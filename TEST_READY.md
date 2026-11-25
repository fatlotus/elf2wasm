# E2E Test Suite Ready — Docker-on-WASM Web Platform (Alpine, Python 3.12, Node 22)

The requirement-driven, opaque-box, 4-tier E2E test suite (`e2e_docker_web/`) for the `elf2wasm` Client-Side Docker-on-WASM Web Platform has been expanded to cover `python:3.12-slim` and `node:22-slim` (Features F13–F22, Contracts §5–§6) while preserving 100% of all 47 existing Alpine/BusyBox/Docker-on-WASM E2E tests and all 5 infrastructure self-tests.

## Summary of Deliverables
- **Specification**: `TEST_INFRA.md`
- **Unified Runner**: `e2e_docker_web/run_all.mjs` (`--tier 1|2|3|4|all`, `--self-test`, `--skip-live`, `--verbose`, `--json <file>`, `--help`)
- **4-Tier Opaque-Box Suite (71 E2E tests + 5 live harness self-tests)**:
  - **Self-Test (`e2e_docker_web/self_test.mjs`, 5 tests: `ST-1`..`ST-5`)**: ANSI stripper, `waitFor`, POSIX ustar `tar_builder.mjs`, dual-origin `mock_oci_registry.mjs` (Bearer auth, multi-arch index, 302 cross-origin auth-stripping, synthetic multi-layer disk-backed `filePath` streaming + `HEAD` + `getOciTarball`), and headless Google Chrome CDP + Dedicated Web Worker network capture.
  - **Tier 1 (`e2e_docker_web/tier1_features.mjs`, 32 tests = 24 existing + 8 new)**: Server static/WASM/health routes, COOP/COEP headers, OCI v2 Bearer auth & cross-origin 302 auth-stripping, `.presets-row` HTML & Chrome CDP preset-chip clicks (`T1.1.8`, `T1.1.9`), JS SDK, client-side execution proof, Alpine interactive shell & streaming, `/dev/*`, `/proc/*`, `#!` + `X_OK`, `runtime-wasm` §1 C-ABI export check, `python:3.12-slim` script / 12-module stdlib / interactive `>>> ` REPL with canonical TTY echo (`T1.7.1`–`T1.7.3`), and `node:22-slim` script / 7 core built-ins / interactive `> ` REPL (`T1.8.1`–`T1.8.3`).
  - **Tier 2 (`e2e_docker_web/tier2_boundaries.mjs`, 21 tests = 13 existing + 8 new)**: Malformed image refs, 404 & upstream 500 -> 502, 10-host SSRF 403 matrix (hardened server), path traversal, invalid digests (400), empty directories, OCI `.wh.<name>` & `.wh..wh..opq` whiteouts, `-ENOEXEC`, exact 131,072-byte Alpine stdout, 25 sequential forks, `SIGINT`, `closeStdin()` EOF, `resize()` / `stty size`, Python & Node non-zero exit codes/stderr (`T2.14`, `T2.15`), >128 KiB stdout & 64 KiB SHA-256 stdin piping (`T2.16`, `T2.17`), UTF-8 multi-byte I/O (`T2.18`), Python `PYTHONUNBUFFERED=1` & custom env overrides (`T2.19`), Node Contract §6 default env injection & strict user overrides (`T2.20`), and warm startup latency bounds (`T2.21`: Python < 15s, Node < 30s).
  - **Tier 3 (`e2e_docker_web/tier3_combinations.mjs`, 9 tests = 5 existing + 4 new)**: Multi-layer OCI whiteouts + symlinks + `PATH`/`Env`/`WorkingDir`, pipelines + redirections + subshells + `#!` + `/dev/null` in TTY, host VFS `writeFile`/`readFile` for Alpine (`T3.3`), Python (`T3.6`), and Node (`T3.7`), multi-image switching isolation (`T3.4`, `T3.9`: `alpine` -> `python` -> `node` -> `alpine` with zero VFS/env bleed), offline `loadOciTarball` interactive TTY controls (`T3.5`), and live stdin-to-stdout streaming + Python `subprocess.run` + `/bin/sh | node` POSIX pipe (`T3.8`).
  - **Tier 4 (`e2e_docker_web/tier4_scenarios.mjs`, 9 headless Google Chrome CDP scenarios = 5 existing + 4 new)**: Default Alpine interactive shell UI (`T4.1`), programmatic `window.Elf2WasmDocker`/`window.runDockerImage` (`T4.2`), second image from UI (`T4.3`), strictly client-side + zero-CDN Page & Dedicated Web Worker CDP network audit (`T4.4`), live Docker Hub `alpine:latest` on hardened server (`T4.5`), `python:3.12-slim` preset chip + `<15s` post-compile REPL latency + canonical TTY echo + `json`/`csv`/`hashlib`/`zlib` workload (`T4.6`), `node:22-slim` preset chip + `> ` REPL + `JSON`/`crypto`/`fs`/`Buffer` workload (`T4.7`), in-tab Web UI preset switching `alpine` -> `python` -> `node` (`T4.8`), and live Docker Hub `python:3.12-slim` preset chip boot on hardened server (`T4.9`).
