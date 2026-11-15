use crate::decoder::{BlockTerminator, DecodedBlock, DecodedProgram, FastHashMap};
use crate::elf_loader::{LoadedImage, INITIAL_MEM_PAGES};
use crate::lifter::{
    Lifter, DEFAULT_QUANTUM, GLOBAL_CF, GLOBAL_DF, GLOBAL_EXIT_CODE, GLOBAL_EXIT_FLAG,
    GLOBAL_FSBASE, GLOBAL_GSBASE, GLOBAL_MXCSR, GLOBAL_QUANTUM, GLOBAL_RAX, GLOBAL_RIP, GLOBAL_RSP,
    GLOBAL_TSC, GLOBAL_X87_CW, GLOBAL_XMM_BASE, GLOBAL_YIELD_FLAG, GPR_NAMES, LOCAL_I64_0,
    LOCAL_PC_IDX,
};
use crate::meta::{MetaSoFile, WasmMeta};
use anyhow::Result;
use iced_x86::Mnemonic;
use std::borrow::Cow;
use wasm_encoder::{
    BlockType, CodeSection, ConstExpr, CustomSection, DataSection, ElementSection, Elements,
    EntityType, ExportKind, ExportSection, Function, FunctionSection, GlobalSection, GlobalType,
    ImportSection, Instruction as WInst, MemArg, MemorySection, MemoryType, Module, RefType,
    TableSection, TableType, TypeSection, ValType,
};

pub const DISPATCH_HASH_ADDR: u32 = 0x0C00_0000;
const CHUNK_MAX_BLOCKS: usize = 512;
const CHUNK_MAX_INSTRS: usize = 4096;

fn make_chunk_function() -> Function {
    // Param 0 is i32 ($pc_idx) from function type.
    // Locals: 8 x i64, 8 x i32, 4 x f64, 4 x f32, 4 x v128
    Function::new([
        (8, ValType::I64),
        (8, ValType::I32),
        (4, ValType::F64),
        (4, ValType::F32),
        (4, ValType::V128),
    ])
}

fn emit_jump_target(
    func: &mut Function,
    target_va: u32,
    chunk_block_map: &FastHashMap<u32, u32>,
    dispatch_depth: u32,
) {
    if let Some(&local_idx) = chunk_block_map.get(&target_va) {
        func.instruction(&WInst::GlobalGet(GLOBAL_QUANTUM));
        func.instruction(&WInst::I32Const(1));
        func.instruction(&WInst::I32Sub);
        func.instruction(&WInst::GlobalSet(GLOBAL_QUANTUM));

        func.instruction(&WInst::GlobalGet(GLOBAL_QUANTUM));
        func.instruction(&WInst::I32Const(0));
        func.instruction(&WInst::I32LeS);
        func.instruction(&WInst::If(BlockType::Empty));
        func.instruction(&WInst::I64Const(target_va as i64));
        func.instruction(&WInst::GlobalSet(GLOBAL_RIP));
        func.instruction(&WInst::I32Const(2));
        func.instruction(&WInst::GlobalSet(GLOBAL_YIELD_FLAG));
        func.instruction(&WInst::Return);
        func.instruction(&WInst::End);

        func.instruction(&WInst::I32Const(local_idx as i32));
        func.instruction(&WInst::LocalSet(LOCAL_PC_IDX));
        func.instruction(&WInst::Br(dispatch_depth));
    } else {
        func.instruction(&WInst::I64Const(target_va as i64));
        func.instruction(&WInst::GlobalSet(GLOBAL_RIP));
        func.instruction(&WInst::Return);
    }
}

fn emit_push_ret_addr(func: &mut Function, ret_va: u32) {
    func.instruction(&WInst::GlobalGet(GLOBAL_RSP));
    func.instruction(&WInst::I64Const(8));
    func.instruction(&WInst::I64Sub);
    func.instruction(&WInst::GlobalSet(GLOBAL_RSP));

    func.instruction(&WInst::GlobalGet(GLOBAL_RSP));
    func.instruction(&WInst::I32WrapI64);
    func.instruction(&WInst::I64Const(ret_va as i64));
    func.instruction(&WInst::I64Store(MemArg {
        offset: 0,
        align: 3,
        memory_index: 0,
    }));
}

fn emit_chunk_function(
    chunk: &[&DecodedBlock],
    chunk_block_map: &FastHashMap<u32, u32>,
) -> Function {
    let mut func = make_chunk_function();
    let n = chunk.len() as u32;

    // (block $trap
    //   (loop $dispatch
    //     (block $b_{n-1} ... (block $b_0
    //       (local.get 0) (br_table 0 1 ... n-1 (n+1))
    //     ) ... )
    //   )
    // )
    // (unreachable)
    func.instruction(&WInst::Block(BlockType::Empty)); // $trap
    func.instruction(&WInst::Loop(BlockType::Empty)); // $dispatch
    for _ in 0..n {
        func.instruction(&WInst::Block(BlockType::Empty));
    }

    func.instruction(&WInst::LocalGet(LOCAL_PC_IDX));
    let targets: Vec<u32> = (0..n).collect();
    func.instruction(&WInst::BrTable(Cow::Owned(targets), n + 1));

    for (idx, block) in chunk.iter().enumerate() {
        func.instruction(&WInst::End); // closes $b_{idx}
        let dispatch_depth = (n - 1) - (idx as u32);

        let instrs = &block.instructions;
        let has_term_instr = match block.terminator {
            BlockTerminator::Fallthrough(_) => false,
            BlockTerminator::Trap => instrs.last().is_some_and(|i| {
                matches!(
                    i.mnemonic(),
                    Mnemonic::Ud2
                        | Mnemonic::Hlt
                        | Mnemonic::Int3
                        | Mnemonic::Int
                        | Mnemonic::Into
                        | Mnemonic::INVALID
                )
            }),
            _ => true,
        };
        let body_len = if has_term_instr && !instrs.is_empty() {
            instrs.len() - 1
        } else {
            instrs.len()
        };

        {
            let mut lifter = Lifter::new(&mut func);
            for instr in &instrs[..body_len] {
                lifter.lift_instruction(instr);
            }
        }

        match block.terminator {
            BlockTerminator::Fallthrough(next_va) | BlockTerminator::DirectJump(next_va) => {
                emit_jump_target(&mut func, next_va, chunk_block_map, dispatch_depth);
            }
            BlockTerminator::ConditionalBranch { taken, fallthrough } => {
                if let Some(last) = instrs.last() {
                    let mut lifter = Lifter::new(&mut func);
                    match last.mnemonic() {
                        Mnemonic::Jrcxz => {
                            func.instruction(&WInst::GlobalGet(crate::lifter::GLOBAL_RCX));
                            func.instruction(&WInst::I64Eqz);
                        }
                        Mnemonic::Jecxz => {
                            func.instruction(&WInst::GlobalGet(crate::lifter::GLOBAL_RCX));
                            func.instruction(&WInst::I32WrapI64);
                            func.instruction(&WInst::I32Eqz);
                        }
                        _ => {
                            lifter.emit_condition(last.condition_code());
                        }
                    }
                    func.instruction(&WInst::If(BlockType::Empty));
                    emit_jump_target(&mut func, taken, chunk_block_map, dispatch_depth + 1);
                    func.instruction(&WInst::End);
                    emit_jump_target(&mut func, fallthrough, chunk_block_map, dispatch_depth);
                } else {
                    func.instruction(&WInst::Unreachable);
                }
            }
            BlockTerminator::DirectCall {
                target,
                fallthrough,
            } => {
                emit_push_ret_addr(&mut func, fallthrough);
                emit_jump_target(&mut func, target, chunk_block_map, dispatch_depth);
            }
            BlockTerminator::IndirectCall { fallthrough } => {
                if let Some(last) = instrs.last() {
                    {
                        let mut lifter = Lifter::new(&mut func);
                        lifter.emit_indirect_target_i64(last);
                    }
                    func.instruction(&WInst::LocalSet(LOCAL_I64_0));
                    emit_push_ret_addr(&mut func, fallthrough);
                    func.instruction(&WInst::LocalGet(LOCAL_I64_0));
                    func.instruction(&WInst::GlobalSet(GLOBAL_RIP));
                    func.instruction(&WInst::Return);
                } else {
                    func.instruction(&WInst::Unreachable);
                }
            }
            BlockTerminator::IndirectJump => {
                if let Some(last) = instrs.last() {
                    {
                        let mut lifter = Lifter::new(&mut func);
                        lifter.emit_indirect_target_i64(last);
                    }
                    func.instruction(&WInst::GlobalSet(GLOBAL_RIP));
                    func.instruction(&WInst::Return);
                } else {
                    func.instruction(&WInst::Unreachable);
                }
            }
            BlockTerminator::Return => {
                let extra_pop = instrs
                    .last()
                    .and_then(|i| {
                        if i.op_count() > 0 {
                            Some(i.immediate16() as i64)
                        } else {
                            None
                        }
                    })
                    .unwrap_or(0);

                func.instruction(&WInst::GlobalGet(GLOBAL_RSP));
                func.instruction(&WInst::I32WrapI64);
                func.instruction(&WInst::I64Load(MemArg {
                    offset: 0,
                    align: 3,
                    memory_index: 0,
                }));
                func.instruction(&WInst::LocalSet(LOCAL_I64_0));

                func.instruction(&WInst::GlobalGet(GLOBAL_RSP));
                func.instruction(&WInst::I64Const(8 + extra_pop));
                func.instruction(&WInst::I64Add);
                func.instruction(&WInst::GlobalSet(GLOBAL_RSP));

                func.instruction(&WInst::LocalGet(LOCAL_I64_0));
                func.instruction(&WInst::GlobalSet(GLOBAL_RIP));
                func.instruction(&WInst::Return);
            }
            BlockTerminator::Trap => {
                func.instruction(&WInst::Unreachable);
            }
        }
    }

    func.instruction(&WInst::End); // closes $dispatch
    func.instruction(&WInst::End); // closes $trap
    func.instruction(&WInst::Unreachable);
    func.instruction(&WInst::End); // function end
    func
}

