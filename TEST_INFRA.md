# E2E Test Infrastructure — elf2wasm Client-Side Docker-on-WASM Web Platform

## 1. Overview & Architecture
`e2e_docker_web/` is a **requirement-driven, opaque-box, 4-tier E2E test suite** derived strictly from `ORIGINAL_REQUEST.md` and `PROJECT.md` Interface Contracts (§1–§10) and Feature Inventory (F1–F31).

- **Zero external npm dependencies**: Built entirely on Node.js 22 built-ins (`node:http`, `node:zlib`, `node:crypto`, `node:fs`, `node:path`, `node:child_process`, `node:assert/strict`, native `WebSocket`, native `fetch`).
- **Real Headless Browser**: Drives `/usr/bin/google-chrome` (discovered dynamically via `CHROME_PATH` / `CHROME_BIN` → `/usr/bin/google-chrome` → `/usr/bin/google-chrome-stable` → `/usr/bin/chromium` → `/usr/bin/chromium-browser`) over Chrome DevTools Protocol (CDP), including Dedicated Web Worker network inspection via `Target.setAutoAttach` + `Network.enable`, input/preset helpers (`getInputValue`, `getPresetChips`, `clickPresetChip`, `getProjectPresetChips`, `clickProjectPresetChip`), terminal polling (`waitForTerminalText`), and control-key dispatch (`sendControlKey`).
- **Multi-Layer Disk-Backed Mock OCI v2 Registry**: Dual ephemeral-port HTTP server (`e2e_docker_web/helpers/mock_oci_registry.mjs`) implementing OCI Distribution v2 Bearer token negotiation (`401` + `WWW-Authenticate` + `/token`), multi-arch Image Indexes (`linux/arm64` + `unknown/unknown` attestation before `linux/amd64`), cross-origin `302` blob redirects to a separate blob origin that strictly rejects leaked `Authorization` headers, and deterministic multi-layer fixtures cached from local Docker (`alpine:latest`, `busybox:musl`, and opt-in `python:3.12-slim` / `node:22-slim`) into `/tmp/elf2wasm-e2e-cache/<sanitized>/` (v2 `meta.json` + `layer<N>.tar.gz`).
  - Extracts multi-layer `docker save` archives via external `tar -xf` and compresses uncompressed layers with `gzip -1` to disk, avoiding Node V8 heap spikes on 180–232 MB images.
  - Streams disk-backed blobs via `fs.createReadStream(blob.filePath).pipe(res)` with `Content-Length` and `HEAD` support (zero resident blob heap for `python:3.12-slim` + `node:22-slim`), and uses zero-copy `Buffer.from(bytes.buffer, byteOffset, byteLength)` for in-memory synthetic blobs.
  - Default fixtures remain lightweight (`["alpine", "layered", "combo", "busybox", "app_v2"]`) so `--self-test` stays fast and never triggers heavy Docker pulls; `"python"` (`library/python:3.12-slim`) and `"node"` (`library/node:22-slim`) are loaded lazily via `registry.ensureBuiltinFixture("python" | "node")`.
- **Dual-Origin Mock Git Archive Server**: Ephemeral dual-port HTTP server (`e2e_docker_web/helpers/mock_git_server.mjs`) serving synthetic `.tar.gz` repo snapshots (`GET|HEAD /<repo>/archive/<ref>.tar.gz`) with cross-origin `302` CDN redirects that strictly reject leaked `Authorization` headers (`leakedAuthCount()`), custom `X-Git-Strip-Components`, commit/branch/tag/HEAD ref resolution, and deterministic error triggers (`404`, `429`, `500`, redirect loops, corrupt gzip, slow upstream).
- **Live Docker Hub & GitHub Coverage**: Tier 4 Scenarios `T4.5` (`alpine:latest`), `T4.9` (`python:3.12-slim` preset chip), `T4.12` (real GitHub repo `octocat/Hello-World` overlaid on live `alpine:latest`), and `T4.13` (all 3 dynamically discovered `.project-preset-chip` Python/JavaScript/Rust project test presets) test real end-to-end pulls and execution through a hardened `server/server.mjs` (without `--allow-local-registries`). All four are skipped when `--skip-live` is passed.
- **Strictly Opaque-Box**: Tests interact exclusively through HTTP endpoints (`server/server.mjs`, `/api/v2/*`, `/api/git/archive`), the public JS SDK (`/js/docker_sdk.mjs`, `/js/git_client.mjs`), the compiled `elf2wasm_runtime_wasm.wasm` C-ABI exports, and headless Google Chrome driving `/` (`web/index.html`). No internal Rust/JS implementation symbols are imported.

