use anyhow::{bail, Context, Result};
use goblin::elf::{program_header, Elf};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

pub const MAIN_PIE_BASE: u32 = 0x0010_0000; // 1 MB
pub const LD_BASE: u32 = 0x0100_0000; // 16 MB
pub const SO_BASE_START: u32 = 0x0200_0000; // 32 MB
pub const BRK_START: u32 = 0x0500_0000; // 80 MB
pub const MMAP_START: u32 = 0x0800_0000; // 128 MB
pub const STACK_TOP: u32 = 0x0BFF_0000; // ~192 MB
pub const INITIAL_MEM_PAGES: u32 = 4096; // 256 MB (4096 * 64KB)
pub const DISPATCH_TABLE_ADDR: u32 = 0x0001_0000; // 64 KB

#[derive(Debug, Clone)]
pub struct ExecSegment {
    pub name: String,
    pub vaddr: u32,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct DataSegment {
    pub vaddr: u32,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct SoFile {
    pub host_path: String,
    pub guest_paths: Vec<String>,
    pub base_addr: u32,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct LoadedImage {
    pub entry_rip: u32,
    pub at_phdr: u32,
    pub at_phent: u32,
    pub at_phnum: u32,
    pub at_entry: u32,
    pub at_base: u32,
    pub exec_segments: Vec<ExecSegment>,
    pub data_segments: Vec<DataSegment>,
    pub so_files: Vec<SoFile>,
    pub symbols: HashMap<u32, String>,
    pub elf_path: String,
}

pub const GUEST_MEM_SIZE: usize = (INITIAL_MEM_PAGES as usize) * 65536; // 256 MB
pub const GUEST_CODE_DATA_LIMIT: usize = 0x0B00_0000; // below stack & dispatch hash table

fn align_up(val: u32, align: u32) -> Option<u32> {
    val.checked_add(align - 1).map(|v| v & !(align - 1))
}

fn elf_span(elf: &Elf) -> Result<u32> {
    let mut max_end = 0u32;
    for ph in &elf.program_headers {
        if ph.p_type == program_header::PT_LOAD {
            let end64 = ph
                .p_vaddr
                .checked_add(ph.p_memsz)
                .context("ELF segment vaddr + memsz overflow")?;
            let end = u32::try_from(end64)
                .context("ELF segment exceeds 32-bit guest virtual address space")?;
            if end > max_end {
                max_end = end;
            }
        }
    }
    align_up(max_end, 0x0010_0000).context("ELF span 1MB alignment overflow")
}

fn collect_symbols(elf: &Elf, base: u32, out: &mut HashMap<u32, String>) {
    for sym in &elf.syms {
        if sym.st_value != 0 && sym.st_type() == goblin::elf::sym::STT_FUNC {
            if let Some(name) = elf.strtab.get_at(sym.st_name) {
                if !name.is_empty() {
                    if let Some(addr) = u32::try_from(sym.st_value).ok().and_then(|v| base.checked_add(v)) {
                        out.insert(addr, name.to_string());
                    }
                }
            }
        }
    }
    for sym in &elf.dynsyms {
        if sym.st_value != 0 && sym.st_type() == goblin::elf::sym::STT_FUNC {
            if let Some(name) = elf.dynstrtab.get_at(sym.st_name) {
                if !name.is_empty() {
                    if let Some(addr) = u32::try_from(sym.st_value).ok().and_then(|v| base.checked_add(v)) {
                        out.insert(addr, name.to_string());
                    }
                }
            }
        }
    }
}

fn extract_segments(
    name: &str,
    bytes: &[u8],
    elf: &Elf,
    base: u32,
    load_data: bool,
    exec_segments: &mut Vec<ExecSegment>,
    data_segments: &mut Vec<DataSegment>,
) -> Result<()> {
    for ph in &elf.program_headers {
        if ph.p_type != program_header::PT_LOAD {
            continue;
        }
        if ph.p_filesz > ph.p_memsz {
            bail!(
                "ELF {} segment has p_filesz ({}) > p_memsz ({})",
                name,
                ph.p_filesz,
                ph.p_memsz
            );
        }
        let file_end = ph
            .p_offset
            .checked_add(ph.p_filesz)
            .context("ELF segment p_offset + p_filesz overflow")?;
        if file_end > bytes.len() as u64 {
            bail!(
                "ELF {} segment extends past EOF (offset+filesz={} > len={})",
                name,
                file_end,
                bytes.len()
            );
        }
        let memsz = usize::try_from(ph.p_memsz)
            .ok()
            .filter(|&m| m <= GUEST_MEM_SIZE)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "ELF {} segment p_memsz ({}) exceeds guest memory limit ({})",
                    name,
                    ph.p_memsz,
                    GUEST_MEM_SIZE
                )
            })?;
        let filesz = ph.p_filesz as usize;
        let offset = ph.p_offset as usize;

        let vaddr64 = (base as u64)
            .checked_add(ph.p_vaddr)
            .context("ELF segment base + p_vaddr overflow")?;
        let vaddr = u32::try_from(vaddr64).with_context(|| {
            format!(
                "ELF {} segment vaddr 0x{:x} exceeds 32-bit guest address space",
                name, vaddr64
            )
        })?;
        let seg_end = (vaddr as usize)
            .checked_add(memsz)
            .context("ELF segment end address overflow")?;
        if seg_end > GUEST_CODE_DATA_LIMIT {
            bail!(
                "ELF {} segment [0x{:x}, 0x{:x}) overlaps stack/dispatch region (>= 0x{:x})",
                name,
                vaddr,
                seg_end,
                GUEST_CODE_DATA_LIMIT
            );
        }

        let mut seg_data = vec![0u8; memsz];
        if filesz > 0 {
            seg_data[..filesz].copy_from_slice(&bytes[offset..offset + filesz]);
        }

        if ph.p_flags & program_header::PF_X != 0 {
            // Only lift the file-backed executable bytes
            let code_len = filesz.min(memsz);
            exec_segments.push(ExecSegment {
                name: format!("{name}@0x{vaddr:x}"),
                vaddr,
                data: seg_data[..code_len].to_vec(),
            });
        }

        if load_data && !seg_data.is_empty() {
            data_segments.push(DataSegment {
                vaddr,
                data: seg_data,
            });
        }
    }
    Ok(())
}

