use crate::meta::MetaSoFile;
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

pub const ENOENT: i64 = 2;
pub const EIO: i64 = 5;
pub const EBADF: i64 = 9;
pub const ENOMEM: i64 = 12;
pub const EACCES: i64 = 13;
pub const EFAULT: i64 = 14;
pub const ENOTDIR: i64 = 20;
pub const EISDIR: i64 = 21;
pub const EINVAL: i64 = 22;
pub const EMFILE: i64 = 24;
pub const ENOTTY: i64 = 25;
pub const ESPIPE: i64 = 29;
pub const ERANGE: i64 = 34;
pub const ENOSYS: i64 = 38;

pub const MAX_FDS: i32 = 4096;

pub const AT_FDCWD: i32 = -100;
pub const AT_SYMLINK_NOFOLLOW: i32 = 0x100;
pub const AT_EMPTY_PATH: i32 = 0x1000;

pub const O_ACCMODE: i32 = 0x3;
pub const O_RDONLY: i32 = 0x0;
pub const O_WRONLY: i32 = 0x1;
pub const O_RDWR: i32 = 0x2;
pub const O_CREAT: i32 = 0x40;
pub const O_TRUNC: i32 = 0x200;
pub const O_APPEND: i32 = 0x400;
pub const O_DIRECTORY: i32 = 0x10000;

pub const S_IFLNK: u32 = 0o120000;
pub const S_IFREG: u32 = 0o100000;
pub const S_IFDIR: u32 = 0o040000;
pub const S_IFCHR: u32 = 0o020000;

pub const DT_UNKNOWN: u8 = 0;
pub const DT_DIR: u8 = 4;
pub const DT_REG: u8 = 8;
pub const DT_LNK: u8 = 10;

pub const SEEK_SET: i32 = 0;
pub const SEEK_CUR: i32 = 1;
pub const SEEK_END: i32 = 2;

#[derive(Debug, Clone)]
pub struct VfsMount {
    pub host_root: PathBuf,
    pub guest_prefix: String,
}

#[derive(Debug, Clone)]
pub struct SoEntry {
    pub guest_paths: Vec<String>,
    pub base_addr: u32,
    pub bytes: Arc<Vec<u8>>,
}

#[derive(Debug, Clone)]
pub struct FileStat {
    pub st_ino: u64,
    pub st_mode: u32,
    pub st_nlink: u64,
    pub st_size: i64,
}

#[derive(Debug, Clone)]
pub struct DirEntry {
    pub d_ino: u64,
    pub d_type: u8,
    pub name: String,
}

#[derive(Debug, Clone)]
pub struct OpenFile {
    pub data: Arc<Vec<u8>>,
    pub cursor: usize,
    pub so_index: Option<usize>,
    pub so_base_addr: Option<u32>,
    pub guest_path: String,
    pub is_dir: bool,
    pub is_std: Option<u8>,
    pub is_pipe: bool,
    pub dir_entries: Vec<DirEntry>,
}

pub struct VirtualFs {
    so_entries: Vec<SoEntry>,
    mounts: Vec<VfsMount>,
    fds: HashMap<i32, OpenFile>,
    next_fd: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub stdin_data: Vec<u8>,
    stdin_cursor: usize,
    pub inherit_stdin: bool,
    pub elf_path: String,
}

const DEFAULT_RO_ALLOWLIST: &[&str] = &[
    "/usr/lib/locale/C.utf8",
    "/usr/share/locale/locale.alias",
    "/usr/lib/x86_64-linux-gnu/gconv",
];

const DENY_PATHS: &[&str] = &[
    "/etc/ld.so.preload",
    "/etc/ld.so.cache",
    "/usr/lib/locale/locale-archive",
];

pub fn normalize_guest_path(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for comp in Path::new(path).components() {
        match comp {
            Component::RootDir => {}
            Component::CurDir => {}
            Component::ParentDir => {
                parts.pop();
            }
            Component::Normal(s) => {
                if let Some(st) = s.to_str() {
                    parts.push(st);
                }
            }
            Component::Prefix(_) => {}
        }
    }
    if parts.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", parts.join("/"))
    }
}

fn path_hash(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h.max(1)
}