fn emit_start_function(num_chunks: u32, hash_mask: u32) -> Function {
    // Locals: 0=$va(i32), 1=$slot(i32), 2=$slot_va(i32), 3=$packed(i32)
    let mut func = Function::new([(4, ValType::I32)]);

    if num_chunks == 0 {
        func.instruction(&WInst::GlobalGet(GLOBAL_EXIT_CODE));
        func.instruction(&WInst::Return);
        func.instruction(&WInst::End);
        return func;
    }

    // loop $trampoline
    func.instruction(&WInst::Loop(BlockType::Empty));
    {
        // if exit_flag != 0 { return exit_code }
        func.instruction(&WInst::GlobalGet(GLOBAL_EXIT_FLAG));
        func.instruction(&WInst::If(BlockType::Empty));
        func.instruction(&WInst::GlobalGet(GLOBAL_EXIT_CODE));
        func.instruction(&WInst::Return);
        func.instruction(&WInst::End);

        // if yield_flag != 0 { return exit_code }
        func.instruction(&WInst::GlobalGet(GLOBAL_YIELD_FLAG));
        func.instruction(&WInst::If(BlockType::Empty));
        func.instruction(&WInst::GlobalGet(GLOBAL_EXIT_CODE));
        func.instruction(&WInst::Return);
        func.instruction(&WInst::End);

        // if rip == 0 { return exit_code }
        func.instruction(&WInst::GlobalGet(GLOBAL_RIP));
        func.instruction(&WInst::I64Eqz);
        func.instruction(&WInst::If(BlockType::Empty));
        func.instruction(&WInst::GlobalGet(GLOBAL_EXIT_CODE));
        func.instruction(&WInst::Return);
        func.instruction(&WInst::End);

        // if (rip >> 32) != 0 { unreachable (trap) }
        func.instruction(&WInst::GlobalGet(GLOBAL_RIP));
        func.instruction(&WInst::I64Const(32));
        func.instruction(&WInst::I64ShrU);
        func.instruction(&WInst::I64Const(0));
        func.instruction(&WInst::I64Ne);
        func.instruction(&WInst::If(BlockType::Empty));
        func.instruction(&WInst::Unreachable);
        func.instruction(&WInst::End);

        // if quantum <= 0 { yield_flag = 2; return exit_code }
        func.instruction(&WInst::GlobalGet(GLOBAL_QUANTUM));
        func.instruction(&WInst::I32Const(0));
        func.instruction(&WInst::I32LeS);
        func.instruction(&WInst::If(BlockType::Empty));
        func.instruction(&WInst::I32Const(2));
        func.instruction(&WInst::GlobalSet(GLOBAL_YIELD_FLAG));
        func.instruction(&WInst::GlobalGet(GLOBAL_EXIT_CODE));
        func.instruction(&WInst::Return);
        func.instruction(&WInst::End);

        // va = rip as i32
        func.instruction(&WInst::GlobalGet(GLOBAL_RIP));
        func.instruction(&WInst::I32WrapI64);
        func.instruction(&WInst::LocalTee(0));

        // slot = (va * 0x9E37_79B1) & hash_mask
        func.instruction(&WInst::I32Const(0x9E37_79B1u32 as i32));
        func.instruction(&WInst::I32Mul);
        func.instruction(&WInst::I32Const(hash_mask as i32));
        func.instruction(&WInst::I32And);
        func.instruction(&WInst::LocalSet(1));

        // loop $probe
        func.instruction(&WInst::Loop(BlockType::Empty));
        {
            // byte_off = slot << 3 -> local 2 (temporarily), load slot_va
            func.instruction(&WInst::LocalGet(1));
            func.instruction(&WInst::I32Const(3));
            func.instruction(&WInst::I32Shl);
            func.instruction(&WInst::I32Load(MemArg {
                offset: DISPATCH_HASH_ADDR as u64,
                align: 2,
                memory_index: 0,
            }));
            func.instruction(&WInst::LocalTee(2));

            // if slot_va == va
            func.instruction(&WInst::LocalGet(0));
            func.instruction(&WInst::I32Eq);
            func.instruction(&WInst::If(BlockType::Empty));
            {
                // Consume 1 quantum for this block dispatch
                func.instruction(&WInst::GlobalGet(GLOBAL_QUANTUM));
                func.instruction(&WInst::I32Const(1));
                func.instruction(&WInst::I32Sub);
                func.instruction(&WInst::GlobalSet(GLOBAL_QUANTUM));

                // packed = i32.load(offset = DISPATCH_HASH_ADDR + 4)(slot << 3)
                func.instruction(&WInst::LocalGet(1));
                func.instruction(&WInst::I32Const(3));
                func.instruction(&WInst::I32Shl);
                func.instruction(&WInst::I32Load(MemArg {
                    offset: (DISPATCH_HASH_ADDR + 4) as u64,
                    align: 2,
                    memory_index: 0,
                }));
                func.instruction(&WInst::LocalTee(3));

                // local_idx = packed & 0x3FF
                func.instruction(&WInst::I32Const(0x3FF));
                func.instruction(&WInst::I32And);

                // chunk_idx = packed >> 10
                func.instruction(&WInst::LocalGet(3));
                func.instruction(&WInst::I32Const(10));
                func.instruction(&WInst::I32ShrU);

                // call_indirect type 1 (chunk_fn), table 0
                func.instruction(&WInst::CallIndirect {
                    type_index: 1,
                    table_index: 0,
                });
                // br $trampoline (depth 2: out of if -> out of $probe -> $trampoline)
                func.instruction(&WInst::Br(2));
            }
            func.instruction(&WInst::End);

            // if slot_va == 0 -> trap
            func.instruction(&WInst::LocalGet(2));
            func.instruction(&WInst::I32Eqz);
            func.instruction(&WInst::If(BlockType::Empty));
            func.instruction(&WInst::Unreachable);
            func.instruction(&WInst::End);

            // slot = (slot + 1) & hash_mask
            func.instruction(&WInst::LocalGet(1));
            func.instruction(&WInst::I32Const(1));
            func.instruction(&WInst::I32Add);
            func.instruction(&WInst::I32Const(hash_mask as i32));
            func.instruction(&WInst::I32And);
            func.instruction(&WInst::LocalSet(1));
            func.instruction(&WInst::Br(0));
        }
        func.instruction(&WInst::End); // end $probe
    }
    func.instruction(&WInst::End); // end $trampoline

    func.instruction(&WInst::GlobalGet(GLOBAL_EXIT_CODE));
    func.instruction(&WInst::End);
    func
}

fn emit_save_ctx_function() -> Function {
    let mut func = Function::new([]);
    let store_i64 = |f: &mut Function, global_idx: u32, offset: u64| {
        f.instruction(&WInst::LocalGet(0));
        f.instruction(&WInst::GlobalGet(global_idx));
        f.instruction(&WInst::I64Store(MemArg {
            offset,
            align: 3,
            memory_index: 0,
        }));
    };
    let store_i32 = |f: &mut Function, global_idx: u32, offset: u64| {
        f.instruction(&WInst::LocalGet(0));
        f.instruction(&WInst::GlobalGet(global_idx));
        f.instruction(&WInst::I32Store(MemArg {
            offset,
            align: 2,
            memory_index: 0,
        }));
    };

    for i in 0..16u32 {
        store_i64(&mut func, GLOBAL_RAX + i, (i as u64) * 8);
    }
    store_i64(&mut func, GLOBAL_RIP, 128);
    store_i64(&mut func, GLOBAL_FSBASE, 136);
    store_i64(&mut func, GLOBAL_GSBASE, 144);
    store_i64(&mut func, GLOBAL_TSC, 152);

    for (j, g) in (GLOBAL_CF..=GLOBAL_DF).enumerate() {
        store_i32(&mut func, g, 160 + (j as u64) * 4);
    }
    store_i32(&mut func, GLOBAL_MXCSR, 188);
    store_i32(&mut func, GLOBAL_X87_CW, 192);

    for k in 0..16u32 {
        func.instruction(&WInst::LocalGet(0));
        func.instruction(&WInst::GlobalGet(GLOBAL_XMM_BASE + k));
        func.instruction(&WInst::V128Store(MemArg {
            offset: 208 + (k as u64) * 16,
            align: 4,
            memory_index: 0,
        }));
    }

    func.instruction(&WInst::End);
    func
}

