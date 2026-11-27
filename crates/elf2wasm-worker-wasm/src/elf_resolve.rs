//! ELF, symlink, PATH, shebang, and shared-object dependency resolution over `VirtualFs`.
//!
//! Mirrors `js/elf2wasm_shim.mjs` (`resolveVfsPath`, `resolveCommandPath`, `runFromVfs`,
//! `_resolveElfSos`) so remote `wasmi` execution resolves the exact same binaries and `.so`
//! libraries as browser/Node V8 execution.

use elf2wasm_runtime_core::syscalls::is_valid_elf64_x86_64;
use elf2wasm_runtime_core::vfs::{normalize_guest_path, VirtualFs, AT_FDCWD};
use goblin::elf::{program_header, Elf};
use std::collections::{HashSet, VecDeque};

pub const DEFAULT_PATH: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

const DEFAULT_SO_SEARCH_DIRS: &[&str] = &[
    "/lib64",
    "/lib",
    "/lib/x86_64-linux-gnu",
    "/usr/lib/x86_64-linux-gnu",
    "/usr/lib64",
    "/usr/lib",
];

/// Core Python `lib-dynload` extension modules auto-bundled when running `python3`,
/// matching `PYTHON_CORE_LIB_DYNLOAD` in `js/elf2wasm_shim.mjs`.
const PYTHON_CORE_LIB_DYNLOAD: &[&str] = &[
    "_asyncio",
    "_bisect",
    "_blake2",
    "_bz2",
    "_codecs_cn",
    "_codecs_hk",
    "_codecs_iso2022",
    "_codecs_jp",
    "_codecs_kr",
    "_codecs_tw",
    "_contextvars",
    "_csv",
    "_ctypes",
    "_datetime",
    "_decimal",
    "_elementtree",
    "_hashlib",
    "_heapq",
    "_json",
    "_lsprof",
    "_lzma",
    "_md5",
    "_multibytecodec",
    "_opcode",
    "_pickle",
    "_posixsubprocess",
    "_queue",
    "_random",
    "_sha1",
    "_sha2",
    "_sha3",
    "_socket",
    "_sqlite3",
    "_ssl",
    "_struct",
    "_typing",
    "_uuid",
    "_zoneinfo",
    "array",
    "binascii",
    "cmath",
    "fcntl",
    "grp",
    "math",
    "mmap",
    "pyexpat",
    "select",
    "termios",
    "unicodedata",
    "zlib",
];

fn parent_dir(norm_path: &str) -> &str {
    if norm_path == "/" {
        return "/";
    }
    match norm_path.rfind('/') {
        Some(0) => "/",
        Some(idx) => &norm_path[..idx],
        None => "/",
    }
}

fn base_name(norm_path: &str) -> &str {
    norm_path.rsplit('/').next().unwrap_or(norm_path)
}

/// Resolve symlinks component-by-component up to 40 hops, matching `resolveVfsPath`.
pub fn resolve_vfs_path(vfs: &VirtualFs, guest_path: &str) -> String {
    let mut cur = normalize_guest_path(guest_path);
    for _ in 0..40 {
        let parts: Vec<&str> = cur.split('/').filter(|s| !s.is_empty()).collect();
        let mut prefix = String::new();
        let mut expanded = false;
        for (i, part) in parts.iter().enumerate() {
            prefix.push('/');
            prefix.push_str(part);
            if let Ok(target_bytes) = vfs.readlink(AT_FDCWD, &prefix) {
                let target = String::from_utf8_lossy(&target_bytes).into_owned();
                let dir = parent_dir(&prefix);
                let resolved_target = if target.starts_with('/') {
                    normalize_guest_path(&target)
                } else if dir == "/" {
                    normalize_guest_path(&format!("/{}", target))
                } else {
                    normalize_guest_path(&format!("{}/{}", dir, target))
                };
                let rest = parts[i + 1..].join("/");
                cur = if rest.is_empty() {
                    resolved_target
                } else if resolved_target == "/" {
                    normalize_guest_path(&format!("/{}", rest))
                } else {
                    normalize_guest_path(&format!("{}/{}", resolved_target, rest))
                };
                expanded = true;
                break;
            }
        }
        if !expanded {
            return cur;
        }
    }
    cur
}

