# Project: elf2wasm

## Architecture
`elf2wasm` translates unmodified Linux x86-64 ELF64 binaries (and their required `.so` shared libraries) into a self-contained WebAssembly (`.wasm`) module and executes it in a `wasmtime` sandbox with emulated Linux syscalls.

- **Translation Pipeline (`elf2wasm translate`)**:
  1. `elf_loader.rs`: Parses main ELF64 (`ET_DYN` PIE at `0x0010_0000` or `ET_EXEC` non-PIE at `0x0040_0000`+), `ld-linux-x86-64.so.2` (`LD_BASE = 0x0100_0000`), and `.so` libraries (`SO_BASE_START = 0x0200_0000`+, 1 MB aligned).
  2. `decoder.rs`: Decodes all `PF_X` segments using `iced-x86`, discovers function/block boundaries and indirect dispatch targets.
  3. `lifter.rs` & `wasm_emit.rs`: Lifts x86-64 instructions (baseline GPRs, flags, `%fs:` TLS, SSE/SSE2, x87 subset if needed, masked `cpuid`/`xgetbv`, `rdtsc`, `syscall` import) into a valid `.wasm` module with 256 MB linear memory (`4096` pages), trampoline/`return_call_indirect` dispatch, initial `DataSection`, and `elf2wasm_meta` custom section (`meta.rs`).
- **Sandboxed Runtime (`elf2wasm run`)**:
  1. `runtime.rs`: Loads the `.wasm` module via `wasmtime 27`, decodes `elf2wasm_meta`, initializes `STACK_TOP` (`0x0BFF_0000`) with `argc`, `argv`, `envp`, and `auxv` (omitting `AT_SYSINFO_EHDR` so glibc uses `clock_gettime` syscall).
  2. `syscalls.rs` & `vfs.rs`: Emulates Linux x86-64 syscalls in a sandboxed virtual OS: `.so`-aware `mmap` returning `so.base_addr`, `brk`, `arch_prctl(ARCH_SET_FS)`, process/signal/time/futex stubs, and a read-only sandboxed VFS for embedded `.so` files and host-mapped read-only system/Python stdlib paths (zero host writes, zero network/process creation).

## Code Layout
```
/home/antigravity/elf2wasm/
├── Cargo.toml
├── Cargo.lock
├── PROJECT.md
├── src/
│   ├── main.rs          # CLI entry point (translate, run)
│   ├── elf_loader.rs    # Existing ELF64 + .so loader & memory layout constants
│   ├── meta.rs          # Existing WasmMeta custom section serialization
│   ├── decoder.rs       # M1: iced-x86 code discovery & basic-block/function CFG
│   ├── lifter.rs        # M2: x86-64 -> WASM instruction lifting & CPU state
│   ├── wasm_emit.rs     # M2: wasm-encoder module assembly & dispatch table
│   ├── runtime.rs       # M3: wasmtime 27 host, stack/auxv setup, execution loop
│   ├── syscalls.rs      # M3/M4: Linux x86-64 sandboxed syscall emulator
│   └── vfs.rs           # M3/M4: Sandboxed virtual filesystem & fd table
└── tests/               # E2E & integration test suite
```

## Feature Inventory
Every feature from the Survey phase is assigned a milestone below:

| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | ELF64 PIE & non-PIE + `.so` loading | Load `ET_DYN` (`true`/`echo`), `ET_EXEC` (`python3` at `0x400000`+), `ld-linux-x86-64.so.2`, and `.so` list into 32-bit guest VA layout | M1 (wire existing `elf_loader.rs`/`meta.rs`) | Survey 1, 2, 3 |
| 2 | x86-64 code discovery & decoding | Decode `PF_X` segments with `iced-x86` (recursive descent + linear sweep) to map all blocks, functions, and indirect targets | M1 | Survey 2 |
| 3 | CPU state & flags lifting | 16 GPRs, `rip`, `rflags` (CF/ZF/SF/OF/PF/AF), `fsbase`/`gsbase`, 16 XMM (`v128`), `cmovcc`/`setcc`/`jcc`/`adc`/`sbb` | M2 | Survey 2, 3 |
| 4 | Baseline x86-64 + `rep`/`lock`/`endbr64` | Full `x86-64-baseline` integer/control-flow, `rep movs/stos/scas/cmps`, `lock` RMW, `endbr64` NOP, `rdtsc` | M2 | Survey 2, 3 |
| 5 | SSE/SSE2 & `cpuid`/`xgetbv` masking | Mask `cpuid`/`xgetbv` to baseline x86-64 + SSE2 (disable AVX/AVX2/AVX-512/BMI) so `ld.so`/`libc` pick SSE2 IFUNCs; lift SSE/SSE2 ops | M2 | Survey 2, 3 |
| 6 | Indirect dispatch & WASM module emission | Trampoline or `return_call_indirect` dispatch (no WASM stack overflow), `wasm-encoder` emission + `elf2wasm_meta` custom section | M2 | Survey 2 |
| 7 | `wasmtime` host & Linux stack/auxv init | Load `.wasm`, decode `elf2wasm_meta`, populate `STACK_TOP` (`argc`, `argv`, `envp`, `auxv` without `AT_SYSINFO_EHDR`), run `_start` | M3 | Survey 2, 3 |
| 8 | Tier 1 memory & process syscalls (`true`/`echo`) | `brk`, `.so`-aware `mmap`, `mprotect`, `munmap`, `mremap`, `arch_prctl(ARCH_SET_FS)`, `set_tid_address`, `set_robust_list`, `rseq`, `prlimit64`, `getrandom`, `futex`, `exit`/`exit_group` | M3 | Survey 2, 3 |
| 9 | Tier 1 VFS & I/O syscalls (`true`/`echo`) | FD table (stdin/stdout/stderr capture), `openat` (embedded `.so`s + locale/gconv + `-ENOENT` for `/etc/ld.so.preload`), `close`, `read`, `pread64`, `write`, `writev`, `newfstatat`, `access` | M3 | Survey 2, 3 |
| 10 | CLI (`translate` & `run`) | `clap` CLI to translate ELF+`.so`s to `.wasm` and run `.wasm` with args and sandboxed VFS mounts | M3 | Survey 1, 2 |
| 11 | Python 3 syscalls & signals/time/ids | `lseek`, `getdents64`, `fcntl`, `ioctl(TCGETS -> -ENOTTY)`, `rt_sigaction`, `rt_sigprocmask`, `sigaltstack`, `readlink`/`readlinkat`, `getcwd`, `sysinfo`, `getuid`/`geteuid`/`getgid`/`getegid`/`getpid`/`gettid`, `uname`, `clock_gettime`, `gettimeofday`, `sched_getaffinity`, `dup*`/`pipe2` | M4 | Survey 2, 3 |
| 12 | Python 3 stdlib VFS & x87/SSE4.2 edge ops | Read-only VFS mapping for `/usr/lib/python3.11/**`, `/usr/lib/python3/dist-packages/**`, user `.py` scripts; any x87 FPU / SSE4.2 ops hit by `libm.so.6`/`libz.so.1`/`python3` | M4 | Survey 3 |
| 13 | Differential verification & E2E test suite | Verify identical exit code, stdout, stderr between native and WASM for `true`, `echo`, and `python3` programs under sandbox | M5 (and E2E Track) | Survey 1, 2, 3 |

