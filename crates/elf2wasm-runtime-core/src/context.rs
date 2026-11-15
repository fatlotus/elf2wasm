use crate::vfs::{DirEntry, FileStat};
use elf2wasm_core::lifter::CTX_SIZE;

#[cfg(feature = "std-fs")]
use crate::vfs::{path_hash, DT_DIR, DT_REG, DT_UNKNOWN, EIO, S_IFDIR, S_IFREG};
#[cfg(feature = "std-fs")]
use std::fs;
#[cfg(feature = "std-fs")]
use std::path::{Path, PathBuf};

/// Abstraction over guest linear memory, CPU register globals, and context save/load.
/// Implemented by `WasmtimeGuestContext` on native hosts and `WasmGuestContext` in `elf2wasm-runtime-wasm`.
pub trait GuestContext {
    fn mem_len(&self) -> usize;
    fn mem_read(&self, addr: u64, buf: &mut [u8]) -> Result<(), i64>;
    fn mem_write(&mut self, addr: u64, data: &[u8]) -> Result<(), i64>;
    fn mem_zero(&mut self, addr: u64, len: usize) -> Result<(), i64>;
    fn mem_read_cstr(&self, addr: u64, max_len: usize) -> Result<String, i64>;

    fn get_fsbase(&self) -> i64;
    fn set_fsbase(&mut self, val: i64);
    fn get_gsbase(&self) -> i64;
    fn set_gsbase(&mut self, val: i64);
    fn get_rcx(&self) -> i64;
    fn set_rip(&mut self, val: i64);
    fn set_rsp(&mut self, val: i64);

    fn set_exit(&mut self, code: i32);
    fn set_yield_flag(&mut self, val: i32);
    fn set_quantum(&mut self, val: i32);

    fn save_ctx(&mut self, scratch_addr: u32) -> Result<[u8; CTX_SIZE], i64>;
    fn load_ctx(&mut self, scratch_addr: u32, buf: &[u8; CTX_SIZE]) -> Result<(), i64>;

    fn trace_enabled(&self) -> bool {
        false
    }
    fn trace_log(&self, _msg: &str) {}
}

/// Abstraction over host read-only filesystem mounts and inherited host stdin.
pub trait HostFsProvider {
    fn is_under_ro_mount(&self, norm_path: &str) -> bool;
    fn stat_host_ro(&self, norm_path: &str) -> Option<FileStat>;
    fn read_host_ro(&self, norm_path: &str) -> Option<Vec<u8>>;
    fn list_host_ro_dir(&self, norm_path: &str) -> Option<Vec<DirEntry>>;
    fn is_virtual_allowlist_parent(&self, norm_path: &str) -> bool;
    fn host_file_size(&self, host_path: &str) -> Option<u64>;
    fn read_inherited_stdin(&mut self, max_bytes: usize) -> Result<Vec<u8>, i64>;
    fn mount_guest_prefixes(&self) -> Vec<String>;
    fn allowlist_entries(&self) -> Vec<(String, bool)>;
}

/// Pure in-memory / wasm32 no-op host filesystem provider.
#[derive(Debug, Default, Clone)]
pub struct NoopHostFs;

impl HostFsProvider for NoopHostFs {
    fn is_under_ro_mount(&self, _norm_path: &str) -> bool {
        false
    }
    fn stat_host_ro(&self, _norm_path: &str) -> Option<FileStat> {
        None
    }
    fn read_host_ro(&self, _norm_path: &str) -> Option<Vec<u8>> {
        None
    }
    fn list_host_ro_dir(&self, _norm_path: &str) -> Option<Vec<DirEntry>> {
        None
    }
    fn is_virtual_allowlist_parent(&self, _norm_path: &str) -> bool {
        false
    }
    fn host_file_size(&self, _host_path: &str) -> Option<u64> {
        None
    }
    fn read_inherited_stdin(&mut self, _max_bytes: usize) -> Result<Vec<u8>, i64> {
        Ok(Vec::new())
    }
    fn mount_guest_prefixes(&self) -> Vec<String> {
        Vec::new()
    }
    fn allowlist_entries(&self) -> Vec<(String, bool)> {
        Vec::new()
    }
}

#[cfg(feature = "std-fs")]
pub const DEFAULT_RO_ALLOWLIST: &[&str] = &[
    "/usr/lib/locale/C.utf8",
    "/usr/share/locale/locale.alias",
    "/usr/lib/x86_64-linux-gnu/gconv",
];

#[cfg(feature = "std-fs")]
#[derive(Debug, Clone)]
pub struct VfsMount {
    pub host_root: PathBuf,
    pub guest_prefix: String,
}

#[cfg(feature = "std-fs")]
#[derive(Debug, Clone)]
pub struct StdHostFs {
    pub mounts: Vec<VfsMount>,
}

