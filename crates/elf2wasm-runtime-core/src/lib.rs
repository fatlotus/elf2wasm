pub mod context;
pub mod scheduler;
pub mod stack;
pub mod syscalls;
pub mod vfs;

#[cfg(test)]
mod tests {
    use crate::context::GuestContext;
    use crate::scheduler::{Scheduler, ThreadContext, ThreadState, MAIN_TID};
    use crate::syscalls::{handle_syscall, HostState};
    use crate::vfs::{
        VirtualFs, AT_FDCWD, AT_REMOVEDIR, EACCES, EAGAIN, EEXIST, ENOENT, ENOTEMPTY, ETIMEDOUT,
        O_APPEND, O_CREAT, O_EXCL, O_RDWR, O_WRONLY, S_IFDIR,
    };
    use elf2wasm_core::lifter::{CTX_SIZE, DEFAULT_QUANTUM};
    use elf2wasm_core::meta::MetaSoFile;

    struct MockCtx {
        mem: Vec<u8>,
        fsbase: i64,
        gsbase: i64,
        rcx: i64,
        rip: i64,
        rsp: i64,
        rax: i64,
        rdi: i64,
        rsi: i64,
        rdx: i64,
        r10: i64,
        r8: i64,
        r9: i64,
        exit_flag: i32,
        exit_code: i32,
        yield_flag: i32,
        quantum: i32,
    }

    impl MockCtx {
        fn new(mem_size: usize) -> Self {
            Self {
                mem: vec![0u8; mem_size],
                fsbase: 0,
                gsbase: 0,
                rcx: 0,
                rip: 0,
                rsp: 0,
                rax: 0,
                rdi: 0,
                rsi: 0,
                rdx: 0,
                r10: 0,
                r8: 0,
                r9: 0,
                exit_flag: 0,
                exit_code: 0,
                yield_flag: 0,
                quantum: DEFAULT_QUANTUM,
            }
        }
    }

    impl GuestContext for MockCtx {
        fn mem_len(&self) -> usize {
            self.mem.len()
        }
        fn mem_read(&self, addr: u64, buf: &mut [u8]) -> Result<(), i64> {
            let s = usize::try_from(addr).map_err(|_| -14i64)?;
            let e = s.checked_add(buf.len()).ok_or(-14i64)?;
            if e > self.mem.len() {
                return Err(-14);
            }
            buf.copy_from_slice(&self.mem[s..e]);
            Ok(())
        }
        fn mem_write(&mut self, addr: u64, data: &[u8]) -> Result<(), i64> {
            let s = usize::try_from(addr).map_err(|_| -14i64)?;
            let e = s.checked_add(data.len()).ok_or(-14i64)?;
            if e > self.mem.len() {
                return Err(-14);
            }
            self.mem[s..e].copy_from_slice(data);
            Ok(())
        }
        fn mem_zero(&mut self, addr: u64, len: usize) -> Result<(), i64> {
            let s = usize::try_from(addr).map_err(|_| -12i64)?;
            let e = s.checked_add(len).ok_or(-12i64)?;
            if e > self.mem.len() {
                return Err(-12);
            }
            self.mem[s..e].fill(0);
            Ok(())
        }
        fn mem_read_cstr(&self, addr: u64, max_len: usize) -> Result<String, i64> {
            let s = usize::try_from(addr).map_err(|_| -14i64)?;
            if s >= self.mem.len() {
                return Err(-14);
            }
            let end = (s + max_len).min(self.mem.len());
            let slice = &self.mem[s..end];
            let nul = slice.iter().position(|&b| b == 0).ok_or(-14i64)?;
            String::from_utf8(slice[..nul].to_vec()).map_err(|_| -22)
        }
        fn get_fsbase(&self) -> i64 {
            self.fsbase
        }
        fn set_fsbase(&mut self, val: i64) {
            self.fsbase = val;
        }
        fn get_gsbase(&self) -> i64 {
            self.gsbase
        }
        fn set_gsbase(&mut self, val: i64) {
            self.gsbase = val;
        }
        fn get_rcx(&self) -> i64 {
            self.rcx
        }
        fn set_rip(&mut self, val: i64) {
            self.rip = val;
        }
        fn set_rsp(&mut self, val: i64) {
            self.rsp = val;
        }
        fn get_rax(&self) -> i64 {
            self.rax
        }
        fn set_rax(&mut self, val: i64) {
            self.rax = val;
        }
        fn get_rdi(&self) -> i64 {
            self.rdi
        }
        fn get_rsi(&self) -> i64 {
            self.rsi
        }
        fn get_rdx(&self) -> i64 {
            self.rdx
        }
        fn get_r10(&self) -> i64 {
            self.r10
        }
        fn get_r8(&self) -> i64 {
            self.r8
        }
        fn get_r9(&self) -> i64 {
            self.r9
        }
        fn set_exit(&mut self, code: i32) {
            self.exit_flag = 1;
            self.exit_code = code;
        }
        fn set_yield_flag(&mut self, val: i32) {
            self.yield_flag = val;
        }
        fn set_quantum(&mut self, val: i32) {
            self.quantum = val;
        }
        fn save_ctx(&mut self, scratch_addr: u32) -> Result<[u8; CTX_SIZE], i64> {
            let mut buf = [0u8; CTX_SIZE];
            buf[32..40].copy_from_slice(&self.rsp.to_le_bytes());
            buf[128..136].copy_from_slice(&self.rip.to_le_bytes());
            buf[136..144].copy_from_slice(&self.fsbase.to_le_bytes());
            self.mem_write(scratch_addr as u64, &buf)?;
            Ok(buf)
        }
        fn load_ctx(&mut self, scratch_addr: u32, buf: &[u8; CTX_SIZE]) -> Result<(), i64> {
            self.mem_write(scratch_addr as u64, buf)?;
            self.rsp = i64::from_le_bytes(buf[32..40].try_into().unwrap());
            self.rip = i64::from_le_bytes(buf[128..136].try_into().unwrap());
            self.fsbase = i64::from_le_bytes(buf[136..144].try_into().unwrap());
            Ok(())
        }
    }

    #[test]
    fn test_writable_vfs_overlay_crud() {
        let so = MetaSoFile {
            guest_paths: vec!["/lib/x86_64-linux-gnu/libtest.so.1".to_string()],
            base_addr: 0x0200_0000,
            bytes: b"\x7fELFtest".to_vec(),
        };
        let mut vfs = VirtualFs::new_in_memory(&[so]);

        // RO .so still rejects writes
        assert_eq!(
            vfs.openat(AT_FDCWD, "/lib/x86_64-linux-gnu/libtest.so.1", O_WRONLY),
            -EACCES
        );

        // /tmp is pre-seeded and writable
        let st_tmp = vfs.stat_path(AT_FDCWD, "/tmp", 0).unwrap();
        assert_eq!(st_tmp.st_mode & S_IFDIR, S_IFDIR);

        assert_eq!(vfs.mkdirat(AT_FDCWD, "/tmp/work", 0o755, 100), 0);
        assert_eq!(vfs.mkdirat(AT_FDCWD, "/tmp/work", 0o755, 100), -EEXIST);

        let fd = vfs.openat(AT_FDCWD, "/tmp/work/a.txt", O_CREAT | O_RDWR | O_EXCL) as i32;
        assert!(fd >= 3);
        assert_eq!(
            vfs.openat(AT_FDCWD, "/tmp/work/a.txt", O_CREAT | O_RDWR | O_EXCL),
            -EEXIST
        );
        assert_eq!(vfs.write(fd, b"hello"), 5);
        assert_eq!(vfs.close(fd), 0);

        // Append
        let fd2 = vfs.openat(AT_FDCWD, "/tmp/work/a.txt", O_WRONLY | O_APPEND) as i32;
        assert!(fd2 >= 3);
        assert_eq!(vfs.write(fd2, b"_world"), 6);
        assert_eq!(vfs.close(fd2), 0);

        assert_eq!(vfs.vfs_read_file("/tmp/work/a.txt").unwrap(), b"hello_world");

        // Rename & truncate
        assert_eq!(
            vfs.renameat(AT_FDCWD, "/tmp/work/a.txt", AT_FDCWD, "/tmp/work/b.txt"),
            0
        );
        assert_eq!(vfs.vfs_read_file("/tmp/work/a.txt"), None);
        assert_eq!(vfs.truncate_path("/tmp/work/b.txt", 5, 200), 0);
        assert_eq!(vfs.vfs_read_file("/tmp/work/b.txt").unwrap(), b"hello");

        // rmdir non-empty fails, unlink then rmdir succeeds
        assert_eq!(vfs.unlinkat(AT_FDCWD, "/tmp/work", AT_REMOVEDIR), -ENOTEMPTY);
        assert_eq!(vfs.unlinkat(AT_FDCWD, "/tmp/work/b.txt", 0), 0);
        assert_eq!(vfs.unlinkat(AT_FDCWD, "/tmp/work", AT_REMOVEDIR), 0);
        assert_eq!(vfs.stat_path(AT_FDCWD, "/tmp/work", 0).err(), Some(-ENOENT));
    }

    #[test]
    fn test_simulated_time_nanosleep_fast_forward() {
        let vfs = VirtualFs::new_in_memory(&[]);
        let mut state = HostState::new(vfs);
        let mut ctx = MockCtx::new(0x0B00_0000);

        // Write timespec { tv_sec: 10, tv_nsec: 0 } at 0x1000
        let mut ts = [0u8; 16];
        ts[0..8].copy_from_slice(&10i64.to_le_bytes());
        ctx.mem_write(0x1000, &ts).unwrap();

        let ret = handle_syscall(&mut ctx, &mut state, 35 /* SYS_NANOSLEEP */, 0x1000, 0, 0, 0, 0, 0);
        assert_eq!(ret, 0);
        assert_eq!(ctx.yield_flag, 1);

        let cont = state.scheduler.on_yield(&mut ctx, 1).unwrap();
        assert!(cont);
        assert!(state.scheduler.virtual_mono_ns >= 10_000_000_000);

        // clock_gettime(CLOCK_MONOTONIC, 0x2000)
        let ret2 = handle_syscall(&mut ctx, &mut state, 228, 1, 0x2000, 0, 0, 0, 0);
        assert_eq!(ret2, 0);
        let mut out = [0u8; 16];
        ctx.mem_read(0x2000, &mut out).unwrap();
        let sec = i64::from_le_bytes(out[0..8].try_into().unwrap());
        assert_eq!(sec, 10);
    }

    #[test]
    fn test_scheduler_futex_wake_and_timeout() {
        let mut sched = Scheduler::new();
        let mut ctx = MockCtx::new(0x0B00_0000);

        let t2 = sched.alloc_tid();
        let mut tc2 = ThreadContext::new(t2);
        tc2.state = ThreadState::FutexWait {
            uaddr: 0x3000,
            bitset: 0xFFFF_FFFF,
            wake_ns: Some(5_000_000),
        };
        sched.threads.insert(t2, tc2);

        // Wake before timeout
        assert_eq!(sched.futex_wake(0x3000, 1, 0xFFFF_FFFF), 1);
        assert_eq!(sched.threads.get(&t2).unwrap().state, ThreadState::Runnable);
        assert_eq!(sched.run_queue.pop_front(), Some(t2));

        // Put main thread to timed futex wait, verify timeout fast-forward sets -ETIMEDOUT
        sched.threads.get_mut(&MAIN_TID).unwrap().state = ThreadState::FutexWait {
            uaddr: 0x4000,
            bitset: 0xFFFF_FFFF,
            wake_ns: Some(20_000_000),
        };
        assert!(sched.on_yield(&mut ctx, 1).unwrap());
        assert_eq!(sched.virtual_mono_ns, 20_000_000);
        let rax = sched.threads.get(&MAIN_TID).unwrap().get_reg_i64(0);
        assert_eq!(rax, -ETIMEDOUT);

        // Verify EAGAIN constant is positive 11
        assert_eq!(EAGAIN, 11);
    }

    fn write_cstr(ctx: &mut MockCtx, addr: u64, s: &str) {
        let mut bytes = s.as_bytes().to_vec();
        bytes.push(0);
        ctx.mem_write(addr, &bytes).unwrap();
    }

    #[test]
    fn test_interactive_stdin_need_stdin_and_push_close() {
        let vfs = VirtualFs::new_in_memory(&[]);
        let mut state = HostState::new(vfs);
        state.multiproc_enabled = true;
        state.set_tty_mode(true);
        let mut ctx = MockCtx::new(0x0B00_0000);

        // read(0, 0x1000, 16) blocks in StdinReadWait
        let ret = handle_syscall(&mut ctx, &mut state, 0 /* SYS_READ */, 0, 0x1000, 16, 0, 0, 0);
        assert_eq!(ret, 0);
        assert_eq!(ctx.yield_flag, 1);

        // on_yield_multiproc returns 5 = NeedStdin
        let action = state.on_yield_multiproc(&mut ctx, 1).unwrap();
        assert_eq!(action, 5);

        // Host pushes "hi\n" and wakes waiters
        state.vfs.push_stdin(b"hi\n");
        state.wake_ready_waiters();
        assert!(state.resume_active(&mut ctx).unwrap());
        let mut buf = [0u8; 3];
        ctx.mem_read(0x1000, &mut buf).unwrap();
        assert_eq!(&buf, b"hi\n");
        let rax = state.scheduler.current_thread().get_reg_i64(0);
        assert_eq!(rax, 3);

        // Next read(0) blocks again -> NeedStdin (5), then close_stdin -> EOF (0)
        let ret2 = handle_syscall(&mut ctx, &mut state, 0, 0, 0x1000, 16, 0, 0, 0);
        assert_eq!(ret2, 0);
        assert_eq!(state.on_yield_multiproc(&mut ctx, 1).unwrap(), 5);
        state.vfs.close_stdin();
        state.wake_ready_waiters();
        assert!(state.resume_active(&mut ctx).unwrap());
        assert_eq!(state.scheduler.current_thread().get_reg_i64(0), 0);
    }

    #[test]
    fn test_poll_stdin_interactive_vs_batch() {
        let mut ctx = MockCtx::new(0x0B00_0000);
        // pollfd { fd: 0, events: POLLIN(1), revents: 0 } at 0x2000
        let mut pfd = [0u8; 8];
        pfd[0..4].copy_from_slice(&0i32.to_le_bytes());
        pfd[4..6].copy_from_slice(&1i16.to_le_bytes());
        ctx.mem_write(0x2000, &pfd).unwrap();

        // Batch mode (default stdin_eof=true): poll(fd=0, timeout=0) immediately ready
        let mut batch_state = HostState::new(VirtualFs::new_in_memory(&[]));
        assert_eq!(handle_syscall(&mut ctx, &mut batch_state, 7, 0x2000, 1, 0, 0, 0, 0), 1);

        // Interactive mode with empty open stdin: timeout=0 returns 0
        let mut state = HostState::new(VirtualFs::new_in_memory(&[]));
        state.multiproc_enabled = true;
        state.set_tty_mode(true);
        assert_eq!(handle_syscall(&mut ctx, &mut state, 7, 0x2000, 1, 0, 0, 0, 0), 0);

        // Blocking poll(fd=0, timeout=-1) yields NeedStdin (5)
        assert_eq!(handle_syscall(&mut ctx, &mut state, 7, 0x2000, 1, -1, 0, 0, 0), 0);
        assert_eq!(state.on_yield_multiproc(&mut ctx, 1).unwrap(), 5);

        // Push data -> wakes poll waiter with revents = POLLIN
        state.vfs.push_stdin(b"a");
        state.wake_ready_waiters();
        assert!(state.resume_active(&mut ctx).unwrap());
        assert_eq!(state.scheduler.current_thread().get_reg_i64(0), 1);
        let mut rev = [0u8; 2];
        ctx.mem_read(0x2006, &mut rev).unwrap();
        assert_eq!(i16::from_le_bytes(rev), 1);
    }

    #[test]
    fn test_stdout_stderr_drain_and_get_compat() {
        let mut vfs = VirtualFs::new_in_memory(&[]);
        assert_eq!(vfs.write(1, b"hello "), 6);
        assert_eq!(vfs.write(2, b"err1"), 4);
        assert_eq!(vfs.drain_stdout(), b"hello ");
        assert_eq!(vfs.drain_stdout(), b"");
        assert_eq!(vfs.write(1, b"world"), 5);
        assert_eq!(vfs.drain_stdout(), b"world");
        // Full accumulated stdout/stderr preserved for backward compat
        assert_eq!(vfs.stdout, b"hello world");
        assert_eq!(vfs.drain_stderr(), b"err1");
        assert_eq!(vfs.stderr, b"err1");
    }

