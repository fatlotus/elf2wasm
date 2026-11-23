//! WASM-compiled `elf2wasm` runtime (`cdylib`).
//!
//! Bridges guest syscalls, writable VFS overlay, deterministic simulated time,
//! and cooperative multi-threading to a host/JS shim via `"env"` imports.

use core::cell::UnsafeCell;
use elf2wasm_core::lifter::{CTX_SIZE, YIELD_SYSCALL_PENDING};
use elf2wasm_core::meta::WasmMeta;
use elf2wasm_runtime_core::context::{GuestContext, HostFsProvider};
use elf2wasm_runtime_core::scheduler::ThreadState;
use elf2wasm_runtime_core::stack::setup_guest_stack_ctx_with_ids;
use elf2wasm_runtime_core::syscalls::{handle_syscall, HostState, PendingHostAction};
use elf2wasm_runtime_core::vfs::{
    path_hash, DirEntry, FileStat, VirtualFs, AT_FDCWD, EFAULT, EINVAL, ENOMEM,
};

const GLOBAL_ID_FSBASE: u32 = 0;
const GLOBAL_ID_GSBASE: u32 = 1;
const GLOBAL_ID_RCX: u32 = 2;
const GLOBAL_ID_RIP: u32 = 3;
const GLOBAL_ID_RSP: u32 = 4;
const GLOBAL_ID_EXIT_FLAG: u32 = 5;
const GLOBAL_ID_EXIT_CODE: u32 = 6;
const GLOBAL_ID_YIELD_FLAG: u32 = 7;
const GLOBAL_ID_QUANTUM: u32 = 8;
const GLOBAL_ID_RAX: u32 = 9;
const GLOBAL_ID_RDI: u32 = 10;
const GLOBAL_ID_RSI: u32 = 11;
const GLOBAL_ID_RDX: u32 = 12;
const GLOBAL_ID_R10: u32 = 13;
const GLOBAL_ID_R8: u32 = 14;
const GLOBAL_ID_R9: u32 = 15;

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
    fn host_vfs_is_ro_mount(path_ptr: *const u8, path_len: usize) -> i32;
    fn host_vfs_stat_ro(
        path_ptr: *const u8,
        path_len: usize,
        out_mode_ptr: *mut u32,
        out_size_ptr: *mut i64,
    ) -> i32;
    fn host_vfs_read_ro(path_ptr: *const u8, path_len: usize, out_len_ptr: *mut usize) -> *mut u8;
    fn host_vfs_list_dir_ro(
        path_ptr: *const u8,
        path_len: usize,
        out_len_ptr: *mut usize,
    ) -> *mut u8;
    fn host_vfs_is_virtual_parent(path_ptr: *const u8, path_len: usize) -> i32;
}

struct WasmHostFs;

impl HostFsProvider for WasmHostFs {
    fn is_under_ro_mount(&self, norm_path: &str) -> bool {
        let b = norm_path.as_bytes();
        unsafe { host_vfs_is_ro_mount(b.as_ptr(), b.len()) != 0 }
    }

    fn stat_host_ro(&self, norm_path: &str) -> Option<FileStat> {
        let b = norm_path.as_bytes();
        let mut mode = 0u32;
        let mut size = 0i64;
        let rc = unsafe { host_vfs_stat_ro(b.as_ptr(), b.len(), &mut mode, &mut size) };
        if rc != 0 {
            return None;
        }
        let is_dir = (mode & 0o170000) == 0o040000;
        Some(FileStat {
            st_ino: path_hash(norm_path),
            st_mode: mode,
            st_nlink: if is_dir { 2 } else { 1 },
            st_size: size,
            mtime_ns: 0,
        })
    }

    fn read_host_ro(&self, norm_path: &str) -> Option<Vec<u8>> {
        let b = norm_path.as_bytes();
        let mut len = 0usize;
        let ptr = unsafe { host_vfs_read_ro(b.as_ptr(), b.len(), &mut len) };
        if ptr.is_null() {
            return None;
        }
        let vec = unsafe { Vec::from_raw_parts(ptr, len, len) };
        Some(vec)
    }

    fn list_host_ro_dir(&self, norm_path: &str) -> Option<Vec<DirEntry>> {
        let b = norm_path.as_bytes();
        let mut len = 0usize;
        let ptr = unsafe { host_vfs_list_dir_ro(b.as_ptr(), b.len(), &mut len) };
        if ptr.is_null() {
            return None;
        }
        let buf = unsafe { Vec::from_raw_parts(ptr, len, len) };
        let mut out = Vec::new();
        let mut pos = 0usize;
        while pos + 3 <= buf.len() {
            let d_type = buf[pos];
            let name_len = u16::from_le_bytes([buf[pos + 1], buf[pos + 2]]) as usize;
            pos += 3;
            if pos + name_len > buf.len() {
                break;
            }
            if let Ok(name) = core::str::from_utf8(&buf[pos..pos + name_len]) {
                let child = if norm_path == "/" {
                    format!("/{}", name)
                } else {
                    format!("{}/{}", norm_path, name)
                };
                out.push(DirEntry {
                    d_ino: path_hash(&child),
                    d_type,
                    name: name.to_string(),
                });
            }
            pos += name_len;
        }
        Some(out)
    }

