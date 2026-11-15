use crate::context::GuestContext;
use crate::scheduler::{Scheduler, ThreadContext, ThreadState};
use crate::vfs::{
    FileStat, VirtualFs, AT_FDCWD, AT_REMOVEDIR, EACCES, EAGAIN, EBADF, EFAULT, EINVAL, ENOMEM,
    ENOSYS, ENOTTY, ERANGE, ETIMEDOUT,
};
use elf2wasm_core::elf_loader::{BRK_START, MMAP_START};

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
const SYS_PWRITE64: i64 = 18;
const SYS_WRITEV: i64 = 20;
const SYS_ACCESS: i64 = 21;
const SYS_SCHED_YIELD: i64 = 24;
const SYS_MREMAP: i64 = 25;
const SYS_DUP: i64 = 32;
const SYS_DUP2: i64 = 33;
const SYS_NANOSLEEP: i64 = 35;
const SYS_GETPID: i64 = 39;
const SYS_CLONE: i64 = 56;
const SYS_EXIT: i64 = 60;
const SYS_UNAME: i64 = 63;
const SYS_FCNTL: i64 = 72;
const SYS_TRUNCATE: i64 = 76;
const SYS_FTRUNCATE: i64 = 77;
const SYS_GETCWD: i64 = 79;
const SYS_CHDIR: i64 = 80;
const SYS_FCHDIR: i64 = 81;
const SYS_RENAME: i64 = 82;
const SYS_MKDIR: i64 = 83;
const SYS_RMDIR: i64 = 84;
const SYS_UNLINK: i64 = 87;
const SYS_READLINK: i64 = 89;
const SYS_CHMOD: i64 = 90;
const SYS_FCHMOD: i64 = 91;
const SYS_GETTIMEOFDAY: i64 = 96;
const SYS_GETRLIMIT: i64 = 97;
const SYS_SYSINFO: i64 = 99;
const SYS_GETUID: i64 = 102;
const SYS_GETGID: i64 = 104;
const SYS_GETEUID: i64 = 107;
const SYS_GETEGID: i64 = 108;
const SYS_SIGALTSTACK: i64 = 131;
const SYS_PRCTL: i64 = 157;
const SYS_ARCH_PRCTL: i64 = 158;
const SYS_GETTID: i64 = 186;
const SYS_TKILL: i64 = 200;
const SYS_TIME: i64 = 201;
const SYS_FUTEX: i64 = 202;
const SYS_SCHED_GETAFFINITY: i64 = 204;
const SYS_GETDENTS64: i64 = 217;
const SYS_SET_TID_ADDRESS: i64 = 218;
const SYS_CLOCK_GETTIME: i64 = 228;
const SYS_CLOCK_GETRES: i64 = 229;
const SYS_CLOCK_NANOSLEEP: i64 = 230;
const SYS_EXIT_GROUP: i64 = 231;
const SYS_TGKILL: i64 = 234;
const SYS_OPENAT: i64 = 257;
const SYS_MKDIRAT: i64 = 258;
const SYS_NEWFSTATAT: i64 = 262;
const SYS_UNLINKAT: i64 = 263;
const SYS_RENAMEAT: i64 = 264;
const SYS_READLINKAT: i64 = 267;
const SYS_FCHMODAT: i64 = 268;
const SYS_FACCESSAT: i64 = 269;
const SYS_SET_ROBUST_LIST: i64 = 273;
const SYS_UTIMENSAT: i64 = 280;
const SYS_DUP3: i64 = 292;
const SYS_PIPE2: i64 = 293;
const SYS_PRLIMIT64: i64 = 302;
const SYS_RENAMEAT2: i64 = 316;
const SYS_GETRANDOM: i64 = 318;
const SYS_STATX: i64 = 332;
const SYS_RSEQ: i64 = 334;
const SYS_CLONE3: i64 = 435;
const SYS_FACCESSAT2: i64 = 439;

const MAP_FIXED: i32 = 0x10;
const MAP_ANONYMOUS: i32 = 0x20;
const MAP_FIXED_NOREPLACE: i32 = 0x100000;
const MREMAP_MAYMOVE: i32 = 0x1;

const ARCH_SET_GS: i64 = 0x1001;
const ARCH_SET_FS: i64 = 0x1002;
const ARCH_GET_FS: i64 = 0x1003;
const ARCH_GET_GS: i64 = 0x1004;