    #[test]
    fn test_tty_ioctl_and_sigint() {
        let mut state = HostState::new(VirtualFs::new_in_memory(&[]));
        state.multiproc_enabled = true;
        let mut ctx = MockCtx::new(0x0B00_0000);

        // Non-TTY mode returns -ENOTTY for TCGETS
        assert_eq!(handle_syscall(&mut ctx, &mut state, 16, 0, 0x5401, 0x1000, 0, 0, 0), -25);

        // Enable TTY mode
        state.set_tty_mode(true);
        state.set_winsize(40, 120);

        // TCGETS / TCSETS
        assert_eq!(handle_syscall(&mut ctx, &mut state, 16, 0, 0x5401, 0x1000, 0, 0, 0), 0);
        let mut termios = [0u8; 36];
        ctx.mem_read(0x1000, &mut termios).unwrap();
        assert_ne!(u32::from_le_bytes(termios[12..16].try_into().unwrap()), 0);
        termios[12..16].copy_from_slice(&0u32.to_le_bytes()); // raw mode
        ctx.mem_write(0x1000, &termios).unwrap();
        assert_eq!(handle_syscall(&mut ctx, &mut state, 16, 0, 0x5402, 0x1000, 0, 0, 0), 0);
        assert_eq!(u32::from_le_bytes(state.tty.termios[12..16].try_into().unwrap()), 0);

        // TIOCGWINSZ / TIOCSWINSZ
        assert_eq!(handle_syscall(&mut ctx, &mut state, 16, 0, 0x5413, 0x1100, 0, 0, 0), 0);
        let mut ws = [0u8; 8];
        ctx.mem_read(0x1100, &mut ws).unwrap();
        assert_eq!(u16::from_le_bytes([ws[0], ws[1]]), 40);
        assert_eq!(u16::from_le_bytes([ws[2], ws[3]]), 120);

        // TIOCGPGRP / TIOCSPGRP
        assert_eq!(handle_syscall(&mut ctx, &mut state, 16, 0, 0x540F, 0x1200, 0, 0, 0), 0);
        let mut pg = [0u8; 4];
        ctx.mem_read(0x1200, &mut pg).unwrap();
        assert_eq!(i32::from_le_bytes(pg), 1000);

        // FIONREAD on stdin
        state.vfs.push_stdin(b"12345");
        assert_eq!(handle_syscall(&mut ctx, &mut state, 16, 0, 0x541B, 0x1210, 0, 0, 0), 0);
        ctx.mem_read(0x1210, &mut pg).unwrap();
        assert_eq!(i32::from_le_bytes(pg), 5);
        let _ = state.vfs.read(0, 5);

        // SYS_RT_SIGACTION store & retrieve handler
        ctx.mem_write(0x1300, &0x401000u64.to_le_bytes()).unwrap();
        assert_eq!(handle_syscall(&mut ctx, &mut state, 13, 2, 0x1300, 0x1340, 8, 0, 0), 0);
        assert_eq!(handle_syscall(&mut ctx, &mut state, 13, 2, 0, 0x1340, 8, 0, 0), 0);
        let mut old_h = [0u8; 8];
        ctx.mem_read(0x1340, &mut old_h).unwrap();
        assert_eq!(u64::from_le_bytes(old_h), 0x401000);

        // SIGINT interrupts MAIN_PID blocked on StdinReadWait with -EINTR (-4)
        assert_eq!(handle_syscall(&mut ctx, &mut state, 0, 0, 0x1400, 16, 0, 0, 0), 0);
        assert_eq!(state.on_yield_multiproc(&mut ctx, 1).unwrap(), 5);
        state.send_sigint();
        assert!(state.resume_active(&mut ctx).unwrap());
        assert_eq!(state.scheduler.current_thread().get_reg_i64(0), -4);

        // SYS_KILL on forked child with SIG_DFL terminates child and records in reaped_pids
        let child_pid = handle_syscall(&mut ctx, &mut state, 57 /* SYS_FORK */, 0, 0, 0, 0, 0, 0) as i32;
        assert!(child_pid > 1000);
        state.pending_action = None;
        // Reset child's SIGINT handler to SIG_DFL (0)
        state.processes.get_mut(&child_pid).unwrap().sig_handlers.insert(2, 0);
        assert_eq!(handle_syscall(&mut ctx, &mut state, 62 /* SYS_KILL */, child_pid as i64, 2, 0, 0, 0, 0), 0);
        assert!(state.processes[&child_pid].exited);
        assert_eq!(state.take_reaped_pids(), vec![child_pid]);
    }

    #[test]
    fn test_virtual_dev_and_proc_and_vfs_dir_remove() {
        let mut vfs = VirtualFs::new_in_memory(&[]);
        vfs.cmdline = vec!["/bin/sh".to_string(), "-c".to_string(), "echo hi".to_string()];

        // /dev/null
        let fd_null = vfs.openat(AT_FDCWD, "/dev/null", O_RDWR) as i32;
        assert!(fd_null >= 3);
        assert_eq!(vfs.write(fd_null, b"discard me"), 10);
        assert_eq!(vfs.read(fd_null, 16).unwrap(), b"");
        assert_eq!(vfs.close(fd_null), 0);

        // /dev/zero
        let fd_zero = vfs.openat(AT_FDCWD, "/dev/zero", 0) as i32;
        assert_eq!(vfs.read(fd_zero, 8).unwrap(), vec![0u8; 8]);
        assert_eq!(vfs.close(fd_zero), 0);

        // /dev/urandom
        let fd_rand = vfs.openat(AT_FDCWD, "/dev/urandom", 0) as i32;
        let rbytes = vfs.read(fd_rand, 16).unwrap();
        assert_eq!(rbytes.len(), 16);
        assert!(rbytes.iter().any(|&b| b != 0));
        assert_eq!(vfs.close(fd_rand), 0);

        // /dev/stdout -> /proc/self/fd/1 must be writable (not blocked by is_read_only_path)
        let fd_out = vfs.openat(AT_FDCWD, "/dev/stdout", O_WRONLY) as i32;
        assert!(fd_out >= 3);
        assert_eq!(vfs.write(fd_out, b"via-dev-stdout"), 14);
        assert_eq!(vfs.stdout, b"via-dev-stdout");
        assert_eq!(vfs.close(fd_out), 0);

        // /dev/fd/2 -> stderr
        let fd_err = vfs.openat(AT_FDCWD, "/dev/fd/2", O_WRONLY) as i32;
        assert!(fd_err >= 3);
        assert_eq!(vfs.write(fd_err, b"via-dev-fd2"), 11);
        assert_eq!(vfs.stderr, b"via-dev-fd2");
        assert_eq!(vfs.close(fd_err), 0);

        // /proc/self/* and /proc/{uptime,meminfo,cpuinfo,version}
        assert_eq!(vfs.readlink(AT_FDCWD, "/proc/self").unwrap(), b"1000");
        assert_eq!(
            vfs.vfs_read_file("/proc/self/cmdline").unwrap(),
            b"/bin/sh\0-c\0echo hi\0"
        );
        assert!(String::from_utf8(vfs.vfs_read_file("/proc/self/status").unwrap())
            .unwrap()
            .contains("Pid:\t1000"));
        assert!(String::from_utf8(vfs.vfs_read_file("/proc/self/stat").unwrap())
            .unwrap()
            .starts_with("1000 (sh) R"));
        assert!(vfs.vfs_read_file("/proc/uptime").is_some());
        assert!(vfs.vfs_read_file("/proc/meminfo").is_some());
        assert!(vfs.vfs_read_file("/proc/cpuinfo").is_some());
        assert!(vfs.vfs_read_file("/proc/version").is_some());

        // vfs_add_dir and recursive vfs_remove_path
        vfs.vfs_add_dir("/var/empty_dir", 0o755);
        assert_eq!(vfs.stat_path(AT_FDCWD, "/var/empty_dir", 0).unwrap().st_mode & S_IFDIR, S_IFDIR);
        vfs.vfs_write_file("/var/empty_dir/sub/f.txt", b"abc", 0o644);
        assert!(vfs.vfs_remove_path("/var/empty_dir"));
        assert_eq!(vfs.stat_path(AT_FDCWD, "/var/empty_dir", 0).err(), Some(-ENOENT));
        assert_eq!(vfs.stat_path(AT_FDCWD, "/var/empty_dir/sub/f.txt", 0).err(), Some(-ENOENT));
    }

    #[test]
    fn test_execve_shebang_enoexec_and_access_xok() {
        let mut vfs = VirtualFs::new_in_memory(&[]);
        let mut valid_elf = [0u8; 120];
        valid_elf[0..4].copy_from_slice(b"\x7fELF");
        valid_elf[4] = 2; // ELFCLASS64
        valid_elf[5] = 1; // ELFDATA2LSB
        valid_elf[6] = 1; // EV_CURRENT
        valid_elf[16..18].copy_from_slice(&2u16.to_le_bytes()); // ET_EXEC
        valid_elf[18..20].copy_from_slice(&62u16.to_le_bytes()); // EM_X86_64
        valid_elf[32..40].copy_from_slice(&64u64.to_le_bytes()); // e_phoff = 64
        valid_elf[54..56].copy_from_slice(&56u16.to_le_bytes()); // e_phentsize = 56
        valid_elf[56..58].copy_from_slice(&1u16.to_le_bytes()); // e_phnum = 1
        // PT_LOAD (1), PF_R|PF_X (5), p_offset=0, p_filesz=120, p_memsz=120
        valid_elf[64..68].copy_from_slice(&1u32.to_le_bytes());
        valid_elf[68..72].copy_from_slice(&5u32.to_le_bytes());
        valid_elf[72..80].copy_from_slice(&0u64.to_le_bytes());
        valid_elf[96..104].copy_from_slice(&120u64.to_le_bytes());
        valid_elf[104..112].copy_from_slice(&120u64.to_le_bytes());
        vfs.vfs_write_file("/bin/sh", &valid_elf, 0o755);
        vfs.vfs_write_file("/tmp/script.sh", b"#!/bin/sh -e\necho hi\n", 0o755);
        vfs.vfs_write_file("/tmp/plain.txt", b"not an elf", 0o644);

        // access(X_OK) rejects 0o644 regular file, accepts 0o755 and dirs
        assert_eq!(vfs.access(AT_FDCWD, "/tmp/plain.txt", 1), -EACCES);
        assert_eq!(vfs.access(AT_FDCWD, "/tmp/script.sh", 1), 0);
        assert_eq!(vfs.access(AT_FDCWD, "/tmp", 1), 0);

        let mut state = HostState::new(vfs);
        state.multiproc_enabled = true;
        let mut ctx = MockCtx::new(0x0B00_0000);

        // Open an O_CLOEXEC fd to verify -ENOEXEC does NOT close it
        let clo_fd = state.vfs.openat(AT_FDCWD, "/tmp/plain.txt", 0x80000 /* O_CLOEXEC */) as i32;
        assert!(clo_fd >= 3);

        // execve("/tmp/plain.txt") -> -ENOEXEC (-8), O_CLOEXEC fd stays open!
        write_cstr(&mut ctx, 0x1000, "/tmp/plain.txt");
        ctx.mem_write(0x1100, &0x1000u64.to_le_bytes()).unwrap();
        ctx.mem_write(0x1108, &0u64.to_le_bytes()).unwrap();
        ctx.mem_write(0x1200, &0u64.to_le_bytes()).unwrap();
        let ret = handle_syscall(&mut ctx, &mut state, 59 /* SYS_EXECVE */, 0x1000, 0x1100, 0x1200, 0, 0, 0);
        assert_eq!(ret, -8);
        assert!(state.vfs.get_fd(clo_fd).is_some());
        assert!(state.pending_action.is_none());

        // execve("/tmp/script.sh", ["script.sh", "arg1"]) -> resolves #!/bin/sh -e
        write_cstr(&mut ctx, 0x2000, "/tmp/script.sh");
        write_cstr(&mut ctx, 0x2020, "arg1");
        ctx.mem_write(0x2100, &0x2000u64.to_le_bytes()).unwrap();
        ctx.mem_write(0x2108, &0x2020u64.to_le_bytes()).unwrap();
        ctx.mem_write(0x2110, &0u64.to_le_bytes()).unwrap();
        let ret2 = handle_syscall(&mut ctx, &mut state, 59, 0x2000, 0x2100, 0x1200, 0, 0, 0);
        assert_eq!(ret2, 0);
        assert!(state.vfs.get_fd(clo_fd).is_none());
        match &state.pending_action {
            Some(crate::syscalls::PendingHostAction::Exec { path, argv, .. }) => {
                assert_eq!(path, "/bin/sh");
                assert_eq!(argv, &vec!["/bin/sh", "-e", "/tmp/script.sh", "arg1"]);
            }
            other => panic!("expected PendingHostAction::Exec, got {:?}", other),
        }
    }

    #[test]
    fn test_f5_syscalls_and_uid_gid() {
        let mut state = HostState::new(VirtualFs::new_in_memory(&[]));
        let mut ctx = MockCtx::new(0x0B00_0000);

        // Configurable UID/GID preserved across reset_for_new_run
        state.set_uid_gid(0, 0);
        state.reset_for_new_run();
        assert_eq!(handle_syscall(&mut ctx, &mut state, 102 /* getuid */, 0, 0, 0, 0, 0, 0), 0);
        assert_eq!(handle_syscall(&mut ctx, &mut state, 104 /* getgid */, 0, 0, 0, 0, 0, 0), 0);

        // umask
        assert_eq!(handle_syscall(&mut ctx, &mut state, 95 /* umask */, 0o077, 0, 0, 0, 0, 0), 0o022);
        assert_eq!(handle_syscall(&mut ctx, &mut state, 95, 0o022, 0, 0, 0, 0, 0), 0o077);

        // link & chown & fsync & statfs
        state.vfs.vfs_write_file("/tmp/orig.txt", b"hello", 0o644);
        write_cstr(&mut ctx, 0x1000, "/tmp/orig.txt");
        write_cstr(&mut ctx, 0x1040, "/tmp/hard.txt");
        assert_eq!(handle_syscall(&mut ctx, &mut state, 86 /* link */, 0x1000, 0x1040, 0, 0, 0, 0), 0);
        assert_eq!(state.vfs.vfs_read_file("/tmp/hard.txt").unwrap(), b"hello");
        assert_eq!(handle_syscall(&mut ctx, &mut state, 92 /* chown */, 0x1040, 0, 0, 0, 0, 0), 0);
        assert_eq!(handle_syscall(&mut ctx, &mut state, 137 /* statfs */, 0x1040, 0x1100, 0, 0, 0, 0), 0);
        assert_eq!(handle_syscall(&mut ctx, &mut state, 74 /* fsync */, 1, 0, 0, 0, 0, 0), 0);

        // setsid / getsid / times / getrusage
        assert_eq!(handle_syscall(&mut ctx, &mut state, 112 /* setsid */, 0, 0, 0, 0, 0, 0), 1000);
        assert_eq!(handle_syscall(&mut ctx, &mut state, 124 /* getsid */, 0, 0, 0, 0, 0, 0), 1000);
        assert!(handle_syscall(&mut ctx, &mut state, 100 /* times */, 0x1200, 0, 0, 0, 0, 0) >= 0);
        assert_eq!(handle_syscall(&mut ctx, &mut state, 98 /* getrusage */, 0, 0x1300, 0, 0, 0, 0), 0);

        // socket(AF_INET6) -> -EAFNOSUPPORT (-97); socket(AF_INET, SOCK_STREAM) succeeds
        assert_eq!(handle_syscall(&mut ctx, &mut state, 41 /* socket */, 10, 1, 0, 0, 0, 0), -97);
        let tcp_fd = handle_syscall(&mut ctx, &mut state, 41 /* socket */, 2, 1, 0, 0, 0, 0) as i32;
        assert!(tcp_fd >= 3);
        assert_eq!(handle_syscall(&mut ctx, &mut state, 3 /* close */, tcp_fd as i64, 0, 0, 0, 0, 0), 0);

        // socketpair(AF_UNIX) bidirectional + readv
        assert_eq!(handle_syscall(&mut ctx, &mut state, 53 /* socketpair */, 1, 1, 0, 0x1400, 0, 0), 0);
        let mut sv = [0u8; 8];
        ctx.mem_read(0x1400, &mut sv).unwrap();
        let s0 = i32::from_le_bytes(sv[0..4].try_into().unwrap());
        let s1 = i32::from_le_bytes(sv[4..8].try_into().unwrap());
        ctx.mem_write(0x1500, b"abcdef").unwrap();
        assert_eq!(handle_syscall(&mut ctx, &mut state, 1 /* write */, s0 as i64, 0x1500, 6, 0, 0, 0), 6);
        // readv into two 3-byte iovecs
        ctx.mem_write(0x1600, &0x1700u64.to_le_bytes()).unwrap();
        ctx.mem_write(0x1608, &3u64.to_le_bytes()).unwrap();
        ctx.mem_write(0x1610, &0x1710u64.to_le_bytes()).unwrap();
        ctx.mem_write(0x1618, &3u64.to_le_bytes()).unwrap();
        assert_eq!(handle_syscall(&mut ctx, &mut state, 19 /* readv */, s1 as i64, 0x1600, 2, 0, 0, 0), 6);
        let mut b1 = [0u8; 3];
        let mut b2 = [0u8; 3];
        ctx.mem_read(0x1700, &mut b1).unwrap();
        ctx.mem_read(0x1710, &mut b2).unwrap();
        assert_eq!(&b1, b"abc");
        assert_eq!(&b2, b"def");

        // eventfd2 + epoll (12-byte packed epoll_event verification)
        let efd = handle_syscall(&mut ctx, &mut state, 290 /* eventfd2 */, 3, 0, 0, 0, 0, 0) as i32;
        assert!(efd >= 3);
        let epfd = handle_syscall(&mut ctx, &mut state, 291 /* epoll_create1 */, 0, 0, 0, 0, 0, 0) as i32;
        assert!(epfd >= 3);
        let mut ev = [0u8; 12];
        ev[0..4].copy_from_slice(&1u32.to_le_bytes()); // EPOLLIN
        ev[4..12].copy_from_slice(&0xdead_beef_cafe_1234u64.to_le_bytes());
        ctx.mem_write(0x1800, &ev).unwrap();
        assert_eq!(handle_syscall(&mut ctx, &mut state, 233 /* epoll_ctl */, epfd as i64, 1, efd as i64, 0x1800, 0, 0), 0);
        assert_eq!(handle_syscall(&mut ctx, &mut state, 232 /* epoll_wait */, epfd as i64, 0x1900, 4, 0, 0, 0), 1);
        let mut out_ev = [0u8; 12];
        ctx.mem_read(0x1900, &mut out_ev).unwrap();
        assert_eq!(u32::from_le_bytes(out_ev[0..4].try_into().unwrap()), 1);
        assert_eq!(u64::from_le_bytes(out_ev[4..12].try_into().unwrap()), 0xdead_beef_cafe_1234);
    }

