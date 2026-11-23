# E2E Test Infrastructure — elf2wasm Client-Side Docker-on-WASM Web Platform

## 1. Overview & Architecture
`e2e_docker_web/` is a **requirement-driven, opaque-box, 4-tier E2E test suite** derived strictly from `ORIGINAL_REQUEST.md` and `PROJECT.md` Interface Contracts (§1–§4) and Feature Inventory (F1–F12).

- **Zero external npm dependencies**: Built entirely on Node.js 22 built-ins (`node:http`, `node:zlib`, `node:crypto`, `node:fs`, `node:path`, `node:child_process`, `node:assert/strict`, native `WebSocket`, native `fetch`).
- **Real Headless Browser**: Drives `/usr/bin/google-chrome` (discovered dynamically via `CHROME_PATH` / `CHROME_BIN` → `/usr/bin/google-chrome` → `/usr/bin/google-chrome-stable` → `/usr/bin/chromium` → `/usr/bin/chromium-browser`) over Chrome DevTools Protocol (CDP), including Dedicated Web Worker network inspection via `Target.setAutoAttach` + `Network.enable`.
- **Self-Contained Opaque-Box Mock OCI v2 Registry**: Dual ephemeral-port HTTP server (`e2e_docker_web/helpers/mock_oci_registry.mjs`) implementing OCI Distribution v2 Bearer token negotiation (`401` + `WWW-Authenticate` + `/token`), multi-arch Image Indexes (`linux/arm64` + `unknown/unknown` attestation before `linux/amd64`), cross-origin `302` blob redirects to a separate blob origin that strictly rejects leaked `Authorization` headers, and deterministic multi-layer fixtures cached from local Docker (`alpine:latest`, `busybox:musl`) into `/tmp/elf2wasm-e2e-cache/`.
- **Live Docker Hub Coverage**: Tier 4 Scenario 4.5 tests a real end-to-end pull and interactive shell execution of `alpine:latest` from `registry-1.docker.io` through a hardened `server/server.mjs` (without `--allow-local-registries`).
- **Strictly Opaque-Box**: Tests interact exclusively through HTTP endpoints (`server/server.mjs`), the public JS SDK (`/js/docker_sdk.mjs`), the compiled `elf2wasm_runtime_wasm.wasm` C-ABI exports, and headless Google Chrome driving `/` (`web/index.html`). No internal Rust/JS implementation symbols are imported.

## 2. Prerequisites
- **Node.js**: `>= 22.0.0` (verified on `v22.23.5`)
- **Browser**: Google Chrome (`/usr/bin/google-chrome`, verified on `158.0.8127.36`; note `/usr/bin/chromium` is not required)
- **Docker Daemon**: Running locally for first-time extraction of `alpine:latest` and `busybox:musl` base layers into `/tmp/elf2wasm-e2e-cache/` (repeat runs use cache in <5ms)
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
├── self_test.mjs                  # Infrastructure self-test (tar builder, mock OCI registry, auth-stripping, Chrome CDP + Worker network)
├── tier1_features.mjs             # Tier 1: Isolated feature happy paths (21+ tests across Server, Proxy, SDK, Shell, /dev, /proc, #!, C-ABI)
├── tier2_boundaries.mjs           # Tier 2: Boundaries, security, error handling & stress (13+ tests: SSRF, traversal, whiteouts, -ENOEXEC, 128KB stdout, 25 forks, SIGINT, EOF, resize)
├── tier3_combinations.mjs         # Tier 3: Cross-feature workflows (5+ tests: multi-layer whiteout+symlink+PATH, pipelines+redirs+#!, VFS readFile/writeFile, multi-image switching, offline tarball)
├── tier4_scenarios.mjs            # Tier 4: Full headless Google Chrome E2E scenarios (5 scenarios: Alpine UI shell, window.runDockerImage/Elf2WasmDocker, 2nd image UI, client-side+zero-CDN CDP proof, live Docker Hub alpine:latest)
└── helpers/
    ├── test_runner.mjs            # Shared assertion helpers, ANSI stripper, polling waiter, structured suite reporter
    ├── tar_builder.mjs            # Pure-JS POSIX ustar tar & tar.gz builder (files, empty dirs, symlinks, hardlinks, whiteouts)
    ├── mock_oci_registry.mjs      # Dual-origin mock OCI v2 registry (Bearer auth, multi-arch index, 302 cross-origin blob CDN, error routes, /tmp cache, OCI tarball exporter)
    ├── server_harness.mjs         # Ephemeral-port server/server.mjs launcher (hardened vs --allow-local-registries), health wait, request log capture, prerequisite check
    └── cdp_browser.mjs            # Headless /usr/bin/google-chrome launcher (process-group cleanup + rmSync retries) & Node 22 WebSocket CDP client (Page, Runtime, Input, Network + Worker Target.setAutoAttach)
