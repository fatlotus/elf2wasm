//! `wasmi` guest instance wrapper implementing `elf2wasm_runtime_core::context::GuestContext`.

use anyhow::{anyhow, Context, Result};
use elf2wasm_core::lifter::CTX_SIZE;
use elf2wasm_runtime_core::context::GuestContext;
use elf2wasm_runtime_core::syscalls::HostState;
use elf2wasm_runtime_core::vfs::{EFAULT, ENOMEM};
use wasmi::{Engine, Global, Instance, Memory, Module, Store, StoreLimits, StoreLimitsBuilder, TypedFunc, Val};

pub struct CachedGlobals {
    pub fsbase: Global,
    pub gsbase: Global,
    pub rcx: Global,
    pub rip: Global,
    pub rsp: Global,
    pub rax: Global,
    pub rdi: Global,
    pub rsi: Global,
    pub rdx: Global,
    pub r10: Global,
    pub r8: Global,
    pub r9: Global,
    pub exit_flag: Global,
    pub exit_code: Global,
    pub yield_flag: Global,
    pub quantum: Global,
}

impl CachedGlobals {
    fn from_instance(store: &Store<StoreLimits>, instance: &Instance) -> Result<Self> {
        let get = |name: &str| -> Result<Global> {
            instance
                .get_global(store, name)
                .ok_or_else(|| anyhow!("Guest WASM missing exported global '{}'", name))
        };
        Ok(Self {
            fsbase: get("fsbase")?,
            gsbase: get("gsbase")?,
            rcx: get("rcx")?,
            rip: get("rip")?,
            rsp: get("rsp")?,
            rax: get("rax")?,
            rdi: get("rdi")?,
            rsi: get("rsi")?,
            rdx: get("rdx")?,
            r10: get("r10")?,
            r8: get("r8")?,
            r9: get("r9")?,
            exit_flag: get("exit_flag")?,
            exit_code: get("exit_code")?,
            yield_flag: get("yield_flag")?,
            quantum: get("quantum")?,
        })
    }
}

pub struct GuestProcess {
    pub store: Store<StoreLimits>,
    pub module: Module,
    pub instance: Instance,
    pub memory: Memory,
    pub start_fn: TypedFunc<(), i32>,
    pub save_ctx_fn: TypedFunc<i32, ()>,
    pub load_ctx_fn: TypedFunc<i32, ()>,
    pub globals: CachedGlobals,
    pub elf_path: String,
}

impl GuestProcess {
    pub fn instantiate(
        engine: &Engine,
        module: Module,
        elf_path: String,
        max_memory_bytes: usize,
    ) -> Result<Self> {
        let limits = StoreLimitsBuilder::new()
            .memory_size(max_memory_bytes)
            .memories(1)
            .instances(1)
            .build();
        let mut store = Store::new(engine, limits);
        store.limiter(|lim| lim);
        // Set unlimited fuel for instantiation (guest modules have no start section,
        // but setting fuel avoids any surprises before the main loop budgets _start).
        let _ = store.set_fuel(u64::MAX);

        let instance = Instance::new(&mut store, &module, &[])
            .context("Failed to instantiate guest WASM module in wasmi")?;
        let memory = instance
            .get_memory(&store, "memory")
            .ok_or_else(|| anyhow!("Guest WASM missing exported 'memory'"))?;
        let start_fn = instance
            .get_typed_func::<(), i32>(&store, "_start")
            .context("Guest WASM missing exported '_start'")?;
        let save_ctx_fn = instance
            .get_typed_func::<i32, ()>(&store, "save_ctx")
            .context("Guest WASM missing exported 'save_ctx'")?;
        let load_ctx_fn = instance
            .get_typed_func::<i32, ()>(&store, "load_ctx")
            .context("Guest WASM missing exported 'load_ctx'")?;
        let globals = CachedGlobals::from_instance(&store, &instance)?;

        Ok(Self {
            store,
            module,
            instance,
            memory,
            start_fn,
            save_ctx_fn,
            load_ctx_fn,
            globals,
            elf_path,
        })
    }

    pub fn mem_byte_len(&self) -> usize {
        self.memory.data(&self.store).len()
    }

    pub fn get_i32(&self, g: &Global) -> i32 {
        g.get(&self.store).i32().unwrap_or(0)
    }

    pub fn get_i64(&self, g: &Global) -> i64 {
        g.get(&self.store).i64().unwrap_or(0)
    }

    pub fn set_i32(&mut self, g: Global, val: i32) {
        let _ = g.set(&mut self.store, Val::I32(val));
    }

