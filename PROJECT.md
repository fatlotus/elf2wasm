# Project: elf2wasm

## Architecture
`elf2wasm` translates unmodified Linux x86-64 ELF64 binaries (and their required `.so` shared libraries) into a self-contained WebAssembly (`.wasm`) module and executes it in a `wasmtime` sandbox with emulated Linux syscalls.

- **Translation Pipeline (`elf2wasm translate`)**:
  1. `elf_loader.rs`: Parses main ELF64 (`ET_DYN` PIE at `0x0010_0000` or `ET_EXEC` non-PIE at `0x0040_0000`+), `ld-linux-x86-64.so.2` (`LD_BASE = 0x0100_0000`), and `.so` libraries (`SO_BASE_START = 0x0200_0000`+, 1 MB aligned).
  2. `decoder.rs`: Decodes all `PF_X` segments using `iced-x86`, discovers function/block boundaries and indirect dispatch targets.
  3. `lifter.rs` & `wasm_emit.rs`: Lifts x86-64 instructions (baseline GPRs, flags, `%fs:` TLS, SSE/SSE2, x87 subset if needed, masked `cpuid`/`xgetbv`, `rdtsc`, `syscall` import) into a valid `.wasm` module with `>= 4096` pages (256 MB+ dynamically sized for `DISPATCH_HASH_ADDR = 0x0C00_0000` + dispatch hash table), trampoline dispatch, initial `DataSection`, and `elf2wasm_meta` custom section (`meta.rs`).
- **Sandboxed Runtime (`elf2wasm run`)**:
  1. `runtime.rs`: Loads the `.wasm` module via `wasmtime 27`, decodes `elf2wasm_meta`, initializes `STACK_TOP` (`0x0BFF_0000`) with `argc`, `argv`, `envp`, and `auxv` (omitting `AT_SYSINFO_EHDR` so glibc uses `clock_gettime` syscall).
  2. `syscalls.rs` & `vfs.rs`: Emulates Linux x86-64 syscalls in a sandboxed virtual OS: `.so`-aware `mmap` returning `so.base_addr`, `brk`, `arch_prctl(ARCH_SET_FS)`, process/signal/time/futex stubs, and a read-only sandboxed VFS for embedded `.so` files and host-mapped read-only system/Python stdlib paths (zero host writes, zero network/process creation).

## Code Layout
```
/home/antigravity/elf2wasm/
├── Cargo.toml                         # Workspace root (elf2wasm CLI + runtime)
├── Cargo.lock
├── PROJECT.md
├── crates/
│   ├── elf2wasm-core/                 # Pure compiler library (no wasmtime/clap; std-fs optional)
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── elf_loader.rs          # In-memory & host ELF64 + .so loader, dynamic VA bases
│   │       ├── meta.rs                # WasmMeta custom section serialization
│   │       ├── decoder.rs             # iced-x86 code discovery, CFG, split_indirect_targets
│   │       ├── lifter.rs              # x86-64 -> WASM instruction lifting & CPU state
│   │       └── wasm_emit.rs           # wasm-encoder module assembly, quantum/yield, save/load_ctx
│   ├── elf2wasm-compiler-wasm/        # wasm32-unknown-unknown cdylib compiler
│   │   ├── Cargo.toml
│   │   └── src/
│   │       └── lib.rs                 # C-ABI alloc, dealloc, compile_bundle (E2WB format)
│   ├── elf2wasm-runtime-core/         # Pure runtime library (writable VFS, virtual time, scheduler, multi-process)
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── context.rs             # GuestContext & HostFsProvider traits (StdHostFs / NoopHostFs)
│   │       ├── vfs.rs                 # Writable in-memory VFS overlay + RO host/so mounts + PipeBuffer
│   │       ├── scheduler.rs           # Deterministic virtual time, cooperative thread & multi-proc scheduler
│   │       ├── syscalls.rs            # Platform-agnostic Linux x86-64 syscall emulator (ProcessState, F10)
│   │       └── stack.rs               # RunConfig, RunOutput, extract_elf2wasm_meta, guest stack init
│   └── elf2wasm-runtime-wasm/         # wasm32-unknown-unknown cdylib runtime
│       ├── Cargo.toml
│       └── src/
│           └── lib.rs                 # C-ABI runtime_* & multi-proc exports + env.host_* / host_vfs_* imports
├── js/
│   ├── elf2wasm_shim.mjs              # Zero-dependency ESM JS shim (Node & browser) for compiler/runtime/guest WASM
│   └── cli.mjs                        # Node CLI wrapper (compile, run)
├── src/
│   ├── main.rs                        # CLI entry point (translate, run)
│   ├── runtime.rs                     # wasmtime 27 host, WasmtimeGuestContext, slice execution loop
│   ├── syscalls.rs                    # Re-export of elf2wasm_runtime_core::syscalls
│   └── vfs.rs                         # Re-export of elf2wasm_runtime_core::vfs
└── tests/                             # E2E & integration test suite
```

