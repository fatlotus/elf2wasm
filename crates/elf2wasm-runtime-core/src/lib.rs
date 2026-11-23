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

        // socket(AF_INET) -> -EAFNOSUPPORT (-97)
        assert_eq!(handle_syscall(&mut ctx, &mut state, 41 /* socket */, 2, 1, 0, 0, 0, 0), -97);

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
}