impl VirtualFs {
    pub fn new(so_files: &[MetaSoFile], vfs_ro: &[(PathBuf, String)]) -> Self {
        let so_entries = so_files
            .iter()
            .map(|so| SoEntry {
                guest_paths: so
                    .guest_paths
                    .iter()
                    .map(|p| normalize_guest_path(p))
                    .collect(),
                base_addr: so.base_addr,
                bytes: Arc::new(so.bytes.clone()),
            })
            .collect();

        let mut mounts = Vec::new();
        for (host, guest) in vfs_ro {
            if let Ok(canon) = fs::canonicalize(host) {
                mounts.push(VfsMount {
                    host_root: canon,
                    guest_prefix: normalize_guest_path(guest),
                });
            }
        }
        // Sort longest guest_prefix first for most-specific matching
        mounts.sort_by(|a, b| b.guest_prefix.len().cmp(&a.guest_prefix.len()));

        let mut fds = HashMap::new();
        let empty = Arc::new(Vec::new());
        fds.insert(
            0,
            OpenFile {
                data: Arc::clone(&empty),
                cursor: 0,
                so_index: None,
                so_base_addr: None,
                guest_path: "/dev/stdin".to_string(),
                is_dir: false,
                is_std: Some(0),
                is_pipe: false,
                dir_entries: Vec::new(),
            },
        );
        fds.insert(
            1,
            OpenFile {
                data: Arc::clone(&empty),
                cursor: 0,
                so_index: None,
                so_base_addr: None,
                guest_path: "/dev/stdout".to_string(),
                is_dir: false,
                is_std: Some(1),
                is_pipe: false,
                dir_entries: Vec::new(),
            },
        );
        fds.insert(
            2,
            OpenFile {
                data: empty,
                cursor: 0,
                so_index: None,
                so_base_addr: None,
                guest_path: "/dev/stderr".to_string(),
                is_dir: false,
                is_std: Some(2),
                is_pipe: false,
                dir_entries: Vec::new(),
            },
        );

        Self {
            so_entries,
            mounts,
            fds,
            next_fd: 3,
            stdout: Vec::new(),
            stderr: Vec::new(),
            stdin_data: Vec::new(),
            stdin_cursor: 0,
            inherit_stdin: false,
            elf_path: String::new(),
        }
    }

    fn alloc_fd(&mut self) -> Result<i32, i64> {
        while self.next_fd < MAX_FDS {
            let fd = self.next_fd;
            self.next_fd += 1;
            if !self.fds.contains_key(&fd) {
                return Ok(fd);
            }
        }
        for fd in 3..MAX_FDS {
            if !self.fds.contains_key(&fd) {
                return Ok(fd);
            }
        }
        Err(-EMFILE)
    }

    fn resolve_guest_path(&self, dirfd: i32, raw_path: &str) -> Result<String, i64> {
        if raw_path.is_empty() {
            return Err(-ENOENT);
        }
        if raw_path.starts_with('/') {
            Ok(normalize_guest_path(raw_path))
        } else if dirfd == AT_FDCWD {
            Ok(normalize_guest_path(&format!("/{}", raw_path)))
        } else if let Some(dir_file) = self.fds.get(&dirfd) {
            if !dir_file.is_dir {
                return Err(-ENOTDIR);
            }
            let base = &dir_file.guest_path;
            Ok(normalize_guest_path(&format!("{}/{}", base, raw_path)))
        } else {
            Err(-EBADF)
        }
    }

    fn find_so(&self, norm_path: &str) -> Option<(usize, &SoEntry)> {
        for (idx, so) in self.so_entries.iter().enumerate() {
            if so.guest_paths.iter().any(|gp| gp == norm_path) {
                return Some((idx, so));
            }
        }
        None
    }

    fn is_untranslated_so(&self, norm_path: &str) -> bool {
        let Some(fname) = Path::new(norm_path).file_name().and_then(|s| s.to_str()) else {
            return false;
        };
        (fname.ends_with(".so") || fname.contains(".so.")) && self.find_so(norm_path).is_none()
    }