- **Helpers (`e2e_docker_web/helpers/`)**: `test_runner.mjs` (`waitWithTimeout`), `tar_builder.mjs`, `mock_oci_registry.mjs` (multi-layer `tar -xf` v2 `/tmp` cache, disk-backed streaming blobs, lazy `ensureBuiltinFixture("python"|"node")`), `server_harness.mjs`, `cdp_browser.mjs` (`getPresetChips`, `clickPresetChip`, `waitForTerminalText`, `sendControlKey`).

## Python & Node Feature Coverage Checklist
- [x] `python:3.12-slim` & `node:22-slim` preset chips in `.presets-row` + default `alpine:latest` preserved (`T1.1.8`, `T1.1.9`, `T4.6`–`T4.9`)
- [x] `python:3.12-slim` script execution, 12 core stdlib modules (`lib-dynload/*.so`), interactive `>>> ` REPL, canonical TTY echo (`T1.7.1`–`T1.7.3`, `T4.6`)
- [x] `node:22-slim` script execution, 7 core built-ins, interactive `> ` REPL, Contract §6 default `--jitless` env injection & user override (`T1.8.1`–`T1.8.3`, `T2.20`, `T4.7`)
- [x] Error exit codes, stderr tracebacks/syntax errors, >128 KiB stdout & 64 KiB stdin SHA-256 integrity, UTF-8 multi-byte I/O, unbuffered streaming (`T2.14`–`T2.19`)
- [x] Startup latency regression guards: warm Python `< 15s`, warm Node `< 30s`, Chrome post-compile Python REPL `< 15s` (`T2.21`, `T4.6`, `T4.9`)
- [x] Host VFS `writeFile`/`readFile` persistence, `subprocess.run`, `/bin/sh | node` POSIX pipes, clean multi-image & UI preset switching (`T3.6`–`T3.9`, `T4.8`)
- [x] Live Docker Hub verification on hardened server for `alpine:latest` and `python:3.12-slim` (`T4.5`, `T4.9`, skippable with `--skip-live`)

## M8 Sequential Execution Commands
Once M6 & M7 are complete, run each tier sequentially:
```bash
node e2e_docker_web/run_all.mjs --self-test --verbose
node e2e_docker_web/run_all.mjs --tier 1 --verbose
node e2e_docker_web/run_all.mjs --tier 2 --verbose
node e2e_docker_web/run_all.mjs --tier 3 --verbose
node e2e_docker_web/run_all.mjs --tier 4 --verbose
```

Or run the entire suite in one command:
```bash
node e2e_docker_web/run_all.mjs --tier all --verbose
```

For strictly offline verification (skipping live Docker Hub `T4.5` & `T4.9`):
```bash
node e2e_docker_web/run_all.mjs --tier all --skip-live --verbose
```

## Git Repo Overlay & Project Presets E2E Ready

The opaque-box 4-tier E2E test suite (`e2e_docker_web/`) has been expanded to cover **Git Repo Overlay & Project Test Presets** (Features F25–F31, Contracts §7–§10) with **+21 new E2E tests** and **+1 new infrastructure self-test** (**92 E2E tests + 6 self-tests = 98 total**), preserving 100% of all 71 existing E2E tests and 5 existing self-tests untouched.

