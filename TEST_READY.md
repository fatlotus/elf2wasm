# E2E Test Suite Ready — Docker-on-WASM Web Platform

The requirement-driven, opaque-box, 4-tier E2E test suite (`e2e_docker_web/`) for the `elf2wasm` Client-Side Docker-on-WASM Web Platform is complete and has passed the full 5-agent Verification Gate (2 Reviewers + 2 Challengers + 1 Forensic Auditor — all green).

## Summary of Deliverables
- **Specification**: `TEST_INFRA.md`
- **Unified Runner**: `e2e_docker_web/run_all.mjs` (`--tier 1|2|3|4|all`, `--self-test`, `--skip-live`, `--verbose`, `--json <file>`, `--help`)
- **4-Tier Opaque-Box Suite (47 E2E tests + 5 live harness self-tests)**:
  - **Tier 1 (`e2e_docker_web/tier1_features.mjs`, 24 tests)**: Server static/WASM/health routes, COOP/COEP headers, OCI v2 Bearer auth & cross-origin 302 auth-stripping, JS SDK (`parseImageRef`, `Elf2WasmDocker`, `pullImage`, `loadOciTarball`, `createContainer`, `runDockerImage`), client-side execution proof (fetch spy + negative server probes), interactive shell commands, live streaming, UID `0`, `/dev/*`, `/proc/*`, `#!` + `X_OK`, and `runtime-wasm` §1 C-ABI export check.
  - **Tier 2 (`e2e_docker_web/tier2_boundaries.mjs`, 13 tests)**: Malformed image refs, 404 & upstream 500 -> 502, 10-host SSRF 403 matrix (hardened server), path traversal, invalid digests (400), empty directories, OCI `.wh.<name>` & `.wh..wh..opq` whiteouts, `-ENOEXEC`, exact 131,072-byte stdout streaming, 25 sequential forks (memory hygiene), `SIGINT` Ctrl-C, `closeStdin()` EOF, and `resize()` / `stty size`.
  - **Tier 3 (`e2e_docker_web/tier3_combinations.mjs`, 5 tests)**: Multi-layer OCI whiteouts + symlinks + `PATH`/`Env`/`WorkingDir`, pipelines + redirections + subshells + `#!` + `/dev/null` in TTY, host VFS `writeFile`/`readFile`, multi-image switching isolation (`alpine:latest` ↔ `custom/app:v2` ↔ `busybox:musl`), and offline `loadOciTarball` interactive TTY controls.
  - **Tier 4 (`e2e_docker_web/tier4_scenarios.mjs`, 5 headless Google Chrome CDP scenarios)**: Default Alpine interactive shell UI (`#image-input`, `#start-btn`, `#terminal`, `#clear-btn`, `#stop-btn`), programmatic `window.Elf2WasmDocker`/`window.runDockerImage`, second image launched from UI, strictly client-side + zero-CDN Page & Dedicated Web Worker CDP network audit, and live Docker Hub `alpine:latest` pull on a hardened server.
- **Helpers (`e2e_docker_web/helpers/`)**: `test_runner.mjs`, `tar_builder.mjs`, `mock_oci_registry.mjs`, `server_harness.mjs`, `cdp_browser.mjs` (uses `/usr/bin/google-chrome` via Node 22 native `WebSocket` CDP with `Target.setAutoAttach({ waitForDebuggerOnStart: true })` for race-free Worker network capture).

## M5 Sequential Execution Commands
Once M1–M4 are complete, run each tier sequentially:
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
