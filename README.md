# `elf2wasm`

`elf2wasm` is a **deterministic, Linux-compatible operating system** that runs **unmodified x86/x86-64 programs** in WebAssembly.

---

## Core Goal & Architecture

`elf2wasm` translates unmodified Linux x86-64 ELF64 executables and their required `.so` shared libraries (including `ld-linux-x86-64.so.2` and `libc.so.6`) into self-contained, zero-import WebAssembly (`.wasm`) modules and executes them inside a deterministic virtual OS.

- **CPS (Continuation-Passing Style) Execution Model**: Translated guest `.wasm` modules have **zero imports**. Instead of calling out through a synchronous host import on `syscall`, a guest sets `yield_flag = 3` (`YIELD_SYSCALL_PENDING`), saves `rcx = next_ip`, `r11 = rflags`, and `rip = next_ip`, and returns from `_start()`. Similarly, when the instruction/block quantum (`quantum`, default `128`) expires, the guest sets `yield_flag = 2` (`YIELD_QUANTUM`) and returns from `_start()`. The kernel/runtime inspects the exported register globals, executes the syscall or schedules another thread/process, updates CPU state, and resumes `_start()`.
- **Deterministic Virtual Time**: Clocks (`clock_gettime`, `gettimeofday`, `rdtsc`) and timed waits (`nanosleep`, `clock_nanosleep`, `futex`, `poll`, `epoll_wait`) advance a deterministic monotonic virtual clock rather than reading wall-clock host time, ensuring reproducible execution across runs and platforms.
- **Cooperative Preemption & Multi-Processing**: A cooperative scheduler manages threads (`clone`) and processes (`fork`/`vfork`/`execve`/`wait4`) using `save_ctx` / `load_ctx` into a 464-byte context buffer, enabling deterministic time-slicing and interleaving without host threads.
- **Sandboxed Virtual Filesystem (VFS)**: Guest file I/O operates against an in-memory writable overlay (regular files, directories, symlinks, pipes, `/dev/null`, `/dev/urandom` deterministic PRNG) layered over optional read-only host mounts (`--vfs-ro`), with zero unintended host writes or network access.

---

## Installation & Building `.wasm` Modules

### Prerequisites

- **Rust toolchain & `cargo`** (edition 2021)
- **`wasm32-unknown-unknown` target**:
  ```bash
  rustup target add wasm32-unknown-unknown
  ```
- **Node.js v24+** (for the JavaScript ESM API, `js/cli.mjs`, and E2E test suite)
- **`gcc` & Linux x86-64 shared libraries** (e.g., `/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`, `/lib/x86_64-linux-gnu/libc.so.6`) when compiling or translating dynamically linked x86-64 ELF guests

### Building the Native CLI

```bash
cargo build --release
```

This produces `target/release/elf2wasm`.

### Building the `.wasm` Compiler and Runtime Modules

```bash
cargo build --release --target wasm32-unknown-unknown -p elf2wasm-compiler-wasm -p elf2wasm-runtime-wasm
```

Outputs:
- `target/wasm32-unknown-unknown/release/elf2wasm_compiler_wasm.wasm`
- `target/wasm32-unknown-unknown/release/elf2wasm_runtime_wasm.wasm`

### Translating an ELF Executable to a Guest `.wasm` Module

#### Native CLI

```bash
elf2wasm translate <elf> [--so <path>...] -o <output.wasm>
```

Example (dynamically linked x86-64 binary):

```bash
gcc -O2 hello.c -o hello
./target/release/elf2wasm translate ./hello \
  --so /lib/x86_64-linux-gnu/ld-linux-x86-64.so.2 \
  --so /lib/x86_64-linux-gnu/libc.so.6 \
  -o hello.wasm
```

#### Node.js CLI

```bash
node js/cli.mjs compile --elf <path> [--so <path>...] --out <out.wasm>
```

Example:

```bash
node js/cli.mjs compile --elf ./hello \
  --so /lib/x86_64-linux-gnu/ld-linux-x86-64.so.2 \
  --so /lib/x86_64-linux-gnu/libc.so.6 \
  --out hello.wasm
```

---

## Running

### Native CLI