    pub fn set_i64(&mut self, g: Global, val: i64) {
        let _ = g.set(&mut self.store, Val::I64(val));
    }

    pub fn as_ctx(&mut self) -> WasmiGuestContext<'_> {
        WasmiGuestContext { proc: self }
    }
}

pub struct WasmiGuestContext<'a> {
    proc: &'a mut GuestProcess,
}

impl<'a> GuestContext for WasmiGuestContext<'a> {
    fn mem_len(&self) -> usize {
        self.proc.memory.data(&self.proc.store).len()
    }

    fn mem_grow(&mut self, delta_pages: u32) -> Result<usize, i64> {
        let prev_pages = self
            .proc
            .memory
            .grow(&mut self.proc.store, delta_pages as u64)
            .map_err(|_| -ENOMEM)?;
        Ok((prev_pages as usize) * 65536)
    }

    fn mem_read(&self, addr: u64, buf: &mut [u8]) -> Result<(), i64> {
        if buf.is_empty() {
            return Ok(());
        }
        let start = usize::try_from(addr).map_err(|_| -EFAULT)?;
        let end = start.checked_add(buf.len()).ok_or(-EFAULT)?;
        let data = self.proc.memory.data(&self.proc.store);
        if end > data.len() {
            return Err(-EFAULT);
        }
        buf.copy_from_slice(&data[start..end]);
        Ok(())
    }

    fn mem_write(&mut self, addr: u64, src: &[u8]) -> Result<(), i64> {
        if src.is_empty() {
            return Ok(());
        }
        let start = usize::try_from(addr).map_err(|_| -EFAULT)?;
        let end = start.checked_add(src.len()).ok_or(-EFAULT)?;
        let data = self.proc.memory.data_mut(&mut self.proc.store);
        if end > data.len() {
            return Err(-EFAULT);
        }
        data[start..end].copy_from_slice(src);
        Ok(())
    }

    fn mem_zero(&mut self, addr: u64, len: usize) -> Result<(), i64> {
        if len == 0 {
            return Ok(());
        }
        let start = usize::try_from(addr).map_err(|_| -EFAULT)?;
        let end = start.checked_add(len).ok_or(-EFAULT)?;
        let data = self.proc.memory.data_mut(&mut self.proc.store);
        if end > data.len() {
            return Err(-EFAULT);
        }
        data[start..end].fill(0);
        Ok(())
    }

    fn mem_read_cstr(&self, addr: u64, max_len: usize) -> Result<String, i64> {
        let start = usize::try_from(addr).map_err(|_| -EFAULT)?;
        let data = self.proc.memory.data(&self.proc.store);
        if start >= data.len() {
            return Err(-EFAULT);
        }
        let limit = start.saturating_add(max_len).min(data.len());
        let slice = &data[start..limit];
        let nul = slice.iter().position(|&b| b == 0).unwrap_or(slice.len());
        Ok(String::from_utf8_lossy(&slice[..nul]).into_owned())
    }

    fn get_fsbase(&self) -> i64 {
        self.proc.get_i64(&self.proc.globals.fsbase)
    }
    fn set_fsbase(&mut self, val: i64) {
        let g = self.proc.globals.fsbase;
        self.proc.set_i64(g, val);
    }
    fn get_gsbase(&self) -> i64 {
        self.proc.get_i64(&self.proc.globals.gsbase)
    }
    fn set_gsbase(&mut self, val: i64) {
        let g = self.proc.globals.gsbase;
        self.proc.set_i64(g, val);
    }
    fn get_rcx(&self) -> i64 {
        self.proc.get_i64(&self.proc.globals.rcx)
    }
    fn set_rip(&mut self, val: i64) {
        let g = self.proc.globals.rip;
        self.proc.set_i64(g, val);
    }
    fn set_rsp(&mut self, val: i64) {
        let g = self.proc.globals.rsp;
        self.proc.set_i64(g, val);
    }
    fn get_rax(&self) -> i64 {
        self.proc.get_i64(&self.proc.globals.rax)
    }
    fn set_rax(&mut self, val: i64) {
        let g = self.proc.globals.rax;
        self.proc.set_i64(g, val);
    }
    fn get_rdi(&self) -> i64 {
        self.proc.get_i64(&self.proc.globals.rdi)
    }
    fn get_rsi(&self) -> i64 {
        self.proc.get_i64(&self.proc.globals.rsi)
    }
    fn get_rdx(&self) -> i64 {
        self.proc.get_i64(&self.proc.globals.rdx)
    }
    fn get_r10(&self) -> i64 {
        self.proc.get_i64(&self.proc.globals.r10)
    }
    fn get_r8(&self) -> i64 {
        self.proc.get_i64(&self.proc.globals.r8)
    }
    fn get_r9(&self) -> i64 {
        self.proc.get_i64(&self.proc.globals.r9)
    }