    fn is_virtual_allowlist_parent(&self, norm_path: &str) -> bool {
        let b = norm_path.as_bytes();
        unsafe { host_vfs_is_virtual_parent(b.as_ptr(), b.len()) != 0 }
    }

    fn host_file_size(&self, host_path: &str) -> Option<u64> {
        self.stat_host_ro(host_path).map(|s| s.st_size as u64)
    }

    fn read_inherited_stdin(&mut self, _max_bytes: usize) -> Result<Vec<u8>, i64> {
        Ok(Vec::new())
    }

    fn mount_guest_prefixes(&self) -> Vec<String> {
        Vec::new()
    }

    fn allowlist_entries(&self) -> Vec<(String, bool)> {
        Vec::new()
    }
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

    fn get_rax(&self) -> i64 {
        unsafe { host_get_global(GLOBAL_ID_RAX) }
    }

    fn set_rax(&mut self, val: i64) {
        unsafe { host_set_global(GLOBAL_ID_RAX, val) }
    }

    fn get_rdi(&self) -> i64 {
        unsafe { host_get_global(GLOBAL_ID_RDI) }
    }

    fn get_rsi(&self) -> i64 {
        unsafe { host_get_global(GLOBAL_ID_RSI) }
    }

    fn get_rdx(&self) -> i64 {
        unsafe { host_get_global(GLOBAL_ID_RDX) }
    }

    fn get_r10(&self) -> i64 {
        unsafe { host_get_global(GLOBAL_ID_R10) }
    }

    fn get_r8(&self) -> i64 {
        unsafe { host_get_global(GLOBAL_ID_R8) }
    }