#[cfg(feature = "std-fs")]
impl StdHostFs {
    pub fn new(vfs_ro: &[(PathBuf, String)]) -> Self {
        let mut mounts = Vec::new();
        for (host, guest) in vfs_ro {
            if let Ok(canon) = fs::canonicalize(host) {
                mounts.push(VfsMount {
                    host_root: canon,
                    guest_prefix: crate::vfs::normalize_guest_path(guest),
                });
            }
        }
        mounts.sort_by(|a, b| b.guest_prefix.len().cmp(&a.guest_prefix.len()));
        Self { mounts }
    }

    fn resolve_host_ro_with_root(&self, norm_path: &str) -> Option<(PathBuf, PathBuf)> {
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
}

#[cfg(feature = "std-fs")]
impl HostFsProvider for StdHostFs {
    fn is_under_ro_mount(&self, norm_path: &str) -> bool {
        for m in &self.mounts {
            if m.guest_prefix == "/" {
                // Note: mounting "/" as RO would make everything RO unless handled carefully;
                // only treat as RO if it actually resolves or matches mount.
                return true;
            }
            if norm_path == m.guest_prefix || norm_path.starts_with(&format!("{}/", m.guest_prefix))
            {
                return true;
            }
        }
        for prefix in DEFAULT_RO_ALLOWLIST {
            if norm_path == *prefix || norm_path.starts_with(&format!("{}/", prefix)) {
                return true;
            }
        }
        false
    }

    fn stat_host_ro(&self, norm_path: &str) -> Option<FileStat> {
        let host_path = self.resolve_host_ro_with_root(norm_path)?.0;
        let meta = fs::metadata(&host_path).ok()?;
        if meta.is_dir() {
            Some(FileStat {
                st_ino: path_hash(norm_path),
                st_mode: S_IFDIR | 0o755,
                st_nlink: 2,
                st_size: 4096,
                mtime_ns: 0,
            })
        } else {
            #[cfg(unix)]
            let mode = {
                use std::os::unix::fs::PermissionsExt;
                S_IFREG | (meta.permissions().mode() & 0o777)
            };
            #[cfg(not(unix))]
            let mode = S_IFREG | 0o644;
            Some(FileStat {
                st_ino: path_hash(norm_path),
                st_mode: mode,
                st_nlink: 1,
                st_size: meta.len() as i64,
                mtime_ns: 0,
            })
        }
    }

    fn read_host_ro(&self, norm_path: &str) -> Option<Vec<u8>> {
        let host_path = self.resolve_host_ro_with_root(norm_path)?.0;
        let meta = fs::metadata(&host_path).ok()?;
        if meta.is_dir() {
            return None;
        }
        fs::read(&host_path).ok()
    }

    fn list_host_ro_dir(&self, norm_path: &str) -> Option<Vec<DirEntry>> {
        let (host_path, host_root) = self.resolve_host_ro_with_root(norm_path)?;
        let meta = fs::metadata(&host_path).ok()?;
        if !meta.is_dir() {
            return None;
        }
        let mut out = Vec::new();
        let rd = fs::read_dir(&host_path).ok()?;
        for item in rd.flatten() {
            let name = item.file_name().to_string_lossy().into_owned();
            let child_guest = if norm_path == "/" {
                format!("/{}", name)
            } else {
                format!("{}/{}", norm_path, name)
            };
            let d_type = match item.file_type() {
                Ok(ft) if ft.is_dir() => DT_DIR,
                Ok(ft) if ft.is_file() => DT_REG,
                Ok(ft) if ft.is_symlink() => match fs::canonicalize(item.path()) {
                    Ok(canon) if canon.starts_with(&host_root) => {
                        if canon.is_dir() {
                            DT_DIR
                        } else {
                            DT_REG
                        }
                    }
                    _ => continue,
                },
                _ => DT_UNKNOWN,
            };
            out.push(DirEntry {
                d_ino: path_hash(&child_guest),
                d_type,
                name,
            });
        }
        Some(out)
    }

    fn is_virtual_allowlist_parent(&self, norm_path: &str) -> bool {
        let prefix_slash = format!("{}/", norm_path);
        for m in &self.mounts {
            if m.guest_prefix.starts_with(&prefix_slash) {
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

    fn host_file_size(&self, host_path: &str) -> Option<u64> {
        fs::metadata(Path::new(host_path)).ok().map(|m| m.len())
    }

    fn read_inherited_stdin(&mut self, max_bytes: usize) -> Result<Vec<u8>, i64> {
        use std::io::Read;
        let cap = max_bytes.min(64 * 1024);
        let mut buf = vec![0u8; cap];
        let mut stdin = std::io::stdin().lock();
        loop {
            match stdin.read(&mut buf) {
                Ok(n) => {
                    buf.truncate(n);
                    return Ok(buf);
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => return Err(-EIO),
            }
        }
    }

    fn mount_guest_prefixes(&self) -> Vec<String> {
        self.mounts.iter().map(|m| m.guest_prefix.clone()).collect()
    }

    fn allowlist_entries(&self) -> Vec<(String, bool)> {
        let mut out = Vec::new();
        for allow in DEFAULT_RO_ALLOWLIST {
            if let Ok(meta) = fs::metadata(allow) {
                out.push(((*allow).to_string(), meta.is_file()));
            }
        }
        out
    }
}
