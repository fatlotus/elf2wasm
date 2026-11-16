use std::fs;
use std::io::Write;
use std::os::unix::fs as unix_fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use wasm_encoder::{
    BlockType, CodeSection, CustomSection, ExportKind, ExportSection, Function, FunctionSection,
    GlobalSection, GlobalType, Instruction, MemorySection, MemoryType, Module, TypeSection,
    ValType,
};

fn elf2wasm_bin() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_elf2wasm"))
}

fn temp_path(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("elf2wasm_tier5_{}_{}", name, std::process::id()))
}

/// Build a minimal valid elf2wasm `.wasm` module that calls `syscall(nr, a0..a5)`
/// and returns the lower 32 bits of the syscall return value as `_start` exit code.
fn build_syscall_probe_wasm(
    nr: i64,
    a0: i64,
    a1: i64,
    a2: i64,
    a3: i64,
    a4: i64,
    a5: i64,
) -> Vec<u8> {
    build_multi_syscall_wasm(&[(nr, a0, a1, a2, a3, a4, a5)])
}

/// Build a synthetic `.wasm` that runs a sequence of syscalls and exits with the last one's i32 result.
fn build_multi_syscall_wasm(calls: &[(i64, i64, i64, i64, i64, i64, i64)]) -> Vec<u8> {
    let mut module = Module::new();
    let mut types = TypeSection::new();
    types.ty().function(vec![], vec![ValType::I32]); // 0: _start
    module.section(&types);

    let mut funcs = FunctionSection::new();
    funcs.function(0);
    module.section(&funcs);

    let mut mems = MemorySection::new();
    mems.memory(MemoryType {
        minimum: 4096, // 256 MB
        maximum: None,
        memory64: false,
        shared: false,
        page_size_log2: None,
    });
    module.section(&mems);

    // Globals:
    // 0: rsp (i64)
    // 1: rip (i64)
    // 2: yield_flag (i32)
    // 3: exit_flag (i32)
    // 4: exit_code (i32)
    // 5: rcx (i64)
    // 6: rax (i64)
    // 7: rdi (i64)
    // 8: rsi (i64)
    // 9: rdx (i64)
    // 10: r10 (i64)
    // 11: r8 (i64)
    // 12: r9 (i64)
    let mut globals = GlobalSection::new();
    let i64_mut = GlobalType {
        val_type: ValType::I64,
        mutable: true,
        shared: false,
    };
    let i32_mut = GlobalType {
        val_type: ValType::I32,
        mutable: true,
        shared: false,
    };
    globals.global(i64_mut, &wasm_encoder::ConstExpr::i64_const(0)); // 0: rsp
    globals.global(i64_mut, &wasm_encoder::ConstExpr::i64_const(0)); // 1: rip
    globals.global(i32_mut, &wasm_encoder::ConstExpr::i32_const(0)); // 2: yield_flag
    globals.global(i32_mut, &wasm_encoder::ConstExpr::i32_const(0)); // 3: exit_flag
    globals.global(i32_mut, &wasm_encoder::ConstExpr::i32_const(0)); // 4: exit_code
    for _ in 0..8 {
        // 5..=12: rcx, rax, rdi, rsi, rdx, r10, r8, r9
        globals.global(i64_mut, &wasm_encoder::ConstExpr::i64_const(0));
    }
    module.section(&globals);

    let mut exports = ExportSection::new();
    exports.export("memory", ExportKind::Memory, 0);
    exports.export("rsp", ExportKind::Global, 0);
    exports.export("rip", ExportKind::Global, 1);
    exports.export("yield_flag", ExportKind::Global, 2);
    exports.export("exit_flag", ExportKind::Global, 3);
    exports.export("exit_code", ExportKind::Global, 4);
    exports.export("rcx", ExportKind::Global, 5);
    exports.export("rax", ExportKind::Global, 6);
    exports.export("rdi", ExportKind::Global, 7);
    exports.export("rsi", ExportKind::Global, 8);
    exports.export("rdx", ExportKind::Global, 9);
    exports.export("r10", ExportKind::Global, 10);
    exports.export("r8", ExportKind::Global, 11);
    exports.export("r9", ExportKind::Global, 12);
    exports.export("_start", ExportKind::Func, 0);
    module.section(&exports);

    let mut code = CodeSection::new();
    let mut f = Function::new([]);
    for (idx, &(nr, a0, a1, a2, a3, a4, a5)) in calls.iter().enumerate() {
        f.instruction(&Instruction::GlobalGet(1)); // rip
        f.instruction(&Instruction::I64Const(idx as i64));
        f.instruction(&Instruction::I64Eq);
        f.instruction(&Instruction::If(BlockType::Empty));
        f.instruction(&Instruction::I64Const(nr));
        f.instruction(&Instruction::GlobalSet(6)); // rax
        f.instruction(&Instruction::I64Const(a0));
        f.instruction(&Instruction::GlobalSet(7)); // rdi
        f.instruction(&Instruction::I64Const(a1));
        f.instruction(&Instruction::GlobalSet(8)); // rsi
        f.instruction(&Instruction::I64Const(a2));
        f.instruction(&Instruction::GlobalSet(9)); // rdx
        f.instruction(&Instruction::I64Const(a3));
        f.instruction(&Instruction::GlobalSet(10)); // r10
        f.instruction(&Instruction::I64Const(a4));
        f.instruction(&Instruction::GlobalSet(11)); // r8
        f.instruction(&Instruction::I64Const(a5));
        f.instruction(&Instruction::GlobalSet(12)); // r9
        f.instruction(&Instruction::I64Const((idx + 1) as i64));
        f.instruction(&Instruction::GlobalSet(1)); // rip
        f.instruction(&Instruction::I64Const((idx + 1) as i64));
        f.instruction(&Instruction::GlobalSet(5)); // rcx
        f.instruction(&Instruction::I32Const(3)); // YIELD_SYSCALL_PENDING
        f.instruction(&Instruction::GlobalSet(2)); // yield_flag
        f.instruction(&Instruction::I32Const(0));
        f.instruction(&Instruction::Return);
        f.instruction(&Instruction::End);
    }
    if calls.is_empty() {
        f.instruction(&Instruction::I32Const(0));
    } else {
        f.instruction(&Instruction::GlobalGet(6)); // rax
        f.instruction(&Instruction::I32WrapI64);
    }
    f.instruction(&Instruction::End);
    code.function(&f);
    module.section(&code);

    // Minimal elf2wasm_meta custom section:
    // MAGIC("ELF2WASM") + 7*u32(0) + num_so(0) + num_sym(0) + elf_path("")
    let mut meta = Vec::from(*b"ELF2WASM");
    meta.extend_from_slice(&[0u8; 7 * 4 + 4 + 4 + 4]);
    module.section(&CustomSection {
        name: std::borrow::Cow::Borrowed("elf2wasm_meta"),
        data: std::borrow::Cow::Borrowed(&meta),
    });

    module.finish()
}

