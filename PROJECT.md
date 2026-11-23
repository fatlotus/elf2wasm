# Project: elf2wasm — Client-Side Docker-on-WASM Web Platform

## Architecture
`elf2wasm` translates unmodified Linux x86-64 ELF64 binaries (and their required `.so` shared libraries) into self-contained, zero-import WebAssembly (`.wasm`) CPS modules and runs them in a sandboxed virtual Linux runtime — both compiled to `wasm32-unknown-unknown` so **100% of Docker layer decompression, rootfs unpacking, ELF-to-WASM compilation, and container execution occur on the client side in the browser**.

### System Data Flow
```
Browser (Main Thread — web/index.html + web/terminal.mjs)
  │  User enters Docker image (default: alpine:latest) or calls JS SDK (window.Elf2WasmDocker)
  ▼
Browser Web Worker (js/container_worker.mjs + js/docker_sdk.mjs + js/oci_client.mjs + js/elf2wasm_shim.mjs)
  ├── 1. Fetch OCI manifest / multi-arch index (select linux/amd64) & raw .tar.gz layer blobs
  │      via thin streaming HTTP proxy (/api/v2/...)
  ├── 2. Decompress (.tar.gz via DecompressionStream) & extract layers client-side
  │      (empty dirs, symlinks, hardlinks, OCI .wh.* / .wh..wh..opq whiteouts)
  ├── 3. Resolve Entrypoint/Cmd/Env/WorkingDir & PT_INTERP/DT_NEEDED (musl + glibc)
  ├── 4. Compile ELF64 -> WASM client-side via elf2wasm_compiler_wasm.wasm (cached per binary)
  └── 5. Execute guest .wasm client-side via elf2wasm_runtime_wasm.wasm (CPS async loop:
         NeedStdin=5 yield, live stdout/stderr streaming, TTY ioctl, /dev/*, /proc/*, fork/execve)
  ▲
  │  HTTP only (static assets + raw OCI manifests/blobs; ZERO compilation/execution on server)
  ▼
Node.js Web Server & Thin Streaming OCI Registry Proxy (server/server.mjs + server/registry_proxy.mjs)
  ├── Static serving: / -> web/index.html, /web/*, /js/*, /wasm/*.wasm (COOP/COEP headers)
  └── Stateless OCI v2 proxy: Bearer token auth + manifest/blob streaming + SSRF protection
```

## Code Layout
```
/home/antigravity/fatlotus/elf2wasm/
├── Cargo.toml                         # Rust workspace root (5 crates)
├── PROJECT.md                         # Living architecture, milestones, contracts
├── TEST_INFRA.md                      # E2E testing track specification
├── TEST_READY.md                      # E2E test suite completion signal
├── crates/
│   ├── elf2wasm-core/                 # Pure x86-64 ELF64 -> WASM compiler library
│   │   └── src/{lib,elf_loader,meta,decoder,lifter,wasm_emit}.rs
│   ├── elf2wasm-compiler-wasm/        # wasm32-unknown-unknown cdylib compiler (zero imports)
│   │   └── src/lib.rs
│   ├── elf2wasm-runtime-core/         # Pure Linux x86-64 syscall/VFS/TTY/scheduler library
│   │   └── src/{lib,context,vfs,scheduler,syscalls,stack}.rs
│   └── elf2wasm-runtime-wasm/         # wasm32-unknown-unknown cdylib runtime
│       └── src/lib.rs
├── src/
│   ├── main.rs                        # Native CLI (translate, run)
│   └── runtime.rs                     # Native wasmtime 27 host
├── server/                            # Node.js 22 ESM web server & thin OCI registry proxy
│   ├── server.mjs                     # HTTP server (static assets + /wasm/* + /api/v2/* proxy)
│   ├── registry_proxy.mjs             # OCI v2 Bearer auth, manifest/blob streaming, SSRF guard
│   ├── mock_registry.mjs              # Local mock OCI v2 registry for deterministic testing
│   └── test_server.mjs                # Unit/integration tests for server & proxy
├── js/                                # Browser & Node ESM client-side SDK and shim
│   ├── elf2wasm_shim.mjs              # Core WASM compiler/runtime shim, VFS tar/OCI extraction, async CPS loop
│   ├── oci_client.mjs                 # Image ref parser, multi-arch linux/amd64 index/manifest/blob client
│   ├── docker_sdk.mjs                 # Public JS API: Elf2WasmDocker, runDockerImage, pullImage, createContainer
│   ├── container_worker.mjs           # Dedicated Web Worker host for non-blocking client-side compilation & execution
│   ├── cli.mjs                        # Node CLI wrapper
│   └── test_docker_sdk.mjs            # Unit/integration tests for OCI client & Docker SDK
├── web/                               # Self-hosted HTML home page & interactive web terminal (zero CDN deps)
│   ├── index.html                     # Home page (default alpine:latest interactive shell + JS SDK exposure)
│   ├── app.mjs                        # UI controller connecting terminal, image selector, progress, and SDK
│   ├── terminal.mjs                   # Self-contained ANSI/VT100 interactive terminal widget
│   └── styles.css                     # Clean responsive styling
├── e2e_docker_web/                    # New opaque-box E2E test suite (Tiers 1-4 + Tier 5)
├── e2e_v2/                            # Prior Phase 2 regression tests
└── tests/                             # Rust integration & adversarial tests
```

