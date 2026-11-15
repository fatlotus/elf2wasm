use elf2wasm_core::decoder::{discover_code, split_indirect_targets, BlockTerminator, DecodedProgram};
use elf2wasm_core::elf_loader::{
    DataSegment, ExecSegment, LoadedImage, SoFile, INITIAL_MEM_PAGES,
};
use elf2wasm_core::lifter::{CTX_SIZE, DEFAULT_QUANTUM};
use elf2wasm_core::meta::{MetaSoFile, WasmMeta};
use elf2wasm_core::wasm_emit::{emit_wasm, DISPATCH_HASH_ADDR};
use elf2wasm_runtime_core::context::GuestContext;
use elf2wasm_runtime_core::scheduler::{
    Scheduler, ThreadContext, ThreadState, MAIN_PID, MAIN_TID, QUANTUM_TIME_STEP_NS,
};
use elf2wasm_runtime_core::syscalls::{handle_syscall, HostState, PendingHostAction};
use elf2wasm_runtime_core::vfs::{
    VirtualFs, AT_FDCWD, AT_REMOVEDIR, EACCES, EAGAIN, ECHILD, EFAULT, EINVAL, ENOSYS, ENOTDIR,
    ENOTEMPTY, EPIPE, ESPIPE, ETIMEDOUT, O_APPEND, O_CLOEXEC, O_CREAT, O_NONBLOCK, O_RDONLY,
    O_RDWR, O_TRUNC, O_WRONLY, PIPE_CAPACITY,
};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use wasmtime::{Caller, Engine, Linker, Module as WasmModule, Store, Val};

fn repo_root() -> PathBuf {
    PathBuf::from(option_env!("CARGO_MANIFEST_DIR").unwrap_or("/home/antigravity/elf2wasm"))
}

fn compiler_wasm_path() -> PathBuf {
    repo_root().join("target/wasm32-unknown-unknown/release/elf2wasm_compiler_wasm.wasm")
}

fn runtime_wasm_path() -> PathBuf {
    repo_root().join("target/wasm32-unknown-unknown/release/elf2wasm_runtime_wasm.wasm")
}

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
    buf[20..24].copy_from_slice(&1u32.to_le_bytes());
    buf[24..32].copy_from_slice(&e_entry.to_le_bytes());
    buf[32..40].copy_from_slice(&64u64.to_le_bytes());
    buf[52..54].copy_from_slice(&64u16.to_le_bytes());
    buf[54..56].copy_from_slice(&56u16.to_le_bytes());
    buf[56..58].copy_from_slice(&1u16.to_le_bytes());

    let ph = &mut buf[64..120];
    ph[0..4].copy_from_slice(&1u32.to_le_bytes()); // PT_LOAD
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

