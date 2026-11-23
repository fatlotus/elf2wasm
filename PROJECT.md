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
│   ├── proxy_core.mjs                 # Pure ESM shared OCI proxy validation, SSRF, auth & cache core
│   ├── server.mjs                     # HTTP server (static assets + /wasm/* + /api/v2/* proxy)
│   ├── registry_proxy.mjs             # Node OCI v2 proxy (uses proxy_core.mjs + dns.lookup pinning)
│   ├── mock_registry.mjs              # Local mock OCI v2 registry for deterministic testing
│   └── test_server.mjs                # Unit/integration tests for server & proxy
├── worker/                            # Cloudflare Workers full-app deployment (OCI proxy + Static Assets)
│   ├── wrangler.jsonc                 # Wrangler config (name: elf2wasm, workers_dev: true, assets: ./dist)
│   ├── package.json                   # Isolated manifest pinning wrangler + scripts
│   ├── package-lock.json              # Reproducible lockfile for CI
│   ├── scripts/build_assets.mjs       # Stages web/, js/, /wasm/*.wasm + _headers into worker/dist/
│   ├── src/index.mjs                  # Web-standard Cloudflare Worker fetch() handler (/api/health, /api/v2/*)
│   └── test/worker.test.mjs           # Automated Worker unit/integration tests
├── .github/workflows/
│   └── deploy-worker.yml              # GitHub Actions: Rust/WASM build + tests + cloudflare/wrangler-action@v4
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
| F13 | Cloudflare Workers Full-App Deployment (OCI Proxy + Static Assets + WASM) | Extract pure ESM `server/proxy_core.mjs` shared by Node (`server/registry_proxy.mjs`) and Cloudflare Workers (`worker/src/index.mjs`); implement streaming Web-standard `fetch()` proxy (`/api/health`, `/api/v2/*`), SSRF checks, Bearer token exchange/cache, cross-origin redirect `Authorization` stripping, same-origin / configurable `ALLOWED_ORIGINS` CORS, COOP/COEP/CORP/nosniff headers, `worker/scripts/build_assets.mjs` staging `web/`, `js/`, and `/wasm/*.wasm` + `_headers` into `worker/dist/` for Workers Static Assets (`name: elf2wasm`), optional runtime `registryProxyBase` override in `web/app.mjs`, and automated Worker tests. | M6 | Survey 1, Survey 2, Survey 3, User Update |
| F14 | GitHub Actions Rust/WASM Build & Auto-Deploy Pipeline | Add `.github/workflows/deploy-worker.yml` building `wasm32-unknown-unknown` release WASM binaries, staging static assets, running Node & Worker tests + `wrangler deploy --dry-run` on PRs, and auto-deploying via `cloudflare/wrangler-action@v4` (`CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`) on `push` to `main` (and `workflow_dispatch`), with concurrency guard and `.gitignore` updates. | M6 | Survey 2, Survey 3, User Update |
| F15 | WASM Toolchain Build (`wasm32-unknown-unknown`) | Install `wasm32-unknown-unknown` Rust target and build release `elf2wasm_compiler_wasm.wasm` and `elf2wasm_runtime_wasm.wasm` artifacts. | M7 | Survey 1 (1.1–1.2), Survey 2 (1.2), Survey 3 (3) |
| F16 | Dynamic Guest VA Layout & Expanded Guest Memory (>256 MiB) | Add `brk_start`, `mmap_start`, `mmap_end`, `stack_top`, `dispatch_hash_addr` to `WasmMeta` (`meta.rs`); compute dynamic VA layout in `elf_loader.rs` and `wasm_emit.rs` so >108 MiB `ET_EXEC`/`ET_DYN` binaries (`node:22-slim`) load without `BRK_START` overflow while preserving 256 MiB footprint for small binaries; consume `WasmMeta` layout fields in `syscalls.rs`, `stack.rs`, `scheduler.rs`. | M7 | Survey 1 (1.4), Survey 3 (1.5, 4.2 Phase 1) |
| F17 | Compiler Peak Memory & `.wasm` Size Scaling for Large Binaries (`node`) | Optimize `decoder.rs` and `wasm_emit.rs` (compact block representation + on-the-fly chunk decoding/emission, avoid redundant allocations) so `elf2wasm_compiler_wasm.wasm` (wasm32) compiles `node:22-slim`'s 38.5 MiB `.text` without OOM and V8 `WebAssembly.compile` succeeds. | M7 | Survey 3 (1.7, 4.2 Phase 3) |
| F18 | 64 KiB `.so` VA Alignment & Quantum/VFS Performance | Change `.so` VA span alignment in `elf_loader.rs` from 1 MiB to 64 KiB so dozens of Python `lib-dynload/*.so` extensions fit easily; raise `DEFAULT_QUANTUM` (`lifter.rs` + `wasm_emit.rs` test); optimize `vfs.rs` `is_virtual_parent_dir` and `build_dir_entries` with `BTreeMap::range`. | M7 | Survey 2 (1.6, 4.2, 4.3) |
| F19 | Canonical TTY Echo & Line Editing (`ICANON | ECHO`) | Implement canonical TTY input echo (`\r` → `\r\n` with `ICRNL`, `\x7f`/`\x08` → `\x08 \x08`) and line buffering in `vfs.rs`/`syscalls.rs` when `tty.enabled` and `ECHO`/`ICANON` are set, preserving raw mode passthrough for shells like `ash`. | M7 | Survey 2 (1.3, 4.4) |
| F20 | Node.js / V8 / libuv Runtime Syscalls & Instruction Coverage | Lower `RLIMIT_STACK` (`syscalls.rs`) from 8 MiB to 2 MiB; stub `SYS_CAPGET` (125); return `-EPERM` in `SYS_EPOLL_CTL` on regular files; fix missing x86-64/SSE2 saturating instructions and runtime syscall/PID-TID allocation edge cases encountered when executing real `node:22-slim` (`--jitless`) and `python:3.12-slim` binaries. | M7 | Survey 3 (1.6, 4.2 Phase 2) |
| F21 | Non-Blocking Time-Based Macrotask Yielding & `NeedStdin` Race Fix | Replace `setTimeout(0)` with `MessageChannel` (with fallback) in `js/elf2wasm_shim.mjs`; remove unconditional `steps % yieldEvery === 0` macrotask yield in favor of 16 ms wall-clock yielding (eliminating 81.2s Chrome startup hang on `python:3.12-slim`); fix `NeedStdin` lost-wakeup race via `_inputSignaled`. | M8 | Survey 2 (1.4, 1.6, 4.1) |
| F22 | Python `lib-dynload/*.so` Core Stdlib Auto-Bundling | Update `_resolveElfSos()` in `js/elf2wasm_shim.mjs` to auto-discover and bundle core Python `lib-dynload/*.so` C extensions (and their transitive `DT_NEEDED` libraries) for `python3*` executables so `math`, `random`, `datetime`, `pathlib`, `zlib`, `base64`, `struct`, `csv`, `hashlib`, `urllib.parse`, `subprocess`, `tempfile`, `readline`, etc. import cleanly. | M8 | Survey 1 (1.5), Survey 2 (1.5, 4.3) |
| F23 | Node.js Default `--jitless` Env Injection & Browser VFS Memory Hygiene | In `js/docker_sdk.mjs`, inject overridable defaults (`NODE_OPTIONS=--jitless --v8-pool-size=1 --no-experimental-strip-types`, `MALLOC_ARENA_MAX=1`, `UV_USE_IO_URING=0`, `UV_THREADPOOL_SIZE=1`) for Node.js images/executables; release raw `tarBytes` after VFS extraction in `js/elf2wasm_shim.mjs` to minimize browser RAM usage on 232 MB images. | M8 | Survey 3 (1.6, 4.2 Phase 2–3) |
| F24 | Web UI Presets for `python:3.12-slim` and `node:22-slim` | Add `<button type="button" class="preset-chip" data-image="python:3.12-slim">python:3.12-slim</button>` and `<button type="button" class="preset-chip" data-image="node:22-slim">node:22-slim</button>` to `.presets-row` in `web/index.html` (and wire `web/app.mjs` if needed); verify both presets end-to-end in Node SDK and headless Chrome Web UI. | M8 | Survey 1 (1.3), Survey 2 (4.5), Survey 3 (4.1–4.2) |

