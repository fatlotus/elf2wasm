# TEST_READY: `elf2wasm` E2E Test Suite

**Status:** READY
**Track:** `sub_orch_e2e` (E2E Testing Track)
**Specification:** [TEST_INFRA.md](/home/antigravity/elf2wasm/TEST_INFRA.md)

## Summary
The opaque-box, requirement-driven E2E test suite for `elf2wasm` is complete, verified, and ready for Milestone M5 (and incremental M3/M4 verification).

- **Total E2E Tests:** `144` (covering all 13 features in `PROJECT.md § Feature Inventory` across Tiers 1–4):
  - **Tier 1 (`e2e/test_tier1.py`)**: 65 tests (5 per feature across Features 1–13)
  - **Tier 2 (`e2e/test_tier2.py`)**: 65 tests (5 per feature across Features 1–13, boundary & corner cases)
  - **Tier 3 (`e2e/test_tier3.py`)**: 8 tests (cross-feature pairwise & multi-feature combinations)
  - **Tier 4 (`e2e/test_tier4.py`)**: 6 tests (real-world byte-for-byte differential parity vs native `/usr/bin/true`, `/usr/bin/echo`, `/usr/bin/python3`, plus sandbox isolation verification)
- **Non-Interference:** `cargo test --offline` passes (`4 ignored` in `tests/e2e_suite.rs`, `0 failed`). `src/`, `Cargo.toml`, `Cargo.lock`, and `PROJECT.md` were not modified.

## How to Run (once M3/M4 CLI & runtime are implemented)
- Standalone runner: `./e2e/run_e2e.sh` (or `./e2e/run_e2e.sh tier1`, `tier2`, `tier3`, `tier4`)
- Via Cargo: `cargo test --offline --test e2e_suite -- --ignored`

## Verification Sign-Off
- **Reviewers:** 2/2 `APPROVE`
- **Challengers:** 2/2 `CONFIRM` (verified assertion failure on wrong stdout/stderr/exit code and sandbox escape detection)
- **Forensic Auditor:** `CLEAN` (zero cheating, zero `src/` coupling, genuine differential & sandbox checks)
