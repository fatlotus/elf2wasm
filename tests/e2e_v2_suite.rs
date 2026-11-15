//! Cargo integration test wrapper for the opaque-box E2E v2 test suite in `e2e_v2/`.
//!
//! - `e2e_v2_prebuild_fixtures_and_js_syntax` runs on every `cargo test --offline`
//!   to verify that all C11/POSIX fixtures compile cleanly and `js_runner.mjs` has valid syntax.
//! - Tiers 1-3 are marked `#[ignore]` until M1-M4 WASM compiler/runtime & JS shim are built.
//!   Run them via:
//!     cargo test --offline --test e2e_v2_suite -- --ignored
//!   Or directly via:
//!     ./e2e_v2/run_e2e_v2.sh

use std::path::PathBuf;
use std::process::Command;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn run_python_v2_tier(pattern: &str) {
    let root = repo_root();
    let bin = env!("CARGO_BIN_EXE_elf2wasm");
    let status = Command::new("python3")
        .arg("-m")
        .arg("unittest")
        .arg("discover")
        .arg("-s")
        .arg("e2e_v2")
        .arg("-p")
        .arg(pattern)
        .arg("-v")
        .current_dir(&root)
        .env("ELF2WASM_BIN", bin)
        .status()
        .expect("failed to invoke python3 unittest");

    assert!(
        status.success(),
        "E2E v2 suite ({pattern}) failed with status: {status}"
    );
}

#[test]
fn e2e_v2_prebuild_fixtures_and_js_syntax() {
    run_python_v2_tier("test_v2_prebuild.py");
}

#[test]
#[ignore = "requires M1-M4 WASM compiler/runtime & JS shim"]
fn e2e_v2_tier1_wasm_and_js_shim() {
    run_python_v2_tier("test_v2_tier1.py");
}

#[test]
#[ignore = "requires M1-M4 WASM compiler/runtime & JS shim"]
fn e2e_v2_tier2_boundary_cases() {
    run_python_v2_tier("test_v2_tier2.py");
}

#[test]
#[ignore = "requires M1-M4 WASM compiler/runtime & JS shim"]
fn e2e_v2_tier3_victory_cases() {
    run_python_v2_tier("test_v2_tier3.py");
}
