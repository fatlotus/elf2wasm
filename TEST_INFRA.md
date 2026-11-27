# elf2wasm E2E Test Infrastructure (`TEST_INFRA.md`)

## Overview
`e2e_docker_web/` provides a **zero-dependency**, requirement-driven, opaque-box End-to-End (E2E) test suite built on Node.js 22 native `fetch`, `WebSocket` (Chrome DevTools Protocol), `zlib`, and `node:assert/strict`. It requires no Playwright, Puppeteer, or npm packages.

## Test Architecture
- **Headless Chrome CDP Controller (`e2e_docker_web/helpers/cdp_browser.mjs`)**:
  - Launches headless Chrome with isolated temporary user-data directories.
  - Emulates OS color schemes via `Emulation.setEmulatedMedia` (`prefers-color-scheme: light | dark`), mobile viewports via `Emulation.setDeviceMetricsOverride` (`390x844`), computes WCAG 2.1 relative luminance & contrast ratios (`parseRgb`, `relativeLuminance`, `contrastRatio`), and captures real browser file downloads via `Browser.setDownloadBehavior` + `downloadWillBegin`/`downloadProgress`.
- **Semantic Opaque-Box UI Helpers (`e2e_docker_web/helpers/v2_ui_helpers.mjs`)**:
  - Interacts with the developer-tool UI via accessible labels, roles, semantic HTML (`<textarea>`, `<button>`, `<select>`, `<table>`), and `data-*` attributes rather than brittle presentation classes.
- **Remote Evaluation API Client (`e2e_docker_web/helpers/eval_client.mjs`)**:
  - Exercises `POST /api/eval` for both JSON responses (`postEvalJson`) and direct `.tar.gz` downloads (`postEvalTarGz` via `Accept: application/gzip` and `?format=tar.gz`), verifying gzip magic bytes (`0x1f 0x8b`) and parsing USTAR/PAX/GNU tar entries (`encodeTarGzBase64`, `decodeTarGzBase64`).
- **Offline Mock Fixtures (`e2e_docker_web/helpers/mock_oci_registry.mjs`, `mock_git_server.mjs`, `tar_builder.mjs`, `server_harness.mjs`)**:
  - Dual-origin mock OCI v2 registry (serving `library/alpine:latest` offline), mock Git archive server, pure-JS POSIX USTAR tar/tar.gz builder & parser (with OCI `.wh.<name>` whiteout support), and local `server/server.mjs` harness supporting both `--allow-local-registries` and strict SSRF-protected modes.

## Feature Traceability Matrix (F1–F14)

| Feature | Requirement Summary | Tier(s) | Test IDs |
|---------|---------------------|---------|----------|
| F1 | Repo cleanup (legacy paths removed, virtual workspace `Cargo.toml`, interactive tools retained) | Tier 1 | `T1-V2.1` |
| F2 | Toolchain & built WASM/server prerequisites | Runner | `checkPrerequisites()` |
| F3 | VFS diff & USTAR tar export with OCI `.wh.<name>` whiteouts & `modifiedFiles` manifest | Tier 1, 2 | `T1-V2.7`, `T1-V2.8`, `T2-V2.2` |
| F4 | Compact memory & `wasmi` Worker interpreter deterministic parity with browser | Tier 3 | `T3-V2.2` |
| F5 | Remote layer evaluation API (`POST /api/eval` JSON, direct `.tar.gz`, errors, whiteouts) | Tier 1, 2, 3, 4 | `T1-V2.7`, `T1-V2.8`, `T2-V2.1`, `T2-V2.2`, `T3-V2.2`, `T4-V2.5` |
| F6 | Local dev server (`server/server.mjs`) `/api/eval` parity & COOP/COEP/SSRF enforcement | Tier 1, 2 | `T1-V2.7`, `T1-V2.8`, `T2-V2.1` |
| F7 | Bidirectional Dockerfile parser & serializer (`web/dockerfile.mjs`) & invalid recovery | Tier 1, 2, 3 | `T1-V2.5`, `T2-V2.3`, `T3-V2.1` |
| F8 | Multi-layer stack execution (`FROM+GIT+WORKDIR+ENV+RUN`) & mixed local/remote diff handoff | Tier 3, 4 | `T3-V2.1`, `T3-V2.2`, `T3-V2.3`, `T4-V2.1` |
| F9 | Generalized `SWEEP` across downstream layers (`env`, `delay`, `seed` in list & range modes) | Tier 2, 3 | `T2-V2.4`, `T3-V2.4`, `T3-V2.5` |
| F10 | URL state round-trip preserving Dockerfile, sweep config, and execution targets | Tier 3 | `T3-V2.6` |
| F11 | System-default Light/Dark theme (`prefers-color-scheme`), WCAG AA contrast (`>= 4.5`), persistence, mobile responsiveness | Tier 1, 2, 4 | `T1-V2.2`, `T1-V2.3`, `T2-V2.5`, `T4-V2.1` |
| F12 | Visual Layer Builder <-> Dockerfile text bidirectional sync | Tier 1, 2, 3 | `T1-V2.5`, `T2-V2.3`, `T3-V2.1`, `T3-V2.4`, `T3-V2.5` |
| F13 | Global "Run All Locally" / "Run All Remotely", per-layer selectors & browser `.tar.gz` download | Tier 1, 2, 3, 4 | `T1-V2.6`, `T2-V2.5`, `T3-V2.3`, `T4-V2.1` |
| F14 | Well-known presets (Express.js, Flask; zero Bottle / Nano ID / Nushell) | Tier 1, 4 | `T1-V2.4`, `T4-V2.3`, `T4-V2.4` |

