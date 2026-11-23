use anyhow::{bail, Context, Result};
use goblin::elf::{program_header, Elf};
use std::collections::HashMap;
#[cfg(feature = "std-fs")]
use std::fs;
#[cfg(feature = "std-fs")]
use std::path::{Path, PathBuf};

pub const MAIN_PIE_BASE: u32 = 0x0010_0000; // 1 MB
pub const LD_BASE: u32 = 0x0100_0000; // 16 MB
pub const SO_BASE_START: u32 = 0x0200_0000; // 32 MB
pub const SO_ALIGN: u32 = 0x0001_0000; // 64 KB
pub const BRK_START: u32 = 0x0500_0000; // 80 MB
pub const MMAP_START: u32 = 0x0800_0000; // 128 MB
pub const MMAP_END: u32 = 0x0B00_0000; // 176 MB
pub const STACK_TOP: u32 = 0x0BFF_0000; // ~192 MB
pub const INITIAL_MEM_PAGES: u32 = 4096; // 256 MB (4096 * 64KB)
pub const DISPATCH_TABLE_ADDR: u32 = 0x0001_0000; // 64 KB

const EXPANDED_BRK_SIZE: u32 = 0x0300_0000; // 48 MB
const EXPANDED_MMAP_SIZE: u32 = 0x1000_0000; // 256 MB
const EXPANDED_STACK_SIZE: u32 = 0x0100_0000; // 16 MB
const STACK_GUARD_GAP: u32 = 0x0001_0000; // 64 KB below dispatch_hash_addr