pub fn get_env_var<'a>(env: &'a [String], key: &str) -> Option<&'a str> {
    let prefix = format!("{}=", key);
    for entry in env.iter().rev() {
        if let Some(val) = entry.strip_prefix(&prefix) {
            return Some(val);
        }
    }
    None
}

/// Resolve a command name (bare name via `PATH` or relative/absolute path) in `vfs`.
pub fn resolve_command_path(
    vfs: &VirtualFs,
    cmd: &str,
    env: &[String],
    cwd: &str,
) -> Option<String> {
    if cmd.is_empty() {
        return None;
    }
    if cmd.contains('/') {
        let candidate = if cmd.starts_with('/') {
            normalize_guest_path(cmd)
        } else {
            let base = normalize_guest_path(if cwd.is_empty() { "/" } else { cwd });
            if base == "/" {
                normalize_guest_path(&format!("/{}", cmd))
            } else {
                normalize_guest_path(&format!("{}/{}", base, cmd))
            }
        };
        let resolved = resolve_vfs_path(vfs, &candidate);
        if vfs.vfs_read_file(&resolved).is_some() {
            return Some(candidate);
        }
        return None;
    }
    let path_env = get_env_var(env, "PATH").unwrap_or(DEFAULT_PATH);
    let base_cwd = normalize_guest_path(if cwd.is_empty() { "/" } else { cwd });
    for dir in path_env.split(':') {
        let candidate = if dir.is_empty() {
            if base_cwd == "/" {
                normalize_guest_path(&format!("/{}", cmd))
            } else {
                normalize_guest_path(&format!("{}/{}", base_cwd, cmd))
            }
        } else if dir == "/" {
            format!("/{}", cmd)
        } else if dir.starts_with('/') {
            normalize_guest_path(&format!("{}/{}", dir, cmd))
        } else if base_cwd == "/" {
            normalize_guest_path(&format!("/{}/{}", dir, cmd))
        } else {
            normalize_guest_path(&format!("{}/{}/{}", base_cwd, dir, cmd))
        };
        let resolved = resolve_vfs_path(vfs, &candidate);
        if vfs.vfs_read_file(&resolved).is_some() {
            return Some(candidate);
        }
    }
    None
}

pub struct ResolvedExec {
    pub elf_path: String,
    pub elf_bytes: Vec<u8>,
    pub argv: Vec<String>,
    pub sos: Vec<(String, Vec<u8>)>,
}

