use anyhow::{bail, Result};

#[derive(Debug, Clone)]
pub struct MetaSoFile {
    pub guest_paths: Vec<String>,
    pub base_addr: u32,
    pub bytes: Vec<u8>,
}

pub const DEFAULT_BRK_START: u32 = 0x0500_0000;
pub const DEFAULT_MMAP_START: u32 = 0x0800_0000;
pub const DEFAULT_MMAP_END: u32 = 0x0B00_0000;
pub const DEFAULT_STACK_TOP: u32 = 0x0BFF_0000;
pub const DEFAULT_DISPATCH_HASH_ADDR: u32 = 0x0C00_0000;

#[derive(Debug, Clone)]
pub struct WasmMeta {
    pub entry_rip: u32,
    pub at_phdr: u32,
    pub at_phent: u32,
    pub at_phnum: u32,
    pub at_entry: u32,
    pub at_base: u32,
    pub max_code_addr: u32,
    pub so_files: Vec<MetaSoFile>,
    pub symbols: Vec<(u32, String)>,
    pub elf_path: String,
    pub brk_start: u32,
    pub mmap_start: u32,
    pub mmap_end: u32,
    pub stack_top: u32,
    pub dispatch_hash_addr: u32,
}

const MAGIC: &[u8; 8] = b"ELF2WASM";

fn write_u32(buf: &mut Vec<u8>, v: u32) {
    buf.extend_from_slice(&v.to_le_bytes());
}

fn write_str(buf: &mut Vec<u8>, s: &str) {
    write_u32(buf, s.len() as u32);
    buf.extend_from_slice(s.as_bytes());
}

fn read_u32(data: &[u8], pos: &mut usize) -> Result<u32> {
    let end = pos
        .checked_add(4)
        .filter(|&e| e <= data.len())
        .ok_or_else(|| anyhow::anyhow!("Unexpected EOF reading u32 in elf2wasm_meta"))?;
    let v = u32::from_le_bytes(data[*pos..end].try_into().unwrap());
    *pos = end;
    Ok(v)
}

fn read_str(data: &[u8], pos: &mut usize) -> Result<String> {
    let len = read_u32(data, pos)? as usize;
    let end = pos
        .checked_add(len)
        .filter(|&e| e <= data.len())
        .ok_or_else(|| anyhow::anyhow!("Unexpected EOF reading string in elf2wasm_meta"))?;
    let s = String::from_utf8(data[*pos..end].to_vec())?;
    *pos = end;
    Ok(s)
}

impl WasmMeta {
    pub fn encode(&self) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(MAGIC);
        write_u32(&mut buf, self.entry_rip);
        write_u32(&mut buf, self.at_phdr);
        write_u32(&mut buf, self.at_phent);
        write_u32(&mut buf, self.at_phnum);
        write_u32(&mut buf, self.at_entry);
        write_u32(&mut buf, self.at_base);
        write_u32(&mut buf, self.max_code_addr);

        write_u32(&mut buf, self.so_files.len() as u32);
        for so in &self.so_files {
            write_u32(&mut buf, so.base_addr);
            write_u32(&mut buf, so.guest_paths.len() as u32);
            for gp in &so.guest_paths {
                write_str(&mut buf, gp);
            }
            write_u32(&mut buf, so.bytes.len() as u32);
            buf.extend_from_slice(&so.bytes);
        }