    #[test]
    fn test_mmap_freelist_coalesce_and_reuse() {
        let mut state = HostState::new(VirtualFs::new_in_memory(&[]));
        let mut ctx = MockCtx::new(0x0B00_0000);
        const MAP_PRIVATE_ANON: i64 = 0x22;

        // Allocate & munmap 4 MiB x 50 iterations (200 MiB > 48 MiB arena) without -ENOMEM
        let mut first_addr = 0i64;
        for i in 0..50 {
            let a = handle_syscall(&mut ctx, &mut state, 9 /* mmap */, 0, 4 * 1024 * 1024, 3, MAP_PRIVATE_ANON, -1, 0);
            assert!(a >= 0x0800_0000, "iteration {} failed: {}", i, a);
            if i == 0 {
                first_addr = a;
            } else {
                assert_eq!(a, first_addr, "freed tail should retract cursor and be reused");
            }
            assert_eq!(handle_syscall(&mut ctx, &mut state, 11 /* munmap */, a, 4 * 1024 * 1024, 0, 0, 0, 0), 0);
        }

        // Coalesce two adjacent non-tail blocks
        let a = handle_syscall(&mut ctx, &mut state, 9, 0, 0x10000, 3, MAP_PRIVATE_ANON, -1, 0);
        let b = handle_syscall(&mut ctx, &mut state, 9, 0, 0x10000, 3, MAP_PRIVATE_ANON, -1, 0);
        let c = handle_syscall(&mut ctx, &mut state, 9, 0, 0x10000, 3, MAP_PRIVATE_ANON, -1, 0);
        assert_eq!(b, a + 0x10000);
        assert_eq!(c, b + 0x10000);
        assert_eq!(handle_syscall(&mut ctx, &mut state, 11, a, 0x10000, 0, 0, 0, 0), 0);
        assert_eq!(handle_syscall(&mut ctx, &mut state, 11, b, 0x10000, 0, 0, 0, 0), 0);
        // A 0x20000 allocation should now fit in the coalesced [a..a+0x20000) hole!
        let d = handle_syscall(&mut ctx, &mut state, 9, 0, 0x20000, 3, MAP_PRIVATE_ANON, -1, 0);
        assert_eq!(d, a);
    }

    #[test]
    fn test_non_tty_stdin_open_yields_need_stdin_and_returns_enotty() {
        let mut state = HostState::new(VirtualFs::new_in_memory(&[]));
        state.multiproc_enabled = true;
        let mut ctx = MockCtx::new(0x0B00_0000);

        // Configure non-TTY mode with stdin explicitly open (e.g., docker run -i without -t)
        state.set_tty_mode(false);
        state.set_stdin_open(true);
        // Verify setting tty_mode(false) again does NOT force stdin_eof = true
        state.set_tty_mode(false);
        // Verify reset_for_new_run preserves open stdin while keeping tty.enabled == false
        state.reset_for_new_run();

        assert!(!state.tty.enabled);
        assert!(!state.vfs.stdin_eof);

        // TCGETS on fd 0 must still return -ENOTTY (-25)
        assert_eq!(
            handle_syscall(&mut ctx, &mut state, 16 /* ioctl */, 0, 0x5401 /* TCGETS */, 0x1000, 0, 0, 0),
            -25
        );

        // read(0, buf, 16) must block and yield NeedStdin (5) instead of returning immediate EOF
        let ret = handle_syscall(&mut ctx, &mut state, 0 /* read */, 0, 0x2000, 16, 0, 0, 0);
        assert_eq!(ret, 0);
        assert_eq!(state.on_yield_multiproc(&mut ctx, 1).unwrap(), 5);

        // Push data -> wakes reader with bytes
        state.vfs.push_stdin(b"ping\n");
        state.wake_ready_waiters();
        assert!(state.resume_active(&mut ctx).unwrap());
        assert_eq!(state.scheduler.current_thread().get_reg_i64(0), 5);
        let mut buf = [0u8; 5];
        ctx.mem_read(0x2000, &mut buf).unwrap();
        assert_eq!(&buf, b"ping\n");

        // Second read(0) after buffer drained should still yield NeedStdin until close_stdin()
        let ret2 = handle_syscall(&mut ctx, &mut state, 0 /* read */, 0, 0x2000, 16, 0, 0, 0);
        assert_eq!(ret2, 0);
        assert_eq!(state.on_yield_multiproc(&mut ctx, 1).unwrap(), 5);

        // Close stdin -> wakes reader with 0 (EOF)
        state.vfs.close_stdin();
        state.wake_ready_waiters();
        assert!(state.resume_active(&mut ctx).unwrap());
        assert_eq!(state.scheduler.current_thread().get_reg_i64(0), 0);
    }

    #[test]
    fn test_c1_gap1_execve_validates_full_elf64_x86_64_header() {
        let make_elf_with_phdr = |class: u8,
                                  data: u8,
                                  ver: u8,
                                  e_type: u16,
                                  e_machine: u16,
                                  e_phoff: u64,
                                  e_phentsize: u16,
                                  e_phnum: u16,
                                  p_flags: u32,
                                  p_offset: u64,
                                  p_filesz: u64,
                                  p_memsz: u64,
                                  total_len: usize| {
            let mut b = vec![0u8; total_len];
            b[0..4].copy_from_slice(b"\x7fELF");
            b[4] = class;
            b[5] = data;
            b[6] = ver;
            b[16..18].copy_from_slice(&e_type.to_le_bytes());
            b[18..20].copy_from_slice(&e_machine.to_le_bytes());
            b[32..40].copy_from_slice(&e_phoff.to_le_bytes());
            b[54..56].copy_from_slice(&e_phentsize.to_le_bytes());
            b[56..58].copy_from_slice(&e_phnum.to_le_bytes());
            if total_len >= 120 {
                b[64..68].copy_from_slice(&1u32.to_le_bytes()); // PT_LOAD
                b[68..72].copy_from_slice(&p_flags.to_le_bytes());
                b[72..80].copy_from_slice(&p_offset.to_le_bytes());
                b[96..104].copy_from_slice(&p_filesz.to_le_bytes());
                b[104..112].copy_from_slice(&p_memsz.to_le_bytes());
            }
            b
        };

        let mut vfs = VirtualFs::new_in_memory(&[]);
        vfs.vfs_write_file("/tmp/trunc", b"\x7fELF", 0o755);
        vfs.vfs_write_file("/tmp/elf32", &make_elf_with_phdr(1, 1, 1, 2, 62, 64, 56, 1, 5, 0, 120, 120, 120), 0o755);
        vfs.vfs_write_file("/tmp/bigend", &make_elf_with_phdr(2, 2, 1, 2, 62, 64, 56, 1, 5, 0, 120, 120, 120), 0o755);
        vfs.vfs_write_file("/tmp/reloc", &make_elf_with_phdr(2, 1, 1, 1, 62, 64, 56, 1, 5, 0, 120, 120, 120), 0o755);
        vfs.vfs_write_file("/tmp/arm64", &make_elf_with_phdr(2, 1, 1, 2, 183, 64, 56, 1, 5, 0, 120, 120, 120), 0o755);
        // R2-C1-Gap1: truncated program headers, e_phnum=0, out-of-bounds PT_LOAD, filesz > memsz, non-exec/empty PT_LOAD
        vfs.vfs_write_file("/tmp/trunc64_phdr", &make_elf_with_phdr(2, 1, 1, 2, 62, 64, 56, 1, 5, 0, 120, 120, 64), 0o755);
        vfs.vfs_write_file("/tmp/trunc100_phdr", &make_elf_with_phdr(2, 1, 1, 2, 62, 64, 56, 1, 5, 0, 120, 120, 100), 0o755);
        vfs.vfs_write_file("/tmp/zero_phnum", &make_elf_with_phdr(2, 1, 1, 2, 62, 64, 56, 0, 5, 0, 120, 120, 64), 0o755);
        vfs.vfs_write_file("/tmp/oob_load", &make_elf_with_phdr(2, 1, 1, 2, 62, 64, 56, 1, 5, 0, 200, 200, 120), 0o755);
        vfs.vfs_write_file("/tmp/filesz_gt_memsz", &make_elf_with_phdr(2, 1, 1, 2, 62, 64, 56, 1, 5, 0, 120, 64, 120), 0o755);
        vfs.vfs_write_file("/tmp/no_pfx", &make_elf_with_phdr(2, 1, 1, 2, 62, 64, 56, 1, 4, 0, 120, 120, 120), 0o755);
        vfs.vfs_write_file("/tmp/empty_pfx", &make_elf_with_phdr(2, 1, 1, 2, 62, 64, 56, 1, 5, 0, 0, 120, 120), 0o755);
        vfs.vfs_write_file("/tmp/valid_dyn", &make_elf_with_phdr(2, 1, 1, 3, 62, 64, 56, 1, 5, 0, 120, 120, 120), 0o755);

        let mut state = HostState::new(vfs);
        state.multiproc_enabled = true;
        let mut ctx = MockCtx::new(0x0B00_0000);

        let clo_fd = state
            .vfs
            .openat(AT_FDCWD, "/tmp/trunc", 0x80000 /* O_CLOEXEC */) as i32;
        assert!(clo_fd >= 3);

        ctx.mem_write(0x1200, &0u64.to_le_bytes()).unwrap(); // envp = [NULL]
        for bad in [
            "/tmp/trunc",
            "/tmp/elf32",
            "/tmp/bigend",
            "/tmp/reloc",
            "/tmp/arm64",
            "/tmp/trunc64_phdr",
            "/tmp/trunc100_phdr",
            "/tmp/zero_phnum",
            "/tmp/oob_load",
            "/tmp/filesz_gt_memsz",
            "/tmp/no_pfx",
            "/tmp/empty_pfx",
        ] {
            write_cstr(&mut ctx, 0x1000, bad);
            ctx.mem_write(0x1100, &0x1000u64.to_le_bytes()).unwrap();
            ctx.mem_write(0x1108, &0u64.to_le_bytes()).unwrap();
            let ret = handle_syscall(&mut ctx, &mut state, 59, 0x1000, 0x1100, 0x1200, 0, 0, 0);
            assert_eq!(ret, -8, "expected -ENOEXEC for {}", bad);
            assert!(
                state.vfs.get_fd(clo_fd).is_some(),
                "O_CLOEXEC fd must remain open after -ENOEXEC for {}",
                bad
            );
            assert!(state.pending_action.is_none());
        }

        // Valid ELF64 x86-64 ET_DYN succeeds and closes O_CLOEXEC fd
        write_cstr(&mut ctx, 0x1000, "/tmp/valid_dyn");
        ctx.mem_write(0x1100, &0x1000u64.to_le_bytes()).unwrap();
        ctx.mem_write(0x1108, &0u64.to_le_bytes()).unwrap();
        let ok = handle_syscall(&mut ctx, &mut state, 59, 0x1000, 0x1100, 0x1200, 0, 0, 0);
        assert_eq!(ok, 0);
        assert!(state.vfs.get_fd(clo_fd).is_none());
        assert!(matches!(
            state.pending_action,
            Some(crate::syscalls::PendingHostAction::Exec { .. })
        ));
    }

    #[test]
    fn test_c1_gap3_resume_active_does_not_reenter_exited_child_after_sigint() {
        let mut state = HostState::new(VirtualFs::new_in_memory(&[]));
        state.multiproc_enabled = true;
        state.set_tty_mode(true);
        state.reset_for_new_run();
        let mut ctx = MockCtx::new(0x0B00_0000);

        // Parent forks child 1001
        let child_pid = handle_syscall(&mut ctx, &mut state, 57 /* fork */, 0, 0, 0, 0, 0, 0) as i32;
        assert_eq!(child_pid, 1001);
        assert_eq!(state.on_yield_multiproc(&mut ctx, 1).unwrap(), 3); // NeedFork
        assert!(state.ack_fork(child_pid));
        assert_eq!(state.active_pid, child_pid);
        assert!(state.resume_active(&mut ctx).unwrap());

        // Child blocks on read(0, buf, 16) -> NeedStdin (5)
        let _ = handle_syscall(&mut ctx, &mut state, 0 /* read */, 0, 0x2000, 16, 0, 0, 0);
        // Put parent in wait4 so child is the only stdin waiter
        state.switch_active_process(1000);
        let _ = handle_syscall(&mut ctx, &mut state, 61 /* wait4 */, -1, 0x3000, 0, 0, 0, 0);
        let y = state.on_yield_multiproc(&mut ctx, 1).unwrap();
        assert_eq!(y, 5); // NeedStdin on child 1001
        assert_eq!(state.active_pid, child_pid);

        // SIGINT terminates foreground child 1001 while active_pid is still 1001
        state.send_sigint();
        assert_eq!(state.active_pid, child_pid);
        // resume_active MUST return Ok(false) instead of re-entering the dead child
        assert_eq!(state.resume_active(&mut ctx).unwrap(), false);
        assert_eq!(ctx.yield_flag, 1);

        // Next on_yield_multiproc switches cleanly back to parent 1000
        let next_y = state.on_yield_multiproc(&mut ctx, 1).unwrap();
        assert_eq!(next_y, 2);
        assert_eq!(state.active_pid, 1000);
        assert!(state.resume_active(&mut ctx).unwrap());
    }

    #[test]
    fn test_c1_gap4_map_fixed_preserves_gap_and_anon_mmap_zeroes_full_page() {
        let mut state = HostState::new(VirtualFs::new_in_memory(&[]));
        let mut ctx = MockCtx::new(0x0B00_0000);
        const MAP_PRIVATE_ANON: i64 = 0x22;
        const MAP_FIXED_PRIVATE_ANON: i64 = 0x32;

        // 1. Sub-page anonymous mmap reuse must zero the entire 4 KiB page tail
        let p1 = handle_syscall(&mut ctx, &mut state, 9, 0, 4096, 3, MAP_PRIVATE_ANON, -1, 0);
        assert!(p1 >= 0x0800_0000);
        ctx.mem_write(p1 as u64, &[0xAAu8; 4096]).unwrap();
        assert_eq!(handle_syscall(&mut ctx, &mut state, 11, p1, 4096, 0, 0, 0, 0), 0);

        let p2 = handle_syscall(&mut ctx, &mut state, 9, 0, 100, 3, MAP_PRIVATE_ANON, -1, 0);
        assert_eq!(p2, p1, "expected page reuse");
        let mut page = [0u8; 4096];
        ctx.mem_read(p2 as u64, &mut page).unwrap();
        assert!(
            page.iter().all(|&b| b == 0),
            "full 4 KiB page must be zeroed on anonymous mmap reuse"
        );
        assert_eq!(handle_syscall(&mut ctx, &mut state, 11, p2, 4096, 0, 0, 0, 0), 0);

        // 2. MAP_FIXED near top of mmap arena must preserve [cursor, fixed_addr) in free_regions
        let fixed_addr = 0x0AFE_0000i64;
        let f = handle_syscall(
            &mut ctx,
            &mut state,
            9,
            fixed_addr,
            4096,
            3,
            MAP_FIXED_PRIVATE_ANON,
            -1,
            0,
        );
        assert_eq!(f, fixed_addr);
        let big = handle_syscall(
            &mut ctx,
            &mut state,
            9,
            0,
            1024 * 1024,
            3,
            MAP_PRIVATE_ANON,
            -1,
            0,
        );
        assert!(
            big >= 0x0800_0000 && big < fixed_addr,
            "expected 1 MiB anonymous mmap to allocate from preserved gap, got {}",
            big
        );
    }

    #[test]
    fn test_f17_canonical_tty_echo_line_editing_and_modes() {
        let mut state = HostState::new(VirtualFs::new_in_memory(&[]));
        let mut ctx = MockCtx::new(0x0B00_0000);
        state.set_tty_mode(true);

        // 1. Canonical mode: echo + backspace + CR->NL + line buffering
        state.push_stdin(b"ab\x7fc");
        assert_eq!(state.vfs.stdout, b"ab\x08 \x08c");
        assert_eq!(state.vfs.stdin_available(), 0, "unterminated line must stay buffered");

        state.push_stdin(b"\r");
        assert_eq!(state.vfs.stdout, b"ab\x08 \x08c\r\n");
        let n = handle_syscall(&mut ctx, &mut state, 0 /* read */, 0, 0x2000, 16, 0, 0, 0);
        assert_eq!(n, 3);
        let mut out = [0u8; 3];
        ctx.mem_read(0x2000, &mut out).unwrap();
        assert_eq!(&out, b"ac\n");

        // 2. Ctrl-U kills line and erases echoed chars
        state.vfs.stdout.clear();
        state.push_stdin(b"xyz\x15ok\n");
        assert_eq!(state.vfs.stdout, b"xyz\x08 \x08\x08 \x08\x08 \x08ok\r\n");
        let n = handle_syscall(&mut ctx, &mut state, 0, 0, 0x2000, 16, 0, 0, 0);
        assert_eq!(n, 3);
        ctx.mem_read(0x2000, &mut out).unwrap();
        assert_eq!(&out, b"ok\n");

        // 3. Ctrl-D flushes partial line without EOF; second Ctrl-D on empty sets EOF
        state.vfs.stdout.clear();
        state.push_stdin(b"hi\x04");
        assert!(!state.vfs.stdin_eof);
        let n = handle_syscall(&mut ctx, &mut state, 0, 0, 0x2000, 16, 0, 0, 0);
        assert_eq!(n, 2);
        let mut hi = [0u8; 2];
        ctx.mem_read(0x2000, &mut hi).unwrap();
        assert_eq!(&hi, b"hi");

        state.push_stdin(b"\x04");
        assert!(state.vfs.stdin_eof);
        let eof_n = handle_syscall(&mut ctx, &mut state, 0, 0, 0x2000, 16, 0, 0, 0);
        assert_eq!(eof_n, 0);

        // 4. Switch to raw mode via TCSETS (clear ICANON | ECHO) flushes pending canon_buf
        state.reset_for_new_run();
        state.vfs.stdin_data.clear();
        state.set_tty_mode(true);
        state.push_stdin(b"pre");
        assert_eq!(state.vfs.stdin_available(), 0);
        let mut raw_termios = state.tty.termios;
        let lflag = u32::from_le_bytes(raw_termios[12..16].try_into().unwrap()) & !(0x0002 | 0x0008);
        raw_termios[12..16].copy_from_slice(&lflag.to_le_bytes());
        ctx.mem_write(0x3000, &raw_termios).unwrap();
        assert_eq!(
            handle_syscall(&mut ctx, &mut state, 16 /* ioctl */, 0, 0x5402 /* TCSETS */, 0x3000, 0, 0, 0),
            0
        );
        assert_eq!(state.vfs.stdin_available(), 3, "switching to raw mode must flush canon_buf");
        state.vfs.stdout.clear();
        state.push_stdin(b"q");
        assert!(state.vfs.stdout.is_empty(), "raw mode with ECHO cleared must not echo");
        assert_eq!(state.vfs.stdin_available(), 4);

        // 5. Batch mode (tty.enabled == false): direct passthrough with zero echo
        state.reset_for_new_run();
        state.vfs.stdin_data.clear();
        state.set_tty_mode(false);
        state.set_stdin_open(true);
        state.push_stdin(b"raw\r");
        assert!(state.vfs.stdout.is_empty());
        let n = handle_syscall(&mut ctx, &mut state, 0, 0, 0x2000, 16, 0, 0, 0);
        assert_eq!(n, 4);
        let mut raw_out = [0u8; 4];
        ctx.mem_read(0x2000, &mut raw_out).unwrap();
        assert_eq!(&raw_out, b"raw\r");
    }

