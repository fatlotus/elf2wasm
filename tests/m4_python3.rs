use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

fn elf2wasm_bin() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_elf2wasm"))
}

fn temp_wasm_path(name: &str) -> PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!("elf2wasm_m4_test_{}_{}.wasm", name, std::process::id()));
    p
}

fn translate_python3(wasm_path: &PathBuf) {
    let status = Command::new(elf2wasm_bin())
        .args([
            "translate",
            "/usr/bin/python3",
            "--so",
            "/lib64/ld-linux-x86-64.so.2",
            "--so",
            "/lib/x86_64-linux-gnu/libm.so.6",
            "--so",
            "/lib/x86_64-linux-gnu/libz.so.1",
            "--so",
            "/lib/x86_64-linux-gnu/libexpat.so.1",
            "--so",
            "/lib/x86_64-linux-gnu/libc.so.6",
            "-o",
        ])
        .arg(wasm_path)
        .status()
        .expect("failed to run elf2wasm translate /usr/bin/python3");
    assert!(status.success(), "elf2wasm translate /usr/bin/python3 failed");
}

fn run_wasm_python3(wasm_path: &PathBuf, extra_vfs: &[String], py_args: &[&str]) -> std::process::Output {
    let mut cmd = Command::new(elf2wasm_bin());
    cmd.arg("run")
        .arg(wasm_path)
        .arg("--vfs-ro")
        .arg("/usr/lib/python3.11:/usr/lib/python3.11")
        .arg("--vfs-ro")
        .arg("/usr/lib/python3/dist-packages:/usr/lib/python3/dist-packages");
    for v in extra_vfs {
        cmd.arg("--vfs-ro").arg(v);
    }
    cmd.arg("--").args(py_args);
    cmd.output().expect("failed to run elf2wasm run python3.wasm")
}

fn assert_diff_matches(wasm_path: &PathBuf, extra_vfs: &[String], py_args: &[&str], label: &str) {
    let native = Command::new("/usr/bin/python3")
        .args(py_args)
        .output()
        .expect("failed to run native /usr/bin/python3");
    let wasm = run_wasm_python3(wasm_path, extra_vfs, py_args);

    assert_eq!(
        wasm.status.code(),
        native.status.code(),
        "{}: exit code mismatch (wasm={:?}, native={:?}, wasm_stderr={})",
        label,
        wasm.status.code(),
        native.status.code(),
        String::from_utf8_lossy(&wasm.stderr)
    );
    assert_eq!(
        wasm.stdout,
        native.stdout,
        "{}: stdout mismatch\nwasm:   {:?}\nnative: {:?}",
        label,
        String::from_utf8_lossy(&wasm.stdout),
        String::from_utf8_lossy(&native.stdout)
    );
    assert_eq!(
        wasm.stderr,
        native.stderr,
        "{}: stderr mismatch\nwasm:   {:?}\nnative: {:?}",
        label,
        String::from_utf8_lossy(&wasm.stderr),
        String::from_utf8_lossy(&native.stderr)
    );
}

fn run_cmd_with_stdin(cmd: &mut Command, stdin_bytes: &[u8]) -> std::process::Output {
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to spawn command");
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(stdin_bytes)
            .expect("failed to write stdin to child");
    }
    child.wait_with_output().expect("failed to wait for child")
}