```bash
elf2wasm run <wasm> [--vfs-ro <host:guest>...] [-- <args...>]
```

Example:

```bash
./target/release/elf2wasm run hello.wasm -- arg1 arg2
```

### Node.js CLI

```bash
node js/cli.mjs run --elf <path> [--so <path>...] [--vfs-ro <host:guest>...] [--vfs-rw <host:guest>...] [-- <args...>]
```

Optional flags: `--compiler <path>` and `--runtime <path>` override the default `target/wasm32-unknown-unknown/release/elf2wasm_{compiler,runtime}_wasm.wasm` paths.

### JavaScript / Node.js ESM API (`js/elf2wasm_shim.mjs`)

`js/elf2wasm_shim.mjs` is a zero-dependency ESM module compatible with both Node.js and browsers.

#### `Elf2WasmSystem`

- `await Elf2WasmSystem.create({ compilerWasm, runtimeWasm, vfsRo = [], vfsRw = [] })` — Instantiates the compiler and runtime WASM modules and mounts optional host directories.
- `sys.compile(elfBytes, soEntries = [], options = {})` — Compiles an ELF64 binary and `soEntries` (`[{ path, name?, bytes }]`) into a guest `.wasm` `Uint8Array` (with in-memory caching).
- `sys.writeVfsFile(guestPath, bytes, mode = 0o644)` — Writes a file into the in-memory VFS overlay.
- `sys.writeVfsSymlink(guestPath, target)` — Creates a symbolic link in the VFS overlay.
- `sys.readVfsLink(guestPath)` — Reads the target string of a VFS symlink, or `null`.
- `sys.resolveVfsPath(guestPath, maxHops = 40)` — Resolves symlinks in the VFS and returns the canonical guest path.
- `sys.readVfsFile(guestPath)` — Reads a file from the VFS as `Uint8Array`, or `null`.
- `await sys.runElf(elfBytes, soEntries = [], args = [], options = {})` — Compiles (if needed) and runs an ELF binary, returning `{ exitCode, stdout, stderr, virtualTimeNs }`.
- `await sys.runFromVfs(guestPath, args = [], options = {})` — Resolves an executable in the VFS (including symlinks and `PT_INTERP`/`DT_NEEDED` shared libraries), compiles, and runs it.

#### Top-Level Helper Functions

- `await compileElfToWasm(compilerWasm, elfBytes, soEntries = [], options = {})` — One-shot ELF-to-WASM compilation returning `Uint8Array`.
- `await runElf({ compilerWasm, runtimeWasm, elfBytes, soEntries = [], args = [], ... })` — One-shot compile and run.
- `await runFromVfs({ compilerWasm, runtimeWasm, vfs, command, args = [], env, vfsRo = [], vfsRw = [] })` — One-shot execution of an ELF from a VFS overlay (`{ files, symlinks }`).
- `extractTarToVfs(systemOrBytes, maybeTarBytes)` — Extracts a `.tar` archive (files, directories, symlinks, and hardlinks) and returns `{ files, symlinks }`. Pass an `Elf2WasmSystem` as the first argument and tar bytes as the second to also populate its VFS, or pass `Uint8Array`/`ArrayBuffer` bytes directly as the first argument.
- `await extractTarGzToVfs(systemOrBytes, maybeGzBytes)` — Decompresses `.tar.gz`/`.tgz` via `DecompressionStream("gzip")` and extracts it (same `(system, bytes)` or `(bytes)` calling convention, returning `{ files, symlinks }`).
- `await extractZipToVfs(systemOrBytes, maybeZipBytes)` — Extracts a `.zip` archive (stored or deflate-compressed) (same `(system, bytes)` or `(bytes)` calling convention, returning `{ files, symlinks }`).
- `await compileAndRunInVfs({ compilerWasm, runtimeWasm, ccBytes, ccPath = "/usr/bin/gcc", soEntries = [], vfsRo = [], vfsRw = [], sourceBytes, guestSourcePath, guestOutPath })` — Writes `sourceBytes` to `guestSourcePath` in a fresh VFS, runs the hosted C compiler `ccBytes` (`ccPath`) to compile `guestSourcePath` into `guestOutPath`, and executes `guestOutPath`.