    fn set_exit(&mut self, code: i32) {
        let ef = self.proc.globals.exit_flag;
        let ec = self.proc.globals.exit_code;
        self.proc.set_i32(ef, 1);
        self.proc.set_i32(ec, code);
    }

    fn set_yield_flag(&mut self, val: i32) {
        let yf = self.proc.globals.yield_flag;
        self.proc.set_i32(yf, val);
    }

    fn set_quantum(&mut self, val: i32) {
        let q = self.proc.globals.quantum;
        self.proc.set_i32(q, val);
    }

    fn save_ctx(&mut self, scratch_addr: u32) -> Result<[u8; CTX_SIZE], i64> {
        // Temporarily grant unlimited fuel so internal context saves never trip OutOfFuel.
        let prev_fuel = self.proc.store.get_fuel().ok();
        let _ = self.proc.store.set_fuel(u64::MAX);
        let call_res = self
            .proc
            .save_ctx_fn
            .call(&mut self.proc.store, scratch_addr as i32);
        if let Some(f) = prev_fuel {
            let _ = self.proc.store.set_fuel(f);
        }
        call_res.map_err(|_| -EFAULT)?;
        let mut buf = [0u8; CTX_SIZE];
        self.mem_read(scratch_addr as u64, &mut buf)?;
        Ok(buf)
    }

    fn load_ctx(&mut self, scratch_addr: u32, buf: &[u8; CTX_SIZE]) -> Result<(), i64> {
        self.mem_write(scratch_addr as u64, buf)?;
        let prev_fuel = self.proc.store.get_fuel().ok();
        let _ = self.proc.store.set_fuel(u64::MAX);
        let call_res = self
            .proc
            .load_ctx_fn
            .call(&mut self.proc.store, scratch_addr as i32);
        if let Some(f) = prev_fuel {
            let _ = self.proc.store.set_fuel(f);
        }
        call_res.map_err(|_| -EFAULT)
    }
}

/// Clone a `GuestProcess` for `fork()` using sparse dirty-range memory copy
/// directly between disjoint `wasmi::Store` instances.
pub fn fork_guest_process(
    engine: &Engine,
    parent: &GuestProcess,
    state: &HostState,
    scratch_addr: u32,
    max_memory_bytes: usize,
) -> Result<GuestProcess> {
    let mut child = GuestProcess::instantiate(
        engine,
        parent.module.clone(),
        parent.elf_path.clone(),
        max_memory_bytes,
    )?;

    let parent_len = parent.mem_byte_len();
    let child_len = child.mem_byte_len();
    if parent_len > child_len {
        let delta_pages = ((parent_len - child_len) / 65536) as u64;
        if delta_pages > 0 {
            child
                .memory
                .grow(&mut child.store, delta_pages)
                .map_err(|e| anyhow!("MEMORY_LIMIT: fork memory grow failed: {}", e))?;
        }
    }

    // Sparse copy of active memory ranges (skips unmapped PROT_NONE holes).
    let ranges = state.fork_copy_ranges(parent_len);
    {
        let p_data = parent.memory.data(&parent.store);
        let c_data = child.memory.data_mut(&mut child.store);
        for (start, end) in ranges {
            let s = start.min(p_data.len()).min(c_data.len());
            let e = end.min(p_data.len()).min(c_data.len());
            if e > s {
                c_data[s..e].copy_from_slice(&p_data[s..e]);
            }
        }
    }

    // Copy all exported globals from parent to child.
    let global_vals: Vec<(String, Val)> = parent
        .instance
        .exports(&parent.store)
        .filter_map(|exp| {
            let name = exp.name().to_string();
            exp.into_global()
                .map(|g| (name, g.get(&parent.store)))
        })
        .collect();
    for (name, val) in global_vals {
        if let Some(cg) = child.instance.get_global(&child.store, &name) {
            let _ = cg.set(&mut child.store, val);
        }
    }

    // Restore full CPU context (including xmm0..xmm15 & flags) from scratch_addr.
    let _ = child.store.set_fuel(u64::MAX);
    child
        .load_ctx_fn
        .call(&mut child.store, scratch_addr as i32)
        .context("fork child load_ctx failed")?;

    Ok(child)
}