fn emit_load_ctx_function() -> Function {
    let mut func = Function::new([]);
    let load_i64 = |f: &mut Function, global_idx: u32, offset: u64| {
        f.instruction(&WInst::LocalGet(0));
        f.instruction(&WInst::I64Load(MemArg {
            offset,
            align: 3,
            memory_index: 0,
        }));
        f.instruction(&WInst::GlobalSet(global_idx));
    };
    let load_i32 = |f: &mut Function, global_idx: u32, offset: u64| {
        f.instruction(&WInst::LocalGet(0));
        f.instruction(&WInst::I32Load(MemArg {
            offset,
            align: 2,
            memory_index: 0,
        }));
        f.instruction(&WInst::GlobalSet(global_idx));
    };

    for i in 0..16u32 {
        load_i64(&mut func, GLOBAL_RAX + i, (i as u64) * 8);
    }
    load_i64(&mut func, GLOBAL_RIP, 128);
    load_i64(&mut func, GLOBAL_FSBASE, 136);
    load_i64(&mut func, GLOBAL_GSBASE, 144);
    load_i64(&mut func, GLOBAL_TSC, 152);

    for (j, g) in (GLOBAL_CF..=GLOBAL_DF).enumerate() {
        load_i32(&mut func, g, 160 + (j as u64) * 4);
    }
    load_i32(&mut func, GLOBAL_MXCSR, 188);
    load_i32(&mut func, GLOBAL_X87_CW, 192);

    for k in 0..16u32 {
        func.instruction(&WInst::LocalGet(0));
        func.instruction(&WInst::V128Load(MemArg {
            offset: 208 + (k as u64) * 16,
            align: 4,
            memory_index: 0,
        }));
        func.instruction(&WInst::GlobalSet(GLOBAL_XMM_BASE + k));
    }

    func.instruction(&WInst::End);
    func
}

pub fn emit_wasm(image: &LoadedImage, prog: &DecodedProgram) -> Result<Vec<u8>> {
    // 1. Partition blocks into chunks
    let est_chunks = (prog.blocks.len() / CHUNK_MAX_BLOCKS).max(16);
    let mut chunks: Vec<(Vec<&DecodedBlock>, FastHashMap<u32, u32>)> = Vec::with_capacity(est_chunks);
    let mut cur_blocks: Vec<&DecodedBlock> = Vec::with_capacity(CHUNK_MAX_BLOCKS);
    let mut cur_map: FastHashMap<u32, u32> =
        FastHashMap::with_capacity_and_hasher(CHUNK_MAX_BLOCKS, Default::default());
    let mut cur_instrs: usize = 0;

    for (&va, block) in &prog.blocks {
        if !cur_blocks.is_empty()
            && (cur_blocks.len() >= CHUNK_MAX_BLOCKS
                || cur_instrs + block.instructions.len() > CHUNK_MAX_INSTRS)
        {
            chunks.push((
                std::mem::replace(&mut cur_blocks, Vec::with_capacity(CHUNK_MAX_BLOCKS)),
                std::mem::replace(
                    &mut cur_map,
                    FastHashMap::with_capacity_and_hasher(CHUNK_MAX_BLOCKS, Default::default()),
                ),
            ));
            cur_instrs = 0;
        }
        let local_idx = cur_blocks.len() as u32;
        cur_map.insert(va, local_idx);
        cur_blocks.push(block);
        cur_instrs += block.instructions.len();
    }
    if !cur_blocks.is_empty() {
        chunks.push((cur_blocks, cur_map));
    }

    let num_chunks = chunks.len() as u32;

    // 2. Build open-addressed dispatch hash table
    let table_slots = (prog.blocks.len() * 2).max(16).next_power_of_two();
    let table_bytes_len = table_slots * 8;
    let needed_bytes = (DISPATCH_HASH_ADDR as usize) + table_bytes_len;
    let mem_pages = INITIAL_MEM_PAGES.max(((needed_bytes + 65535) / 65536) as u32);

    let hash_mask = (table_slots - 1) as u32;
    let mut hash_bytes = vec![0u8; table_bytes_len];
    for (chunk_idx, (blocks, _)) in chunks.iter().enumerate() {
        for (local_idx, block) in blocks.iter().enumerate() {
            let va = block.start_va;
            if va == 0 {
                continue;
            }
            let packed = ((chunk_idx as u32) << 10) | (local_idx as u32);
            let mut slot = va.wrapping_mul(0x9E37_79B1) & hash_mask;
            loop {
                let off = (slot as usize) * 8;
                let existing = u32::from_le_bytes(hash_bytes[off..off + 4].try_into().unwrap());
                if existing == 0 {
                    hash_bytes[off..off + 4].copy_from_slice(&va.to_le_bytes());
                    hash_bytes[off + 4..off + 8].copy_from_slice(&packed.to_le_bytes());
                    break;
                }
                slot = (slot + 1) & hash_mask;
            }
        }
    }

    // 3. Assemble WASM Sections
    let mut module = Module::new();

    // Type Section
    let mut types = TypeSection::new();
    types.ty().function([ValType::I64; 7], [ValType::I64]); // 0: syscall
    types.ty().function([ValType::I32], []); // 1: chunk_fn
    types.ty().function([], [ValType::I32]); // 2: _start
    module.section(&types);

    // Import Section
    let mut imports = ImportSection::new();
    imports.import("env", "syscall", EntityType::Function(0));
    module.section(&imports);

    // Function Section
    let mut functions = FunctionSection::new();
    for _ in 0..num_chunks {
        functions.function(1);
    }
    functions.function(2); // _start
    functions.function(1); // save_ctx
    functions.function(1); // load_ctx
    module.section(&functions);

    // Table Section
    let mut tables = TableSection::new();
    tables.table(TableType {
        element_type: RefType::FUNCREF,
        table64: false,
        minimum: num_chunks as u64,
        maximum: Some(num_chunks as u64),
        shared: false,
    });
    module.section(&tables);

    // Memory Section
    let mut memories = MemorySection::new();
    memories.memory(MemoryType {
        minimum: mem_pages as u64,
        maximum: Some(mem_pages as u64),
        memory64: false,
        shared: false,
        page_size_log2: None,
    });
    module.section(&memories);

    // Global Section (exact order matching lifter.rs GLOBAL_* constants)
    let mut globals = GlobalSection::new();
    for _ in 0..16 {
        globals.global(
            GlobalType {
                val_type: ValType::I64,
                mutable: true,
                shared: false,
            },
            &ConstExpr::i64_const(0),
        );
    }
    // 16: rip
    globals.global(
        GlobalType {
            val_type: ValType::I64,
            mutable: true,
            shared: false,
        },
        &ConstExpr::i64_const(image.entry_rip as i64),
    );
    // 17: exit_flag, 18: exit_code
    for _ in 17..=18 {
        globals.global(
            GlobalType {
                val_type: ValType::I32,
                mutable: true,
                shared: false,
            },
            &ConstExpr::i32_const(0),
        );
    }
    // 19: fsbase, 20: gsbase
    for _ in 19..=20 {
        globals.global(
            GlobalType {
                val_type: ValType::I64,
                mutable: true,
                shared: false,
            },
            &ConstExpr::i64_const(0),
        );
    }
    // 21..=27: cf, pf, af, zf, sf, of, df
    for _ in 21..=27 {
        globals.global(
            GlobalType {
                val_type: ValType::I32,
                mutable: true,
                shared: false,
            },
            &ConstExpr::i32_const(0),
        );
    }
    // 28..=43: xmm0..xmm15
    for _ in GLOBAL_XMM_BASE..GLOBAL_XMM_BASE + 16 {
        globals.global(
            GlobalType {
                val_type: ValType::V128,
                mutable: true,
                shared: false,
            },
            &ConstExpr::v128_const(0),
        );
    }
    // 44: mxcsr
    globals.global(
        GlobalType {
            val_type: ValType::I32,
            mutable: true,
            shared: false,
        },
        &ConstExpr::i32_const(0x1F80),
    );
    // 45: tsc
    globals.global(
        GlobalType {
            val_type: ValType::I64,
            mutable: true,
            shared: false,
        },
        &ConstExpr::i64_const(1000),
    );
    let _ = GLOBAL_TSC;
    // 46: x87_cw
    globals.global(
        GlobalType {
            val_type: ValType::I32,
            mutable: true,
            shared: false,
        },
        &ConstExpr::i32_const(0x037F),
    );
    let _ = GLOBAL_X87_CW;
    // 47: yield_flag
    globals.global(
        GlobalType {
            val_type: ValType::I32,
            mutable: true,
            shared: false,
        },
        &ConstExpr::i32_const(0),
    );
    // 48: quantum
    globals.global(
        GlobalType {
            val_type: ValType::I32,
            mutable: true,
            shared: false,
        },
        &ConstExpr::i32_const(DEFAULT_QUANTUM),
    );
    module.section(&globals);

    // Export Section
    let start_func_idx = 1 + num_chunks;
    let save_ctx_func_idx = 2 + num_chunks;
    let load_ctx_func_idx = 3 + num_chunks;
    let mut exports = ExportSection::new();
    exports.export("memory", ExportKind::Memory, 0);
    exports.export("_start", ExportKind::Func, start_func_idx);
    exports.export("save_ctx", ExportKind::Func, save_ctx_func_idx);
    exports.export("load_ctx", ExportKind::Func, load_ctx_func_idx);
    for (i, name) in GPR_NAMES.iter().enumerate() {
        exports.export(name, ExportKind::Global, GLOBAL_RAX + i as u32);
    }
    exports.export("rip", ExportKind::Global, GLOBAL_RIP);
    exports.export("exit_flag", ExportKind::Global, GLOBAL_EXIT_FLAG);
    exports.export("exit_code", ExportKind::Global, GLOBAL_EXIT_CODE);
    exports.export("fsbase", ExportKind::Global, GLOBAL_FSBASE);
    exports.export("gsbase", ExportKind::Global, GLOBAL_GSBASE);
    exports.export("yield_flag", ExportKind::Global, GLOBAL_YIELD_FLAG);
    exports.export("quantum", ExportKind::Global, GLOBAL_QUANTUM);
    module.section(&exports);

    // Element Section
    if num_chunks > 0 {
        let mut elements = ElementSection::new();
        let func_indices: Vec<u32> = (1..1 + num_chunks).collect();
        elements.active(
            Some(0),
            &ConstExpr::i32_const(0),
            Elements::Functions(Cow::Owned(func_indices)),
        );
        module.section(&elements);
    }

    // Code Section
    let mut codes = CodeSection::new();
    for (blocks, map) in &chunks {
        let f = emit_chunk_function(blocks, map);
        codes.function(&f);
    }
    codes.function(&emit_start_function(num_chunks, hash_mask));
    codes.function(&emit_save_ctx_function());
    codes.function(&emit_load_ctx_function());
    module.section(&codes);

    // Data Section
    let mut data = DataSection::new();
    for seg in &image.data_segments {
        if !seg.data.is_empty() {
            data.active(
                0,
                &ConstExpr::i32_const(seg.vaddr as i32),
                seg.data.iter().copied(),
            );
        }
    }
    data.active(
        0,
        &ConstExpr::i32_const(DISPATCH_HASH_ADDR as i32),
        hash_bytes.iter().copied(),
    );
    module.section(&data);

    // Custom Section: elf2wasm_meta
    let meta = WasmMeta {
        entry_rip: image.entry_rip,
        at_phdr: image.at_phdr,
        at_phent: image.at_phent,
        at_phnum: image.at_phnum,
        at_entry: image.at_entry,
        at_base: image.at_base,
        max_code_addr: prog.max_code_addr,
        so_files: image
            .so_files
            .iter()
            .map(|so| MetaSoFile {
                guest_paths: so.guest_paths.clone(),
                base_addr: so.base_addr,
                bytes: so.bytes.clone(),
            })
            .collect(),
        symbols: vec![],
        elf_path: image.elf_path.clone(),
    };
    let meta_bytes = meta.encode();
    module.section(&CustomSection {
        name: Cow::Borrowed("elf2wasm_meta"),
        data: Cow::Owned(meta_bytes),
    });

    Ok(module.finish())
}