## Feature Inventory
Every feature from the Survey phase is assigned a milestone below:

| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| R1 | CPS Syscall ABI & Kernel Preemption | Remove `env.syscall` import from translated guest `.wasm`; return from `_start` with `yield_flag = 3` (`YIELD_SYSCALL_PENDING`), `rip = next_ip`, and syscall args in exported globals (`rax, rdi, rsi, rdx, r10, r8, r9`). Kernel/host dispatches syscall, preempts/switches processes, and resumes. Verify with two subprocesses waiting for deterministic amounts of time. | M1 | Survey 1, 3 |
| R2 | `README.md` & Exhaustive WASM ABI Docs | Create `README.md` stating the core goal (deterministic, Linux-compatible OS running unmodified x86 programs), how to install/build `.wasm` modules (`compiler.wasm`, `runtime.wasm`, guest `.wasm`), how to run them, and exhaustive ABI docs for `compiler.wasm`, `runtime.wasm`, and translated guest executables. | M3 | Survey 2, 3 |
| R3 | VFS Symlinks, `.tar.gz`/Docker Overlay & HTML Web UI | Add `OverlayNode::Symlink` + `symlink`/`symlinkat`/`readlink` + symlink resolution in JS `_resolveElfSos`; add `.tar.gz`/`.zip` overlay extraction into VFS and `runFromVfs`; build HTML web page to upload Linux binaries & `.tar.gz`/`.zip` overlays and run them; verify uploading a Python runtime and running Python code. | M2 | Survey 2, 3 |
| R4 | Codebase Simplification & Cleanup | Remove unused root `Cargo.toml` deps (`goblin`, `iced-x86`, `wasm-encoder`), trivial wrappers (`src/syscalls.rs`, `src/vfs.rs`), redundant slow tests (`m2_runtime.rs`, `m3_true_echo.rs`, `m4_python3.rs`), stale docs (`TEST_READY_V2.md`), and any dead/duplicated code found by the background simplification agent. | M4 | Survey 3 |

*(Note: Prior M1–M6 baseline x86-64→WASM, `wasmtime` host, Python 3 support, `compiler-wasm`, `runtime-wasm`, and `js/elf2wasm_shim.mjs` are already complete and verified passing 73/73 workspace tests.)*

## Milestones

| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | CPS Syscall ABI & Kernel Preemption | `crates/elf2wasm-core`, `crates/elf2wasm-runtime-core`, `crates/elf2wasm-runtime-wasm`, `src/runtime.rs`, `js/elf2wasm_shim.mjs`; build `wasm32-unknown-unknown` `.wasm` modules; verify deterministic two-subprocess wait preemption | none | DONE (`sub_orch_m1` gate passed) |
| M2 | VFS Symlinks, `.tar.gz` Overlay & HTML Web UI | `crates/elf2wasm-runtime-core/src/{vfs,syscalls}.rs`, `js/elf2wasm_shim.mjs`, `web/index.html`; verify uploading Python runtime `.tar.gz` and running Python in headless Chromium | M1 | DONE (`sub_orch_m2` gate passed) |
| M3 | `README.md` & Exhaustive WASM ABI Docs | `README.md` at repo root | M1, M2 | DONE (`sub_orch_m3` gate passed) |
| M4 | Codebase Simplification & Cleanup | `Cargo.toml`, `src/{syscalls,vfs}.rs`, `tests/`, stale docs, and background simplification findings | M1, M2 | DONE (`sub_orch_m4` gate passed) |
| M5 | Final Milestone (E2E Pass + Tier 5 Hardening) | Pass 100% of E2E test suite (`TEST_READY.md`) + Tier 5 adversarial hardening | M1, M2, M3, M4, TEST_READY.md | DONE (`sub_orch_m5` gate passed) |