        write_u32(&mut buf, self.symbols.len() as u32);
        for (addr, name) in &self.symbols {
            write_u32(&mut buf, *addr);
            write_str(&mut buf, name);
        }
        write_str(&mut buf, &self.elf_path);
        write_u32(&mut buf, self.brk_start);
        write_u32(&mut buf, self.mmap_start);
        write_u32(&mut buf, self.mmap_end);
        write_u32(&mut buf, self.stack_top);
        write_u32(&mut buf, self.dispatch_hash_addr);
        buf
    }

    pub fn decode(data: &[u8]) -> Result<Self> {
        if data.len() < 8 || &data[0..8] != MAGIC {
            bail!("Invalid elf2wasm_meta magic");
        }
        let mut pos = 8;
        let entry_rip = read_u32(data, &mut pos)?;
        let at_phdr = read_u32(data, &mut pos)?;
        let at_phent = read_u32(data, &mut pos)?;
        let at_phnum = read_u32(data, &mut pos)?;
        let at_entry = read_u32(data, &mut pos)?;
        let at_base = read_u32(data, &mut pos)?;
        let max_code_addr = read_u32(data, &mut pos)?;

        let num_so = read_u32(data, &mut pos)? as usize;
        let remaining = data.len() - pos;
        if num_so > remaining / 12 {
            bail!(
                "num_so ({}) exceeds remaining elf2wasm_meta bytes ({})",
                num_so,
                remaining
            );
        }
        let mut so_files = Vec::with_capacity(num_so);
        for _ in 0..num_so {
            let base_addr = read_u32(data, &mut pos)?;
            let num_gp = read_u32(data, &mut pos)? as usize;
            let remaining_gp = data.len() - pos;
            if num_gp > remaining_gp / 4 {
                bail!(
                    "num_gp ({}) exceeds remaining elf2wasm_meta bytes ({})",
                    num_gp,
                    remaining_gp
                );
            }
            let mut guest_paths = Vec::with_capacity(num_gp);
            for _ in 0..num_gp {
                guest_paths.push(read_str(data, &mut pos)?);
            }
            let blen = read_u32(data, &mut pos)? as usize;
            let end = pos
                .checked_add(blen)
                .filter(|&e| e <= data.len())
                .ok_or_else(|| anyhow::anyhow!("Unexpected EOF reading .so bytes"))?;
            let bytes = data[pos..end].to_vec();
            pos = end;
            so_files.push(MetaSoFile {
                guest_paths,
                base_addr,
                bytes,
            });
        }

        let num_sym = read_u32(data, &mut pos)? as usize;
        let remaining_sym = data.len() - pos;
        if num_sym > remaining_sym / 8 {
            bail!(
                "num_sym ({}) exceeds remaining elf2wasm_meta bytes ({})",
                num_sym,
                remaining_sym
            );
        }
        let mut symbols = Vec::with_capacity(num_sym);
        for _ in 0..num_sym {
            let addr = read_u32(data, &mut pos)?;
            let name = read_str(data, &mut pos)?;
            symbols.push((addr, name));
        }

        let elf_path = if pos < data.len() {
            read_str(data, &mut pos)?
        } else {
            String::new()
        };

        let (brk_start, mmap_start, mmap_end, stack_top, dispatch_hash_addr) = if pos < data.len() {
            (
                read_u32(data, &mut pos)?,
                read_u32(data, &mut pos)?,
                read_u32(data, &mut pos)?,
                read_u32(data, &mut pos)?,
                read_u32(data, &mut pos)?,
            )
        } else {
            (
                DEFAULT_BRK_START,
                DEFAULT_MMAP_START,
                DEFAULT_MMAP_END,
                DEFAULT_STACK_TOP,
                DEFAULT_DISPATCH_HASH_ADDR,
            )
        };

        Ok(Self {
            entry_rip,
            at_phdr,
            at_phent,
            at_phnum,
            at_entry,
            at_base,
            max_code_addr,
            so_files,
            symbols,
            elf_path,
            brk_start,
            mmap_start,
            mmap_end,
            stack_top,
            dispatch_hash_addr,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_meta_decode_edge_cases() {
        assert!(WasmMeta::decode(b"").is_err());
        assert!(WasmMeta::decode(b"BADMAGIC").is_err());
        assert!(WasmMeta::decode(b"ELF2WASM\x00\x00").is_err());

        // num_so = u32::MAX must return Err, never panic/OOM
        let mut bad_so = Vec::from(*b"ELF2WASM");
        bad_so.extend_from_slice(&[0u8; 7 * 4]);
        bad_so.extend_from_slice(&u32::MAX.to_le_bytes());
        assert!(WasmMeta::decode(&bad_so).is_err());

        // num_sym = u32::MAX must return Err, never panic/OOM
        let mut bad_sym = Vec::from(*b"ELF2WASM");
        bad_sym.extend_from_slice(&[0u8; 7 * 4]);
        bad_sym.extend_from_slice(&0u32.to_le_bytes()); // num_so = 0
        bad_sym.extend_from_slice(&u32::MAX.to_le_bytes()); // num_sym = u32::MAX
        assert!(WasmMeta::decode(&bad_sym).is_err());
    }

    #[test]
    fn test_meta_layout_roundtrip_and_legacy_defaults() {
        let meta = WasmMeta {
            entry_rip: 0x06C0_1000,
            at_phdr: 0x0040_0040,
            at_phent: 56,
            at_phnum: 9,
            at_entry: 0x0040_1000,
            at_base: 0x06C0_0000,
            max_code_addr: 0x0760_0000,
            so_files: vec![],
            symbols: vec![(0x0040_1000, "_start".to_string())],
            elf_path: "/usr/local/bin/node".to_string(),
            brk_start: 0x0800_0000,
            mmap_start: 0x0B00_0000,
            mmap_end: 0x1B00_0000,
            stack_top: 0x1BFF_0000,
            dispatch_hash_addr: 0x1C00_0000,
        };
        let encoded = meta.encode();
        let decoded = WasmMeta::decode(&encoded).expect("round-trip decode should succeed");
        assert_eq!(decoded.elf_path, "/usr/local/bin/node");
        assert_eq!(decoded.brk_start, 0x0800_0000);
        assert_eq!(decoded.mmap_start, 0x0B00_0000);
        assert_eq!(decoded.mmap_end, 0x1B00_0000);
        assert_eq!(decoded.stack_top, 0x1BFF_0000);
        assert_eq!(decoded.dispatch_hash_addr, 0x1C00_0000);

        // Legacy buffer ending right after elf_path (20 trailing layout bytes stripped)
        let legacy_encoded = &encoded[..encoded.len() - 20];
        let legacy = WasmMeta::decode(legacy_encoded).expect("legacy decode should succeed");
        assert_eq!(legacy.elf_path, "/usr/local/bin/node");
        assert_eq!(legacy.brk_start, DEFAULT_BRK_START);
        assert_eq!(legacy.mmap_start, DEFAULT_MMAP_START);
        assert_eq!(legacy.mmap_end, DEFAULT_MMAP_END);
        assert_eq!(legacy.stack_top, DEFAULT_STACK_TOP);
        assert_eq!(legacy.dispatch_hash_addr, DEFAULT_DISPATCH_HASH_ADDR);
    }
}