fn build_e2wb_bundle(main_path: &[u8], main_bytes: &[u8], sos: &[(&[u8], &[u8])]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(b"E2WB");
    out.extend_from_slice(&(main_path.len() as u32).to_le_bytes());
    out.extend_from_slice(main_path);
    out.extend_from_slice(&(main_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(main_bytes);
    out.extend_from_slice(&(sos.len() as u32).to_le_bytes());
    for &(sp, sb) in sos {
        out.extend_from_slice(&(sp.len() as u32).to_le_bytes());
        out.extend_from_slice(sp);
        out.extend_from_slice(&(sb.len() as u32).to_le_bytes());
        out.extend_from_slice(sb);
    }
    out
}

fn synth_image(entry_rip: u32, code: Vec<u8>) -> LoadedImage {
    LoadedImage {
        entry_rip,
        at_phdr: 0,
        at_phent: 56,
        at_phnum: 0,
        at_entry: entry_rip,
        at_base: 0,
        exec_segments: vec![ExecSegment {
            name: "synth".to_string(),
            vaddr: entry_rip,
            data: code,
        }],
        data_segments: vec![],
        so_files: vec![],
        symbols: HashMap::new(),
        elf_path: "synth".to_string(),
    }
}

// ============================================================================
// 1. elf2wasm-compiler-wasm (C-ABI & E2WB bundle parsing)
// ============================================================================

#[test]
fn test_t5_v2_compiler_wasm_alloc_dealloc_and_null_guards() {
    let wasm_path = compiler_wasm_path();
    if !wasm_path.exists() {
        return;
    }
    let engine = Engine::default();
    let module = WasmModule::from_file(&engine, &wasm_path).unwrap();
    let mut store = Store::new(&engine, ());
    let linker = Linker::new(&engine);
    let inst = linker.instantiate(&mut store, &module).unwrap();

    let mem = inst.get_memory(&mut store, "memory").unwrap();
    let alloc = inst.get_typed_func::<i32, i32>(&mut store, "alloc").unwrap();
    let dealloc = inst.get_typed_func::<(i32, i32), ()>(&mut store, "dealloc").unwrap();
    let compile_bundle = inst
        .get_typed_func::<(i32, i32, i32), i32>(&mut store, "compile_bundle")
        .unwrap();

    assert_eq!(alloc.call(&mut store, 0).unwrap(), 0);
    dealloc.call(&mut store, (0, 0)).unwrap();
    dealloc.call(&mut store, (0, 128)).unwrap();

    let p = alloc.call(&mut store, 256).unwrap();
    assert_ne!(p, 0);
    dealloc.call(&mut store, (p, 0)).unwrap();
    dealloc.call(&mut store, (p, 256)).unwrap();

    assert_eq!(compile_bundle.call(&mut store, (0, 0, 0)).unwrap(), 0);

    let out_len_ptr = alloc.call(&mut store, 4).unwrap();
    assert_ne!(out_len_ptr, 0);

    let out_ptr = compile_bundle.call(&mut store, (0, 16, out_len_ptr)).unwrap();
    assert_ne!(out_ptr, 0);
    let mut len_bytes = [0u8; 4];
    mem.read(&store, out_len_ptr as usize, &mut len_bytes).unwrap();
    let out_len = u32::from_le_bytes(len_bytes) as usize;
    assert!(out_len > 1);
    let mut msg = vec![0u8; out_len];
    mem.read(&store, out_ptr as usize, &mut msg).unwrap();
    assert_eq!(msg[0], 0x01);
    assert!(std::str::from_utf8(&msg[1..]).unwrap().contains("empty or null"));
    dealloc.call(&mut store, (out_ptr, out_len as i32)).unwrap();

    let in_ptr = alloc.call(&mut store, 8).unwrap();
    let out_ptr2 = compile_bundle
        .call(&mut store, (in_ptr, 0, out_len_ptr))
        .unwrap();
    assert_ne!(out_ptr2, 0);
    mem.read(&store, out_len_ptr as usize, &mut len_bytes).unwrap();
    let out_len2 = u32::from_le_bytes(len_bytes) as usize;
    assert!(out_len2 > 1);
    let mut msg2 = vec![0u8; out_len2];
    mem.read(&store, out_ptr2 as usize, &mut msg2).unwrap();
    assert_eq!(msg2[0], 0x01);
    dealloc.call(&mut store, (out_ptr2, out_len2 as i32)).unwrap();
    dealloc.call(&mut store, (in_ptr, 8)).unwrap();
    dealloc.call(&mut store, (out_len_ptr, 4)).unwrap();
}

#[test]
fn test_t5_v2_compiler_wasm_e2wb_malformed_and_valid_roundtrip() {
    let wasm_path = compiler_wasm_path();
    if !wasm_path.exists() {
        return;
    }
    let engine = Engine::default();
    let module = WasmModule::from_file(&engine, &wasm_path).unwrap();
    let mut store = Store::new(&engine, ());
    let linker = Linker::new(&engine);
    let inst = linker.instantiate(&mut store, &module).unwrap();

    let mem = inst.get_memory(&mut store, "memory").unwrap();
    let alloc = inst.get_typed_func::<i32, i32>(&mut store, "alloc").unwrap();
    let dealloc = inst.get_typed_func::<(i32, i32), ()>(&mut store, "dealloc").unwrap();
    let compile_bundle = inst
        .get_typed_func::<(i32, i32, i32), i32>(&mut store, "compile_bundle")
        .unwrap();
    let out_len_ptr = alloc.call(&mut store, 4).unwrap();

    let invoke = |store: &mut Store<()>, bundle: &[u8]| -> (u8, Vec<u8>) {
        let in_ptr = alloc.call(&mut *store, bundle.len() as i32).unwrap();
        mem.write(&mut *store, in_ptr as usize, bundle).unwrap();
        let out_ptr = compile_bundle
            .call(&mut *store, (in_ptr, bundle.len() as i32, out_len_ptr))
            .unwrap();
        assert_ne!(out_ptr, 0);
        let mut len_bytes = [0u8; 4];
        mem.read(&*store, out_len_ptr as usize, &mut len_bytes).unwrap();
        let out_len = u32::from_le_bytes(len_bytes) as usize;
        assert!(out_len >= 1);
        let mut out = vec![0u8; out_len];
        mem.read(&*store, out_ptr as usize, &mut out).unwrap();
        dealloc.call(&mut *store, (out_ptr, out_len as i32)).unwrap();
        dealloc
            .call(&mut *store, (in_ptr, bundle.len() as i32))
            .unwrap();
        (out[0], out[1..].to_vec())
    };

    for bad in [&b"E2W"[..], &b"BAD!"[..], &b"E2WB\xff\xff\xff\xff"[..]] {
        let (status, msg) = invoke(&mut store, bad);
        assert_eq!(status, 0x01);
        assert!(!msg.is_empty());
    }

    let bad_utf8 = build_e2wb_bundle(&[0xff, 0xfe, 0x80], b"", &[]);
    let (status, msg) = invoke(&mut store, &bad_utf8);
    assert_eq!(status, 0x01);
    assert!(std::str::from_utf8(&msg).unwrap().contains("UTF-8"));

    let mut huge_sos = build_e2wb_bundle(b"/bin/app", b"", &[]);
    let n = huge_sos.len();
    huge_sos[n - 4..n].copy_from_slice(&u32::MAX.to_le_bytes());
    let (status, msg) = invoke(&mut store, &huge_sos);
    assert_eq!(status, 0x01);
    assert!(std::str::from_utf8(&msg).unwrap().contains("num_sos"));

    let mut so_overflow = Vec::new();
    so_overflow.extend_from_slice(b"E2WB");
    so_overflow.extend_from_slice(&4u32.to_le_bytes());
    so_overflow.extend_from_slice(b"main");
    so_overflow.extend_from_slice(&0u32.to_le_bytes());
    so_overflow.extend_from_slice(&1u32.to_le_bytes());
    so_overflow.extend_from_slice(&4u32.to_le_bytes());
    so_overflow.extend_from_slice(b"a.so");
    so_overflow.extend_from_slice(&u32::MAX.to_le_bytes());
    let (status, _) = invoke(&mut store, &so_overflow);
    assert_eq!(status, 0x01);

    let bad_so_utf8 = build_e2wb_bundle(b"/bin/app", b"", &[(&[0xff, 0xc0], b"")]);
    let (status, msg) = invoke(&mut store, &bad_so_utf8);
    assert_eq!(status, 0x01);
    assert!(std::str::from_utf8(&msg).unwrap().contains("UTF-8"));

    let minimal_elf =
        build_minimal_elf64(2, 62, 0x400078, 5, 0, 0x400000, 124, 124, &[0xc3, 0, 0, 0]);
    let valid_bundle = build_e2wb_bundle(b"/bin/minimal", &minimal_elf, &[]);
    let (status, compiled_wasm) = invoke(&mut store, &valid_bundle);
    assert_eq!(
        status,
        0x00,
        "expected success, got error: {}",
        String::from_utf8_lossy(&compiled_wasm)
    );
    assert!(compiled_wasm.starts_with(b"\0asm\x01\x00\x00\x00"));
    WasmModule::new(&engine, &compiled_wasm).expect("compiled WASM must validate");

    dealloc.call(&mut store, (out_len_ptr, 4)).unwrap();
}

// ============================================================================
// 2. elf2wasm-core::decoder
// ============================================================================

#[test]
fn test_t5_v2_decoder_split_mem_read_write_blocks_boundaries() {
    let code = vec![
        0x8b, 0x07, // mov eax, [rdi]
        0x89, 0x06, // mov [rsi], eax
        0x8b, 0x44, 0x24, 0x08, // mov eax, [rsp+8]
        0x89, 0x06, // mov [rsi], eax
        0x8b, 0x07, // mov eax, [rdi]
        0x89, 0x45, 0xf8, // mov [rbp-8], eax
        0x48, 0x8d, 0x47, 0x08, // lea rax, [rdi+8]
        0x48, 0x89, 0x06, // mov [rsi], rax
        0x83, 0x3f, 0x00, // cmp dword ptr [rdi], 0
        0xc7, 0x07, 0x01, 0x00, 0x00, 0x00, // mov dword ptr [rdi], 1
        0xc3, // ret
    ];
    let image = synth_image(0x1000, code);
    let prog = discover_code(&image).unwrap();

    assert!(prog.blocks.contains_key(&0x1000));
    assert!(prog.blocks.contains_key(&0x1002));
    assert!(!prog.blocks.contains_key(&0x1008));
    assert!(!prog.blocks.contains_key(&0x100c));
    assert!(prog.blocks.contains_key(&0x1013));
    assert!(prog.blocks.contains_key(&0x1019));

    assert_eq!(prog.blocks[&0x1000].terminator, BlockTerminator::Fallthrough(0x1002));
    assert_eq!(prog.blocks[&0x1002].terminator, BlockTerminator::Fallthrough(0x1013));
    assert_eq!(prog.blocks[&0x1013].terminator, BlockTerminator::Fallthrough(0x1019));
    assert_eq!(prog.blocks[&0x1019].terminator, BlockTerminator::Return);
}

#[test]
fn test_t5_v2_decoder_pt_dynamic_dt_init_fini_and_malformed_offset() {
    let mut so_bytes = vec![0u8; 0x200];
    so_bytes[0..4].copy_from_slice(b"\x7fELF");
    so_bytes[4] = 2;
    so_bytes[5] = 1;
    so_bytes[6] = 1;
    so_bytes[16..18].copy_from_slice(&3u16.to_le_bytes());
    so_bytes[18..20].copy_from_slice(&62u16.to_le_bytes());
    so_bytes[20..24].copy_from_slice(&1u32.to_le_bytes());
    so_bytes[32..40].copy_from_slice(&64u64.to_le_bytes());
    so_bytes[52..54].copy_from_slice(&64u16.to_le_bytes());
    so_bytes[54..56].copy_from_slice(&56u16.to_le_bytes());
    so_bytes[56..58].copy_from_slice(&2u16.to_le_bytes());

    let ph0 = &mut so_bytes[64..120];
    ph0[0..4].copy_from_slice(&1u32.to_le_bytes());
    ph0[4..8].copy_from_slice(&5u32.to_le_bytes());
    ph0[32..40].copy_from_slice(&0x200u64.to_le_bytes());
    ph0[40..48].copy_from_slice(&0x200u64.to_le_bytes());

    let ph1 = &mut so_bytes[120..176];
    ph1[0..4].copy_from_slice(&2u32.to_le_bytes());
    ph1[8..16].copy_from_slice(&0x120u64.to_le_bytes());
    ph1[16..24].copy_from_slice(&0x120u64.to_le_bytes());
    ph1[32..40].copy_from_slice(&48u64.to_le_bytes());
    ph1[40..48].copy_from_slice(&48u64.to_le_bytes());

    so_bytes[0x100] = 0xc3;
    so_bytes[0x110] = 0xc3;

    so_bytes[0x120..0x128].copy_from_slice(&12i64.to_le_bytes());
    so_bytes[0x128..0x130].copy_from_slice(&0x100u64.to_le_bytes());
    so_bytes[0x130..0x138].copy_from_slice(&13i64.to_le_bytes());
    so_bytes[0x138..0x140].copy_from_slice(&0x110u64.to_le_bytes());

    let mut bad_so_bytes = so_bytes.clone();
    bad_so_bytes[120 + 8..120 + 16].copy_from_slice(&0xFFFF_FFF0u64.to_le_bytes());

    let so_base = 0x0200_0000u32;
    let image = LoadedImage {
        entry_rip: 0x0010_0000,
        at_phdr: 0,
        at_phent: 56,
        at_phnum: 0,
        at_entry: 0x0010_0000,
        at_base: 0,
        exec_segments: vec![
            ExecSegment {
                name: "main".to_string(),
                vaddr: 0x0010_0000,
                data: vec![0xc3],
            },
            ExecSegment {
                name: "so_text".to_string(),
                vaddr: so_base + 0x100,
                data: vec![0xc3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xc3],
            },
        ],
        data_segments: vec![],
        so_files: vec![
            SoFile {
                host_path: "good.so".to_string(),
                guest_paths: vec!["/lib/good.so".to_string()],
                base_addr: so_base,
                bytes: so_bytes,
            },
            SoFile {
                host_path: "bad.so".to_string(),
                guest_paths: vec!["/lib/bad.so".to_string()],
                base_addr: 0x0300_0000,
                bytes: bad_so_bytes,
            },
        ],
        symbols: HashMap::new(),
        elf_path: "main".to_string(),
    };

    let prog = discover_code(&image).unwrap();
    assert!(prog.blocks.contains_key(&(so_base + 0x100)));
    assert!(prog.blocks.contains_key(&(so_base + 0x110)));
}

#[test]
fn test_t5_v2_decoder_split_indirect_targets_jump_table_and_endbr64() {
    let disp: i32 = 0x0020_0000 - 0x0010_0007;
    let mut code = vec![0x48, 0x8d, 0x05];
    code.extend_from_slice(&disp.to_le_bytes());
    code.extend_from_slice(&[
        0x90,                   // nop
        0x31, 0xc0,             // xor eax, eax
        0xf3, 0x0f, 0x1e, 0xfa, // endbr64
        0x0f, 0x05,             // syscall
        0xc3,                   // ret
    ]);

    let mut table = Vec::new();
    table.extend_from_slice(&(0x0010_0008i32 - 0x0020_0000i32).to_le_bytes());
    table.extend_from_slice(&0i32.to_le_bytes());

    let image = LoadedImage {
        entry_rip: 0x0010_0000,
        at_phdr: 0,
        at_phent: 56,
        at_phnum: 0,
        at_entry: 0x0010_0000,
        at_base: 0,
        exec_segments: vec![ExecSegment {
            name: "main".to_string(),
            vaddr: 0x0010_0000,
            data: code,
        }],
        data_segments: vec![DataSegment {
            vaddr: 0x0020_0000,
            data: table,
        }],
        so_files: vec![],
        symbols: HashMap::new(),
        elf_path: "main".to_string(),
    };

    let mut prog = discover_code(&image).unwrap();
    split_indirect_targets(&image, &mut prog);

    for expected in [0x0010_0000u32, 0x0010_0008, 0x0010_000a, 0x0010_0010] {
        assert!(prog.blocks.contains_key(&expected));
        assert!(prog.indirect_targets.binary_search(&expected).is_ok());
    }
}

// ============================================================================
// 3. elf2wasm-core::wasm_emit & lifter
// ============================================================================

#[test]
fn test_t5_v2_wasm_emit_quantum_boundaries_and_high_rip_trap() {
    let code = vec![0x48, 0xff, 0xc9, 0x75, 0xfb, 0xc3];
    let image = synth_image(0x0010_0000, code);
    let prog = discover_code(&image).unwrap();
    let wasm_bytes = emit_wasm(&image, &prog).unwrap();

    let engine = Engine::default();
    let module = WasmModule::new(&engine, &wasm_bytes).unwrap();
    let mut linker: Linker<()> = Linker::new(&engine);
    linker
        .func_wrap(
            "env",
            "syscall",
            |_: Caller<'_, ()>, _: i64, _: i64, _: i64, _: i64, _: i64, _: i64, _: i64| -> i64 {
                -38
            },
        )
        .unwrap();
    let mut store = Store::new(&engine, ());
    let inst = linker.instantiate(&mut store, &module).unwrap();
    let start = inst.get_typed_func::<(), i32>(&mut store, "_start").unwrap();

    inst.get_global(&mut store, "rip").unwrap().set(&mut store, Val::I64(0x0010_0000)).unwrap();
    inst.get_global(&mut store, "yield_flag").unwrap().set(&mut store, Val::I32(1)).unwrap();
    inst.get_global(&mut store, "quantum").unwrap().set(&mut store, Val::I32(10)).unwrap();
    let _ = start.call(&mut store, ()).unwrap();
    assert_eq!(inst.get_global(&mut store, "quantum").unwrap().get(&mut store).i32(), Some(10));
    assert_eq!(inst.get_global(&mut store, "rip").unwrap().get(&mut store).i64(), Some(0x0010_0000));

    inst.get_global(&mut store, "yield_flag").unwrap().set(&mut store, Val::I32(0)).unwrap();
    inst.get_global(&mut store, "quantum").unwrap().set(&mut store, Val::I32(0)).unwrap();
    let _ = start.call(&mut store, ()).unwrap();
    assert_eq!(inst.get_global(&mut store, "yield_flag").unwrap().get(&mut store).i32(), Some(2));

    inst.get_global(&mut store, "yield_flag").unwrap().set(&mut store, Val::I32(0)).unwrap();
    inst.get_global(&mut store, "quantum").unwrap().set(&mut store, Val::I32(1)).unwrap();
    inst.get_global(&mut store, "rcx").unwrap().set(&mut store, Val::I64(5)).unwrap();
    let _ = start.call(&mut store, ()).unwrap();
    assert_eq!(inst.get_global(&mut store, "yield_flag").unwrap().get(&mut store).i32(), Some(2));
    assert_eq!(inst.get_global(&mut store, "rcx").unwrap().get(&mut store).i64(), Some(4));

    inst.get_global(&mut store, "yield_flag").unwrap().set(&mut store, Val::I32(0)).unwrap();
    inst.get_global(&mut store, "quantum").unwrap().set(&mut store, Val::I32(DEFAULT_QUANTUM)).unwrap();
    inst.get_global(&mut store, "rip").unwrap().set(&mut store, Val::I64(0x1_0000_0000)).unwrap();
    assert!(start.call(&mut store, ()).is_err());
}

#[test]
fn test_t5_v2_save_ctx_load_ctx_oob_trap_and_unaligned() {
    let image = synth_image(0x0010_0000, vec![0xc3]);
    let prog = discover_code(&image).unwrap();
    let wasm_bytes = emit_wasm(&image, &prog).unwrap();

    let engine = Engine::default();
    let module = WasmModule::new(&engine, &wasm_bytes).unwrap();
    let mut linker: Linker<()> = Linker::new(&engine);
    linker
        .func_wrap(
            "env",
            "syscall",
            |_: Caller<'_, ()>, _: i64, _: i64, _: i64, _: i64, _: i64, _: i64, _: i64| -> i64 {
                -38
            },
        )
        .unwrap();
    let mut store = Store::new(&engine, ());
    let inst = linker.instantiate(&mut store, &module).unwrap();
    let mem = inst.get_memory(&mut store, "memory").unwrap();
    let mem_bytes = mem.data_size(&store) as i32;
    assert!(mem_bytes >= (INITIAL_MEM_PAGES as i32) * 65536);

    let save_ctx = inst.get_typed_func::<i32, ()>(&mut store, "save_ctx").unwrap();
    let load_ctx = inst.get_typed_func::<i32, ()>(&mut store, "load_ctx").unwrap();

    inst.get_global(&mut store, "r15")
        .unwrap()
        .set(&mut store, Val::I64(0xDEAD_BEEF_CAFE_BABEu64 as i64))
        .unwrap();
    save_ctx.call(&mut store, 0x0020_0001).unwrap();
    inst.get_global(&mut store, "r15").unwrap().set(&mut store, Val::I64(0)).unwrap();
    load_ctx.call(&mut store, 0x0020_0001).unwrap();
    assert_eq!(
        inst.get_global(&mut store, "r15").unwrap().get(&mut store).i64(),
        Some(0xDEAD_BEEF_CAFE_BABEu64 as i64)
    );

    let oob_ptr = mem_bytes - (CTX_SIZE as i32 - 4);
    assert!(save_ctx.call(&mut store, oob_ptr).is_err());
    assert!(load_ctx.call(&mut store, oob_ptr).is_err());
}

