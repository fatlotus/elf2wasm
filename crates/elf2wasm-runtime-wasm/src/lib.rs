//! WASM-compiled `elf2wasm` runtime (`cdylib`).
//!
//! Bridges guest syscalls, writable VFS overlay, deterministic simulated time,
//! and cooperative multi-threading to a host/JS shim via `"env"` imports.

use core::cell::UnsafeCell;
use elf2wasm_core::lifter::CTX_SIZE;
use elf2wasm_core::meta::WasmMeta;
use elf2wasm_runtime_core::context::GuestContext;
use elf2wasm_runtime_core::stack::setup_guest_stack_ctx;
use elf2wasm_runtime_core::syscalls::{handle_syscall, HostState};
use elf2wasm_runtime_core::vfs::{VirtualFs, EFAULT, EINVAL, ENOMEM};

const GLOBAL_ID_FSBASE: u32 = 0;
const GLOBAL_ID_GSBASE: u32 = 1;
const GLOBAL_ID_RCX: u32 = 2;
const GLOBAL_ID_RIP: u32 = 3;
const GLOBAL_ID_RSP: u32 = 4;
const GLOBAL_ID_EXIT_FLAG: u32 = 5;
const GLOBAL_ID_EXIT_CODE: u32 = 6;
const GLOBAL_ID_YIELD_FLAG: u32 = 7;
const GLOBAL_ID_QUANTUM: u32 = 8;

#[link(wasm_import_module = "env")]
extern "C" {
    fn host_mem_size() -> u32;
    fn host_read_guest(guest_addr: u32, rt_ptr: u32, len: u32) -> i32;
    fn host_write_guest(guest_addr: u32, rt_ptr: u32, len: u32) -> i32;
    fn host_zero_guest(guest_addr: u32, len: u32) -> i32;
    fn host_get_global(id: u32) -> i64;
    fn host_set_global(id: u32, val: i64);
    fn host_save_ctx(scratch_addr: u32);
    fn host_load_ctx(scratch_addr: u32);
}

struct RuntimeSlot(UnsafeCell<Option<HostState>>);
unsafe impl Sync for RuntimeSlot {}

static RUNTIME: RuntimeSlot = RuntimeSlot(UnsafeCell::new(None));

fn state_mut() -> Option<&'static mut HostState> {
    unsafe { (*RUNTIME.0.get()).as_mut() }
}

fn state_ref() -> Option<&'static HostState> {
    unsafe { (*RUNTIME.0.get()).as_ref() }
}

struct WasmGuestContext;

impl GuestContext for WasmGuestContext {
    fn mem_len(&self) -> usize {
        unsafe { host_mem_size() as usize }
    }

    fn mem_read(&self, addr: u64, buf: &mut [u8]) -> Result<(), i64> {
        if buf.is_empty() {
            return Ok(());
        }
        let gaddr = u32::try_from(addr).map_err(|_| -EFAULT)?;
        let len = u32::try_from(buf.len()).map_err(|_| -EFAULT)?;
        let rc = unsafe { host_read_guest(gaddr, buf.as_mut_ptr() as u32, len) };
        if rc == 0 {
            Ok(())
        } else {
            Err(-EFAULT)
        }
    }

    fn mem_write(&mut self, addr: u64, data: &[u8]) -> Result<(), i64> {
        if data.is_empty() {
            return Ok(());
        }
        let gaddr = u32::try_from(addr).map_err(|_| -EFAULT)?;
        let len = u32::try_from(data.len()).map_err(|_| -EFAULT)?;
        let rc = unsafe { host_write_guest(gaddr, data.as_ptr() as u32, len) };
        if rc == 0 {
            Ok(())
        } else {
            Err(-EFAULT)
        }
    }

