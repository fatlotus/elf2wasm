# `elf2wasm`

`elf2wasm` is a **deterministic, Linux-compatible container runtime** that executes **unmodified x86-64 OCI container images and GitHub repositories** in WebAssembly — both **locally in the browser** and **remotely on Cloudflare Workers** (`wasmi`) with identical deterministic output.

---

## Core Goal & Architecture

`elf2wasm` translates unmodified Linux x86-64 ELF64 executables and their required `.so` shared libraries (including `ld-linux-x86-64.so.2` and `libc.so.6`) into self-contained, zero-import WebAssembly (`.wasm`) modules and executes them inside a deterministic virtual OS:

- **CPS (Continuation-Passing Style) Execution Model**: Translated guest `.wasm` modules have **zero imports**. On `syscall`, a guest sets `yield_flag = 3` (`YIELD_SYSCALL_PENDING`), saves `rcx = next_ip`, `r11 = rflags`, and `rip = next_ip`, and returns from `_start()`. When the block quantum (`quantum`, default `128`) expires, the guest sets `yield_flag = 2` (`YIELD_QUANTUM`) and returns. The runtime inspects exported globals, executes the syscall or schedules another thread/process, updates CPU state, and resumes `_start()`.
- **Deterministic Virtual Time & Delay Injection**: Clocks (`clock_gettime`, `gettimeofday`, `rdtsc`) and timed waits (`nanosleep`, `futex`, `poll`, `epoll_wait`) advance a deterministic monotonic virtual clock rather than reading host wall-clock time. Configurable PRNG seeds and synthetic scheduling delays make race conditions and distributed-systems failures reproducible.
- **Cooperative Preemption & Multi-Processing**: A cooperative scheduler manages threads (`clone`) and processes (`fork`/`vfork`/`execve`/`wait4`) using `save_ctx` / `load_ctx` into a 464-byte context buffer without host threads.
- **Sandboxed Copy-on-Write VFS & `.tar.gz` Diff Export**: Guest file I/O operates against an in-memory CoW VFS overlay (regular files, directories, symlinks, pipes, `/dev/null`, deterministic `/dev/urandom`, plus optional host mounts in `js/cli.mjs`) with zero unintended host writes or outbound guest internet. Any layer's modified files can be exported as an OCI-compatible `.tar` / `.tar.gz` diff archive (with `.wh.<name>` whiteouts).
- **Local Browser & Remote Cloudflare Worker Parity**: The same Rust compiler (`elf2wasm-core`) and runtime (`elf2wasm-runtime-core`) run in the browser (compiling to native V8 WASM) and on Cloudflare Workers via `elf2wasm-worker-wasm` (using the `wasmi` interpreter with SIMD and fuel metering, requiring zero dynamic `WebAssembly.compile()`).

### Workspace & Repository Layout

```text
elf2wasm/
├── Cargo.toml                         # Virtual Rust workspace
├── crates/
│   ├── elf2wasm-core/                 # x86-64 ELF64 loader, decoder, lifter, WASM emitter
│   ├── elf2wasm-runtime-core/         # Deterministic Linux syscall/VFS/scheduler runtime + tar diff export
│   ├── elf2wasm-compiler-wasm/        # Browser/Node compiler cdylib (wasm32-unknown-unknown)
│   ├── elf2wasm-runtime-wasm/         # Browser/Node runtime cdylib (wasm32-unknown-unknown)
│   └── elf2wasm-worker-wasm/          # Cloudflare Worker wasmi interpreter cdylib (wasm32-unknown-unknown)
├── js/
│   ├── docker_sdk.mjs                 # Multi-layer local/remote pipeline & sweep SDK
│   ├── container_worker.mjs           # Persistent Dedicated Web Worker backend
│   ├── elf2wasm_shim.mjs              # Low-level WASM compiler/runtime & VFS shim
│   ├── oci_client.mjs                 # OCI Registry v2 client
│   ├── git_client.mjs                 # GitHub / forge archive client
│   └── cli.mjs                        # Interactive Node.js CLI for local ELF testing
├── web/                               # Zero-build vanilla ESM Web UI (Dockerfile/Layer builder, VT100 terminal)
├── server/                            # Zero-dependency local Node.js dev server (mirrors Worker /api/*)
├── worker/                            # Cloudflare Worker (static assets + OCI/Git proxy + POST /api/eval)
└── e2e_docker_web/                    # 4-tier automated E2E verification suite
```

