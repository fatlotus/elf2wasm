use crate::elf_loader::{BRK_START, MMAP_START};
use crate::vfs::{
    FileStat, VirtualFs, AT_FDCWD, EACCES, EBADF, EFAULT, EINVAL, ENOMEM, ENOSYS, ENOTTY, ERANGE,
};
use wasmtime::{Caller, Memory, Val};

// Bring in missing errno/access constants locally if not in vfs
const EAGAIN: i64 = 11;

pub const MMAP_END: u32 = 0x0B00_0000;

const SYS_READ: i64 = 0;
const SYS_WRITE: i64 = 1;
const SYS_OPEN: i64 = 2;
const SYS_CLOSE: i64 = 3;
const SYS_STAT: i64 = 4;
const SYS_FSTAT: i64 = 5;
const SYS_LSTAT: i64 = 6;
const SYS_LSEEK: i64 = 8;
const SYS_MMAP: i64 = 9;
const SYS_MPROTECT: i64 = 10;
const SYS_MUNMAP: i64 = 11;
const SYS_BRK: i64 = 12;
const SYS_RT_SIGACTION: i64 = 13;
const SYS_RT_SIGPROCMASK: i64 = 14;
const SYS_IOCTL: i64 = 16;
const SYS_PREAD64: i64 = 17;
const SYS_WRITEV: i64 = 20;
const SYS_ACCESS: i64 = 21;
const SYS_MREMAP: i64 = 25;
const SYS_DUP: i64 = 32;
const SYS_DUP2: i64 = 33;
const SYS_GETPID: i64 = 39;
const SYS_EXIT: i64 = 60;
const SYS_UNAME: i64 = 63;
const SYS_FCNTL: i64 = 72;
const SYS_GETCWD: i64 = 79;
const SYS_READLINK: i64 = 89;
const SYS_GETTIMEOFDAY: i64 = 96;
const SYS_GETRLIMIT: i64 = 97;
const SYS_SYSINFO: i64 = 99;
const SYS_GETUID: i64 = 102;
const SYS_GETGID: i64 = 104;
const SYS_GETEUID: i64 = 107;
const SYS_GETEGID: i64 = 108;
const SYS_SIGALTSTACK: i64 = 131;
const SYS_ARCH_PRCTL: i64 = 158;
const SYS_GETTID: i64 = 186;
const SYS_FUTEX: i64 = 202;
const SYS_SCHED_GETAFFINITY: i64 = 204;
const SYS_GETDENTS64: i64 = 217;
const SYS_SET_TID_ADDRESS: i64 = 218;
const SYS_CLOCK_GETTIME: i64 = 228;
const SYS_EXIT_GROUP: i64 = 231;
const SYS_OPENAT: i64 = 257;
const SYS_NEWFSTATAT: i64 = 262;
const SYS_READLINKAT: i64 = 267;
const SYS_FACCESSAT: i64 = 269;
const SYS_SET_ROBUST_LIST: i64 = 273;
const SYS_DUP3: i64 = 292;
const SYS_PIPE2: i64 = 293;
const SYS_PRLIMIT64: i64 = 302;
const SYS_GETRANDOM: i64 = 318;
const SYS_STATX: i64 = 332;
const SYS_RSEQ: i64 = 334;
const SYS_FACCESSAT2: i64 = 439;

const MAP_FIXED: i32 = 0x10;
const MAP_ANONYMOUS: i32 = 0x20;
const MAP_FIXED_NOREPLACE: i32 = 0x100000;
const MREMAP_MAYMOVE: i32 = 0x1;

const ARCH_SET_GS: i64 = 0x1001;
const ARCH_SET_FS: i64 = 0x1002;
const ARCH_GET_FS: i64 = 0x1003;
const ARCH_GET_GS: i64 = 0x1004;

pub struct HostState {
    pub vfs: VirtualFs,
    pub brk_curr: u32,
    pub mmap_cursor: u32,
    pub prng_state: u64,
}

impl HostState {
    pub fn new(vfs: VirtualFs) -> Self {
        Self {
            vfs,
            brk_curr: BRK_START,
            mmap_cursor: MMAP_START,
            prng_state: 0x9e37_79b9_7f4a_7c15,
        }
    }

