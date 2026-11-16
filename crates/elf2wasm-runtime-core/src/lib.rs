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
}