/// Resolve `cmd` through `PATH` and up to 5 shebang (`#!`) hops, returning the final
/// ELF64 x86-64 executable, effective `argv`, and all transitive `.so` dependencies.
pub fn resolve_command_and_sos(
    vfs: &VirtualFs,
    cmd: &[String],
    env: &[String],
    cwd: &str,
) -> Result<ResolvedExec, String> {
    if cmd.is_empty() || cmd[0].is_empty() {
        return Err("Empty command".to_string());
    }
    let mut eff_argv = cmd.to_vec();
    let mut cur_path = resolve_command_path(vfs, &eff_argv[0], env, cwd)
        .ok_or_else(|| format!("Command not found in VFS: {}", eff_argv[0]))?;

    for _ in 0..5 {
        let resolved = resolve_vfs_path(vfs, &cur_path);
        let bytes = vfs
            .vfs_read_file(&resolved)
            .ok_or_else(|| format!("Executable not found in VFS: {}", cur_path))?;

        if bytes.len() >= 2 && bytes[0] == b'#' && bytes[1] == b'!' {
            let line_end = bytes
                .iter()
                .position(|&b| b == b'\n' || b == b'\r')
                .unwrap_or(bytes.len().min(256));
            let line = String::from_utf8_lossy(&bytes[2..line_end]);
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return Err(format!("Empty shebang in {}", cur_path));
            }
            let (interp, opt_arg) = match trimmed.find(|c: char| c.is_ascii_whitespace()) {
                Some(idx) => {
                    let interp = trimmed[..idx].to_string();
                    let arg = trimmed[idx..].trim();
                    (interp, if arg.is_empty() { None } else { Some(arg.to_string()) })
                }
                None => (trimmed.to_string(), None),
            };
            let mut next_argv = vec![interp.clone()];
            if let Some(arg) = opt_arg {
                next_argv.push(arg);
            }
            next_argv.push(cur_path.clone());
            next_argv.extend_from_slice(&eff_argv[1..]);
            eff_argv = next_argv;
            cur_path = resolve_command_path(vfs, &interp, env, cwd)
                .ok_or_else(|| format!("Shebang interpreter not found in VFS: {}", interp))?;
            continue;
        }

        if !is_valid_elf64_x86_64(&bytes) {
            return Err(format!("Not a valid ELF64 x86-64 binary: {}", cur_path));
        }

        let sos = resolve_elf_sos(vfs, &cur_path, &bytes, env, &eff_argv);
        return Ok(ResolvedExec {
            elf_path: cur_path,
            elf_bytes: bytes,
            argv: eff_argv,
            sos,
        });
    }

    Err(format!("Too many shebang indirections starting at {}", cmd[0]))
}

struct ElfDeps {
    interp: Option<String>,
    needed: Vec<String>,
    rpath: Vec<String>,
    runpath: Vec<String>,
}

fn parse_elf_deps(bytes: &[u8]) -> ElfDeps {
    let Ok(elf) = Elf::parse(bytes) else {
        return ElfDeps {
            interp: None,
            needed: Vec::new(),
            rpath: Vec::new(),
            runpath: Vec::new(),
        };
    };
    let mut interp = elf.interpreter.map(|s| s.to_string());
    if interp.is_none() {
        for ph in &elf.program_headers {
            if ph.p_type == program_header::PT_INTERP {
                let off = ph.p_offset as usize;
                let sz = ph.p_filesz as usize;
                if off.saturating_add(sz) <= bytes.len() {
                    let slice = &bytes[off..off + sz];
                    let end = slice.iter().position(|&b| b == 0).unwrap_or(slice.len());
                    if end > 0 {
                        interp = Some(String::from_utf8_lossy(&slice[..end]).into_owned());
                    }
                }
            }
        }
    }
    let needed = elf.libraries.iter().map(|s| (*s).to_string()).collect();
    let rpath = elf
        .rpaths
        .iter()
        .flat_map(|s| s.split(':'))
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();
    let runpath = elf
        .runpaths
        .iter()
        .flat_map(|s| s.split(':'))
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();

    ElfDeps {
        interp,
        needed,
        rpath,
        runpath,
    }
}

fn expand_origin(dir: &str, origin: &str) -> String {
    let s = dir.replace("${ORIGIN}", origin).replace("$ORIGIN", origin);
    normalize_guest_path(&s)
}

fn glob_match(pattern: &str, text: &str) -> bool {
    let p = pattern.as_bytes();
    let t = text.as_bytes();
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star_p, mut star_t) = (None, 0usize);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == b'?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == b'*' {
            star_p = Some(pi);
            star_t = ti;
            pi += 1;
        } else if let Some(sp) = star_p {
            pi = sp + 1;
            star_t += 1;
            ti = star_t;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == b'*' {
        pi += 1;
    }
    pi == p.len()
}