#[derive(Debug, Clone)]
pub struct ExecSegment {
    pub name: String,
    pub vaddr: u32,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct DataSegment {
    pub vaddr: u32,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct SoFile {
    pub host_path: String,
    pub guest_paths: Vec<String>,
    pub base_addr: u32,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct LoadedImage {
    pub entry_rip: u32,
    pub at_phdr: u32,
    pub at_phent: u32,
    pub at_phnum: u32,
    pub at_entry: u32,
    pub at_base: u32,
    pub exec_segments: Vec<ExecSegment>,
    pub data_segments: Vec<DataSegment>,
    pub so_files: Vec<SoFile>,
    pub symbols: HashMap<u32, String>,
    pub elf_path: String,
    pub brk_start: u32,
    pub mmap_start: u32,
    pub mmap_end: u32,
    pub stack_top: u32,
    pub dispatch_hash_addr: u32,
}

pub const GUEST_MEM_SIZE: usize = (INITIAL_MEM_PAGES as usize) * 65536; // 256 MB
pub const GUEST_CODE_DATA_LIMIT: usize = 0x0B00_0000; // 176 MB max VA end for code/data/.so

fn align_up(val: u32, align: u32) -> Option<u32> {
    val.checked_add(align - 1).map(|v| v & !(align - 1))
}

/// Compute per-module dynamic guest VA layout `(brk_start, mmap_start, mmap_end, stack_top, dispatch_hash_addr)`.
/// Preserves the exact legacy 256 MiB layout whenever `code_so_end <= BRK_START`.
pub fn compute_guest_layout(code_so_end: u32) -> Result<(u32, u32, u32, u32, u32)> {
    if code_so_end <= BRK_START {
        return Ok((
            crate::meta::DEFAULT_BRK_START,
            crate::meta::DEFAULT_MMAP_START,
            crate::meta::DEFAULT_MMAP_END,
            crate::meta::DEFAULT_STACK_TOP,
            crate::meta::DEFAULT_DISPATCH_HASH_ADDR,
        ));
    }
    let brk_start = align_up(code_so_end, 0x0100_0000)
        .context("brk_start 16MB alignment overflow")?;
    let mmap_start = brk_start
        .checked_add(EXPANDED_BRK_SIZE)
        .context("mmap_start overflow")?;
    let mmap_end = mmap_start
        .checked_add(EXPANDED_MMAP_SIZE)
        .context("mmap_end overflow")?;
    let dispatch_hash_addr = mmap_end
        .checked_add(EXPANDED_STACK_SIZE)
        .context("dispatch_hash_addr overflow")?;
    let stack_top = dispatch_hash_addr - STACK_GUARD_GAP;
    Ok((brk_start, mmap_start, mmap_end, stack_top, dispatch_hash_addr))
}

fn elf_span(elf: &Elf, align: u32) -> Result<u32> {
    let mut max_end = 0u32;
    for ph in &elf.program_headers {
        if ph.p_type == program_header::PT_LOAD {
            let end64 = ph
                .p_vaddr
                .checked_add(ph.p_memsz)
                .context("ELF segment vaddr + memsz overflow")?;
            let end = u32::try_from(end64)
                .context("ELF segment exceeds 32-bit guest virtual address space")?;
            if end > max_end {
                max_end = end;
            }
        }
    }
    align_up(max_end, align).context("ELF span alignment overflow")
}

fn collect_symbols(elf: &Elf, base: u32, out: &mut HashMap<u32, String>) {
    for sym in &elf.syms {
        if sym.st_value != 0 && sym.st_type() == goblin::elf::sym::STT_FUNC {
            if let Some(name) = elf.strtab.get_at(sym.st_name) {
                if !name.is_empty() {
                    if let Some(addr) = u32::try_from(sym.st_value).ok().and_then(|v| base.checked_add(v)) {
                        out.insert(addr, name.to_string());
                    }
                }
            }
        }
    }
    for sym in &elf.dynsyms {
        if sym.st_value != 0 && sym.st_type() == goblin::elf::sym::STT_FUNC {
            if let Some(name) = elf.dynstrtab.get_at(sym.st_name) {
                if !name.is_empty() {
                    if let Some(addr) = u32::try_from(sym.st_value).ok().and_then(|v| base.checked_add(v)) {
                        out.insert(addr, name.to_string());
                    }
                }
            }
        }
    }
}

fn extract_segments(
    name: &str,
    bytes: &[u8],
    elf: &Elf,
    base: u32,
    load_data: bool,
    exec_segments: &mut Vec<ExecSegment>,
    data_segments: &mut Vec<DataSegment>,
) -> Result<()> {
    for ph in &elf.program_headers {
        if ph.p_type != program_header::PT_LOAD {
            continue;
        }
        if ph.p_filesz > ph.p_memsz {
            bail!(
                "ELF {} segment has p_filesz ({}) > p_memsz ({})",
                name,
                ph.p_filesz,
                ph.p_memsz
            );
        }
        let file_end = ph
            .p_offset
            .checked_add(ph.p_filesz)
            .context("ELF segment p_offset + p_filesz overflow")?;
        if file_end > bytes.len() as u64 {
            bail!(
                "ELF {} segment extends past EOF (offset+filesz={} > len={})",
                name,
                file_end,
                bytes.len()
            );
        }
        let memsz = usize::try_from(ph.p_memsz)
            .ok()
            .filter(|&m| m <= GUEST_MEM_SIZE)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "ELF {} segment p_memsz ({}) exceeds guest memory limit ({})",
                    name,
                    ph.p_memsz,
                    GUEST_MEM_SIZE
                )
            })?;
        let filesz = ph.p_filesz as usize;
        let offset = ph.p_offset as usize;

        let vaddr64 = (base as u64)
            .checked_add(ph.p_vaddr)
            .context("ELF segment base + p_vaddr overflow")?;
        let vaddr = u32::try_from(vaddr64).with_context(|| {
            format!(
                "ELF {} segment vaddr 0x{:x} exceeds 32-bit guest address space",
                name, vaddr64
            )
        })?;
        let seg_end = (vaddr as usize)
            .checked_add(memsz)
            .context("ELF segment end address overflow")?;
        if seg_end > GUEST_CODE_DATA_LIMIT {
            bail!(
                "ELF {} segment [0x{:x}, 0x{:x}) overlaps stack/dispatch region (>= 0x{:x})",
                name,
                vaddr,
                seg_end,
                GUEST_CODE_DATA_LIMIT
            );
        }

        let code_len = filesz.min(memsz);
        if ph.p_flags & program_header::PF_X != 0 {
            // Only lift the file-backed executable bytes
            exec_segments.push(ExecSegment {
                name: format!("{name}@0x{vaddr:x}"),
                vaddr,
                data: bytes[offset..offset + code_len].to_vec(),
            });
        }

        // Only store file-backed bytes; WASM linear memory is already zero-initialized for .bss.
        if load_data && filesz > 0 {
            data_segments.push(DataSegment {
                vaddr,
                data: bytes[offset..offset + filesz].to_vec(),
            });
        }
    }
    Ok(())
}