    #[test]
    fn test_f18_rlimit_stack_capget_and_epoll_regular_file_eperm() {
        let mut vfs = VirtualFs::new_in_memory(&[]);
        vfs.vfs_write_file("/tmp/regular.txt", b"hello", 0o644);
        let mut state = HostState::new(vfs);
        let mut ctx = MockCtx::new(0x0B00_0000);

        // 1. RLIMIT_STACK = 2 MiB in both prlimit64 (302) and getrlimit (97)
        assert_eq!(
            handle_syscall(&mut ctx, &mut state, 302 /* prlimit64 */, 0, 3, 0, 0x2000, 0, 0),
            0
        );
        let mut rlim = [0u8; 16];
        ctx.mem_read(0x2000, &mut rlim).unwrap();
        assert_eq!(u64::from_le_bytes(rlim[0..8].try_into().unwrap()), 2 * 1024 * 1024);

        assert_eq!(
            handle_syscall(&mut ctx, &mut state, 97 /* getrlimit */, 3, 0x2020, 0, 0, 0, 0),
            0
        );
        ctx.mem_read(0x2020, &mut rlim).unwrap();
        assert_eq!(u64::from_le_bytes(rlim[0..8].try_into().unwrap()), 2 * 1024 * 1024);

        // 2. SYS_CAPGET (125): version probe with NULL data writes v3 and returns 0
        ctx.mem_write(0x2100, &[0u8; 8]).unwrap();
        assert_eq!(
            handle_syscall(&mut ctx, &mut state, 125 /* capget */, 0x2100, 0, 0, 0, 0, 0),
            0
        );
        let mut ver = [0u8; 4];
        ctx.mem_read(0x2100, &mut ver).unwrap();
        assert_eq!(u32::from_le_bytes(ver), 0x2008_0522);

        // v3 query zeroes 24 bytes of cap_user_data_t and returns 0
        ctx.mem_write(0x2120, &[0xFFu8; 24]).unwrap();
        assert_eq!(
            handle_syscall(&mut ctx, &mut state, 125 /* capget */, 0x2100, 0x2120, 0, 0, 0, 0),
            0
        );
        let mut cap_data = [0u8; 24];
        ctx.mem_read(0x2120, &mut cap_data).unwrap();
        assert!(cap_data.iter().all(|&b| b == 0));

        // 3. SYS_EPOLL_CTL (233): returns -EPERM (-1) on regular files, 0 on eventfd/stdin
        let epfd = handle_syscall(&mut ctx, &mut state, 291 /* epoll_create1 */, 0, 0, 0, 0, 0, 0);
        assert!(epfd >= 3);
        ctx.mem_write(0x2200, b"/tmp/regular.txt\0").unwrap();
        let reg_fd = handle_syscall(
            &mut ctx,
            &mut state,
            257, /* openat */
            -100,
            0x2200,
            0,
            0,
            0,
            0,
        );
        assert!(reg_fd >= 3);
        let mut ev = [0u8; 12];
        ev[0..4].copy_from_slice(&1u32.to_le_bytes()); // EPOLLIN
        ctx.mem_write(0x2240, &ev).unwrap();
        assert_eq!(
            handle_syscall(
                &mut ctx,
                &mut state,
                233, /* epoll_ctl */
                epfd,
                1, /* EPOLL_CTL_ADD */
                reg_fd,
                0x2240,
                0,
                0,
            ),
            -1 // -EPERM
        );
        // stdin (fd 0) is supported
        assert_eq!(
            handle_syscall(&mut ctx, &mut state, 233, epfd, 1, 0, 0x2240, 0, 0),
            0
        );
    }

    #[test]
    fn test_alloc_pid_tid_unified_namespace_and_reset() {
        use crate::scheduler::MAIN_PID;
        let mut state = HostState::new(VirtualFs::new_in_memory(&[]));

        // Interleaved alloc_pid() and alloc_tid() must share one strictly
        // monotonic, disjoint namespace starting at MAIN_PID + 1.
        let p1 = state.alloc_pid();
        let p2 = state.alloc_pid();
        let t1 = state.alloc_tid();
        let t2 = state.alloc_tid();
        let p3 = state.alloc_pid();
        let t3 = state.alloc_tid();

        assert_eq!(
            [p1, p2, t1, t2, p3, t3],
            [
                MAIN_PID + 1,
                MAIN_PID + 2,
                MAIN_PID + 3,
                MAIN_PID + 4,
                MAIN_PID + 5,
                MAIN_PID + 6,
            ]
        );
        assert_eq!(state.next_pid, MAIN_PID + 7);
        assert_eq!(state.next_tid, MAIN_PID + 7);

        // reset_for_new_run() must reset both counters cleanly to MAIN_PID + 1
        // and subsequent interleaved allocations must remain disjoint.
        state.reset_for_new_run();
        assert_eq!(state.next_pid, MAIN_PID + 1);
        assert_eq!(state.next_tid, MAIN_PID + 1);

        let rt1 = state.alloc_tid();
        let rp1 = state.alloc_pid();
        let rt2 = state.alloc_tid();
        let rp2 = state.alloc_pid();
        assert_eq!(
            [rt1, rp1, rt2, rp2],
            [MAIN_PID + 1, MAIN_PID + 2, MAIN_PID + 3, MAIN_PID + 4]
        );
        assert_eq!(state.next_pid, MAIN_PID + 5);
        assert_eq!(state.next_tid, MAIN_PID + 5);
    }

    fn insert_child_process(state: &mut HostState, child_pid: i32, zombie: bool, exit_status: i32) {
        use crate::scheduler::{Scheduler, MAIN_PID};
        use crate::syscalls::{MmapAllocator, ProcessState};
        use std::collections::BTreeMap;
        state.processes.insert(
            child_pid,
            ProcessState {
                pid: child_pid,
                ppid: MAIN_PID,
                pgid: MAIN_PID,
                sid: MAIN_PID,
                umask: 0o022,
                fds: BTreeMap::new(),
                next_fd: 3,
                cwd: "/".to_string(),
                elf_path: String::new(),
                so_entries: Vec::new(),
                brk_start: 0,
                brk_curr: 0,
                mmap_start: 0,
                mmap_end: 0,
                mmap_alloc: MmapAllocator::new(),
                scheduler: Scheduler::new(),
                sig_handlers: BTreeMap::new(),
                exited: zombie,
                zombie,
                exit_status,
                vfork_parent: None,
            },
        );
    }

    #[test]
    fn test_waitid_wnowait_immediate_and_wait4() {
        let mut state = HostState::new(VirtualFs::new_in_memory(&[]));
        state.multiproc_enabled = true;
        let mut ctx = MockCtx::new(0x0B00_0000);
        let child_pid = 1001;
        insert_child_process(&mut state, child_pid, true, 42 << 8);

        // waitid(P_PID=1, child_pid, infop=0x2000, WEXITED|WNOWAIT, rusage=0x2100)
        const WEXITED: i64 = 4;
        const WNOWAIT: i64 = 0x0100_0000;
        let ret = handle_syscall(
            &mut ctx,
            &mut state,
            247, /* SYS_WAITID */
            1,
            child_pid as i64,
            0x2000,
            WEXITED | WNOWAIT,
            0x2100,
            0,
        );
        assert_eq!(ret, 0);
        let mut si = [0u8; 128];
        ctx.mem_read(0x2000, &mut si).unwrap();
        assert_eq!(i32::from_le_bytes(si[0..4].try_into().unwrap()), 17); // SIGCHLD
        assert_eq!(i32::from_le_bytes(si[8..12].try_into().unwrap()), 1); // CLD_EXITED
        assert_eq!(i32::from_le_bytes(si[16..20].try_into().unwrap()), child_pid);
        assert_eq!(i32::from_le_bytes(si[24..28].try_into().unwrap()), 42);
        // Zombie must still remain in processes because WNOWAIT was set!
        assert!(state.processes.contains_key(&child_pid));

        // Subsequent wait4(child_pid, &wstatus, 0, 0) reaps it and returns child_pid
        let w4 = handle_syscall(
            &mut ctx,
            &mut state,
            61, /* SYS_WAIT4 */
            child_pid as i64,
            0x2200,
            0,
            0,
            0,
            0,
        );
        assert_eq!(w4, child_pid as i64);
        let mut ws = [0u8; 4];
        ctx.mem_read(0x2200, &mut ws).unwrap();
        assert_eq!(i32::from_le_bytes(ws), 42 << 8);
        assert!(!state.processes.contains_key(&child_pid));

        // Third wait4 returns -ECHILD (-10)
        let w4_again = handle_syscall(&mut ctx, &mut state, 61, child_pid as i64, 0, 0, 0, 0, 0);
        assert_eq!(w4_again, -10);
    }

    #[test]
    fn test_waitid_wnowait_blocking_and_wait4() {
        use crate::scheduler::{ThreadState, MAIN_TID};
        let mut state = HostState::new(VirtualFs::new_in_memory(&[]));
        state.multiproc_enabled = true;
        let mut ctx = MockCtx::new(0x0B00_0000);
        let child_pid = 1002;
        insert_child_process(&mut state, child_pid, false, 0);

        const WEXITED: i64 = 4;
        const WNOWAIT: i64 = 0x0100_0000;
        let ret = handle_syscall(
            &mut ctx,
            &mut state,
            247, /* SYS_WAITID */
            1,
            child_pid as i64,
            0x2000,
            WEXITED | WNOWAIT,
            0,
            0,
        );
        assert_eq!(ret, 0);
        assert_eq!(ctx.yield_flag, 1);
        assert!(matches!(
            state.scheduler.threads.get(&MAIN_TID).unwrap().state,
            ThreadState::Wait4Wait { options, .. } if options == (WEXITED | WNOWAIT) as i32
        ));

        // Now child becomes a zombie with exit code 7
        {
            let c = state.processes.get_mut(&child_pid).unwrap();
            c.exited = true;
            c.zombie = true;
            c.exit_status = 7 << 8;
        }
        // Drive multiproc yield handler to wake parent and complete PendingWakeup::Wait4
        let action = state.on_yield_multiproc(&mut ctx, 1).unwrap();
        assert_eq!(action, 1);
        let mut si = [0u8; 128];
        ctx.mem_read(0x2000, &mut si).unwrap();
        assert_eq!(i32::from_le_bytes(si[16..20].try_into().unwrap()), child_pid);
        assert_eq!(i32::from_le_bytes(si[24..28].try_into().unwrap()), 7);
        assert!(state.processes.contains_key(&child_pid));

        // Subsequent wait4 reaps child
        let w4 = handle_syscall(&mut ctx, &mut state, 61, child_pid as i64, 0x2200, 0, 0, 0, 0);
        assert_eq!(w4, child_pid as i64);
        let mut ws = [0u8; 4];
        ctx.mem_read(0x2200, &mut ws).unwrap();
        assert_eq!(i32::from_le_bytes(ws), 7 << 8);
    }

    #[test]
    fn test_waitid_without_wnowait_reaps_and_cld_killed_and_einval() {
        let mut state = HostState::new(VirtualFs::new_in_memory(&[]));
        state.multiproc_enabled = true;
        let mut ctx = MockCtx::new(0x0B00_0000);
        let child_pid = 1003;
        // Signal 9 (SIGKILL) -> exit_status = 9
        insert_child_process(&mut state, child_pid, true, 9);

        // Invalid options (0) -> -EINVAL (-22)
        assert_eq!(
            handle_syscall(&mut ctx, &mut state, 247, 1, child_pid as i64, 0x2000, 0, 0, 0),
            -22
        );
        // Invalid idtype (99) -> -EINVAL (-22)
        assert_eq!(
            handle_syscall(&mut ctx, &mut state, 247, 99, child_pid as i64, 0x2000, 4, 0, 0),
            -22
        );
        // Invalid P_PID id (0) -> -EINVAL (-22)
        assert_eq!(
            handle_syscall(&mut ctx, &mut state, 247, 1, 0, 0x2000, 4, 0, 0),
            -22
        );

        // Without WNOWAIT: populates CLD_KILLED (2) + sig=9 and reaps child
        assert_eq!(
            handle_syscall(&mut ctx, &mut state, 247, 1, child_pid as i64, 0x2000, 4, 0, 0),
            0
        );
        let mut si = [0u8; 128];
        ctx.mem_read(0x2000, &mut si).unwrap();
        assert_eq!(i32::from_le_bytes(si[0..4].try_into().unwrap()), 17); // SIGCHLD
        assert_eq!(i32::from_le_bytes(si[8..12].try_into().unwrap()), 2); // CLD_KILLED
        assert_eq!(i32::from_le_bytes(si[24..28].try_into().unwrap()), 9); // SIGKILL
        assert!(!state.processes.contains_key(&child_pid));
        assert_eq!(
            handle_syscall(&mut ctx, &mut state, 61, child_pid as i64, 0, 0, 0, 0, 0),
            -10
        );
    }

