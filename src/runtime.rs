use anyhow::{Context, Result};
use elf2wasm_core::lifter::{CTX_SIZE, YIELD_SYSCALL_PENDING};
use elf2wasm_runtime_core::context::GuestContext;
pub use elf2wasm_runtime_core::stack::{
    extract_elf2wasm_meta, setup_guest_stack, RunConfig, RunOutput,
};
use elf2wasm_runtime_core::scheduler::ThreadState;
use elf2wasm_runtime_core::syscalls::{handle_syscall, HostState, PendingHostAction};
use elf2wasm_runtime_core::vfs::{VirtualFs, EFAULT, EINVAL, ENOMEM, ENOSYS};
use std::collections::HashMap;
use wasmtime::{Engine, Instance, Memory, Module, Store, Val};


struct StoreCtx<'a> {
    store: &'a mut Store<Option<HostState>>,
    instance: &'a Instance,
    mem: Memory,
    fsbase: i64,
    gsbase: i64,
    rcx: i64,
    rax: i64,
    rdi: i64,
    rsi: i64,
    rdx: i64,
    r10: i64,
    r8: i64,
    r9: i64,
    trace: bool,
}

impl<'a> StoreCtx<'a> {
    fn read_global_i64(
        store: &mut Store<Option<HostState>>,
        instance: &Instance,
        name: &str,
    ) -> i64 {
        instance
            .get_global(&mut *store, name)
            .and_then(|g| g.get(&mut *store).i64())
            .unwrap_or(0)
    }

    fn new(
        store: &'a mut Store<Option<HostState>>,
        instance: &'a Instance,
        mem: Memory,
        trace: bool,
    ) -> Self {
        let fsbase = Self::read_global_i64(store, instance, "fsbase");
        let gsbase = Self::read_global_i64(store, instance, "gsbase");
        let rcx = Self::read_global_i64(store, instance, "rcx");
        let rax = Self::read_global_i64(store, instance, "rax");
        let rdi = Self::read_global_i64(store, instance, "rdi");
        let rsi = Self::read_global_i64(store, instance, "rsi");
        let rdx = Self::read_global_i64(store, instance, "rdx");
        let r10 = Self::read_global_i64(store, instance, "r10");
        let r8 = Self::read_global_i64(store, instance, "r8");
        let r9 = Self::read_global_i64(store, instance, "r9");
        Self {
            store,
            instance,
            mem,
            fsbase,
            gsbase,
            rcx,
            rax,
            rdi,
            rsi,
            rdx,
            r10,
            r8,
            r9,
            trace,
        }
    }

    fn set_global_i64(&mut self, name: &str, val: i64) {
        if let Some(g) = self.instance.get_global(&mut *self.store, name) {
            let _ = g.set(&mut *self.store, Val::I64(val));
        }
    }

    fn set_global_i32(&mut self, name: &str, val: i32) {
        if let Some(g) = self.instance.get_global(&mut *self.store, name) {
            let _ = g.set(&mut *self.store, Val::I32(val));
        }
    }
}

impl<'a> GuestContext for StoreCtx<'a> {
    fn mem_len(&self) -> usize {
        self.mem.data_size(&*self.store)
    }

    fn mem_read(&self, addr: u64, buf: &mut [u8]) -> Result<(), i64> {
        if buf.is_empty() {
            return Ok(());
        }
        if addr == 0 {
            return Err(-EFAULT);
        }
        let mem_size = self.mem.data_size(&*self.store);
        let start = usize::try_from(addr).map_err(|_| -EFAULT)?;
        let end = start.checked_add(buf.len()).ok_or(-EFAULT)?;
        if end > mem_size {
            return Err(-EFAULT);
        }
        self.mem.read(&*self.store, start, buf).map_err(|_| -EFAULT)
    }

    fn mem_write(&mut self, addr: u64, data: &[u8]) -> Result<(), i64> {
        if data.is_empty() {
            return Ok(());
        }
        if addr == 0 {
            return Err(-EFAULT);
        }
        let mem_size = self.mem.data_size(&*self.store);
        let start = usize::try_from(addr).map_err(|_| -EFAULT)?;
        let end = start.checked_add(data.len()).ok_or(-EFAULT)?;
        if end > mem_size {
            return Err(-EFAULT);
        }
        self.mem
            .write(&mut *self.store, start, data)
            .map_err(|_| -EFAULT)
    }