pub fn load_elf_and_sos_bytes(
    main_path: &str,
    main_bytes: &[u8],
    sos: &[(&str, &[u8])],
) -> Result<LoadedImage> {
    let main_elf = Elf::parse(main_bytes)
        .with_context(|| format!("Failed to parse main ELF: {}", main_path))?;

    if !main_elf.is_64 {
        bail!("Only ELF64 is supported");
    }
    if main_elf.header.e_machine != goblin::elf::header::EM_X86_64 {
        bail!(
            "Unsupported ELF e_machine={} (only EM_X86_64={} is supported)",
            main_elf.header.e_machine,
            goblin::elf::header::EM_X86_64
        );
    }
    if main_elf.header.e_type != goblin::elf::header::ET_EXEC
        && main_elf.header.e_type != goblin::elf::header::ET_DYN
    {
        bail!(
            "Unsupported ELF e_type={} (only ET_EXEC and ET_DYN are supported)",
            main_elf.header.e_type
        );
    }

    let main_base = if main_elf.header.e_type == goblin::elf::header::ET_DYN {
        MAIN_PIE_BASE
    } else {
        0
    };
    let main_span = elf_span(&main_elf, 0x0010_0000)?;
    let main_end = if main_base == 0 {
        main_span
    } else {
        main_base
            .checked_add(main_span)
            .context("main ELF end overflow")?
    };

    let mut exec_segments = Vec::new();
    let mut data_segments = Vec::new();
    let mut symbols = HashMap::new();

    let main_name = main_path.rsplit('/').next().unwrap_or(main_path);
    extract_segments(
        main_name,
        main_bytes,
        &main_elf,
        main_base,
        true,
        &mut exec_segments,
        &mut data_segments,
    )?;
    collect_symbols(&main_elf, main_base, &mut symbols);

    // Determine AT_PHDR
    let mut at_phdr = u32::try_from(
        (main_base as u64)
            .checked_add(main_elf.header.e_phoff)
            .context("e_phoff overflow")?,
    )
    .context("AT_PHDR exceeds 32-bit guest address space")?;
    for ph in &main_elf.program_headers {
        if ph.p_type == program_header::PT_PHDR {
            at_phdr = u32::try_from(
                (main_base as u64)
                    .checked_add(ph.p_vaddr)
                    .context("PT_PHDR vaddr overflow")?,
            )
            .context("PT_PHDR exceeds 32-bit guest address space")?;
            break;
        }
    }
    let at_phent = main_elf.header.e_phentsize as u32;
    let at_phnum = main_elf.header.e_phnum as u32;
    let at_entry = u32::try_from(
        (main_base as u64)
            .checked_add(main_elf.header.e_entry)
            .context("e_entry overflow")?,
    )
    .context("e_entry exceeds 32-bit guest address space")?;

    let interp_path = main_elf.interpreter.map(|s| s.to_string());

    // Pre-parse all .so headers so we can compute dynamic ld_base and next_so_base
    // regardless of the order in which ld.so and other .so files are provided.
    struct ParsedSo<'a> {
        so_str: &'a str,
        so_base_name: &'a str,
        bytes: &'a [u8],
        elf: Elf<'a>,
        is_interp: bool,
    }

    let mut parsed_sos: Vec<ParsedSo<'_>> = Vec::with_capacity(sos.len());
    let mut interp_idx: Option<usize> = None;
    for &(so_str, so_bytes) in sos {
        let so_elf =
            Elf::parse(so_bytes).with_context(|| format!("Failed to parse .so: {}", so_str))?;
        if !so_elf.is_64 || so_elf.header.e_machine != goblin::elf::header::EM_X86_64 {
            bail!("Shared object {} is not an ELF64 x86-64 binary", so_str);
        }
        let so_base_name = so_str.rsplit('/').next().unwrap_or(so_str);
        let matches_interp = interp_path
            .as_deref()
            .map_or(false, |ip| is_interp_name_match(ip, so_str, so_base_name));
        if matches_interp {
            if let Some(existing_idx) = interp_idx {
                if parsed_sos[existing_idx].bytes == so_bytes {
                    // musl combines ld-musl and libc.musl into one binary; skip duplicate entry
                    // so we don't lift it twice or embed redundant bytes in WasmMeta.
                    continue;
                }
            }
        }
        let is_interp = interp_idx.is_none() && matches_interp;
        if is_interp {
            interp_idx = Some(parsed_sos.len());
        }
        parsed_sos.push(ParsedSo {
            so_str,
            so_base_name,
            bytes: so_bytes,
            elf: so_elf,
            is_interp,
        });
    }

    let ld_base = LD_BASE.max(main_end);
    let mut next_so_base = if let Some(idx) = interp_idx {
        let ld_span = elf_span(&parsed_sos[idx].elf, SO_ALIGN)?.max(SO_ALIGN);
        let ld_end = ld_base
            .checked_add(ld_span)
            .filter(|&n| n <= GUEST_CODE_DATA_LIMIT as u32)
            .ok_or_else(|| {
                anyhow::anyhow!("ld.so exceeds reserved VA space (GUEST_CODE_DATA_LIMIT)")
            })?;
        SO_BASE_START.max(ld_end)
    } else {
        SO_BASE_START.max(main_end)
    };

    let mut ld_loaded = false;
    let mut entry_rip = at_entry;
    let mut at_base = 0u32;
    let mut so_files = Vec::new();

    for pso in parsed_sos {
        if pso.is_interp {
            ld_loaded = true;
            at_base = ld_base;
            entry_rip = u32::try_from(
                (ld_base as u64)
                    .checked_add(pso.elf.header.e_entry)
                    .context("ld.so e_entry overflow")?,
            )
            .context("ld.so e_entry exceeds 32-bit guest address space")?;
            extract_segments(
                pso.so_base_name,
                pso.bytes,
                &pso.elf,
                ld_base,
                true,
                &mut exec_segments,
                &mut data_segments,
            )?;
            collect_symbols(&pso.elf, ld_base, &mut symbols);
        } else {
            let base = next_so_base;
            let span = elf_span(&pso.elf, SO_ALIGN)?.max(SO_ALIGN);
            next_so_base = next_so_base
                .checked_add(span)
                .filter(|&n| n <= GUEST_CODE_DATA_LIMIT as u32)
                .ok_or_else(|| anyhow::anyhow!("Shared objects exceed reserved SO VA space"))?;

            // Lift its code at `base`, but do NOT preload its data segments:
            // ld.so will openat + mmap it into `base` at runtime!
            extract_segments(
                pso.so_base_name,
                pso.bytes,
                &pso.elf,
                base,
                false,
                &mut exec_segments,
                &mut data_segments,
            )?;
            collect_symbols(&pso.elf, base, &mut symbols);

            let mut guest_paths = vec![
                pso.so_str.to_string(),
                format!("/lib/x86_64-linux-gnu/{}", pso.so_base_name),
                format!("/usr/lib/x86_64-linux-gnu/{}", pso.so_base_name),
                format!("/lib64/{}", pso.so_base_name),
                format!("/lib/{}", pso.so_base_name),
                format!("/usr/lib/{}", pso.so_base_name),
            ];
            guest_paths.sort();
            guest_paths.dedup();

            so_files.push(SoFile {
                host_path: pso.so_str.to_string(),
                guest_paths,
                base_addr: base,
                bytes: pso.bytes.to_vec(),
            });
        }
    }

    if interp_path.is_some() && !ld_loaded {
        bail!(
            "Main ELF requires interpreter {:?}, but it was not provided in --so list",
            interp_path.unwrap()
        );
    }
    if exec_segments.is_empty() {
        bail!("No executable PT_LOAD segments found in ELF");
    }

    let (brk_start, mmap_start, mmap_end, stack_top, dispatch_hash_addr) =
        compute_guest_layout(next_so_base)?;

    Ok(LoadedImage {
        entry_rip,
        at_phdr,
        at_phent,
        at_phnum,
        at_entry,
        at_base,
        exec_segments,
        data_segments,
        so_files,
        symbols,
        elf_path: main_path.to_string(),
        brk_start,
        mmap_start,
        mmap_end,
        stack_top,
        dispatch_hash_addr,
    })
}