### Docker WASM Web Shell & Browser JS SDK (`server/server.mjs`, `web/index.html`)

First build the compiler and runtime `.wasm` modules (required so `/wasm/*.wasm` is available):

```bash
rustup target add wasm32-unknown-unknown
cargo build --release --target wasm32-unknown-unknown -p elf2wasm-compiler-wasm -p elf2wasm-runtime-wasm
```

Then start the zero-dependency Node.js web server (which serves the static web UI, `/js/*`, `/wasm/*` with COOP/COEP headers, and the stateless OCI v2 streaming proxy):

```bash
node server/server.mjs --port 8080
```

Open `http://127.0.0.1:8080/` in your browser:
1. Click **Start Shell** to pull and boot `alpine:latest` client-side in WebAssembly inside a Dedicated Web Worker, or enter any other OCI/Docker image reference (e.g., `busybox:latest`).
2. Run interactive shell commands in the built-in VT100 web terminal — all layer decompression, ELF64-to-WASM compilation, and execution happen 100% client-side.
3. Call `window.Elf2WasmDocker` or `window.runDockerImage("alpine:latest", { cmd: ["/bin/sh", "-c", "uname -a"] })` directly from JavaScript (or import `/js/docker_sdk.mjs`).

#### URL Query-Parameter Deep-Linking

All shareable Web UI options automatically sync with the browser URL query string (`?query`) so you can copy and share a direct link to any container + Git repository coding project (for security, opening a deep link populates the form without auto-booting the container):

| Parameter | Default (omitted) | Description |
|---|---|---|
| `image` | `alpine:latest` | Docker / OCI image reference (e.g. `python:3.12-slim`) |
| `cmd` | *(image default)* | Optional command override |
| `repo` | *(none)* | Git repository overlay (`owner/repo` or forge URL) |
| `ref` | `HEAD` | Branch, tag, or commit SHA (only serialized when `repo` is set; `repoRef` also accepted on read) |
| `mount` | `/workspace` | Guest mount path for the Git repo (only serialized when `repo` is set; `repoMount` also accepted on read) |
| `cwd` | *(image default)* | Working directory (auto-opens Advanced Options on load) |
| `env` | *(none)* | Repeatable `KEY=VALUE` parameter (e.g. `?env=FOO=1&env=BAR=2`; auto-opens Advanced Options on load) |
| `preset` | *(none)* | Read-only shorthand (`python-bottle`, `js-nanoid`, `rust-nushell`) expanded on load; any explicit parameter overrides the preset |

Example shareable link:
```
/?image=python:3.12-slim&repo=bottlepy/bottle&ref=0.13.4&cmd=python3+-m+unittest+discover+-s+test+-t+.&cwd=/workspace&env=PYTHONUNBUFFERED=1
```

---

## Exhaustive WASM ABI Documentation

### Module 1: `elf2wasm-compiler-wasm` (`elf2wasm_compiler_wasm.wasm`)

#### Imports

None (zero imports).

#### Exports

| Export Name | Kind | Signature / Type | Description |
|---|---|---|---|
| `memory` | Memory | `WebAssembly.Memory` | Linear memory used for passing input bundles and reading output buffers. |
| `alloc` | Function | `(len: i32) -> i32` | Allocates `len` bytes in compiler linear memory. Returns `0` if `len == 0`. |
| `dealloc` | Function | `(ptr: i32, len: i32) -> ()` | Frees a buffer allocated by `alloc` or returned by `compile_bundle`. No-op if `ptr == 0 \|\| len == 0`. |
| `compile_bundle` | Function | `(ptr: i32, len: i32, out_len_ptr: i32) -> i32` | Compiles an `E2WB` bundle at `(ptr, len)` into a guest `.wasm` module. Writes output byte length (`u32` LE) to `*out_len_ptr` and returns `out_ptr`. |

#### `E2WB` Binary Bundle Format

All multi-byte integers are little-endian `u32`; strings are UTF-8 (not NUL-terminated):