## 2. Prerequisites
- **Node.js**: `>= 22.0.0` (verified on `v22.23.5`)
- **Browser**: Google Chrome (`/usr/bin/google-chrome`; note `/usr/bin/chromium` is not required)
- **Docker Daemon**: Running locally for first-time extraction of `alpine:latest`, `busybox:musl`, `python:3.12-slim`, and `node:22-slim` base layers into `/tmp/elf2wasm-e2e-cache/` (repeat runs validate v2 cache metadata in <5ms)
- **Built System Under Test (for Tiers 1–4)**:
  - `target/wasm32-unknown-unknown/release/elf2wasm_compiler_wasm.wasm`
  - `target/wasm32-unknown-unknown/release/elf2wasm_runtime_wasm.wasm`
  - `server/server.mjs`
  - `js/docker_sdk.mjs` (and supporting `js/` modules)
  - `web/index.html` (and supporting `web/` assets)

## 3. Directory Layout
```text
e2e_docker_web/
├── run_all.mjs                    # Unified CLI runner (--tier 1|2|3|4|all, --self-test, --skip-live, --verbose, --json)
├── self_test.mjs                  # 6 infrastructure self-tests (ST-1..ST-6: ANSI, waitFor, tar_builder, mock OCI registry, Chrome CDP + Worker network, mock git archive server)
├── tier1_features.mjs             # Tier 1: Isolated feature happy paths (40 tests: Server, OCI Proxy, Git Proxy, git_client, Presets, SDK, Git Overlay, Alpine, Python 3.12, Node 22, /dev, /proc, #!, C-ABI)
├── tier2_boundaries.mjs           # Tier 2: Boundaries, security, error handling & stress (26 tests: OCI & Git SSRF, validation, upstream errors, tar traversal, whiteouts, -ENOEXEC, large I/O, UTF-8/binary, env overrides, latency bounds, SIGINT, EOF, resize)
├── tier3_combinations.mjs         # Tier 3: Cross-feature workflows (13 tests: multi-layer whiteout+symlink+PATH, pipelines+#!, VFS bridges, streaming+subprocess+pipes, multi-image isolation, offline tarball, Alpine/Python/Node git repo overlays + isolation)
├── tier4_scenarios.mjs            # Tier 4: Full headless Google Chrome E2E scenarios (13 scenarios: Alpine UI, window SDK, 2nd image, client-side+zero-CDN CDP proof, live Alpine, Python/Node presets+REPLs, preset switching, live Python, Git Overlay UI+CDP, Project Presets DOM, live GitHub overlay, live 3 Project Test Presets)
└── helpers/
    ├── test_runner.mjs            # Shared assertion helpers, ANSI stripper, waitFor, waitWithTimeout (timer-safe), structured suite reporter
    ├── tar_builder.mjs            # Pure-JS POSIX ustar tar & tar.gz builder (files, empty dirs, symlinks, hardlinks, whiteouts)
    ├── mock_oci_registry.mjs      # Dual-origin mock OCI v2 registry (Bearer auth, multi-arch index, 302 cross-origin blob CDN, multi-layer v2 /tmp cache, disk-backed streaming blobs, lazy ensureBuiltinFixture, OCI tarball exporter)
    ├── mock_git_server.mjs        # Dual-origin mock git archive server (commit/branch/tag/HEAD, HEAD method, 302 cross-origin CDN auth-stripping, X-Git-Strip-Components, error triggers, synthetic repo fixtures)
    ├── server_harness.mjs         # Ephemeral-port server/server.mjs launcher (hardened vs --allow-local-registries), health wait, prerequisite check
    └── cdp_browser.mjs            # Headless /usr/bin/google-chrome launcher (process-group cleanup + rmSync retries) & Node 22 WebSocket CDP client (Page, Runtime, Input, Network + Worker Target.setAutoAttach, input/image/project preset & terminal helpers)
```

## 4. Running the Suite

### Infrastructure Self-Test (runs independently of M1–M7)
```bash
node e2e_docker_web/run_all.mjs --self-test --verbose
```

### Sequential Per-Tier Execution (Recommended for M8 Gate)
```bash
node e2e_docker_web/run_all.mjs --tier 1 --verbose
node e2e_docker_web/run_all.mjs --tier 2 --verbose
node e2e_docker_web/run_all.mjs --tier 3 --verbose
node e2e_docker_web/run_all.mjs --tier 4 --verbose
```

### Full Suite Execution
```bash
node e2e_docker_web/run_all.mjs --tier all --verbose
```

