use crate::elf_loader::STACK_TOP;
use crate::meta::WasmMeta;
use crate::syscalls::{self, HostState};
use crate::vfs::VirtualFs;
use anyhow::{bail, Context, Result};
use std::path::PathBuf;
use wasmtime::{Caller, Engine, Linker, Module, Store, Val};

#[derive(Debug, Clone, Default)]
pub struct RunConfig {
    pub args: Vec<String>,
    pub env: Vec<String>,
    pub vfs_ro: Vec<(PathBuf, String)>,
    pub stdin: Vec<u8>,
    pub inherit_stdin: bool,
}

#[derive(Debug, Clone)]
pub struct RunOutput {
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

fn read_leb_u32(bytes: &[u8], pos: &mut usize) -> Result<u32> {
    let mut result = 0u32;
    let mut shift = 0u32;
    loop {
        if *pos >= bytes.len() {
            bail!("Unexpected EOF reading LEB128 in WASM");
        }
        let b = bytes[*pos];
        *pos += 1;
        result |= ((b & 0x7f) as u32) << shift;
        if (b & 0x80) == 0 {
            return Ok(result);
        }
        shift += 7;
        if shift >= 35 {
            bail!("LEB128 overflow in WASM");
        }
    }
}

pub fn extract_elf2wasm_meta(wasm_bytes: &[u8]) -> Result<WasmMeta> {
    if wasm_bytes.len() < 8 || &wasm_bytes[0..8] != b"\0asm\x01\x00\x00\x00" {
        bail!("Invalid WASM magic/version header");
    }
    let mut pos = 8;
    while pos < wasm_bytes.len() {
        let sec_id = wasm_bytes[pos];
        pos += 1;
        let sec_size = read_leb_u32(wasm_bytes, &mut pos)? as usize;
        let sec_end = pos
            .checked_add(sec_size)
            .context("WASM section size overflow")?;
        if sec_end > wasm_bytes.len() {
            bail!("WASM section extends past EOF");
        }
        if sec_id == 0 {
            let mut p = pos;
            let name_len = read_leb_u32(wasm_bytes, &mut p)? as usize;
            let name_end = p.checked_add(name_len).context("Custom section name overflow")?;
            if name_end <= sec_end {
                if let Ok(name) = std::str::from_utf8(&wasm_bytes[p..name_end]) {
                    if name == "elf2wasm_meta" {
                        return WasmMeta::decode(&wasm_bytes[name_end..sec_end]);
                    }
                }
            }
        }
        pos = sec_end;
    }
    bail!("Missing elf2wasm_meta custom section in WASM module");
}

fn push_bytes(mem: &mut [u8], sp: &mut u32, data: &[u8]) -> Result<u32> {
    let len = u32::try_from(data.len()).context("Guest stack item too large")?;
    let new_sp = sp.checked_sub(len).context("Guest stack underflow")?;
    if new_sp < syscalls::MMAP_END {
        bail!("Guest stack overflow into mmap region");
    }
    *sp = new_sp;
    let addr = *sp as usize;
    mem[addr..addr + data.len()].copy_from_slice(data);
    Ok(*sp)
}

fn push_cstr(mem: &mut [u8], sp: &mut u32, s: &str) -> Result<u32> {
    let mut bytes = s.as_bytes().to_vec();
    bytes.push(0);
    push_bytes(mem, sp, &bytes)
}

fn write_u64_mem(mem: &mut [u8], addr: u32, val: u64) {
    let idx = addr as usize;
    mem[idx..idx + 8].copy_from_slice(&val.to_le_bytes());
}

fn setup_guest_stack(mem: &mut [u8], meta: &WasmMeta, config: &RunConfig) -> Result<u32> {
    let mut sp = STACK_TOP;

    // 16 random bytes for AT_RANDOM
    let rand_bytes: [u8; 16] = [
        0x1a, 0x2b, 0x3c, 0x4d, 0x5e, 0x6f, 0x70, 0x81, 0x92, 0xa3, 0xb4, 0xc5, 0xd6, 0xe7, 0xf8,
        0x09,
    ];
    let _random_addr = push_bytes(mem, &mut sp, &rand_bytes)?;
    sp &= !0xF;
    // Ensure random_addr is at the aligned spot
    mem[sp as usize..sp as usize + 16].copy_from_slice(&rand_bytes);
    let random_addr = sp;

    let platform_addr = push_cstr(mem, &mut sp, "x86_64")?;
    let execfn_str = if !meta.elf_path.is_empty() {
        meta.elf_path.as_str()
    } else {
        config.args.first().map(|s| s.as_str()).unwrap_or("app")
    };
    let execfn_addr = push_cstr(mem, &mut sp, execfn_str)?;

    let mut env_ptrs = Vec::with_capacity(config.env.len());
    for e in config.env.iter().rev() {
        env_ptrs.push(push_cstr(mem, &mut sp, e)?);
    }
    env_ptrs.reverse();

    let mut arg_ptrs = Vec::with_capacity(config.args.len());
    for a in config.args.iter().rev() {
        arg_ptrs.push(push_cstr(mem, &mut sp, a)?);
    }
    arg_ptrs.reverse();

    sp &= !7;

    let auxv: [(u64, u64); 19] = [
        (3, meta.at_phdr as u64),   // AT_PHDR
        (4, meta.at_phent as u64),  // AT_PHENT
        (5, meta.at_phnum as u64),  // AT_PHNUM
        (6, 4096),                  // AT_PAGESZ
        (7, meta.at_base as u64),   // AT_BASE
        (8, 0),                     // AT_FLAGS
        (9, meta.at_entry as u64),  // AT_ENTRY
        (11, 1000),                 // AT_UID
        (12, 1000),                 // AT_EUID
        (13, 1000),                 // AT_GID
        (14, 1000),                 // AT_EGID
        (15, platform_addr as u64), // AT_PLATFORM
        (16, 0x078bfbff),           // AT_HWCAP (baseline x86-64 + SSE2, no AVX)
        (17, 100),                  // AT_CLKTCK
        (23, 0),                    // AT_SECURE
        (25, random_addr as u64),   // AT_RANDOM
        (26, 0),                    // AT_HWCAP2
        (31, execfn_addr as u64),   // AT_EXECFN
        (0, 0),                     // AT_NULL
    ];

    let words = 1usize
        .checked_add(arg_ptrs.len())
        .and_then(|w| w.checked_add(1))
        .and_then(|w| w.checked_add(env_ptrs.len()))
        .and_then(|w| w.checked_add(1))
        .and_then(|w| w.checked_add(auxv.len() * 2))
        .context("Guest stack word count overflow")?;
    let bytes_needed = u32::try_from(words.checked_mul(8).context("Guest stack byte size overflow")?)
        .context("Guest stack size exceeds u32")?;
    let mut rsp = sp
        .checked_sub(bytes_needed)
        .context("Guest stack underflow")?;
    if (rsp & 0xF) != 0 {
        rsp = rsp.checked_sub(8).context("Guest stack alignment underflow")?;
    }
    if rsp < syscalls::MMAP_END {
        bail!("Guest stack overflow into mmap region");
    }

    let mut p = rsp;
    write_u64_mem(mem, p, arg_ptrs.len() as u64);
    p += 8;
    for ptr in &arg_ptrs {
        write_u64_mem(mem, p, *ptr as u64);
        p += 8;
    }
    write_u64_mem(mem, p, 0);
    p += 8;
    for ptr in &env_ptrs {
        write_u64_mem(mem, p, *ptr as u64);
        p += 8;
    }
    write_u64_mem(mem, p, 0);
    p += 8;
    for (k, v) in &auxv {
        write_u64_mem(mem, p, *k);
        write_u64_mem(mem, p + 8, *v);
        p += 16;
    }

    Ok(rsp)
}

pub fn run_wasm(wasm_bytes: &[u8], config: RunConfig) -> Result<RunOutput> {
    let meta = extract_elf2wasm_meta(wasm_bytes)?;
    let engine = Engine::default();
    let module = Module::new(&engine, wasm_bytes)?;

    let mut linker: Linker<HostState> = Linker::new(&engine);
    linker.func_wrap(
        "env",
        "syscall",
        |mut caller: Caller<'_, HostState>,
         nr: i64,
         a0: i64,
         a1: i64,
         a2: i64,
         a3: i64,
         a4: i64,
         a5: i64|
         -> i64 { syscalls::handle_syscall(&mut caller, nr, a0, a1, a2, a3, a4, a5) },
    )?;

    for (host, _) in &config.vfs_ro {
        std::fs::canonicalize(host).with_context(|| {
            format!(
                "Invalid --vfs-ro host path '{}': does not exist or cannot be resolved",
                host.display()
            )
        })?;
    }

    let mut vfs = VirtualFs::new(&meta.so_files, &config.vfs_ro);
    vfs.stdin_data = config.stdin.clone();
    vfs.inherit_stdin = config.inherit_stdin;
    vfs.elf_path = meta.elf_path.clone();
    let host_state = HostState::new(vfs);
    let mut store = Store::new(&engine, host_state);

    let instance = linker.instantiate(&mut store, &module)?;
    let mem = instance
        .get_memory(&mut store, "memory")
        .context("missing exported memory")?;

    let initial_rsp = {
        let mem_slice = mem.data_mut(&mut store);
        setup_guest_stack(mem_slice, &meta, &config)?
    };

    instance
        .get_global(&mut store, "rsp")
        .context("missing rsp global")?
        .set(&mut store, Val::I64(initial_rsp as i64))?;

    instance
        .get_global(&mut store, "rip")
        .context("missing rip global")?
        .set(&mut store, Val::I64(meta.entry_rip as i64))?;

    let start = instance.get_typed_func::<(), i32>(&mut store, "_start")?;
    let exit_code = loop {
        let code = match start.call(&mut store, ()) {
            Ok(code) => code,
            Err(err) => {
                let rip = instance
                    .get_global(&mut store, "rip")
                    .and_then(|g| g.get(&mut store).i64())
                    .unwrap_or(-1) as u64;
                let rsp = instance
                    .get_global(&mut store, "rsp")
                    .and_then(|g| g.get(&mut store).i64())
                    .unwrap_or(-1) as u64;
                let rax = instance
                    .get_global(&mut store, "rax")
                    .and_then(|g| g.get(&mut store).i64())
                    .unwrap_or(-1) as u64;
                let sym = meta
                    .symbols
                    .iter()
                    .rev()
                    .find(|(addr, _)| (*addr as u64) <= rip)
                    .map(|(addr, name)| format!("{}+0x{:x}", name, rip - *addr as u64))
                    .unwrap_or_else(|| "unknown".to_string());
                return Err(err).context(format!(
                    "WASM trap at rip=0x{:x} ({}), rsp=0x{:x}, rax=0x{:x}",
                    rip, sym, rsp, rax
                ));
            }
        };
        let yield_flag = instance
            .get_global(&mut store, "yield_flag")
            .and_then(|g| g.get(&mut store).i32())
            .unwrap_or(0);
        let exit_flag = instance
            .get_global(&mut store, "exit_flag")
            .and_then(|g| g.get(&mut store).i32())
            .unwrap_or(0);
        if yield_flag != 0 && exit_flag == 0 {
            if let Some(g) = instance.get_global(&mut store, "yield_flag") {
                g.set(&mut store, Val::I32(0))?;
            }
            if let Some(g) = instance.get_global(&mut store, "quantum") {
                g.set(&mut store, Val::I32(crate::lifter::DEFAULT_QUANTUM))?;
            }
            continue;
        }
        break code;
    };

    let state = store.data();
    Ok(RunOutput {
        exit_code,
        stdout: state.vfs.stdout.clone(),
        stderr: state.vfs.stderr.clone(),
    })
}
