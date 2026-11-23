use crate::context::GuestContext;
use crate::scheduler::{
    PendingWakeup, PollFdSpec, PollKind, Scheduler, ThreadContext, ThreadState, MAIN_PID,
    QUANTUM_TIME_STEP_NS,
};
use crate::stack::setup_guest_stack_ctx_with_ids;
use crate::vfs::{
    EpollEntry, FileStat, OpenFile, SoEntry, VirtualDevice, VirtualFs, AT_FDCWD, AT_REMOVEDIR,
    AT_SYMLINK_NOFOLLOW, EACCES, EAFNOSUPPORT, EAGAIN, EBADF, ECHILD, EFAULT, EINTR, EINVAL,
    ELOOP, ENOENT, ENOEXEC, ENOMEM, ENOSYS, ENOTTY, EPERM, EPIPE, ERANGE, ESRCH, ETIMEDOUT,
    O_CLOEXEC, O_NONBLOCK, S_IFDIR,
};
use elf2wasm_core::elf_loader::{BRK_START, MMAP_START};
use elf2wasm_core::lifter::DEFAULT_QUANTUM;
use elf2wasm_core::meta::WasmMeta;
use std::collections::BTreeMap;

pub const MMAP_END: u32 = 0x0B00_0000;
/// Top of bump-allocated mmap region; the final 4 KiB page (`MMAP_END - 4096..MMAP_END`)
/// is reserved for the scheduler's `save_ctx`/`load_ctx` scratch buffer.
pub const MMAP_ALLOC_END: u32 = MMAP_END - 4096;

const SYS_READ: i64 = 0;
const SYS_WRITE: i64 = 1;
const SYS_OPEN: i64 = 2;
const SYS_CLOSE: i64 = 3;
const SYS_STAT: i64 = 4;
const SYS_FSTAT: i64 = 5;
const SYS_LSTAT: i64 = 6;
const SYS_POLL: i64 = 7;
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
const SYS_READV: i64 = 19;
const SYS_WRITEV: i64 = 20;
const SYS_ACCESS: i64 = 21;
const SYS_PIPE: i64 = 22;
const SYS_SELECT: i64 = 23;
const SYS_SCHED_YIELD: i64 = 24;
const SYS_MREMAP: i64 = 25;
const SYS_MADVISE: i64 = 28;
const SYS_DUP: i64 = 32;
const SYS_DUP2: i64 = 33;
const SYS_NANOSLEEP: i64 = 35;
const SYS_GETPID: i64 = 39;
const SYS_SOCKET: i64 = 41;
const SYS_SENDTO: i64 = 44;
const SYS_RECVFROM: i64 = 45;
const SYS_SOCKETPAIR: i64 = 53;
const SYS_CLONE: i64 = 56;
const SYS_FORK: i64 = 57;
const SYS_VFORK: i64 = 58;
const SYS_EXECVE: i64 = 59;
const SYS_EXIT: i64 = 60;
const SYS_WAIT4: i64 = 61;
const SYS_KILL: i64 = 62;
const SYS_UNAME: i64 = 63;
const SYS_FCNTL: i64 = 72;
const SYS_FSYNC: i64 = 74;
const SYS_FDATASYNC: i64 = 75;
const SYS_TRUNCATE: i64 = 76;
const SYS_FTRUNCATE: i64 = 77;
const SYS_GETCWD: i64 = 79;
const SYS_CHDIR: i64 = 80;
const SYS_FCHDIR: i64 = 81;
const SYS_RENAME: i64 = 82;
const SYS_MKDIR: i64 = 83;
const SYS_RMDIR: i64 = 84;
const SYS_LINK: i64 = 86;
const SYS_UNLINK: i64 = 87;
const SYS_SYMLINK: i64 = 88;
const SYS_READLINK: i64 = 89;
const SYS_CHMOD: i64 = 90;
const SYS_FCHMOD: i64 = 91;
const SYS_CHOWN: i64 = 92;
const SYS_FCHOWN: i64 = 93;
const SYS_LCHOWN: i64 = 94;
const SYS_UMASK: i64 = 95;
const SYS_GETTIMEOFDAY: i64 = 96;
const SYS_GETRLIMIT: i64 = 97;
const SYS_GETRUSAGE: i64 = 98;
const SYS_SYSINFO: i64 = 99;
const SYS_TIMES: i64 = 100;
const SYS_GETUID: i64 = 102;
const SYS_GETGID: i64 = 104;
const SYS_SETUID: i64 = 105;
const SYS_SETGID: i64 = 106;
const SYS_GETEUID: i64 = 107;
const SYS_GETEGID: i64 = 108;
const SYS_SETPGID: i64 = 109;
const SYS_GETPPID: i64 = 110;
const SYS_GETPGRP: i64 = 111;
const SYS_SETSID: i64 = 112;
const SYS_GETGROUPS: i64 = 115;
const SYS_SETGROUPS: i64 = 116;
const SYS_GETPGID: i64 = 121;
const SYS_GETSID: i64 = 124;
const SYS_CAPGET: i64 = 125;
const SYS_SIGALTSTACK: i64 = 131;
const SYS_STATFS: i64 = 137;
const SYS_FSTATFS: i64 = 138;
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
const SYS_EPOLL_WAIT: i64 = 232;
const SYS_EPOLL_CTL: i64 = 233;
const SYS_TGKILL: i64 = 234;
const SYS_WAITID: i64 = 247;
const SYS_OPENAT: i64 = 257;
const SYS_MKDIRAT: i64 = 258;
const SYS_FCHOWNAT: i64 = 260;
const SYS_NEWFSTATAT: i64 = 262;
const SYS_UNLINKAT: i64 = 263;
const SYS_RENAMEAT: i64 = 264;
const SYS_LINKAT: i64 = 265;
const SYS_SYMLINKAT: i64 = 266;
const SYS_READLINKAT: i64 = 267;
const SYS_FCHMODAT: i64 = 268;
const SYS_FACCESSAT: i64 = 269;
const SYS_PSELECT6: i64 = 270;
const SYS_PPOLL: i64 = 271;
const SYS_SET_ROBUST_LIST: i64 = 273;
const SYS_UTIMENSAT: i64 = 280;
const SYS_EPOLL_PWAIT: i64 = 281;
const SYS_EVENTFD2: i64 = 290;
const SYS_EPOLL_CREATE1: i64 = 291;
const SYS_DUP3: i64 = 292;
const SYS_PIPE2: i64 = 293;
const SYS_PRLIMIT64: i64 = 302;
const SYS_RENAMEAT2: i64 = 316;
const SYS_GETRANDOM: i64 = 318;
const SYS_EXECVEAT: i64 = 322;
const SYS_STATX: i64 = 332;
const SYS_RSEQ: i64 = 334;
const SYS_CLONE3: i64 = 435;
const SYS_FACCESSAT2: i64 = 439;

const PROT_NONE: i32 = 0x0;
const PROT_EXEC: i32 = 0x4;
const MAP_FIXED: i32 = 0x10;
const MAP_ANONYMOUS: i32 = 0x20;
const MAP_FIXED_NOREPLACE: i32 = 0x100000;
const MREMAP_MAYMOVE: i32 = 0x1;

const HIGH_MMAP_LIMIT: u32 = 0x8000_0000; // 2 GiB (32768 Wasm pages)

const ARCH_SET_GS: i64 = 0x1001;
const ARCH_SET_FS: i64 = 0x1002;
const ARCH_GET_FS: i64 = 0x1003;
const ARCH_GET_GS: i64 = 0x1004;

const CLONE_VM: u64 = 0x0000_0100;
const CLONE_VFORK: u64 = 0x0000_4000;
const CLONE_SETTLS: u64 = 0x0008_0000;
const CLONE_PARENT_SETTID: u64 = 0x0010_0000;
const CLONE_CHILD_CLEARTID: u64 = 0x0020_0000;
const CLONE_CHILD_SETTID: u64 = 0x0100_0000;

const WNOHANG: i32 = 1;

const POLLIN: i16 = 0x0001;
const POLLOUT: i16 = 0x0004;
const POLLERR: i16 = 0x0008;
const POLLHUP: i16 = 0x0010;
const POLLNVAL: i16 = 0x0020;

#[derive(Debug, Clone)]
pub struct MmapAllocator {
    pub cursor: u32,
    pub mmap_start: u32,
    pub mmap_alloc_end: u32,
    pub free_regions: BTreeMap<u32, u32>,
    /// Growable high-mmap region placed above initial Wasm linear memory (past dispatch table).
    /// `high_start == 0` means lazily initialized from `ctx.mem_len()` on first high-region use.
    pub high_start: u32,
    pub high_cursor: u32,
    pub high_limit: u32,
    /// Highest byte offset ever allocated or reserved in the high region.
    /// Any bump allocation starting at `>= high_clean_watermark` is guaranteed freshly zeroed by Wasm `memory.grow`.
    pub high_clean_watermark: u32,
    pub high_free_regions: BTreeMap<u32, u32>,
    /// Sorted, disjoint, coalesced half-open `[start, end)` intervals of known-zero
    /// untouched `PROT_NONE` anonymous mappings that can be skipped on fork.
    pub prot_none_ranges: Vec<(u32, u32)>,
}

impl MmapAllocator {
    pub fn new() -> Self {
        Self::new_with_bounds(MMAP_START, MMAP_ALLOC_END)
    }

    pub fn new_with_bounds(mmap_start: u32, mmap_alloc_end: u32) -> Self {
        Self {
            cursor: mmap_start,
            mmap_start,
            mmap_alloc_end,
            free_regions: BTreeMap::new(),
            high_start: 0,
            high_cursor: 0,
            high_limit: HIGH_MMAP_LIMIT,
            high_clean_watermark: 0,
            high_free_regions: BTreeMap::new(),
            prot_none_ranges: Vec::new(),
        }
    }

    fn ensure_high_init(&mut self, mem_len: usize) {
        if self.high_start == 0 {
            let start = u32::try_from(mem_len)
                .unwrap_or(self.high_limit)
                .min(self.high_limit);
            let aligned = start.saturating_add(65535) & !65535;
            let aligned = aligned.min(self.high_limit);
            self.high_start = aligned;
            self.high_cursor = aligned;
            self.high_clean_watermark = aligned;
        }
    }

    pub fn alloc(&mut self, aligned_len: u32) -> Option<u32> {
        if aligned_len == 0 {
            return None;
        }
        Self::alloc_from_region(
            &mut self.cursor,
            self.mmap_alloc_end,
            &mut self.free_regions,
            aligned_len,
        )
    }

    /// Allocate from the primary mmap region first (no `mem_grow`), falling back to the
    /// growable high-mmap region above initial Wasm linear memory.
    /// Returns `Some((addr, freshly_grown))`, where `freshly_grown` is `true` iff the returned
    /// range comes from never-before-allocated Wasm linear memory pages (guaranteed zeroed).
    pub fn alloc_with_grow(
        &mut self,
        ctx: &mut dyn GuestContext,
        aligned_len: u32,
    ) -> Option<(u32, bool)> {
        if aligned_len == 0 {
            return None;
        }
        if let Some(addr) = self.alloc(aligned_len) {
            return Some((addr, false));
        }

        self.ensure_high_init(ctx.mem_len());

        // Try reusing a freed slice in the high region first (not freshly grown -> must zero).
        let found = self
            .high_free_regions
            .iter()
            .find(|(_, &len)| len >= aligned_len)
            .map(|(&start, &len)| (start, len));
        if let Some((start, len)) = found {
            self.high_free_regions.remove(&start);
            if len > aligned_len {
                self.high_free_regions
                    .insert(start + aligned_len, len - aligned_len);
            }
            return Some((start, false));
        }

        let next = self.high_cursor.checked_add(aligned_len)?;
        if next > self.high_limit {
            return None;
        }

        let cur_len = ctx.mem_len();
        if (next as usize) > cur_len {
            let needed = (next as usize) - cur_len;
            let delta_pages = u32::try_from((needed + 65535) / 65536).ok()?;
            if ctx.mem_grow(delta_pages).is_err() {
                return None;
            }
            if ctx.mem_len() < (next as usize) {
                return None;
            }
        }

        let addr = self.high_cursor;
        let freshly_grown = addr >= self.high_clean_watermark;
        self.high_cursor = next;
        if next > self.high_clean_watermark {
            self.high_clean_watermark = next;
        }
        Some((addr, freshly_grown))
    }

    fn alloc_from_region(
        cursor: &mut u32,
        region_end: u32,
        free_regions: &mut BTreeMap<u32, u32>,
        aligned_len: u32,
    ) -> Option<u32> {
        let found = free_regions
            .iter()
            .find(|(_, &len)| len >= aligned_len)
            .map(|(&start, &len)| (start, len));
        if let Some((start, len)) = found {
            free_regions.remove(&start);
            if len > aligned_len {
                free_regions.insert(start + aligned_len, len - aligned_len);
            }
            return Some(start);
        }
        let next = cursor.checked_add(aligned_len)?;
        if next > region_end {
            return None;
        }
        let addr = *cursor;
        *cursor = next;
        Some(addr)
    }

    pub fn free(&mut self, addr: u32, aligned_len: u32) {
        if aligned_len == 0 {
            return;
        }
        self.remove_prot_none_range(addr, addr.saturating_add(aligned_len));
        Self::free_in_region(
            self.mmap_start,
            &mut self.cursor,
            &mut self.free_regions,
            addr,
            aligned_len,
        );
        if self.high_start != 0 {
            Self::free_in_region(
                self.high_start,
                &mut self.high_cursor,
                &mut self.high_free_regions,
                addr,
                aligned_len,
            );
        }
    }

    fn free_in_region(
        region_start: u32,
        cursor: &mut u32,
        free_regions: &mut BTreeMap<u32, u32>,
        addr: u32,
        aligned_len: u32,
    ) {
        let mut start = addr.max(region_start);
        let mut end = addr.saturating_add(aligned_len).min(*cursor);
        if start >= end {
            return;
        }
        if let Some((&pred_start, &pred_len)) = free_regions.range(..=start).next_back() {
            let pred_end = pred_start.saturating_add(pred_len);
            if pred_end >= start {
                start = pred_start;
                end = end.max(pred_end);
                free_regions.remove(&pred_start);
            }
        }
        let succs: Vec<(u32, u32)> = free_regions
            .range(start..=end)
            .map(|(&k, &v)| (k, v))
            .collect();
        for (k, v) in succs {
            free_regions.remove(&k);
            end = end.max(k.saturating_add(v));
        }
        if end == *cursor {
            *cursor = start;
        } else {
            free_regions.insert(start, end - start);
        }
    }

    pub fn reserve_fixed(&mut self, addr: u32, aligned_len: u32) {
        if aligned_len == 0 {
            return;
        }
        Self::reserve_in_region(
            self.mmap_start,
            self.mmap_alloc_end,
            &mut self.cursor,
            &mut self.free_regions,
            addr,
            aligned_len,
        );
        if self.high_start != 0 {
            let end = addr.saturating_add(aligned_len).min(self.high_limit);
            if addr.max(self.high_start) < end {
                Self::reserve_in_region(
                    self.high_start,
                    self.high_limit,
                    &mut self.high_cursor,
                    &mut self.high_free_regions,
                    addr,
                    aligned_len,
                );
                if end > self.high_clean_watermark {
                    self.high_clean_watermark = end;
                }
            }
        }
    }

    fn reserve_in_region(
        region_start: u32,
        region_end: u32,
        cursor: &mut u32,
        free_regions: &mut BTreeMap<u32, u32>,
        addr: u32,
        aligned_len: u32,
    ) {
        let start = addr.max(region_start);
        let end = addr.saturating_add(aligned_len).min(region_end);
        if start >= end {
            return;
        }
        if end > *cursor {
            if start > *cursor {
                let mut gap_start = *cursor;
                let gap_end = start;
                if let Some((&pred_start, &pred_len)) = free_regions.range(..=gap_start).next_back()
                {
                    if pred_start.saturating_add(pred_len) >= gap_start {
                        gap_start = pred_start;
                        free_regions.remove(&pred_start);
                    }
                }
                free_regions.insert(gap_start, gap_end - gap_start);
            }
            *cursor = end;
        }
        let overlapping: Vec<(u32, u32)> = free_regions
            .iter()
            .filter(|(&k, &v)| k < end && k.saturating_add(v) > start)
            .map(|(&k, &v)| (k, v))
            .collect();
        for (k, v) in overlapping {
            free_regions.remove(&k);
            let k_end = k.saturating_add(v);
            if k < start {
                free_regions.insert(k, start - k);
            }
            if k_end > end {
                free_regions.insert(end, k_end - end);
            }
        }
    }

    pub fn contains_range(&self, start: u32, end: u32) -> bool {
        let in_primary = start >= self.mmap_start && end <= self.mmap_alloc_end;
        let in_high = self.high_start != 0 && start >= self.high_start && end <= self.high_cursor;
        in_primary || in_high
    }

    /// Record `[start, end)` as a known-zero untouched `PROT_NONE` anonymous range.
    /// Maintains sorted, disjoint, coalesced intervals.
    pub fn add_prot_none_range(&mut self, start: u32, end: u32) {
        if start >= end {
            return;
        }
        let mut new_start = start;
        let mut new_end = end;
        let mut out = Vec::with_capacity(self.prot_none_ranges.len() + 1);
        let mut inserted = false;
        for &(r_start, r_end) in &self.prot_none_ranges {
            if r_end < new_start {
                out.push((r_start, r_end));
            } else if r_start > new_end {
                if !inserted {
                    out.push((new_start, new_end));
                    inserted = true;
                }
                out.push((r_start, r_end));
            } else {
                new_start = new_start.min(r_start);
                new_end = new_end.max(r_end);
            }
        }
        if !inserted {
            out.push((new_start, new_end));
        }
        self.prot_none_ranges = out;
    }

    /// Subtract `[start, end)` from tracked `PROT_NONE` ranges, splitting any containing interval.
    pub fn remove_prot_none_range(&mut self, start: u32, end: u32) {
        if start >= end || self.prot_none_ranges.is_empty() {
            return;
        }
        let mut out = Vec::with_capacity(self.prot_none_ranges.len() + 1);
        for &(r_start, r_end) in &self.prot_none_ranges {
            if r_end <= start || r_start >= end {
                out.push((r_start, r_end));
            } else {
                if r_start < start {
                    out.push((r_start, start));
                }
                if r_end > end {
                    out.push((end, r_end));
                }
            }
        }
        self.prot_none_ranges = out;
    }

    /// Return sorted, disjoint byte ranges in `[0, total_len)` that must be copied on fork,
    /// skipping tracked known-zero `PROT_NONE` ranges.
    pub fn fork_copy_ranges(&self, total_len: usize) -> Vec<(usize, usize)> {
        if total_len == 0 {
            return Vec::new();
        }
        let mut out = Vec::with_capacity(self.prot_none_ranges.len() + 1);
        let mut pos: usize = 0;
        for &(r_start, r_end) in &self.prot_none_ranges {
            let s = (r_start as usize).min(total_len);
            let e = (r_end as usize).min(total_len);
            if s > pos {
                out.push((pos, s));
            }
            if e > pos {
                pos = e;
            }
            if pos >= total_len {
                break;
            }
        }
        if pos < total_len {
            out.push((pos, total_len));
        }
        out
    }
}

#[derive(Debug, Clone)]
pub struct TtyState {
    pub enabled: bool,
    pub rows: u16,
    pub cols: u16,
    pub fg_pgid: i32,
    pub termios: [u8; 36],
    pub canon_buf: Vec<u8>,
}

impl TtyState {
    pub fn new() -> Self {
        let mut termios = [0u8; 36];
        termios[0..4].copy_from_slice(&0x4500u32.to_le_bytes()); // ICRNL | IXON | IUTF8
        termios[4..8].copy_from_slice(&0x0005u32.to_le_bytes()); // OPOST | ONLCR
        termios[8..12].copy_from_slice(&0x00bfu32.to_le_bytes()); // B38400 | CS8 | CREAD
        termios[12..16].copy_from_slice(&0x8a3bu32.to_le_bytes()); // ISIG | ICANON | ECHO | ...
        termios[16] = 0; // c_line
        let cc: [u8; 19] = [
            3, 28, 127, 21, 4, 0, 1, 0, 17, 19, 26, 0, 18, 15, 23, 22, 0, 0, 0,
        ];
        termios[17..36].copy_from_slice(&cc);
        Self {
            enabled: false,
            rows: 24,
            cols: 80,
            fg_pgid: MAIN_PID,
            termios,
            canon_buf: Vec::new(),
        }
    }

    #[inline]
    pub fn c_iflag(&self) -> u32 {
        u32::from_le_bytes(self.termios[0..4].try_into().unwrap())
    }

