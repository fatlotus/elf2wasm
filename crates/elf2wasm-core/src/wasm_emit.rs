use crate::decoder::{
    decode_block_instructions_into, BlockTerminator, DecodedBlock, DecodedProgram, FastHashMap,
};
use crate::elf_loader::{ExecSegment, LoadedImage, INITIAL_MEM_PAGES};
use crate::lifter::{
    Lifter, DEFAULT_QUANTUM, GLOBAL_CF, GLOBAL_DF, GLOBAL_EXIT_CODE, GLOBAL_EXIT_FLAG,
    GLOBAL_FSBASE, GLOBAL_GSBASE, GLOBAL_MXCSR, GLOBAL_QUANTUM, GLOBAL_RAX, GLOBAL_RCX,
    GLOBAL_RIP, GLOBAL_RSP, GLOBAL_TSC, GLOBAL_X87_CW, GLOBAL_X87_SE_BASE, GLOBAL_X87_ST_BASE,
    GLOBAL_X87_SW, GLOBAL_X87_TOP, GLOBAL_XMM_BASE, GLOBAL_YIELD_FLAG, GPR_NAMES, LOCAL_I64_0,
    LOCAL_PC_IDX, YIELD_SYSCALL_PENDING,
};
use crate::meta::{MetaSoFile, WasmMeta};
use crate::x87::{
    emit_x87_functions_into, register_x87_functions, register_x87_types, X87_HELPER_COUNT,
};
use anyhow::Result;
use iced_x86::{Instruction, Mnemonic};
use std::borrow::Cow;
use wasm_encoder::{
    BlockType, ConstExpr, CustomSection, ElementSection, Elements, Encode, ExportKind,
    ExportSection, Function, FunctionSection, GlobalSection, GlobalType, Instruction as WInst,
    MemArg, MemorySection, MemoryType, RefType, Section, SectionId, TableSection, TableType,
    TypeSection, ValType,
};

pub const DISPATCH_HASH_ADDR: u32 = 0x0C00_0000;
const CHUNK_MAX_BLOCKS: usize = 64;
const CHUNK_MAX_INSTRS: usize = 512;

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

#[inline]
fn lookup_block_target(
    blocks_flat: &[&DecodedBlock],
    chunk_ranges: &[(usize, usize)],
    target_va: u32,
) -> Option<(u32, u32)> {
    if target_va == 0 {
        return None;
    }
    let block_idx = blocks_flat
        .binary_search_by_key(&target_va, |b| b.start_va)
        .ok()?;
    let chunk_idx = chunk_ranges.partition_point(|&(_, end)| end <= block_idx);
    let (chunk_start, _) = chunk_ranges[chunk_idx];
    Some((chunk_idx as u32, (block_idx - chunk_start) as u32))
}

/// Strictly intra-block backward dead-flag analysis over `body_instrs`.
/// Assumes all arithmetic flags (`CF/OF/AF/ZF/SF/PF`) are live at block exit.
/// Marks `skip_flags[i] = true` only for instructions that unconditionally
/// overwrite all 6 arithmetic flags without reading any flag when no subsequent
/// instruction in the block reads them before another full overwrite.
fn compute_skip_flags(body_instrs: &[Instruction], skip_flags: &mut Vec<bool>) {
    skip_flags.clear();
    skip_flags.resize(body_instrs.len(), false);
    let mut flags_live = true;

    for i in (0..body_instrs.len()).rev() {
        match body_instrs[i].mnemonic() {
            // Unconditionally overwrite all 6 arithmetic flags (CF/OF/AF/ZF/SF/PF)
            // without reading any arithmetic flag.
            Mnemonic::Add
            | Mnemonic::Sub
            | Mnemonic::And
            | Mnemonic::Or
            | Mnemonic::Xor
            | Mnemonic::Cmp
            | Mnemonic::Test
            | Mnemonic::Neg => {
                if !flags_live {
                    skip_flags[i] = true;
                }
                flags_live = false;
            }
            // Strictly flag-transparent instructions (neither read nor write CF/OF/AF/ZF/SF/PF).
            Mnemonic::Mov
            | Mnemonic::Movzx
            | Mnemonic::Movsx
            | Mnemonic::Movsxd
            | Mnemonic::Lea
            | Mnemonic::Push
            | Mnemonic::Pop
            | Mnemonic::Nop
            | Mnemonic::Endbr64
            | Mnemonic::Endbr32
            | Mnemonic::Pause
            | Mnemonic::Sfence
            | Mnemonic::Lfence
            | Mnemonic::Mfence
            | Mnemonic::Prefetcht0
            | Mnemonic::Prefetcht1
            | Mnemonic::Prefetcht2
            | Mnemonic::Prefetchnta
            | Mnemonic::Prefetchw
            | Mnemonic::Wait
            | Mnemonic::Xchg
            | Mnemonic::Bswap
            | Mnemonic::Not
            | Mnemonic::Cdq
            | Mnemonic::Cqo
            | Mnemonic::Cdqe
            | Mnemonic::Cwde
            | Mnemonic::Cbw
            | Mnemonic::Cwd
            | Mnemonic::Movaps
            | Mnemonic::Movups
            | Mnemonic::Movapd
            | Mnemonic::Movupd
            | Mnemonic::Movdqa
            | Mnemonic::Movdqu
            | Mnemonic::Movss
            | Mnemonic::Movd
            | Mnemonic::Movq
            | Mnemonic::Movlpd
            | Mnemonic::Movhpd
            | Mnemonic::Movlps
            | Mnemonic::Movhps
            | Mnemonic::Pxor
            | Mnemonic::Xorps
            | Mnemonic::Xorpd
            | Mnemonic::Por
            | Mnemonic::Pand
            | Mnemonic::Pandn => {}
            // Conservative: anything else may read or partially modify flags.
            _ => {
                flags_live = true;
            }
        }
    }
}

fn emit_quantum_backedge_check(func: &mut Function, target_va: u32) {
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
}