    fn is_virtual_parent_dir(&self, norm_path: &str) -> bool {
        if norm_path == "/" {
            return true;
        }
        let prefix_slash = format!("{}/", norm_path);
        for m in &self.mounts {
            if m.guest_prefix.starts_with(&prefix_slash) {
                return true;
            }
        }
        for so in &self.so_entries {
            if so.guest_paths.iter().any(|gp| gp.starts_with(&prefix_slash)) {
                return true;
            }
        }
        for allow in DEFAULT_RO_ALLOWLIST {
            if allow.starts_with(&prefix_slash) && fs::metadata(allow).is_ok() {
                return true;
            }
        }
        false
    }

    fn build_dir_entries(
        &self,
        norm_path: &str,
        host_dir: Option<&Path>,
        host_root: Option<&Path>,
    ) -> Vec<DirEntry> {
        let parent_path = Path::new(norm_path)
            .parent()
            .and_then(|p| p.to_str())
            .unwrap_or("/");
        let mut entries = vec![
            DirEntry {
                d_ino: path_hash(norm_path),
                d_type: DT_DIR,
                name: ".".to_string(),
            },
            DirEntry {
                d_ino: path_hash(parent_path),
                d_type: DT_DIR,
                name: "..".to_string(),
            },
        ];
        let mut seen = std::collections::HashSet::new();
        seen.insert(".".to_string());
        seen.insert("..".to_string());

        if let Some(hdir) = host_dir {
            if let Ok(rd) = fs::read_dir(hdir) {
                for item in rd.flatten() {
                    let name = item.file_name().to_string_lossy().into_owned();
                    if seen.contains(&name) {
                        continue;
                    }
                    let child_guest = if norm_path == "/" {
                        format!("/{}", name)
                    } else {
                        format!("{}/{}", norm_path, name)
                    };
                    if self.is_untranslated_so(&child_guest) {
                        continue;
                    }
                    let d_type = match item.file_type() {
                        Ok(ft) if ft.is_dir() => DT_DIR,
                        Ok(ft) if ft.is_file() => DT_REG,
                        Ok(ft) if ft.is_symlink() => {
                            if let Some(root) = host_root {
                                match fs::canonicalize(item.path()) {
                                    Ok(canon) if canon.starts_with(root) => {
                                        if canon.is_dir() {
                                            DT_DIR
                                        } else {
                                            DT_REG
                                        }
                                    }
                                    _ => continue,
                                }
                            } else if fs::metadata(item.path()).map(|m| m.is_dir()).unwrap_or(false) {
                                DT_DIR
                            } else {
                                DT_REG
                            }
                        }
                        _ => DT_UNKNOWN,
                    };
                    seen.insert(name.clone());
                    entries.push(DirEntry {
                        d_ino: path_hash(&child_guest),
                        d_type,
                        name,
                    });
                }
            }
        }

        // Also synthesize immediate children from mounts/so_entries/allowlist
        let prefix_slash = if norm_path == "/" {
            "/".to_string()
        } else {
            format!("{}/", norm_path)
        };
        let mut add_child_from_path = |full_path: &str, is_file_leaf: bool| {
            if let Some(rest) = full_path.strip_prefix(&prefix_slash) {
                if let Some((first, has_more)) = rest.split_once('/').map(|(a, _)| (a, true)).or_else(|| {
                    if rest.is_empty() {
                        None
                    } else {
                        Some((rest, false))
                    }
                }) {
                    if !seen.contains(first) {
                        seen.insert(first.to_string());
                        let child_guest = format!("{}{}", prefix_slash, first);
                        entries.push(DirEntry {
                            d_ino: path_hash(&child_guest),
                            d_type: if has_more || !is_file_leaf { DT_DIR } else { DT_REG },
                            name: first.to_string(),
                        });
                    }
                }
            }
        };

        for m in &self.mounts {
            add_child_from_path(&m.guest_prefix, false);
        }
        for so in &self.so_entries {
            for gp in &so.guest_paths {
                add_child_from_path(gp, true);
            }
        }
        for allow in DEFAULT_RO_ALLOWLIST {
            if let Ok(meta) = fs::metadata(allow) {
                add_child_from_path(allow, meta.is_file());
            }
        }

        entries
    }