fn collect_ld_so_conf_dirs(
    vfs: &VirtualFs,
    conf_path: &str,
    overlay_paths: &[String],
    visited: &mut HashSet<String>,
    out_dirs: &mut Vec<String>,
) {
    let norm = resolve_vfs_path(vfs, conf_path);
    if !visited.insert(norm.clone()) {
        return;
    }
    let Some(bytes) = vfs.vfs_read_file(&norm) else {
        return;
    };
    let text = String::from_utf8_lossy(&bytes);
    let conf_dir = parent_dir(&norm).to_string();
    for raw_line in text.lines() {
        let line = raw_line.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("include ") {
            let pat = rest.trim();
            let full_pat = if pat.starts_with('/') {
                normalize_guest_path(pat)
            } else if conf_dir == "/" {
                normalize_guest_path(&format!("/{}", pat))
            } else {
                normalize_guest_path(&format!("{}/{}", conf_dir, pat))
            };
            if full_pat.contains('*') || full_pat.contains('?') {
                for p in overlay_paths {
                    if glob_match(&full_pat, p) {
                        collect_ld_so_conf_dirs(vfs, p, overlay_paths, visited, out_dirs);
                    }
                }
            } else {
                collect_ld_so_conf_dirs(vfs, &full_pat, overlay_paths, visited, out_dirs);
            }
        } else if line.starts_with('/') {
            let d = normalize_guest_path(line);
            if !out_dirs.contains(&d) {
                out_dirs.push(d);
            }
        }
    }
}

fn collect_system_ld_dirs(vfs: &VirtualFs, overlay_paths: &[String]) -> Vec<String> {
    let mut dirs = Vec::new();
    // Musl path file
    if let Some(bytes) = vfs.vfs_read_file("/etc/ld-musl-x86_64.path") {
        let text = String::from_utf8_lossy(&bytes);
        for line in text.lines() {
            for part in line.split(':') {
                let t = part.trim();
                if !t.is_empty() && t.starts_with('/') {
                    let n = normalize_guest_path(t);
                    if !dirs.contains(&n) {
                        dirs.push(n);
                    }
                }
            }
        }
    }
    let mut visited = HashSet::new();
    collect_ld_so_conf_dirs(vfs, "/etc/ld.so.conf", overlay_paths, &mut visited, &mut dirs);
    for &d in DEFAULT_SO_SEARCH_DIRS {
        let s = d.to_string();
        if !dirs.contains(&s) {
            dirs.push(s);
        }
    }
    dirs
}