fn emit_jump_target(
    func: &mut Function,
    target_va: u32,
    current_va: u32,
    chunk_block_map: &FastHashMap<u32, u32>,
    blocks_flat: &[&DecodedBlock],
    chunk_ranges: &[(usize, usize)],
    dispatch_depth: u32,
    current_idx: u32,
) {
    if let Some(&local_idx) = chunk_block_map.get(&target_va) {
        if local_idx <= current_idx {
            emit_quantum_backedge_check(func, target_va);
        }

        func.instruction(&WInst::I32Const(local_idx as i32));
        func.instruction(&WInst::LocalSet(LOCAL_PC_IDX));
        func.instruction(&WInst::Br(dispatch_depth));
    } else if let Some((target_chunk, target_local)) =
        lookup_block_target(blocks_flat, chunk_ranges, target_va)
    {
        if target_va <= current_va {
            emit_quantum_backedge_check(func, target_va);
        }

        func.instruction(&WInst::I32Const(target_local as i32));
        func.instruction(&WInst::ReturnCall(target_chunk));
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
    exec_segments: &[ExecSegment],
    chunk: &[&DecodedBlock],
    chunk_block_map: &FastHashMap<u32, u32>,
    blocks_flat: &[&DecodedBlock],
    chunk_ranges: &[(usize, usize)],
    x87_helper_base: u32,
    instr_buf: &mut Vec<Instruction>,
    skip_flags_buf: &mut Vec<bool>,
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

        decode_block_instructions_into(exec_segments, block, instr_buf);
        let instrs = instr_buf.as_slice();
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

        compute_skip_flags(&instrs[..body_len], skip_flags_buf);
        {
            let mut lifter = Lifter::new(&mut func, x87_helper_base);
            for (i, instr) in instrs[..body_len].iter().enumerate() {
                lifter.lift_instruction_with_flags(instr, skip_flags_buf[i]);
            }
        }

        match block.terminator {
            BlockTerminator::Fallthrough(next_va) | BlockTerminator::DirectJump(next_va) => {
                emit_jump_target(
                    &mut func,
                    next_va,
                    block.start_va,
                    chunk_block_map,
                    blocks_flat,
                    chunk_ranges,
                    dispatch_depth,
                    idx as u32,
                );
            }
            BlockTerminator::ConditionalBranch { taken, fallthrough } => {
                if let Some(last) = instrs.last() {
                    let mut lifter = Lifter::new(&mut func, x87_helper_base);
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
                    emit_jump_target(
                        &mut func,
                        taken,
                        block.start_va,
                        chunk_block_map,
                        blocks_flat,
                        chunk_ranges,
                        dispatch_depth + 1,
                        idx as u32,
                    );
                    func.instruction(&WInst::End);
                    emit_jump_target(
                        &mut func,
                        fallthrough,
                        block.start_va,
                        chunk_block_map,
                        blocks_flat,
                        chunk_ranges,
                        dispatch_depth,
                        idx as u32,
                    );
                } else {
                    func.instruction(&WInst::Unreachable);
                }
            }
            BlockTerminator::DirectCall {
                target,
                fallthrough,
            } => {
                emit_push_ret_addr(&mut func, fallthrough);
                emit_jump_target(
                    &mut func,
                    target,
                    block.start_va,
                    chunk_block_map,
                    blocks_flat,
                    chunk_ranges,
                    dispatch_depth,
                    idx as u32,
                );
            }
            BlockTerminator::IndirectCall { fallthrough } => {
                if let Some(last) = instrs.last() {
                    {
                        let mut lifter = Lifter::new(&mut func, x87_helper_base);
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
                        let mut lifter = Lifter::new(&mut func, x87_helper_base);
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

fn emit_start_function(num_chunks: u32, hash_mask: u32, dispatch_hash_addr: u32) -> Function {
    // Locals: 0=$va(i32), 1=$slot(i32), 2=$slot_va(i32), 3=$tmp(i32), 4=$entry_or_rip(i64)
    let mut func = Function::new([(4, ValType::I32), (1, ValType::I64)]);

    if num_chunks == 0 {
        func.instruction(&WInst::GlobalGet(GLOBAL_EXIT_CODE));
        func.instruction(&WInst::Return);
        func.instruction(&WInst::End);
        return func;
    }

    // loop $trampoline
    func.instruction(&WInst::Loop(BlockType::Empty));
    {
        // Merged exit_flag | yield_flag check
        func.instruction(&WInst::GlobalGet(GLOBAL_EXIT_FLAG));
        func.instruction(&WInst::GlobalGet(GLOBAL_YIELD_FLAG));
        func.instruction(&WInst::I32Or);
        func.instruction(&WInst::If(BlockType::Empty));
        func.instruction(&WInst::GlobalGet(GLOBAL_EXIT_CODE));
        func.instruction(&WInst::Return);
        func.instruction(&WInst::End);

        // Merged rip == 0 / (rip >> 32) != 0 check:
        // (rip - 1) >=u 0xFFFF_FFFF iff rip == 0 or rip >= 0x1_0000_0000
        func.instruction(&WInst::GlobalGet(GLOBAL_RIP));
        func.instruction(&WInst::LocalTee(4));
        func.instruction(&WInst::I64Const(1));
        func.instruction(&WInst::I64Sub);
        func.instruction(&WInst::I64Const(0xFFFF_FFFFu32 as i64));
        func.instruction(&WInst::I64GeU);
        func.instruction(&WInst::If(BlockType::Empty));
        {
            func.instruction(&WInst::LocalGet(4));
            func.instruction(&WInst::I64Eqz);
            func.instruction(&WInst::If(BlockType::Empty));
            func.instruction(&WInst::GlobalGet(GLOBAL_EXIT_CODE));
            func.instruction(&WInst::Return);
            func.instruction(&WInst::End);

            // Emulate Linux x86-64 legacy vsyscall page (0xffffffffff600000..+0x1000):
            //   0xffffffffff600000 -> vgettimeofday (SYS_gettimeofday = 96)
            //   0xffffffffff600400 -> vtime         (SYS_time         = 201)
            //   0xffffffffff600800 -> vgetcpu       (SYS_getcpu       = 309)
            // Each entry point executes `mov eax, nr; syscall; ret`.
            // Runs only on this cold branch (zero overhead on normal 32-bit RIP dispatch).
            func.instruction(&WInst::I32Const(0));
            func.instruction(&WInst::LocalSet(0));
            for &(vsyscall_va, syscall_nr) in &[
                (0xffff_ffff_ff60_0000u64, 96i32),  // vgettimeofday
                (0xffff_ffff_ff60_0400u64, 201i32), // vtime
                (0xffff_ffff_ff60_0800u64, 309i32), // vgetcpu
            ] {
                func.instruction(&WInst::LocalGet(4));
                func.instruction(&WInst::I64Const(vsyscall_va as i64));
                func.instruction(&WInst::I64Eq);
                func.instruction(&WInst::If(BlockType::Empty));
                func.instruction(&WInst::I32Const(syscall_nr));
                func.instruction(&WInst::LocalSet(0));
                func.instruction(&WInst::End);
            }

            func.instruction(&WInst::LocalGet(0));
            func.instruction(&WInst::If(BlockType::Empty));
            {
                // Bounds-check GLOBAL_RSP fits in 32-bit guest linear memory before wrapping.
                func.instruction(&WInst::GlobalGet(GLOBAL_RSP));
                func.instruction(&WInst::LocalTee(4));
                func.instruction(&WInst::I64Const(32));
                func.instruction(&WInst::I64ShrU);
                func.instruction(&WInst::I64Const(0));
                func.instruction(&WInst::I64Ne);
                func.instruction(&WInst::If(BlockType::Empty));
                func.instruction(&WInst::Unreachable);
                func.instruction(&WInst::End);

                // Pop return address from [GLOBAL_RSP] and advance GLOBAL_RSP += 8.
                func.instruction(&WInst::LocalGet(4));
                func.instruction(&WInst::I32WrapI64);
                func.instruction(&WInst::I64Load(MemArg {
                    offset: 0,
                    align: 0,
                    memory_index: 0,
                }));
                func.instruction(&WInst::LocalSet(4));

                func.instruction(&WInst::GlobalGet(GLOBAL_RSP));
                func.instruction(&WInst::I64Const(8));
                func.instruction(&WInst::I64Add);
                func.instruction(&WInst::GlobalSet(GLOBAL_RSP));

                // CPS syscall ABI: rip = rcx = ret_addr, rax = syscall_nr,
                // yield_flag = YIELD_SYSCALL_PENDING, return exit_code.
                func.instruction(&WInst::LocalGet(4));
                func.instruction(&WInst::GlobalSet(GLOBAL_RIP));
                func.instruction(&WInst::LocalGet(4));
                func.instruction(&WInst::GlobalSet(GLOBAL_RCX));
                func.instruction(&WInst::LocalGet(0));
                func.instruction(&WInst::I64ExtendI32U);
                func.instruction(&WInst::GlobalSet(GLOBAL_RAX));
                func.instruction(&WInst::I32Const(YIELD_SYSCALL_PENDING));
                func.instruction(&WInst::GlobalSet(GLOBAL_YIELD_FLAG));
                func.instruction(&WInst::GlobalGet(GLOBAL_EXIT_CODE));
                func.instruction(&WInst::Return);
            }
            func.instruction(&WInst::End);

            func.instruction(&WInst::Unreachable);
        }
        func.instruction(&WInst::End);

        // Decrement & check quantum once via local.tee:
        // q = quantum - 1; if q < 0 { yield_flag = 2; return exit_code } else { quantum = q }
        func.instruction(&WInst::GlobalGet(GLOBAL_QUANTUM));
        func.instruction(&WInst::I32Const(1));
        func.instruction(&WInst::I32Sub);
        func.instruction(&WInst::LocalTee(3));
        func.instruction(&WInst::I32Const(0));
        func.instruction(&WInst::I32LtS);
        func.instruction(&WInst::If(BlockType::Empty));
        func.instruction(&WInst::I32Const(2));
        func.instruction(&WInst::GlobalSet(GLOBAL_YIELD_FLAG));
        func.instruction(&WInst::GlobalGet(GLOBAL_EXIT_CODE));
        func.instruction(&WInst::Return);
        func.instruction(&WInst::End);
        func.instruction(&WInst::LocalGet(3));
        func.instruction(&WInst::GlobalSet(GLOBAL_QUANTUM));

        // va = rip as i32 (reusing local 4)
        func.instruction(&WInst::LocalGet(4));
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
            // Single i64.load (align 3) for (slot_va | (packed << 32))
            func.instruction(&WInst::LocalGet(1));
            func.instruction(&WInst::I32Const(3));
            func.instruction(&WInst::I32Shl);
            func.instruction(&WInst::I64Load(MemArg {
                offset: dispatch_hash_addr as u64,
                align: 3,
                memory_index: 0,
            }));
            func.instruction(&WInst::LocalTee(4));
            func.instruction(&WInst::I32WrapI64);
            func.instruction(&WInst::LocalTee(2));

            // if slot_va == va
            func.instruction(&WInst::LocalGet(0));
            func.instruction(&WInst::I32Eq);
            func.instruction(&WInst::If(BlockType::Empty));
            {
                // packed = (entry >> 32) as i32
                func.instruction(&WInst::LocalGet(4));
                func.instruction(&WInst::I64Const(32));
                func.instruction(&WInst::I64ShrU);
                func.instruction(&WInst::I32WrapI64);
                func.instruction(&WInst::LocalTee(3));

                // local_idx = packed & 0x3FF
                func.instruction(&WInst::I32Const(0x3FF));
                func.instruction(&WInst::I32And);

                // chunk_idx = packed >> 10
                func.instruction(&WInst::LocalGet(3));
                func.instruction(&WInst::I32Const(10));
                func.instruction(&WInst::I32ShrU);

                // call_indirect type 0 (chunk_fn), table 0
                func.instruction(&WInst::CallIndirect {
                    type_index: 0,
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
    store_i32(&mut func, GLOBAL_X87_TOP, 196);
    store_i32(&mut func, GLOBAL_X87_SW, 200);

    for k in 0..16u32 {
        func.instruction(&WInst::LocalGet(0));
        func.instruction(&WInst::GlobalGet(GLOBAL_XMM_BASE + k));
        func.instruction(&WInst::V128Store(MemArg {
            offset: 208 + (k as u64) * 16,
            align: 4,
            memory_index: 0,
        }));
    }

    for k in 0..8u32 {
        store_i64(&mut func, GLOBAL_X87_ST_BASE + k, 464 + (k as u64) * 8);
    }
    for k in 0..8u32 {
        func.instruction(&WInst::LocalGet(0));
        func.instruction(&WInst::GlobalGet(GLOBAL_X87_SE_BASE + k));
        func.instruction(&WInst::I32Store16(MemArg {
            offset: 528 + (k as u64) * 2,
            align: 1,
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
    load_i32(&mut func, GLOBAL_X87_TOP, 196);
    load_i32(&mut func, GLOBAL_X87_SW, 200);

    for k in 0..16u32 {
        func.instruction(&WInst::LocalGet(0));
        func.instruction(&WInst::V128Load(MemArg {
            offset: 208 + (k as u64) * 16,
            align: 4,
            memory_index: 0,
        }));
        func.instruction(&WInst::GlobalSet(GLOBAL_XMM_BASE + k));
    }

    for k in 0..8u32 {
        load_i64(&mut func, GLOBAL_X87_ST_BASE + k, 464 + (k as u64) * 8);
    }
    for k in 0..8u32 {
        func.instruction(&WInst::LocalGet(0));
        func.instruction(&WInst::I32Load16U(MemArg {
            offset: 528 + (k as u64) * 2,
            align: 1,
            memory_index: 0,
        }));
        func.instruction(&WInst::GlobalSet(GLOBAL_X87_SE_BASE + k));
    }

    func.instruction(&WInst::End);
    func
}

const ZERO_RUN_THRESHOLD: usize = 4096;

#[inline]
fn write_leb_u32(out: &mut Vec<u8>, mut val: u32) {
    loop {
        let byte = (val & 0x7f) as u8;
        val >>= 7;
        if val == 0 {
            out.push(byte);
            break;
        }
        out.push(byte | 0x80);
    }
}

#[inline]
fn write_leb_i32(out: &mut Vec<u8>, mut val: i32) {
    loop {
        let byte = (val & 0x7f) as u8;
        val >>= 7;
        let done = (val == 0 && (byte & 0x40) == 0) || (val == -1 && (byte & 0x40) != 0);
        if done {
            out.push(byte);
            break;
        }
        out.push(byte | 0x80);
    }
}

#[inline]
fn write_leb_u32_5byte(dst: &mut [u8], val: u32) {
    dst[0] = ((val & 0x7f) as u8) | 0x80;
    dst[1] = (((val >> 7) & 0x7f) as u8) | 0x80;
    dst[2] = (((val >> 14) & 0x7f) as u8) | 0x80;
    dst[3] = (((val >> 21) & 0x7f) as u8) | 0x80;
    dst[4] = ((val >> 28) & 0x0f) as u8;
}

fn push_nonzero_slices<'a>(vaddr: u32, data: &'a [u8], out: &mut Vec<(u32, &'a [u8])>) {
    let mut pos = 0usize;
    let len = data.len();
    while pos < len {
        let z_start = pos;
        while pos < len && data[pos] == 0 {
            pos += 1;
        }
        if pos - z_start >= ZERO_RUN_THRESHOLD {
            continue;
        }
        if pos == len {
            break;
        }
        let slice_start = z_start;
        let mut slice_end = pos;
        while pos < len {
            if data[pos] != 0 {
                pos += 1;
                slice_end = pos;
            } else {
                let run_start = pos;
                while pos < len && data[pos] == 0 {
                    pos += 1;
                }
                if pos - run_start >= ZERO_RUN_THRESHOLD {
                    break;
                }
                if pos < len {
                    slice_end = pos;
                }
            }
        }
        if slice_end > slice_start {
            out.push((vaddr + slice_start as u32, &data[slice_start..slice_end]));
        }
    }
}

fn write_active_data_segment(out: &mut Vec<u8>, vaddr: u32, payload: &[u8]) {
    // Active segment in memory 0: flags=0x00, i32.const vaddr, end (0x0b), byte vec
    out.push(0x00);
    out.push(0x41);
    write_leb_i32(out, vaddr as i32);
    out.push(0x0b);
    write_leb_u32(out, payload.len() as u32);
    out.extend_from_slice(payload);
}

pub fn emit_wasm(image: &LoadedImage, prog: &DecodedProgram) -> Result<Vec<u8>> {
    emit_wasm_with_prefix(image, prog, &[])
}

pub fn emit_wasm_with_prefix(
    image: &LoadedImage,
    prog: &DecodedProgram,
    prefix: &[u8],
) -> Result<Vec<u8>> {
    // 1. Partition blocks into chunk ranges over a compact flat slice of references
    let blocks_flat: Vec<&DecodedBlock> = prog.blocks.values().collect();
    let est_chunks = (blocks_flat.len() / CHUNK_MAX_BLOCKS).max(16);
    let mut chunk_ranges: Vec<(usize, usize)> = Vec::with_capacity(est_chunks);
    let mut chunk_start = 0usize;
    let mut cur_instrs = 0usize;

    for (i, block) in blocks_flat.iter().enumerate() {
        let b_instrs = block.instr_count as usize;
        if i > chunk_start
            && ((i - chunk_start) >= CHUNK_MAX_BLOCKS || cur_instrs + b_instrs > CHUNK_MAX_INSTRS)
        {
            chunk_ranges.push((chunk_start, i));
            chunk_start = i;
            cur_instrs = 0;
        }
        cur_instrs += b_instrs;
    }
    if chunk_start < blocks_flat.len() {
        chunk_ranges.push((chunk_start, blocks_flat.len()));
    }

    let num_chunks = chunk_ranges.len() as u32;

    // 2. Compute dispatch hash table sizing (<=66.7% load factor) without allocating yet
    let table_slots = (blocks_flat.len() + blocks_flat.len() / 2)
        .max(16)
        .next_power_of_two();
    let table_bytes_len = table_slots * 8;
    let dispatch_hash_addr = image.dispatch_hash_addr;
    let needed_bytes = (dispatch_hash_addr as usize)
        .checked_add(table_bytes_len)
        .ok_or_else(|| anyhow::anyhow!("Dispatch table exceeds 32-bit guest memory"))?;
    let mem_pages = INITIAL_MEM_PAGES.max(((needed_bytes + 65535) / 65536) as u32);
    let hash_mask = (table_slots - 1) as u32;

    // Pre-size single output buffer to avoid 512 MiB -> 1024 MiB Vec doubling
    let total_exec_bytes: usize = image.exec_segments.iter().map(|s| s.data.len()).sum();
    let total_data_bytes: usize = image.data_segments.iter().map(|s| s.data.len()).sum();
    let meta_est: usize = image.so_files.iter().map(|s| s.bytes.len() + 256).sum::<usize>() + 1024;
    let est_cap = prefix
        .len()
        .saturating_add(total_exec_bytes.saturating_mul(7))
        .saturating_add(total_data_bytes)
        .saturating_add(table_bytes_len)
        .saturating_add(meta_est)
        .saturating_add(65536);

    let mut out = Vec::with_capacity(est_cap);
    out.extend_from_slice(prefix);
    out.extend_from_slice(b"\0asm\x01\x00\x00\x00");

    // 3. Emit small sections directly into `out` and drop immediately
    let x87_types = {
        let mut types = TypeSection::new();
        types.ty().function([ValType::I32], []); // 0: chunk_fn, save_ctx, load_ctx
        types.ty().function([], [ValType::I32]); // 1: _start
        let x87_types = register_x87_types(&mut types, 2);
        types.append_to(&mut out);
        x87_types
    };

    {
        let mut functions = FunctionSection::new();
        for _ in 0..num_chunks {
            functions.function(0);
        }
        functions.function(1); // _start
        functions.function(0); // save_ctx
        functions.function(0); // load_ctx
        register_x87_functions(&mut functions, &x87_types);
        functions.append_to(&mut out);
    }

    {
        let mut tables = TableSection::new();
        tables.table(TableType {
            element_type: RefType::FUNCREF,
            table64: false,
            minimum: num_chunks as u64,
            maximum: Some(num_chunks as u64),
            shared: false,
        });
        tables.append_to(&mut out);
    }

    {
        let mut memories = MemorySection::new();
        memories.memory(MemoryType {
            minimum: mem_pages as u64,
            maximum: Some(mem_pages.max(32768) as u64),
            memory64: false,
            shared: false,
            page_size_log2: None,
        });
        memories.append_to(&mut out);
    }

    {
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
        // 49..=56: x87_st0..x87_st7 (i64 mantissas)
        for _ in GLOBAL_X87_ST_BASE..GLOBAL_X87_ST_BASE + 8 {
            globals.global(
                GlobalType {
                    val_type: ValType::I64,
                    mutable: true,
                    shared: false,
                },
                &ConstExpr::i64_const(0),
            );
        }
        // 57: x87_top
        globals.global(
            GlobalType {
                val_type: ValType::I32,
                mutable: true,
                shared: false,
            },
            &ConstExpr::i32_const(0),
        );
        // 58: x87_sw
        globals.global(
            GlobalType {
                val_type: ValType::I32,
                mutable: true,
                shared: false,
            },
            &ConstExpr::i32_const(0),
        );
        // 59..=66: x87_se0..x87_se7 (i32 sign+exponent)
        for _ in GLOBAL_X87_SE_BASE..GLOBAL_X87_SE_BASE + 8 {
            globals.global(
                GlobalType {
                    val_type: ValType::I32,
                    mutable: true,
                    shared: false,
                },
                &ConstExpr::i32_const(0),
            );
        }
        globals.append_to(&mut out);
    }

    {
        // Export Section
        let start_func_idx = num_chunks;
        let save_ctx_func_idx = 1 + num_chunks;
        let load_ctx_func_idx = 2 + num_chunks;
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
        exports.export("x87_cw", ExportKind::Global, GLOBAL_X87_CW);
        exports.export("x87_top", ExportKind::Global, GLOBAL_X87_TOP);
        exports.export("x87_sw", ExportKind::Global, GLOBAL_X87_SW);
        for i in 0..8u32 {
            exports.export(
                &format!("x87_st{}", i),
                ExportKind::Global,
                GLOBAL_X87_ST_BASE + i,
            );
            exports.export(
                &format!("x87_se{}", i),
                ExportKind::Global,
                GLOBAL_X87_SE_BASE + i,
            );
        }
        exports.append_to(&mut out);
    }

    if num_chunks > 0 {
        let mut elements = ElementSection::new();
        let func_indices: Vec<u32> = (0..num_chunks).collect();
        elements.active(
            Some(0),
            &ConstExpr::i32_const(0),
            Elements::Functions(Cow::Owned(func_indices)),
        );
        elements.append_to(&mut out);
    }

    // 4. Stream CodeSection directly into `out` (zero intermediate CodeSection buffer)
    {
        let x87_helper_base = num_chunks + 3;
        out.push(SectionId::Code as u8);
        let code_size_pos = out.len();
        out.extend_from_slice(&[0u8; 5]);
        let code_payload_start = out.len();

        let total_funcs = num_chunks + 3 + X87_HELPER_COUNT;
        write_leb_u32(&mut out, total_funcs);

        let mut chunk_block_map: FastHashMap<u32, u32> =
            FastHashMap::with_capacity_and_hasher(CHUNK_MAX_BLOCKS, Default::default());
        let mut instr_buf: Vec<Instruction> = Vec::with_capacity(64);
        let mut skip_flags_buf: Vec<bool> = Vec::with_capacity(64);

        for &(start, end) in &chunk_ranges {
            let chunk = &blocks_flat[start..end];
            chunk_block_map.clear();
            for (local_idx, block) in chunk.iter().enumerate() {
                chunk_block_map.insert(block.start_va, local_idx as u32);
            }
            let f = emit_chunk_function(
                &image.exec_segments,
                chunk,
                &chunk_block_map,
                &blocks_flat,
                &chunk_ranges,
                x87_helper_base,
                &mut instr_buf,
                &mut skip_flags_buf,
            );
            f.encode(&mut out);
        }
        emit_start_function(num_chunks, hash_mask, dispatch_hash_addr).encode(&mut out);
        emit_save_ctx_function().encode(&mut out);
        emit_load_ctx_function().encode(&mut out);
        emit_x87_functions_into(&mut out, x87_helper_base);

        let code_payload_len = u32::try_from(out.len() - code_payload_start)
            .map_err(|_| anyhow::anyhow!("CodeSection exceeds 32-bit WASM section size"))?;
        write_leb_u32_5byte(&mut out[code_size_pos..code_size_pos + 5], code_payload_len);
    }

    // 5. Stream DataSection directly into `out` with >=4 KiB zero-run compaction & late hash_bytes
    {
        let mut non_zero_slices: Vec<(u32, &[u8])> = Vec::new();
        for seg in &image.data_segments {
            if !seg.data.is_empty() {
                push_nonzero_slices(seg.vaddr, &seg.data, &mut non_zero_slices);
            }
        }

        out.push(SectionId::Data as u8);
        let data_size_pos = out.len();
        out.extend_from_slice(&[0u8; 5]);
        let data_payload_start = out.len();

        let num_data_segs = (non_zero_slices.len() + 1) as u32;
        write_leb_u32(&mut out, num_data_segs);

        for (vaddr, slice) in non_zero_slices {
            write_active_data_segment(&mut out, vaddr, slice);
        }

        // Allocate dispatch hash table only now, stream it, and drop immediately
        let mut hash_bytes = vec![0u8; table_bytes_len];
        for (chunk_idx, &(start, end)) in chunk_ranges.iter().enumerate() {
            for (local_idx, block) in blocks_flat[start..end].iter().enumerate() {
                let va = block.start_va;
                if va == 0 {
                    continue;
                }
                let packed = ((chunk_idx as u32) << 10) | (local_idx as u32);
                let mut slot = va.wrapping_mul(0x9E37_79B1) & hash_mask;
                loop {
                    let off = (slot as usize) * 8;
                    let existing =
                        u32::from_le_bytes(hash_bytes[off..off + 4].try_into().unwrap());
                    if existing == 0 {
                        hash_bytes[off..off + 4].copy_from_slice(&va.to_le_bytes());
                        hash_bytes[off + 4..off + 8].copy_from_slice(&packed.to_le_bytes());
                        break;
                    }
                    slot = (slot + 1) & hash_mask;
                }
            }
        }
        write_active_data_segment(&mut out, dispatch_hash_addr, &hash_bytes);
        drop(hash_bytes);

        let data_payload_len = u32::try_from(out.len() - data_payload_start)
            .map_err(|_| anyhow::anyhow!("DataSection exceeds 32-bit WASM section size"))?;
        write_leb_u32_5byte(&mut out[data_size_pos..data_size_pos + 5], data_payload_len);
    }

    // 6. Custom Section: elf2wasm_meta
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
        brk_start: image.brk_start,
        mmap_start: image.mmap_start,
        mmap_end: image.mmap_end,
        stack_top: image.stack_top,
        dispatch_hash_addr: image.dispatch_hash_addr,
    };
    let meta_bytes = meta.encode();
    CustomSection {
        name: Cow::Borrowed("elf2wasm_meta"),
        data: Cow::Owned(meta_bytes),
    }
    .append_to(&mut out);

    Ok(out)
}

#[cfg(all(test, not(target_arch = "wasm32"), feature = "std-fs"))]
mod tests {
    use super::*;
    use crate::lifter::YIELD_SYSCALL_PENDING;
    use std::collections::HashMap;
    use crate::decoder::discover_code;
    use crate::elf_loader::{load_elf_and_sos, ExecSegment, STACK_TOP};
    use std::path::Path;
    use wasmtime::{Engine, Instance, Module as WasmModule, Store};

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
            brk_start: crate::meta::DEFAULT_BRK_START,
            mmap_start: crate::meta::DEFAULT_MMAP_START,
            mmap_end: crate::meta::DEFAULT_MMAP_END,
            stack_top: crate::meta::DEFAULT_STACK_TOP,
            dispatch_hash_addr: crate::meta::DEFAULT_DISPATCH_HASH_ADDR,
        }
    }

    #[derive(Default)]
    struct TestHost {
        syscalls: Vec<(i64, i64, i64, i64, i64, i64, i64)>,
    }

    fn run_snippet(code: Vec<u8>, fsbase_init: i64) -> (i32, HashMap<String, i64>, Vec<u8>, TestHost) {
        let image = make_synthetic_image(code);
        let mut prog = discover_code(&image).expect("discover_code failed");
        crate::decoder::split_indirect_targets(&image, &mut prog);
        let wasm_bytes = emit_wasm(&image, &prog).expect("emit_wasm failed");

        let engine = Engine::default();
        WasmModule::validate(&engine, &wasm_bytes).expect("wasm validation failed");
        let module = WasmModule::new(&engine, &wasm_bytes).expect("wasm compile failed");
        assert_eq!(module.imports().len(), 0, "translated module must have zero imports");

        let mut store = Store::new(&engine, TestHost::default());
        let instance = Instance::new(&mut store, &module, &[]).unwrap();

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
        let exit_code = loop {
            let code = start.call(&mut store, ()).unwrap();
            let yield_flag = instance
                .get_global(&mut store, "yield_flag")
                .unwrap()
                .get(&mut store)
                .i32()
                .unwrap();
            if yield_flag == YIELD_SYSCALL_PENDING {
                let nr = instance.get_global(&mut store, "rax").unwrap().get(&mut store).i64().unwrap();
                let a0 = instance.get_global(&mut store, "rdi").unwrap().get(&mut store).i64().unwrap();
                let a1 = instance.get_global(&mut store, "rsi").unwrap().get(&mut store).i64().unwrap();
                let a2 = instance.get_global(&mut store, "rdx").unwrap().get(&mut store).i64().unwrap();
                let a3 = instance.get_global(&mut store, "r10").unwrap().get(&mut store).i64().unwrap();
                let a4 = instance.get_global(&mut store, "r8").unwrap().get(&mut store).i64().unwrap();
                let a5 = instance.get_global(&mut store, "r9").unwrap().get(&mut store).i64().unwrap();
                store.data_mut().syscalls.push((nr, a0, a1, a2, a3, a4, a5));
                if nr == 60 || nr == 231 {
                    instance.get_global(&mut store, "exit_flag").unwrap().set(&mut store, wasmtime::Val::I32(1)).unwrap();
                    instance.get_global(&mut store, "exit_code").unwrap().set(&mut store, wasmtime::Val::I32(a0 as i32)).unwrap();
                    instance.get_global(&mut store, "yield_flag").unwrap().set(&mut store, wasmtime::Val::I32(0)).unwrap();
                    break a0 as i32;
                } else {
                    instance.get_global(&mut store, "rax").unwrap().set(&mut store, wasmtime::Val::I64(42)).unwrap();
                    instance.get_global(&mut store, "yield_flag").unwrap().set(&mut store, wasmtime::Val::I32(0)).unwrap();
                    instance.get_global(&mut store, "quantum").unwrap().set(&mut store, wasmtime::Val::I32(DEFAULT_QUANTUM)).unwrap();
                }
            } else if yield_flag == 2 {
                instance.get_global(&mut store, "yield_flag").unwrap().set(&mut store, wasmtime::Val::I32(0)).unwrap();
                instance.get_global(&mut store, "quantum").unwrap().set(&mut store, wasmtime::Val::I32(DEFAULT_QUANTUM)).unwrap();
            } else {
                break code;
            }
        };

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
        assert_eq!(WasmModule::new(&engine, &wasm_bytes).unwrap().imports().len(), 0);

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
            brk_start: crate::meta::DEFAULT_BRK_START,
            mmap_start: crate::meta::DEFAULT_MMAP_START,
            mmap_end: crate::meta::DEFAULT_MMAP_END,
            stack_top: crate::meta::DEFAULT_STACK_TOP,
            dispatch_hash_addr: crate::meta::DEFAULT_DISPATCH_HASH_ADDR,
        };
        let prog = crate::decoder::discover_code(&image).unwrap();
        let wasm_bytes = emit_wasm(&image, &prog).unwrap();
        let engine = wasmtime::Engine::default();
        let module = wasmtime::Module::new(&engine, &wasm_bytes).unwrap();
        let mut store = wasmtime::Store::new(&engine, ());
        let inst = wasmtime::Instance::new(&mut store, &module, &[]).unwrap();
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
            brk_start: crate::meta::DEFAULT_BRK_START,
            mmap_start: crate::meta::DEFAULT_MMAP_START,
            mmap_end: crate::meta::DEFAULT_MMAP_END,
            stack_top: crate::meta::DEFAULT_STACK_TOP,
            dispatch_hash_addr: crate::meta::DEFAULT_DISPATCH_HASH_ADDR,
        };
        let mut prog = crate::decoder::discover_code(&image).unwrap();
        crate::decoder::split_indirect_targets(&image, &mut prog);
        let wasm_bytes = emit_wasm(&image, &prog).unwrap();
        let engine = Engine::default();
        let module = WasmModule::new(&engine, &wasm_bytes).unwrap();
        let mut store = Store::new(&engine, ());
        let inst = Instance::new(&mut store, &module, &[]).unwrap();
        inst.get_global(&mut store, "rsp")
            .unwrap()
            .set(&mut store, wasmtime::Val::I64(STACK_TOP as i64))
            .unwrap();

        let start = inst.get_typed_func::<(), i32>(&mut store, "_start").unwrap();
        // First slice: yields on syscall 100 with yield_flag == 3
        let _ = start.call(&mut store, ()).unwrap();
        assert_eq!(
            inst.get_global(&mut store, "yield_flag")
                .unwrap()
                .get(&mut store)
                .i32(),
            Some(YIELD_SYSCALL_PENDING)
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
            inst.get_global(&mut store, "rcx")
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
            Some(100)
        );

        // Simulate kernel handling syscall 100 -> returns 42, resume
        inst.get_global(&mut store, "rax")
            .unwrap()
            .set(&mut store, wasmtime::Val::I64(42))
            .unwrap();
        inst.get_global(&mut store, "yield_flag")
            .unwrap()
            .set(&mut store, wasmtime::Val::I32(0))
            .unwrap();
        inst.get_global(&mut store, "quantum")
            .unwrap()
            .set(&mut store, wasmtime::Val::I32(DEFAULT_QUANTUM))
            .unwrap();
        let _ = start.call(&mut store, ()).unwrap();
        assert_eq!(
            inst.get_global(&mut store, "yield_flag")
                .unwrap()
                .get(&mut store)
                .i32(),
            Some(YIELD_SYSCALL_PENDING)
        );
        assert_eq!(
            inst.get_global(&mut store, "rax")
                .unwrap()
                .get(&mut store)
                .i64(),
            Some(60)
        );
        assert_eq!(
            inst.get_global(&mut store, "rdi")
                .unwrap()
                .get(&mut store)
                .i64(),
            Some(47)
        );

        // Simulate kernel handling exit(47)
        inst.get_global(&mut store, "exit_code")
            .unwrap()
            .set(&mut store, wasmtime::Val::I32(47))
            .unwrap();
        inst.get_global(&mut store, "exit_flag")
            .unwrap()
            .set(&mut store, wasmtime::Val::I32(1))
            .unwrap();
        inst.get_global(&mut store, "yield_flag")
            .unwrap()
            .set(&mut store, wasmtime::Val::I32(0))
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
        // Loop (DEFAULT_QUANTUM + 2000) times, then exit(99)
        // 0x100000: mov rcx, loop_count  (48 c7 c1 <imm32>)
        // 0x100007: dec rcx              (48 ff c9)
        // 0x10000a: jnz 0x100007         (75 fb)
        // 0x10000c: mov rdi, 99          (48 c7 c7 63 00 00 00)
        // 0x100013: mov rax, 60          (48 c7 c0 3c 00 00 00)
        // 0x10001a: syscall              (0f 05)
        let loop_count = ((DEFAULT_QUANTUM as u32) + 2000).to_le_bytes();
        let code = vec![
            0x48, 0xc7, 0xc1, loop_count[0], loop_count[1], loop_count[2], loop_count[3], // mov rcx, DEFAULT_QUANTUM + 2000
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
            brk_start: crate::meta::DEFAULT_BRK_START,
            mmap_start: crate::meta::DEFAULT_MMAP_START,
            mmap_end: crate::meta::DEFAULT_MMAP_END,
            stack_top: crate::meta::DEFAULT_STACK_TOP,
            dispatch_hash_addr: crate::meta::DEFAULT_DISPATCH_HASH_ADDR,
        };
        let prog = crate::decoder::discover_code(&image).unwrap();
        let wasm_bytes = emit_wasm(&image, &prog).unwrap();
        let engine = Engine::default();
        let module = WasmModule::new(&engine, &wasm_bytes).unwrap();
        let mut store = Store::new(&engine, ());
        let inst = Instance::new(&mut store, &module, &[]).unwrap();
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
            let yf = inst
                .get_global(&mut store, "yield_flag")
                .unwrap()
                .get(&mut store)
                .i32()
                .unwrap();
            if yf == YIELD_SYSCALL_PENDING {
                let nr = inst.get_global(&mut store, "rax").unwrap().get(&mut store).i64().unwrap();
                let a0 = inst.get_global(&mut store, "rdi").unwrap().get(&mut store).i64().unwrap();
                assert_eq!(nr, 60);
                assert_eq!(a0, 99);
                exit_code = a0 as i32;
                inst.get_global(&mut store, "exit_code").unwrap().set(&mut store, wasmtime::Val::I32(exit_code)).unwrap();
                inst.get_global(&mut store, "exit_flag").unwrap().set(&mut store, wasmtime::Val::I32(1)).unwrap();
                inst.get_global(&mut store, "yield_flag").unwrap().set(&mut store, wasmtime::Val::I32(0)).unwrap();
                break;
            }
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
            brk_start: crate::meta::DEFAULT_BRK_START,
            mmap_start: crate::meta::DEFAULT_MMAP_START,
            mmap_end: crate::meta::DEFAULT_MMAP_END,
            stack_top: crate::meta::DEFAULT_STACK_TOP,
            dispatch_hash_addr: crate::meta::DEFAULT_DISPATCH_HASH_ADDR,
        };
        let prog = crate::decoder::discover_code(&image).unwrap();
        let wasm_bytes = emit_wasm(&image, &prog).unwrap();
        let engine = Engine::default();
        let module = WasmModule::new(&engine, &wasm_bytes).unwrap();
        let mut store = Store::new(&engine, ());
        let inst = Instance::new(&mut store, &module, &[]).unwrap();
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

    #[test]
    fn test_x87_m80fp_roundtrip_and_arithmetic() {
        // Test 1: m80fp round-trip (fld qword [rdi]; fstp tbyte [rsi]; fld tbyte [rsi]; fstp qword [rdx])
        // + arithmetic: fld qword [rdi]; fld1; faddp st(1), st(0); fsqrt; fstp qword [rcx]
        // + compare/status: fld1; fldz; fcomip st(0), st(1); fnstsw ax; fstp st(0); syscall
        let code: Vec<u8> = vec![
            // fld qword ptr [rdi]       (dd 07)
            0xdd, 0x07,
            // fstp tbyte ptr [rsi]      (db 3e)
            0xdb, 0x3e,
            // fld tbyte ptr [rsi]       (db 2e)
            0xdb, 0x2e,
            // fstp qword ptr [rdx]      (dd 1a)
            0xdd, 0x1a,
            // fld qword ptr [rdi]       (dd 07)
            0xdd, 0x07,
            // fld1                      (d9 e8)
            0xd9, 0xe8,
            // faddp st(1), st(0)        (de c1)
            0xde, 0xc1,
            // fsqrt                     (d9 fa)
            0xd9, 0xfa,
            // fstp qword ptr [rcx]      (dd 19)
            0xdd, 0x19,
            // fld1                      (d9 e8)
            0xd9, 0xe8,
            // fldz                      (d9 ee)
            0xd9, 0xee,
            // fcomip st(0), st(1)       (df f1) -> 0.0 < 1.0 => CF=1, ZF=0, PF=0
            0xdf, 0xf1,
            // fnstsw ax                 (df e0)
            0xdf, 0xe0,
            // fstp st(0)                (dd d8)
            0xdd, 0xd8,
            // mov rdi, 0; mov rax, 60; syscall
            0x48, 0xc7, 0xc7, 0x00, 0x00, 0x00, 0x00,
            0x48, 0xc7, 0xc0, 0x3c, 0x00, 0x00, 0x00,
            0x0f, 0x05,
        ];

        let image = LoadedImage {
            entry_rip: 0x0010_0000,
            at_phdr: 0,
            at_phent: 56,
            at_phnum: 0,
            at_entry: 0x0010_0000,
            at_base: 0,
            exec_segments: vec![ExecSegment {
                name: "x87_test".to_string(),
                vaddr: 0x0010_0000,
                data: code,
            }],
            data_segments: vec![],
            so_files: vec![],
            symbols: std::collections::HashMap::new(),
            elf_path: "x87_test".to_string(),
            brk_start: crate::meta::DEFAULT_BRK_START,
            mmap_start: crate::meta::DEFAULT_MMAP_START,
            mmap_end: crate::meta::DEFAULT_MMAP_END,
            stack_top: crate::meta::DEFAULT_STACK_TOP,
            dispatch_hash_addr: crate::meta::DEFAULT_DISPATCH_HASH_ADDR,
        };

        let prog = crate::decoder::discover_code(&image).unwrap();
        let wasm_bytes = emit_wasm(&image, &prog).unwrap();

        let engine = Engine::default();
        WasmModule::validate(&engine, &wasm_bytes)
            .expect("x87 lifted WASM must pass WASM validation");
        let module = WasmModule::new(&engine, &wasm_bytes).unwrap();

        // Test round-trip for normal, negative, subnormal, +0.0, -0.0, +Inf, -Inf, NaN
        let test_vals: [f64; 8] = [
            8.0,
            -42.5,
            std::f64::consts::PI,
            f64::from_bits(1), // smallest positive subnormal
            0.0,
            -0.0,
            f64::INFINITY,
            f64::NAN,
        ];

        for &val in &test_vals {
            let mut store = Store::new(&engine, ());
            let inst = Instance::new(&mut store, &module, &[]).unwrap();
            let mem = inst.get_memory(&mut store, "memory").unwrap();

            let in_addr = 0x0020_0000u32;
            let m80_addr = 0x0020_0010u32;
            let rt_addr = 0x0020_0020u32;
            let arith_addr = 0x0020_0030u32;

            mem.write(&mut store, in_addr as usize, &val.to_le_bytes())
                .unwrap();

            inst.get_global(&mut store, "rsp")
                .unwrap()
                .set(&mut store, wasmtime::Val::I64(STACK_TOP as i64))
                .unwrap();
            inst.get_global(&mut store, "rdi")
                .unwrap()
                .set(&mut store, wasmtime::Val::I64(in_addr as i64))
                .unwrap();
            inst.get_global(&mut store, "rsi")
                .unwrap()
                .set(&mut store, wasmtime::Val::I64(m80_addr as i64))
                .unwrap();
            inst.get_global(&mut store, "rdx")
                .unwrap()
                .set(&mut store, wasmtime::Val::I64(rt_addr as i64))
                .unwrap();
            inst.get_global(&mut store, "rcx")
                .unwrap()
                .set(&mut store, wasmtime::Val::I64(arith_addr as i64))
                .unwrap();

            let start = inst.get_typed_func::<(), i32>(&mut store, "_start").unwrap();
            let _ = start.call(&mut store, ()).unwrap();

            let mut out_bytes = [0u8; 8];
            mem.read(&store, rt_addr as usize, &mut out_bytes).unwrap();
            let rt_val = f64::from_le_bytes(out_bytes);
            if val.is_nan() {
                assert!(rt_val.is_nan(), "expected NaN round-trip, got {}", rt_val);
            } else {
                assert_eq!(
                    rt_val.to_bits(),
                    val.to_bits(),
                    "m80fp round-trip mismatch for {}: got {}",
                    val,
                    rt_val
                );
            }

            if val == 8.0 {
                let mut arith_bytes = [0u8; 8];
                mem.read(&store, arith_addr as usize, &mut arith_bytes)
                    .unwrap();
                let arith_val = f64::from_le_bytes(arith_bytes);
                assert_eq!(arith_val, 3.0, "sqrt(8.0 + 1.0) should be 3.0");
            }

            // Verify x87_top returned to 0 after balanced pushes/pops
            assert_eq!(
                inst.get_global(&mut store, "x87_top")
                    .unwrap()
                    .get(&mut store)
                    .i32(),
                Some(0)
            );
        }
    }

    #[test]
    fn test_x87_80bit_precision_and_instructions() {
        // Memory layout at RDI (0x0020_0000):
        //   [rdi+0x00]: f64  2^63 (9223372036854775808.0)
        //   [rdi+0x08]: f64  0.59
        //   [rdi+0x10]: f64  10.0
        //   [rdi+0x18]: f64  3.0
        //   [rdi+0x20]: i64  0x1234_5678_9ABC_DEF1 (exceeds 53-bit f64 precision)
        //   [rdi+0x28]: f64  1.5
        //   [rdi+0x30]: f64  4.0
        //   [rdi+0x38]: f64  2048.0 (2^11)
        //   [rdi+0x40]: i64  0x4000_0000_0000_0321 (64-bit int with low 11 bits = 0x321 = 801)
        //
        // Outputs at RSI (0x0020_0100):
        //   [rsi+0x00]: f64  (2^63 + 0.59) - 2^63  (musl fmt_fp rounding idiom -> must be 1.0)
        //   [rsi+0x08]: f64  fxch st(1) + fstp st(1) result (must be 10.0, not 0.0)
        //   [rsi+0x10]: f64  fsubrp st(1), st(0): ST(0)=3.0, ST(1)=10.0 -> 3.0 - 10.0 = -7.0
        //   [rsi+0x18]: f64  fdivrp st(1), st(0): ST(0)=3.0, ST(1)=10.0 -> 3.0 / 10.0 = 0.3
        //   [rsi+0x20]: i64  fild qword -> fistp qword exact 64-bit round-trip
        //   [rsi+0x28]: f64  fscale: 1.5 * 2^4 = 24.0
        //   [rsi+0x30]: f64  fprem: 0x4000_0000_0000_0321 % 2048.0 = 801.0 (exact 64-bit mod)
        //   [rsi+0x38]: u16  fnstsw ax after fcom st(0), st(1) where 3.0 < 10.0 (C0=1 -> 0x0100)
        let code: Vec<u8> = vec![
            // 1. musl fmt_fp 64-bit rounding: (2^63 + 0.59) - 2^63 == 1.0
            0xdd, 0x07,             // fld qword [rdi+0x00] (ST0 = 2^63)
            0xdd, 0x47, 0x08,       // fld qword [rdi+0x08] (ST0 = 0.59, ST1 = 2^63)
            0xd8, 0xc1,             // fadd st(0), st(1)    (ST0 = 2^63 + 1.0)
            0xde, 0xe1,             // fsubrp st(1), st(0)  (ST0 = (2^63 + 1.0) - 2^63 = 1.0)
            0xdd, 0x1e,             // fstp qword [rsi+0x00]

            // 2. fxch st(1) + fstp st(1) (musl fmt_fp zero-check sequence)
            0xdd, 0x47, 0x10,       // fld qword [rdi+0x10] (ST0 = 10.0)
            0xd9, 0xee,             // fldz                 (ST0 = 0.0, ST1 = 10.0)
            0xd9, 0xc9,             // fxch st(1)           (ST0 = 10.0, ST1 = 0.0)
            0xdd, 0xd9,             // fstp st(1)           (ST1 = 10.0, pop -> ST0 = 10.0)
            0xdd, 0x5e, 0x08,       // fstp qword [rsi+0x08]

            // 3. fsubrp st(1), st(0): ST(1)=10.0, ST(0)=3.0 -> 3.0 - 10.0 = -7.0
            0xdd, 0x47, 0x10,       // fld qword [rdi+0x10] (10.0)
            0xdd, 0x47, 0x18,       // fld qword [rdi+0x18] (3.0)
            0xde, 0xe1,             // fsubrp st(1), st(0)
            0xdd, 0x5e, 0x10,       // fstp qword [rsi+0x10]

            // 4. fdivrp st(1), st(0): ST(1)=10.0, ST(0)=3.0 -> 3.0 / 10.0 = 0.3
            0xdd, 0x47, 0x10,       // fld qword [rdi+0x10] (10.0)
            0xdd, 0x47, 0x18,       // fld qword [rdi+0x18] (3.0)
            0xde, 0xf1,             // fdivrp st(1), st(0)
            0xdd, 0x5e, 0x18,       // fstp qword [rsi+0x18]

            // 5. fild i64 -> fistp i64 exact 64-bit integer round-trip
            0xdf, 0x6f, 0x20,       // fild qword [rdi+0x20]
            0xdf, 0x7e, 0x20,       // fistp qword [rsi+0x20]

            // 6. fscale: ST(1)=4.0, ST(0)=1.5 -> ST(0)=24.0
            0xdd, 0x47, 0x30,       // fld qword [rdi+0x30] (4.0)
            0xdd, 0x47, 0x28,       // fld qword [rdi+0x28] (1.5)
            0xd9, 0xfd,             // fscale
            0xdd, 0x5e, 0x28,       // fstp qword [rsi+0x28]
            0xdd, 0xd8,             // fstp st(0)

            // 7. fprem: exact 64-bit integer mod 2048.0 -> 801.0
            0xdd, 0x47, 0x38,       // fld qword [rdi+0x38] (ST1 = 2048.0)
            0xdf, 0x6f, 0x40,       // fild qword [rdi+0x40] (ST0 = 0x4000_0000_0000_0321)
            0xd9, 0xf8,             // fprem
            0xdd, 0x5e, 0x30,       // fstp qword [rsi+0x30]
            0xdd, 0xd8,             // fstp st(0)

            // 8. fcom st(0), st(1) (2-operand form): 3.0 < 10.0 -> C0=1 (0x0100)
            0xdd, 0x47, 0x10,       // fld qword [rdi+0x10] (10.0)
            0xdd, 0x47, 0x18,       // fld qword [rdi+0x18] (3.0)
            0xd8, 0xd1,             // fcom st(0), st(1)
            0xdf, 0xe0,             // fnstsw ax
            0x66, 0x89, 0x46, 0x38, // mov word [rsi+0x38], ax
            0xdd, 0xd8,             // fstp st(0)
            0xdd, 0xd8,             // fstp st(0)

            // exit(0)
            0x48, 0xc7, 0xc7, 0x00, 0x00, 0x00, 0x00,
            0x48, 0xc7, 0xc0, 0x3c, 0x00, 0x00, 0x00,
            0x0f, 0x05,
        ];

        let image = LoadedImage {
            entry_rip: 0x0010_0000,
            at_phdr: 0,
            at_phent: 56,
            at_phnum: 0,
            at_entry: 0x0010_0000,
            at_base: 0,
            exec_segments: vec![ExecSegment {
                name: "x87_80bit_test".to_string(),
                vaddr: 0x0010_0000,
                data: code,
            }],
            data_segments: vec![],
            so_files: vec![],
            symbols: std::collections::HashMap::new(),
            elf_path: "x87_80bit_test".to_string(),
            brk_start: crate::meta::DEFAULT_BRK_START,
            mmap_start: crate::meta::DEFAULT_MMAP_START,
            mmap_end: crate::meta::DEFAULT_MMAP_END,
            stack_top: crate::meta::DEFAULT_STACK_TOP,
            dispatch_hash_addr: crate::meta::DEFAULT_DISPATCH_HASH_ADDR,
        };

        let prog = crate::decoder::discover_code(&image).unwrap();
        let wasm_bytes = emit_wasm(&image, &prog).unwrap();

        let engine = Engine::default();
        WasmModule::validate(&engine, &wasm_bytes)
            .expect("x87 80-bit WASM must pass validation");
        let module = WasmModule::new(&engine, &wasm_bytes).unwrap();
        let mut store = Store::new(&engine, ());
        let inst = Instance::new(&mut store, &module, &[]).unwrap();
        let mem = inst.get_memory(&mut store, "memory").unwrap();

        let in_base = 0x0020_0000usize;
        let out_base = 0x0020_0100usize;
        let big_i64: i64 = 0x1234_5678_9ABC_DEF1;
        let fprem_i64: i64 = 0x4000_0000_0000_0321;

        mem.write(&mut store, in_base + 0x00, &(9223372036854775808.0f64).to_le_bytes()).unwrap();
        mem.write(&mut store, in_base + 0x08, &(0.59f64).to_le_bytes()).unwrap();
        mem.write(&mut store, in_base + 0x10, &(10.0f64).to_le_bytes()).unwrap();
        mem.write(&mut store, in_base + 0x18, &(3.0f64).to_le_bytes()).unwrap();
        mem.write(&mut store, in_base + 0x20, &big_i64.to_le_bytes()).unwrap();
        mem.write(&mut store, in_base + 0x28, &(1.5f64).to_le_bytes()).unwrap();
        mem.write(&mut store, in_base + 0x30, &(4.0f64).to_le_bytes()).unwrap();
        mem.write(&mut store, in_base + 0x38, &(2048.0f64).to_le_bytes()).unwrap();
        mem.write(&mut store, in_base + 0x40, &fprem_i64.to_le_bytes()).unwrap();

        inst.get_global(&mut store, "rsp").unwrap().set(&mut store, wasmtime::Val::I64(STACK_TOP as i64)).unwrap();
        inst.get_global(&mut store, "rdi").unwrap().set(&mut store, wasmtime::Val::I64(in_base as i64)).unwrap();
        inst.get_global(&mut store, "rsi").unwrap().set(&mut store, wasmtime::Val::I64(out_base as i64)).unwrap();

        let start = inst.get_typed_func::<(), i32>(&mut store, "_start").unwrap();
        let _ = start.call(&mut store, ()).unwrap();

        let read_f64 = |off: usize| -> f64 {
            let mut b = [0u8; 8];
            mem.read(&store, out_base + off, &mut b).unwrap();
            f64::from_le_bytes(b)
        };
        let read_i64 = |off: usize| -> i64 {
            let mut b = [0u8; 8];
            mem.read(&store, out_base + off, &mut b).unwrap();
            i64::from_le_bytes(b)
        };
        let read_u16 = |off: usize| -> u16 {
            let mut b = [0u8; 2];
            mem.read(&store, out_base + off, &mut b).unwrap();
            u16::from_le_bytes(b)
        };

        assert_eq!(read_f64(0x00), 1.0, "(2^63 + 0.59) - 2^63 must round to 1.0 in 80-bit x87");
        assert_eq!(read_f64(0x08), 10.0, "fxch st(1) + fstp st(1) must preserve 10.0");
        assert_eq!(read_f64(0x10), -7.0, "fsubrp st(1), st(0) must compute 3.0 - 10.0 = -7.0");
        assert!((read_f64(0x18) - 0.3).abs() < 1e-15, "fdivrp st(1), st(0) must compute 3.0 / 10.0 = 0.3");
        assert_eq!(read_i64(0x20), big_i64, "fild/fistp i64 must preserve all 64 bits");
        assert_eq!(read_f64(0x28), 24.0, "fscale 1.5 * 2^4 must equal 24.0");
        assert_eq!(read_f64(0x30), 801.0, "fprem must preserve low 11 bits of 64-bit integer");
        assert_eq!(read_u16(0x38) & 0x4500, 0x0100, "fcom st(0), st(1) for 3.0 < 10.0 must set C0=1");
        assert_eq!(
            inst.get_global(&mut store, "x87_top").unwrap().get(&mut store).i32(),
            Some(0),
            "x87_top must return to 0"
        );
    }

    #[test]
    fn test_sse2_saturating_add_sub() {
        // Inputs at RDI (0x0020_0000), 16 bytes each:
        //   [rdi+0x00]: a_u8,  [rdi+0x10]: b_u8
        //   [rdi+0x20]: a_i8,  [rdi+0x30]: b_i8
        //   [rdi+0x40]: a_u16, [rdi+0x50]: b_u16
        //   [rdi+0x60]: a_i16, [rdi+0x70]: b_i16
        //
        // Outputs at RSI (0x0020_0100), 16 bytes each:
        //   [rsi+0x00]: psubusb (reg-reg)
        //   [rsi+0x10]: psubusb (reg-mem)
        //   [rsi+0x20]: paddusb
        //   [rsi+0x30]: paddsb
        //   [rsi+0x40]: psubsb
        //   [rsi+0x50]: paddusw
        //   [rsi+0x60]: psubusw
        //   [rsi+0x70]: paddsw
        //   [rsi+0x80]: psubsw
        let code: Vec<u8> = vec![
            // psubusb xmm0, xmm1
            0xf3, 0x0f, 0x6f, 0x07,       // movdqu xmm0, [rdi+0x00]
            0xf3, 0x0f, 0x6f, 0x4f, 0x10, // movdqu xmm1, [rdi+0x10]
            0x66, 0x0f, 0xd8, 0xc1,       // psubusb xmm0, xmm1
            0xf3, 0x0f, 0x7f, 0x06,       // movdqu [rsi+0x00], xmm0

            // psubusb xmm0, [rdi+0x10] (memory operand form)
            0xf3, 0x0f, 0x6f, 0x07,       // movdqu xmm0, [rdi+0x00]
            0x66, 0x0f, 0xd8, 0x47, 0x10, // psubusb xmm0, [rdi+0x10]
            0xf3, 0x0f, 0x7f, 0x46, 0x10, // movdqu [rsi+0x10], xmm0

            // paddusb xmm0, xmm1
            0xf3, 0x0f, 0x6f, 0x07,       // movdqu xmm0, [rdi+0x00]
            0x66, 0x0f, 0xdc, 0xc1,       // paddusb xmm0, xmm1
            0xf3, 0x0f, 0x7f, 0x46, 0x20, // movdqu [rsi+0x20], xmm0

            // paddsb xmm0, xmm1
            0xf3, 0x0f, 0x6f, 0x47, 0x20, // movdqu xmm0, [rdi+0x20]
            0xf3, 0x0f, 0x6f, 0x4f, 0x30, // movdqu xmm1, [rdi+0x30]
            0x66, 0x0f, 0xec, 0xc1,       // paddsb xmm0, xmm1
            0xf3, 0x0f, 0x7f, 0x46, 0x30, // movdqu [rsi+0x30], xmm0

            // psubsb xmm0, xmm1
            0xf3, 0x0f, 0x6f, 0x47, 0x20, // movdqu xmm0, [rdi+0x20]
            0x66, 0x0f, 0xe8, 0xc1,       // psubsb xmm0, xmm1
            0xf3, 0x0f, 0x7f, 0x46, 0x40, // movdqu [rsi+0x40], xmm0

            // paddusw xmm0, xmm1
            0xf3, 0x0f, 0x6f, 0x47, 0x40, // movdqu xmm0, [rdi+0x40]
            0xf3, 0x0f, 0x6f, 0x4f, 0x50, // movdqu xmm1, [rdi+0x50]
            0x66, 0x0f, 0xdd, 0xc1,       // paddusw xmm0, xmm1
            0xf3, 0x0f, 0x7f, 0x46, 0x50, // movdqu [rsi+0x50], xmm0

            // psubusw xmm0, xmm1
            0xf3, 0x0f, 0x6f, 0x47, 0x40, // movdqu xmm0, [rdi+0x40]
            0x66, 0x0f, 0xd9, 0xc1,       // psubusw xmm0, xmm1
            0xf3, 0x0f, 0x7f, 0x46, 0x60, // movdqu [rsi+0x60], xmm0

            // paddsw xmm0, xmm1
            0xf3, 0x0f, 0x6f, 0x47, 0x60, // movdqu xmm0, [rdi+0x60]
            0xf3, 0x0f, 0x6f, 0x4f, 0x70, // movdqu xmm1, [rdi+0x70]
            0x66, 0x0f, 0xed, 0xc1,       // paddsw xmm0, xmm1
            0xf3, 0x0f, 0x7f, 0x46, 0x70, // movdqu [rsi+0x70], xmm0

            // psubsw xmm0, xmm1
            0xf3, 0x0f, 0x6f, 0x47, 0x60, // movdqu xmm0, [rdi+0x60]
            0x66, 0x0f, 0xe9, 0xc1,       // psubsw xmm0, xmm1
            0xf3, 0x0f, 0x7f, 0x86, 0x80, 0x00, 0x00, 0x00, // movdqu [rsi+0x80], xmm0

            // exit(0)
            0x48, 0xc7, 0xc7, 0x00, 0x00, 0x00, 0x00,
            0x48, 0xc7, 0xc0, 0x3c, 0x00, 0x00, 0x00,
            0x0f, 0x05,
        ];

        let image = LoadedImage {
            entry_rip: 0x0010_0000,
            at_phdr: 0,
            at_phent: 56,
            at_phnum: 0,
            at_entry: 0x0010_0000,
            at_base: 0,
            exec_segments: vec![ExecSegment {
                name: "sse2_sat_test".to_string(),
                vaddr: 0x0010_0000,
                data: code,
            }],
            data_segments: vec![],
            so_files: vec![],
            symbols: std::collections::HashMap::new(),
            elf_path: "sse2_sat_test".to_string(),
            brk_start: crate::meta::DEFAULT_BRK_START,
            mmap_start: crate::meta::DEFAULT_MMAP_START,
            mmap_end: crate::meta::DEFAULT_MMAP_END,
            stack_top: crate::meta::DEFAULT_STACK_TOP,
            dispatch_hash_addr: crate::meta::DEFAULT_DISPATCH_HASH_ADDR,
        };

        let prog = crate::decoder::discover_code(&image).unwrap();
        let wasm_bytes = emit_wasm(&image, &prog).unwrap();

        let engine = Engine::default();
        WasmModule::validate(&engine, &wasm_bytes)
            .expect("SSE2 saturating add/sub WASM must pass validation");
        let module = WasmModule::new(&engine, &wasm_bytes).unwrap();
        let mut store = Store::new(&engine, ());
        let inst = Instance::new(&mut store, &module, &[]).unwrap();
        let mem = inst.get_memory(&mut store, "memory").unwrap();

        let in_base = 0x0020_0000usize;
        let out_base = 0x0020_0100usize;

        let a_u8: [u8; 16] = [0, 1, 10, 100, 200, 250, 255, 255, 0, 5, 9, 10, 15, 0x80, 0xFE, 0xFF];
        let b_u8: [u8; 16] = [0, 2, 10, 200, 100, 10, 0, 1, 255, 10, 9, 9, 9, 0x80, 0x02, 0xFF];

        let a_i8: [i8; 16] = [0, 100, 127, 127, -100, -128, -128, -50, 50, -128, 127, 10, -10, 120, -120, 0];
        let b_i8: [i8; 16] = [0, 50, 1, 127, -50, -1, -128, 100, -100, 1, -1, -20, 20, 10, -10, -128];

        let a_u16: [u16; 8] = [0, 1, 1000, 40000, 65535, 65535, 0, 0x8000];
        let b_u16: [u16; 8] = [0, 2, 1000, 30000, 0, 1, 65535, 0x8000];

        let a_i16: [i16; 8] = [0, 30000, 32767, -30000, -32768, -20000, 20000, 0];
        let b_i16: [i16; 8] = [0, 10000, 1, -10000, -1, 20000, -20000, -32768];

        let to_bytes_i8 = |v: &[i8; 16]| -> [u8; 16] { v.map(|x| x as u8) };
        let to_bytes_u16 = |v: &[u16; 8]| -> [u8; 16] {
            let mut out = [0u8; 16];
            for (i, &w) in v.iter().enumerate() {
                out[2 * i..2 * i + 2].copy_from_slice(&w.to_le_bytes());
            }
            out
        };
        let to_bytes_i16 = |v: &[i16; 8]| -> [u8; 16] {
            let mut out = [0u8; 16];
            for (i, &w) in v.iter().enumerate() {
                out[2 * i..2 * i + 2].copy_from_slice(&w.to_le_bytes());
            }
            out
        };

        mem.write(&mut store, in_base + 0x00, &a_u8).unwrap();
        mem.write(&mut store, in_base + 0x10, &b_u8).unwrap();
        mem.write(&mut store, in_base + 0x20, &to_bytes_i8(&a_i8)).unwrap();
        mem.write(&mut store, in_base + 0x30, &to_bytes_i8(&b_i8)).unwrap();
        mem.write(&mut store, in_base + 0x40, &to_bytes_u16(&a_u16)).unwrap();
        mem.write(&mut store, in_base + 0x50, &to_bytes_u16(&b_u16)).unwrap();
        mem.write(&mut store, in_base + 0x60, &to_bytes_i16(&a_i16)).unwrap();
        mem.write(&mut store, in_base + 0x70, &to_bytes_i16(&b_i16)).unwrap();

        inst.get_global(&mut store, "rsp").unwrap().set(&mut store, wasmtime::Val::I64(STACK_TOP as i64)).unwrap();
        inst.get_global(&mut store, "rdi").unwrap().set(&mut store, wasmtime::Val::I64(in_base as i64)).unwrap();
        inst.get_global(&mut store, "rsi").unwrap().set(&mut store, wasmtime::Val::I64(out_base as i64)).unwrap();

        let start = inst.get_typed_func::<(), i32>(&mut store, "_start").unwrap();
        let _ = start.call(&mut store, ()).unwrap();

        let read_16 = |off: usize| -> [u8; 16] {
            let mut b = [0u8; 16];
            mem.read(&store, out_base + off, &mut b).unwrap();
            b
        };

        let exp_psubusb: [u8; 16] = std::array::from_fn(|i| a_u8[i].saturating_sub(b_u8[i]));
        let exp_paddusb: [u8; 16] = std::array::from_fn(|i| a_u8[i].saturating_add(b_u8[i]));
        let exp_paddsb: [i8; 16] = std::array::from_fn(|i| a_i8[i].saturating_add(b_i8[i]));
        let exp_psubsb: [i8; 16] = std::array::from_fn(|i| a_i8[i].saturating_sub(b_i8[i]));
        let exp_paddusw: [u16; 8] = std::array::from_fn(|i| a_u16[i].saturating_add(b_u16[i]));
        let exp_psubusw: [u16; 8] = std::array::from_fn(|i| a_u16[i].saturating_sub(b_u16[i]));
        let exp_paddsw: [i16; 8] = std::array::from_fn(|i| a_i16[i].saturating_add(b_i16[i]));
        let exp_psubsw: [i16; 8] = std::array::from_fn(|i| a_i16[i].saturating_sub(b_i16[i]));

        assert_eq!(read_16(0x00), exp_psubusb, "psubusb (reg-reg) mismatch");
        assert_eq!(read_16(0x10), exp_psubusb, "psubusb (reg-mem) mismatch");
        assert_eq!(read_16(0x20), exp_paddusb, "paddusb mismatch");
        assert_eq!(read_16(0x30), to_bytes_i8(&exp_paddsb), "paddsb mismatch");
        assert_eq!(read_16(0x40), to_bytes_i8(&exp_psubsb), "psubsb mismatch");
        assert_eq!(read_16(0x50), to_bytes_u16(&exp_paddusw), "paddusw mismatch");
        assert_eq!(read_16(0x60), to_bytes_u16(&exp_psubusw), "psubusw mismatch");
        assert_eq!(read_16(0x70), to_bytes_i16(&exp_paddsw), "paddsw mismatch");
        assert_eq!(read_16(0x80), to_bytes_i16(&exp_psubsw), "psubsw mismatch");
    }

    #[test]
    fn test_dead_flag_elimination_preserves_semantics() {
        // Test both dead-flag ALU chains and live-flag sequences (adc, cmov, jcc).
        //
        // Block 1 (at 0x10_0000):
        //   31 c0                 xor eax, eax          ; dead flags (overwritten by add)
        //   83 c0 05              add eax, 5            ; dead flags (overwritten by sub)
        //   83 e8 02              sub eax, 2            ; dead flags (overwritten by or), eax=3
        //   83 c8 10              or  eax, 0x10         ; dead flags (overwritten by and), eax=0x13
        //   83 e0 1f              and eax, 0x1f         ; dead flags (overwritten by neg), eax=0x13
        //   f7 d8                 neg eax               ; dead flags (overwritten by add), eax=-19 (0xFFFFFFED)
        //   48 89 c3              mov rbx, rax          ; transparent
        //   83 c0 13              add eax, 0x13         ; LIVE flags (sets CF=1, ZF=1), eax=0
        //   48 83 d3 00           adc rbx, 0            ; reads CF=1! rbx = 0xFFFFFFED + 1 = 0xFFFFFFEE
        //   48 83 e8 01           sub rax, 1            ; LIVE flags (sets CF=1, SF=1), rax=-1
        //   48 89 c1              mov rcx, rax          ; transparent
        //   48 0f 42 c3           cmovb rax, rbx        ; reads CF=1 -> rax = 0xFFFFFFEE
        //   48 3d ee ff ff 00     cmp rax, 0x00ff_ffee  ; LIVE flags (not equal: 0xFFFFFFEE != 0x00FFFFEE)
        //   75 05                 jne +5                ; taken -> skip mov rax, 0xdead
        //   b8 ad de 00 00        mov eax, 0xdead
        //   c3                    ret
        let code: Vec<u8> = vec![
            0x31, 0xC0, // xor eax, eax
            0x83, 0xC0, 0x05, // add eax, 5
            0x83, 0xE8, 0x02, // sub eax, 2
            0x83, 0xC8, 0x10, // or eax, 0x10
            0x83, 0xE0, 0x1F, // and eax, 0x1f
            0xF7, 0xD8, // neg eax
            0x48, 0x89, 0xC3, // mov rbx, rax
            0x83, 0xC0, 0x13, // add eax, 0x13 (CF=1, ZF=1)
            0x48, 0x83, 0xD3, 0x00, // adc rbx, 0 (reads CF=1)
            0x48, 0x83, 0xE8, 0x01, // sub rax, 1 (CF=1)
            0x48, 0x89, 0xC1, // mov rcx, rax
            0x48, 0x0F, 0x42, 0xC3, // cmovb rax, rbx (reads CF=1)
            0x48, 0x3D, 0xEE, 0xFF, 0xFF, 0x00, // cmp rax, 0x00ff_ffee
            0x75, 0x05, // jne +5
            0xB8, 0xAD, 0xDE, 0x00, 0x00, // mov eax, 0xdead
            0xC3, // ret
        ];

        // 1. Verify compute_skip_flags marks exact dead vs live instructions on block 1 body
        let image = make_synthetic_image(code);
        let prog = discover_code(&image).unwrap();
        let entry_block = prog.blocks.get(&0x0010_0000).unwrap();
        let mut instr_buf = Vec::new();
        decode_block_instructions_into(&image.exec_segments, entry_block, &mut instr_buf);
        let body_len = instr_buf.len() - 1; // exclude jne
        let mut skip = Vec::new();
        compute_skip_flags(&instr_buf[..body_len], &mut skip);
        assert_eq!(
            skip,
            vec![
                true,  // xor eax, eax (dead)
                true,  // add eax, 5 (dead)
                true,  // sub eax, 2 (dead)
                true,  // or eax, 0x10 (dead)
                true,  // and eax, 0x1f (dead)
                true,  // neg eax (dead)
                false, // mov rbx, rax (transparent)
                false, // add eax, 0x13 (LIVE: read by adc)
                false, // adc rbx, 0 (not skipped)
                false, // sub rax, 1 (LIVE: read by cmovb)
                false, // mov rcx, rax (transparent)
                false, // cmovb rax, rbx (reads CF)
                false, // cmp rax, 0x00ff_ffee (LIVE: read by jne)
            ],
            "unexpected dead-flag mask"
        );

        // 2. Execute compiled WASM in Wasmtime and verify exact register results
        let wasm = emit_wasm(&image, &prog).unwrap();
        let engine = Engine::default();
        let module = WasmModule::new(&engine, &wasm).unwrap();
        let mut store = Store::new(&engine, ());
        let inst = Instance::new(&mut store, &module, &[]).unwrap();

        inst.get_global(&mut store, "rsp")
            .unwrap()
            .set(&mut store, wasmtime::Val::I64(STACK_TOP as i64))
            .unwrap();
        let start = inst
            .get_typed_func::<(), i32>(&mut store, "_start")
            .unwrap();
        let _ = start.call(&mut store, ()).unwrap();

        let rax = inst
            .get_global(&mut store, "rax")
            .unwrap()
            .get(&mut store)
            .unwrap_i64() as u64;
        let rbx = inst
            .get_global(&mut store, "rbx")
            .unwrap()
            .get(&mut store)
            .unwrap_i64() as u64;
        let rcx = inst
            .get_global(&mut store, "rcx")
            .unwrap()
            .get(&mut store)
            .unwrap_i64() as u64;

        assert_eq!(rbx, 0xFFFF_FFEE, "adc should have observed CF=1 from add");
        assert_eq!(rcx, u64::MAX, "sub rax, 1 should produce -1");
        assert_eq!(rax, 0xFFFF_FFEE, "cmovb and jne should have observed live flags");
    }

    fn run_rcr_snippet(code: &[u8]) -> (u64, u64, u64, u64, u64, u64) {
        let image = make_synthetic_image(code.to_vec());
        let prog = discover_code(&image).unwrap();
        let wasm = emit_wasm(&image, &prog).unwrap();
        let engine = Engine::default();
        let module = WasmModule::new(&engine, &wasm).unwrap();
        let mut store = Store::new(&engine, ());
        let inst = Instance::new(&mut store, &module, &[]).unwrap();
        inst.get_global(&mut store, "rsp")
            .unwrap()
            .set(&mut store, wasmtime::Val::I64(STACK_TOP as i64))
            .unwrap();
        let start = inst
            .get_typed_func::<(), i32>(&mut store, "_start")
            .unwrap();
        let _ = start.call(&mut store, ()).unwrap();
        let g = |store: &mut Store<()>, name: &str| {
            inst.get_global(&mut *store, name)
                .unwrap()
                .get(&mut *store)
                .unwrap_i64() as u64
        };
        (
            g(&mut store, "rax"),
            g(&mut store, "rbx"),
            g(&mut store, "rcx"),
            g(&mut store, "rdx"),
            g(&mut store, "rsi"),
            g(&mut store, "rdi"),
        )
    }

    #[test]
    fn test_exec_rcr_rcl_widths_and_counts() {
        // 1. 64-bit RCR by 1 with CF=1:
        //    mov rax, 0x0000_0000_0000_0003; stc; rcr rax, 1
        //    -> rax = 0x8000_0000_0000_0001, CF = 1, OF = 1 (msb=1 ^ bit62=0)
        //    setc bl; seto bh
        let code_rcr64_1: &[u8] = &[
            0x48, 0xC7, 0xC0, 0x03, 0x00, 0x00, 0x00, // mov rax, 3
            0x31, 0xDB, // xor ebx, ebx
            0x45, 0x31, 0xC0, 0x41, 0x80, 0xF8, 0x01, // xor r8d, r8d; cmp r8b, 1 (CF=1)
            0x48, 0xD1, 0xD8, // rcr rax, 1
            0x0F, 0x92, 0xC3, // setc bl
            0x0F, 0x90, 0xC7, // seto bh
            0xC3, // ret
        ];
        let (rax, rbx, _, _, _, _) = run_rcr_snippet(code_rcr64_1);
        assert_eq!(rax, 0x8000_0000_0000_0001);
        assert_eq!(rbx & 0xFF, 1, "CF should be 1");
        assert_eq!((rbx >> 8) & 0xFF, 1, "OF should be 1");

        // 2. 64-bit RCR by 63 with CF=1, and RCL by 63 with CF=0:
        //    rax = 0x8000_0000_0000_0001, CF=1, rcr rax, 63 ->
        //      new_cf = bit 62 of rax = 0
        //      res = (rax >> 63) | (1 << 1) | (rax << 2) = 1 | 2 | 4 = 7
        //    rdx = 0x8000_0000_0000_0001, CF=0, rcl rdx, 63 ->
        //      new_cf = bit 1 of rdx = 0
        //      res = (rdx << 63) | (0 << 62) | (rdx >> 2) = 0x8000_0000_0000_0000 | 0x2000_0000_0000_0000 = 0xA000_0000_0000_0000
        let code_64_multi: &[u8] = &[
            0x48, 0xB8, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80, // movabs rax, 0x8000000000000001
            0x48, 0x89, 0xC2, // mov rdx, rax
            0x31, 0xDB, // xor ebx, ebx
            0x45, 0x31, 0xC0, 0x41, 0x80, 0xF8, 0x01, // CF=1
            0x48, 0xC1, 0xD8, 0x3F, // rcr rax, 63
            0x0F, 0x92, 0xC3, // setc bl
            0x45, 0x31, 0xC0, // CF=0
            0x48, 0xC1, 0xD2, 0x3F, // rcl rdx, 63
            0x0F, 0x92, 0xC7, // setc bh
            0xC3, // ret
        ];
        let (rax, rbx, _, rdx, _, _) = run_rcr_snippet(code_64_multi);
        assert_eq!(rax, 7);
        assert_eq!(rbx & 0xFF, 0);
        assert_eq!(rdx, 0xA000_0000_0000_0000);
        assert_eq!((rbx >> 8) & 0xFF, 0);

        // 3. Count == 0 preserves CF/OF; on x86-64, 32-bit register operands still zero-extend into r64:
        //    rax = 0x1234_5678_9ABC_DEF0, cl = 0, CF=1, rcr eax, cl -> rax = 0x0000_0000_9ABC_DEF0, CF=1
        //    Then cl = 1, rcr eax, cl -> upper 32 bits zeroed, eax = (0x9ABC_DEF0 >> 1) | 0x8000_0000 = 0xCD5E_6F78, CF=0
        let code_count0_and_32: &[u8] = &[
            0x48, 0xB8, 0xF0, 0xDE, 0xBC, 0x9A, 0x78, 0x56, 0x34, 0x12, // movabs rax, 0x123456789ABCDEF0
            0x31, 0xC9, // xor ecx, ecx (cl = 0)
            0x31, 0xDB, // xor ebx, ebx
            0x45, 0x31, 0xC0, 0x41, 0x80, 0xF8, 0x01, // CF=1
            0xD3, 0xD8, // rcr eax, cl
            0x48, 0x89, 0xC2, // mov rdx, rax (snapshot after count=0)
            0x0F, 0x92, 0xC3, // setc bl
            0xB1, 0x01, // mov cl, 1
            0xD3, 0xD8, // rcr eax, cl (CF was still 1)
            0x0F, 0x92, 0xC7, // setc bh
            0xC3, // ret
        ];
        let (rax, rbx, _, rdx, _, _) = run_rcr_snippet(code_count0_and_32);
        assert_eq!(
            rdx, 0x0000_0000_9ABC_DEF0,
            "32-bit count=0 must zero-extend rax while preserving CF"
        );
        assert_eq!(rbx & 0xFF, 1, "count=0 must leave CF intact");
        assert_eq!(rax, 0xCD5E_6F78, "32-bit rcr must zero-extend upper 32 bits");
        assert_eq!((rbx >> 8) & 0xFF, 0, "new CF should be bit 0 of 0x9ABCDEF0 (0)");

        // 4. 8-bit & 16-bit modulo-9 / modulo-17 counts and full-width wrap (c=8, c=16):
        //    al = 0x81, CF=1, rcr al, 9 (9 % 9 == 0 -> unchanged, CF=1)
        //    Then rcr al, 8 -> new_cf = bit 7 (1), res = (1 << 0) | ((0x81 << 1) & 0xFF) = 0x03
        //    dx = 0x8001, CF=1, rcl dx, 17 (17 % 17 == 0 -> unchanged, CF=1)
        //    Then rcl dx, 1 -> new_cf = 1, res = 0x0003, OF = msb(0x0003)^1 = 1
        let code_8_16: &[u8] = &[
            0x31, 0xC0, // xor eax, eax
            0xB0, 0x81, // mov al, 0x81
            0x31, 0xDB, // xor ebx, ebx
            0x45, 0x31, 0xC0, 0x41, 0x80, 0xF8, 0x01, // CF=1
            0xC0, 0xD8, 0x09, // rcr al, 9 (c = 0)
            0x48, 0x89, 0xC6, // mov rsi, rax
            0xC0, 0xD8, 0x08, // rcr al, 8 (c = 8, CF=1)
            0x0F, 0x92, 0xC3, // setc bl
            0x31, 0xD2, // xor edx, edx
            0x66, 0xBA, 0x01, 0x80, // mov dx, 0x8001
            0x45, 0x31, 0xC0, 0x41, 0x80, 0xF8, 0x01, // CF=1
            0x66, 0xC1, 0xD2, 0x11, // rcl dx, 17 (c = 0)
            0x48, 0x89, 0xD7, // mov rdi, rdx
            0x66, 0xD1, 0xD2, // rcl dx, 1 (CF=1)
            0x0F, 0x90, 0xC7, // seto bh
            0xC3, // ret
        ];
        let (rax, rbx, _, rdx, rsi, rdi) = run_rcr_snippet(code_8_16);
        assert_eq!(rsi, 0x81, "8-bit rcr by 9 must be no-op");
        assert_eq!(rax, 0x03, "8-bit rcr by 8 with CF=1");
        assert_eq!(rbx & 0xFF, 1, "8-bit rcr by 8 CF");
        assert_eq!(rdi, 0x8001, "16-bit rcl by 17 must be no-op");
        assert_eq!(rdx, 0x0003, "16-bit rcl by 1 with CF=1");
        assert_eq!((rbx >> 8) & 0xFF, 1, "16-bit rcl by 1 OF");

        // 5. Memory-operand RCR/RCL (m32 with count=0 and count=1 preserving adjacent bytes, plus m64 RCL by 1):
        let code_mem: &[u8] = &[
            0x48, 0x83, 0xEC, 0x10, // sub rsp, 16
            0x48, 0xB8, 0x03, 0x00, 0x00, 0x80, 0x44, 0x33, 0x22, 0x11, // movabs rax, 0x1122334480000003
            0x48, 0x89, 0x04, 0x24, // mov [rsp], rax
            0x48, 0xB8, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80, // movabs rax, 0x8000000000000001
            0x48, 0x89, 0x44, 0x24, 0x08, // mov [rsp+8], rax
            0x31, 0xDB, // xor ebx, ebx
            0x31, 0xC9, // xor ecx, ecx (cl = 0)
            0x45, 0x31, 0xC0, 0x41, 0x80, 0xF8, 0x01, // CF=1
            0xD3, 0x1C, 0x24, // rcr dword ptr [rsp], cl (count=0: memory & CF unchanged)
            0x48, 0x8B, 0x34, 0x24, // mov rsi, [rsp]
            0xD1, 0x1C, 0x24, // rcr dword ptr [rsp], 1 (CF=1 -> 0xC0000001, new CF=1)
            0x0F, 0x92, 0xC3, // setc bl
            0x48, 0x8B, 0x04, 0x24, // mov rax, [rsp]
            0x48, 0xD1, 0x54, 0x24, 0x08, // rcl qword ptr [rsp+8], 1 (CF=1 -> 0x3, new CF=1)
            0x0F, 0x92, 0xC7, // setc bh
            0x48, 0x8B, 0x54, 0x24, 0x08, // mov rdx, [rsp+8]
            0x48, 0x83, 0xC4, 0x10, // add rsp, 16
            0xC3, // ret
        ];
        let (rax, rbx, _, rdx, rsi, _) = run_rcr_snippet(code_mem);
        assert_eq!(
            rsi, 0x1122_3344_8000_0003,
            "m32 rcr count=0 must leave memory and adjacent bytes intact"
        );
        assert_eq!(
            rax, 0x1122_3344_C000_0001,
            "m32 rcr by 1 must update only low 32 bits and preserve adjacent bytes"
        );
        assert_eq!(rbx & 0xFF, 1, "m32 rcr by 1 CF");
        assert_eq!(rdx, 0x0000_0000_0000_0003, "m64 rcl by 1 with CF=1");
        assert_eq!((rbx >> 8) & 0xFF, 1, "m64 rcl by 1 CF");
    }

    #[test]
    fn test_exec_rcr_go_unsigned_div_pattern() {
        // Exact Go 1.24 runtime.semrelease1 unsigned modulo-251 sequence:
        //   movabs rax, magic_251
        //   movabs rsi, x
        //   mul rsi
        //   add rdx, rsi     (sets CF=1 for large x!)
        //   rcr rdx, 1       (consumes CF!)
        //   shr rdx, 7       (q = x / 251)
        //   imul rcx, rdx, 251
        //   sub rsi, rcx     (r = x % 251)
        let magic: u64 = (((1u128 << 72) / 251 + 1) - (1u128 << 64)) as u64;
        for &x in &[
            0u64,
            250,
            251,
            252,
            0x1234_5678_9ABC_DEF0,
            u64::MAX - 13, // forces add rdx, rsi to overflow (CF = 1)
            u64::MAX,
        ] {
            let mut code = Vec::new();
            code.extend_from_slice(&[0x48, 0xB8]); // movabs rax, magic
            code.extend_from_slice(&magic.to_le_bytes());
            code.extend_from_slice(&[0x48, 0xBE]); // movabs rsi, x
            code.extend_from_slice(&x.to_le_bytes());
            code.extend_from_slice(&[
                0x48, 0xF7, 0xE6, // mul rsi
                0x48, 0x01, 0xF2, // add rdx, rsi
                0x48, 0xD1, 0xDA, // rcr rdx, 1
                0x48, 0xC1, 0xEA, 0x07, // shr rdx, 7
                0x48, 0x69, 0xCA, 0xFB, 0x00, 0x00, 0x00, // imul rcx, rdx, 251
                0x48, 0x29, 0xCE, // sub rsi, rcx
                0xC3, // ret
            ]);
            let (_, _, _, rdx, rsi, _) = run_rcr_snippet(&code);
            assert_eq!(rdx, x / 251, "quotient mismatch for x={x:#x}");
            assert_eq!(rsi, x % 251, "remainder mismatch for x={x:#x}");
        }
    }

    #[test]
    fn test_exec_vsyscall_emulation_all_three_entries() {
        let cases: &[(u64, i64)] = &[
            (0xffff_ffff_ff60_0000, 96),  // vgettimeofday -> SYS_gettimeofday
            (0xffff_ffff_ff60_0400, 201), // vtime         -> SYS_time
            (0xffff_ffff_ff60_0800, 309), // vgetcpu       -> SYS_getcpu
        ];

        for &(vsyscall_va, expected_nr) in cases {
            // mov rdi, 0x1111; mov rsi, 0x2222; mov rdx, 0x3333;
            // movabs rax, vsyscall_va; call rax;
            // add rax, 0x10; ret
            let mut code = Vec::new();
            code.extend_from_slice(&[0x48, 0xC7, 0xC7, 0x11, 0x11, 0x00, 0x00]); // mov rdi, 0x1111 (7B)
            code.extend_from_slice(&[0x48, 0xC7, 0xC6, 0x22, 0x22, 0x00, 0x00]); // mov rsi, 0x2222 (7B)
            code.extend_from_slice(&[0x48, 0xC7, 0xC2, 0x33, 0x33, 0x00, 0x00]); // mov rdx, 0x3333 (7B)
            code.extend_from_slice(&[0x48, 0xB8]); // movabs rax, vsyscall_va (10B)
            code.extend_from_slice(&vsyscall_va.to_le_bytes());
            code.extend_from_slice(&[0xFF, 0xD0]); // call rax (2B)
            let ret_offset = code.len() as u64;
            code.extend_from_slice(&[0x48, 0x83, 0xC0, 0x10]); // add rax, 0x10
            code.push(0xC3); // ret

            let image = make_synthetic_image(code);
            let ret_va = image.entry_rip as u64 + ret_offset;
            let prog = discover_code(&image).unwrap();
            let wasm = emit_wasm(&image, &prog).unwrap();
            let engine = Engine::default();
            let module = WasmModule::new(&engine, &wasm).unwrap();
            let mut store = Store::new(&engine, ());
            let inst = Instance::new(&mut store, &module, &[]).unwrap();

            inst.get_global(&mut store, "rsp")
                .unwrap()
                .set(&mut store, wasmtime::Val::I64(STACK_TOP as i64))
                .unwrap();
            let start = inst
                .get_typed_func::<(), i32>(&mut store, "_start")
                .unwrap();

            // First invocation yields for the emulated syscall.
            let _ = start.call(&mut store, ()).unwrap();

            let yield_flag = inst
                .get_global(&mut store, "yield_flag")
                .unwrap()
                .get(&mut store)
                .unwrap_i32();
            let rax = inst
                .get_global(&mut store, "rax")
                .unwrap()
                .get(&mut store)
                .unwrap_i64();
            let rip = inst
                .get_global(&mut store, "rip")
                .unwrap()
                .get(&mut store)
                .unwrap_i64() as u64;
            let rcx = inst
                .get_global(&mut store, "rcx")
                .unwrap()
                .get(&mut store)
                .unwrap_i64() as u64;
            let rsp = inst
                .get_global(&mut store, "rsp")
                .unwrap()
                .get(&mut store)
                .unwrap_i64() as u64;
            let rdi = inst
                .get_global(&mut store, "rdi")
                .unwrap()
                .get(&mut store)
                .unwrap_i64() as u64;
            let rsi = inst
                .get_global(&mut store, "rsi")
                .unwrap()
                .get(&mut store)
                .unwrap_i64() as u64;
            let rdx = inst
                .get_global(&mut store, "rdx")
                .unwrap()
                .get(&mut store)
                .unwrap_i64() as u64;

            assert_eq!(yield_flag, YIELD_SYSCALL_PENDING, "vsyscall {vsyscall_va:#x} must yield syscall");
            assert_eq!(rax, expected_nr, "vsyscall {vsyscall_va:#x} syscall nr mismatch");
            assert_eq!(rip, ret_va, "vsyscall {vsyscall_va:#x} must pop return address into rip");
            assert_eq!(rcx, ret_va, "vsyscall {vsyscall_va:#x} must set rcx to return address");
            assert_eq!(rsp, STACK_TOP as u64, "vsyscall {vsyscall_va:#x} must restore rsp");
            assert_eq!((rdi, rsi, rdx), (0x1111, 0x2222, 0x3333), "vsyscall args must be preserved");

            // Host handles syscall, writes return value to rax, clears yield_flag, and resumes.
            inst.get_global(&mut store, "rax")
                .unwrap()
                .set(&mut store, wasmtime::Val::I64(42))
                .unwrap();
            inst.get_global(&mut store, "yield_flag")
                .unwrap()
                .set(&mut store, wasmtime::Val::I32(0))
                .unwrap();

            let _ = start.call(&mut store, ()).unwrap();
            let final_rax = inst
                .get_global(&mut store, "rax")
                .unwrap()
                .get(&mut store)
                .unwrap_i64();
            assert_eq!(final_rax, 58, "resumed execution after vsyscall {vsyscall_va:#x} should run add rax, 0x10");
        }
    }

    #[test]
    fn test_exec_non_vsyscall_high_addresses_still_trap() {
        for &bad_va in &[
            0xffff_ffff_ff60_0100u64, // middle of vsyscall page (not a valid entry)
            0xffff_ffff_ff60_0001u64, // off-by-one from vgettimeofday
            0x0000_0001_0000_0000u64, // first non-32-bit address
        ] {
            let mut code = Vec::new();
            code.extend_from_slice(&[0x48, 0xB8]); // movabs rax, bad_va
            code.extend_from_slice(&bad_va.to_le_bytes());
            code.extend_from_slice(&[0xFF, 0xD0]); // call rax
            code.push(0xC3); // ret

            let image = make_synthetic_image(code);
            let prog = discover_code(&image).unwrap();
            let wasm = emit_wasm(&image, &prog).unwrap();
            let engine = Engine::default();
            let module = WasmModule::new(&engine, &wasm).unwrap();
            let mut store = Store::new(&engine, ());
            let inst = Instance::new(&mut store, &module, &[]).unwrap();
            inst.get_global(&mut store, "rsp")
                .unwrap()
                .set(&mut store, wasmtime::Val::I64(STACK_TOP as i64))
                .unwrap();
            let start = inst
                .get_typed_func::<(), i32>(&mut store, "_start")
                .unwrap();
            let err = start.call(&mut store, ()).expect_err("non-vsyscall high address must trap");
            let msg = format!("{err:?}");
            assert!(
                msg.contains("unreachable"),
                "expected unreachable trap for {bad_va:#x}, got: {msg}"
            );
        }
    }

    #[test]
    fn test_exec_vsyscall_with_invalid_high_rsp_traps() {
        let code = vec![0xC3]; // dummy block so num_chunks > 0
        let image = make_synthetic_image(code);
        let prog = discover_code(&image).unwrap();
        let wasm = emit_wasm(&image, &prog).unwrap();
        let engine = Engine::default();
        let module = WasmModule::new(&engine, &wasm).unwrap();
        let mut store = Store::new(&engine, ());
        let inst = Instance::new(&mut store, &module, &[]).unwrap();
        // Set rip to vgettimeofday with an out-of-range 64-bit rsp
        inst.get_global(&mut store, "rip")
            .unwrap()
            .set(&mut store, wasmtime::Val::I64(0xffff_ffff_ff60_0000u64 as i64))
            .unwrap();
        inst.get_global(&mut store, "rsp")
            .unwrap()
            .set(&mut store, wasmtime::Val::I64(0x0000_0001_0000_1000u64 as i64))
            .unwrap();
        let start = inst
            .get_typed_func::<(), i32>(&mut store, "_start")
            .unwrap();
        let err = start.call(&mut store, ()).expect_err("vsyscall with 64-bit rsp must trap");
        assert!(format!("{err:?}").contains("unreachable"));
    }
}