fn assert_diff_matches_stdin(
    wasm_path: &PathBuf,
    extra_vfs: &[String],
    py_args: &[&str],
    stdin_bytes: &[u8],
    label: &str,
) {
    let mut native_cmd = Command::new("/usr/bin/python3");
    native_cmd.args(py_args);
    let native = run_cmd_with_stdin(&mut native_cmd, stdin_bytes);

    let mut wasm_cmd = Command::new(elf2wasm_bin());
    wasm_cmd
        .arg("run")
        .arg(wasm_path)
        .arg("--vfs-ro")
        .arg("/usr/lib/python3.11:/usr/lib/python3.11")
        .arg("--vfs-ro")
        .arg("/usr/lib/python3/dist-packages:/usr/lib/python3/dist-packages");
    for v in extra_vfs {
        wasm_cmd.arg("--vfs-ro").arg(v);
    }
    wasm_cmd.arg("--").args(py_args);
    let wasm = run_cmd_with_stdin(&mut wasm_cmd, stdin_bytes);

    assert_eq!(
        wasm.status.code(),
        native.status.code(),
        "{}: exit code mismatch (wasm={:?}, native={:?}, wasm_stderr={})",
        label,
        wasm.status.code(),
        native.status.code(),
        String::from_utf8_lossy(&wasm.stderr)
    );
    assert_eq!(
        wasm.stdout,
        native.stdout,
        "{}: stdout mismatch\nwasm:   {:?}\nnative: {:?}",
        label,
        String::from_utf8_lossy(&wasm.stdout),
        String::from_utf8_lossy(&native.stdout)
    );
    assert_eq!(
        wasm.stderr,
        native.stderr,
        "{}: stderr mismatch\nwasm:   {:?}\nnative: {:?}",
        label,
        String::from_utf8_lossy(&wasm.stderr),
        String::from_utf8_lossy(&native.stderr)
    );
}

#[test]
fn test_m4_python3_differential() {
    let wasm_path = temp_wasm_path("python3");
    translate_python3(&wasm_path);

    // 1. Basic print
    assert_diff_matches(&wasm_path, &[], &["-c", "print('hello')"], "print_hello");

    // 2. Stdlib imports (sys, os, json, math) + float formatting
    assert_diff_matches(
        &wasm_path,
        &[],
        &[
            "-c",
            "import sys, os, json, math; print(json.dumps({'pi': round(math.pi, 4), 'sum': sum(range(10))}))",
        ],
        "stdlib_json_math",
    );

    // 3. .py script file mounted via --vfs-ro
    let script_dir = std::env::temp_dir().join(format!("elf2wasm_m4_scripts_{}", std::process::id()));
    std::fs::create_dir_all(&script_dir).expect("create script dir");
    let script_path = script_dir.join("hello.py");
    std::fs::write(
        &script_path,
        "import json, math\nvals = [i * i for i in range(5)]\nprint(json.dumps({'vals': vals, 'sqrt2': round(math.sqrt(2), 5)}))\n",
    )
    .expect("write script");
    let script_dir_str = script_dir.to_string_lossy().into_owned();
    let vfs_spec = format!("{}:{}", script_dir_str, script_dir_str);
    let script_arg = script_path.to_string_lossy().into_owned();
    assert_diff_matches(&wasm_path, &[vfs_spec], &[&script_arg], "script_file");

    let _ = std::fs::remove_file(&script_path);
    let _ = std::fs::remove_dir(&script_dir);

    // 4. Runtime exception (1/0) and syntax error
    assert_diff_matches(&wasm_path, &[], &["-c", "1/0"], "runtime_exception");
    assert_diff_matches(&wasm_path, &[], &["-c", "def bad(:"], "syntax_error");

    // 5. Piped stdin differential tests
    assert_diff_matches_stdin(
        &wasm_path,
        &[],
        &["-c", "import sys; print(repr(sys.stdin.read()))"],
        b"hello\nworld\n",
        "stdin_sys_read",
    );
    assert_diff_matches_stdin(
        &wasm_path,
        &[],
        &["-"],
        b"x = 6 * 7\nprint(f'answer={x}')\n",
        "stdin_script_dash",
    );
    assert_diff_matches_stdin(
        &wasm_path,
        &[],
        &["-c", "import sys; print(repr(sys.stdin.read()))"],
        b"",
        "stdin_empty",
    );
    assert_diff_matches_stdin(
        &wasm_path,
        &[],
        &["-c", "import os; d = os.dup(0); print(os.read(d, 5), os.read(0, 10))"],
        b"abcdefghi",
        "stdin_dup0",
    );
    assert_diff_matches_stdin(
        &wasm_path,
        &[],
        &["-c", "import sys; print(list(sys.stdin.buffer.read()))"],
        b"\x00\x01\xff\n",
        "stdin_binary",
    );

    let _ = std::fs::remove_file(&wasm_path);
}