### Coverage Summary
- **New Helper (`e2e_docker_web/helpers/mock_git_server.mjs`)**: Dual-origin mock git archive server (primary forge + separate-origin CDN with strict `Authorization` leak rejection, commit/branch/tag/HEAD ref resolution, `HEAD` method, custom `X-Git-Strip-Components`, deterministic error triggers, and 6 built-in synthetic `.tar.gz` repo fixtures).
- **Updated Helper (`e2e_docker_web/helpers/cdp_browser.mjs`)**: Backward-compatible `getInputValue`, `getProjectPresetChips`, and `clickProjectPresetChip` methods.
- **Self-Test (`e2e_docker_web/self_test.mjs`, 6 tests = 5 existing + `ST-6`)**: `ST-6` verifies `mock_git_server.mjs` ref resolution, `HEAD`, 302 cross-origin auth-stripping, `X-Git-Strip-Components: 0`, error triggers, and fixture archive integrity.
- **Tier 1 (`e2e_docker_web/tier1_features.mjs`, 40 tests = 32 existing + `T1.9.1`–`T1.9.8`)**:
  - `T1.9.1`–`T1.9.2`: `GET`/`HEAD /api/git/archive` for 40-char SHA, branch, tag, and default `HEAD` with `X-Git-Archive-Format`, `X-Git-Strip-Components`, immutable/mutable `Cache-Control`, COOP/COEP/CORP/`nosniff`, and 302 auth-stripping.
  - `T1.9.3`: `GET /js/git_client.mjs` + dynamic import `fetchGitArchive` streaming, client-side gzip decompression, and `"git-download"` / `"git-decompress"` progress stages.
  - `T1.9.4`–`T1.9.5`: Static HTML & headless Chrome DOM contract for `#repo-input`, `#repo-ref-input`, `#repo-mount-input` (`/workspace`), 3 `.project-preset-chip` (Python, JavaScript, Rust), and backward-compatible 5 `.preset-chip` image presets with full field reset.
  - `T1.9.6`–`T1.9.8`: `createContainer({ gitRepo })` (`/workspace` & custom `mountPath`, default `cwd`/`PWD`, hardlink rebasing, relative symlink preservation), `runDockerImage(..., { gitRepo })`, and offline `overlayTarBytes` with zero git network calls.
- **Tier 2 (`e2e_docker_web/tier2_boundaries.mjs`, 26 tests = 21 existing + `T2.22`–`T2.26`)**:
  - `T2.22`: Input validation `400` JSON matrix for missing/invalid `repo` and `ref`.
  - `T2.23`: SSRF `403` matrix on hardened `/api/git/archive` (loopback, private, link-local, live mock URL).
  - `T2.24`: Upstream error propagation (`404`, `429`, `500 -> 502`, connection refused `-> 502`) & SDK rejection.
  - `T2.25`–`T2.26`: Tar overlay `..` path traversal containment to `mountPath`, `stripComponents` root-entry skipping, explicit `cwd` override, and 4 KiB binary + UTF-8 byte-for-byte integrity.
- **Tier 3 (`e2e_docker_web/tier3_combinations.mjs`, 13 tests = 9 existing + `T3.10`–`T3.13`)**:
  - `T3.10`: Alpine + git repo overlay (branch `main` vs pinned 40-char SHA) running shell test script in `/workspace`.
  - `T3.11`: `python:3.12-slim` + synthetic Python project git repo overlay running `python3 -m unittest discover -s tests -v`.
  - `T3.12`: `node:22-slim` + synthetic JavaScript project git repo overlay running `node --test --experimental-test-isolation=none`.
  - `T3.13`: Custom `mountPath` + `env`/`cmd` overrides + host `readFile`/`writeFile` + zero `/workspace` bleed on plain container.
- **Tier 4 (`e2e_docker_web/tier4_scenarios.mjs`, 13 scenarios = 9 existing + `T4.10`–`T4.13`)**:
  - `T4.10` (offline): Web UI Git Repo Overlay workflow, `#terminal-title`, and CDP network audit (same-origin, zero POST, `/api/git/archive` 200, `.wasm` 200).
  - `T4.11` (offline): Web UI `.project-presets-row` (3 ecosystems) & `.presets-row` (5 preserved image presets + field reset) DOM contract.
  - `T4.12` (live, `--skip-live`): Real GitHub repo `octocat/Hello-World` @ pinned SHA streamed through hardened `/api/git/archive` (plus SSRF 403 check) and overlaid on live `alpine:latest` via `window.runDockerImage`.
  - `T4.13` (live, `--skip-live`): Dynamically discovers all 3 `.project-preset-chip[data-preset]` buttons (Python, JavaScript, Rust) and runs each sequentially in a fresh headless Chrome instance on a hardened server.