    fn mem_zero(&mut self, addr: u64, len: usize) -> Result<(), i64> {
        if len == 0 {
            return Ok(());
        }
        let mem_size = self.mem.data_size(&*self.store);
        let start = usize::try_from(addr).map_err(|_| -ENOMEM)?;
        let end = start.checked_add(len).ok_or(-ENOMEM)?;
        if end > mem_size {
            return Err(-ENOMEM);
        }
        self.mem.data_mut(&mut *self.store)[start..end].fill(0);
        Ok(())
    }

    fn mem_read_cstr(&self, addr: u64, max_len: usize) -> Result<String, i64> {
        if addr == 0 {
            return Err(-EFAULT);
        }
        let data = self.mem.data(&*self.store);
        let start = usize::try_from(addr).map_err(|_| -EFAULT)?;
        if start >= data.len() {
            return Err(-EFAULT);
        }
        let max_end = (start + max_len).min(data.len());
        let slice = &data[start..max_end];
        let nul = slice.iter().position(|&b| b == 0).ok_or(-EFAULT)?;
        String::from_utf8(slice[..nul].to_vec()).map_err(|_| -EINVAL)
    }

    fn get_fsbase(&self) -> i64 {
        self.fsbase
    }

    fn set_fsbase(&mut self, val: i64) {
        self.fsbase = val;
        self.set_global_i64("fsbase", val);
    }

    fn get_gsbase(&self) -> i64 {
        self.gsbase
    }

    fn set_gsbase(&mut self, val: i64) {
        self.gsbase = val;
        self.set_global_i64("gsbase", val);
    }

    fn get_rcx(&self) -> i64 {
        self.rcx
    }

    fn set_rip(&mut self, val: i64) {
        self.set_global_i64("rip", val);
    }

    fn set_rsp(&mut self, val: i64) {
        self.set_global_i64("rsp", val);
    }

    fn get_rax(&self) -> i64 {
        self.rax
    }

    fn set_rax(&mut self, val: i64) {
        self.rax = val;
        self.set_global_i64("rax", val);
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
        self.set_global_i32("exit_flag", 1);
        self.set_global_i32("exit_code", code);
    }

    fn set_yield_flag(&mut self, val: i32) {
        self.set_global_i32("yield_flag", val);
    }

    fn set_quantum(&mut self, val: i32) {
        self.set_global_i32("quantum", val);
    }

    fn save_ctx(&mut self, scratch_addr: u32) -> Result<[u8; CTX_SIZE], i64> {
        let func = self
            .instance
            .get_typed_func::<i32, ()>(&mut *self.store, "save_ctx")
            .map_err(|_| -ENOSYS)?;
        func.call(&mut *self.store, scratch_addr as i32)
            .map_err(|_| -EFAULT)?;
        let mut buf = [0u8; CTX_SIZE];
        self.mem_read(scratch_addr as u64, &mut buf)?;
        Ok(buf)
    }

    fn load_ctx(&mut self, scratch_addr: u32, buf: &[u8; CTX_SIZE]) -> Result<(), i64> {
        self.mem_write(scratch_addr as u64, buf)?;
        let func = self
            .instance
            .get_typed_func::<i32, ()>(&mut *self.store, "load_ctx")
            .map_err(|_| -ENOSYS)?;
        func.call(&mut *self.store, scratch_addr as i32)
            .map_err(|_| -EFAULT)?;
        Ok(())
    }

    fn trace_enabled(&self) -> bool {
        self.trace
    }

    fn trace_log(&self, msg: &str) {
        eprintln!("{}", msg);
    }
}

pub fn create_engine() -> Result<Engine> {
    let mut engine_config = wasmtime::Config::new();
    engine_config.cranelift_opt_level(wasmtime::OptLevel::None);
    Engine::new(&engine_config)
}

fn fnv1a_64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