    fn resolve_host_ro_with_root(&self, norm_path: &str) -> Option<(PathBuf, PathBuf)> {
        // Check explicit --vfs-ro mounts first
        for m in &self.mounts {
            let matched = if m.guest_prefix == "/" {
                Some(norm_path.trim_start_matches('/'))
            } else if norm_path == m.guest_prefix {
                Some("")
            } else if let Some(rest) = norm_path.strip_prefix(&format!("{}/", m.guest_prefix)) {
                Some(rest)
            } else {
                None
            };

            if let Some(rel) = matched {
                let candidate = if rel.is_empty() {
                    m.host_root.clone()
                } else {
                    m.host_root.join(rel)
                };
                if let Ok(canon) = fs::canonicalize(&candidate) {
                    if canon.starts_with(&m.host_root) {
                        return Some((canon, m.host_root.clone()));
                    }
                }
            }
        }

        // Check default read-only locale/gconv allowlist
        for prefix in DEFAULT_RO_ALLOWLIST {
            if norm_path == *prefix || norm_path.starts_with(&format!("{}/", prefix)) {
                let root_canon = match fs::canonicalize(prefix) {
                    Ok(p) => p,
                    Err(_) => continue,
                };
                if let Ok(canon) = fs::canonicalize(norm_path) {
                    if canon.starts_with(&root_canon) {
                        return Some((canon, root_canon));
                    }
                }
            }
        }

        None
    }

    fn resolve_host_ro(&self, norm_path: &str) -> Option<PathBuf> {
        self.resolve_host_ro_with_root(norm_path).map(|(p, _)| p)
    }

    pub fn openat(&mut self, dirfd: i32, raw_path: &str, flags: i32) -> i64 {
        let norm_path = match self.resolve_guest_path(dirfd, raw_path) {
            Ok(p) => p,
            Err(e) => return e,
        };

        // Never allow writes / creation / invalid O_ACCMODE (3) on sandboxed VFS
        let acc = flags & O_ACCMODE;
        if acc == O_WRONLY
            || acc == O_RDWR
            || acc == 3
            || (flags & (O_CREAT | O_TRUNC | O_APPEND)) != 0
        {
            return -EACCES;
        }

        if DENY_PATHS.contains(&norm_path.as_str()) {
            return -ENOENT;
        }

        if let Some((idx, so)) = self.find_so(&norm_path) {
            if (flags & O_DIRECTORY) != 0 {
                return -ENOTDIR;
            }
            let so_bytes = Arc::clone(&so.bytes);
            let so_base = so.base_addr;
            let fd = match self.alloc_fd() {
                Ok(fd) => fd,
                Err(e) => return e,
            };
            self.fds.insert(
                fd,
                OpenFile {
                    data: so_bytes,
                    cursor: 0,
                    so_index: Some(idx),
                    so_base_addr: Some(so_base),
                    guest_path: norm_path,
                    is_dir: false,
                    is_std: None,
                    is_pipe: false,
                    dir_entries: Vec::new(),
                },
            );
            return fd as i64;
        }

        if self.is_untranslated_so(&norm_path) {
            return -ENOENT;
        }

        if let Some((host_path, host_root)) = self.resolve_host_ro_with_root(&norm_path) {
            let meta = match fs::metadata(&host_path) {
                Ok(m) => m,
                Err(_) => return -ENOENT,
            };
            if meta.is_dir() {
                let dir_entries =
                    self.build_dir_entries(&norm_path, Some(&host_path), Some(&host_root));
                let fd = match self.alloc_fd() {
                    Ok(fd) => fd,
                    Err(e) => return e,
                };
                self.fds.insert(
                    fd,
                    OpenFile {
                        data: Arc::new(Vec::new()),
                        cursor: 0,
                        so_index: None,
                        so_base_addr: None,
                        guest_path: norm_path,
                        is_dir: true,
                        is_std: None,
                        is_pipe: false,
                        dir_entries,
                    },
                );
                return fd as i64;
            }
            if (flags & O_DIRECTORY) != 0 {
                return -ENOTDIR;
            }
            match fs::read(&host_path) {
                Ok(bytes) => {
                    let fd = match self.alloc_fd() {
                        Ok(fd) => fd,
                        Err(e) => return e,
                    };
                    self.fds.insert(
                        fd,
                        OpenFile {
                            data: Arc::new(bytes),
                            cursor: 0,
                            so_index: None,
                            so_base_addr: None,
                            guest_path: norm_path,
                            is_dir: false,
                            is_std: None,
                            is_pipe: false,
                            dir_entries: Vec::new(),
                        },
                    );
                    return fd as i64;
                }
                Err(_) => return -ENOENT,
            }
        }

        if self.is_virtual_parent_dir(&norm_path) {
            let dir_entries = self.build_dir_entries(&norm_path, None, None);
            let fd = match self.alloc_fd() {
                Ok(fd) => fd,
                Err(e) => return e,
            };
            self.fds.insert(
                fd,
                OpenFile {
                    data: Arc::new(Vec::new()),
                    cursor: 0,
                    so_index: None,
                    so_base_addr: None,
                    guest_path: norm_path,
                    is_dir: true,
                    is_std: None,
                    is_pipe: false,
                    dir_entries,
                },
            );
            return fd as i64;
        }

        -ENOENT
    }