## Feature Inventory
Every Survey feature from Explorers 1, 2, and 3 is assigned a milestone below (zero unassigned):

| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| F1 | WASM Toolchain Build & Alpine/musl Loader Fix | Install `wasm32-unknown-unknown` target; build `elf2wasm_{compiler,runtime}_wasm.wasm`; fix `elf_loader.rs` `is_interp` matching so musl symlinks (`ld-musl-x86_64.so.1` <-> `libc.musl-x86_64.so.1`) resolve cleanly; verify real Alpine BusyBox `/bin/sh` compiles and executes without missing x86-64 instructions. | M1 | Survey 1 (F1), Survey 2 |
| F2 | Interactive Stdin (`NeedStdin`), Live Stdout/Stderr Streaming & VFS Dir/Remove Exports | Add `ThreadState::StdinReadWait` / `PendingWakeup::StdinRead`, `runtime_on_yield` return code `5 = NeedStdin`, and `runtime-wasm` exports: `runtime_push_stdin`, `runtime_close_stdin`, `runtime_drain_stdout`, `runtime_drain_stderr`, `runtime_set_winsize`, `runtime_send_sigint`, `runtime_set_uid_gid`, `runtime_take_reaped_pids`, `runtime_add_vfs_dir`, `runtime_remove_vfs_path`. Fix `eval_fd_events` so `poll`/`select` on fd 0 only reports `POLLIN` when buffered data or EOF is present. | M1 | Survey 1 (F2), Survey 2 (RT1), Survey 3 (W1) |
| F3 | Minimal TTY/PTY `ioctl` & Ctrl-C (`SIGINT`/`kill`) | Implement `SYS_IOCTL` (`TCGETS`, `TCSETS`/`TCSETSW`/`TCSETSF`, `TIOCGWINSZ`/`TIOCSWINSZ`, `TIOCGPGRP`/`TIOCSPGRP`, `FIONREAD`) on TTY fds so `isatty(0)` succeeds and BusyBox `ash`/shells enter interactive mode; implement `SYS_KILL` (62) and `SIGINT` interruption of foreground process group (`-EINTR` on blocked reads or child termination). | M1 | Survey 1 (F2), Survey 2 (RT2), Survey 3 (W1) |
| F4 | Virtual `/dev/*` & `/proc/*` Devices | Implement `/dev/null`, `/dev/zero`, `/dev/urandom`, `/dev/random`, `/dev/tty`, `/dev/stdin`, `/dev/stdout`, `/dev/stderr`, `/dev/fd/<N>`, and `/proc/self/{fd/*,cmdline,stat,status}`, `/proc/{uptime,meminfo,cpuinfo,version}` in `vfs.rs`. | M1 | Survey 2 (RT3) |
| F5 | `execve` `#!` Shebang + `-ENOEXEC`, BusyBox/Docker Syscalls, Container UID `0`, & `access(X_OK)` | Parse `#!interp [arg]` in `do_execve` before closing `O_CLOEXEC` FDs or waking vfork parent; return `-ENOEXEC` cleanly on non-ELF files; add `readv`, `umask`, `link`/`linkat`, `chown`/`fchown`/`lchown`/`fchownat`, `madvise`, `fsync`/`fdatasync`, `setsid`/`getsid`, `statfs`/`fstatfs`, `times`, `getrusage`, `setuid`/`setgid`/`getgroups`/`setgroups`, `epoll_create1`/`epoll_ctl`/`epoll_wait`/`epoll_pwait`, `eventfd2`, `AF_UNIX` `socketpair` (clean `-EAFNOSUPPORT` for `AF_INET`/`AF_INET6`); configurable UID/GID (default `0:0` for Docker containers); check `0o111` execute bits in `access(X_OK)`. | M1 | Survey 1 (F1), Survey 2 (RT4) |
| F6 | Browser Memory Hygiene (`munmap` Free-List & Reaped Child PID Tracking) | Replace bump-only `mmap_cursor` in `syscalls.rs` with a page-aligned free-list allocator reclaiming `munmap` regions in `0x0800_0000..0x0AFF_F000`; track exited/reaped non-main child PIDs in `HostState` and expose via `runtime_take_reaped_pids`. | M1 | Survey 2 (RT5) |
| F7 | Static Web Server & WASM Asset Serving | Zero-dependency Node.js 22 ESM HTTP server (`server/server.mjs`) serving `/` -> `web/index.html`, `/web/*`, `/js/*`, `/wasm/*.wasm` (`Content-Type: application/wasm`), with `COOP`/`COEP` headers and `--port`/`--host`/`--allow-local-registries` flags. | M2 | Survey 1 (F4), Survey 3 (W3) |
| F8 | Thin Streaming OCI v2 Registry Proxy | Stateless HTTP proxy (`server/registry_proxy.mjs`) handling OCI v2 Bearer token negotiation, manifest & blob streaming with cross-origin redirect `Authorization` stripping, `Content-Length` / `Content-Type` / `Docker-Content-Digest` preservation, input validation, and SSRF protection (zero unpacking/compilation/execution on server). | M2 | Survey 1 (F4), Survey 3 (W3) |
| F9 | Local Mock OCI v2 Registry | `server/mock_registry.mjs` serving valid OCI v2 Image Index + Manifest + Config + `.tar.gz` layer blobs from local fixtures for deterministic offline E2E testing. | M2 | Survey 3 (W3, W6) |
| F10 | Shim OCI VFS Extraction, Dynamic Linker Resolution, Async CPS Loop & Child Leak Fix | Upgrade `js/elf2wasm_shim.mjs`: preserve empty dirs (`typeFlag === "5"`), apply OCI whiteouts (`.wh.<name>`, `.wh..wh..opq`), preserve requested `PT_INTERP` alongside canonical path, support `DT_RPATH`/`DT_RUNPATH` + `/etc/ld-musl-x86_64.path` + `/etc/ld.so.conf*`, delete reaped child PIDs from `processes` Map (fixing 256 MiB/child leak), add async interactive CPS runner with `NeedStdin` (`5`), incremental stdout/stderr callbacks, periodic macrotask yield, `PATH` resolution, and clean `-ENOEXEC` handling. | M3 | Survey 1 (F1, F3), Survey 2 (RT1, RT5, RT6), Survey 3 (W2) |
| F11 | Client-Side OCI Image Loader, Web Worker & JavaScript Docker-on-WASM SDK | Implement `js/oci_client.mjs`, `js/container_worker.mjs`, and `js/docker_sdk.mjs`: parse Docker image refs, resolve multi-arch `linux/amd64` manifests, parse OCI config (`Entrypoint`/`Cmd`/`Env`/`WorkingDir`/`User`), stream/decompress layers client-side with progress callbacks (plus offline `loadOciTarball`), run compilation & execution in a dedicated Web Worker (with Node.js direct fallback), and expose ergonomic `Elf2WasmDocker` / `runDockerImage` JS API. | M3 | Survey 1 (F3), Survey 2 (RT1), Survey 3 (W4) |
| F12 | Interactive Web Shell Home Page (Default Alpine Linux) & VT100 Terminal UI | Build self-hosted (zero CDN) `web/index.html`, `web/app.mjs`, `web/terminal.mjs`, `web/styles.css`: image input defaulting to `alpine:latest` with presets, optional cmd/env/workdir overrides, live client-side fetch/unpack/compile/run progress indicator, interactive ANSI/VT100 terminal (Ctrl+C, Ctrl+D, Ctrl+L, backspace, resize, paste, scrolling), `window.Elf2WasmDocker` & `window.runDockerImage` global hooks, and optional manual file-upload drawer. | M4 | Survey 1 (F5), Survey 3 (W5) |