fn run_synthetic_wasm(name: &str, wasm_bytes: &[u8]) -> std::process::Output {
    let p = temp_path(&format!("{name}.wasm"));
    fs::write(&p, wasm_bytes).expect("write synthetic wasm");
    let out = Command::new(elf2wasm_bin())
        .arg("run")
        .arg(&p)
        .output()
        .expect("run synthetic wasm");
    let _ = fs::remove_file(&p);
    out
}

fn translate_python3_once(wasm_path: &PathBuf) {
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
        .expect("translate python3");
    assert!(status.success());
}

/// Build a minimal 64-bit ELF with one PT_LOAD segment.
fn build_minimal_elf64(
    e_type: u16,
    e_machine: u16,
    e_entry: u64,
    p_flags: u32,
    p_offset: u64,
    p_vaddr: u64,
    p_filesz: u64,
    p_memsz: u64,
    payload: &[u8],
) -> Vec<u8> {
    let mut buf = vec![0u8; 64 + 56 + payload.len()];
    buf[0..4].copy_from_slice(b"\x7fELF");
    buf[4] = 2; // ELFCLASS64
    buf[5] = 1; // ELFDATA2LSB
    buf[6] = 1; // EV_CURRENT
    buf[16..18].copy_from_slice(&e_type.to_le_bytes());
    buf[18..20].copy_from_slice(&e_machine.to_le_bytes());
    buf[20..24].copy_from_slice(&1u32.to_le_bytes()); // e_version
    buf[24..32].copy_from_slice(&e_entry.to_le_bytes());
    buf[32..40].copy_from_slice(&64u64.to_le_bytes()); // e_phoff
    buf[52..54].copy_from_slice(&64u16.to_le_bytes()); // e_ehsize
    buf[54..56].copy_from_slice(&56u16.to_le_bytes()); // e_phentsize
    buf[56..58].copy_from_slice(&1u16.to_le_bytes()); // e_phnum

    let ph = &mut buf[64..120];
    ph[0..4].copy_from_slice(&1u32.to_le_bytes());
    ph[4..8].copy_from_slice(&p_flags.to_le_bytes());
    ph[8..16].copy_from_slice(&p_offset.to_le_bytes());
    ph[16..24].copy_from_slice(&p_vaddr.to_le_bytes());
    ph[24..32].copy_from_slice(&p_vaddr.to_le_bytes());
    ph[32..40].copy_from_slice(&p_filesz.to_le_bytes());
    ph[40..48].copy_from_slice(&p_memsz.to_le_bytes());
    ph[48..56].copy_from_slice(&0x1000u64.to_le_bytes());

    buf[120..120 + payload.len()].copy_from_slice(payload);
    buf
}

