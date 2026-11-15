use crate::syscalls::HostState;
use crate::vfs::{VirtualFs, EFAULT, EINVAL, ENOMEM, ENOSYS};
use anyhow::{Context, Result};
use elf2wasm_core::lifter::CTX_SIZE;
use elf2wasm_runtime_core::context::GuestContext;
pub use elf2wasm_runtime_core::stack::{
    extract_elf2wasm_meta, setup_guest_stack, RunConfig, RunOutput,
};
use elf2wasm_runtime_core::syscalls::handle_syscall;
use wasmtime::{Caller, Engine, Instance, Linker, Memory, Module, Store, Val};

struct CallerCtx<'a, 'b> {
    caller: &'a mut Caller<'b, Option<HostState>>,
    mem: Memory,
    trace: bool,
}

impl<'a, 'b> CallerCtx<'a, 'b> {
    fn get_global_i64(&mut self, name: &str) -> i64 {
        self.caller
            .get_export(name)
            .and_then(|e| e.into_global())
            .and_then(|g| g.get(&mut *self.caller).i64())
            .unwrap_or(0)
    }

    fn set_global_i64(&mut self, name: &str, val: i64) {
        if let Some(g) = self.caller.get_export(name).and_then(|e| e.into_global()) {
            let _ = g.set(&mut *self.caller, Val::I64(val));
        }
    }

    fn set_global_i32(&mut self, name: &str, val: i32) {
        if let Some(g) = self.caller.get_export(name).and_then(|e| e.into_global()) {
            let _ = g.set(&mut *self.caller, Val::I32(val));
        }
    }
}

impl<'a, 'b> GuestContext for CallerCtx<'a, 'b> {
    fn mem_len(&self) -> usize {
        self.mem.data_size(&*self.caller)
    }

    fn mem_read(&self, addr: u64, buf: &mut [u8]) -> Result<(), i64> {
        if buf.is_empty() {
            return Ok(());
        }
        if addr == 0 {
            return Err(-EFAULT);
        }
        let mem_size = self.mem.data_size(&*self.caller);
        let start = usize::try_from(addr).map_err(|_| -EFAULT)?;
        let end = start.checked_add(buf.len()).ok_or(-EFAULT)?;
        if end > mem_size {
            return Err(-EFAULT);
        }
        self.mem.read(&*self.caller, start, buf).map_err(|_| -EFAULT)
    }

    fn mem_write(&mut self, addr: u64, data: &[u8]) -> Result<(), i64> {
        if data.is_empty() {
            return Ok(());
        }
        if addr == 0 {
            return Err(-EFAULT);
        }
        let mem_size = self.mem.data_size(&*self.caller);
        let start = usize::try_from(addr).map_err(|_| -EFAULT)?;
        let end = start.checked_add(data.len()).ok_or(-EFAULT)?;
        if end > mem_size {
            return Err(-EFAULT);
        }
        self.mem
            .write(&mut *self.caller, start, data)
            .map_err(|_| -EFAULT)
    }

    fn mem_zero(&mut self, addr: u64, len: usize) -> Result<(), i64> {
        if len == 0 {
            return Ok(());
        }
        let mem_size = self.mem.data_size(&*self.caller);
        let start = usize::try_from(addr).map_err(|_| -ENOMEM)?;
        let end = start.checked_add(len).ok_or(-ENOMEM)?;
        if end > mem_size {
            return Err(-ENOMEM);
        }
        self.mem.data_mut(&mut *self.caller)[start..end].fill(0);
        Ok(())
    }

    fn mem_read_cstr(&self, addr: u64, max_len: usize) -> Result<String, i64> {
        if addr == 0 {
            return Err(-EFAULT);
        }
        let data = self.mem.data(&*self.caller);
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
        0
    }

    fn set_fsbase(&mut self, val: i64) {
        self.set_global_i64("fsbase", val);
    }

    fn get_gsbase(&self) -> i64 {
        0
    }

    fn set_gsbase(&mut self, val: i64) {
        self.set_global_i64("gsbase", val);
    }

    fn get_rcx(&self) -> i64 {
        0
    }

    fn set_rip(&mut self, val: i64) {
        self.set_global_i64("rip", val);
    }

