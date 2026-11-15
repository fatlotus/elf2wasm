use crate::context::{HostFsProvider, NoopHostFs};
use elf2wasm_core::meta::MetaSoFile;
use std::collections::{BTreeMap, HashSet, VecDeque};
use std::sync::Arc;

#[cfg(feature = "std-fs")]
use crate::context::StdHostFs;
#[cfg(feature = "std-fs")]
use std::path::PathBuf;

pub const ENOENT: i64 = 2;
pub const ESRCH: i64 = 3;
pub const EIO: i64 = 5;
pub const EBADF: i64 = 9;
pub const ECHILD: i64 = 10;
pub const EAGAIN: i64 = 11;
pub const ENOMEM: i64 = 12;
pub const EACCES: i64 = 13;
pub const EFAULT: i64 = 14;
pub const EBUSY: i64 = 16;
pub const EEXIST: i64 = 17;
pub const EXDEV: i64 = 18;
pub const ENOTDIR: i64 = 20;
pub const EISDIR: i64 = 21;
pub const EINVAL: i64 = 22;
pub const EMFILE: i64 = 24;
pub const ENOTTY: i64 = 25;
pub const ESPIPE: i64 = 29;
pub const EROFS: i64 = 30;
pub const EPIPE: i64 = 32;
pub const ERANGE: i64 = 34;
pub const ENOSYS: i64 = 38;
pub const ENOTEMPTY: i64 = 39;
pub const ETIMEDOUT: i64 = 110;

pub const MAX_FDS: i32 = 4096;
pub const PIPE_CAPACITY: usize = 65536;

pub const AT_FDCWD: i32 = -100;
pub const AT_SYMLINK_NOFOLLOW: i32 = 0x100;
pub const AT_REMOVEDIR: i32 = 0x200;
pub const AT_EMPTY_PATH: i32 = 0x1000;

pub const O_ACCMODE: i32 = 0x3;
pub const O_RDONLY: i32 = 0x0;
pub const O_WRONLY: i32 = 0x1;
pub const O_RDWR: i32 = 0x2;
pub const O_CREAT: i32 = 0x40;
pub const O_EXCL: i32 = 0x80;
pub const O_TRUNC: i32 = 0x200;
pub const O_APPEND: i32 = 0x400;
pub const O_NONBLOCK: i32 = 0x800;
pub const O_DIRECTORY: i32 = 0x10000;
pub const O_CLOEXEC: i32 = 0x80000;

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

const DENY_PATHS: &[&str] = &[
    "/etc/ld.so.preload",
    "/etc/ld.so.cache",
    "/usr/lib/locale/locale-archive",
];

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
    pub mtime_ns: u64,
}

#[derive(Debug, Clone)]
pub struct DirEntry {
    pub d_ino: u64,
    pub d_type: u8,
    pub name: String,
}

#[derive(Debug, Clone)]
pub enum OverlayNode {
    File {
        data: Arc<Vec<u8>>,
        mode: u32,
        mtime_ns: u64,
    },
    Dir {
        mode: u32,
        mtime_ns: u64,
    },
}

#[derive(Debug, Clone)]
pub struct PipeBuffer {
    pub buf: VecDeque<u8>,
    pub readers: usize,
    pub writers: usize,
    pub capacity: usize,
}

impl PipeBuffer {
    pub fn new() -> Self {
        Self {
            buf: VecDeque::new(),
            readers: 1,
            writers: 1,
            capacity: PIPE_CAPACITY,
        }
    }
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
    pub pipe_id: Option<u64>,
    pub writable: bool,
    pub append: bool,
    pub cloexec: bool,
    pub nonblock: bool,
    pub dir_entries: Vec<DirEntry>,
    pub unlinked: bool,
}

