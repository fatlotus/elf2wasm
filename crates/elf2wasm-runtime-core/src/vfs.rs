use crate::context::{HostFsProvider, NoopHostFs};
use elf2wasm_core::meta::MetaSoFile;
use std::collections::{BTreeMap, HashSet, VecDeque};
use std::sync::Arc;

#[cfg(feature = "std-fs")]
use crate::context::StdHostFs;
#[cfg(feature = "std-fs")]
use std::path::PathBuf;

pub const EPERM: i64 = 1;
pub const ENOENT: i64 = 2;
pub const ESRCH: i64 = 3;
pub const EINTR: i64 = 4;
pub const EIO: i64 = 5;
pub const ENOEXEC: i64 = 8;
pub const EBADF: i64 = 9;
pub const ECHILD: i64 = 10;
pub const EAGAIN: i64 = 11;
pub const ENOMEM: i64 = 12;
pub const EACCES: i64 = 13;
pub const EFAULT: i64 = 14;
pub const EBUSY: i64 = 16;
pub const EEXIST: i64 = 17;
pub const EXDEV: i64 = 18;
pub const ENODEV: i64 = 19;
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
pub const ELOOP: i64 = 40;
pub const ENOTSOCK: i64 = 88;
pub const ENOPROTOOPT: i64 = 92;
pub const EPROTONOSUPPORT: i64 = 93;
pub const EOPNOTSUPP: i64 = 95;
pub const EAFNOSUPPORT: i64 = 97;
pub const EADDRINUSE: i64 = 98;
pub const EADDRNOTAVAIL: i64 = 99;
pub const ENETUNREACH: i64 = 101;
pub const ECONNRESET: i64 = 104;
pub const EISCONN: i64 = 106;
pub const ENOTCONN: i64 = 107;
pub const ESHUTDOWN: i64 = 108;
pub const ETIMEDOUT: i64 = 110;
pub const ECONNREFUSED: i64 = 111;
pub const EALREADY: i64 = 114;
pub const EINPROGRESS: i64 = 115;

pub const MAX_FDS: i32 = 4096;
pub const PIPE_CAPACITY: usize = 65536;

pub const AT_FDCWD: i32 = -100;
pub const AT_SYMLINK_NOFOLLOW: i32 = 0x100;
pub const AT_REMOVEDIR: i32 = 0x200;
pub const AT_SYMLINK_FOLLOW: i32 = 0x400;
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
pub const O_NOFOLLOW: i32 = 0x20000;
pub const O_CLOEXEC: i32 = 0x80000;
pub const MAX_SYMLINK_HOPS: usize = 40;

pub const S_IFSOCK: u32 = 0o140000;
pub const S_IFLNK: u32 = 0o120000;
pub const S_IFREG: u32 = 0o100000;
pub const S_IFDIR: u32 = 0o040000;
pub const S_IFCHR: u32 = 0o020000;
pub const S_IFIFO: u32 = 0o010000;