### Git Repo Overlay & Project Presets Feature Checklist
- [x] **F25–F26 / Contract §7**: `GET|HEAD /api/git/archive` ref/repo parsing, validation (`400`), SSRF guard (`403`), upstream error mapping (`404`/`429`/`502`), 302 auth-stripping, `X-Git-Strip-Components`, immutable/mutable `Cache-Control`, COOP/COEP/CORP/`nosniff` (`ST-6`, `T1.9.1`–`T1.9.2`, `T2.22`–`T2.24`, `T4.10`, `T4.12`)
- [x] **F27 / Contract §8**: VFS tar overlay with `mountPath`, `stripComponents`, `..` traversal clamping, hardlink rebasing, relative symlink preservation, binary/UTF-8 integrity (`T1.9.6`, `T1.9.8`, `T2.25`–`T2.26`, `T3.10`–`T3.13`)
- [x] **F28 / Contract §9**: `js/git_client.mjs` `fetchGitArchive` + client-side gzip + progress stages, `Elf2WasmDocker` `gitProxyBase`, `gitRepo` & offline `overlayTarBytes`, default `cwd`/`PWD` & container isolation (`T1.9.3`, `T1.9.6`–`T1.9.8`, `T2.24`, `T2.26`, `T3.10`–`T3.13`, `T4.10`, `T4.12`)
- [x] **F29–F31 / Contract §10**: Web UI `#repo-input`/`#repo-ref-input`/`#repo-mount-input`, `#terminal-title`, 3 Python/JS/Rust `.project-preset-chip` buttons, backward-compatible 5 `.preset-chip` buttons with reset, and live execution of all 3 project test presets (`T1.9.4`–`T1.9.5`, `T4.10`–`T4.11`, `T4.13`)

### M13 Sequential Execution Commands
```bash
node e2e_docker_web/run_all.mjs --self-test --verbose
node e2e_docker_web/run_all.mjs --tier 1 --verbose
node e2e_docker_web/run_all.mjs --tier 2 --verbose
node e2e_docker_web/run_all.mjs --tier 3 --verbose
node e2e_docker_web/run_all.mjs --tier 4 --verbose
```

For strictly offline verification (skipping live Docker Hub & GitHub scenarios `T4.5`, `T4.9`, `T4.12`, `T4.13`):
```bash
node e2e_docker_web/run_all.mjs --tier all --skip-live --verbose
```

---

## Delay Injection, Build/Run Split & Sweep Mode E2E Ready (F41 — M19 Gate)

The requirement-driven, **opaque-box** 4-tier E2E test suite for **Deterministic Simulated-Time Delay Injection, Build/Run Command Split, Sweep Mode, and Linkable Sweep / Per-Run URLs** (Feature F41, Contracts §11–§13) is complete and verified (**60 E2E tests across Tiers 1–4 + 6 harness self-tests**), preserving 100% of all prior `e2e_docker_web/` suites and helpers untouched.

### Deliverables
- **Specification**: `TEST_INFRA.md` (Section 7)
- **Dedicated Runner**: `e2e_docker_web/run_delay_sweep_e2e.mjs` (`--tier <1|2|3|4|all>`, `--self-test`, `--skip-live`, `--verbose`, `--json <file>`, `--help`; exit codes `0` pass, `1` test failure, `2` prereq/CLI error)
- **Shared Fixtures & Helpers**: `e2e_docker_web/delay_sweep_helpers.mjs` (cached static x86-64 C TCP/epoll/clock/nanosleep probe compiled via `gcc -O2 -static`, mock OCI image `delay-sweep/probe-alpine:v1`, mock Git repo `acme/sweep-proj`, Chrome CDP DOM/sweep wait helpers, and 6 harness self-tests `DS-ST-1`..`DS-ST-6`)
- **Tier 1 (`e2e_docker_web/test_delay_sweep_tier1.mjs`, 26 tests)**:
  - Delay Injection & Simulated Time (`DS-T1.1.1`–`DS-T1.1.7`): bit-for-bit determinism across SDK/exec/CLI, seed/stddev perturbation, large simulated delay (`stddev=5000ms`) fast wall-clock execution with `virtualTimeNs` advance, `stddev=0` baseline, JS + native CLI (`translate` -> `run`) flags.
  - Build vs Run Split (`DS-T1.2.1`–`DS-T1.2.6`): build runs once at `stddev=0`, post-build VFS snapshot preservation, clean snapshot isolation across runs, failed build aborts before sweep (`runs: []`, `passed: false`), relative `./prog` in `cwd`, manual `snapshotVfs`/`restoreVfs`/`dropVfsSnapshot`.
  - Sweep Mode (`DS-T1.3.1`–`DS-T1.3.6`): passing sweep with `round3(stddevStart + i * stddevStep)` & `seedStart + i`, immediate stop on first failure, callback ordering (`onBuildOutput`/`onRunStart`/`onRunOutput`/`onRunComplete`), standalone bit-for-bit reproduction of failing sweep run.
  - URL Linking (`DS-T1.4.1`–`DS-T1.4.7`): `parseStateFromSearch`/`serializeStateToSearch` sweep round-trip, `computeSweepRunParams`, `buildRunSearch` standalone reproducer URL, Chrome CDP sweep & single-run hydration without auto-boot, backward compatibility with exact `ORIGINAL_REQUEST.md` `?cmd=` URL, `go-raft-nodice` preset chip.
