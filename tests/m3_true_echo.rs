use std::path::PathBuf;
use std::process::Command;

fn elf2wasm_bin() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_elf2wasm"))
}

fn temp_wasm_path(name: &str) -> PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!("elf2wasm_m3_test_{}_{}.wasm", name, std::process::id()));
    p
}

#[test]
fn test_m3_true_differential() {
    let wasm_path = temp_wasm_path("true");
    let status = Command::new(elf2wasm_bin())
        .args([
            "translate",
            "/usr/bin/true",
            "--so",
            "/lib64/ld-linux-x86-64.so.2",
            "--so",
            "/lib/x86_64-linux-gnu/libc.so.6",
            "-o",
        ])
        .arg(&wasm_path)
        .status()
        .expect("failed to run elf2wasm translate");
    assert!(status.success(), "elf2wasm translate /usr/bin/true failed");

    let native = Command::new("/usr/bin/true")
        .output()
        .expect("failed to run native /usr/bin/true");
    let wasm = Command::new(elf2wasm_bin())
        .arg("run")
        .arg(&wasm_path)
        .output()
        .expect("failed to run elf2wasm run true.wasm");

    let _ = std::fs::remove_file(&wasm_path);

    assert_eq!(wasm.status.code(), native.status.code(), "exit code mismatch");
    assert_eq!(wasm.stdout, native.stdout, "stdout mismatch");
    assert_eq!(wasm.stderr, native.stderr, "stderr mismatch");
}

#[test]
fn test_m3_echo_differential() {
    let wasm_path = temp_wasm_path("echo");
    let status = Command::new(elf2wasm_bin())
        .args([
            "translate",
            "/usr/bin/echo",
            "--so",
            "/lib64/ld-linux-x86-64.so.2",
            "--so",
            "/lib/x86_64-linux-gnu/libc.so.6",
            "-o",
        ])
        .arg(&wasm_path)
        .status()
        .expect("failed to run elf2wasm translate");
    assert!(status.success(), "elf2wasm translate /usr/bin/echo failed");

    let cases: &[&[&str]] = &[
        &[],
        &["hello world"],
        &["-n", "hello"],
        &["-e", "a\\nb\\tc"],
        &["foo", "bar", "baz"],
        &["-n", "-e", "line1\\nline2"],
    ];

    for args in cases {
        let native = Command::new("/usr/bin/echo")
            .args(*args)
            .output()
            .expect("failed to run native /usr/bin/echo");

        let mut cmd = Command::new(elf2wasm_bin());
        cmd.arg("run").arg(&wasm_path);
        if !args.is_empty() {
            cmd.arg("--").args(*args);
        }
        let wasm = cmd.output().expect("failed to run elf2wasm run echo.wasm");

        assert_eq!(
            wasm.status.code(),
            native.status.code(),
            "exit code mismatch for args {:?}",
            args
        );
        assert_eq!(
            wasm.stdout, native.stdout,
            "stdout mismatch for args {:?}",
            args
        );
        assert_eq!(
            wasm.stderr, native.stderr,
            "stderr mismatch for args {:?}",
            args
        );
    }

    let _ = std::fs::remove_file(&wasm_path);
}