    fn mem_zero(&mut self, addr: u64, len: usize) -> Result<(), i64> {
        if len == 0 {
            return Ok(());
        }
        let gaddr = u32::try_from(addr).map_err(|_| -ENOMEM)?;
        let ulen = u32::try_from(len).map_err(|_| -ENOMEM)?;
        let rc = unsafe { host_zero_guest(gaddr, ulen) };
        if rc == 0 {
            Ok(())
        } else {
            Err(-ENOMEM)
        }
    }

    fn mem_read_cstr(&self, addr: u64, max_len: usize) -> Result<String, i64> {
        if addr == 0 {
            return Err(-EFAULT);
        }
        let mem_size = self.mem_len();
        let start = usize::try_from(addr).map_err(|_| -EFAULT)?;
        if start >= mem_size {
            return Err(-EFAULT);
        }
        let max_avail = (mem_size - start).min(max_len);
        let mut buf = vec![0u8; max_avail];
        self.mem_read(addr, &mut buf)?;
        let nul = buf.iter().position(|&b| b == 0).ok_or(-EFAULT)?;
        String::from_utf8(buf[..nul].to_vec()).map_err(|_| -EINVAL)
    }

    fn get_fsbase(&self) -> i64 {
        unsafe { host_get_global(GLOBAL_ID_FSBASE) }
    }

    fn set_fsbase(&mut self, val: i64) {
        unsafe { host_set_global(GLOBAL_ID_FSBASE, val) }
    }

    fn get_gsbase(&self) -> i64 {
        unsafe { host_get_global(GLOBAL_ID_GSBASE) }
    }

    fn set_gsbase(&mut self, val: i64) {
        unsafe { host_set_global(GLOBAL_ID_GSBASE, val) }
    }

    fn get_rcx(&self) -> i64 {
        unsafe { host_get_global(GLOBAL_ID_RCX) }
    }

    fn set_rip(&mut self, val: i64) {
        unsafe { host_set_global(GLOBAL_ID_RIP, val) }
    }

    fn set_rsp(&mut self, val: i64) {
        unsafe { host_set_global(GLOBAL_ID_RSP, val) }
    }

    fn set_exit(&mut self, code: i32) {
        unsafe {
            host_set_global(GLOBAL_ID_EXIT_FLAG, 1);
            host_set_global(GLOBAL_ID_EXIT_CODE, code as i64);
        }
    }

    fn set_yield_flag(&mut self, val: i32) {
        unsafe { host_set_global(GLOBAL_ID_YIELD_FLAG, val as i64) }
    }

    fn set_quantum(&mut self, val: i32) {
        unsafe { host_set_global(GLOBAL_ID_QUANTUM, val as i64) }
    }

    fn save_ctx(&mut self, scratch_addr: u32) -> Result<[u8; CTX_SIZE], i64> {
        unsafe { host_save_ctx(scratch_addr) };
        let mut buf = [0u8; CTX_SIZE];
        self.mem_read(scratch_addr as u64, &mut buf)?;
        Ok(buf)
    }

    fn load_ctx(&mut self, scratch_addr: u32, buf: &[u8; CTX_SIZE]) -> Result<(), i64> {
        self.mem_write(scratch_addr as u64, buf)?;
        unsafe { host_load_ctx(scratch_addr) };
        Ok(())
    }
}

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return core::ptr::null_mut();
    }
    let mut buf = Vec::<u8>::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    core::mem::forget(buf);
    ptr
}

#[no_mangle]
pub extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }
    unsafe {
        let _ = Vec::from_raw_parts(ptr, 0, len);
    }
}

#[no_mangle]
pub extern "C" fn runtime_new() -> i32 {
    let vfs = VirtualFs::new_in_memory(&[]);
    let state = HostState::new(vfs);
    unsafe {
        *RUNTIME.0.get() = Some(state);
    }
    0
}

