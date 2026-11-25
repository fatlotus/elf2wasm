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
├── server/                            # Node.js 22 ESM web server & thin OCI/Git streaming proxy
│   ├── proxy_core.mjs                 # Pure ESM shared OCI proxy validation, SSRF, auth & cache core
│   ├── git_core.mjs                   # Pure ESM shared git repo/ref parser, validator & forge tarball URL resolver
│   ├── server.mjs                     # HTTP server (static assets + /wasm/* + /api/v2/* + /api/git/archive)
│   ├── registry_proxy.mjs             # Node OCI v2 proxy (uses proxy_core.mjs + dns.lookup pinning)
│   ├── git_proxy.mjs                  # Node streaming git repo archive proxy (uses git_core.mjs + SSRF pinning)
│   ├── mock_registry.mjs              # Local mock OCI v2 registry for deterministic testing
│   ├── mock_git_server.mjs            # Local mock git archive HTTP server for deterministic offline testing
│   └── test_server.mjs                # Unit/integration tests for server, OCI proxy & git proxy
├── worker/                            # Cloudflare Workers full-app deployment (OCI/Git proxy + Static Assets)
│   ├── wrangler.jsonc                 # Wrangler config (name: elf2wasm, workers_dev: true, assets: ./dist)
│   ├── package.json                   # Isolated manifest pinning wrangler + scripts
│   ├── package-lock.json              # Reproducible lockfile for CI
│   ├── scripts/build_assets.mjs       # Stages web/, js/, /wasm/*.wasm + _headers into worker/dist/
│   ├── src/index.mjs                  # Web-standard Cloudflare Worker fetch() handler (/api/health, /api/v2/*, /api/git/archive)
│   └── test/worker.test.mjs           # Automated Worker unit/integration tests
├── .github/workflows/
│   └── deploy-worker.yml              # GitHub Actions: Rust/WASM build + tests + cloudflare/wrangler-action@v4
├── js/                                # Browser & Node ESM client-side SDK and shim
│   ├── elf2wasm_shim.mjs              # Core WASM compiler/runtime shim, VFS tar/OCI/git overlay extraction, async CPS loop
│   ├── oci_client.mjs                 # Image ref parser, multi-arch linux/amd64 index/manifest/blob client
│   ├── git_client.mjs                 # Client-side git repo snapshot fetcher (.tar.gz streaming + decompression)
│   ├── docker_sdk.mjs                 # Public JS API: Elf2WasmDocker, runDockerImage, pullImage, createContainer (with gitRepo overlay)
│   ├── container_worker.mjs           # Dedicated Web Worker host for non-blocking client-side compilation & execution
│   ├── cli.mjs                        # Node CLI wrapper
│   └── test_docker_sdk.mjs            # Unit/integration tests for OCI client, git overlay & Docker SDK
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
| F25 | Shared Pure-ESM Git Repo Spec & Forge Archive URL Core (`server/git_core.mjs`) | Pure ESM (zero `node:*` deps) parser and validator for `repo` (GitHub `owner/repo` shorthand, `https://github.com/...`, `https://gitlab.com/...`, `https://codeberg.org/...`, plus loopback `http://127.0.0.1:<port>/...` under `allowLocalRegistries`) and `ref` (commit SHA, branch, or tag, default `HEAD`, rejecting control chars, whitespace, `..`, leading `-`, etc.), resolving canonical forge `.tar.gz` snapshot URLs and `isImmutableRef` / `stripComponents`. | M10 | Survey 2 (1.4, 4.1) |
| F26 | Dual-Runtime Backend Git Snapshot Endpoint (`GET\|HEAD /api/git/archive`) & Mock Server | Implement streaming single-file `.tar.gz` git repo snapshot endpoint in BOTH Node.js (`server/git_proxy.mjs` + `server/server.mjs`) and Cloudflare Worker (`worker/src/index.mjs` with `caches.default` + CORS), with SSRF protection, DNS-rebinding pinning (Node), cross-origin redirect `Authorization` stripping, `X-Git-Strip-Components` & `Cache-Control` headers, COOP/COEP/CORP headers, `server/mock_git_server.mjs`, and comprehensive Node + Worker unit tests. | M10 | Survey 1 (1.1, 2.2), Survey 2 (1.1, 1.4, 4.2) |
| F27 | WASM Toolchain Build & VFS Tar Overlay Extraction (`mountPath` + `stripComponents`) | Install `wasm32-unknown-unknown` target and build release `elf2wasm_{compiler,runtime}_wasm.wasm`; extend `extractTarToVfs` and `extractTarGzToVfs` in `js/elf2wasm_shim.mjs` with `{ mountPath = "/", stripComponents = 0, ignoreWhiteouts = false }` including path-escape scoping to `mountPath` and hardlink target rebasing. | M11 | Survey 1 (1.4, 2.2, 4.1), Survey 2 (1.3, 4.3), Survey 3 (1.1, 1.2) |
| F28 | Client Git Snapshot Fetcher (`js/git_client.mjs`), Docker SDK Overlay Integration & Worker Asset Allowlist | Create `js/git_client.mjs` (`fetchGitArchive`, streaming `.tar.gz` + client-side `DecompressionStream("gzip")` + progress stages + `AbortSignal`), register `git_client.mjs` in `worker/scripts/build_assets.mjs:BROWSER_JS_FILES`, and extend `Elf2WasmDocker`/`ContainerEngine`/`WorkerBackend`/`DirectBackend`/`DockerImage`/`runDockerImage`/`container_worker.mjs` with `gitProxyBase` and `gitRepo: { repo, ref, mountPath, stripComponents }` (and `overlayTarBytes`), overlaying onto container VFS after OCI layers, defaulting `cwd`/`PWD` to `mountPath`, and releasing `tarBytes` after extraction. | M11 | Survey 1 (1.1, 1.4, 4.2), Survey 2 (1.3, 4.4) |
| F29 | Live Runtime Verification of 3 Large Project Presets (Python, JavaScript, Rust) | Empirically verify 3 well-known projects' test suites running offline inside `elf2wasm` (Node SDK) via Docker container + git repo overlay: (1) Python (`python:3.12-slim`, e.g. `Python-Markdown/markdown` or `hukkin/tomli`, adding missing stdlib `PYTHON_CORE_LIB_DYNLOAD` modules like `pyexpat`/`_elementtree` if required), (2) JavaScript (`node:22-slim`, e.g. `ai/nanoid` via `node --test --test-isolation=none`), (3) Rust (e.g. `nushell/nushell` on `ghcr.io/nushell/nushell:*-alpine` running `crates/nu-std/tests/`, or another verified well-known Rust project runnable within `elf2wasm`'s 176 MiB ELF ceiling). Record exact verified `{ image, repo, ref, mountPath, cmd, cwd, env }` in `PROJECT.md`. | M11 | Survey 1 (2.4), Survey 3 (1.1, 1.4, 3.1–3.3) |
| F30 | Web UI Git Repo Overlay Controls & Progress/Terminal Integration | Add Git Repository Overlay controls after Docker image selection in `web/index.html`, `web/app.mjs`, `web/styles.css` (`#repo-input`, `#repo-ref-input`, `#repo-mount-input` defaulting to `/workspace`), wire `gitRepo` into `bootImage()`, handle git download/decompress/overlay progress stages in `handleProgressEvent()`, and display active repo/ref in `#terminal-title`. | M12 | Survey 1 (1.2, 2.1, 4.3) |
| F31 | Web UI Project Test Presets (Python, JavaScript, Rust) & Backward-Compatible Image Presets | Preserve the 5 existing `button.preset-chip[data-image]` chips in `.presets-row` (clearing repo/cmd/cwd/env fields on click and focusing `#image-input` for full E2E compatibility); add a separate `.project-presets-row` with `.project-preset-chip[data-preset]` buttons for the 3 verified large Python, JavaScript, and Rust projects (populating image, repo, ref, mountPath, cmd, cwd, env in one click); run `cd worker && npm run build:assets && npm run deploy:dry-run`. | M12 | Survey 1 (1.3, 2.3, 4.3), Survey 3 (3.1–3.3) |
| F32 | Web UI URL Query-Parameter Deep-Linking | Pure zero-DOM ESM module `web/url_state.mjs` and bidirectional URL/history wiring in `web/app.mjs` (plus `name` attrs in `web/index.html`) syncing the 7 shareable UI options (`image`, `cmd`, `repo`, `ref`, `mount`, `cwd`, `env`, plus `?preset=<id>` and `repoRef`/`repoMount` read aliases) to `window.location.search` with default omission, unmanaged param preservation, `replaceState` on input, `pushState` on preset click, `popstate` re-hydration, auto-open `#advanced-options` when `cwd`/`env` hydrated, strict no-autorun and `.value`/`.textContent`-only XSS safety, unit + headless Chrome CDP tests, and CI integration. | M14 | Survey 1, Survey 2, Survey 3 |
| F33 | `SYS_WAITID` `WNOWAIT` & `PendingWakeup::Wait4` Fix | Honor `WNOWAIT` (`0x0100_0000`) in `SYS_WAITID` (247) and `PendingWakeup::Wait4` in `crates/elf2wasm-runtime-core/src/syscalls.rs` so `waitid(P_PID, pid, &si, WEXITED\|WNOWAIT, 0)` does not prematurely reap the zombie before Go's subsequent `wait4` (`-ECHILD`); preserve `options` when re-blocking; fix `CLD_KILLED` vs `CLD_EXITED` `siginfo_t` encoding and `idtype`/`id` validation. | M15 | Survey o4 (1, 2, 3) |
| F34 | In-Memory IPv4 TCP Loopback Sockets & `epoll` Readiness | Implement in-memory IPv4 TCP loopback (`127.0.0.1`/`0.0.0.0`) sockets in `crates/elf2wasm-runtime-core/src/` (`socket`, `bind` with ephemeral port 0, `listen`, `accept`/`accept4`, `connect` with non-blocking `EINPROGRESS`/`SO_ERROR`, `getsockname`, `getpeername`, `setsockopt`, `getsockopt`, `shutdown`, `sendto`/`recvfrom`, `read`/`write`/`close` EOF, and `epoll`/`poll` readiness + wakeups) so Go `net.Listen("tcp", "127.0.0.1:0")` and `net/http` work inside `elf2wasm`. | M15 | Survey o4 (3) |
| F35 | End-to-End `golang:1.21-bookworm` + `fatlotus/nodice` Verification | Rebuild `wasm32-unknown-unknown` release `.wasm` artifacts, reproduce `wait: no child processes` before fix, and verify `/bin/sh -c "cd /workspace/example && go build && ./raft"` exits `0` with all 4 Raft proposals replicated/committed/applied cleanly and all Rust/JS/Server/Worker tests passing. | M15 | Survey o4 (3), User Request |
| F36 | Deterministic Simulated-Time Delay Injection in Rust Runtime Core | Add seeded SplitMix64 PRNGs (`delay_stddev_ns`, `delay_seed`, `delay_rng_state`, `seed_configured`) seeding `vfs.prng_state`, `AT_RANDOM`, and `delay_rng_state`; half-normal `\|N(0, stddev_ns²)\|` delay sampler; simulated-time `PipeBuffer::in_flight` TCP delivery preserving per-connection FIFO while reordering across concurrent connections, integrated with `on_yield_multiproc` virtual-time fast-forward (`min_in_flight_ns`) and EOF-after-drain; Fisher-Yates `epoll` ready-event shuffling and `run_queue` jitter when `delay_stddev_ns > 0`. Zero real-time waiting; `stddev=0` preserves legacy behavior. | M16 | Survey 1 (RT-D1..RT-D4), Survey 3 |
| F37 | CoW VFS Snapshots, Multi-Run Clean Reset, WASM C-ABI & Native CLI | Export `runtime_snapshot_vfs`, `runtime_restore_vfs`, `runtime_drop_vfs_snapshot` (CoW `overlay.clone()`), `runtime_set_delay_config(stddev_ns, seed)`, and `runtime_reset_virtual_time` in `elf2wasm-runtime-wasm`; fix `VirtualFs::reset_fds_and_stdio()` to clear TCP socket tables (`tcp_sockets`, `tcp_bound_ports`, `tcp_listeners`, `next_ephemeral_port`) and `stdin_data`; reset `virtual_mono_ns = 0` and re-seed PRNGs deterministically on new runs; install `wasm32-unknown-unknown` and build release `.wasm` artifacts; add `--delay-stddev-ms` and `--delay-seed` flags to native CLI (`src/main.rs`, `src/runtime.rs`). | M16 | Survey 1 (RT-D5), Survey 2 (F-BR1, F-CLI1) |
| F38 | Shim Relative `cwd` Fix, Snapshot/Delay Plumbing, Reusable Container Exec & Sweep SDK | Fix `Elf2WasmSystem::runFromVfs()` relative executable path resolution (`./raft`) against `options.cwd`; add `setDelayConfig`, `resetVirtualTime`, `snapshotVfs`, `restoreVfs`, `dropVfsSnapshot` to `js/elf2wasm_shim.mjs`; extend `ContainerEngine`/`DirectBackend`/`WorkerBackend`/`DockerContainer`/`container_worker.mjs` with snapshot/restore, reusable `exec()`, and `runSweep()` (build once with `stddev=0` -> snapshot -> run N times with increasing `stddev` & `seed` until failure); add `--delay-stddev-ms` & `--delay-seed` to `js/cli.mjs`; verify live `fatlotus/nodice` Raft bug discovery & standalone deterministic reproduction. | M17 | Survey 2 (F-BR2, F-CLI1), Survey 3 |
| F39 | URL State Schema for Build/Run Split, Delay Injection, Sweep Mode & Linkable Runs | Extend `web/url_state.mjs` with `build`, `cmd` (canonical run command + `run` read alias), `stddev`, `seed`, `sweep`, `runs`, `stddevStart`, `stddevStep`, `selectedRun`; add `computeSweepRunParams` & `buildRunSearch` for standalone deterministic per-run reproducer links; preserve 100% backward compatibility with existing `?cmd=` URLs and `js/test_url_state.mjs`. | M18 | Survey 2 (F-URL1) |
| F40 | Web UI Build/Run Split, Delay & Sweep Controls, Live Sweep Panel & Worker Assets | Update `web/index.html`, `web/app.mjs`, `web/styles.css` with `#build-cmd-input`, relabeled `#cmd-input` (Run Command), delay (`#delay-stddev-input`, `#delay-seed-input`) and sweep (`#sweep-mode-toggle`, `#sweep-runs-input`, `#sweep-stddev-start-input`, `#sweep-stddev-step-input`) controls, build-once -> snapshot -> run/sweep execution with stop-on-first-failure, `#sweep-panel` live results table with click-to-inspect output (`selectedRun` URL sync) and per-run standalone reproducer `<a class="run-link">` links, `Go: Raft (nodice)` project preset, and `worker/scripts/build_assets.mjs` verification. | M18 | Survey 2 (F-UI1, F-ASSET1) |
| F41 | Opaque-Box 4-Tier E2E Test Suite (Delay Injection, Build/Run Split & Sweep Mode) | Design and implement requirement-driven opaque-box E2E tests (Tiers 1–4) in `e2e_docker_web/` covering deterministic simulated-time delay injection, build/run split, sweep mode stop-on-failure, URL linking for sweep + specific runs, and `fatlotus/nodice` Raft bug finding; publish `TEST_INFRA.md` and `TEST_READY.md`. | E2E Track | Dual Track, Survey 3 |
| F42 | Final Milestone — E2E Pass (Tiers 1–4) + Tier 5 Adversarial Hardening | Phase 1: pass 100% of E2E tests (Tiers 1–4); Phase 2: white-box Tier 5 adversarial coverage hardening (Challenger -> Worker -> Reviewer loop until no gaps remain). | M19 | Project Pattern |

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
| M10 | Backend Git Repo Snapshot Proxy (Node.js + Cloudflare Worker) | `server/git_core.mjs`, `server/git_proxy.mjs`, `server/server.mjs`, `server/mock_git_server.mjs`, `server/test_server.mjs`, `worker/src/index.mjs`, `worker/test/worker.test.mjs`; features F25–F26 | none | DONE (`sub_orch_m10` Iter 1 gate passed 5/5 unanimous; 36/36 worker tests, 15/15 server git tests, 258/258 adversarial probes, Auditor CLEAN) |
| M11 | VFS Tar Overlay, Git Client, Docker SDK Integration & Live Project Verification | `js/elf2wasm_shim.mjs`, `js/git_client.mjs`, `js/docker_sdk.mjs`, `js/container_worker.mjs`, `js/test_docker_sdk.mjs`, `worker/scripts/build_assets.mjs`, WASM build (`wasm32-unknown-unknown`); features F27–F29 | M10 | DONE (`sub_orch_m11` Iter 1 gate passed 5/5 unanimous; 172/172 unit/integration tests + 46/46 adversarial probes PASS; WASM built; all 3 live presets verified exit 0: Bottle 359/359, Nano ID 13/13, Nushell 35/35; Auditor CLEAN) |
| M12 | Web UI Git Repo Overlay Controls & Project Test Presets | `web/index.html`, `web/app.mjs`, `web/styles.css`, `worker/scripts/build_assets.mjs` asset staging + `wrangler deploy --dry-run`; features F30–F31 | M10, M11 | DONE (`sub_orch_m12` Iter 2 gate passed 5/5 unanimous; 154/154 full-suite tests + 89/89 adversarial Chrome/JS probes PASS; `worker` build/test/dry-run PASS; Auditor CLEAN) |
| M13 | Final Milestone — Git Repo Overlay & Project Presets E2E Pass (Tiers 1–4) + Tier 5 Hardening | Pass 100% of updated `TEST_READY.md` E2E suite (existing + Git Repo Overlay & Project Presets Tiers 1–4) + Tier 5 adversarial hardening | M10, M11, M12, TEST_READY.md | DONE (Phase 1 Tiers 1–4: 88/92 E2E PASS + 4 `--skip-live` + 6/6 self-test; Phase 2 Tier 5: 20/20 PASS + 13 bugs/parity gaps fixed; 304/304 total automated tests PASS + `wrangler deploy --dry-run` PASS; both Fresh Challengers `NO_GAPS`, both Final Reviewers `APPROVE`, Whole-Project Forensic Auditor `CLEAN`) |
| M14 | Web UI URL Query-Parameter Deep-Linking | `web/url_state.mjs`, `web/app.mjs`, `web/index.html`, `js/test_url_state.mjs`, `e2e_docker_web/test_deep_link.mjs`, `server/test_server.mjs`, `worker/test/worker.test.mjs`, `.github/workflows/deploy-worker.yml`, `README.md`, `PROJECT.md`; feature F32 | M12 | DONE (Iter 1 gate passed 5/5 unanimous: 115/115 suite tests PASS [14 URL unit + 47 server + 43 worker + 5 Chrome CDP deep-link + 6 E2E self-test], 25/25 URL fuzz/adversarial probes + 12/12 Chrome CDP adversarial probes PASS, 2/2 Reviewers APPROVE, 2/2 Challengers APPROVE, Forensic Auditor CLEAN) |
| M15 | Go `go build && ./raft` (`fatlotus/nodice`): `waitid(WNOWAIT)`, `MAP_SHARED` & IPv4 TCP Loopback Sockets | `crates/elf2wasm-runtime-core/src/{syscalls,vfs,scheduler,lib}.rs`, `js/test_docker_sdk.mjs`, WASM rebuild; features F33–F35 | M13 | DONE (`orchestrator_4` Iter 2 gate passed 5/5 unanimous: 94/94 Rust workspace lib tests, 39/39 JS Docker SDK tests, 43/43 Worker tests, WASM 0 warnings, live `go build` + `fatlotus/nodice/example` 3-node Raft cluster exit 0, Forensic Auditor CLEAN) |
| M16 | Rust Runtime Deterministic Delay Injection, CoW VFS Snapshots & WASM Build | `crates/elf2wasm-runtime-core/src/{vfs,syscalls,stack,scheduler,lib}.rs`, `crates/elf2wasm-runtime-wasm/src/lib.rs`, `src/{main,runtime}.rs`, WASM release build (`wasm32-unknown-unknown`); features F36–F37 | none | DONE (`sub_orch_m16` Iter 2 gate passed 5/5 unanimous: 103/103 Rust workspace lib tests, wasm32 release build 0 warnings, 5 Contract 11 C-ABI exports, 18/18 adversarial probes, Forensic Auditor CLEAN) |
| M17 | JS Shim, Docker SDK, Worker & CLI Support for Delay Injection, Build/Run Split & Sweep Mode | `js/elf2wasm_shim.mjs`, `js/docker_sdk.mjs`, `js/container_worker.mjs`, `js/cli.mjs`, `js/test_docker_sdk.mjs`; feature F38; live `fatlotus/nodice` Raft bug sweep verification | M16 | DONE (`sub_orch_m17` Iter 2 gate passed 5/5 unanimous: 152/152 automated tests, 60/60 adversarial probes, live `fatlotus/nodice` sweep found bug on run #7 with bit-for-bit standalone repro, Forensic Auditor CLEAN) |
| M18 | Web UI & URL Deep-Linking for Build/Run Split, Delay Injection & Linkable Sweep Mode | `web/url_state.mjs`, `web/index.html`, `web/app.mjs`, `web/styles.css`, `js/test_url_state.mjs`, `e2e_docker_web/test_deep_link.mjs`, `worker/scripts/build_assets.mjs`; features F39–F40 | M17 | DONE (`sub_orch_m18` Iter 2 gate passed 5/5 unanimous: 169/169 automated tests [incl. 10/10 Chrome CDP deep-link/sweep], 500/500 URL fuzzing + 7/7 Chrome CDP adversarial probes, Forensic Auditor CLEAN) |
| M19 | Final Milestone — Delay Injection & Sweep Mode E2E Pass (Tiers 1–4) + Tier 5 Hardening | Pass 100% of E2E tests (Tiers 1–4) + Tier 5 adversarial coverage hardening across all modules | M16, M17, M18, TEST_READY.md | DONE (Phase 1 Tiers 1–4: 60/60 PASS incl. live `T4-DS-3` `fatlotus/nodice` + 6/6 self-test; Phase 2 Tier 5: 7 iterations, 21 bugs fixed, 21/21 Tier 5 PASS; 356/356 total automated tests PASS [104 Rust + 23 URL + 48 SDK + 10 Deep-Link + 47 Server + 43 Worker + 60 E2E + 21 Tier 5], 13/13 `worker/dist/` SHA-256 parity, both Fresh Challengers `NO_GAPS`, both Final Reviewers `APPROVE`, Whole-Project Forensic Auditor `CLEAN`) |
| E2E | E2E Testing Track — Delay Injection, Build/Run Split & Sweep Mode | `TEST_INFRA.md`, `TEST_READY.md`, `e2e_docker_web/` opaque-box 4-tier test suite; feature F41 | none | DONE (`e2e_orch_delay_sweep` Iter 2 gate passed 5/5 unanimous: 60 opaque-box E2E tests Tiers 1–4 + 6 self-tests, `TEST_INFRA.md` & `TEST_READY.md` published, Forensic Auditor CLEAN) |

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

### 7. Backend Git Repo Snapshot Proxy (`M10` ↔ `M11` / `M12` / `E2E`)
Implemented identically in BOTH `server/server.mjs` (via `server/git_proxy.mjs`) and `worker/src/index.mjs`, sharing pure-ESM `server/git_core.mjs` (zero `node:*` imports):
- **Route**: `GET|HEAD /api/git/archive?repo=<owner/repo-or-url>&ref=<commit|branch|tag>`
- **Input parsing & validation (`server/git_core.mjs`)**:
  - `repo` (required): accepts GitHub shorthand `owner/repo` (with optional `.git`), `https://github.com/<owner>/<repo>[.git]`, `https://gitlab.com/<group...>/<repo>[.git]`, `https://codeberg.org/<owner>/<repo>[.git]`, or (ONLY when `allowLocalRegistries` is enabled) loopback `http://127.0.0.1:<port>/...` / `http://[::1]:<port>/...` for offline tests. Rejects credentials, control chars, `..`, null bytes, non-HTTPS (except loopback under `allowLocalRegistries`), and private/link-local/metadata IPs.
  - `ref` (optional, default `"HEAD"`): commit SHA (short or 40-char hex), branch name, or tag name (also accepts `refs/heads/<branch>` or `refs/tags/<tag>`). Rejects control chars, whitespace, `..`, `~`, `^`, `:`, `?`, `*`, `[`, `\`, leading `-`, leading/trailing `/`, length > 255.
  - Upstream forge tarball URL resolution:
    - GitHub: `https://github.com/<owner>/<repo>/archive/<ref>.tar.gz` (follows 302 to `codeload.github.com`, avoiding unauthenticated REST API 60 req/hr limit).
    - GitLab: `https://gitlab.com/<group...>/<repo>/-/archive/<ref>/<repo>-<ref>.tar.gz`.
    - Codeberg: `https://codeberg.org/<owner>/<repo>/archive/<ref>.tar.gz`.
    - Local mock (when `allowLocalRegistries`): `<baseUrl>/archive/<encodedRef>.tar.gz` (or direct mock archive URL convention).
- **Security**:
  - Reuses `validateUrlPolicy` / `isBlockedIp` from `server/proxy_core.mjs` (and DNS-rebinding pinning in Node).
  - Validates every redirect hop (max 5); strips `Authorization` on cross-origin redirect.
  - Sets COOP/COEP/CORP/`X-Content-Type-Options: nosniff` headers on all responses.
- **Response headers**:
  - `Content-Type: application/gzip`
  - `Content-Length` (when provided upstream)
  - `X-Git-Archive-Format: tar.gz`
  - `X-Git-Strip-Components: 1` (or `0` if upstream header specifies)
  - `Cache-Control`: `public, max-age=604800, immutable` for 40-char hex SHAs; `public, max-age=300` for branches/tags/short SHAs.
- **Error semantics**: Invalid `repo`/`ref` → `400`, SSRF/blocked host → `403`, upstream 404 → `404`, upstream 429 → `429`, upstream failure/timeout → `502` with JSON `{ "error": "..." }`.

### 8. VFS Tar Overlay Extraction (`M11`)
Extended `extractTarToVfs(arg1, arg2, options?)` and `extractTarGzToVfs(arg1, arg2, options?)` in `js/elf2wasm_shim.mjs`:
- Backward-compatible with existing `(sys, bytes)` and `(bytes)` signatures.
- Optional `options = { mountPath = "/", stripComponents = 0, ignoreWhiteouts = false }`:
  - Strips `stripComponents` leading path segments from each tar entry (entries with `<= stripComponents` segments are skipped).
  - Resolves and prefixes remaining path under `normalizeGuestPath(mountPath)` while rejecting/clamping any `..` traversal that would escape `mountPath` when `mountPath !== "/"`.
  - Applies the same `stripComponents` + `mountPath` rebasing to hardlink (`typeFlag === "1"`) targets; preserves relative symlink (`typeFlag === "2"`) targets as-is.

### 9. Client Git Snapshot Fetcher & Extended Docker SDK (`M11` ↔ `M12` / `E2E`)
- **`js/git_client.mjs`** (also registered in `worker/scripts/build_assets.mjs:BROWSER_JS_FILES`):
  - `fetchGitArchive({ repo, ref, gitProxyBase = "/api/git/archive", onProgress, signal })` → `Promise<{ tarBytes: Uint8Array, stripComponents: number, repo: string, ref: string }>`
  - Streams `.tar.gz` from `${gitProxyBase}?repo=...&ref=...`, emits progress stages (`"git-download"`, `"git-decompress"`), decompresses client-side via `DecompressionStream("gzip")` (with `node:zlib` fallback).
- **`js/docker_sdk.mjs` & `js/container_worker.mjs`**:
  - `Elf2WasmDocker.create(options?)` accepts `gitProxyBase = "/api/git/archive"`.
  - `image.createContainer(options?)` and `runDockerImage(imageRef, options?)` accept:
    - `gitRepo?: { repo: string, ref?: string, mountPath?: string, stripComponents?: number }` (default `mountPath = "/workspace"`, `ref = "HEAD"`).
    - `overlayTarBytes?: Uint8Array` + `overlayMountPath?: string` + `overlayStripComponents?: number` (for pre-fetched/offline tar overlays).
  - `WorkerBackend.createContainer()` forwards `gitRepo` (and transfers `overlayTarBytes` if provided) in `cleanOptions` to `js/container_worker.mjs`.
  - In `ContainerEngine.createContainer()`: after extracting all `image.layers`, fetches (if `gitRepo`) and extracts the repo tar onto `sys` at `mountPath` with `stripComponents`, releases repo `tarBytes` immediately after extraction, and defaults `cwd` (and `PWD`) to `mountPath` when `options.cwd` is not explicitly provided.

### 10. Web UI Git Repo Controls & Project Test Presets DOM Contracts (`M12` ↔ `E2E`)
- **Existing `.presets-row` preserved intact**: All 5 `button.preset-chip[data-image="..."]` chips remain unchanged; clicking any plain image `.preset-chip` populates `#image-input`, clears `#repo-input`, `#repo-ref-input`, `#cmd-input`, `#cwd-input`, `#env-input` (and resets `#repo-mount-input` to `/workspace`), and focuses `#image-input`.
- **Git Repo Overlay controls** (placed after Docker image selection in `web/index.html`):
  - `#repo-input`: text input for GitHub `owner/repo` or repo URL (optional; empty = no repo overlay).
  - `#repo-ref-input`: text input for commit SHA, branch, or tag (optional; defaults to `HEAD` when repo is set).
  - `#repo-mount-input`: text input for container mount path (default `/workspace`).
- **Project Test Presets** (separate row `.project-presets-row`):
  - 3 `button.project-preset-chip[data-preset="..."]` buttons (one Python project, one JavaScript project, one Rust project — exact pinned `{ id, label, language, image, repo, ref, mountPath, cmd, cwd, env }` populated from M11's verified live runs).
  - Clicking a `.project-preset-chip` populates `#image-input`, `#repo-input`, `#repo-ref-input`, `#repo-mount-input`, `#cmd-input`, `#cwd-input`, `#env-input` in one click.

#### Verified Project Test Presets (from M11 F29)
1. **`python-bottle`** (Python):
   - `label`: `"Python: Bottle (359 tests)"`
   - `image`: `"python:3.12-slim"`
   - `repo`: `"bottlepy/bottle"`, `ref`: `"0.13.4"`, `mountPath`: `"/workspace"`
   - `cmd`: `python3 -m unittest discover -s test -t .`
   - `cwd`: `"/workspace"`, `env`: `["PYTHONUNBUFFERED=1"]`
2. **`js-nanoid`** (JavaScript):
   - `label`: `"JavaScript: Nano ID (13 tests)"`
   - `image`: `"node:22-slim"`
   - `repo`: `"ai/nanoid"`, `ref`: `"6.0.2"`, `mountPath`: `"/workspace"`
   - `cmd`: `node test/non-secure.test.js`
   - `cwd`: `"/workspace"`, `env`: `[]`
3. **`rust-nushell`** (Rust):
   - `label`: `"Rust: Nushell stdlib (35 tests)"`
   - `image`: `"ghcr.io/nushell/nushell:0.117.0-alpine"`
   - `repo`: `"nushell/nushell"`, `ref`: `"0.117.0"`, `mountPath`: `"/workspace"`
   - `cmd`: `--no-config-file -c "source crates/nu-std/tests/test_asserts.nu; source crates/nu-std/tests/test_iter.nu; source crates/nu-std/tests/test_formats.nu; assert_basic; assert_not; assert_equal; assert_not_equal; assert_error; assert_length; assert_less; assert_less_or_equal; assert_greater; assert_greater_or_equal; iter_find; iter_intersperse; iter_scan; iter_filter_map; iter_find_index; iter_zip_with; iter_flat_map; iter_zip_into_record; from_ndjson_multiple_objects; from_ndjson_single_object; from_ndjson_invalid_object; from_jsonl_multiple_objects; from_jsonl_single_object; from_jsonl_invalid_object; to_ndjson_multiple_objects; to_ndjson_single_object; to_jsonl_multiple_objects; to_jsonl_single_object; from_ndnuon_multiple_objects; from_ndnuon_single_object; from_ndnuon_invalid_object; to_ndnuon_multiple_objects; to_ndnuon_single_object; to_ndnuon_multiline_strings; from_ndnuon_multiline_strings; print 'OK: 35 nu-std tests passed'"`
   - `cwd`: `"/workspace"`, `env`: `["HOME=/tmp"]`

### 11. Runtime Deterministic Delay Injection & CoW VFS Snapshot C-ABI (`M16` ↔ `M17` / `E2E`)
Exported from `crates/elf2wasm-runtime-wasm/src/lib.rs` (all existing exports backward-compatible):
- `runtime_set_delay_config(stddev_ns: u64, seed: u64)`: Configures simulated-time delay injection (`stddev_ns` = standard deviation in nanoseconds, `0` disables delay injection; `seed` = 64-bit PRNG seed). Derives independent SplitMix64 streams for `delay_rng_state` and `vfs.prng_state` / `AT_RANDOM`. When `stddev_ns == 0 && seed == 0` (unset), preserves exact legacy PRNG behavior.
- `runtime_reset_virtual_time()`: Resets `virtual_mono_ns = 0` (and `vfs.uptime_ns = 0`) so each standalone or sweep run starts from identical simulated time `0`.
- `runtime_snapshot_vfs() -> u32`: Captures a Copy-on-Write snapshot of `VirtualFs::overlay` (`Arc<Vec<u8>>` zero-copy clone) and returns a non-zero `snapshot_id`.
- `runtime_restore_vfs(snapshot_id: u32) -> i32`: Restores `VirtualFs::overlay` from `snapshot_id` (`0` on success, `-1` if invalid ID).
- `runtime_drop_vfs_snapshot(snapshot_id: u32) -> i32`: Releases snapshot `snapshot_id` (`0` on success, `-1` if invalid ID).
- **Clean multi-run reset invariant**: `VirtualFs::reset_fds_and_stdio()` clears `tcp_sockets`, `next_tcp_socket_id`, `tcp_bound_ports`, `tcp_listeners`, `next_ephemeral_port`, and `stdin_data` in addition to pipes/epolls/fds/stdio. `SyscallState::reset_for_new_run()` re-seeds PRNGs deterministically from `(delay_stddev_ns, delay_seed)` when configured and resets `virtual_mono_ns = 0` so sweep iteration `k` is bit-for-bit identical to a standalone run with the same `(stddev, seed)`.
- **Simulated-time TCP in-flight delivery**: When `delay_stddev_ns > 0`, TCP socket writes enqueue `(deliver_ns, bytes)` in `PipeBuffer::in_flight` where `deliver_ns = prev_deliver_ns.max(now_ns + sample_half_normal(stddev_ns))` (preserving per-connection FIFO while reordering across concurrent connections). `on_yield_multiproc` includes `min_in_flight_ns()` in `min_wake` fast-forward (0 real-time wait). EOF is deferred until `in_flight.is_empty()`. Simultaneously ready `epoll` events in `finish_poll` are Fisher-Yates shuffled and `run_queue` thread selection is perturbed deterministically using `delay_rng_state`.

### 12. JS Docker SDK Reusable Exec, VFS Snapshots & Sweep API (`M17` ↔ `M18` / `E2E`)
Extended in `js/elf2wasm_shim.mjs`, `js/docker_sdk.mjs`, and `js/container_worker.mjs`:
- `Elf2WasmSystem`:
  - `runFromVfs(elfPath, argv, options)` resolves relative executable paths (e.g. `./raft`) against `options.cwd` when `elfPath.includes("/")` and `!elfPath.startsWith("/")`.
  - `setDelayConfig(stddevMs, seed)`, `resetVirtualTime()`, `snapshotVfs() -> number`, `restoreVfs(snapshotId)`, `dropVfsSnapshot(snapshotId)`.
- `DockerContainer` (via both `DirectBackend` and `WorkerBackend` / `container_worker.mjs`):
  - `createContainer(options)` accepts `delayStddevMs?: number`, `delaySeed?: number`.
  - `snapshotVfs() -> Promise<number>`, `restoreVfs(snapshotId: number) -> Promise<void>`, `dropVfsSnapshot(snapshotId: number) -> Promise<void>`.
  - `exec(options) -> Promise<{ exitCode: number, stdout: string, stderr: string, virtualTimeNs: number, timedOut?: boolean, error?: string }>`: runs a command on an existing container without destroying it; accepts `{ cmd, env, cwd, tty, stdin, delayStddevMs, delaySeed, timeoutMs, onStdout, onStderr, signal }`.
- High-level `runSweep(imageRef, options)` exported from `js/docker_sdk.mjs` (and exposed on `window.runSweep` if useful):
  - Options: `{ buildCmd?: string[], runCmd: string[], runs: number, stddevStart?: number, stddevStep?: number, seedStart?: number, stopOnFailure?: boolean (default true), timeoutMs?: number, repo / gitRepo, cwd, env, onBuildOutput, onRunStart, onRunOutput, onRunComplete, onProgress, signal }`.
  - Lifecycle: pulls image + overlays git repo once → executes `buildCmd` once (with `delayStddevMs = 0`, aborting if build fails with non-zero exit) → takes CoW VFS snapshot → runs `runCmd` for `i = 0 .. runs - 1` (restoring snapshot before each run) with `stddev = round3(stddevStart + i * stddevStep)` and `seed = seedStart + i` until a run fails (`exitCode !== 0`, WASM trap, or timeout) or `runs` complete.
  - Returns `{ build: { exitCode, stdout, stderr, skipped }, runs: Array<{ index, stddevMs, seed, exitCode, status, stdout, stderr, virtualTimeNs, error }>, failedRun: RunResult | null, passed: boolean }`.
- CLI flags in both `src/main.rs` (`run`) and `js/cli.mjs` (`run`): `--delay-stddev-ms <f64>` and `--delay-seed <u64>`.

### 13. URL State Schema & Web UI DOM Contracts (`M18` ↔ `E2E`)
Extended in `web/url_state.mjs`, `web/index.html`, `web/app.mjs`, `web/styles.css`:
- **Backward-compatible URL query parameters** (`web/url_state.mjs`):
  - Existing preserved: `preset`, `image`, `cmd` (canonical Run Command), `repo`, `ref` (`repoRef` alias), `mount` (`repoMount` alias), `cwd`, `env` (repeatable).
  - New parameters:
    - `build`: Build Command string (optional; omitted when empty).
    - `run`: Read alias for `cmd` (canonical serialization writes `cmd`).
    - `stddev`: Delay stddev in ms (number `>= 0`; omitted when `0` / default).
    - `seed`: PRNG seed (non-negative integer; omitted when default `0` and `stddev === 0` and `!sweep`).
    - `sweep`: `"1"` when Sweep Mode is enabled (omitted when off).
    - `runs`: Number of sweep runs `N` (integer `>= 1`, default `20`; serialized when `sweep` is enabled and non-default or explicitly set).
    - `stddevStart`: Sweep starting stddev in ms (number `>= 0`, default `1`; serialized when `sweep` is enabled and non-default).
    - `stddevStep`: Sweep stddev increment per run in ms (number `>= 0`, default `1`; serialized when `sweep` is enabled and non-default).
    - `selectedRun`: Optional 1-based run index inside a sweep (`1..N`) for linking a specific run within sweep view.
  - Exported pure helpers:
    - `computeSweepRunParams(state, runIndex1Based)` → `{ index, stddev, seed }` (`stddev = round3(stddevStart + (index - 1) * stddevStep)`, `seed = seedStart + (index - 1)`).
    - `buildRunSearch(state, { stddev, seed })` → standalone deterministic single-run query string (keeps `image`, `build`, `cmd`, `repo`, `ref`, `mount`, `cwd`, `env`; removes `sweep`, `runs`, `stddevStart`, `stddevStep`, `selectedRun`; sets exact `stddev` and `seed`).
- **Stable DOM IDs** (all existing IDs preserved intact; no auto-boot on page load):
  - `#build-cmd-input` (Build Command, optional, runs once before run/sweep)
  - `#cmd-input` (Run Command — existing ID preserved)
  - `#delay-stddev-input` (Delay Stddev ms)
  - `#delay-seed-input` (PRNG Seed)
  - `#sweep-mode-toggle` (checkbox enabling Sweep Mode)
  - `#sweep-runs-input` (N runs), `#sweep-stddev-start-input`, `#sweep-stddev-step-input`
  - `#sweep-panel` (live sweep summary, "Copy Sweep Link" button `#copy-sweep-link-btn`, and `#sweep-results-body` table where each row displays `# | Stddev (ms) | Seed | Status | Exit | Virtual Time | Link`, clicking a row shows its output in `#terminal` and syncs `selectedRun`, and `<a class="run-link">` links directly to the standalone deterministic run URL via `buildRunSearch`).
  - Project preset chip `button.project-preset-chip[data-preset="go-raft-nodice"]` (`image: "ghcr.io/fatlotus/golang-with-cache:1.27-alpine"`, `repo: "fatlotus/nodice"`, `cwd: "/workspace/example"`, `build: "go build"`, `cmd: "./raft"`).