    #[inline]
    pub fn c_oflag(&self) -> u32 {
        u32::from_le_bytes(self.termios[4..8].try_into().unwrap())
    }

    #[inline]
    pub fn c_lflag(&self) -> u32 {
        u32::from_le_bytes(self.termios[12..16].try_into().unwrap())
    }

    #[inline]
    pub fn is_icrnl(&self) -> bool {
        (self.c_iflag() & 0x0100) != 0
    }

    #[inline]
    pub fn is_onlcr(&self) -> bool {
        (self.c_oflag() & 0x0004) != 0
    }

    #[inline]
    pub fn is_isig(&self) -> bool {
        (self.c_lflag() & 0x0001) != 0
    }

    #[inline]
    pub fn is_icanon(&self) -> bool {
        (self.c_lflag() & 0x0002) != 0
    }

    #[inline]
    pub fn is_echo(&self) -> bool {
        (self.c_lflag() & 0x0008) != 0
    }
}

pub struct ProcessState {
    pub pid: i32,
    pub ppid: i32,
    pub pgid: i32,
    pub sid: i32,
    pub umask: u32,
    pub fds: BTreeMap<i32, OpenFile>,
    pub next_fd: i32,
    pub cwd: String,
    pub elf_path: String,
    pub so_entries: Vec<SoEntry>,
    pub brk_start: u32,
    pub brk_curr: u32,
    pub mmap_start: u32,
    pub mmap_end: u32,
    pub mmap_alloc: MmapAllocator,
    pub scheduler: Scheduler,
    pub sig_handlers: BTreeMap<i32, u64>,
    pub exited: bool,
    pub zombie: bool,
    pub exit_status: i32,
    pub vfork_parent: Option<i32>,
}

impl ProcessState {
    fn empty_slot(pid: i32, ppid: i32, pgid: i32, sid: i32) -> Self {
        Self {
            pid,
            ppid,
            pgid,
            sid,
            umask: 0o022,
            fds: BTreeMap::new(),
            next_fd: 3,
            cwd: String::new(),
            elf_path: String::new(),
            so_entries: Vec::new(),
            brk_start: BRK_START,
            brk_curr: BRK_START,
            mmap_start: MMAP_START,
            mmap_end: MMAP_END,
            mmap_alloc: MmapAllocator::new(),
            scheduler: Scheduler::new_with_tid(pid, 0, 0),
            sig_handlers: BTreeMap::new(),
            exited: false,
            zombie: false,
            exit_status: 0,
            vfork_parent: None,
        }
    }
}

#[derive(Debug, Clone)]
pub enum PendingHostAction {
    Fork {
        parent_pid: i32,
        child_pid: i32,
        is_vfork: bool,
        scratch_addr: u32,
    },
    Exec {
        pid: i32,
        path: String,
        argv: Vec<String>,
        envp: Vec<String>,
    },
}

pub struct HostState {
    pub vfs: VirtualFs,
    pub scheduler: Scheduler,
    pub brk_start: u32,
    pub brk_curr: u32,
    pub mmap_start: u32,
    pub mmap_end: u32,
    pub mmap_alloc: MmapAllocator,
    pub prng_state: u64,
    pub active_pid: i32,
    pub next_pid: i32,
    pub next_tid: i32,
    pub processes: BTreeMap<i32, ProcessState>,
    pub pending_action: Option<PendingHostAction>,
    pub multiproc_enabled: bool,
    pub tty: TtyState,
    pub stdin_open: bool,
    pub uid: u32,
    pub euid: u32,
    pub gid: u32,
    pub egid: u32,
    pub groups: Vec<u32>,
    pub reaped_pids: Vec<i32>,
}

impl HostState {
    pub fn new(vfs: VirtualFs) -> Self {
        let mut processes = BTreeMap::new();
        processes.insert(
            MAIN_PID,
            ProcessState::empty_slot(MAIN_PID, 1, MAIN_PID, MAIN_PID),
        );
        Self {
            vfs,
            scheduler: Scheduler::new(),
            brk_start: BRK_START,
            brk_curr: BRK_START,
            mmap_start: MMAP_START,
            mmap_end: MMAP_END,
            mmap_alloc: MmapAllocator::new(),
            prng_state: 0x9e37_79b9_7f4a_7c15,
            active_pid: MAIN_PID,
            next_pid: MAIN_PID + 1,
            next_tid: MAIN_PID + 1,
            processes,
            pending_action: None,
            multiproc_enabled: false,
            tty: TtyState::new(),
            stdin_open: false,
            uid: 1000,
            euid: 1000,
            gid: 1000,
            egid: 1000,
            groups: vec![1000],
            reaped_pids: Vec::new(),
        }
    }

    pub fn apply_meta_layout(&mut self, meta: &WasmMeta) {
        let mmap_alloc_end = meta.mmap_end.saturating_sub(4096);
        self.brk_start = meta.brk_start;
        self.brk_curr = meta.brk_start;
        self.mmap_start = meta.mmap_start;
        self.mmap_end = meta.mmap_end;
        self.mmap_alloc = MmapAllocator::new_with_bounds(meta.mmap_start, mmap_alloc_end);
        self.scheduler.scratch_addr = mmap_alloc_end;
    }

    pub fn set_uid_gid(&mut self, uid: u32, gid: u32) {
        self.uid = uid;
        self.euid = uid;
        self.gid = gid;
        self.egid = gid;
        self.groups = vec![gid];
        self.vfs.uid = uid;
        self.vfs.gid = gid;
    }

    pub fn set_tty_mode(&mut self, enabled: bool) {
        if !enabled && !self.tty.canon_buf.is_empty() {
            let pending = core::mem::take(&mut self.tty.canon_buf);
            self.vfs.push_stdin(&pending);
        }
        self.tty.enabled = enabled;
        self.vfs.stdin_eof = !(self.tty.enabled || self.stdin_open);
    }

    pub fn set_stdin_open(&mut self, open: bool) {
        self.stdin_open = open;
        self.vfs.stdin_eof = !(self.tty.enabled || self.stdin_open);
    }

    pub fn set_winsize(&mut self, rows: u32, cols: u32) {
        self.tty.rows = rows.clamp(1, u16::MAX as u32) as u16;
        self.tty.cols = cols.clamp(1, u16::MAX as u32) as u16;
    }

    /// Push host stdin bytes through the POSIX TTY line discipline when `tty.enabled`,
    /// or directly into the raw stdin queue in batch/pipe mode.
    pub fn push_stdin(&mut self, data: &[u8]) {
        if !self.tty.enabled {
            self.vfs.push_stdin(data);
            self.wake_ready_waiters();
            return;
        }
        let icanon = self.tty.is_icanon();
        let echo = self.tty.is_echo();
        let icrnl = self.tty.is_icrnl();
        let onlcr = self.tty.is_onlcr();
        let isig = self.tty.is_isig();
        let vintr = self.tty.termios[17];
        let verase = self.tty.termios[19];
        let vkill = self.tty.termios[20];
        let veof = self.tty.termios[21];

        let echo_nl = |stdout: &mut Vec<u8>| {
            if onlcr {
                stdout.extend_from_slice(b"\r\n");
            } else {
                stdout.push(b'\n');
            }
        };

        if !icanon {
            if !self.tty.canon_buf.is_empty() {
                let pending = core::mem::take(&mut self.tty.canon_buf);
                self.vfs.push_stdin(&pending);
            }
            for &raw_b in data {
                if isig && vintr != 0 && raw_b == vintr {
                    if echo {
                        self.vfs.stdout.extend_from_slice(b"^C");
                        echo_nl(&mut self.vfs.stdout);
                    }
                    self.send_sigint();
                    continue;
                }
                let b = if icrnl && raw_b == b'\r' { b'\n' } else { raw_b };
                if echo {
                    if b == b'\n' {
                        echo_nl(&mut self.vfs.stdout);
                    } else if (b >= 0x20 && b != 0x7f) || b == b'\t' {
                        self.vfs.stdout.push(b);
                    }
                }
                self.vfs.push_stdin(&[b]);
            }
            self.wake_ready_waiters();
            return;
        }

        // Canonical mode (ICANON)
        for &raw_b in data {
            if isig && vintr != 0 && raw_b == vintr {
                self.tty.canon_buf.clear();
                if echo {
                    self.vfs.stdout.extend_from_slice(b"^C");
                    echo_nl(&mut self.vfs.stdout);
                }
                self.send_sigint();
                continue;
            }
            let b = if icrnl && raw_b == b'\r' { b'\n' } else { raw_b };
            if b == 0x7f || b == 0x08 || (verase != 0 && b == verase) {
                if self.tty.canon_buf.pop().is_some() && echo {
                    self.vfs.stdout.extend_from_slice(b"\x08 \x08");
                }
                continue;
            }
            if vkill != 0 && b == vkill {
                let n = self.tty.canon_buf.len();
                self.tty.canon_buf.clear();
                if echo {
                    for _ in 0..n {
                        self.vfs.stdout.extend_from_slice(b"\x08 \x08");
                    }
                }
                continue;
            }
            if veof != 0 && b == veof {
                if !self.tty.canon_buf.is_empty() {
                    let line = core::mem::take(&mut self.tty.canon_buf);
                    self.vfs.push_stdin(&line);
                } else {
                    self.vfs.close_stdin();
                }
                continue;
            }
            if b == b'\n' {
                self.tty.canon_buf.push(b'\n');
                if echo {
                    echo_nl(&mut self.vfs.stdout);
                }
                let line = core::mem::take(&mut self.tty.canon_buf);
                self.vfs.push_stdin(&line);
                continue;
            }
            self.tty.canon_buf.push(b);
            if echo && ((b >= 0x20 && b != 0x7f) || b == b'\t') {
                self.vfs.stdout.push(b);
            }
        }
        self.wake_ready_waiters();
    }

    pub fn close_stdin(&mut self) {
        if !self.tty.canon_buf.is_empty() {
            let pending = core::mem::take(&mut self.tty.canon_buf);
            self.vfs.push_stdin(&pending);
        }
        self.vfs.close_stdin();
        self.wake_ready_waiters();
    }

    pub fn take_reaped_pids(&mut self) -> Vec<i32> {
        core::mem::take(&mut self.reaped_pids)
    }

    pub fn alloc_pid(&mut self) -> i32 {
        let id = self.next_pid.max(self.next_tid);
        self.next_pid = id + 1;
        self.next_tid = id + 1;
        id
    }

    pub fn alloc_tid(&mut self) -> i32 {
        let id = self.next_pid.max(self.next_tid);
        self.next_pid = id + 1;
        self.next_tid = id + 1;
        id
    }

    fn next_rand_u64(&mut self) -> u64 {
        self.vfs.next_rand_u64()
    }

    pub fn switch_active_process(&mut self, new_pid: i32) {
        if new_pid == self.active_pid {
            return;
        }
        let mono = self.scheduler.virtual_mono_ns;
        let rt_base = self.scheduler.realtime_base_ns;
        if let Some(old_p) = self.processes.get_mut(&self.active_pid) {
            core::mem::swap(&mut self.vfs.fds, &mut old_p.fds);
            old_p.next_fd = self.vfs.next_fd;
            old_p.umask = self.vfs.umask;
            core::mem::swap(&mut self.vfs.cwd, &mut old_p.cwd);
            core::mem::swap(&mut self.vfs.elf_path, &mut old_p.elf_path);
            core::mem::swap(&mut self.vfs.so_entries, &mut old_p.so_entries);
            old_p.brk_start = self.brk_start;
            old_p.brk_curr = self.brk_curr;
            old_p.mmap_start = self.mmap_start;
            old_p.mmap_end = self.mmap_end;
            core::mem::swap(&mut self.mmap_alloc, &mut old_p.mmap_alloc);
            core::mem::swap(&mut self.scheduler, &mut old_p.scheduler);
        }
        if let Some(new_p) = self.processes.get_mut(&new_pid) {
            core::mem::swap(&mut self.vfs.fds, &mut new_p.fds);
            self.vfs.next_fd = new_p.next_fd;
            self.vfs.umask = new_p.umask;
            core::mem::swap(&mut self.vfs.cwd, &mut new_p.cwd);
            core::mem::swap(&mut self.vfs.elf_path, &mut new_p.elf_path);
            core::mem::swap(&mut self.vfs.so_entries, &mut new_p.so_entries);
            self.brk_start = new_p.brk_start;
            self.brk_curr = new_p.brk_curr;
            self.mmap_start = new_p.mmap_start;
            self.mmap_end = new_p.mmap_end;
            core::mem::swap(&mut self.mmap_alloc, &mut new_p.mmap_alloc);
            core::mem::swap(&mut self.scheduler, &mut new_p.scheduler);
            self.scheduler.virtual_mono_ns = mono;
            self.scheduler.realtime_base_ns = rt_base;
            self.active_pid = new_pid;
            self.vfs.current_pid = new_p.pid;
            self.vfs.current_ppid = new_p.ppid;
            self.vfs.current_pgid = new_p.pgid;
        }
    }

    pub fn send_sigint(&mut self) {
        let fg_pgid = self.tty.fg_pgid;
        let mut targets: Vec<i32> = self
            .processes
            .values()
            .filter(|p| !p.exited && p.pgid == fg_pgid)
            .map(|p| p.pid)
            .collect();
        if targets.is_empty() {
            targets = self
                .processes
                .values()
                .filter(|p| !p.exited && p.pid != MAIN_PID)
                .map(|p| p.pid)
                .collect();
        }
        if targets.is_empty() && !self.is_main_exited() {
            targets.push(MAIN_PID);
        }
        for pid in targets {
            self.deliver_signal(None, pid, 2);
        }
        self.wake_ready_waiters();
    }

    pub fn deliver_signal(
        &mut self,
        ctx: Option<&mut dyn GuestContext>,
        target_pid: i32,
        sig: i32,
    ) {
        let Some(exited) = self.processes.get(&target_pid).map(|p| p.exited) else {
            return;
        };
        if exited || sig == 0 {
            return;
        }
        let handler = self
            .processes
            .get(&target_pid)
            .and_then(|p| p.sig_handlers.get(&sig).copied())
            .unwrap_or(0);

        let should_terminate = match sig {
            9 => true, // SIGKILL
            2 | 15 => handler == 0 && target_pid != MAIN_PID,
            _ => false,
        };

        if should_terminate {
            let pipe_ids: Vec<u64> = if target_pid == self.active_pid {
                let ids = self
                    .vfs
                    .fds
                    .values()
                    .flat_map(|f| f.pipe_id.into_iter().chain(f.sock_write_pipe_id))
                    .collect();
                self.vfs.close_all_fds();
                ids
            } else {
                let old_fds = if let Some(p) = self.processes.get_mut(&target_pid) {
                    core::mem::take(&mut p.fds)
                } else {
                    BTreeMap::new()
                };
                let mut ids = Vec::new();
                for f in old_fds.values() {
                    if let Some(pid) = f.pipe_id {
                        ids.push(pid);
                    }
                    if let Some(wpid) = f.sock_write_pipe_id {
                        ids.push(wpid);
                    }
                }
                // Decrement pipe refcounts for inactive process FDs
                let saved = core::mem::replace(&mut self.vfs.fds, old_fds);
                self.vfs.close_all_fds();
                self.vfs.fds = saved;
                ids
            };
            for pipe_id in pipe_ids {
                self.wake_pipe_waiters(pipe_id);
            }
            self.wake_vfork_parent_for(target_pid);
            if let Some(p) = self.processes.get_mut(&target_pid) {
                if !p.exited {
                    p.exited = true;
                    p.zombie = target_pid != MAIN_PID;
                    p.exit_status = sig & 0x7f;
                    if target_pid != MAIN_PID {
                        self.reaped_pids.push(target_pid);
                    }
                }
            }
            if target_pid == self.active_pid {
                if let Some(c) = ctx {
                    if target_pid == MAIN_PID {
                        c.set_exit(128 + (sig & 0x7f));
                    } else {
                        c.set_yield_flag(1);
                    }
                }
            }
            self.wake_ready_waiters();
            return;
        }

        if handler == 1 {
            // SIG_IGN
            return;
        }

        // Interrupt blocked threads in target_pid with -EINTR (for trapped signals or SIGINT on MAIN_PID)
        let sched = if target_pid == self.active_pid {
            &mut self.scheduler
        } else if let Some(p) = self.processes.get_mut(&target_pid) {
            &mut p.scheduler
        } else {
            return;
        };
        let tids: Vec<i32> = sched.threads.keys().copied().collect();
        for tid in tids {
            let is_blocked = sched.threads.get(&tid).map_or(false, |t| {
                matches!(
                    t.state,
                    ThreadState::StdinReadWait { .. }
                        | ThreadState::Sleeping { .. }
                        | ThreadState::PollWait { .. }
                        | ThreadState::Wait4Wait { .. }
                        | ThreadState::PipeReadWait { .. }
                        | ThreadState::PipeWriteWait { .. }
                        | ThreadState::FutexWait { .. }
                )
            });
            if is_blocked {
                if let Some(t) = sched.threads.get_mut(&tid) {
                    t.state = ThreadState::Runnable;
                    t.pending_wakeup = None;
                    t.set_rax(-EINTR);
                    if !sched.run_queue.contains(&tid) {
                        sched.run_queue.push_back(tid);
                    }
                }
            }
        }
    }

    pub fn is_main_exited(&self) -> bool {
        self.processes.get(&MAIN_PID).map_or(false, |p| p.exited)
    }

    pub fn current_ppid(&self) -> i32 {
        self.processes
            .get(&self.active_pid)
            .map_or(1, |p| p.ppid)
    }

    pub fn current_pgid(&self) -> i32 {
        self.processes
            .get(&self.active_pid)
            .map_or(self.active_pid, |p| p.pgid)
    }

    fn matches_wait_target(parent_pgid: i32, child: &ProcessState, target_pid: i32) -> bool {
        if target_pid > 0 {
            child.pid == target_pid
        } else if target_pid == -1 {
            true
        } else if target_pid == 0 {
            child.pgid == parent_pgid
        } else {
            child.pgid == -target_pid
        }
    }

    fn find_wait_status(&self, parent_pid: i32, target_pid: i32) -> (bool, Option<i32>) {
        let parent_pgid = self
            .processes
            .get(&parent_pid)
            .map_or(parent_pid, |p| p.pgid);
        let mut has_child = false;
        let mut zombie_pid = None;
        for (&cpid, child) in &self.processes {
            if child.ppid == parent_pid && Self::matches_wait_target(parent_pgid, child, target_pid)
            {
                has_child = true;
                if child.zombie {
                    zombie_pid = Some(cpid);
                    break;
                }
            }
        }
        (has_child, zombie_pid)
    }

    fn reap_child(
        &mut self,
        ctx: &mut dyn GuestContext,
        child_pid: i32,
        wstatus_addr: u64,
        rusage_addr: u64,
    ) -> Result<i64, i64> {
        let exit_status = self
            .processes
            .remove(&child_pid)
            .map(|c| c.exit_status)
            .unwrap_or(0);
        if wstatus_addr != 0 {
            write_bytes(ctx, wstatus_addr, &exit_status.to_le_bytes())?;
        }
        if rusage_addr != 0 {
            write_bytes(ctx, rusage_addr, &[0u8; 144])?;
        }
        Ok(child_pid as i64)
    }

    fn wake_vfork_parent_for(&mut self, child_pid: i32) {
        let parent_pid = self
            .processes
            .get_mut(&child_pid)
            .and_then(|c| c.vfork_parent.take());
        let Some(ppid) = parent_pid else {
            return;
        };
        if ppid == self.active_pid {
            let tids: Vec<i32> = self.scheduler.threads.keys().copied().collect();
            for tid in tids {
                if let Some(t) = self.scheduler.threads.get_mut(&tid) {
                    if matches!(t.state, ThreadState::VforkWait { child_pid: c } if c == child_pid)
                    {
                        t.state = ThreadState::Runnable;
                        self.scheduler.run_queue.push_back(tid);
                    }
                }
            }
        } else if let Some(p) = self.processes.get_mut(&ppid) {
            let tids: Vec<i32> = p.scheduler.threads.keys().copied().collect();
            for tid in tids {
                if let Some(t) = p.scheduler.threads.get_mut(&tid) {
                    if matches!(t.state, ThreadState::VforkWait { child_pid: c } if c == child_pid)
                    {
                        t.state = ThreadState::Runnable;
                        p.scheduler.run_queue.push_back(tid);
                    }
                }
            }
        }
    }