#[no_mangle]
pub extern "C" fn runtime_add_vfs_file(
    path_ptr: *const u8,
    path_len: usize,
    data_ptr: *const u8,
    data_len: usize,
    mode: u32,
) -> i32 {
    let Some(state) = state_mut() else {
        return -1;
    };
    if path_ptr.is_null() || path_len == 0 {
        return -1;
    }
    let path_bytes = unsafe { core::slice::from_raw_parts(path_ptr, path_len) };
    let Ok(path) = core::str::from_utf8(path_bytes) else {
        return -1;
    };
    let data = if data_ptr.is_null() || data_len == 0 {
        &[][..]
    } else {
        unsafe { core::slice::from_raw_parts(data_ptr, data_len) }
    };
    state.vfs.vfs_write_file(path, data, mode);
    0
}

#[no_mangle]
pub extern "C" fn runtime_read_vfs_file(
    path_ptr: *const u8,
    path_len: usize,
    out_len_ptr: *mut usize,
) -> *mut u8 {
    if out_len_ptr.is_null() || path_ptr.is_null() || path_len == 0 {
        return core::ptr::null_mut();
    }
    let Some(state) = state_ref() else {
        return core::ptr::null_mut();
    };
    let path_bytes = unsafe { core::slice::from_raw_parts(path_ptr, path_len) };
    let Ok(path) = core::str::from_utf8(path_bytes) else {
        return core::ptr::null_mut();
    };
    let Some(mut data) = state.vfs.vfs_read_file(path) else {
        unsafe {
            *out_len_ptr = 0;
        }
        return core::ptr::null_mut();
    };
    data.shrink_to_fit();
    let len = data.len();
    let ptr = data.as_mut_ptr();
    core::mem::forget(data);
    unsafe {
        *out_len_ptr = len;
    }
    ptr
}

fn decode_args_and_env(buf: &[u8], default_prog: &str) -> (Vec<String>, Vec<String>) {
    if buf.is_empty() {
        let prog = if default_prog.is_empty() {
            "app".to_string()
        } else {
            default_prog.to_string()
        };
        return (
            vec![prog],
            vec!["PATH=/usr/local/bin:/usr/bin:/bin".to_string()],
        );
    }

    // Length-prefixed format: b"E2WA" + u32 argc + [u32 len, bytes...] + u32 envc + [u32 len, bytes...]
    if buf.starts_with(b"E2WA") && buf.len() >= 8 {
        let mut pos = 4usize;
        let read_u32 = |p: &mut usize| -> Option<u32> {
            let end = p.checked_add(4)?;
            let v = u32::from_le_bytes(buf.get(*p..end)?.try_into().ok()?);
            *p = end;
            Some(v)
        };
        let read_str = |p: &mut usize| -> Option<String> {
            let len = read_u32(p)? as usize;
            let end = p.checked_add(len)?;
            let s = core::str::from_utf8(buf.get(*p..end)?).ok()?.to_string();
            *p = end;
            Some(s)
        };
        if let Some(argc) = read_u32(&mut pos) {
            let mut args = Vec::with_capacity((argc as usize).min(4096));
            for _ in 0..argc {
                if let Some(s) = read_str(&mut pos) {
                    args.push(s);
                } else {
                    break;
                }
            }
            let mut env = Vec::new();
            if let Some(envc) = read_u32(&mut pos) {
                for _ in 0..envc {
                    if let Some(s) = read_str(&mut pos) {
                        env.push(s);
                    } else {
                        break;
                    }
                }
            } else {
                env.push("PATH=/usr/local/bin:/usr/bin:/bin".to_string());
            }
            return (args, env);
        }
    }

    // NUL-separated format: argv strings separated by \0; optional \0\0 followed by envp strings
    let mut args = Vec::new();
    let mut env = Vec::new();
    let mut in_env = false;
    let mut start = 0usize;
    while start < buf.len() {
        let end = buf[start..]
            .iter()
            .position(|&b| b == 0)
            .map(|rel| start + rel)
            .unwrap_or(buf.len());
        if end == start {
            if !in_env {
                in_env = true;
                start = end + 1;
                continue;
            } else {
                break;
            }
        }
        let s = String::from_utf8_lossy(&buf[start..end]).into_owned();
        if in_env {
            env.push(s);
        } else {
            args.push(s);
        }
        start = end + 1;
    }
    if !in_env && env.is_empty() {
        env.push("PATH=/usr/local/bin:/usr/bin:/bin".to_string());
    }
    (args, env)
}

