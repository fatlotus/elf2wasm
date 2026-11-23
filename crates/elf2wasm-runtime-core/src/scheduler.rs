use crate::context::GuestContext;
use crate::syscalls::MMAP_ALLOC_END;
use crate::vfs::ETIMEDOUT;
use elf2wasm_core::lifter::{CTX_SIZE, DEFAULT_QUANTUM};
use std::collections::{BTreeMap, VecDeque};

pub const MAIN_TID: i32 = 1000;
pub const MAIN_PID: i32 = 1000;
pub const INITIAL_REALTIME_BASE_NS: u64 = 1_700_000_000_000_000_000;
pub const SYSCALL_TIME_STEP_NS: u64 = 100;
pub const QUANTUM_TIME_STEP_NS: u64 = 1_000;

/// Byte offsets in the 464-byte `save_ctx`/`load_ctx` buffer (from `wasm_emit.rs`).
pub const CTX_OFF_RAX: usize = 0;
pub const CTX_OFF_RSP: usize = 32;
pub const CTX_OFF_RIP: usize = 128;
pub const CTX_OFF_FSBASE: usize = 136;
pub const CTX_OFF_GSBASE: usize = 144;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PollFdSpec {
    pub fd: i32,
    pub events: i16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PollKind {
    Poll {
        fds_addr: u64,
        fds: Vec<PollFdSpec>,
    },
    Select {
        nfds: i32,
        readfds_addr: u64,
        writefds_addr: u64,
        exceptfds_addr: u64,
        orig_read_mask: Vec<u8>,
        orig_write_mask: Vec<u8>,
    },
    Epoll {
        epfd: i32,
        events_addr: u64,
        maxevents: usize,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PendingWakeup {
    PipeRead {
        pipe_id: u64,
        buf_addr: u64,
        count: usize,
    },
    PipeWrite {
        pipe_id: u64,
        data: Vec<u8>,
        written: usize,
    },
    StdinRead {
        buf_addr: u64,
        count: usize,
    },
    Wait4 {
        target_pid: i32,
        wstatus_addr: u64,
        options: i32,
        rusage_addr: u64,
        waitid_infop: Option<u64>,
    },
    Poll {
        kind: PollKind,
        timed_out: bool,
    },
    SetChildTid {
        addr: u64,
        tid: i32,
    },
    Accept {
        listener_socket_id: u64,
        addr_ptr: u64,
        addrlen_ptr: u64,
        flags: i32,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ThreadState {
    Runnable,
    Sleeping {
        wake_ns: u64,
    },
    FutexWait {
        uaddr: u32,
        bitset: u32,
        wake_ns: Option<u64>,
    },
    PipeReadWait {
        pipe_id: u64,
        buf_addr: u64,
        count: usize,
    },
    PipeWriteWait {
        pipe_id: u64,
        data: Vec<u8>,
        written: usize,
    },
    StdinReadWait {
        buf_addr: u64,
        count: usize,
    },
    VforkWait {
        child_pid: i32,
    },
    Wait4Wait {
        target_pid: i32,
        wstatus_addr: u64,
        options: i32,
        rusage_addr: u64,
        waitid_infop: Option<u64>,
    },
    PollWait {
        kind: PollKind,
        wake_ns: Option<u64>,
    },
    AcceptWait {
        listener_socket_id: u64,
        addr_ptr: u64,
        addrlen_ptr: u64,
        flags: i32,
    },
    Exited,
}

#[derive(Debug, Clone)]
pub struct ThreadContext {
    pub tid: i32,
    pub state: ThreadState,
    pub regs: [u8; CTX_SIZE],
    pub clear_child_tid: u32,
    pub robust_list_head: u32,
    pub pending_wakeup: Option<PendingWakeup>,
}

impl ThreadContext {
    pub fn new(tid: i32) -> Self {
        Self {
            tid,
            state: ThreadState::Runnable,
            regs: [0u8; CTX_SIZE],
            clear_child_tid: 0,
            robust_list_head: 0,
            pending_wakeup: None,
        }
    }

    pub fn set_reg_i64(&mut self, offset: usize, val: i64) {
        self.regs[offset..offset + 8].copy_from_slice(&val.to_le_bytes());
    }

    pub fn get_reg_i64(&self, offset: usize) -> i64 {
        i64::from_le_bytes(self.regs[offset..offset + 8].try_into().unwrap())
    }

    pub fn set_rax(&mut self, val: i64) {
        self.set_reg_i64(CTX_OFF_RAX, val);
    }

    pub fn set_rsp(&mut self, val: i64) {
        self.set_reg_i64(CTX_OFF_RSP, val);
    }

    pub fn set_rip(&mut self, val: i64) {
        self.set_reg_i64(CTX_OFF_RIP, val);
    }

    pub fn set_fsbase(&mut self, val: i64) {
        self.set_reg_i64(CTX_OFF_FSBASE, val);
    }
}

pub struct Scheduler {
    pub threads: BTreeMap<i32, ThreadContext>,
    pub current_tid: i32,
    pub next_tid: i32,
    pub run_queue: VecDeque<i32>,
    pub virtual_mono_ns: u64,
    pub realtime_base_ns: u64,
    pub scratch_addr: u32,
}

impl Default for Scheduler {
    fn default() -> Self {
        Self::new()
    }
}

impl Scheduler {
    pub fn new() -> Self {
        Self::new_with_tid(MAIN_TID, 0, INITIAL_REALTIME_BASE_NS)
    }

    pub fn new_with_tid(tid: i32, virtual_mono_ns: u64, realtime_base_ns: u64) -> Self {
        let mut threads = BTreeMap::new();
        threads.insert(tid, ThreadContext::new(tid));
        Self {
            threads,
            current_tid: tid,
            next_tid: tid + 1,
            run_queue: VecDeque::new(),
            virtual_mono_ns,
            realtime_base_ns,
            scratch_addr: MMAP_ALLOC_END,
        }
    }

    pub fn pop_next_runnable(&mut self) -> Option<i32> {
        while let Some(tid) = self.run_queue.pop_front() {
            if self
                .threads
                .get(&tid)
                .map_or(false, |t| t.state == ThreadState::Runnable)
            {
                return Some(tid);
            }
        }
        None
    }

    pub fn min_wake_ns(&self) -> Option<u64> {
        self.threads
            .values()
            .filter_map(|t| match t.state {
                ThreadState::Sleeping { wake_ns } => Some(wake_ns),
                ThreadState::FutexWait {
                    wake_ns: Some(wake_ns),
                    ..
                } => Some(wake_ns),
                ThreadState::PollWait {
                    wake_ns: Some(wake_ns),
                    ..
                } => Some(wake_ns),
                _ => None,
            })
            .min()
    }

    pub fn wake_timed_waiters(&mut self, now_ns: u64) {
        self.virtual_mono_ns = now_ns;
        let tids: Vec<i32> = self.threads.keys().copied().collect();
        for tid in tids {
            if let Some(t) = self.threads.get_mut(&tid) {
                match t.state.clone() {
                    ThreadState::Sleeping { wake_ns } if wake_ns <= now_ns => {
                        t.state = ThreadState::Runnable;
                        t.set_rax(0);
                        self.run_queue.push_back(tid);
                    }
                    ThreadState::FutexWait {
                        wake_ns: Some(wake_ns),
                        ..
                    } if wake_ns <= now_ns => {
                        t.state = ThreadState::Runnable;
                        t.set_rax(-ETIMEDOUT);
                        self.run_queue.push_back(tid);
                    }
                    ThreadState::PollWait {
                        kind,
                        wake_ns: Some(wake_ns),
                    } if wake_ns <= now_ns => {
                        t.state = ThreadState::Runnable;
                        t.pending_wakeup = Some(PendingWakeup::Poll {
                            kind,
                            timed_out: true,
                        });
                        self.run_queue.push_back(tid);
                    }
                    _ => {}
                }
            }
        }
    }

    pub fn advance_syscall_time(&mut self) {
        self.virtual_mono_ns = self.virtual_mono_ns.saturating_add(SYSCALL_TIME_STEP_NS);
    }

    pub fn realtime_ns(&self) -> u64 {
        self.realtime_base_ns.saturating_add(self.virtual_mono_ns)
    }

    pub fn current_thread(&self) -> &ThreadContext {
        self.threads
            .get(&self.current_tid)
            .expect("current_tid missing from scheduler")
    }

    pub fn current_thread_mut(&mut self) -> &mut ThreadContext {
        self.threads
            .get_mut(&self.current_tid)
            .expect("current_tid missing from scheduler")
    }

    pub fn alloc_tid(&mut self) -> i32 {
        let tid = self.next_tid;
        self.next_tid += 1;
        tid
    }

    pub fn live_thread_count(&self) -> usize {
        self.threads
            .values()
            .filter(|t| t.state != ThreadState::Exited)
            .count()
    }

    pub fn futex_wake(&mut self, uaddr: u32, max_wake: usize, bitset: u32) -> usize {
        if max_wake == 0 || bitset == 0 {
            return 0;
        }
        let mut woken = 0usize;
        let tids: Vec<i32> = self.threads.keys().copied().collect();
        for tid in tids {
            if woken >= max_wake {
                break;
            }
            if let Some(t) = self.threads.get_mut(&tid) {
                if let ThreadState::FutexWait {
                    uaddr: w_addr,
                    bitset: w_bits,
                    ..
                } = t.state
                {
                    if w_addr == uaddr && (w_bits & bitset) != 0 {
                        t.state = ThreadState::Runnable;
                        t.set_rax(0);
                        self.run_queue.push_back(tid);
                        woken += 1;
                    }
                }
            }
        }
        woken
    }

    /// Handles a yield from `_start` (`yield_flag == 1` for syscall yield, `2` for quantum preemption).
    /// Returns `Ok(true)` to continue executing `_start`, or `Ok(false)` when all threads exited/deadlocked.
    pub fn on_yield(&mut self, ctx: &mut dyn GuestContext, yield_flag: i32) -> Result<bool, i64> {
        if yield_flag == 2 {
            self.virtual_mono_ns = self.virtual_mono_ns.saturating_add(QUANTUM_TIME_STEP_NS);
        }
        self.wake_timed_waiters(self.virtual_mono_ns);
        if yield_flag == 2
            && self.run_queue.is_empty()
            && self
                .threads
                .get(&self.current_tid)
                .map_or(false, |t| t.state == ThreadState::Runnable)
        {
            ctx.set_yield_flag(0);
            ctx.set_quantum(DEFAULT_QUANTUM);
            return Ok(true);
        }

        // Save current thread context
        let saved = ctx.save_ctx(self.scratch_addr)?;
        let cur_tid = self.current_tid;
        if let Some(cur) = self.threads.get_mut(&cur_tid) {
            cur.regs = saved;
            if cur.state == ThreadState::Runnable {
                self.run_queue.push_back(cur_tid);
            }
        }

        // Pick next runnable thread, fast-forwarding virtual time if needed
        let next_tid = loop {
            if let Some(tid) = self.run_queue.pop_front() {
                if self
                    .threads
                    .get(&tid)
                    .map_or(false, |t| t.state == ThreadState::Runnable)
                {
                    break tid;
                }
                continue;
            }

            let min_wake = self
                .threads
                .values()
                .filter_map(|t| match t.state {
                    ThreadState::Sleeping { wake_ns } => Some(wake_ns),
                    ThreadState::FutexWait {
                        wake_ns: Some(wake_ns),
                        ..
                    } => Some(wake_ns),
                    ThreadState::PollWait {
                        wake_ns: Some(wake_ns),
                        ..
                    } => Some(wake_ns),
                    _ => None,
                })
                .min();

            let Some(target_ns) = min_wake else {
                return Ok(false);
            };

            if target_ns > self.virtual_mono_ns {
                self.virtual_mono_ns = target_ns;
            }

            let tids: Vec<i32> = self.threads.keys().copied().collect();
            for tid in tids {
                if let Some(t) = self.threads.get_mut(&tid) {
                    match t.state.clone() {
                        ThreadState::Sleeping { wake_ns } if wake_ns <= self.virtual_mono_ns => {
                            t.state = ThreadState::Runnable;
                            t.set_rax(0);
                            self.run_queue.push_back(tid);
                        }
                        ThreadState::FutexWait {
                            wake_ns: Some(wake_ns),
                            ..
                        } if wake_ns <= self.virtual_mono_ns => {
                            t.state = ThreadState::Runnable;
                            t.set_rax(-ETIMEDOUT);
                            self.run_queue.push_back(tid);
                        }
                        ThreadState::PollWait {
                            kind,
                            wake_ns: Some(wake_ns),
                        } if wake_ns <= self.virtual_mono_ns => {
                            t.state = ThreadState::Runnable;
                            t.pending_wakeup = Some(PendingWakeup::Poll {
                                kind,
                                timed_out: true,
                            });
                            self.run_queue.push_back(tid);
                        }
                        _ => {}
                    }
                }
            }
        };

        if next_tid != cur_tid || yield_flag == 1 {
            let regs = self.threads.get(&next_tid).unwrap().regs;
            ctx.load_ctx(self.scratch_addr, &regs)?;
        }
        self.current_tid = next_tid;
        ctx.set_yield_flag(0);
        ctx.set_quantum(DEFAULT_QUANTUM);
        Ok(true)
    }
}