1. `magic`: `b"E2WB"` (4 bytes)
2. `main_path_len`: `u32`
3. `main_path`: `[u8; main_path_len]`
4. `main_bytes_len`: `u32`
5. `main_bytes`: `[u8; main_bytes_len]`
6. `num_sos`: `u32`
7. Repeated `num_sos` times:
   - `so_path_len`: `u32`
   - `so_path`: `[u8; so_path_len]`
   - `so_bytes_len`: `u32`
   - `so_bytes`: `[u8; so_bytes_len]`

#### Output Buffer Format

`*out_len_ptr` receives `out_len` (`u32` LE). The caller must free the returned buffer with `dealloc(out_ptr, out_len)`.
- Byte `0 == 0x00`: compilation succeeded; bytes `1..out_len` are the compiled guest `.wasm` module.
- Byte `0 == 0x01`: compilation failed; bytes `1..out_len` are a UTF-8 error message.

---

### Module 2: `elf2wasm-runtime-wasm` (`elf2wasm_runtime_wasm.wasm`)

#### Imports (all in module `"env"`)

| Module | Import Name | Signature | Description |
|---|---|---|---|
| `env` | `host_mem_size` | `() -> i32` | Returns the active guest linear memory size in bytes. |
| `env` | `host_read_guest` | `(guest_addr: i32, rt_ptr: i32, len: i32) -> i32` | Copies `len` bytes from active guest memory at `guest_addr` into runtime memory at `rt_ptr`. Returns `0` on success, non-zero on fault. |
| `env` | `host_write_guest` | `(guest_addr: i32, rt_ptr: i32, len: i32) -> i32` | Copies `len` bytes from runtime memory at `rt_ptr` into active guest memory at `guest_addr`. Returns `0` on success, non-zero on fault. |
| `env` | `host_zero_guest` | `(guest_addr: i32, len: i32) -> i32` | Zero-fills `len` bytes in active guest memory starting at `guest_addr`. Returns `0` on success, non-zero on fault. |
| `env` | `host_get_global` | `(id: i32) -> i64` | Reads a guest global identified by `GLOBAL_ID_*` (`0..=15`) from the active guest instance (sign/zero-extended to `i64` for `i32` globals). |
| `env` | `host_set_global` | `(id: i32, val: i64) -> ()` | Writes `val` to a guest global identified by `GLOBAL_ID_*` (`0..=15`) on the active guest instance. |
| `env` | `host_save_ctx` | `(scratch_addr: i32) -> ()` | Calls `save_ctx(scratch_addr)` on the active guest instance. |
| `env` | `host_load_ctx` | `(scratch_addr: i32) -> ()` | Calls `load_ctx(scratch_addr)` on the active guest instance. |
| `env` | `host_vfs_is_ro_mount` | `(path_ptr: i32, path_len: i32) -> i32` | Returns `1` if the normalized guest path is under a host read-only mount, `0` otherwise. |
| `env` | `host_vfs_stat_ro` | `(path_ptr: i32, path_len: i32, out_mode_ptr: i32, out_size_ptr: i32) -> i32` | Stats a path on a host read-only mount, writing `st_mode` (`u32`) and `st_size` (`i64`) to runtime memory. Returns `0` on success, non-zero if not found. |
| `env` | `host_vfs_read_ro` | `(path_ptr: i32, path_len: i32, out_len_ptr: i32) -> i32` | Reads a host read-only file into a runtime buffer allocated via `alloc`, writes length to `*out_len_ptr`, and returns the pointer (or `0` on failure). |
| `env` | `host_vfs_list_dir_ro` | `(path_ptr: i32, path_len: i32, out_len_ptr: i32) -> i32` | Lists a host read-only directory into a runtime buffer allocated via `alloc`, writes length to `*out_len_ptr`, and returns the pointer (or `0` on failure). Packed entry format: `[u8 d_type, u16_le name_len, name_bytes...]`. |
| `env` | `host_vfs_is_virtual_parent` | `(path_ptr: i32, path_len: i32) -> i32` | Returns `1` if the path is a virtual parent directory of a host read-only mount, `0` otherwise. |

#### Global IDs (`GLOBAL_ID_*`, `0..=15`)