pub fn normalize_guest_path(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for comp in path.split('/') {
        match comp {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    if parts.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", parts.join("/"))
    }
}

pub fn parent_guest_path(norm_path: &str) -> &str {
    if norm_path == "/" {
        return "/";
    }
    match norm_path.rfind('/') {
        Some(0) | None => "/",
        Some(idx) => &norm_path[..idx],
    }
}

pub fn path_hash(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h.max(1)
}

pub struct VirtualFs {
    pub so_entries: Vec<SoEntry>,
    host_fs: Box<dyn HostFsProvider>,
    overlay: BTreeMap<String, OverlayNode>,
    pub fds: BTreeMap<i32, OpenFile>,
    pub next_fd: i32,
    pub pipes: BTreeMap<u64, PipeBuffer>,
    pub next_pipe_id: u64,
    pub cwd: String,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub stdin_data: Vec<u8>,
    stdin_cursor: usize,
    pub inherit_stdin: bool,
    pub elf_path: String,
}

impl VirtualFs {
    #[cfg(feature = "std-fs")]
    pub fn new(so_files: &[MetaSoFile], vfs_ro: &[(PathBuf, String)]) -> Self {
        Self::with_provider(so_files, Box::new(StdHostFs::new(vfs_ro)))
    }

    pub fn new_in_memory(so_files: &[MetaSoFile]) -> Self {
        Self::with_provider(so_files, Box::new(NoopHostFs))
    }

    pub fn with_provider(so_files: &[MetaSoFile], host_fs: Box<dyn HostFsProvider>) -> Self {
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

        let mut overlay = BTreeMap::new();
        if !host_fs.is_under_ro_mount("/") {
            overlay.insert(
                "/".to_string(),
                OverlayNode::Dir {
                    mode: 0o755,
                    mtime_ns: 0,
                },
            );
        }
        if !host_fs.is_under_ro_mount("/tmp") {
            overlay.insert(
                "/tmp".to_string(),
                OverlayNode::Dir {
                    mode: 0o1777,
                    mtime_ns: 0,
                },
            );
        }

        let mut fds = BTreeMap::new();
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
                pipe_id: None,
                writable: false,
                append: false,
                cloexec: false,
                nonblock: false,
                dir_entries: Vec::new(),
                    unlinked: false,
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
                pipe_id: None,
                writable: true,
                append: false,
                cloexec: false,
                nonblock: false,
                dir_entries: Vec::new(),
                    unlinked: false,
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
                pipe_id: None,
                writable: true,
                append: false,
                cloexec: false,
                nonblock: false,
                dir_entries: Vec::new(),
                    unlinked: false,
            },
        );

        Self {
            so_entries,
            host_fs,
            overlay,
            fds,
            next_fd: 3,
            pipes: BTreeMap::new(),
            next_pipe_id: 1,
            cwd: "/".to_string(),
            stdout: Vec::new(),
            stderr: Vec::new(),
            stdin_data: Vec::new(),
            stdin_cursor: 0,
            inherit_stdin: false,
            elf_path: String::new(),
        }
    }

    pub fn stdin_cursor_val(&self) -> usize {
        self.stdin_cursor
    }

    pub fn reset_fds_and_stdio(&mut self) {
        self.pipes.clear();
        self.next_pipe_id = 1;
        self.fds.clear();
        let empty = Arc::new(Vec::new());
        for (fd, path, writable) in [
            (0, "/dev/stdin", false),
            (1, "/dev/stdout", true),
            (2, "/dev/stderr", true),
        ] {
            self.fds.insert(
                fd,
                OpenFile {
                    data: Arc::clone(&empty),
                    cursor: 0,
                    so_index: None,
                    so_base_addr: None,
                    guest_path: path.to_string(),
                    is_dir: false,
                    is_std: Some(fd as u8),
                    is_pipe: false,
                    pipe_id: None,
                    writable,
                    append: false,
                    cloexec: false,
                    nonblock: false,
                    dir_entries: Vec::new(),
                    unlinked: false,
                },
            );
        }
        self.next_fd = 3;
        self.cwd = "/".to_string();
        self.stdout.clear();
        self.stderr.clear();
        self.stdin_cursor = 0;
    }

    pub fn set_so_files(&mut self, so_files: &[MetaSoFile]) {
        self.so_entries = so_files
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
    }

    pub fn vfs_write_file(&mut self, path: &str, bytes: &[u8], mode: u32) {
        let norm = normalize_guest_path(path);
        if norm == "/" {
            return;
        }
        // Ensure parent directories exist in overlay
        let mut cur = String::new();
        let parts: Vec<&str> = norm.trim_start_matches('/').split('/').collect();
        for part in &parts[..parts.len().saturating_sub(1)] {
            if part.is_empty() {
                continue;
            }
            cur.push('/');
            cur.push_str(part);
            self.overlay.entry(cur.clone()).or_insert(OverlayNode::Dir {
                mode: 0o755,
                mtime_ns: 0,
            });
        }
        self.overlay.insert(
            norm,
            OverlayNode::File {
                data: Arc::new(bytes.to_vec()),
                mode: mode & 0o7777,
                mtime_ns: 0,
            },
        );
    }

    pub fn vfs_read_file(&self, path: &str) -> Option<Vec<u8>> {
        let norm = normalize_guest_path(path);
        if let Some(OverlayNode::File { data, .. }) = self.overlay.get(&norm) {
            return Some(data.as_ref().clone());
        }
        if let Some((_, so)) = self.find_so(&norm) {
            return Some(so.bytes.as_ref().clone());
        }
        self.host_fs.read_host_ro(&norm)
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
            if self.cwd == "/" {
                Ok(normalize_guest_path(&format!("/{}", raw_path)))
            } else {
                Ok(normalize_guest_path(&format!("{}/{}", self.cwd, raw_path)))
            }
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
        let fname = norm_path.rsplit('/').next().unwrap_or("");
        (fname.ends_with(".so") || fname.contains(".so.")) && self.find_so(norm_path).is_none()
    }

    pub fn is_read_only_path(&self, norm_path: &str) -> bool {
        if self.find_so(norm_path).is_some() || self.is_untranslated_so(norm_path) {
            return true;
        }
        if self.host_fs.is_under_ro_mount(norm_path) {
            return true;
        }
        if norm_path == "/proc" || norm_path.starts_with("/proc/") {
            return true;
        }
        false
    }

    fn is_virtual_parent_dir(&self, norm_path: &str) -> bool {
        if norm_path == "/" {
            return true;
        }
        let prefix_slash = format!("{}/", norm_path);
        for so in &self.so_entries {
            if so.guest_paths.iter().any(|gp| gp.starts_with(&prefix_slash)) {
                return true;
            }
        }
        for key in self.overlay.keys() {
            if key.starts_with(&prefix_slash) {
                return true;
            }
        }
        self.host_fs.is_virtual_allowlist_parent(norm_path)
    }

    fn is_existing_dir(&self, norm_path: &str) -> bool {
        match self.overlay.get(norm_path) {
            Some(OverlayNode::Dir { .. }) => return true,
            Some(OverlayNode::File { .. }) => return false,
            None => {}
        }
        if let Some(st) = self.host_fs.stat_host_ro(norm_path) {
            return (st.st_mode & S_IFDIR) != 0;
        }
        self.is_virtual_parent_dir(norm_path)
    }

    fn missing_parent_errno(&self, parent: &str) -> i64 {
        if self.overlay.contains_key(parent)
            || self.host_fs.stat_host_ro(parent).is_some()
            || self.find_so(parent).is_some()
        {
            -ENOTDIR
        } else {
            -ENOENT
        }
    }

    fn build_dir_entries(&self, norm_path: &str) -> Vec<DirEntry> {
        let parent_path = parent_guest_path(norm_path);
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
        let mut seen = HashSet::new();
        seen.insert(".".to_string());
        seen.insert("..".to_string());

        let prefix_slash = if norm_path == "/" {
            "/".to_string()
        } else {
            format!("{}/", norm_path)
        };

        // 1. Overlay direct children
        for (path, node) in &self.overlay {
            if let Some(rest) = path.strip_prefix(&prefix_slash) {
                if !rest.is_empty() && !rest.contains('/') && !seen.contains(rest) {
                    seen.insert(rest.to_string());
                    let d_type = match node {
                        OverlayNode::Dir { .. } => DT_DIR,
                        OverlayNode::File { .. } => DT_REG,
                    };
                    entries.push(DirEntry {
                        d_ino: path_hash(path),
                        d_type,
                        name: rest.to_string(),
                    });
                }
            }
        }

        // 2. Host RO directory listing
        if let Some(host_entries) = self.host_fs.list_host_ro_dir(norm_path) {
            for item in host_entries {
                if seen.contains(&item.name) {
                    continue;
                }
                let child_guest = format!("{}{}", prefix_slash, item.name);
                if self.is_untranslated_so(&child_guest) {
                    continue;
                }
                seen.insert(item.name.clone());
                entries.push(item);
            }
        }

        // 3. Synthesize immediate children from mounts / so_entries / allowlist
        let mut add_child_from_path = |full_path: &str, is_file_leaf: bool| {
            if let Some(rest) = full_path.strip_prefix(&prefix_slash) {
                let first_opt = rest
                    .split_once('/')
                    .map(|(a, _)| (a, true))
                    .or_else(|| if rest.is_empty() { None } else { Some((rest, false)) });
                if let Some((first, has_more)) = first_opt {
                    if !seen.contains(first) {
                        seen.insert(first.to_string());
                        let child_guest = format!("{}{}", prefix_slash, first);
                        entries.push(DirEntry {
                            d_ino: path_hash(&child_guest),
                            d_type: if has_more || !is_file_leaf {
                                DT_DIR
                            } else {
                                DT_REG
                            },
                            name: first.to_string(),
                        });
                    }
                }
            }
        };

        for p in self.host_fs.mount_guest_prefixes() {
            add_child_from_path(&p, false);
        }
        for so in &self.so_entries {
            for gp in &so.guest_paths {
                add_child_from_path(gp, true);
            }
        }
        for (allow, is_file) in self.host_fs.allowlist_entries() {
            add_child_from_path(&allow, is_file);
        }

        entries
    }

    pub fn openat(&mut self, dirfd: i32, raw_path: &str, flags: i32) -> i64 {
        self.openat_with_mode(dirfd, raw_path, flags, 0o644, 0)
    }

    pub fn openat_with_mode(
        &mut self,
        dirfd: i32,
        raw_path: &str,
        flags: i32,
        mode: u32,
        now_ns: u64,
    ) -> i64 {
        let norm_path = match self.resolve_guest_path(dirfd, raw_path) {
            Ok(p) => p,
            Err(e) => return e,
        };

        let acc = flags & O_ACCMODE;
        if acc == 3 {
            return -EACCES;
        }

        if DENY_PATHS.contains(&norm_path.as_str()) {
            return -ENOENT;
        }

        let wants_write =
            acc == O_WRONLY || acc == O_RDWR || (flags & (O_CREAT | O_TRUNC | O_APPEND)) != 0;
        if wants_write && self.is_read_only_path(&norm_path) {
            return -EACCES;
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
            let cloexec = (flags & O_CLOEXEC) != 0;
            let nonblock = (flags & O_NONBLOCK) != 0;
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
                    pipe_id: None,
                    writable: false,
                    append: false,
                    cloexec,
                    nonblock,
                    dir_entries: Vec::new(),
                    unlinked: false,
                },
            );
            return fd as i64;
        }

        // Check overlay first
        if let Some(node) = self.overlay.get(&norm_path).cloned() {
            match node {
                OverlayNode::Dir { .. } => {
                    if (flags & O_CREAT) != 0 && (flags & O_EXCL) != 0 {
                        return -EEXIST;
                    }
                    if acc == O_WRONLY || acc == O_RDWR {
                        return -EISDIR;
                    }
                    let dir_entries = self.build_dir_entries(&norm_path);
                    let fd = match self.alloc_fd() {
                        Ok(fd) => fd,
                        Err(e) => return e,
                    };
                    let cloexec = (flags & O_CLOEXEC) != 0;
                    let nonblock = (flags & O_NONBLOCK) != 0;
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
                            pipe_id: None,
                            writable: false,
                            append: false,
                            cloexec,
                            nonblock,
                            dir_entries,
                        unlinked: false,
                        },
                    );
                    return fd as i64;
                }
                OverlayNode::File { data, .. } => {
                    if (flags & O_DIRECTORY) != 0 {
                        return -ENOTDIR;
                    }
                    if (flags & O_CREAT) != 0 && (flags & O_EXCL) != 0 {
                        return -EEXIST;
                    }
                    let writable = acc == O_WRONLY || acc == O_RDWR;
                    let append = (flags & O_APPEND) != 0;
                    let file_data = if (flags & O_TRUNC) != 0 && writable {
                        let empty = Arc::new(Vec::new());
                        if let Some(OverlayNode::File {
                            data: node_data,
                            mtime_ns,
                            ..
                        }) = self.overlay.get_mut(&norm_path)
                        {
                            *node_data = Arc::clone(&empty);
                            *mtime_ns = now_ns;
                        }
                        empty
                    } else {
                        data
                    };
                    let fd = match self.alloc_fd() {
                        Ok(fd) => fd,
                        Err(e) => return e,
                    };
                    let cloexec = (flags & O_CLOEXEC) != 0;
                    let nonblock = (flags & O_NONBLOCK) != 0;
                    self.fds.insert(
                        fd,
                        OpenFile {
                            data: file_data,
                            cursor: 0,
                            so_index: None,
                            so_base_addr: None,
                            guest_path: norm_path,
                            is_dir: false,
                            is_std: None,
                            is_pipe: false,
                            pipe_id: None,
                            writable,
                            append,
                            cloexec,
                            nonblock,
                            dir_entries: Vec::new(),
                    unlinked: false,
                        },
                    );
                    return fd as i64;
                }
            }
        }

        // Check host RO mounts / allowlist
        if let Some(st) = self.host_fs.stat_host_ro(&norm_path) {
            if (st.st_mode & S_IFDIR) != 0 {
                if (flags & O_CREAT) != 0 && (flags & O_EXCL) != 0 {
                    return -EEXIST;
                }
                if acc == O_WRONLY || acc == O_RDWR {
                    return -EISDIR;
                }
                let dir_entries = self.build_dir_entries(&norm_path);
                let fd = match self.alloc_fd() {
                    Ok(fd) => fd,
                    Err(e) => return e,
                };
                let cloexec = (flags & O_CLOEXEC) != 0;
                let nonblock = (flags & O_NONBLOCK) != 0;
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
                        pipe_id: None,
                        writable: false,
                        append: false,
                        cloexec,
                        nonblock,
                        dir_entries,
                        unlinked: false,
                    },
                );
                return fd as i64;
            }
            if (flags & O_DIRECTORY) != 0 {
                return -ENOTDIR;
            }
            if (flags & O_CREAT) != 0 && (flags & O_EXCL) != 0 {
                return -EEXIST;
            }
            if wants_write {
                return -EACCES;
            }
            match self.host_fs.read_host_ro(&norm_path) {
                Some(bytes) => {
                    let fd = match self.alloc_fd() {
                        Ok(fd) => fd,
                        Err(e) => return e,
                    };
                    let cloexec = (flags & O_CLOEXEC) != 0;
                    let nonblock = (flags & O_NONBLOCK) != 0;
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
                            pipe_id: None,
                            writable: false,
                            append: false,
                            cloexec,
                            nonblock,
                            dir_entries: Vec::new(),
                    unlinked: false,
                        },
                    );
                    return fd as i64;
                }
                None => return -ENOENT,
            }
        }

        // Check virtual parent directories
        if self.is_virtual_parent_dir(&norm_path) {
            if (flags & O_CREAT) != 0 && (flags & O_EXCL) != 0 {
                return -EEXIST;
            }
            if acc == O_WRONLY || acc == O_RDWR {
                return -EISDIR;
            }
            let dir_entries = self.build_dir_entries(&norm_path);
            let fd = match self.alloc_fd() {
                Ok(fd) => fd,
                Err(e) => return e,
            };
            let cloexec = (flags & O_CLOEXEC) != 0;
            let nonblock = (flags & O_NONBLOCK) != 0;
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
                    pipe_id: None,
                    writable: false,
                    append: false,
                    cloexec,
                    nonblock,
                    dir_entries,
                        unlinked: false,
                },
            );
            return fd as i64;
        }

        // File does not exist yet: create in overlay if O_CREAT
        if (flags & O_CREAT) != 0 {
            if (flags & O_DIRECTORY) != 0 {
                return -EINVAL;
            }
            let parent = parent_guest_path(&norm_path);
            if !self.is_existing_dir(parent) {
                return self.missing_parent_errno(parent);
            }
            let empty = Arc::new(Vec::new());
            self.overlay.insert(
                norm_path.clone(),
                OverlayNode::File {
                    data: Arc::clone(&empty),
                    mode: mode & 0o7777,
                    mtime_ns: now_ns,
                },
            );
            let fd = match self.alloc_fd() {
                Ok(fd) => fd,
                Err(e) => return e,
            };
            let writable = acc == O_WRONLY || acc == O_RDWR;
            let append = (flags & O_APPEND) != 0;
            let cloexec = (flags & O_CLOEXEC) != 0;
            let nonblock = (flags & O_NONBLOCK) != 0;
            self.fds.insert(
                fd,
                OpenFile {
                    data: empty,
                    cursor: 0,
                    so_index: None,
                    so_base_addr: None,
                    guest_path: norm_path,
                    is_dir: false,
                    is_std: None,
                    is_pipe: false,
                    pipe_id: None,
                    writable,
                    append,
                    cloexec,
                    nonblock,
                    dir_entries: Vec::new(),
                    unlinked: false,
                },
            );
            return fd as i64;
        }

        -ENOENT
    }

    pub fn close(&mut self, fd: i32) -> i64 {
        let Some(file) = self.fds.remove(&fd) else {
            return -EBADF;
        };
        self.dec_pipe_ref(&file);
        0
    }

    fn inc_pipe_ref(&mut self, file: &OpenFile) {
        if let Some(pid) = file.pipe_id {
            if let Some(p) = self.pipes.get_mut(&pid) {
                if file.writable {
                    p.writers += 1;
                } else {
                    p.readers += 1;
                }
            }
        }
    }

    fn dec_pipe_ref(&mut self, file: &OpenFile) {
        if let Some(pid) = file.pipe_id {
            let mut remove_pipe = false;
            if let Some(p) = self.pipes.get_mut(&pid) {
                if file.writable {
                    p.writers = p.writers.saturating_sub(1);
                } else {
                    p.readers = p.readers.saturating_sub(1);
                }
                if p.readers == 0 && p.writers == 0 {
                    remove_pipe = true;
                }
            }
            if remove_pipe {
                self.pipes.remove(&pid);
            }
        }
    }

    pub fn clone_fds_for_fork(&mut self) -> BTreeMap<i32, OpenFile> {
        let cloned: BTreeMap<i32, OpenFile> = self.fds.clone();
        for file in cloned.values() {
            self.inc_pipe_ref(file);
        }
        cloned
    }

    pub fn close_cloexec_fds(&mut self) {
        let cloexec_fds: Vec<i32> = self
            .fds
            .iter()
            .filter_map(|(&fd, f)| if f.cloexec { Some(fd) } else { None })
            .collect();
        for fd in cloexec_fds {
            self.close(fd);
        }
    }

    pub fn close_all_fds(&mut self) {
        let all_fds: Vec<i32> = self.fds.keys().copied().collect();
        for fd in all_fds {
            self.close(fd);
        }
    }

    pub fn get_fd(&self, fd: i32) -> Option<&OpenFile> {
        self.fds.get(&fd)
    }

    pub fn get_fd_mut(&mut self, fd: i32) -> Option<&mut OpenFile> {
        self.fds.get_mut(&fd)
    }

    fn current_file_data<'a>(&'a self, file: &'a OpenFile) -> &'a [u8] {
        if !file.unlinked
            && file.so_index.is_none()
            && file.is_std.is_none()
            && !file.is_dir
            && !file.is_pipe
        {
            if let Some(OverlayNode::File { data, .. }) = self.overlay.get(&file.guest_path) {
                return data.as_slice();
            }
        }
        file.data.as_slice()
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
                    let out = self.host_fs.read_inherited_stdin(count)?;
                    return Ok((out, true));
                }
                if self.stdin_cursor >= self.stdin_data.len() {
                    return Ok((Vec::new(), false));
                }
                let avail = self.stdin_data.len() - self.stdin_cursor;
                let n = avail.min(count);
                let out = self.stdin_data[self.stdin_cursor..self.stdin_cursor + n].to_vec();
                return Ok((out, false));
            }
            return Err(-EBADF);
        }
        if file.is_dir {
            return Err(-EISDIR);
        }
        let data = self.current_file_data(file);
        if file.cursor >= data.len() {
            return Ok((Vec::new(), false));
        }
        let avail = data.len() - file.cursor;
        let n = avail.min(count);
        let out = data[file.cursor..file.cursor + n].to_vec();
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
        if file.is_pipe {
            return Err(-ESPIPE);
        }
        if file.is_dir {
            return Err(-EISDIR);
        }
        let data = self.current_file_data(file);
        if offset >= data.len() {
            return Ok(Vec::new());
        }
        let avail = data.len() - offset;
        let n = avail.min(count);
        Ok(data[offset..offset + n].to_vec())
    }

    pub fn write(&mut self, fd: i32, data: &[u8]) -> i64 {
        self.write_at(fd, data, None, 0)
    }

    pub fn write_with_time(&mut self, fd: i32, data: &[u8], now_ns: u64) -> i64 {
        self.write_at(fd, data, None, now_ns)
    }

    pub fn pwrite64(&mut self, fd: i32, data: &[u8], offset: usize, now_ns: u64) -> i64 {
        self.write_at(fd, data, Some(offset), now_ns)
    }

    fn write_at(&mut self, fd: i32, data: &[u8], explicit_offset: Option<usize>, now_ns: u64) -> i64 {
        let Some((is_std, is_dir, is_pipe, writable, append, cursor, guest_path, unlinked)) =
            self.fds.get(&fd).map(|f| {
                (
                    f.is_std,
                    f.is_dir,
                    f.is_pipe,
                    f.writable,
                    f.append,
                    f.cursor,
                    f.guest_path.clone(),
                    f.unlinked,
                )
            })
        else {
            return -EBADF;
        };

        if let Some(std_fd) = is_std {
            if explicit_offset.is_some() {
                return -ESPIPE;
            }
            return match std_fd {
                1 => {
                    self.stdout.extend_from_slice(data);
                    data.len() as i64
                }
                2 => {
                    self.stderr.extend_from_slice(data);
                    data.len() as i64
                }
                _ => -EBADF,
            };
        }
        if is_pipe {
            return if explicit_offset.is_some() {
                -ESPIPE
            } else {
                -EBADF
            };
        }
        if is_dir {
            return -EISDIR;
        }
        if !writable {
            return -EBADF;
        }

        if unlinked {
            let Some(f) = self.fds.get_mut(&fd) else {
                return -EBADF;
            };
            let buf = Arc::make_mut(&mut f.data);
            let pos = match explicit_offset {
                Some(off) => off,
                None => {
                    if append {
                        buf.len()
                    } else {
                        cursor
                    }
                }
            };
            let end = match pos.checked_add(data.len()) {
                Some(e) => e,
                None => return -EINVAL,
            };
            if end > buf.len() {
                buf.resize(end, 0);
            }
            buf[pos..end].copy_from_slice(data);
            if explicit_offset.is_none() {
                f.cursor = end;
            }
            return data.len() as i64;
        }

        let Some(OverlayNode::File {
            data: node_data,
            mtime_ns,
            ..
        }) = self.overlay.get_mut(&guest_path)
        else {
            return -EBADF;
        };

        let buf = Arc::make_mut(node_data);
        let pos = match explicit_offset {
            Some(off) => off,
            None => {
                if append {
                    buf.len()
                } else {
                    cursor
                }
            }
        };
        let end = match pos.checked_add(data.len()) {
            Some(e) => e,
            None => return -EINVAL,
        };
        if end > buf.len() {
            buf.resize(end, 0);
        }
        buf[pos..end].copy_from_slice(data);
        *mtime_ns = now_ns;
        let updated = Arc::clone(node_data);

        if let Some(f) = self.fds.get_mut(&fd) {
            f.data = updated;
            if explicit_offset.is_none() {
                f.cursor = end;
            }
        }
        data.len() as i64
    }

    pub fn lseek(&mut self, fd: i32, offset: i64, whence: i32) -> i64 {
        let len = {
            let Some(file) = self.fds.get(&fd) else {
                return -EBADF;
            };
            if file.is_std.is_some() || file.is_pipe {
                return -ESPIPE;
            }
            if file.is_dir {
                file.dir_entries.len() as i64
            } else {
                self.current_file_data(file).len() as i64
            }
        };
        let Some(file) = self.fds.get_mut(&fd) else {
            return -EBADF;
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
                mtime_ns: 0,
            });
        }
        if file.is_dir {
            let (mode, mtime_ns) = match self.overlay.get(&file.guest_path) {
                Some(OverlayNode::Dir { mode, mtime_ns }) => (*mode, *mtime_ns),
                _ => (0o755, 0),
            };
            return Ok(FileStat {
                st_ino: path_hash(&file.guest_path),
                st_mode: S_IFDIR | mode,
                st_nlink: 2,
                st_size: 4096,
                mtime_ns,
            });
        }
        if !file.unlinked && file.so_index.is_none() {
            if let Some(OverlayNode::File {
                data,
                mode,
                mtime_ns,
            }) = self.overlay.get(&file.guest_path)
            {
                return Ok(FileStat {
                    st_ino: path_hash(&file.guest_path),
                    st_mode: S_IFREG | *mode,
                    st_nlink: 1,
                    st_size: data.len() as i64,
                    mtime_ns: *mtime_ns,
                });
            }
        }
        Ok(FileStat {
            st_ino: path_hash(&file.guest_path),
            st_mode: S_IFREG | if file.so_index.is_some() { 0o755 } else { 0o644 },
            st_nlink: 1,
            st_size: file.data.len() as i64,
            mtime_ns: 0,
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
        if let Some((_, so)) = self.find_so(&norm_path) {
            return Ok(FileStat {
                st_ino: path_hash(&norm_path),
                st_mode: S_IFREG | 0o755,
                st_nlink: 1,
                st_size: so.bytes.len() as i64,
                mtime_ns: 0,
            });
        }
        if let Some(node) = self.overlay.get(&norm_path) {
            return match node {
                OverlayNode::Dir { mode, mtime_ns } => Ok(FileStat {
                    st_ino: path_hash(&norm_path),
                    st_mode: S_IFDIR | *mode,
                    st_nlink: 2,
                    st_size: 4096,
                    mtime_ns: *mtime_ns,
                }),
                OverlayNode::File {
                    data,
                    mode,
                    mtime_ns,
                } => Ok(FileStat {
                    st_ino: path_hash(&norm_path),
                    st_mode: S_IFREG | *mode,
                    st_nlink: 1,
                    st_size: data.len() as i64,
                    mtime_ns: *mtime_ns,
                }),
            };
        }
        if let Some(st) = self.host_fs.stat_host_ro(&norm_path) {
            return Ok(st);
        }
        if self.is_virtual_parent_dir(&norm_path) {
            return Ok(FileStat {
                st_ino: path_hash(&norm_path),
                st_mode: S_IFDIR | 0o755,
                st_nlink: 2,
                st_size: 4096,
                mtime_ns: 0,
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
                    mtime_ns: 0,
                });
            }
            return Ok(FileStat {
                st_ino: path_hash(&normalize_guest_path(target)),
                st_mode: S_IFREG | 0o755,
                st_nlink: 1,
                st_size: self.host_fs.host_file_size(target).unwrap_or(0) as i64,
                mtime_ns: 0,
            });
        }
        if !self.elf_path.is_empty() && norm_path == normalize_guest_path(&self.elf_path) {
            return Ok(FileStat {
                st_ino: path_hash(&norm_path),
                st_mode: S_IFREG | 0o755,
                st_nlink: 1,
                st_size: self.host_fs.host_file_size(&self.elf_path).unwrap_or(0) as i64,
                mtime_ns: 0,
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
        let Some(mut file) = self.fds.get(&oldfd).cloned() else {
            return -EBADF;
        };
        file.cloexec = false;
        let newfd = match self.alloc_fd() {
            Ok(fd) => fd,
            Err(e) => return e,
        };
        self.inc_pipe_ref(&file);
        self.fds.insert(newfd, file);
        newfd as i64
    }

    pub fn dup2(&mut self, oldfd: i32, newfd: i32) -> i64 {
        if newfd < 0 || newfd >= MAX_FDS {
            return -EBADF;
        }
        let Some(mut file) = self.fds.get(&oldfd).cloned() else {
            return -EBADF;
        };
        if oldfd == newfd {
            return newfd as i64;
        }
        if self.fds.contains_key(&newfd) {
            self.close(newfd);
        }
        file.cloexec = false;
        self.inc_pipe_ref(&file);
        self.fds.insert(newfd, file);
        if newfd >= self.next_fd {
            self.next_fd = newfd + 1;
        }
        newfd as i64
    }

    pub fn dup3(&mut self, oldfd: i32, newfd: i32, flags: i32) -> i64 {
        if (flags & !O_CLOEXEC) != 0 {
            return -EINVAL;
        }
        if oldfd == newfd {
            return -EINVAL;
        }
        if newfd < 0 || newfd >= MAX_FDS {
            return -EBADF;
        }
        let Some(mut file) = self.fds.get(&oldfd).cloned() else {
            return -EBADF;
        };
        if self.fds.contains_key(&newfd) {
            self.close(newfd);
        }
        file.cloexec = (flags & O_CLOEXEC) != 0;
        self.inc_pipe_ref(&file);
        self.fds.insert(newfd, file);
        if newfd >= self.next_fd {
            self.next_fd = newfd + 1;
        }
        newfd as i64
    }

    pub fn dup_from(&mut self, oldfd: i32, min_fd: i32, cloexec: bool) -> i64 {
        if min_fd < 0 || min_fd >= MAX_FDS {
            return -EINVAL;
        }
        let Some(mut file) = self.fds.get(&oldfd).cloned() else {
            return -EBADF;
        };
        let mut fd = min_fd;
        while self.fds.contains_key(&fd) {
            fd += 1;
            if fd >= MAX_FDS {
                return -EMFILE;
            }
        }
        file.cloexec = cloexec;
        self.inc_pipe_ref(&file);
        self.fds.insert(fd, file);
        if fd >= self.next_fd {
            self.next_fd = fd + 1;
        }
        fd as i64
    }

    pub fn create_pipe(&mut self) -> Result<(i32, i32), i64> {
        self.create_pipe_with_flags(0)
    }

    pub fn create_pipe_with_flags(&mut self, flags: i32) -> Result<(i32, i32), i64> {
        if (flags & !(O_CLOEXEC | O_NONBLOCK)) != 0 {
            return Err(-EINVAL);
        }
        let cloexec = (flags & O_CLOEXEC) != 0;
        let nonblock = (flags & O_NONBLOCK) != 0;

        let pipe_id = self.next_pipe_id;
        self.next_pipe_id += 1;

        let rfd = self.alloc_fd()?;
        let empty = Arc::new(Vec::new());
        self.fds.insert(
            rfd,
            OpenFile {
                data: Arc::clone(&empty),
                cursor: 0,
                so_index: None,
                so_base_addr: None,
                guest_path: format!("pipe:[{}]", pipe_id),
                is_dir: false,
                is_std: None,
                is_pipe: true,
                pipe_id: Some(pipe_id),
                writable: false,
                append: false,
                cloexec,
                nonblock,
                dir_entries: Vec::new(),
                    unlinked: false,
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
                guest_path: format!("pipe:[{}]", pipe_id),
                is_dir: false,
                is_std: None,
                is_pipe: true,
                pipe_id: Some(pipe_id),
                writable: true,
                append: false,
                cloexec,
                nonblock,
                dir_entries: Vec::new(),
                    unlinked: false,
            },
        );
        self.pipes.insert(pipe_id, PipeBuffer::new());
        Ok((rfd, wfd))
    }

    pub fn access(&self, dirfd: i32, raw_path: &str, mode: i32) -> i64 {
        let norm_path = match self.resolve_guest_path(dirfd, raw_path) {
            Ok(p) => p,
            Err(e) => return e,
        };
        if (mode & 2) != 0 && self.is_read_only_path(&norm_path) {
            return -EACCES;
        }
        match self.stat_path(dirfd, raw_path, 0) {
            Ok(_) => 0,
            Err(e) => e,
        }
    }

    pub fn mkdirat(&mut self, dirfd: i32, raw_path: &str, mode: u32, now_ns: u64) -> i64 {
        let norm_path = match self.resolve_guest_path(dirfd, raw_path) {
            Ok(p) => p,
            Err(e) => return e,
        };
        if norm_path == "/" {
            return -EEXIST;
        }
        if self.is_read_only_path(&norm_path) {
            return -EACCES;
        }
        if self.overlay.contains_key(&norm_path)
            || self.host_fs.stat_host_ro(&norm_path).is_some()
            || self.is_virtual_parent_dir(&norm_path)
        {
            return -EEXIST;
        }
        let parent = parent_guest_path(&norm_path);
        if !self.is_existing_dir(parent) {
            return self.missing_parent_errno(parent);
        }
        self.overlay.insert(
            norm_path,
            OverlayNode::Dir {
                mode: mode & 0o7777,
                mtime_ns: now_ns,
            },
        );
        0
    }

    pub fn unlinkat(&mut self, dirfd: i32, raw_path: &str, flags: i32) -> i64 {
        let norm_path = match self.resolve_guest_path(dirfd, raw_path) {
            Ok(p) => p,
            Err(e) => return e,
        };
        if norm_path == "/" {
            return -EBUSY;
        }
        if self.is_read_only_path(&norm_path) {
            return -EACCES;
        }
        match self.overlay.get(&norm_path) {
            None => {
                if self.host_fs.stat_host_ro(&norm_path).is_some()
                    || self.is_virtual_parent_dir(&norm_path)
                {
                    return -EACCES;
                }
                return -ENOENT;
            }
            Some(OverlayNode::Dir { .. }) => {
                if (flags & AT_REMOVEDIR) == 0 {
                    return -EISDIR;
                }
                let prefix = format!("{}/", norm_path);
                if self.overlay.keys().any(|k| k.starts_with(&prefix)) {
                    return -ENOTEMPTY;
                }
            }
            Some(OverlayNode::File { .. }) => {
                if (flags & AT_REMOVEDIR) != 0 {
                    return -ENOTDIR;
                }
            }
        }
        if let Some(OverlayNode::File { data, .. }) = self.overlay.remove(&norm_path) {
            for f in self.fds.values_mut() {
                if !f.unlinked && !f.is_dir && !f.is_pipe && f.guest_path == norm_path {
                    f.unlinked = true;
                    f.data = Arc::clone(&data);
                }
            }
        }
        0
    }

    pub fn renameat(
        &mut self,
        olddirfd: i32,
        oldpath: &str,
        newdirfd: i32,
        newpath: &str,
    ) -> i64 {
        let old_norm = match self.resolve_guest_path(olddirfd, oldpath) {
            Ok(p) => p,
            Err(e) => return e,
        };
        let new_norm = match self.resolve_guest_path(newdirfd, newpath) {
            Ok(p) => p,
            Err(e) => return e,
        };
        if self.is_read_only_path(&old_norm) || self.is_read_only_path(&new_norm) {
            return -EACCES;
        }
        if old_norm == "/" || new_norm == "/" {
            return -EBUSY;
        }
        if old_norm == new_norm {
            return if self.overlay.contains_key(&old_norm) {
                0
            } else {
                -ENOENT
            };
        }
        let Some(node) = self.overlay.get(&old_norm).cloned() else {
            if self.host_fs.stat_host_ro(&old_norm).is_some()
                || self.is_virtual_parent_dir(&old_norm)
            {
                return -EACCES;
            }
            return -ENOENT;
        };
        let new_parent = parent_guest_path(&new_norm);
        if !self.is_existing_dir(new_parent) {
            return self.missing_parent_errno(new_parent);
        }
        if matches!(node, OverlayNode::Dir { .. })
            && new_norm.starts_with(&format!("{}/", old_norm))
        {
            return -EINVAL;
        }

        // Check target compatibility if it exists
        if let Some(existing) = self.overlay.get(&new_norm) {
            match (&node, existing) {
                (OverlayNode::Dir { .. }, OverlayNode::File { .. }) => return -ENOTDIR,
                (OverlayNode::File { .. }, OverlayNode::Dir { .. }) => return -EISDIR,
                (OverlayNode::Dir { .. }, OverlayNode::Dir { .. }) => {
                    let new_prefix = format!("{}/", new_norm);
                    if self.overlay.keys().any(|k| k.starts_with(&new_prefix)) {
                        return -ENOTEMPTY;
                    }
                }
                _ => {}
            }
        }

        // Mark any open FDs pointing to an overwritten target file as unlinked
        if let Some(OverlayNode::File { data, .. }) = self.overlay.get(&new_norm) {
            let old_target_data = Arc::clone(data);
            for f in self.fds.values_mut() {
                if !f.unlinked && !f.is_dir && !f.is_pipe && f.guest_path == new_norm {
                    f.unlinked = true;
                    f.data = Arc::clone(&old_target_data);
                }
            }
        }

        self.overlay.remove(&old_norm);
        if matches!(node, OverlayNode::Dir { .. }) {
            let old_prefix = format!("{}/", old_norm);
            let descendants: Vec<(String, OverlayNode)> = self
                .overlay
                .iter()
                .filter(|(k, _)| k.starts_with(&old_prefix))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            for (k, v) in descendants {
                self.overlay.remove(&k);
                let suffix = &k[old_prefix.len()..];
                let dest = format!("{}/{}", new_norm, suffix);
                self.overlay.insert(dest, v);
            }
            for f in self.fds.values_mut() {
                if !f.unlinked && !f.is_pipe {
                    if f.guest_path == old_norm {
                        f.guest_path = new_norm.clone();
                    } else if f.guest_path.starts_with(&old_prefix) {
                        let suffix = &f.guest_path[old_prefix.len()..];
                        f.guest_path = format!("{}/{}", new_norm, suffix);
                    }
                }
            }
        } else {
            for f in self.fds.values_mut() {
                if !f.unlinked && !f.is_dir && !f.is_pipe && f.guest_path == old_norm {
                    f.guest_path = new_norm.clone();
                }
            }
        }
        self.overlay.insert(new_norm, node);
        0
    }

    pub fn truncate_path(&mut self, raw_path: &str, length: i64, now_ns: u64) -> i64 {
        if length < 0 {
            return -EINVAL;
        }
        let norm_path = match self.resolve_guest_path(AT_FDCWD, raw_path) {
            Ok(p) => p,
            Err(e) => return e,
        };
        if self.is_read_only_path(&norm_path) {
            return -EACCES;
        }
        match self.overlay.get_mut(&norm_path) {
            Some(OverlayNode::File {
                data, mtime_ns, ..
            }) => {
                Arc::make_mut(data).resize(length as usize, 0);
                *mtime_ns = now_ns;
                0
            }
            Some(OverlayNode::Dir { .. }) => -EISDIR,
            None => {
                if self.host_fs.stat_host_ro(&norm_path).is_some() {
                    -EACCES
                } else {
                    -ENOENT
                }
            }
        }
    }

    pub fn ftruncate(&mut self, fd: i32, length: i64, now_ns: u64) -> i64 {
        if length < 0 {
            return -EINVAL;
        }
        let Some((writable, is_dir, is_std, guest_path, unlinked)) = self
            .fds
            .get(&fd)
            .map(|f| (f.writable, f.is_dir, f.is_std, f.guest_path.clone(), f.unlinked))
        else {
            return -EBADF;
        };
        if is_std.is_some() || is_dir || !writable {
            return -EINVAL;
        }
        if unlinked {
            if let Some(f) = self.fds.get_mut(&fd) {
                Arc::make_mut(&mut f.data).resize(length as usize, 0);
            }
            return 0;
        }
        let Some(OverlayNode::File {
            data, mtime_ns, ..
        }) = self.overlay.get_mut(&guest_path)
        else {
            return -EINVAL;
        };
        Arc::make_mut(data).resize(length as usize, 0);
        *mtime_ns = now_ns;
        let updated = Arc::clone(data);
        if let Some(f) = self.fds.get_mut(&fd) {
            f.data = updated;
        }
        0
    }

    pub fn chmod_at(&mut self, dirfd: i32, raw_path: &str, mode: u32) -> i64 {
        let norm_path = match self.resolve_guest_path(dirfd, raw_path) {
            Ok(p) => p,
            Err(e) => return e,
        };
        if self.is_read_only_path(&norm_path) {
            return -EACCES;
        }
        match self.overlay.get_mut(&norm_path) {
            Some(OverlayNode::File { mode: m, .. }) | Some(OverlayNode::Dir { mode: m, .. }) => {
                *m = mode & 0o7777;
                0
            }
            None => {
                if self.host_fs.stat_host_ro(&norm_path).is_some() {
                    -EACCES
                } else {
                    -ENOENT
                }
            }
        }
    }

    pub fn fchmod(&mut self, fd: i32, mode: u32) -> i64 {
        let Some((is_std, guest_path)) = self
            .fds
            .get(&fd)
            .map(|f| (f.is_std.is_some(), f.guest_path.clone()))
        else {
            return -EBADF;
        };
        if is_std {
            return 0;
        }
        if self.is_read_only_path(&guest_path) {
            return -EACCES;
        }
        match self.overlay.get_mut(&guest_path) {
            Some(OverlayNode::File { mode: m, .. }) | Some(OverlayNode::Dir { mode: m, .. }) => {
                *m = mode & 0o7777;
                0
            }
            None => -EACCES,
        }
    }

    pub fn utimensat(&mut self, dirfd: i32, raw_path: Option<&str>, now_ns: u64) -> i64 {
        let norm_path = match raw_path {
            Some(p) => match self.resolve_guest_path(dirfd, p) {
                Ok(np) => np,
                Err(e) => return e,
            },
            None => match self.fds.get(&dirfd) {
                Some(f) => f.guest_path.clone(),
                None => return -EBADF,
            },
        };
        if self.is_read_only_path(&norm_path) {
            return -EACCES;
        }
        match self.overlay.get_mut(&norm_path) {
            Some(OverlayNode::File { mtime_ns, .. })
            | Some(OverlayNode::Dir { mtime_ns, .. }) => {
                *mtime_ns = now_ns;
                0
            }
            None => {
                if self.host_fs.stat_host_ro(&norm_path).is_some() {
                    -EACCES
                } else {
                    -ENOENT
                }
            }
        }
    }

    pub fn chdir(&mut self, raw_path: &str) -> i64 {
        let norm_path = match self.resolve_guest_path(AT_FDCWD, raw_path) {
            Ok(p) => p,
            Err(e) => return e,
        };
        match self.stat_path(AT_FDCWD, &norm_path, 0) {
            Ok(st) if (st.st_mode & S_IFDIR) != 0 => {
                self.cwd = norm_path;
                0
            }
            Ok(_) => -ENOTDIR,
            Err(e) => e,
        }
    }

    pub fn fchdir(&mut self, fd: i32) -> i64 {
        let Some(file) = self.fds.get(&fd) else {
            return -EBADF;
        };
        if !file.is_dir {
            return -ENOTDIR;
        }
        self.cwd = file.guest_path.clone();
        0
    }
}
