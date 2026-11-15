use crate::context::GuestContext;
use crate::scheduler::{
    PendingWakeup, PollFdSpec, PollKind, Scheduler, ThreadContext, ThreadState, MAIN_PID,
    QUANTUM_TIME_STEP_NS,
};
use crate::stack::setup_guest_stack_ctx;
use crate::vfs::{
    normalize_guest_path, FileStat, OpenFile, SoEntry, VirtualFs, AT_FDCWD, AT_REMOVEDIR, EACCES,
    EAGAIN, EBADF, ECHILD, EFAULT, EINVAL, ENOENT, ENOMEM, ENOSYS, ENOTDIR, ENOTTY, EPIPE, ERANGE,
    ESRCH, ETIMEDOUT, O_NONBLOCK, S_IFDIR,
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
const SYS_WRITEV: i64 = 20;
const SYS_ACCESS: i64 = 21;
const SYS_PIPE: i64 = 22;
const SYS_SELECT: i64 = 23;
const SYS_SCHED_YIELD: i64 = 24;
const SYS_MREMAP: i64 = 25;
const SYS_DUP: i64 = 32;
const SYS_DUP2: i64 = 33;
const SYS_NANOSLEEP: i64 = 35;
const SYS_GETPID: i64 = 39;
const SYS_CLONE: i64 = 56;
const SYS_FORK: i64 = 57;
const SYS_VFORK: i64 = 58;
const SYS_EXECVE: i64 = 59;
const SYS_EXIT: i64 = 60;
const SYS_WAIT4: i64 = 61;
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
const SYS_SETPGID: i64 = 109;
const SYS_GETPPID: i64 = 110;
const SYS_GETPGRP: i64 = 111;
const SYS_GETPGID: i64 = 121;
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
const SYS_WAITID: i64 = 247;
const SYS_OPENAT: i64 = 257;
const SYS_MKDIRAT: i64 = 258;
const SYS_NEWFSTATAT: i64 = 262;
const SYS_UNLINKAT: i64 = 263;
const SYS_RENAMEAT: i64 = 264;
const SYS_READLINKAT: i64 = 267;
const SYS_FCHMODAT: i64 = 268;
const SYS_FACCESSAT: i64 = 269;
const SYS_PSELECT6: i64 = 270;
const SYS_PPOLL: i64 = 271;
const SYS_SET_ROBUST_LIST: i64 = 273;
const SYS_UTIMENSAT: i64 = 280;
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

const PROT_EXEC: i32 = 0x4;
const MAP_FIXED: i32 = 0x10;
const MAP_ANONYMOUS: i32 = 0x20;
const MAP_FIXED_NOREPLACE: i32 = 0x100000;
const MREMAP_MAYMOVE: i32 = 0x1;

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

pub struct ProcessState {
    pub pid: i32,
    pub ppid: i32,
    pub pgid: i32,
    pub fds: BTreeMap<i32, OpenFile>,
    pub next_fd: i32,
    pub cwd: String,
    pub elf_path: String,
    pub so_entries: Vec<SoEntry>,
    pub brk_curr: u32,
    pub mmap_cursor: u32,
    pub scheduler: Scheduler,
    pub exited: bool,
    pub zombie: bool,
    pub exit_status: i32,
    pub vfork_parent: Option<i32>,
}

impl ProcessState {
    fn empty_slot(pid: i32, ppid: i32, pgid: i32) -> Self {
        Self {
            pid,
            ppid,
            pgid,
            fds: BTreeMap::new(),
            next_fd: 3,
            cwd: String::new(),
            elf_path: String::new(),
            so_entries: Vec::new(),
            brk_curr: BRK_START,
            mmap_cursor: MMAP_START,
            scheduler: Scheduler::new_with_tid(pid, 0, 0),
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
    pub brk_curr: u32,
    pub mmap_cursor: u32,
    pub prng_state: u64,
    pub active_pid: i32,
    pub next_pid: i32,
    pub next_tid: i32,
    pub processes: BTreeMap<i32, ProcessState>,
    pub pending_action: Option<PendingHostAction>,
    pub multiproc_enabled: bool,
}

impl HostState {
    pub fn new(vfs: VirtualFs) -> Self {
        let mut processes = BTreeMap::new();
        processes.insert(MAIN_PID, ProcessState::empty_slot(MAIN_PID, 1, MAIN_PID));
        Self {
            vfs,
            scheduler: Scheduler::new(),
            brk_curr: BRK_START,
            mmap_cursor: MMAP_START,
            prng_state: 0x9e37_79b9_7f4a_7c15,
            active_pid: MAIN_PID,
            next_pid: MAIN_PID + 1,
            next_tid: MAIN_PID + 1,
            processes,
            pending_action: None,
            multiproc_enabled: false,
        }
    }

    pub fn alloc_pid(&mut self) -> i32 {
        let pid = self.next_pid;
        self.next_pid += 1;
        pid
    }

    pub fn alloc_tid(&mut self) -> i32 {
        let tid = self.next_tid;
        self.next_tid += 1;
        tid
    }

    fn next_rand_u64(&mut self) -> u64 {
        let mut x = self.prng_state;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.prng_state = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
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
            core::mem::swap(&mut self.vfs.cwd, &mut old_p.cwd);
            core::mem::swap(&mut self.vfs.elf_path, &mut old_p.elf_path);
            core::mem::swap(&mut self.vfs.so_entries, &mut old_p.so_entries);
            old_p.brk_curr = self.brk_curr;
            old_p.mmap_cursor = self.mmap_cursor;
            core::mem::swap(&mut self.scheduler, &mut old_p.scheduler);
        }
        if let Some(new_p) = self.processes.get_mut(&new_pid) {
            core::mem::swap(&mut self.vfs.fds, &mut new_p.fds);
            self.vfs.next_fd = new_p.next_fd;
            core::mem::swap(&mut self.vfs.cwd, &mut new_p.cwd);
            core::mem::swap(&mut self.vfs.elf_path, &mut new_p.elf_path);
            core::mem::swap(&mut self.vfs.so_entries, &mut new_p.so_entries);
            self.brk_curr = new_p.brk_curr;
            self.mmap_cursor = new_p.mmap_cursor;
            core::mem::swap(&mut self.scheduler, &mut new_p.scheduler);
            self.scheduler.virtual_mono_ns = mono;
            self.scheduler.realtime_base_ns = rt_base;
            self.active_pid = new_pid;
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
        if let Some(std_fd) = f.is_std {
            let mut revents = 0i16;
            if std_fd == 0 && (events & POLLIN) != 0 {
                if self.vfs.inherit_stdin || self.vfs.stdin_data.len() > self.vfs.stdin_cursor_val()
                {
                    revents |= POLLIN;
                } else {
                    revents |= POLLIN;
                }
            }
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
        }
    }

    fn wake_ready_waiters(&mut self) {
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
                        sched.run_queue.push_back(tid);
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
                                    si[20..24].copy_from_slice(&1000u32.to_le_bytes()); // si_uid
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

        if !active_exited {
            let saved = ctx.save_ctx(self.scheduler.scratch_addr)?;
            let cur_tid = self.scheduler.current_tid;
            if let Some(cur) = self.scheduler.threads.get_mut(&cur_tid) {
                cur.regs = saved;
                if cur.state == ThreadState::Runnable {
                    self.scheduler.run_queue.push_back(cur_tid);
                }
            }
        }

        loop {
            self.wake_ready_waiters();

            if !self
                .processes
                .get(&self.active_pid)
                .map_or(false, |p| p.exited)
            {
                if let Some(next_tid) = self.scheduler.pop_next_runnable() {
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
                self.switch_active_process(next_pid);
                self.scheduler.current_tid = next_tid;
                return Ok(2);
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
        if !self.complete_pending_wakeup(ctx)? {
            ctx.set_yield_flag(1);
            return Ok(false);
        }
        let cur_tid = self.scheduler.current_tid;
        let regs = self.scheduler.threads.get(&cur_tid).unwrap().regs;
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
        self.brk_curr = BRK_START;
        self.mmap_cursor = MMAP_START;
        let mono = self.scheduler.virtual_mono_ns;
        let rt_base = self.scheduler.realtime_base_ns;
        self.scheduler = Scheduler::new_with_tid(pid, mono, rt_base);

        let rsp = setup_guest_stack_ctx(ctx, meta, args, env).map_err(|_| -ENOMEM)?;
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
        self.processes.clear();
        self.processes
            .insert(MAIN_PID, ProcessState::empty_slot(MAIN_PID, 1, MAIN_PID));
        self.brk_curr = BRK_START;
        self.mmap_cursor = MMAP_START;
        self.scheduler = Scheduler::new_with_tid(MAIN_PID, mono, rt_base);
        self.vfs.reset_fds_and_stdio();
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
            if let Some(f) = state.vfs.get_fd(fd).cloned() {
                if let Some(pipe_id) = f.pipe_id {
                    if f.writable {
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
        SYS_CLOSE => {
            let fd = a0 as i32;
            let pipe_id = state.vfs.get_fd(fd).and_then(|f| f.pipe_id);
            let ret = state.vfs.close(fd);
            if ret == 0 {
                if let Some(pid) = pipe_id {
                    state.wake_pipe_waiters(pid);
                }
            }
            ret
        }
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
                    if next > MMAP_ALLOC_END {
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
            if (prot & PROT_EXEC) != 0 && so_base.is_none() {
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
                if next > MMAP_ALLOC_END {
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
            if next > MMAP_ALLOC_END {
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
                    si[20..24].copy_from_slice(&1000u32.to_le_bytes()); // si_uid
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
        SYS_GETUID | SYS_GETEUID | SYS_GETGID | SYS_GETEGID => 1000,
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
        SYS_IOCTL => -ENOTTY,
        SYS_DUP => state.vfs.dup(a0 as i32),
        SYS_DUP2 => {
            let oldfd = a0 as i32;
            let newfd = a1 as i32;
            let displaced_pipe = if oldfd != newfd {
                state.vfs.get_fd(newfd).and_then(|f| f.pipe_id)
            } else {
                None
            };
            let ret = state.vfs.dup2(oldfd, newfd);
            if ret >= 0 {
                if let Some(pid) = displaced_pipe {
                    state.wake_pipe_waiters(pid);
                }
            }
            ret
        }
        SYS_DUP3 => {
            let oldfd = a0 as i32;
            let newfd = a1 as i32;
            let flags = a2 as i32;
            let displaced_pipe = if oldfd != newfd {
                state.vfs.get_fd(newfd).and_then(|f| f.pipe_id)
            } else {
                None
            };
            let ret = state.vfs.dup3(oldfd, newfd, flags);
            if ret >= 0 {
                if let Some(pid) = displaced_pipe {
                    state.wake_pipe_waiters(pid);
                }
            }
            ret
        }
        SYS_PIPE => {
            let pipefd_addr = a0 as u64;
            if pipefd_addr == 0 {
                return -EFAULT;
            }
            let (rfd, wfd) = match state.vfs.create_pipe_with_flags(0) {
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
        SYS_PIPE2 => {
            let pipefd_addr = a0 as u64;
            let flags = a1 as i32;
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
        .filter_map(|f| f.pipe_id)
        .collect();
    state.vfs.close_all_fds();
    for pipe_id in pipe_ids {
        state.wake_pipe_waiters(pipe_id);
    }
    state.wake_vfork_parent_for(pid);
    if let Some(p) = state.processes.get_mut(&pid) {
        p.exited = true;
        p.zombie = pid != MAIN_PID;
        p.exit_status = (code & 0xff) << 8;
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
        if let Some(pipe_id) = f.pipe_id {
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
    state.vfs.write_with_time(fd, &bytes, now_ns)
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
        fds: cloned_fds,
        next_fd: state.vfs.next_fd,
        cwd: state.vfs.cwd.clone(),
        elf_path: state.vfs.elf_path.clone(),
        so_entries: state.vfs.so_entries.clone(),
        brk_curr: state.brk_curr,
        mmap_cursor: state.mmap_cursor,
        scheduler: child_sched,
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
    let norm_path = if raw_path.is_empty() && (flags & AT_EMPTY_PATH) != 0 {
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
    } else if raw_path.starts_with('/') {
        normalize_guest_path(&raw_path)
    } else if dirfd == AT_FDCWD {
        if state.vfs.cwd == "/" {
            normalize_guest_path(&format!("/{}", raw_path))
        } else {
            normalize_guest_path(&format!("{}/{}", state.vfs.cwd, raw_path))
        }
    } else if let Some(df) = state.vfs.get_fd(dirfd) {
        if !df.is_dir {
            return -ENOTDIR;
        }
        normalize_guest_path(&format!("{}/{}", df.guest_path, raw_path))
    } else {
        return -EBADF;
    };

    match state.vfs.stat_path(AT_FDCWD, &norm_path, 0) {
        Ok(st) => {
            if (st.st_mode & S_IFDIR) != 0 {
                return -EACCES;
            }
        }
        Err(e) => return e,
    }
    if state.vfs.vfs_read_file(&norm_path).is_none() {
        return -ENOENT;
    }

    let argv = match read_cstr_array(ctx, argv_addr) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let envp = match read_cstr_array(ctx, envp_addr) {
        Ok(v) => v,
        Err(e) => return e,
    };

    let closed_pipes: Vec<u64> = state
        .vfs
        .fds
        .values()
        .filter_map(|f| if f.cloexec { f.pipe_id } else { None })
        .collect();
    state.vfs.close_cloexec_fds();
    for pipe_id in closed_pipes {
        state.wake_pipe_waiters(pipe_id);
    }

    let pid = state.active_pid;
    state.wake_vfork_parent_for(pid);
    state.pending_action = Some(PendingHostAction::Exec {
        pid,
        path: norm_path,
        argv,
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