---

## Quick Start (Local Dev Server & Web UI)

### Prerequisites

- **Rust toolchain & `cargo`** (edition 2021) with the `wasm32-unknown-unknown` target
- **Node.js v22+** (for the local dev server, JS SDK tests, `js/cli.mjs`, and Cloudflare Worker tooling)
- *(Optional)* `gcc` and Linux x86-64 shared libraries if compiling custom local ELF binaries for `js/cli.mjs`

### 1. Build the `.wasm` Modules

```bash
rustup target add wasm32-unknown-unknown
cargo build --release --target wasm32-unknown-unknown \
  -p elf2wasm-compiler-wasm \
  -p elf2wasm-runtime-wasm \
  -p elf2wasm-worker-wasm
```

Outputs in `target/wasm32-unknown-unknown/release/`:
- `elf2wasm_compiler_wasm.wasm`
- `elf2wasm_runtime_wasm.wasm`
- `elf2wasm_worker_wasm.wasm`

### 2. Start the Local Dev Server

```bash
node server/server.mjs --port 8080
```

Open `http://127.0.0.1:8080/` in your browser. The dev server serves the static Web UI, `/js/*`, `/wasm/*` with COOP/COEP headers, the `/api/v2/*` OCI registry proxy, `/api/git/archive`, and `POST /api/eval`.

---

## Web UI Features

- **System-Default Light & Dark Mode**: Automatically follows your OS `prefers-color-scheme` (light or dark) with a **System / Light / Dark** switcher in the header persisted to `localStorage` and `?theme=`. Both UI chrome and the built-in VT100 terminal ANSI palette adapt cleanly.
- **Dual-Mode Visual Layer Builder ↔ Dockerfile Text**:
  - Build container stacks visually with **+ FROM**, **+ Git Clone**, **+ WORKDIR**, **+ ENV**, **+ RUN**, and **+ SWEEP** cards, or switch to the **Dockerfile** tab to paste/edit a complete Dockerfile directly. Both views stay bidirectionally synchronized.
  - Supported Dockerfile directives: `FROM <image>`, `WORKDIR <path>`, `ENV KEY=VALUE`, `RUN <command>`, `RUN git clone [--branch <ref>] <repo> [<mount>]` (or `# elf2wasm:git repo=<r> ref=<ref> mount=<m>`), `# elf2wasm:sweep ...`, and `# elf2wasm:executor=remote|local`.
- **Configurable Sweep**: Insert a `SWEEP` layer anywhere in the stack to snapshot the VFS at that point and fan out **all downstream layers** across a user-selected variable:
  - **Delay Stddev (ms)** (`param=delay`)
  - **PRNG Seed** (`param=seed`)
  - **Environment Variable** (`param=env`, arbitrary `envKey`)
  - Configured either as a numeric **Range** (`start`, `step`, `count`) or a **Values List** (`values=a,b,c`).
  - Click any row in the Sweep Results table to inspect its downstream logs, download its `.tar.gz` outputs, or open a standalone deep link to that exact variation.
- **Local vs. Remote Execution & Build Output Downloads**:
  - Choose **Local** (in-browser WebAssembly) or **Remote** (Cloudflare Worker `POST /api/eval`) on each layer, or use the top-level **Run All Locally** / **Run All Remotely** controls.
  - Pure-remote pipelines skip local WASM download and compilation entirely, making them fast on phones and constrained devices.
  - Mixed local+remote pipelines automatically hand off `.tar.gz` VFS diffs between layers.
  - Completed layers display modified file counts and a **Download `.tar.gz`** button to save build outputs.