## Milestones

| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | `decoder` (Code Discovery & CFG) | `src/decoder.rs` + wire `mod`s in `src/main.rs`; decode `PF_X` segments of `true`, `echo`, `python3`, `ld.so`, `libc.so.6` with unit tests | none | DONE (`src/decoder.rs`, 9/9 tests) |
| M2 | `lifter` & `wasm_emit` (x86-64 → WASM) | `src/lifter.rs`, `src/wasm_emit.rs`; lift baseline x86-64 + SSE2 + masked `cpuid`/`xgetbv` + `syscall` import + overflow-safe dispatch; validate emitted `.wasm` | M1 | DONE (`src/lifter.rs`, `src/wasm_emit.rs`, 20/20 tests) |
| M3 | `runtime` & Tier 1 Syscalls (`true`, `echo`) | `src/runtime.rs`, `src/syscalls.rs`, `src/vfs.rs`, `src/main.rs` CLI; execute `/usr/bin/true` and `/usr/bin/echo` identically to native | M2 | DONE (`src/runtime.rs`, `src/syscalls.rs`, `src/vfs.rs`, `src/main.rs`, 22 unit + 2 diff tests) |
| M4 | Python 3 Support (`python3`) | Extend `syscalls.rs`, `vfs.rs`, and `lifter.rs` (x87/extra ops if hit) to execute `/usr/bin/python3` basic programs identically to native | M3 | DONE (`tests/m4_python3.rs` + `23` unit + `2` m3 tests) |
| M5 | Final Milestone (E2E Pass + Tier 5 Hardening) | Pass 100% of E2E tests (Tiers 1–4) after `TEST_READY.md`, then run Tier 5 adversarial coverage hardening | M4, TEST_READY.md | DONE (144/144 E2E + 9/9 Tier 5 + 26/26 unit + m3/m4) |
| M6 | Git History & Remote Push (`fatlotus/elf2wasm`) | Create small, self-contained git commits (excluding `target/`, `.agents/`), set remote `origin` to `fatlotus/elf2wasm`, and push | M5 | DONE (`m6_worker`) |

## Interface Contracts

### `elf_loader` ↔ `decoder`
- `LoadedImage` provides `exec_segments: Vec<ExecSegment>` (`vaddr: u32`, `bytes: Vec<u8>`), `entry_rip: u32`, and `symbols: Vec<(u32, String)>`.
- `decoder::discover_code(image: &LoadedImage) -> Result<DecodedProgram>` returns basic blocks/functions keyed by `u32` guest virtual address, with sorted instruction/block entry addresses for indirect dispatch.

### `decoder` ↔ `lifter` / `wasm_emit`
- `wasm_emit::emit_wasm(image: &LoadedImage, prog: &DecodedProgram) -> Result<Vec<u8>>` produces a valid `.wasm` binary containing:
  - Import: `("env", "syscall", [i64, i64, i64, i64, i64, i64, i64] -> [i64])`
  - Export: `"memory"` (Memory, 4096 initial pages), `"_start"` (`[] -> [i32]` or `() -> ()` with exit code via syscall/global)
  - Custom section: `"elf2wasm_meta"` encoded by `WasmMeta::encode()`.

### `wasm_emit` ↔ `runtime` / `syscalls` / `vfs`
- `runtime::run_wasm(wasm_bytes: &[u8], config: RunConfig) -> Result<RunOutput>` decodes `"elf2wasm_meta"`, initializes `STACK_TOP` with `argc`/`argv`/`envp`/`auxv`, runs `_start`, and returns `RunOutput { exit_code: i32, stdout: Vec<u8>, stderr: Vec<u8> }`.
- `syscalls::handle_syscall(caller, nr, a0..a5) -> i64` accesses guest linear memory via `wasmtime::Memory`, `.so` payloads via `WasmMeta.so_files`, and sandboxed files via `vfs::VirtualFs`.
