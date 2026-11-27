# elf2wasm v2 E2E Suite Ready (`TEST_READY.md`)

**Status**: READY FOR M6 INTEGRATION & VERIFICATION (Feature F16)

## Commits
- `6476d82` — `e2e: remove stale native-CLI/nushell refs and extend CDP, server & /api/eval helpers`
- `39cff2d` — `e2e: add 4-tier v2 opaque-box E2E suite (F1-F14) and TEST_INFRA.md`

## Exact Runner Commands

```bash
# Harness self-test (no M2-M5 artifacts required):
node e2e_docker_web/run_v2_e2e.mjs --self-test

# Run all offline tiers (Tiers 1-4, live tests skipped):
node e2e_docker_web/run_v2_e2e.mjs --tier all --skip-live

# Run individual tiers:
node e2e_docker_web/run_v2_e2e.mjs --tier 1 --skip-live
node e2e_docker_web/run_v2_e2e.mjs --tier 2 --skip-live
node e2e_docker_web/run_v2_e2e.mjs --tier 3 --skip-live
node e2e_docker_web/run_v2_e2e.mjs --tier 4 --skip-live

# Full suite including live Docker Hub / GitHub presets & JSON report:
node e2e_docker_web/run_v2_e2e.mjs --tier all --verbose --json /tmp/v2-e2e-results.json

# Existing harness regression self-test:
node e2e_docker_web/run_all.mjs --self-test
```

## Requirement Traceability Table (F1–F14)

| Feature | Tier 1 | Tier 2 | Tier 3 | Tier 4 |
|---------|--------|--------|--------|--------|
| F1 Repo Cleanliness | `T1-V2.1` | — | — | — |
| F2 Toolchain / Artifacts | `checkPrerequisites()` | — | — | — |
| F3 VFS Diff & OCI Whiteouts | `T1-V2.7`, `T1-V2.8` | `T2-V2.2` | — | — |
| F4 Worker WASM Interpreter Parity | — | — | `T3-V2.2` | — |
| F5 `POST /api/eval` API | `T1-V2.7`, `T1-V2.8` | `T2-V2.1`, `T2-V2.2` | `T3-V2.2` | `T4-V2.5` (live) |
| F6 Dev Server `/api/eval` & SSRF | `T1-V2.7`, `T1-V2.8` | `T2-V2.1` | — | — |
| F7 Dockerfile Parser & Serializer | `T1-V2.5` | `T2-V2.3` | `T3-V2.1` | — |
| F8 Multi-Layer & Local/Remote SDK | — | — | `T3-V2.1`, `T3-V2.2`, `T3-V2.3` | `T4-V2.1` |
| F9 Generalized Sweep (`env`/`delay`/`seed`) | — | `T2-V2.4` | `T3-V2.4`, `T3-V2.5` | — |
| F10 URL State Round-Trip | — | — | `T3-V2.6` | — |
| F11 System Light/Dark Theme & Mobile UI | `T1-V2.2`, `T1-V2.3` | `T2-V2.5` | — | `T4-V2.1` |
| F12 Visual Layer Builder <-> Dockerfile | `T1-V2.5` | `T2-V2.3` | `T3-V2.1`, `T3-V2.4`, `T3-V2.5` | — |
| F13 Global/Per-Layer Controls & Download | `T1-V2.6` | `T2-V2.5` | `T3-V2.3` | `T4-V2.1`, `T4-V2.2` |
| F14 Well-Known Presets (Express, Flask) | `T1-V2.4` | — | — | `T4-V2.3` (live), `T4-V2.4` (live) |

## Self-Test Verification Results

1. **Syntax Validation (`node --check` on all `.mjs` files in `e2e_docker_web/` and `e2e_docker_web/helpers/`)**:
   - Result: `ALL_SYNTAX_OK` (exit 0)
2. **v2 Harness Self-Test (`node e2e_docker_web/run_v2_e2e.mjs --self-test`)**:
   - `PASS [V2-ST-1]` `tar_builder` & `eval_client` base64 tar.gz round-trip including OCI whiteouts (6ms)
   - `PASS [V2-ST-2]` `eval_client` `postEvalJson` & `postEvalTarGz` against mock HTTP `/api/eval` (49ms)
   - `PASS [V2-ST-3]` `mock_oci_registry` & `mock_git_server` startup & fixture serving (30ms)
   - `PASS [V2-ST-4]` `cdp_browser` WCAG helpers, `setColorScheme('light'|'dark')`, `setViewport(390, 844)`, and real Chrome blob `.tar.gz` download capture (2848ms)
   - Result: **4/4 PASS (2.9s, exit 0)**
3. **Existing Harness Regression Self-Test (`node e2e_docker_web/run_all.mjs --self-test`)**:
   - Result: **6/6 PASS (10.9s, exit 0)**