#[cfg(feature = "std-fs")]
pub fn load_elf_and_sos(main_path: &Path, so_paths: &[PathBuf]) -> Result<LoadedImage> {
    let main_bytes = fs::read(main_path)
        .with_context(|| format!("Failed to read main ELF: {}", main_path.display()))?;

    let mut effective_so_paths = so_paths.to_vec();
    if main_path
        .file_name()
        .and_then(|n| n.to_str())
        .map_or(false, |n| n.starts_with("python3"))
    {
        let ctxvars = Path::new(
            "/usr/lib/python3.11/lib-dynload/_contextvars.cpython-311-x86_64-linux-gnu.so",
        );
        if ctxvars.exists()
            && !effective_so_paths
                .iter()
                .any(|p| p == ctxvars || p.file_name() == ctxvars.file_name())
        {
            effective_so_paths.push(ctxvars.to_path_buf());
        }
    }

    let mut so_owned = Vec::with_capacity(effective_so_paths.len());
    for so_path in &effective_so_paths {
        let so_bytes = fs::read(so_path)
            .with_context(|| format!("Failed to read .so: {}", so_path.display()))?;
        let so_str = so_path.to_string_lossy().to_string();
        let canon_str = fs::canonicalize(so_path)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| so_str.clone());
        so_owned.push((so_str, so_bytes, canon_str));
    }

    let so_slices: Vec<(&str, &[u8])> = so_owned
        .iter()
        .map(|(p, b, _)| (p.as_str(), b.as_slice()))
        .collect();
    let main_path_str = main_path.to_string_lossy();
    let mut image = load_elf_and_sos_bytes(&main_path_str, &main_bytes, &so_slices)?;

    // Preserve canonical symlink guest paths when loading from the host filesystem.
    for so_file in &mut image.so_files {
        if let Some((_, _, canon_str)) = so_owned
            .iter()
            .find(|(so_str, _, _)| so_str == &so_file.host_path)
        {
            if canon_str != &so_file.host_path {
                so_file.guest_paths.push(canon_str.clone());
                if let Some(canon_base) = Path::new(canon_str).file_name() {
                    let cb = canon_base.to_string_lossy();
                    so_file
                        .guest_paths
                        .push(format!("/lib/x86_64-linux-gnu/{}", cb));
                    so_file.guest_paths.push(format!("/lib64/{}", cb));
                    so_file.guest_paths.push(format!("/lib/{}", cb));
                    so_file.guest_paths.push(format!("/usr/lib/{}", cb));
                }
                so_file.guest_paths.sort();
                so_file.guest_paths.dedup();
            }
        }
    }

    Ok(image)
}