    pub fn close(&mut self, fd: i32) -> i64 {
        if self.fds.remove(&fd).is_some() {
            0
        } else {
            -EBADF
        }
    }

    pub fn get_fd(&self, fd: i32) -> Option<&OpenFile> {
        self.fds.get(&fd)
    }

    /// Reads up to `count` bytes without advancing `stdin_cursor` or `file.cursor`
    /// (except when reading directly from inherited host stdin).
    /// Returns `(bytes, already_consumed_from_host)`.
    pub fn read_no_advance(&mut self, fd: i32, count: usize) -> Result<(Vec<u8>, bool), i64> {
        let file = self.fds.get(&fd).ok_or(-EBADF)?;
        if let Some(std_fd) = file.is_std {
            if std_fd == 0 {
                if count == 0 {
                    return Ok((Vec::new(), false));
                }
                if self.inherit_stdin && self.stdin_data.is_empty() {
                    use std::io::Read;
                    let cap = count.min(64 * 1024);
                    let mut buf = vec![0u8; cap];
                    let mut stdin = std::io::stdin().lock();
                    loop {
                        match stdin.read(&mut buf) {
                            Ok(n) => {
                                buf.truncate(n);
                                return Ok((buf, true));
                            }
                            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                            Err(_) => return Err(-EIO),
                        }
                    }
                }
                let avail = self.stdin_data.len().saturating_sub(self.stdin_cursor);
                let n = avail.min(count);
                let out = self.stdin_data[self.stdin_cursor..self.stdin_cursor + n].to_vec();
                return Ok((out, false));
            }
            return Err(-EBADF);
        }
        if file.is_dir {
            return Err(-EISDIR);
        }
        let avail = file.data.len().saturating_sub(file.cursor);
        let n = avail.min(count);
        let out = file.data[file.cursor..file.cursor + n].to_vec();
        Ok((out, false))
    }

    pub fn advance_read_cursor(&mut self, fd: i32, n: usize) {
        if let Some(file) = self.fds.get_mut(&fd) {
            if file.is_std == Some(0) {
                self.stdin_cursor = self.stdin_cursor.saturating_add(n);
            } else if file.is_std.is_none() {
                file.cursor = file.cursor.saturating_add(n);
            }
        }
    }

    pub fn read(&mut self, fd: i32, count: usize) -> Result<Vec<u8>, i64> {
        let (out, host_consumed) = self.read_no_advance(fd, count)?;
        if !host_consumed {
            self.advance_read_cursor(fd, out.len());
        }
        Ok(out)
    }

    pub fn pread64(&self, fd: i32, count: usize, offset: usize) -> Result<Vec<u8>, i64> {
        let file = self.fds.get(&fd).ok_or(-EBADF)?;
        if file.is_std.is_some() {
            return Err(-EBADF);
        }
        if file.is_dir {
            return Err(-EISDIR);
        }
        if offset >= file.data.len() {
            return Ok(Vec::new());
        }
        let avail = file.data.len() - offset;
        let n = avail.min(count);
        Ok(file.data[offset..offset + n].to_vec())
    }