fn assert_translate_rejects(name: &str, elf_bytes: &[u8]) {
    let elf_path = temp_path(&format!("{}.elf", name));
    let wasm_path = temp_path(&format!("{}.wasm", name));
    fs::write(&elf_path, elf_bytes).unwrap();
    let out = Command::new(elf2wasm_bin())
        .args(["translate"])
        .arg(&elf_path)
        .arg("-o")
        .arg(&wasm_path)
        .output()
        .expect("failed to spawn elf2wasm");
    let _ = fs::remove_file(&elf_path);
    let _ = fs::remove_file(&wasm_path);
    assert!(
        !out.status.success(),
        "{}: expected translate to return Err (non-zero exit), but it succeeded!",
        name
    );
}

#[test]
fn test_tier5_vfs_traversal_symlink_escape_and_deny_paths() {
    let wasm_path = temp_path("py3_vfs.wasm");
    translate_python3_once(&wasm_path);

    let base = temp_path("vfs_jail");
    let ro_dir = base.join("ro");
    let sub_dir = ro_dir.join("sub");
    let outside_secret = base.join("secret.txt");
    let _ = fs::remove_dir_all(&base);
    fs::create_dir_all(&sub_dir).unwrap();
    fs::write(ro_dir.join("ok.txt"), b"inside_ro").unwrap();
    fs::write(&outside_secret, b"TOP_SECRET").unwrap();
    unix_fs::symlink(&outside_secret, ro_dir.join("escape_link.txt")).unwrap();

    let script = r#"
import os, errno

def expect_err(fn, expected):
    try:
        fn()
        raise AssertionError(f"expected {expected}, got success")
    except OSError as e:
        assert e.errno in expected, f"got errno {e.errno}, expected {expected}"

# 1. Normalization & traversal escapes
assert open('/mnt/ro//./sub/../ok.txt', 'rb').read() == b'inside_ro'
expect_err(lambda: open('/mnt/ro/../../etc/passwd', 'rb'), (errno.ENOENT,))
expect_err(lambda: open('/mnt/ro/../secret.txt', 'rb'), (errno.ENOENT,))

# 2. dirfd-relative traversal escape
dfd = os.open('/mnt/ro/sub', os.O_RDONLY)
expect_err(lambda: os.open('../../etc/passwd', os.O_RDONLY, dir_fd=dfd), (errno.ENOENT,))
os.close(dfd)

# 3. Symlink inside --vfs-ro pointing outside host_root must be blocked on open AND filtered from getdents64
expect_err(lambda: open('/mnt/ro/escape_link.txt', 'rb'), (errno.ENOENT,))
entries = os.listdir('/mnt/ro')
assert 'ok.txt' in entries
assert 'escape_link.txt' not in entries, f"escaping symlink leaked in listdir: {entries}"

# 4. DENY_PATHS (direct + normalized variants)
for p in ['/etc/ld.so.preload', '/etc//ld.so.preload', '/etc/./ld.so.cache', '/usr/lib/locale/locale-archive']:
    expect_err(lambda p=p: open(p, 'rb'), (errno.ENOENT,))

print("VFS_TRAVERSAL_OK")
"#;

    let out = Command::new(elf2wasm_bin())
        .arg("run")
        .arg(&wasm_path)
        .args([
            "--vfs-ro",
            "/usr/lib/python3.11:/usr/lib/python3.11",
            "--vfs-ro",
            "/usr/lib/python3/dist-packages:/usr/lib/python3/dist-packages",
            "--vfs-ro",
            &format!("{}:/mnt/ro", ro_dir.display()),
            "--",
            "-c",
            script,
        ])
        .output()
        .unwrap();

    let _ = fs::remove_dir_all(&base);
    let _ = fs::remove_file(&wasm_path);

    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&out.stdout).trim(),
        "VFS_TRAVERSAL_OK"
    );
}

