pub mod decoder;
pub mod elf_loader;
pub mod lifter;
pub mod meta;
pub mod runtime;
pub mod syscalls;
pub mod vfs;
pub mod wasm_emit;

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process;

#[derive(Parser)]
#[command(name = "elf2wasm", about = "Translate Linux x86-64 ELF binaries to sandboxed WASM")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Translate an ELF64 binary and its shared libraries into a .wasm module
    Translate {
        /// Path to the main ELF64 executable
        elf: PathBuf,
        /// Shared library (.so) paths to bundle (repeatable)
        #[arg(long = "so")]
        so_paths: Vec<PathBuf>,
        /// Output .wasm file path
        #[arg(short = 'o', long = "output")]
        output: PathBuf,
    },
    /// Run a translated .wasm module in the sandboxed runtime
    Run {
        /// Path to the translated .wasm file
        wasm: PathBuf,
        /// Read-only VFS mount in host:guest format (repeatable)
        #[arg(long = "vfs-ro")]
        vfs_ro: Vec<String>,
        /// Arguments passed to the guest program (after --)
        #[arg(last = true)]
        args: Vec<String>,
    },
}

fn parse_vfs_ro(spec: &str) -> Result<(PathBuf, String)> {
    let Some((host, guest)) = spec.split_once(':') else {
        bail!("Invalid --vfs-ro specification '{}': expected <host:guest>", spec);
    };
    if host.is_empty() || guest.is_empty() {
        bail!("Invalid --vfs-ro specification '{}': empty host or guest path", spec);
    }
    let host_path = std::fs::canonicalize(host).with_context(|| {
        format!(
            "Invalid --vfs-ro host path '{}': does not exist or cannot be resolved",
            host
        )
    })?;
    Ok((host_path, guest.to_string()))
}

