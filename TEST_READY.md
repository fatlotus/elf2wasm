# Phase 2 E2E Test Suite Ready (`TEST_READY.md`)

## Test Runner Command
```bash
./e2e_v2/run_phase2.sh
```

Individual requirement tests can also be run directly with Node.js (`v24+`):
```bash
node e2e_v2/test_r1_cps_preemption.mjs
node e2e_v2/test_r2_readme_abi.mjs
node e2e_v2/test_r3_web_ui_python.mjs
node e2e_v2/test_r4_cleanliness.mjs
```

## Coverage Summary

| Requirement | Test File | What It Verifies (Opaque-Box) |
|---|---|---|
| **R1: CPS Syscall ABI & Kernel Preemption** | `e2e_v2/test_r1_cps_preemption.mjs` | Compiles C programs with `gcc` and translates via `elf2wasm translate`; inspects `.wasm` via `WebAssembly.Module` for 0 imports (`env.syscall` removed), all required ABI exports (`memory`, `_start`, `save_ctx`, `load_ctx`, `yield_flag`, `quantum`, `rip`, `exit_flag`, `exit_code`, `fsbase`, `gsbase`, `rax`..`r15`), and `elf2wasm_meta` custom section; instantiates directly in Node to verify `_start()` CPS return (`yield_flag` 2/3, `rip != 0`); runs a two-subprocess `fork()` + `nanosleep()` + `waitpid()` program (Child A 50ms, Child B 10ms) via both `elf2wasm run` and `node js/cli.mjs run`, asserting exit code 0, deterministic `CHILD_B_DONE` before `CHILD_A_DONE` before `PARENT_DONE`, and identical stdout across repeated runs. |
| **R2: `README.md` & Exhaustive WASM ABI Docs** | `e2e_v2/test_r2_readme_abi.mjs` | Verifies `README.md` exists and documents the core goal (deterministic, Linux-compatible OS running unmodified x86/x86-64 programs), build/install instructions (`wasm32-unknown-unknown`, `cargo build`, `.wasm` modules), and run instructions; dynamically extracts all `WebAssembly.Module.imports` and `WebAssembly.Module.exports` from `elf2wasm_compiler_wasm.wasm`, `elf2wasm_runtime_wasm.wasm`, and a freshly translated guest `.wasm`, asserting every import and export symbol is documented in `README.md`. |
| **R3: VFS Symlinks, `.tar.gz` Overlay & HTML Web UI + Python** | `e2e_v2/test_r3_web_ui_python.mjs` | Packages a real `.tar.gz` overlay from host `/usr/bin/python3.11`, its `.so` dependencies (`libc.so.6`, `libm.so.6`, `libexpat.so.1`, `libz.so.1`, `ld-linux-x86-64.so.2`), symlinks (`/usr/bin/python3 -> python3.11`, `/lib64/ld-linux-x86-64.so.2 -> /lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`), and minimal `/usr/lib/python3.11` stdlib; verifies `js/elf2wasm_shim.mjs` (`extractTarGzToVfs`, `runFromVfs`, symlink resolution); serves the repo via HTTP, launches headless `/usr/bin/chromium` over CDP, loads `/web/index.html` with zero uncaught page errors, uploads the `.tar.gz` overlay via `DOM.setFileInputFiles`, runs `/usr/bin/python3 -S -c "print(6 * 7)"`, and asserts stdout contains `42`. |
| **R4: Codebase Simplification & Cleanup** | `e2e_v2/test_r4_cleanliness.mjs` | Verifies obsolete/redundant files (`src/syscalls.rs`, `src/vfs.rs`, `tests/m2_runtime.rs`, `tests/m3_true_echo.rs`, `tests/m4_python3.rs`, `TEST_READY_V2.md`) are deleted, root `Cargo.toml` `[dependencies]` no longer contains unused `goblin`, `iced-x86`, or `wasm-encoder`, and `cargo test --workspace` exits `0`. |