    fn set_rsp(&mut self, val: i64) {
        self.set_global_i64("rsp", val);
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
            .caller
            .get_export("save_ctx")
            .and_then(|e| e.into_func())
            .and_then(|f| f.typed::<i32, ()>(&*self.caller).ok())
            .ok_or(-ENOSYS)?;
        func.call(&mut *self.caller, scratch_addr as i32)
            .map_err(|_| -EFAULT)?;
        let mut buf = [0u8; CTX_SIZE];
        self.mem_read(scratch_addr as u64, &mut buf)?;
        Ok(buf)
    }

    fn load_ctx(&mut self, scratch_addr: u32, buf: &[u8; CTX_SIZE]) -> Result<(), i64> {
        self.mem_write(scratch_addr as u64, buf)?;
        let func = self
            .caller
            .get_export("load_ctx")
            .and_then(|e| e.into_func())
            .and_then(|f| f.typed::<i32, ()>(&*self.caller).ok())
            .ok_or(-ENOSYS)?;
        func.call(&mut *self.caller, scratch_addr as i32)
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

/// Wrapper for `CallerCtx` that caches `fsbase`, `gsbase`, and `rcx` before `handle_syscall`
/// since `wasmtime::Global::get` requires `&mut Caller`.
struct CallerCtxCached<'a, 'b> {
    inner: CallerCtx<'a, 'b>,
    fsbase: i64,
    gsbase: i64,
    rcx: i64,
}

impl<'a, 'b> CallerCtxCached<'a, 'b> {
    fn new(caller: &'a mut Caller<'b, Option<HostState>>, mem: Memory, trace: bool) -> Self {
        let mut inner = CallerCtx { caller, mem, trace };
        let fsbase = inner.get_global_i64("fsbase");
        let gsbase = inner.get_global_i64("gsbase");
        let rcx = inner.get_global_i64("rcx");
        Self {
            inner,
            fsbase,
            gsbase,
            rcx,
        }
    }
}

impl<'a, 'b> GuestContext for CallerCtxCached<'a, 'b> {
    fn mem_len(&self) -> usize {
        self.inner.mem_len()
    }
    fn mem_read(&self, addr: u64, buf: &mut [u8]) -> Result<(), i64> {
        self.inner.mem_read(addr, buf)
    }
    fn mem_write(&mut self, addr: u64, data: &[u8]) -> Result<(), i64> {
        self.inner.mem_write(addr, data)
    }
    fn mem_zero(&mut self, addr: u64, len: usize) -> Result<(), i64> {
        self.inner.mem_zero(addr, len)
    }
    fn mem_read_cstr(&self, addr: u64, max_len: usize) -> Result<String, i64> {
        self.inner.mem_read_cstr(addr, max_len)
    }
    fn get_fsbase(&self) -> i64 {
        self.fsbase
    }
    fn set_fsbase(&mut self, val: i64) {
        self.fsbase = val;
        self.inner.set_fsbase(val);
    }
    fn get_gsbase(&self) -> i64 {
        self.gsbase
    }
    fn set_gsbase(&mut self, val: i64) {
        self.gsbase = val;
        self.inner.set_gsbase(val);
    }
    fn get_rcx(&self) -> i64 {
        self.rcx
    }
    fn set_rip(&mut self, val: i64) {
        self.inner.set_rip(val);
    }
    fn set_rsp(&mut self, val: i64) {
        self.inner.set_rsp(val);
    }
    fn set_exit(&mut self, code: i32) {
        self.inner.set_exit(code);
    }
    fn set_yield_flag(&mut self, val: i32) {
        self.inner.set_yield_flag(val);
    }
    fn set_quantum(&mut self, val: i32) {
        self.inner.set_quantum(val);
    }
    fn save_ctx(&mut self, scratch_addr: u32) -> Result<[u8; CTX_SIZE], i64> {
        self.inner.save_ctx(scratch_addr)
    }
    fn load_ctx(&mut self, scratch_addr: u32, buf: &[u8; CTX_SIZE]) -> Result<(), i64> {
        self.inner.load_ctx(scratch_addr, buf)
    }
    fn trace_enabled(&self) -> bool {
        self.inner.trace_enabled()
    }
    fn trace_log(&self, msg: &str) {
        self.inner.trace_log(msg);
    }
}

struct StoreCtx<'a> {
    store: &'a mut Store<Option<HostState>>,
    instance: &'a Instance,
    mem: Memory,
    fsbase: i64,
    gsbase: i64,
    rcx: i64,
    trace: bool,
}

impl<'a> StoreCtx<'a> {
    fn new(
        store: &'a mut Store<Option<HostState>>,
        instance: &'a Instance,
        mem: Memory,
        trace: bool,
    ) -> Self {
        let fsbase = instance
            .get_global(&mut *store, "fsbase")
            .and_then(|g| g.get(&mut *store).i64())
            .unwrap_or(0);
        let gsbase = instance
            .get_global(&mut *store, "gsbase")
            .and_then(|g| g.get(&mut *store).i64())
            .unwrap_or(0);
        let rcx = instance
            .get_global(&mut *store, "rcx")
            .and_then(|g| g.get(&mut *store).i64())
            .unwrap_or(0);
        Self {
            store,
            instance,
            mem,
            fsbase,
            gsbase,
            rcx,
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

pub fn run_wasm(wasm_bytes: &[u8], config: RunConfig) -> Result<RunOutput> {
    let meta = extract_elf2wasm_meta(wasm_bytes)?;
    let engine = Engine::default();
    let module = Module::new(&engine, wasm_bytes)?;
    let trace = std::env::var_os("ELF2WASM_TRACE").is_some();

    let mut linker: Linker<Option<HostState>> = Linker::new(&engine);
    linker.func_wrap(
        "env",
        "syscall",
        move |mut caller: Caller<'_, Option<HostState>>,
              nr: i64,
              a0: i64,
              a1: i64,
              a2: i64,
              a3: i64,
              a4: i64,
              a5: i64|
              -> i64 {
            let mem = caller
                .get_export("memory")
                .and_then(|e| e.into_memory())
                .expect("missing exported memory");
            let mut host_state = caller
                .data_mut()
                .take()
                .expect("HostState missing during syscall");
            let mut ctx = CallerCtxCached::new(&mut caller, mem, trace);
            let ret = handle_syscall(&mut ctx, &mut host_state, nr, a0, a1, a2, a3, a4, a5);
            *caller.data_mut() = Some(host_state);
            ret
        },
    )?;

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
    let host_state = HostState::new(vfs);
    let mut store = Store::new(&engine, Some(host_state));

    let instance = linker.instantiate(&mut store, &module)?;
    let mem = instance
        .get_memory(&mut store, "memory")
        .context("missing exported memory")?;

    let initial_rsp = {
        let mem_slice = mem.data_mut(&mut store);
        setup_guest_stack(mem_slice, &meta, &config)?
    };

    instance
        .get_global(&mut store, "rsp")
        .context("missing rsp global")?
        .set(&mut store, Val::I64(initial_rsp as i64))?;

    instance
        .get_global(&mut store, "rip")
        .context("missing rip global")?
        .set(&mut store, Val::I64(meta.entry_rip as i64))?;

    let start = instance.get_typed_func::<(), i32>(&mut store, "_start")?;
    let exit_code = loop {
        let code = match start.call(&mut store, ()) {
            Ok(code) => code,
            Err(err) => {
                let rip = instance
                    .get_global(&mut store, "rip")
                    .and_then(|g| g.get(&mut store).i64())
                    .unwrap_or(-1) as u64;
                let rsp = instance
                    .get_global(&mut store, "rsp")
                    .and_then(|g| g.get(&mut store).i64())
                    .unwrap_or(-1) as u64;
                let rax = instance
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
        let yield_flag = instance
            .get_global(&mut store, "yield_flag")
            .and_then(|g| g.get(&mut store).i32())
            .unwrap_or(0);
        let exit_flag = instance
            .get_global(&mut store, "exit_flag")
            .and_then(|g| g.get(&mut store).i32())
            .unwrap_or(0);
        if exit_flag != 0 {
            let exit_code = instance
                .get_global(&mut store, "exit_code")
                .and_then(|g| g.get(&mut store).i32())
                .unwrap_or(code);
            break exit_code;
        }
        if yield_flag != 0 {
            let mut host_state = store
                .data_mut()
                .take()
                .expect("HostState missing during yield");
            let mut sctx = StoreCtx::new(&mut store, &instance, mem, trace);
            let cont = host_state
                .scheduler
                .on_yield(&mut sctx, yield_flag)
                .map_err(|e| anyhow::anyhow!("scheduler on_yield failed: {}", e))?;
            *store.data_mut() = Some(host_state);
            if !cont {
                break code;
            }
            continue;
        }
        break code;
    };

    let state = store.data().as_ref().expect("HostState missing at exit");
    Ok(RunOutput {
        exit_code,
        stdout: state.vfs.stdout.clone(),
        stderr: state.vfs.stderr.clone(),
    })
}