    fn wake_pipe_waiters(&mut self, pipe_id: u64) {
        let (has_data, writers, readers, has_space) = match self.vfs.pipes.get(&pipe_id) {
            Some(p) => (!p.buf.is_empty(), p.writers, p.readers, p.buf.len() < p.capacity),
            None => (false, 0, 0, false),
        };
        let wake_in_sched = |sched: &mut Scheduler| {
            let tids: Vec<i32> = sched.threads.keys().copied().collect();
            for tid in tids {
                if let Some(t) = sched.threads.get_mut(&tid) {
                    match t.state.clone() {
                        ThreadState::PipeReadWait {
                            pipe_id: pid,
                            buf_addr,
                            count,
                        } if pid == pipe_id && (has_data || writers == 0) => {
                            t.state = ThreadState::Runnable;
                            t.pending_wakeup = Some(PendingWakeup::PipeRead {
                                pipe_id,
                                buf_addr,
                                count,
                            });
                            sched.run_queue.push_back(tid);
                        }
                        ThreadState::PipeWriteWait {
                            pipe_id: pid,
                            data,
                            written,
                        } if pid == pipe_id && (has_space || readers == 0) => {
                            t.state = ThreadState::Runnable;
                            t.pending_wakeup = Some(PendingWakeup::PipeWrite {
                                pipe_id,
                                data,
                                written,
                            });
                            sched.run_queue.push_back(tid);
                        }
                        _ => {}
                    }
                }
            }
        };
        wake_in_sched(&mut self.scheduler);
        let active_pid = self.active_pid;
        for (&pid, p) in self.processes.iter_mut() {
            if pid != active_pid && !p.exited {
                wake_in_sched(&mut p.scheduler);
            }
        }
    }

    fn poll_fds_ref(&self, pid: i32) -> &BTreeMap<i32, OpenFile> {
        if pid == self.active_pid {
            &self.vfs.fds
        } else {
            &self.processes[&pid].fds
        }
    }

    fn eval_fd_events(&self, fds: &BTreeMap<i32, OpenFile>, fd: i32, events: i16) -> i16 {
        let Some(f) = fds.get(&fd) else {
            return POLLNVAL;
        };
        if let Some(wpid) = f.sock_write_pipe_id {
            let mut revents = 0i16;
            if let Some(rpid) = f.pipe_id {
                match self.vfs.pipes.get(&rpid) {
                    Some(p) => {
                        if !p.buf.is_empty() && (events & POLLIN) != 0 {
                            revents |= POLLIN;
                        }
                        if p.writers == 0 {
                            revents |= POLLHUP;
                        }
                    }
                    None => revents |= POLLHUP,
                }
            }
            match self.vfs.pipes.get(&wpid) {
                Some(p) => {
                    if p.readers == 0 {
                        revents |= POLLERR;
                    } else if p.buf.len() < p.capacity && (events & POLLOUT) != 0 {
                        revents |= POLLOUT;
                    }
                }
                None => revents |= POLLERR,
            }
            return revents;
        }
        if let Some(eid) = f.eventfd_id {
            let mut revents = 0i16;
            if let Some(efd) = self.vfs.eventfds.get(&eid) {
                if efd.counter > 0 && (events & POLLIN) != 0 {
                    revents |= POLLIN;
                }
                if efd.counter < u64::MAX - 1 && (events & POLLOUT) != 0 {
                    revents |= POLLOUT;
                }
            }
            return revents;
        }
        if let Some(pid) = f.pipe_id {
            let Some(p) = self.vfs.pipes.get(&pid) else {
                return POLLHUP;
            };
            let mut revents = 0i16;
            if !f.writable {
                if !p.buf.is_empty() && (events & POLLIN) != 0 {
                    revents |= POLLIN;
                }
                if p.writers == 0 {
                    revents |= POLLHUP;
                }
            } else {
                if p.readers == 0 {
                    revents |= POLLERR;
                } else if p.buf.len() < p.capacity && (events & POLLOUT) != 0 {
                    revents |= POLLOUT;
                }
            }
            return revents;
        }
        if f.is_std == Some(0) || f.dev == Some(VirtualDevice::Tty) {
            let mut revents = 0i16;
            if (events & POLLIN) != 0
                && (self.vfs.inherit_stdin
                    || self.vfs.stdin_available() > 0
                    || self.vfs.stdin_eof)
            {
                revents |= POLLIN;
            }
            if f.dev == Some(VirtualDevice::Tty) && f.writable && (events & POLLOUT) != 0 {
                revents |= POLLOUT;
            }
            return revents;
        }
        if let Some(std_fd) = f.is_std {
            let mut revents = 0i16;
            if (std_fd == 1 || std_fd == 2) && (events & POLLOUT) != 0 {
                revents |= POLLOUT;
            }
            return revents;
        }
        let mut revents = 0i16;
        if (events & POLLIN) != 0 {
            revents |= POLLIN;
        }
        if f.writable && (events & POLLOUT) != 0 {
            revents |= POLLOUT;
        }
        revents
    }

    fn is_poll_kind_ready(&self, pid: i32, kind: &PollKind) -> bool {
        let fds = self.poll_fds_ref(pid);
        match kind {
            PollKind::Poll { fds: specs, .. } => specs.iter().any(|s| {
                s.fd >= 0 && self.eval_fd_events(fds, s.fd, s.events) != 0
            }),
            PollKind::Select {
                nfds,
                orig_read_mask,
                orig_write_mask,
                ..
            } => {
                for fd in 0..(*nfds) {
                    let byte_idx = (fd / 8) as usize;
                    let bit = 1u8 << (fd % 8);
                    let want_r = orig_read_mask.get(byte_idx).map_or(false, |b| (b & bit) != 0);
                    let want_w = orig_write_mask.get(byte_idx).map_or(false, |b| (b & bit) != 0);
                    if want_r && (self.eval_fd_events(fds, fd, POLLIN) & (POLLIN | POLLHUP | POLLERR)) != 0 {
                        return true;
                    }
                    if want_w && (self.eval_fd_events(fds, fd, POLLOUT) & (POLLOUT | POLLERR)) != 0 {
                        return true;
                    }
                }
                false
            }
            PollKind::Epoll { epfd, .. } => {
                let Some(eid) = fds.get(epfd).and_then(|f| f.epoll_id) else {
                    return true;
                };
                let Some(inst) = self.vfs.epolls.get(&eid) else {
                    return true;
                };
                inst.entries.iter().any(|(&fd, entry)| {
                    let ev = (entry.events & 0xffff) as i16;
                    let rev = self.eval_fd_events(fds, fd, ev);
                    rev != 0 && rev != POLLNVAL
                })
            }
        }
    }

    fn poll_kind_watches_stdin(&self, pid: i32, kind: &PollKind) -> bool {
        let fds = self.poll_fds_ref(pid);
        let is_stdin_fd = |fd: i32| {
            fds.get(&fd)
                .map_or(false, |f| f.is_std == Some(0) || f.dev == Some(VirtualDevice::Tty))
        };
        match kind {
            PollKind::Poll { fds: specs, .. } => specs
                .iter()
                .any(|s| s.fd >= 0 && (s.events & POLLIN) != 0 && is_stdin_fd(s.fd)),
            PollKind::Select {
                nfds,
                orig_read_mask,
                ..
            } => (0..*nfds).any(|fd| {
                let byte_idx = (fd / 8) as usize;
                let bit = 1u8 << (fd % 8);
                orig_read_mask.get(byte_idx).map_or(false, |b| (b & bit) != 0) && is_stdin_fd(fd)
            }),
            PollKind::Epoll { epfd, .. } => {
                let Some(eid) = fds.get(epfd).and_then(|f| f.epoll_id) else {
                    return false;
                };
                self.vfs.epolls.get(&eid).map_or(false, |inst| {
                    inst.entries
                        .iter()
                        .any(|(&fd, entry)| (entry.events & (POLLIN as u32)) != 0 && is_stdin_fd(fd))
                })
            }
        }
    }

    fn has_stdin_waiter(&self, pid: i32) -> bool {
        let sched = if pid == self.active_pid {
            &self.scheduler
        } else if let Some(p) = self.processes.get(&pid) {
            if p.exited {
                return false;
            }
            &p.scheduler
        } else {
            return false;
        };
        if self.processes.get(&pid).map_or(true, |p| p.exited) {
            return false;
        }
        sched.threads.values().any(|t| match &t.state {
            ThreadState::StdinReadWait { .. } => true,
            ThreadState::PollWait {
                kind,
                wake_ns: None,
            } => self.poll_kind_watches_stdin(pid, kind),
            _ => false,
        })
    }

    pub fn wake_ready_waiters(&mut self) {
        let active_pid = self.active_pid;
        let all_pids: Vec<i32> = self.processes.keys().copied().collect();
        for pid in all_pids {
            if self.processes.get(&pid).map_or(true, |p| p.exited) {
                continue;
            }
            let tids: Vec<i32> = if pid == active_pid {
                self.scheduler.threads.keys().copied().collect()
            } else {
                self.processes[&pid].scheduler.threads.keys().copied().collect()
            };
            for tid in tids {
                let state = if pid == active_pid {
                    self.scheduler.threads.get(&tid).map(|t| t.state.clone())
                } else {
                    self.processes[&pid].scheduler.threads.get(&tid).map(|t| t.state.clone())
                };
                let Some(state) = state else { continue };
                let wakeup = match state {
                    ThreadState::PipeReadWait {
                        pipe_id,
                        buf_addr,
                        count,
                    } => {
                        let ready = match self.vfs.pipes.get(&pipe_id) {
                            Some(p) => !p.buf.is_empty() || p.writers == 0,
                            None => true,
                        };
                        if ready {
                            Some(PendingWakeup::PipeRead {
                                pipe_id,
                                buf_addr,
                                count,
                            })
                        } else {
                            None
                        }
                    }
                    ThreadState::PipeWriteWait {
                        pipe_id,
                        data,
                        written,
                    } => {
                        let ready = match self.vfs.pipes.get(&pipe_id) {
                            Some(p) => p.readers == 0 || p.buf.len() < p.capacity,
                            None => true,
                        };
                        if ready {
                            Some(PendingWakeup::PipeWrite {
                                pipe_id,
                                data,
                                written,
                            })
                        } else {
                            None
                        }
                    }
                    ThreadState::StdinReadWait { buf_addr, count } => {
                        if self.vfs.stdin_available() > 0 || self.vfs.stdin_eof {
                            Some(PendingWakeup::StdinRead { buf_addr, count })
                        } else {
                            None
                        }
                    }
                    ThreadState::Wait4Wait {
                        target_pid,
                        wstatus_addr,
                        options,
                        rusage_addr,
                        waitid_infop,
                    } => {
                        let (has_child, zombie_pid) = self.find_wait_status(pid, target_pid);
                        if !has_child || zombie_pid.is_some() {
                            Some(PendingWakeup::Wait4 {
                                target_pid,
                                wstatus_addr,
                                options,
                                rusage_addr,
                                waitid_infop,
                            })
                        } else {
                            None
                        }
                    }
                    ThreadState::PollWait { kind, .. } => {
                        if self.is_poll_kind_ready(pid, &kind) {
                            Some(PendingWakeup::Poll {
                                kind,
                                timed_out: false,
                            })
                        } else {
                            None
                        }
                    }
                    _ => None,
                };
                if let Some(w) = wakeup {
                    let sched = if pid == active_pid {
                        &mut self.scheduler
                    } else {
                        &mut self.processes.get_mut(&pid).unwrap().scheduler
                    };
                    if let Some(t) = sched.threads.get_mut(&tid) {
                        t.state = ThreadState::Runnable;
                        t.pending_wakeup = Some(w);
                        if !sched.run_queue.contains(&tid) {
                            sched.run_queue.push_back(tid);
                        }
                    }
                }
            }
        }
    }

    fn complete_pending_wakeup(&mut self, ctx: &mut dyn GuestContext) -> Result<bool, i64> {
        let cur_tid = self.scheduler.current_tid;
        let Some(wakeup) = self
            .scheduler
            .threads
            .get_mut(&cur_tid)
            .and_then(|t| t.pending_wakeup.take())
        else {
            return Ok(true);
        };
        match wakeup {
            PendingWakeup::SetChildTid { addr, tid } => {
                let _ = write_bytes(ctx, addr, &tid.to_le_bytes());
                Ok(true)
            }
            PendingWakeup::StdinRead { buf_addr, count } => {
                if self.vfs.stdin_available() > 0 {
                    let cursor = self.vfs.stdin_cursor_val();
                    let avail = self.vfs.stdin_available();
                    let n = avail.min(count);
                    let bytes = self.vfs.stdin_data[cursor..cursor + n].to_vec();
                    let ret = match write_bytes(ctx, buf_addr, &bytes) {
                        Ok(()) => {
                            self.vfs.advance_read_cursor(0, n);
                            n as i64
                        }
                        Err(e) => e,
                    };
                    if let Some(t) = self.scheduler.threads.get_mut(&cur_tid) {
                        t.set_rax(ret);
                    }
                    Ok(true)
                } else if self.vfs.stdin_eof {
                    if let Some(t) = self.scheduler.threads.get_mut(&cur_tid) {
                        t.set_rax(0);
                    }
                    Ok(true)
                } else {
                    if let Some(t) = self.scheduler.threads.get_mut(&cur_tid) {
                        t.state = ThreadState::StdinReadWait { buf_addr, count };
                    }
                    Ok(false)
                }
            }
            PendingWakeup::PipeRead {
                pipe_id,
                buf_addr,
                count,
            } => {
                let mut drained = Vec::new();
                let mut writers = 0usize;
                if let Some(p) = self.vfs.pipes.get_mut(&pipe_id) {
                    writers = p.writers;
                    let n = count.min(p.buf.len());
                    drained.reserve(n);
                    for _ in 0..n {
                        if let Some(b) = p.buf.pop_front() {
                            drained.push(b);
                        }
                    }
                }
                if drained.is_empty() && writers > 0 {
                    if let Some(t) = self.scheduler.threads.get_mut(&cur_tid) {
                        t.state = ThreadState::PipeReadWait {
                            pipe_id,
                            buf_addr,
                            count,
                        };
                    }
                    return Ok(false);
                }
                let ret = match write_bytes(ctx, buf_addr, &drained) {
                    Ok(()) => {
                        if !drained.is_empty() {
                            self.wake_pipe_waiters(pipe_id);
                        }
                        drained.len() as i64
                    }
                    Err(e) => e,
                };
                if let Some(t) = self.scheduler.threads.get_mut(&cur_tid) {
                    t.set_rax(ret);
                }
                Ok(true)
            }
            PendingWakeup::PipeWrite {
                pipe_id,
                data,
                written,
            } => {
                let ret = match self.vfs.pipes.get_mut(&pipe_id) {
                    None => -EPIPE,
                    Some(p) if p.readers == 0 => {
                        if written > 0 {
                            written as i64
                        } else {
                            -EPIPE
                        }
                    }
                    Some(p) => {
                        let space = p.capacity.saturating_sub(p.buf.len());
                        if space == 0 {
                            if let Some(t) = self.scheduler.threads.get_mut(&cur_tid) {
                                t.state = ThreadState::PipeWriteWait {
                                    pipe_id,
                                    data,
                                    written,
                                };
                            }
                            return Ok(false);
                        }
                        let rem = data.len().saturating_sub(written);
                        let n = rem.min(space);
                        p.buf.extend(&data[written..written + n]);
                        self.wake_pipe_waiters(pipe_id);
                        (written + n) as i64
                    }
                };
                if let Some(t) = self.scheduler.threads.get_mut(&cur_tid) {
                    t.set_rax(ret);
                }
                Ok(true)
            }
            PendingWakeup::Wait4 {
                target_pid,
                wstatus_addr,
                options: _,
                rusage_addr,
                waitid_infop,
            } => {
                let (has_child, zombie_pid) = self.find_wait_status(self.active_pid, target_pid);
                if let Some(zpid) = zombie_pid {
                    let ret = if let Some(infop) = waitid_infop {
                        let exit_status = self
                            .processes
                            .get(&zpid)
                            .map(|c| c.exit_status)
                            .unwrap_or(0);
                        match self.reap_child(ctx, zpid, 0, rusage_addr) {
                            Ok(_) => {
                                if infop != 0 {
                                    let mut si = [0u8; 128];
                                    si[0..4].copy_from_slice(&17i32.to_le_bytes()); // si_signo = SIGCHLD
                                    si[8..12].copy_from_slice(&1i32.to_le_bytes()); // si_code = CLD_EXITED
                                    si[16..20].copy_from_slice(&zpid.to_le_bytes()); // si_pid
                                    si[20..24].copy_from_slice(&self.uid.to_le_bytes()); // si_uid
                                    si[24..28].copy_from_slice(&((exit_status >> 8) & 0xff).to_le_bytes());
                                    match write_bytes(ctx, infop, &si) {
                                        Ok(()) => 0,
                                        Err(e) => e,
                                    }
                                } else {
                                    0
                                }
                            }
                            Err(e) => e,
                        }
                    } else {
                        match self.reap_child(ctx, zpid, wstatus_addr, rusage_addr) {
                            Ok(r) => r,
                            Err(e) => e,
                        }
                    };
                    if let Some(t) = self.scheduler.threads.get_mut(&cur_tid) {
                        t.set_rax(ret);
                    }
                    Ok(true)
                } else if !has_child {
                    if let Some(t) = self.scheduler.threads.get_mut(&cur_tid) {
                        t.set_rax(-ECHILD);
                    }
                    Ok(true)
                } else {
                    if let Some(t) = self.scheduler.threads.get_mut(&cur_tid) {
                        t.state = ThreadState::Wait4Wait {
                            target_pid,
                            wstatus_addr,
                            options: 0,
                            rusage_addr,
                            waitid_infop,
                        };
                    }
                    Ok(false)
                }
            }
            PendingWakeup::Poll { kind, timed_out } => {
                let ret = self.finish_poll(ctx, &kind, timed_out);
                if let Some(t) = self.scheduler.threads.get_mut(&cur_tid) {
                    t.set_rax(ret);
                }
                Ok(true)
            }
        }
    }

    fn finish_poll(&self, ctx: &mut dyn GuestContext, kind: &PollKind, timed_out: bool) -> i64 {
        match kind {
            PollKind::Poll { fds_addr, fds } => {
                let mut ready = 0i64;
                for (idx, spec) in fds.iter().enumerate() {
                    let revents = if timed_out || spec.fd < 0 {
                        0i16
                    } else {
                        self.eval_fd_events(&self.vfs.fds, spec.fd, spec.events)
                    };
                    if revents != 0 {
                        ready += 1;
                    }
                    let rev_addr = *fds_addr + (idx as u64) * 8 + 6;
                    if let Err(e) = write_bytes(ctx, rev_addr, &revents.to_le_bytes()) {
                        return e;
                    }
                }
                ready
            }
            PollKind::Select {
                nfds,
                readfds_addr,
                writefds_addr,
                exceptfds_addr,
                orig_read_mask,
                orig_write_mask,
            } => {
                let nbytes = ((*nfds + 7) / 8) as usize;
                let mut out_r = vec![0u8; nbytes];
                let mut out_w = vec![0u8; nbytes];
                let out_e = vec![0u8; nbytes];
                let mut count = 0i64;
                if !timed_out {
                    for fd in 0..(*nfds) {
                        let byte_idx = (fd / 8) as usize;
                        let bit = 1u8 << (fd % 8);
                        if orig_read_mask.get(byte_idx).map_or(false, |b| (b & bit) != 0)
                            && (self.eval_fd_events(&self.vfs.fds, fd, POLLIN)
                                & (POLLIN | POLLHUP | POLLERR))
                                != 0
                        {
                            out_r[byte_idx] |= bit;
                            count += 1;
                        }
                        if orig_write_mask.get(byte_idx).map_or(false, |b| (b & bit) != 0)
                            && (self.eval_fd_events(&self.vfs.fds, fd, POLLOUT)
                                & (POLLOUT | POLLERR))
                                != 0
                        {
                            out_w[byte_idx] |= bit;
                            count += 1;
                        }
                    }
                }
                if *readfds_addr != 0 {
                    if let Err(e) = write_bytes(ctx, *readfds_addr, &out_r) {
                        return e;
                    }
                }
                if *writefds_addr != 0 {
                    if let Err(e) = write_bytes(ctx, *writefds_addr, &out_w) {
                        return e;
                    }
                }
                if *exceptfds_addr != 0 {
                    if let Err(e) = write_bytes(ctx, *exceptfds_addr, &out_e) {
                        return e;
                    }
                }
                count
            }
            PollKind::Epoll {
                epfd,
                events_addr,
                maxevents,
            } => {
                if timed_out {
                    return 0;
                }
                let Some(eid) = self.vfs.fds.get(epfd).and_then(|f| f.epoll_id) else {
                    return -EBADF;
                };
                let Some(inst) = self.vfs.epolls.get(&eid) else {
                    return -EBADF;
                };
                let mut count = 0usize;
                for (&fd, entry) in &inst.entries {
                    if count >= *maxevents {
                        break;
                    }
                    let ev = (entry.events & 0xffff) as i16;
                    let rev = self.eval_fd_events(&self.vfs.fds, fd, ev);
                    if rev != 0 && rev != POLLNVAL {
                        // Linux x86-64 struct epoll_event is 12 bytes packed: u32 events, u64 data
                        let mut buf = [0u8; 12];
                        buf[0..4].copy_from_slice(&(rev as u16 as u32).to_le_bytes());
                        buf[4..12].copy_from_slice(&entry.data.to_le_bytes());
                        if let Err(e) = write_bytes(ctx, *events_addr + (count as u64) * 12, &buf) {
                            return e;
                        }
                        count += 1;
                    }
                }
                count as i64
            }
        }
    }