## Tier Breakdown

### Tier 1 (`e2e_docker_web/tier1_v2_features.mjs`) — 8 Tests
- `T1-V2.1`: F1 Repo cleanliness (`src/`, `tests/`, `e2e/`, `e2e_v2/`, `js/test_m1_preemption.mjs` absent; virtual workspace `Cargo.toml`; `server/server.mjs`, `js/cli.mjs`, `e2e_docker_web/` present).
- `T1-V2.2`: F11 System Light mode default (`L(bg) > 0.65`, `L(text) < 0.25`, contrast >= 4.5, terminal legible, zero errors).
- `T1-V2.3`: F11 System Dark mode default (`L(bg) < 0.25`, `L(text) > 0.65`, contrast >= 4.5) + manual switcher flip & reload persistence.
- `T1-V2.4`: F14 Well-known presets (zero Bottle / Nano ID / Nushell; Express & Flask present and load distinct valid Dockerfiles).
- `T1-V2.5`: F7/F12 Visual Layer Builder <-> Dockerfile bidirectional sync (`FROM`, `GIT`, `WORKDIR`, `ENV`, `RUN`, `SWEEP`).
- `T1-V2.6`: F13 Global "Run All Locally" / "Run All Remotely" & per-layer Local/Remote controls.
- `T1-V2.7`: F5/F6 `POST /api/eval` JSON happy path (schema, `remote-wasmi`, `exitCode`, `stdout`, `virtualTimeNs`, `outputDiffTarGzBase64`, `modifiedFiles`).
- `T1-V2.8`: F5/F6 `POST /api/eval` direct `.tar.gz` download via `Accept: application/gzip` AND `?format=tar.gz`.

### Tier 2 (`e2e_docker_web/tier2_v2_boundaries.mjs`) — 5 Tests
- `T2-V2.1`: F5/F6 `POST /api/eval` error handling (malformed JSON, missing `baseImage`, empty `cmd`, SSRF against `allowLocalRegistries: false`) + COOP/COEP headers.
- `T2-V2.2`: F3/F5 `inputLayerDiffs` chaining & OCI `.wh.<name>` whiteout emission on deletion.
- `T2-V2.3`: F7/F12 Invalid Dockerfile validation error without uncaught exceptions + recovery when fixed.
- `T2-V2.4`: F9 Sweep boundary validation (empty list / invalid range handled cleanly).
- `T2-V2.5`: F11/F13 Responsive mobile phone viewport (`390x844`): no horizontal overflow, controls accessible, Light & Dark contrast.

### Tier 3 (`e2e_docker_web/tier3_v2_combinations.mjs`) — 6 Tests
- `T3-V2.1`: F7/F8/F12 Offline multi-layer stack (`FROM + GIT + WORKDIR + ENV + chained RUN`).
- `T3-V2.2`: F4/F5/F8 Local browser vs Remote Worker determinism parity.
- `T3-V2.3`: F8/F13 Mixed Remote Layer 1 + Local Layer 2 stack (`/api/eval` called only once) + browser `.tar.gz` download verification.
- `T3-V2.4`: F9/F12 `env` sweep (list mode `alpha,beta,gamma`) across 2 downstream `RUN` layers + row-click terminal inspection.
- `T3-V2.5`: F9/F12 `delay` sweep (range `0,5,10`) & `seed` sweep (range `10,11,12`) producing 3 varied rows each.
- `T3-V2.6`: F10 URL state round-trip preserving Dockerfile, sweep config, and targets in a fresh browser.

### Tier 4 (`e2e_docker_web/tier4_v2_scenarios.mjs`) — 5 Tests
- `T4-V2.1`: Offline full user journey (Light mode -> Dockerfile -> Run All Remotely -> download `.tar.gz` -> Dark mode -> Run All Locally -> identical output).
- `T4-V2.2`: Offline remote failure recovery & Stop/Cancel mid-execution cleanly re-enables UI.
- `T4-V2.3`: Live Express.js preset execution (`--skip-live` gated).
- `T4-V2.4`: Live Flask preset execution (`--skip-live` gated).
- `T4-V2.5`: Live `alpine:latest` remote `POST /api/eval` JSON & `.tar.gz` download (`--skip-live` gated).

## Coverage Thresholds & Exit Codes
- **Pass Criteria**: 100% pass rate across all executed offline tests (`--tier all --skip-live`), zero uncaught browser exceptions, zero console errors on happy paths, WCAG AA contrast >= 4.5 in both Light and Dark themes.
- **Exit Codes**:
  - `0`: All executed tests passed.
  - `1`: One or more test assertions failed.
  - `2`: Prerequisite artifact missing, Chrome missing, or invalid CLI flags.

## CLI Commands
```bash
# Verify harness health independently of M2-M5 artifacts:
node e2e_docker_web/run_v2_e2e.mjs --self-test

# Run all offline v2 E2E tiers (Tiers 1-4 with live tests skipped):
node e2e_docker_web/run_v2_e2e.mjs --tier all --skip-live

# Run individual tiers:
node e2e_docker_web/run_v2_e2e.mjs --tier 1
node e2e_docker_web/run_v2_e2e.mjs --tier 2
node e2e_docker_web/run_v2_e2e.mjs --tier 3
node e2e_docker_web/run_v2_e2e.mjs --tier 4 --skip-live

# Run full suite including live Docker Hub / GitHub presets & emit JSON report:
node e2e_docker_web/run_v2_e2e.mjs --tier all --verbose --json /tmp/v2-e2e-results.json

# Legacy harness self-test (regression check):
node e2e_docker_web/run_all.mjs --self-test
```