pub const DT_UNKNOWN: u8 = 0;
pub const DT_FIFO: u8 = 1;
pub const DT_CHR: u8 = 2;
pub const DT_DIR: u8 = 4;
pub const DT_REG: u8 = 8;
pub const DT_LNK: u8 = 10;
pub const DT_SOCK: u8 = 12;

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
    Symlink {
        target: String,
        mtime_ns: u64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VfsDiffKind {
    File,
    Dir,
    Symlink,
    Deleted,
}

impl VfsDiffKind {
    pub fn as_str(self) -> &'static str {
        match self {
            VfsDiffKind::File => "file",
            VfsDiffKind::Dir => "dir",
            VfsDiffKind::Symlink => "symlink",
            VfsDiffKind::Deleted => "deleted",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VfsDiffEntry {
    pub path: String,
    pub kind: VfsDiffKind,
    pub size: u64,
}

fn push_json_escaped_str(out: &mut Vec<u8>, s: &str) {
    out.push(b'"');
    for b in s.bytes() {
        match b {
            b'"' => out.extend_from_slice(b"\\\""),
            b'\\' => out.extend_from_slice(b"\\\\"),
            0x08 => out.extend_from_slice(b"\\b"),
            0x0c => out.extend_from_slice(b"\\f"),
            b'\n' => out.extend_from_slice(b"\\n"),
            b'\r' => out.extend_from_slice(b"\\r"),
            b'\t' => out.extend_from_slice(b"\\t"),
            c if c < 0x20 => {
                let hex = b"0123456789abcdef";
                out.extend_from_slice(b"\\u00");
                out.push(hex[(c >> 4) as usize]);
                out.push(hex[(c & 0x0f) as usize]);
            }
            c => out.push(c),
        }
    }
    out.push(b'"');
}

/// Encode a slice of [`VfsDiffEntry`] values as compact RFC 8259 JSON UTF-8 bytes.
pub fn encode_vfs_diff_json(entries: &[VfsDiffEntry]) -> Vec<u8> {
    let mut out = Vec::with_capacity(2 + entries.len() * 48);
    out.push(b'[');
    for (i, entry) in entries.iter().enumerate() {
        if i > 0 {
            out.push(b',');
        }
        out.extend_from_slice(b"{\"path\":");
        push_json_escaped_str(&mut out, &entry.path);
        out.extend_from_slice(b",\"kind\":\"");
        out.extend_from_slice(entry.kind.as_str().as_bytes());
        out.extend_from_slice(b"\",\"size\":");
        out.extend_from_slice(entry.size.to_string().as_bytes());
        out.push(b'}');
    }
    out.push(b']');
    out
}

#[derive(Debug, Clone)]
pub struct PipeBuffer {
    pub buf: VecDeque<u8>,
    pub in_flight: VecDeque<(u64, Vec<u8>)>,
    pub in_flight_bytes: usize,
    pub is_tcp: bool,
    pub readers: usize,
    pub writers: usize,
    pub capacity: usize,
}

impl PipeBuffer {
    pub fn new() -> Self {
        Self {
            buf: VecDeque::new(),
            in_flight: VecDeque::new(),
            in_flight_bytes: 0,
            is_tcp: false,
            readers: 1,
            writers: 1,
            capacity: PIPE_CAPACITY,
        }
    }

    pub fn new_tcp() -> Self {
        let mut p = Self::new();
        p.is_tcp = true;
        p
    }

    /// Total bytes buffered (already delivered + currently in-flight).
    #[inline]
    pub fn total_buffered(&self) -> usize {
        self.buf.len().saturating_add(self.in_flight_bytes)
    }

    /// True only when all writers are closed AND all in-flight bytes have been delivered.
    #[inline]
    pub fn is_eof(&self) -> bool {
        self.writers == 0 && self.in_flight.is_empty()
    }

    /// Enqueue bytes for simulated-time delivery while strictly preserving per-pipe FIFO.
    pub fn push_in_flight(&mut self, now_ns: u64, delay_ns: u64, bytes: Vec<u8>) {
        if bytes.is_empty() {
            return;
        }
        let target = now_ns.saturating_add(delay_ns);
        let deliver_ns = self
            .in_flight
            .back()
            .map_or(target, |&(prev_ns, _)| prev_ns.max(target));
        self.in_flight_bytes = self.in_flight_bytes.saturating_add(bytes.len());
        self.in_flight.push_back((deliver_ns, bytes));
    }

    /// Move all in-flight chunks with `deliver_ns <= now_ns` into `self.buf`.
    /// Returns `(delivered_any, became_eof)`.
    pub fn flush_in_flight(&mut self, now_ns: u64) -> (bool, bool) {
        let mut delivered = false;
        while let Some(&(deliver_ns, _)) = self.in_flight.front() {
            if deliver_ns > now_ns {
                break;
            }
            if let Some((_, chunk)) = self.in_flight.pop_front() {
                self.in_flight_bytes = self.in_flight_bytes.saturating_sub(chunk.len());
                self.buf.extend(chunk);
                delivered = true;
            }
        }
        let became_eof = delivered && self.writers == 0 && self.in_flight.is_empty();
        (delivered, became_eof)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VirtualDevice {
    Null,
    Zero,
    Random,
    Tty,
}

#[derive(Debug, Clone)]
pub struct EventFdState {
    pub counter: u64,
    pub semaphore: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EpollEntry {
    pub events: u32,
    pub data: u64,
    pub last_reported_revents: u16,
}

#[derive(Debug, Clone, Default)]
pub struct EpollInstance {
    pub entries: BTreeMap<i32, EpollEntry>,
}

#[derive(Debug, Clone)]
pub enum TcpSocketState {
    Unbound,
    Bound {
        local_ip: u32,
        local_port: u16,
    },
    Listening {
        local_ip: u32,
        local_port: u16,
        backlog_limit: usize,
        pending: VecDeque<u64>,
    },
    Connected {
        local_ip: u32,
        local_port: u16,
        peer_ip: u32,
        peer_port: u16,
        read_pipe_id: u64,
        write_pipe_id: u64,
        shut_rd: bool,
        shut_wr: bool,
    },
}

#[derive(Debug, Clone)]
pub struct TcpSocket {
    pub state: TcpSocketState,
    pub ref_count: usize,
    pub reuse_addr: bool,
    pub tcp_nodelay: bool,
    pub keepalive: bool,
    pub keepidle: i32,
    pub keepintvl: i32,
    pub keepcnt: i32,
    pub sndbuf: i32,
    pub rcvbuf: i32,
    pub so_error: i32,
}

impl TcpSocket {
    pub fn new(state: TcpSocketState) -> Self {
        Self {
            state,
            ref_count: 1,
            reuse_addr: false,
            tcp_nodelay: false,
            keepalive: false,
            keepidle: 7200,
            keepintvl: 75,
            keepcnt: 9,
            sndbuf: PIPE_CAPACITY as i32,
            rcvbuf: PIPE_CAPACITY as i32,
            so_error: 0,
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
    pub sock_write_pipe_id: Option<u64>,
    pub tcp_socket_id: Option<u64>,
    pub dev: Option<VirtualDevice>,
    pub epoll_id: Option<u64>,
    pub eventfd_id: Option<u64>,
    pub writable: bool,
    pub append: bool,
    pub cloexec: bool,
    pub nonblock: bool,
    pub dir_entries: Vec<DirEntry>,
    pub unlinked: bool,
}

impl OpenFile {
    fn base(guest_path: String, data: Arc<Vec<u8>>) -> Self {
        Self {
            data,
            cursor: 0,
            so_index: None,
            so_base_addr: None,
            guest_path,
            is_dir: false,
            is_std: None,
            is_pipe: false,
            pipe_id: None,
            sock_write_pipe_id: None,
            tcp_socket_id: None,
            dev: None,
            epoll_id: None,
            eventfd_id: None,
            writable: false,
            append: false,
            cloexec: false,
            nonblock: false,
            dir_entries: Vec::new(),
            unlinked: false,
        }
    }
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
    pub epolls: BTreeMap<u64, EpollInstance>,
    pub next_epoll_id: u64,
    pub eventfds: BTreeMap<u64, EventFdState>,
    pub next_eventfd_id: u64,
    pub tcp_sockets: BTreeMap<u64, TcpSocket>,
    pub next_tcp_socket_id: u64,
    pub tcp_bound_ports: BTreeMap<u16, u64>,
    pub tcp_listeners: BTreeMap<u16, u64>,
    pub next_ephemeral_port: u16,
    pub cwd: String,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub stdout_drain_cursor: usize,
    pub stderr_drain_cursor: usize,
    pub stdin_data: Vec<u8>,
    stdin_cursor: usize,
    pub stdin_eof: bool,
    pub inherit_stdin: bool,
    pub elf_path: String,
    pub prng_state: u64,
    pub current_pid: i32,
    pub current_ppid: i32,
    pub current_pgid: i32,
    pub uid: u32,
    pub gid: u32,
    pub cmdline: Vec<String>,
    pub uptime_ns: u64,
    pub umask: u32,
    snapshots: BTreeMap<u32, BTreeMap<String, OverlayNode>>,
    next_snapshot_id: u32,
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
        for (fd, path, writable) in [
            (0, "/dev/stdin", false),
            (1, "/dev/stdout", true),
            (2, "/dev/stderr", true),
        ] {
            let mut f = OpenFile::base(path.to_string(), Arc::clone(&empty));
            f.is_std = Some(fd as u8);
            f.writable = writable;
            fds.insert(fd, f);
        }

        Self {
            so_entries,
            host_fs,
            overlay,
            fds,
            next_fd: 3,
            pipes: BTreeMap::new(),
            next_pipe_id: 1,
            epolls: BTreeMap::new(),
            next_epoll_id: 1,
            eventfds: BTreeMap::new(),
            next_eventfd_id: 1,
            tcp_sockets: BTreeMap::new(),
            next_tcp_socket_id: 1,
            tcp_bound_ports: BTreeMap::new(),
            tcp_listeners: BTreeMap::new(),
            next_ephemeral_port: 32768,
            cwd: "/".to_string(),
            stdout: Vec::new(),
            stderr: Vec::new(),
            stdout_drain_cursor: 0,
            stderr_drain_cursor: 0,
            stdin_data: Vec::new(),
            stdin_cursor: 0,
            stdin_eof: true,
            inherit_stdin: false,
            elf_path: String::new(),
            prng_state: 0x9e37_79b9_7f4a_7c15,
            current_pid: 1000,
            current_ppid: 1,
            current_pgid: 1000,
            uid: 1000,
            gid: 1000,
            cmdline: Vec::new(),
            uptime_ns: 0,
            umask: 0o022,
            snapshots: BTreeMap::new(),
            next_snapshot_id: 1,
        }
    }

    pub fn next_rand_u64(&mut self) -> u64 {
        let mut x = self.prng_state;
        if x == 0 {
            x = 0x9e37_79b9_7f4a_7c15;
        }
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.prng_state = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    pub fn stdin_cursor_val(&self) -> usize {
        self.stdin_cursor
    }

    pub fn stdin_available(&self) -> usize {
        self.stdin_data.len().saturating_sub(self.stdin_cursor)
    }

    pub fn push_stdin(&mut self, data: &[u8]) {
        if self.stdin_cursor > 0 && self.stdin_cursor >= self.stdin_data.len() {
            self.stdin_data.clear();
            self.stdin_cursor = 0;
        }
        self.stdin_data.extend_from_slice(data);
    }

    pub fn close_stdin(&mut self) {
        self.stdin_eof = true;
    }

    pub fn drain_stdout(&mut self) -> Vec<u8> {
        let cur = self.stdout_drain_cursor.min(self.stdout.len());
        let out = self.stdout[cur..].to_vec();
        self.stdout_drain_cursor = self.stdout.len();
        out
    }

    pub fn drain_stderr(&mut self) -> Vec<u8> {
        let cur = self.stderr_drain_cursor.min(self.stderr.len());
        let out = self.stderr[cur..].to_vec();
        self.stderr_drain_cursor = self.stderr.len();
        out
    }

    pub fn snapshot_vfs(&mut self) -> u32 {
        let mut id = self.next_snapshot_id;
        if id == 0 {
            id = 1;
        }
        while self.snapshots.contains_key(&id) {
            id = id.wrapping_add(1);
            if id == 0 {
                id = 1;
            }
        }
        self.next_snapshot_id = id.wrapping_add(1);
        if self.next_snapshot_id == 0 {
            self.next_snapshot_id = 1;
        }
        self.snapshots.insert(id, self.overlay.clone());
        id
    }

    pub fn restore_vfs(&mut self, snapshot_id: u32) -> i32 {
        if snapshot_id == 0 {
            return -1;
        }
        let Some(snap) = self.snapshots.get(&snapshot_id) else {
            return -1;
        };
        self.overlay = snap.clone();
        0
    }

    pub fn drop_vfs_snapshot(&mut self, snapshot_id: u32) -> i32 {
        if snapshot_id == 0 {
            return -1;
        }
        if self.snapshots.remove(&snapshot_id).is_some() {
            0
        } else {
            -1
        }
    }

    pub fn has_snapshot(&self, snapshot_id: u32) -> bool {
        snapshot_id != 0 && self.snapshots.contains_key(&snapshot_id)
    }

    /// Return sorted normalized paths of all entries currently in the VFS overlay.
    pub fn overlay_paths(&self) -> Vec<String> {
        self.overlay.keys().cloned().collect()
    }

    fn normalize_prefix(path_prefix: Option<&str>) -> Option<String> {
        let raw = path_prefix?;
        if raw.is_empty() {
            return None;
        }
        let norm = normalize_guest_path(raw);
        if norm == "/" {
            None
        } else {
            Some(norm)
        }
    }

    fn matches_prefix(path: &str, prefix: Option<&str>) -> bool {
        if path == "/" {
            return false;
        }
        let Some(pfx) = prefix else {
            return true;
        };
        path == pfx
            || (path.len() > pfx.len()
                && path.starts_with(pfx)
                && path.as_bytes()[pfx.len()] == b'/')
    }

    fn nodes_unchanged(cur: &OverlayNode, base: &OverlayNode) -> bool {
        match (cur, base) {
            (
                OverlayNode::File {
                    data: d1,
                    mode: m1,
                    mtime_ns: t1,
                },
                OverlayNode::File {
                    data: d2,
                    mode: m2,
                    mtime_ns: t2,
                },
            ) => Arc::ptr_eq(d1, d2) && m1 == m2 && t1 == t2,
            (
                OverlayNode::Dir {
                    mode: m1,
                    mtime_ns: t1,
                },
                OverlayNode::Dir {
                    mode: m2,
                    mtime_ns: t2,
                },
            ) => m1 == m2 && t1 == t2,
            (
                OverlayNode::Symlink {
                    target: s1,
                    mtime_ns: t1,
                },
                OverlayNode::Symlink {
                    target: s2,
                    mtime_ns: t2,
                },
            ) => s1 == s2 && t1 == t2,
            _ => false,
        }
    }

    fn has_ancestor_in_set(path: &str, set: &HashSet<&str>) -> bool {
        let mut cur = parent_guest_path(path);
        while cur != "/" {
            if set.contains(cur) {
                return true;
            }
            cur = parent_guest_path(cur);
        }
        false
    }

    fn compute_diff_sets<'a>(
        &'a self,
        base_snapshot_id: Option<u32>,
        path_prefix: Option<&str>,
    ) -> (Vec<(&'a String, &'a OverlayNode)>, Vec<&'a str>, Vec<&'a str>) {
        let norm_prefix = Self::normalize_prefix(path_prefix);
        let pfx = norm_prefix.as_deref();
        let base_map = base_snapshot_id.and_then(|id| self.snapshots.get(&id));

        let mut deleted_paths: Vec<&'a str> = Vec::new();
        let mut replaced_dir_whiteouts: Vec<&'a str> = Vec::new();

        if let Some(base) = base_map {
            let mut raw_deleted: Vec<&'a str> = Vec::new();
            let mut raw_replaced: Vec<&'a str> = Vec::new();
            for (path, base_node) in base {
                if !Self::matches_prefix(path, pfx) {
                    continue;
                }
                match self.overlay.get(path) {
                    None => raw_deleted.push(path.as_str()),
                    Some(cur_node) => {
                        if matches!(base_node, OverlayNode::Dir { .. })
                            && !matches!(cur_node, OverlayNode::Dir { .. })
                        {
                            raw_replaced.push(path.as_str());
                        }
                    }
                }
            }
            let mut all_removed: HashSet<&'a str> =
                HashSet::with_capacity(raw_deleted.len() + raw_replaced.len());
            for &p in &raw_deleted {
                all_removed.insert(p);
            }
            for &p in &raw_replaced {
                all_removed.insert(p);
            }
            for p in raw_deleted {
                if !Self::has_ancestor_in_set(p, &all_removed) {
                    deleted_paths.push(p);
                }
            }
            for p in raw_replaced {
                if !Self::has_ancestor_in_set(p, &all_removed) {
                    replaced_dir_whiteouts.push(p);
                }
            }
        }

        let mut changed_entries: Vec<(&'a String, &'a OverlayNode)> = Vec::new();
        for (path, cur_node) in &self.overlay {
            if !Self::matches_prefix(path, pfx) {
                continue;
            }
            if let Some(base_node) = base_map.and_then(|b| b.get(path)) {
                if Self::nodes_unchanged(cur_node, base_node) {
                    continue;
                }
            }
            changed_entries.push((path, cur_node));
        }

        (changed_entries, deleted_paths, replaced_dir_whiteouts)
    }

    pub fn list_diff(
        &self,
        base_snapshot_id: Option<u32>,
        path_prefix: Option<&str>,
    ) -> Vec<VfsDiffEntry> {
        let (changed_entries, deleted_paths, _) =
            self.compute_diff_sets(base_snapshot_id, path_prefix);
        let mut out = Vec::with_capacity(changed_entries.len() + deleted_paths.len());
        for (path, node) in changed_entries {
            let (kind, size) = match node {
                OverlayNode::File { data, .. } => (VfsDiffKind::File, data.len() as u64),
                OverlayNode::Dir { .. } => (VfsDiffKind::Dir, 0),
                OverlayNode::Symlink { target, .. } => (VfsDiffKind::Symlink, target.len() as u64),
            };
            out.push(VfsDiffEntry {
                path: path.clone(),
                kind,
                size,
            });
        }
        for path in deleted_paths {
            out.push(VfsDiffEntry {
                path: path.to_string(),
                kind: VfsDiffKind::Deleted,
                size: 0,
            });
        }
        out.sort_by(|a, b| a.path.cmp(&b.path));
        out
    }

    pub fn export_tar(
        &self,
        base_snapshot_id: Option<u32>,
        path_prefix: Option<&str>,
    ) -> Vec<u8> {
        let (changed_entries, deleted_paths, replaced_dir_whiteouts) =
            self.compute_diff_sets(base_snapshot_id, path_prefix);

        let mut out: Vec<u8> = Vec::new();

        // 1. OCI whiteouts (.wh.<name>) for deletions and replaced directories.
        let mut whiteouts: Vec<&str> =
            Vec::with_capacity(deleted_paths.len() + replaced_dir_whiteouts.len());
        whiteouts.extend_from_slice(&deleted_paths);
        whiteouts.extend_from_slice(&replaced_dir_whiteouts);
        whiteouts.sort_unstable();
        whiteouts.dedup();
        for path in whiteouts {
            let trimmed = path.trim_start_matches('/');
            if trimmed.is_empty() {
                continue;
            }
            let wh_tar_path = match trimmed.rfind('/') {
                Some(idx) => format!("{}/.wh.{}", &trimmed[..idx], &trimmed[idx + 1..]),
                None => format!(".wh.{}", trimmed),
            };
            write_tar_entry(&mut out, &wh_tar_path, b'0', 0o644, 0, "", &[]);
        }

        // 2. Directories (parents before children via BTreeMap lexicographical order).
        for (path, node) in &changed_entries {
            if let OverlayNode::Dir { mode, mtime_ns } = node {
                let trimmed = path.trim_start_matches('/');
                if trimmed.is_empty() {
                    continue;
                }
                let tar_path = format!("{}/", trimmed);
                write_tar_entry(
                    &mut out,
                    &tar_path,
                    b'5',
                    *mode & 0o7777,
                    *mtime_ns / 1_000_000_000,
                    "",
                    &[],
                );
            }
        }

        // 3. Symlinks.
        for (path, node) in &changed_entries {
            if let OverlayNode::Symlink { target, mtime_ns } = node {
                let trimmed = path.trim_start_matches('/');
                if trimmed.is_empty() {
                    continue;
                }
                write_tar_entry(
                    &mut out,
                    trimmed,
                    b'2',
                    0o777,
                    *mtime_ns / 1_000_000_000,
                    target,
                    &[],
                );
            }
        }

        // 4. Regular files.
        for (path, node) in &changed_entries {
            if let OverlayNode::File {
                data,
                mode,
                mtime_ns,
            } = node
            {
                let trimmed = path.trim_start_matches('/');
                if trimmed.is_empty() {
                    continue;
                }
                write_tar_entry(
                    &mut out,
                    trimmed,
                    b'0',
                    *mode & 0o7777,
                    *mtime_ns / 1_000_000_000,
                    "",
                    data.as_slice(),
                );
            }
        }

        // 5. End-of-archive: two 512-byte zero blocks.
        out.resize(out.len() + 1024, 0);
        out
    }

    /// Extract a USTAR/PAX/GNU-longname tar archive into the VFS overlay.
    ///
    /// Supports OCI whiteouts (`.wh.<name>` and `.wh..wh..opq`), `mount_path`,
    /// and `strip_components`, matching `extractTarToVfs` + `applyVfsOverlay` in
    /// `js/elf2wasm_shim.mjs`.
    pub fn extract_tar(
        &mut self,
        tar_bytes: &[u8],
        mount_path: &str,
        strip_components: usize,
        ignore_whiteouts: bool,
    ) -> Result<usize, String> {
        let mount = normalize_guest_path(if mount_path.is_empty() { "/" } else { mount_path });

        enum TarWhiteout {
            Opaque(String),
            Remove(String),
        }

        let mut files: BTreeMap<String, (Vec<u8>, u32)> = BTreeMap::new();
        let mut symlinks: BTreeMap<String, String> = BTreeMap::new();
        let mut dirs: BTreeMap<String, u32> = BTreeMap::new();
        let mut whiteouts: Vec<TarWhiteout> = Vec::new();

        if mount != "/" {
            dirs.insert(mount.clone(), 0o755);
        }

        let mut offset: usize = 0;
        let mut next_long_name: Option<String> = None;
        let mut next_long_link: Option<String> = None;
        let mut next_pax: Option<BTreeMap<String, String>> = None;
        let mut global_pax: BTreeMap<String, String> = BTreeMap::new();

        while offset + 512 <= tar_bytes.len() {
            let hdr = &tar_bytes[offset..offset + 512];
            if hdr.iter().all(|&b| b == 0) {
                offset += 512;
                continue;
            }

            let name_field = read_tar_str(&hdr[0..100]);
            let mode = parse_tar_num(&hdr[100..108]).unwrap_or(0) as u32;
            let mut size = parse_tar_num(&hdr[124..136]).unwrap_or(0);
            let typeflag = hdr[156];
            let link_field = read_tar_str(&hdr[157..257]);
            let prefix_field = read_tar_str(&hdr[345..500]);

            offset += 512;

            if let Some(pax) = next_pax.as_ref() {
                if let Some(sz_str) = pax.get("size") {
                    if let Ok(pax_sz) = sz_str.parse::<u64>() {
                        size = pax_sz;
                    }
                }
            }

            let size_usize = usize::try_from(size)
                .map_err(|_| format!("tar entry size overflows usize: {}", size))?;
            let data_end = offset.saturating_add(size_usize).min(tar_bytes.len());
            let payload = &tar_bytes[offset..data_end];
            let padded_blocks = size_usize.div_ceil(512).saturating_mul(512);
            offset = offset.saturating_add(padded_blocks);

            match typeflag {
                b'L' => {
                    let s = String::from_utf8_lossy(payload)
                        .trim_end_matches('\0')
                        .to_string();
                    next_long_name = Some(s);
                    continue;
                }
                b'K' => {
                    let s = String::from_utf8_lossy(payload)
                        .trim_end_matches('\0')
                        .to_string();
                    next_long_link = Some(s);
                    continue;
                }
                b'x' => {
                    next_pax = Some(parse_pax_records(payload));
                    continue;
                }
                b'g' => {
                    for (k, v) in parse_pax_records(payload) {
                        global_pax.insert(k, v);
                    }
                    continue;
                }
                _ => {}
            }

            let mut raw_path = if !prefix_field.is_empty() {
                format!("{}/{}", prefix_field, name_field)
            } else {
                name_field
            };
            if let Some(ln) = next_long_name.take() {
                raw_path = ln;
            }
            if let Some(pax_path) = next_pax
                .as_ref()
                .and_then(|p| p.get("path"))
                .or_else(|| global_pax.get("path"))
            {
                raw_path = pax_path.clone();
            }

            let mut link_target = link_field;
            if let Some(ll) = next_long_link.take() {
                link_target = ll;
            }
            if let Some(pax_link) = next_pax
                .as_ref()
                .and_then(|p| p.get("linkpath"))
                .or_else(|| global_pax.get("linkpath"))
            {
                link_target = pax_link.clone();
            }
            next_pax = None;

            let Some(guest_path) = resolve_tar_entry_path(&raw_path, &mount, strip_components)
            else {
                continue;
            };

            if !ignore_whiteouts {
                let (parent_dir, base) = split_parent_base(&guest_path);
                if base == ".wh..wh..opq" {
                    whiteouts.push(TarWhiteout::Opaque(parent_dir.to_string()));
                    continue;
                }
                if let Some(target_name) = base.strip_prefix(".wh.") {
                    if !target_name.is_empty() {
                        let target_path = if parent_dir == "/" {
                            format!("/{}", target_name)
                        } else {
                            format!("{}/{}", parent_dir, target_name)
                        };
                        whiteouts.push(TarWhiteout::Remove(target_path));
                    }
                    continue;
                }
            }

            match typeflag {
                b'5' => {
                    symlinks.remove(&guest_path);
                    files.remove(&guest_path);
                    dirs.insert(guest_path, if mode != 0 { mode & 0o7777 } else { 0o755 });
                }
                b'2' => {
                    files.remove(&guest_path);
                    dirs.remove(&guest_path);
                    symlinks.insert(guest_path, link_target);
                }
                b'1' => {
                    let Some(target_guest) =
                        resolve_tar_entry_path(&link_target, &mount, strip_components)
                    else {
                        continue;
                    };
                    if let Some((existing_bytes, existing_mode)) = files.get(&target_guest).cloned()
                    {
                        symlinks.remove(&guest_path);
                        dirs.remove(&guest_path);
                        let m = if mode != 0 {
                            mode & 0o7777
                        } else if existing_mode != 0 {
                            existing_mode
                        } else {
                            0o644
                        };
                        files.insert(guest_path, (existing_bytes, m));
                    } else if let Some(target_bytes) = self.vfs_read_file(&target_guest) {
                        symlinks.remove(&guest_path);
                        dirs.remove(&guest_path);
                        let m = if mode != 0 { mode & 0o7777 } else { 0o644 };
                        files.insert(guest_path, (target_bytes, m));
                    } else {
                        files.remove(&guest_path);
                        dirs.remove(&guest_path);
                        symlinks.insert(guest_path, target_guest);
                    }
                }
                b'0' | 0 => {
                    let file_mode = if mode != 0 { mode & 0o7777 } else { 0o644 };
                    symlinks.remove(&guest_path);
                    dirs.remove(&guest_path);
                    files.insert(guest_path, (payload.to_vec(), file_mode));
                }
                _ => {}
            }
        }

        let mut applied = 0usize;

        // 1. Apply whiteouts before this layer's entries.
        for wh in whiteouts {
            match wh {
                TarWhiteout::Opaque(dir) => {
                    if dir == "/" {
                        let non_root: Vec<String> = self
                            .overlay
                            .keys()
                            .filter(|k| k.as_str() != "/")
                            .cloned()
                            .collect();
                        for k in non_root {
                            self.overlay.remove(&k);
                        }
                    } else {
                        self.vfs_remove_path(&dir);
                        self.vfs_add_dir(&dir, 0o755);
                    }
                    applied += 1;
                }
                TarWhiteout::Remove(path) => {
                    self.vfs_remove_path(&path);
                    applied += 1;
                }
            }
        }

        // 2. Apply directories sorted by depth ascending.
        let mut sorted_dirs: Vec<(String, u32)> = dirs.into_iter().collect();
        sorted_dirs.sort_by(|a, b| {
            let da = a.0.matches('/').count();
            let db = b.0.matches('/').count();
            da.cmp(&db).then_with(|| a.0.cmp(&b.0))
        });
        for (path, mode) in sorted_dirs {
            self.vfs_add_dir(&path, mode);
            applied += 1;
        }

        // 3. Apply symlinks sorted by depth ascending.
        let mut sorted_symlinks: Vec<(String, String)> = symlinks.into_iter().collect();
        sorted_symlinks.sort_by(|a, b| {
            let da = a.0.matches('/').count();
            let db = b.0.matches('/').count();
            da.cmp(&db).then_with(|| a.0.cmp(&b.0))
        });
        for (path, target) in sorted_symlinks {
            self.vfs_add_symlink(&path, &target);
            applied += 1;
        }

        // 4. Apply regular files.
        for (path, (bytes, mode)) in files {
            self.vfs_write_file(&path, &bytes, mode);
            applied += 1;
        }

        Ok(applied)
    }

    /// Earliest scheduled delivery timestamp among all pipes with an open reader.
    pub fn min_in_flight_ns(&self) -> Option<u64> {
        self.pipes
            .values()
            .filter(|p| p.readers > 0)
            .filter_map(|p| p.in_flight.front().map(|&(deliver_ns, _)| deliver_ns))
            .min()
    }

    /// Deliver all in-flight pipe chunks with `deliver_ns <= now_ns` into `p.buf`.
    /// Returns `(pipe_id, became_eof)` for each pipe that delivered bytes.
    pub fn flush_in_flight_pipes(&mut self, now_ns: u64) -> Vec<(u64, bool)> {
        let mut flushed = Vec::new();
        for (&pipe_id, p) in self.pipes.iter_mut() {
            if p.readers == 0 {
                if !p.in_flight.is_empty() {
                    p.in_flight.clear();
                    p.in_flight_bytes = 0;
                }
                continue;
            }
            let (delivered, became_eof) = p.flush_in_flight(now_ns);
            if delivered {
                flushed.push((pipe_id, became_eof));
            }
        }
        flushed
    }

    pub fn reset_fds_and_stdio(&mut self) {
        self.pipes.clear();
        self.next_pipe_id = 1;
        self.epolls.clear();
        self.next_epoll_id = 1;
        self.eventfds.clear();
        self.next_eventfd_id = 1;
        self.tcp_sockets.clear();
        self.next_tcp_socket_id = 1;
        self.tcp_bound_ports.clear();
        self.tcp_listeners.clear();
        self.next_ephemeral_port = 32768;
        self.fds.clear();
        let empty = Arc::new(Vec::new());
        for (fd, path, writable) in [
            (0, "/dev/stdin", false),
            (1, "/dev/stdout", true),
            (2, "/dev/stderr", true),
        ] {
            let mut f = OpenFile::base(path.to_string(), Arc::clone(&empty));
            f.is_std = Some(fd as u8);
            f.writable = writable;
            self.fds.insert(fd, f);
        }
        self.next_fd = 3;
        self.cwd = "/".to_string();
        self.stdout.clear();
        self.stderr.clear();
        self.stdout_drain_cursor = 0;
        self.stderr_drain_cursor = 0;
        self.stdin_data.clear();
        self.stdin_cursor = 0;
        self.umask = 0o022;
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

    fn resolve_and_ensure_parent(&mut self, path: &str) -> Option<String> {
        let norm = normalize_guest_path(path);
        if norm == "/" {
            return None;
        }
        let (parent_raw, name) = norm.rsplit_once('/')?;
        if name.is_empty() {
            return None;
        }
        let resolved_parent = if parent_raw.is_empty() {
            "/".to_string()
        } else {
            match self.resolve_path(AT_FDCWD, parent_raw, true) {
                Ok(p) => p,
                Err(_) => parent_raw.to_string(),
            }
        };
        let mut cur = String::new();
        for part in resolved_parent.split('/').filter(|s| !s.is_empty()) {
            cur.push('/');
            cur.push_str(part);
            self.overlay.entry(cur.clone()).or_insert(OverlayNode::Dir {
                mode: 0o755,
                mtime_ns: crate::scheduler::INITIAL_REALTIME_BASE_NS,
            });
        }
        let final_path = if resolved_parent == "/" {
            format!("/{}", name)
        } else {
            format!("{}/{}", resolved_parent, name)
        };
        Some(final_path)
    }

    pub fn vfs_write_file(&mut self, path: &str, bytes: &[u8], mode: u32) {
        let Some(final_path) = self.resolve_and_ensure_parent(path) else {
            return;
        };
        self.overlay.insert(
            final_path,
            OverlayNode::File {
                data: Arc::new(bytes.to_vec()),
                mode: mode & 0o7777,
                mtime_ns: crate::scheduler::INITIAL_REALTIME_BASE_NS,
            },
        );
    }

    pub fn vfs_add_symlink(&mut self, path: &str, target: &str) {
        let Some(final_path) = self.resolve_and_ensure_parent(path) else {
            return;
        };
        self.overlay.insert(
            final_path,
            OverlayNode::Symlink {
                target: target.to_string(),
                mtime_ns: crate::scheduler::INITIAL_REALTIME_BASE_NS,
            },
        );
    }

    pub fn vfs_add_dir(&mut self, path: &str, mode: u32) {
        let norm = normalize_guest_path(path);
        if norm == "/" {
            self.overlay.insert(
                "/".to_string(),
                OverlayNode::Dir {
                    mode: mode & 0o7777,
                    mtime_ns: crate::scheduler::INITIAL_REALTIME_BASE_NS,
                },
            );
            return;
        }
        let Some(final_path) = self.resolve_and_ensure_parent(path) else {
            return;
        };
        self.overlay.insert(
            final_path,
            OverlayNode::Dir {
                mode: mode & 0o7777,
                mtime_ns: crate::scheduler::INITIAL_REALTIME_BASE_NS,
            },
        );
    }

    pub fn vfs_remove_path(&mut self, path: &str) -> bool {
        let norm = self
            .resolve_path(AT_FDCWD, path, false)
            .unwrap_or_else(|_| normalize_guest_path(path));
        if norm == "/" {
            return false;
        }
        let mut removed = self.overlay.remove(&norm).is_some();
        let prefix = format!("{}/", norm);
        let descendants: Vec<String> = self
            .overlay
            .keys()
            .filter(|k| k.starts_with(&prefix))
            .cloned()
            .collect();
        for key in descendants {
            self.overlay.remove(&key);
            removed = true;
        }
        removed
    }

    pub fn vfs_read_file(&self, path: &str) -> Option<Vec<u8>> {
        let norm = self.resolve_path(AT_FDCWD, path, true).ok()?;
        if let Some(bytes) = self.virtual_proc_file(&norm) {
            return Some(bytes);
        }
        if let Some(OverlayNode::File { data, .. }) = self.overlay.get(&norm) {
            return Some(data.as_ref().clone());
        }
        if let Some((_, so)) = self.find_so(&norm) {
            return Some(so.bytes.as_ref().clone());
        }
        self.host_fs.read_host_ro(&norm)
    }

    fn virtual_symlink_target(&self, path: &str) -> Option<String> {
        match path {
            "/dev/stdin" => Some("/proc/self/fd/0".to_string()),
            "/dev/stdout" => Some("/proc/self/fd/1".to_string()),
            "/dev/stderr" => Some("/proc/self/fd/2".to_string()),
            "/dev/fd" => Some("/proc/self/fd".to_string()),
            "/proc/self" => Some(self.current_pid.to_string()),
            _ => None,
        }
    }

    fn virtual_dev_kind(norm_path: &str) -> Option<VirtualDevice> {
        match norm_path {
            "/dev/null" => Some(VirtualDevice::Null),
            "/dev/zero" => Some(VirtualDevice::Zero),
            "/dev/urandom" | "/dev/random" => Some(VirtualDevice::Random),
            "/dev/tty" => Some(VirtualDevice::Tty),
            _ => None,
        }
    }

    fn parse_proc_fd(&self, norm_path: &str) -> Option<i32> {
        let rest = norm_path.strip_prefix("/proc/")?;
        let (who, tail) = rest.split_once("/fd/")?;
        if tail.contains('/') {
            return None;
        }
        if who != "self" && who != self.current_pid.to_string() {
            return None;
        }
        tail.parse::<i32>().ok().filter(|&n| n >= 0)
    }

    fn is_proc_self_prefix(&self, who: &str) -> bool {
        who == "self" || who == self.current_pid.to_string()
    }

    fn is_virtual_dir(&self, norm_path: &str) -> bool {
        if norm_path == "/dev" || norm_path == "/proc" {
            return true;
        }
        if let Some(rest) = norm_path.strip_prefix("/proc/") {
            if self.is_proc_self_prefix(rest) {
                return true;
            }
            if let Some(who) = rest.strip_suffix("/fd") {
                if self.is_proc_self_prefix(who) {
                    return true;
                }
            }
        }
        false
    }

    fn virtual_proc_file(&self, norm_path: &str) -> Option<Vec<u8>> {
        match norm_path {
            "/proc/uptime" => {
                let secs = (self.uptime_ns as f64 / 1e9).max(1.0);
                Some(format!("{:.2} {:.2}\n", secs, secs).into_bytes())
            }
            "/proc/meminfo" => Some(
                b"MemTotal:         262144 kB\n\
MemFree:          131072 kB\n\
MemAvailable:     131072 kB\n\
Buffers:               0 kB\n\
Cached:                0 kB\n\
SwapTotal:             0 kB\n\
SwapFree:              0 kB\n"
                    .to_vec(),
            ),
            "/proc/cpuinfo" => Some(
                b"processor\t: 0\n\
vendor_id\t: GenuineIntel\n\
cpu family\t: 6\n\
model\t\t: 142\n\
model name\t: elf2wasm Virtual x86_64 CPU\n\
stepping\t: 0\n\
cpu MHz\t\t: 2400.000\n\
cache size\t: 4096 KB\n\
flags\t\t: fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush mmx fxsr sse sse2 syscall nx lm\n\n"
                    .to_vec(),
            ),
            "/proc/version" => {
                Some(b"Linux version 6.12.0 (elf2wasm@sandbox) (gcc 12.2.0) #1 SMP\n".to_vec())
            }
            _ => {
                let rest = norm_path.strip_prefix("/proc/")?;
                let (who, leaf) = rest.split_once('/')?;
                if !self.is_proc_self_prefix(who) {
                    return None;
                }
                let comm = self
                    .cmdline
                    .first()
                    .map(|s| s.as_str())
                    .filter(|s| !s.is_empty())
                    .or_else(|| {
                        if !self.elf_path.is_empty() {
                            Some(self.elf_path.as_str())
                        } else {
                            None
                        }
                    })
                    .unwrap_or("app")
                    .rsplit('/')
                    .next()
                    .unwrap_or("app");
                match leaf {
                    "cmdline" => {
                        let mut out = Vec::new();
                        if self.cmdline.is_empty() {
                            let s = if self.elf_path.is_empty() {
                                "app"
                            } else {
                                self.elf_path.as_str()
                            };
                            out.extend_from_slice(s.as_bytes());
                            out.push(0);
                        } else {
                            for arg in &self.cmdline {
                                out.extend_from_slice(arg.as_bytes());
                                out.push(0);
                            }
                        }
                        Some(out)
                    }
                    "stat" => Some(
                        format!(
                            "{} ({}) R {} {} {} 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 0 268435456 1024 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n",
                            self.current_pid, comm, self.current_ppid, self.current_pgid, self.current_pgid
                        )
                        .into_bytes(),
                    ),
                    "status" => Some(
                        format!(
                            "Name:\t{}\nState:\tR (running)\nTgid:\t{}\nPid:\t{}\nPPid:\t{}\nUid:\t{}\t{}\t{}\t{}\nGid:\t{}\t{}\t{}\t{}\nThreads:\t1\nVmSize:\t  262144 kB\nVmRSS:\t    4096 kB\n",
                            comm,
                            self.current_pid,
                            self.current_pid,
                            self.current_ppid,
                            self.uid,
                            self.uid,
                            self.uid,
                            self.uid,
                            self.gid,
                            self.gid,
                            self.gid,
                            self.gid
                        )
                        .into_bytes(),
                    ),
                    _ => None,
                }
            }
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

    pub fn resolve_path(
        &self,
        dirfd: i32,
        raw_path: &str,
        follow_final: bool,
    ) -> Result<String, i64> {
        if raw_path.is_empty() {
            return Err(-ENOENT);
        }
        let base: &str = if raw_path.starts_with('/') {
            "/"
        } else if dirfd == AT_FDCWD {
            &self.cwd
        } else if let Some(dir_file) = self.fds.get(&dirfd) {
            if !dir_file.is_dir {
                return Err(-ENOTDIR);
            }
            &dir_file.guest_path
        } else {
            return Err(-EBADF);
        };

        let has_trailing_slash = raw_path.len() > 1 && raw_path.ends_with('/');
        let eff_follow_final = follow_final || has_trailing_slash;

        let mut resolved_parts: Vec<String> = base
            .split('/')
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect();
        let mut queue: VecDeque<String> = raw_path
            .split('/')
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect();

        let mut hops = 0usize;
        while let Some(comp) = queue.pop_front() {
            if comp == "." {
                continue;
            }
            if comp == ".." {
                resolved_parts.pop();
                continue;
            }
            resolved_parts.push(comp);
            let is_last = queue.is_empty();
            if !is_last || eff_follow_final {
                let cur_path = format!("/{}", resolved_parts.join("/"));
                let sym_target = match self.overlay.get(&cur_path) {
                    Some(OverlayNode::Symlink { target, .. }) => Some(target.clone()),
                    _ => self.virtual_symlink_target(&cur_path),
                };
                if let Some(target) = sym_target {
                    hops += 1;
                    if hops > MAX_SYMLINK_HOPS {
                        return Err(-ELOOP);
                    }
                    resolved_parts.pop();
                    if target.starts_with('/') {
                        resolved_parts.clear();
                    }
                    for part in target.split('/').filter(|s| !s.is_empty()).rev() {
                        queue.push_front(part.to_string());
                    }
                    continue;
                }
            }
        }

        Ok(if resolved_parts.is_empty() {
            "/".to_string()
        } else {
            format!("/{}", resolved_parts.join("/"))
        })
    }

    fn find_so(&self, norm_path: &str) -> Option<(usize, &SoEntry)> {
        for (idx, so) in self.so_entries.iter().enumerate() {
            if so.guest_paths.iter().any(|gp| gp == norm_path) {
                return Some((idx, so));
            }
        }
        // Also match shared libraries whose registered guest path traverses
        // overlay symlinks (e.g. Debian usrmerge /lib -> usr/lib and soname
        // symlinks like libtinfo.so.6 -> libtinfo.so.6.4) to reach norm_path.
        for (idx, so) in self.so_entries.iter().enumerate() {
            if so
                .guest_paths
                .iter()
                .any(|gp| self.resolve_path(AT_FDCWD, gp, true).as_deref() == Ok(norm_path))
            {
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
        if self.parse_proc_fd(norm_path).is_some() {
            return false;
        }
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
        if norm_path == "/" || self.is_virtual_dir(norm_path) {
            return true;
        }
        let prefix_slash = format!("{}/", norm_path);
        for so in &self.so_entries {
            if so.guest_paths.iter().any(|gp| gp.starts_with(&prefix_slash)) {
                return true;
            }
        }
        if let Some((key, _)) = self
            .overlay
            .range::<str, _>((std::ops::Bound::Included(prefix_slash.as_str()), std::ops::Bound::Unbounded))
            .next()
        {
            if key.starts_with(&prefix_slash) {
                return true;
            }
        }
        self.host_fs.is_virtual_allowlist_parent(norm_path)
    }

    fn is_existing_dir(&self, norm_path: &str) -> bool {
        let check_path = match self.overlay.get(norm_path) {
            Some(OverlayNode::Dir { .. }) => return true,
            Some(OverlayNode::File { .. }) => return false,
            Some(OverlayNode::Symlink { .. }) => {
                let Ok(resolved) = self.resolve_path(AT_FDCWD, norm_path, true) else {
                    return false;
                };
                match self.overlay.get(&resolved) {
                    Some(OverlayNode::Dir { .. }) => return true,
                    Some(OverlayNode::File { .. }) | Some(OverlayNode::Symlink { .. }) => {
                        return false
                    }
                    None => resolved,
                }
            }
            None => norm_path.to_string(),
        };
        if let Some(st) = self.host_fs.stat_host_ro(&check_path) {
            return (st.st_mode & S_IFDIR) != 0;
        }
        self.is_virtual_parent_dir(&check_path)
    }

    fn missing_parent_errno(&self, parent: &str) -> i64 {
        if matches!(self.overlay.get(parent), Some(OverlayNode::Symlink { .. })) {
            return match self.resolve_path(AT_FDCWD, parent, true) {
                Ok(resolved) => {
                    if self.overlay.contains_key(&resolved)
                        || self.host_fs.stat_host_ro(&resolved).is_some()
                        || self.is_virtual_parent_dir(&resolved)
                    {
                        -ENOTDIR
                    } else {
                        -ENOENT
                    }
                }
                Err(e) => e,
            };
        }
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

        // 1. Overlay direct children (O(log N) range scan)
        for (path, node) in self.overlay.range::<str, _>((
            std::ops::Bound::Included(prefix_slash.as_str()),
            std::ops::Bound::Unbounded,
        )) {
            let Some(rest) = path.strip_prefix(&prefix_slash) else {
                break;
            };
            if !rest.is_empty() && !rest.contains('/') && !seen.contains(rest) {
                seen.insert(rest.to_string());
                let d_type = match node {
                    OverlayNode::Dir { .. } => DT_DIR,
                    OverlayNode::File { .. } => DT_REG,
                    OverlayNode::Symlink { .. } => DT_LNK,
                };
                entries.push(DirEntry {
                    d_ino: path_hash(path),
                    d_type,
                    name: rest.to_string(),
                });
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

        // 4. Virtual /dev and /proc entries
        let mut add_virtual_entry = |name: &str, d_type: u8| {
            if !seen.contains(name) {
                seen.insert(name.to_string());
                let child_guest = format!("{}{}", prefix_slash, name);
                entries.push(DirEntry {
                    d_ino: path_hash(&child_guest),
                    d_type,
                    name: name.to_string(),
                });
            }
        };

        if norm_path == "/" {
            add_virtual_entry("dev", DT_DIR);
            add_virtual_entry("proc", DT_DIR);
        } else if norm_path == "/dev" {
            for dev_name in ["null", "zero", "urandom", "random", "tty"] {
                add_virtual_entry(dev_name, DT_CHR);
            }
            for link_name in ["stdin", "stdout", "stderr", "fd"] {
                add_virtual_entry(link_name, DT_LNK);
            }
        } else if norm_path == "/proc" {
            add_virtual_entry("self", DT_LNK);
            let pid_str = self.current_pid.to_string();
            add_virtual_entry(&pid_str, DT_DIR);
            for f in ["uptime", "meminfo", "cpuinfo", "version"] {
                add_virtual_entry(f, DT_REG);
            }
        } else if let Some(rest) = norm_path.strip_prefix("/proc/") {
            if self.is_proc_self_prefix(rest) {
                add_virtual_entry("exe", DT_LNK);
                add_virtual_entry("fd", DT_DIR);
                for f in ["cmdline", "stat", "status"] {
                    add_virtual_entry(f, DT_REG);
                }
            } else if let Some(who) = rest.strip_suffix("/fd") {
                if self.is_proc_self_prefix(who) {
                    let fd_names: Vec<String> = self.fds.keys().map(|k| k.to_string()).collect();
                    for name in fd_names {
                        add_virtual_entry(&name, DT_LNK);
                    }
                }
            }
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
        if (flags & O_CREAT) != 0 && (flags & O_EXCL) != 0 {
            if let Ok(no_follow_path) = self.resolve_path(dirfd, raw_path, false) {
                if matches!(
                    self.overlay.get(&no_follow_path),
                    Some(OverlayNode::Symlink { .. })
                ) {
                    return -EEXIST;
                }
            }
        }
        let follow = (flags & O_NOFOLLOW) == 0;
        let norm_path = match self.resolve_path(dirfd, raw_path, follow) {
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

        // Virtual /proc/<self|pid>/fd/<N> (including /dev/stdin, /dev/stdout, /dev/stderr, /dev/fd/<N>)
        if let Some(target_fd) = self.parse_proc_fd(&norm_path) {
            if (flags & O_DIRECTORY) != 0 {
                let is_dir = self.fds.get(&target_fd).map_or(false, |f| f.is_dir);
                if !is_dir {
                    return -ENOTDIR;
                }
            }
            let Some(mut cloned) = self.fds.get(&target_fd).cloned() else {
                return -ENOENT;
            };
            cloned.cloexec = (flags & O_CLOEXEC) != 0;
            cloned.nonblock = (flags & O_NONBLOCK) != 0;
            let newfd = match self.alloc_fd() {
                Ok(fd) => fd,
                Err(e) => return e,
            };
            self.inc_pipe_ref(&cloned);
            self.fds.insert(newfd, cloned);
            return newfd as i64;
        }

        // Virtual /dev/* devices (checked before overlay so container tarballs with placeholder
        // /dev/null files still get real character device semantics)
        if let Some(dev_kind) = Self::virtual_dev_kind(&norm_path) {
            if (flags & O_DIRECTORY) != 0 {
                return -ENOTDIR;
            }
            if (flags & O_CREAT) != 0 && (flags & O_EXCL) != 0 {
                return -EEXIST;
            }
            let fd = match self.alloc_fd() {
                Ok(fd) => fd,
                Err(e) => return e,
            };
            let mut f = OpenFile::base(norm_path, Arc::new(Vec::new()));
            f.dev = Some(dev_kind);
            f.writable = acc == O_WRONLY || acc == O_RDWR;
            f.append = (flags & O_APPEND) != 0;
            f.cloexec = (flags & O_CLOEXEC) != 0;
            f.nonblock = (flags & O_NONBLOCK) != 0;
            self.fds.insert(fd, f);
            return fd as i64;
        }

        // Virtual /proc/* regular files
        if let Some(bytes) = self.virtual_proc_file(&norm_path) {
            if (flags & O_DIRECTORY) != 0 {
                return -ENOTDIR;
            }
            if (flags & O_CREAT) != 0 && (flags & O_EXCL) != 0 {
                return -EEXIST;
            }
            if wants_write {
                return -EACCES;
            }
            let fd = match self.alloc_fd() {
                Ok(fd) => fd,
                Err(e) => return e,
            };
            let mut f = OpenFile::base(norm_path, Arc::new(bytes));
            f.cloexec = (flags & O_CLOEXEC) != 0;
            f.nonblock = (flags & O_NONBLOCK) != 0;
            self.fds.insert(fd, f);
            return fd as i64;
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
            let mut f = OpenFile::base(norm_path, so_bytes);
            f.so_index = Some(idx);
            f.so_base_addr = Some(so_base);
            f.cloexec = (flags & O_CLOEXEC) != 0;
            f.nonblock = (flags & O_NONBLOCK) != 0;
            self.fds.insert(fd, f);
            return fd as i64;
        }

        // Check overlay first
        if let Some(node) = self.overlay.get(&norm_path).cloned() {
            match node {
                OverlayNode::Symlink { .. } => return -ELOOP,
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
                    let mut f = OpenFile::base(norm_path, Arc::new(Vec::new()));
                    f.is_dir = true;
                    f.cloexec = (flags & O_CLOEXEC) != 0;
                    f.nonblock = (flags & O_NONBLOCK) != 0;
                    f.dir_entries = dir_entries;
                    self.fds.insert(fd, f);
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
                    let mut f = OpenFile::base(norm_path, file_data);
                    f.writable = writable;
                    f.append = append;
                    f.cloexec = (flags & O_CLOEXEC) != 0;
                    f.nonblock = (flags & O_NONBLOCK) != 0;
                    self.fds.insert(fd, f);
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
                let mut f = OpenFile::base(norm_path, Arc::new(Vec::new()));
                f.is_dir = true;
                f.cloexec = (flags & O_CLOEXEC) != 0;
                f.nonblock = (flags & O_NONBLOCK) != 0;
                f.dir_entries = dir_entries;
                self.fds.insert(fd, f);
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
                    let mut f = OpenFile::base(norm_path, Arc::new(bytes));
                    f.cloexec = (flags & O_CLOEXEC) != 0;
                    f.nonblock = (flags & O_NONBLOCK) != 0;
                    self.fds.insert(fd, f);
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
            let mut f = OpenFile::base(norm_path, Arc::new(Vec::new()));
            f.is_dir = true;
            f.cloexec = (flags & O_CLOEXEC) != 0;
            f.nonblock = (flags & O_NONBLOCK) != 0;
            f.dir_entries = dir_entries;
            self.fds.insert(fd, f);
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
                    mode: (mode & !self.umask) & 0o7777,
                    mtime_ns: now_ns,
                },
            );
            let fd = match self.alloc_fd() {
                Ok(fd) => fd,
                Err(e) => return e,
            };
            let mut f = OpenFile::base(norm_path, empty);
            f.writable = acc == O_WRONLY || acc == O_RDWR;
            f.append = (flags & O_APPEND) != 0;
            f.cloexec = (flags & O_CLOEXEC) != 0;
            f.nonblock = (flags & O_NONBLOCK) != 0;
            self.fds.insert(fd, f);
            return fd as i64;
        }

        -ENOENT
    }

    pub fn close(&mut self, fd: i32) -> i64 {
        let (ret, _, _) = self.close_with_events(fd);
        ret
    }

    pub fn close_with_events(&mut self, fd: i32) -> (i64, Vec<u64>, Vec<u64>) {
        let Some(file) = self.fds.remove(&fd) else {
            return (-EBADF, Vec::new(), Vec::new());
        };
        let mut affected_pipes = Vec::new();
        let mut closed_listeners = Vec::new();
        self.dec_pipe_ref_collect(&file, &mut affected_pipes, &mut closed_listeners);
        (0, affected_pipes, closed_listeners)
    }

    fn inc_pipe_ref(&mut self, file: &OpenFile) {
        if let Some(sid) = file.tcp_socket_id {
            if let Some(sock) = self.tcp_sockets.get_mut(&sid) {
                sock.ref_count += 1;
            }
            return;
        }
        if let Some(wpid) = file.sock_write_pipe_id {
            // Bidirectional socketpair: pipe_id is read pipe, sock_write_pipe_id is write pipe.
            if let Some(rpid) = file.pipe_id {
                if let Some(p) = self.pipes.get_mut(&rpid) {
                    p.readers += 1;
                }
            }
            if let Some(p) = self.pipes.get_mut(&wpid) {
                p.writers += 1;
            }
            return;
        }
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

    fn dec_tcp_socket_ref(
        &mut self,
        sid: u64,
        affected_pipes: &mut Vec<u64>,
        closed_listeners: &mut Vec<u64>,
    ) {
        let should_remove = match self.tcp_sockets.get_mut(&sid) {
            Some(sock) => {
                sock.ref_count = sock.ref_count.saturating_sub(1);
                sock.ref_count == 0
            }
            None => false,
        };
        if !should_remove {
            return;
        }
        let Some(sock) = self.tcp_sockets.remove(&sid) else {
            return;
        };
        match sock.state {
            TcpSocketState::Unbound => {}
            TcpSocketState::Bound { local_port, .. } => {
                if self.tcp_bound_ports.get(&local_port) == Some(&sid) {
                    self.tcp_bound_ports.remove(&local_port);
                }
            }
            TcpSocketState::Listening {
                local_port,
                pending,
                ..
            } => {
                if self.tcp_bound_ports.get(&local_port) == Some(&sid) {
                    self.tcp_bound_ports.remove(&local_port);
                }
                if self.tcp_listeners.get(&local_port) == Some(&sid) {
                    self.tcp_listeners.remove(&local_port);
                }
                closed_listeners.push(sid);
                for child_sid in pending {
                    self.dec_tcp_socket_ref(child_sid, affected_pipes, closed_listeners);
                }
            }
            TcpSocketState::Connected {
                read_pipe_id,
                write_pipe_id,
                shut_rd,
                shut_wr,
                ..
            } => {
                if !shut_rd {
                    let mut remove = false;
                    if let Some(p) = self.pipes.get_mut(&read_pipe_id) {
                        p.readers = p.readers.saturating_sub(1);
                        if p.readers == 0 {
                            p.in_flight.clear();
                            p.in_flight_bytes = 0;
                        }
                        if p.readers == 0 && p.writers == 0 {
                            remove = true;
                        }
                    }
                    if remove {
                        self.pipes.remove(&read_pipe_id);
                    }
                    affected_pipes.push(read_pipe_id);
                }
                if !shut_wr {
                    let mut remove = false;
                    if let Some(p) = self.pipes.get_mut(&write_pipe_id) {
                        p.writers = p.writers.saturating_sub(1);
                        if p.readers == 0 && p.writers == 0 {
                            remove = true;
                        }
                    }
                    if remove {
                        self.pipes.remove(&write_pipe_id);
                    }
                    affected_pipes.push(write_pipe_id);
                }
            }
        }
    }

    fn dec_pipe_ref_collect(
        &mut self,
        file: &OpenFile,
        affected_pipes: &mut Vec<u64>,
        closed_listeners: &mut Vec<u64>,
    ) {
        if let Some(sid) = file.tcp_socket_id {
            self.dec_tcp_socket_ref(sid, affected_pipes, closed_listeners);
            return;
        }
        if let Some(wpid) = file.sock_write_pipe_id {
            if let Some(rpid) = file.pipe_id {
                let mut remove = false;
                if let Some(p) = self.pipes.get_mut(&rpid) {
                    p.readers = p.readers.saturating_sub(1);
                    if p.readers == 0 {
                        p.in_flight.clear();
                        p.in_flight_bytes = 0;
                    }
                    if p.readers == 0 && p.writers == 0 {
                        remove = true;
                    }
                }
                if remove {
                    self.pipes.remove(&rpid);
                }
                affected_pipes.push(rpid);
            }
            let mut remove = false;
            if let Some(p) = self.pipes.get_mut(&wpid) {
                p.writers = p.writers.saturating_sub(1);
                if p.readers == 0 && p.writers == 0 {
                    remove = true;
                }
            }
            if remove {
                self.pipes.remove(&wpid);
            }
            affected_pipes.push(wpid);
            return;
        }
        if let Some(pid) = file.pipe_id {
            let mut remove_pipe = false;
            if let Some(p) = self.pipes.get_mut(&pid) {
                if file.writable {
                    p.writers = p.writers.saturating_sub(1);
                } else {
                    p.readers = p.readers.saturating_sub(1);
                    if p.readers == 0 {
                        p.in_flight.clear();
                        p.in_flight_bytes = 0;
                    }
                }
                if p.readers == 0 && p.writers == 0 {
                    remove_pipe = true;
                }
            }
            if remove_pipe {
                self.pipes.remove(&pid);
            }
            affected_pipes.push(pid);
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
        let _ = self.close_cloexec_fds_with_events();
    }

    pub fn close_cloexec_fds_with_events(&mut self) -> (Vec<u64>, Vec<u64>) {
        let cloexec_fds: Vec<i32> = self
            .fds
            .iter()
            .filter_map(|(&fd, f)| if f.cloexec { Some(fd) } else { None })
            .collect();
        let mut affected_pipes = Vec::new();
        let mut closed_listeners = Vec::new();
        for fd in cloexec_fds {
            let (_, pipes, listeners) = self.close_with_events(fd);
            affected_pipes.extend(pipes);
            closed_listeners.extend(listeners);
        }
        (affected_pipes, closed_listeners)
    }

    pub fn close_all_fds(&mut self) {
        let _ = self.close_all_fds_with_events();
    }

    pub fn close_all_fds_with_events(&mut self) -> (Vec<u64>, Vec<u64>) {
        let all_fds: Vec<i32> = self.fds.keys().copied().collect();
        let mut affected_pipes = Vec::new();
        let mut closed_listeners = Vec::new();
        for fd in all_fds {
            let (_, pipes, listeners) = self.close_with_events(fd);
            affected_pipes.extend(pipes);
            closed_listeners.extend(listeners);
        }
        (affected_pipes, closed_listeners)
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
            && file.dev.is_none()
            && file.epoll_id.is_none()
            && file.eventfd_id.is_none()
            && file.sock_write_pipe_id.is_none()
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
    /// (except when reading directly from inherited host stdin or virtual devices).
    /// Returns `(bytes, already_consumed_from_host)`.
    pub fn read_no_advance(&mut self, fd: i32, count: usize) -> Result<(Vec<u8>, bool), i64> {
        let (is_std, dev, is_dir, eventfd_id, nonblock, epoll_id) = {
            let file = self.fds.get(&fd).ok_or(-EBADF)?;
            (
                file.is_std,
                file.dev,
                file.is_dir,
                file.eventfd_id,
                file.nonblock,
                file.epoll_id,
            )
        };
        if epoll_id.is_some() {
            return Err(-EINVAL);
        }
        if let Some(eid) = eventfd_id {
            if count < 8 {
                return Err(-EINVAL);
            }
            let Some(efd) = self.eventfds.get_mut(&eid) else {
                return Err(-EBADF);
            };
            if efd.counter == 0 {
                return Err(-EAGAIN);
            }
            let val = if efd.semaphore {
                efd.counter -= 1;
                1u64
            } else {
                let v = efd.counter;
                efd.counter = 0;
                v
            };
            let _ = nonblock;
            return Ok((val.to_le_bytes().to_vec(), true));
        }
        if let Some(d) = dev {
            return match d {
                VirtualDevice::Null => Ok((Vec::new(), true)),
                VirtualDevice::Zero => Ok((vec![0u8; count.min(64 * 1024)], true)),
                VirtualDevice::Random => {
                    let n = count.min(64 * 1024);
                    let mut out = vec![0u8; n];
                    let mut off = 0;
                    while off < n {
                        let r = self.next_rand_u64().to_le_bytes();
                        let take = (n - off).min(8);
                        out[off..off + take].copy_from_slice(&r[..take]);
                        off += take;
                    }
                    Ok((out, true))
                }
                VirtualDevice::Tty => {
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
                    Ok((out, false))
                }
            };
        }
        if let Some(std_fd) = is_std {
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
        if is_dir {
            return Err(-EISDIR);
        }
        let file = self.fds.get(&fd).ok_or(-EBADF)?;
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
            if file.is_std == Some(0) || file.dev == Some(VirtualDevice::Tty) {
                self.stdin_cursor = self.stdin_cursor.saturating_add(n);
            } else if file.is_std.is_none() && file.dev.is_none() {
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
        let Some((
            is_std,
            dev,
            eventfd_id,
            epoll_id,
            is_dir,
            is_pipe,
            writable,
            append,
            cursor,
            guest_path,
            unlinked,
        )) = self.fds.get(&fd).map(|f| {
            (
                f.is_std,
                f.dev,
                f.eventfd_id,
                f.epoll_id,
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

        if epoll_id.is_some() {
            return -EINVAL;
        }
        if let Some(eid) = eventfd_id {
            if explicit_offset.is_some() {
                return -ESPIPE;
            }
            if data.len() < 8 {
                return -EINVAL;
            }
            let val = u64::from_le_bytes(data[..8].try_into().unwrap());
            if val == u64::MAX {
                return -EINVAL;
            }
            let Some(efd) = self.eventfds.get_mut(&eid) else {
                return -EBADF;
            };
            if efd.counter > (u64::MAX - 1).saturating_sub(val) {
                return -EAGAIN;
            }
            efd.counter += val;
            return 8;
        }
        if let Some(d) = dev {
            if !writable {
                return -EBADF;
            }
            return match d {
                VirtualDevice::Null | VirtualDevice::Zero | VirtualDevice::Random => {
                    data.len() as i64
                }
                VirtualDevice::Tty => {
                    if explicit_offset.is_some() {
                        return -ESPIPE;
                    }
                    self.stdout.extend_from_slice(data);
                    data.len() as i64
                }
            };
        }
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
            if let Some(d) = file.dev {
                return match d {
                    VirtualDevice::Null | VirtualDevice::Zero | VirtualDevice::Random => 0,
                    VirtualDevice::Tty => -ESPIPE,
                };
            }
            if file.is_std.is_some()
                || file.is_pipe
                || file.sock_write_pipe_id.is_some()
                || file.epoll_id.is_some()
                || file.eventfd_id.is_some()
            {
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
        if file.dev.is_some() {
            return Ok(FileStat {
                st_ino: path_hash(&file.guest_path),
                st_mode: S_IFCHR | 0o666,
                st_nlink: 1,
                st_size: 0,
                mtime_ns: 0,
            });
        }
        if file.sock_write_pipe_id.is_some() || file.tcp_socket_id.is_some() {
            return Ok(FileStat {
                st_ino: path_hash(&file.guest_path),
                st_mode: S_IFSOCK | 0o777,
                st_nlink: 1,
                st_size: 0,
                mtime_ns: 0,
            });
        }
        if file.is_pipe {
            return Ok(FileStat {
                st_ino: path_hash(&file.guest_path),
                st_mode: S_IFIFO | 0o600,
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
        let follow = (flags & AT_SYMLINK_NOFOLLOW) == 0;
        let norm_path = self.resolve_path(dirfd, raw_path, follow)?;
        if DENY_PATHS.contains(&norm_path.as_str()) {
            return Err(-ENOENT);
        }
        if !follow {
            if let Some(target) = self.virtual_symlink_target(&norm_path) {
                return Ok(FileStat {
                    st_ino: path_hash(&norm_path),
                    st_mode: S_IFLNK | 0o777,
                    st_nlink: 1,
                    st_size: target.len() as i64,
                    mtime_ns: 0,
                });
            }
        }
        if let Some(target_fd) = self.parse_proc_fd(&norm_path) {
            let Some(file) = self.fds.get(&target_fd) else {
                return Err(-ENOENT);
            };
            if !follow {
                return Ok(FileStat {
                    st_ino: path_hash(&norm_path),
                    st_mode: S_IFLNK | 0o700,
                    st_nlink: 1,
                    st_size: file.guest_path.len() as i64,
                    mtime_ns: 0,
                });
            }
            return self.stat_fd(target_fd);
        }
        if Self::virtual_dev_kind(&norm_path).is_some() {
            return Ok(FileStat {
                st_ino: path_hash(&norm_path),
                st_mode: S_IFCHR | 0o666,
                st_nlink: 1,
                st_size: 0,
                mtime_ns: 0,
            });
        }
        if let Some(bytes) = self.virtual_proc_file(&norm_path) {
            return Ok(FileStat {
                st_ino: path_hash(&norm_path),
                st_mode: S_IFREG | 0o444,
                st_nlink: 1,
                st_size: bytes.len() as i64,
                mtime_ns: 0,
            });
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
                OverlayNode::Symlink { target, mtime_ns } => Ok(FileStat {
                    st_ino: path_hash(&norm_path),
                    st_mode: S_IFLNK | 0o777,
                    st_nlink: 1,
                    st_size: target.len() as i64,
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
        let norm_path = self.resolve_path(dirfd, raw_path, false)?;
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
        if let Some(target_fd) = self.parse_proc_fd(&norm_path) {
            let Some(file) = self.fds.get(&target_fd) else {
                return Err(-ENOENT);
            };
            return Ok(file.guest_path.as_bytes().to_vec());
        }
        if let Some(target) = self.virtual_symlink_target(&norm_path) {
            return Ok(target.into_bytes());
        }
        if let Some(OverlayNode::Symlink { target, .. }) = self.overlay.get(&norm_path) {
            return Ok(target.as_bytes().to_vec());
        }
        if self.stat_path(dirfd, raw_path, AT_SYMLINK_NOFOLLOW).is_ok() {
            return Err(-EINVAL);
        }
        Err(-ENOENT)
    }

    pub fn symlinkat(&mut self, target: &str, dirfd: i32, raw_linkpath: &str, now_ns: u64) -> i64 {
        if target.is_empty() {
            return -ENOENT;
        }
        if raw_linkpath.len() > 1 && raw_linkpath.ends_with('/') {
            return -ENOENT;
        }
        let norm_path = match self.resolve_path(dirfd, raw_linkpath, false) {
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
            || self.find_so(&norm_path).is_some()
        {
            return -EEXIST;
        }
        let parent = parent_guest_path(&norm_path);
        if !self.is_existing_dir(parent) {
            return self.missing_parent_errno(parent);
        }
        self.overlay.insert(
            norm_path,
            OverlayNode::Symlink {
                target: target.to_string(),
                mtime_ns: now_ns,
            },
        );
        0
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

    fn dup_into_with_events(
        &mut self,
        oldfd: i32,
        newfd: i32,
        cloexec: bool,
    ) -> (i64, Vec<u64>, Vec<u64>) {
        if newfd < 0 || newfd >= MAX_FDS {
            return (-EBADF, Vec::new(), Vec::new());
        }
        let Some(mut file) = self.fds.get(&oldfd).cloned() else {
            return (-EBADF, Vec::new(), Vec::new());
        };
        if oldfd == newfd {
            return (newfd as i64, Vec::new(), Vec::new());
        }
        let (affected_pipes, closed_listeners) = if self.fds.contains_key(&newfd) {
            let (_, pipes, listeners) = self.close_with_events(newfd);
            (pipes, listeners)
        } else {
            (Vec::new(), Vec::new())
        };
        file.cloexec = cloexec;
        self.inc_pipe_ref(&file);
        self.fds.insert(newfd, file);
        if newfd >= self.next_fd {
            self.next_fd = newfd + 1;
        }
        (newfd as i64, affected_pipes, closed_listeners)
    }

    pub fn dup2(&mut self, oldfd: i32, newfd: i32) -> i64 {
        self.dup2_with_events(oldfd, newfd).0
    }

    pub fn dup2_with_events(&mut self, oldfd: i32, newfd: i32) -> (i64, Vec<u64>, Vec<u64>) {
        self.dup_into_with_events(oldfd, newfd, false)
    }

    pub fn dup3(&mut self, oldfd: i32, newfd: i32, flags: i32) -> i64 {
        self.dup3_with_events(oldfd, newfd, flags).0
    }

    pub fn dup3_with_events(
        &mut self,
        oldfd: i32,
        newfd: i32,
        flags: i32,
    ) -> (i64, Vec<u64>, Vec<u64>) {
        if (flags & !O_CLOEXEC) != 0 || oldfd == newfd {
            return (-EINVAL, Vec::new(), Vec::new());
        }
        self.dup_into_with_events(oldfd, newfd, (flags & O_CLOEXEC) != 0)
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
        let mut rf = OpenFile::base(format!("pipe:[{}]", pipe_id), Arc::clone(&empty));
        rf.is_pipe = true;
        rf.pipe_id = Some(pipe_id);
        rf.cloexec = cloexec;
        rf.nonblock = nonblock;
        self.fds.insert(rfd, rf);
        let wfd = match self.alloc_fd() {
            Ok(fd) => fd,
            Err(e) => {
                self.fds.remove(&rfd);
                return Err(e);
            }
        };
        let mut wf = OpenFile::base(format!("pipe:[{}]", pipe_id), empty);
        wf.is_pipe = true;
        wf.pipe_id = Some(pipe_id);
        wf.writable = true;
        wf.cloexec = cloexec;
        wf.nonblock = nonblock;
        self.fds.insert(wfd, wf);
        self.pipes.insert(pipe_id, PipeBuffer::new());
        Ok((rfd, wfd))
    }

    pub fn create_socketpair(&mut self, cloexec: bool, nonblock: bool) -> Result<(i32, i32), i64> {
        let pipe_a = self.next_pipe_id;
        self.next_pipe_id += 1;
        let pipe_b = self.next_pipe_id;
        self.next_pipe_id += 1;

        let fd0 = self.alloc_fd()?;
        let empty = Arc::new(Vec::new());
        let mut f0 = OpenFile::base(format!("socket:[{}]", pipe_a), Arc::clone(&empty));
        f0.pipe_id = Some(pipe_b);
        f0.sock_write_pipe_id = Some(pipe_a);
        f0.writable = true;
        f0.cloexec = cloexec;
        f0.nonblock = nonblock;
        self.fds.insert(fd0, f0);

        let fd1 = match self.alloc_fd() {
            Ok(fd) => fd,
            Err(e) => {
                self.fds.remove(&fd0);
                return Err(e);
            }
        };
        let mut f1 = OpenFile::base(format!("socket:[{}]", pipe_b), empty);
        f1.pipe_id = Some(pipe_a);
        f1.sock_write_pipe_id = Some(pipe_b);
        f1.writable = true;
        f1.cloexec = cloexec;
        f1.nonblock = nonblock;
        self.fds.insert(fd1, f1);

        self.pipes.insert(pipe_a, PipeBuffer::new());
        self.pipes.insert(pipe_b, PipeBuffer::new());
        Ok((fd0, fd1))
    }

    pub fn alloc_ephemeral_port(&mut self) -> Result<u16, i64> {
        const EPHEMERAL_MIN: u16 = 32768;
        const EPHEMERAL_MAX: u16 = 60999;
        let span = (EPHEMERAL_MAX - EPHEMERAL_MIN + 1) as u32;
        for _ in 0..span {
            let port = self.next_ephemeral_port;
            self.next_ephemeral_port = if port >= EPHEMERAL_MAX {
                EPHEMERAL_MIN
            } else {
                port + 1
            };
            if !self.tcp_bound_ports.contains_key(&port) && !self.tcp_listeners.contains_key(&port)
            {
                return Ok(port);
            }
        }
        Err(-EADDRINUSE)
    }

    pub fn create_tcp_socket(&mut self, cloexec: bool, nonblock: bool) -> Result<i32, i64> {
        let sid = self.next_tcp_socket_id;
        self.next_tcp_socket_id += 1;
        let fd = self.alloc_fd()?;
        let mut f = OpenFile::base(format!("socket:[tcp:{}]", sid), Arc::new(Vec::new()));
        f.tcp_socket_id = Some(sid);
        f.writable = true;
        f.cloexec = cloexec;
        f.nonblock = nonblock;
        self.fds.insert(fd, f);
        self.tcp_sockets
            .insert(sid, TcpSocket::new(TcpSocketState::Unbound));
        Ok(fd)
    }

    pub fn alloc_fd_for_tcp_socket(
        &mut self,
        sid: u64,
        cloexec: bool,
        nonblock: bool,
    ) -> Result<i32, i64> {
        let fd = self.alloc_fd()?;
        let mut f = OpenFile::base(format!("socket:[tcp:{}]", sid), Arc::new(Vec::new()));
        f.tcp_socket_id = Some(sid);
        f.writable = true;
        f.cloexec = cloexec;
        f.nonblock = nonblock;
        self.fds.insert(fd, f);
        Ok(fd)
    }

    pub fn create_epoll(&mut self, cloexec: bool) -> Result<i32, i64> {
        let id = self.next_epoll_id;
        self.next_epoll_id += 1;
        let fd = self.alloc_fd()?;
        let mut f = OpenFile::base(format!("anon_inode:[eventpoll:{}]", id), Arc::new(Vec::new()));
        f.epoll_id = Some(id);
        f.cloexec = cloexec;
        self.fds.insert(fd, f);
        self.epolls.insert(id, EpollInstance::default());
        Ok(fd)
    }

    pub fn create_eventfd(
        &mut self,
        initval: u64,
        semaphore: bool,
        cloexec: bool,
        nonblock: bool,
    ) -> Result<i32, i64> {
        let id = self.next_eventfd_id;
        self.next_eventfd_id += 1;
        let fd = self.alloc_fd()?;
        let mut f = OpenFile::base(format!("anon_inode:[eventfd:{}]", id), Arc::new(Vec::new()));
        f.eventfd_id = Some(id);
        f.writable = true;
        f.cloexec = cloexec;
        f.nonblock = nonblock;
        self.fds.insert(fd, f);
        self.eventfds.insert(
            id,
            EventFdState {
                counter: initval,
                semaphore,
            },
        );
        Ok(fd)
    }

    pub fn linkat(
        &mut self,
        olddirfd: i32,
        oldpath: &str,
        newdirfd: i32,
        newpath: &str,
        flags: i32,
        now_ns: u64,
    ) -> i64 {
        let follow = (flags & AT_SYMLINK_FOLLOW) != 0;
        let old_norm = match self.resolve_path(olddirfd, oldpath, follow) {
            Ok(p) => p,
            Err(e) => return e,
        };
        let new_norm = match self.resolve_path(newdirfd, newpath, false) {
            Ok(p) => p,
            Err(e) => return e,
        };
        if self.is_read_only_path(&new_norm) {
            return -EACCES;
        }
        if self.overlay.contains_key(&new_norm)
            || self.host_fs.stat_host_ro(&new_norm).is_some()
            || self.is_virtual_parent_dir(&new_norm)
            || self.find_so(&new_norm).is_some()
        {
            return -EEXIST;
        }
        let parent = parent_guest_path(&new_norm);
        if !self.is_existing_dir(parent) {
            return self.missing_parent_errno(parent);
        }
        if let Some(node) = self.overlay.get(&old_norm).cloned() {
            match node {
                OverlayNode::Dir { .. } => return -EPERM,
                OverlayNode::File { .. } | OverlayNode::Symlink { .. } => {
                    self.overlay.insert(new_norm, node);
                    return 0;
                }
            }
        }
        if let Some(st) = self.host_fs.stat_host_ro(&old_norm) {
            if (st.st_mode & S_IFDIR) != 0 {
                return -EPERM;
            }
            if let Some(bytes) = self.host_fs.read_host_ro(&old_norm) {
                self.overlay.insert(
                    new_norm,
                    OverlayNode::File {
                        data: Arc::new(bytes),
                        mode: st.st_mode & 0o7777,
                        mtime_ns: now_ns,
                    },
                );
                return 0;
            }
        }
        if let Some((_, so)) = self.find_so(&old_norm) {
            let bytes = Arc::clone(&so.bytes);
            self.overlay.insert(
                new_norm,
                OverlayNode::File {
                    data: bytes,
                    mode: 0o755,
                    mtime_ns: now_ns,
                },
            );
            return 0;
        }
        -ENOENT
    }

    pub fn access(&self, dirfd: i32, raw_path: &str, mode: i32) -> i64 {
        if (mode & !7) != 0 {
            return -EINVAL;
        }
        let st = match self.stat_path(dirfd, raw_path, 0) {
            Ok(s) => s,
            Err(e) => return e,
        };
        if (mode & 1) != 0 && (st.st_mode & S_IFDIR) == 0 && (st.st_mode & 0o111) == 0 {
            return -EACCES;
        }
        if (mode & 2) != 0 {
            let norm_path = match self.resolve_path(dirfd, raw_path, true) {
                Ok(p) => p,
                Err(e) => return e,
            };
            if self.is_read_only_path(&norm_path) {
                return -EACCES;
            }
        }
        0
    }

    pub fn mkdirat(&mut self, dirfd: i32, raw_path: &str, mode: u32, now_ns: u64) -> i64 {
        let norm_path = match self.resolve_path(dirfd, raw_path, false) {
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
                mode: (mode & !self.umask) & 0o7777,
                mtime_ns: now_ns,
            },
        );
        0
    }

    pub fn unlinkat(&mut self, dirfd: i32, raw_path: &str, flags: i32) -> i64 {
        let norm_path = match self.resolve_path(dirfd, raw_path, false) {
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
                if self
                    .overlay
                    .range::<str, _>((
                        std::ops::Bound::Included(prefix.as_str()),
                        std::ops::Bound::Unbounded,
                    ))
                    .next()
                    .is_some_and(|(k, _)| k.starts_with(&prefix))
                {
                    return -ENOTEMPTY;
                }
            }
            Some(OverlayNode::File { .. }) | Some(OverlayNode::Symlink { .. }) => {
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
        let old_norm = match self.resolve_path(olddirfd, oldpath, false) {
            Ok(p) => p,
            Err(e) => return e,
        };
        let new_norm = match self.resolve_path(newdirfd, newpath, false) {
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
                (
                    OverlayNode::Dir { .. },
                    OverlayNode::File { .. } | OverlayNode::Symlink { .. },
                ) => return -ENOTDIR,
                (
                    OverlayNode::File { .. } | OverlayNode::Symlink { .. },
                    OverlayNode::Dir { .. },
                ) => return -EISDIR,
                (OverlayNode::Dir { .. }, OverlayNode::Dir { .. }) => {
                    let new_prefix = format!("{}/", new_norm);
                    if self
                        .overlay
                        .range::<str, _>((
                            std::ops::Bound::Included(new_prefix.as_str()),
                            std::ops::Bound::Unbounded,
                        ))
                        .next()
                        .is_some_and(|(k, _)| k.starts_with(&new_prefix))
                    {
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
        let norm_path = match self.resolve_path(AT_FDCWD, raw_path, true) {
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
            Some(OverlayNode::Symlink { .. }) => -ELOOP,
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
        let Ok(length_u32) = u32::try_from(length) else {
            return -EINVAL;
        };
        let Ok(length_usize) = usize::try_from(length_u32) else {
            return -EINVAL;
        };
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
                Arc::make_mut(&mut f.data).resize(length_usize, 0);
            }
            return 0;
        }
        let Some(OverlayNode::File {
            data, mtime_ns, ..
        }) = self.overlay.get_mut(&guest_path)
        else {
            return -EINVAL;
        };
        Arc::make_mut(data).resize(length_usize, 0);
        *mtime_ns = now_ns;
        let updated = Arc::clone(data);
        if let Some(f) = self.fds.get_mut(&fd) {
            f.data = updated;
        }
        0
    }

    pub fn fallocate(&mut self, fd: i32, mode: i32, offset: i64, len: i64, now_ns: u64) -> i64 {
        if offset < 0 || len <= 0 {
            return -EINVAL;
        }
        const FALLOC_FL_KEEP_SIZE: i32 = 1;
        if mode != 0 && mode != FALLOC_FL_KEEP_SIZE {
            return -EOPNOTSUPP;
        }
        let Some((is_pipe, is_non_regular, writable, cur_len)) = self.fds.get(&fd).map(|f| {
            let cur_len = if !f.unlinked {
                match self.overlay.get(&f.guest_path) {
                    Some(OverlayNode::File { data, .. }) => data.len(),
                    _ => f.data.len(),
                }
            } else {
                f.data.len()
            };
            let is_non_regular = f.is_std.is_some()
                || f.is_dir
                || f.tcp_socket_id.is_some()
                || f.sock_write_pipe_id.is_some()
                || f.epoll_id.is_some()
                || f.eventfd_id.is_some();
            (f.is_pipe, is_non_regular, f.writable, cur_len)
        }) else {
            return -EBADF;
        };
        if is_pipe {
            return -ESPIPE;
        }
        if is_non_regular {
            return -ENODEV;
        }
        if !writable {
            return -EBADF;
        }
        let Some(new_end) = offset.checked_add(len) else {
            return -EINVAL;
        };
        let Ok(new_end_u32) = u32::try_from(new_end) else {
            return -EINVAL;
        };
        let Ok(new_end_usize) = usize::try_from(new_end_u32) else {
            return -EINVAL;
        };
        if mode == FALLOC_FL_KEEP_SIZE {
            return 0;
        }
        if new_end_usize > cur_len {
            self.ftruncate(fd, new_end, now_ns)
        } else {
            0
        }
    }

    pub fn write_overlay_range(
        &mut self,
        guest_path: &str,
        offset: usize,
        bytes: &[u8],
        now_ns: u64,
    ) {
        if bytes.is_empty() {
            return;
        }
        if let Some(OverlayNode::File {
            data, mtime_ns, ..
        }) = self.overlay.get_mut(guest_path)
        {
            let file_len = data.len();
            if offset >= file_len {
                return;
            }
            let copy_len = (file_len - offset).min(bytes.len());
            if copy_len == 0 {
                return;
            }
            let vec = Arc::make_mut(data);
            vec[offset..offset + copy_len].copy_from_slice(&bytes[..copy_len]);
            *mtime_ns = now_ns;
            let updated = Arc::clone(data);
            for f in self.fds.values_mut() {
                if !f.unlinked && f.guest_path == guest_path {
                    f.data = Arc::clone(&updated);
                }
            }
        }
    }

    pub fn read_latest_fd_data(&self, fd: i32) -> Option<Arc<Vec<u8>>> {
        let f = self.fds.get(&fd)?;
        if !f.unlinked {
            if let Some(OverlayNode::File { data, .. }) = self.overlay.get(&f.guest_path) {
                return Some(Arc::clone(data));
            }
        }
        Some(Arc::clone(&f.data))
    }

    pub fn chmod_at(&mut self, dirfd: i32, raw_path: &str, mode: u32) -> i64 {
        let norm_path = match self.resolve_path(dirfd, raw_path, true) {
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
            Some(OverlayNode::Symlink { .. }) => -ELOOP,
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
            Some(OverlayNode::Symlink { .. }) => -ELOOP,
            None => -EACCES,
        }
    }

    pub fn utimensat(&mut self, dirfd: i32, raw_path: Option<&str>, now_ns: u64) -> i64 {
        let norm_path = match raw_path {
            Some(p) => match self.resolve_path(dirfd, p, true) {
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
            Some(OverlayNode::Symlink { .. }) => -ELOOP,
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
        let norm_path = match self.resolve_path(AT_FDCWD, raw_path, true) {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn new_test_vfs() -> VirtualFs {
        VirtualFs::new_in_memory(&[])
    }

    #[test]
    fn test_symlink_relative_and_absolute() {
        let mut vfs = new_test_vfs();
        vfs.vfs_write_file("/usr/bin/python3.11", b"ELF_PY", 0o755);
        vfs.vfs_add_symlink("/usr/bin/python3", "python3.11");
        vfs.vfs_add_symlink("/bin/py", "/usr/bin/python3");

        assert_eq!(vfs.vfs_read_file("/usr/bin/python3").unwrap(), b"ELF_PY");
        assert_eq!(vfs.vfs_read_file("/bin/py").unwrap(), b"ELF_PY");
        assert_eq!(
            vfs.readlink(AT_FDCWD, "/usr/bin/python3").unwrap(),
            b"python3.11"
        );
        assert_eq!(
            vfs.readlink(AT_FDCWD, "/bin/py").unwrap(),
            b"/usr/bin/python3"
        );
    }

    #[test]
    fn test_symlink_parent_dir_traversal() {
        let mut vfs = new_test_vfs();
        vfs.vfs_write_file("/usr/lib/x86_64-linux-gnu/libc.so.6", b"LIBC", 0o755);
        vfs.vfs_add_symlink("/lib64", "/usr/lib/x86_64-linux-gnu");

        assert_eq!(
            vfs.vfs_read_file("/lib64/libc.so.6").unwrap(),
            b"LIBC"
        );
        let fd = vfs.openat(AT_FDCWD, "/lib64/libc.so.6", O_RDONLY);
        assert!(fd >= 3);
        vfs.close(fd as i32);
    }

    #[test]
    fn test_symlink_lstat_vs_stat_and_nofollow() {
        let mut vfs = new_test_vfs();
        vfs.vfs_write_file("/tmp/target.txt", b"hello", 0o644);
        vfs.vfs_add_symlink("/tmp/link.txt", "target.txt");

        let lst = vfs
            .stat_path(AT_FDCWD, "/tmp/link.txt", AT_SYMLINK_NOFOLLOW)
            .unwrap();
        assert_eq!(lst.st_mode & S_IFLNK, S_IFLNK);
        assert_eq!(lst.st_size, "target.txt".len() as i64);

        let st = vfs.stat_path(AT_FDCWD, "/tmp/link.txt", 0).unwrap();
        assert_eq!(st.st_mode & S_IFREG, S_IFREG);
        assert_eq!(st.st_size, 5);

        let err = vfs.openat(AT_FDCWD, "/tmp/link.txt", O_RDONLY | O_NOFOLLOW);
        assert_eq!(err, -ELOOP);
    }

    #[test]
    fn test_symlink_eloop() {
        let mut vfs = new_test_vfs();
        vfs.vfs_add_symlink("/tmp/a", "b");
        vfs.vfs_add_symlink("/tmp/b", "a");

        assert_eq!(
            vfs.resolve_path(AT_FDCWD, "/tmp/a", true),
            Err(-ELOOP)
        );
        assert_eq!(vfs.openat(AT_FDCWD, "/tmp/a", O_RDONLY), -ELOOP);
    }

    #[test]
    fn test_symlinkat_and_unlinkat() {
        let mut vfs = new_test_vfs();
        vfs.vfs_write_file("/tmp/orig", b"data", 0o644);
        assert_eq!(vfs.symlinkat("orig", AT_FDCWD, "/tmp/sym", 123), 0);
        assert_eq!(vfs.symlinkat("orig", AT_FDCWD, "/tmp/sym", 123), -EEXIST);
        assert_eq!(vfs.vfs_read_file("/tmp/sym").unwrap(), b"data");

        // unlinkat with AT_REMOVEDIR on symlink fails with ENOTDIR
        assert_eq!(vfs.unlinkat(AT_FDCWD, "/tmp/sym", AT_REMOVEDIR), -ENOTDIR);
        // unlinkat without AT_REMOVEDIR removes the symlink, not target
        assert_eq!(vfs.unlinkat(AT_FDCWD, "/tmp/sym", 0), 0);
        assert!(vfs.readlink(AT_FDCWD, "/tmp/sym").is_err());
        assert_eq!(vfs.vfs_read_file("/tmp/orig").unwrap(), b"data");
    }

    #[test]
    fn test_vfs_sandbox_denials_and_embedded_so() {
        let so = MetaSoFile {
            guest_paths: vec!["/lib/x86_64-linux-gnu/libtest.so.1".to_string()],
            base_addr: 0x0200_0000,
            bytes: b"\x7fELFtest_so_payload".to_vec(),
        };
        let mut vfs = VirtualFs::new_in_memory(&[so]);

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
    fn test_vfs_stdin_and_dup0() {
        let mut vfs = VirtualFs::new_in_memory(&[]);
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

    #[cfg(feature = "std-fs")]
    use std::fs;

    #[cfg(feature = "std-fs")]
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

    #[cfg(feature = "std-fs")]
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

    #[test]
    fn test_vfs_write_file_and_add_symlink_resolve_parent_symlinks() {
        let mut vfs = VirtualFs::new_in_memory(&[]);
        vfs.vfs_add_symlink("/lib64", "/usr/lib64");
        vfs.vfs_write_file("/lib64/sub/hello.txt", b"world", 0o644);
        assert_eq!(
            vfs.vfs_read_file("/usr/lib64/sub/hello.txt").unwrap(),
            b"world"
        );
        assert_eq!(
            vfs.vfs_read_file("/lib64/sub/hello.txt").unwrap(),
            b"world"
        );

        vfs.vfs_add_symlink("/lib64/sub/link.txt", "hello.txt");
        assert_eq!(
            vfs.readlink(AT_FDCWD, "/usr/lib64/sub/link.txt").unwrap(),
            b"hello.txt"
        );
        assert_eq!(
            vfs.vfs_read_file("/usr/lib64/sub/link.txt").unwrap(),
            b"world"
        );
    }

    #[test]
    fn test_access_nonexistent_so_returns_enoent_for_w_ok() {
        let vfs = VirtualFs::new_in_memory(&[]);
        assert_eq!(vfs.access(AT_FDCWD, "/nonexistent.so", 2), -ENOENT);
        assert_eq!(vfs.access(AT_FDCWD, "/nonexistent.so", 0), -ENOENT);
    }

    #[test]
    fn test_find_so_resolves_usrmerge_and_soname_symlinks() {
        let so = MetaSoFile {
            guest_paths: vec!["/lib/x86_64-linux-gnu/libtinfo.so.6".to_string()],
            base_addr: 0x0300_0000,
            bytes: b"\x7fELF_libtinfo".to_vec(),
        };
        let mut vfs = VirtualFs::new_in_memory(&[so]);
        // Simulate Debian usrmerge (/lib -> usr/lib) + soname symlink (libtinfo.so.6 -> libtinfo.so.6.4)
        vfs.vfs_add_symlink("/lib", "usr/lib");
        vfs.vfs_write_file(
            "/usr/lib/x86_64-linux-gnu/libtinfo.so.6.4",
            b"\x7fELF_libtinfo",
            0o644,
        );
        vfs.vfs_add_symlink(
            "/usr/lib/x86_64-linux-gnu/libtinfo.so.6",
            "libtinfo.so.6.4",
        );

        let fd1 = vfs.openat(AT_FDCWD, "/lib/x86_64-linux-gnu/libtinfo.so.6", O_RDONLY);
        assert!(fd1 >= 3, "expected valid fd, got {}", fd1);
        assert_eq!(vfs.get_fd(fd1 as i32).unwrap().so_base_addr, Some(0x0300_0000));

        let fd2 = vfs.openat(AT_FDCWD, "/usr/lib/x86_64-linux-gnu/libtinfo.so.6.4", O_RDONLY);
        assert!(fd2 >= 3, "expected valid fd, got {}", fd2);
        assert_eq!(vfs.get_fd(fd2 as i32).unwrap().so_base_addr, Some(0x0300_0000));
    }

    fn verify_tar_headers(tar: &[u8]) {
        assert_eq!(tar.len() % 512, 0, "tar must be 512-byte aligned");
        assert!(tar.len() >= 1024, "tar must include 1024-byte trailer");
        assert!(
            tar[tar.len() - 1024..].iter().all(|&b| b == 0),
            "tar must end with 1024 zero bytes"
        );
        let mut off = 0;
        while off + 512 <= tar.len() {
            let hdr = &tar[off..off + 512];
            if hdr.iter().all(|&b| b == 0) {
                off += 512;
                continue;
            }
            assert_eq!(&hdr[257..263], b"ustar\0");
            assert_eq!(&hdr[263..265], b"00");
            let stored_cksum = parse_tar_num(&hdr[148..156]).unwrap() as u32;
            let mut calc: u32 = 0;
            for (i, &b) in hdr.iter().enumerate() {
                calc += if (148..156).contains(&i) {
                    b' ' as u32
                } else {
                    b as u32
                };
            }
            assert_eq!(stored_cksum, calc, "tar header checksum mismatch at offset {}", off);
            let size = parse_tar_num(&hdr[124..136]).unwrap() as usize;
            off += 512 + size.div_ceil(512) * 512;
        }
    }

    #[test]
    fn test_vfs_diff_and_export_tar_basic() {
        let mut vfs = VirtualFs::new_in_memory(&[]);
        vfs.vfs_write_file("/workspace/keep.txt", b"unchanged", 0o644);
        vfs.vfs_write_file("/workspace/mod.txt", b"v1", 0o644);
        vfs.vfs_write_file("/workspace/chmod_me.txt", b"same-data", 0o644);
        vfs.vfs_write_file("/workspace/delete_me.txt", b"bye", 0o644);

        let snap = vfs.snapshot_vfs();
        assert!(vfs.has_snapshot(snap));
        assert!(!vfs.has_snapshot(0));
        assert!(!vfs.has_snapshot(snap + 99));

        // Mutate: modify file, chmod file, add dir + file + symlink, delete file.
        vfs.vfs_write_file("/workspace/mod.txt", b"v2-updated", 0o644);
        assert_eq!(vfs.chmod_at(AT_FDCWD, "/workspace/chmod_me.txt", 0o755), 0);
        vfs.vfs_add_dir("/workspace/sub", 0o750);
        vfs.vfs_write_file("/workspace/sub/new.txt", b"hello", 0o600);
        vfs.vfs_add_symlink("/workspace/link.txt", "sub/new.txt");
        assert!(vfs.vfs_remove_path("/workspace/delete_me.txt"));

        let diff = vfs.list_diff(Some(snap), None);
        assert!(!diff.iter().any(|e| e.path == "/workspace/keep.txt"));
        assert_eq!(
            diff.iter().find(|e| e.path == "/workspace/mod.txt"),
            Some(&VfsDiffEntry {
                path: "/workspace/mod.txt".to_string(),
                kind: VfsDiffKind::File,
                size: 10,
            })
        );
        assert_eq!(
            diff.iter().find(|e| e.path == "/workspace/chmod_me.txt"),
            Some(&VfsDiffEntry {
                path: "/workspace/chmod_me.txt".to_string(),
                kind: VfsDiffKind::File,
                size: 9,
            })
        );
        assert_eq!(
            diff.iter().find(|e| e.path == "/workspace/sub"),
            Some(&VfsDiffEntry {
                path: "/workspace/sub".to_string(),
                kind: VfsDiffKind::Dir,
                size: 0,
            })
        );
        assert_eq!(
            diff.iter().find(|e| e.path == "/workspace/link.txt"),
            Some(&VfsDiffEntry {
                path: "/workspace/link.txt".to_string(),
                kind: VfsDiffKind::Symlink,
                size: "sub/new.txt".len() as u64,
            })
        );
        assert_eq!(
            diff.iter().find(|e| e.path == "/workspace/delete_me.txt"),
            Some(&VfsDiffEntry {
                path: "/workspace/delete_me.txt".to_string(),
                kind: VfsDiffKind::Deleted,
                size: 0,
            })
        );

        let tar = vfs.export_tar(Some(snap), None);
        verify_tar_headers(&tar);

        // Round-trip: restore base snapshot and extract exported diff tar.
        assert_eq!(vfs.restore_vfs(snap), 0);
        assert!(vfs.vfs_read_file("/workspace/delete_me.txt").is_some());
        assert_eq!(vfs.vfs_read_file("/workspace/mod.txt").unwrap(), b"v1");

        let count = vfs.extract_tar(&tar, "/", 0, false).unwrap();
        assert!(count >= 6);
        assert_eq!(vfs.vfs_read_file("/workspace/keep.txt").unwrap(), b"unchanged");
        assert_eq!(vfs.vfs_read_file("/workspace/mod.txt").unwrap(), b"v2-updated");
        assert_eq!(vfs.vfs_read_file("/workspace/sub/new.txt").unwrap(), b"hello");
        assert_eq!(
            vfs.readlink(AT_FDCWD, "/workspace/link.txt").unwrap(),
            b"sub/new.txt"
        );
        assert!(vfs.vfs_read_file("/workspace/delete_me.txt").is_none());
        let st = vfs.stat_path(AT_FDCWD, "/workspace/chmod_me.txt", 0).unwrap();
        assert_eq!(st.st_mode & 0o777, 0o755);
    }

    #[test]
    fn test_vfs_diff_deleted_dir_prunes_descendants_and_hyphen_sibling() {
        let mut vfs = VirtualFs::new_in_memory(&[]);
        vfs.vfs_write_file("/tmp/dir/a.txt", b"a", 0o644);
        vfs.vfs_write_file("/tmp/dir/sub/b.txt", b"b", 0o644);
        vfs.vfs_write_file("/tmp/dir-other/keep.txt", b"k", 0o644);

        let snap = vfs.snapshot_vfs();
        assert!(vfs.vfs_remove_path("/tmp/dir"));
        assert!(vfs.vfs_remove_path("/tmp/dir-other/keep.txt"));

        let diff = vfs.list_diff(Some(snap), None);
        let paths: Vec<&str> = diff.iter().map(|e| e.path.as_str()).collect();
        assert!(paths.contains(&"/tmp/dir"));
        assert!(!paths.contains(&"/tmp/dir/a.txt"));
        assert!(!paths.contains(&"/tmp/dir/sub/b.txt"));
        assert!(paths.contains(&"/tmp/dir-other/keep.txt"));

        let tar = vfs.export_tar(Some(snap), None);
        verify_tar_headers(&tar);
        assert_eq!(vfs.restore_vfs(snap), 0);
        vfs.extract_tar(&tar, "/", 0, false).unwrap();
        assert!(vfs.vfs_read_file("/tmp/dir/a.txt").is_none());
        assert!(vfs.vfs_read_file("/tmp/dir/sub/b.txt").is_none());
        assert!(vfs.vfs_read_file("/tmp/dir-other/keep.txt").is_none());
    }

    #[test]
    fn test_vfs_diff_path_prefix_filtering() {
        let mut vfs = VirtualFs::new_in_memory(&[]);
        let snap = vfs.snapshot_vfs();
        vfs.vfs_write_file("/workspace/a.txt", b"a", 0o644);
        vfs.vfs_write_file("/workspace-extra/b.txt", b"b", 0o644);
        vfs.vfs_write_file("/tmp/c.txt", b"c", 0o644);

        let diff = vfs.list_diff(Some(snap), Some("/workspace"));
        assert!(diff.iter().any(|e| e.path == "/workspace/a.txt"));
        assert!(!diff.iter().any(|e| e.path.starts_with("/workspace-extra")));
        assert!(!diff.iter().any(|e| e.path.starts_with("/tmp")));
    }

    #[test]
    fn test_vfs_export_tar_pax_long_paths_and_symlinks() {
        let mut vfs = VirtualFs::new_in_memory(&[]);
        let long_path = format!(
            "/workspace/{}/deep_file.txt",
            "a_very_long_directory_segment_1234567890".repeat(4)
        );
        let long_target = format!(
            "../{}/target.txt",
            "long_symlink_target_component_0987654321".repeat(4)
        );
        assert!(long_path.len() > 120);
        assert!(long_target.len() > 120);

        vfs.vfs_write_file(&long_path, b"pax-content", 0o644);
        vfs.vfs_add_symlink("/workspace/long_link", &long_target);

        let tar = vfs.export_tar(None, Some("/workspace"));
        verify_tar_headers(&tar);

        // Verify round-trip preserves exact > 120-byte path and symlink target.
        let mut vfs2 = VirtualFs::new_in_memory(&[]);
        vfs2.extract_tar(&tar, "/", 0, false).unwrap();
        assert_eq!(vfs2.vfs_read_file(&long_path).unwrap(), b"pax-content");
        assert_eq!(
            vfs2.readlink(AT_FDCWD, "/workspace/long_link").unwrap(),
            long_target.as_bytes()
        );
    }

    #[test]
    fn test_vfs_diff_dir_replaced_by_file_and_json_escaping() {
        let mut vfs = VirtualFs::new_in_memory(&[]);
        vfs.vfs_write_file("/tmp/x/child.txt", b"old", 0o644);
        let snap = vfs.snapshot_vfs();

        // Replace directory /tmp/x with a regular file /tmp/x.
        assert!(vfs.vfs_remove_path("/tmp/x"));
        vfs.vfs_write_file("/tmp/x", b"now-a-file", 0o644);

        let diff = vfs.list_diff(Some(snap), None);
        // /tmp/x is reported as File; /tmp/x/child.txt is pruned because /tmp/x was replaced.
        assert_eq!(
            diff,
            vec![VfsDiffEntry {
                path: "/tmp/x".to_string(),
                kind: VfsDiffKind::File,
                size: 10,
            }]
        );

        let tar = vfs.export_tar(Some(snap), None);
        verify_tar_headers(&tar);
        assert_eq!(vfs.restore_vfs(snap), 0);
        vfs.extract_tar(&tar, "/", 0, false).unwrap();
        assert_eq!(vfs.vfs_read_file("/tmp/x").unwrap(), b"now-a-file");
        assert!(vfs.vfs_read_file("/tmp/x/child.txt").is_none());

        // JSON escaping check.
        let json_bytes = encode_vfs_diff_json(&[VfsDiffEntry {
            path: "/tmp/a\"b\\c\n\t\x01".to_string(),
            kind: VfsDiffKind::File,
            size: 42,
        }]);
        let json = String::from_utf8(json_bytes).unwrap();
        assert_eq!(
            json,
            r#"[{"path":"/tmp/a\"b\\c\n\t\u0001","kind":"file","size":42}]"#
        );
    }

    #[test]
    fn test_vfs_export_tar_empty_diff_and_full_export() {
        let mut vfs = VirtualFs::new_in_memory(&[]);
        vfs.vfs_write_file("/workspace/one.txt", b"1", 0o644);
        let snap = vfs.snapshot_vfs();

        assert!(vfs.list_diff(Some(snap), None).is_empty());
        let empty_tar = vfs.export_tar(Some(snap), None);
        assert_eq!(empty_tar.len(), 1024);
        assert!(empty_tar.iter().all(|&b| b == 0));

        let full = vfs.list_diff(None, None);
        assert!(!full.iter().any(|e| e.path == "/"));
        assert!(full.iter().any(|e| e.path == "/workspace/one.txt"));
    }
}

fn utf8_truncate(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

fn push_pax_record(out: &mut Vec<u8>, key: &str, value: &str) {
    // Format: "<len> <key>=<value>\n" where <len> includes itself.
    let tail_len = 1 + key.len() + 1 + value.len() + 1;
    let mut digits = 1usize;
    loop {
        let total = digits + tail_len;
        let actual_digits = total.to_string().len();
        if actual_digits == digits {
            out.extend_from_slice(total.to_string().as_bytes());
            out.push(b' ');
            out.extend_from_slice(key.as_bytes());
            out.push(b'=');
            out.extend_from_slice(value.as_bytes());
            out.push(b'\n');
            break;
        }
        digits = actual_digits;
    }
}

fn write_ustar_header(
    out: &mut Vec<u8>,
    name: &str,
    typeflag: u8,
    mode: u32,
    size: u64,
    mtime_sec: u64,
    linkname: &str,
) {
    let mut hdr = [0u8; 512];
    let name_bytes = utf8_truncate(name, 100).as_bytes();
    hdr[..name_bytes.len()].copy_from_slice(name_bytes);

    let mode_str = format!("{:07o}\0", mode & 0o7777);
    hdr[100..108].copy_from_slice(mode_str.as_bytes());
    hdr[108..116].copy_from_slice(b"0000000\0");
    hdr[116..124].copy_from_slice(b"0000000\0");

    let size_str = format!("{:011o}\0", size.min(0o77777777777));
    hdr[124..136].copy_from_slice(size_str.as_bytes());

    let mtime_str = format!("{:011o}\0", mtime_sec.min(0o77777777777));
    hdr[136..148].copy_from_slice(mtime_str.as_bytes());

    hdr[148..156].fill(b' ');
    hdr[156] = typeflag;

    let link_bytes = utf8_truncate(linkname, 100).as_bytes();
    hdr[157..157 + link_bytes.len()].copy_from_slice(link_bytes);

    hdr[257..263].copy_from_slice(b"ustar\0");
    hdr[263..265].copy_from_slice(b"00");
    hdr[265..269].copy_from_slice(b"root");
    hdr[297..301].copy_from_slice(b"root");
    hdr[329..337].copy_from_slice(b"0000000\0");
    hdr[337..345].copy_from_slice(b"0000000\0");

    let sum: u32 = hdr.iter().map(|&b| b as u32).sum();
    let cksum_str = format!("{:06o}\0 ", sum);
    hdr[148..156].copy_from_slice(cksum_str.as_bytes());

    out.extend_from_slice(&hdr);
}

fn write_tar_entry(
    out: &mut Vec<u8>,
    tar_path: &str,
    typeflag: u8,
    mode: u32,
    mtime_sec: u64,
    linkname: &str,
    data: &[u8],
) {
    let size = data.len() as u64;
    let needs_pax = tar_path.len() > 100 || linkname.len() > 100 || size >= 0o100000000000;
    if needs_pax {
        let mut pax = Vec::new();
        if tar_path.len() > 100 {
            push_pax_record(&mut pax, "path", tar_path);
        }
        if linkname.len() > 100 {
            push_pax_record(&mut pax, "linkpath", linkname);
        }
        if size >= 0o100000000000 {
            push_pax_record(&mut pax, "size", &size.to_string());
        }
        let base = tar_path.rsplit('/').find(|s| !s.is_empty()).unwrap_or("entry");
        let pax_name = format!("PaxHeaders.0/{}", utf8_truncate(base, 87));
        write_ustar_header(out, &pax_name, b'x', 0o644, pax.len() as u64, 0, "");
        out.extend_from_slice(&pax);
        let pad = (512 - (pax.len() % 512)) % 512;
        out.resize(out.len() + pad, 0);
    }

    write_ustar_header(out, tar_path, typeflag, mode, size, mtime_sec, linkname);
    if !data.is_empty() {
        out.extend_from_slice(data);
        let pad = (512 - (data.len() % 512)) % 512;
        out.resize(out.len() + pad, 0);
    }
}

fn read_tar_str(field: &[u8]) -> String {
    let end = field.iter().position(|&b| b == 0).unwrap_or(field.len());
    String::from_utf8_lossy(&field[..end]).into_owned()
}

fn parse_tar_num(field: &[u8]) -> Option<u64> {
    if field.is_empty() {
        return Some(0);
    }
    if (field[0] & 0x80) != 0 {
        // GNU base-256 (big-endian, high bit set on first byte).
        let mut val: u64 = (field[0] & 0x7f) as u64;
        for &b in &field[1..] {
            val = val.checked_shl(8)?.checked_add(b as u64)?;
        }
        return Some(val);
    }
    let s = read_tar_str(field);
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return Some(0);
    }
    u64::from_str_radix(trimmed, 8).ok()
}

fn parse_pax_records(data: &[u8]) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    let mut pos = 0usize;
    while pos < data.len() {
        let Some(sp_rel) = data[pos..].iter().position(|&b| b == b' ') else {
            break;
        };
        let len_str = String::from_utf8_lossy(&data[pos..pos + sp_rel]);
        let Ok(rec_len) = len_str.trim().parse::<usize>() else {
            break;
        };
        if rec_len == 0 || pos + rec_len > data.len() {
            break;
        }
        let rec_body = &data[pos + sp_rel + 1..pos + rec_len];
        let rec_body = rec_body.strip_suffix(b"\n").unwrap_or(rec_body);
        if let Some(eq_idx) = rec_body.iter().position(|&b| b == b'=') {
            let key = String::from_utf8_lossy(&rec_body[..eq_idx]).into_owned();
            let val = String::from_utf8_lossy(&rec_body[eq_idx + 1..]).into_owned();
            map.insert(key, val);
        }
        pos += rec_len;
    }
    map
}

fn resolve_tar_entry_path(
    raw_path: &str,
    mount_path: &str,
    strip_components: usize,
) -> Option<String> {
    let cleaned = raw_path.trim_end_matches('/');
    if cleaned.is_empty() || cleaned == "." {
        return None;
    }
    let parts: Vec<&str> = cleaned
        .split('/')
        .filter(|s| !s.is_empty() && *s != ".")
        .collect();
    if parts.len() <= strip_components {
        return None;
    }
    let mut stack: Vec<&str> = Vec::new();
    for seg in &parts[strip_components..] {
        if *seg == ".." {
            if stack.pop().is_none() && mount_path != "/" {
                return None;
            }
        } else {
            stack.push(seg);
        }
    }
    if stack.is_empty() {
        return None;
    }
    let rel = stack.join("/");
    if mount_path == "/" {
        Some(format!("/{}", rel))
    } else {
        Some(format!("{}/{}", mount_path.trim_end_matches('/'), rel))
    }
}

fn split_parent_base(norm_path: &str) -> (&str, &str) {
    let trimmed = norm_path.trim_end_matches('/');
    if trimmed.is_empty() {
        return ("/", "");
    }
    match trimmed.rfind('/') {
        Some(0) => ("/", &trimmed[1..]),
        Some(idx) => (&trimmed[..idx], &trimmed[idx + 1..]),
        None => ("/", trimmed),
    }
}