    pub fn write(&mut self, fd: i32, data: &[u8]) -> i64 {
        let Some(file) = self.fds.get(&fd) else {
            return -EBADF;
        };
        match file.is_std {
            Some(1) => {
                self.stdout.extend_from_slice(data);
                data.len() as i64
            }
            Some(2) => {
                self.stderr.extend_from_slice(data);
                data.len() as i64
            }
            _ => -EBADF,
        }
    }

    pub fn lseek(&mut self, fd: i32, offset: i64, whence: i32) -> i64 {
        let Some(file) = self.fds.get_mut(&fd) else {
            return -EBADF;
        };
        if file.is_std.is_some() || file.is_pipe {
            return -ESPIPE;
        }
        let len = if file.is_dir {
            file.dir_entries.len() as i64
        } else {
            file.data.len() as i64
        };
        let new_pos = match whence {
            SEEK_SET => offset,
            SEEK_CUR => {
                let Ok(cur) = i64::try_from(file.cursor) else {
                    return -EINVAL;
                };
                match cur.checked_add(offset) {
                    Some(p) => p,
                    None => return -EINVAL,
                }
            }
            SEEK_END => match len.checked_add(offset) {
                Some(p) => p,
                None => return -EINVAL,
            },
            _ => return -EINVAL,
        };
        if new_pos < 0 {
            return -EINVAL;
        }
        file.cursor = new_pos as usize;
        new_pos
    }

    pub fn getdents64(&mut self, fd: i32, max_bytes: usize) -> Result<Vec<u8>, i64> {
        let file = self.fds.get_mut(&fd).ok_or(-EBADF)?;
        if !file.is_dir {
            return Err(-ENOTDIR);
        }
        let mut out = Vec::new();
        while file.cursor < file.dir_entries.len() {
            let entry = &file.dir_entries[file.cursor];
            let name_bytes = entry.name.as_bytes();
            let reclen = (19 + name_bytes.len() + 1 + 7) & !7;
            if out.len() + reclen > max_bytes {
                if out.is_empty() {
                    return Err(-EINVAL);
                }
                break;
            }
            let d_off = (file.cursor + 1) as i64;
            let start = out.len();
            out.resize(start + reclen, 0);
            out[start..start + 8].copy_from_slice(&entry.d_ino.to_le_bytes());
            out[start + 8..start + 16].copy_from_slice(&d_off.to_le_bytes());
            out[start + 16..start + 18].copy_from_slice(&(reclen as u16).to_le_bytes());
            out[start + 18] = entry.d_type;
            out[start + 19..start + 19 + name_bytes.len()].copy_from_slice(name_bytes);
            // NUL terminator and padding are already 0 from resize
            file.cursor += 1;
        }
        Ok(out)
    }

    pub fn stat_fd(&self, fd: i32) -> Result<FileStat, i64> {
        let file = self.fds.get(&fd).ok_or(-EBADF)?;
        if file.is_std.is_some() {
            return Ok(FileStat {
                st_ino: (fd as u64) + 1,
                st_mode: S_IFCHR | 0o620,
                st_nlink: 1,
                st_size: 0,
            });
        }
        if file.is_dir {
            return Ok(FileStat {
                st_ino: path_hash(&file.guest_path),
                st_mode: S_IFDIR | 0o755,
                st_nlink: 2,
                st_size: 4096,
            });
        }
        Ok(FileStat {
            st_ino: path_hash(&file.guest_path),
            st_mode: S_IFREG | if file.so_index.is_some() { 0o755 } else { 0o644 },
            st_nlink: 1,
            st_size: file.data.len() as i64,
        })
    }