## Milestones

| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Rust Core & WASM Runtime for Alpine/Docker Interactive Shell | `crates/elf2wasm-core`, `crates/elf2wasm-runtime-core`, `crates/elf2wasm-runtime-wasm`, `src/runtime.rs`; build `.wasm` artifacts; features F1–F6; verify Alpine BusyBox `/bin/sh` | none | DONE (`sub_orch_m1` gate passed; 52/52 lib tests, 24/24 adv tests, `.wasm` built, Alpine BusyBox verified, Auditor CLEAN) |
| M2 | Web Server & Thin Streaming OCI Registry Proxy | `server/server.mjs`, `server/registry_proxy.mjs`, `server/mock_registry.mjs`, `server/test_server.mjs`; features F7–F9 | none | DONE (`sub_orch_m2` gate passed; 25/25 tests, Auditor CLEAN) |
| M3 | Client-Side OCI Loader, Shim Upgrades, Web Worker & JS Docker SDK | `js/elf2wasm_shim.mjs`, `js/oci_client.mjs`, `js/docker_sdk.mjs`, `js/container_worker.mjs`, `js/test_docker_sdk.mjs`; features F10–F11 | M1, M2 | DONE (`sub_orch_m3` gate passed; 16/16 SDK tests, Chrome Web Worker verified, Auditor CLEAN) |
| M4 | Interactive Web Shell Home Page & VT100 Terminal UI | `web/index.html`, `web/app.mjs`, `web/terminal.mjs`, `web/styles.css`; feature F12 | M2, M3 | DONE (`sub_orch_m4` gate passed; 30/30 Chrome probes, T4.1–T4.4 pass, Auditor CLEAN) |
| M5 | Final Milestone (E2E Pass Tiers 1–4 + Tier 5 Adversarial Hardening) | Pass 100% of `TEST_READY.md` E2E suite (Tiers 1–4) + Tier 5 adversarial hardening across all modules | M1, M2, M3, M4, TEST_READY.md | DONE (Phase 1 Tiers 1–4: 47/47 PASS; Phase 2 Tier 5: 10/10 PASS, 158/158 total tests, both Fresh Challengers `NO_GAPS`, Whole-Project Auditor `CLEAN`) |
| M6 | Cloudflare Workers Full-App (Proxy + Static Assets + WASM) & GitHub Auto-Deploy | `server/proxy_core.mjs`, `server/registry_proxy.mjs`, `worker/**`, `.github/workflows/deploy-worker.yml`, `.gitignore`, `web/app.mjs`; features F13–F14 | M1, M2, M4 | DONE (Iteration 2 gate passed: 26/26 server tests, 25/25 worker tests, WASM 0.81+0.52 MiB staged, `wrangler deploy --dry-run` PASS, 2/2 Reviewers APPROVE, 2/2 Challengers APPROVE, Auditor CLEAN) |
| M7 | Rust Core, Compiler & Runtime Upgrades for `python:3.12-slim` and `node:22-slim` | `crates/elf2wasm-core`, `crates/elf2wasm-compiler-wasm`, `crates/elf2wasm-runtime-core`, `crates/elf2wasm-runtime-wasm`, `src/runtime.rs`; features F15–F20; verify native & wasm32 compilation + execution of both `python:3.12-slim` and `node:22-slim` | none | DONE (`sub_orch_m6` Iter 2 gate passed 5/5 unanimous; 65/65 Rust unit tests, wasm32 release builds, live `python:3.12-slim` & `node:22-slim` verified native + wasm32 + V8 compile, Auditor CLEAN) |
| M8 | JS Shim, Docker SDK & Web UI Presets for `python:3.12-slim` and `node:22-slim` | `js/elf2wasm_shim.mjs`, `js/docker_sdk.mjs`, `js/test_docker_sdk.mjs`, `web/index.html`, `web/app.mjs`; features F21–F24; verify Node SDK + Chrome Web UI presets & interactive REPLs | M7 | DONE (`sub_orch_m7` Iter 1 gate passed 5/5 unanimous; 20/20 SDK tests, 26/26 server tests, 65/65 Rust tests, live Python & Node Chrome UI presets + REPLs verified, Auditor CLEAN) |
| M9 | Final Milestone — Python & Node E2E Suite Pass (Tiers 1–4) + Tier 5 Adversarial Hardening | Pass 100% of updated `TEST_READY.md` E2E suite (existing + Python/Node Tiers 1–4) + Tier 5 adversarial hardening | M7, M8, TEST_READY.md | DONE (Phase 1 Tiers 1–4: 71/71 E2E PASS + 5/5 self-test; Phase 2 Tier 5: 14/14 PASS, 67/67 Rust lib, 24/24 SDK, 26/26 Server = 207/207 total tests PASS, both Fresh Challengers `NO_GAPS`, Whole-Project Forensic Auditor `CLEAN`) |

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