    #[test]
    fn test_ipv4_tcp_loopback_full_lifecycle_and_epoll() {
        let mut state = HostState::new(VirtualFs::new_in_memory(&[]));
        let mut ctx = MockCtx::new(0x0B00_0000);

        let write_sa = |ctx: &mut MockCtx, addr: u64, ip: [u8; 4], port: u16| {
            let mut sa = [0u8; 16];
            sa[0..2].copy_from_slice(&2u16.to_le_bytes()); // AF_INET
            sa[2..4].copy_from_slice(&port.to_be_bytes());
            sa[4..8].copy_from_slice(&ip);
            ctx.mem_write(addr, &sa).unwrap();
        };

        // Create non-blocking listening socket
        let lfd = handle_syscall(&mut ctx, &mut state, 41 /* socket */, 2, 1 | 0x800 | 0x80000, 0, 0, 0, 0) as i32;
        assert!(lfd >= 3);

        // setsockopt(SO_REUSEADDR=1) & getsockopt
        ctx.mem_write(0x1000, &1i32.to_le_bytes()).unwrap();
        assert_eq!(handle_syscall(&mut ctx, &mut state, 54 /* setsockopt */, lfd as i64, 1, 2, 0x1000, 4, 0), 0);
        ctx.mem_write(0x1010, &4u32.to_le_bytes()).unwrap();
        assert_eq!(handle_syscall(&mut ctx, &mut state, 55 /* getsockopt */, lfd as i64, 1, 2, 0x1004, 0x1010, 0), 0);
        let mut optv = [0u8; 4];
        ctx.mem_read(0x1004, &mut optv).unwrap();
        assert_eq!(i32::from_le_bytes(optv), 1);

        // Bind to 127.0.0.1:0 (ephemeral port)
        write_sa(&mut ctx, 0x1100, [127, 0, 0, 1], 0);
        assert_eq!(handle_syscall(&mut ctx, &mut state, 49 /* bind */, lfd as i64, 0x1100, 16, 0, 0, 0), 0);

        // getsockname -> non-zero ephemeral port
        ctx.mem_write(0x1120, &16u32.to_le_bytes()).unwrap();
        assert_eq!(handle_syscall(&mut ctx, &mut state, 51 /* getsockname */, lfd as i64, 0x1110, 0x1120, 0, 0, 0), 0);
        let mut sa_out = [0u8; 16];
        ctx.mem_read(0x1110, &mut sa_out).unwrap();
        let port = u16::from_be_bytes([sa_out[2], sa_out[3]]);
        assert!(port >= 32768);

        // Duplicate bind on same port -> -EADDRINUSE (-98)
        let dup_fd = handle_syscall(&mut ctx, &mut state, 41, 2, 1, 0, 0, 0, 0) as i32;
        write_sa(&mut ctx, 0x1130, [127, 0, 0, 1], port);
        assert_eq!(handle_syscall(&mut ctx, &mut state, 49, dup_fd as i64, 0x1130, 16, 0, 0, 0), -98);
        assert_eq!(handle_syscall(&mut ctx, &mut state, 3, dup_fd as i64, 0, 0, 0, 0, 0), 0);

        // listen
        assert_eq!(handle_syscall(&mut ctx, &mut state, 50 /* listen */, lfd as i64, 16, 0, 0, 0, 0), 0);

        // Non-blocking accept4 with empty queue -> -EAGAIN (-11)
        assert_eq!(handle_syscall(&mut ctx, &mut state, 288 /* accept4 */, lfd as i64, 0, 0, 0x800, 0, 0), -11);

        // Register listener on epoll with EPOLLET | EPOLLIN
        let epfd = handle_syscall(&mut ctx, &mut state, 291 /* epoll_create1 */, 0, 0, 0, 0, 0, 0) as i32;
        let mut ev = [0u8; 12];
        ev[0..4].copy_from_slice(&(0x8000_0001u32).to_le_bytes()); // EPOLLET | EPOLLIN
        ev[4..12].copy_from_slice(&0xCAFEu64.to_le_bytes());
        ctx.mem_write(0x1200, &ev).unwrap();
        assert_eq!(handle_syscall(&mut ctx, &mut state, 233 /* epoll_ctl */, epfd as i64, 1, lfd as i64, 0x1200, 0, 0), 0);
        // No pending connections -> epoll_wait returns 0
        assert_eq!(handle_syscall(&mut ctx, &mut state, 232 /* epoll_wait */, epfd as i64, 0x1220, 8, 0, 0, 0), 0);

        // Connect to unused port -> -ECONNREFUSED (-111)
        let cfd = handle_syscall(&mut ctx, &mut state, 41, 2, 1 | 0x800, 0, 0, 0, 0) as i32;
        write_sa(&mut ctx, 0x1140, [127, 0, 0, 1], 19999);
        assert_eq!(handle_syscall(&mut ctx, &mut state, 42 /* connect */, cfd as i64, 0x1140, 16, 0, 0, 0), -111);

        // Connect to listening port -> succeeds (0)
        write_sa(&mut ctx, 0x1140, [127, 0, 0, 1], port);
        assert_eq!(handle_syscall(&mut ctx, &mut state, 42 /* connect */, cfd as i64, 0x1140, 16, 0, 0, 0), 0);

        // getsockopt(SO_ERROR) == 0, setsockopt(TCP_NODELAY=1)
        ctx.mem_write(0x1010, &4u32.to_le_bytes()).unwrap();
        assert_eq!(handle_syscall(&mut ctx, &mut state, 55, cfd as i64, 1, 4, 0x1004, 0x1010, 0), 0);
        ctx.mem_read(0x1004, &mut optv).unwrap();
        assert_eq!(i32::from_le_bytes(optv), 0);
        ctx.mem_write(0x1000, &1i32.to_le_bytes()).unwrap();
        assert_eq!(handle_syscall(&mut ctx, &mut state, 54, cfd as i64, 6, 1, 0x1000, 4, 0), 0);

        // epoll_wait on listener now reports EPOLLIN (1 event)
        assert_eq!(handle_syscall(&mut ctx, &mut state, 232, epfd as i64, 0x1220, 8, 0, 0, 0), 1);
        let mut out_ev = [0u8; 12];
        ctx.mem_read(0x1220, &mut out_ev).unwrap();
        assert_eq!(u32::from_le_bytes(out_ev[0..4].try_into().unwrap()) & 1, 1);
        assert_eq!(u64::from_le_bytes(out_ev[4..12].try_into().unwrap()), 0xCAFE);

        // accept4 returns server-side connected FD + client sockaddr_in
        ctx.mem_write(0x1160, &16u32.to_le_bytes()).unwrap();
        let sfd = handle_syscall(&mut ctx, &mut state, 288, lfd as i64, 0x1150, 0x1160, 0x800, 0, 0) as i32;
        assert!(sfd >= 3);

        // getpeername on client returns listening port
        ctx.mem_write(0x1180, &16u32.to_le_bytes()).unwrap();
        assert_eq!(handle_syscall(&mut ctx, &mut state, 52 /* getpeername */, cfd as i64, 0x1170, 0x1180, 0, 0, 0), 0);
        ctx.mem_read(0x1170, &mut sa_out).unwrap();
        assert_eq!(u16::from_be_bytes([sa_out[2], sa_out[3]]), port);

        // Bidirectional sendto/recvfrom + write/read
        ctx.mem_write(0x1300, b"ping").unwrap();
        assert_eq!(handle_syscall(&mut ctx, &mut state, 44 /* sendto */, cfd as i64, 0x1300, 4, 0, 0, 0), 4);
        assert_eq!(handle_syscall(&mut ctx, &mut state, 45 /* recvfrom */, sfd as i64, 0x1310, 16, 0, 0, 0), 4);
        let mut buf = [0u8; 4];
        ctx.mem_read(0x1310, &mut buf).unwrap();
        assert_eq!(&buf, b"ping");

        ctx.mem_write(0x1320, b"pong").unwrap();
        assert_eq!(handle_syscall(&mut ctx, &mut state, 1 /* write */, sfd as i64, 0x1320, 4, 0, 0, 0), 4);
        assert_eq!(handle_syscall(&mut ctx, &mut state, 0 /* read */, cfd as i64, 0x1330, 16, 0, 0, 0), 4);
        ctx.mem_read(0x1330, &mut buf).unwrap();
        assert_eq!(&buf, b"pong");

        // Non-blocking read with empty buffer -> -EAGAIN (-11)
        assert_eq!(handle_syscall(&mut ctx, &mut state, 0, cfd as i64, 0x1330, 16, 0, 0, 0), -11);

        // shutdown(SHUT_WR) on server -> client sees EOF (0) and EPOLLIN|EPOLLRDHUP
        assert_eq!(handle_syscall(&mut ctx, &mut state, 48 /* shutdown */, sfd as i64, 1, 0, 0, 0, 0), 0);
        assert_eq!(handle_syscall(&mut ctx, &mut state, 0, cfd as i64, 0x1330, 16, 0, 0, 0), 0);

        // Cleanup
        assert_eq!(handle_syscall(&mut ctx, &mut state, 3, cfd as i64, 0, 0, 0, 0, 0), 0);
        assert_eq!(handle_syscall(&mut ctx, &mut state, 3, sfd as i64, 0, 0, 0, 0, 0), 0);
        assert_eq!(handle_syscall(&mut ctx, &mut state, 3, lfd as i64, 0, 0, 0, 0, 0), 0);
        assert_eq!(handle_syscall(&mut ctx, &mut state, 3, epfd as i64, 0, 0, 0, 0, 0), 0);
    }

    #[test]
    fn test_fallocate_and_map_shared_writeback() {
        let mut state = HostState::new(VirtualFs::new_in_memory(&[]));
        let mut ctx = MockCtx::new(0x0B00_0000);

        // Create writable output file via openat(AT_FDCWD, "/tmp/out.bin", O_RDWR|O_CREAT|O_TRUNC, 0755)
        write_cstr(&mut ctx, 0x1000, "/tmp/out.bin");
        let fd = handle_syscall(
            &mut ctx,
            &mut state,
            257, /* openat */
            -100,
            0x1000,
            0x2 | 0x40 | 0x200,
            0o755,
            0,
            0,
        ) as i32;
        assert!(fd >= 3);

        // fallocate(fd, 0, 0, 4096) extends file to 4096 zero bytes
        assert_eq!(
            handle_syscall(&mut ctx, &mut state, 285 /* fallocate */, fd as i64, 0, 0, 4096, 0, 0),
            0
        );
        assert_eq!(state.vfs.vfs_read_file("/tmp/out.bin").unwrap().len(), 4096);

        // mmap(0, 4096, PROT_READ|PROT_WRITE (3), MAP_SHARED (1), fd, 0)
        let addr = handle_syscall(&mut ctx, &mut state, 9 /* mmap */, 0, 4096, 3, 1, fd as i64, 0);
        assert!(addr > 0);

        // Write ELF magic into mapped memory
        ctx.mem_write(addr as u64, b"\x7fELFlinked").unwrap();

        // msync flushes changes to VFS immediately
        assert_eq!(handle_syscall(&mut ctx, &mut state, 26 /* msync */, addr, 4096, 4, 0, 0, 0), 0);
        assert_eq!(&state.vfs.vfs_read_file("/tmp/out.bin").unwrap()[..10], b"\x7fELFlinked");

        // Modify again and munmap -> flushes final bytes to VFS
        ctx.mem_write(addr as u64 + 10, b"!").unwrap();
        assert_eq!(handle_syscall(&mut ctx, &mut state, 11 /* munmap */, addr, 4096, 0, 0, 0, 0), 0);
        assert_eq!(&state.vfs.vfs_read_file("/tmp/out.bin").unwrap()[..11], b"\x7fELFlinked!");
        assert_eq!(handle_syscall(&mut ctx, &mut state, 3, fd as i64, 0, 0, 0, 0, 0), 0);
    }

    #[test]
    fn test_fallocate_fd_types_ro_and_4gib_overflow() {
        let mut state = HostState::new(VirtualFs::new_in_memory(&[]));
        let mut ctx = MockCtx::new(0x0B00_0000);
        const SYS_FALLOCATE: i64 = 285;
        const SYS_FTRUNCATE: i64 = 77;
        const FALLOC_FL_KEEP_SIZE: i64 = 1;

        // Pipe -> -ESPIPE (-29) for both mode=0 and FALLOC_FL_KEEP_SIZE
        assert_eq!(handle_syscall(&mut ctx, &mut state, 293 /* pipe2 */, 0x1000, 0, 0, 0, 0, 0), 0);
        let mut pfd = [0u8; 8];
        ctx.mem_read(0x1000, &mut pfd).unwrap();
        let pr = i32::from_le_bytes(pfd[0..4].try_into().unwrap());
        let pw = i32::from_le_bytes(pfd[4..8].try_into().unwrap());
        assert_eq!(handle_syscall(&mut ctx, &mut state, SYS_FALLOCATE, pr as i64, 0, 0, 100, 0, 0), -29);
        assert_eq!(handle_syscall(&mut ctx, &mut state, SYS_FALLOCATE, pw as i64, 0, 0, 100, 0, 0), -29);
        assert_eq!(handle_syscall(&mut ctx, &mut state, SYS_FALLOCATE, pw as i64, FALLOC_FL_KEEP_SIZE, 0, 100, 0, 0), -29);

        // TCP socket -> -ENODEV (-19) for both mode=0 and FALLOC_FL_KEEP_SIZE
        let sfd = handle_syscall(&mut ctx, &mut state, 41 /* socket */, 2, 1, 0, 0, 0, 0) as i32;
        assert!(sfd >= 3);
        assert_eq!(handle_syscall(&mut ctx, &mut state, SYS_FALLOCATE, sfd as i64, 0, 0, 100, 0, 0), -19);
        assert_eq!(handle_syscall(&mut ctx, &mut state, SYS_FALLOCATE, sfd as i64, FALLOC_FL_KEEP_SIZE, 0, 100, 0, 0), -19);

        // stdout (fd 1) and directory -> -ENODEV (-19)
        assert_eq!(handle_syscall(&mut ctx, &mut state, SYS_FALLOCATE, 1, 0, 0, 100, 0, 0), -19);
        write_cstr(&mut ctx, 0x1020, "/tmp");
        let dfd = handle_syscall(&mut ctx, &mut state, 257 /* openat */, -100, 0x1020, 0x10000 /* O_DIRECTORY */, 0, 0, 0) as i32;
        assert!(dfd >= 3);
        assert_eq!(handle_syscall(&mut ctx, &mut state, SYS_FALLOCATE, dfd as i64, 0, 0, 100, 0, 0), -19);
        assert_eq!(handle_syscall(&mut ctx, &mut state, SYS_FALLOCATE, dfd as i64, FALLOC_FL_KEEP_SIZE, 0, 100, 0, 0), -19);

        // O_RDONLY regular file -> -EBADF (-9) for both mode=0 and FALLOC_FL_KEEP_SIZE
        write_cstr(&mut ctx, 0x1040, "/tmp/ro.bin");
        let wfd = handle_syscall(&mut ctx, &mut state, 257, -100, 0x1040, 0x2 | 0x40 | 0x200, 0o644, 0, 0) as i32;
        assert!(wfd >= 3);
        let rfd = handle_syscall(&mut ctx, &mut state, 257, -100, 0x1040, 0 /* O_RDONLY */, 0, 0, 0) as i32;
        assert!(rfd >= 3);
        assert_eq!(handle_syscall(&mut ctx, &mut state, SYS_FALLOCATE, rfd as i64, 0, 0, 100, 0, 0), -9);
        assert_eq!(handle_syscall(&mut ctx, &mut state, SYS_FALLOCATE, rfd as i64, FALLOC_FL_KEEP_SIZE, 0, 100, 0, 0), -9);

        // >4 GiB (u32 overflow on wasm32) -> -EINVAL (-22) for both fallocate and ftruncate
        let over_4gib: i64 = (1i64 << 32) + 4096;
        assert_eq!(handle_syscall(&mut ctx, &mut state, SYS_FALLOCATE, wfd as i64, 0, 0, over_4gib, 0, 0), -22);
        assert_eq!(handle_syscall(&mut ctx, &mut state, SYS_FALLOCATE, wfd as i64, FALLOC_FL_KEEP_SIZE, 1i64 << 32, 4096, 0, 0), -22);
        assert_eq!(handle_syscall(&mut ctx, &mut state, SYS_FTRUNCATE, wfd as i64, over_4gib, 0, 0, 0, 0), -22);
    }

    #[test]
    fn test_map_shared_partial_munmap_and_eof_clamping() {
        let mut state = HostState::new(VirtualFs::new_in_memory(&[]));
        let mut ctx = MockCtx::new(0x0B00_0000);

        // Part A: partial munmap of 8192-byte MAP_SHARED mapping preserves second-half writeback
        write_cstr(&mut ctx, 0x1000, "/tmp/partial.bin");
        let fd = handle_syscall(&mut ctx, &mut state, 257, -100, 0x1000, 0x2 | 0x40 | 0x200, 0o644, 0, 0) as i32;
        assert_eq!(handle_syscall(&mut ctx, &mut state, 285 /* fallocate */, fd as i64, 0, 0, 8192, 0, 0), 0);
        let addr = handle_syscall(&mut ctx, &mut state, 9 /* mmap */, 0, 8192, 3, 1 /* MAP_SHARED */, fd as i64, 0);
        assert!(addr > 0);

        ctx.mem_write(addr as u64, b"FIRST_HALF").unwrap();
        // Unmap only the first 4096 bytes
        assert_eq!(handle_syscall(&mut ctx, &mut state, 11 /* munmap */, addr, 4096, 0, 0, 0, 0), 0);
        assert_eq!(&state.vfs.vfs_read_file("/tmp/partial.bin").unwrap()[0..10], b"FIRST_HALF");

        // Write to the still-mapped second 4096 bytes, then unmap it
        ctx.mem_write(addr as u64 + 4096, b"SECOND_HALF").unwrap();
        assert_eq!(handle_syscall(&mut ctx, &mut state, 11 /* munmap */, addr + 4096, 4096, 0, 0, 0, 0), 0);
        let data = state.vfs.vfs_read_file("/tmp/partial.bin").unwrap();
        assert_eq!(data.len(), 8192);
        assert_eq!(&data[0..10], b"FIRST_HALF");
        assert_eq!(&data[4096..4107], b"SECOND_HALF");

        // Part B: 100-byte file mapped with 4096 bytes preserves file size 100 on writeback
        write_cstr(&mut ctx, 0x1040, "/tmp/small100.bin");
        let fd2 = handle_syscall(&mut ctx, &mut state, 257, -100, 0x1040, 0x2 | 0x40 | 0x200, 0o644, 0, 0) as i32;
        assert_eq!(handle_syscall(&mut ctx, &mut state, 285, fd2 as i64, 0, 0, 100, 0, 0), 0);
        let addr2 = handle_syscall(&mut ctx, &mut state, 9, 0, 4096, 3, 1, fd2 as i64, 0);
        assert!(addr2 > 0);
        ctx.mem_write(addr2 as u64, b"AB").unwrap();
        ctx.mem_write(addr2 as u64 + 99, b"Z").unwrap();
        ctx.mem_write(addr2 as u64 + 200, b"PAST_EOF").unwrap();
        assert_eq!(handle_syscall(&mut ctx, &mut state, 11, addr2, 4096, 0, 0, 0, 0), 0);
        let small = state.vfs.vfs_read_file("/tmp/small100.bin").unwrap();
        assert_eq!(small.len(), 100);
        assert_eq!(&small[0..2], b"AB");
        assert_eq!(small[99], b'Z');
    }