## Milestones

| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Rust Core & WASM Runtime for Alpine/Docker Interactive Shell | `crates/elf2wasm-core`, `crates/elf2wasm-runtime-core`, `crates/elf2wasm-runtime-wasm`, `src/runtime.rs`; build `.wasm` artifacts; features F1–F6; verify Alpine BusyBox `/bin/sh` | none | DONE (`sub_orch_m1` gate passed; 52/52 lib tests, 24/24 adv tests, `.wasm` built, Alpine BusyBox verified, Auditor CLEAN) |
| M2 | Web Server & Thin Streaming OCI Registry Proxy | `server/server.mjs`, `server/registry_proxy.mjs`, `server/mock_registry.mjs`, `server/test_server.mjs`; features F7–F9 | none | DONE (`sub_orch_m2` gate passed; 25/25 tests, Auditor CLEAN) |
| M3 | Client-Side OCI Loader, Shim Upgrades, Web Worker & JS Docker SDK | `js/elf2wasm_shim.mjs`, `js/oci_client.mjs`, `js/docker_sdk.mjs`, `js/container_worker.mjs`, `js/test_docker_sdk.mjs`; features F10–F11 | M1, M2 | DONE (`sub_orch_m3` gate passed; 16/16 SDK tests, Chrome Web Worker verified, Auditor CLEAN) |
| M4 | Interactive Web Shell Home Page & VT100 Terminal UI | `web/index.html`, `web/app.mjs`, `web/terminal.mjs`, `web/styles.css`; feature F12 | M2, M3 | DONE (`sub_orch_m4` gate passed; 30/30 Chrome probes, T4.1–T4.4 pass, Auditor CLEAN) |
| M5 | Final Milestone (E2E Pass Tiers 1–4 + Tier 5 Adversarial Hardening) | Pass 100% of `TEST_READY.md` E2E suite (Tiers 1–4) + Tier 5 adversarial hardening across all modules | M1, M2, M3, M4, TEST_READY.md | DONE (Phase 1 Tiers 1–4: 47/47 PASS; Phase 2 Tier 5: 10/10 PASS, 158/158 total tests, both Fresh Challengers `NO_GAPS`, Whole-Project Auditor `CLEAN`) |