| ID | Constant | Guest Global | Type |
|---|---|---|---|
| `0` | `GLOBAL_ID_FSBASE` | `fsbase` | `i64` |
| `1` | `GLOBAL_ID_GSBASE` | `gsbase` | `i64` |
| `2` | `GLOBAL_ID_RCX` | `rcx` | `i64` |
| `3` | `GLOBAL_ID_RIP` | `rip` | `i64` |
| `4` | `GLOBAL_ID_RSP` | `rsp` | `i64` |
| `5` | `GLOBAL_ID_EXIT_FLAG` | `exit_flag` | `i32` |
| `6` | `GLOBAL_ID_EXIT_CODE` | `exit_code` | `i32` |
| `7` | `GLOBAL_ID_YIELD_FLAG` | `yield_flag` | `i32` |
| `8` | `GLOBAL_ID_QUANTUM` | `quantum` | `i32` |
| `9` | `GLOBAL_ID_RAX` | `rax` | `i64` |
| `10` | `GLOBAL_ID_RDI` | `rdi` | `i64` |
| `11` | `GLOBAL_ID_RSI` | `rsi` | `i64` |
| `12` | `GLOBAL_ID_RDX` | `rdx` | `i64` |
| `13` | `GLOBAL_ID_R10` | `r10` | `i64` |
| `14` | `GLOBAL_ID_R8` | `r8` | `i64` |
| `15` | `GLOBAL_ID_R9` | `r9` | `i64` |

#### Exports

| Export Name | Kind | Signature / Type | Description |
|---|---|---|---|
| `memory` | Memory | `WebAssembly.Memory` | Runtime linear memory. |
| `alloc` | Function | `(len: i32) -> i32` | Allocates `len` bytes in runtime linear memory (`0` if `len == 0`). |
| `dealloc` | Function | `(ptr: i32, len: i32) -> ()` | Frees a buffer allocated by `alloc` or returned by allocating runtime exports (`0` / `len == 0` is a no-op). |
| `runtime_new` | Function | `() -> i32` | Initializes a fresh `HostState` with multi-processing enabled. Returns `0`. |
| `runtime_add_vfs_file` | Function | `(path_ptr: i32, path_len: i32, data_ptr: i32, data_len: i32, mode: i32) -> i32` | Adds or overwrites a regular file in the in-memory VFS overlay. Returns `0` on success, `-1` on error. |
| `runtime_add_vfs_symlink` | Function | `(path_ptr: i32, path_len: i32, target_ptr: i32, target_len: i32) -> i32` | Adds a symbolic link at `path` pointing to `target` in the VFS overlay. Returns `0` on success, `-1` on error. |
| `runtime_read_vfs_file` | Function | `(path_ptr: i32, path_len: i32, out_len_ptr: i32) -> i32` | Reads a file from the VFS into an allocated buffer, writing byte length to `*out_len_ptr`. Caller frees with `dealloc`. Returns `0` if not found. |
| `runtime_read_vfs_link` | Function | `(path_ptr: i32, path_len: i32, out_len_ptr: i32) -> i32` | Reads a symlink target from the VFS into an allocated buffer, writing byte length to `*out_len_ptr`. Caller frees with `dealloc`. Returns `0` if not a symlink. |
| `runtime_init_guest_stack` | Function | `(meta_ptr: i32, meta_len: i32, args_ptr: i32, args_len: i32) -> i32` | Decodes `elf2wasm_meta` and `E2WA` (or NUL-separated) args/env, resets runtime state for a new run, initializes guest stack (`argc`, `argv`, `envp`, `auxv`), and sets `rsp` and `rip`. Returns `0` on success (`< 0` on error). |
| `runtime_handle_syscall` | Function | `(nr: i64, a0: i64, a1: i64, a2: i64, a3: i64, a4: i64, a5: i64) -> i64` | Directly dispatches a Linux x86-64 syscall on the current `HostState`. |
| `runtime_on_yield` | Function | `() -> i32` | Handles a guest yield (`yield_flag` `1`, `2`, or `3`). See return codes and CPS flow below. |
| `runtime_get_active_pid` | Function | `() -> i32` | Returns the PID of the currently active guest process. |
| `runtime_get_pending_child_pid` | Function | `() -> i32` | Returns the child PID for a pending `Fork` action, or `-1`. |
| `runtime_get_pending_scratch_addr` | Function | `() -> i32` | Returns the guest scratch address used for context save/load during `Fork` or scheduling. |
| `runtime_ack_fork` | Function | `(child_pid: i32) -> i32` | Acknowledges that the host cloned the guest instance for `child_pid`. Returns `0` on success, `-1` on error. |
| `runtime_resume_active` | Function | `() -> i32` | Restores context/globals for the active process/thread before resuming `_start()`. Returns `1` if runnable, `0` if done, `-1` on error. |
| `runtime_get_exec_info` | Function | `(out_len_ptr: i32) -> i32` | Returns an allocated `E2WE` buffer describing a pending `Exec` action (length written to `*out_len_ptr`). Caller frees with `dealloc`. |
| `runtime_complete_exec` | Function | `(pid: i32, meta_ptr: i32, meta_len: i32, args_ptr: i32, args_len: i32) -> i32` | Completes an `Exec` transition after the host instantiates the new guest module for `pid`. Returns `0` on success (`< 0` on error). |
| `runtime_is_exited` | Function | `() -> i32` | Returns `1` if the main process has exited, `0` otherwise. |
| `runtime_get_stdout` | Function | `(out_len_ptr: i32) -> i32` | Returns a **borrowed** pointer to the captured `stdout` buffer and writes its length to `*out_len_ptr`. **Do not `dealloc`.** |
| `runtime_get_stderr` | Function | `(out_len_ptr: i32) -> i32` | Returns a **borrowed** pointer to the captured `stderr` buffer and writes its length to `*out_len_ptr`. **Do not `dealloc`.** |
| `runtime_get_exit_code` | Function | `() -> i32` | Returns the guest's `exit_code` global. |
| `runtime_get_virtual_time_ns` | Function | `() -> i64` | Returns the current deterministic monotonic virtual time in nanoseconds (`u64` as `i64`). |