```

## 4. Running the Suite

### Infrastructure Self-Test (runs independently of M1–M4)
```bash
node e2e_docker_web/run_all.mjs --self-test
```

### Sequential Per-Tier Execution (Recommended for M5 Gate)
```bash
node e2e_docker_web/run_all.mjs --tier 1
node e2e_docker_web/run_all.mjs --tier 2
node e2e_docker_web/run_all.mjs --tier 3
node e2e_docker_web/run_all.mjs --tier 4
```

### Full Suite Execution
```bash
node e2e_docker_web/run_all.mjs --tier all
```

### CLI Options & Exit Codes
- `--tier <1|2|3|4|all>`: Select tier(s) to execute (default: `all`).
- `--self-test`: Execute harness self-tests only (`e2e_docker_web/self_test.mjs`).
- `--skip-live`: Skip Tier 4 Scenario 4.5 (live Docker Hub pull) for strictly offline runs.
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
| `ORIGINAL_REQUEST.md` (JS on-demand Docker-in-WASM, HTML interactive shell home page, Alpine default, client-side compile/exec) | Tiers 1, 3, and 4 (Scenarios 4.1–4.5) |
| **F1–F6** (WASM build, Alpine/musl, `NeedStdin=5`, live streaming, TTY `ioctl`, `SIGINT`, `/dev/*`, `/proc/*`, `#!`, `-ENOEXEC`, UID `0`, `X_OK`, `munmap`/reaped PID hygiene) | Tier 1 (T1.1.3, T1.4.*, T1.5.*, T1.6.1), Tier 2 (T2.8–T2.13), Tier 3 (T3.2, T3.5), Tier 4 (T4.1, T4.5) |
| **F7–F9** (Static server, COOP/COEP, `/wasm/*.wasm`, `/api/health`, OCI v2 Bearer proxy, cross-origin 302 auth-stripping, SSRF guard, mock registry) | Tier 1 (T1.1.1–T1.1.7, T1.3.1), Tier 2 (T2.2–T2.5), Tier 4 (T4.4, T4.5) |
| **F10–F11** (OCI empty dirs, `.wh.*` & `.wh..wh..opq` whiteouts, dynamic linker, async CPS loop, child PID leak fix, OCI client, Web Worker, JS Docker SDK) | Tier 1 (T1.2.1–T1.2.6, T1.4.8), Tier 2 (T2.1, T2.6–T2.10), Tier 3 (T3.1–T3.5), Tier 4 (T4.2, T4.4) |
| **F12** (Self-hosted zero-CDN `web/index.html`, `#image-input` default `alpine:latest`, `#start-btn`/`#stop-btn`/`#clear-btn`, `#status-text`/`#progress-bar`, `#terminal`, `window.Elf2WasmDocker`/`window.runDockerImage`) | Tier 4 (T4.1–T4.5) |

## 6. Reliability & Anti-Flake Design
1. **No TTY Echo False Positives**: Interactive shell tests assert computed outputs (e.g., `echo $((20+22))` → `42`, `printf "%s_%s\n" OUT OK` → `OUT_OK`) and strip ANSI CSI/OSC sequences before matching.
2. **Web Worker CDP Network Capture**: `cdp_browser.mjs` enables `Target.setAutoAttach({ autoAttach: true, waitForDebuggerOnStart: true, flatten: true })`, attaches `Network.enable` and `Runtime.enable` on every Worker session before calling `Runtime.runIfWaitingForDebugger`, ensuring zero dropped fetches from `js/container_worker.mjs` in Scenario 4.4.
3. **Clean Chrome Process-Group Teardown**: Chrome is spawned `detached: true`; teardown sends `SIGTERM`/`SIGKILL` to `-proc.pid`, awaits exit, and removes `--user-data-dir` with retries (`maxRetries: 10, retryDelay: 100`).
4. **Hardened vs Local-Mock Server Isolation**: SSRF tests (T2.3) and live Docker Hub (T4.5) spawn `server/server.mjs` **without** `--allow-local-registries`; offline mock-registry tests spawn a separate ephemeral-port server **with** `--allow-local-registries`.
5. **Sequential Execution & Cold-Compile Budgets**: On 2 vCPUs / 7.8 GiB RAM, browser scenarios run sequentially with 90s cold-compile timeouts and 250ms polling (no brittle fixed sleeps).