## Interface Contracts

### `elf_loader` ↔ `decoder`
- `elf_loader::load_elf_and_sos_bytes(main_path: &str, main_bytes: &[u8], sos: &[(&str, &[u8])]) -> Result<LoadedImage>` performs pure in-memory ELF64 + `.so` loading with dynamic `LD_BASE` / `SO_BASE_START` placement above `main_end` (zero `std::fs`).
- `decoder::discover_code(image: &LoadedImage) -> Result<DecodedProgram>` and `decoder::split_indirect_targets(image: &LoadedImage, prog: &mut DecodedProgram)` discover basic blocks and indirect jump/call targets, including post-`Syscall` block splits.

### Translated Guest Executable ↔ Kernel/Host (CPS Syscall ABI)
- **Imports**: None (zero-import WASM module).
- **Exports**: `"memory"` (`>= 4096` pages), `"_start"` (`[] -> [i32]`), `"save_ctx"` / `"load_ctx"` (`[i32] -> []`, 464-byte `CTX_SIZE` layout), `"yield_flag"` (`i32`: `0=running`, `1=blocked/yield`, `2=quantum preempt`, `3=syscall pending`), `"quantum"` (`i32`, `DEFAULT_QUANTUM = 128`), GPRs (`"rax"`, `"rcx"`, `"rdx"`, `"rbx"`, `"rsp"`, `"rbp"`, `"rsi"`, `"rdi"`, `"r8"`..`"r15"`), `"rip"`, `"exit_flag"`, `"exit_code"`, `"fsbase"`, `"gsbase"`.
- **CPS Syscall Convention**: On `Mnemonic::Syscall`, guest sets `rcx = next_ip`, `r11 = rflags`, `rip = next_ip`, `yield_flag = 3` (`YIELD_SYSCALL_PENDING`), and returns from `_start`. Syscall number is in `rax`, args in `rdi, rsi, rdx, r10, r8, r9`. Kernel/host reads args, executes syscall, writes return value to `rax`, clears `yield_flag` (unless blocked/exited), and may preempt/switch processes before resuming `_start()`.
- **Custom section**: `"elf2wasm_meta"` encoded by `WasmMeta::encode()`.

### `elf2wasm-compiler-wasm` (WASM C-ABI)
- Zero imports. Exports `memory`, `alloc(len: usize) -> *mut u8`, `dealloc(ptr: *mut u8, len: usize)`, `compile_bundle(ptr: *const u8, len: usize, out_len_ptr: *mut usize) -> *mut u8` (`E2WB` input → `0x00` + `.wasm` or `0x01` + UTF-8 error).

### `elf2wasm-runtime-wasm` (WASM C-ABI)
- Imports from `"env"`: `host_mem_size`, `host_read_guest`, `host_write_guest`, `host_zero_guest`, `host_get_global`, `host_set_global`, `host_save_ctx`, `host_load_ctx`, `host_vfs_is_ro_mount`, `host_vfs_stat_ro`, `host_vfs_read_ro`, `host_vfs_list_dir_ro`, `host_vfs_is_virtual_parent`.
- Exports: `memory`, `alloc`, `dealloc`, `runtime_new`, `runtime_add_vfs_file`, `runtime_add_vfs_symlink` (M2), `runtime_read_vfs_file`, `runtime_init_guest_stack`, `runtime_handle_syscall`, `runtime_on_yield` (`0`=done, `1`=continue, `2`=switch pid, `3`=NeedFork, `4`=NeedExec), `runtime_get_active_pid`, `runtime_get_pending_child_pid`, `runtime_get_pending_scratch_addr`, `runtime_ack_fork`, `runtime_resume_active`, `runtime_get_exec_info`, `runtime_complete_exec`, `runtime_is_exited`, `runtime_get_stdout`, `runtime_get_stderr`, `runtime_get_exit_code`, `runtime_get_virtual_time_ns`.

### `js/elf2wasm_shim.mjs` & `web/`
- Zero-dependency pure ESM module (`Elf2WasmSystem`, `compileElfToWasm`, `runElf`, `runFromVfs`, `extractTarGzToVfs`) compatible with Node.js and browsers.
- `web/index.html`: Static HTML/JS UI using `elf2wasm_shim.mjs` to upload binaries or `.tar.gz`/`.zip` overlays into VFS and execute them.