/// Resolve all transitive shared-object dependencies (`PT_INTERP` + `DT_NEEDED` +
/// Python `lib-dynload` + explicit `.so` paths in `argv`).
pub fn resolve_elf_sos(
    vfs: &VirtualFs,
    main_path: &str,
    main_bytes: &[u8],
    env: &[String],
    argv: &[String],
) -> Vec<(String, Vec<u8>)> {
    let overlay_paths = vfs.overlay_paths();
    let sys_dirs = collect_system_ld_dirs(vfs, &overlay_paths);
    let ld_library_path: Vec<String> = get_env_var(env, "LD_LIBRARY_PATH")
        .map(|v| {
            v.split(':')
                .filter(|s| !s.is_empty())
                .map(normalize_guest_path)
                .collect()
        })
        .unwrap_or_default();

    let mut result: Vec<(String, Vec<u8>)> = Vec::new();
    let mut seen_canonical: HashSet<String> = HashSet::new();
    let mut queue: VecDeque<(String, Vec<u8>)> = VecDeque::new();

    let try_add_so = |candidate_path: &str,
                          result: &mut Vec<(String, Vec<u8>)>,
                          seen: &mut HashSet<String>,
                          queue: &mut VecDeque<(String, Vec<u8>)>|
     -> bool {
        let norm_cand = normalize_guest_path(candidate_path);
        let canonical = resolve_vfs_path(vfs, &norm_cand);
        if seen.contains(&canonical) {
            return true;
        }
        if let Some(bytes) = vfs.vfs_read_file(&canonical) {
            if is_valid_elf64_x86_64(&bytes) {
                seen.insert(canonical);
                result.push((norm_cand.clone(), bytes.clone()));
                queue.push_back((norm_cand, bytes));
                return true;
            }
        }
        false
    };

    // Seed with main binary.
    let main_norm = normalize_guest_path(main_path);
    seen_canonical.insert(resolve_vfs_path(vfs, &main_norm));
    queue.push_back((main_norm.clone(), main_bytes.to_vec()));

    // Check if running python3 -> auto-bundle core lib-dynload/*.so modules.
    let main_base = base_name(&main_norm);
    let resolved_main = resolve_vfs_path(vfs, &main_norm);
    let resolved_main_base = base_name(&resolved_main);
    let is_python = main_base == "python3"
        || main_base.starts_with("python3.")
        || resolved_main_base == "python3"
        || resolved_main_base.starts_with("python3.");
    if is_python {
        for p in &overlay_paths {
            if p.contains("/lib-dynload/") && p.ends_with(".so") {
                let fname = base_name(p);
                let stem = fname.split('.').next().unwrap_or("");
                if PYTHON_CORE_LIB_DYNLOAD.contains(&stem) {
                    try_add_so(p, &mut result, &mut seen_canonical, &mut queue);
                }
            }
        }
    }

    // Check argv for explicit /.../*.so* paths.
    for arg in argv.iter().skip(1) {
        if arg.starts_with('/') && (arg.ends_with(".so") || arg.contains(".so.")) {
            try_add_so(arg, &mut result, &mut seen_canonical, &mut queue);
        }
    }

    while let Some((cur_path, cur_bytes)) = queue.pop_front() {
        let deps = parse_elf_deps(&cur_bytes);
        if let Some(interp) = deps.interp {
            try_add_so(&interp, &mut result, &mut seen_canonical, &mut queue);
        }

        let origin = parent_dir(&resolve_vfs_path(vfs, &cur_path)).to_string();
        let mut search_dirs: Vec<String> = Vec::new();
        if deps.runpath.is_empty() {
            for r in &deps.rpath {
                search_dirs.push(expand_origin(r, &origin));
            }
        }
        for d in &ld_library_path {
            search_dirs.push(d.clone());
        }
        for r in &deps.runpath {
            search_dirs.push(expand_origin(r, &origin));
        }
        for d in &sys_dirs {
            search_dirs.push(d.clone());
        }

        for lib in deps.needed {
            if lib.contains('/') {
                try_add_so(&lib, &mut result, &mut seen_canonical, &mut queue);
                continue;
            }
            for dir in &search_dirs {
                let cand = if dir == "/" {
                    format!("/{}", lib)
                } else {
                    format!("{}/{}", dir, lib)
                };
                if try_add_so(&cand, &mut result, &mut seen_canonical, &mut queue) {
                    break;
                }
            }
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolve_command_path_empty_path_component_uses_cwd() {
        let mut vfs = VirtualFs::new_in_memory(&[]);
        vfs.vfs_write_file("/workspace/localtool", b"#!/bin/sh\n", 0o755);

        let env = vec!["PATH=/usr/bin::/bin".to_string()];
        let found = resolve_command_path(&vfs, "localtool", &env, "/workspace");
        assert_eq!(found.as_deref(), Some("/workspace/localtool"));

        // Leading empty component also resolves against cwd.
        let env_leading = vec!["PATH=:/bin".to_string()];
        assert_eq!(
            resolve_command_path(&vfs, "localtool", &env_leading, "/workspace").as_deref(),
            Some("/workspace/localtool")
        );

        // Relative PATH component resolves against cwd.
        let env_rel = vec!["PATH=.:/bin".to_string()];
        assert_eq!(
            resolve_command_path(&vfs, "localtool", &env_rel, "/workspace").as_deref(),
            Some("/workspace/localtool")
        );
    }
}
