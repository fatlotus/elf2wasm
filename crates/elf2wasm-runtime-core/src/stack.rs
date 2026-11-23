use crate::context::GuestContext;
use anyhow::{bail, Context, Result};
use elf2wasm_core::meta::WasmMeta;

#[derive(Debug, Clone, Default)]
pub struct RunConfig {
    pub args: Vec<String>,
    pub env: Vec<String>,
    #[cfg(feature = "std-fs")]
    pub vfs_ro: Vec<(std::path::PathBuf, String)>,
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
            let name_end = p
                .checked_add(name_len)
                .context("Custom section name overflow")?;
            if name_end <= sec_end {
                if let Ok(name) = core::str::from_utf8(&wasm_bytes[p..name_end]) {
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

fn push_bytes_ctx(
    ctx: &mut dyn GuestContext,
    sp: &mut u32,
    stack_min: u32,
    data: &[u8],
) -> Result<u32> {
    let len = u32::try_from(data.len()).context("Guest stack item too large")?;
    let new_sp = sp.checked_sub(len).context("Guest stack underflow")?;
    if new_sp < stack_min {
        bail!("Guest stack overflow into mmap region");
    }
    *sp = new_sp;
    ctx.mem_write(*sp as u64, data)
        .map_err(|e| anyhow::anyhow!("mem_write failed during stack setup: {}", e))?;
    Ok(*sp)
}

fn push_cstr_ctx(
    ctx: &mut dyn GuestContext,
    sp: &mut u32,
    stack_min: u32,
    s: &str,
) -> Result<u32> {
    let mut bytes = s.as_bytes().to_vec();
    bytes.push(0);
    push_bytes_ctx(ctx, sp, stack_min, &bytes)
}

fn write_u64_ctx(ctx: &mut dyn GuestContext, addr: u32, val: u64) -> Result<()> {
    ctx.mem_write(addr as u64, &val.to_le_bytes())
        .map_err(|e| anyhow::anyhow!("mem_write failed during stack setup: {}", e))
}

pub fn setup_guest_stack_ctx(
    ctx: &mut dyn GuestContext,
    meta: &WasmMeta,
    args: &[String],
    env: &[String],
) -> Result<u32> {
    setup_guest_stack_ctx_with_ids(ctx, meta, args, env, 1000, 1000)
}

pub fn setup_guest_stack_ctx_with_ids(
    ctx: &mut dyn GuestContext,
    meta: &WasmMeta,
    args: &[String],
    env: &[String],
    uid: u32,
    gid: u32,
) -> Result<u32> {
    let stack_min = meta.mmap_end;
    let mut sp = meta.stack_top;

    let rand_bytes: [u8; 16] = [
        0x1a, 0x2b, 0x3c, 0x4d, 0x5e, 0x6f, 0x70, 0x81, 0x92, 0xa3, 0xb4, 0xc5, 0xd6, 0xe7, 0xf8,
        0x09,
    ];
    let _random_addr = push_bytes_ctx(ctx, &mut sp, stack_min, &rand_bytes)?;
    sp &= !0xF;
    ctx.mem_write(sp as u64, &rand_bytes)
        .map_err(|e| anyhow::anyhow!("mem_write failed for AT_RANDOM: {}", e))?;
    let random_addr = sp;

    let platform_addr = push_cstr_ctx(ctx, &mut sp, stack_min, "x86_64")?;
    let execfn_str = if !meta.elf_path.is_empty() {
        meta.elf_path.as_str()
    } else {
        args.first().map(|s| s.as_str()).unwrap_or("app")
    };
    let execfn_addr = push_cstr_ctx(ctx, &mut sp, stack_min, execfn_str)?;

    let mut env_ptrs = Vec::with_capacity(env.len());
    for e in env.iter().rev() {
        env_ptrs.push(push_cstr_ctx(ctx, &mut sp, stack_min, e)?);
    }
    env_ptrs.reverse();

    let mut arg_ptrs = Vec::with_capacity(args.len());
    for a in args.iter().rev() {
        arg_ptrs.push(push_cstr_ctx(ctx, &mut sp, stack_min, a)?);
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
        (11, uid as u64),           // AT_UID
        (12, uid as u64),           // AT_EUID
        (13, gid as u64),           // AT_GID
        (14, gid as u64),           // AT_EGID
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
    let bytes_needed = u32::try_from(
        words
            .checked_mul(8)
            .context("Guest stack byte size overflow")?,
    )
    .context("Guest stack size exceeds u32")?;
    let mut rsp = sp
        .checked_sub(bytes_needed)
        .context("Guest stack underflow")?;
    if (rsp & 0xF) != 0 {
        rsp = rsp
            .checked_sub(8)
            .context("Guest stack alignment underflow")?;
    }
    if rsp < stack_min {
        bail!("Guest stack overflow into mmap region");
    }

    let mut p = rsp;
    write_u64_ctx(ctx, p, arg_ptrs.len() as u64)?;
    p += 8;
    for ptr in &arg_ptrs {
        write_u64_ctx(ctx, p, *ptr as u64)?;
        p += 8;
    }
    write_u64_ctx(ctx, p, 0)?;
    p += 8;
    for ptr in &env_ptrs {
        write_u64_ctx(ctx, p, *ptr as u64)?;
        p += 8;
    }
    write_u64_ctx(ctx, p, 0)?;
    p += 8;
    for (k, v) in &auxv {
        write_u64_ctx(ctx, p, *k)?;
        write_u64_ctx(ctx, p + 8, *v)?;
        p += 16;
    }

    Ok(rsp)
}

pub fn setup_guest_stack(mem: &mut [u8], meta: &WasmMeta, config: &RunConfig) -> Result<u32> {
    struct SliceCtx<'a>(&'a mut [u8]);
    impl<'a> GuestContext for SliceCtx<'a> {
        fn mem_len(&self) -> usize {
            self.0.len()
        }
        fn mem_read(&self, addr: u64, buf: &mut [u8]) -> Result<(), i64> {
            let s = addr as usize;
            buf.copy_from_slice(&self.0[s..s + buf.len()]);
            Ok(())
        }
        fn mem_write(&mut self, addr: u64, data: &[u8]) -> Result<(), i64> {
            let s = addr as usize;
            self.0[s..s + data.len()].copy_from_slice(data);
            Ok(())
        }
        fn mem_zero(&mut self, addr: u64, len: usize) -> Result<(), i64> {
            let s = addr as usize;
            self.0[s..s + len].fill(0);
            Ok(())
        }
        fn mem_read_cstr(&self, _addr: u64, _max_len: usize) -> Result<String, i64> {
            Err(-38)
        }
        fn get_fsbase(&self) -> i64 {
            0
        }
        fn set_fsbase(&mut self, _val: i64) {}
        fn get_gsbase(&self) -> i64 {
            0
        }
        fn set_gsbase(&mut self, _val: i64) {}
        fn get_rcx(&self) -> i64 {
            0
        }
        fn set_rip(&mut self, _val: i64) {}
        fn set_rsp(&mut self, _val: i64) {}
        fn get_rax(&self) -> i64 {
            0
        }
        fn set_rax(&mut self, _val: i64) {}
        fn get_rdi(&self) -> i64 {
            0
        }
        fn get_rsi(&self) -> i64 {
            0
        }
        fn get_rdx(&self) -> i64 {
            0
        }
        fn get_r10(&self) -> i64 {
            0
        }
        fn get_r8(&self) -> i64 {
            0
        }
        fn get_r9(&self) -> i64 {
            0
        }
        fn set_exit(&mut self, _code: i32) {}
        fn set_yield_flag(&mut self, _val: i32) {}
        fn set_quantum(&mut self, _val: i32) {}
        fn save_ctx(&mut self, _scratch_addr: u32) -> Result<[u8; elf2wasm_core::lifter::CTX_SIZE], i64> {
            Err(-38)
        }
        fn load_ctx(&mut self, _scratch_addr: u32, _buf: &[u8; elf2wasm_core::lifter::CTX_SIZE]) -> Result<(), i64> {
            Err(-38)
        }
    }
    let mut sctx = SliceCtx(mem);
    setup_guest_stack_ctx(&mut sctx, meta, &config.args, &config.env)
}