#### Binary Formats (`E2WA` and `E2WE`)

- **`E2WA`** (input to `runtime_init_guest_stack` / `runtime_complete_exec`, little-endian `u32`):
  - `magic`: `b"E2WA"` (4 bytes)
  - `argc`: `u32`, followed by `argc` entries of (`len: u32`, `bytes: [u8; len]`)
  - `envc`: `u32`, followed by `envc` entries of (`len: u32`, `bytes: [u8; len]`)
  - *(Fallback)* If the buffer does not start with `b"E2WA"`, it is parsed as NUL-separated `argv` strings, optionally followed by `\0\0` and NUL-separated `envp` strings.
- **`E2WE`** (output of `runtime_get_exec_info`, little-endian):
  - `magic`: `b"E2WE"` (4 bytes)
  - `pid`: `i32`
  - `path_len`: `u32`, `path`: `[u8; path_len]`
  - `argc`: `u32`, followed by `argc` entries of (`arg_len: u32`, `arg: [u8; arg_len]`)
  - `envc`: `u32`, followed by `envc` entries of (`env_len: u32`, `env: [u8; env_len]`)

#### `runtime_on_yield` Return Codes (`0..=4`) & CPS `yield_flag == 3` Flow

| Return Code | Meaning | Host Action |
|---|---|---|
| `0` | Exited / Deadlocked | Execution is complete; read `runtime_get_exit_code()`, `runtime_get_stdout()`, `runtime_get_stderr()`. |
| `1` | Continue Active | Continue running the current active PID (`runtime_get_active_pid()`). |
| `2` | Switch Active | Switch active guest instance to `runtime_get_active_pid()` and call `runtime_resume_active()`. |
| `3` | `NeedFork` | Clone the active guest instance, register it under `runtime_get_pending_child_pid()`, call `runtime_ack_fork(child_pid)`, then call `runtime_resume_active()`. |
| `4` | `NeedExec` | Read `runtime_get_exec_info()` (`E2WE`), compile/instantiate the new guest `.wasm` for `pid`, call `runtime_complete_exec(...)`, and resume. |

