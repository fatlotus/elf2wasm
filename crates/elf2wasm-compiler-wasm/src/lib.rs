//! WASM-compiled `elf2wasm` compiler (`cdylib`).
//!
//! # Binary Bundle Input Format
//! All multi-byte integers are little-endian `u32`:
//! - `magic`: `[u8; 4]` = `b"E2WB"`
//! - `main_path_len: u32`, `main_path: [u8; main_path_len]` (UTF-8)
//! - `main_bytes_len: u32`, `main_bytes: [u8; main_bytes_len]`
//! - `num_sos: u32`
//! - Repeated `num_sos` times:
//!   - `so_path_len: u32`, `so_path: [u8; so_path_len]` (UTF-8)
//!   - `so_bytes_len: u32`, `so_bytes: [u8; so_bytes_len]`
//!
//! # Output Buffer Format
//! Returned pointer points to `out_len` bytes (written to `*out_len_ptr`):
//! - Byte `0` == `0x00`: success; bytes `1..out_len` are the compiled `.wasm` module.
//! - Byte `0` == `0x01`: error; bytes `1..out_len` are a UTF-8 error message.
//! Caller must free the returned buffer with `dealloc(out_ptr, out_len)`.

use elf2wasm_core::{decoder, elf_loader, wasm_emit};

struct Cursor<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }

    fn remaining(&self) -> usize {
        self.buf.len().saturating_sub(self.pos)
    }

    fn read_bytes(&mut self, len: usize) -> Result<&'a [u8], String> {
        let end = self
            .pos
            .checked_add(len)
            .ok_or_else(|| "bundle length overflow".to_string())?;
        if end > self.buf.len() {
            return Err(format!(
                "truncated bundle: needed {} bytes at offset {}, total {}",
                len,
                self.pos,
                self.buf.len()
            ));
        }
        let slice = &self.buf[self.pos..end];
        self.pos = end;
        Ok(slice)
    }

    fn read_u32(&mut self) -> Result<u32, String> {
        let bytes = self.read_bytes(4)?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    fn read_len_prefixed_bytes(&mut self) -> Result<&'a [u8], String> {
        let len = self.read_u32()? as usize;
        self.read_bytes(len)
    }

    fn read_len_prefixed_str(&mut self) -> Result<&'a str, String> {
        let bytes = self.read_len_prefixed_bytes()?;
        core::str::from_utf8(bytes).map_err(|e| format!("invalid UTF-8 string in bundle: {e}"))
    }
}

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return core::ptr::null_mut();
    }
    let mut buf = Vec::<u8>::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    core::mem::forget(buf);
    ptr
}

#[no_mangle]
pub extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }
    unsafe {
        let _ = Vec::from_raw_parts(ptr, 0, len);
    }
}

fn write_output(out_len_ptr: *mut usize, mut data: Vec<u8>) -> *mut u8 {
    data.shrink_to_fit();
    let out_len = data.len();
    let out_ptr = data.as_mut_ptr();
    core::mem::forget(data);
    unsafe {
        *out_len_ptr = out_len;
    }
    out_ptr
}

fn err_output(out_len_ptr: *mut usize, msg: &str) -> *mut u8 {
    let mut out = Vec::with_capacity(1 + msg.len());
    out.push(0x01);
    out.extend_from_slice(msg.as_bytes());
    write_output(out_len_ptr, out)
}

fn compile_bundle_inner(bundle: &[u8]) -> Result<Vec<u8>, String> {
    let mut cur = Cursor::new(bundle);
    let magic = cur.read_bytes(4)?;
    if magic != b"E2WB" {
        return Err(format!("invalid bundle magic: expected E2WB, got {:?}", magic));
    }

    let main_path = cur.read_len_prefixed_str()?;
    let main_bytes = cur.read_len_prefixed_bytes()?;
    let num_sos = cur.read_u32()? as usize;

    // Each .so entry requires at least 8 bytes (two u32 lengths).
    if num_sos.saturating_mul(8) > cur.remaining() {
        return Err(format!(
            "invalid num_sos={} for remaining {} bytes",
            num_sos,
            cur.remaining()
        ));
    }

    let mut sos = Vec::with_capacity(num_sos);
    for _ in 0..num_sos {
        let so_path = cur.read_len_prefixed_str()?;
        let so_bytes = cur.read_len_prefixed_bytes()?;
        sos.push((so_path, so_bytes));
    }

    let image = elf_loader::load_elf_and_sos_bytes(main_path, main_bytes, &sos)
        .map_err(|e| format!("{:#}", e))?;
    let mut prog = decoder::discover_code(&image).map_err(|e| format!("{:#}", e))?;
    decoder::split_indirect_targets(&image, &mut prog);
    let wasm_bytes = wasm_emit::emit_wasm(&image, &prog).map_err(|e| format!("{:#}", e))?;
    Ok(wasm_bytes)
}

#[no_mangle]
pub extern "C" fn compile_bundle(
    ptr: *const u8,
    len: usize,
    out_len_ptr: *mut usize,
) -> *mut u8 {
    if out_len_ptr.is_null() {
        return core::ptr::null_mut();
    }
    if ptr.is_null() || len == 0 {
        return err_output(out_len_ptr, "empty or null input bundle");
    }
    let bundle = unsafe { core::slice::from_raw_parts(ptr, len) };
    match compile_bundle_inner(bundle) {
        Ok(wasm_bytes) => {
            let mut out = Vec::with_capacity(1 + wasm_bytes.len());
            out.push(0x00);
            out.extend_from_slice(&wasm_bytes);
            write_output(out_len_ptr, out)
        }
        Err(msg) => err_output(out_len_ptr, &msg),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_malformed_bundles_do_not_panic() {
        assert!(compile_bundle_inner(&[]).is_err());
        assert!(compile_bundle_inner(b"BAD!").is_err());
        assert!(compile_bundle_inner(b"E2WB\xff\xff\xff\xff").is_err());
        // Huge num_sos
        let mut buf = Vec::new();
        buf.extend_from_slice(b"E2WB");
        buf.extend_from_slice(&4u32.to_le_bytes());
        buf.extend_from_slice(b"main");
        buf.extend_from_slice(&0u32.to_le_bytes());
        buf.extend_from_slice(&0xFFFF_FFFFu32.to_le_bytes());
        assert!(compile_bundle_inner(&buf).is_err());
    }
}
