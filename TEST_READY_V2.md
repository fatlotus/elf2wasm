# TEST_READY_V2: `elf2wasm` E2E v2 Test Suite (WASM-Hosted Compiler/Runtime + Determinism)

**Status:** READY
**Track:** `sub_orch_e2e_v2` (E2E v2 Testing Track)
**Plan:** [PLAN.md](/home/antigravity/.agents/teamwork/orchestrator_1/PLAN.md)

## Overview
Opaque-box, requirement-driven E2E v2 test suite in `e2e_v2/` and `tests/e2e_v2_suite.rs`, exercising the WASM-hosted compiler (`compiler.wasm`), WASM-hosted runtime (`runtime.wasm`), ESM JS shim (`js/elf2wasm_shim.mjs`), writable VFS, simulated virtual time, deterministic cooperative multi-threading, multi-process syscalls, and hosted C compiler victory case.

- **Pre-build (`e2e_v2/test_v2_prebuild.py`)**: 7 tests (runs continuously on pre-M1 baseline via `cargo test --offline`; compiles all 6 C11/POSIX fixtures with `gcc`, runs non-sleeping fixtures natively, and runs `node --check` on `e2e_v2/js_runner.mjs` and `js/*.mjs`).
- **Tier 1 (`e2e_v2/test_v2_tier1.py`)**: 7 tests covering F1–F11 via `compiler.wasm` + `runtime.wasm` + `js/elf2wasm_shim.mjs`.
- **Tier 2 (`e2e_v2/test_v2_tier2.py`)**: 6 tests covering boundary & error cases (`-ENOENT`, invalid ELF rejection, large `argv`, `O_RDONLY` write `-EBADF`/`-EACCES`, `futex` `EAGAIN`/`ETIMEDOUT`, `nanosleep` `0`/`EINVAL`, pipe EOF).
- **Tier 3 (`e2e_v2/test_v2_tier3.py`)**: 5 tests covering multi-process (`fork`/`pipe`/`dup2`/`execve`/`waitpid`), Easy Victory Case (`sleep_test` 65s virtual in `< 1.0s` wall time in both JS+WASM and native CLI), Hard Victory Case (`racy_threads` `0 < counter < 400000` and 5 runs byte-for-byte identical), and C Compiler Victory Case (`hello_c_target.c` compiled inside WASM system -> ELF in VFS -> `compiler.wasm` -> run guest WASM).

## Feature Coverage Matrix (F1–F14)

| Feature | Description | Test Coverage |
|---------|-------------|---------------|
| F1, F2, F3 | In-memory ELF64->WASM compiler, dynamic `LD_BASE`, `compiler.wasm` | `test_v2_tier1.py` (`test_f3_compiler_wasm_compiles_*`), `test_v2_tier2.py` (`test_invalid_elf_rejected_by_compiler_wasm`) |
| F4, F8, F14 | Yield/quantum preemption, cooperative pthreads, deterministic racy threads | `test_v2_tier1.py` (`test_f8_cooperative_pthreads_join`), `test_v2_tier3.py` (`test_f14_hard_victory_deterministic_racy_threads`) |
| F5, F6, F9 | Pure runtime, `runtime.wasm`, writable VFS overlay | `test_v2_tier1.py` (`test_f6_writable_vfs_ops`), `test_v2_tier2.py` (`test_vfs_rdonly_write_rejected_*`, `test_missing_vfs_file_*`) |
| F7, F13 | Simulated virtual clock, fast `sleep` victory case | `test_v2_tier1.py` (`test_f7_simulated_time_clock_advances`), `test_v2_tier2.py` (`test_futex_and_nanosleep_boundaries`), `test_v2_tier3.py` (`test_f13_easy_victory_fast_sleep_js_and_native`) |
| F10 | Multi-process syscalls (`fork`, `pipe`, `dup2`, `execve`, `waitpid`) | `test_v2_tier2.py` (`test_multiproc_pipe_eof_and_exit_status`), `test_v2_tier3.py` (`test_f10_multiproc_*`) |
| F11 | ESM JS shim (`js/elf2wasm_shim.mjs`) | `test_v2_tier1.py` (`test_f11_js_shim_runs_*`), `e2e_v2/js_runner.mjs` |
| F12 | Hosted C compiler victory case | `test_v2_tier3.py` (`test_f12_c_compiler_victory_case`) |

## Pre-M3 vs Post-M3 Behavior
- **Pre-M3**: `cargo test --offline` runs `e2e_v2_prebuild_fixtures_and_js_syntax` (PASS) and leaves Tiers 1–3 `#[ignore]`. Running Tiers 1–3 directly before `compiler.wasm`, `runtime.wasm`, and `js/elf2wasm_shim.mjs` exist fails loudly with `AssertionError` via `require_v2_artifacts()` (never skipped or silently passed).
- **Post-M3/M4**: Once `compiler.wasm`, `runtime.wasm`, and `js/elf2wasm_shim.mjs` are built, all Tiers 1–3 execute end-to-end.

## Run Commands
```bash
# Pre-build verification (works on pre-M1 baseline):
./e2e_v2/run_e2e_v2.sh prebuild
cargo test --test e2e_v2_suite --offline

# Full E2E v2 suite (after M1-M4 artifacts are built):
./e2e_v2/run_e2e_v2.sh all
cargo test --offline --test e2e_v2_suite -- --ignored
```