- **Interactive Shell & Manual Upload**: Pipelines without `RUN`/`SWEEP` layers boot an interactive VT100 shell in the browser. A collapsible **Manual Local Archive / ELF64 Upload** drawer supports dragging in `.tar.gz`, `.zip`, or raw ELF64 files.

### Well-Known Presets

| Preset ID | Name | Stack |
|---|---|---|
| `js-express` | **Express.js** | `mirror.gcr.io/library/mongo-express:1.0.2-20-alpine3.19` — starts a real Express.js HTTP server and queries `GET /api/hello` |
| `python-flask` | **Flask** | `quay.io/computesphere/computesphere-python-flask-example:latest` — runs a Python 3.13 Flask app and verifies `GET /api/hello` via `test_client()` |
| `go-raft-nodice` | **Go Raft (nodice)** | `ghcr.io/fatlotus/golang-with-cache:1.27-alpine` + `fatlotus/nodice` — clones from GitHub, compiles with `go build`, and runs `./raft` |
| `alpine-sweep` | **Alpine Env Sweep** | `mirror.gcr.io/library/alpine:latest` — 3-variation `ENV` sweep (`GREETING=hello,bonjour,hola`) executing in ~1s |

### URL Query-Parameter Deep-Linking

UI state syncs with the URL query string (`?query`) without auto-executing on page load:

| Parameter | Default (omitted) | Description |
|---|---|---|
| `dockerfile` | `FROM alpine:latest` | URL-encoded Dockerfile text (including `# elf2wasm:git`, `# elf2wasm:sweep`, `# elf2wasm:executor=remote`) |
| `executor` | `local` | Execution mode (`local`, `remote`, or `mixed`) |
| `theme` | `system` | Color theme override (`light` or `dark`; omitted when following system mode) |
| `preset` | *(none)* | Read-only shorthand (`js-express`, `python-flask`, `go-raft-nodice`, `alpine-sweep`) expanded on load |
| `selectedRun` | *(none)* | 1-based variation index to highlight in the Sweep Results table |
| Legacy params | *(none)* | `image`, `build`, `cmd`, `repo`, `ref`, `mount`, `cwd`, `env`, `stddev`, `seed`, `sweep`, `runs` remain supported for backward compatibility |

Example deep link:
```text
/?preset=python-flask&theme=light
```

---

## Cloudflare Worker & Remote Evaluation API (`POST /api/eval`)

The Cloudflare Worker (`worker/src/index.mjs`) serves the static Web UI (`worker/dist/`) and exposes:

- `GET /api/health` — Worker health & status check
- `GET /api/v2/*` — Edge-cached OCI Registry v2 streaming proxy
- `GET /api/git/archive` — Edge-cached GitHub/forge archive proxy
- `POST /api/eval` — Remote deterministic layer evaluation via `elf2wasm-worker-wasm` (`wasmi`)

### `POST /api/eval` Contract

**Request (`application/json`)**:
```json
{
  "baseImage": "mirror.gcr.io/library/alpine:latest",
  "gitRepo": { "repo": "owner/repo", "ref": "main", "mountPath": "/workspace" },
  "inputLayerDiffs": ["<base64 gzip-compressed tar>"],
  "cmd": ["sh", "-c", "echo hello > /workspace/out.txt && cat /workspace/out.txt"],
  "env": ["KEY=VALUE"],
  "cwd": "/workspace",
  "delayStddevMs": 0,
  "delaySeed": 0,
  "timeoutMs": 30000,
  "returnOutputDiff": true
}
```