- **Tier 2 (`e2e_docker_web/test_delay_sweep_tier2.mjs`, 26 tests)**:
  - Delay Injection boundaries (`DS-T2.1.1`–`DS-T2.1.7`): `stddev=0` + non-zero seed, fractional `0.001`/`0.5` ms, large `60000` ms, `seed=0`, `Number.MAX_SAFE_INTEGER`, negative/`NaN`/`Infinity` handling, CLI invalid flag rejection.
  - Build/Run Split boundaries (`DS-T2.2.1`–`DS-T2.2.6`): omitted/empty `buildCmd` (`skipped: true`), custom `env`/`cwd`, nested dirs + symlinks, self-deleting run artifact, missing build binary, invalid `snapshotId`.
  - Sweep Mode boundaries (`DS-T2.3.1`–`DS-T2.3.6`): `runs=1`, `stddevStart=0` + `stddevStep=0`, failure on run 1, failure on run `N`, `stopOnFailure: false`, `AbortSignal` cancellation + per-run `timeoutMs`.
  - URL Linking boundaries (`DS-T2.4.1`–`DS-T2.4.7`): `?run=` read alias & canonical `cmd=` precedence, default omission, unmanaged param + `#hash` preservation, invalid/negative/`NaN` query sanitization, `selectedRun` bounds, XSS payload immunity in Chrome CDP, plain `.preset-chip` reset compatibility.
- **Tier 3 (`e2e_docker_web/test_delay_sweep_tier3.mjs`, 5 offline pairwise tests)**:
  - `T3-DS-1`: Build/Run split + Sweep + Clean Snapshot Isolation + Standalone Deterministic Reproduction.
  - `T3-DS-2`: Git Repo Overlay (mock git server) + Build/Run Split + relative `./app` `cwd` + Sweep + Failed-Build Abort.
  - `T3-DS-3`: Chrome CDP Sweep URL hydration -> `#sweep-panel` / `#sweep-results-body` row click (`selectedRun` URL sync) -> `<a class="run-link">` standalone reproducer navigation & exact reproduction.
  - `T3-DS-4`: `button.project-preset-chip[data-preset="go-raft-nodice"]` URL/reload hydration vs plain `.preset-chip` reset.
  - `T3-DS-5`: Backward-compatible `?cmd=` / `?run=` coexistence, `#copy-sweep-link-btn`, and `popstate` transitions.
- **Tier 4 (`e2e_docker_web/test_delay_sweep_tier4.mjs`, 3 real-world scenarios)**:
  - `T4-DS-1` (offline): Realistic multi-connection TCP loopback concurrency race sweep with `SLEEP_MS=15000` (`ELAPSED_NS >= 15_000_000_000n`, strict `sweepWallMs < totalSimMs`) + standalone deterministic reproduction.
  - `T4-DS-2` (offline): Full Chrome CDP sweep-to-reproducer user journey with Git repo overlay & Dedicated Web Worker verification.
  - `T4-DS-3` (live, skipped only via `--skip-live`): Real `ghcr.io/fatlotus/golang-with-cache:1.27-alpine` + `fatlotus/nodice` (`/workspace/example`, `buildCmd: ["go", "build"]`, `runCmd: ["./raft"]`) sweep finding `INVARIANT VIOLATION (Committed Log Truncation Race)` with build-once, immediate stop-on-failure, simulated time (`virtualTimeNs > 0`), and standalone deterministic reproduction of the exact failing `(stddevMs, seed)`.

### M19 Execution Commands
Once M16–M18 are complete, verify harness + all 4 tiers:
```bash
node e2e_docker_web/run_delay_sweep_e2e.mjs --self-test --verbose
node e2e_docker_web/run_delay_sweep_e2e.mjs --tier 1 --verbose
node e2e_docker_web/run_delay_sweep_e2e.mjs --tier 2 --verbose
node e2e_docker_web/run_delay_sweep_e2e.mjs --tier 3 --verbose
node e2e_docker_web/run_delay_sweep_e2e.mjs --tier 4 --verbose
```

Or run all 4 tiers in one command (add `--skip-live` for strictly offline verification skipping `T4-DS-3`):
```bash
node e2e_docker_web/run_delay_sweep_e2e.mjs --tier all --verbose
```

