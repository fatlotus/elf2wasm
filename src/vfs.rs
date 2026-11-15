pub use elf2wasm_runtime_core::vfs::*;

#[cfg(test)]
mod tests {
    use super::*;
    use elf2wasm_core::meta::MetaSoFile;
    use std::fs;

    #[test]
    fn test_vfs_sandbox_denials_and_embedded_so() {
        let so = MetaSoFile {
            guest_paths: vec!["/lib/x86_64-linux-gnu/libtest.so.1".to_string()],
            base_addr: 0x0200_0000,
            bytes: b"\x7fELFtest_so_payload".to_vec(),
        };
        let mut vfs = VirtualFs::new(&[so], &[]);

        assert_eq!(vfs.openat(AT_FDCWD, "/etc/ld.so.preload", O_RDONLY), -ENOENT);
        assert_eq!(vfs.openat(AT_FDCWD, "/etc/ld.so.cache", O_RDONLY), -ENOENT);
        assert_eq!(
            vfs.openat(AT_FDCWD, "/usr/lib/locale/locale-archive", O_RDONLY),
            -ENOENT
        );

        assert_eq!(
            vfs.openat(AT_FDCWD, "/lib/x86_64-linux-gnu/libtest.so.1", O_WRONLY),
            -EACCES
        );
        assert_eq!(
            vfs.openat(AT_FDCWD, "/lib/x86_64-linux-gnu/libtest.so.1", O_CREAT),
            -EACCES
        );

        let fd = vfs.openat(AT_FDCWD, "/lib/x86_64-linux-gnu/libtest.so.1", O_RDONLY) as i32;
        assert!(fd >= 3);
        let f = vfs.get_fd(fd).unwrap();
        assert_eq!(f.so_base_addr, Some(0x0200_0000));
        assert_eq!(vfs.pread64(fd, 4, 4).unwrap(), b"test");
        assert_eq!(vfs.stat_fd(fd).unwrap().st_size, 19);
        assert_eq!(vfs.close(fd), 0);
        assert_eq!(vfs.close(fd), -EBADF);
    }

    #[test]
    fn test_vfs_ro_mount_and_traversal_block() {
        let dir = std::env::temp_dir().join(format!("elf2wasm_vfs_test_{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let file = dir.join("hello.txt");
        fs::write(&file, b"sandbox_ok").unwrap();

        let mut vfs = VirtualFs::new(&[], &[(dir.clone(), "/mnt/ro".to_string())]);
        let fd = vfs.openat(AT_FDCWD, "/mnt/ro/hello.txt", O_RDONLY) as i32;
        assert!(fd >= 3);
        assert_eq!(vfs.read(fd, 64).unwrap(), b"sandbox_ok");
        assert_eq!(vfs.close(fd), 0);

        assert_eq!(
            vfs.openat(AT_FDCWD, "/mnt/ro/../../etc/passwd", O_RDONLY),
            -ENOENT
        );

        let _ = fs::remove_file(&file);
        let _ = fs::remove_dir(&dir);
    }

    #[test]
    fn test_vfs_stdin_and_dup0() {
        let mut vfs = VirtualFs::new(&[], &[]);
        vfs.stdin_data = b"hello_world".to_vec();

        assert_eq!(vfs.read(0, 5).unwrap(), b"hello");

        let dup_fd = vfs.dup(0) as i32;
        assert!(dup_fd >= 3);
        assert_eq!(vfs.read(dup_fd, 1).unwrap(), b"_");

        assert_eq!(vfs.read(0, 64).unwrap(), b"world");
        assert_eq!(vfs.read(dup_fd, 64).unwrap(), b"");
        assert_eq!(vfs.read(0, 64).unwrap(), b"");

        assert_eq!(vfs.read(1, 10), Err(-EBADF));
        assert_eq!(vfs.read(2, 10), Err(-EBADF));
    }

    #[test]
    fn test_proc_self_exe_lstat_vs_stat() {
        let mut vfs = VirtualFs::new(&[], &[]);
        vfs.elf_path = "/usr/bin/python3.11".to_string();

        let lstat = vfs
            .stat_path(AT_FDCWD, "/proc/self/exe", AT_SYMLINK_NOFOLLOW)
            .unwrap();
        assert_eq!(lstat.st_mode, S_IFLNK | 0o777);
        assert_eq!(lstat.st_nlink, 1);
        assert_eq!(lstat.st_size, "/usr/bin/python3.11".len() as i64);

        let stat = vfs.stat_path(AT_FDCWD, "/proc/self/exe", 0).unwrap();
        assert_eq!(stat.st_mode, S_IFREG | 0o755);
        assert_eq!(stat.st_nlink, 1);
        let expected_size = fs::metadata("/usr/bin/python3.11")
            .map(|m| m.len() as i64)
            .unwrap_or(0);
        assert_eq!(stat.st_size, expected_size);

        vfs.elf_path.clear();
        let pid_lstat = vfs
            .stat_path(AT_FDCWD, "/proc/1234/exe", AT_SYMLINK_NOFOLLOW)
            .unwrap();
        assert_eq!(pid_lstat.st_mode, S_IFLNK | 0o777);
        assert_eq!(pid_lstat.st_size, "/usr/bin/python3.11".len() as i64);
        assert_eq!(
            vfs.readlink(AT_FDCWD, "/proc/self/exe").unwrap(),
            b"/usr/bin/python3.11"
        );
    }
}