## Interface Contracts

### 1. `elf2wasm-runtime-wasm` Extended C-ABI (`M1` ↔ `M3`)
All existing exports remain backward-compatible. New exports added in M1:
- `runtime_on_yield() -> i32`:
  - `0` = Done (exited)
  - `1` = Continue (same PID)
  - `2` = Switch PID (call `runtime_get_active_pid`)
  - `3` = NeedFork
  - `4` = NeedExec
  - `5` = **NeedStdin** (guest is blocked reading stdin; host should await input, call `runtime_push_stdin` or `runtime_close_stdin`, then call `runtime_resume_active`)
- `runtime_push_stdin(ptr: *const u8, len: usize) -> i32`: Appends bytes to stdin queue and wakes any thread in `StdinReadWait`.
- `runtime_close_stdin()`: Marks stdin EOF and wakes any thread in `StdinReadWait` (returning 0 bytes).
- `runtime_drain_stdout(out_len_ptr: *mut usize) -> *mut u8`: Returns newly written stdout bytes since last drain (caller frees with `dealloc` if len > 0); existing `runtime_get_stdout` continues to return full accumulated stdout for backward compatibility.
- `runtime_drain_stderr(out_len_ptr: *mut usize) -> *mut u8`: Returns newly written stderr bytes since last drain.
- `runtime_take_reaped_pids(out_len_ptr: *mut usize) -> *mut u8`: Returns packed little-endian `u32` array of exited/reaped non-main child PIDs since last call so JS can free their 256 MiB WASM instances.
- `runtime_set_winsize(rows: u32, cols: u32)`: Updates TTY window size returned by `TIOCGWINSZ`.
- `runtime_set_tty_mode(enabled: i32)`: Enables/disables TTY behavior on fds 0/1/2 (`1` = TTY enabled, `0` = non-TTY pipe/batch).
- `runtime_send_sigint()`: Delivers `SIGINT` to foreground process group (interrupts blocked reads/sleeps with `-EINTR` or terminates default-action foreground child processes).
- `runtime_set_uid_gid(uid: u32, gid: u32)`: Configures guest UID/EUID/GID/EGID (default `0`/`0` for containers or `1000`/`1000` if unset — M1 should keep existing unit tests passing while allowing M3 to set `0, 0` for Docker containers).
- `runtime_add_vfs_dir(path_ptr: *const u8, path_len: usize, mode: u32) -> i32`: Explicitly creates directory (and parents) in VFS overlay.
- `runtime_remove_vfs_path(path_ptr: *const u8, path_len: usize) -> i32`: Recursively removes a file/symlink/directory (for OCI `.wh.<name>` and `.wh..wh..opq` whiteouts).

### 2. Web Server & Thin Streaming OCI Registry Proxy (`M2` ↔ `M3` / `M4` / `E2E`)
- **Static routes** (all responses include `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`):
  - `GET /` → `web/index.html` (`text/html; charset=utf-8`)
  - `GET /web/*` → static files under `web/`
  - `GET /js/*` → static files under `js/` (`application/javascript; charset=utf-8`)
  - `GET /wasm/<name>.wasm` → `target/wasm32-unknown-unknown/release/<name>.wasm` (`application/wasm`)
  - `GET /api/health` → `200 OK` JSON `{ "ok": true, "mode": "client-side-wasm" }`