#[test]
fn test_tier5_write_and_mutate_syscalls_blocked() {
    let wasm_path = temp_path("py3_mut.wasm");
    translate_python3_once(&wasm_path);

    let ro_dir = temp_path("vfs_mut_ro");
    let _ = fs::remove_dir_all(&ro_dir);
    fs::create_dir_all(&ro_dir).unwrap();
    fs::write(ro_dir.join("target.txt"), b"immutable").unwrap();

    let script = r#"
import os, errno

def expect_err(fn, expected):
    try:
        fn()
        raise AssertionError("expected failure")
    except OSError as e:
        assert e.errno in expected, f"unexpected errno {e.errno}"

for flags in [os.O_WRONLY, os.O_RDWR, os.O_CREAT, os.O_TRUNC, os.O_RDONLY | os.O_CREAT, os.O_RDONLY | os.O_TRUNC, 3]:
    expect_err(lambda f=flags: os.open('/mnt/ro/target.txt', f), (errno.EACCES, errno.EROFS))

expect_err(lambda: os.unlink('/mnt/ro/target.txt'), (errno.ENOSYS, errno.EROFS, errno.EACCES))
expect_err(lambda: os.rename('/mnt/ro/target.txt', '/mnt/ro/new.txt'), (errno.ENOSYS, errno.EROFS, errno.EACCES))
expect_err(lambda: os.mkdir('/mnt/ro/newdir'), (errno.ENOSYS, errno.EROFS, errno.EACCES))
expect_err(lambda: os.chmod('/mnt/ro/target.txt', 0o777), (errno.ENOSYS, errno.EROFS, errno.EACCES))
assert (open('/mnt/ro/target.txt', 'rb').read() == b'immutable')
print("MUTATE_BLOCKED_OK")
"#;

    let out = Command::new(elf2wasm_bin())
        .arg("run")
        .arg(&wasm_path)
        .args([
            "--vfs-ro",
            "/usr/lib/python3.11:/usr/lib/python3.11",
            "--vfs-ro",
            "/usr/lib/python3/dist-packages:/usr/lib/python3/dist-packages",
            "--vfs-ro",
            &format!("{}:/mnt/ro", ro_dir.display()),
            "--",
            "-c",
            script,
        ])
        .output()
        .unwrap();

    assert_eq!(fs::read(ro_dir.join("target.txt")).unwrap(), b"immutable");
    let _ = fs::remove_dir_all(&ro_dir);
    let _ = fs::remove_file(&wasm_path);

    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&out.stdout).trim(),
        "MUTATE_BLOCKED_OK"
    );
}