### CLI Options & Exit Codes
- `--tier <1|2|3|4|all>`: Select tier(s) to execute (default: `all`).
- `--self-test`: Execute harness self-tests only (`e2e_docker_web/self_test.mjs`).
- `--skip-live`: Skip all live Docker Hub & GitHub Tier 4 scenarios (`T4.5`, `T4.9`, `T4.12`, `T4.13`) for strictly offline runs.
- `--verbose`: Stream detailed test progress and diagnostics.
- `--json <file>`: Write machine-readable JSON summary to `<file>`.
- `--help`: Print usage and exit `0`.

**Exit Codes**:
- `0`: All executed tests passed.
- `1`: One or more test assertions failed.
- `2`: Environment/prerequisite/CLI error (missing `.wasm` artifacts, missing `server/server.mjs`, missing Chrome binary, invalid CLI flags).

## 5. Requirement & Feature Traceability

| Source | Coverage |
|---|---|
| `ORIGINAL_REQUEST.md` (Docker-in-WASM web shell, Alpine default, `python:3.12-slim` & `node:22-slim` fixes and presets) | Tiers 1–4 (`T1.1.8`–`T1.1.9`, `T1.7.*`, `T1.8.*`, `T2.14`–`T2.21`, `T3.6`–`T3.9`, `T4.1`–`T4.9`) |
| **F1–F6** (WASM build, Alpine/musl, `NeedStdin=5`, live streaming, TTY `ioctl`, `SIGINT`, `/dev/*`, `/proc/*`, `#!`, `-ENOEXEC`, UID `0`, `X_OK`, `munmap`/reaped PID hygiene) | Tier 1 (`T1.1.3`, `T1.4.*`, `T1.5.*`, `T1.6.1`), Tier 2 (`T2.8`–`T2.13`), Tier 3 (`T3.2`, `T3.5`), Tier 4 (`T4.1`, `T4.5`) |
| **F7–F9** (Static server, COOP/COEP, `/wasm/*.wasm`, `/api/health`, OCI v2 Bearer proxy, cross-origin 302 auth-stripping, SSRF guard, mock registry) | Tier 1 (`T1.1.1`–`T1.1.7`, `T1.3.1`), Tier 2 (`T2.2`–`T2.5`), Tier 4 (`T4.4`, `T4.5`, `T4.9`) |
| **F10–F11** (OCI empty dirs, `.wh.*` & `.wh..wh..opq` whiteouts, dynamic linker, async CPS loop, child PID leak fix, OCI client, Web Worker, JS Docker SDK) | Tier 1 (`T1.2.1`–`T1.2.6`, `T1.4.8`), Tier 2 (`T2.1`, `T2.6`–`T2.10`), Tier 3 (`T3.1`–`T3.5`), Tier 4 (`T4.2`, `T4.4`) |
| **F12** (Self-hosted zero-CDN `web/index.html`, `#image-input` default `alpine:latest`, `#start-btn`/`#stop-btn`/`#clear-btn`, `#status-text`/`#progress-bar`, `#terminal`, `window.Elf2WasmDocker`/`window.runDockerImage`) | Tier 4 (`T4.1`–`T4.5`) |
| **F13–F16** (WASM release build, dynamic guest VA layout >256 MiB for `node`, large-binary compiler scaling, 64 KiB `.so` alignment & quantum/VFS perf) | Tier 1 (`T1.7.1`, `T1.8.1`), Tier 2 (`T2.14`–`T2.17`, `T2.21`), Tier 3 (`T3.6`–`T3.9`), Tier 4 (`T4.6`–`T4.8`) |
| **F17** (Canonical TTY echo & line editing `ICANON \| ECHO`) | Tier 1 (`T1.7.3`), Tier 4 (`T4.6`) |
| **F18** (Node.js/V8/libuv & Python syscalls/instructions, `RLIMIT_STACK`, `SYS_CAPGET`, `SYS_EPOLL_CTL`) | Tier 1 (`T1.8.1`–`T1.8.3`), Tier 2 (`T2.15`, `T2.17`–`T2.18`), Tier 3 (`T3.7`–`T3.8`), Tier 4 (`T4.7`–`T4.8`) |
| **F19** (Time-based `MessageChannel` macrotask yielding & `NeedStdin` race fix) | Tier 2 (`T2.19`, `T2.21`), Tier 3 (`T3.8`), Tier 4 (`T4.6` `< 15s` REPL latency, `T4.9`) |
| **F20** (Python `lib-dynload/*.so` core stdlib auto-bundling) | Tier 1 (`T1.7.2` all 12 stdlib modules), Tier 4 (`T4.6` `math`/`json`/`csv`/`hashlib`/`zlib`, `T4.9`) |
| **F21** (Node.js default `--jitless` / `MALLOC_ARENA_MAX` / `UV_*` env injection Contract §6 & VFS memory hygiene) | Tier 2 (`T2.20`), Tier 3 (`T3.9` zero env bleed), Tier 4 (`T4.7`–`T4.8`) |
| **F22** (Web UI presets for `python:3.12-slim` and `node:22-slim`) | Tier 1 (`T1.1.8`, `T1.1.9`), Tier 4 (`T4.6`, `T4.7`, `T4.8`, `T4.9`) |
| **F25–F26 / Contract §7** (Shared `git_core.mjs` repo/ref parser & validator, dual-runtime `GET\|HEAD /api/git/archive` streaming proxy, cross-origin 302 auth stripping, `X-Git-Strip-Components`, immutable/mutable `Cache-Control`, COOP/COEP/CORP/`nosniff`, SSRF guard, error propagation) | Self-Test (`ST-6`), Tier 1 (`T1.9.1`, `T1.9.2`), Tier 2 (`T2.22`, `T2.23`, `T2.24`), Tier 4 (`T4.10`, `T4.12`) |
| **F27 / Contract §8** (VFS tar overlay extraction with `mountPath`, `stripComponents`, `..` path-escape clamping, hardlink rebasing, relative symlink preservation, binary/UTF-8 integrity) | Tier 1 (`T1.9.6`, `T1.9.8`), Tier 2 (`T2.25`, `T2.26`), Tier 3 (`T3.10`–`T3.13`) |
| **F28 / Contract §9** (`js/git_client.mjs` `fetchGitArchive` streaming + client-side gzip decompression + progress stages, `Elf2WasmDocker` `gitProxyBase`, `createContainer`/`runDockerImage` `gitRepo` & offline `overlayTarBytes`, default `cwd`/`PWD` & isolation) | Tier 1 (`T1.9.3`, `T1.9.6`, `T1.9.7`, `T1.9.8`), Tier 2 (`T2.24`, `T2.26`), Tier 3 (`T3.10`–`T3.13`), Tier 4 (`T4.10`, `T4.12`) |
| **F29–F31 / Contract §10** (Web UI `#repo-input`/`#repo-ref-input`/`#repo-mount-input`, `#terminal-title`, `.project-presets-row` 3 Python/JS/Rust project test presets, backward-compatible 5 `.preset-chip` image presets with field reset, live 3-project test execution) | Tier 1 (`T1.9.4`, `T1.9.5`), Tier 4 (`T4.10`, `T4.11`, `T4.13`) |