#[no_mangle]
pub extern "C" fn runtime_init_guest_stack(
    meta_ptr: *const u8,
    meta_len: usize,
    args_ptr: *const u8,
    args_len: usize,
) -> i32 {
    let Some(state) = state_mut() else {
        return -1;
    };
    if meta_ptr.is_null() || meta_len == 0 {
        return -1;
    }
    let meta_bytes = unsafe { core::slice::from_raw_parts(meta_ptr, meta_len) };
    let Ok(meta) = WasmMeta::decode(meta_bytes) else {
        return -2;
    };
    let args_bytes = if args_ptr.is_null() || args_len == 0 {
        &[][..]
    } else {
        unsafe { core::slice::from_raw_parts(args_ptr, args_len) }
    };
    let (args, env) = decode_args_and_env(args_bytes, &meta.elf_path);

    state.vfs.set_so_files(&meta.so_files);
    state.vfs.elf_path = meta.elf_path.clone();

    let mut ctx = WasmGuestContext;
    let Ok(rsp) = setup_guest_stack_ctx(&mut ctx, &meta, &args, &env) else {
        return -3;
    };
    ctx.set_rsp(rsp as i64);
    ctx.set_rip(meta.entry_rip as i64);
    0
}

#[no_mangle]
pub extern "C" fn runtime_handle_syscall(
    nr: i64,
    a0: i64,
    a1: i64,
    a2: i64,
    a3: i64,
    a4: i64,
    a5: i64,
) -> i64 {
    let Some(state) = state_mut() else {
        return -38;
    };
    let mut ctx = WasmGuestContext;
    handle_syscall(&mut ctx, state, nr, a0, a1, a2, a3, a4, a5)
}

#[no_mangle]
pub extern "C" fn runtime_on_yield() -> i32 {
    let Some(state) = state_mut() else {
        return 0;
    };
    let exit_flag = unsafe { host_get_global(GLOBAL_ID_EXIT_FLAG) } as i32;
    if exit_flag != 0 {
        return 0;
    }
    let yield_flag = unsafe { host_get_global(GLOBAL_ID_YIELD_FLAG) } as i32;
    if yield_flag == 0 {
        return 0;
    }
    let mut ctx = WasmGuestContext;
    match state.scheduler.on_yield(&mut ctx, yield_flag) {
        Ok(true) => 1,
        _ => 0,
    }
}

#[no_mangle]
pub extern "C" fn runtime_get_stdout(out_len_ptr: *mut usize) -> *const u8 {
    let Some(state) = state_ref() else {
        if !out_len_ptr.is_null() {
            unsafe { *out_len_ptr = 0 };
        }
        return core::ptr::null();
    };
    if !out_len_ptr.is_null() {
        unsafe { *out_len_ptr = state.vfs.stdout.len() };
    }
    state.vfs.stdout.as_ptr()
}

#[no_mangle]
pub extern "C" fn runtime_get_stderr(out_len_ptr: *mut usize) -> *const u8 {
    let Some(state) = state_ref() else {
        if !out_len_ptr.is_null() {
            unsafe { *out_len_ptr = 0 };
        }
        return core::ptr::null();
    };
    if !out_len_ptr.is_null() {
        unsafe { *out_len_ptr = state.vfs.stderr.len() };
    }
    state.vfs.stderr.as_ptr()
}

#[no_mangle]
pub extern "C" fn runtime_get_exit_code() -> i32 {
    unsafe { host_get_global(GLOBAL_ID_EXIT_CODE) as i32 }
}

#[no_mangle]
pub extern "C" fn runtime_get_virtual_time_ns() -> u64 {
    state_ref()
        .map(|s| s.scheduler.virtual_mono_ns)
        .unwrap_or(0)
}