#[test]
fn test_tier5_mmap_mremap_brk_bounds_and_overflow() {
    // SYS_MMAP = 9, SYS_MREMAP = 25, SYS_BRK = 12
    const MAP_PRIVATE_ANON: i64 = 0x22;
    const MAP_FIXED_ANON: i64 = 0x32;
    const ENOMEM: i32 = 12;
    const EFAULT: i32 = 14;
    const EINVAL: i32 = 22;

    // 1. mmap with len = 0 -> -EINVAL (-22)
    let out = run_synthetic_wasm(
        "mmap_zero",
        &build_syscall_probe_wasm(9, 0, 0, 3, MAP_PRIVATE_ANON, -1, 0),
    );
    assert_eq!(out.status.code(), Some((-EINVAL) as u8 as i32));

    // 2. mmap with len = usize::MAX -> must return -ENOMEM (-12), not panic or wrap
    let out = run_synthetic_wasm(
        "mmap_max",
        &build_syscall_probe_wasm(9, 0, -1, 3, MAP_PRIVATE_ANON, -1, 0),
    );
    assert_eq!(out.status.code(), Some((-ENOMEM) as u8 as i32));

    // 3. mmap with len = 0x1_0000_1000 must return -ENOMEM without leaking mmap_cursor,
    //    so a subsequent mmap(4096) still gets MMAP_START (0x0800_0000, low byte 0x00).
    let out = run_synthetic_wasm(
        "mmap_trunc",
        &build_multi_syscall_wasm(&[
            (9, 0, 0x1_0000_1000, 3, MAP_PRIVATE_ANON, -1, 0),
            (9, 0, 4096, 3, MAP_PRIVATE_ANON, -1, 0),
        ]),
    );
    assert_eq!(out.status.code(), Some(0));

    // 4. MAP_FIXED at addr = 0 -> -EINVAL (must fail cleanly, not trap host)
    let out = run_synthetic_wasm(
        "mmap_fixed0",
        &build_syscall_probe_wasm(9, 0, 4096, 3, MAP_FIXED_ANON, -1, 0),
    );
    assert_eq!(out.status.code(), Some((-EINVAL) as u8 as i32));

    // 5. MAP_FIXED with 64-bit addr 0x1_0000_0000 -> -ENOMEM (must not truncate to 0)
    let out = run_synthetic_wasm(
        "mmap_fixed_hi",
        &build_syscall_probe_wasm(9, 0x1_0000_0000, 4096, 3, MAP_FIXED_ANON, -1, 0),
    );
    assert_eq!(out.status.code(), Some((-ENOMEM) as u8 as i32));

    // 6. mremap with OOB old_addr -> -EFAULT without leaking mmap_cursor
    let out = run_synthetic_wasm(
        "mremap_efault",
        &build_syscall_probe_wasm(25, 0x7FFF_FFFF, 4096, 8192, 1, 0, 0),
    );
    assert_eq!(out.status.code(), Some((-EFAULT) as u8 as i32));

    // 7. brk(0) and brk(u64::MAX) must both return BRK_START (0x0500_0000), never panic
    let out = run_synthetic_wasm("brk_max", &build_syscall_probe_wasm(12, -1, 0, 0, 0, 0, 0));
    assert_eq!(out.status.code(), Some((0x0500_0000u32 & 0xff) as i32));
}