**CPS `yield_flag == 3` (`YIELD_SYSCALL_PENDING`) Flow:**
1. When `runtime_on_yield()` sees `yield_flag == 3`, it reads `nr` from `GLOBAL_ID_RAX` and `a0..a5` from `GLOBAL_ID_RDI`, `GLOBAL_ID_RSI`, `GLOBAL_ID_RDX`, `GLOBAL_ID_R10`, `GLOBAL_ID_R8`, and `GLOBAL_ID_R9`.
2. It invokes `handle_syscall(...)` and writes the return value back to `GLOBAL_ID_RAX`.
3. If the main process exited or `exit_flag != 0` with no pending host action, it returns `0`.
4. **Fast-path**: if `yield_flag` is still `3` and no other thread or process is currently runnable, it clears `yield_flag` to `0` (`host_set_global(GLOBAL_ID_YIELD_FLAG, 0)`) and returns `1` immediately without a context save/restore.
5. Otherwise (if the syscall blocked, triggered `PendingHostAction::Fork` / `Exec`, or another thread/process is runnable), it delegates to `on_yield_multiproc(...)` to save context and preemptively switch to another runnable thread/process (returning `1`..`4`).

---

### Module 3: Translated Guest Executable (`.wasm`)

#### Imports

None (zero imports — no `env.syscall`).

#### Exported `"memory"` & Virtual Address Map

The guest exports a single fixed-size linear `"memory"` (`minimum = maximum = max(4096, ceil((DISPATCH_HASH_ADDR + table_slots * 8) / 65536))` pages, i.e. 256 MiB+ at 64 KiB/page).

| Constant | Address | Purpose |
|---|---|---|
| `DISPATCH_TABLE_ADDR` | `0x0001_0000` | Legacy dispatch table region (64 KiB) |
| `MAIN_PIE_BASE` | `0x0010_0000` | Default base address for PIE (`ET_DYN`) main executables (1 MiB) |
| `LD_BASE` | `0x0100_0000` | Default base address for `ld-linux-x86-64.so.2` (16 MiB) |
| `SO_BASE_START` | `0x0200_0000` | Default starting base address for shared libraries (32 MiB) |
| `BRK_START` | `0x0500_0000` | Initial program break (`brk`) (80 MiB) |
| `MMAP_START` | `0x0800_0000` | Anonymous `mmap` region start (128 MiB) |
| `MMAP_ALLOC_END` | `0x0AFF_F000` | Upper bound for `mmap`; the 4 KiB page `0x0AFF_F000..0x0B00_0000` serves as the `save_ctx`/`load_ctx` scratch page |
| `STACK_TOP` | `0x0BFF_0000` | Initial guest stack top (~192 MiB) |
| `DISPATCH_HASH_ADDR` | `0x0C00_0000` | Open-addressed indirect-branch dispatch hash table (`8` bytes per slot, 192 MiB) |

#### Exported Functions

| Export Name | Signature | Description |
|---|---|---|
| `_start` | `() -> i32` | Executes translated x86-64 blocks starting from `rip` until exit (`exit_flag != 0`) or yield (`yield_flag != 0`). Returns `exit_code`. |
| `save_ctx` | `(ctx_ptr: i32) -> ()` | Serializes all CPU registers, flags, `rip`, `fsbase`, `gsbase`, `tsc`, `mxcsr`, `x87_cw`, and `xmm0..xmm15` into `464` bytes at `ctx_ptr`. |
| `load_ctx` | `(ctx_ptr: i32) -> ()` | Restores all CPU registers, flags, `rip`, `fsbase`, `gsbase`, `tsc`, `mxcsr`, `x87_cw`, and `xmm0..xmm15` from `464` bytes at `ctx_ptr`. |

#### Exact 464-byte `CTX_SIZE` Layout (`save_ctx` / `load_ctx`)