    #[test]
    fn test_recvmsg_scatter_gather_and_eagain_preserves_msghdr() {
        let mut state = HostState::new(VirtualFs::new_in_memory(&[]));
        let mut ctx = MockCtx::new(0x0B00_0000);

        // Set up connected TCP loopback pair (cfd, sfd)
        let lfd = handle_syscall(&mut ctx, &mut state, 41, 2, 1 | 0x800, 0, 0, 0, 0) as i32;
        let mut sa = [0u8; 16];
        sa[0..2].copy_from_slice(&2u16.to_le_bytes());
        sa[4..8].copy_from_slice(&[127, 0, 0, 1]);
        ctx.mem_write(0x1000, &sa).unwrap();
        assert_eq!(handle_syscall(&mut ctx, &mut state, 49, lfd as i64, 0x1000, 16, 0, 0, 0), 0);
        ctx.mem_write(0x1020, &16u32.to_le_bytes()).unwrap();
        assert_eq!(handle_syscall(&mut ctx, &mut state, 51, lfd as i64, 0x1010, 0x1020, 0, 0, 0), 0);
        ctx.mem_read(0x1010, &mut sa).unwrap();
        let port = u16::from_be_bytes([sa[2], sa[3]]);
        assert_eq!(handle_syscall(&mut ctx, &mut state, 50, lfd as i64, 8, 0, 0, 0, 0), 0);

        let cfd = handle_syscall(&mut ctx, &mut state, 41, 2, 1 | 0x800, 0, 0, 0, 0) as i32;
        sa[2..4].copy_from_slice(&port.to_be_bytes());
        ctx.mem_write(0x1030, &sa).unwrap();
        assert_eq!(handle_syscall(&mut ctx, &mut state, 42, cfd as i64, 0x1030, 16, 0, 0, 0), 0);
        let sfd = handle_syscall(&mut ctx, &mut state, 288, lfd as i64, 0, 0, 0x800, 0, 0) as i32;
        assert!(sfd >= 3);

        // Prepare 2 iovecs: [0x2000, len=4] and [0x2100, len=6]
        let mut iovs = [0u8; 32];
        iovs[0..8].copy_from_slice(&0x2000u64.to_le_bytes());
        iovs[8..16].copy_from_slice(&4u64.to_le_bytes());
        iovs[16..24].copy_from_slice(&0x2100u64.to_le_bytes());
        iovs[24..32].copy_from_slice(&6u64.to_le_bytes());
        ctx.mem_write(0x1200, &iovs).unwrap();

        // Prepare msghdr at 0x1300 with sentinel msg_controllen=0x1234, msg_flags=0x5678
        let mut msg = [0u8; 56];
        msg[16..24].copy_from_slice(&0x1200u64.to_le_bytes());
        msg[24..32].copy_from_slice(&2u64.to_le_bytes());
        msg[40..48].copy_from_slice(&0x1234u64.to_le_bytes());
        msg[48..52].copy_from_slice(&0x5678i32.to_le_bytes());
        ctx.mem_write(0x1300, &msg).unwrap();

        // Empty non-blocking socket -> -EAGAIN (-11), msghdr sentinels untouched
        assert_eq!(handle_syscall(&mut ctx, &mut state, 47 /* recvmsg */, sfd as i64, 0x1300, 0, 0, 0, 0), -11);
        let mut msg_after = [0u8; 56];
        ctx.mem_read(0x1300, &mut msg_after).unwrap();
        assert_eq!(u64::from_le_bytes(msg_after[40..48].try_into().unwrap()), 0x1234);
        assert_eq!(i32::from_le_bytes(msg_after[48..52].try_into().unwrap()), 0x5678);

        // Send 10 bytes across both iovecs -> returns 10 and zeroes msg_controllen/msg_flags
        ctx.mem_write(0x1400, b"HEAD_BODY!").unwrap();
        assert_eq!(handle_syscall(&mut ctx, &mut state, 44 /* sendto */, cfd as i64, 0x1400, 10, 0, 0, 0), 10);
        assert_eq!(handle_syscall(&mut ctx, &mut state, 47 /* recvmsg */, sfd as i64, 0x1300, 0, 0, 0, 0), 10);
        let mut b0 = [0u8; 4];
        let mut b1 = [0u8; 6];
        ctx.mem_read(0x2000, &mut b0).unwrap();
        ctx.mem_read(0x2100, &mut b1).unwrap();
        assert_eq!(&b0, b"HEAD");
        assert_eq!(&b1, b"_BODY!");
        ctx.mem_read(0x1300, &mut msg_after).unwrap();
        assert_eq!(u64::from_le_bytes(msg_after[40..48].try_into().unwrap()), 0);
        assert_eq!(i32::from_le_bytes(msg_after[48..52].try_into().unwrap()), 0);

        // Partial scatter-gather (6 bytes into 4+6) -> returns 6 without blocking
        ctx.mem_write(0x1400, b"ABCDEF").unwrap();
        assert_eq!(handle_syscall(&mut ctx, &mut state, 44, cfd as i64, 0x1400, 6, 0, 0, 0), 6);
        assert_eq!(handle_syscall(&mut ctx, &mut state, 47, sfd as i64, 0x1300, 0, 0, 0, 0), 6);
        ctx.mem_read(0x2000, &mut b0).unwrap();
        ctx.mem_read(0x2100, &mut b1).unwrap();
        assert_eq!(&b0, b"ABCD");
        assert_eq!(&b1[..2], b"EF");
    }

    #[test]
    fn test_tcp_socket_close_wakeups_on_exit_execve_and_dup2() {
        use crate::scheduler::{ThreadContext, ThreadState, MAIN_PID, MAIN_TID};

        let make_connected_pair = |ctx: &mut MockCtx, state: &mut HostState, client_cloexec: bool| -> (i32, i32, i32) {
            let lfd = handle_syscall(ctx, state, 41, 2, 1 | 0x800, 0, 0, 0, 0) as i32;
            let mut sa = [0u8; 16];
            sa[0..2].copy_from_slice(&2u16.to_le_bytes());
            sa[4..8].copy_from_slice(&[127, 0, 0, 1]);
            ctx.mem_write(0x1000, &sa).unwrap();
            assert_eq!(handle_syscall(ctx, state, 49, lfd as i64, 0x1000, 16, 0, 0, 0), 0);
            ctx.mem_write(0x1020, &16u32.to_le_bytes()).unwrap();
            assert_eq!(handle_syscall(ctx, state, 51, lfd as i64, 0x1010, 0x1020, 0, 0, 0), 0);
            ctx.mem_read(0x1010, &mut sa).unwrap();
            let port = u16::from_be_bytes([sa[2], sa[3]]);
            assert_eq!(handle_syscall(ctx, state, 50, lfd as i64, 8, 0, 0, 0, 0), 0);
            let flags = 1 | if client_cloexec { 0x80000 } else { 0 };
            let cfd = handle_syscall(ctx, state, 41, 2, flags, 0, 0, 0, 0) as i32;
            sa[2..4].copy_from_slice(&port.to_be_bytes());
            ctx.mem_write(0x1030, &sa).unwrap();
            assert_eq!(handle_syscall(ctx, state, 42, cfd as i64, 0x1030, 16, 0, 0, 0), 0);
            let sfd = handle_syscall(ctx, state, 288, lfd as i64, 0, 0, 0, 0, 0) as i32;
            (lfd, cfd, sfd)
        };

        // 1. SYS_DUP2 overwriting TCP client socket wakes peer thread in PipeReadWait
        {
            let mut state = HostState::new(VirtualFs::new_in_memory(&[]));
            let mut ctx = MockCtx::new(0x0B00_0000);
            let (lfd, cfd, sfd) = make_connected_pair(&mut ctx, &mut state, false);
            let t2 = 2001;
            state.scheduler.threads.insert(t2, ThreadContext::new(t2));
            state.scheduler.current_tid = t2;
            // Blocking read on sfd -> enters PipeReadWait
            assert_eq!(handle_syscall(&mut ctx, &mut state, 0 /* read */, sfd as i64, 0x2000, 16, 0, 0, 0), 0);
            assert!(matches!(state.scheduler.threads[&t2].state, ThreadState::PipeReadWait { .. }));
            // Main thread overwrites cfd with dup2(1, cfd)
            state.scheduler.current_tid = MAIN_TID;
            assert_eq!(handle_syscall(&mut ctx, &mut state, 33 /* dup2 */, 1, cfd as i64, 0, 0, 0, 0), cfd as i64);
            assert_eq!(state.scheduler.threads[&t2].state, ThreadState::Runnable);

            // Also verify dup2 overwriting listener wakes AcceptWait
            let t3 = 2002;
            state.scheduler.threads.insert(t3, ThreadContext::new(t3));
            state.scheduler.current_tid = t3;
            let lfd_blocking = handle_syscall(&mut ctx, &mut state, 41, 2, 1, 0, 0, 0, 0) as i32;
            let mut sa = [0u8; 16];
            sa[0..2].copy_from_slice(&2u16.to_le_bytes());
            sa[4..8].copy_from_slice(&[127, 0, 0, 1]);
            ctx.mem_write(0x1050, &sa).unwrap();
            assert_eq!(handle_syscall(&mut ctx, &mut state, 49, lfd_blocking as i64, 0x1050, 16, 0, 0, 0), 0);
            assert_eq!(handle_syscall(&mut ctx, &mut state, 50, lfd_blocking as i64, 8, 0, 0, 0, 0), 0);
            assert_eq!(handle_syscall(&mut ctx, &mut state, 43 /* accept */, lfd_blocking as i64, 0, 0, 0, 0, 0), 0);
            assert!(matches!(state.scheduler.threads[&t3].state, ThreadState::AcceptWait { .. }));
            state.scheduler.current_tid = MAIN_TID;
            assert_eq!(handle_syscall(&mut ctx, &mut state, 33, 1, lfd_blocking as i64, 0, 0, 0, 0), lfd_blocking as i64);
            assert_eq!(state.scheduler.threads[&t3].state, ThreadState::Runnable);
            let _ = lfd;
        }

        // 2. do_execve closing O_CLOEXEC TCP socket wakes peer waiter in another process
        {
            let mut elf = vec![0u8; 120];
            elf[0..4].copy_from_slice(b"\x7fELF");
            elf[4] = 2; // ELFCLASS64
            elf[5] = 1; // ELFDATA2LSB
            elf[6] = 1; // EV_CURRENT
            elf[16..18].copy_from_slice(&2u16.to_le_bytes()); // ET_EXEC
            elf[18..20].copy_from_slice(&62u16.to_le_bytes()); // EM_X86_64
            elf[32..40].copy_from_slice(&64u64.to_le_bytes()); // e_phoff
            elf[54..56].copy_from_slice(&56u16.to_le_bytes()); // e_phentsize
            elf[56..58].copy_from_slice(&1u16.to_le_bytes()); // e_phnum
            elf[64..68].copy_from_slice(&1u32.to_le_bytes()); // PT_LOAD
            elf[68..72].copy_from_slice(&5u32.to_le_bytes()); // PF_R | PF_X
            elf[72..80].copy_from_slice(&0u64.to_le_bytes()); // p_offset
            elf[96..104].copy_from_slice(&120u64.to_le_bytes()); // p_filesz
            elf[104..112].copy_from_slice(&120u64.to_le_bytes()); // p_memsz
            let mut state = HostState::new(VirtualFs::new_in_memory(&[]));
            state.vfs.vfs_write_file("/bin/dummy", &elf, 0o755);
            state.multiproc_enabled = true;
            let mut ctx = MockCtx::new(0x0B00_0000);
            let (_lfd, cfd, sfd) = make_connected_pair(&mut ctx, &mut state, true);
            let t2 = 2003;
            state.scheduler.threads.insert(t2, ThreadContext::new(t2));
            state.scheduler.current_tid = t2;
            assert_eq!(handle_syscall(&mut ctx, &mut state, 0, sfd as i64, 0x2000, 16, 0, 0, 0), 0);
            assert!(matches!(state.scheduler.threads[&t2].state, ThreadState::PipeReadWait { .. }));
            state.scheduler.current_tid = MAIN_TID;
            write_cstr(&mut ctx, 0x1500, "/bin/dummy");
            ctx.mem_write(0x1520, &0x1500u64.to_le_bytes()).unwrap();
            ctx.mem_write(0x1528, &0u64.to_le_bytes()).unwrap();
            ctx.mem_write(0x1530, &0u64.to_le_bytes()).unwrap();
            assert_eq!(handle_syscall(&mut ctx, &mut state, 59 /* execve */, 0x1500, 0x1520, 0x1530, 0, 0, 0), 0);
            assert!(state.vfs.get_fd(cfd).is_none());
            assert_eq!(state.scheduler.threads[&t2].state, ThreadState::Runnable);
        }

        // 3. exit_process closing TCP socket wakes parent process blocked in PipeReadWait
        {
            let mut state = HostState::new(VirtualFs::new_in_memory(&[]));
            state.multiproc_enabled = true;
            let mut ctx = MockCtx::new(0x0B00_0000);
            let (_lfd, cfd, sfd) = make_connected_pair(&mut ctx, &mut state, false);
            // Fork-like child holding only cfd; parent holds sfd and blocks in read(sfd)
            let child_pid = 1005;
            insert_child_process(&mut state, child_pid, false, 0);
            let cfd_file = state.vfs.get_fd(cfd).cloned().unwrap();
            state.processes.get_mut(&child_pid).unwrap().fds.insert(cfd, cfd_file);
            // Remove cfd from parent without dropping refcount (transferred ownership to child)
            state.vfs.fds.remove(&cfd);
            assert_eq!(handle_syscall(&mut ctx, &mut state, 0, sfd as i64, 0x2000, 16, 0, 0, 0), 0);
            assert!(matches!(state.scheduler.threads[&MAIN_TID].state, ThreadState::PipeReadWait { .. }));

            // Switch to child and exit_group(0) without explicitly closing cfd
            state.switch_active_process(child_pid);
            assert_eq!(handle_syscall(&mut ctx, &mut state, 231 /* exit_group */, 0, 0, 0, 0, 0, 0), 0);
            assert_eq!(
                state.processes[&MAIN_PID].scheduler.threads[&MAIN_TID].state,
                ThreadState::Runnable
            );
        }
    }

    #[test]
    fn test_waitid_wstopped_only_does_not_match_exited_zombie() {
        use crate::scheduler::{ThreadState, MAIN_TID};
        let mut state = HostState::new(VirtualFs::new_in_memory(&[]));
        state.multiproc_enabled = true;
        let mut ctx = MockCtx::new(0x0B00_0000);
        let child_pid = 1004;
        insert_child_process(&mut state, child_pid, true, 55 << 8);

        const WNOHANG: i64 = 1;
        const WSTOPPED: i64 = 2;
        const WEXITED: i64 = 4;

        // Pre-fill siginfo_t with 0xAA
        ctx.mem_write(0x2000, &[0xAAu8; 128]).unwrap();
        // waitid(P_PID, child_pid, infop, WSTOPPED | WNOHANG, 0) -> must NOT match exited zombie
        assert_eq!(
            handle_syscall(&mut ctx, &mut state, 247 /* SYS_WAITID */, 1, child_pid as i64, 0x2000, WSTOPPED | WNOHANG, 0, 0),
            0
        );
        let mut si = [0u8; 128];
        ctx.mem_read(0x2000, &mut si).unwrap();
        assert!(si.iter().all(|&b| b == 0));
        assert!(state.processes.contains_key(&child_pid));

        // Blocking waitid(P_PID, child_pid, infop, WSTOPPED, 0) -> blocks and is NOT woken by exited zombie
        assert_eq!(
            handle_syscall(&mut ctx, &mut state, 247, 1, child_pid as i64, 0x2000, WSTOPPED, 0, 0),
            0
        );
        assert_eq!(ctx.yield_flag, 1);
        assert!(matches!(state.scheduler.threads[&MAIN_TID].state, ThreadState::Wait4Wait { .. }));
        state.wake_ready_waiters();
        assert!(matches!(state.scheduler.threads[&MAIN_TID].state, ThreadState::Wait4Wait { .. }));
        assert!(state.processes.contains_key(&child_pid));

        // Reset thread to Runnable and call with WEXITED -> now matches and reaps zombie
        state.scheduler.threads.get_mut(&MAIN_TID).unwrap().state = ThreadState::Runnable;
        assert_eq!(
            handle_syscall(&mut ctx, &mut state, 247, 1, child_pid as i64, 0x2000, WEXITED, 0, 0),
            0
        );
        ctx.mem_read(0x2000, &mut si).unwrap();
        assert_eq!(i32::from_le_bytes(si[16..20].try_into().unwrap()), child_pid);
        assert_eq!(i32::from_le_bytes(si[24..28].try_into().unwrap()), 55);
        assert!(!state.processes.contains_key(&child_pid));
    }

    fn m16_make_tcp_pair(ctx: &mut MockCtx, state: &mut HostState, nonblock_server: bool) -> (i32, i32, i32) {
        let lfd = handle_syscall(ctx, state, 41 /* socket */, 2, 1 | 0x800, 0, 0, 0, 0) as i32;
        assert!(lfd >= 3);
        let mut sa = [0u8; 16];
        sa[0..2].copy_from_slice(&2u16.to_le_bytes()); // AF_INET
        sa[4..8].copy_from_slice(&[127, 0, 0, 1]);
        ctx.mem_write(0x1000, &sa).unwrap();
        assert_eq!(handle_syscall(ctx, state, 49 /* bind */, lfd as i64, 0x1000, 16, 0, 0, 0), 0);
        ctx.mem_write(0x1020, &16u32.to_le_bytes()).unwrap();
        assert_eq!(handle_syscall(ctx, state, 51 /* getsockname */, lfd as i64, 0x1010, 0x1020, 0, 0, 0), 0);
        ctx.mem_read(0x1010, &mut sa).unwrap();
        let port = u16::from_be_bytes([sa[2], sa[3]]);
        assert_eq!(handle_syscall(ctx, state, 50 /* listen */, lfd as i64, 16, 0, 0, 0, 0), 0);
        let cfd = handle_syscall(ctx, state, 41 /* socket */, 2, 1, 0, 0, 0, 0) as i32;
        sa[2..4].copy_from_slice(&port.to_be_bytes());
        ctx.mem_write(0x1030, &sa).unwrap();
        assert_eq!(handle_syscall(ctx, state, 42 /* connect */, cfd as i64, 0x1030, 16, 0, 0, 0), 0);
        let accept_flags = if nonblock_server { 0x800 } else { 0 };
        let sfd = handle_syscall(ctx, state, 288 /* accept4 */, lfd as i64, 0, 0, accept_flags, 0, 0) as i32;
        assert!(sfd >= 3);
        (lfd, cfd, sfd)
    }