## 6. Reliability, Memory & Cold-Compile Budgets
1. **No TTY Echo False Positives**: Interactive shell and REPL tests assert computed outputs (e.g., `print(20 + 22)` → `/(?:^|\n)42(?:\n|$)/`, `math.factorial(10)` → `3628800`, host-computed SHA-256 prefixes) after `stripAnsi()`, while separately asserting visible typed input for F17 canonical TTY echo.
2. **Fail-Fast Browser Boot Diagnostics**: `waitForRunStage()` and `waitForReplPrompt()` poll `#status-pill[data-state]` on every tick and throw immediately with `#status-text` + `#terminal` tail if `data-state === "error"`.
3. **Timer-Safe Timeouts & Cleanup**: Every container `wait()` uses `waitWithTimeout()` (clears its `setTimeout` in `.finally`), interactive containers always `stop()` in `try/finally`, and Chrome processes are terminated by process group `-proc.pid` with `rmSync` retries on `--user-data-dir`.
4. **Cold-Compile & Startup Latency Budgets (2 vCPUs / 7.8 GiB RAM)**:
   - `alpine:latest` / `busybox:musl`: `90s` cold-compile budget.
   - `python:3.12-slim`: `120s` cold-compile budget (`180s` live Docker Hub), `< 15s` warm startup (`T2.21`) and `< 15s` post-compile REPL prompt latency (`T4.6`, `T4.9`).
   - `node:22-slim`: `180s` cold-compile budget (38.5 MiB `.text` ELF + 232 MB rootfs), `< 30s` warm startup (`T2.21`).
   - Heavy Chrome scenarios launch fresh browser instances sequentially so Alpine, Python, and Node WASM heaps never coexist across scenarios.
5. **Hardened vs Local-Mock Server Isolation**: SSRF tests (`T2.3`, `T2.23`) and live Docker Hub / GitHub scenarios (`T4.5`, `T4.9`, `T4.12`, `T4.13`) spawn `server/server.mjs` **without** `--allow-local-registries`; offline mock-registry & mock-git-server tests spawn a separate ephemeral-port server **with** `--allow-local-registries`.
