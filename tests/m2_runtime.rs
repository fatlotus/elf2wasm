use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::Instant;

fn elf2wasm_bin() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_elf2wasm"))
}

fn compile_and_translate(name: &str, c_src: &str, extra_gcc: &[&str]) -> Option<(PathBuf, PathBuf)> {
    let dir = std::env::temp_dir().join(format!("elf2wasm_m2_{}_{}", name, std::process::id()));
    let _ = fs::create_dir_all(&dir);
    let c_path = dir.join(format!("{}.c", name));
    let bin_path = dir.join(name);
    let wasm_path = dir.join(format!("{}.wasm", name));

    fs::write(&c_path, c_src).unwrap();

    let gcc = Command::new("gcc")
        .arg("-O2")
        .arg(&c_path)
        .args(extra_gcc)
        .arg("-o")
        .arg(&bin_path)
        .output();
    let Ok(gcc_out) = gcc else {
        return None;
    };
    assert!(
        gcc_out.status.success(),
        "gcc failed: {}",
        String::from_utf8_lossy(&gcc_out.stderr)
    );

    let tr_out = Command::new(elf2wasm_bin())
        .arg("translate")
        .arg(&bin_path)
        .args([
            "--so",
            "/lib64/ld-linux-x86-64.so.2",
            "--so",
            "/lib/x86_64-linux-gnu/libc.so.6",
            "-o",
        ])
        .arg(&wasm_path)
        .output()
        .expect("failed to run elf2wasm translate");
    assert!(
        tr_out.status.success(),
        "translate failed: {}",
        String::from_utf8_lossy(&tr_out.stderr)
    );

    Some((dir, wasm_path))
}

#[test]
fn test_m2_writable_vfs_overlay() {
    let c_src = r#"
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

int main(void) {
    if (mkdir("/tmp/m2_dir", 0755) != 0) return 1;
    int fd = open("/tmp/m2_dir/a.txt", O_CREAT | O_RDWR | O_TRUNC, 0644);
    if (fd < 0) return 2;
    if (write(fd, "hello", 5) != 5) return 3;
    close(fd);

    fd = open("/tmp/m2_dir/a.txt", O_WRONLY | O_APPEND);
    if (fd < 0) return 4;
    if (write(fd, "_m2", 3) != 3) return 5;
    close(fd);

    if (rename("/tmp/m2_dir/a.txt", "/tmp/m2_dir/b.txt") != 0) return 6;
    struct stat st;
    if (stat("/tmp/m2_dir/b.txt", &st) != 0) return 7;

    fd = open("/tmp/m2_dir/b.txt", O_RDONLY);
    if (fd < 0) return 8;
    char buf[32] = {0};
    ssize_t n = read(fd, buf, sizeof(buf) - 1);
    close(fd);
    if (n != 8) return 9;

    if (unlink("/tmp/m2_dir/b.txt") != 0) return 10;
    if (rmdir("/tmp/m2_dir") != 0) return 11;

    printf("%s:%ld\n", buf, (long)st.st_size);
    return 0;
}
"#;

    let Some((dir, wasm_path)) = compile_and_translate("vfs_test", c_src, &[]) else {
        return;
    };

    let out = Command::new(elf2wasm_bin())
        .arg("run")
        .arg(&wasm_path)
        .output()
        .expect("failed to run vfs_test.wasm");
    let _ = fs::remove_dir_all(&dir);

    assert!(
        out.status.success(),
        "vfs_test failed (code={:?}): {}",
        out.status.code(),
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "hello_m2:8");
}

#[test]
fn test_m2_fast_sleep_virtual_time() {
    let c_src = r#"
#include <stdio.h>
#include <time.h>
#include <unistd.h>

int main(void) {
    struct timespec t0, t1;
    clock_gettime(CLOCK_MONOTONIC, &t0);
    sleep(30);
    clock_gettime(CLOCK_MONOTONIC, &t1);
    long long delta_ns = (long long)(t1.tv_sec - t0.tv_sec) * 1000000000LL
                       + (long long)(t1.tv_nsec - t0.tv_nsec);
    printf("delta_s=%.3f\n", (double)delta_ns / 1e9);
    return delta_ns >= 30000000000LL ? 0 : 1;
}
"#;

    let Some((dir, wasm_path)) = compile_and_translate("sleep_test", c_src, &[]) else {
        return;
    };

    let t0 = Instant::now();
    let out = Command::new(elf2wasm_bin())
        .arg("run")
        .arg(&wasm_path)
        .output()
        .expect("failed to run sleep_test.wasm");
    let elapsed = t0.elapsed();
    let _ = fs::remove_dir_all(&dir);

    assert!(
        out.status.success(),
        "sleep_test failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        elapsed.as_secs() < 15,
        "sleep(30) took too long on host (expected << 30s even with JIT): {:?}",
        elapsed
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("delta_s=30."), "unexpected stdout: {}", stdout);
}

#[test]
fn test_m2_deterministic_racy_pthreads() {
    let c_src = r#"
#include <pthread.h>
#include <stdio.h>

static volatile int counter = 0;

static void *worker(void *arg) {
    (void)arg;
    for (int i = 0; i < 200; i++) {
        int v = counter;
        for (volatile int d = 0; d < 200; d++) {}
        counter = v + 1;
    }
    return NULL;
}

int main(void) {
    pthread_t th[4];
    for (int i = 0; i < 4; i++) {
        if (pthread_create(&th[i], NULL, worker, NULL) != 0) return 1;
    }
    for (int i = 0; i < 4; i++) {
        pthread_join(th[i], NULL);
    }
    printf("counter=%d\n", counter);
    return 0;
}
"#;

    let Some((dir, wasm_path)) = compile_and_translate("racy_pthreads", c_src, &["-pthread"]) else {
        return;
    };

    let run1 = Command::new(elf2wasm_bin())
        .arg("run")
        .arg(&wasm_path)
        .output()
        .expect("run 1 failed");
    let run2 = Command::new(elf2wasm_bin())
        .arg("run")
        .arg(&wasm_path)
        .output()
        .expect("run 2 failed");
    let _ = fs::remove_dir_all(&dir);

    assert!(
        run1.status.success(),
        "run1 failed: {}",
        String::from_utf8_lossy(&run1.stderr)
    );
    assert!(
        run2.status.success(),
        "run2 failed: {}",
        String::from_utf8_lossy(&run2.stderr)
    );
    assert_eq!(run1.stdout, run2.stdout, "racy pthread output must be deterministic");

    let s = String::from_utf8_lossy(&run1.stdout);
    let val: i32 = s
        .trim()
        .strip_prefix("counter=")
        .expect("missing counter= prefix")
        .parse()
        .expect("invalid counter");
    assert!(
        val > 0 && val < 800,
        "expected race condition (0 < counter < 800), got {}",
        val
    );
}