    pub fn stat_path(&self, dirfd: i32, raw_path: &str, flags: i32) -> Result<FileStat, i64> {
        if (flags & AT_EMPTY_PATH) != 0 && raw_path.is_empty() {
            return self.stat_fd(dirfd);
        }
        let norm_path = self.resolve_guest_path(dirfd, raw_path)?;
        if DENY_PATHS.contains(&norm_path.as_str()) {
            return Err(-ENOENT);
        }
        if let Some((_idx, so)) = self.find_so(&norm_path) {
            return Ok(FileStat {
                st_ino: path_hash(&norm_path),
                st_mode: S_IFREG | 0o755,
                st_nlink: 1,
                st_size: so.bytes.len() as i64,
            });
        }
        if self.is_untranslated_so(&norm_path) {
            return Err(-ENOENT);
        }
        if let Some(host_path) = self.resolve_host_ro(&norm_path) {
            let meta = fs::metadata(&host_path).map_err(|_| -ENOENT)?;
            if meta.is_dir() {
                return Ok(FileStat {
                    st_ino: path_hash(&norm_path),
                    st_mode: S_IFDIR | 0o755,
                    st_nlink: 2,
                    st_size: 4096,
                });
            }
            return Ok(FileStat {
                st_ino: path_hash(&norm_path),
                st_mode: S_IFREG | 0o644,
                st_nlink: 1,
                st_size: meta.len() as i64,
            });
        }
        if self.is_virtual_parent_dir(&norm_path) {
            return Ok(FileStat {
                st_ino: path_hash(&norm_path),
                st_mode: S_IFDIR | 0o755,
                st_nlink: 2,
                st_size: 4096,
            });
        }
        if norm_path == "/proc/self/exe"
            || (norm_path.starts_with("/proc/") && norm_path.ends_with("/exe"))
        {
            let target = if !self.elf_path.is_empty() {
                self.elf_path.as_str()
            } else {
                "/usr/bin/python3.11"
            };
            if (flags & AT_SYMLINK_NOFOLLOW) != 0 {
                return Ok(FileStat {
                    st_ino: path_hash(&norm_path),
                    st_mode: S_IFLNK | 0o777,
                    st_nlink: 1,
                    st_size: target.len() as i64,
                });
            }
            return Ok(FileStat {
                st_ino: path_hash(&normalize_guest_path(target)),
                st_mode: S_IFREG | 0o755,
                st_nlink: 1,
                st_size: fs::metadata(target).map(|m| m.len() as i64).unwrap_or(0),
            });
        }
        if !self.elf_path.is_empty() && norm_path == normalize_guest_path(&self.elf_path) {
            return Ok(FileStat {
                st_ino: path_hash(&norm_path),
                st_mode: S_IFREG | 0o755,
                st_nlink: 1,
                st_size: fs::metadata(&self.elf_path).map(|m| m.len() as i64).unwrap_or(0),
            });
        }
        Err(-ENOENT)
    }

    pub fn readlink(&self, dirfd: i32, raw_path: &str) -> Result<Vec<u8>, i64> {
        let norm_path = self.resolve_guest_path(dirfd, raw_path)?;
        if norm_path == "/proc/self/exe"
            || (norm_path.starts_with("/proc/") && norm_path.ends_with("/exe"))
        {
            let target = if !self.elf_path.is_empty() {
                self.elf_path.as_bytes()
            } else {
                b"/usr/bin/python3.11"
            };
            return Ok(target.to_vec());
        }
        if self.stat_path(dirfd, raw_path, AT_SYMLINK_NOFOLLOW).is_ok() {
            return Err(-EINVAL);
        }
        Err(-ENOENT)
    }

    pub fn dup(&mut self, oldfd: i32) -> i64 {
        let Some(file) = self.fds.get(&oldfd).cloned() else {
            return -EBADF;
        };
        let newfd = match self.alloc_fd() {
            Ok(fd) => fd,
            Err(e) => return e,
        };
        self.fds.insert(newfd, file);
        newfd as i64
    }

    pub fn dup2(&mut self, oldfd: i32, newfd: i32) -> i64 {
        if newfd < 0 || newfd >= MAX_FDS {
            return -EBADF;
        }
        let Some(file) = self.fds.get(&oldfd).cloned() else {
            return -EBADF;
        };
        if oldfd == newfd {
            return newfd as i64;
        }
        self.fds.insert(newfd, file);
        if newfd >= self.next_fd {
            self.next_fd = newfd + 1;
        }
        newfd as i64
    }

    pub fn dup_from(&mut self, oldfd: i32, min_fd: i32) -> i64 {
        if min_fd < 0 || min_fd >= MAX_FDS {
            return -EINVAL;
        }
        let Some(file) = self.fds.get(&oldfd).cloned() else {
            return -EBADF;
        };
        let mut fd = min_fd;
        while self.fds.contains_key(&fd) {
            fd += 1;
            if fd >= MAX_FDS {
                return -EMFILE;
            }
        }
        self.fds.insert(fd, file);
        if fd >= self.next_fd {
            self.next_fd = fd + 1;
        }
        fd as i64
    }