    #[test]
    fn test_m16_zero_delay_backward_compat() {
        use crate::stack::LEGACY_AT_RANDOM;
        use crate::syscalls::LEGACY_PRNG_SEED;

        let mut state = HostState::new(VirtualFs::new_in_memory(&[]));
        let mut ctx = MockCtx::new(0x0B00_0000);

        assert_eq!(state.delay_stddev_ns, 0);
        assert!(!state.seed_configured);
        assert_eq!(state.vfs.prng_state, LEGACY_PRNG_SEED);
        assert_eq!(state.at_random_bytes(), LEGACY_AT_RANDOM);

        let (_lfd, cfd, sfd) = m16_make_tcp_pair(&mut ctx, &mut state, true);
        ctx.mem_write(0x2000, b"immediate").unwrap();
        assert_eq!(handle_syscall(&mut ctx, &mut state, 1 /* write */, cfd as i64, 0x2000, 9, 0, 0, 0), 9);
        assert!(state.min_in_flight_ns().is_none());

        let mut buf = [0u8; 9];
        assert_eq!(handle_syscall(&mut ctx, &mut state, 0 /* read */, sfd as i64, 0x2100, 9, 0, 0, 0), 9);
        ctx.mem_read(0x2100, &mut buf).unwrap();
        assert_eq!(&buf, b"immediate");

        // Switching to a non-zero delay config changes seeds; switching back to (0, 0) restores legacy behavior.
        state.set_delay_config(10_000_000, 42);
        assert!(state.seed_configured);
        assert_ne!(state.at_random_bytes(), LEGACY_AT_RANDOM);
        assert_ne!(state.vfs.prng_state, LEGACY_PRNG_SEED);

        state.set_delay_config(0, 0);
        assert!(!state.seed_configured);
        assert_eq!(state.at_random_bytes(), LEGACY_AT_RANDOM);
        assert_eq!(state.vfs.prng_state, LEGACY_PRNG_SEED);
        ctx.mem_write(0x2000, b"again").unwrap();
        assert_eq!(handle_syscall(&mut ctx, &mut state, 1, cfd as i64, 0x2000, 5, 0, 0, 0), 5);
        assert!(state.min_in_flight_ns().is_none());
        let mut buf2 = [0u8; 5];
        assert_eq!(handle_syscall(&mut ctx, &mut state, 0, sfd as i64, 0x2100, 5, 0, 0, 0), 5);
        ctx.mem_read(0x2100, &mut buf2).unwrap();
        assert_eq!(&buf2, b"again");
    }

    #[test]
    fn test_m16_simulated_time_fast_forward_zero_wall_clock() {
        let mut state = HostState::new(VirtualFs::new_in_memory(&[]));
        state.multiproc_enabled = true;
        // Huge 60-second stddev — must complete in milliseconds of wall-clock time!
        state.set_delay_config(60_000_000_000, 12345);
        let mut ctx = MockCtx::new(0x0B00_0000);

        let wall_start = std::time::Instant::now();
        let (_lfd, cfd, sfd) = m16_make_tcp_pair(&mut ctx, &mut state, false);

        ctx.mem_write(0x2000, b"hello-sim").unwrap();
        assert_eq!(handle_syscall(&mut ctx, &mut state, 1 /* write */, cfd as i64, 0x2000, 9, 0, 0, 0), 9);

        let deliver_ns = state.min_in_flight_ns().expect("packet should be in flight");
        assert!(deliver_ns > state.scheduler.virtual_mono_ns);

        // FIONREAD (0x541b) on sfd must report 0 while bytes are still in flight
        assert_eq!(handle_syscall(&mut ctx, &mut state, 16 /* ioctl */, sfd as i64, 0x541b, 0x2200, 0, 0, 0), 0);
        let mut fionread = [0u8; 4];
        ctx.mem_read(0x2200, &mut fionread).unwrap();
        assert_eq!(i32::from_le_bytes(fionread), 0);

        // Blocking read on sfd -> enters PipeReadWait -> on_yield_multiproc fast-forwards virtual time
        assert_eq!(handle_syscall(&mut ctx, &mut state, 0 /* read */, sfd as i64, 0x2100, 16, 0, 0, 0), 0);
        assert_eq!(ctx.yield_flag, 1);

        let status = state.on_yield_multiproc(&mut ctx, 1).unwrap();
        assert_eq!(status, 1);
        assert!(state.scheduler.virtual_mono_ns >= deliver_ns);
        let cur_tid = state.scheduler.current_tid;
        let woken_rax = i64::from_le_bytes(state.scheduler.threads[&cur_tid].regs[0..8].try_into().unwrap());
        assert_eq!(woken_rax, 9);
        let mut out = [0u8; 9];
        ctx.mem_read(0x2100, &mut out).unwrap();
        assert_eq!(&out, b"hello-sim");

        assert!(
            wall_start.elapsed() < std::time::Duration::from_millis(500),
            "simulated-time fast-forward must not wait in real time"
        );
    }

    #[test]
    fn test_m16_tcp_per_connection_fifo_and_cross_connection_reordering() {
        let mut state = HostState::new(VirtualFs::new_in_memory(&[]));
        state.set_delay_config(10_000_000 /* 10ms */, 777);
        let mut ctx = MockCtx::new(0x0B00_0000);

        // 1. Per-connection FIFO across 20 messages
        let (_lfd1, cfd1, sfd1) = m16_make_tcp_pair(&mut ctx, &mut state, true);
        let mut expected = Vec::new();
        for i in 0..20u8 {
            let tag = format!("{:02}", i);
            expected.extend_from_slice(tag.as_bytes());
            ctx.mem_write(0x2000, tag.as_bytes()).unwrap();
            assert_eq!(handle_syscall(&mut ctx, &mut state, 1, cfd1 as i64, 0x2000, 2, 0, 0, 0), 2);
        }
        let sfd1_sid = state.vfs.get_fd(sfd1).unwrap().tcp_socket_id.unwrap();
        let read_pipe_id = match state.vfs.tcp_sockets[&sfd1_sid].state {
            crate::vfs::TcpSocketState::Connected { read_pipe_id, .. } => read_pipe_id,
            _ => panic!("expected Connected"),
        };
        let times: Vec<u64> = state.vfs.pipes[&read_pipe_id]
            .in_flight
            .iter()
            .map(|&(t, _)| t)
            .collect();
        assert!(!times.is_empty());
        for w in times.windows(2) {
            assert!(w[0] <= w[1], "per-connection FIFO violated: {} > {}", w[0], w[1]);
        }
        let max_t = *times.last().unwrap();
        state.scheduler.virtual_mono_ns = max_t;
        state.flush_in_flight_pipes(max_t);
        let mut received = [0u8; 40];
        assert_eq!(handle_syscall(&mut ctx, &mut state, 0, sfd1 as i64, 0x2100, 40, 0, 0, 0), 40);
        ctx.mem_read(0x2100, &mut received).unwrap();
        assert_eq!(received.as_slice(), expected.as_slice());

        // 2. Cross-connection reordering: send on A then immediately on B across rounds
        let (_lfd_a, cfd_a, sfd_a) = m16_make_tcp_pair(&mut ctx, &mut state, true);
        let (_lfd_b, cfd_b, sfd_b) = m16_make_tcp_pair(&mut ctx, &mut state, true);
        let pipe_a = match state.vfs.tcp_sockets[&state.vfs.get_fd(sfd_a).unwrap().tcp_socket_id.unwrap()].state {
            crate::vfs::TcpSocketState::Connected { read_pipe_id, .. } => read_pipe_id,
            _ => panic!("expected Connected"),
        };
        let pipe_b = match state.vfs.tcp_sockets[&state.vfs.get_fd(sfd_b).unwrap().tcp_socket_id.unwrap()].state {
            crate::vfs::TcpSocketState::Connected { read_pipe_id, .. } => read_pipe_id,
            _ => panic!("expected Connected"),
        };

        let mut reordered_count = 0usize;
        for _ in 0..30 {
            ctx.mem_write(0x2000, b"A").unwrap();
            assert_eq!(handle_syscall(&mut ctx, &mut state, 1, cfd_a as i64, 0x2000, 1, 0, 0, 0), 1);
            ctx.mem_write(0x2001, b"B").unwrap();
            assert_eq!(handle_syscall(&mut ctx, &mut state, 1, cfd_b as i64, 0x2001, 1, 0, 0, 0), 1);

            let ta = state.vfs.pipes[&pipe_a].in_flight.front().map(|&(t, _)| t).unwrap_or(0);
            let tb = state.vfs.pipes[&pipe_b].in_flight.front().map(|&(t, _)| t).unwrap_or(0);
            if tb < ta {
                reordered_count += 1;
            }
            let flush_t = ta.max(tb);
            state.scheduler.virtual_mono_ns = state.scheduler.virtual_mono_ns.max(flush_t);
            state.flush_in_flight_pipes(state.scheduler.virtual_mono_ns);
            assert_eq!(handle_syscall(&mut ctx, &mut state, 0, sfd_a as i64, 0x2100, 1, 0, 0, 0), 1);
            assert_eq!(handle_syscall(&mut ctx, &mut state, 0, sfd_b as i64, 0x2101, 1, 0, 0, 0), 1);
        }
        assert!(reordered_count > 0, "expected cross-connection reordering in simulated time");
    }

    #[test]
    fn test_m16_tcp_eof_deferred_until_in_flight_drained() {
        for use_close in [false, true] {
            let mut state = HostState::new(VirtualFs::new_in_memory(&[]));
            state.multiproc_enabled = true;
            state.set_delay_config(50_000_000 /* 50ms */, 7);
            let mut ctx = MockCtx::new(0x0B00_0000);

            let (_lfd, cfd, sfd) = m16_make_tcp_pair(&mut ctx, &mut state, true);
            let epfd = handle_syscall(&mut ctx, &mut state, 291 /* epoll_create1 */, 0, 0, 0, 0, 0, 0) as i32;
            assert!(epfd >= 3);
            // Register sfd with EPOLLIN (0x1) | EPOLLRDHUP (0x2000)
            let mut ev = [0u8; 12];
            ev[0..4].copy_from_slice(&(0x2001u32).to_le_bytes());
            ev[4..12].copy_from_slice(&(sfd as u64).to_le_bytes());
            ctx.mem_write(0x3000, &ev).unwrap();
            assert_eq!(
                handle_syscall(&mut ctx, &mut state, 233 /* epoll_ctl */, epfd as i64, 1, sfd as i64, 0x3000, 0, 0),
                0
            );

            ctx.mem_write(0x2000, b"payload").unwrap();
            assert_eq!(handle_syscall(&mut ctx, &mut state, 1, cfd as i64, 0x2000, 7, 0, 0, 0), 7);
            let deliver_ns = state.min_in_flight_ns().expect("payload should be in flight");

            if use_close {
                assert_eq!(handle_syscall(&mut ctx, &mut state, 3 /* close */, cfd as i64, 0, 0, 0, 0, 0), 0);
            } else {
                assert_eq!(handle_syscall(&mut ctx, &mut state, 48 /* shutdown */, cfd as i64, 1 /* SHUT_WR */, 0, 0, 0, 0), 0);
            }

            // Before deliver_ns: read must return -EAGAIN (-11), NOT 0 (EOF), and
            // epoll_wait(timeout=0) must return 0 (no premature POLLERR/POLLIN/POLLRDHUP/POLLHUP)
            assert_eq!(
                handle_syscall(&mut ctx, &mut state, 0 /* read */, sfd as i64, 0x2100, 16, 0, 0, 0),
                -11
            );
            assert_eq!(
                handle_syscall(&mut ctx, &mut state, 232 /* epoll_wait */, epfd as i64, 0x3100, 4, 0, 0, 0),
                0,
                "use_close={}: epoll_wait must not fire prematurely while in-flight chunks remain",
                use_close
            );

            // Blocking epoll_wait(timeout=-1) -> fast-forwards to deliver_ns via on_yield_multiproc
            assert_eq!(
                handle_syscall(&mut ctx, &mut state, 232 /* epoll_wait */, epfd as i64, 0x3100, 4, -1, 0, 0),
                0
            );
            assert_eq!(ctx.yield_flag, 1);
            assert_eq!(state.on_yield_multiproc(&mut ctx, 1).unwrap(), 1);
            assert!(state.scheduler.virtual_mono_ns >= deliver_ns);
            let cur_tid = state.scheduler.current_tid;
            let woken_rax = i64::from_le_bytes(state.scheduler.threads[&cur_tid].regs[0..8].try_into().unwrap());
            assert_eq!(woken_rax, 1);
            let mut out_ev = [0u8; 12];
            ctx.mem_read(0x3100, &mut out_ev).unwrap();
            let revents = u32::from_le_bytes(out_ev[0..4].try_into().unwrap());
            assert_ne!(revents & 0x1, 0, "expected EPOLLIN after delivery");
            assert_ne!(revents & 0x2000, 0, "expected EPOLLRDHUP after last chunk drained");
            if use_close {
                assert_ne!(revents & 0x10, 0, "expected EPOLLHUP after close + drain");
            }

            // First read returns "payload"; second read returns 0 (EOF)
            assert_eq!(handle_syscall(&mut ctx, &mut state, 0, sfd as i64, 0x2100, 16, 0, 0, 0), 7);
            let mut payload = [0u8; 7];
            ctx.mem_read(0x2100, &mut payload).unwrap();
            assert_eq!(&payload, b"payload");
            assert_eq!(handle_syscall(&mut ctx, &mut state, 0, sfd as i64, 0x2100, 16, 0, 0, 0), 0);
        }
    }

