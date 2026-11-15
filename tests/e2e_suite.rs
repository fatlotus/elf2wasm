//! Cargo integration test wrapper for the opaque-box E2E test suite in `e2e/`.
//!
//! All tests are marked `#[ignore]` so `cargo test --offline` stays green during M1-M4.
//! To run the E2E suite via Cargo:
//!   cargo test --offline --test e2e_suite -- --ignored
//! Or run directly via:
//!   ./e2e/run_e2e.sh

use std::path::PathBuf;
use std::process::Command;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn run_python_tier(pattern: &str) {
    let root = repo_root();
    let bin = env!("CARGO_BIN_EXE_elf2wasm");
    let status = Command::new("python3")
        .arg("-m")
        .arg("unittest")
        .arg("discover")
        .arg("-s")
        .arg("e2e")
        .arg("-p")
        .arg(pattern)
        .arg("-v")
        .current_dir(&root)
        .env("ELF2WASM_BIN", bin)
        .status()
        .expect("failed to invoke python3 unittest");

    assert!(
        status.success(),
        "E2E suite ({pattern}) failed with status: {status}"
    );
}

#[test]
#[ignore = "requires M3/M4 CLI & runtime; run via e2e/run_e2e.sh or cargo test --test e2e_suite -- --ignored"]
fn e2e_tier1_feature_coverage() {
    run_python_tier("test_tier1.py");
}

#[test]
#[ignore = "requires M3/M4 CLI & runtime; run via e2e/run_e2e.sh or cargo test --test e2e_suite -- --ignored"]
fn e2e_tier2_boundary_and_corner_cases() {
    run_python_tier("test_tier2.py");
}

#[test]
#[ignore = "requires M3/M4 CLI & runtime; run via e2e/run_e2e.sh or cargo test --test e2e_suite -- --ignored"]
fn e2e_tier3_cross_feature_combinations() {
    run_python_tier("test_tier3.py");
}

#[test]
#[ignore = "requires M3/M4 CLI & runtime; run via e2e/run_e2e.sh or cargo test --test e2e_suite -- --ignored"]
fn e2e_tier4_differential_and_sandbox() {
    run_python_tier("test_tier4.py");
}
