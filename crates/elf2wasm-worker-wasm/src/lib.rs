//! Self-contained WASM interpreter runtime (`cdylib` + `rlib`) for Cloudflare Workers.
//!
//! Bundles `elf2wasm-core` (x86-64 ELF64 lifter), `elf2wasm-runtime-core` (deterministic
//! Linux syscall/VFS/scheduler runtime), and `wasmi` (SIMD + fuel metering + deterministic
//! execution) so guest x86-64 binaries can be lifted and executed with **zero** dynamic
//! `WebAssembly.compile()` calls.

pub mod elf_resolve;
pub mod wasmi_guest;

use anyhow::{anyhow, Result};
use base64::Engine as _;
use core::cell::UnsafeCell;
use elf2wasm_core::decoder::{discover_code, split_indirect_targets};
use elf2wasm_core::elf_loader::{load_elf_and_sos_bytes_with_layout, MemoryLayoutConfig};
use elf2wasm_core::lifter::YIELD_SYSCALL_PENDING;
use elf2wasm_core::meta::WasmMeta;
use elf2wasm_core::wasm_emit::emit_wasm;
use elf2wasm_runtime_core::context::GuestContext;
use elf2wasm_runtime_core::scheduler::ThreadState;
use elf2wasm_runtime_core::stack::{
    extract_elf2wasm_meta, setup_guest_stack_ctx_with_ids_and_random,
};
use elf2wasm_runtime_core::syscalls::{handle_syscall, HostState, PendingHostAction};
use elf2wasm_runtime_core::vfs::{
    encode_vfs_diff_json, normalize_guest_path, VirtualFs, ENOENT,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use wasmi::{CompilationMode, Config, Engine, Module, TrapCode};

use crate::elf_resolve::{resolve_command_and_sos, resolve_elf_sos, resolve_vfs_path, DEFAULT_PATH};
use crate::wasmi_guest::{fork_guest_process, GuestProcess};

const DEFAULT_MAX_FUEL: u64 = 500_000_000;
const DEFAULT_MAX_MEMORY_BYTES: usize = 64 * 1024 * 1024;
const MAX_CACHED_MODULES: usize = 8;

fn default_env() -> Vec<String> {
    vec![format!("PATH={}", DEFAULT_PATH)]
}

fn default_cwd() -> String {
    "/".to_string()
}

fn default_max_fuel() -> u64 {
    DEFAULT_MAX_FUEL
}

fn default_max_memory_bytes() -> usize {
    DEFAULT_MAX_MEMORY_BYTES
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCommandRequest {
    pub cmd: Vec<String>,
    #[serde(default = "default_env")]
    pub env: Vec<String>,
    #[serde(default = "default_cwd")]
    pub cwd: String,
    #[serde(default)]
    pub uid: u32,
    #[serde(default)]
    pub gid: u32,
    #[serde(default)]
    pub stdin_base64: String,
    #[serde(default)]
    pub delay_stddev_ms: f64,
    #[serde(default)]
    pub delay_seed: u64,
    #[serde(default = "default_max_fuel")]
    pub max_fuel: u64,
    #[serde(default = "default_max_memory_bytes")]
    pub max_memory_bytes: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCommandResponse {
    pub ok: bool,
    pub exit_code: i32,
    pub stdout_base64: String,
    pub stderr_base64: String,
    pub virtual_time_ns: String,
    pub timed_out: bool,
    pub error: Option<String>,
    pub error_code: Option<String>,
}

impl RunCommandResponse {
    fn error(code: &str, msg: impl Into<String>, exit_code: i32, timed_out: bool) -> Self {
        Self {
            ok: false,
            exit_code,
            stdout_base64: String::new(),
            stderr_base64: String::new(),
            virtual_time_ns: "0".to_string(),
            timed_out,
            error: Some(msg.into()),
            error_code: Some(code.to_string()),
        }
    }
}

#[derive(Clone)]
struct CachedCompiledGuest {
    module: Module,
    meta: Arc<WasmMeta>,
}

pub struct WorkerSession {
    pub state: HostState,
    engine: Engine,
    layout: MemoryLayoutConfig,
    module_cache: HashMap<(String, u64), CachedCompiledGuest>,
}

fn fnv1a_bytes(hash: &mut u64, bytes: &[u8]) {
    for &b in bytes {
        *hash ^= b as u64;
        *hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
}

fn compute_bundle_hash(main_bytes: &[u8], sos: &[(String, Vec<u8>)]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    fnv1a_bytes(&mut h, &(main_bytes.len() as u64).to_le_bytes());
    fnv1a_bytes(&mut h, main_bytes);
    for (p, b) in sos {
        fnv1a_bytes(&mut h, p.as_bytes());
        fnv1a_bytes(&mut h, &(b.len() as u64).to_le_bytes());
        fnv1a_bytes(&mut h, b);
    }
    h
}

fn is_memory_limit_error(msg: &str) -> bool {
    let lower = msg.to_ascii_lowercase();
    lower.contains("memory_limit")
        || lower.contains("exceeds guest memory limit")
        || lower.contains("exceeds guest code/data limit")
        || lower.contains("exceeds maximum linear memory")
        || lower.contains("exceeding maximum")
        || lower.contains("exceeds reserved")
        || lower.contains("memory limit")
        || lower.contains("resource limiter")
        || lower.contains("resourcelimiter")
        || lower.contains("out of memory")
}

impl WorkerSession {
    pub fn new() -> Self {
        let mut config = Config::default();
        config.wasm_simd(true);
        config.consume_fuel(true);
        config.compilation_mode(CompilationMode::LazyTranslation);
        config.ignore_custom_sections(true);
        let engine = Engine::new(&config);
        let mut state = HostState::new(VirtualFs::new_in_memory(&[]));
        state.multiproc_enabled = true;
        Self {
            state,
            engine,
            layout: MemoryLayoutConfig::compact(),
            module_cache: HashMap::new(),
        }
    }

    pub fn reset(&mut self) {
        let mut state = HostState::new(VirtualFs::new_in_memory(&[]));
        state.multiproc_enabled = true;
        self.state = state;
    }

    fn compile_or_get_guest(
        &mut self,
        elf_path: &str,
        elf_bytes: &[u8],
        sos: &[(String, Vec<u8>)],
    ) -> Result<CachedCompiledGuest> {
        let hash = compute_bundle_hash(elf_bytes, sos);
        let key = (elf_path.to_string(), hash);
        if let Some(cached) = self.module_cache.get(&key) {
            return Ok(cached.clone());
        }

        let so_refs: Vec<(&str, &[u8])> = sos
            .iter()
            .map(|(p, b)| (p.as_str(), b.as_slice()))
            .collect();
        let image = load_elf_and_sos_bytes_with_layout(elf_path, elf_bytes, &so_refs, &self.layout)?;
        let mut prog = discover_code(&image)?;
        split_indirect_targets(&image, &mut prog);
        let wasm_bytes = emit_wasm(&image, &prog)?;
        let meta = extract_elf2wasm_meta(&wasm_bytes)?;
        let module = Module::new(&self.engine, &wasm_bytes)?;

        let compiled = CachedCompiledGuest {
            module,
            meta: Arc::new(meta),
        };
        if self.module_cache.len() >= MAX_CACHED_MODULES {
            self.module_cache.clear();
        }
        self.module_cache.insert(key, compiled.clone());
        Ok(compiled)
    }

    fn apply_initial_cwd(&mut self, cwd: &str) {
        let norm = normalize_guest_path(if cwd.is_empty() { "/" } else { cwd });
        if norm == "/" {
            return;
        }
        if self.state.vfs.chdir(&norm) == -ENOENT {
            self.state.vfs.vfs_add_dir(&norm, 0o755);
            let _ = self.state.vfs.chdir(&norm);
        }
    }

    pub fn run_command(&mut self, req: &RunCommandRequest) -> RunCommandResponse {
        if req.cmd.is_empty() || req.cmd[0].is_empty() {
            return RunCommandResponse::error("INVALID_REQUEST", "cmd must be non-empty", 126, false);
        }

        let stdin_bytes = if req.stdin_base64.is_empty() {
            Vec::new()
        } else {
            match base64::engine::general_purpose::STANDARD.decode(&req.stdin_base64) {
                Ok(b) => b,
                Err(e) => {
                    return RunCommandResponse::error(
                        "INVALID_REQUEST",
                        format!("Invalid stdinBase64: {}", e),
                        126,
                        false,
                    );
                }
            }
        };

        let env = if req.env.is_empty() {
            default_env()
        } else {
            req.env.clone()
        };

        let resolved = match resolve_command_and_sos(&self.state.vfs, &req.cmd, &env, &req.cwd) {
            Ok(r) => r,
            Err(e) => {
                return RunCommandResponse::error("EXEC_ERROR", e, 127, false);
            }
        };

        let compiled = match self.compile_or_get_guest(
            &resolved.elf_path,
            &resolved.elf_bytes,
            &resolved.sos,
        ) {
            Ok(c) => c,
            Err(e) => {
                let msg = format!("{:#}", e);
                let code = if is_memory_limit_error(&msg) {
                    "MEMORY_LIMIT"
                } else {
                    "EXEC_ERROR"
                };
                return RunCommandResponse::error(code, msg, 126, false);
            }
        };

        let max_mem = req.max_memory_bytes.max(16 * 1024 * 1024);
        let mut main_proc = match GuestProcess::instantiate(
            &self.engine,
            compiled.module.clone(),
            resolved.elf_path.clone(),
            max_mem,
        ) {
            Ok(p) => p,
            Err(e) => {
                let msg = format!("{:#}", e);
                let code = if is_memory_limit_error(&msg) {
                    "MEMORY_LIMIT"
                } else {
                    "WASM_TRAP"
                };
                return RunCommandResponse::error(code, msg, 126, false);
            }
        };

        // Configure deterministic timing, PRNG, UID/GID BEFORE reset_for_new_run()!
        let stddev_ns = if req.delay_stddev_ms.is_finite() && req.delay_stddev_ms > 0.0 {
            (req.delay_stddev_ms * 1_000_000.0).round() as u64
        } else {
            0
        };
        self.state.set_delay_config(stddev_ns, req.delay_seed);
        self.state.reset_virtual_time();
        self.state.set_uid_gid(req.uid, req.gid);
        self.state.set_tty_mode(false);
        self.state.set_stdin_open(false);

        self.state.reset_for_new_run();
        self.state.apply_meta_layout(&compiled.meta);
        self.state.vfs.set_so_files(&compiled.meta.so_files);
        self.state.vfs.elf_path = compiled.meta.elf_path.clone();
        self.state.vfs.cmdline = resolved.argv.clone();

        let at_random = self.state.at_random_bytes();
        let rsp = {
            let mut ctx = main_proc.as_ctx();
            match setup_guest_stack_ctx_with_ids_and_random(
                &mut ctx,
                &compiled.meta,
                &resolved.argv,
                &env,
                self.state.uid,
                self.state.gid,
                at_random,
            ) {
                Ok(r) => r,
                Err(e) => {
                    return RunCommandResponse::error(
                        "EXEC_ERROR",
                        format!("Failed to initialize guest stack: {:#}", e),
                        126,
                        false,
                    );
                }
            }
        };
        {
            let mut ctx = main_proc.as_ctx();
            ctx.set_rsp(rsp as i64);
            ctx.set_rip(compiled.meta.entry_rip as i64);
        }

        // Apply initial cwd and stdin AFTER reset_for_new_run().
        self.apply_initial_cwd(&req.cwd);
        if !stdin_bytes.is_empty() {
            self.state.push_stdin(&stdin_bytes);
        }
        self.state.close_stdin();

        let mut processes: BTreeMap<i32, GuestProcess> = BTreeMap::new();
        processes.insert(1000, main_proc);
        let mut active_pid: i32 = 1000;
        let mut remaining_fuel: u64 = if req.max_fuel == 0 {
            DEFAULT_MAX_FUEL
        } else {
            req.max_fuel
        };
        let mut skip_start = false;
        let mut last_code: i32 = 0;

        let mut fatal_error: Option<(&'static str, String, bool)> = None;

        loop {
            // Reap exited child processes immediately to reclaim their wasmi::Store memory.
            for reaped_pid in self.state.take_reaped_pids() {
                if reaped_pid != 1000 && reaped_pid != active_pid {
                    processes.remove(&reaped_pid);
                }
            }

            if !skip_start {
                if remaining_fuel == 0 {
                    fatal_error = Some((
                        "FUEL_EXHAUSTED",
                        "Execution exceeded fuel limit".to_string(),
                        true,
                    ));
                    break;
                }
                let Some(proc) = processes.get_mut(&active_pid) else {
                    fatal_error = Some((
                        "WASM_TRAP",
                        format!("Missing active process pid={}", active_pid),
                        false,
                    ));
                    break;
                };
                let _ = proc.store.set_fuel(remaining_fuel);
                match proc.start_fn.call(&mut proc.store, ()) {
                    Ok(code) => {
                        remaining_fuel = proc.store.get_fuel().unwrap_or(0);
                        last_code = code;
                    }
                    Err(e) => {
                        if e.as_trap_code() == Some(TrapCode::OutOfFuel) {
                            fatal_error = Some((
                                "FUEL_EXHAUSTED",
                                "Execution exceeded fuel limit".to_string(),
                                true,
                            ));
                        } else {
                            let rip = proc.get_i64(&proc.globals.rip) as u64;
                            let rsp_val = proc.get_i64(&proc.globals.rsp) as u64;
                            let rax = proc.get_i64(&proc.globals.rax);
                            let msg = format!(
                                "WASM trap in {} (pid={}, rip=0x{:x}, rsp=0x{:x}, rax={}): {}",
                                proc.elf_path, active_pid, rip, rsp_val, rax, e
                            );
                            let err_code = if is_memory_limit_error(&msg) {
                                "MEMORY_LIMIT"
                            } else {
                                "WASM_TRAP"
                            };
                            fatal_error = Some((err_code, msg, false));
                        }
                        break;
                    }
                }
            }
            skip_start = false;

            if self.state.is_main_exited() {
                break;
            }

            let (mut yield_flag, mut exit_flag) = {
                let proc = processes.get(&active_pid).unwrap();
                (
                    proc.get_i32(&proc.globals.yield_flag),
                    proc.get_i32(&proc.globals.exit_flag),
                )
            };

            if exit_flag != 0 && self.state.pending_action.is_none() {
                break;
            }

            if yield_flag == YIELD_SYSCALL_PENDING {
                let proc = processes.get_mut(&active_pid).unwrap();
                let mut ctx = proc.as_ctx();
                let nr = ctx.get_rax();
                let a0 = ctx.get_rdi();
                let a1 = ctx.get_rsi();
                let a2 = ctx.get_rdx();
                let a3 = ctx.get_r10();
                let a4 = ctx.get_r8();
                let a5 = ctx.get_r9();
                let ret = handle_syscall(&mut ctx, &mut self.state, nr, a0, a1, a2, a3, a4, a5);
                ctx.set_rax(ret);

                if self.state.is_main_exited() {
                    break;
                }

                yield_flag = proc.get_i32(&proc.globals.yield_flag);
                exit_flag = proc.get_i32(&proc.globals.exit_flag);
                if exit_flag != 0 && self.state.pending_action.is_none() {
                    break;
                }

                // Fast-path matching elf2wasm-runtime-wasm: avoid scheduler round-trip when
                // no pending host action, other runnable threads/processes, or expired timers exist.
                if yield_flag == YIELD_SYSCALL_PENDING && self.state.pending_action.is_none() {
                    let other_runnable = !self.state.scheduler.run_queue.is_empty()
                        || self.state.has_expired_timed_waiter()
                        || self.state.processes.iter().any(|(&pid, p)| {
                            pid != self.state.active_pid
                                && !p.exited
                                && p.scheduler
                                    .threads
                                    .values()
                                    .any(|t| t.state == ThreadState::Runnable)
                        });
                    if !other_runnable {
                        proc.as_ctx().set_yield_flag(0);
                        continue;
                    }
                }
            }

            if yield_flag == 0 && self.state.pending_action.is_none() {
                break;
            }

            let action = {
                let proc = processes.get_mut(&active_pid).unwrap();
                let mut ctx = proc.as_ctx();
                match self.state.on_yield_multiproc(&mut ctx, yield_flag) {
                    Ok(a) => a,
                    Err(e) => {
                        fatal_error = Some(("WASM_TRAP", format!("on_yield error: {}", e), false));
                        break;
                    }
                }
            };

            match action {
                0 => {
                    // Exited
                    break;
                }
                1 => {
                    // Continue current active_pid
                }
                2 => {
                    // SwitchPid
                    active_pid = self.state.active_pid;
                    for reaped_pid in self.state.take_reaped_pids() {
                        if reaped_pid != 1000 && reaped_pid != active_pid {
                            processes.remove(&reaped_pid);
                        }
                    }
                    let Some(proc) = processes.get_mut(&active_pid) else {
                        fatal_error = Some((
                            "WASM_TRAP",
                            format!("SwitchPid target pid={} not found", active_pid),
                            false,
                        ));
                        break;
                    };
                    let mut ctx = proc.as_ctx();
                    match self.state.resume_active(&mut ctx) {
                        Ok(true) => {}
                        Ok(false) => {
                            skip_start = true;
                        }
                        Err(e) => {
                            fatal_error = Some(("WASM_TRAP", format!("resume_active error: {}", e), false));
                            break;
                        }
                    }
                }
                3 => {
                    // NeedFork
                    let (child_pid, scratch_addr) = match self.state.pending_action {
                        Some(PendingHostAction::Fork {
                            child_pid,
                            scratch_addr,
                            ..
                        }) => (child_pid, scratch_addr),
                        _ => {
                            fatal_error = Some((
                                "WASM_TRAP",
                                "NeedFork without PendingHostAction::Fork".to_string(),
                                false,
                            ));
                            break;
                        }
                    };

                    // Enforce aggregate memory budget across live processes to prevent isolate OOM.
                    let total_mem: usize = processes.values().map(|p| p.mem_byte_len()).sum();
                    let parent_mem = processes
                        .get(&active_pid)
                        .map(|p| p.mem_byte_len())
                        .unwrap_or(0);
                    let total_budget = max_mem.saturating_mul(2);
                    if total_mem.saturating_add(parent_mem) > total_budget {
                        fatal_error = Some((
                            "MEMORY_LIMIT",
                            format!(
                                "Fork would exceed worker memory budget ({} + {} > {} bytes)",
                                total_mem, parent_mem, total_budget
                            ),
                            false,
                        ));
                        break;
                    }

                    let child_proc = {
                        let parent = processes.get(&active_pid).unwrap();
                        fork_guest_process(
                            &self.engine,
                            parent,
                            &self.state,
                            scratch_addr,
                            max_mem,
                        )
                    };
                    let child_proc = match child_proc {
                        Ok(p) => p,
                        Err(e) => {
                            let msg = format!("{:#}", e);
                            let code = if is_memory_limit_error(&msg) {
                                "MEMORY_LIMIT"
                            } else {
                                "WASM_TRAP"
                            };
                            fatal_error = Some((code, msg, false));
                            break;
                        }
                    };
                    processes.insert(child_pid, child_proc);
                    self.state.ack_fork(child_pid);
                    active_pid = self.state.active_pid;
                    let proc = processes.get_mut(&active_pid).unwrap();
                    let mut ctx = proc.as_ctx();
                    match self.state.resume_active(&mut ctx) {
                        Ok(true) => {}
                        Ok(false) => {
                            skip_start = true;
                        }
                        Err(e) => {
                            fatal_error = Some(("WASM_TRAP", format!("resume_active after fork error: {}", e), false));
                            break;
                        }
                    }
                }
                4 => {
                    // NeedExec
                    let (exec_pid, exec_path, exec_argv, exec_envp) =
                        match self.state.pending_action.take() {
                            Some(PendingHostAction::Exec {
                                pid,
                                path,
                                argv,
                                envp,
                            }) => (pid, path, argv, envp),
                            _ => {
                                fatal_error = Some((
                                    "WASM_TRAP",
                                    "NeedExec without PendingHostAction::Exec".to_string(),
                                    false,
                                ));
                                break;
                            }
                        };

                    let resolved_path = resolve_vfs_path(&self.state.vfs, &exec_path);
                    let Some(elf_bytes) = self.state.vfs.vfs_read_file(&resolved_path) else {
                        fatal_error = Some((
                            "EXEC_ERROR",
                            format!("execve target not found in VFS: {}", exec_path),
                            false,
                        ));
                        break;
                    };
                    let sos = resolve_elf_sos(
                        &self.state.vfs,
                        &exec_path,
                        &elf_bytes,
                        &exec_envp,
                        &exec_argv,
                    );
                    let exec_compiled = match self.compile_or_get_guest(&exec_path, &elf_bytes, &sos) {
                        Ok(c) => c,
                        Err(e) => {
                            let msg = format!("{:#}", e);
                            let code = if is_memory_limit_error(&msg) {
                                "MEMORY_LIMIT"
                            } else {
                                "EXEC_ERROR"
                            };
                            fatal_error = Some((code, msg, false));
                            break;
                        }
                    };

                    // Drop old process store before allocating the new one to keep peak RAM low.
                    processes.remove(&exec_pid);
                    let mut new_proc = match GuestProcess::instantiate(
                        &self.engine,
                        exec_compiled.module.clone(),
                        exec_path.clone(),
                        max_mem,
                    ) {
                        Ok(p) => p,
                        Err(e) => {
                            let msg = format!("{:#}", e);
                            let code = if is_memory_limit_error(&msg) {
                                "MEMORY_LIMIT"
                            } else {
                                "WASM_TRAP"
                            };
                            fatal_error = Some((code, msg, false));
                            break;
                        }
                    };
                    let complete_res = {
                        let mut ctx = new_proc.as_ctx();
                        self.state.complete_exec(
                            &mut ctx,
                            exec_pid,
                            &exec_compiled.meta,
                            &exec_argv,
                            &exec_envp,
                        )
                    };
                    if let Err(e) = complete_res {
                        fatal_error = Some((
                            "EXEC_ERROR",
                            format!("complete_exec failed for {}: {}", exec_path, e),
                            false,
                        ));
                        break;
                    }
                    processes.insert(exec_pid, new_proc);
                    active_pid = exec_pid;
                }
                5 => {
                    // NeedStdin: batch mode closes stdin and wakes waiters.
                    self.state.close_stdin();
                    self.state.wake_ready_waiters();
                    let proc = processes.get_mut(&active_pid).unwrap();
                    let mut ctx = proc.as_ctx();
                    match self.state.resume_active(&mut ctx) {
                        Ok(true) => {}
                        Ok(false) => {
                            skip_start = true;
                        }
                        Err(e) => {
                            fatal_error = Some(("WASM_TRAP", format!("resume_active after stdin error: {}", e), false));
                            break;
                        }
                    }
                }
                other => {
                    fatal_error = Some((
                        "WASM_TRAP",
                        format!("Unknown on_yield_multiproc action: {}", other),
                        false,
                    ));
                    break;
                }
            }
        }

        // Explicitly drop all guest WASM stores before encoding outputs so memory is reclaimed.
        drop(processes);

        let stdout_b64 = base64::engine::general_purpose::STANDARD.encode(&self.state.vfs.stdout);
        let stderr_b64 = base64::engine::general_purpose::STANDARD.encode(&self.state.vfs.stderr);
        let vtime = self.state.scheduler.virtual_mono_ns.to_string();

        if let Some((err_code, err_msg, timed_out)) = fatal_error {
            return RunCommandResponse {
                ok: false,
                exit_code: if timed_out { 124 } else { 126 },
                stdout_base64: stdout_b64,
                stderr_base64: stderr_b64,
                virtual_time_ns: vtime,
                timed_out,
                error: Some(err_msg),
                error_code: Some(err_code.to_string()),
            };
        }

        let exit_code = self.state.main_exit_code().unwrap_or(last_code);
        RunCommandResponse {
            ok: true,
            exit_code,
            stdout_base64: stdout_b64,
            stderr_base64: stderr_b64,
            virtual_time_ns: vtime,
            timed_out: false,
            error: None,
            error_code: None,
        }
    }
}

impl Default for WorkerSession {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// Single-threaded WASM C-ABI exports (for Cloudflare Workers & Node.js)
// ============================================================================

struct GlobalSession(UnsafeCell<Option<WorkerSession>>);
unsafe impl Sync for GlobalSession {}

static SESSION: GlobalSession = GlobalSession(UnsafeCell::new(None));

fn session_mut() -> &'static mut WorkerSession {
    unsafe {
        let slot = &mut *SESSION.0.get();
        if slot.is_none() {
            *slot = Some(WorkerSession::new());
        }
        slot.as_mut().unwrap()
    }
}

fn export_owned_bytes(bytes: Vec<u8>, out_len_ptr: *mut usize) -> *mut u8 {
    if out_len_ptr.is_null() {
        return core::ptr::null_mut();
    }
    let mut boxed = bytes.into_boxed_slice();
    let len = boxed.len();
    unsafe {
        *out_len_ptr = len;
    }
    if len == 0 {
        return core::ptr::null_mut();
    }
    let ptr = boxed.as_mut_ptr();
    core::mem::forget(boxed);
    ptr
}

fn read_utf8_arg<'a>(ptr: *const u8, len: usize) -> Result<&'a str> {
    if len == 0 {
        return Ok("");
    }
    if ptr.is_null() {
        return Err(anyhow!("null pointer"));
    }
    let slice = unsafe { core::slice::from_raw_parts(ptr, len) };
    core::str::from_utf8(slice).map_err(|_| anyhow!("invalid UTF-8"))
}

#[no_mangle]
pub extern "C" fn worker_alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    core::mem::forget(buf);
    ptr
}

#[no_mangle]
pub extern "C" fn worker_dealloc(ptr: *mut u8, len: usize) {
    if !ptr.is_null() && len > 0 {
        unsafe {
            let _ = Vec::from_raw_parts(ptr, 0, len);
        }
    }
}

#[no_mangle]
pub extern "C" fn worker_reset() -> i32 {
    session_mut().reset();
    0
}

#[no_mangle]
pub extern "C" fn worker_extract_tar(
    tar_ptr: *const u8,
    tar_len: usize,
    mount_ptr: *const u8,
    mount_len: usize,
    strip_components: u32,
    ignore_whiteouts: u32,
) -> i32 {
    if tar_len > 0 && tar_ptr.is_null() {
        return -1;
    }
    let tar_bytes = if tar_len == 0 {
        &[][..]
    } else {
        unsafe { core::slice::from_raw_parts(tar_ptr, tar_len) }
    };
    let Ok(mount) = read_utf8_arg(mount_ptr, mount_len) else {
        return -2;
    };
    let mount = if mount.is_empty() { "/" } else { mount };
    match session_mut().state.vfs.extract_tar(
        tar_bytes,
        mount,
        strip_components as usize,
        ignore_whiteouts != 0,
    ) {
        Ok(count) => count.min(i32::MAX as usize) as i32,
        Err(_) => -3,
    }
}

#[no_mangle]
pub extern "C" fn worker_add_vfs_file(
    path_ptr: *const u8,
    path_len: usize,
    data_ptr: *const u8,
    data_len: usize,
    mode: u32,
) -> i32 {
    let Ok(path) = read_utf8_arg(path_ptr, path_len) else {
        return -1;
    };
    if path.is_empty() || (data_len > 0 && data_ptr.is_null()) {
        return -1;
    }
    let data = if data_len == 0 {
        &[][..]
    } else {
        unsafe { core::slice::from_raw_parts(data_ptr, data_len) }
    };
    session_mut().state.vfs.vfs_write_file(path, data, mode);
    0
}

#[no_mangle]
pub extern "C" fn worker_add_vfs_dir(path_ptr: *const u8, path_len: usize, mode: u32) -> i32 {
    let Ok(path) = read_utf8_arg(path_ptr, path_len) else {
        return -1;
    };
    if path.is_empty() {
        return -1;
    }
    session_mut().state.vfs.vfs_add_dir(path, mode);
    0
}

#[no_mangle]
pub extern "C" fn worker_add_vfs_symlink(
    path_ptr: *const u8,
    path_len: usize,
    target_ptr: *const u8,
    target_len: usize,
) -> i32 {
    let Ok(path) = read_utf8_arg(path_ptr, path_len) else {
        return -1;
    };
    let Ok(target) = read_utf8_arg(target_ptr, target_len) else {
        return -1;
    };
    if path.is_empty() || target.is_empty() {
        return -1;
    }
    session_mut().state.vfs.vfs_add_symlink(path, target);
    0
}

#[no_mangle]
pub extern "C" fn worker_remove_vfs_path(path_ptr: *const u8, path_len: usize) -> i32 {
    let Ok(path) = read_utf8_arg(path_ptr, path_len) else {
        return -1;
    };
    if path.is_empty() {
        return -1;
    }
    if session_mut().state.vfs.vfs_remove_path(path) {
        0
    } else {
        -2
    }
}

#[no_mangle]
pub extern "C" fn worker_snapshot_vfs() -> u32 {
    session_mut().state.vfs.snapshot_vfs()
}

#[no_mangle]
pub extern "C" fn worker_restore_vfs(snapshot_id: u32) -> i32 {
    session_mut().state.vfs.restore_vfs(snapshot_id)
}

#[no_mangle]
pub extern "C" fn worker_drop_vfs_snapshot(snapshot_id: u32) -> i32 {
    session_mut().state.vfs.drop_vfs_snapshot(snapshot_id)
}

#[no_mangle]
pub extern "C" fn worker_export_vfs_tar(
    base_snap_id: u32,
    use_base: u32,
    prefix_ptr: *const u8,
    prefix_len: usize,
    out_len_ptr: *mut usize,
) -> *mut u8 {
    if out_len_ptr.is_null() {
        return core::ptr::null_mut();
    }
    let sess = session_mut();
    let base = if use_base != 0 {
        if !sess.state.vfs.has_snapshot(base_snap_id) {
            unsafe { *out_len_ptr = 0 };
            return core::ptr::null_mut();
        }
        Some(base_snap_id)
    } else {
        None
    };
    let prefix = if prefix_len > 0 {
        let Ok(s) = read_utf8_arg(prefix_ptr, prefix_len) else {
            unsafe { *out_len_ptr = 0 };
            return core::ptr::null_mut();
        };
        Some(s)
    } else {
        None
    };
    let tar = sess.state.vfs.export_tar(base, prefix);
    export_owned_bytes(tar, out_len_ptr)
}

#[no_mangle]
pub extern "C" fn worker_list_vfs_diff(
    base_snap_id: u32,
    use_base: u32,
    prefix_ptr: *const u8,
    prefix_len: usize,
    out_len_ptr: *mut usize,
) -> *mut u8 {
    if out_len_ptr.is_null() {
        return core::ptr::null_mut();
    }
    let sess = session_mut();
    let base = if use_base != 0 {
        if !sess.state.vfs.has_snapshot(base_snap_id) {
            unsafe { *out_len_ptr = 0 };
            return core::ptr::null_mut();
        }
        Some(base_snap_id)
    } else {
        None
    };
    let prefix = if prefix_len > 0 {
        let Ok(s) = read_utf8_arg(prefix_ptr, prefix_len) else {
            unsafe { *out_len_ptr = 0 };
            return core::ptr::null_mut();
        };
        Some(s)
    } else {
        None
    };
    let diff = sess.state.vfs.list_diff(base, prefix);
    let json = encode_vfs_diff_json(&diff);
    export_owned_bytes(json, out_len_ptr)
}

#[no_mangle]
pub extern "C" fn worker_run_command(
    req_json_ptr: *const u8,
    req_json_len: usize,
    out_len_ptr: *mut usize,
) -> *mut u8 {
    if out_len_ptr.is_null() {
        return core::ptr::null_mut();
    }
    let resp = match read_utf8_arg(req_json_ptr, req_json_len) {
        Ok(json_str) => match serde_json::from_str::<RunCommandRequest>(json_str) {
            Ok(req) => session_mut().run_command(&req),
            Err(e) => RunCommandResponse::error(
                "INVALID_REQUEST",
                format!("Failed to parse request JSON: {}", e),
                126,
                false,
            ),
        },
        Err(e) => RunCommandResponse::error(
            "INVALID_REQUEST",
            format!("Invalid request buffer: {}", e),
            126,
            false,
        ),
    };
    let out_json = serde_json::to_vec(&resp).unwrap_or_else(|_| {
        br#"{"ok":false,"exitCode":126,"stdoutBase64":"","stderrBase64":"","virtualTimeNs":"0","timedOut":false,"error":"Serialization failed","errorCode":"WASM_TRAP"}"#.to_vec()
    });
    export_owned_bytes(out_json, out_len_ptr)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a minimal valid static ELF64 x86-64 executable with a single PT_LOAD
    /// segment mapped at `vaddr = 0x400000`, `entry = 0x400000 + code_offset`.
    fn build_static_elf64(code: &[u8], rodata: &[u8]) -> (Vec<u8>, u32) {
        let ehdr_size = 64usize;
        let phdr_size = 56usize;
        let code_offset = 0x1000usize;
        let rodata_offset = code_offset + code.len();
        let total_len = rodata_offset + rodata.len();
        let vaddr_base: u64 = 0x0040_0000;
        let entry_va = vaddr_base + code_offset as u64;
        let rodata_va = (vaddr_base as u32) + rodata_offset as u32;

        let mut buf = vec![0u8; total_len];
        // ELF64 header
        buf[0..4].copy_from_slice(b"\x7fELF");
        buf[4] = 2; // ELFCLASS64
        buf[5] = 1; // ELFDATA2LSB
        buf[6] = 1; // EV_CURRENT
        buf[16..18].copy_from_slice(&2u16.to_le_bytes()); // ET_EXEC
        buf[18..20].copy_from_slice(&62u16.to_le_bytes()); // EM_X86_64
        buf[20..24].copy_from_slice(&1u32.to_le_bytes()); // EV_CURRENT
        buf[24..32].copy_from_slice(&entry_va.to_le_bytes()); // e_entry
        buf[32..40].copy_from_slice(&(ehdr_size as u64).to_le_bytes()); // e_phoff
        buf[52..54].copy_from_slice(&(ehdr_size as u16).to_le_bytes()); // e_ehsize
        buf[54..56].copy_from_slice(&(phdr_size as u16).to_le_bytes()); // e_phentsize
        buf[56..58].copy_from_slice(&1u16.to_le_bytes()); // e_phnum

        // Single PT_LOAD segment (PF_R | PF_W | PF_X)
        let ph = &mut buf[ehdr_size..ehdr_size + phdr_size];
        ph[0..4].copy_from_slice(&1u32.to_le_bytes()); // PT_LOAD
        ph[4..8].copy_from_slice(&7u32.to_le_bytes()); // PF_R|PF_W|PF_X
        ph[8..16].copy_from_slice(&0u64.to_le_bytes()); // p_offset
        ph[16..24].copy_from_slice(&vaddr_base.to_le_bytes()); // p_vaddr
        ph[24..32].copy_from_slice(&vaddr_base.to_le_bytes()); // p_paddr
        ph[32..40].copy_from_slice(&(total_len as u64).to_le_bytes()); // p_filesz
        ph[40..48].copy_from_slice(&(total_len as u64).to_le_bytes()); // p_memsz
        ph[48..56].copy_from_slice(&0x1000u64.to_le_bytes()); // p_align

        buf[code_offset..code_offset + code.len()].copy_from_slice(code);
        buf[rodata_offset..rodata_offset + rodata.len()].copy_from_slice(rodata);
        (buf, rodata_va)
    }

    fn emit_mov_eax(code: &mut Vec<u8>, imm: u32) {
        code.push(0xb8);
        code.extend_from_slice(&imm.to_le_bytes());
    }
    fn emit_mov_edi(code: &mut Vec<u8>, imm: u32) {
        code.push(0xbf);
        code.extend_from_slice(&imm.to_le_bytes());
    }
    fn emit_mov_esi(code: &mut Vec<u8>, imm: u32) {
        code.push(0xbe);
        code.extend_from_slice(&imm.to_le_bytes());
    }
    fn emit_mov_edx(code: &mut Vec<u8>, imm: u32) {
        code.push(0xba);
        code.extend_from_slice(&imm.to_le_bytes());
    }
    fn emit_mov_r10d(code: &mut Vec<u8>, imm: u32) {
        code.extend_from_slice(&[0x41, 0xba]);
        code.extend_from_slice(&imm.to_le_bytes());
    }
    fn emit_syscall(code: &mut Vec<u8>) {
        code.extend_from_slice(&[0x0f, 0x05]);
    }

    /// Build a real x86-64 ELF64 that:
    /// 1. Writes "hello wasmi\n" to stdout (fd 1)
    /// 2. Writes "warn\n" to stderr (fd 2)
    /// 3. Calls getrandom(rsp, 8, 0) and writes the 8 random bytes to /workspace/out.bin
    /// 4. Unlinks /workspace/old.txt
    /// 5. Exits with code 42
    fn build_full_test_elf() -> Vec<u8> {
        let msg_out = b"hello wasmi\n";
        let msg_err = b"warn\n";
        let out_path = b"/workspace/out.bin\0";
        let old_path = b"/workspace/old.txt\0";

        let mut rodata = Vec::new();
        let off_out = rodata.len() as u32;
        rodata.extend_from_slice(msg_out);
        let off_err = rodata.len() as u32;
        rodata.extend_from_slice(msg_err);
        let off_out_path = rodata.len() as u32;
        rodata.extend_from_slice(out_path);
        let off_old_path = rodata.len() as u32;
        rodata.extend_from_slice(old_path);

        // Two-pass assembly so rodata_va is exact.
        let assemble = |rodata_va: u32| -> Vec<u8> {
            let mut c = Vec::new();
            // sub rsp, 64 (48 83 ec 40)
            c.extend_from_slice(&[0x48, 0x83, 0xec, 0x40]);

            // write(1, msg_out, msg_out.len())
            emit_mov_eax(&mut c, 1);
            emit_mov_edi(&mut c, 1);
            emit_mov_esi(&mut c, rodata_va + off_out);
            emit_mov_edx(&mut c, msg_out.len() as u32);
            emit_syscall(&mut c);

            // write(2, msg_err, msg_err.len())
            emit_mov_eax(&mut c, 1);
            emit_mov_edi(&mut c, 2);
            emit_mov_esi(&mut c, rodata_va + off_err);
            emit_mov_edx(&mut c, msg_err.len() as u32);
            emit_syscall(&mut c);

            // getrandom(rsp, 8, 0) -> SYS_getrandom = 318
            emit_mov_eax(&mut c, 318);
            // mov rdi, rsp (48 89 e7)
            c.extend_from_slice(&[0x48, 0x89, 0xe7]);
            emit_mov_esi(&mut c, 8);
            emit_mov_edx(&mut c, 0);
            emit_syscall(&mut c);

            // openat(AT_FDCWD=-100, "/workspace/out.bin", O_CREAT|O_WRONLY|O_TRUNC=0x241, 0o644) -> SYS_openat = 257
            emit_mov_eax(&mut c, 257);
            // mov rdi, -100 (48 c7 c7 9c ff ff ff)
            c.extend_from_slice(&[0x48, 0xc7, 0xc7, 0x9c, 0xff, 0xff, 0xff]);
            emit_mov_esi(&mut c, rodata_va + off_out_path);
            emit_mov_edx(&mut c, 0x241);
            emit_mov_r10d(&mut c, 0o644);
            emit_syscall(&mut c);

            // mov rdi, rax (fd) -> 48 89 c7
            c.extend_from_slice(&[0x48, 0x89, 0xc7]);
            // write(fd, rsp, 8)
            emit_mov_eax(&mut c, 1);
            // mov rsi, rsp (48 89 e6)
            c.extend_from_slice(&[0x48, 0x89, 0xe6]);
            emit_mov_edx(&mut c, 8);
            emit_syscall(&mut c);

            // close(fd) -> rdi still holds fd, SYS_close = 3
            emit_mov_eax(&mut c, 3);
            emit_syscall(&mut c);

            // unlinkat(AT_FDCWD=-100, "/workspace/old.txt", 0) -> SYS_unlinkat = 263
            emit_mov_eax(&mut c, 263);
            c.extend_from_slice(&[0x48, 0xc7, 0xc7, 0x9c, 0xff, 0xff, 0xff]);
            emit_mov_esi(&mut c, rodata_va + off_old_path);
            emit_mov_edx(&mut c, 0);
            emit_syscall(&mut c);

            // exit_group(42) -> SYS_exit_group = 231
            emit_mov_eax(&mut c, 231);
            emit_mov_edi(&mut c, 42);
            emit_syscall(&mut c);
            c
        };

        let probe_code = assemble(0);
        let (_, rodata_va) = build_static_elf64(&probe_code, &rodata);
        let final_code = assemble(rodata_va);
        assert_eq!(probe_code.len(), final_code.len());
        let (elf, _) = build_static_elf64(&final_code, &rodata);
        elf
    }

    #[test]
    fn test_worker_runs_elf_deterministically_and_exports_vfs_diff() {
        let elf = build_full_test_elf();

        let run_once = || {
            let mut sess = WorkerSession::new();
            sess.state.vfs.vfs_write_file("/bin/testapp", &elf, 0o755);
            sess.state
                .vfs
                .vfs_write_file("/workspace/old.txt", b"delete-me", 0o644);
            sess.state
                .vfs
                .vfs_write_file("/workspace/keep.txt", b"untouched", 0o644);
            let snap = sess.state.vfs.snapshot_vfs();

            let req = RunCommandRequest {
                cmd: vec!["testapp".to_string()],
                env: default_env(),
                cwd: "/workspace".to_string(),
                uid: 0,
                gid: 0,
                stdin_base64: String::new(),
                delay_stddev_ms: 5.0,
                delay_seed: 123456,
                max_fuel: DEFAULT_MAX_FUEL,
                max_memory_bytes: DEFAULT_MAX_MEMORY_BYTES,
            };
            let resp = sess.run_command(&req);
            let diff = sess.state.vfs.list_diff(Some(snap), Some("/workspace"));
            let tar = sess.state.vfs.export_tar(Some(snap), Some("/workspace"));
            let out_bin = sess.state.vfs.vfs_read_file("/workspace/out.bin").unwrap();
            (resp, diff, tar, out_bin)
        };

        let (r1, d1, t1, b1) = run_once();
        let (r2, d2, t2, b2) = run_once();

        assert!(r1.ok, "run failed: {:?}", r1.error);
        assert_eq!(r1.exit_code, 42);
        let stdout = base64::engine::general_purpose::STANDARD
            .decode(&r1.stdout_base64)
            .unwrap();
        let stderr = base64::engine::general_purpose::STANDARD
            .decode(&r1.stderr_base64)
            .unwrap();
        assert_eq!(stdout, b"hello wasmi\n");
        assert_eq!(stderr, b"warn\n");
        assert_eq!(b1.len(), 8);

        // Determinism check: identical outputs, virtual time, PRNG bytes, diff, and tar!
        assert_eq!(r1.exit_code, r2.exit_code);
        assert_eq!(r1.stdout_base64, r2.stdout_base64);
        assert_eq!(r1.stderr_base64, r2.stderr_base64);
        assert_eq!(r1.virtual_time_ns, r2.virtual_time_ns);
        assert_eq!(b1, b2);
        assert_eq!(d1, d2);
        assert_eq!(t1, t2);

        // VFS diff check: out.bin added, old.txt deleted, keep.txt omitted.
        assert!(!d1.iter().any(|e| e.path == "/workspace/keep.txt"));
        assert!(d1
            .iter()
            .any(|e| e.path == "/workspace/out.bin" && e.kind == elf2wasm_runtime_core::VfsDiffKind::File && e.size == 8));
        assert!(d1
            .iter()
            .any(|e| e.path == "/workspace/old.txt" && e.kind == elf2wasm_runtime_core::VfsDiffKind::Deleted));
    }

    #[test]
    fn test_worker_fuel_exhaustion_on_infinite_loop() {
        // Infinite loop: jmp -2 (eb fe)
        let (elf, _) = build_static_elf64(&[0xeb, 0xfe], &[]);
        let mut sess = WorkerSession::new();
        sess.state.vfs.vfs_write_file("/bin/spin", &elf, 0o755);

        let req = RunCommandRequest {
            cmd: vec!["/bin/spin".to_string()],
            env: default_env(),
            cwd: "/".to_string(),
            uid: 0,
            gid: 0,
            stdin_base64: String::new(),
            delay_stddev_ms: 0.0,
            delay_seed: 0,
            max_fuel: 50_000,
            max_memory_bytes: DEFAULT_MAX_MEMORY_BYTES,
        };
        let resp = sess.run_command(&req);
        assert!(!resp.ok);
        assert!(resp.timed_out);
        assert_eq!(resp.exit_code, 124);
        assert_eq!(resp.error_code.as_deref(), Some("FUEL_EXHAUSTED"));
    }

    #[test]
    fn test_worker_fork_and_wait4() {
        // Static x86-64 ELF:
        // fork() (SYS_fork=57)
        // if rax == 0 (child): write(1, "C", 1); exit_group(7)
        // else (parent): wait4(-1, 0, 0, 0) (SYS_wait4=61); write(1, "P", 1); exit_group(0)
        let rodata = b"CP";
        let assemble = |rodata_va: u32| -> Vec<u8> {
            let mut c = Vec::new();
            // SYS_fork = 57
            emit_mov_eax(&mut c, 57);
            emit_syscall(&mut c);
            // test rax, rax (48 85 c0)
            c.extend_from_slice(&[0x48, 0x85, 0xc0]);
            // jnz parent (0f 85 <rel32>)
            c.extend_from_slice(&[0x0f, 0x85]);
            let jnz_patch = c.len();
            c.extend_from_slice(&0i32.to_le_bytes());

            // Child: write(1, "C", 1); exit_group(7)
            emit_mov_eax(&mut c, 1);
            emit_mov_edi(&mut c, 1);
            emit_mov_esi(&mut c, rodata_va);
            emit_mov_edx(&mut c, 1);
            emit_syscall(&mut c);
            emit_mov_eax(&mut c, 231);
            emit_mov_edi(&mut c, 7);
            emit_syscall(&mut c);

            // Patch jnz target to parent
            let parent_off = c.len();
            let rel = (parent_off as i32) - ((jnz_patch + 4) as i32);
            c[jnz_patch..jnz_patch + 4].copy_from_slice(&rel.to_le_bytes());

            // Parent: wait4(-1, 0, 0, 0) -> SYS_wait4 = 61
            emit_mov_eax(&mut c, 61);
            // mov rdi, -1 (48 c7 c7 ff ff ff ff)
            c.extend_from_slice(&[0x48, 0xc7, 0xc7, 0xff, 0xff, 0xff, 0xff]);
            emit_mov_esi(&mut c, 0);
            emit_mov_edx(&mut c, 0);
            emit_mov_r10d(&mut c, 0);
            emit_syscall(&mut c);

            // write(1, "P", 1); exit_group(0)
            emit_mov_eax(&mut c, 1);
            emit_mov_edi(&mut c, 1);
            emit_mov_esi(&mut c, rodata_va + 1);
            emit_mov_edx(&mut c, 1);
            emit_syscall(&mut c);
            emit_mov_eax(&mut c, 231);
            emit_mov_edi(&mut c, 0);
            emit_syscall(&mut c);
            c
        };

        let probe = assemble(0);
        let (_, rodata_va) = build_static_elf64(&probe, rodata);
        let code = assemble(rodata_va);
        let (elf, _) = build_static_elf64(&code, rodata);

        let mut sess = WorkerSession::new();
        sess.state.vfs.vfs_write_file("/bin/forktest", &elf, 0o755);
        let req = RunCommandRequest {
            cmd: vec!["/bin/forktest".to_string()],
            env: default_env(),
            cwd: "/".to_string(),
            uid: 0,
            gid: 0,
            stdin_base64: String::new(),
            delay_stddev_ms: 0.0,
            delay_seed: 0,
            max_fuel: DEFAULT_MAX_FUEL,
            max_memory_bytes: DEFAULT_MAX_MEMORY_BYTES,
        };
        let resp = sess.run_command(&req);
        assert!(resp.ok, "forktest failed: {:?}", resp.error);
        assert_eq!(resp.exit_code, 0);
        let stdout = base64::engine::general_purpose::STANDARD
            .decode(&resp.stdout_base64)
            .unwrap();
        assert_eq!(stdout, b"CP");
    }

    #[test]
    fn test_worker_memory_limit_error_code() {
        let elf = build_full_test_elf();
        let mut sess = WorkerSession::new();
        sess.state.vfs.vfs_write_file("/bin/testapp", &elf, 0o755);

        let req = RunCommandRequest {
            cmd: vec!["/bin/testapp".to_string()],
            env: default_env(),
            cwd: "/".to_string(),
            uid: 0,
            gid: 0,
            stdin_base64: String::new(),
            delay_stddev_ms: 0.0,
            delay_seed: 0,
            max_fuel: DEFAULT_MAX_FUEL,
            max_memory_bytes: 65_536,
        };
        let resp = sess.run_command(&req);
        assert!(!resp.ok);
        assert!(!resp.timed_out);
        assert_eq!(
            resp.error_code.as_deref(),
            Some("MEMORY_LIMIT"),
            "expected MEMORY_LIMIT, got {:?} with error {:?}",
            resp.error_code,
            resp.error
        );
    }

    #[test]
    fn test_export_owned_bytes_with_excess_capacity_and_dealloc() {
        let mut buf = Vec::with_capacity(1024);
        buf.extend_from_slice(b"hello-wasm");
        assert!(buf.capacity() >= 1024);

        let mut out_len: usize = 0;
        let ptr = export_owned_bytes(buf, &mut out_len as *mut usize);
        assert!(!ptr.is_null());
        assert_eq!(out_len, 10);
        let exported = unsafe { core::slice::from_raw_parts(ptr, out_len) };
        assert_eq!(exported, b"hello-wasm");

        worker_dealloc(ptr, out_len);

        // Empty Vec with excess capacity must return null and len 0 cleanly.
        let empty_buf = Vec::with_capacity(512);
        let mut empty_len: usize = 99;
        let empty_ptr = export_owned_bytes(empty_buf, &mut empty_len as *mut usize);
        assert!(empty_ptr.is_null());
        assert_eq!(empty_len, 0);
        worker_dealloc(empty_ptr, empty_len);
    }
}