**Default Response (`application/json`)**:
```json
{
  "ok": true,
  "executor": "remote-wasmi",
  "exitCode": 0,
  "stdout": "hello\n",
  "stderr": "",
  "virtualTimeNs": "123456",
  "timedOut": false,
  "error": null,
  "outputDiffTarGzBase64": "<base64 gzip-compressed tar>",
  "modifiedFiles": [{ "path": "/workspace/out.txt", "kind": "file", "size": 6 }]
}
```

**Direct `.tar.gz` Download**: Pass `Accept: application/gzip` or `?format=tar.gz` to receive `200 OK` with `Content-Type: application/gzip`, `Content-Disposition: attachment; filename="layer-output.tar.gz"`, `X-Eval-Exit-Code`, `X-Eval-Virtual-Time-Ns`, and the raw `.tar.gz` body.

**Structured Error Codes**: `INVALID_REQUEST` (`400`), `FUEL_EXHAUSTED` (`408`), `MEMORY_LIMIT` (`413` / `507`), `UPSTREAM_ERROR` (`502`).

Example `curl` request against the local dev server:
```bash
curl -sS -X POST http://127.0.0.1:8080/api/eval \
  -H 'Content-Type: application/json' \
  -d '{"baseImage":"mirror.gcr.io/library/alpine:latest","cmd":["sh","-c","echo hi > /tmp/out.txt && cat /tmp/out.txt"],"returnOutputDiff":true}'
```

### Building & Deploying the Cloudflare Worker

```bash
cd worker
npm ci
npm run build:assets   # copies web/, js/, and all 3 release .wasm files into worker/dist & worker/src
npm test               # runs Cloudflare Worker unit & /api/eval tests
npm run deploy:dry-run # verifies wrangler bundle without deploying
```

---

## JavaScript SDK & Interactive CLI

### Multi-Layer Container SDK (`js/docker_sdk.mjs`)

Exposed on `window` in the browser (`Elf2WasmDocker`, `runLayerPipeline`, `runDockerImage`, `runSweep`) and importable as ESM in Node.js or browsers:

- `await runLayerPipeline(layers, options)` — Executes an ordered `Layer[]` stack (`from`, `git`, `workdir`, `env`, `run`, `sweep`) with per-layer `local` vs `remote` execution, automatic `.tar.gz` VFS diff handoff, and sweep fan-out. Pure-remote pipelines skip local WASM initialization.
- `await docker.runLayerPipeline(layers, options)` — Runs on a persistent worker-backed `Elf2WasmDocker` instance to keep the compiled WASM module cache warm across runs.
- `await runDockerImage(imageRef, options)` — One-shot container execution returning `{ exitCode, stdout, stderr, virtualTimeNs }`.
- `await runSweep(imageRef, options)` — Runs an optional build step once, snapshots VFS, and sweeps delay/seed variations.

### Low-Level WASM Shim (`js/elf2wasm_shim.mjs`)

- `await Elf2WasmSystem.create({ compilerWasm, runtimeWasm, vfsRo = [], vfsRw = [] })`
- `sys.compile(elfBytes, soEntries = [], options = {})`
- `sys.writeVfsFile(guestPath, bytes, mode = 0o644)` / `sys.writeVfsSymlink(guestPath, target)` / `sys.readVfsFile(guestPath)` / `sys.readVfsLink(guestPath)` / `sys.resolveVfsPath(guestPath)`
- `sys.exportVfsDiffTar({ baseSnapshotId?, pathPrefix? })` — Returns an OCI-compatible USTAR/PAX `.tar` `Uint8Array` of modified/deleted files.
- `sys.listVfsDiff({ baseSnapshotId?, pathPrefix? })` — Returns `Array<{ path, kind, size }>`.
- `await sys.runElf(...)` / `await sys.runFromVfs(...)`
- Helpers: `compileElfToWasm`, `runElf`, `runFromVfs`, `extractTarToVfs`, `extractTarGzToVfs`, `extractZipToVfs`, `compileAndRunInVfs`.