    fn next_rand_u64(&mut self) -> u64 {
        let mut x = self.prng_state;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.prng_state = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
}

fn get_memory(caller: &mut Caller<'_, HostState>) -> Memory {
    caller
        .get_export("memory")
        .and_then(|e| e.into_memory())
        .expect("missing exported memory")
}

fn read_bytes(caller: &Caller<'_, HostState>, mem: &Memory, addr: u64, len: usize) -> Result<Vec<u8>, i64> {
    if len == 0 {
        return Ok(Vec::new());
    }
    if addr == 0 {
        return Err(-EFAULT);
    }
    let mem_size = mem.data_size(caller);
    let start = usize::try_from(addr).map_err(|_| -EFAULT)?;
    let end = start.checked_add(len).ok_or(-EFAULT)?;
    if end > mem_size {
        return Err(-EFAULT);
    }
    let mut buf = vec![0u8; len];
    mem.read(caller, start, &mut buf).map_err(|_| -EFAULT)?;
    Ok(buf)
}

fn write_bytes(caller: &mut Caller<'_, HostState>, mem: &Memory, addr: u64, data: &[u8]) -> Result<(), i64> {
    if data.is_empty() {
        return Ok(());
    }
    if addr == 0 {
        return Err(-EFAULT);
    }
    let mem_size = mem.data_size(&*caller);
    let start = usize::try_from(addr).map_err(|_| -EFAULT)?;
    let end = start.checked_add(data.len()).ok_or(-EFAULT)?;
    if end > mem_size {
        return Err(-EFAULT);
    }
    mem.write(caller, start, data).map_err(|_| -EFAULT)?;
    Ok(())
}

fn zero_fill(caller: &mut Caller<'_, HostState>, mem: &Memory, addr: u32, len: usize) -> Result<(), i64> {
    if len == 0 {
        return Ok(());
    }
    let mem_size = mem.data_size(&*caller);
    let start = addr as usize;
    let end = start.checked_add(len).ok_or(-ENOMEM)?;
    if end > mem_size {
        return Err(-ENOMEM);
    }
    let data = mem.data_mut(caller);
    data[start..end].fill(0);
    Ok(())
}

fn read_cstr(caller: &Caller<'_, HostState>, mem: &Memory, addr: u64) -> Result<String, i64> {
    if addr == 0 {
        return Err(-EFAULT);
    }
    let data = mem.data(caller);
    let start = usize::try_from(addr).map_err(|_| -EFAULT)?;
    if start >= data.len() {
        return Err(-EFAULT);
    }
    let max_end = (start + 4096).min(data.len());
    let slice = &data[start..max_end];
    let nul = slice.iter().position(|&b| b == 0).ok_or(-EFAULT)?;
    String::from_utf8(slice[..nul].to_vec()).map_err(|_| -EINVAL)
}

fn read_u64(caller: &Caller<'_, HostState>, mem: &Memory, addr: u64) -> Result<u64, i64> {
    let b = read_bytes(caller, mem, addr, 8)?;
    Ok(u64::from_le_bytes(b.try_into().unwrap()))
}

fn write_u64(caller: &mut Caller<'_, HostState>, mem: &Memory, addr: u64, val: u64) -> Result<(), i64> {
    write_bytes(caller, mem, addr, &val.to_le_bytes())
}

fn write_stat(caller: &mut Caller<'_, HostState>, mem: &Memory, addr: u64, st: &FileStat) -> Result<(), i64> {
    let mut buf = [0u8; 144];
    buf[0..8].copy_from_slice(&1u64.to_le_bytes()); // st_dev
    buf[8..16].copy_from_slice(&st.st_ino.to_le_bytes());
    buf[16..24].copy_from_slice(&st.st_nlink.to_le_bytes());
    buf[24..28].copy_from_slice(&st.st_mode.to_le_bytes());
    buf[28..32].copy_from_slice(&1000u32.to_le_bytes()); // st_uid
    buf[32..36].copy_from_slice(&1000u32.to_le_bytes()); // st_gid
    buf[48..56].copy_from_slice(&st.st_size.to_le_bytes());
    buf[56..64].copy_from_slice(&4096i64.to_le_bytes()); // st_blksize
    let blocks = (st.st_size + 511) / 512;
    buf[64..72].copy_from_slice(&blocks.to_le_bytes());
    write_bytes(caller, mem, addr, &buf)
}

fn align_up_4k(v: u32) -> Option<u32> {
    v.checked_add(4095).map(|x| x & !4095)
}

pub fn handle_syscall(
    caller: &mut Caller<'_, HostState>,
    nr: i64,
    a0: i64,
    a1: i64,
    a2: i64,
    a3: i64,
    a4: i64,
    a5: i64,
) -> i64 {
    let trace = std::env::var_os("ELF2WASM_TRACE").is_some();
    let ret = handle_syscall_inner(caller, nr, a0, a1, a2, a3, a4, a5);
    if trace {
        eprintln!(
            "[syscall] nr={} (0x{:x}, 0x{:x}, 0x{:x}, 0x{:x}, 0x{:x}, 0x{:x}) -> {} (0x{:x})",
            nr, a0, a1, a2, a3, a4, a5, ret, ret
        );
    }
    ret
}

fn handle_syscall_inner(
    caller: &mut Caller<'_, HostState>,
    nr: i64,
    a0: i64,
    a1: i64,
    a2: i64,
    a3: i64,
    a4: i64,
    a5: i64,
) -> i64 {
    let mem = get_memory(caller);

    match nr {
        SYS_READ => {
            let fd = a0 as i32;
            let buf_addr = a1 as u64;
            let count = a2 as usize;
            if count > 0 {
                let mem_size = mem.data_size(&*caller);
                if buf_addr == 0
                    || usize::try_from(buf_addr).map_or(true, |s| s >= mem_size)
                {
                    return -EFAULT;
                }
            }
            match caller.data_mut().vfs.read_no_advance(fd, count) {
                Ok((bytes, host_consumed)) => {
                    let n = bytes.len();
                    if let Err(e) = write_bytes(caller, &mem, buf_addr, &bytes) {
                        return e;
                    }
                    if !host_consumed {
                        caller.data_mut().vfs.advance_read_cursor(fd, n);
                    }
                    n as i64
                }
                Err(e) => e,
            }
        }
        SYS_PREAD64 => {
            let fd = a0 as i32;
            let buf_addr = a1 as u64;
            let count = a2 as usize;
            let offset = a3 as usize;
            if count > 0 && buf_addr == 0 {
                return -EFAULT;
            }
            match caller.data().vfs.pread64(fd, count, offset) {
                Ok(bytes) => {
                    let n = bytes.len();
                    if let Err(e) = write_bytes(caller, &mem, buf_addr, &bytes) {
                        return e;
                    }
                    n as i64
                }
                Err(e) => e,
            }
        }
        SYS_WRITE => {
            let fd = a0 as i32;
            let buf_addr = a1 as u64;
            let count = a2 as usize;
            let bytes = match read_bytes(caller, &mem, buf_addr, count) {
                Ok(b) => b,
                Err(e) => return e,
            };
            caller.data_mut().vfs.write(fd, &bytes)
        }
        SYS_WRITEV => {
            let fd = a0 as i32;
            let iov_addr = a1 as u64;
            let iovcnt = a2 as i32;
            if iovcnt < 0 || iovcnt > 1024 {
                return -EINVAL;
            }
            let mut total: i64 = 0;
            for i in 0..(iovcnt as u64) {
                let entry_addr = match i.checked_mul(16).and_then(|off| iov_addr.checked_add(off)) {
                    Some(a) => a,
                    None => return -EFAULT,
                };
                let len_addr = match entry_addr.checked_add(8) {
                    Some(a) => a,
                    None => return -EFAULT,
                };
                let base = match read_u64(caller, &mem, entry_addr) {
                    Ok(v) => v,
                    Err(e) => return e,
                };
                let len_u64 = match read_u64(caller, &mem, len_addr) {
                    Ok(v) => v,
                    Err(e) => return e,
                };
                let len = match usize::try_from(len_u64) {
                    Ok(l) => l,
                    Err(_) => return -EFAULT,
                };
                if len == 0 {
                    continue;
                }
                let bytes = match read_bytes(caller, &mem, base, len) {
                    Ok(b) => b,
                    Err(e) => return e,
                };
                let written = caller.data_mut().vfs.write(fd, &bytes);
                if written < 0 {
                    return written;
                }
                total += written;
            }
            total
        }
        SYS_OPEN => {
            let path = match read_cstr(caller, &mem, a0 as u64) {
                Ok(p) => p,
                Err(e) => return e,
            };
            caller.data_mut().vfs.openat(AT_FDCWD, &path, a1 as i32)
        }
        SYS_OPENAT => {
            let dirfd = a0 as i32;
            let path = match read_cstr(caller, &mem, a1 as u64) {
                Ok(p) => p,
                Err(e) => return e,
            };
            caller.data_mut().vfs.openat(dirfd, &path, a2 as i32)
        }
        SYS_CLOSE => caller.data_mut().vfs.close(a0 as i32),
        SYS_LSEEK => caller.data_mut().vfs.lseek(a0 as i32, a1, a2 as i32),
        SYS_STAT => {
            let path = match read_cstr(caller, &mem, a0 as u64) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let st = match caller.data().vfs.stat_path(AT_FDCWD, &path, 0) {
                Ok(s) => s,
                Err(e) => return e,
            };
            match write_stat(caller, &mem, a1 as u64, &st) {
                Ok(()) => 0,
                Err(e) => e,
            }
        }
        SYS_FSTAT => {
            let st = match caller.data().vfs.stat_fd(a0 as i32) {
                Ok(s) => s,
                Err(e) => return e,
            };
            match write_stat(caller, &mem, a1 as u64, &st) {
                Ok(()) => 0,
                Err(e) => e,
            }
        }
        SYS_LSTAT => {
            let path = match read_cstr(caller, &mem, a0 as u64) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let st = match caller.data().vfs.stat_path(AT_FDCWD, &path, 0x100) {
                Ok(s) => s,
                Err(e) => return e,
            };
            match write_stat(caller, &mem, a1 as u64, &st) {
                Ok(()) => 0,
                Err(e) => e,
            }
        }
        SYS_NEWFSTATAT => {
            let dirfd = a0 as i32;
            let path = match read_cstr(caller, &mem, a1 as u64) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let flags = a3 as i32;
            let st = match caller.data().vfs.stat_path(dirfd, &path, flags) {
                Ok(s) => s,
                Err(e) => return e,
            };
            match write_stat(caller, &mem, a2 as u64, &st) {
                Ok(()) => 0,
                Err(e) => e,
            }
        }
        SYS_ACCESS => {
            let path = match read_cstr(caller, &mem, a0 as u64) {
                Ok(p) => p,
                Err(e) => return e,
            };
            caller.data().vfs.access(AT_FDCWD, &path, a1 as i32)
        }
        SYS_FACCESSAT | SYS_FACCESSAT2 => {
            let dirfd = a0 as i32;
            let path = match read_cstr(caller, &mem, a1 as u64) {
                Ok(p) => p,
                Err(e) => return e,
            };
            caller.data().vfs.access(dirfd, &path, a2 as i32)
        }
        SYS_BRK => {
            let req = a0 as u64;
            let curr = caller.data().brk_curr;
            if req == 0 || req < BRK_START as u64 {
                return curr as i64;
            }
            if req >= MMAP_START as u64 {
                return curr as i64;
            }
            let new_brk = req as u32;
            if new_brk > curr {
                if let Err(_) = zero_fill(caller, &mem, curr, (new_brk - curr) as usize) {
                    return curr as i64;
                }
            }
            caller.data_mut().brk_curr = new_brk;
            new_brk as i64
        }
        SYS_MMAP => {
            let addr = a0 as u64;
            let len_u64 = a1 as u64;
            let flags = a3 as i32;
            let fd = a4 as i32;
            let offset_u64 = a5 as u64;
            if len_u64 == 0 {
                return -EINVAL;
            }
            let Ok(len_u32) = u32::try_from(len_u64) else {
                return -ENOMEM;
            };
            let Some(aligned) = align_up_4k(len_u32).filter(|&v| v > 0) else {
                return -ENOMEM;
            };
            let len = len_u32 as usize;
            let is_fixed = (flags & (MAP_FIXED | MAP_FIXED_NOREPLACE)) != 0;
            let is_anon = (flags & MAP_ANONYMOUS) != 0;

            let validate_fixed = |addr: u64| -> Result<u32, i64> {
                let fixed_addr = u32::try_from(addr).map_err(|_| -ENOMEM)?;
                if fixed_addr == 0 || (fixed_addr & 0xfff) != 0 {
                    return Err(-EINVAL);
                }
                let mem_size = mem.data_size(&*caller);
                if (fixed_addr as usize)
                    .checked_add(len)
                    .map_or(true, |end| end > mem_size)
                {
                    return Err(-ENOMEM);
                }
                Ok(fixed_addr)
            };

            if is_anon {
                let (target, new_cursor) = if is_fixed {
                    match validate_fixed(addr) {
                        Ok(t) => (t, None),
                        Err(e) => return e,
                    }
                } else {
                    let cur = caller.data().mmap_cursor;
                    let Some(next) = cur.checked_add(aligned) else {
                        return -ENOMEM;
                    };
                    if next > MMAP_END {
                        return -ENOMEM;
                    }
                    (cur, Some(next))
                };
                if let Err(e) = zero_fill(caller, &mem, target, len) {
                    return e;
                }
                if let Some(next) = new_cursor {
                    caller.data_mut().mmap_cursor = next;
                }
                return target as i64;
            }

            // File-backed mmap
            let (file_data, so_base, is_dir, is_std_or_pipe) = match caller.data().vfs.get_fd(fd) {
                Some(f) => (
                    f.data.clone(),
                    f.so_base_addr,
                    f.is_dir,
                    f.is_std.is_some() || f.is_pipe,
                ),
                None => return -EBADF,
            };
            if is_dir || is_std_or_pipe {
                return -EACCES;
            }
            let Ok(offset) = usize::try_from(offset_u64) else {
                return -EINVAL;
            };

            let (target, new_cursor) = if is_fixed {
                match validate_fixed(addr) {
                    Ok(t) => (t, None),
                    Err(e) => return e,
                }
            } else if let Some(base) = so_base {
                let Ok(off_u32) = u32::try_from(offset_u64) else {
                    return -EINVAL;
                };
                let Some(t) = base.checked_add(off_u32) else {
                    return -ENOMEM;
                };
                (t, None)
            } else {
                let cur = caller.data().mmap_cursor;
                let Some(next) = cur.checked_add(aligned) else {
                    return -ENOMEM;
                };
                if next > MMAP_END {
                    return -ENOMEM;
                }
                (cur, Some(next))
            };

            if let Err(e) = zero_fill(caller, &mem, target, len) {
                return e;
            }
            if offset < file_data.len() {
                let copy_len = len.min(file_data.len() - offset);
                if let Err(e) = write_bytes(
                    caller,
                    &mem,
                    target as u64,
                    &file_data[offset..offset + copy_len],
                ) {
                    return e;
                }
            }
            if let Some(next) = new_cursor {
                caller.data_mut().mmap_cursor = next;
            }
            target as i64
        }
        SYS_MPROTECT | SYS_MUNMAP => 0,
        SYS_MREMAP => {
            let old_addr_u64 = a0 as u64;
            let old_size_u64 = a1 as u64;
            let new_size_u64 = a2 as u64;
            let flags = a3 as i32;
            if old_addr_u64 == 0 {
                return -EFAULT;
            }
            let Ok(old_addr) = u32::try_from(old_addr_u64) else {
                return -EFAULT;
            };
            let Ok(old_size) = usize::try_from(old_size_u64) else {
                return -EINVAL;
            };
            let Ok(new_size_u32) = u32::try_from(new_size_u64) else {
                return -ENOMEM;
            };
            let new_size = new_size_u32 as usize;
            if new_size <= old_size {
                return old_addr as i64;
            }
            if (flags & MREMAP_MAYMOVE) == 0 {
                return -ENOMEM;
            }
            let Some(aligned) = align_up_4k(new_size_u32).filter(|&v| v > 0) else {
                return -ENOMEM;
            };
            let target = caller.data().mmap_cursor;
            let Some(next) = target.checked_add(aligned) else {
                return -ENOMEM;
            };
            if next > MMAP_END {
                return -ENOMEM;
            }
            let old_bytes = match read_bytes(caller, &mem, old_addr as u64, old_size) {
                Ok(b) => b,
                Err(e) => return e,
            };
            if let Err(e) = zero_fill(caller, &mem, target, aligned as usize) {
                return e;
            }
            if let Err(e) = write_bytes(caller, &mem, target as u64, &old_bytes) {
                return e;
            }
            caller.data_mut().mmap_cursor = next;
            target as i64
        }
        SYS_ARCH_PRCTL => {
            let code = a0;
            let addr = a1;
            match code {
                ARCH_SET_FS => {
                    if let Some(g) = caller.get_export("fsbase").and_then(|e| e.into_global()) {
                        let _ = g.set(&mut *caller, Val::I64(addr));
                    }
                    0
                }
                ARCH_GET_FS => {
                    let val = caller
                        .get_export("fsbase")
                        .and_then(|e| e.into_global())
                        .and_then(|g| g.get(&mut *caller).i64())
                        .unwrap_or(0) as u64;
                    match write_u64(caller, &mem, addr as u64, val) {
                        Ok(()) => 0,
                        Err(e) => e,
                    }
                }
                ARCH_SET_GS => {
                    if let Some(g) = caller.get_export("gsbase").and_then(|e| e.into_global()) {
                        let _ = g.set(&mut *caller, Val::I64(addr));
                    }
                    0
                }
                ARCH_GET_GS => {
                    let val = caller
                        .get_export("gsbase")
                        .and_then(|e| e.into_global())
                        .and_then(|g| g.get(&mut *caller).i64())
                        .unwrap_or(0) as u64;
                    match write_u64(caller, &mem, addr as u64, val) {
                        Ok(()) => 0,
                        Err(e) => e,
                    }
                }
                _ => -EINVAL,
            }
        }
        SYS_SET_TID_ADDRESS => 1000,
        SYS_SET_ROBUST_LIST => 0,
        SYS_RSEQ => -ENOSYS,
        SYS_PRLIMIT64 => {
            let resource = a1 as i32;
            let old_limit = a3 as u64;
            if old_limit != 0 {
                let (cur, max) = match resource {
                    3 => (8u64 * 1024 * 1024, u64::MAX), // RLIMIT_STACK
                    7 => (1024u64, 4096u64),            // RLIMIT_NOFILE
                    _ => (u64::MAX, u64::MAX),
                };
                let mut buf = [0u8; 16];
                buf[0..8].copy_from_slice(&cur.to_le_bytes());
                buf[8..16].copy_from_slice(&max.to_le_bytes());
                if let Err(e) = write_bytes(caller, &mem, old_limit, &buf) {
                    return e;
                }
            }
            0
        }
        SYS_GETRLIMIT => {
            let resource = a0 as i32;
            let rlim = a1 as u64;
            if rlim != 0 {
                let (cur, max) = match resource {
                    3 => (8u64 * 1024 * 1024, u64::MAX),
                    7 => (1024u64, 4096u64),
                    _ => (u64::MAX, u64::MAX),
                };
                let mut buf = [0u8; 16];
                buf[0..8].copy_from_slice(&cur.to_le_bytes());
                buf[8..16].copy_from_slice(&max.to_le_bytes());
                if let Err(e) = write_bytes(caller, &mem, rlim, &buf) {
                    return e;
                }
            }
            0
        }
        SYS_GETRANDOM => {
            let buf_addr = a0 as u64;
            let buflen = a1 as usize;
            if buflen == 0 {
                return 0;
            }
            if buf_addr == 0 {
                return -EFAULT;
            }
            let mem_size = mem.data_size(&*caller);
            let start = match usize::try_from(buf_addr) {
                Ok(s) => s,
                Err(_) => return -EFAULT,
            };
            let end = match start.checked_add(buflen) {
                Some(e) if e <= mem_size => e,
                _ => return -EFAULT,
            };
            let mut offset = start;
            while offset < end {
                let r = caller.data_mut().next_rand_u64().to_le_bytes();
                let chunk_len = (end - offset).min(8);
                mem.data_mut(&mut *caller)[offset..offset + chunk_len].copy_from_slice(&r[..chunk_len]);
                offset += chunk_len;
            }
            buflen as i64
        }
        SYS_FUTEX => {
            let op = (a1 as i32) & 0x7f;
            match op {
                0 | 9 => -EAGAIN, // FUTEX_WAIT / FUTEX_WAIT_BITSET
                _ => 0,           // FUTEX_WAKE etc.
            }
        }
        SYS_UNAME => {
            let buf_addr = a0 as u64;
            let mut buf = [0u8; 390];
            let fields: [(usize, &[u8]); 6] = [
                (0, b"Linux"),
                (65, b"sandbox"),
                (130, b"6.12.0"),
                (195, b"#1 SMP"),
                (260, b"x86_64"),
                (325, b"(none)"),
            ];
            for (off, s) in fields {
                buf[off..off + s.len()].copy_from_slice(s);
            }
            match write_bytes(caller, &mem, buf_addr, &buf) {
                Ok(()) => 0,
                Err(e) => e,
            }
        }
        SYS_GETUID | SYS_GETEUID | SYS_GETGID | SYS_GETEGID | SYS_GETPID | SYS_GETTID => 1000,
        SYS_CLOCK_GETTIME => {
            let tp = a1 as u64;
            if tp != 0 {
                let mut buf = [0u8; 16];
                buf[0..8].copy_from_slice(&1_700_000_000i64.to_le_bytes());
                if let Err(e) = write_bytes(caller, &mem, tp, &buf) {
                    return e;
                }
            }
            0
        }
        SYS_RT_SIGACTION => {
            let oldact = a2 as u64;
            if oldact != 0 {
                if let Err(e) = write_bytes(caller, &mem, oldact, &[0u8; 32]) {
                    return e;
                }
            }
            0
        }
        SYS_RT_SIGPROCMASK => {
            let oldset = a2 as u64;
            let sigsetsize = a3 as usize;
            if oldset != 0 && sigsetsize <= 128 {
                let zeros = vec![0u8; sigsetsize];
                if let Err(e) = write_bytes(caller, &mem, oldset, &zeros) {
                    return e;
                }
            }
            0
        }
        SYS_FCNTL => {
            let fd = a0 as i32;
            let cmd = a1 as i32;
            let arg = a2 as i32;
            const F_DUPFD: i32 = 0;
            const F_GETFD: i32 = 1;
            const F_SETFD: i32 = 2;
            const F_GETFL: i32 = 3;
            const F_SETFL: i32 = 4;
            const F_DUPFD_CLOEXEC: i32 = 1030;
            match cmd {
                F_DUPFD | F_DUPFD_CLOEXEC => caller.data_mut().vfs.dup_from(fd, arg),
                F_GETFD | F_SETFD | F_GETFL | F_SETFL => {
                    if caller.data().vfs.get_fd(fd).is_some() {
                        0
                    } else {
                        -EBADF
                    }
                }
                _ => 0,
            }
        }
        SYS_IOCTL => -ENOTTY,
        SYS_DUP => caller.data_mut().vfs.dup(a0 as i32),
        SYS_DUP2 => caller.data_mut().vfs.dup2(a0 as i32, a1 as i32),
        SYS_DUP3 => {
            let oldfd = a0 as i32;
            let newfd = a1 as i32;
            if oldfd == newfd {
                -EINVAL
            } else {
                caller.data_mut().vfs.dup2(oldfd, newfd)
            }
        }
        SYS_PIPE2 => {
            let pipefd_addr = a0 as u64;
            if pipefd_addr == 0 {
                return -EFAULT;
            }
            let (rfd, wfd) = match caller.data_mut().vfs.create_pipe() {
                Ok(fds) => fds,
                Err(e) => return e,
            };
            let mut buf = [0u8; 8];
            buf[0..4].copy_from_slice(&rfd.to_le_bytes());
            buf[4..8].copy_from_slice(&wfd.to_le_bytes());
            match write_bytes(caller, &mem, pipefd_addr, &buf) {
                Ok(()) => 0,
                Err(e) => {
                    caller.data_mut().vfs.close(rfd);
                    caller.data_mut().vfs.close(wfd);
                    e
                }
            }
        }
        SYS_GETCWD => {
            let buf_addr = a0 as u64;
            let size = a1 as usize;
            if size < 2 {
                return -ERANGE;
            }
            match write_bytes(caller, &mem, buf_addr, b"/\0") {
                Ok(()) => 2,
                Err(e) => e,
            }
        }
        SYS_GETDENTS64 => {
            let fd = a0 as i32;
            let dirp = a1 as u64;
            let count = a2 as usize;
            match caller.data_mut().vfs.getdents64(fd, count) {
                Ok(bytes) => {
                    let n = bytes.len();
                    if n > 0 {
                        if let Err(e) = write_bytes(caller, &mem, dirp, &bytes) {
                            return e;
                        }
                    }
                    n as i64
                }
                Err(e) => e,
            }
        }
        SYS_READLINK => {
            let path = match read_cstr(caller, &mem, a0 as u64) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let buf_addr = a1 as u64;
            let bufsiz_signed = a2 as isize;
            if bufsiz_signed <= 0 {
                return -EINVAL;
            }
            let bufsiz = bufsiz_signed as usize;
            match caller.data().vfs.readlink(AT_FDCWD, &path) {
                Ok(target) => {
                    let n = target.len().min(bufsiz);
                    if n > 0 {
                        if let Err(e) = write_bytes(caller, &mem, buf_addr, &target[..n]) {
                            return e;
                        }
                    }
                    n as i64
                }
                Err(e) => e,
            }
        }
        SYS_READLINKAT => {
            let dirfd = a0 as i32;
            let path = match read_cstr(caller, &mem, a1 as u64) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let buf_addr = a2 as u64;
            let bufsiz_signed = a3 as isize;
            if bufsiz_signed <= 0 {
                return -EINVAL;
            }
            let bufsiz = bufsiz_signed as usize;
            match caller.data().vfs.readlink(dirfd, &path) {
                Ok(target) => {
                    let n = target.len().min(bufsiz);
                    if n > 0 {
                        if let Err(e) = write_bytes(caller, &mem, buf_addr, &target[..n]) {
                            return e;
                        }
                    }
                    n as i64
                }
                Err(e) => e,
            }
        }
        SYS_SYSINFO => {
            let info_addr = a0 as u64;
            let mut buf = [0u8; 112];
            buf[0..8].copy_from_slice(&1000i64.to_le_bytes()); // uptime
            buf[32..40].copy_from_slice(&(256u64 * 1024 * 1024).to_le_bytes()); // totalram
            buf[40..48].copy_from_slice(&(128u64 * 1024 * 1024).to_le_bytes()); // freeram
            buf[80..82].copy_from_slice(&1u16.to_le_bytes()); // procs
            buf[104..108].copy_from_slice(&1u32.to_le_bytes()); // mem_unit
            match write_bytes(caller, &mem, info_addr, &buf) {
                Ok(()) => 0,
                Err(e) => e,
            }
        }
        SYS_GETTIMEOFDAY => {
            let tv = a0 as u64;
            if tv != 0 {
                let mut buf = [0u8; 16];
                buf[0..8].copy_from_slice(&1_700_000_000i64.to_le_bytes());
                if let Err(e) = write_bytes(caller, &mem, tv, &buf) {
                    return e;
                }
            }
            0
        }
        SYS_SIGALTSTACK => {
            let old_ss = a1 as u64;
            if old_ss != 0 {
                let mut buf = [0u8; 24];
                buf[8..12].copy_from_slice(&2i32.to_le_bytes()); // SS_DISABLE
                if let Err(e) = write_bytes(caller, &mem, old_ss, &buf) {
                    return e;
                }
            }
            0
        }
        SYS_SCHED_GETAFFINITY => {
            let cpusetsize = a1 as usize;
            let mask_addr = a2 as u64;
            if cpusetsize < 8 {
                return -EINVAL;
            }
            let mut buf = vec![0u8; cpusetsize.min(128)];
            buf[0] = 1; // CPU 0
            match write_bytes(caller, &mem, mask_addr, &buf) {
                Ok(()) => 8,
                Err(e) => e,
            }
        }
        SYS_STATX => {
            let dirfd = a0 as i32;
            let path = match read_cstr(caller, &mem, a1 as u64) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let flags = a2 as i32;
            let statxbuf = a4 as u64;
            let st = match caller.data().vfs.stat_path(dirfd, &path, flags) {
                Ok(s) => s,
                Err(e) => return e,
            };
            let mut buf = [0u8; 256];
            buf[0..4].copy_from_slice(&0x0fffu32.to_le_bytes()); // stx_mask (STATX_BASIC_STATS)
            buf[4..8].copy_from_slice(&4096u32.to_le_bytes()); // stx_blksize
            buf[16..20].copy_from_slice(&(st.st_nlink as u32).to_le_bytes());
            buf[20..24].copy_from_slice(&1000u32.to_le_bytes()); // stx_uid
            buf[24..28].copy_from_slice(&1000u32.to_le_bytes()); // stx_gid
            buf[28..30].copy_from_slice(&(st.st_mode as u16).to_le_bytes());
            buf[32..40].copy_from_slice(&st.st_ino.to_le_bytes());
            buf[40..48].copy_from_slice(&(st.st_size as u64).to_le_bytes());
            let blocks = ((st.st_size + 511) / 512) as u64;
            buf[48..56].copy_from_slice(&blocks.to_le_bytes());
            match write_bytes(caller, &mem, statxbuf, &buf) {
                Ok(()) => 0,
                Err(e) => e,
            }
        }
        SYS_EXIT | SYS_EXIT_GROUP => {
            if let Some(g) = caller.get_export("exit_flag").and_then(|e| e.into_global()) {
                let _ = g.set(&mut *caller, Val::I32(1));
            }
            if let Some(g) = caller.get_export("exit_code").and_then(|e| e.into_global()) {
                let _ = g.set(&mut *caller, Val::I32(a0 as i32));
            }
            0
        }
        _ => -ENOSYS,
    }
}