| Byte Offset | Size | Type | Field(s) |
|---|---|---|---|
| `0..128` | 128 | `i64` x 16 | `rax` (+0), `rcx` (+8), `rdx` (+16), `rbx` (+24), `rsp` (+32), `rbp` (+40), `rsi` (+48), `rdi` (+56), `r8` (+64), `r9` (+72), `r10` (+80), `r11` (+88), `r12` (+96), `r13` (+104), `r14` (+112), `r15` (+120) |
| `128..136` | 8 | `i64` | `rip` |
| `136..144` | 8 | `i64` | `fsbase` |
| `144..152` | 8 | `i64` | `gsbase` |
| `152..160` | 8 | `i64` | `tsc` |
| `160..188` | 28 | `i32` x 7 | `cf` (+160), `pf` (+164), `af` (+168), `zf` (+172), `sf` (+176), `of` (+180), `df` (+184) |
| `188..192` | 4 | `i32` | `mxcsr` |
| `192..196` | 4 | `i32` | `x87_cw` |
| `196..208` | 12 | — | Padding |
| `208..464` | 256 | `v128` x 16 | `xmm0` (+208), `xmm1` (+224), ..., `xmm15` (+448) |

#### Exported Globals (all mutable)

| Export Name | WASM Type | Initial Value | Description |
|---|---|---|---|
| `rax`, `rcx`, `rdx`, `rbx`, `rsp`, `rbp`, `rsi`, `rdi`, `r8`, `r9`, `r10`, `r11`, `r12`, `r13`, `r14`, `r15` | `i64` | `0` | 64-bit general-purpose x86-64 registers |
| `rip` | `i64` | `entry_rip` | Guest instruction pointer |
| `exit_flag` | `i32` | `0` | Non-zero when the guest has exited |
| `exit_code` | `i32` | `0` | Guest exit status code |
| `fsbase` | `i64` | `0` | x86-64 `%fs` segment base (TLS) |
| `gsbase` | `i64` | `0` | x86-64 `%gs` segment base |
| `yield_flag` | `i32` | `0` | Yield reason (`0`..`3`) |
| `quantum` | `i32` | `128` | Remaining block dispatch budget (`DEFAULT_QUANTUM = 128`) |

#### CPS Syscall & Quantum Preemption Convention

- `yield_flag` values:
  - `0`: `YIELD_NONE` (running / normal)
  - `1`: `YIELD_BLOCKED` (blocked / explicit yield)
  - `2`: `YIELD_QUANTUM` (quantum exhausted)
  - `3`: `YIELD_SYSCALL_PENDING` (pending Linux syscall)
- **On `syscall`**:
  1. Guest sets `rcx = next_ip`.
  2. Guest sets `r11 = rflags`, packed as `0x202 | cf | (pf << 2) | (af << 4) | (zf << 6) | (sf << 7) | (df << 10) | (of << 11)`.
  3. Guest sets `rip = next_ip`.
  4. Guest sets `yield_flag = 3` (`YIELD_SYSCALL_PENDING`) and returns from `_start()`.
  5. Syscall number is in `rax`; arguments are in `rdi`, `rsi`, `rdx`, `r10`, `r8`, `r9`.
  6. The host executes the syscall, writes the return value to `rax`, resets `yield_flag = 0` (leaving `quantum` unchanged on the non-preempting syscall fast-path, or resetting `quantum = 128` on quantum exhaustion / context switch), and resumes `_start()`.
- **On quantum preemption**:
  - When `quantum <= 0` at a block transition, the guest sets `rip = target_va`, `yield_flag = 2` (`YIELD_QUANTUM`), and returns from `_start()`.

#### `"elf2wasm_meta"` Custom Section Binary Layout

All multi-byte integers are little-endian `u32`; strings are `u32` length-prefixed UTF-8:

1. `magic`: `b"ELF2WASM"` (8 bytes)
2. `entry_rip`: `u32`
3. `at_phdr`: `u32`
4. `at_phent`: `u32`
5. `at_phnum`: `u32`
6. `at_entry`: `u32`
7. `at_base`: `u32`
8. `max_code_addr`: `u32`
9. `num_so`: `u32`, followed by `num_so` entries:
   - `base_addr`: `u32`
   - `num_gp`: `u32`, followed by `num_gp` entries of (`len: u32`, `guest_path: [u8; len]`)
   - `bytes_len`: `u32`, `bytes`: `[u8; bytes_len]`
10. `num_sym`: `u32`, followed by `num_sym` entries:
    - `addr`: `u32`
    - `name_len`: `u32`, `name`: `[u8; name_len]`
11. `elf_path_len`: `u32`, `elf_path`: `[u8; elf_path_len]`