fn cwasm_cache_path(wasm_bytes: &[u8]) -> std::path::PathBuf {
    let hash = fnv1a_64(wasm_bytes);
    std::env::temp_dir()
        .join("elf2wasm_cwasm_cache")
        .join(format!("{:016x}_{}.cwasm", hash, wasm_bytes.len()))
}

pub fn prewarm_cwasm_cache(wasm_bytes: &[u8]) -> Result<()> {
    let cache_path = cwasm_cache_path(wasm_bytes);
    if cache_path.exists() {
        return Ok(());
    }
    if let Some(parent) = cache_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let engine = create_engine()?;
    let module = Module::new(&engine, wasm_bytes)?;
    let serialized = module.serialize()?;
    let tmp_path = cache_path.with_extension("cwasm.tmp");
    std::fs::write(&tmp_path, &serialized)?;
    std::fs::rename(&tmp_path, &cache_path)?;
    Ok(())
}

pub fn run_wasm(wasm_bytes: &[u8], config: RunConfig) -> Result<RunOutput> {
    let meta = extract_elf2wasm_meta(wasm_bytes)?;
    let engine = create_engine()?;
    let cache_path = cwasm_cache_path(wasm_bytes);
    let module = if cache_path.exists() {
        match unsafe { Module::deserialize_file(&engine, &cache_path) } {
            Ok(m) => m,
            Err(_) => Module::new(&engine, wasm_bytes)?,
        }
    } else {
        let m = Module::new(&engine, wasm_bytes)?;
        if let Some(parent) = cache_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(serialized) = m.serialize() {
            let tmp_path = cache_path.with_extension("cwasm.tmp");
            if std::fs::write(&tmp_path, &serialized).is_ok() {
                let _ = std::fs::rename(&tmp_path, &cache_path);
            }
        }
        m
    };
    let trace = std::env::var_os("ELF2WASM_TRACE").is_some();

    for (host, _) in &config.vfs_ro {
        std::fs::canonicalize(host).with_context(|| {
            format!(
                "Invalid --vfs-ro host path '{}': does not exist or cannot be resolved",
                host.display()
            )
        })?;
    }

    let mut vfs = VirtualFs::new(&meta.so_files, &config.vfs_ro);
    vfs.stdin_data = config.stdin.clone();
    vfs.inherit_stdin = config.inherit_stdin;
    vfs.elf_path = meta.elf_path.clone();
    let mut host_state = HostState::new(vfs);
    host_state.apply_meta_layout(&meta);
    host_state.multiproc_enabled = true;
    let mut store = Store::new(&engine, Some(host_state));

    let main_inst = Instance::new(&mut store, &module, &[])?;
    let main_mem = main_inst
        .get_memory(&mut store, "memory")
        .context("missing exported memory")?;

    let initial_rsp = {
        let mem_slice = main_mem.data_mut(&mut store);
        setup_guest_stack(mem_slice, &meta, &config)?
    };

    main_inst
        .get_global(&mut store, "rsp")
        .context("missing rsp global")?
        .set(&mut store, Val::I64(initial_rsp as i64))?;

    main_inst
        .get_global(&mut store, "rip")
        .context("missing rip global")?
        .set(&mut store, Val::I64(meta.entry_rip as i64))?;

    let mut processes: HashMap<i32, Instance> = HashMap::new();
    let mut active_pid: i32 = 1000;
    processes.insert(active_pid, main_inst);

    let exit_code = loop {
        let active_inst = *processes
            .get(&active_pid)
            .context("missing active guest instance")?;
        let mem = active_inst
            .get_memory(&mut store, "memory")
            .context("missing exported memory")?;
        let start = active_inst.get_typed_func::<(), i32>(&mut store, "_start")?;
        let code = match start.call(&mut store, ()) {
            Ok(code) => code,
            Err(err) => {
                let rip = active_inst
                    .get_global(&mut store, "rip")
                    .and_then(|g| g.get(&mut store).i64())
                    .unwrap_or(-1) as u64;
                let rsp = active_inst
                    .get_global(&mut store, "rsp")
                    .and_then(|g| g.get(&mut store).i64())
                    .unwrap_or(-1) as u64;
                let rax = active_inst
                    .get_global(&mut store, "rax")
                    .and_then(|g| g.get(&mut store).i64())
                    .unwrap_or(-1) as u64;
                let sym = meta
                    .symbols
                    .iter()
                    .rev()
                    .find(|(addr, _)| (*addr as u64) <= rip)
                    .map(|(addr, name)| format!("{}+0x{:x}", name, rip - *addr as u64))
                    .unwrap_or_else(|| "unknown".to_string());
                return Err(err).context(format!(
                    "WASM trap at rip=0x{:x} ({}), rsp=0x{:x}, rax=0x{:x}",
                    rip, sym, rsp, rax
                ));
            }
        };
        let mut yield_flag = active_inst
            .get_global(&mut store, "yield_flag")
            .and_then(|g| g.get(&mut store).i32())
            .unwrap_or(0);
        let mut exit_flag = active_inst
            .get_global(&mut store, "exit_flag")
            .and_then(|g| g.get(&mut store).i32())
            .unwrap_or(0);

        if yield_flag == YIELD_SYSCALL_PENDING {
            let mut host_state = store
                .data_mut()
                .take()
                .expect("HostState missing during syscall");
            let mut sctx = StoreCtx::new(&mut store, &active_inst, mem, trace);
            let nr = sctx.get_rax();
            let a0 = sctx.get_rdi();
            let a1 = sctx.get_rsi();
            let a2 = sctx.get_rdx();
            let a3 = sctx.get_r10();
            let a4 = sctx.get_r8();
            let a5 = sctx.get_r9();
            let ret = handle_syscall(&mut sctx, &mut host_state, nr, a0, a1, a2, a3, a4, a5);
            sctx.set_rax(ret);

            let main_exited = host_state.is_main_exited();
            let has_pending = host_state.pending_action.is_some();
            if main_exited {
                let ec = processes[&1000]
                    .get_global(&mut store, "exit_code")
                    .and_then(|g| g.get(&mut store).i32())
                    .unwrap_or(code);
                *store.data_mut() = Some(host_state);
                break ec;
            }
            yield_flag = active_inst
                .get_global(&mut store, "yield_flag")
                .and_then(|g| g.get(&mut store).i32())
                .unwrap_or(0);
            exit_flag = active_inst
                .get_global(&mut store, "exit_flag")
                .and_then(|g| g.get(&mut store).i32())
                .unwrap_or(0);
            if exit_flag != 0 && !has_pending {
                let ec = active_inst
                    .get_global(&mut store, "exit_code")
                    .and_then(|g| g.get(&mut store).i32())
                    .unwrap_or(code);
                *store.data_mut() = Some(host_state);
                break ec;
            }
            if yield_flag == YIELD_SYSCALL_PENDING {
                let other_runnable = !host_state.scheduler.run_queue.is_empty()
                    || host_state.has_expired_timed_waiter()
                    || host_state.processes.iter().any(|(&pid, p)| {
                        pid != host_state.active_pid
                            && !p.exited
                            && p.scheduler
                                .threads
                                .values()
                                .any(|t| t.state == ThreadState::Runnable)
                    });
                if !other_runnable {
                    let mut sctx = StoreCtx::new(&mut store, &active_inst, mem, trace);
                    sctx.set_yield_flag(0);
                    *store.data_mut() = Some(host_state);
                    continue;
                }
            }
            *store.data_mut() = Some(host_state);
        }

        let mut host_state = store
            .data_mut()
            .take()
            .expect("HostState missing during yield");
        if host_state.is_main_exited() {
            let ec = processes[&1000]
                .get_global(&mut store, "exit_code")
                .and_then(|g| g.get(&mut store).i32())
                .unwrap_or(code);
            *store.data_mut() = Some(host_state);
            break ec;
        }
        if exit_flag != 0 && host_state.pending_action.is_none() {
            let ec = active_inst
                .get_global(&mut store, "exit_code")
                .and_then(|g| g.get(&mut store).i32())
                .unwrap_or(code);
            *store.data_mut() = Some(host_state);
            break ec;
        }
        if yield_flag == 0 && host_state.pending_action.is_none() {
            *store.data_mut() = Some(host_state);
            break code;
        }

        let mut sctx = StoreCtx::new(&mut store, &active_inst, mem, trace);
        let action = host_state
            .on_yield_multiproc(&mut sctx, yield_flag)
            .map_err(|e| anyhow::anyhow!("on_yield_multiproc failed: {}", e))?;
        match action {
            0 => {
                let ec = processes[&1000]
                    .get_global(&mut store, "exit_code")
                    .and_then(|g| g.get(&mut store).i32())
                    .unwrap_or(code);
                *store.data_mut() = Some(host_state);
                break ec;
            }
            1 => {
                *store.data_mut() = Some(host_state);
                continue;
            }
            2 => {
                active_pid = host_state.active_pid;
                let next_inst = *processes
                    .get(&active_pid)
                    .context("missing switched guest instance")?;
                let next_mem = next_inst
                    .get_memory(&mut store, "memory")
                    .context("missing exported memory")?;
                let mut next_ctx = StoreCtx::new(&mut store, &next_inst, next_mem, trace);
                host_state
                    .resume_active(&mut next_ctx)
                    .map_err(|e| anyhow::anyhow!("resume_active failed: {}", e))?;
                *store.data_mut() = Some(host_state);
                continue;
            }
            3 => {
                // NeedFork
                let (child_pid, scratch_addr) = match host_state.pending_action {
                    Some(PendingHostAction::Fork {
                        child_pid,
                        scratch_addr,
                        ..
                    }) => (child_pid, scratch_addr),
                    _ => anyhow::bail!("Expected PendingHostAction::Fork"),
                };
                let child_inst = Instance::new(&mut store, &module, &[])?;
                let child_mem = child_inst
                    .get_memory(&mut store, "memory")
                    .context("missing child memory")?;
                let parent_bytes = mem.data_size(&store);
                let child_bytes = child_mem.data_size(&store);
                if child_bytes < parent_bytes {
                    let pages = ((parent_bytes - child_bytes) + 65535) / 65536;
                    child_mem.grow(&mut store, pages as u64)?;
                }
                let mem_copy = mem.data(&store).to_vec();
                child_mem.data_mut(&mut store)[..mem_copy.len()].copy_from_slice(&mem_copy);

                let export_names: Vec<String> = module
                    .exports()
                    .map(|e| e.name().to_string())
                    .collect();
                for name in export_names {
                    if let (Some(pg), Some(cg)) = (
                        active_inst.get_global(&mut store, &name),
                        child_inst.get_global(&mut store, &name),
                    ) {
                        if pg.ty(&store).mutability() == wasmtime::Mutability::Var {
                            let val = pg.get(&mut store);
                            let _ = cg.set(&mut store, val);
                        }
                    }
                }
                if let Ok(load_ctx) = child_inst.get_typed_func::<i32, ()>(&mut store, "load_ctx") {
                    load_ctx.call(&mut store, scratch_addr as i32)?;
                }
                processes.insert(child_pid, child_inst);
                host_state.ack_fork(child_pid);
                active_pid = host_state.active_pid;
                let next_inst = *processes
                    .get(&active_pid)
                    .context("missing active guest instance after fork")?;
                let next_mem = next_inst
                    .get_memory(&mut store, "memory")
                    .context("missing exported memory")?;
                let mut next_ctx = StoreCtx::new(&mut store, &next_inst, next_mem, trace);
                host_state
                    .resume_active(&mut next_ctx)
                    .map_err(|e| anyhow::anyhow!("resume_active after fork failed: {}", e))?;
                *store.data_mut() = Some(host_state);
                continue;
            }
            other => {
                *store.data_mut() = Some(host_state);
                anyhow::bail!("Unsupported on_yield_multiproc action {} in native runner", other);
            }
        }
    };

    let state = store.data().as_ref().expect("HostState missing at exit");
    Ok(RunOutput {
        exit_code,
        stdout: state.vfs.stdout.clone(),
        stderr: state.vfs.stderr.clone(),
    })
}