    fn get_r9(&self) -> i64 {
        unsafe { host_get_global(GLOBAL_ID_R9) }
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
    let vfs = VirtualFs::with_provider(&[], Box::new(WasmHostFs));
    let mut state = HostState::new(vfs);
    state.multiproc_enabled = true;
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
pub extern "C" fn runtime_add_vfs_symlink(
    path_ptr: *const u8,
    path_len: usize,
    target_ptr: *const u8,
    target_len: usize,
) -> i32 {
    let Some(state) = state_mut() else {
        return -1;
    };
    if path_ptr.is_null() || path_len == 0 || target_ptr.is_null() || target_len == 0 {
        return -1;
    }
    let path_bytes = unsafe { core::slice::from_raw_parts(path_ptr, path_len) };
    let Ok(path) = core::str::from_utf8(path_bytes) else {
        return -1;
    };
    let target_bytes = unsafe { core::slice::from_raw_parts(target_ptr, target_len) };
    let Ok(target) = core::str::from_utf8(target_bytes) else {
        return -1;
    };
    state.vfs.vfs_add_symlink(path, target);
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

#[no_mangle]
pub extern "C" fn runtime_read_vfs_link(
    path_ptr: *const u8,
    path_len: usize,
    out_len_ptr: *mut usize,
) -> *mut u8 {
    if out_len_ptr.is_null() || path_ptr.is_null() || path_len == 0 {
        return core::ptr::null_mut();
    }
    let Some(state) = state_ref() else {
        unsafe {
            *out_len_ptr = 0;
        }
        return core::ptr::null_mut();
    };
    let path_bytes = unsafe { core::slice::from_raw_parts(path_ptr, path_len) };
    let Ok(path) = core::str::from_utf8(path_bytes) else {
        unsafe {
            *out_len_ptr = 0;
        }
        return core::ptr::null_mut();
    };
    let Ok(mut target) = state.vfs.readlink(AT_FDCWD, path) else {
        unsafe {
            *out_len_ptr = 0;
        }
        return core::ptr::null_mut();
    };
    target.shrink_to_fit();
    let len = target.len();
    let ptr = target.as_mut_ptr();
    core::mem::forget(target);
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

    state.reset_for_new_run();
    state.apply_meta_layout(&meta);
    state.vfs.set_so_files(&meta.so_files);
    state.vfs.elf_path = meta.elf_path.clone();
    state.vfs.cmdline = args.clone();

    let mut ctx = WasmGuestContext;
    let Ok(rsp) =
        setup_guest_stack_ctx_with_ids(&mut ctx, &meta, &args, &env, state.uid, state.gid)
    else {
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
    if state.is_main_exited() {
        return 0;
    }
    let mut yield_flag = unsafe { host_get_global(GLOBAL_ID_YIELD_FLAG) } as i32;
    let mut exit_flag = unsafe { host_get_global(GLOBAL_ID_EXIT_FLAG) } as i32;
    if exit_flag != 0 && state.pending_action.is_none() {
        return 0;
    }
    let mut ctx = WasmGuestContext;
    if yield_flag == YIELD_SYSCALL_PENDING {
        let nr = ctx.get_rax();
        let a0 = ctx.get_rdi();
        let a1 = ctx.get_rsi();
        let a2 = ctx.get_rdx();
        let a3 = ctx.get_r10();
        let a4 = ctx.get_r8();
        let a5 = ctx.get_r9();
        let ret = handle_syscall(&mut ctx, state, nr, a0, a1, a2, a3, a4, a5);
        ctx.set_rax(ret);

        if state.is_main_exited() {
            return 0;
        }
        yield_flag = unsafe { host_get_global(GLOBAL_ID_YIELD_FLAG) } as i32;
        exit_flag = unsafe { host_get_global(GLOBAL_ID_EXIT_FLAG) } as i32;
        if exit_flag != 0 && state.pending_action.is_none() {
            return 0;
        }
        if yield_flag == YIELD_SYSCALL_PENDING {
            let other_runnable = !state.scheduler.run_queue.is_empty()
                || state.has_expired_timed_waiter()
                || state.processes.iter().any(|(&pid, p)| {
                    pid != state.active_pid
                        && !p.exited
                        && p.scheduler
                            .threads
                            .values()
                            .any(|t| t.state == ThreadState::Runnable)
                });
            if !other_runnable {
                ctx.set_yield_flag(0);
                return 1;
            }
        }
    }
    if yield_flag == 0 && state.pending_action.is_none() {
        return 0;
    }
    state
        .on_yield_multiproc(&mut ctx, yield_flag)
        .unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn runtime_get_active_pid() -> i32 {
    state_ref().map(|s| s.active_pid).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn runtime_get_pending_child_pid() -> i32 {
    let Some(state) = state_ref() else {
        return -1;
    };
    match state.pending_action {
        Some(PendingHostAction::Fork { child_pid, .. }) => child_pid,
        _ => -1,
    }
}

#[no_mangle]
pub extern "C" fn runtime_get_pending_scratch_addr() -> u32 {
    let Some(state) = state_ref() else {
        return 0;
    };
    match state.pending_action {
        Some(PendingHostAction::Fork { scratch_addr, .. }) => scratch_addr,
        _ => state.scheduler.scratch_addr,
    }
}

#[no_mangle]
pub extern "C" fn runtime_ack_fork(child_pid: i32) -> i32 {
    let Some(state) = state_mut() else {
        return -1;
    };
    if state.ack_fork(child_pid) {
        0
    } else {
        -1
    }
}

#[no_mangle]
pub extern "C" fn runtime_resume_active() -> i32 {
    let Some(state) = state_mut() else {
        return -1;
    };
    let mut ctx = WasmGuestContext;
    match state.resume_active(&mut ctx) {
        Ok(true) => 1,
        Ok(false) => 0,
        Err(_) => -1,
    }
}

#[no_mangle]
pub extern "C" fn runtime_get_exec_info(out_len_ptr: *mut usize) -> *mut u8 {
    if out_len_ptr.is_null() {
        return core::ptr::null_mut();
    }
    let Some(state) = state_ref() else {
        unsafe { *out_len_ptr = 0 };
        return core::ptr::null_mut();
    };
    let Some(PendingHostAction::Exec {
        pid,
        ref path,
        ref argv,
        ref envp,
    }) = state.pending_action
    else {
        unsafe { *out_len_ptr = 0 };
        return core::ptr::null_mut();
    };

    let mut out = Vec::new();
    out.extend_from_slice(b"E2WE");
    out.extend_from_slice(&pid.to_le_bytes());
    let pb = path.as_bytes();
    out.extend_from_slice(&(pb.len() as u32).to_le_bytes());
    out.extend_from_slice(pb);
    out.extend_from_slice(&(argv.len() as u32).to_le_bytes());
    for a in argv {
        let ab = a.as_bytes();
        out.extend_from_slice(&(ab.len() as u32).to_le_bytes());
        out.extend_from_slice(ab);
    }
    out.extend_from_slice(&(envp.len() as u32).to_le_bytes());
    for e in envp {
        let eb = e.as_bytes();
        out.extend_from_slice(&(eb.len() as u32).to_le_bytes());
        out.extend_from_slice(eb);
    }
    out.shrink_to_fit();
    let len = out.len();
    let ptr = out.as_mut_ptr();
    core::mem::forget(out);
    unsafe { *out_len_ptr = len };
    ptr
}

#[no_mangle]
pub extern "C" fn runtime_complete_exec(
    pid: i32,
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
    let mut ctx = WasmGuestContext;
    if state
        .complete_exec(&mut ctx, pid, &meta, &args, &env)
        .is_err()
    {
        return -3;
    }
    0
}

#[no_mangle]
pub extern "C" fn runtime_is_exited() -> i32 {
    let Some(state) = state_ref() else {
        return 1;
    };
    if state.is_main_exited() {
        1
    } else {
        0
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

#[no_mangle]
pub extern "C" fn runtime_push_stdin(ptr: *const u8, len: usize) -> i32 {
    let Some(state) = state_mut() else {
        return -1;
    };
    if len > 0 {
        if ptr.is_null() {
            return -1;
        }
        let bytes = unsafe { core::slice::from_raw_parts(ptr, len) };
        state.push_stdin(bytes);
    } else {
        state.wake_ready_waiters();
    }
    0
}

#[no_mangle]
pub extern "C" fn runtime_close_stdin() {
    if let Some(state) = state_mut() {
        state.close_stdin();
    }
}

fn export_owned_bytes(mut bytes: Vec<u8>, out_len_ptr: *mut usize) -> *mut u8 {
    if bytes.is_empty() {
        if !out_len_ptr.is_null() {
            unsafe { *out_len_ptr = 0 };
        }
        return core::ptr::null_mut();
    }
    bytes.shrink_to_fit();
    let len = bytes.len();
    let ptr = bytes.as_mut_ptr();
    core::mem::forget(bytes);
    if !out_len_ptr.is_null() {
        unsafe { *out_len_ptr = len };
    }
    ptr
}

#[no_mangle]
pub extern "C" fn runtime_drain_stdout(out_len_ptr: *mut usize) -> *mut u8 {
    if out_len_ptr.is_null() {
        return core::ptr::null_mut();
    }
    let Some(state) = state_mut() else {
        unsafe { *out_len_ptr = 0 };
        return core::ptr::null_mut();
    };
    let bytes = state.vfs.drain_stdout();
    export_owned_bytes(bytes, out_len_ptr)
}

#[no_mangle]
pub extern "C" fn runtime_drain_stderr(out_len_ptr: *mut usize) -> *mut u8 {
    if out_len_ptr.is_null() {
        return core::ptr::null_mut();
    }
    let Some(state) = state_mut() else {
        unsafe { *out_len_ptr = 0 };
        return core::ptr::null_mut();
    };
    let bytes = state.vfs.drain_stderr();
    export_owned_bytes(bytes, out_len_ptr)
}

#[no_mangle]
pub extern "C" fn runtime_take_reaped_pids(out_len_ptr: *mut usize) -> *mut u8 {
    if out_len_ptr.is_null() {
        return core::ptr::null_mut();
    }
    let Some(state) = state_mut() else {
        unsafe { *out_len_ptr = 0 };
        return core::ptr::null_mut();
    };
    let pids = state.take_reaped_pids();
    if pids.is_empty() {
        unsafe { *out_len_ptr = 0 };
        return core::ptr::null_mut();
    }
    let mut out = Vec::with_capacity(pids.len() * 4);
    for pid in pids {
        out.extend_from_slice(&(pid as u32).to_le_bytes());
    }
    export_owned_bytes(out, out_len_ptr)
}

#[no_mangle]
pub extern "C" fn runtime_set_winsize(rows: u32, cols: u32) {
    if let Some(state) = state_mut() {
        state.set_winsize(rows, cols);
    }
}

#[no_mangle]
pub extern "C" fn runtime_set_tty_mode(enabled: i32) {
    if let Some(state) = state_mut() {
        state.set_tty_mode(enabled != 0);
    }
}

#[no_mangle]
pub extern "C" fn runtime_set_stdin_open(open: i32) {
    if let Some(state) = state_mut() {
        state.set_stdin_open(open != 0);
    }
}

#[no_mangle]
pub extern "C" fn runtime_send_sigint() {
    if let Some(state) = state_mut() {
        state.send_sigint();
    }
}

#[no_mangle]
pub extern "C" fn runtime_set_uid_gid(uid: u32, gid: u32) {
    if let Some(state) = state_mut() {
        state.set_uid_gid(uid, gid);
    }
}

#[no_mangle]
pub extern "C" fn runtime_add_vfs_dir(
    path_ptr: *const u8,
    path_len: usize,
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
    state.vfs.vfs_add_dir(path, mode);
    0
}

#[no_mangle]
pub extern "C" fn runtime_remove_vfs_path(path_ptr: *const u8, path_len: usize) -> i32 {
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
    state.vfs.vfs_remove_path(path);
    0
}