#[test]
fn test_tier5_io_fd_and_iovec_edge_cases() {
    // SYS_READ = 0, SYS_WRITE = 1, SYS_CLOSE = 3, SYS_FSTAT = 5, SYS_LSEEK = 8,
    // SYS_PREAD64 = 17, SYS_WRITEV = 20, SYS_DUP2 = 33, SYS_UNAME = 63,
    // SYS_GETCWD = 79, SYS_READLINK = 89, SYS_SYSINFO = 99, SYS_PIPE2 = 293, SYS_GETRANDOM = 318
    const EBADF: i32 = 9;
    const EFAULT: i32 = 14;
    const EINVAL: i32 = 22;

    // 1. read/write/close on fd = -1 and fd = 9999 -> -EBADF
    for &(nr, fd) in &[
        (0, -1),
        (0, 9999),
        (1, -1),
        (1, 9999),
        (3, -1),
        (3, 9999),
        (17, -1),
    ] {
        let out = run_synthetic_wasm(
            &format!("badfd_{nr}_{fd}"),
            &build_syscall_probe_wasm(nr, fd, 0x0500_0000, 16, 0, 0, 0),
        );
        assert_eq!(out.status.code(), Some((-EBADF) as u8 as i32));
    }

    // 2. NULL pointer (addr == 0) must return -EFAULT on uname, getcwd, pipe2, fstat, read, sysinfo
    for (name, call) in [
        ("uname_null", (63, 0, 0, 0, 0, 0, 0)),
        ("getcwd_null", (79, 0, 64, 0, 0, 0, 0)),
        ("pipe2_null", (293, 0, 0, 0, 0, 0, 0)),
        ("fstat_null", (5, 0, 0, 0, 0, 0, 0)),
        ("read_null", (0, 0, 0, 10, 0, 0, 0)),
        ("sysinfo_null", (99, 0, 0, 0, 0, 0, 0)),
    ] {
        let out = run_synthetic_wasm(
            name,
            &build_syscall_probe_wasm(call.0, call.1, call.2, call.3, call.4, call.5, call.6),
        );
        assert_eq!(
            out.status.code(),
            Some((-EFAULT) as u8 as i32),
            "{name} did not return -EFAULT"
        );
    }

    // 3. writev with iov_addr = u64::MAX - 8 and iovcnt = 2 -> must return -EFAULT, NOT panic on u64 overflow
    let out = run_synthetic_wasm(
        "writev_ovf",
        &build_syscall_probe_wasm(20, 1, -9i64, 2, 0, 0, 0),
    );
    assert_eq!(out.status.code(), Some((-EFAULT) as u8 as i32));

    // 4. writev with OOB iov_addr (0x7FFF_FFFF) -> -EFAULT
    let out = run_synthetic_wasm(
        "writev_oob",
        &build_syscall_probe_wasm(20, 1, 0x7FFF_FFFF, 1, 0, 0, 0),
    );
    assert_eq!(out.status.code(), Some((-EFAULT) as u8 as i32));

    // 5. dup2(0, i32::MAX) -> -EBADF, must NOT panic on next_fd = newfd + 1 overflow
    let out = run_synthetic_wasm(
        "dup2_max",
        &build_syscall_probe_wasm(33, 0, i32::MAX as i64, 0, 0, 0, 0),
    );
    assert_eq!(out.status.code(), Some((-EBADF) as u8 as i32));

    // 6. getrandom(0x0500_0000, usize::MAX, 0) -> -EFAULT, NOT host OOM panic!
    let out = run_synthetic_wasm(
        "getrandom_max",
        &build_syscall_probe_wasm(318, 0x0500_0000, -1, 0, 0, 0, 0),
    );
    assert_eq!(out.status.code(), Some((-EFAULT) as u8 as i32));

    // 7. readlink with negative bufsiz (-1) -> -EINVAL
    let out = run_synthetic_wasm(
        "readlink_neg",
        &build_syscall_probe_wasm(89, 0x0500_0000, 0x0500_0100, -1, 0, 0, 0),
    );
    assert_eq!(out.status.code(), Some((-EINVAL) as u8 as i32));

    // 8. pipe2(OOB) must not leak FDs: if pipe2(0, 0) fails, subsequent pipe2(valid) still gets fd 3,4
    let out = run_synthetic_wasm(
        "pipe2_no_leak",
        &build_multi_syscall_wasm(&[
            (293, 0, 0, 0, 0, 0, 0),           // -EFAULT
            (293, 0x0500_0000, 0, 0, 0, 0, 0), // succeeds, allocates 3 & 4
            (3, 3, 0, 0, 0, 0, 0),             // close(3) -> 0
        ]),
    );
    assert_eq!(out.status.code(), Some(0));
}