const CLONE_VM: u64 = 0x0000_0100;
const CLONE_SETTLS: u64 = 0x0008_0000;
const CLONE_PARENT_SETTID: u64 = 0x0010_0000;
const CLONE_CHILD_CLEARTID: u64 = 0x0020_0000;
const CLONE_CHILD_SETTID: u64 = 0x0100_0000;

pub struct HostState {
    pub vfs: VirtualFs,
    pub scheduler: Scheduler,
    pub brk_curr: u32,
    pub mmap_cursor: u32,
    pub prng_state: u64,
}

impl HostState {
    pub fn new(vfs: VirtualFs) -> Self {
        Self {
            vfs,
            scheduler: Scheduler::new(),
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

fn read_bytes(ctx: &dyn GuestContext, addr: u64, len: usize) -> Result<Vec<u8>, i64> {
    if len == 0 {
        return Ok(Vec::new());
    }
    if addr == 0 {
        return Err(-EFAULT);
    }
    let mut buf = vec![0u8; len];
    ctx.mem_read(addr, &mut buf)?;
    Ok(buf)
}

fn write_bytes(ctx: &mut dyn GuestContext, addr: u64, data: &[u8]) -> Result<(), i64> {
    if data.is_empty() {
        return Ok(());
    }
    if addr == 0 {
        return Err(-EFAULT);
    }
    ctx.mem_write(addr, data)
}

fn read_cstr(ctx: &dyn GuestContext, addr: u64) -> Result<String, i64> {
    ctx.mem_read_cstr(addr, 4096)
}

fn read_u32(ctx: &dyn GuestContext, addr: u64) -> Result<u32, i64> {
    let b = read_bytes(ctx, addr, 4)?;
    Ok(u32::from_le_bytes(b.try_into().unwrap()))
}

fn read_u64(ctx: &dyn GuestContext, addr: u64) -> Result<u64, i64> {
    let b = read_bytes(ctx, addr, 8)?;
    Ok(u64::from_le_bytes(b.try_into().unwrap()))
}

fn write_u64(ctx: &mut dyn GuestContext, addr: u64, val: u64) -> Result<(), i64> {
    write_bytes(ctx, addr, &val.to_le_bytes())
}

fn read_timespec(ctx: &dyn GuestContext, addr: u64) -> Result<(i64, i64), i64> {
    let b = read_bytes(ctx, addr, 16)?;
    let sec = i64::from_le_bytes(b[0..8].try_into().unwrap());
    let nsec = i64::from_le_bytes(b[8..16].try_into().unwrap());
    if sec < 0 || !(0..1_000_000_000).contains(&nsec) {
        return Err(-EINVAL);
    }
    Ok((sec, nsec))
}

fn write_stat(ctx: &mut dyn GuestContext, addr: u64, st: &FileStat) -> Result<(), i64> {
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
    let mtime_sec = (st.mtime_ns / 1_000_000_000) as i64;
    let mtime_nsec = (st.mtime_ns % 1_000_000_000) as i64;
    buf[88..96].copy_from_slice(&mtime_sec.to_le_bytes());
    buf[96..104].copy_from_slice(&mtime_nsec.to_le_bytes());
    write_bytes(ctx, addr, &buf)
}

fn align_up_4k(v: u32) -> Option<u32> {
    v.checked_add(4095).map(|x| x & !4095)
}

pub fn handle_syscall(
    ctx: &mut dyn GuestContext,
    state: &mut HostState,
    nr: i64,
    a0: i64,
    a1: i64,
    a2: i64,
    a3: i64,
    a4: i64,
    a5: i64,
) -> i64 {
    state.scheduler.advance_syscall_time();
    let ret = handle_syscall_inner(ctx, state, nr, a0, a1, a2, a3, a4, a5);
    if ctx.trace_enabled() {
        ctx.trace_log(&format!(
            "[syscall tid={}] nr={} (0x{:x}, 0x{:x}, 0x{:x}, 0x{:x}, 0x{:x}, 0x{:x}) -> {} (0x{:x})",
            state.scheduler.current_tid, nr, a0, a1, a2, a3, a4, a5, ret, ret
        ));
    }
    ret
}

fn handle_syscall_inner(
    ctx: &mut dyn GuestContext,
    state: &mut HostState,
    nr: i64,
    a0: i64,
    a1: i64,
    a2: i64,
    a3: i64,
    a4: i64,
    a5: i64,
) -> i64 {
    let now_ns = state.scheduler.realtime_ns();

    match nr {
        SYS_READ => {
            let fd = a0 as i32;
            let buf_addr = a1 as u64;
            let count = a2 as usize;
            if count > 0 {
                let mem_size = ctx.mem_len();
                if buf_addr == 0 || usize::try_from(buf_addr).map_or(true, |s| s >= mem_size) {
                    return -EFAULT;
                }
            }
            match state.vfs.read_no_advance(fd, count) {
                Ok((bytes, host_consumed)) => {
                    let n = bytes.len();
                    if let Err(e) = write_bytes(ctx, buf_addr, &bytes) {
                        return e;
                    }
                    if !host_consumed {
                        state.vfs.advance_read_cursor(fd, n);
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
            match state.vfs.pread64(fd, count, offset) {
                Ok(bytes) => {
                    let n = bytes.len();
                    if let Err(e) = write_bytes(ctx, buf_addr, &bytes) {
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
            let bytes = match read_bytes(ctx, buf_addr, count) {
                Ok(b) => b,
                Err(e) => return e,
            };
            state.vfs.write_with_time(fd, &bytes, now_ns)
        }
        SYS_PWRITE64 => {
            let fd = a0 as i32;
            let buf_addr = a1 as u64;
            let count = a2 as usize;
            let offset = a3 as usize;
            let bytes = match read_bytes(ctx, buf_addr, count) {
                Ok(b) => b,
                Err(e) => return e,
            };
            state.vfs.pwrite64(fd, &bytes, offset, now_ns)
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
                let base = match read_u64(ctx, entry_addr) {
                    Ok(v) => v,
                    Err(e) => return e,
                };
                let len_u64 = match read_u64(ctx, len_addr) {
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
                let bytes = match read_bytes(ctx, base, len) {
                    Ok(b) => b,
                    Err(e) => return e,
                };
                let written = state.vfs.write_with_time(fd, &bytes, now_ns);
                if written < 0 {
                    return written;
                }
                total += written;
            }
            total
        }
        SYS_OPEN => {
            let path = match read_cstr(ctx, a0 as u64) {
                Ok(p) => p,
                Err(e) => return e,
            };
            state
                .vfs
                .openat_with_mode(AT_FDCWD, &path, a1 as i32, a2 as u32, now_ns)
        }
        SYS_OPENAT => {
            let dirfd = a0 as i32;
            let path = match read_cstr(ctx, a1 as u64) {
                Ok(p) => p,
                Err(e) => return e,
            };
            state
                .vfs
                .openat_with_mode(dirfd, &path, a2 as i32, a3 as u32, now_ns)
        }
        SYS_CLOSE => state.vfs.close(a0 as i32),
        SYS_LSEEK => state.vfs.lseek(a0 as i32, a1, a2 as i32),
        SYS_STAT => {
            let path = match read_cstr(ctx, a0 as u64) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let st = match state.vfs.stat_path(AT_FDCWD, &path, 0) {
                Ok(s) => s,
                Err(e) => return e,
            };
            match write_stat(ctx, a1 as u64, &st) {
                Ok(()) => 0,
                Err(e) => e,
            }
        }
        SYS_FSTAT => {
            let st = match state.vfs.stat_fd(a0 as i32) {
                Ok(s) => s,
                Err(e) => return e,
            };
            match write_stat(ctx, a1 as u64, &st) {
                Ok(()) => 0,
                Err(e) => e,
            }
        }
        SYS_LSTAT => {
            let path = match read_cstr(ctx, a0 as u64) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let st = match state.vfs.stat_path(AT_FDCWD, &path, 0x100) {
                Ok(s) => s,
                Err(e) => return e,
            };
            match write_stat(ctx, a1 as u64, &st) {
                Ok(()) => 0,
                Err(e) => e,
            }
        }
        SYS_NEWFSTATAT => {
            let dirfd = a0 as i32;
            let path = match read_cstr(ctx, a1 as u64) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let flags = a3 as i32;
            let st = match state.vfs.stat_path(dirfd, &path, flags) {
                Ok(s) => s,
                Err(e) => return e,
            };
            match write_stat(ctx, a2 as u64, &st) {
                Ok(()) => 0,
                Err(e) => e,
            }
        }
        SYS_ACCESS => {
            let path = match read_cstr(ctx, a0 as u64) {
                Ok(p) => p,
                Err(e) => return e,
            };
            state.vfs.access(AT_FDCWD, &path, a1 as i32)
        }
        SYS_FACCESSAT | SYS_FACCESSAT2 => {
            let dirfd = a0 as i32;
            let path = match read_cstr(ctx, a1 as u64) {
                Ok(p) => p,
                Err(e) => return e,
            };
            state.vfs.access(dirfd, &path, a2 as i32)
        }
        SYS_MKDIR => {
            let path = match read_cstr(ctx, a0 as u64) {
                Ok(p) => p,
                Err(e) => return e,
            };
            state.vfs.mkdirat(AT_FDCWD, &path, a1 as u32, now_ns)
        }
        SYS_MKDIRAT => {
            let path = match read_cstr(ctx, a1 as u64) {
                Ok(p) => p,
                Err(e) => return e,
            };
            state.vfs.mkdirat(a0 as i32, &path, a2 as u32, now_ns)
        }
        SYS_UNLINK => {
            let path = match read_cstr(ctx, a0 as u64) {
                Ok(p) => p,
                Err(e) => return e,
            };
            state.vfs.unlinkat(AT_FDCWD, &path, 0)
        }
        SYS_RMDIR => {
            let path = match read_cstr(ctx, a0 as u64) {
                Ok(p) => p,
                Err(e) => return e,
            };
            state.vfs.unlinkat(AT_FDCWD, &path, AT_REMOVEDIR)
        }
        SYS_UNLINKAT => {
            let path = match read_cstr(ctx, a1 as u64) {
                Ok(p) => p,
                Err(e) => return e,
            };
            state.vfs.unlinkat(a0 as i32, &path, a2 as i32)
        }
        SYS_RENAME => {
            let oldpath = match read_cstr(ctx, a0 as u64) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let newpath = match read_cstr(ctx, a1 as u64) {
                Ok(p) => p,
                Err(e) => return e,
            };
            state.vfs.renameat(AT_FDCWD, &oldpath, AT_FDCWD, &newpath)
        }
        SYS_RENAMEAT | SYS_RENAMEAT2 => {
            let oldpath = match read_cstr(ctx, a1 as u64) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let newpath = match read_cstr(ctx, a3 as u64) {
                Ok(p) => p,
                Err(e) => return e,
            };
            state.vfs.renameat(a0 as i32, &oldpath, a2 as i32, &newpath)
        }
        SYS_TRUNCATE => {
            let path = match read_cstr(ctx, a0 as u64) {
                Ok(p) => p,
                Err(e) => return e,
            };
            state.vfs.truncate_path(&path, a1, now_ns)
        }
        SYS_FTRUNCATE => state.vfs.ftruncate(a0 as i32, a1, now_ns),
        SYS_CHMOD => {
            let path = match read_cstr(ctx, a0 as u64) {
                Ok(p) => p,
                Err(e) => return e,
            };
            state.vfs.chmod_at(AT_FDCWD, &path, a1 as u32)
        }
        SYS_FCHMOD => state.vfs.fchmod(a0 as i32, a1 as u32),
        SYS_FCHMODAT => {
            let path = match read_cstr(ctx, a1 as u64) {
                Ok(p) => p,
                Err(e) => return e,
            };
            state.vfs.chmod_at(a0 as i32, &path, a2 as u32)
        }
        SYS_UTIMENSAT => {
            let path = if a1 == 0 {
                None
            } else {
                match read_cstr(ctx, a1 as u64) {
                    Ok(p) => Some(p),
                    Err(e) => return e,
                }
            };
            state.vfs.utimensat(a0 as i32, path.as_deref(), now_ns)
        }
        SYS_CHDIR => {
            let path = match read_cstr(ctx, a0 as u64) {
                Ok(p) => p,
                Err(e) => return e,
            };
            state.vfs.chdir(&path)
        }
        SYS_FCHDIR => state.vfs.fchdir(a0 as i32),
        SYS_BRK => {
            let req = a0 as u64;
            let curr = state.brk_curr;
            if req == 0 || req < BRK_START as u64 {
                return curr as i64;
            }
            if req >= MMAP_START as u64 {
                return curr as i64;
            }
            let new_brk = req as u32;
            if new_brk > curr {
                if ctx.mem_zero(curr as u64, (new_brk - curr) as usize).is_err() {
                    return curr as i64;
                }
            }
            state.brk_curr = new_brk;
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

            let mem_size = ctx.mem_len();
            let validate_fixed = |addr: u64| -> Result<u32, i64> {
                let fixed_addr = u32::try_from(addr).map_err(|_| -ENOMEM)?;
                if fixed_addr == 0 || (fixed_addr & 0xfff) != 0 {
                    return Err(-EINVAL);
                }
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
                    let cur = state.mmap_cursor;
                    let Some(next) = cur.checked_add(aligned) else {
                        return -ENOMEM;
                    };
                    if next > MMAP_END {
                        return -ENOMEM;
                    }
                    (cur, Some(next))
                };
                if ctx.mem_zero(target as u64, len).is_err() {
                    return -ENOMEM;
                }
                if let Some(next) = new_cursor {
                    state.mmap_cursor = next;
                }
                return target as i64;
            }

            let (file_data, so_base, is_dir, is_std_or_pipe) = match state.vfs.get_fd(fd) {
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
                let cur = state.mmap_cursor;
                let Some(next) = cur.checked_add(aligned) else {
                    return -ENOMEM;
                };
                if next > MMAP_END {
                    return -ENOMEM;
                }
                (cur, Some(next))
            };

            if ctx.mem_zero(target as u64, len).is_err() {
                return -ENOMEM;
            }
            if offset < file_data.len() {
                let copy_len = len.min(file_data.len() - offset);
                if let Err(e) = write_bytes(ctx, target as u64, &file_data[offset..offset + copy_len]) {
                    return e;
                }
            }
            if let Some(next) = new_cursor {
                state.mmap_cursor = next;
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
            let target = state.mmap_cursor;
            let Some(next) = target.checked_add(aligned) else {
                return -ENOMEM;
            };
            if next > MMAP_END {
                return -ENOMEM;
            }
            let old_bytes = match read_bytes(ctx, old_addr as u64, old_size) {
                Ok(b) => b,
                Err(e) => return e,
            };
            if ctx.mem_zero(target as u64, aligned as usize).is_err() {
                return -ENOMEM;
            }
            if let Err(e) = write_bytes(ctx, target as u64, &old_bytes) {
                return e;
            }
            state.mmap_cursor = next;
            target as i64
        }
        SYS_ARCH_PRCTL => {
            let code = a0;
            let addr = a1;
            match code {
                ARCH_SET_FS => {
                    ctx.set_fsbase(addr);
                    0
                }
                ARCH_GET_FS => {
                    let val = ctx.get_fsbase() as u64;
                    match write_u64(ctx, addr as u64, val) {
                        Ok(()) => 0,
                        Err(e) => e,
                    }
                }
                ARCH_SET_GS => {
                    ctx.set_gsbase(addr);
                    0
                }
                ARCH_GET_GS => {
                    let val = ctx.get_gsbase() as u64;
                    match write_u64(ctx, addr as u64, val) {
                        Ok(()) => 0,
                        Err(e) => e,
                    }
                }
                _ => -EINVAL,
            }
        }
        SYS_SET_TID_ADDRESS => {
            state.scheduler.current_thread_mut().clear_child_tid = a0 as u32;
            state.scheduler.current_tid as i64
        }
        SYS_SET_ROBUST_LIST => {
            state.scheduler.current_thread_mut().robust_list_head = a0 as u32;
            0
        }
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
                if let Err(e) = write_bytes(ctx, old_limit, &buf) {
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
                if let Err(e) = write_bytes(ctx, rlim, &buf) {
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
            let mem_size = ctx.mem_len();
            let start = match usize::try_from(buf_addr) {
                Ok(s) => s,
                Err(_) => return -EFAULT,
            };
            if start.checked_add(buflen).map_or(true, |e| e > mem_size) {
                return -EFAULT;
            }
            let mut out = Vec::with_capacity(buflen);
            while out.len() < buflen {
                let r = state.next_rand_u64().to_le_bytes();
                let take = (buflen - out.len()).min(8);
                out.extend_from_slice(&r[..take]);
            }
            if let Err(e) = write_bytes(ctx, buf_addr, &out) {
                return e;
            }
            buflen as i64
        }
        SYS_FUTEX => {
            let uaddr = a0 as u32;
            let raw_op = a1 as i32;
            let op = raw_op & 0x7f;
            let val = a2 as u32;
            let timeout_ptr = a3 as u64;
            let bitset = a5 as u32;
            match op {
                0 | 9 => {
                    let eff_bitset = if op == 9 { bitset } else { 0xFFFF_FFFF };
                    if eff_bitset == 0 {
                        return -EINVAL;
                    }
                    let cur = match read_u32(ctx, uaddr as u64) {
                        Ok(v) => v,
                        Err(e) => return e,
                    };
                    if cur != val {
                        return -EAGAIN;
                    }
                    let wake_ns = if timeout_ptr != 0 {
                        let (sec, nsec) = match read_timespec(ctx, timeout_ptr) {
                            Ok(t) => t,
                            Err(e) => return e,
                        };
                        let t_ns = (sec as u64)
                            .saturating_mul(1_000_000_000)
                            .saturating_add(nsec as u64);
                        if op == 0 {
                            Some(state.scheduler.virtual_mono_ns.saturating_add(t_ns))
                        } else if (raw_op & 0x100) != 0 {
                            Some(t_ns.saturating_sub(state.scheduler.realtime_base_ns))
                        } else {
                            Some(t_ns)
                        }
                    } else {
                        None
                    };
                    if matches!(wake_ns, Some(w) if w <= state.scheduler.virtual_mono_ns) {
                        return -ETIMEDOUT;
                    }
                    state.scheduler.current_thread_mut().state = ThreadState::FutexWait {
                        uaddr,
                        bitset: eff_bitset,
                        wake_ns,
                    };
                    ctx.set_yield_flag(1);
                    0
                }
                1 | 10 => {
                    let eff_bitset = if op == 10 { bitset } else { 0xFFFF_FFFF };
                    state
                        .scheduler
                        .futex_wake(uaddr, val as usize, eff_bitset) as i64
                }
                _ => 0,
            }
        }
        SYS_CLONE => {
            let flags = a0 as u64;
            if (flags & CLONE_VM) == 0 {
                return -ENOSYS;
            }
            let child_stack = a1 as u64;
            let ptid_ptr = a2 as u64;
            let ctid_ptr = a3 as u64;
            let newtls = a4 as u64;

            let parent_regs = match ctx.save_ctx(state.scheduler.scratch_addr) {
                Ok(r) => r,
                Err(e) => return e,
            };

            let child_tid = state.scheduler.alloc_tid();
            if (flags & CLONE_PARENT_SETTID) != 0 && ptid_ptr != 0 {
                if let Err(e) = write_bytes(ctx, ptid_ptr, &child_tid.to_le_bytes()) {
                    return e;
                }
            }
            if (flags & CLONE_CHILD_SETTID) != 0 && ctid_ptr != 0 {
                if let Err(e) = write_bytes(ctx, ctid_ptr, &child_tid.to_le_bytes()) {
                    return e;
                }
            }

            let mut child = ThreadContext::new(child_tid);
            child.regs = parent_regs;
            child.set_rax(0);
            if child_stack != 0 {
                child.set_rsp(child_stack as i64);
            }
            child.set_rip(ctx.get_rcx());
            if (flags & CLONE_SETTLS) != 0 {
                child.set_fsbase(newtls as i64);
            }
            if (flags & CLONE_CHILD_CLEARTID) != 0 {
                child.clear_child_tid = ctid_ptr as u32;
            }

            state.scheduler.threads.insert(child_tid, child);
            state.scheduler.run_queue.push_back(child_tid);
            child_tid as i64
        }
        SYS_CLONE3 => -ENOSYS,
        SYS_SCHED_YIELD => {
            ctx.set_yield_flag(1);
            0
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
            match write_bytes(ctx, buf_addr, &buf) {
                Ok(()) => 0,
                Err(e) => e,
            }
        }
        SYS_GETUID | SYS_GETEUID | SYS_GETGID | SYS_GETEGID | SYS_GETPID => 1000,
        SYS_GETTID => state.scheduler.current_tid as i64,
        SYS_CLOCK_GETTIME => {
            let clk_id = a0 as i32;
            let tp = a1 as u64;
            let ns = match clk_id {
                0 | 5 => state.scheduler.realtime_ns(),
                _ => state.scheduler.virtual_mono_ns,
            };
            if tp != 0 {
                let sec = (ns / 1_000_000_000) as i64;
                let nsec = (ns % 1_000_000_000) as i64;
                let mut buf = [0u8; 16];
                buf[0..8].copy_from_slice(&sec.to_le_bytes());
                buf[8..16].copy_from_slice(&nsec.to_le_bytes());
                if let Err(e) = write_bytes(ctx, tp, &buf) {
                    return e;
                }
            }
            0
        }
        SYS_CLOCK_GETRES => {
            let res = a1 as u64;
            if res != 0 {
                let mut buf = [0u8; 16];
                buf[8..16].copy_from_slice(&1i64.to_le_bytes());
                if let Err(e) = write_bytes(ctx, res, &buf) {
                    return e;
                }
            }
            0
        }
        SYS_NANOSLEEP => {
            let req = a0 as u64;
            let rem = a1 as u64;
            let (sec, nsec) = match read_timespec(ctx, req) {
                Ok(t) => t,
                Err(e) => return e,
            };
            let dur_ns = (sec as u64)
                .saturating_mul(1_000_000_000)
                .saturating_add(nsec as u64);
            if rem != 0 {
                let _ = write_bytes(ctx, rem, &[0u8; 16]);
            }
            if dur_ns == 0 {
                return 0;
            }
            let wake_ns = state.scheduler.virtual_mono_ns.saturating_add(dur_ns);
            state.scheduler.current_thread_mut().state = ThreadState::Sleeping { wake_ns };
            ctx.set_yield_flag(1);
            0
        }
        SYS_CLOCK_NANOSLEEP => {
            let clk_id = a0 as i32;
            let flags = a1 as i32;
            let req = a2 as u64;
            let rem = a3 as u64;
            let (sec, nsec) = match read_timespec(ctx, req) {
                Ok(t) => t,
                Err(e) => return e,
            };
            let target_ns = (sec as u64)
                .saturating_mul(1_000_000_000)
                .saturating_add(nsec as u64);
            let is_abs = (flags & 1) != 0;
            let wake_ns = if is_abs {
                if clk_id == 0 || clk_id == 5 {
                    target_ns.saturating_sub(state.scheduler.realtime_base_ns)
                } else {
                    target_ns
                }
            } else {
                state.scheduler.virtual_mono_ns.saturating_add(target_ns)
            };
            if rem != 0 && !is_abs {
                let _ = write_bytes(ctx, rem, &[0u8; 16]);
            }
            if wake_ns <= state.scheduler.virtual_mono_ns {
                return 0;
            }
            state.scheduler.current_thread_mut().state = ThreadState::Sleeping { wake_ns };
            ctx.set_yield_flag(1);
            0
        }
        SYS_GETTIMEOFDAY => {
            let tv = a0 as u64;
            if tv != 0 {
                let ns = state.scheduler.realtime_ns();
                let sec = (ns / 1_000_000_000) as i64;
                let usec = ((ns % 1_000_000_000) / 1_000) as i64;
                let mut buf = [0u8; 16];
                buf[0..8].copy_from_slice(&sec.to_le_bytes());
                buf[8..16].copy_from_slice(&usec.to_le_bytes());
                if let Err(e) = write_bytes(ctx, tv, &buf) {
                    return e;
                }
            }
            0
        }
        SYS_TIME => {
            let tloc = a0 as u64;
            let sec = (state.scheduler.realtime_ns() / 1_000_000_000) as i64;
            if tloc != 0 {
                if let Err(e) = write_bytes(ctx, tloc, &sec.to_le_bytes()) {
                    return e;
                }
            }
            sec
        }
        SYS_RT_SIGACTION => {
            let oldact = a2 as u64;
            if oldact != 0 {
                if let Err(e) = write_bytes(ctx, oldact, &[0u8; 32]) {
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
                if let Err(e) = write_bytes(ctx, oldset, &zeros) {
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
                F_DUPFD | F_DUPFD_CLOEXEC => state.vfs.dup_from(fd, arg),
                F_GETFD | F_SETFD | F_GETFL | F_SETFL => {
                    if state.vfs.get_fd(fd).is_some() {
                        0
                    } else {
                        -EBADF
                    }
                }
                _ => 0,
            }
        }
        SYS_IOCTL => -ENOTTY,
        SYS_DUP => state.vfs.dup(a0 as i32),
        SYS_DUP2 => state.vfs.dup2(a0 as i32, a1 as i32),
        SYS_DUP3 => {
            let oldfd = a0 as i32;
            let newfd = a1 as i32;
            if oldfd == newfd {
                -EINVAL
            } else {
                state.vfs.dup2(oldfd, newfd)
            }
        }
        SYS_PIPE2 => {
            let pipefd_addr = a0 as u64;
            if pipefd_addr == 0 {
                return -EFAULT;
            }
            let (rfd, wfd) = match state.vfs.create_pipe() {
                Ok(fds) => fds,
                Err(e) => return e,
            };
            let mut buf = [0u8; 8];
            buf[0..4].copy_from_slice(&rfd.to_le_bytes());
            buf[4..8].copy_from_slice(&wfd.to_le_bytes());
            match write_bytes(ctx, pipefd_addr, &buf) {
                Ok(()) => 0,
                Err(e) => {
                    state.vfs.close(rfd);
                    state.vfs.close(wfd);
                    e
                }
            }
        }
        SYS_GETCWD => {
            let buf_addr = a0 as u64;
            let size = a1 as usize;
            let cwd_bytes = state.vfs.cwd.as_bytes();
            let needed = cwd_bytes.len() + 1;
            if size < needed {
                return -ERANGE;
            }
            let mut out = Vec::with_capacity(needed);
            out.extend_from_slice(cwd_bytes);
            out.push(0);
            match write_bytes(ctx, buf_addr, &out) {
                Ok(()) => needed as i64,
                Err(e) => e,
            }
        }
        SYS_GETDENTS64 => {
            let fd = a0 as i32;
            let dirp = a1 as u64;
            let count = a2 as usize;
            match state.vfs.getdents64(fd, count) {
                Ok(bytes) => {
                    let n = bytes.len();
                    if n > 0 {
                        if let Err(e) = write_bytes(ctx, dirp, &bytes) {
                            return e;
                        }
                    }
                    n as i64
                }
                Err(e) => e,
            }
        }
        SYS_READLINK => {
            let path = match read_cstr(ctx, a0 as u64) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let buf_addr = a1 as u64;
            let bufsiz_signed = a2 as isize;
            if bufsiz_signed <= 0 {
                return -EINVAL;
            }
            let bufsiz = bufsiz_signed as usize;
            match state.vfs.readlink(AT_FDCWD, &path) {
                Ok(target) => {
                    let n = target.len().min(bufsiz);
                    if n > 0 {
                        if let Err(e) = write_bytes(ctx, buf_addr, &target[..n]) {
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
            let path = match read_cstr(ctx, a1 as u64) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let buf_addr = a2 as u64;
            let bufsiz_signed = a3 as isize;
            if bufsiz_signed <= 0 {
                return -EINVAL;
            }
            let bufsiz = bufsiz_signed as usize;
            match state.vfs.readlink(dirfd, &path) {
                Ok(target) => {
                    let n = target.len().min(bufsiz);
                    if n > 0 {
                        if let Err(e) = write_bytes(ctx, buf_addr, &target[..n]) {
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
            let uptime = (state.scheduler.virtual_mono_ns / 1_000_000_000).max(1) as i64;
            buf[0..8].copy_from_slice(&uptime.to_le_bytes());
            buf[32..40].copy_from_slice(&(256u64 * 1024 * 1024).to_le_bytes()); // totalram
            buf[40..48].copy_from_slice(&(128u64 * 1024 * 1024).to_le_bytes()); // freeram
            buf[80..82].copy_from_slice(&(state.scheduler.live_thread_count().max(1) as u16).to_le_bytes());
            buf[104..108].copy_from_slice(&1u32.to_le_bytes()); // mem_unit
            match write_bytes(ctx, info_addr, &buf) {
                Ok(()) => 0,
                Err(e) => e,
            }
        }
        SYS_SIGALTSTACK => {
            let old_ss = a1 as u64;
            if old_ss != 0 {
                let mut buf = [0u8; 24];
                buf[8..12].copy_from_slice(&2i32.to_le_bytes()); // SS_DISABLE
                if let Err(e) = write_bytes(ctx, old_ss, &buf) {
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
            match write_bytes(ctx, mask_addr, &buf) {
                Ok(()) => 8,
                Err(e) => e,
            }
        }
        SYS_STATX => {
            let dirfd = a0 as i32;
            let path = match read_cstr(ctx, a1 as u64) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let flags = a2 as i32;
            let statxbuf = a4 as u64;
            let st = match state.vfs.stat_path(dirfd, &path, flags) {
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
            match write_bytes(ctx, statxbuf, &buf) {
                Ok(()) => 0,
                Err(e) => e,
            }
        }
        SYS_EXIT => {
            let ctid = state.scheduler.current_thread().clear_child_tid;
            if ctid != 0 {
                let _ = ctx.mem_write(ctid as u64, &0i32.to_le_bytes());
                state.scheduler.futex_wake(ctid, 1, 0xFFFF_FFFF);
            }
            state.scheduler.current_thread_mut().state = ThreadState::Exited;
            if state.scheduler.live_thread_count() == 0 {
                ctx.set_exit(a0 as i32);
            } else {
                ctx.set_yield_flag(1);
            }
            0
        }
        SYS_EXIT_GROUP => {
            ctx.set_exit(a0 as i32);
            0
        }
        SYS_TGKILL | SYS_TKILL | SYS_PRCTL => 0,
        _ => -ENOSYS,
    }
}