fn split_indirect_targets(image: &elf_loader::LoadedImage, prog: &mut decoder::DecodedProgram) {
    use decoder::{BlockTerminator, DecodedBlock};
    use goblin::elf::{program_header, Elf};
    use iced_x86::{Mnemonic, OpKind, Register};
    use std::collections::{BTreeSet, HashSet};

    let in_exec = |va: u32| -> bool {
        image.exec_segments.iter().any(|seg| {
            let end = seg.vaddr.saturating_add(seg.data.len() as u32);
            va >= seg.vaddr && va < end
        })
    };

    let in_data = |va: u32| -> bool {
        image.data_segments.iter().any(|seg| {
            let end = seg.vaddr.saturating_add(seg.data.len() as u32);
            va >= seg.vaddr && va < end
        })
    };

    let read_data_i32 = |va: u32| -> Option<i32> {
        for seg in &image.data_segments {
            let end = seg.vaddr.saturating_add(seg.data.len() as u32);
            if va >= seg.vaddr && va + 4 <= end {
                let off = (va - seg.vaddr) as usize;
                return Some(i32::from_le_bytes(seg.data[off..off + 4].try_into().unwrap()));
            }
        }
        None
    };

    let read_data_u64 = |va: u32| -> Option<u64> {
        for seg in &image.data_segments {
            let end = seg.vaddr.saturating_add(seg.data.len() as u32);
            if va >= seg.vaddr && va + 8 <= end {
                let off = (va - seg.vaddr) as usize;
                return Some(u64::from_le_bytes(seg.data[off..off + 8].try_into().unwrap()));
            }
        }
        None
    };

    struct SoRoView<'a> {
        base_addr: u32,
        bytes: &'a [u8],
        loads: Vec<(u64, u64, u64)>, // (p_vaddr, p_filesz, p_offset)
    }

    let mut so_views = Vec::new();
    for so in &image.so_files {
        if let Ok(elf) = Elf::parse(&so.bytes) {
            let mut loads = Vec::new();
            for ph in &elf.program_headers {
                if ph.p_type == program_header::PT_LOAD {
                    loads.push((ph.p_vaddr, ph.p_filesz, ph.p_offset));
                }
            }
            so_views.push(SoRoView {
                base_addr: so.base_addr,
                bytes: &so.bytes,
                loads,
            });
        }
    }

    let read_so_i32 = |va: u32| -> Option<i32> {
        for sv in &so_views {
            if va < sv.base_addr {
                continue;
            }
            let rel_va = (va - sv.base_addr) as u64;
            for &(pvaddr, pfilesz, poff) in &sv.loads {
                if rel_va >= pvaddr && rel_va + 4 <= pvaddr + pfilesz {
                    let foff = (poff + (rel_va - pvaddr)) as usize;
                    if foff + 4 <= sv.bytes.len() {
                        return Some(i32::from_le_bytes(
                            sv.bytes[foff..foff + 4].try_into().unwrap(),
                        ));
                    }
                }
            }
        }
        None
    };

    let mut instr_addrs = HashSet::new();
    for block in prog.blocks.values() {
        for instr in &block.instructions {
            instr_addrs.insert(instr.ip() as u32);
        }
    }

    let mut targets = BTreeSet::new();
    let mut ro_table_candidates = BTreeSet::new();
    let mut abs_table_candidates = BTreeSet::new();
    for block in prog.blocks.values() {
        for (i, instr) in block.instructions.iter().enumerate() {
            if instr.is_ip_rel_memory_operand() {
                if let Ok(va) = u32::try_from(instr.ip_rel_memory_address()) {
                    if in_exec(va) {
                        targets.insert(va);
                    } else {
                        ro_table_candidates.insert(va);
                    }
                }
            } else {
                for op_idx in 0..instr.op_count() {
                    match instr.op_kind(op_idx) {
                        OpKind::Memory => {
                            if instr.memory_base() == Register::None
                                && instr.memory_displacement64() != 0
                            {
                                if let Ok(va) = u32::try_from(instr.memory_displacement64()) {
                                    if in_data(va) {
                                        abs_table_candidates.insert(va);
                                    }
                                }
                            }
                        }
                        OpKind::Immediate32 | OpKind::Immediate32to64 | OpKind::Immediate64 => {
                            let imm = instr.immediate(op_idx);
                            if let Ok(va) = u32::try_from(imm) {
                                if in_data(va) {
                                    abs_table_candidates.insert(va);
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            if i > 0 {
                let va = instr.ip() as u32;
                if instr.mnemonic() == Mnemonic::Endbr64 {
                    targets.insert(va);
                } else if block.instructions[i - 1].mnemonic() == Mnemonic::Nop
                    && instr.mnemonic() != Mnemonic::Nop
                {
                    targets.insert(va);
                }
            }
        }
    }

    // Probe potential relative jump tables (i32 offsets relative to table_va)
    for &table_va in &ro_table_candidates {
        for idx in 0..512u32 {
            let entry_va = table_va.wrapping_add(idx * 4);
            let rel = read_data_i32(entry_va).or_else(|| read_so_i32(entry_va));
            let Some(rel) = rel else { break };
            let target = table_va.wrapping_add(rel as u32);
            if in_exec(target) {
                targets.insert(target);
            } else {
                break;
            }
        }
    }

    // Probe potential absolute u64 jump tables in data_segments (e.g. ET_EXEC python3)
    for table_va in abs_table_candidates.into_iter().chain(ro_table_candidates) {
        for idx in 0..1024u32 {
            let entry_va = table_va.wrapping_add(idx * 8);
            let Some(entry) = read_data_u64(entry_va) else {
                break;
            };
            let Ok(target) = u32::try_from(entry) else {
                break;
            };
            if in_exec(target) && instr_addrs.contains(&target) {
                targets.insert(target);
            } else {
                break;
            }
        }
    }

    for split_va in targets {
        if prog.blocks.contains_key(&split_va) {
            continue;
        }
        let Some((&block_va, _)) = prog.blocks.range(..split_va).next_back() else {
            continue;
        };
        let Some(block) = prog.blocks.get(&block_va) else {
            continue;
        };
        if split_va >= block.end_va {
            continue;
        }
        let Some(idx) = block
            .instructions
            .iter()
            .position(|ins| ins.ip() as u32 == split_va)
        else {
            continue;
        };
        if idx == 0 {
            continue;
        }
        let mut orig = prog.blocks.remove(&block_va).unwrap();
        let tail_instrs = orig.instructions.split_off(idx);
        let tail_block = DecodedBlock {
            start_va: split_va,
            end_va: orig.end_va,
            instructions: tail_instrs,
            succs: orig.succs,
            terminator: orig.terminator,
        };
        for ins in &tail_block.instructions {
            prog.instr_to_block.insert(ins.ip() as u32, split_va);
        }
        orig.end_va = split_va;
        orig.succs = vec![split_va];
        orig.terminator = BlockTerminator::Fallthrough(split_va);
        prog.blocks.insert(block_va, orig);
        prog.blocks.insert(split_va, tail_block);
    }
    prog.indirect_targets = prog.blocks.keys().copied().collect();
}

fn run_cli() -> Result<i32> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Translate {
            elf,
            so_paths,
            output,
        } => {
            let image = elf_loader::load_elf_and_sos(&elf, &so_paths)?;
            let mut prog = decoder::discover_code(&image)?;
            split_indirect_targets(&image, &mut prog);
            let wasm_bytes = wasm_emit::emit_wasm(&image, &prog)?;
            fs::write(&output, &wasm_bytes)
                .with_context(|| format!("Failed to write {}", output.display()))?;
            Ok(0)
        }
        Commands::Run { wasm, vfs_ro, args } => {
            let wasm_bytes =
                fs::read(&wasm).with_context(|| format!("Failed to read {}", wasm.display()))?;
            let mut mounts = Vec::with_capacity(vfs_ro.len());
            for spec in &vfs_ro {
                mounts.push(parse_vfs_ro(spec)?);
            }
            let prog_name = runtime::extract_elf2wasm_meta(&wasm_bytes)
                .ok()
                .map(|m| m.elf_path)
                .filter(|p| !p.is_empty())
                .unwrap_or_else(|| {
                    wasm.file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("app")
                        .to_string()
                });
            let mut full_args = Vec::with_capacity(1 + args.len());
            full_args.push(prog_name);
            full_args.extend(args);

            let out = runtime::run_wasm(
                &wasm_bytes,
                runtime::RunConfig {
                    args: full_args,
                    env: vec!["PATH=/usr/local/bin:/usr/bin:/bin".to_string()],
                    vfs_ro: mounts,
                    stdin: Vec::new(),
                    inherit_stdin: true,
                },
            )?;

            std::io::stdout().write_all(&out.stdout)?;
            std::io::stderr().write_all(&out.stderr)?;
            std::io::stdout().flush()?;
            std::io::stderr().flush()?;
            Ok(out.exit_code)
        }
    }
}

fn main() {
    match run_cli() {
        Ok(code) => process::exit(code),
        Err(e) => {
            eprintln!("elf2wasm error: {:#}", e);
            process::exit(1);
        }
    }
}