#[test]
fn test_tier5_getdents64_readlink_and_pipe2_edge_cases() {
    let wasm_path = temp_path("py3_edge.wasm");
    translate_python3_once(&wasm_path);

    let script = r#"
import os, errno

# readlink("/proc/self/exe") works
target = os.readlink('/proc/self/exe')
assert len(target) > 0

# pipe2 creates pipe FDs >= 3 and lseek on pipe FDs returns ESPIPE
r, w = os.pipe()
assert r >= 3 and w >= 3
try:
    os.lseek(r, 0, os.SEEK_SET)
    raise AssertionError("expected ESPIPE on pipe")
except OSError as e:
    assert e.errno == errno.ESPIPE, f"got {e.errno}"
os.close(r)
os.close(w)

# lseek on stdin returns ESPIPE
try:
    os.lseek(0, 0, os.SEEK_SET)
    raise AssertionError("expected ESPIPE on stdin")
except OSError as e:
    assert e.errno == errno.ESPIPE

print("EDGE_OK")
"#;

    let mut child = Command::new(elf2wasm_bin())
        .arg("run")
        .arg(&wasm_path)
        .args([
            "--vfs-ro",
            "/usr/lib/python3.11:/usr/lib/python3.11",
            "--vfs-ro",
            "/usr/lib/python3/dist-packages:/usr/lib/python3/dist-packages",
            "--",
            "-c",
            script,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(b"abc").unwrap();
    let out = child.wait_with_output().unwrap();
    let _ = fs::remove_file(&wasm_path);

    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "EDGE_OK");
}

#[test]
fn test_t5_malformed_elf_non_x86_64_and_et_rel() {
    // 1. AArch64 (e_machine = 183)
    let aarch64 = build_minimal_elf64(2, 183, 0x400078, 5, 120, 0x400000, 4, 4, &[0xc3, 0, 0, 0]);
    assert_translate_rejects("aarch64_e_machine", &aarch64);

    // 2. ET_REL (e_type = 1, e_machine = 62)
    let et_rel = build_minimal_elf64(1, 62, 0x400078, 5, 120, 0x400000, 4, 4, &[0xc3, 0, 0, 0]);
    assert_translate_rejects("et_rel", &et_rel);
}

#[test]
fn test_t5_malformed_elf_bounds_and_truncation() {
    // 1. Truncated ELF (only 16 bytes)
    assert_translate_rejects(
        "truncated_16b",
        b"\x7fELF\x02\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00",
    );

    // 2. p_filesz > p_memsz (must return Err, never panic!)
    let filesz_gt_memsz =
        build_minimal_elf64(2, 62, 0x400078, 5, 120, 0x400000, 16, 4, &[0xc3; 16]);
    assert_translate_rejects("p_filesz_gt_p_memsz", &filesz_gt_memsz);

    // 3. p_offset + p_filesz out of bounds
    let oob_filesz = build_minimal_elf64(2, 62, 0x400078, 5, 120, 0x400000, 4096, 4096, &[0xc3]);
    assert_translate_rejects("p_offset_plus_filesz_oob", &oob_filesz);

    // 4. Huge p_memsz (100 GB) - must return Err, never OOM abort
    let huge_memsz = build_minimal_elf64(
        2,
        62,
        0x400078,
        5,
        120,
        0x400000,
        1,
        100 * 1024 * 1024 * 1024,
        &[0xc3],
    );
    assert_translate_rejects("huge_p_memsz", &huge_memsz);

    // 5. 64-bit vaddr exceeding 32-bit guest address space
    let high_vaddr = build_minimal_elf64(
        2,
        62,
        0x0000_0001_0040_0078,
        5,
        120,
        0x0000_0001_0040_0000,
        1,
        1,
        &[0xc3],
    );
    assert_translate_rejects("vaddr_above_4gb", &high_vaddr);

    // 6. Segment overlapping STACK_TOP (0x0BFF_0000)
    let overlap_stack =
        build_minimal_elf64(2, 62, 0x0BFF_0000, 5, 120, 0x0BFF_0000, 1, 1, &[0xc3]);
    assert_translate_rejects("vaddr_overlap_stack", &overlap_stack);
}

#[test]
fn test_t5_wasm_meta_huge_length_via_cli_run() {
    // Craft a minimal valid WASM header + custom section "elf2wasm_meta" with num_so = u32::MAX
    let mut meta = Vec::new();
    meta.extend_from_slice(b"ELF2WASM");
    meta.extend_from_slice(&[0u8; 7 * 4]); // entry_rip..max_code_addr
    meta.extend_from_slice(&u32::MAX.to_le_bytes()); // num_so = 0xFFFF_FFFF

    let sec_name = b"elf2wasm_meta";
    let mut custom_sec = Vec::new();
    custom_sec.push(sec_name.len() as u8);
    custom_sec.extend_from_slice(sec_name);
    custom_sec.extend_from_slice(&meta);

    let mut wasm = Vec::from(&b"\0asm\x01\x00\x00\x00"[..]);
    wasm.push(0); // custom section id
    wasm.push(custom_sec.len() as u8); // LEB128 (< 128)
    wasm.extend_from_slice(&custom_sec);

    let wasm_path = temp_path("bad_meta.wasm");
    fs::write(&wasm_path, &wasm).unwrap();
    let out = Command::new(elf2wasm_bin())
        .args(["run"])
        .arg(&wasm_path)
        .output()
        .expect("failed to spawn elf2wasm run");
    let _ = fs::remove_file(&wasm_path);
    assert!(
        !out.status.success(),
        "run with huge num_so in elf2wasm_meta must fail cleanly, not OOM/panic"
    );
}

#[test]
fn test_t5_python3_sandbox_blocks_and_stress() {
    let wasm_path = temp_path("python3_t5.wasm");
    translate_python3_once(&wasm_path);

    let run_py = |code: &str| {
        Command::new(elf2wasm_bin())
            .arg("run")
            .arg(&wasm_path)
            .args([
                "--vfs-ro",
                "/usr/lib/python3.11:/usr/lib/python3.11",
                "--vfs-ro",
                "/usr/lib/python3/dist-packages:/usr/lib/python3/dist-packages",
                "--",
                "-c",
                code,
            ])
            .output()
            .expect("failed to run python3.wasm")
    };

    // 1. ctypes blocked cleanly (untranslated .so -> ModuleNotFoundError / ImportError)
    let out = run_py("import ctypes");
    assert!(!out.status.success());
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("ModuleNotFoundError") || stderr.contains("ImportError"),
        "unexpected stderr: {stderr}"
    );

    // 2. os.fork works inside sandboxed multi-process runtime (zero host processes)
    let out = run_py(
        "import os\npid = os.fork()\nif pid == 0:\n os._exit(7)\n_, st = os.waitpid(pid, 0)\nprint('FORK_OK', os.waitstatus_to_exitcode(st))",
    );
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    assert!(String::from_utf8_lossy(&out.stdout).contains("FORK_OK 7"));

    // 3. large allocation (triggers glibc anonymous mmap) works inside sandbox
    let out = run_py(
        "b = bytearray(1024 * 1024); b[0:2] = b'ok'; print(bytes(b[0:2]))",
    );
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "b'ok'");

    // 4. signal.signal stub works cleanly
    let out = run_py("import signal; signal.signal(signal.SIGINT, signal.SIG_IGN); print('SIG_OK')");
    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "SIG_OK");

    // 5. Deeply nested recursion + indirect dispatch stress (500 levels)
    let out = run_py("import sys; sys.setrecursionlimit(2000)\ndef f(n): return 1 if n <= 0 else f(n-1) + 1\nprint(f(500))");
    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "501");

    let _ = fs::remove_file(&wasm_path);
}