### Interactive Node.js CLI (`js/cli.mjs`)

```bash
# Compile an x86-64 ELF binary to a guest .wasm module
node js/cli.mjs compile --elf ./hello \
  --so /lib/x86_64-linux-gnu/ld-linux-x86-64.so.2 \
  --so /lib/x86_64-linux-gnu/libc.so.6 \
  --out hello.wasm

# Compile and run directly via the WASM runtime
node js/cli.mjs run --elf ./hello \
  --so /lib/x86_64-linux-gnu/ld-linux-x86-64.so.2 \
  --so /lib/x86_64-linux-gnu/libc.so.6 \
  -- arg1 arg2
```

Optional flags: `--vfs-ro <host:guest>`, `--vfs-rw <host:guest>`, `--compiler <path>`, `--runtime <path>`.

---

## Testing

```bash
# Rust workspace unit tests
cargo test --workspace

# JS SDK, Dockerfile parser, URL state, and local dev server tests
node --test js/test_dockerfile.mjs js/test_url_state.mjs js/test_docker_sdk.mjs server/test_server.mjs

# Cloudflare Worker tests
npm --prefix worker test

# Automated 4-tier E2E suite (offline tiers)
node e2e_docker_web/run_v2_e2e.mjs --tier all --skip-live
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
| `runtime_export_vfs_tar` | Function | `(base_snap_id: i32, use_base: i32, prefix_ptr: i32, prefix_len: i32, out_len_ptr: i32) -> i32` | Exports current VFS (or diff against `base_snap_id` when `use_base != 0`) as an OCI-compatible USTAR/PAX `.tar` buffer with `.wh.<name>` whiteouts. Caller frees with `dealloc`. |
| `runtime_list_vfs_diff` | Function | `(base_snap_id: i32, use_base: i32, prefix_ptr: i32, prefix_len: i32, out_len_ptr: i32) -> i32` | Returns a UTF-8 JSON array of `{ path, kind, size }` entries describing VFS changes since `base_snap_id`. Caller frees with `dealloc`. |
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

---

### Module 3: Translated Guest Executable (`.wasm`)

#### Imports

None (zero imports — no `env.syscall`).

#### Exported `"memory"` & Virtual Address Map

The guest exports a single fixed-size linear `"memory"` (`minimum = maximum = max(4096, ceil((DISPATCH_HASH_ADDR + table_slots * 8) / 65536))` pages, i.e. 256 MiB+ in standard browser layout, or compact 32 MiB layout in `elf2wasm-worker-wasm`).

| Constant | Standard Address | Purpose |
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

#### Exported Functions & Globals

- Functions: `_start() -> i32`, `save_ctx(ctx_ptr: i32)`, `load_ctx(ctx_ptr: i32)` (464-byte `CTX_SIZE` buffer: `rax..r15`, `rip`, `fsbase`, `gsbase`, `tsc`, `cf..df`, `mxcsr`, `x87_cw`, `xmm0..xmm15`).
- Globals (all mutable): `rax..r15` (`i64`), `rip` (`i64`), `fsbase` (`i64`), `gsbase` (`i64`), `exit_flag` (`i32`), `exit_code` (`i32`), `yield_flag` (`i32`), `quantum` (`i32`, default `128`).

---

### Module 4: `elf2wasm-worker-wasm` (`elf2wasm_worker_wasm.wasm`)

Self-contained zero-import `wasm32-unknown-unknown` module statically bundled into the Cloudflare Worker (`worker/src/elf2wasm_worker_wasm.wasm`). It embeds `elf2wasm-core` (with compact Worker-friendly memory layout), `elf2wasm-runtime-core`, and the `wasmi` interpreter (with SIMD and fuel metering) so `POST /api/eval` can lift and execute x86-64 ELF64 binaries inside Cloudflare Workers without dynamic `WebAssembly.compile()`, exporting modified files as an OCI `.tar` diff archive.