#[cfg(all(test, not(target_arch = "wasm32"), feature = "std-fs"))]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use crate::decoder::discover_code;
    use crate::elf_loader::{load_elf_and_sos, ExecSegment, STACK_TOP};
    use std::path::Path;
    use wasmtime::{Caller, Engine, Linker, Module as WasmModule, Store};

    fn make_synthetic_image(code: Vec<u8>) -> LoadedImage {
        LoadedImage {
            entry_rip: 0x0010_0000,
            at_phdr: 0,
            at_phent: 56,
            at_phnum: 0,
            at_entry: 0x0010_0000,
            at_base: 0,
            exec_segments: vec![ExecSegment {
                name: "synth".to_string(),
                vaddr: 0x0010_0000,
                data: code,
            }],
            data_segments: vec![],
            so_files: vec![],
            symbols: HashMap::new(),
            elf_path: String::new(),
        }
    }

    #[derive(Default)]
    struct TestHost {
        syscalls: Vec<(i64, i64, i64, i64, i64, i64, i64)>,
    }

    fn run_snippet(code: Vec<u8>, fsbase_init: i64) -> (i32, HashMap<String, i64>, Vec<u8>, TestHost) {
        let image = make_synthetic_image(code);
        let prog = discover_code(&image).expect("discover_code failed");
        let wasm_bytes = emit_wasm(&image, &prog).expect("emit_wasm failed");

        let engine = Engine::default();
        WasmModule::validate(&engine, &wasm_bytes).expect("wasm validation failed");
        let module = WasmModule::new(&engine, &wasm_bytes).expect("wasm compile failed");

        let mut linker = Linker::new(&engine);
        linker
            .func_wrap(
                "env",
                "syscall",
                |mut caller: Caller<'_, TestHost>,
                 nr: i64,
                 a0: i64,
                 a1: i64,
                 a2: i64,
                 a3: i64,
                 a4: i64,
                 a5: i64|
                 -> i64 {
                    caller.data_mut().syscalls.push((nr, a0, a1, a2, a3, a4, a5));
                    if nr == 60 || nr == 231 {
                        // exit / exit_group
                        if let Some(ext) = caller.get_export("exit_flag").and_then(|e| e.into_global()) {
                            let _ = ext.set(&mut caller, wasmtime::Val::I32(1));
                        }
                        if let Some(ext) = caller.get_export("exit_code").and_then(|e| e.into_global()) {
                            let _ = ext.set(&mut caller, wasmtime::Val::I32(a0 as i32));
                        }
                        return 0;
                    }
                    42
                },
            )
            .unwrap();

        let mut store = Store::new(&engine, TestHost::default());
        let instance = linker.instantiate(&mut store, &module).unwrap();

        // Initialize RSP to STACK_TOP and push 0 return address so `ret` exits cleanly
        let mem = instance.get_memory(&mut store, "memory").unwrap();
        let rsp_val = (STACK_TOP - 8) as i64;
        mem.write(&mut store, (STACK_TOP - 8) as usize, &0u64.to_le_bytes())
            .unwrap();
        instance
            .get_global(&mut store, "rsp")
            .unwrap()
            .set(&mut store, wasmtime::Val::I64(rsp_val))
            .unwrap();
        if fsbase_init != 0 {
            instance
                .get_global(&mut store, "fsbase")
                .unwrap()
                .set(&mut store, wasmtime::Val::I64(fsbase_init))
                .unwrap();
        }

        let start = instance
            .get_typed_func::<(), i32>(&mut store, "_start")
            .unwrap();
        let exit_code = start.call(&mut store, ()).unwrap();

        let mut regs = HashMap::new();
        for name in GPR_NAMES {
            let v = instance
                .get_global(&mut store, name)
                .unwrap()
                .get(&mut store)
                .i64()
                .unwrap();
            regs.insert(name.to_string(), v);
        }

        let mut mem_buf = vec![0u8; 256];
        mem.read(&store, 0x0020_0000, &mut mem_buf).unwrap();
        (exit_code, regs, mem_buf, store.into_data())
    }

    fn extract_custom_section<'a>(wasm: &'a [u8], target_name: &str) -> Option<&'a [u8]> {
        fn read_leb_u32(data: &[u8], pos: &mut usize) -> u32 {
            let mut res = 0u32;
            let mut shift = 0;
            loop {
                let b = data[*pos];
                *pos += 1;
                res |= ((b & 0x7F) as u32) << shift;
                if b & 0x80 == 0 {
                    break;
                }
                shift += 7;
            }
            res
        }
        let mut pos = 8; // skip \0asm + version
        while pos < wasm.len() {
            let id = wasm[pos];
            pos += 1;
            let size = read_leb_u32(wasm, &mut pos) as usize;
            let end = pos + size;
            if id == 0 {
                let mut p = pos;
                let name_len = read_leb_u32(wasm, &mut p) as usize;
                if let Ok(name) = std::str::from_utf8(&wasm[p..p + name_len]) {
                    if name == target_name {
                        return Some(&wasm[p + name_len..end]);
                    }
                }
            }
            pos = end;
        }
        None
    }

    #[test]
    fn test_validate_true_wasm() {
        use std::path::PathBuf;
        let image = load_elf_and_sos(
            Path::new("/usr/bin/true"),
            &[
                PathBuf::from("/lib64/ld-linux-x86-64.so.2"),
                PathBuf::from("/lib/x86_64-linux-gnu/libc.so.6"),
            ],
        )
        .unwrap();
        let prog = discover_code(&image).unwrap();
        let wasm_bytes = emit_wasm(&image, &prog).unwrap();
        let engine = Engine::default();
        WasmModule::validate(&engine, &wasm_bytes).expect("true .wasm failed validation");

        let meta_sec = extract_custom_section(&wasm_bytes, "elf2wasm_meta").unwrap();
        let meta = WasmMeta::decode(meta_sec).unwrap();
        assert_eq!(meta.entry_rip, image.entry_rip);
    }

    #[test]
    fn test_validate_echo_wasm() {
        use std::path::PathBuf;
        let image = load_elf_and_sos(
            Path::new("/usr/bin/echo"),
            &[
                PathBuf::from("/lib64/ld-linux-x86-64.so.2"),
                PathBuf::from("/lib/x86_64-linux-gnu/libc.so.6"),
            ],
        )
        .unwrap();
        let prog = discover_code(&image).unwrap();
        let wasm_bytes = emit_wasm(&image, &prog).unwrap();
        let engine = Engine::default();
        WasmModule::validate(&engine, &wasm_bytes).expect("echo .wasm failed validation");
    }

    #[test]
    fn test_validate_python3_wasm() {
        use std::path::PathBuf;
        let image = load_elf_and_sos(
            Path::new("/usr/bin/python3"),
            &[
                PathBuf::from("/lib64/ld-linux-x86-64.so.2"),
                PathBuf::from("/lib/x86_64-linux-gnu/libc.so.6"),
                PathBuf::from("/lib/x86_64-linux-gnu/libm.so.6"),
                PathBuf::from("/lib/x86_64-linux-gnu/libz.so.1"),
                PathBuf::from("/lib/x86_64-linux-gnu/libexpat.so.1"),
            ],
        )
        .unwrap();
        let prog = discover_code(&image).unwrap();
        let wasm_bytes = emit_wasm(&image, &prog).unwrap();
        let engine = Engine::default();
        WasmModule::validate(&engine, &wasm_bytes).expect("python3 .wasm failed validation");
    }

    #[test]
    fn test_exec_arithmetic_and_subregs() {
        // mov rax, 0x1122334455667788
        // mov eax, 0xAABBCCDD  (zero-extends upper 32 bits -> rax = 0xAABBCCDD)
        // mov ah, 0x11         (rax = 0xAABB11DD)
        // mov al, 0x22         (rax = 0xAABB1122)
        // mov rbx, 10
        // add rax, rbx         (rax = 0xAABB112C)
        // imul rcx, rbx, 3     (rcx = 30)
        // mov rdx, 0
        // mov rsi, 7
        // xchg rax, rsi        (rax = 7, rsi = 0xAABB112C)
        // mov rax, 100
        // mov rdx, 0
        // div rsi              (100 / 0xAABB112C -> q=0, r=100)
        // mov rax, -25
        // cqo
        // mov r8, 4
        // idiv r8              (rax = -6, rdx = -1)
        // ret
        let code = vec![
            0x48, 0xB8, 0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11, // mov rax, imm64
            0xB8, 0xDD, 0xCC, 0xBB, 0xAA, // mov eax, 0xAABBCCDD
            0xB4, 0x11, // mov ah, 0x11
            0xB0, 0x22, // mov al, 0x22
            0x48, 0xC7, 0xC3, 0x0A, 0x00, 0x00, 0x00, // mov rbx, 10
            0x48, 0x01, 0xD8, // add rax, rbx
            0x48, 0x6B, 0xCB, 0x03, // imul rcx, rbx, 3
            0x48, 0x89, 0xC6, // mov rsi, rax
            0x48, 0xC7, 0xC0, 0xE7, 0xFF, 0xFF, 0xFF, // mov rax, -25
            0x48, 0x99, // cqo
            0x49, 0xC7, 0xC0, 0x04, 0x00, 0x00, 0x00, // mov r8, 4
            0x49, 0xF7, 0xF8, // idiv r8
            0xC3, // ret
        ];
        let (_ec, regs, _, _) = run_snippet(code, 0);
        assert_eq!(regs["rsi"], 0xAABB_112Ci64);
        assert_eq!(regs["rcx"], 30);
        assert_eq!(regs["rax"], -6);
        assert_eq!(regs["rdx"], -1);
    }

    #[test]
    fn test_exec_flags_inc_dec_adc_cmov_setcc() {
        // Test inc/dec preserve CF, adc uses CF, cmovcc & setcc & pushfq/popfq
        // mov rax, 0xFFFFFFFFFFFFFFFF
        // add rax, 1       ; rax=0, CF=1, ZF=1
        // mov rbx, 10
        // inc rbx          ; rbx=11, CF MUST still be 1!
        // mov rcx, 0
        // adc rcx, 5       ; rcx = 0 + 5 + 1 = 6, CF=0
        // cmp rcx, 6       ; ZF=1
        // mov rdx, 99
        // mov rsi, 42
        // cmove rdx, rsi   ; rdx = 42
        // sete r8b         ; r8 = 1
        // pushfq
        // pop r9
        // ret
        let code = vec![
            0x48, 0x31, 0xC9, // xor rcx, rcx
            0x48, 0xC7, 0xC0, 0xFF, 0xFF, 0xFF, 0xFF, // mov rax, -1
            0x48, 0x83, 0xC0, 0x01, // add rax, 1
            0x48, 0xC7, 0xC3, 0x0A, 0x00, 0x00, 0x00, // mov rbx, 10
            0x48, 0xFF, 0xC3, // inc rbx
            0x48, 0x83, 0xD1, 0x05, // adc rcx, 5
            0x48, 0x83, 0xF9, 0x06, // cmp rcx, 6
            0x48, 0xC7, 0xC2, 0x63, 0x00, 0x00, 0x00, // mov rdx, 99
            0x48, 0xC7, 0xC6, 0x2A, 0x00, 0x00, 0x00, // mov rsi, 42
            0x48, 0x0F, 0x44, 0xD6, // cmove rdx, rsi
            0x41, 0x0F, 0x94, 0xC0, // sete r8b
            0x9C, // pushfq
            0x41, 0x59, // pop r9
            0xC3, // ret
        ];
        let (_ec, regs, _, _) = run_snippet(code, 0);
        assert_eq!(regs["rbx"], 11);
        assert_eq!(regs["rcx"], 6);
        assert_eq!(regs["rdx"], 42);
        assert_eq!(regs["r8"], 1);
        // ZF (bit 6) and PF (bit 2, since 0 has even parity) should be set in r9
        assert_ne!(regs["r9"] & (1 << 6), 0);
    }

    #[test]
    fn test_exec_loop_call_ret_and_rep_stosb() {
        // Direct call to helper that sums 1..=5, plus rep stosb at 0x0020_0000
        // 0x100000: mov rdi, 0x200000
        //           mov al, 0xAA
        //           mov rcx, 8
        //           cld
        //           rep stosb
        //           mov rcx, 5
        //           call helper (+...)
        //           ret
        // helper:   xor rax, rax
        // loop_lbl: add rax, rcx
        //           dec rcx
        //           jnz loop_lbl
        //           ret
        let code = vec![
            0x48, 0xC7, 0xC7, 0x00, 0x00, 0x20, 0x00, // mov rdi, 0x200000
            0xB0, 0xAA, // mov al, 0xAA
            0x48, 0xC7, 0xC1, 0x08, 0x00, 0x00, 0x00, // mov rcx, 8
            0xFC, // cld
            0xF3, 0xAA, // rep stosb
            0x48, 0xC7, 0xC1, 0x05, 0x00, 0x00, 0x00, // mov rcx, 5
            0xE8, 0x01, 0x00, 0x00, 0x00, // call +1 (skips ret)
            0xC3, // ret
            // helper:
            0x48, 0x31, 0xC0, // xor rax, rax
            0x48, 0x01, 0xC8, // add rax, rcx
            0x48, 0xFF, 0xC9, // dec rcx
            0x75, 0xF8, // jnz -8
            0xC3, // ret
        ];
        let (_ec, regs, mem, _) = run_snippet(code, 0);
        assert_eq!(regs["rax"], 15); // 5+4+3+2+1
        assert_eq!(&mem[0..8], &[0xAAu8; 8]);
        assert_eq!(mem[8], 0);
    }

    #[test]
    fn test_exec_cpuid_xgetbv_and_fs_prefix() {
        // mov eax, 1
        // cpuid              ; rcx must be 0, rdx must have SSE2 (bit 26)
        // mov r8, rcx
        // mov r9, rdx
        // xor ecx, ecx
        // xgetbv             ; eax=3, edx=0
        // mov r10, rax
        // mov r11, rdx
        // mov qword ptr fs:[0x10], 0x12345678
        // mov rsi, qword ptr fs:[0x10]
        // ret
        let code = vec![
            0xB8, 0x01, 0x00, 0x00, 0x00, // mov eax, 1
            0x0F, 0xA2, // cpuid
            0x49, 0x89, 0xC8, // mov r8, rcx
            0x49, 0x89, 0xD1, // mov r9, rdx
            0x31, 0xC9, // xor ecx, ecx
            0x0F, 0x01, 0xD0, // xgetbv
            0x49, 0x89, 0xC2, // mov r10, rax
            0x49, 0x89, 0xD3, // mov r11, rdx
            0x64, 0x48, 0xC7, 0x04, 0x25, 0x10, 0x00, 0x00, 0x00, 0x78, 0x56, 0x34, 0x12, // mov qword ptr fs:[0x10], 0x12345678
            0x64, 0x48, 0x8B, 0x34, 0x25, 0x10, 0x00, 0x00, 0x00, // mov rsi, qword ptr fs:[0x10]
            0xC3, // ret
        ];
        let (_ec, regs, mem, _) = run_snippet(code, 0x0020_0000);
        assert_eq!(regs["r8"], 0); // ECX == 0 (AVX/OSXSAVE/SSE3/SSE4 cleared)
        assert_ne!(regs["r9"] & (1 << 26), 0); // SSE2 set
        assert_eq!(regs["r10"], 3); // xgetbv eax == 3
        assert_eq!(regs["r11"], 0); // xgetbv edx == 0
        assert_eq!(regs["rsi"], 0x1234_5678);
        assert_eq!(
            u64::from_le_bytes(mem[0x10..0x18].try_into().unwrap()),
            0x1234_5678
        );
    }

    #[test]
    fn test_exec_sse2_and_syscall_exit() {
        // pxor xmm0, xmm0
        // mov rax, 0x0000000000004100 ; 'A' at byte 1
        // movq xmm1, rax
        // mov rax, 0x0000000000004142
        // movq xmm2, rax
        // pcmpeqb xmm1, xmm2          ; byte 1 matches (0xFF), byte 0 doesn't (0x00), bytes 2..15 match (0xFF)
        // pmovmskb rbx, xmm1          ; bit 0 is 0, bits 1..15 are 1 -> 0xFFFE
        // mov eax, 7
        // cvtsi2sd xmm3, rax
        // mov eax, 3
        // cvtsi2sd xmm4, rax
        // addsd xmm3, xmm4            ; 10.0
        // cvttsd2si rcx, xmm3         ; rcx = 10
        // mov rdi, rcx                ; exit code = 10
        // mov rax, 231                ; exit_group
        // syscall
        let code = vec![
            0x66, 0x0F, 0xEF, 0xC0, // pxor xmm0, xmm0
            0x48, 0xC7, 0xC0, 0x00, 0x41, 0x00, 0x00, // mov rax, 0x4100
            0x66, 0x48, 0x0F, 0x6E, 0xC8, // movq xmm1, rax
            0x48, 0xC7, 0xC0, 0x42, 0x41, 0x00, 0x00, // mov rax, 0x4142
            0x66, 0x48, 0x0F, 0x6E, 0xD0, // movq xmm2, rax
            0x66, 0x0F, 0x74, 0xCA, // pcmpeqb xmm1, xmm2
            0x66, 0x0F, 0xD7, 0xD9, // pmovmskb ebx, xmm1
            0xB8, 0x07, 0x00, 0x00, 0x00, // mov eax, 7
            0xF2, 0x48, 0x0F, 0x2A, 0xD8, // cvtsi2sd xmm3, rax
            0xB8, 0x03, 0x00, 0x00, 0x00, // mov eax, 3
            0xF2, 0x48, 0x0F, 0x2A, 0xE0, // cvtsi2sd xmm4, rax
            0xF2, 0x0F, 0x58, 0xDC, // addsd xmm3, xmm4
            0xF2, 0x48, 0x0F, 0x2C, 0xCB, // cvttsd2si rcx, xmm3
            0x48, 0x89, 0xCF, // mov rdi, rcx
            0xB8, 0xE7, 0x00, 0x00, 0x00, // mov eax, 231
            0x0F, 0x05, // syscall
        ];
        let (ec, regs, _, host) = run_snippet(code, 0);
        assert_eq!(ec, 10);
        assert_eq!(regs["rbx"], 0xFFFE);
        assert_eq!(regs["rdi"], 10);
        assert_eq!(regs["rcx"], 0x0010_004B);
        assert_eq!(host.syscalls.len(), 1);
        assert_eq!(host.syscalls[0].0, 231);
        assert_eq!(host.syscalls[0].1, 10);
    }

    #[test]
    fn test_exec_string_movsd_rep_movsd_and_cmpsd() {
        let code = vec![
            0xC7, 0x04, 0x25, 0x00, 0x00, 0x20, 0x00, 0x44, 0x33, 0x22, 0x11, // mov dword ptr [0x200000], 0x11223344
            0xC7, 0x04, 0x25, 0x04, 0x00, 0x20, 0x00, 0x88, 0x77, 0x66, 0x55, // mov dword ptr [0x200004], 0x55667788
            0xC7, 0x04, 0x25, 0x08, 0x00, 0x20, 0x00, 0xCC, 0xBB, 0xAA, 0x99, // mov dword ptr [0x200008], 0x99AABBCC
            0xBE, 0x00, 0x00, 0x20, 0x00, // mov esi, 0x00200000
            0xBF, 0x20, 0x00, 0x20, 0x00, // mov edi, 0x00200020
            0xA5, // movsd (string 32-bit copy)
            0xB9, 0x02, 0x00, 0x00, 0x00, // mov ecx, 2
            0xF3, 0xA5, // rep movsd
            0xBE, 0x00, 0x00, 0x20, 0x00, // mov esi, 0x00200000
            0xBF, 0x20, 0x00, 0x20, 0x00, // mov edi, 0x00200020
            0xA7, // cmpsd (equal -> ZF=1)
            0x0F, 0x94, 0xC0, // sete al
            0x48, 0x0F, 0xB6, 0xC0, // movzx rax, al
            0xC7, 0x04, 0x25, 0x30, 0x00, 0x20, 0x00, 0x01, 0x00, 0x00, 0x00, // mov dword ptr [0x200030], 1
            0xBE, 0x00, 0x00, 0x20, 0x00, // mov esi, 0x00200000
            0xBF, 0x30, 0x00, 0x20, 0x00, // mov edi, 0x00200030
            0xA7, // cmpsd (unequal -> ZF=0)
            0x0F, 0x94, 0xC3, // sete bl
            0x48, 0x0F, 0xB6, 0xDB, // movzx rbx, bl
            0xC3, // ret
        ];
        let (_ec, regs, mem, _) = run_snippet(code, 0);
        assert_eq!(&mem[0x20..0x2C], &mem[0x00..0x0C]);
        assert_eq!(regs["rax"], 1);
        assert_eq!(regs["rbx"], 0);
    }

    #[test]
    fn test_exec_v128_oversized_shifts() {
        let code = vec![
            0x48, 0xC7, 0xC0, 0xFF, 0xFF, 0xFF, 0xFF, // mov rax, -1
            0x66, 0x48, 0x0F, 0x6E, 0xC0, // movq xmm0, rax
            0x66, 0x0F, 0x73, 0xD0, 0x40, // psrlq xmm0, 64
            0x66, 0x48, 0x0F, 0x7E, 0xC0, // movq rax, xmm0
            0x48, 0xC7, 0xC3, 0xFF, 0xFF, 0xFF, 0xFF, // mov rbx, -1
            0x66, 0x48, 0x0F, 0x6E, 0xCB, // movq xmm1, rbx
            0x66, 0x0F, 0x71, 0xF1, 0x10, // psllw xmm1, 16
            0x66, 0x48, 0x0F, 0x7E, 0xCB, // movq rbx, xmm1
            0xB9, 0x00, 0x80, 0x00, 0x00, // mov ecx, 0x8000
            0x66, 0x48, 0x0F, 0x6E, 0xD1, // movq xmm2, rcx
            0x66, 0x0F, 0x71, 0xE2, 0x10, // psraw xmm2, 16
            0x66, 0x48, 0x0F, 0x7E, 0xD1, // movq rcx, xmm2
            0x48, 0xC7, 0xC2, 0xFF, 0xFF, 0xFF, 0xFF, // mov rdx, -1
            0x66, 0x48, 0x0F, 0x6E, 0xC2, // movq xmm0, rdx
            0xBA, 0x40, 0x00, 0x00, 0x00, // mov edx, 64
            0x66, 0x48, 0x0F, 0x6E, 0xDA, // movq xmm3, rdx
            0x66, 0x0F, 0xD3, 0xC3, // psrlq xmm0, xmm3
            0x66, 0x48, 0x0F, 0x7E, 0xC2, // movq rdx, xmm0
            0xC3, // ret
        ];
        let (_ec, regs, _mem, _) = run_snippet(code, 0);
        assert_eq!(regs["rax"], 0);
        assert_eq!(regs["rbx"], 0);
        assert_eq!(regs["rcx"], 0xFFFF);
        assert_eq!(regs["rdx"], 0);
    }

    #[test]
    fn test_exec_cvtsd2si_rounding_vs_cvttsd2si() {
        let neg_3_9 = (-3.9f64).to_le_bytes();
        let pos_2_5 = (2.5f64).to_le_bytes();
        let pos_3_5 = (3.5f64).to_le_bytes();
        let mut code = Vec::new();
        // mov rax, -3.9f64
        code.extend_from_slice(&[0x48, 0xB8]);
        code.extend_from_slice(&neg_3_9);
        code.extend_from_slice(&[
            0x66, 0x48, 0x0F, 0x6E, 0xC0, // movq xmm0, rax
            0xF2, 0x48, 0x0F, 0x2D, 0xC0, // cvtsd2si rax, xmm0 -> -4
            0xF2, 0x48, 0x0F, 0x2C, 0xD8, // cvttsd2si rbx, xmm0 -> -3
        ]);
        // mov rcx, 2.5f64
        code.extend_from_slice(&[0x48, 0xB9]);
        code.extend_from_slice(&pos_2_5);
        code.extend_from_slice(&[
            0x66, 0x48, 0x0F, 0x6E, 0xC9, // movq xmm1, rcx
            0xF2, 0x48, 0x0F, 0x2D, 0xC9, // cvtsd2si rcx, xmm1 -> 2
        ]);
        // mov rdx, 3.5f64
        code.extend_from_slice(&[0x48, 0xBA]);
        code.extend_from_slice(&pos_3_5);
        code.extend_from_slice(&[
            0x66, 0x48, 0x0F, 0x6E, 0xD2, // movq xmm2, rdx
            0xF2, 0x48, 0x0F, 0x2D, 0xD2, // cvtsd2si rdx, xmm2 -> 4
            0xC3, // ret
        ]);
        let (_ec, regs, _mem, _) = run_snippet(code, 0);
        assert_eq!(regs["rax"], -4);
        assert_eq!(regs["rbx"], -3);
        assert_eq!(regs["rcx"], 2);
        assert_eq!(regs["rdx"], 4);
    }

    #[test]
    fn test_exec_tier5_high_rip_trap_and_xchg_reg_mem() {
        // 1. xchg rax, [rax] must compute EA before overwriting rax
        // 0x200000 is mapped data in run_snippet
        let code_xchg = vec![
            0x48, 0xC7, 0xC0, 0x00, 0x00, 0x20, 0x00, // mov rax, 0x200000
            0x48, 0xC7, 0x00, 0x42, 0x00, 0x00, 0x00, // mov qword ptr [rax], 0x42
            0x48, 0x87, 0x00, // xchg rax, [rax]
            0xC3, // ret
        ];
        let (_ec, regs, mem, _) = run_snippet(code_xchg, 0);
        assert_eq!(regs["rax"], 0x42);
        assert_eq!(u64::from_le_bytes(mem[0..8].try_into().unwrap()), 0x200000);

        // 2. rep movsb with rcx = 0 must not trap on unmapped rdi = 0
        let code_rep0 = vec![
            0x31, 0xC9, // xor ecx, ecx
            0x31, 0xFF, // xor edi, edi
            0x31, 0xF6, // xor esi, esi
            0xF3, 0xA4, // rep movsb
            0xB8, 0x77, 0x00, 0x00, 0x00, // mov eax, 0x77
            0xC3, // ret
        ];
        let (_ec, regs, _, _) = run_snippet(code_rep0, 0);
        assert_eq!(regs["rax"], 0x77);

        // 3. Indirect jump to 0x1_0000_0000 must TRAP (not wrap to 0 and jump to block 0!)
        let code_hi_rip = vec![
            0x48, 0xB8, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, // mov rax, 0x1_0000_0000
            0xFF, 0xE0, // jmp rax
        ];
        let image = LoadedImage {
            entry_rip: 0x0010_0000,
            at_phdr: 0,
            at_phent: 56,
            at_phnum: 0,
            at_entry: 0x0010_0000,
            at_base: 0,
            exec_segments: vec![ExecSegment {
                name: "hi_rip".to_string(),
                vaddr: 0x0010_0000,
                data: code_hi_rip,
            }],
            data_segments: vec![],
            so_files: vec![],
            symbols: std::collections::HashMap::new(),
            elf_path: "test".to_string(),
        };
        let prog = crate::decoder::discover_code(&image).unwrap();
        let wasm_bytes = emit_wasm(&image, &prog).unwrap();
        let engine = wasmtime::Engine::default();
        let module = wasmtime::Module::new(&engine, &wasm_bytes).unwrap();
        let mut linker: wasmtime::Linker<()> = wasmtime::Linker::new(&engine);
        linker
            .func_wrap("env", "syscall", |_: i64, _: i64, _: i64, _: i64, _: i64, _: i64, _: i64| -> i64 { 0 })
            .unwrap();
        let mut store = wasmtime::Store::new(&engine, ());
        let inst = linker.instantiate(&mut store, &module).unwrap();
        inst.get_global(&mut store, "rip")
            .unwrap()
            .set(&mut store, wasmtime::Val::I64(0x0010_0000))
            .unwrap();
        inst.get_global(&mut store, "rsp")
            .unwrap()
            .set(&mut store, wasmtime::Val::I64(0x0030_0000))
            .unwrap();
        let start = inst.get_typed_func::<(), i32>(&mut store, "_start").unwrap();
        assert!(start.call(&mut store, ()).is_err(), "0x1_0000_0000 indirect jump must trap!");
    }

    #[test]
    fn test_syscall_yield_and_resume() {
        // 0x100000: mov rax, 100   (48 c7 c0 64 00 00 00)
        // 0x100007: syscall        (0f 05) -> host sets yield_flag = 1 and returns 42
        // 0x100009: add rax, 5     (48 83 c0 05) -> 47
        // 0x10000d: mov rdi, rax   (48 89 c7)
        // 0x100010: mov rax, 60    (48 c7 c0 3c 00 00 00)
        // 0x100017: syscall        (0f 05) -> exit(47)
        let code = vec![
            0x48, 0xc7, 0xc0, 0x64, 0x00, 0x00, 0x00, // mov rax, 100
            0x0f, 0x05, // syscall
            0x48, 0x83, 0xc0, 0x05, // add rax, 5
            0x48, 0x89, 0xc7, // mov rdi, rax
            0x48, 0xc7, 0xc0, 0x3c, 0x00, 0x00, 0x00, // mov rax, 60
            0x0f, 0x05, // syscall
        ];
        let image = LoadedImage {
            entry_rip: 0x0010_0000,
            at_phdr: 0,
            at_phent: 56,
            at_phnum: 0,
            at_entry: 0x0010_0000,
            at_base: 0,
            exec_segments: vec![ExecSegment {
                name: "yield_test".to_string(),
                vaddr: 0x0010_0000,
                data: code,
            }],
            data_segments: vec![],
            so_files: vec![],
            symbols: std::collections::HashMap::new(),
            elf_path: "test".to_string(),
        };
        let mut prog = crate::decoder::discover_code(&image).unwrap();
        crate::decoder::split_indirect_targets(&image, &mut prog);
        let wasm_bytes = emit_wasm(&image, &prog).unwrap();
        let engine = Engine::default();
        let module = WasmModule::new(&engine, &wasm_bytes).unwrap();
        let mut linker: Linker<()> = Linker::new(&engine);
        linker
            .func_wrap(
                "env",
                "syscall",
                |mut caller: Caller<'_, ()>,
                 nr: i64,
                 a0: i64,
                 _: i64,
                 _: i64,
                 _: i64,
                 _: i64,
                 _: i64|
                 -> i64 {
                    if nr == 100 {
                        caller
                            .get_export("yield_flag")
                            .unwrap()
                            .into_global()
                            .unwrap()
                            .set(&mut caller, wasmtime::Val::I32(1))
                            .unwrap();
                        return 42;
                    }
                    if nr == 60 {
                        caller
                            .get_export("exit_code")
                            .unwrap()
                            .into_global()
                            .unwrap()
                            .set(&mut caller, wasmtime::Val::I32(a0 as i32))
                            .unwrap();
                        caller
                            .get_export("exit_flag")
                            .unwrap()
                            .into_global()
                            .unwrap()
                            .set(&mut caller, wasmtime::Val::I32(1))
                            .unwrap();
                        return 0;
                    }
                    -38
                },
            )
            .unwrap();
        let mut store = Store::new(&engine, ());
        let inst = linker.instantiate(&mut store, &module).unwrap();
        inst.get_global(&mut store, "rsp")
            .unwrap()
            .set(&mut store, wasmtime::Val::I64(STACK_TOP as i64))
            .unwrap();

        let start = inst.get_typed_func::<(), i32>(&mut store, "_start").unwrap();
        // First slice: yields on syscall 100
        let _ = start.call(&mut store, ()).unwrap();
        assert_eq!(
            inst.get_global(&mut store, "yield_flag")
                .unwrap()
                .get(&mut store)
                .i32(),
            Some(1)
        );
        assert_eq!(
            inst.get_global(&mut store, "exit_flag")
                .unwrap()
                .get(&mut store)
                .i32(),
            Some(0)
        );
        assert_eq!(
            inst.get_global(&mut store, "rip")
                .unwrap()
                .get(&mut store)
                .i64(),
            Some(0x0010_0009)
        );
        assert_eq!(
            inst.get_global(&mut store, "rax")
                .unwrap()
                .get(&mut store)
                .i64(),
            Some(42)
        );

        // Resume: clear yield_flag, reset quantum, call _start again
        inst.get_global(&mut store, "yield_flag")
            .unwrap()
            .set(&mut store, wasmtime::Val::I32(0))
            .unwrap();
        inst.get_global(&mut store, "quantum")
            .unwrap()
            .set(&mut store, wasmtime::Val::I32(DEFAULT_QUANTUM))
            .unwrap();
        let code = start.call(&mut store, ()).unwrap();
        assert_eq!(code, 47);
        assert_eq!(
            inst.get_global(&mut store, "exit_flag")
                .unwrap()
                .get(&mut store)
                .i32(),
            Some(1)
        );
    }

    #[test]
    fn test_quantum_preemption_and_resume() {
        // Loop 200 times (exceeds DEFAULT_QUANTUM = 128), then exit(rcx)
        // 0x100000: mov rcx, 200   (48 c7 c1 c8 00 00 00)
        // 0x100007: dec rcx        (48 ff c9)
        // 0x10000a: jnz 0x100007   (75 fb)
        // 0x10000c: mov rdi, 99    (48 c7 c7 63 00 00 00)
        // 0x100013: mov rax, 60    (48 c7 c0 3c 00 00 00)
        // 0x10001a: syscall        (0f 05)
        let code = vec![
            0x48, 0xc7, 0xc1, 0xc8, 0x00, 0x00, 0x00, // mov rcx, 200
            0x48, 0xff, 0xc9, // dec rcx
            0x75, 0xfb, // jnz -5 -> 0x100007
            0x48, 0xc7, 0xc7, 0x63, 0x00, 0x00, 0x00, // mov rdi, 99
            0x48, 0xc7, 0xc0, 0x3c, 0x00, 0x00, 0x00, // mov rax, 60
            0x0f, 0x05, // syscall
        ];
        let image = LoadedImage {
            entry_rip: 0x0010_0000,
            at_phdr: 0,
            at_phent: 56,
            at_phnum: 0,
            at_entry: 0x0010_0000,
            at_base: 0,
            exec_segments: vec![ExecSegment {
                name: "quantum_test".to_string(),
                vaddr: 0x0010_0000,
                data: code,
            }],
            data_segments: vec![],
            so_files: vec![],
            symbols: std::collections::HashMap::new(),
            elf_path: "test".to_string(),
        };
        let prog = crate::decoder::discover_code(&image).unwrap();
        let wasm_bytes = emit_wasm(&image, &prog).unwrap();
        let engine = Engine::default();
        let module = WasmModule::new(&engine, &wasm_bytes).unwrap();
        let mut linker: Linker<()> = Linker::new(&engine);
        linker
            .func_wrap(
                "env",
                "syscall",
                |mut caller: Caller<'_, ()>,
                 nr: i64,
                 a0: i64,
                 _: i64,
                 _: i64,
                 _: i64,
                 _: i64,
                 _: i64|
                 -> i64 {
                    if nr == 60 {
                        caller
                            .get_export("exit_code")
                            .unwrap()
                            .into_global()
                            .unwrap()
                            .set(&mut caller, wasmtime::Val::I32(a0 as i32))
                            .unwrap();
                        caller
                            .get_export("exit_flag")
                            .unwrap()
                            .into_global()
                            .unwrap()
                            .set(&mut caller, wasmtime::Val::I32(1))
                            .unwrap();
                        return 0;
                    }
                    -38
                },
            )
            .unwrap();
        let mut store = Store::new(&engine, ());
        let inst = linker.instantiate(&mut store, &module).unwrap();
        inst.get_global(&mut store, "rsp")
            .unwrap()
            .set(&mut store, wasmtime::Val::I64(STACK_TOP as i64))
            .unwrap();

        let start = inst.get_typed_func::<(), i32>(&mut store, "_start").unwrap();
        let _ = start.call(&mut store, ()).unwrap();
        assert_eq!(
            inst.get_global(&mut store, "yield_flag")
                .unwrap()
                .get(&mut store)
                .i32(),
            Some(2),
            "tight loop must preempt with yield_flag == 2"
        );
        assert_eq!(
            inst.get_global(&mut store, "exit_flag")
                .unwrap()
                .get(&mut store)
                .i32(),
            Some(0)
        );

        // Resume until completion
        let mut slices = 1;
        let mut exit_code = 0;
        loop {
            let ef = inst
                .get_global(&mut store, "exit_flag")
                .unwrap()
                .get(&mut store)
                .i32()
                .unwrap();
            if ef != 0 {
                break;
            }
            inst.get_global(&mut store, "yield_flag")
                .unwrap()
                .set(&mut store, wasmtime::Val::I32(0))
                .unwrap();
            inst.get_global(&mut store, "quantum")
                .unwrap()
                .set(&mut store, wasmtime::Val::I32(DEFAULT_QUANTUM))
                .unwrap();
            exit_code = start.call(&mut store, ()).unwrap();
            slices += 1;
            assert!(slices < 10, "loop should finish in a few slices");
        }
        assert_eq!(exit_code, 99);
    }

    #[test]
    fn test_save_ctx_load_ctx_round_trip() {
        // Program that sets GPRs, flags, and XMM0, then calls syscall to exit.
        // 0x100000: mov rax, 0x1122334455667788 (48 b8 88 77 66 55 44 33 22 11)
        // 0x10000a: mov rbx, 0x0102030405060708 (48 bb 08 07 06 05 04 03 02 01)
        // 0x100014: movq xmm0, rax              (66 48 0f 6e c0)
        // 0x100019: cmp rbx, rax                (48 39 c3) -> sets CF=1, SF=1
        // 0x10001c: mov rdi, 0                  (48 c7 c7 00 00 00 00)
        // 0x100023: mov rax, 60                 (48 c7 c0 3c 00 00 00)
        // 0x10002a: syscall                     (0f 05)
        let code = vec![
            0x48, 0xb8, 0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11, // mov rax, imm64
            0x48, 0xbb, 0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01, // mov rbx, imm64
            0x66, 0x48, 0x0f, 0x6e, 0xc0, // movq xmm0, rax
            0x48, 0x39, 0xc3, // cmp rbx, rax
            0x48, 0xc7, 0xc7, 0x00, 0x00, 0x00, 0x00, // mov rdi, 0
            0x48, 0xc7, 0xc0, 0x3c, 0x00, 0x00, 0x00, // mov rax, 60
            0x0f, 0x05, // syscall
        ];
        let image = LoadedImage {
            entry_rip: 0x0010_0000,
            at_phdr: 0,
            at_phent: 56,
            at_phnum: 0,
            at_entry: 0x0010_0000,
            at_base: 0,
            exec_segments: vec![ExecSegment {
                name: "ctx_test".to_string(),
                vaddr: 0x0010_0000,
                data: code,
            }],
            data_segments: vec![],
            so_files: vec![],
            symbols: std::collections::HashMap::new(),
            elf_path: "test".to_string(),
        };
        let prog = crate::decoder::discover_code(&image).unwrap();
        let wasm_bytes = emit_wasm(&image, &prog).unwrap();
        let engine = Engine::default();
        let module = WasmModule::new(&engine, &wasm_bytes).unwrap();
        let mut linker: Linker<()> = Linker::new(&engine);
        linker
            .func_wrap(
                "env",
                "syscall",
                |mut caller: Caller<'_, ()>,
                 nr: i64,
                 a0: i64,
                 _: i64,
                 _: i64,
                 _: i64,
                 _: i64,
                 _: i64|
                 -> i64 {
                    if nr == 60 {
                        caller
                            .get_export("exit_code")
                            .unwrap()
                            .into_global()
                            .unwrap()
                            .set(&mut caller, wasmtime::Val::I32(a0 as i32))
                            .unwrap();
                        caller
                            .get_export("exit_flag")
                            .unwrap()
                            .into_global()
                            .unwrap()
                            .set(&mut caller, wasmtime::Val::I32(1))
                            .unwrap();
                        return 0;
                    }
                    -38
                },
            )
            .unwrap();
        let mut store = Store::new(&engine, ());
        let inst = linker.instantiate(&mut store, &module).unwrap();
        inst.get_global(&mut store, "fsbase")
            .unwrap()
            .set(&mut store, wasmtime::Val::I64(0x1234_5678))
            .unwrap();
        inst.get_global(&mut store, "gsbase")
            .unwrap()
            .set(&mut store, wasmtime::Val::I64(0x9abc_def0))
            .unwrap();
        inst.get_global(&mut store, "rsp")
            .unwrap()
            .set(&mut store, wasmtime::Val::I64(STACK_TOP as i64))
            .unwrap();

        let start = inst.get_typed_func::<(), i32>(&mut store, "_start").unwrap();
        let _ = start.call(&mut store, ()).unwrap();

        let save_ctx = inst
            .get_typed_func::<i32, ()>(&mut store, "save_ctx")
            .unwrap();
        let load_ctx = inst
            .get_typed_func::<i32, ()>(&mut store, "load_ctx")
            .unwrap();

        let ctx_ptr = 0x0020_0000i32;
        save_ctx.call(&mut store, ctx_ptr).unwrap();

        // Check XMM0 was saved at offset 208 (0x1122334455667788 in low 64 bits)
        let mem = inst.get_memory(&mut store, "memory").unwrap();
        let mut xmm0_saved = [0u8; 16];
        mem.read(&store, (ctx_ptr + 208) as usize, &mut xmm0_saved)
            .unwrap();
        assert_eq!(
            u64::from_le_bytes(xmm0_saved[0..8].try_into().unwrap()),
            0x1122_3344_5566_7788
        );

        // Clobber globals
        inst.get_global(&mut store, "rax")
            .unwrap()
            .set(&mut store, wasmtime::Val::I64(0))
            .unwrap();
        inst.get_global(&mut store, "rbx")
            .unwrap()
            .set(&mut store, wasmtime::Val::I64(0))
            .unwrap();
        inst.get_global(&mut store, "fsbase")
            .unwrap()
            .set(&mut store, wasmtime::Val::I64(0))
            .unwrap();
        inst.get_global(&mut store, "gsbase")
            .unwrap()
            .set(&mut store, wasmtime::Val::I64(0))
            .unwrap();
        inst.get_global(&mut store, "rip")
            .unwrap()
            .set(&mut store, wasmtime::Val::I64(0))
            .unwrap();

        // Restore via load_ctx
        load_ctx.call(&mut store, ctx_ptr).unwrap();
        assert_eq!(
            inst.get_global(&mut store, "rbx")
                .unwrap()
                .get(&mut store)
                .i64(),
            Some(0x0102_0304_0506_0708)
        );
        assert_eq!(
            inst.get_global(&mut store, "fsbase")
                .unwrap()
                .get(&mut store)
                .i64(),
            Some(0x1234_5678)
        );
        assert_eq!(
            inst.get_global(&mut store, "gsbase")
                .unwrap()
                .get(&mut store)
                .i64(),
            Some(0x9abc_def0)
        );

        // Save again to another slot and verify XMM0 was restored too
        let ctx_ptr2 = 0x0020_1000i32;
        save_ctx.call(&mut store, ctx_ptr2).unwrap();
        let mut xmm0_re_saved = [0u8; 16];
        mem.read(&store, (ctx_ptr2 + 208) as usize, &mut xmm0_re_saved)
            .unwrap();
        assert_eq!(xmm0_re_saved, xmm0_saved);
    }
}