### 4. Web UI DOM & Global Hooks (`M4` / `M7` ↔ `E2E`)
- `window.Elf2WasmDocker` and `window.runDockerImage` exposed on `window`.
- Key stable DOM `id` attributes in `web/index.html`:
  - `#image-input` (input defaulting to `alpine:latest`)
  - `#cmd-input` (optional command override input)
  - `#start-btn` (button to start interactive shell)
  - `#stop-btn` (button to stop/reset container)
  - `#clear-btn` (button to clear terminal)
  - `#status-text` / `#progress-bar` (live client-side stage & progress display)
  - `#terminal` (interactive VT100 terminal container with accessible output text and keyboard focus)
- `.presets-row` quick-preset chips (`button.preset-chip[data-image]`):
  - `alpine:latest`
  - `busybox:latest`
  - `debian:bookworm-slim`
  - `python:3.12-slim` (added in M7)
  - `node:22-slim` (added in M7)

### 5. `WasmMeta` Dynamic Guest VA Layout (`M6` ↔ `M7`)
- `WasmMeta` (`crates/elf2wasm-core/src/meta.rs`) carries dynamic guest layout fields (`brk_start: u32`, `mmap_start: u32`, `mmap_end: u32`, `stack_top: u32`, `dispatch_hash_addr: u32`) with backward-compatible defaults matching the legacy 256 MiB map (`0x0500_0000`, `0x0800_0000`, `0x0B00_0000`, `0x0BFF_0000`, `0x0C00_0000`) when binaries fit in 256 MiB, and dynamically expanding for large binaries (`node:22-slim`, ~108 MiB `ET_EXEC`).
- `elf2wasm-runtime-core` reads these fields from `WasmMeta` instead of hardcoded constants.

### 6. Node.js Default Runtime Environment (`M7` ↔ `E2E`)
- When `createContainer()` (`js/docker_sdk.mjs`) runs a Node.js image (detected via `NODE_VERSION` in image env or `node` executable basename), it injects default environment variables (strictly overridable by user-supplied `options.env`):
  - `NODE_OPTIONS=--jitless --v8-pool-size=1`
  - `MALLOC_ARENA_MAX=1`
  - `UV_USE_IO_URING=0`
  - `UV_THREADPOOL_SIZE=1`