    #[test]
    fn test_m16_tcp_close_with_in_flight_chunks_epoll_wait() {
        // Regression test for Probe 3b: writer writes multiple chunks under delay_stddev_ns > 0
        // and immediately calls SYS_CLOSE(cfd), while reader monitors sfd via level-triggered
        // epoll_wait(POLLIN | POLLRDHUP) with timeout=0 and blocking timeout=-1.
        let mut state = HostState::new(VirtualFs::new_in_memory(&[]));
        state.multiproc_enabled = true;
        state.set_delay_config(50_000_000 /* 50ms */, 7777);
        let mut ctx = MockCtx::new(0x0B00_0000);

        let (_lfd, cfd, sfd) = m16_make_tcp_pair(&mut ctx, &mut state, true);
        let epfd = handle_syscall(&mut ctx, &mut state, 291 /* epoll_create1 */, 0, 0, 0, 0, 0, 0) as i32;
        assert!(epfd >= 3);
        let mut ev = [0u8; 12];
        ev[0..4].copy_from_slice(&0x2001u32.to_le_bytes()); // EPOLLIN | EPOLLRDHUP
        ev[4..12].copy_from_slice(&(sfd as u64).to_le_bytes());
        ctx.mem_write(0x3000, &ev).unwrap();
        assert_eq!(
            handle_syscall(&mut ctx, &mut state, 233 /* epoll_ctl */, epfd as i64, 1, sfd as i64, 0x3000, 0, 0),
            0
        );

        let mut expected = Vec::new();
        for i in 0..8u8 {
            let chunk = format!("chunk-{:02}|", i);
            expected.extend_from_slice(chunk.as_bytes());
            ctx.mem_write(0x2000, chunk.as_bytes()).unwrap();
            assert_eq!(
                handle_syscall(&mut ctx, &mut state, 1 /* write */, cfd as i64, 0x2000, chunk.len() as i64, 0, 0, 0),
                chunk.len() as i64
            );
        }
        assert!(state.min_in_flight_ns().is_some(), "chunks must be in flight");

        // Immediately close writer fd while all 8 chunks are still in flight
        assert_eq!(handle_syscall(&mut ctx, &mut state, 3 /* close */, cfd as i64, 0, 0, 0, 0, 0), 0);

        // FIONREAD must be 0, non-blocking read must return -EAGAIN, and epoll_wait(timeout=0) must return 0
        assert_eq!(
            handle_syscall(&mut ctx, &mut state, 16 /* ioctl */, sfd as i64, 0x541B /* FIONREAD */, 0x2200, 0, 0, 0),
            0
        );
        let mut avail = [0u8; 4];
        ctx.mem_read(0x2200, &mut avail).unwrap();
        assert_eq!(i32::from_le_bytes(avail), 0, "FIONREAD must be 0 while all chunks are in-flight");
        assert_eq!(
            handle_syscall(&mut ctx, &mut state, 0 /* read */, sfd as i64, 0x2100, 64, 0, 0, 0),
            -11
        );
        assert_eq!(
            handle_syscall(&mut ctx, &mut state, 232 /* epoll_wait */, epfd as i64, 0x3100, 4, 0, 0, 0),
            0,
            "epoll_wait(timeout=0) must NOT fire premature POLLERR/POLLHUP while in-flight chunks remain"
        );

        // Drain all 8 chunks via blocking level-triggered epoll_wait(timeout=-1) + on_yield_multiproc
        let mut received = Vec::new();
        let mut saw_eof_events = false;
        for _ in 0..32 {
            ctx.yield_flag = 0;
            let n = handle_syscall(&mut ctx, &mut state, 232 /* epoll_wait */, epfd as i64, 0x3100, 4, -1, 0, 0);
            let ready = if ctx.yield_flag == 1 {
                assert_eq!(state.on_yield_multiproc(&mut ctx, 1).unwrap(), 1);
                let cur_tid = state.scheduler.current_tid;
                i64::from_le_bytes(state.scheduler.threads[&cur_tid].regs[0..8].try_into().unwrap())
            } else {
                n
            };
            assert_eq!(ready, 1);

            let mut out_ev = [0u8; 12];
            ctx.mem_read(0x3100, &mut out_ev).unwrap();
            let revents = u32::from_le_bytes(out_ev[0..4].try_into().unwrap());
            let still_in_flight = state.min_in_flight_ns().is_some();
            if still_in_flight {
                assert_eq!(
                    revents & (0x8 | 0x10 | 0x2000),
                    0,
                    "must NOT report POLLERR/POLLHUP/POLLRDHUP while chunks remain in flight, got 0x{:x}",
                    revents
                );
                assert_ne!(revents & 0x1, 0, "expected EPOLLIN for delivered in-flight chunk");
            } else if (revents & (0x10 | 0x2000)) != 0 {
                saw_eof_events = true;
            }

            loop {
                let r = handle_syscall(&mut ctx, &mut state, 0 /* read */, sfd as i64, 0x2100, 64, 0, 0, 0);
                if r > 0 {
                    let mut buf = vec![0u8; r as usize];
                    ctx.mem_read(0x2100, &mut buf).unwrap();
                    received.extend_from_slice(&buf);
                } else if r == 0 {
                    assert!(
                        state.min_in_flight_ns().is_none(),
                        "0-byte EOF must only occur after all in-flight chunks drained"
                    );
                    break;
                } else {
                    assert_eq!(r, -11, "expected -EAGAIN when buffer drained");
                    break;
                }
            }
            if received.len() == expected.len() && state.min_in_flight_ns().is_none() {
                // Verify subsequent read returns 0 (EOF) and epoll_wait reports EPOLLHUP | EPOLLRDHUP
                assert_eq!(
                    handle_syscall(&mut ctx, &mut state, 0 /* read */, sfd as i64, 0x2100, 64, 0, 0, 0),
                    0
                );
                if !saw_eof_events {
                    assert_eq!(
                        handle_syscall(&mut ctx, &mut state, 232 /* epoll_wait */, epfd as i64, 0x3100, 4, 0, 0, 0),
                        1
                    );
                    ctx.mem_read(0x3100, &mut out_ev).unwrap();
                    let rev = u32::from_le_bytes(out_ev[0..4].try_into().unwrap());
                    assert_ne!(rev & 0x10, 0, "expected EPOLLHUP after drain");
                    assert_ne!(rev & 0x2000, 0, "expected EPOLLRDHUP after drain");
                    saw_eof_events = true;
                }
                break;
            }
        }
        assert_eq!(received, expected, "all 8 chunks must arrive in strict FIFO order");
        assert!(saw_eof_events, "expected EPOLLHUP/EPOLLRDHUP after all in-flight chunks drained");

        // Also verify edge-triggered (EPOLLET | EPOLLIN | EPOLLOUT | EPOLLRDHUP) like Go's netpoller:
        // peer SYS_CLOSE while chunks are in flight must not spuriously rearm EPOLLOUT/EPOLLERR before drain,
        // and must rearm & deliver EPOLLHUP/EPOLLRDHUP once the last chunk drains.
        let (_lfd2, cfd2, sfd2) = m16_make_tcp_pair(&mut ctx, &mut state, true);
        let epfd2 = handle_syscall(&mut ctx, &mut state, 291, 0, 0, 0, 0, 0, 0) as i32;
        let mut ev2 = [0u8; 12];
        ev2[0..4].copy_from_slice(&(0x8000_2005u32).to_le_bytes()); // EPOLLET | EPOLLRDHUP | EPOLLOUT | EPOLLIN
        ev2[4..12].copy_from_slice(&(sfd2 as u64).to_le_bytes());
        ctx.mem_write(0x3000, &ev2).unwrap();
        assert_eq!(handle_syscall(&mut ctx, &mut state, 233, epfd2 as i64, 1, sfd2 as i64, 0x3000, 0, 0), 0);
        // Consume initial edge-triggered EPOLLOUT
        assert_eq!(handle_syscall(&mut ctx, &mut state, 232, epfd2 as i64, 0x3100, 4, 0, 0, 0), 1);
        assert_eq!(handle_syscall(&mut ctx, &mut state, 232, epfd2 as i64, 0x3100, 4, 0, 0, 0), 0);

        ctx.mem_write(0x2000, b"et-msg").unwrap();
        assert_eq!(handle_syscall(&mut ctx, &mut state, 1, cfd2 as i64, 0x2000, 6, 0, 0, 0), 6);
        let et_deliver_ns = state.min_in_flight_ns().expect("et-msg should be in flight");
        assert_eq!(handle_syscall(&mut ctx, &mut state, 3, cfd2 as i64, 0, 0, 0, 0, 0), 0);

        // Must NOT fire spuriously before et_deliver_ns
        assert_eq!(
            handle_syscall(&mut ctx, &mut state, 232, epfd2 as i64, 0x3100, 4, 0, 0, 0),
            0,
            "EPOLLET must not spuriously rearm EPOLLOUT/EPOLLERR while in-flight chunks remain"
        );
        // Blocking epoll_wait fast-forwards to et_deliver_ns and delivers EPOLLIN | EPOLLRDHUP | EPOLLHUP
        ctx.yield_flag = 0;
        assert_eq!(handle_syscall(&mut ctx, &mut state, 232, epfd2 as i64, 0x3100, 4, -1, 0, 0), 0);
        assert_eq!(ctx.yield_flag, 1);
        assert_eq!(state.on_yield_multiproc(&mut ctx, 1).unwrap(), 1);
        assert!(state.scheduler.virtual_mono_ns >= et_deliver_ns);
        let mut out_ev2 = [0u8; 12];
        ctx.mem_read(0x3100, &mut out_ev2).unwrap();
        let rev2 = u32::from_le_bytes(out_ev2[0..4].try_into().unwrap());
        assert_ne!(rev2 & 0x1, 0, "EPOLLET expected EPOLLIN after drain");
        assert_ne!(rev2 & 0x10, 0, "EPOLLET expected EPOLLHUP after drain");
        assert_ne!(rev2 & 0x2000, 0, "EPOLLET expected EPOLLRDHUP after drain");
        assert_eq!(handle_syscall(&mut ctx, &mut state, 0, sfd2 as i64, 0x2100, 16, 0, 0, 0), 6);
        assert_eq!(handle_syscall(&mut ctx, &mut state, 0, sfd2 as i64, 0x2100, 16, 0, 0, 0), 0);
    }

    #[test]
    fn test_m16_determinism_identical_seeds_and_reset_for_new_run() {
        fn run_trace(state: &mut HostState) -> ([u8; 16], [u8; 32], [u8; 16], Vec<u64>, Vec<u64>) {
            let mut ctx = MockCtx::new(0x0B00_0000);
            let at_rand = state.at_random_bytes();

            // 1. SYS_GETRANDOM (318)
            assert_eq!(handle_syscall(&mut ctx, state, 318, 0x2000, 32, 0, 0, 0, 0), 32);
            let mut getrand = [0u8; 32];
            ctx.mem_read(0x2000, &mut getrand).unwrap();

            // 2. /dev/urandom
            write_cstr(&mut ctx, 0x2100, "/dev/urandom");
            let ufd = handle_syscall(&mut ctx, state, 257 /* openat */, -100, 0x2100, 0, 0, 0, 0) as i32;
            assert!(ufd >= 3);
            assert_eq!(handle_syscall(&mut ctx, state, 0, ufd as i64, 0x2200, 16, 0, 0, 0), 16);
            let mut urand = [0u8; 16];
            ctx.mem_read(0x2200, &mut urand).unwrap();

            // 3. 10 TCP deliver_ns timestamps
            let (_lfd, cfd, sfd) = m16_make_tcp_pair(&mut ctx, state, true);
            for i in 0..10u8 {
                ctx.mem_write(0x2300, &[i]).unwrap();
                assert_eq!(handle_syscall(&mut ctx, state, 1, cfd as i64, 0x2300, 1, 0, 0, 0), 1);
            }
            let sid = state.vfs.get_fd(sfd).unwrap().tcp_socket_id.unwrap();
            let rpid = match state.vfs.tcp_sockets[&sid].state {
                crate::vfs::TcpSocketState::Connected { read_pipe_id, .. } => read_pipe_id,
                _ => panic!("expected Connected"),
            };
            let deliver_times: Vec<u64> = state.vfs.pipes[&rpid]
                .in_flight
                .iter()
                .map(|&(t, _)| t)
                .collect();

            // 4. epoll_wait order across 6 ready eventfds
            let epfd = handle_syscall(&mut ctx, state, 291, 0, 0, 0, 0, 0, 0) as i32;
            for i in 0..6u64 {
                let efd = handle_syscall(&mut ctx, state, 290 /* eventfd2 */, 1, 0, 0, 0, 0, 0) as i32;
                let mut ev = [0u8; 12];
                ev[0..4].copy_from_slice(&1u32.to_le_bytes());
                ev[4..12].copy_from_slice(&(100 + i).to_le_bytes());
                ctx.mem_write(0x3000, &ev).unwrap();
                assert_eq!(handle_syscall(&mut ctx, state, 233, epfd as i64, 1, efd as i64, 0x3000, 0, 0), 0);
            }
            assert_eq!(handle_syscall(&mut ctx, state, 232, epfd as i64, 0x3100, 6, 0, 0, 0), 6);
            let mut epoll_order = Vec::with_capacity(6);
            for i in 0..6usize {
                let mut ev = [0u8; 12];
                ctx.mem_read(0x3100 + (i as u64) * 12, &mut ev).unwrap();
                epoll_order.push(u64::from_le_bytes(ev[4..12].try_into().unwrap()));
            }
            (at_rand, getrand, urand, deliver_times, epoll_order)
        }

        let mut state_a = HostState::new(VirtualFs::new_in_memory(&[]));
        state_a.set_delay_config(10_000_000, 999);
        let trace_a1 = run_trace(&mut state_a);

        let mut state_b = HostState::new(VirtualFs::new_in_memory(&[]));
        state_b.set_delay_config(10_000_000, 999);
        let trace_b = run_trace(&mut state_b);
        assert_eq!(trace_a1, trace_b, "identical seeds must produce bit-identical traces");

        // Reset state_a for a new run (like sweep iteration k) -> must match standalone trace exactly
        state_a.reset_for_new_run();
        assert_eq!(state_a.scheduler.virtual_mono_ns, 0);
        assert_eq!(state_a.vfs.uptime_ns, 0);
        let trace_a2 = run_trace(&mut state_a);
        assert_eq!(trace_a1, trace_a2, "reset_for_new_run must match fresh standalone run");

        // Different seed must diverge
        let mut state_c = HostState::new(VirtualFs::new_in_memory(&[]));
        state_c.set_delay_config(10_000_000, 1000);
        let trace_c = run_trace(&mut state_c);
        assert_ne!(trace_a1, trace_c, "different seeds must produce distinct traces");
    }

    #[test]
    fn test_m16_cow_vfs_snapshot_restore_drop() {
        let mut state = HostState::new(VirtualFs::new_in_memory(&[]));
        state.vfs.vfs_write_file("/workspace/app.bin", b"v1", 0o755);
        state.vfs.vfs_write_file("/workspace/keep.txt", b"orig", 0o644);

        let snap = state.vfs.snapshot_vfs();
        assert!(snap >= 1);

        // Mutate, delete, and create files
        state.vfs.vfs_write_file("/workspace/app.bin", b"v2-mutated", 0o755);
        state.vfs.vfs_remove_path("/workspace/keep.txt");
        state.vfs.vfs_write_file("/workspace/temp.log", b"dirty", 0o644);
        assert_eq!(state.vfs.vfs_read_file("/workspace/app.bin").as_deref(), Some(&b"v2-mutated"[..]));
        assert!(state.vfs.vfs_read_file("/workspace/keep.txt").is_none());

        // Restore reverts all mutations cleanly
        assert_eq!(state.vfs.restore_vfs(snap), 0);
        assert_eq!(state.vfs.vfs_read_file("/workspace/app.bin").as_deref(), Some(&b"v1"[..]));
        assert_eq!(state.vfs.vfs_read_file("/workspace/keep.txt").as_deref(), Some(&b"orig"[..]));
        assert!(state.vfs.vfs_read_file("/workspace/temp.log").is_none());

        // Snapshot survives reset_for_new_run() and can be restored repeatedly
        state.vfs.vfs_write_file("/workspace/app.bin", b"v3", 0o755);
        state.reset_for_new_run();
        assert_eq!(state.vfs.restore_vfs(snap), 0);
        assert_eq!(state.vfs.vfs_read_file("/workspace/app.bin").as_deref(), Some(&b"v1"[..]));

        // Dropping snapshot invalidates it
        assert_eq!(state.vfs.drop_vfs_snapshot(snap), 0);
        assert_eq!(state.vfs.restore_vfs(snap), -1);
        assert_eq!(state.vfs.drop_vfs_snapshot(snap), -1);

        // Invalid / zero IDs return -1
        assert_eq!(state.vfs.restore_vfs(0), -1);
        assert_eq!(state.vfs.restore_vfs(99999), -1);
        assert_eq!(state.vfs.drop_vfs_snapshot(0), -1);
    }

    #[test]
    fn test_m16_tcp_socket_and_stdin_reset_across_runs() {
        let mut state = HostState::new(VirtualFs::new_in_memory(&[]));
        let mut ctx = MockCtx::new(0x0B00_0000);

        // Bind explicit port 18080
        let lfd = handle_syscall(&mut ctx, &mut state, 41, 2, 1, 0, 0, 0, 0) as i32;
        let mut sa = [0u8; 16];
        sa[0..2].copy_from_slice(&2u16.to_le_bytes());
        sa[2..4].copy_from_slice(&18080u16.to_be_bytes());
        sa[4..8].copy_from_slice(&[127, 0, 0, 1]);
        ctx.mem_write(0x1000, &sa).unwrap();
        assert_eq!(handle_syscall(&mut ctx, &mut state, 49, lfd as i64, 0x1000, 16, 0, 0, 0), 0);
        assert_eq!(handle_syscall(&mut ctx, &mut state, 50, lfd as i64, 8, 0, 0, 0, 0), 0);

        // Also open an ephemeral connected pair, push stdin, advance virtual time
        let _ = m16_make_tcp_pair(&mut ctx, &mut state, true);
        state.vfs.push_stdin(b"leftover");
        state.scheduler.virtual_mono_ns = 999_999;
        state.vfs.uptime_ns = 999_999;

        state.reset_for_new_run();

        assert!(state.vfs.tcp_sockets.is_empty());
        assert!(state.vfs.tcp_bound_ports.is_empty());
        assert!(state.vfs.tcp_listeners.is_empty());
        assert_eq!(state.vfs.next_tcp_socket_id, 1);
        assert_eq!(state.vfs.next_ephemeral_port, 32768);
        assert!(state.vfs.stdin_data.is_empty());
        assert_eq!(state.scheduler.virtual_mono_ns, 0);
        assert_eq!(state.vfs.uptime_ns, 0);

        // Re-binding port 18080 on the new run must succeed (not -EADDRINUSE)
        let lfd2 = handle_syscall(&mut ctx, &mut state, 41, 2, 1, 0, 0, 0, 0) as i32;
        ctx.mem_write(0x1000, &sa).unwrap();
        assert_eq!(handle_syscall(&mut ctx, &mut state, 49, lfd2 as i64, 0x1000, 16, 0, 0, 0), 0);
    }

    #[test]
    fn test_m16_epoll_shuffle_and_run_queue_jitter() {
        use crate::scheduler::ThreadContext;

        let collect_epoll_order = |stddev_ns: u64, seed: u64| -> Vec<u64> {
            let mut state = HostState::new(VirtualFs::new_in_memory(&[]));
            state.set_delay_config(stddev_ns, seed);
            let mut ctx = MockCtx::new(0x0B00_0000);
            let epfd = handle_syscall(&mut ctx, &mut state, 291, 0, 0, 0, 0, 0, 0) as i32;
            for i in 0..8u64 {
                let efd = handle_syscall(&mut ctx, &mut state, 290, 1, 0, 0, 0, 0, 0) as i32;
                let mut ev = [0u8; 12];
                ev[0..4].copy_from_slice(&1u32.to_le_bytes());
                ev[4..12].copy_from_slice(&i.to_le_bytes());
                ctx.mem_write(0x3000, &ev).unwrap();
                assert_eq!(handle_syscall(&mut ctx, &mut state, 233, epfd as i64, 1, efd as i64, 0x3000, 0, 0), 0);
            }
            assert_eq!(handle_syscall(&mut ctx, &mut state, 232, epfd as i64, 0x3100, 8, 0, 0, 0), 8);
            let mut out = Vec::with_capacity(8);
            for i in 0..8usize {
                let mut ev = [0u8; 12];
                ctx.mem_read(0x3100 + (i as u64) * 12, &mut ev).unwrap();
                out.push(u64::from_le_bytes(ev[4..12].try_into().unwrap()));
            }
            out
        };

        let baseline = collect_epoll_order(0, 0);
        assert_eq!(baseline, vec![0, 1, 2, 3, 4, 5, 6, 7]);

        let shuffled1 = collect_epoll_order(5_000_000, 42);
        let shuffled2 = collect_epoll_order(5_000_000, 42);
        assert_eq!(shuffled1, shuffled2);
        assert_ne!(shuffled1, baseline);
        let mut sorted = shuffled1.clone();
        sorted.sort();
        assert_eq!(sorted, baseline);

        // Scheduler run_queue perturbation
        let mut sched = crate::scheduler::Scheduler::new();
        for tid in 2001..=2008 {
            sched.threads.insert(tid, ThreadContext::new(tid));
            sched.run_queue.push_back(tid);
        }
        let mut rng_state = 0x1234_5678_9abc_def0u64;
        let mut popped = Vec::new();
        while let Some(tid) = sched.pop_next_runnable_with_rng(|| crate::syscalls::splitmix64_next(&mut rng_state)) {
            popped.push(tid);
        }
        assert_ne!(popped, (2001..=2008).collect::<Vec<_>>());
        popped.sort();
        assert_eq!(popped, (2001..=2008).collect::<Vec<_>>());
    }
}