fn is_interp_name_match(interp_path: &str, so_str: &str, so_base_name: &str) -> bool {
    let ip_base = interp_path.rsplit('/').next().unwrap_or(interp_path);
    if interp_path == so_str || ip_base == so_base_name {
        return true;
    }
    // glibc dynamic linker aliases (e.g. ld-linux-x86-64.so.2)
    if so_base_name.starts_with("ld-linux") && interp_path.contains("ld-linux") {
        return true;
    }
    // musl dynamic linker <-> libc duality:
    // PT_INTERP is typically /lib/ld-musl-x86_64.so.1 while the real file / DT_NEEDED is libc.musl-x86_64.so.1
    if let Some(suffix) = ip_base.strip_prefix("ld-musl-") {
        if so_base_name == format!("libc.musl-{}", suffix)
            || so_base_name == format!("ld-musl-{}", suffix)
        {
            return true;
        }
    }
    if let Some(suffix) = ip_base.strip_prefix("libc.musl-") {
        if so_base_name == format!("ld-musl-{}", suffix)
            || so_base_name == format!("libc.musl-{}", suffix)
        {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_minimal_elf64(
        e_type: u16,
        e_entry: u64,
        vaddr: u64,
        memsz: u64,
        interp: Option<&[u8]>,
    ) -> Vec<u8> {
        // ELF64 header (64 bytes) + 1 or 2 program headers (56 bytes each) + code/interp payload
        let phnum: u16 = if interp.is_some() { 2 } else { 1 };
        let phoff: u64 = 64;
        let payload_off: u64 = 64 + (phnum as u64) * 56;
        let code = [0xc3u8]; // ret
        let interp_off = payload_off + code.len() as u64;
        let total_len = interp_off as usize + interp.map_or(0, |s| s.len());
        let mut buf = vec![0u8; total_len];

        // e_ident
        buf[0..4].copy_from_slice(b"\x7fELF");
        buf[4] = 2; // ELFCLASS64
        buf[5] = 1; // ELFDATA2LSB
        buf[6] = 1; // EV_CURRENT
        buf[16..18].copy_from_slice(&e_type.to_le_bytes());
        buf[18..20].copy_from_slice(&62u16.to_le_bytes()); // EM_X86_64
        buf[20..24].copy_from_slice(&1u32.to_le_bytes()); // EV_CURRENT
        buf[24..32].copy_from_slice(&e_entry.to_le_bytes());
        buf[32..40].copy_from_slice(&phoff.to_le_bytes());
        buf[52..54].copy_from_slice(&64u16.to_le_bytes()); // e_ehsize
        buf[54..56].copy_from_slice(&56u16.to_le_bytes()); // e_phentsize
        buf[56..58].copy_from_slice(&phnum.to_le_bytes());

        // PT_LOAD (p_type = 1, PF_R | PF_X = 5)
        let ph0 = 64usize;
        buf[ph0..ph0 + 4].copy_from_slice(&1u32.to_le_bytes());
        buf[ph0 + 4..ph0 + 8].copy_from_slice(&5u32.to_le_bytes());
        buf[ph0 + 8..ph0 + 16].copy_from_slice(&payload_off.to_le_bytes());
        buf[ph0 + 16..ph0 + 24].copy_from_slice(&vaddr.to_le_bytes());
        buf[ph0 + 24..ph0 + 32].copy_from_slice(&vaddr.to_le_bytes());
        buf[ph0 + 32..ph0 + 40].copy_from_slice(&(code.len() as u64).to_le_bytes());
        buf[ph0 + 40..ph0 + 48].copy_from_slice(&memsz.to_le_bytes());
        buf[ph0 + 48..ph0 + 56].copy_from_slice(&0x1000u64.to_le_bytes());

        buf[payload_off as usize..payload_off as usize + code.len()].copy_from_slice(&code);

        if let Some(ip) = interp {
            let ph1 = 64 + 56;
            buf[ph1..ph1 + 4].copy_from_slice(&3u32.to_le_bytes()); // PT_INTERP
            buf[ph1 + 4..ph1 + 8].copy_from_slice(&4u32.to_le_bytes()); // PF_R
            buf[ph1 + 8..ph1 + 16].copy_from_slice(&interp_off.to_le_bytes());
            buf[ph1 + 32..ph1 + 40].copy_from_slice(&(ip.len() as u64).to_le_bytes()); // p_filesz
            buf[ph1 + 40..ph1 + 48].copy_from_slice(&(ip.len() as u64).to_le_bytes()); // p_memsz
            buf[ph1 + 48..ph1 + 56].copy_from_slice(&1u64.to_le_bytes());
            buf[interp_off as usize..interp_off as usize + ip.len()].copy_from_slice(ip);
        }

        buf
    }

    #[test]
    fn test_large_et_exec_dynamic_bases() -> Result<()> {
        // Large ET_EXEC ending at 0x0260_0000 (> LD_BASE 0x0100_0000 and > SO_BASE_START 0x0200_0000)
        let main_bytes = make_minimal_elf64(
            goblin::elf::header::ET_EXEC,
            0x0040_0000,
            0x0040_0000,
            0x0220_0000,
            Some(b"/lib64/ld-linux-x86-64.so.2\0"),
        );
        let ld_bytes = make_minimal_elf64(goblin::elf::header::ET_DYN, 0x1000, 0, 0x10_0000, None);
        let libc_bytes =
            make_minimal_elf64(goblin::elf::header::ET_DYN, 0x1000, 0, 0x20_0000, None);

        // Pass libc BEFORE ld.so to verify order independence.
        let image = load_elf_and_sos_bytes(
            "/usr/bin/big_exec",
            &main_bytes,
            &[
                ("/lib/x86_64-linux-gnu/libc.so.6", &libc_bytes),
                ("/lib64/ld-linux-x86-64.so.2", &ld_bytes),
            ],
        )?;

        assert_eq!(image.at_base, 0x0260_0000);
        assert_eq!(image.so_files.len(), 1);
        assert_eq!(image.so_files[0].base_addr, 0x0270_0000);
        assert!(image.so_files[0].base_addr + 0x20_0000 <= BRK_START);
        Ok(())
    }

    #[test]
    fn test_musl_interp_matches_libc_musl_symlink() -> Result<()> {
        let main_bytes = make_minimal_elf64(
            goblin::elf::header::ET_DYN,
            0x1000,
            0,
            0x10_0000,
            Some(b"/lib/ld-musl-x86_64.so.1\0"),
        );
        let musl_bytes =
            make_minimal_elf64(goblin::elf::header::ET_DYN, 0x2000, 0, 0x10_0000, None);

        let image = load_elf_and_sos_bytes(
            "/bin/busybox",
            &main_bytes,
            &[("/lib/libc.musl-x86_64.so.1", &musl_bytes)],
        )?;

        assert_eq!(image.at_base, LD_BASE);
        assert_eq!(image.entry_rip, LD_BASE + 0x2000);
        assert!(image.so_files.is_empty());
        Ok(())
    }

    #[test]
    fn test_musl_interp_deduplicates_both_ld_and_libc() -> Result<()> {
        let main_bytes = make_minimal_elf64(
            goblin::elf::header::ET_DYN,
            0x1000,
            0,
            0x10_0000,
            Some(b"/lib/ld-musl-x86_64.so.1\0"),
        );
        let musl_bytes =
            make_minimal_elf64(goblin::elf::header::ET_DYN, 0x2000, 0, 0x10_0000, None);
        let foo_bytes =
            make_minimal_elf64(goblin::elf::header::ET_DYN, 0x1000, 0, 0x10_0000, None);

        let image = load_elf_and_sos_bytes(
            "/bin/busybox",
            &main_bytes,
            &[
                ("/lib/ld-musl-x86_64.so.1", &musl_bytes),
                ("/lib/libc.musl-x86_64.so.1", &musl_bytes),
                ("/usr/lib/libfoo.so.1", &foo_bytes),
            ],
        )?;

        assert_eq!(image.at_base, LD_BASE);
        assert_eq!(image.so_files.len(), 1);
        assert_eq!(image.so_files[0].host_path, "/usr/lib/libfoo.so.1");
        assert_eq!(image.so_files[0].base_addr, SO_BASE_START);
        Ok(())
    }

    #[test]
    fn test_musl_interp_reverse_order_with_extra_so() -> Result<()> {
        let main_bytes = make_minimal_elf64(
            goblin::elf::header::ET_DYN,
            0x1000,
            0,
            0x10_0000,
            Some(b"/lib/ld-musl-x86_64.so.1\0"),
        );
        let musl_bytes =
            make_minimal_elf64(goblin::elf::header::ET_DYN, 0x2000, 0, 0x10_0000, None);
        let foo_bytes =
            make_minimal_elf64(goblin::elf::header::ET_DYN, 0x1000, 0, 0x10_0000, None);

        let image = load_elf_and_sos_bytes(
            "/bin/busybox",
            &main_bytes,
            &[
                ("/usr/lib/libfoo.so.1", &foo_bytes),
                ("/lib/libc.musl-x86_64.so.1", &musl_bytes),
            ],
        )?;

        assert_eq!(image.at_base, LD_BASE);
        assert_eq!(image.so_files.len(), 1);
        assert_eq!(image.so_files[0].host_path, "/usr/lib/libfoo.so.1");
        assert_eq!(image.so_files[0].base_addr, SO_BASE_START);
        assert_eq!(image.brk_start, BRK_START);
        assert_eq!(image.mmap_start, MMAP_START);
        assert_eq!(image.mmap_end, MMAP_END);
        assert_eq!(image.stack_top, STACK_TOP);
        assert_eq!(
            image.dispatch_hash_addr,
            crate::meta::DEFAULT_DISPATCH_HASH_ADDR
        );
        Ok(())
    }

    #[test]
    fn test_node_scale_et_exec_dynamic_va_layout() -> Result<()> {
        // Simulate node:22-slim: 108 MiB ET_EXEC ending at 0x06C0_0000 + ld.so + .so
        let main_bytes = make_minimal_elf64(
            goblin::elf::header::ET_EXEC,
            0x0040_0000,
            0x0040_0000,
            0x0680_0000,
            Some(b"/lib64/ld-linux-x86-64.so.2\0"),
        );
        let ld_bytes = make_minimal_elf64(goblin::elf::header::ET_DYN, 0x1000, 0, 0x4_0000, None);
        let libc_bytes =
            make_minimal_elf64(goblin::elf::header::ET_DYN, 0x1000, 0, 0x50_0000, None);

        let image = load_elf_and_sos_bytes(
            "/usr/local/bin/node",
            &main_bytes,
            &[
                ("/lib64/ld-linux-x86-64.so.2", &ld_bytes),
                ("/lib/x86_64-linux-gnu/libc.so.6", &libc_bytes),
            ],
        )?;

        assert_eq!(image.at_base, 0x06C0_0000);
        assert_eq!(image.so_files.len(), 1);
        assert_eq!(image.so_files[0].base_addr, 0x06C4_0000);
        assert_eq!(image.brk_start, 0x0800_0000);
        assert_eq!(image.mmap_start, 0x0B00_0000);
        assert_eq!(image.mmap_end, 0x1B00_0000);
        assert_eq!(image.stack_top, 0x1BFF_0000);
        assert_eq!(image.dispatch_hash_addr, 0x1C00_0000);
        Ok(())
    }

    #[test]
    fn test_64k_so_va_alignment_40_small_sos() -> Result<()> {
        let main_bytes = make_minimal_elf64(
            goblin::elf::header::ET_DYN,
            0x1000,
            0,
            0x10_0000,
            Some(b"/lib64/ld-linux-x86-64.so.2\0"),
        );
        let ld_bytes = make_minimal_elf64(goblin::elf::header::ET_DYN, 0x1000, 0, 0x4_0000, None);
        let small_so = make_minimal_elf64(goblin::elf::header::ET_DYN, 0x1000, 0, 0x4000, None);

        let names: Vec<String> = (0..40)
            .map(|i| format!("/usr/local/lib/python3.12/lib-dynload/ext{}.so", i))
            .collect();
        let mut sos: Vec<(&str, &[u8])> = vec![("/lib64/ld-linux-x86-64.so.2", &ld_bytes)];
        for n in &names {
            sos.push((n.as_str(), &small_so));
        }

        let image = load_elf_and_sos_bytes("/usr/local/bin/python3.12", &main_bytes, &sos)?;
        assert_eq!(image.so_files.len(), 40);
        for (i, so) in image.so_files.iter().enumerate() {
            assert_eq!(so.base_addr, SO_BASE_START + (i as u32) * SO_ALIGN);
        }
        // 40 * 64 KiB = 2.5 MiB -> still well within legacy layout (<= BRK_START)
        assert_eq!(image.brk_start, BRK_START);
        Ok(())
    }
}