- **Thin Streaming OCI v2 Proxy routes** (stateless pass-through; ZERO unpacking, compilation, or execution):
  - `GET /api/v2/<registry>/<repo...>/manifests/<reference>`
    - Streams raw OCI/Docker manifest or Image Index JSON with original `Content-Type` and `Docker-Content-Digest`.
    - Handles `401 Unauthorized` + `WWW-Authenticate: Bearer ...` automatically.
  - `GET /api/v2/<registry>/<repo...>/blobs/<digest>`
    - Validates `digest` matches `^sha256:[0-9a-f]{64}$`.
    - Follows `301/302/307/308` redirects stripping `Authorization` header on cross-origin redirect.
    - Streams raw blob bytes preserving `Content-Length` and `Content-Type`.
  - **SSRF Guard**: Rejects loopback/private/link-local registry hosts with `403 Forbidden` unless server started with `--allow-local-registries` (or `ALLOW_LOCAL_REGISTRIES=1`).
  - **Error semantics**: Invalid ref/digest → `400`, blocked host → `403`, upstream 404 → `404`, upstream error → `502` with JSON `{ "error": "..." }`.

### 3. JavaScript Docker-on-WASM SDK (`M3` ↔ `M4` / `E2E`)
Exported from `/js/docker_sdk.mjs`:
- `parseImageRef(ref)` → `{ registry, repository, reference, canonical }` (e.g. `"alpine"` → `{ registry: "registry-1.docker.io", repository: "library/alpine", reference: "latest", canonical: "registry-1.docker.io/library/alpine:latest" }`)
- `Elf2WasmDocker.create(options?)` → `Promise<Elf2WasmDocker>`
  - `options`: `{ compilerWasmUrl = "/wasm/elf2wasm_compiler_wasm.wasm", runtimeWasmUrl = "/wasm/elf2wasm_runtime_wasm.wasm", registryProxyBase = "/api/v2", useWorker = (typeof Worker !== "undefined") }`
- `docker.pullImage(imageRef, options?)` → `Promise<DockerImage>`
  - `options`: `{ platform = "linux/amd64", onProgress?: ({ stage, message, layerIndex, layerCount, loaded, total }) => void, signal?: AbortSignal }`
  - `image.ref`, `image.digest`, `image.config` (`{ entrypoint, cmd, env, workingDir, user }`), `image.layers`
- `docker.loadOciTarball(tarBytes, options?)` → `Promise<DockerImage>` (offline OCI/rootfs tarball support)
- `image.createContainer(options?)` → `Promise<DockerContainer>`
  - `options`: `{ cmd?: string[], entrypoint?: string[], env?: string[], cwd?: string, tty?: boolean, cols?: number, rows?: number, onProgress?: (ev) => void }`
- `DockerContainer` methods:
  - `onStdout(cb: (chunk: Uint8Array) => void)`
  - `onStderr(cb: (chunk: Uint8Array) => void)`
  - `onExit(cb: (exitCode: number) => void)`
  - `start() -> Promise<void>`
  - `writeStdin(data: string | Uint8Array)`
  - `closeStdin()`
  - `resize(cols: number, rows: number)`
  - `sendSignal(sig: "SIGINT")`
  - `wait() -> Promise<{ exitCode: number, stdout: string, stderr: string }>`
  - `readFile(path: string) -> Promise<Uint8Array | null>`
  - `writeFile(path: string, data: Uint8Array | string) -> Promise<void>`
  - `stop() -> Promise<void>`
- `runDockerImage(imageRef, options?)` → `Promise<{ exitCode: number, stdout: string, stderr: string }>` (high-level one-shot helper)

### 4. Web UI DOM & Global Hooks (`M4` ↔ `E2E`)
- `window.Elf2WasmDocker` and `window.runDockerImage` exposed on `window`.
- Key stable DOM `id` attributes in `web/index.html`:
  - `#image-input` (input defaulting to `alpine:latest`)
  - `#cmd-input` (optional command override input)
  - `#start-btn` (button to start interactive shell)
  - `#stop-btn` (button to stop/reset container)
  - `#clear-btn` (button to clear terminal)
  - `#status-text` / `#progress-bar` (live client-side stage & progress display)
  - `#terminal` (interactive VT100 terminal container with accessible output text and keyboard focus)
