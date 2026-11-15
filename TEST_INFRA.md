# `elf2wasm` E2E Test Infrastructure

## 1. Overview
The `elf2wasm` End-to-End (E2E) test suite is an **opaque-box, requirement-driven** suite of **144 tests** across 4 tiers, derived from `PROJECT.md` (Features 1–13) and `ORIGINAL_REQUEST.md`. All tests interact with `elf2wasm` strictly through its external CLI (`translate` and `run`), comparing guest execution against native Linux x86-64 binaries byte-for-byte (`exit_code`, `stdout`, `stderr`) and verifying sandbox isolation.

---

## 2. Host Environment & Target Binaries

| Item | Path / Version | Notes |
|---|---|---|
| OS / Kernel | Debian GNU/Linux 12 (`bookworm`), `x86_64` | glibc `2.36-9+deb12u14` |
| `/usr/bin/true` | ELF64 `ET_DYN` (PIE), stripped | Requires `ld-linux-x86-64.so.2`, `libc.so.6` |
| `/usr/bin/echo` | ELF64 `ET_DYN` (PIE), stripped | Requires `ld-linux-x86-64.so.2`, `libc.so.6` |
| `/usr/bin/python3` | `-> python3.11` (Python 3.11.2), ELF64 `ET_EXEC` (non-PIE) | Entry `0x60a790`; requires `ld-linux-x86-64.so.2`, `libc.so.6`, `libm.so.6`, `libz.so.1`, `libexpat.so.1` |

### Shared Libraries (`.so` Dependencies)
- `/lib64/ld-linux-x86-64.so.2`
- `/lib/x86_64-linux-gnu/libc.so.6`
- `/lib/x86_64-linux-gnu/libm.so.6`
- `/lib/x86_64-linux-gnu/libz.so.1`
- `/lib/x86_64-linux-gnu/libexpat.so.1`

### Python 3 Stdlib VFS Mounts
- `/usr/lib/python3.11:/usr/lib/python3.11`
- `/usr/lib/python3/dist-packages:/usr/lib/python3/dist-packages`

---

## 3. CLI Contract
The single CLI adapter in `e2e/harness.py` invokes:
- **Translate**: `elf2wasm translate <elf> [--so <so>...] -o <out.wasm>`
- **Run**: `elf2wasm run <out.wasm> [--vfs-ro <host:guest>...] [-- <args>...]`

Binary discovery uses `ELF2WASM_BIN` if set, otherwise `/home/antigravity/elf2wasm/target/debug/elf2wasm`.
`e2e/harness.py` caches translated `.wasm` artifacts in a module-level temporary directory (cleaned up via `atexit`) so each target binary (`true`, `echo`, `python3`) is translated at most once per test run.

---

## 4. Directory Layout

```text
/home/antigravity/elf2wasm/
├── TEST_INFRA.md
├── tests/
│   └── e2e_suite.rs          # Cargo integration wrapper (#[ignore] during M1-M4, std-only)
└── e2e/
    ├── harness.py            # Opaque-box CLI adapter, translation cache, differential oracle
    ├── run_e2e.sh            # Executable runner (cargo build --offline + unittest discover)
    ├── test_tier1.py         # 65 tests (5 per feature across Features 1-13)
    ├── test_tier2.py         # 65 tests (5 per feature boundary/corner cases)
    ├── test_tier3.py         # 8 cross-feature combination tests (T3-01..T3-08)
    ├── test_tier4.py         # 6 real-world differential & sandbox tests (T4-01..T4-06)
    └── fixtures/
        ├── app_proj.py       # Multi-module/VFS project script (T1-F10-05, T3-03)
        ├── calc.py           # JSON + math + statistics calculator (T1-F12-05, T4-03)
        ├── data.xml          # Sample XML catalog (T3-05, T4-04, T4-06)
        ├── err_mod.py        # Custom exception & unwind module (T3-07)
        ├── sandbox_probe.py  # Host isolation & VFS escape probe (T4-06)
        ├── utf8_sample.txt   # UTF-8 accents/CJK/emoji sample (T2-F12-04)
        ├── validate.py       # Validation & exit-code contract script (T4-05)
        └── xml2json.py       # Expat XML + zlib + re transformer (T4-04)
```

