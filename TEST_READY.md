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