    pub fn has_expired_timed_waiter(&self) -> bool {
        let now_ns = self.scheduler.virtual_mono_ns;
        if self.scheduler.min_wake_ns().map_or(false, |w| w <= now_ns) {
            return true;
        }
        self.processes.iter().any(|(&pid, p)| {
            pid != self.active_pid
                && !p.exited
                && p.scheduler.min_wake_ns().map_or(false, |w| w <= now_ns)
        })
    }

    pub fn wake_expired_timed_waiters(&mut self) {
        let now_ns = self.scheduler.virtual_mono_ns;
        self.scheduler.wake_timed_waiters(now_ns);
        let active_pid = self.active_pid;
        for (&pid, p) in self.processes.iter_mut() {
            if pid != active_pid && !p.exited {
                p.scheduler.wake_timed_waiters(now_ns);
            }
        }
    }

    /// Multi-process scheduler yield handler for `elf2wasm-runtime-wasm`.
    /// Returns:
    /// - `0`: all processes exited or deadlocked
    /// - `1`: continue current `active_pid`
    /// - `2`: switch active guest instance to `self.active_pid`
    /// - `3`: `NeedFork`
    /// - `4`: `NeedExec`
    pub fn on_yield_multiproc(
        &mut self,
        ctx: &mut dyn GuestContext,
        yield_flag: i32,
    ) -> Result<i32, i64> {
        if self.is_main_exited() {
            return Ok(0);
        }

        if let Some(ref action) = self.pending_action {
            match action {
                PendingHostAction::Fork { is_vfork, .. } => {
                    let is_vfork = *is_vfork;
                    let saved = ctx.save_ctx(self.scheduler.scratch_addr)?;
                    let cur_tid = self.scheduler.current_tid;
                    if let Some(cur) = self.scheduler.threads.get_mut(&cur_tid) {
                        cur.regs = saved;
                        if !is_vfork && cur.state == ThreadState::Runnable {
                            self.scheduler.run_queue.push_back(cur_tid);
                        }
                    }
                    return Ok(3);
                }
                PendingHostAction::Exec { .. } => {
                    return Ok(4);
                }
            }
        }

        let active_exited = self
            .processes
            .get(&self.active_pid)
            .map_or(false, |p| p.exited);

        if yield_flag == 2 && !active_exited {
            self.scheduler.virtual_mono_ns = self
                .scheduler
                .virtual_mono_ns
                .saturating_add(QUANTUM_TIME_STEP_NS);
            self.wake_expired_timed_waiters();
            let other_runnable = self.processes.iter().any(|(&pid, p)| {
                pid != self.active_pid
                    && !p.exited
                    && p.scheduler
                        .threads
                        .values()
                        .any(|t| t.state == ThreadState::Runnable)
            });
            if !other_runnable
                && self.scheduler.run_queue.is_empty()
                && self
                    .scheduler
                    .threads
                    .get(&self.scheduler.current_tid)
                    .map_or(false, |t| t.state == ThreadState::Runnable)
            {
                ctx.set_yield_flag(0);
                ctx.set_quantum(DEFAULT_QUANTUM);
                return Ok(1);
            }
        }

        let mut preempt_cur = (yield_flag == 2 || yield_flag == 3)
            && !active_exited
            && self
                .scheduler
                .threads
                .get(&self.scheduler.current_tid)
                .map_or(false, |t| t.state == ThreadState::Runnable);

        if !active_exited {
            let saved = ctx.save_ctx(self.scheduler.scratch_addr)?;
            let cur_tid = self.scheduler.current_tid;
            if let Some(cur) = self.scheduler.threads.get_mut(&cur_tid) {
                cur.regs = saved;
                if cur.state == ThreadState::Runnable && !preempt_cur {
                    self.scheduler.run_queue.push_back(cur_tid);
                }
            }
        }

        loop {
            self.wake_ready_waiters();
            self.wake_expired_timed_waiters();

            if !self
                .processes
                .get(&self.active_pid)
                .map_or(false, |p| p.exited)
            {
                if let Some(next_tid) = self.scheduler.pop_next_runnable() {
                    if preempt_cur {
                        self.scheduler.run_queue.push_back(self.scheduler.current_tid);
                        preempt_cur = false;
                    }
                    self.scheduler.current_tid = next_tid;
                    if !self.complete_pending_wakeup(ctx)? {
                        continue;
                    }
                    let regs = self.scheduler.threads.get(&next_tid).unwrap().regs;
                    ctx.load_ctx(self.scheduler.scratch_addr, &regs)?;
                    ctx.set_yield_flag(0);
                    ctx.set_quantum(DEFAULT_QUANTUM);
                    return Ok(1);
                }
            }

            // Look for runnable thread in another process (round-robin after active_pid)
            let pids: Vec<i32> = self.processes.keys().copied().collect();
            let start_idx = pids
                .iter()
                .position(|&p| p > self.active_pid)
                .unwrap_or(0);
            let mut chosen: Option<(i32, i32)> = None;
            for offset in 0..pids.len() {
                let pid = pids[(start_idx + offset) % pids.len()];
                if pid == self.active_pid {
                    continue;
                }
                if let Some(p) = self.processes.get_mut(&pid) {
                    if !p.exited {
                        if let Some(tid) = p.scheduler.pop_next_runnable() {
                            chosen = Some((pid, tid));
                            break;
                        }
                    }
                }
            }

            if let Some((next_pid, next_tid)) = chosen {
                if preempt_cur {
                    self.scheduler.run_queue.push_back(self.scheduler.current_tid);
                }
                self.switch_active_process(next_pid);
                self.scheduler.current_tid = next_tid;
                return Ok(2);
            }

            if preempt_cur {
                let cur_tid = self.scheduler.current_tid;
                if let Some(t) = self.scheduler.threads.get(&cur_tid) {
                    if t.state == ThreadState::Runnable {
                        let regs = t.regs;
                        ctx.load_ctx(self.scheduler.scratch_addr, &regs)?;
                        ctx.set_yield_flag(0);
                        ctx.set_quantum(DEFAULT_QUANTUM);
                        return Ok(1);
                    }
                }
                preempt_cur = false;
            }

            // Fast-forward virtual time to earliest timer across all non-exited processes
            let mut min_wake = if !self
                .processes
                .get(&self.active_pid)
                .map_or(false, |p| p.exited)
            {
                self.scheduler.min_wake_ns()
            } else {
                None
            };
            for (&pid, p) in &self.processes {
                if pid != self.active_pid && !p.exited {
                    if let Some(w) = p.scheduler.min_wake_ns() {
                        min_wake = Some(min_wake.map_or(w, |m| m.min(w)));
                    }
                }
            }

            let Some(target_ns) = min_wake else {
                // Check if any live process is blocked waiting for interactive stdin
                if self.has_stdin_waiter(self.active_pid) {
                    return Ok(5);
                }
                let other_stdin_pid = self
                    .processes
                    .keys()
                    .copied()
                    .find(|&pid| pid != self.active_pid && self.has_stdin_waiter(pid));
                if let Some(spid) = other_stdin_pid {
                    self.switch_active_process(spid);
                    return Ok(5);
                }
                return Ok(0);
            };
            let now_ns = self.scheduler.virtual_mono_ns.max(target_ns);
            self.scheduler.wake_timed_waiters(now_ns);
            let active_pid = self.active_pid;
            for (&pid, p) in self.processes.iter_mut() {
                if pid != active_pid && !p.exited {
                    p.scheduler.wake_timed_waiters(now_ns);
                }
            }
        }
    }

    pub fn fork_copy_ranges(&self, total_len: usize) -> Vec<(usize, usize)> {
        self.mmap_alloc.fork_copy_ranges(total_len)
    }

    pub fn ack_fork(&mut self, child_pid: i32) -> bool {
        match &self.pending_action {
            Some(PendingHostAction::Fork {
                child_pid: pending_child,
                ..
            }) if *pending_child == child_pid => {}
            _ => return false,
        }
        self.pending_action.take();
        self.switch_active_process(child_pid);
        true
    }

    pub fn resume_active(&mut self, ctx: &mut dyn GuestContext) -> Result<bool, i64> {
        if self
            .processes
            .get(&self.active_pid)
            .map_or(true, |p| p.exited)
        {
            ctx.set_yield_flag(1);
            return Ok(false);
        }
        let cur_tid = self.scheduler.current_tid;
        let cur_runnable = self
            .scheduler
            .threads
            .get(&cur_tid)
            .map_or(false, |t| t.state == ThreadState::Runnable);
        if !cur_runnable {
            if let Some(next_tid) = self.scheduler.pop_next_runnable() {
                self.scheduler.current_tid = next_tid;
            } else {
                ctx.set_yield_flag(1);
                return Ok(false);
            }
        }
        let active_tid = self.scheduler.current_tid;
        self.scheduler.run_queue.retain(|&id| id != active_tid);

        if !self.complete_pending_wakeup(ctx)? {
            ctx.set_yield_flag(1);
            return Ok(false);
        }
        let cur_tid = self.scheduler.current_tid;
        let Some(thread) = self.scheduler.threads.get(&cur_tid) else {
            ctx.set_yield_flag(1);
            return Ok(false);
        };
        if thread.state != ThreadState::Runnable {
            ctx.set_yield_flag(1);
            return Ok(false);
        }
        let regs = thread.regs;
        ctx.load_ctx(self.scheduler.scratch_addr, &regs)?;
        ctx.set_yield_flag(0);
        ctx.set_quantum(DEFAULT_QUANTUM);
        Ok(true)
    }

    pub fn complete_exec(
        &mut self,
        ctx: &mut dyn GuestContext,
        pid: i32,
        meta: &WasmMeta,
        args: &[String],
        env: &[String],
    ) -> Result<(), i64> {
        self.pending_action = None;
        if pid != self.active_pid {
            self.switch_active_process(pid);
        }
        self.vfs.set_so_files(&meta.so_files);
        if !meta.elf_path.is_empty() {
            self.vfs.elf_path = meta.elf_path.clone();
        }
        self.vfs.cmdline = args.to_vec();
        if let Some(p) = self.processes.get_mut(&pid) {
            // POSIX exec resets all caught signal handlers to SIG_DFL, preserving SIG_IGN (1)
            p.sig_handlers.retain(|_, &mut h| h == 1);
        }
        let mmap_alloc_end = meta.mmap_end.saturating_sub(4096);
        self.brk_start = meta.brk_start;
        self.brk_curr = meta.brk_start;
        self.mmap_start = meta.mmap_start;
        self.mmap_end = meta.mmap_end;
        self.mmap_alloc = MmapAllocator::new_with_bounds(meta.mmap_start, mmap_alloc_end);
        let mono = self.scheduler.virtual_mono_ns;
        let rt_base = self.scheduler.realtime_base_ns;
        self.scheduler = Scheduler::new_with_tid(pid, mono, rt_base);
        self.scheduler.scratch_addr = mmap_alloc_end;

        let rsp = setup_guest_stack_ctx_with_ids(ctx, meta, args, env, self.uid, self.gid)
            .map_err(|_| -ENOMEM)?;
        ctx.set_rsp(rsp as i64);
        ctx.set_rip(meta.entry_rip as i64);
        ctx.set_yield_flag(0);
        ctx.set_quantum(DEFAULT_QUANTUM);
        Ok(())
    }