pub fn load_elf_and_sos(main_path: &Path, so_paths: &[PathBuf]) -> Result<LoadedImage> {
    let main_bytes = fs::read(main_path)
        .with_context(|| format!("Failed to read main ELF: {}", main_path.display()))?;
    let main_elf = Elf::parse(&main_bytes)
        .with_context(|| format!("Failed to parse main ELF: {}", main_path.display()))?;

    if !main_elf.is_64 {
        bail!("Only ELF64 is supported");
    }
    if main_elf.header.e_machine != goblin::elf::header::EM_X86_64 {
        bail!(
            "Unsupported ELF e_machine={} (only EM_X86_64={} is supported)",
            main_elf.header.e_machine,
            goblin::elf::header::EM_X86_64
        );
    }
    if main_elf.header.e_type != goblin::elf::header::ET_EXEC
        && main_elf.header.e_type != goblin::elf::header::ET_DYN
    {
        bail!(
            "Unsupported ELF e_type={} (only ET_EXEC and ET_DYN are supported)",
            main_elf.header.e_type
        );
    }

    let main_base = if main_elf.header.e_type == goblin::elf::header::ET_DYN {
        MAIN_PIE_BASE
    } else {
        0
    };

    let mut exec_segments = Vec::new();
    let mut data_segments = Vec::new();
    let mut symbols = HashMap::new();

    extract_segments(
        &main_path.file_name().unwrap_or_default().to_string_lossy(),
        &main_bytes,
        &main_elf,
        main_base,
        true,
        &mut exec_segments,
        &mut data_segments,
    )?;
    collect_symbols(&main_elf, main_base, &mut symbols);

    // Determine AT_PHDR
    let mut at_phdr = u32::try_from(
        (main_base as u64)
            .checked_add(main_elf.header.e_phoff)
            .context("e_phoff overflow")?,
    )
    .context("AT_PHDR exceeds 32-bit guest address space")?;
    for ph in &main_elf.program_headers {
        if ph.p_type == program_header::PT_PHDR {
            at_phdr = u32::try_from(
                (main_base as u64)
                    .checked_add(ph.p_vaddr)
                    .context("PT_PHDR vaddr overflow")?,
            )
            .context("PT_PHDR exceeds 32-bit guest address space")?;
            break;
        }
    }
    let at_phent = main_elf.header.e_phentsize as u32;
    let at_phnum = main_elf.header.e_phnum as u32;
    let at_entry = u32::try_from(
        (main_base as u64)
            .checked_add(main_elf.header.e_entry)
            .context("e_entry overflow")?,
    )
    .context("e_entry exceeds 32-bit guest address space")?;

    let interp_path = main_elf.interpreter.map(|s| s.to_string());
    let interp_basename = interp_path
        .as_deref()
        .and_then(|p| Path::new(p).file_name())
        .map(|s| s.to_string_lossy().to_string());

    let mut ld_loaded = false;
    let mut entry_rip = at_entry;
    let mut at_base = 0u32;
    let mut next_so_base = SO_BASE_START;
    let mut so_files = Vec::new();

    let mut effective_so_paths = so_paths.to_vec();
    if main_path
        .file_name()
        .and_then(|n| n.to_str())
        .map_or(false, |n| n.starts_with("python3"))
    {
        let ctxvars = Path::new(
            "/usr/lib/python3.11/lib-dynload/_contextvars.cpython-311-x86_64-linux-gnu.so",
        );
        if ctxvars.exists()
            && !effective_so_paths
                .iter()
                .any(|p| p == ctxvars || p.file_name() == ctxvars.file_name())
        {
            effective_so_paths.push(ctxvars.to_path_buf());
        }
    }

    for so_path in &effective_so_paths {
        let so_bytes = fs::read(so_path)
            .with_context(|| format!("Failed to read .so: {}", so_path.display()))?;
        let so_elf = Elf::parse(&so_bytes)
            .with_context(|| format!("Failed to parse .so: {}", so_path.display()))?;
        if !so_elf.is_64 || so_elf.header.e_machine != goblin::elf::header::EM_X86_64 {
            bail!(
                "Shared object {} is not an ELF64 x86-64 binary",
                so_path.display()
            );
        }

        let so_str = so_path.to_string_lossy().to_string();
        let so_base_name = so_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let canon_str = fs::canonicalize(so_path)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| so_str.clone());

        let is_interp = !ld_loaded
            && interp_path.as_ref().map_or(false, |ip| {
                ip == &so_str
                    || ip == &canon_str
                    || interp_basename.as_deref() == Some(so_base_name.as_str())
                    || (so_base_name.starts_with("ld-linux") && ip.contains("ld-linux"))
            });

        if is_interp {
            ld_loaded = true;
            at_base = LD_BASE;
            entry_rip = u32::try_from(
                (LD_BASE as u64)
                    .checked_add(so_elf.header.e_entry)
                    .context("ld.so e_entry overflow")?,
            )
            .context("ld.so e_entry exceeds 32-bit guest address space")?;
            extract_segments(
                &so_base_name,
                &so_bytes,
                &so_elf,
                LD_BASE,
                true,
                &mut exec_segments,
                &mut data_segments,
            )?;
            collect_symbols(&so_elf, LD_BASE, &mut symbols);
        } else {
            let base = next_so_base;
            let span = elf_span(&so_elf)?.max(0x0010_0000);
            next_so_base = next_so_base
                .checked_add(span)
                .filter(|&n| n <= BRK_START)
                .ok_or_else(|| anyhow::anyhow!("Shared objects exceed reserved SO VA space"))?;

            // Lift its code at `base`, but do NOT preload its data segments:
            // ld.so will openat + mmap it into `base` at runtime!
            extract_segments(
                &so_base_name,
                &so_bytes,
                &so_elf,
                base,
                false,
                &mut exec_segments,
                &mut data_segments,
            )?;
            collect_symbols(&so_elf, base, &mut symbols);

            let mut guest_paths = vec![
                so_str.clone(),
                canon_str.clone(),
                format!("/lib/x86_64-linux-gnu/{}", so_base_name),
                format!("/usr/lib/x86_64-linux-gnu/{}", so_base_name),
                format!("/lib64/{}", so_base_name),
                format!("/lib/{}", so_base_name),
                format!("/usr/lib/{}", so_base_name),
            ];
            // Also add the basename of the canonical path (e.g. libc.so.6 -> libc.so.6)
            if let Some(canon_base) = Path::new(&canon_str).file_name() {
                let cb = canon_base.to_string_lossy();
                guest_paths.push(format!("/lib/x86_64-linux-gnu/{}", cb));
                guest_paths.push(format!("/lib64/{}", cb));
            }
            guest_paths.sort();
            guest_paths.dedup();

            so_files.push(SoFile {
                host_path: so_str,
                guest_paths,
                base_addr: base,
                bytes: so_bytes,
            });
        }
    }

    if interp_path.is_some() && !ld_loaded {
        bail!(
            "Main ELF requires interpreter {:?}, but it was not provided in --so list",
            interp_path.unwrap()
        );
    }
    if exec_segments.is_empty() {
        bail!("No executable PT_LOAD segments found in ELF");
    }

    Ok(LoadedImage {
        entry_rip,
        at_phdr,
        at_phent,
        at_phnum,
        at_entry,
        at_base,
        exec_segments,
        data_segments,
        so_files,
        symbols,
        elf_path: main_path.to_string_lossy().to_string(),
    })
}