    pub fn create_pipe(&mut self) -> Result<(i32, i32), i64> {
        let rfd = self.alloc_fd()?;
        let empty = Arc::new(Vec::new());
        self.fds.insert(
            rfd,
            OpenFile {
                data: Arc::clone(&empty),
                cursor: 0,
                so_index: None,
                so_base_addr: None,
                guest_path: "pipe:[0]".to_string(),
                is_dir: false,
                is_std: None,
                is_pipe: true,
                dir_entries: Vec::new(),
            },
        );
        let wfd = match self.alloc_fd() {
            Ok(fd) => fd,
            Err(e) => {
                self.fds.remove(&rfd);
                return Err(e);
            }
        };
        self.fds.insert(
            wfd,
            OpenFile {
                data: empty,
                cursor: 0,
                so_index: None,
                so_base_addr: None,
                guest_path: "pipe:[1]".to_string(),
                is_dir: false,
                is_std: None,
                is_pipe: true,
                dir_entries: Vec::new(),
            },
        );
        Ok((rfd, wfd))
    }

    pub fn access(&self, dirfd: i32, raw_path: &str, mode: i32) -> i64 {
        // W_OK (2) is denied on read-only VFS
        if (mode & 2) != 0 {
            return -EACCES;
        }
        match self.stat_path(dirfd, raw_path, 0) {
            Ok(_) => 0,
            Err(e) => e,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

        // Write flags always denied
        assert_eq!(
            vfs.openat(AT_FDCWD, "/lib/x86_64-linux-gnu/libtest.so.1", O_WRONLY),
            -EACCES
        );
        assert_eq!(
            vfs.openat(AT_FDCWD, "/lib/x86_64-linux-gnu/libtest.so.1", O_CREAT),
            -EACCES
        );

        // Embedded .so open, pread64, stat, close
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

        // Traversal outside mount must fail with -ENOENT
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

        // Read partial from fd 0
        assert_eq!(vfs.read(0, 5).unwrap(), b"hello");

        // dup(0) should share the stdin stream position
        let dup_fd = vfs.dup(0) as i32;
        assert!(dup_fd >= 3);
        assert_eq!(vfs.read(dup_fd, 1).unwrap(), b"_");

        // Remaining bytes from fd 0, then EOF
        assert_eq!(vfs.read(0, 64).unwrap(), b"world");
        assert_eq!(vfs.read(dup_fd, 64).unwrap(), b"");
        assert_eq!(vfs.read(0, 64).unwrap(), b"");

        // Reading from stdout/stderr fails with -EBADF
        assert_eq!(vfs.read(1, 10), Err(-EBADF));
        assert_eq!(vfs.read(2, 10), Err(-EBADF));
    }

    #[test]
    fn test_proc_self_exe_lstat_vs_stat() {
        let mut vfs = VirtualFs::new(&[], &[]);
        vfs.elf_path = "/usr/bin/python3.11".to_string();

        // lstat (AT_SYMLINK_NOFOLLOW) should report a symlink
        let lstat = vfs
            .stat_path(AT_FDCWD, "/proc/self/exe", AT_SYMLINK_NOFOLLOW)
            .unwrap();
        assert_eq!(lstat.st_mode, S_IFLNK | 0o777);
        assert_eq!(lstat.st_nlink, 1);
        assert_eq!(lstat.st_size, "/usr/bin/python3.11".len() as i64);

        // stat (flags = 0) should follow the symlink and report a regular executable file
        let stat = vfs.stat_path(AT_FDCWD, "/proc/self/exe", 0).unwrap();
        assert_eq!(stat.st_mode, S_IFREG | 0o755);
        assert_eq!(stat.st_nlink, 1);
        let expected_size = fs::metadata("/usr/bin/python3.11")
            .map(|m| m.len() as i64)
            .unwrap_or(0);
        assert_eq!(stat.st_size, expected_size);

        // Also check /proc/<pid>/exe with empty elf_path fallback
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