---

## 5. How to Run

### Standard Cargo Test (stays green during M1–M4)
```bash
cargo test --offline
```
All tests in `tests/e2e_suite.rs` are marked `#[ignore = "requires M3/M4 CLI & runtime; run via e2e/run_e2e.sh or cargo test --test e2e_suite -- --ignored"]`.

### Run Full E2E Suite (after M3/M4)
```bash
./e2e/run_e2e.sh            # All 144 tests (Tiers 1-4)
./e2e/run_e2e.sh tier1      # Tier 1 only (65 tests)
./e2e/run_e2e.sh tier2      # Tier 2 only (65 tests)
./e2e/run_e2e.sh tier3      # Tier 3 only (8 tests)
./e2e/run_e2e.sh tier4      # Tier 4 only (6 tests)
```

Or via Cargo:
```bash
cargo test --offline --test e2e_suite -- --ignored
```

---

## 6. Traceability Matrix (Features 1–13 × Tiers 1–4)

| # | Feature (`PROJECT.md`) | Tier 1 (5/feature) | Tier 2 (5/feature) | Tier 3 | Tier 4 |
|---:|---|---|---|---|---|
| 1 | ELF64 PIE & non-PIE + `.so` loading | `test_t1_f01_01..05` | `test_t2_f01_01..05` | `T3-01`, `T3-02`, `T3-08` | `T4-01..05` |
| 2 | x86-64 code discovery & decoding | `test_t1_f02_01..05` | `test_t2_f02_01..05` | `T3-07` | `T4-01..05` |
| 3 | CPU state & flags lifting | `test_t1_f03_01..05` | `test_t2_f03_01..05` | `T3-02`, `T3-04` | `T4-03..05` |
| 4 | Baseline x86-64 + `rep`/`lock`/`endbr64` | `test_t1_f04_01..05` | `test_t2_f04_01..05` | `T3-04` | `T4-01..05` |
| 5 | SSE/SSE2 & `cpuid`/`xgetbv` masking | `test_t1_f05_01..05` | `test_t2_f05_01..05` | `T3-01`, `T3-05` | `T4-02..04` |
| 6 | Indirect dispatch & WASM module emission | `test_t1_f06_01..05` | `test_t2_f06_01..05` | `T3-04`, `T3-07` | `T4-01..05` |
| 7 | `wasmtime` host & Linux stack/auxv init | `test_t1_f07_01..05` | `test_t2_f07_01..05` | `T3-01`, `T3-03` | `T4-01..05` |
| 8 | Tier 1 memory & process syscalls | `test_t1_f08_01..05` | `test_t2_f08_01..05` | `T3-02`, `T3-04`, `T3-07` | `T4-01..05` |
| 9 | Tier 1 VFS & I/O syscalls | `test_t1_f09_01..05` | `test_t2_f09_01..05` | `T3-01`, `T3-06`, `T3-07` | `T4-01..06` |
| 10 | CLI (`translate` & `run`) | `test_t1_f10_01..05` | `test_t2_f10_01..05` | `T3-01`, `T3-03`, `T3-08` | `T4-01..06` |
| 11 | Python 3 syscalls & signals/time/ids | `test_t1_f11_01..05` | `test_t2_f11_01..05` | `T3-03`, `T3-05`, `T3-06` | `T4-03..06` |
| 12 | Python 3 stdlib VFS & x87/SSE4.2 edge ops | `test_t1_f12_01..05` | `test_t2_f12_01..05` | `T3-02`, `T3-03`, `T3-05`, `T3-06` | `T4-03..05` |
| 13 | Differential verification & E2E test suite | `test_t1_f13_01..05` | `test_t2_f13_01..05` | `T3-06` | `T4-01..06` |