#[test]
fn test_t5_v2_emit_wasm_empty_program_validates() {
    let image = synth_image(0, vec![]);
    let prog = DecodedProgram {
        entry_rip: 0,
        max_code_addr: 0,
        blocks: BTreeMap::new(),
        functions: BTreeMap::new(),
        indirect_targets: vec![],
        instr_to_block: Default::default(),
    };
    let wasm_bytes = emit_wasm(&image, &prog).unwrap();
    let engine = Engine::default();
    let module = WasmModule::new(&engine, &wasm_bytes).unwrap();
    let mut linker: Linker<()> = Linker::new(&engine);
    linker
        .func_wrap(
            "env",
            "syscall",
            |_: Caller<'_, ()>, _: i64, _: i64, _: i64, _: i64, _: i64, _: i64, _: i64| -> i64 {
                -38
            },
        )
        .unwrap();
    let mut store = Store::new(&engine, ());
    let inst = linker.instantiate(&mut store, &module).unwrap();
    let mem = inst.get_memory(&mut store, "memory").unwrap();
    assert!(mem.size(&store) >= INITIAL_MEM_PAGES as u64);
    assert!(mem.data_size(&store) as u32 >= DISPATCH_HASH_ADDR + 128);
    let start = inst.get_typed_func::<(), i32>(&mut store, "_start").unwrap();
    assert_eq!(start.call(&mut store, ()).unwrap(), 0);
}

// ============================================================================
// 4. elf2wasm-runtime-wasm (C-ABI exports, bounds, VFS, exec/fork transitions)
// ============================================================================

struct MockRuntimeHost {
    guest_mem: Vec<u8>,
    globals: [i64; 9],
    fail_mem_io: bool,
}

impl MockRuntimeHost {
    fn new(guest_mem_size: usize) -> Self {
        let mut globals = [0i64; 9];
        globals[8] = DEFAULT_QUANTUM as i64;
        Self {
            guest_mem: vec![0u8; guest_mem_size],
            globals,
            fail_mem_io: false,
        }
    }
}