    pub fn reset_for_new_run(&mut self) {
        let mono = self.scheduler.virtual_mono_ns;
        let rt_base = self.scheduler.realtime_base_ns;
        self.active_pid = MAIN_PID;
        self.next_pid = MAIN_PID + 1;
        self.next_tid = MAIN_PID + 1;
        self.pending_action = None;
        self.reaped_pids.clear();
        self.tty.fg_pgid = MAIN_PID;
        self.tty.canon_buf.clear();
        self.tty.termios = TtyState::new().termios;
        self.processes.clear();
        self.processes.insert(
            MAIN_PID,
            ProcessState::empty_slot(MAIN_PID, 1, MAIN_PID, MAIN_PID),
        );
        self.brk_start = BRK_START;
        self.brk_curr = BRK_START;
        self.mmap_start = MMAP_START;
        self.mmap_end = MMAP_END;
        self.mmap_alloc = MmapAllocator::new();
        self.scheduler = Scheduler::new_with_tid(MAIN_PID, mono, rt_base);
        self.vfs.reset_fds_and_stdio();
        self.vfs.stdin_eof = !(self.tty.enabled || self.stdin_open);
        self.vfs.current_pid = MAIN_PID;
        self.vfs.current_ppid = 1;
        self.vfs.current_pgid = MAIN_PID;
        self.vfs.uid = self.uid;
        self.vfs.gid = self.gid;
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

fn write_stat(
    ctx: &mut dyn GuestContext,
    addr: u64,
    st: &FileStat,
    uid: u32,
    gid: u32,
) -> Result<(), i64> {
    let mut buf = [0u8; 144];
    buf[0..8].copy_from_slice(&1u64.to_le_bytes()); // st_dev
    buf[8..16].copy_from_slice(&st.st_ino.to_le_bytes());
    buf[16..24].copy_from_slice(&st.st_nlink.to_le_bytes());
    buf[24..28].copy_from_slice(&st.st_mode.to_le_bytes());
    buf[28..32].copy_from_slice(&uid.to_le_bytes()); // st_uid
    buf[32..36].copy_from_slice(&gid.to_le_bytes()); // st_gid
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
    state.vfs.uptime_ns = state.scheduler.virtual_mono_ns;
    let ret = handle_syscall_inner(ctx, state, nr, a0, a1, a2, a3, a4, a5);
    if ctx.trace_enabled() {
        ctx.trace_log(&format!(
            "[syscall tid={}] nr={} (0x{:x}, 0x{:x}, 0x{:x}, 0x{:x}, 0x{:x}, 0x{:x}) -> {} (0x{:x})",
            state.scheduler.current_tid, nr, a0, a1, a2, a3, a4, a5, ret, ret
        ));
    }
    ret
}

fn read_into_guest(
    ctx: &mut dyn GuestContext,
    state: &mut HostState,
    fd: i32,
    buf_addr: u64,
    count: usize,
) -> i64 {
    if count > 0 {
        let mem_size = ctx.mem_len();
        if buf_addr == 0 || usize::try_from(buf_addr).map_or(true, |s| s >= mem_size) {
            return -EFAULT;
        }
    }
    if let Some(f) = state.vfs.get_fd(fd).cloned() {
        if let Some(pipe_id) = f.pipe_id {
            if f.writable && f.sock_write_pipe_id.is_none() {
                return -EBADF;
            }
            if count == 0 {
                return 0;
            }
            let (drained, writers) = match state.vfs.pipes.get_mut(&pipe_id) {
                Some(p) => {
                    let n = count.min(p.buf.len());
                    let mut d = Vec::with_capacity(n);
                    for _ in 0..n {
                        if let Some(b) = p.buf.pop_front() {
                            d.push(b);
                        }
                    }
                    (d, p.writers)
                }
                None => (Vec::new(), 0),
            };
            if !drained.is_empty() {
                if let Err(e) = write_bytes(ctx, buf_addr, &drained) {
                    return e;
                }
                state.wake_pipe_waiters(pipe_id);
                return drained.len() as i64;
            }
            if writers == 0 {
                return 0;
            }
            if f.nonblock {
                return -EAGAIN;
            }
            state.scheduler.current_thread_mut().state = ThreadState::PipeReadWait {
                pipe_id,
                buf_addr,
                count,
            };
            ctx.set_yield_flag(1);
            return 0;
        }
        if (f.is_std == Some(0) || f.dev == Some(VirtualDevice::Tty))
            && count > 0
            && !state.vfs.inherit_stdin
            && state.vfs.stdin_available() == 0
        {
            if state.vfs.stdin_eof {
                return 0;
            }
            if f.nonblock {
                return -EAGAIN;
            }
            state.scheduler.current_thread_mut().state = ThreadState::StdinReadWait {
                buf_addr,
                count,
            };
            ctx.set_yield_flag(1);
            return 0;
        }
    }
    let is_eventfd = state
        .vfs
        .get_fd(fd)
        .map_or(false, |f| f.eventfd_id.is_some());
    match state.vfs.read_no_advance(fd, count) {
        Ok((bytes, host_consumed)) => {
            let n = bytes.len();
            if let Err(e) = write_bytes(ctx, buf_addr, &bytes) {
                return e;
            }
            if !host_consumed {
                state.vfs.advance_read_cursor(fd, n);
            }
            if is_eventfd {
                state.wake_ready_waiters();
            }
            n as i64
        }
        Err(e) => e,
    }
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
        SYS_READ => read_into_guest(ctx, state, a0 as i32, a1 as u64, a2 as usize),
        SYS_READV => {
            let fd = a0 as i32;
            let iov_addr = a1 as u64;
            let iovcnt = a2 as i32;
            if iovcnt < 0 || iovcnt > 1024 {
                return -EINVAL;
            }
            if state.vfs.get_fd(fd).is_none() {
                return -EBADF;
            }
            let mut iovs: Vec<(u64, usize)> = Vec::with_capacity(iovcnt as usize);
            let mut total_req: usize = 0;
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
                    Err(_) => return -EINVAL,
                };
                if len > 0 {
                    total_req = total_req.saturating_add(len);
                    iovs.push((base, len));
                }
            }
            if total_req == 0 {
                return 0;
            }
            // If only a single non-empty iovec, delegate directly so blocking pipes/stdin work seamlessly
            if iovs.len() == 1 {
                return read_into_guest(ctx, state, fd, iovs[0].0, iovs[0].1);
            }
            let first = iovs[0];
            let mut total_read = 0usize;
            for (base, len) in iovs {
                if let Some(f) = state.vfs.get_fd(fd).cloned() {
                    if let Some(pipe_id) = f.pipe_id {
                        if f.writable && f.sock_write_pipe_id.is_none() {
                            return -EBADF;
                        }
                        let (drained, writers) = match state.vfs.pipes.get_mut(&pipe_id) {
                            Some(p) => {
                                let n = len.min(p.buf.len());
                                let mut d = Vec::with_capacity(n);
                                for _ in 0..n {
                                    if let Some(b) = p.buf.pop_front() {
                                        d.push(b);
                                    }
                                }
                                (d, p.writers)
                            }
                            None => (Vec::new(), 0),
                        };
                        if !drained.is_empty() {
                            if let Err(e) = write_bytes(ctx, base, &drained) {
                                return if total_read > 0 { total_read as i64 } else { e };
                            }
                            state.wake_pipe_waiters(pipe_id);
                            total_read += drained.len();
                            if drained.len() < len {
                                break;
                            }
                            continue;
                        }
                        if total_read > 0 || writers == 0 {
                            break;
                        }
                        if f.nonblock {
                            return -EAGAIN;
                        }
                        state.scheduler.current_thread_mut().state = ThreadState::PipeReadWait {
                            pipe_id,
                            buf_addr: first.0,
                            count: first.1,
                        };
                        ctx.set_yield_flag(1);
                        return 0;
                    }
                    if (f.is_std == Some(0) || f.dev == Some(VirtualDevice::Tty))
                        && !state.vfs.inherit_stdin
                        && state.vfs.stdin_available() == 0
                    {
                        if total_read > 0 || state.vfs.stdin_eof {
                            break;
                        }
                        if f.nonblock {
                            return -EAGAIN;
                        }
                        state.scheduler.current_thread_mut().state = ThreadState::StdinReadWait {
                            buf_addr: first.0,
                            count: first.1,
                        };
                        ctx.set_yield_flag(1);
                        return 0;
                    }
                }
                match state.vfs.read_no_advance(fd, len) {
                    Ok((bytes, host_consumed)) => {
                        if bytes.is_empty() {
                            break;
                        }
                        if let Err(e) = write_bytes(ctx, base, &bytes) {
                            return if total_read > 0 { total_read as i64 } else { e };
                        }
                        if !host_consumed {
                            state.vfs.advance_read_cursor(fd, bytes.len());
                        }
                        total_read += bytes.len();
                        if bytes.len() < len {
                            break;
                        }
                    }
                    Err(e) => {
                        return if total_read > 0 { total_read as i64 } else { e };
                    }
                }
            }
            total_read as i64
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
            write_fd_data(ctx, state, fd, bytes, now_ns)
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
            let is_pipe = state
                .vfs
                .get_fd(fd)
                .map_or(false, |f| f.pipe_id.is_some());
            if is_pipe {
                let mut combined = Vec::new();
                for i in 0..(iovcnt as u64) {
                    let entry_addr =
                        match i.checked_mul(16).and_then(|off| iov_addr.checked_add(off)) {
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
                    combined.extend_from_slice(&bytes);
                }
                return write_fd_data(ctx, state, fd, combined, now_ns);
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
        SYS_OPEN | SYS_OPENAT => {
            let (dirfd, path_ptr, flags, mode) = if nr == SYS_OPENAT {
                (a0 as i32, a1 as u64, a2 as i32, a3 as u32)
            } else {
                (AT_FDCWD, a0 as u64, a1 as i32, a2 as u32)
            };
            let path = match read_cstr(ctx, path_ptr) {
                Ok(p) => p,
                Err(e) => return e,
            };
            state.vfs.openat_with_mode(dirfd, &path, flags, mode, now_ns)
        }
        SYS_CLOSE => {
            let fd = a0 as i32;
            let (pipe_id, sock_wpid) = state
                .vfs
                .get_fd(fd)
                .map_or((None, None), |f| (f.pipe_id, f.sock_write_pipe_id));
            let ret = state.vfs.close(fd);
            if ret == 0 {
                if let Some(pid) = pipe_id {
                    state.wake_pipe_waiters(pid);
                }
                if let Some(wpid) = sock_wpid {
                    state.wake_pipe_waiters(wpid);
                }
            }
            ret
        }
        SYS_LSEEK => state.vfs.lseek(a0 as i32, a1, a2 as i32),
        SYS_FSTAT => {
            let st = match state.vfs.stat_fd(a0 as i32) {
                Ok(s) => s,
                Err(e) => return e,
            };
            match write_stat(ctx, a1 as u64, &st, state.uid, state.gid) {
                Ok(()) => 0,
                Err(e) => e,
            }
        }
        SYS_STAT | SYS_LSTAT | SYS_NEWFSTATAT => {
            let (dirfd, path_ptr, stat_ptr, flags) = if nr == SYS_NEWFSTATAT {
                (a0 as i32, a1 as u64, a2 as u64, a3 as i32)
            } else {
                let flags = if nr == SYS_LSTAT { 0x100 } else { 0 };
                (AT_FDCWD, a0 as u64, a1 as u64, flags)
            };
            let path = match read_cstr(ctx, path_ptr) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let st = match state.vfs.stat_path(dirfd, &path, flags) {
                Ok(s) => s,
                Err(e) => return e,
            };
            match write_stat(ctx, stat_ptr, &st, state.uid, state.gid) {
                Ok(()) => 0,
                Err(e) => e,
            }
        }
        SYS_ACCESS | SYS_FACCESSAT | SYS_FACCESSAT2 => {
            let (dirfd, path_ptr, mode) = if nr == SYS_ACCESS {
                (AT_FDCWD, a0 as u64, a1 as i32)
            } else {
                (a0 as i32, a1 as u64, a2 as i32)
            };
            let path = match read_cstr(ctx, path_ptr) {
                Ok(p) => p,
                Err(e) => return e,
            };
            state.vfs.access(dirfd, &path, mode)
        }
        SYS_MKDIR | SYS_MKDIRAT => {
            let (dirfd, path_ptr, mode) = if nr == SYS_MKDIRAT {
                (a0 as i32, a1 as u64, a2 as u32)
            } else {
                (AT_FDCWD, a0 as u64, a1 as u32)
            };
            let path = match read_cstr(ctx, path_ptr) {
                Ok(p) => p,
                Err(e) => return e,
            };
            state.vfs.mkdirat(dirfd, &path, mode, now_ns)
        }
        SYS_UNLINK | SYS_RMDIR | SYS_UNLINKAT => {
            let (dirfd, path_ptr, flags) = if nr == SYS_UNLINKAT {
                (a0 as i32, a1 as u64, a2 as i32)
            } else {
                let flags = if nr == SYS_RMDIR { AT_REMOVEDIR } else { 0 };
                (AT_FDCWD, a0 as u64, flags)
            };
            let path = match read_cstr(ctx, path_ptr) {
                Ok(p) => p,
                Err(e) => return e,
            };
            state.vfs.unlinkat(dirfd, &path, flags)
        }
        SYS_RENAME | SYS_RENAMEAT | SYS_RENAMEAT2 => {
            let (olddirfd, old_ptr, newdirfd, new_ptr) = if nr == SYS_RENAME {
                (AT_FDCWD, a0 as u64, AT_FDCWD, a1 as u64)
            } else {
                (a0 as i32, a1 as u64, a2 as i32, a3 as u64)
            };
            let oldpath = match read_cstr(ctx, old_ptr) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let newpath = match read_cstr(ctx, new_ptr) {
                Ok(p) => p,
                Err(e) => return e,
            };
            state.vfs.renameat(olddirfd, &oldpath, newdirfd, &newpath)
        }
        SYS_TRUNCATE => {
            let path = match read_cstr(ctx, a0 as u64) {
                Ok(p) => p,
                Err(e) => return e,
            };
            state.vfs.truncate_path(&path, a1, now_ns)
        }
        SYS_FTRUNCATE => state.vfs.ftruncate(a0 as i32, a1, now_ns),
        SYS_FCHMOD => state.vfs.fchmod(a0 as i32, a1 as u32),
        SYS_CHMOD | SYS_FCHMODAT => {
            let (dirfd, path_ptr, mode) = if nr == SYS_FCHMODAT {
                (a0 as i32, a1 as u64, a2 as u32)
            } else {
                (AT_FDCWD, a0 as u64, a1 as u32)
            };
            let path = match read_cstr(ctx, path_ptr) {
                Ok(p) => p,
                Err(e) => return e,
            };
            state.vfs.chmod_at(dirfd, &path, mode)
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
            if req == 0 || req < state.brk_start as u64 {
                return curr as i64;
            }
            if req >= state.mmap_start as u64 {
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
            let prot = a2 as i32;
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
                    .checked_add(aligned as usize)
                    .map_or(true, |end| end > mem_size)
                {
                    return Err(-ENOMEM);
                }
                Ok(fixed_addr)
            };

            if is_anon {
                let (target, allocated, freshly_grown) = if is_fixed {
                    match validate_fixed(addr) {
                        Ok(t) => {
                            state.mmap_alloc.reserve_fixed(t, aligned);
                            (t, false, false)
                        }
                        Err(e) => return e,
                    }
                } else {
                    match state.mmap_alloc.alloc_with_grow(ctx, aligned) {
                        Some((t, freshly_grown)) => (t, true, freshly_grown),
                        None => return -ENOMEM,
                    }
                };
                let skip_zero = prot == PROT_NONE && !is_fixed && freshly_grown;
                if !skip_zero && ctx.mem_zero(target as u64, aligned as usize).is_err() {
                    if allocated {
                        state.mmap_alloc.free(target, aligned);
                    }
                    return -ENOMEM;
                }
                if prot == PROT_NONE {
                    state
                        .mmap_alloc
                        .add_prot_none_range(target, target.saturating_add(aligned));
                } else {
                    state
                        .mmap_alloc
                        .remove_prot_none_range(target, target.saturating_add(aligned));
                }
                return target as i64;
            }

            let (file_data, so_base, is_dir, is_std_or_pipe) = match state.vfs.get_fd(fd) {
                Some(f) => (
                    f.data.clone(),
                    f.so_base_addr,
                    f.is_dir,
                    f.is_std.is_some() || f.is_pipe || f.sock_write_pipe_id.is_some(),
                ),
                None => return -EBADF,
            };
            if is_dir || is_std_or_pipe {
                return -EACCES;
            }
            if (prot & PROT_EXEC) != 0 && so_base.is_none() {
                return -EACCES;
            }
            let Ok(offset) = usize::try_from(offset_u64) else {
                return -EINVAL;
            };

            let (target, allocated) = if is_fixed {
                match validate_fixed(addr) {
                    Ok(t) => {
                        state.mmap_alloc.reserve_fixed(t, aligned);
                        (t, false)
                    }
                    Err(e) => return e,
                }
            } else if let Some(base) = so_base {
                let Ok(off_u32) = u32::try_from(offset_u64) else {
                    return -EINVAL;
                };
                let Some(t) = base.checked_add(off_u32) else {
                    return -ENOMEM;
                };
                (t, false)
            } else {
                match state.mmap_alloc.alloc_with_grow(ctx, aligned) {
                    Some((t, _)) => (t, true),
                    None => return -ENOMEM,
                }
            };

            let zero_len = if so_base.is_none() {
                aligned as usize
            } else {
                len
            };
            if ctx.mem_zero(target as u64, zero_len).is_err() {
                if allocated {
                    state.mmap_alloc.free(target, aligned);
                }
                return -ENOMEM;
            }
            if offset < file_data.len() {
                let copy_len = len.min(file_data.len() - offset);
                if let Err(e) = write_bytes(ctx, target as u64, &file_data[offset..offset + copy_len]) {
                    if allocated {
                        state.mmap_alloc.free(target, aligned);
                    }
                    return e;
                }
            }
            state
                .mmap_alloc
                .remove_prot_none_range(target, target.saturating_add(aligned));
            target as i64
        }
        SYS_MPROTECT => {
            let addr_u64 = a0 as u64;
            let len_u64 = a1 as u64;
            let prot = a2 as i32;
            // Only subtract on prot != PROT_NONE; do NOT add on prot == PROT_NONE because
            // Linux preserves page contents across mprotect(PROT_NONE) -> mprotect(PROT_RW).
            if prot != PROT_NONE && len_u64 > 0 {
                if let (Ok(addr), Ok(len_u32)) = (u32::try_from(addr_u64), u32::try_from(len_u64)) {
                    let start = addr & !0xfff;
                    let end = align_up_4k(addr.saturating_add(len_u32)).unwrap_or(u32::MAX);
                    state.mmap_alloc.remove_prot_none_range(start, end);
                }
            }
            0
        }
        SYS_MUNMAP => {
            let addr_u64 = a0 as u64;
            let len_u64 = a1 as u64;
            if len_u64 == 0 {
                return -EINVAL;
            }
            let Ok(addr) = u32::try_from(addr_u64) else {
                return -EINVAL;
            };
            if (addr & 0xfff) != 0 {
                return -EINVAL;
            }
            let Ok(len_u32) = u32::try_from(len_u64) else {
                return -EINVAL;
            };
            let Some(aligned) = align_up_4k(len_u32).filter(|&v| v > 0) else {
                return -EINVAL;
            };
            state.mmap_alloc.free(addr, aligned);
            0
        }
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
            let Ok(old_size_u32) = u32::try_from(old_size_u64) else {
                return -EINVAL;
            };
            let old_size = old_size_u32 as usize;
            let Ok(new_size_u32) = u32::try_from(new_size_u64) else {
                return -ENOMEM;
            };
            let new_size = new_size_u32 as usize;
            let old_aligned = align_up_4k(old_size_u32).unwrap_or(0);
            let Some(new_aligned) = align_up_4k(new_size_u32).filter(|&v| v > 0) else {
                return -ENOMEM;
            };
            if new_size <= old_size {
                if old_aligned > new_aligned {
                    if let Some(tail_start) = old_addr.checked_add(new_aligned) {
                        state.mmap_alloc.free(tail_start, old_aligned - new_aligned);
                    }
                }
                return old_addr as i64;
            }
            if (flags & MREMAP_MAYMOVE) == 0 {
                return -ENOMEM;
            }
            let old_bytes = match read_bytes(ctx, old_addr as u64, old_size) {
                Ok(b) => b,
                Err(e) => return e,
            };
            let Some((target, _)) = state.mmap_alloc.alloc_with_grow(ctx, new_aligned) else {
                return -ENOMEM;
            };
            if ctx.mem_zero(target as u64, new_aligned as usize).is_err() {
                state.mmap_alloc.free(target, new_aligned);
                return -ENOMEM;
            }
            if let Err(e) = write_bytes(ctx, target as u64, &old_bytes) {
                state.mmap_alloc.free(target, new_aligned);
                return e;
            }
            state
                .mmap_alloc
                .remove_prot_none_range(target, target.saturating_add(new_aligned));
            if old_aligned > 0 {
                state.mmap_alloc.free(old_addr, old_aligned);
            }
            target as i64
        }
        SYS_MADVISE => {
            let addr = a0 as u64;
            let len = a1 as usize;
            let advice = a2 as i32;
            const MADV_DONTNEED: i32 = 4;
            if advice == MADV_DONTNEED && len > 0 {
                if let (Ok(start), Ok(len_u32)) = (u32::try_from(addr), u32::try_from(len)) {
                    if let Some(end) = start.checked_add(len_u32) {
                        if state.mmap_alloc.contains_range(start, end) {
                            let _ = ctx.mem_zero(addr, len);
                        }
                    }
                }
            }
            0
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
                    3 => (2u64 * 1024 * 1024, u64::MAX), // RLIMIT_STACK
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
                    3 => (2u64 * 1024 * 1024, u64::MAX), // RLIMIT_STACK
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
            let child_stack = a1 as u64;
            let ptid_ptr = a2 as u64;
            let ctid_ptr = a3 as u64;
            let newtls = a4 as u64;

            if (flags & CLONE_VM) != 0 && (flags & CLONE_VFORK) == 0 {
                let parent_regs = match ctx.save_ctx(state.scheduler.scratch_addr) {
                    Ok(r) => r,
                    Err(e) => return e,
                };

                let child_tid = state.alloc_tid();
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
            } else {
                let is_vfork = (flags & CLONE_VFORK) != 0;
                do_fork(ctx, state, is_vfork, flags, child_stack, ptid_ptr, ctid_ptr, newtls)
            }
        }
        SYS_FORK => do_fork(ctx, state, false, 0, 0, 0, 0, 0),
        SYS_VFORK => do_fork(ctx, state, true, 0, 0, 0, 0, 0),
        SYS_EXECVE => do_execve(ctx, state, AT_FDCWD, a0 as u64, a1 as u64, a2 as u64, 0),
        SYS_EXECVEAT => do_execve(ctx, state, a0 as i32, a1 as u64, a2 as u64, a3 as u64, a4 as i32),
        SYS_WAIT4 => {
            if !state.multiproc_enabled {
                return -ENOSYS;
            }
            let target_pid = a0 as i32;
            let wstatus_addr = a1 as u64;
            let options = a2 as i32;
            let rusage_addr = a3 as u64;
            let (has_child, zombie_pid) = state.find_wait_status(state.active_pid, target_pid);
            if !has_child {
                return -ECHILD;
            }
            if let Some(zpid) = zombie_pid {
                return match state.reap_child(ctx, zpid, wstatus_addr, rusage_addr) {
                    Ok(r) => r,
                    Err(e) => e,
                };
            }
            if (options & WNOHANG) != 0 {
                return 0;
            }
            state.scheduler.current_thread_mut().state = ThreadState::Wait4Wait {
                target_pid,
                wstatus_addr,
                options,
                rusage_addr,
                waitid_infop: None,
            };
            ctx.set_yield_flag(1);
            0
        }
        SYS_WAITID => {
            if !state.multiproc_enabled {
                return -ENOSYS;
            }
            let idtype = a0 as i32;
            let id = a1 as i32;
            let infop = a2 as u64;
            let options = a3 as i32;
            let rusage_addr = a4 as u64;
            let target_pid = match idtype {
                0 => -1,           // P_ALL
                1 => id.max(1),    // P_PID
                2 => -id.max(1),   // P_PGID
                _ => return -EINVAL,
            };
            let (has_child, zombie_pid) = state.find_wait_status(state.active_pid, target_pid);
            if !has_child {
                return -ECHILD;
            }
            if let Some(zpid) = zombie_pid {
                let exit_status = state
                    .processes
                    .get(&zpid)
                    .map(|c| c.exit_status)
                    .unwrap_or(0);
                let _ = state.reap_child(ctx, zpid, 0, rusage_addr);
                if infop != 0 {
                    let mut si = [0u8; 128];
                    si[0..4].copy_from_slice(&17i32.to_le_bytes()); // si_signo = SIGCHLD
                    si[8..12].copy_from_slice(&1i32.to_le_bytes()); // si_code = CLD_EXITED
                    si[16..20].copy_from_slice(&zpid.to_le_bytes()); // si_pid
                    si[20..24].copy_from_slice(&state.uid.to_le_bytes()); // si_uid
                    si[24..28].copy_from_slice(&((exit_status >> 8) & 0xff).to_le_bytes());
                    if let Err(e) = write_bytes(ctx, infop, &si) {
                        return e;
                    }
                }
                return 0;
            }
            if (options & WNOHANG) != 0 {
                if infop != 0 {
                    let _ = write_bytes(ctx, infop, &[0u8; 128]);
                }
                return 0;
            }
            state.scheduler.current_thread_mut().state = ThreadState::Wait4Wait {
                target_pid,
                wstatus_addr: 0,
                options,
                rusage_addr,
                waitid_infop: Some(infop),
            };
            ctx.set_yield_flag(1);
            0
        }
        SYS_POLL => do_poll(ctx, state, a0 as u64, a1 as usize, a2 as i32 as i64),
        SYS_PPOLL => {
            let timeout_ms = if a2 == 0 {
                -1i64
            } else {
                match read_timespec(ctx, a2 as u64) {
                    Ok((sec, nsec)) => {
                        let ms = sec.saturating_mul(1000).saturating_add(nsec / 1_000_000);
                        if ms == 0 && (sec > 0 || nsec > 0) {
                            1
                        } else {
                            ms
                        }
                    }
                    Err(e) => return e,
                }
            };
            do_poll(ctx, state, a0 as u64, a1 as usize, timeout_ms)
        }
        SYS_SELECT => {
            let nfds = a0 as i32;
            let readfds = a1 as u64;
            let writefds = a2 as u64;
            let exceptfds = a3 as u64;
            let timeout_ptr = a4 as u64;
            let timeout_ns = if timeout_ptr == 0 {
                None
            } else {
                let b = match read_bytes(ctx, timeout_ptr, 16) {
                    Ok(b) => b,
                    Err(e) => return e,
                };
                let sec = i64::from_le_bytes(b[0..8].try_into().unwrap());
                let usec = i64::from_le_bytes(b[8..16].try_into().unwrap());
                if sec < 0 || usec < 0 {
                    return -EINVAL;
                }
                Some(
                    (sec as u64)
                        .saturating_mul(1_000_000_000)
                        .saturating_add((usec as u64).saturating_mul(1_000)),
                )
            };
            do_select(ctx, state, nfds, readfds, writefds, exceptfds, timeout_ns)
        }
        SYS_PSELECT6 => {
            let nfds = a0 as i32;
            let readfds = a1 as u64;
            let writefds = a2 as u64;
            let exceptfds = a3 as u64;
            let timeout_ptr = a4 as u64;
            let timeout_ns = if timeout_ptr == 0 {
                None
            } else {
                match read_timespec(ctx, timeout_ptr) {
                    Ok((sec, nsec)) => Some(
                        (sec as u64)
                            .saturating_mul(1_000_000_000)
                            .saturating_add(nsec as u64),
                    ),
                    Err(e) => return e,
                }
            };
            do_select(ctx, state, nfds, readfds, writefds, exceptfds, timeout_ns)
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
        SYS_GETUID => state.uid as i64,
        SYS_GETEUID => state.euid as i64,
        SYS_GETGID => state.gid as i64,
        SYS_GETEGID => state.egid as i64,
        SYS_SETUID => {
            let new_uid = a0 as u32;
            if state.euid == 0 || new_uid == state.uid || new_uid == state.euid {
                state.uid = new_uid;
                state.euid = new_uid;
                state.vfs.uid = new_uid;
                0
            } else {
                -EPERM
            }
        }
        SYS_SETGID => {
            let new_gid = a0 as u32;
            if state.euid == 0 || new_gid == state.gid || new_gid == state.egid {
                state.gid = new_gid;
                state.egid = new_gid;
                state.vfs.gid = new_gid;
                0
            } else {
                -EPERM
            }
        }
        SYS_GETGROUPS => {
            let size = a0 as i32;
            let list_addr = a1 as u64;
            if size < 0 {
                return -EINVAL;
            }
            if size == 0 {
                return state.groups.len() as i64;
            }
            if (size as usize) < state.groups.len() {
                return -EINVAL;
            }
            let mut buf = Vec::with_capacity(state.groups.len() * 4);
            for &g in &state.groups {
                buf.extend_from_slice(&g.to_le_bytes());
            }
            if let Err(e) = write_bytes(ctx, list_addr, &buf) {
                return e;
            }
            state.groups.len() as i64
        }
        SYS_SETGROUPS => {
            let size = a0 as usize;
            let list_addr = a1 as u64;
            if size > 65536 {
                return -EINVAL;
            }
            let mut new_groups = Vec::with_capacity(size);
            if size > 0 {
                let raw = match read_bytes(ctx, list_addr, size * 4) {
                    Ok(b) => b,
                    Err(e) => return e,
                };
                for chunk in raw.chunks_exact(4) {
                    new_groups.push(u32::from_le_bytes(chunk.try_into().unwrap()));
                }
            }
            state.groups = new_groups;
            0
        }
        SYS_SETSID => {
            let pid = state.active_pid;
            if let Some(p) = state.processes.get_mut(&pid) {
                p.pgid = pid;
                p.sid = pid;
            }
            state.vfs.current_pgid = pid;
            pid as i64
        }
        SYS_GETSID => {
            let pid = a0 as i32;
            let target = if pid == 0 { state.active_pid } else { pid };
            state
                .processes
                .get(&target)
                .map_or(-ESRCH, |p| p.sid as i64)
        }
        SYS_UMASK => {
            let old = state.vfs.umask;
            state.vfs.umask = (a0 as u32) & 0o777;
            old as i64
        }
        SYS_FSYNC | SYS_FDATASYNC => {
            if state.vfs.get_fd(a0 as i32).is_some() {
                0
            } else {
                -EBADF
            }
        }
        SYS_LINK => {
            let oldpath = match read_cstr(ctx, a0 as u64) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let newpath = match read_cstr(ctx, a1 as u64) {
                Ok(p) => p,
                Err(e) => return e,
            };
            state
                .vfs
                .linkat(AT_FDCWD, &oldpath, AT_FDCWD, &newpath, 0, now_ns)
        }
        SYS_LINKAT => {
            let oldpath = match read_cstr(ctx, a1 as u64) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let newpath = match read_cstr(ctx, a3 as u64) {
                Ok(p) => p,
                Err(e) => return e,
            };
            state
                .vfs
                .linkat(a0 as i32, &oldpath, a2 as i32, &newpath, a4 as i32, now_ns)
        }
        SYS_CHOWN | SYS_LCHOWN => {
            let path = match read_cstr(ctx, a0 as u64) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let flags = if nr == SYS_LCHOWN {
                AT_SYMLINK_NOFOLLOW
            } else {
                0
            };
            match state.vfs.stat_path(AT_FDCWD, &path, flags) {
                Ok(_) => 0,
                Err(e) => e,
            }
        }
        SYS_FCHOWN => {
            if state.vfs.get_fd(a0 as i32).is_some() {
                0
            } else {
                -EBADF
            }
        }
        SYS_FCHOWNAT => {
            let path = match read_cstr(ctx, a1 as u64) {
                Ok(p) => p,
                Err(e) => return e,
            };
            match state.vfs.stat_path(a0 as i32, &path, a4 as i32) {
                Ok(_) => 0,
                Err(e) => e,
            }
        }
        SYS_STATFS | SYS_FSTATFS => {
            let buf_addr = a1 as u64;
            if nr == SYS_STATFS {
                let path = match read_cstr(ctx, a0 as u64) {
                    Ok(p) => p,
                    Err(e) => return e,
                };
                if let Err(e) = state.vfs.stat_path(AT_FDCWD, &path, 0) {
                    return e;
                }
            } else if state.vfs.get_fd(a0 as i32).is_none() {
                return -EBADF;
            }
            let mut buf = [0u8; 120];
            buf[0..8].copy_from_slice(&0x0102_1994i64.to_le_bytes()); // TMPFS_MAGIC
            buf[8..16].copy_from_slice(&4096i64.to_le_bytes()); // f_bsize
            buf[16..24].copy_from_slice(&65536u64.to_le_bytes()); // f_blocks
            buf[24..32].copy_from_slice(&32768u64.to_le_bytes()); // f_bfree
            buf[32..40].copy_from_slice(&32768u64.to_le_bytes()); // f_bavail
            buf[40..48].copy_from_slice(&65536u64.to_le_bytes()); // f_files
            buf[48..56].copy_from_slice(&60000u64.to_le_bytes()); // f_ffree
            buf[64..72].copy_from_slice(&255i64.to_le_bytes()); // f_namelen
            buf[72..80].copy_from_slice(&4096i64.to_le_bytes()); // f_frsize
            match write_bytes(ctx, buf_addr, &buf) {
                Ok(()) => 0,
                Err(e) => e,
            }
        }
        SYS_TIMES => {
            let buf_addr = a0 as u64;
            let ticks = (state.scheduler.virtual_mono_ns / 10_000_000) as i64;
            if buf_addr != 0 {
                let mut buf = [0u8; 32];
                buf[0..8].copy_from_slice(&ticks.to_le_bytes());
                if let Err(e) = write_bytes(ctx, buf_addr, &buf) {
                    return e;
                }
            }
            ticks
        }
        SYS_GETRUSAGE => {
            let who = a0 as i32;
            let buf_addr = a1 as u64;
            if who != 0 && who != -1 && who != 1 {
                return -EINVAL;
            }
            let mut buf = [0u8; 144];
            let ns = state.scheduler.virtual_mono_ns;
            let sec = (ns / 1_000_000_000) as i64;
            let usec = ((ns % 1_000_000_000) / 1_000) as i64;
            buf[0..8].copy_from_slice(&sec.to_le_bytes());
            buf[8..16].copy_from_slice(&usec.to_le_bytes());
            buf[32..40].copy_from_slice(&4096i64.to_le_bytes()); // ru_maxrss
            match write_bytes(ctx, buf_addr, &buf) {
                Ok(()) => 0,
                Err(e) => e,
            }
        }
        SYS_SOCKET => -EAFNOSUPPORT,
        SYS_SOCKETPAIR => {
            let domain = a0 as i32;
            let sock_type = a1 as i32;
            let sv_addr = a3 as u64;
            if domain != 1 {
                return -EAFNOSUPPORT;
            }
            let base_type = sock_type & 0xff;
            if base_type != 1 && base_type != 2 && base_type != 5 {
                return -EINVAL;
            }
            if sv_addr == 0 {
                return -EFAULT;
            }
            let cloexec = (sock_type & O_CLOEXEC) != 0;
            let nonblock = (sock_type & O_NONBLOCK) != 0;
            let (fd0, fd1) = match state.vfs.create_socketpair(cloexec, nonblock) {
                Ok(fds) => fds,
                Err(e) => return e,
            };
            let mut buf = [0u8; 8];
            buf[0..4].copy_from_slice(&fd0.to_le_bytes());
            buf[4..8].copy_from_slice(&fd1.to_le_bytes());
            match write_bytes(ctx, sv_addr, &buf) {
                Ok(()) => 0,
                Err(e) => {
                    state.vfs.close(fd0);
                    state.vfs.close(fd1);
                    e
                }
            }
        }
        SYS_SENDTO => {
            let fd = a0 as i32;
            let buf_addr = a1 as u64;
            let count = a2 as usize;
            let dest_addr = a4 as u64;
            if dest_addr != 0 {
                return -EAFNOSUPPORT;
            }
            let bytes = match read_bytes(ctx, buf_addr, count) {
                Ok(b) => b,
                Err(e) => return e,
            };
            write_fd_data(ctx, state, fd, bytes, now_ns)
        }
        SYS_RECVFROM => {
            let fd = a0 as i32;
            let buf_addr = a1 as u64;
            let count = a2 as usize;
            read_into_guest(ctx, state, fd, buf_addr, count)
        }
        SYS_EVENTFD2 => {
            let initval = a0 as u32 as u64;
            let flags = a1 as i32;
            const EFD_SEMAPHORE: i32 = 1;
            if (flags & !(EFD_SEMAPHORE | O_CLOEXEC | O_NONBLOCK)) != 0 {
                return -EINVAL;
            }
            match state.vfs.create_eventfd(
                initval,
                (flags & EFD_SEMAPHORE) != 0,
                (flags & O_CLOEXEC) != 0,
                (flags & O_NONBLOCK) != 0,
            ) {
                Ok(fd) => fd as i64,
                Err(e) => e,
            }
        }
        SYS_EPOLL_CREATE1 => {
            let flags = a0 as i32;
            if (flags & !O_CLOEXEC) != 0 {
                return -EINVAL;
            }
            match state.vfs.create_epoll((flags & O_CLOEXEC) != 0) {
                Ok(fd) => fd as i64,
                Err(e) => e,
            }
        }
        SYS_EPOLL_CTL => {
            let epfd = a0 as i32;
            let op = a1 as i32;
            let fd = a2 as i32;
            let event_addr = a3 as u64;
            const EPOLL_CTL_ADD: i32 = 1;
            const EPOLL_CTL_DEL: i32 = 2;
            const EPOLL_CTL_MOD: i32 = 3;
            let Some(eid) = state.vfs.get_fd(epfd).and_then(|f| f.epoll_id) else {
                return if state.vfs.get_fd(epfd).is_some() {
                    -EINVAL
                } else {
                    -EBADF
                };
            };
            if fd == epfd {
                return -EINVAL;
            }
            let Some(target_f) = state.vfs.get_fd(fd) else {
                return -EBADF;
            };
            let supports_epoll = target_f.is_pipe
                || target_f.pipe_id.is_some()
                || target_f.sock_write_pipe_id.is_some()
                || target_f.eventfd_id.is_some()
                || target_f.epoll_id.is_some()
                || target_f.is_std.is_some()
                || target_f.dev == Some(VirtualDevice::Tty);
            if !supports_epoll {
                return -EPERM;
            }
            match op {
                EPOLL_CTL_DEL => {
                    let Some(inst) = state.vfs.epolls.get_mut(&eid) else {
                        return -EBADF;
                    };
                    if inst.entries.remove(&fd).is_some() {
                        0
                    } else {
                        -ENOENT
                    }
                }
                EPOLL_CTL_ADD | EPOLL_CTL_MOD => {
                    let raw = match read_bytes(ctx, event_addr, 12) {
                        Ok(b) => b,
                        Err(e) => return e,
                    };
                    let events = u32::from_le_bytes(raw[0..4].try_into().unwrap());
                    let data = u64::from_le_bytes(raw[4..12].try_into().unwrap());
                    let Some(inst) = state.vfs.epolls.get_mut(&eid) else {
                        return -EBADF;
                    };
                    if op == EPOLL_CTL_ADD {
                        if inst.entries.contains_key(&fd) {
                            return -crate::vfs::EEXIST;
                        }
                        inst.entries.insert(fd, EpollEntry { events, data });
                    } else if let Some(entry) = inst.entries.get_mut(&fd) {
                        entry.events = events;
                        entry.data = data;
                    } else {
                        return -ENOENT;
                    }
                    0
                }
                _ => -EINVAL,
            }
        }
        SYS_EPOLL_WAIT | SYS_EPOLL_PWAIT => {
            let epfd = a0 as i32;
            let events_addr = a1 as u64;
            let maxevents = a2 as i32;
            let timeout_ms = a3 as i32 as i64;
            if maxevents <= 0 || maxevents > 4096 {
                return -EINVAL;
            }
            let Some(f) = state.vfs.get_fd(epfd) else {
                return -EBADF;
            };
            if f.epoll_id.is_none() {
                return -EINVAL;
            }
            let kind = PollKind::Epoll {
                epfd,
                events_addr,
                maxevents: maxevents as usize,
            };
            if state.is_poll_kind_ready(state.active_pid, &kind) || timeout_ms == 0 {
                return state.finish_poll(ctx, &kind, false);
            }
            let wake_ns = if timeout_ms > 0 {
                Some(
                    state
                        .scheduler
                        .virtual_mono_ns
                        .saturating_add((timeout_ms as u64).saturating_mul(1_000_000)),
                )
            } else {
                None
            };
            state.scheduler.current_thread_mut().state = ThreadState::PollWait { kind, wake_ns };
            ctx.set_yield_flag(1);
            0
        }
        SYS_KILL => {
            let pid = a0 as i32;
            let sig = a1 as i32;
            if !(0..=64).contains(&sig) {
                return -EINVAL;
            }
            let cur_pgid = state.current_pgid();
            let targets: Vec<i32> = if pid > 0 {
                if state.processes.get(&pid).map_or(false, |p| !p.exited) {
                    vec![pid]
                } else {
                    Vec::new()
                }
            } else if pid == 0 {
                state
                    .processes
                    .values()
                    .filter(|p| !p.exited && p.pgid == cur_pgid)
                    .map(|p| p.pid)
                    .collect()
            } else if pid == -1 {
                state
                    .processes
                    .values()
                    .filter(|p| !p.exited && p.pid != 1)
                    .map(|p| p.pid)
                    .collect()
            } else {
                let target_pgid = -pid;
                state
                    .processes
                    .values()
                    .filter(|p| !p.exited && p.pgid == target_pgid)
                    .map(|p| p.pid)
                    .collect()
            };
            if targets.is_empty() {
                return -ESRCH;
            }
            if sig == 0 {
                return 0;
            }
            for tpid in targets {
                state.deliver_signal(Some(ctx), tpid, sig);
            }
            0
        }
        SYS_GETPID => state.active_pid as i64,
        SYS_GETPPID => state.current_ppid() as i64,
        SYS_GETPGRP => state.current_pgid() as i64,
        SYS_GETPGID => {
            let pid = a0 as i32;
            if pid == 0 {
                state.current_pgid() as i64
            } else {
                state
                    .processes
                    .get(&pid)
                    .map_or(-ESRCH, |p| p.pgid as i64)
            }
        }
        SYS_SETPGID => {
            let target = if a0 as i32 == 0 {
                state.active_pid
            } else {
                a0 as i32
            };
            let new_pgid = if a1 as i32 == 0 { target } else { a1 as i32 };
            if new_pgid < 0 {
                return -EINVAL;
            }
            if let Some(p) = state.processes.get_mut(&target) {
                p.pgid = new_pgid;
                0
            } else {
                -ESRCH
            }
        }
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
            let signum = a0 as i32;
            let act = a1 as u64;
            let oldact = a2 as u64;
            if !(1..=64).contains(&signum) {
                return -EINVAL;
            }
            let cur_pid = state.active_pid;
            let prev = state
                .processes
                .get(&cur_pid)
                .and_then(|p| p.sig_handlers.get(&signum).copied())
                .unwrap_or(0);
            if oldact != 0 {
                let mut buf = [0u8; 32];
                buf[0..8].copy_from_slice(&prev.to_le_bytes());
                if let Err(e) = write_bytes(ctx, oldact, &buf) {
                    return e;
                }
            }
            if act != 0 {
                if signum == 9 || signum == 19 {
                    return -EINVAL;
                }
                let handler = match read_u64(ctx, act) {
                    Ok(h) => h,
                    Err(e) => return e,
                };
                if let Some(p) = state.processes.get_mut(&cur_pid) {
                    p.sig_handlers.insert(signum, handler);
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
            const FD_CLOEXEC: i32 = 1;
            match cmd {
                F_DUPFD => state.vfs.dup_from(fd, arg, false),
                F_DUPFD_CLOEXEC => state.vfs.dup_from(fd, arg, true),
                F_GETFD => match state.vfs.get_fd(fd) {
                    Some(f) => if f.cloexec { FD_CLOEXEC as i64 } else { 0 },
                    None => -EBADF,
                },
                F_SETFD => match state.vfs.get_fd_mut(fd) {
                    Some(f) => {
                        f.cloexec = (arg & FD_CLOEXEC) != 0;
                        0
                    }
                    None => -EBADF,
                },
                F_GETFL => match state.vfs.get_fd(fd) {
                    Some(f) => {
                        let mut fl = if f.writable { 1 } else { 0 };
                        if f.append {
                            fl |= 0x400;
                        }
                        if f.nonblock {
                            fl |= O_NONBLOCK;
                        }
                        fl as i64
                    }
                    None => -EBADF,
                },
                F_SETFL => match state.vfs.get_fd_mut(fd) {
                    Some(f) => {
                        f.nonblock = (arg & O_NONBLOCK) != 0;
                        0
                    }
                    None => -EBADF,
                },
                _ => 0,
            }
        }
        SYS_IOCTL => {
            let fd = a0 as i32;
            let req = a1 as u32;
            let arg = a2 as u64;
            let Some(f) = state.vfs.get_fd(fd).cloned() else {
                return -EBADF;
            };
            let is_tty = state.tty.enabled
                && (f.is_std.is_some() || f.dev == Some(VirtualDevice::Tty));

            const TCGETS: u32 = 0x5401;
            const TCSETS: u32 = 0x5402;
            const TCSETSW: u32 = 0x5403;
            const TCSETSF: u32 = 0x5404;
            const TIOCSCTTY: u32 = 0x540E;
            const TIOCGPGRP: u32 = 0x540F;
            const TIOCSPGRP: u32 = 0x5410;
            const TIOCGWINSZ: u32 = 0x5413;
            const TIOCSWINSZ: u32 = 0x5414;
            const FIONREAD: u32 = 0x541B;
            const FIONBIO: u32 = 0x5421;
            const FIONCLEX: u32 = 0x5450;
            const FIOCLEX: u32 = 0x5451;

            match req {
                TCGETS => {
                    if !is_tty {
                        return -ENOTTY;
                    }
                    match write_bytes(ctx, arg, &state.tty.termios) {
                        Ok(()) => 0,
                        Err(e) => e,
                    }
                }
                TCSETS | TCSETSW | TCSETSF => {
                    if !is_tty {
                        return -ENOTTY;
                    }
                    let raw = match read_bytes(ctx, arg, 36) {
                        Ok(b) => b,
                        Err(e) => return e,
                    };
                    state.tty.termios.copy_from_slice(&raw);
                    if !state.tty.is_icanon() && !state.tty.canon_buf.is_empty() {
                        let pending = core::mem::take(&mut state.tty.canon_buf);
                        state.vfs.push_stdin(&pending);
                        state.wake_ready_waiters();
                    }
                    0
                }
                TIOCGWINSZ => {
                    if !is_tty {
                        return -ENOTTY;
                    }
                    let mut buf = [0u8; 8];
                    buf[0..2].copy_from_slice(&state.tty.rows.to_le_bytes());
                    buf[2..4].copy_from_slice(&state.tty.cols.to_le_bytes());
                    match write_bytes(ctx, arg, &buf) {
                        Ok(()) => 0,
                        Err(e) => e,
                    }
                }
                TIOCSWINSZ => {
                    if !is_tty {
                        return -ENOTTY;
                    }
                    let raw = match read_bytes(ctx, arg, 8) {
                        Ok(b) => b,
                        Err(e) => return e,
                    };
                    let rows = u16::from_le_bytes([raw[0], raw[1]]);
                    let cols = u16::from_le_bytes([raw[2], raw[3]]);
                    if rows > 0 {
                        state.tty.rows = rows;
                    }
                    if cols > 0 {
                        state.tty.cols = cols;
                    }
                    0
                }
                TIOCGPGRP => {
                    if !is_tty {
                        return -ENOTTY;
                    }
                    match write_bytes(ctx, arg, &state.tty.fg_pgid.to_le_bytes()) {
                        Ok(()) => 0,
                        Err(e) => e,
                    }
                }
                TIOCSPGRP => {
                    if !is_tty {
                        return -ENOTTY;
                    }
                    let pgid = match read_u32(ctx, arg) {
                        Ok(v) => v as i32,
                        Err(e) => return e,
                    };
                    if pgid <= 0 {
                        return -EINVAL;
                    }
                    state.tty.fg_pgid = pgid;
                    0
                }
                TIOCSCTTY => {
                    if !is_tty {
                        return -ENOTTY;
                    }
                    0
                }
                FIONREAD => {
                    let avail: i32 = if f.is_std == Some(0) || f.dev == Some(VirtualDevice::Tty) {
                        state.vfs.stdin_available().min(i32::MAX as usize) as i32
                    } else if let Some(pid) = f.pipe_id {
                        state
                            .vfs
                            .pipes
                            .get(&pid)
                            .map_or(0, |p| p.buf.len().min(i32::MAX as usize) as i32)
                    } else {
                        f.data
                            .len()
                            .saturating_sub(f.cursor)
                            .min(i32::MAX as usize) as i32
                    };
                    match write_bytes(ctx, arg, &avail.to_le_bytes()) {
                        Ok(()) => 0,
                        Err(e) => e,
                    }
                }
                FIOCLEX => {
                    if let Some(fm) = state.vfs.get_fd_mut(fd) {
                        fm.cloexec = true;
                    }
                    0
                }
                FIONCLEX => {
                    if let Some(fm) = state.vfs.get_fd_mut(fd) {
                        fm.cloexec = false;
                    }
                    0
                }
                FIONBIO => {
                    let val = match read_u32(ctx, arg) {
                        Ok(v) => v,
                        Err(e) => return e,
                    };
                    if let Some(fm) = state.vfs.get_fd_mut(fd) {
                        fm.nonblock = val != 0;
                    }
                    0
                }
                _ => -ENOTTY,
            }
        }
        SYS_DUP => state.vfs.dup(a0 as i32),
        SYS_DUP2 | SYS_DUP3 => {
            let oldfd = a0 as i32;
            let newfd = a1 as i32;
            let displaced_pipe = if oldfd != newfd {
                state.vfs.get_fd(newfd).and_then(|f| f.pipe_id)
            } else {
                None
            };
            let ret = if nr == SYS_DUP3 {
                state.vfs.dup3(oldfd, newfd, a2 as i32)
            } else {
                state.vfs.dup2(oldfd, newfd)
            };
            if ret >= 0 {
                if let Some(pid) = displaced_pipe {
                    state.wake_pipe_waiters(pid);
                }
            }
            ret
        }
        SYS_PIPE | SYS_PIPE2 => {
            let pipefd_addr = a0 as u64;
            let flags = if nr == SYS_PIPE2 { a1 as i32 } else { 0 };
            if pipefd_addr == 0 {
                return -EFAULT;
            }
            let (rfd, wfd) = match state.vfs.create_pipe_with_flags(flags) {
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
        SYS_SYMLINK | SYS_SYMLINKAT => {
            let (target_ptr, dirfd, link_ptr) = if nr == SYS_SYMLINKAT {
                (a0 as u64, a1 as i32, a2 as u64)
            } else {
                (a0 as u64, AT_FDCWD, a1 as u64)
            };
            let target = match read_cstr(ctx, target_ptr) {
                Ok(s) => s,
                Err(e) => return e,
            };
            let linkpath = match read_cstr(ctx, link_ptr) {
                Ok(s) => s,
                Err(e) => return e,
            };
            state.vfs.symlinkat(&target, dirfd, &linkpath, now_ns)
        }
        SYS_READLINK | SYS_READLINKAT => {
            let (dirfd, path_ptr, buf_addr, bufsiz_signed) = if nr == SYS_READLINKAT {
                (a0 as i32, a1 as u64, a2 as u64, a3 as isize)
            } else {
                (AT_FDCWD, a0 as u64, a1 as u64, a2 as isize)
            };
            let path = match read_cstr(ctx, path_ptr) {
                Ok(p) => p,
                Err(e) => return e,
            };
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
            let totalram = (ctx.mem_len() as u64).max(256 * 1024 * 1024);
            let freeram = totalram / 2;
            buf[0..8].copy_from_slice(&uptime.to_le_bytes());
            buf[32..40].copy_from_slice(&totalram.to_le_bytes()); // totalram
            buf[40..48].copy_from_slice(&freeram.to_le_bytes()); // freeram
            buf[80..82].copy_from_slice(&(state.scheduler.live_thread_count().max(1) as u16).to_le_bytes());
            buf[104..108].copy_from_slice(&1u32.to_le_bytes()); // mem_unit
            match write_bytes(ctx, info_addr, &buf) {
                Ok(()) => 0,
                Err(e) => e,
            }
        }
        SYS_CAPGET => {
            const LINUX_CAP_V1: u32 = 0x1998_0330;
            const LINUX_CAP_V2: u32 = 0x2007_1026;
            const LINUX_CAP_V3: u32 = 0x2008_0522;
            let hdr_addr = a0 as u64;
            let data_addr = a1 as u64;
            if hdr_addr == 0 {
                return -EFAULT;
            }
            let version = match read_u32(ctx, hdr_addr) {
                Ok(v) => v,
                Err(e) => return e,
            };
            match version {
                LINUX_CAP_V1 => {
                    if data_addr != 0 {
                        if let Err(e) = write_bytes(ctx, data_addr, &[0u8; 12]) {
                            return e;
                        }
                    }
                    0
                }
                LINUX_CAP_V2 | LINUX_CAP_V3 => {
                    if data_addr != 0 {
                        if let Err(e) = write_bytes(ctx, data_addr, &[0u8; 24]) {
                            return e;
                        }
                    }
                    0
                }
                _ => {
                    if let Err(e) = write_bytes(ctx, hdr_addr, &LINUX_CAP_V3.to_le_bytes()) {
                        return e;
                    }
                    if data_addr == 0 {
                        0
                    } else {
                        -EINVAL
                    }
                }
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
            buf[20..24].copy_from_slice(&state.uid.to_le_bytes()); // stx_uid
            buf[24..28].copy_from_slice(&state.gid.to_le_bytes()); // stx_gid
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
                exit_process(ctx, state, a0 as i32);
            } else {
                ctx.set_yield_flag(1);
            }
            0
        }
        SYS_EXIT_GROUP => {
            exit_process(ctx, state, a0 as i32);
            0
        }
        SYS_TGKILL | SYS_TKILL | SYS_PRCTL => 0,
        _ => -ENOSYS,
    }
}

fn exit_process(ctx: &mut dyn GuestContext, state: &mut HostState, code: i32) {
    let pid = state.active_pid;
    let pipe_ids: Vec<u64> = state
        .vfs
        .fds
        .values()
        .flat_map(|f| f.pipe_id.into_iter().chain(f.sock_write_pipe_id))
        .collect();
    state.vfs.close_all_fds();
    for pipe_id in pipe_ids {
        state.wake_pipe_waiters(pipe_id);
    }
    state.wake_vfork_parent_for(pid);
    if let Some(p) = state.processes.get_mut(&pid) {
        if !p.exited {
            p.exited = true;
            p.zombie = pid != MAIN_PID;
            p.exit_status = (code & 0xff) << 8;
            if pid != MAIN_PID {
                state.reaped_pids.push(pid);
            }
        }
    }
    if pid == MAIN_PID {
        ctx.set_exit(code);
    } else {
        ctx.set_yield_flag(1);
    }
}

fn write_fd_data(
    ctx: &mut dyn GuestContext,
    state: &mut HostState,
    fd: i32,
    bytes: Vec<u8>,
    now_ns: u64,
) -> i64 {
    if let Some(f) = state.vfs.get_fd(fd).cloned() {
        let write_pipe_id = f.sock_write_pipe_id.or(f.pipe_id);
        if let Some(pipe_id) = write_pipe_id {
            if !f.writable {
                return -EBADF;
            }
            if bytes.is_empty() {
                return 0;
            }
            let res = match state.vfs.pipes.get_mut(&pipe_id) {
                None => Err(-EPIPE),
                Some(p) if p.readers == 0 => Err(-EPIPE),
                Some(p) => {
                    let space = p.capacity.saturating_sub(p.buf.len());
                    if space > 0 {
                        let n = bytes.len().min(space);
                        p.buf.extend(&bytes[..n]);
                        Ok(Some(n))
                    } else {
                        Ok(None)
                    }
                }
            };
            return match res {
                Err(e) => e,
                Ok(Some(n)) => {
                    state.wake_pipe_waiters(pipe_id);
                    n as i64
                }
                Ok(None) => {
                    if f.nonblock {
                        return -EAGAIN;
                    }
                    state.scheduler.current_thread_mut().state = ThreadState::PipeWriteWait {
                        pipe_id,
                        data: bytes,
                        written: 0,
                    };
                    ctx.set_yield_flag(1);
                    0
                }
            };
        }
    }
    let is_eventfd = state
        .vfs
        .get_fd(fd)
        .map_or(false, |f| f.eventfd_id.is_some());
    let ret = state.vfs.write_with_time(fd, &bytes, now_ns);
    if is_eventfd && ret > 0 {
        state.wake_ready_waiters();
    }
    ret
}

fn do_fork(
    ctx: &mut dyn GuestContext,
    state: &mut HostState,
    is_vfork: bool,
    flags: u64,
    child_stack: u64,
    ptid_ptr: u64,
    ctid_ptr: u64,
    newtls: u64,
) -> i64 {
    if !state.multiproc_enabled {
        return -ENOSYS;
    }
    let parent_regs = match ctx.save_ctx(state.scheduler.scratch_addr) {
        Ok(r) => r,
        Err(e) => return e,
    };

    let parent_pid = state.active_pid;
    let parent_pgid = state.current_pgid();
    let parent_sid = state
        .processes
        .get(&parent_pid)
        .map(|p| p.sid)
        .unwrap_or(MAIN_PID);
    let parent_sig_handlers = state
        .processes
        .get(&parent_pid)
        .map(|p| p.sig_handlers.clone())
        .unwrap_or_default();
    let child_pid = state.alloc_pid();

    if (flags & CLONE_PARENT_SETTID) != 0 && ptid_ptr != 0 {
        if let Err(e) = write_bytes(ctx, ptid_ptr, &child_pid.to_le_bytes()) {
            return e;
        }
    }

    let cloned_fds = state.vfs.clone_fds_for_fork();
    let mut child_sched = Scheduler::new_with_tid(
        child_pid,
        state.scheduler.virtual_mono_ns,
        state.scheduler.realtime_base_ns,
    );
    child_sched.scratch_addr = state.scheduler.scratch_addr;
    {
        let child_thread = child_sched.threads.get_mut(&child_pid).unwrap();
        child_thread.regs = parent_regs;
        child_thread.set_rax(0);
        child_thread.set_rip(ctx.get_rcx());
        if child_stack != 0 {
            child_thread.set_rsp(child_stack as i64);
        }
        if (flags & CLONE_SETTLS) != 0 {
            child_thread.set_fsbase(newtls as i64);
        }
        if (flags & CLONE_CHILD_CLEARTID) != 0 {
            child_thread.clear_child_tid = ctid_ptr as u32;
        }
        if (flags & CLONE_CHILD_SETTID) != 0 && ctid_ptr != 0 {
            child_thread.pending_wakeup = Some(PendingWakeup::SetChildTid {
                addr: ctid_ptr,
                tid: child_pid,
            });
        }
    }

    let child_proc = ProcessState {
        pid: child_pid,
        ppid: parent_pid,
        pgid: parent_pgid,
        sid: parent_sid,
        umask: state.vfs.umask,
        fds: cloned_fds,
        next_fd: state.vfs.next_fd,
        cwd: state.vfs.cwd.clone(),
        elf_path: state.vfs.elf_path.clone(),
        so_entries: state.vfs.so_entries.clone(),
        brk_start: state.brk_start,
        brk_curr: state.brk_curr,
        mmap_start: state.mmap_start,
        mmap_end: state.mmap_end,
        mmap_alloc: state.mmap_alloc.clone(),
        scheduler: child_sched,
        sig_handlers: parent_sig_handlers,
        exited: false,
        zombie: false,
        exit_status: 0,
        vfork_parent: if is_vfork { Some(parent_pid) } else { None },
    };

    state.processes.insert(child_pid, child_proc);
    if is_vfork {
        state.scheduler.current_thread_mut().state = ThreadState::VforkWait { child_pid };
    }
    state.pending_action = Some(PendingHostAction::Fork {
        parent_pid,
        child_pid,
        is_vfork,
        scratch_addr: state.scheduler.scratch_addr,
    });
    ctx.set_yield_flag(1);
    child_pid as i64
}

fn read_cstr_array(ctx: &dyn GuestContext, arr_addr: u64) -> Result<Vec<String>, i64> {
    if arr_addr == 0 {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for i in 0..4096u64 {
        let ptr = read_u64(ctx, arr_addr + i * 8)?;
        if ptr == 0 {
            break;
        }
        out.push(read_cstr(ctx, ptr)?);
    }
    Ok(out)
}

pub fn is_valid_elf64_x86_64(bytes: &[u8]) -> bool {
    if bytes.len() < 64 {
        return false;
    }
    if &bytes[0..4] != b"\x7fELF" {
        return false;
    }
    // EI_CLASS=2 (ELFCLASS64), EI_DATA=1 (ELFDATA2LSB), EI_VERSION=1 (EV_CURRENT)
    if bytes[4] != 2 || bytes[5] != 1 || bytes[6] != 1 {
        return false;
    }
    let e_type = u16::from_le_bytes([bytes[16], bytes[17]]);
    let e_machine = u16::from_le_bytes([bytes[18], bytes[19]]);
    // ET_EXEC (2) or ET_DYN (3), EM_X86_64 (62)
    if (e_type != 2 && e_type != 3) || e_machine != 62 {
        return false;
    }
    let e_phoff = u64::from_le_bytes(bytes[32..40].try_into().unwrap());
    let e_phentsize = u16::from_le_bytes([bytes[54], bytes[55]]);
    let e_phnum = u16::from_le_bytes([bytes[56], bytes[57]]);
    if e_phentsize != 56 || e_phnum == 0 {
        return false;
    }
    let file_len = bytes.len() as u64;
    let ph_table_size = match (e_phnum as u64).checked_mul(56) {
        Some(sz) => sz,
        None => return false,
    };
    match e_phoff.checked_add(ph_table_size) {
        Some(end) if end <= file_len => {}
        _ => return false,
    }

    let mut has_exec_load = false;
    for i in 0..(e_phnum as usize) {
        let off = (e_phoff as usize) + i * 56;
        let p_type = u32::from_le_bytes(bytes[off..off + 4].try_into().unwrap());
        let p_flags = u32::from_le_bytes(bytes[off + 4..off + 8].try_into().unwrap());
        let p_offset = u64::from_le_bytes(bytes[off + 8..off + 16].try_into().unwrap());
        let p_filesz = u64::from_le_bytes(bytes[off + 32..off + 40].try_into().unwrap());
        let p_memsz = u64::from_le_bytes(bytes[off + 40..off + 48].try_into().unwrap());

        if p_type == 1 {
            // PT_LOAD
            if p_filesz > p_memsz {
                return false;
            }
            match p_offset.checked_add(p_filesz) {
                Some(end) if end <= file_len => {}
                _ => return false,
            }
            if (p_flags & 1) != 0 && p_filesz > 0 {
                has_exec_load = true;
            }
        } else if p_type == 3 {
            // PT_INTERP
            if p_filesz == 0 {
                return false;
            }
            match p_offset.checked_add(p_filesz) {
                Some(end) if end <= file_len => {}
                _ => return false,
            }
        }
    }
    has_exec_load
}

fn do_execve(
    ctx: &mut dyn GuestContext,
    state: &mut HostState,
    dirfd: i32,
    path_addr: u64,
    argv_addr: u64,
    envp_addr: u64,
    flags: i32,
) -> i64 {
    if !state.multiproc_enabled {
        return -ENOSYS;
    }
    let raw_path = match read_cstr(ctx, path_addr) {
        Ok(p) => p,
        Err(e) => return e,
    };
    const AT_EMPTY_PATH: i32 = 0x1000;
    let initial_norm_path = if raw_path.is_empty() && (flags & AT_EMPTY_PATH) != 0 {
        if dirfd == AT_FDCWD {
            return -ENOENT;
        } else if let Some(df) = state.vfs.get_fd(dirfd) {
            if df.is_dir {
                return -EACCES;
            }
            df.guest_path.clone()
        } else {
            return -EBADF;
        }
    } else {
        match state.vfs.resolve_path(dirfd, &raw_path, true) {
            Ok(p) => p,
            Err(e) => return e,
        }
    };

    let mut cur_argv = match read_cstr_array(ctx, argv_addr) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let envp = match read_cstr_array(ctx, envp_addr) {
        Ok(v) => v,
        Err(e) => return e,
    };

    // Resolve `#!` shebang chains and validate ELF magic BEFORE closing O_CLOEXEC FDs
    // or waking a vfork parent, so `-ENOEXEC` leaves process state untouched.
    let mut cur_path = initial_norm_path;
    for depth in 0..=4usize {
        match state.vfs.stat_path(AT_FDCWD, &cur_path, 0) {
            Ok(st) => {
                if (st.st_mode & S_IFDIR) != 0 {
                    return -EACCES;
                }
            }
            Err(e) => return e,
        }
        let Some(bytes) = state.vfs.vfs_read_file(&cur_path) else {
            return -ENOENT;
        };
        if bytes.starts_with(b"\x7fELF") {
            if is_valid_elf64_x86_64(&bytes) {
                break;
            }
            return -ENOEXEC;
        }
        if bytes.starts_with(b"#!") {
            if depth == 4 {
                return -ELOOP;
            }
            let cap = bytes.len().min(256);
            let first_line_end = bytes[..cap]
                .iter()
                .position(|&b| b == b'\n')
                .unwrap_or(cap);
            let line = String::from_utf8_lossy(&bytes[2..first_line_end]);
            let trimmed = line.trim_end_matches('\r').trim_matches(|c| c == ' ' || c == '\t');
            let (interp, rest) = match trimmed.find(|c| c == ' ' || c == '\t') {
                Some(idx) => (&trimmed[..idx], trimmed[idx..].trim_matches(|c| c == ' ' || c == '\t')),
                None => (trimmed, ""),
            };
            if interp.is_empty() {
                return -ENOEXEC;
            }
            let resolved_interp = match state.vfs.resolve_path(AT_FDCWD, interp, true) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let script_arg = if depth == 0 && !raw_path.is_empty() {
                raw_path.clone()
            } else {
                cur_path.clone()
            };
            let mut new_argv = Vec::with_capacity(cur_argv.len() + 2);
            new_argv.push(interp.to_string());
            if !rest.is_empty() {
                new_argv.push(rest.to_string());
            }
            new_argv.push(script_arg);
            if cur_argv.len() > 1 {
                new_argv.extend(cur_argv.into_iter().skip(1));
            }
            cur_argv = new_argv;
            cur_path = resolved_interp;
            continue;
        }
        return -ENOEXEC;
    }

    let closed_pipes: Vec<u64> = state
        .vfs
        .fds
        .values()
        .filter(|f| f.cloexec)
        .flat_map(|f| f.pipe_id.into_iter().chain(f.sock_write_pipe_id))
        .collect();
    state.vfs.close_cloexec_fds();
    for pipe_id in closed_pipes {
        state.wake_pipe_waiters(pipe_id);
    }

    let pid = state.active_pid;
    state.wake_vfork_parent_for(pid);
    state.pending_action = Some(PendingHostAction::Exec {
        pid,
        path: cur_path,
        argv: cur_argv,
        envp,
    });
    ctx.set_yield_flag(1);
    0
}

fn do_poll(
    ctx: &mut dyn GuestContext,
    state: &mut HostState,
    fds_addr: u64,
    nfds: usize,
    timeout_ms: i64,
) -> i64 {
    if nfds > 4096 {
        return -EINVAL;
    }
    let mut specs = Vec::with_capacity(nfds);
    for i in 0..nfds {
        let entry = match read_bytes(ctx, fds_addr + (i as u64) * 8, 8) {
            Ok(b) => b,
            Err(e) => return e,
        };
        let fd = i32::from_le_bytes(entry[0..4].try_into().unwrap());
        let events = i16::from_le_bytes(entry[4..6].try_into().unwrap());
        specs.push(PollFdSpec { fd, events });
    }
    let kind = PollKind::Poll {
        fds_addr,
        fds: specs,
    };
    if state.is_poll_kind_ready(state.active_pid, &kind) || timeout_ms == 0 {
        return state.finish_poll(ctx, &kind, false);
    }
    let wake_ns = if timeout_ms > 0 {
        Some(
            state
                .scheduler
                .virtual_mono_ns
                .saturating_add((timeout_ms as u64).saturating_mul(1_000_000)),
        )
    } else {
        None
    };
    state.scheduler.current_thread_mut().state = ThreadState::PollWait { kind, wake_ns };
    ctx.set_yield_flag(1);
    0
}

fn do_select(
    ctx: &mut dyn GuestContext,
    state: &mut HostState,
    nfds: i32,
    readfds_addr: u64,
    writefds_addr: u64,
    exceptfds_addr: u64,
    timeout_ns: Option<u64>,
) -> i64 {
    if nfds < 0 || nfds > 1024 {
        return -EINVAL;
    }
    let nbytes = ((nfds + 7) / 8) as usize;
    let orig_read_mask = if readfds_addr != 0 && nbytes > 0 {
        match read_bytes(ctx, readfds_addr, nbytes) {
            Ok(b) => b,
            Err(e) => return e,
        }
    } else {
        vec![0u8; nbytes]
    };
    let orig_write_mask = if writefds_addr != 0 && nbytes > 0 {
        match read_bytes(ctx, writefds_addr, nbytes) {
            Ok(b) => b,
            Err(e) => return e,
        }
    } else {
        vec![0u8; nbytes]
    };
    let kind = PollKind::Select {
        nfds,
        readfds_addr,
        writefds_addr,
        exceptfds_addr,
        orig_read_mask,
        orig_write_mask,
    };
    if state.is_poll_kind_ready(state.active_pid, &kind) || matches!(timeout_ns, Some(0)) {
        return state.finish_poll(ctx, &kind, false);
    }
    let wake_ns = timeout_ns.map(|d| state.scheduler.virtual_mono_ns.saturating_add(d));
    state.scheduler.current_thread_mut().state = ThreadState::PollWait { kind, wake_ns };
    ctx.set_yield_flag(1);
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use elf2wasm_core::lifter::CTX_SIZE;
    use std::collections::BTreeMap;

    const PROT_READ: i32 = 0x1;
    const PROT_WRITE: i32 = 0x2;
    const MAP_PRIVATE: i32 = 0x02;
    const MADV_DONTNEED: i32 = 4;

    /// Sparse page-backed mock GuestContext modeling Wasm32 linear memory up to 2 GiB
    /// without allocating gigabytes of host RAM during unit tests.
    struct MockGuestContext {
        mem_len: usize,
        max_len: usize,
        pages: BTreeMap<u64, Vec<u8>>,
        grow_calls: Vec<u32>,
        zero_calls: Vec<(u64, usize)>,
    }

    impl MockGuestContext {
        fn new(initial_bytes: usize, max_bytes: usize) -> Self {
            Self {
                mem_len: initial_bytes,
                max_len: max_bytes,
                pages: BTreeMap::new(),
                grow_calls: Vec::new(),
                zero_calls: Vec::new(),
            }
        }
    }

    impl GuestContext for MockGuestContext {
        fn mem_len(&self) -> usize {
            self.mem_len
        }

        fn mem_grow(&mut self, delta_pages: u32) -> Result<usize, i64> {
            let add_bytes = (delta_pages as usize)
                .checked_mul(65536)
                .ok_or(-ENOMEM)?;
            let new_len = self.mem_len.checked_add(add_bytes).ok_or(-ENOMEM)?;
            if new_len > self.max_len {
                return Err(-ENOMEM);
            }
            let prev = self.mem_len;
            self.mem_len = new_len;
            self.grow_calls.push(delta_pages);
            Ok(prev)
        }

        fn mem_read(&self, addr: u64, buf: &mut [u8]) -> Result<(), i64> {
            if buf.is_empty() {
                return Ok(());
            }
            let end = addr.checked_add(buf.len() as u64).ok_or(-EFAULT)?;
            if end as usize > self.mem_len {
                return Err(-EFAULT);
            }
            for (i, dst) in buf.iter_mut().enumerate() {
                let a = addr + i as u64;
                let page = a & !0xfff;
                let off = (a & 0xfff) as usize;
                *dst = self.pages.get(&page).map_or(0, |p| p[off]);
            }
            Ok(())
        }

        fn mem_write(&mut self, addr: u64, data: &[u8]) -> Result<(), i64> {
            if data.is_empty() {
                return Ok(());
            }
            let end = addr.checked_add(data.len() as u64).ok_or(-EFAULT)?;
            if end as usize > self.mem_len {
                return Err(-EFAULT);
            }
            for (i, &b) in data.iter().enumerate() {
                let a = addr + i as u64;
                let page = a & !0xfff;
                let off = (a & 0xfff) as usize;
                let entry = self.pages.entry(page).or_insert_with(|| vec![0u8; 4096]);
                entry[off] = b;
            }
            Ok(())
        }

        fn mem_zero(&mut self, addr: u64, len: usize) -> Result<(), i64> {
            if len == 0 {
                return Ok(());
            }
            let end = addr.checked_add(len as u64).ok_or(-ENOMEM)?;
            if end as usize > self.mem_len {
                return Err(-ENOMEM);
            }
            self.zero_calls.push((addr, len));
            // Zero only materialized pages overlapping [addr, end)
            let start_page = addr & !0xfff;
            let end_page = (end - 1) & !0xfff;
            let keys: Vec<u64> = self
                .pages
                .range(start_page..=end_page)
                .map(|(&k, _)| k)
                .collect();
            for page in keys {
                let p_start = page.max(addr);
                let p_end = (page + 4096).min(end);
                if p_start == page && p_end == page + 4096 {
                    self.pages.remove(&page);
                } else if let Some(buf) = self.pages.get_mut(&page) {
                    let s = (p_start - page) as usize;
                    let e = (p_end - page) as usize;
                    buf[s..e].fill(0);
                }
            }
            Ok(())
        }

        fn mem_read_cstr(&self, _addr: u64, _max_len: usize) -> Result<String, i64> {
            Err(-EFAULT)
        }

        fn get_fsbase(&self) -> i64 { 0 }
        fn set_fsbase(&mut self, _val: i64) {}
        fn get_gsbase(&self) -> i64 { 0 }
        fn set_gsbase(&mut self, _val: i64) {}
        fn get_rcx(&self) -> i64 { 0 }
        fn set_rip(&mut self, _val: i64) {}
        fn set_rsp(&mut self, _val: i64) {}
        fn get_rax(&self) -> i64 { 0 }
        fn set_rax(&mut self, _val: i64) {}
        fn get_rdi(&self) -> i64 { 0 }
        fn get_rsi(&self) -> i64 { 0 }
        fn get_rdx(&self) -> i64 { 0 }
        fn get_r10(&self) -> i64 { 0 }
        fn get_r8(&self) -> i64 { 0 }
        fn get_r9(&self) -> i64 { 0 }
        fn set_exit(&mut self, _code: i32) {}
        fn set_yield_flag(&mut self, _val: i32) {}
        fn set_quantum(&mut self, _val: i32) {}
        fn save_ctx(&mut self, _scratch_addr: u32) -> Result<[u8; CTX_SIZE], i64> {
            Ok([0u8; CTX_SIZE])
        }
        fn load_ctx(&mut self, _scratch_addr: u32, _buf: &[u8; CTX_SIZE]) -> Result<(), i64> {
            Ok(())
        }
    }

    fn make_state() -> HostState {
        HostState::new(VirtualFs::new_in_memory(&[]))
    }

    fn sys_mmap(
        ctx: &mut MockGuestContext,
        state: &mut HostState,
        addr: u64,
        len: u64,
        prot: i32,
        flags: i32,
    ) -> i64 {
        handle_syscall(
            ctx,
            state,
            SYS_MMAP,
            addr as i64,
            len as i64,
            prot as i64,
            flags as i64,
            -1,
            0,
        )
    }

    #[test]
    fn test_small_mmap_stays_in_primary_without_grow() {
        let mut ctx = MockGuestContext::new(256 * 1024 * 1024, 2 * 1024 * 1024 * 1024);
        let mut state = make_state();

        let p1 = sys_mmap(
            &mut ctx,
            &mut state,
            0,
            64 * 1024,
            PROT_READ | PROT_WRITE,
            MAP_PRIVATE | MAP_ANONYMOUS,
        );
        assert!(p1 >= MMAP_START as i64 && p1 < MMAP_ALLOC_END as i64);
        assert!(ctx.grow_calls.is_empty(), "small alloc must not call mem_grow");
        assert_eq!(ctx.mem_len(), 256 * 1024 * 1024);
    }

    #[test]
    fn test_go_pagealloc_prot_none_sequence_grows_without_zeroing_fresh_pages() {
        let initial = 256 * 1024 * 1024;
        let max_2gib = 2 * 1024 * 1024 * 1024;
        let mut ctx = MockGuestContext::new(initial, max_2gib);
        let mut state = make_state();

        // Go's exact pageAlloc.sysInit sequence: 128 KiB, 1 MiB, 8 MiB, 64 MiB, 512 MiB
        let sizes: [u64; 5] = [
            128 * 1024,
            1 * 1024 * 1024,
            8 * 1024 * 1024,
            64 * 1024 * 1024,
            512 * 1024 * 1024,
        ];
        let mut addrs = [0u64; 5];
        for (i, &sz) in sizes.iter().enumerate() {
            let r = sys_mmap(
                &mut ctx,
                &mut state,
                0,
                sz,
                PROT_NONE,
                MAP_PRIVATE | MAP_ANONYMOUS,
            );
            assert!(r > 0, "mmap level {} ({} bytes) failed: {}", i, sz, r);
            addrs[i] = r as u64;
        }

        // Levels 0..2 (9.125 MiB total) fit in primary [MMAP_START, MMAP_ALLOC_END)
        for i in 0..3 {
            assert!(addrs[i] >= MMAP_START as u64 && addrs[i] < MMAP_ALLOC_END as u64);
        }
        // Levels 3 (64 MiB) and 4 (512 MiB) grow into the high region >= 256 MiB
        assert_eq!(addrs[3], initial as u64);
        assert_eq!(addrs[4], (initial + 64 * 1024 * 1024) as u64);
        assert!(!ctx.grow_calls.is_empty());
        assert_eq!(ctx.mem_len(), initial + (64 + 512) * 1024 * 1024);

        // Freshly grown PROT_NONE high-region allocations MUST NOT invoke mem_zero
        assert!(
            !ctx.zero_calls
                .iter()
                .any(|&(a, _)| a >= initial as u64),
            "freshly grown PROT_NONE pages must skip mem_zero, got {:?}",
            ctx.zero_calls
        );

        // Simulate Go's pageAlloc.sysGrow MAP_FIXED commit at +256 MiB inside summary[4]
        let commit_addr = addrs[4] + 256 * 1024 * 1024;
        let commit_len = 4096u64;
        let r = sys_mmap(
            &mut ctx,
            &mut state,
            commit_addr,
            commit_len,
            PROT_READ | PROT_WRITE,
            MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED,
        );
        assert_eq!(r, commit_addr as i64);
        assert!(
            ctx.zero_calls.contains(&(commit_addr, commit_len as usize)),
            "MAP_FIXED commit must zero the committed slice"
        );

        // Verify read/write at the committed +256 MiB address
        let payload = [0xde, 0xad, 0xbe, 0xef, 0x42, 0x99, 0x11, 0x22];
        ctx.mem_write(commit_addr + 16, &payload).unwrap();
        let mut readback = [0u8; 8];
        ctx.mem_read(commit_addr + 16, &mut readback).unwrap();
        assert_eq!(readback, payload);
    }

    #[test]
    fn test_high_region_munmap_trim_coalesce_and_reuse_zeroes_memory() {
        let initial = 256 * 1024 * 1024;
        let max_2gib = 2 * 1024 * 1024 * 1024;
        let mut ctx = MockGuestContext::new(initial, max_2gib);
        let mut state = make_state();

        // Simulate Go's sysReserveAligned: reserve 128 MiB in high region, then trim head & tail
        // to keep a 64 MiB aligned slice in the middle.
        let size_128m = 128 * 1024 * 1024u64;
        let size_32m = 32 * 1024 * 1024u64;
        let size_64m = 64 * 1024 * 1024u64;

        let base = sys_mmap(
            &mut ctx,
            &mut state,
            0,
            size_128m,
            PROT_NONE,
            MAP_PRIVATE | MAP_ANONYMOUS,
        );
        assert_eq!(base, initial as i64);
        let base_u64 = base as u64;

        // Dirty a byte in the head (which will be trimmed and later reused)
        ctx.mem_write(base_u64 + 4096, &[0xaa, 0xbb]).unwrap();

        // Trim 32 MiB head -> goes into high_free_regions
        let rc_head = handle_syscall(
            &mut ctx,
            &mut state,
            SYS_MUNMAP,
            base_u64 as i64,
            size_32m as i64,
            0,
            0,
            0,
            0,
        );
        assert_eq!(rc_head, 0);

        // Trim 32 MiB tail -> rewinds high_cursor from +128M to +96M
        let rc_tail = handle_syscall(
            &mut ctx,
            &mut state,
            SYS_MUNMAP,
            (base_u64 + size_32m + size_64m) as i64,
            size_32m as i64,
            0,
            0,
            0,
            0,
        );
        assert_eq!(rc_tail, 0);
        assert_eq!(state.mmap_alloc.high_cursor, initial as u32 + (96 * 1024 * 1024));

        // Now free the middle 64 MiB too -> should coalesce with the 32 MiB head and rewind
        // high_cursor all the way back to high_start!
        let rc_mid = handle_syscall(
            &mut ctx,
            &mut state,
            SYS_MUNMAP,
            (base_u64 + size_32m) as i64,
            size_64m as i64,
            0,
            0,
            0,
            0,
        );
        assert_eq!(rc_mid, 0);
        assert_eq!(state.mmap_alloc.high_cursor, initial as u32);
        assert!(state.mmap_alloc.high_free_regions.is_empty());

        // Reallocate 64 MiB (even as PROT_NONE) -> must reuse base_u64 without growing,
        // AND must zero it because it was previously allocated (< high_clean_watermark).
        let grow_count_before = ctx.grow_calls.len();
        ctx.zero_calls.clear();
        let reused = sys_mmap(
            &mut ctx,
            &mut state,
            0,
            size_64m,
            PROT_NONE,
            MAP_PRIVATE | MAP_ANONYMOUS,
        );
        assert_eq!(reused, base_u64 as i64);
        assert_eq!(ctx.grow_calls.len(), grow_count_before, "reused slice must not grow");
        assert!(
            ctx.zero_calls.contains(&(base_u64, size_64m as usize)),
            "reused high-region memory must be zeroed"
        );
        let mut check = [0xffu8; 2];
        ctx.mem_read(base_u64 + 4096, &mut check).unwrap();
        assert_eq!(check, [0, 0]);
    }

    #[test]
    fn test_madvise_dontneed_zeroes_high_region_mapping() {
        let initial = 256 * 1024 * 1024;
        let max_2gib = 2 * 1024 * 1024 * 1024;
        let mut ctx = MockGuestContext::new(initial, max_2gib);
        let mut state = make_state();

        let size_64m = 64 * 1024 * 1024u64;
        let base = sys_mmap(
            &mut ctx,
            &mut state,
            0,
            size_64m,
            PROT_READ | PROT_WRITE,
            MAP_PRIVATE | MAP_ANONYMOUS,
        ) as u64;
        assert_eq!(base, initial as u64);

        let target = base + 8192;
        ctx.mem_write(target, &[0x12, 0x34, 0x56, 0x78]).unwrap();

        let rc = handle_syscall(
            &mut ctx,
            &mut state,
            SYS_MADVISE,
            target as i64,
            4096,
            MADV_DONTNEED as i64,
            0,
            0,
            0,
        );
        assert_eq!(rc, 0);

        let mut buf = [0xffu8; 4];
        ctx.mem_read(target, &mut buf).unwrap();
        assert_eq!(buf, [0, 0, 0, 0]);
    }

    #[test]
    fn test_high_region_enomem_when_exceeding_limit() {
        let initial = 256 * 1024 * 1024;
        let max_512m = 512 * 1024 * 1024;
        let mut ctx = MockGuestContext::new(initial, max_512m);
        let mut state = make_state();

        // Request 512 MiB when only 256 MiB of growth headroom exists -> -ENOMEM
        let r = sys_mmap(
            &mut ctx,
            &mut state,
            0,
            512 * 1024 * 1024,
            PROT_NONE,
            MAP_PRIVATE | MAP_ANONYMOUS,
        );
        assert_eq!(r, -ENOMEM);
    }

    #[test]
    fn test_prot_none_ranges_mmap_map_fixed_mprotect_munmap_and_complement() {
        let initial = 256 * 1024 * 1024;
        let max_2gib = 2 * 1024 * 1024 * 1024;
        let mut ctx = MockGuestContext::new(initial, max_2gib);
        let mut state = make_state();

        // 1. Two adjacent PROT_NONE mappings in high region coalesce into one range.
        let r1 = sys_mmap(
            &mut ctx,
            &mut state,
            0,
            64 * 1024 * 1024,
            PROT_NONE,
            MAP_PRIVATE | MAP_ANONYMOUS,
        ) as u32;
        let r2 = sys_mmap(
            &mut ctx,
            &mut state,
            0,
            64 * 1024 * 1024,
            PROT_NONE,
            MAP_PRIVATE | MAP_ANONYMOUS,
        ) as u32;
        assert_eq!(r1, initial as u32);
        assert_eq!(r2, r1 + 64 * 1024 * 1024);
        assert_eq!(
            state.mmap_alloc.prot_none_ranges,
            vec![(r1, r1 + 128 * 1024 * 1024)]
        );

        // 2. MAP_FIXED(PROT_READ|PROT_WRITE) in the middle splits the PROT_NONE range.
        let fixed_addr = r1 + 16 * 1024 * 1024;
        let fixed_res = sys_mmap(
            &mut ctx,
            &mut state,
            fixed_addr as u64,
            8192,
            PROT_READ | PROT_WRITE,
            MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED,
        );
        assert_eq!(fixed_res, fixed_addr as i64);
        assert_eq!(
            state.mmap_alloc.prot_none_ranges,
            vec![
                (r1, fixed_addr),
                (fixed_addr + 8192, r1 + 128 * 1024 * 1024),
            ]
        );

        // 3. mprotect(PROT_READ|PROT_WRITE) further splits the right-hand PROT_NONE range.
        let mprot_addr = r1 + 64 * 1024 * 1024;
        let rc = handle_syscall(
            &mut ctx,
            &mut state,
            SYS_MPROTECT,
            mprot_addr as i64,
            4096,
            (PROT_READ | PROT_WRITE) as i64,
            0,
            0,
            0,
        );
        assert_eq!(rc, 0);
        assert_eq!(
            state.mmap_alloc.prot_none_ranges,
            vec![
                (r1, fixed_addr),
                (fixed_addr + 8192, mprot_addr),
                (mprot_addr + 4096, r1 + 128 * 1024 * 1024),
            ]
        );

        // 4. mprotect(PROT_NONE) on a writable dirty slice must NOT re-add it to prot_none_ranges
        //    (Linux preserves page contents across mprotect(PROT_NONE) -> mprotect(PROT_RW)).
        ctx.mem_write(fixed_addr as u64, b"DIRTY").unwrap();
        let rc = handle_syscall(
            &mut ctx,
            &mut state,
            SYS_MPROTECT,
            fixed_addr as i64,
            8192,
            PROT_NONE as i64,
            0,
            0,
            0,
        );
        assert_eq!(rc, 0);
        assert_eq!(
            state.mmap_alloc.prot_none_ranges,
            vec![
                (r1, fixed_addr),
                (fixed_addr + 8192, mprot_addr),
                (mprot_addr + 4096, r1 + 128 * 1024 * 1024),
            ]
        );

        // Verify fork_copy_ranges includes [0, r1), [fixed_addr, fixed_addr+8192), [mprot_addr, mprot_addr+4096).
        let total = ctx.mem_len();
        assert_eq!(
            state.fork_copy_ranges(total),
            vec![
                (0, r1 as usize),
                (fixed_addr as usize, (fixed_addr + 8192) as usize),
                (mprot_addr as usize, (mprot_addr + 4096) as usize),
            ]
        );

        // 5. munmap removes the unmapped region from prot_none_ranges.
        let rc = handle_syscall(
            &mut ctx,
            &mut state,
            SYS_MUNMAP,
            (mprot_addr + 4096) as i64,
            (64 * 1024 * 1024 - 4096) as i64,
            0,
            0,
            0,
            0,
        );
        assert_eq!(rc, 0);
        assert_eq!(
            state.mmap_alloc.prot_none_ranges,
            vec![(r1, fixed_addr), (fixed_addr + 8192, mprot_addr)]
        );
    }

    #[test]
    fn test_go_style_512m_prot_none_with_256m_map_fixed_skips_512m_on_fork() {
        let initial = 256 * 1024 * 1024;
        let max_2gib = 2 * 1024 * 1024 * 1024;
        let mut ctx = MockGuestContext::new(initial, max_2gib);
        let mut state = make_state();

        let size_512m = 512 * 1024 * 1024u64;
        let base = sys_mmap(
            &mut ctx,
            &mut state,
            0,
            size_512m,
            PROT_NONE,
            MAP_PRIVATE | MAP_ANONYMOUS,
        ) as usize;
        assert_eq!(base, initial);
        assert_eq!(ctx.mem_len(), initial + size_512m as usize);

        // Commit 4 KiB at +256 MiB (Go arenaBaseOffset midpoint pattern).
        let midpoint = base + 256 * 1024 * 1024;
        let commit_res = sys_mmap(
            &mut ctx,
            &mut state,
            midpoint as u64,
            4096,
            PROT_READ | PROT_WRITE,
            MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED,
        );
        assert_eq!(commit_res, midpoint as i64);

        let ranges = state.fork_copy_ranges(ctx.mem_len());
        assert_eq!(ranges, vec![(0, base), (midpoint, midpoint + 4096)]);

        let total_copied: usize = ranges.iter().map(|(s, e)| e - s).sum();
        assert_eq!(total_copied, initial + 4096);
        let total_skipped = ctx.mem_len() - total_copied;
        assert_eq!(total_skipped, (512 * 1024 * 1024) - 4096);

        // Reset clears prot_none_ranges.
        state.reset_for_new_run();
        assert!(state.mmap_alloc.prot_none_ranges.is_empty());
        assert_eq!(state.fork_copy_ranges(initial), vec![(0, initial)]);
    }
}