fn instantiate_runtime_wasm(
    engine: &Engine,
    module: &WasmModule,
    guest_mem_size: usize,
) -> (Store<MockRuntimeHost>, wasmtime::Instance) {
    let mut linker = Linker::<MockRuntimeHost>::new(engine);

    linker
        .func_wrap("env", "host_mem_size", |caller: Caller<'_, MockRuntimeHost>| -> i32 {
            caller.data().guest_mem.len() as i32
        })
        .unwrap();

    linker
        .func_wrap(
            "env",
            "host_read_guest",
            |mut caller: Caller<'_, MockRuntimeHost>, gaddr: i32, rt_ptr: i32, len: i32| -> i32 {
                if caller.data().fail_mem_io {
                    return -1;
                }
                let ga = gaddr as u32 as usize;
                let l = len as u32 as usize;
                let Some(end) = ga.checked_add(l) else {
                    return -1;
                };
                if end > caller.data().guest_mem.len() {
                    return -1;
                }
                let bytes = caller.data().guest_mem[ga..end].to_vec();
                let mem = caller.get_export("memory").unwrap().into_memory().unwrap();
                if mem.write(&mut caller, rt_ptr as u32 as usize, &bytes).is_err() {
                    return -1;
                }
                0
            },
        )
        .unwrap();

    linker
        .func_wrap(
            "env",
            "host_write_guest",
            |mut caller: Caller<'_, MockRuntimeHost>, gaddr: i32, rt_ptr: i32, len: i32| -> i32 {
                if caller.data().fail_mem_io {
                    return -1;
                }
                let ga = gaddr as u32 as usize;
                let l = len as u32 as usize;
                let Some(end) = ga.checked_add(l) else {
                    return -1;
                };
                if end > caller.data().guest_mem.len() {
                    return -1;
                }
                let mut bytes = vec![0u8; l];
                let mem = caller.get_export("memory").unwrap().into_memory().unwrap();
                if mem.read(&caller, rt_ptr as u32 as usize, &mut bytes).is_err() {
                    return -1;
                }
                caller.data_mut().guest_mem[ga..end].copy_from_slice(&bytes);
                0
            },
        )
        .unwrap();

    linker
        .func_wrap(
            "env",
            "host_zero_guest",
            |mut caller: Caller<'_, MockRuntimeHost>, gaddr: i32, len: i32| -> i32 {
                if caller.data().fail_mem_io {
                    return -1;
                }
                let ga = gaddr as u32 as usize;
                let l = len as u32 as usize;
                let Some(end) = ga.checked_add(l) else {
                    return -1;
                };
                if end > caller.data().guest_mem.len() {
                    return -1;
                }
                caller.data_mut().guest_mem[ga..end].fill(0);
                0
            },
        )
        .unwrap();

    linker
        .func_wrap(
            "env",
            "host_get_global",
            |caller: Caller<'_, MockRuntimeHost>, id: i32| -> i64 {
                caller.data().globals.get(id as usize).copied().unwrap_or(0)
            },
        )
        .unwrap();

    linker
        .func_wrap(
            "env",
            "host_set_global",
            |mut caller: Caller<'_, MockRuntimeHost>, id: i32, val: i64| {
                if let Some(slot) = caller.data_mut().globals.get_mut(id as usize) {
                    *slot = val;
                }
            },
        )
        .unwrap();

    linker
        .func_wrap(
            "env",
            "host_save_ctx",
            |mut caller: Caller<'_, MockRuntimeHost>, scratch_addr: i32| {
                let sa = scratch_addr as u32 as usize;
                let rip = caller.data().globals[3];
                let rsp = caller.data().globals[4];
                if sa + CTX_SIZE <= caller.data().guest_mem.len() {
                    caller.data_mut().guest_mem[sa + 32..sa + 40]
                        .copy_from_slice(&rsp.to_le_bytes());
                    caller.data_mut().guest_mem[sa + 128..sa + 136]
                        .copy_from_slice(&rip.to_le_bytes());
                }
            },
        )
        .unwrap();

    linker
        .func_wrap(
            "env",
            "host_load_ctx",
            |mut caller: Caller<'_, MockRuntimeHost>, scratch_addr: i32| {
                let sa = scratch_addr as u32 as usize;
                if sa + CTX_SIZE <= caller.data().guest_mem.len() {
                    let rsp = i64::from_le_bytes(
                        caller.data().guest_mem[sa + 32..sa + 40].try_into().unwrap(),
                    );
                    let rip = i64::from_le_bytes(
                        caller.data().guest_mem[sa + 128..sa + 136].try_into().unwrap(),
                    );
                    caller.data_mut().globals[4] = rsp;
                    caller.data_mut().globals[3] = rip;
                }
            },
        )
        .unwrap();

    linker
        .func_wrap("env", "host_vfs_is_ro_mount", |_: Caller<'_, MockRuntimeHost>, _: i32, _: i32| -> i32 { 0 })
        .unwrap();
    linker
        .func_wrap("env", "host_vfs_stat_ro", |_: Caller<'_, MockRuntimeHost>, _: i32, _: i32, _: i32, _: i32| -> i32 { -1 })
        .unwrap();
    linker
        .func_wrap("env", "host_vfs_read_ro", |_: Caller<'_, MockRuntimeHost>, _: i32, _: i32, _: i32| -> i32 { 0 })
        .unwrap();
    linker
        .func_wrap("env", "host_vfs_list_dir_ro", |_: Caller<'_, MockRuntimeHost>, _: i32, _: i32, _: i32| -> i32 { 0 })
        .unwrap();
    linker
        .func_wrap("env", "host_vfs_is_virtual_parent", |_: Caller<'_, MockRuntimeHost>, _: i32, _: i32| -> i32 { 0 })
        .unwrap();

    let mut store = Store::new(engine, MockRuntimeHost::new(guest_mem_size));
    let inst = linker.instantiate(&mut store, module).unwrap();
    (store, inst)
}

#[test]
fn test_t5_v2_runtime_wasm_pre_init_and_null_bounds() {
    let wasm_path = runtime_wasm_path();
    if !wasm_path.exists() {
        return;
    }
    let engine = Engine::default();
    let module = WasmModule::from_file(&engine, &wasm_path).unwrap();
    let (mut store, inst) = instantiate_runtime_wasm(&engine, &module, 0x0C00_0000);

    let alloc = inst.get_typed_func::<i32, i32>(&mut store, "alloc").unwrap();
    let dealloc = inst.get_typed_func::<(i32, i32), ()>(&mut store, "dealloc").unwrap();
    let mem = inst.get_memory(&mut store, "memory").unwrap();

    let out_len_ptr = alloc.call(&mut store, 4).unwrap();
    let path_ptr = alloc.call(&mut store, 16).unwrap();
    mem.write(&mut store, path_ptr as usize, b"/tmp/test.txt").unwrap();

    assert_eq!(
        inst.get_typed_func::<(i32, i32, i32, i32, i32), i32>(&mut store, "runtime_add_vfs_file")
            .unwrap()
            .call(&mut store, (path_ptr, 13, 0, 0, 0o644))
            .unwrap(),
        -1
    );
    assert_eq!(
        inst.get_typed_func::<(i32, i32, i32), i32>(&mut store, "runtime_read_vfs_file")
            .unwrap()
            .call(&mut store, (path_ptr, 13, out_len_ptr))
            .unwrap(),
        0
    );
    assert_eq!(
        inst.get_typed_func::<(i32, i32, i32, i32), i32>(&mut store, "runtime_init_guest_stack")
            .unwrap()
            .call(&mut store, (path_ptr, 4, 0, 0))
            .unwrap(),
        -1
    );
    assert_eq!(
        inst.get_typed_func::<(i64, i64, i64, i64, i64, i64, i64), i64>(
            &mut store,
            "runtime_handle_syscall"
        )
        .unwrap()
        .call(&mut store, (39, 0, 0, 0, 0, 0, 0))
        .unwrap(),
        -38
    );
    assert_eq!(
        inst.get_typed_func::<(), i32>(&mut store, "runtime_on_yield")
            .unwrap()
            .call(&mut store, ())
            .unwrap(),
        0
    );
    assert_eq!(
        inst.get_typed_func::<(), i32>(&mut store, "runtime_get_pending_child_pid")
            .unwrap()
            .call(&mut store, ())
            .unwrap(),
        -1
    );
    assert_eq!(
        inst.get_typed_func::<i32, i32>(&mut store, "runtime_ack_fork")
            .unwrap()
            .call(&mut store, 2)
            .unwrap(),
        -1
    );
    assert_eq!(
        inst.get_typed_func::<(), i32>(&mut store, "runtime_resume_active")
            .unwrap()
            .call(&mut store, ())
            .unwrap(),
        -1
    );
    assert_eq!(
        inst.get_typed_func::<i32, i32>(&mut store, "runtime_get_exec_info")
            .unwrap()
            .call(&mut store, out_len_ptr)
            .unwrap(),
        0
    );
    assert_eq!(
        inst.get_typed_func::<(), i32>(&mut store, "runtime_is_exited")
            .unwrap()
            .call(&mut store, ())
            .unwrap(),
        1
    );

    assert_eq!(
        inst.get_typed_func::<(), i32>(&mut store, "runtime_new")
            .unwrap()
            .call(&mut store, ())
            .unwrap(),
        0
    );

    let add_vfs = inst
        .get_typed_func::<(i32, i32, i32, i32, i32), i32>(&mut store, "runtime_add_vfs_file")
        .unwrap();
    let read_vfs = inst
        .get_typed_func::<(i32, i32, i32), i32>(&mut store, "runtime_read_vfs_file")
        .unwrap();

    assert_eq!(add_vfs.call(&mut store, (0, 5, 0, 0, 0o644)).unwrap(), -1);
    assert_eq!(add_vfs.call(&mut store, (path_ptr, 0, 0, 0, 0o644)).unwrap(), -1);
    let bad_utf8_ptr = alloc.call(&mut store, 4).unwrap();
    mem.write(&mut store, bad_utf8_ptr as usize, &[0xff, 0xfe, 0x80, 0x00]).unwrap();
    assert_eq!(add_vfs.call(&mut store, (bad_utf8_ptr, 3, 0, 0, 0o644)).unwrap(), -1);

    assert_eq!(add_vfs.call(&mut store, (path_ptr, 13, 0, 0, 0o644)).unwrap(), 0);
    let rptr = read_vfs.call(&mut store, (path_ptr, 13, out_len_ptr)).unwrap();
    let mut len_bytes = [0u8; 4];
    mem.read(&store, out_len_ptr as usize, &mut len_bytes).unwrap();
    assert_eq!(u32::from_le_bytes(len_bytes), 0);
    if rptr != 0 {
        dealloc.call(&mut store, (rptr, 0)).unwrap();
    }

    mem.write(&mut store, out_len_ptr as usize, &0x1234u32.to_le_bytes()).unwrap();
    let miss_path = alloc.call(&mut store, 16).unwrap();
    mem.write(&mut store, miss_path as usize, b"/tmp/missing").unwrap();
    assert_eq!(read_vfs.call(&mut store, (miss_path, 12, out_len_ptr)).unwrap(), 0);
    mem.read(&store, out_len_ptr as usize, &mut len_bytes).unwrap();
    assert_eq!(u32::from_le_bytes(len_bytes), 0);

    let init_stack = inst
        .get_typed_func::<(i32, i32, i32, i32), i32>(&mut store, "runtime_init_guest_stack")
        .unwrap();
    assert_eq!(init_stack.call(&mut store, (0, 10, 0, 0)).unwrap(), -1);
    assert_eq!(init_stack.call(&mut store, (path_ptr, 0, 0, 0)).unwrap(), -1);
    assert_eq!(init_stack.call(&mut store, (path_ptr, 8, 0, 0)).unwrap(), -2);

    let meta = WasmMeta {
        entry_rip: 0x0010_0000,
        at_phdr: 0,
        at_phent: 56,
        at_phnum: 0,
        at_entry: 0x0010_0000,
        at_base: 0,
        max_code_addr: 0x0010_1000,
        so_files: vec![],
        symbols: vec![],
        elf_path: "/bin/test".to_string(),
    }
    .encode();
    let meta_ptr = alloc.call(&mut store, meta.len() as i32).unwrap();
    mem.write(&mut store, meta_ptr as usize, &meta).unwrap();
    store.data_mut().fail_mem_io = true;
    assert_eq!(init_stack.call(&mut store, (meta_ptr, meta.len() as i32, 0, 0)).unwrap(), -3);

    dealloc.call(&mut store, (meta_ptr, meta.len() as i32)).unwrap();
    dealloc.call(&mut store, (miss_path, 16)).unwrap();
    dealloc.call(&mut store, (bad_utf8_ptr, 4)).unwrap();
    dealloc.call(&mut store, (path_ptr, 16)).unwrap();
    dealloc.call(&mut store, (out_len_ptr, 4)).unwrap();
}

#[test]
fn test_t5_v2_runtime_wasm_fork_exec_and_syscall_bounds() {
    let wasm_path = runtime_wasm_path();
    if !wasm_path.exists() {
        return;
    }
    let engine = Engine::default();
    let module = WasmModule::from_file(&engine, &wasm_path).unwrap();
    let (mut store, inst) = instantiate_runtime_wasm(&engine, &module, 0x0C00_0000);

    inst.get_typed_func::<(), i32>(&mut store, "runtime_new")
        .unwrap()
        .call(&mut store, ())
        .unwrap();

    let alloc = inst.get_typed_func::<i32, i32>(&mut store, "alloc").unwrap();
    let dealloc = inst.get_typed_func::<(i32, i32), ()>(&mut store, "dealloc").unwrap();
    let mem = inst.get_memory(&mut store, "memory").unwrap();

    let meta = WasmMeta {
        entry_rip: 0x0010_0000,
        at_phdr: 0,
        at_phent: 56,
        at_phnum: 0,
        at_entry: 0x0010_0000,
        at_base: 0,
        max_code_addr: 0x0010_1000,
        so_files: vec![],
        symbols: vec![],
        elf_path: "/bin/parent".to_string(),
    }
    .encode();
    let meta_ptr = alloc.call(&mut store, meta.len() as i32).unwrap();
    mem.write(&mut store, meta_ptr as usize, &meta).unwrap();

    let mut bad_e2wa = Vec::from(*b"E2WA");
    bad_e2wa.extend_from_slice(&u32::MAX.to_le_bytes());
    let args_ptr = alloc.call(&mut store, bad_e2wa.len() as i32).unwrap();
    mem.write(&mut store, args_ptr as usize, &bad_e2wa).unwrap();

    let init_stack = inst
        .get_typed_func::<(i32, i32, i32, i32), i32>(&mut store, "runtime_init_guest_stack")
        .unwrap();
    assert_eq!(
        init_stack
            .call(&mut store, (meta_ptr, meta.len() as i32, args_ptr, bad_e2wa.len() as i32))
            .unwrap(),
        0
    );

    let syscall = inst
        .get_typed_func::<(i64, i64, i64, i64, i64, i64, i64), i64>(
            &mut store,
            "runtime_handle_syscall",
        )
        .unwrap();

    assert_eq!(syscall.call(&mut store, (1, 1, 0x1FFF_0000, 16, 0, 0, 0)).unwrap(), -14);
    assert_eq!(syscall.call(&mut store, (257, -100, 0, 0, 0, 0, 0)).unwrap(), -14);

    let fork_ret = syscall.call(&mut store, (57, 0, 0, 0, 0, 0, 0)).unwrap();
    assert!(fork_ret > 1);
    let on_yield = inst.get_typed_func::<(), i32>(&mut store, "runtime_on_yield").unwrap();
    assert_eq!(on_yield.call(&mut store, ()).unwrap(), 3);

    let child_pid = inst
        .get_typed_func::<(), i32>(&mut store, "runtime_get_pending_child_pid")
        .unwrap()
        .call(&mut store, ())
        .unwrap();
    assert_eq!(child_pid, fork_ret as i32);
    assert_ne!(
        inst.get_typed_func::<(), i32>(&mut store, "runtime_get_pending_scratch_addr")
            .unwrap()
            .call(&mut store, ())
            .unwrap(),
        0
    );

    assert_eq!(
        inst.get_typed_func::<i32, i32>(&mut store, "runtime_ack_fork")
            .unwrap()
            .call(&mut store, child_pid)
            .unwrap(),
        0
    );
    assert_eq!(
        inst.get_typed_func::<(), i32>(&mut store, "runtime_get_active_pid")
            .unwrap()
            .call(&mut store, ())
            .unwrap(),
        child_pid
    );
    assert_eq!(
        inst.get_typed_func::<(), i32>(&mut store, "runtime_resume_active")
            .unwrap()
            .call(&mut store, ())
            .unwrap(),
        1
    );

    let path_gaddr = 0x0020_0000usize;
    let argv_gaddr = 0x0020_0100usize;
    let envp_gaddr = 0x0020_0200usize;
    store.data_mut().guest_mem[path_gaddr..path_gaddr + 11].copy_from_slice(b"/bin/child\0");
    store.data_mut().guest_mem[argv_gaddr..argv_gaddr + 8]
        .copy_from_slice(&(path_gaddr as u64).to_le_bytes());
    store.data_mut().guest_mem[argv_gaddr + 8..argv_gaddr + 16].fill(0);
    store.data_mut().guest_mem[envp_gaddr..envp_gaddr + 8].fill(0);

    assert_eq!(
        syscall
            .call(&mut store, (59, path_gaddr as i64, argv_gaddr as i64, envp_gaddr as i64, 0, 0, 0))
            .unwrap(),
        -2
    );

    let vfs_path_ptr = alloc.call(&mut store, 16).unwrap();
    mem.write(&mut store, vfs_path_ptr as usize, b"/bin/child").unwrap();
    let vfs_data_ptr = alloc.call(&mut store, 4).unwrap();
    mem.write(&mut store, vfs_data_ptr as usize, b"\x7fELF").unwrap();
    assert_eq!(
        inst.get_typed_func::<(i32, i32, i32, i32, i32), i32>(&mut store, "runtime_add_vfs_file")
            .unwrap()
            .call(&mut store, (vfs_path_ptr, 10, vfs_data_ptr, 4, 0o755))
            .unwrap(),
        0
    );
    dealloc.call(&mut store, (vfs_data_ptr, 4)).unwrap();
    dealloc.call(&mut store, (vfs_path_ptr, 16)).unwrap();

    assert_eq!(
        syscall
            .call(&mut store, (59, path_gaddr as i64, argv_gaddr as i64, envp_gaddr as i64, 0, 0, 0))
            .unwrap(),
        0
    );
    assert_eq!(on_yield.call(&mut store, ()).unwrap(), 4);

    let out_len_ptr = alloc.call(&mut store, 4).unwrap();
    let exec_info_ptr = inst
        .get_typed_func::<i32, i32>(&mut store, "runtime_get_exec_info")
        .unwrap()
        .call(&mut store, out_len_ptr)
        .unwrap();
    assert_ne!(exec_info_ptr, 0);
    let mut len_bytes = [0u8; 4];
    mem.read(&store, out_len_ptr as usize, &mut len_bytes).unwrap();
    let exec_len = u32::from_le_bytes(len_bytes) as usize;
    let mut exec_buf = vec![0u8; exec_len];
    mem.read(&store, exec_info_ptr as usize, &mut exec_buf).unwrap();
    assert!(exec_buf.starts_with(b"E2WE"));
    dealloc.call(&mut store, (exec_info_ptr, exec_len as i32)).unwrap();

    let complete_exec = inst
        .get_typed_func::<(i32, i32, i32, i32, i32), i32>(&mut store, "runtime_complete_exec")
        .unwrap();
    assert_eq!(
        complete_exec.call(&mut store, (child_pid, out_len_ptr, 4, 0, 0)).unwrap(),
        -2
    );
    assert_eq!(
        complete_exec.call(&mut store, (child_pid, meta_ptr, meta.len() as i32, 0, 0)).unwrap(),
        0
    );
    assert_eq!(
        inst.get_typed_func::<i32, i32>(&mut store, "runtime_get_exec_info")
            .unwrap()
            .call(&mut store, out_len_ptr)
            .unwrap(),
        0
    );

    dealloc.call(&mut store, (out_len_ptr, 4)).unwrap();
    dealloc.call(&mut store, (args_ptr, bad_e2wa.len() as i32)).unwrap();
    dealloc.call(&mut store, (meta_ptr, meta.len() as i32)).unwrap();
}

// ============================================================================
// 5. elf2wasm-runtime-core (Scheduler, Syscalls, VFS)
// ============================================================================

struct MockCtx {
    mem: Vec<u8>,
    fsbase: i64,
    gsbase: i64,
    rcx: i64,
    rip: i64,
    rsp: i64,
    exit_flag: i32,
    exit_code: i32,
    yield_flag: i32,
    quantum: i32,
}

impl MockCtx {
    fn new(mem_size: usize) -> Self {
        Self {
            mem: vec![0u8; mem_size],
            fsbase: 0,
            gsbase: 0,
            rcx: 0,
            rip: 0,
            rsp: 0,
            exit_flag: 0,
            exit_code: 0,
            yield_flag: 0,
            quantum: DEFAULT_QUANTUM,
        }
    }
}

impl GuestContext for MockCtx {
    fn mem_len(&self) -> usize {
        self.mem.len()
    }
    fn mem_read(&self, addr: u64, buf: &mut [u8]) -> Result<(), i64> {
        let s = usize::try_from(addr).map_err(|_| -EFAULT)?;
        let e = s.checked_add(buf.len()).ok_or(-EFAULT)?;
        if e > self.mem.len() {
            return Err(-EFAULT);
        }
        buf.copy_from_slice(&self.mem[s..e]);
        Ok(())
    }
    fn mem_write(&mut self, addr: u64, data: &[u8]) -> Result<(), i64> {
        let s = usize::try_from(addr).map_err(|_| -EFAULT)?;
        let e = s.checked_add(data.len()).ok_or(-EFAULT)?;
        if e > self.mem.len() {
            return Err(-EFAULT);
        }
        self.mem[s..e].copy_from_slice(data);
        Ok(())
    }
    fn mem_zero(&mut self, addr: u64, len: usize) -> Result<(), i64> {
        let s = usize::try_from(addr).map_err(|_| -12i64)?;
        let e = s.checked_add(len).ok_or(-12i64)?;
        if e > self.mem.len() {
            return Err(-12);
        }
        self.mem[s..e].fill(0);
        Ok(())
    }
    fn mem_read_cstr(&self, addr: u64, max_len: usize) -> Result<String, i64> {
        if addr == 0 {
            return Err(-EFAULT);
        }
        let s = usize::try_from(addr).map_err(|_| -EFAULT)?;
        if s >= self.mem.len() {
            return Err(-EFAULT);
        }
        let end = (s + max_len).min(self.mem.len());
        let slice = &self.mem[s..end];
        let nul = slice.iter().position(|&b| b == 0).ok_or(-EFAULT)?;
        String::from_utf8(slice[..nul].to_vec()).map_err(|_| -EINVAL)
    }
    fn get_fsbase(&self) -> i64 {
        self.fsbase
    }
    fn set_fsbase(&mut self, val: i64) {
        self.fsbase = val;
    }
    fn get_gsbase(&self) -> i64 {
        self.gsbase
    }
    fn set_gsbase(&mut self, val: i64) {
        self.gsbase = val;
    }
    fn get_rcx(&self) -> i64 {
        self.rcx
    }
    fn set_rip(&mut self, val: i64) {
        self.rip = val;
    }
    fn set_rsp(&mut self, val: i64) {
        self.rsp = val;
    }
    fn set_exit(&mut self, code: i32) {
        self.exit_flag = 1;
        self.exit_code = code;
    }
    fn set_yield_flag(&mut self, val: i32) {
        self.yield_flag = val;
    }
    fn set_quantum(&mut self, val: i32) {
        self.quantum = val;
    }
    fn save_ctx(&mut self, scratch_addr: u32) -> Result<[u8; CTX_SIZE], i64> {
        let mut buf = [0u8; CTX_SIZE];
        buf[32..40].copy_from_slice(&self.rsp.to_le_bytes());
        buf[128..136].copy_from_slice(&self.rip.to_le_bytes());
        buf[136..144].copy_from_slice(&self.fsbase.to_le_bytes());
        self.mem_write(scratch_addr as u64, &buf)?;
        Ok(buf)
    }
    fn load_ctx(&mut self, scratch_addr: u32, buf: &[u8; CTX_SIZE]) -> Result<(), i64> {
        self.mem_write(scratch_addr as u64, buf)?;
        self.rsp = i64::from_le_bytes(buf[32..40].try_into().unwrap());
        self.rip = i64::from_le_bytes(buf[128..136].try_into().unwrap());
        self.fsbase = i64::from_le_bytes(buf[136..144].try_into().unwrap());
        Ok(())
    }
}

#[test]
fn test_v2_adv_scheduler_quantum_fifo_and_stale_run_queue() {
    let mut sched = Scheduler::new();
    let mut ctx = MockCtx::new(0x0B00_0000);

    ctx.yield_flag = 2;
    assert!(sched.on_yield(&mut ctx, 2).unwrap());
    assert_eq!(sched.virtual_mono_ns, QUANTUM_TIME_STEP_NS);
    assert_eq!(ctx.yield_flag, 0);
    assert_eq!(ctx.quantum, DEFAULT_QUANTUM);

    let t2 = sched.alloc_tid();
    let mut tc2 = ThreadContext::new(t2);
    tc2.set_rip(0x2000);
    sched.threads.insert(t2, tc2);

    let t3 = sched.alloc_tid();
    let mut tc3 = ThreadContext::new(t3);
    tc3.set_rip(0x3000);
    sched.threads.insert(t3, tc3);

    let t_stale = sched.alloc_tid();
    let mut tc_stale = ThreadContext::new(t_stale);
    tc_stale.state = ThreadState::Exited;
    sched.threads.insert(t_stale, tc_stale);

    sched.run_queue.push_back(t_stale);
    sched.run_queue.push_back(t2);
    sched.run_queue.push_back(t3);

    ctx.rip = 0x1000;
    assert!(sched.on_yield(&mut ctx, 2).unwrap());
    assert_eq!(sched.current_tid, t2);
    assert_eq!(ctx.rip, 0x2000);

    assert!(sched.on_yield(&mut ctx, 2).unwrap());
    assert_eq!(sched.current_tid, t3);
    assert_eq!(ctx.rip, 0x3000);

    assert!(sched.on_yield(&mut ctx, 2).unwrap());
    assert_eq!(sched.current_tid, MAIN_TID);
    assert_eq!(ctx.rip, 0x1000);
}

#[test]
fn test_v2_adv_scheduler_futex_bitset_realtime_and_clear_child_tid() {
    const SYS_EXIT: i64 = 60;
    const SYS_FUTEX: i64 = 202;
    const FUTEX_WAIT_BITSET: i64 = 9;
    const FUTEX_WAKE_BITSET: i64 = 10;
    const FUTEX_CLOCK_REALTIME: i64 = 0x100;

    let vfs = VirtualFs::new_in_memory(&[]);
    let mut state = HostState::new(vfs);
    let mut ctx = MockCtx::new(0x0B00_0000);

    ctx.mem_write(0x3000, &42u32.to_le_bytes()).unwrap();

    let r = handle_syscall(&mut ctx, &mut state, SYS_FUTEX, 0x3000, FUTEX_WAIT_BITSET, 42, 0, 0, 0);
    assert_eq!(r, -EINVAL);

    let t2 = state.scheduler.alloc_tid();
    let mut tc2 = ThreadContext::new(t2);
    tc2.state = ThreadState::FutexWait {
        uaddr: 0x3000,
        bitset: 0b0010,
        wake_ns: None,
    };
    state.scheduler.threads.insert(t2, tc2);

    assert_eq!(
        handle_syscall(&mut ctx, &mut state, SYS_FUTEX, 0x3000, FUTEX_WAKE_BITSET, 1, 0, 0, 0b0001),
        0
    );
    assert_eq!(
        handle_syscall(&mut ctx, &mut state, SYS_FUTEX, 0x3000, FUTEX_WAKE_BITSET, 1, 0, 0, 0b0010),
        1
    );
    assert_eq!(state.scheduler.threads[&t2].state, ThreadState::Runnable);

    let past_rt_sec = (state.scheduler.realtime_base_ns / 1_000_000_000) as i64;
    let mut ts = [0u8; 16];
    ts[0..8].copy_from_slice(&past_rt_sec.to_le_bytes());
    ctx.mem_write(0x3100, &ts).unwrap();
    let r_past = handle_syscall(
        &mut ctx,
        &mut state,
        SYS_FUTEX,
        0x3000,
        FUTEX_WAIT_BITSET | FUTEX_CLOCK_REALTIME,
        42,
        0x3100,
        0,
        0xFFFF_FFFF,
    );
    assert_eq!(r_past, -ETIMEDOUT);

    let ctid_addr = 0x3200u64;
    ctx.mem_write(ctid_addr, &t2.to_le_bytes()).unwrap();
    state.scheduler.threads.get_mut(&MAIN_TID).unwrap().state = ThreadState::FutexWait {
        uaddr: ctid_addr as u32,
        bitset: 0xFFFF_FFFF,
        wake_ns: None,
    };
    state.scheduler.current_tid = t2;
    state.scheduler.threads.get_mut(&t2).unwrap().clear_child_tid = ctid_addr as u32;

    assert_eq!(handle_syscall(&mut ctx, &mut state, SYS_EXIT, 0, 0, 0, 0, 0, 0), 0);
    let mut ctid_after = [0xffu8; 4];
    ctx.mem_read(ctid_addr, &mut ctid_after).unwrap();
    assert_eq!(i32::from_le_bytes(ctid_after), 0);
    assert_eq!(state.scheduler.threads[&t2].state, ThreadState::Exited);
    assert_eq!(state.scheduler.threads[&MAIN_TID].state, ThreadState::Runnable);
}

#[test]
fn test_v2_adv_clock_nanosleep_abstime_and_invalid_timespec() {
    const SYS_CLOCK_NANOSLEEP: i64 = 230;
    const TIMER_ABSTIME: i64 = 1;
    const CLOCK_REALTIME: i64 = 0;
    const CLOCK_MONOTONIC: i64 = 1;

    let vfs = VirtualFs::new_in_memory(&[]);
    let mut state = HostState::new(vfs);
    let mut ctx = MockCtx::new(0x0B00_0000);

    let mut bad_ts = [0u8; 16];
    bad_ts[8..16].copy_from_slice(&1_000_000_000i64.to_le_bytes());
    ctx.mem_write(0x1000, &bad_ts).unwrap();
    assert_eq!(
        handle_syscall(&mut ctx, &mut state, SYS_CLOCK_NANOSLEEP, CLOCK_MONOTONIC, 0, 0x1000, 0, 0, 0),
        -EINVAL
    );

    let mut past_ts = [0u8; 16];
    ctx.mem_write(0x1000, &past_ts).unwrap();
    ctx.yield_flag = 0;
    assert_eq!(
        handle_syscall(&mut ctx, &mut state, SYS_CLOCK_NANOSLEEP, CLOCK_MONOTONIC, TIMER_ABSTIME, 0x1000, 0, 0, 0),
        0
    );
    assert_eq!(ctx.yield_flag, 0);

    let target_rt_sec = (state.scheduler.realtime_base_ns / 1_000_000_000) as i64 + 5;
    past_ts[0..8].copy_from_slice(&target_rt_sec.to_le_bytes());
    ctx.mem_write(0x1000, &past_ts).unwrap();
    assert_eq!(
        handle_syscall(&mut ctx, &mut state, SYS_CLOCK_NANOSLEEP, CLOCK_REALTIME, TIMER_ABSTIME, 0x1000, 0, 0, 0),
        0
    );
    assert_eq!(ctx.yield_flag, 1);
    assert!(state.scheduler.on_yield(&mut ctx, 1).unwrap());
    assert_eq!(state.scheduler.virtual_mono_ns, 5_000_000_000);
}

#[test]
fn test_v2_adv_scheduler_on_yield_poll_wait_wakes_on_timeout() {
    const SYS_SELECT: i64 = 23;
    let vfs = VirtualFs::new_in_memory(&[]);
    let mut state = HostState::new(vfs);
    let mut ctx = MockCtx::new(0x0B00_0000);

    let mut tv = [0u8; 16];
    tv[0..8].copy_from_slice(&1i64.to_le_bytes());
    ctx.mem_write(0x1000, &tv).unwrap();

    assert_eq!(handle_syscall(&mut ctx, &mut state, SYS_SELECT, 0, 0, 0, 0, 0x1000, 0), 0);
    assert_eq!(ctx.yield_flag, 1);
    assert!(state.scheduler.on_yield(&mut ctx, 1).unwrap());
    assert!(state.scheduler.virtual_mono_ns >= 1_000_000_000);
    assert!(state.resume_active(&mut ctx).unwrap());
    assert_eq!(state.scheduler.threads[&MAIN_TID].get_reg_i64(0), 0);
}

#[test]
fn test_v2_adv_multiproc_fork_pipe_refcount_wait4_and_vfork() {
    const SYS_READ: i64 = 0;
    const SYS_CLOSE: i64 = 3;
    const SYS_FORK: i64 = 57;
    const SYS_VFORK: i64 = 58;
    const SYS_EXECVE: i64 = 59;
    const SYS_WAIT4: i64 = 61;
    const SYS_EXIT_GROUP: i64 = 231;
    const SYS_PIPE2: i64 = 293;
    const WNOHANG: i64 = 1;

    let vfs = VirtualFs::new_in_memory(&[]);
    let mut state = HostState::new(vfs);
    let mut ctx = MockCtx::new(0x0C00_0000);

    assert_eq!(handle_syscall(&mut ctx, &mut state, SYS_FORK, 0, 0, 0, 0, 0, 0), -ENOSYS);
    assert_eq!(handle_syscall(&mut ctx, &mut state, SYS_WAIT4, -1, 0, 0, 0, 0, 0), -ENOSYS);

    state.multiproc_enabled = true;
    assert_eq!(handle_syscall(&mut ctx, &mut state, SYS_PIPE2, 0x1000, O_CLOEXEC as i64, 0, 0, 0, 0), 0);
    let mut fds_buf = [0u8; 8];
    ctx.mem_read(0x1000, &mut fds_buf).unwrap();
    let rfd = i32::from_le_bytes(fds_buf[0..4].try_into().unwrap());
    let wfd = i32::from_le_bytes(fds_buf[4..8].try_into().unwrap());
    let pipe_id = state.vfs.get_fd(rfd).unwrap().pipe_id.unwrap();

    let child_pid = handle_syscall(&mut ctx, &mut state, SYS_FORK, 0, 0, 0, 0, 0, 0) as i32;
    assert!(child_pid > MAIN_PID);
    assert!(matches!(state.pending_action, Some(PendingHostAction::Fork { is_vfork: false, .. })));
    assert_eq!(state.on_yield_multiproc(&mut ctx, 1).unwrap(), 3);
    assert_eq!(state.vfs.pipes[&pipe_id].readers, 2);
    assert_eq!(state.vfs.pipes[&pipe_id].writers, 2);

    assert!(state.ack_fork(child_pid));
    assert_eq!(state.active_pid, child_pid);

    state.switch_active_process(MAIN_PID);
    assert_eq!(handle_syscall(&mut ctx, &mut state, SYS_CLOSE, wfd as i64, 0, 0, 0, 0, 0), 0);
    assert_eq!(state.vfs.pipes[&pipe_id].writers, 1);

    assert_eq!(handle_syscall(&mut ctx, &mut state, SYS_WAIT4, child_pid as i64, 0x1100, WNOHANG, 0, 0, 0), 0);

    state.switch_active_process(child_pid);
    handle_syscall(&mut ctx, &mut state, SYS_EXIT_GROUP, 7, 0, 0, 0, 0, 0);
    assert_eq!(state.vfs.pipes[&pipe_id].writers, 0);

    state.switch_active_process(MAIN_PID);
    assert_eq!(handle_syscall(&mut ctx, &mut state, SYS_READ, rfd as i64, 0x1200, 16, 0, 0, 0), 0);
    let reaped = handle_syscall(&mut ctx, &mut state, SYS_WAIT4, child_pid as i64, 0x1100, 0, 0, 0, 0);
    assert_eq!(reaped, child_pid as i64);
    let mut wstatus = [0u8; 4];
    ctx.mem_read(0x1100, &mut wstatus).unwrap();
    assert_eq!(i32::from_le_bytes(wstatus), 7 << 8);

    assert_eq!(handle_syscall(&mut ctx, &mut state, SYS_WAIT4, -1, 0, 0, 0, 0, 0), -ECHILD);

    state.vfs.vfs_write_file("/tmp/child_elf", b"\x7fELF", 0o755);
    ctx.mem_write(0x2000, b"/tmp/child_elf\0").unwrap();
    let vchild = handle_syscall(&mut ctx, &mut state, SYS_VFORK, 0, 0, 0, 0, 0, 0) as i32;
    assert_eq!(state.scheduler.threads[&MAIN_TID].state, ThreadState::VforkWait { child_pid: vchild });
    assert!(state.ack_fork(vchild));
    assert!(state.vfs.get_fd(rfd).unwrap().cloexec);

    assert_eq!(handle_syscall(&mut ctx, &mut state, SYS_EXECVE, 0x2000, 0, 0, 0, 0, 0), 0);
    assert!(state.vfs.get_fd(rfd).is_none());
    assert_eq!(
        state.processes[&MAIN_PID].scheduler.threads[&MAIN_TID].state,
        ThreadState::Runnable
    );
    let meta = WasmMeta {
        entry_rip: 0x0010_0000,
        at_phdr: 0,
        at_phent: 56,
        at_phnum: 0,
        at_entry: 0x0010_0000,
        at_base: 0,
        max_code_addr: 0x0010_1000,
        so_files: vec![],
        symbols: vec![],
        elf_path: "/tmp/child_elf".to_string(),
    };
    state.complete_exec(&mut ctx, vchild, &meta, &["/tmp/child_elf".into()], &[]).unwrap();
    assert!(state.pending_action.is_none());
}

#[test]
fn test_v2_adv_waitid_blocking_populates_siginfo_and_returns_zero() {
    const SYS_FORK: i64 = 57;
    const SYS_WAITID: i64 = 247;
    const SYS_EXIT_GROUP: i64 = 231;

    let vfs = VirtualFs::new_in_memory(&[]);
    let mut state = HostState::new(vfs);
    state.multiproc_enabled = true;
    let mut ctx = MockCtx::new(0x0B00_0000);

    let cpid = handle_syscall(&mut ctx, &mut state, SYS_FORK, 0, 0, 0, 0, 0, 0) as i32;
    state.ack_fork(cpid);
    state.switch_active_process(MAIN_PID);

    assert_eq!(handle_syscall(&mut ctx, &mut state, SYS_WAITID, 1, cpid as i64, 0x3000, 4, 0, 0), 0);
    assert_eq!(ctx.yield_flag, 1);

    state.switch_active_process(cpid);
    handle_syscall(&mut ctx, &mut state, SYS_EXIT_GROUP, 9, 0, 0, 0, 0, 0);
    assert_eq!(state.on_yield_multiproc(&mut ctx, 1).unwrap(), 2);
    assert!(state.resume_active(&mut ctx).unwrap());

    assert_eq!(state.scheduler.threads[&MAIN_TID].get_reg_i64(0), 0);
    let mut si = [0u8; 32];
    ctx.mem_read(0x3000, &mut si).unwrap();
    assert_eq!(i32::from_le_bytes(si[0..4].try_into().unwrap()), 17); // SIGCHLD
    assert_eq!(i32::from_le_bytes(si[8..12].try_into().unwrap()), 1); // CLD_EXITED
    assert_eq!(i32::from_le_bytes(si[16..20].try_into().unwrap()), cpid);
    assert_eq!(i32::from_le_bytes(si[24..28].try_into().unwrap()), 9);
}

#[test]
fn test_v2_adv_mmap_prot_exec_guard() {
    const SYS_MMAP: i64 = 9;
    const PROT_READ: i64 = 1;
    const PROT_EXEC: i64 = 4;
    const MAP_PRIVATE: i64 = 2;

    let so = MetaSoFile {
        guest_paths: vec!["/lib/x86_64-linux-gnu/libdummy.so.1".to_string()],
        base_addr: 0x0200_0000,
        bytes: vec![0x90; 4096],
    };
    let mut vfs = VirtualFs::new_in_memory(&[so]);
    vfs.vfs_write_file("/tmp/data.bin", &[0xcc; 4096], 0o755);
    let mut state = HostState::new(vfs);
    let mut ctx = MockCtx::new(0x0B00_0000);

    let data_fd = state.vfs.openat(AT_FDCWD, "/tmp/data.bin", O_RDONLY);
    assert!(data_fd >= 3);
    assert_eq!(
        handle_syscall(&mut ctx, &mut state, SYS_MMAP, 0, 4096, PROT_READ | PROT_EXEC, MAP_PRIVATE, data_fd, 0),
        -EACCES
    );

    let so_fd = state.vfs.openat(AT_FDCWD, "/lib/x86_64-linux-gnu/libdummy.so.1", O_RDONLY);
    assert!(so_fd >= 3);
    let addr = handle_syscall(&mut ctx, &mut state, SYS_MMAP, 0, 4096, PROT_READ | PROT_EXEC, MAP_PRIVATE, so_fd, 0);
    assert_eq!(addr, 0x0200_0000);
}

#[test]
fn test_v2_adv_vfs_pipe_64k_capacity_nonblock_epipe_and_dup3() {
    const SYS_WRITE: i64 = 1;
    const SYS_FCNTL: i64 = 72;
    const SYS_DUP3: i64 = 292;
    const F_SETFL: i64 = 4;

    let mut vfs = VirtualFs::new_in_memory(&[]);
    let (rfd, wfd) = vfs.create_pipe().unwrap();
    let (rfd2, wfd2) = vfs.create_pipe().unwrap();
    let mut state = HostState::new(vfs);
    let mut ctx = MockCtx::new(0x0B00_0000);

    let full = vec![0xABu8; PIPE_CAPACITY];
    ctx.mem_write(0x1000, &full).unwrap();
    assert_eq!(
        handle_syscall(&mut ctx, &mut state, SYS_WRITE, wfd as i64, 0x1000, PIPE_CAPACITY as i64, 0, 0, 0),
        PIPE_CAPACITY as i64
    );

    assert_eq!(handle_syscall(&mut ctx, &mut state, SYS_FCNTL, wfd as i64, F_SETFL, O_NONBLOCK as i64, 0, 0, 0), 0);
    assert_eq!(handle_syscall(&mut ctx, &mut state, SYS_WRITE, wfd as i64, 0x1000, 1, 0, 0, 0), -EAGAIN);

    assert_eq!(handle_syscall(&mut ctx, &mut state, SYS_FCNTL, wfd as i64, F_SETFL, 0, 0, 0, 0), 0);
    assert_eq!(handle_syscall(&mut ctx, &mut state, SYS_WRITE, wfd as i64, 0x1000, 16, 0, 0, 0), 0);
    assert!(matches!(state.scheduler.current_thread().state, ThreadState::PipeWriteWait { .. }));

    assert_eq!(handle_syscall(&mut ctx, &mut state, SYS_DUP3, rfd as i64, rfd as i64, 0, 0, 0, 0), -EINVAL);
    assert_eq!(handle_syscall(&mut ctx, &mut state, SYS_DUP3, rfd as i64, 50, 0x1234, 0, 0, 0), -EINVAL);

    assert_eq!(handle_syscall(&mut ctx, &mut state, SYS_DUP3, rfd as i64, rfd2 as i64, O_CLOEXEC as i64, 0, 0, 0), rfd2 as i64);
    assert_eq!(handle_syscall(&mut ctx, &mut state, SYS_WRITE, wfd2 as i64, 0x1000, 4, 0, 0, 0), -EPIPE);
}

#[test]
fn test_v2_adv_vfs_overlay_trunc_ftruncate_rename_and_read_no_advance() {
    let mut vfs = VirtualFs::new_in_memory(&[]);
    let fd = vfs.openat(AT_FDCWD, "/tmp/f.txt", O_CREAT | O_RDWR | O_TRUNC) as i32;
    assert_eq!(vfs.write(fd, b"abcdef"), 6);
    assert_eq!(vfs.close(fd), 0);

    let fd_tr = vfs.openat(AT_FDCWD, "/tmp/f.txt", O_WRONLY | O_TRUNC) as i32;
    assert_eq!(vfs.vfs_read_file("/tmp/f.txt").unwrap(), b"");
    assert_eq!(vfs.write(fd_tr, b"hi"), 2);
    assert_eq!(vfs.ftruncate(fd_tr, -1, 0), -EINVAL);
    assert_eq!(vfs.ftruncate(fd_tr, 5, 100), 0);
    assert_eq!(vfs.vfs_read_file("/tmp/f.txt").unwrap(), b"hi\0\0\0");
    assert_eq!(vfs.close(fd_tr), 0);

    let fd_ap = vfs.openat(AT_FDCWD, "/tmp/f.txt", O_RDWR | O_APPEND) as i32;
    assert_eq!(vfs.lseek(fd_ap, 0, 0), 0);
    assert_eq!(vfs.write(fd_ap, b"!"), 1);
    assert_eq!(vfs.vfs_read_file("/tmp/f.txt").unwrap(), b"hi\0\0\0!");
    assert_eq!(vfs.close(fd_ap), 0);

    assert_eq!(vfs.mkdirat(AT_FDCWD, "/tmp/d1", 0o755, 0), 0);
    assert_eq!(vfs.mkdirat(AT_FDCWD, "/tmp/d1/sub", 0o755, 0), 0);
    assert_eq!(vfs.renameat(AT_FDCWD, "/tmp/d1", AT_FDCWD, "/tmp/d1/sub/x"), -EINVAL);
    assert_eq!(vfs.mkdirat(AT_FDCWD, "/tmp/d2", 0o755, 0), 0);
    assert_eq!(vfs.renameat(AT_FDCWD, "/tmp/d2", AT_FDCWD, "/tmp/d1"), -ENOTEMPTY);
    assert_eq!(vfs.unlinkat(AT_FDCWD, "/tmp/d1/sub", AT_REMOVEDIR), 0);
    assert_eq!(vfs.renameat(AT_FDCWD, "/tmp/d2", AT_FDCWD, "/tmp/d1"), 0);

    let mut state = HostState::new(vfs);
    let mut ctx = MockCtx::new(0x0B00_0000);
    let rfd = state.vfs.openat(AT_FDCWD, "/tmp/f.txt", O_RDONLY);
    assert_eq!(handle_syscall(&mut ctx, &mut state, 0, rfd, 0xFFFF_FFFF_FFFF_0000u64 as i64, 4, 0, 0, 0), -EFAULT);
    assert_eq!(state.vfs.get_fd(rfd as i32).unwrap().cursor, 0);
}

#[test]
fn test_v2_adv_poll_select_pipe_events() {
    const SYS_POLL: i64 = 7;
    const SYS_SELECT: i64 = 23;
    const POLLERR: i16 = 0x0008;
    const POLLHUP: i16 = 0x0010;
    const POLLNVAL: i16 = 0x0020;

    let mut vfs = VirtualFs::new_in_memory(&[]);
    let (rfd, wfd) = vfs.create_pipe().unwrap();
    vfs.close(wfd);
    let (rfd2, wfd2) = vfs.create_pipe().unwrap();
    vfs.close(rfd2);

    let mut state = HostState::new(vfs);
    let mut ctx = MockCtx::new(0x0B00_0000);

    assert_eq!(handle_syscall(&mut ctx, &mut state, SYS_POLL, 0x1000, 4097, 0, 0, 0, 0), -EINVAL);
    assert_eq!(handle_syscall(&mut ctx, &mut state, SYS_SELECT, -1, 0, 0, 0, 0, 0), -EINVAL);
    assert_eq!(handle_syscall(&mut ctx, &mut state, SYS_SELECT, 1025, 0, 0, 0, 0, 0), -EINVAL);

    let entries = [(rfd, 1i16), (wfd2, 4i16), (999, 1i16)];
    for (i, &(fd, ev)) in entries.iter().enumerate() {
        let base = 0x1000 + (i as u64) * 8;
        ctx.mem_write(base, &fd.to_le_bytes()).unwrap();
        ctx.mem_write(base + 4, &ev.to_le_bytes()).unwrap();
        ctx.mem_write(base + 6, &0i16.to_le_bytes()).unwrap();
    }
    assert_eq!(handle_syscall(&mut ctx, &mut state, SYS_POLL, 0x1000, 3, 0, 0, 0, 0), 3);
    let mut rev = [0u8; 2];
    ctx.mem_read(0x1006, &mut rev).unwrap();
    assert_ne!(i16::from_le_bytes(rev) & POLLHUP, 0);
    ctx.mem_read(0x100e, &mut rev).unwrap();
    assert_ne!(i16::from_le_bytes(rev) & POLLERR, 0);
    ctx.mem_read(0x1016, &mut rev).unwrap();
    assert_ne!(i16::from_le_bytes(rev) & POLLNVAL, 0);
}

#[test]
fn test_v2_adv_ack_fork_wrong_pid_preserves_pending() {
    const SYS_FORK: i64 = 57;
    let vfs = VirtualFs::new_in_memory(&[]);
    let mut state = HostState::new(vfs);
    state.multiproc_enabled = true;
    let mut ctx = MockCtx::new(0x0B00_0000);

    let child_pid = handle_syscall(&mut ctx, &mut state, SYS_FORK, 0, 0, 0, 0, 0, 0) as i32;
    assert!(!state.ack_fork(child_pid + 99));
    assert!(matches!(
        state.pending_action,
        Some(PendingHostAction::Fork { child_pid: p, .. }) if p == child_pid
    ));
    assert!(state.ack_fork(child_pid));
    assert!(state.pending_action.is_none());
}

#[test]
fn test_v2_adv_ppoll_subms_timeout_and_execveat_dirfd_checks() {
    const SYS_PPOLL: i64 = 271;
    const SYS_EXECVEAT: i64 = 322;
    const AT_EMPTY_PATH: i64 = 0x1000;

    let mut vfs = VirtualFs::new_in_memory(&[]);
    vfs.vfs_write_file("/tmp/notadir", b"\x7fELF", 0o755);
    let file_fd = vfs.openat(AT_FDCWD, "/tmp/notadir", O_RDONLY);
    let mut state = HostState::new(vfs);
    state.multiproc_enabled = true;
    let mut ctx = MockCtx::new(0x0B00_0000);

    // ppoll with { tv_sec: 0, tv_nsec: 500_000 } (0.5 ms) must sleep 1 ms instead of returning immediately
    let mut ts = [0u8; 16];
    ts[8..16].copy_from_slice(&500_000i64.to_le_bytes());
    ctx.mem_write(0x1000, &ts).unwrap();
    assert_eq!(handle_syscall(&mut ctx, &mut state, SYS_PPOLL, 0, 0, 0x1000, 0, 0, 0), 0);
    assert_eq!(ctx.yield_flag, 1);
    assert!(state.scheduler.on_yield(&mut ctx, 1).unwrap());
    assert_eq!(state.scheduler.virtual_mono_ns, 1_000_100);
    assert!(state.resume_active(&mut ctx).unwrap());

    // execveat with non-dir fd and relative path -> -ENOTDIR
    ctx.mem_write(0x2000, b"rel\0").unwrap();
    assert_eq!(
        handle_syscall(&mut ctx, &mut state, SYS_EXECVEAT, file_fd, 0x2000, 0, 0, 0, 0),
        -ENOTDIR
    );

    // execveat with empty path and AT_EMPTY_PATH succeeds
    ctx.mem_write(0x2004, b"\0").unwrap();
    assert_eq!(
        handle_syscall(&mut ctx, &mut state, SYS_EXECVEAT, file_fd, 0x2004, 0, 0, AT_EMPTY_PATH, 0),
        0
    );
    assert!(matches!(
        state.pending_action,
        Some(PendingHostAction::Exec { ref path, .. }) if path == "/tmp/notadir"
    ));
}

#[test]
fn test_v2_adv_vfs_enotdir_pipe_espipe_and_open_unlink_rename() {
    let mut vfs = VirtualFs::new_in_memory(&[]);
    vfs.vfs_write_file("/tmp/reg", b"x", 0o644);
    assert_eq!(vfs.openat(AT_FDCWD, "/tmp/reg/child", O_CREAT | O_RDWR), -ENOTDIR);
    assert_eq!(vfs.renameat(AT_FDCWD, "/tmp/reg", AT_FDCWD, "/tmp/reg/child"), -ENOTDIR);

    let (rfd, wfd) = vfs.create_pipe().unwrap();
    assert_eq!(vfs.pread64(rfd, 4, 0), Err(-ESPIPE));
    assert_eq!(vfs.pwrite64(wfd, b"abc", 0, 0), -ESPIPE);

    // Open overlay file, rename it, write & read via open FD
    let fd = vfs.openat(AT_FDCWD, "/tmp/orig", O_CREAT | O_RDWR) as i32;
    assert_eq!(vfs.write(fd, b"hello"), 5);
    assert_eq!(vfs.renameat(AT_FDCWD, "/tmp/orig", AT_FDCWD, "/tmp/moved"), 0);
    assert_eq!(vfs.write(fd, b"!"), 1);
    assert_eq!(vfs.lseek(fd, 0, 0), 0);
    assert_eq!(vfs.read_no_advance(fd, 16).unwrap().0, b"hello!");

    // Unlink open overlay file, then write at end, ftruncate, fstat, and read via open FD
    assert_eq!(vfs.unlinkat(AT_FDCWD, "/tmp/moved", 0), 0);
    assert_eq!(vfs.lseek(fd, 0, 2), 6);
    assert_eq!(vfs.write(fd, b"?"), 1);
    assert_eq!(vfs.lseek(fd, 0, 0), 0);
    assert_eq!(vfs.read_no_advance(fd, 16).unwrap().0, b"hello!?");
    assert_eq!(vfs.ftruncate(fd, 4, 0), 0);
    assert_eq!(vfs.stat_fd(fd).unwrap().st_size, 4);
    assert_eq!(vfs.close(fd), 0);
}
