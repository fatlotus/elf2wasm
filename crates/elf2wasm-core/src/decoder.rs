use crate::elf_loader::{ExecSegment, LoadedImage};
use anyhow::Result;
use iced_x86::{Decoder, DecoderOptions, FlowControl, Instruction, Mnemonic, OpKind};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::hash::{BuildHasherDefault, Hasher};

#[derive(Default)]
pub struct FxHasher {
    hash: usize,
}

impl Hasher for FxHasher {
    #[inline]
    fn finish(&self) -> u64 {
        self.hash as u64
    }

    #[inline]
    fn write_u32(&mut self, i: u32) {
        self.hash = (self.hash.rotate_left(5) ^ (i as usize)).wrapping_mul(0x9E37_79B9);
    }

    #[inline]
    fn write_usize(&mut self, i: usize) {
        self.hash = (self.hash.rotate_left(5) ^ i).wrapping_mul(0x9E37_79B9);
    }

    #[inline]
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.hash = (self.hash.rotate_left(5) ^ (b as usize)).wrapping_mul(0x9E37_79B9);
        }
    }
}

pub type FastHashMap<K, V> = HashMap<K, V, BuildHasherDefault<FxHasher>>;
pub type FastHashSet<K> = HashSet<K, BuildHasherDefault<FxHasher>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockTerminator {
    /// Falls through to `next_va` (e.g. split at a branch target).
    Fallthrough(u32),
    /// Unconditional direct jump to `target_va`.
    DirectJump(u32),
    /// Conditional branch: `taken_va` or `fallthrough_va`.
    ConditionalBranch { taken: u32, fallthrough: u32 },
    /// Direct call to `target_va`, returning to `fallthrough_va`.
    DirectCall { target: u32, fallthrough: u32 },
    /// Indirect call (target resolved at runtime via dispatch table), returning to `fallthrough_va`.
    IndirectCall { fallthrough: u32 },
    /// Indirect jump (target resolved at runtime via dispatch table, e.g. `jmp rax`, `jmp [rip+...]`).
    IndirectJump,
    /// Return instruction (`ret`).
    Return,
    /// Trap / halt (`ud2`, `int3`, `hlt`, invalid, or segment end).
    Trap,
}

#[derive(Debug, Clone)]
pub struct DecodedBlock {
    pub start_va: u32,
    /// Exclusive end VA (`last_instr.next_ip() as u32`).
    pub end_va: u32,
    /// Full `iced_x86::Instruction`s so `lifter.rs` has lossless operand/prefix/disp access.
    pub instructions: Vec<Instruction>,
    /// Static successor VAs (direct jump targets and/or fallthrough).
    pub succs: Vec<u32>,
    pub terminator: BlockTerminator,
}

#[derive(Debug, Clone)]
pub struct DecodedFunction {
    pub entry_va: u32,
    pub name: Option<String>,
    /// Sorted block start VAs belonging to this function (keys into `DecodedProgram::blocks`).
    pub block_vas: Vec<u32>,
}

#[derive(Debug, Clone)]
pub struct DecodedProgram {
    pub entry_rip: u32,
    /// Highest `end_va` across decoded blocks (used for `WasmMeta.max_code_addr`).
    pub max_code_addr: u32,
    /// All basic blocks globally keyed by `start_va` (sorted by VA for deterministic emission).
    pub blocks: BTreeMap<u32, DecodedBlock>,
    /// Discovered functions keyed by `entry_va`.
    pub functions: BTreeMap<u32, DecodedFunction>,
    /// Sorted, deduplicated guest VAs eligible for indirect dispatch (`call reg`, `jmp reg`, `ret`).
    pub indirect_targets: Vec<u32>,
    /// Fast lookup from any decoded instruction VA -> owning block `start_va`.
    pub instr_to_block: FastHashMap<u32, u32>,
}

fn find_segment(segments: &[ExecSegment], addr: u32) -> Option<&ExecSegment> {
    segments.iter().find(|seg| {
        let end = seg.vaddr.saturating_add(seg.data.len() as u32);
        addr >= seg.vaddr && addr < end
    })
}

fn is_near_branch(instr: &Instruction) -> bool {
    matches!(
        instr.op0_kind(),
        OpKind::NearBranch16 | OpKind::NearBranch32 | OpKind::NearBranch64
    )
}

/// Split an existing block at `split_va` (which must be a valid instruction boundary
/// strictly inside `(owner_va, owner_block.end_va)`).
fn split_block(
    blocks: &mut FastHashMap<u32, DecodedBlock>,
    instr_to_block: &mut FastHashMap<u32, u32>,
    owner_va: u32,
    split_va: u32,
) {
    let Some(owner_block) = blocks.get_mut(&owner_va) else {
        return;
    };
    let Some(idx) = owner_block
        .instructions
        .iter()
        .position(|i| i.ip() as u32 == split_va)
    else {
        return;
    };
    if idx == 0 {
        return;
    }

    let tail_instrs = owner_block.instructions.split_off(idx);
    let old_end_va = owner_block.end_va;
    let old_succs = std::mem::replace(&mut owner_block.succs, vec![split_va]);
    let old_term = std::mem::replace(
        &mut owner_block.terminator,
        BlockTerminator::Fallthrough(split_va),
    );
    owner_block.end_va = split_va;

    for instr in &tail_instrs {
        instr_to_block.insert(instr.ip() as u32, split_va);
    }

    let new_block = DecodedBlock {
        start_va: split_va,
        end_va: old_end_va,
        instructions: tail_instrs,
        succs: old_succs,
        terminator: old_term,
    };
    blocks.insert(split_va, new_block);
}

fn is_non_stack_mem_base(instr: &Instruction) -> bool {
    use iced_x86::Register;
    let base = instr.memory_base();
    base != Register::RSP && base != Register::RBP
}

fn is_non_stack_mem_read(instr: &Instruction) -> bool {
    if instr.mnemonic() == Mnemonic::Lea || !is_non_stack_mem_base(instr) {
        return false;
    }
    if matches!(instr.mnemonic(), Mnemonic::Cmp | Mnemonic::Test) {
        return (0..instr.op_count()).any(|i| instr.op_kind(i) == OpKind::Memory);
    }
    (1..instr.op_count()).any(|i| instr.op_kind(i) == OpKind::Memory)
}

fn is_non_stack_mem_write(instr: &Instruction) -> bool {
    if matches!(
        instr.mnemonic(),
        Mnemonic::Lea | Mnemonic::Cmp | Mnemonic::Test
    ) || !is_non_stack_mem_base(instr)
    {
        return false;
    }
    instr.op_count() > 0 && instr.op0_kind() == OpKind::Memory
}

fn split_mem_read_write_blocks(
    blocks: FastHashMap<u32, DecodedBlock>,
    instr_to_block: &mut FastHashMap<u32, u32>,
) -> BTreeMap<u32, DecodedBlock> {
    let mut sorted: Vec<(u32, DecodedBlock)> = blocks.into_iter().collect();
    sorted.sort_unstable_by_key(|(va, _)| *va);

    let mut out: Vec<(u32, DecodedBlock)> = Vec::with_capacity(sorted.len() + sorted.len() / 16);
    for (start_va, mut block) in sorted {
        let mut split_indices: Vec<usize> = Vec::new();
        let mut seen_read = false;
        for (idx, instr) in block.instructions.iter().enumerate() {
            let write = is_non_stack_mem_write(instr);
            if write && seen_read && idx > 0 {
                split_indices.push(idx);
                seen_read = false;
            }
            if is_non_stack_mem_read(instr) {
                seen_read = true;
            }
        }
        if split_indices.is_empty() {
            out.push((start_va, block));
            continue;
        }

        let orig_end_va = block.end_va;
        let orig_succs = std::mem::take(&mut block.succs);
        let orig_term = block.terminator;

        let mut tail_blocks: Vec<(u32, DecodedBlock)> = Vec::with_capacity(split_indices.len());
        let mut cur_end_va = orig_end_va;
        let mut cur_succs = orig_succs;
        let mut cur_term = orig_term;

        for &idx in split_indices.iter().rev() {
            let tail_instrs = block.instructions.split_off(idx);
            let split_va = tail_instrs[0].ip() as u32;
            for instr in &tail_instrs {
                instr_to_block.insert(instr.ip() as u32, split_va);
            }
            tail_blocks.push((
                split_va,
                DecodedBlock {
                    start_va: split_va,
                    end_va: cur_end_va,
                    instructions: tail_instrs,
                    succs: cur_succs,
                    terminator: cur_term,
                },
            ));
            cur_end_va = split_va;
            cur_succs = vec![split_va];
            cur_term = BlockTerminator::Fallthrough(split_va);
        }

        block.end_va = cur_end_va;
        block.succs = cur_succs;
        block.terminator = cur_term;
        out.push((start_va, block));
        for tb in tail_blocks.into_iter().rev() {
            out.push(tb);
        }
    }

    out.into_iter().collect()
}

fn decode_single_block_recursive(
    seg: &ExecSegment,
    start_va: u32,
    _blocks: &mut FastHashMap<u32, DecodedBlock>,
    instr_to_block: &mut FastHashMap<u32, u32>,
    worklist: &mut VecDeque<u32>,
    queued: &mut FastHashSet<u32>,
    function_entries: &mut FastHashSet<u32>,
) {
    let seg_end = seg.vaddr.saturating_add(seg.data.len() as u32);
    let offset = (start_va - seg.vaddr) as usize;
    let mut decoder = Decoder::with_ip(64, &seg.data[offset..], start_va as u64, DecoderOptions::NONE);

    let mut instructions = Vec::new();
    let mut terminator = BlockTerminator::Trap;
    let mut succs = Vec::new();
    let mut end_va = start_va;

    let mut enqueue = |va: u32, is_func: bool| {
        #[cfg(test)]
        if is_func {
            function_entries.insert(va);
        }
        #[cfg(not(test))]
        {
            let _ = is_func;
            let _ = &function_entries;
        }
        if queued.insert(va) {
            worklist.push_back(va);
        }
    };

    while decoder.can_decode() {
        let cur_ip = decoder.ip() as u32;
        if cur_ip >= seg_end {
            break;
        }

        if cur_ip != start_va {
            if let Some(&owner_va) = instr_to_block.get(&cur_ip) {
                terminator = BlockTerminator::Fallthrough(cur_ip);
                succs.push(cur_ip);
                end_va = cur_ip;
                if owner_va != cur_ip {
                    enqueue(cur_ip, false);
                }
                break;
            }
        }

        let instr = decoder.decode();
        if instr.is_invalid() {
            terminator = BlockTerminator::Trap;
            break;
        }

        let next_ip = instr.next_ip() as u32;
        instructions.push(instr);
        end_va = next_ip;

        // Syscall has FlowControl::Call in iced-x86 with op_count == 0; treat as sequential.
        if instr.mnemonic() == Mnemonic::Syscall {
            continue;
        }

        match instr.flow_control() {
            FlowControl::Next | FlowControl::XbeginXabortXend => {
                // Continue decoding sequentially within the block.
            }
            FlowControl::Call => {
                if is_near_branch(&instr) {
                    if let Ok(target) = u32::try_from(instr.near_branch_target()) {
                        terminator = BlockTerminator::DirectCall {
                            target,
                            fallthrough: next_ip,
                        };
                        succs.push(target);
                        if next_ip != target {
                            succs.push(next_ip);
                        }
                        enqueue(target, true);
                        enqueue(next_ip, false);
                    } else {
                        terminator = BlockTerminator::Trap;
                    }
                } else {
                    terminator = BlockTerminator::Trap;
                }
                break;
            }
            FlowControl::UnconditionalBranch => {
                if is_near_branch(&instr) {
                    if let Ok(target) = u32::try_from(instr.near_branch_target()) {
                        terminator = BlockTerminator::DirectJump(target);
                        succs.push(target);
                        enqueue(target, false);
                    } else {
                        terminator = BlockTerminator::Trap;
                    }
                } else {
                    terminator = BlockTerminator::IndirectJump;
                }
                break;
            }
            FlowControl::ConditionalBranch => {
                if is_near_branch(&instr) {
                    if let Ok(taken) = u32::try_from(instr.near_branch_target()) {
                        terminator = BlockTerminator::ConditionalBranch {
                            taken,
                            fallthrough: next_ip,
                        };
                        succs.push(taken);
                        if next_ip != taken {
                            succs.push(next_ip);
                        }
                        enqueue(taken, false);
                        enqueue(next_ip, false);
                    } else {
                        terminator = BlockTerminator::Trap;
                    }
                } else {
                    terminator = BlockTerminator::Trap;
                }
                break;
            }
            FlowControl::IndirectBranch => {
                terminator = BlockTerminator::IndirectJump;
                break;
            }
            FlowControl::IndirectCall => {
                terminator = BlockTerminator::IndirectCall {
                    fallthrough: next_ip,
                };
                succs.push(next_ip);
                enqueue(next_ip, false);
                break;
            }
            FlowControl::Return => {
                terminator = BlockTerminator::Return;
                break;
            }
            FlowControl::Interrupt | FlowControl::Exception => {
                terminator = BlockTerminator::Trap;
                break;
            }
        }
    }

    if instructions.is_empty() {
        return;
    }

    for instr in &instructions {
        instr_to_block.insert(instr.ip() as u32, start_va);
    }

    _blocks.insert(
        start_va,
        DecodedBlock {
            start_va,
            end_va,
            instructions,
            succs,
            terminator,
        },
    );
}

fn linear_sweep_gap(
    seg: &ExecSegment,
    gap_start: u32,
    gap_end: u32,
    blocks: &mut FastHashMap<u32, DecodedBlock>,
    instr_to_block: &mut FastHashMap<u32, u32>,
) {
    let mut pos_va = gap_start;

    while pos_va < gap_end {
        // Skip zero-padding bytes at block start so 0x00 doesn't eat into aligned stubs.
        let byte_idx = (pos_va - seg.vaddr) as usize;
        if seg.data[byte_idx] == 0x00 {
            pos_va += 1;
            continue;
        }

        let start_va = pos_va;
        let end_idx = (gap_end - seg.vaddr) as usize;
        let mut decoder = Decoder::with_ip(
            64,
            &seg.data[byte_idx..end_idx],
            start_va as u64,
            DecoderOptions::NONE,
        );

        let mut instructions = Vec::new();
        let mut terminator = BlockTerminator::Trap;
        let mut succs = Vec::new();
        let mut end_va = start_va;

        while decoder.can_decode() {
            let cur_ip = decoder.ip() as u32;
            if cur_ip >= gap_end {
                break;
            }

            // Avoid decoding a run of 0x00 padding mid-block if it appears.
            let cur_idx = (cur_ip - seg.vaddr) as usize;
            if !instructions.is_empty()
                && cur_idx + 1 < end_idx
                && seg.data[cur_idx] == 0x00
                && seg.data[cur_idx + 1] == 0x00
            {
                terminator = BlockTerminator::Trap;
                end_va = cur_ip;
                break;
            }

            let instr = decoder.decode();
            if instr.is_invalid() {
                if instructions.is_empty() {
                    pos_va = start_va + 1;
                } else {
                    terminator = BlockTerminator::Trap;
                }
                break;
            }

            let next_ip = instr.next_ip() as u32;
            if next_ip > gap_end {
                // Would overlap a recursive-descent block; stop cleanly.
                if instructions.is_empty() {
                    pos_va = gap_end;
                } else {
                    terminator = BlockTerminator::Trap;
                }
                break;
            }

            instructions.push(instr);
            end_va = next_ip;

            if instr.mnemonic() == Mnemonic::Syscall {
                if next_ip == gap_end {
                    if blocks.contains_key(&gap_end) {
                        terminator = BlockTerminator::Fallthrough(gap_end);
                        succs.push(gap_end);
                    } else {
                        terminator = BlockTerminator::Trap;
                    }
                    break;
                }
                continue;
            }

            match instr.flow_control() {
                FlowControl::Next | FlowControl::XbeginXabortXend => {
                    if next_ip == gap_end {
                        // Reached the start of an existing recursive-descent block.
                        if blocks.contains_key(&gap_end) {
                            terminator = BlockTerminator::Fallthrough(gap_end);
                            succs.push(gap_end);
                        } else {
                            terminator = BlockTerminator::Trap;
                        }
                        break;
                    }
                }
                FlowControl::Call => {
                    if is_near_branch(&instr) {
                        if let Ok(target) = u32::try_from(instr.near_branch_target()) {
                            terminator = BlockTerminator::DirectCall {
                                target,
                                fallthrough: next_ip,
                            };
                            succs.push(target);
                            if next_ip != target {
                                succs.push(next_ip);
                            }
                        } else {
                            terminator = BlockTerminator::Trap;
                        }
                    } else {
                        terminator = BlockTerminator::Trap;
                    }
                    break;
                }
                FlowControl::UnconditionalBranch => {
                    if is_near_branch(&instr) {
                        if let Ok(target) = u32::try_from(instr.near_branch_target()) {
                            terminator = BlockTerminator::DirectJump(target);
                            succs.push(target);
                        } else {
                            terminator = BlockTerminator::Trap;
                        }
                    } else {
                        terminator = BlockTerminator::IndirectJump;
                    }
                    break;
                }
                FlowControl::ConditionalBranch => {
                    if is_near_branch(&instr) {
                        if let Ok(taken) = u32::try_from(instr.near_branch_target()) {
                            terminator = BlockTerminator::ConditionalBranch {
                                taken,
                                fallthrough: next_ip,
                            };
                            succs.push(taken);
                            if next_ip != taken {
                                succs.push(next_ip);
                            }
                        } else {
                            terminator = BlockTerminator::Trap;
                        }
                    } else {
                        terminator = BlockTerminator::Trap;
                    }
                    break;
                }
                FlowControl::IndirectBranch => {
                    terminator = BlockTerminator::IndirectJump;
                    break;
                }
                FlowControl::IndirectCall => {
                    terminator = BlockTerminator::IndirectCall {
                        fallthrough: next_ip,
                    };
                    succs.push(next_ip);
                    break;
                }
                FlowControl::Return => {
                    terminator = BlockTerminator::Return;
                    break;
                }
                FlowControl::Interrupt | FlowControl::Exception => {
                    terminator = BlockTerminator::Trap;
                    break;
                }
            }
        }

        if !instructions.is_empty() {
            for instr in &instructions {
                instr_to_block.insert(instr.ip() as u32, start_va);
            }
            blocks.insert(
                start_va,
                DecodedBlock {
                    start_va,
                    end_va,
                    instructions,
                    succs,
                    terminator,
                },
            );
            pos_va = end_va;
        }
    }
}

pub fn discover_code(image: &LoadedImage) -> Result<DecodedProgram> {
    let total_exec_bytes: usize = image.exec_segments.iter().map(|s| s.data.len()).sum();
    let mut blocks: FastHashMap<u32, DecodedBlock> =
        FastHashMap::with_capacity_and_hasher(total_exec_bytes / 12, Default::default());
    let mut instr_to_block: FastHashMap<u32, u32> =
        FastHashMap::with_capacity_and_hasher(total_exec_bytes / 3, Default::default());
    let mut worklist: VecDeque<u32> = VecDeque::with_capacity(total_exec_bytes / 16);
    let mut queued: FastHashSet<u32> =
        FastHashSet::with_capacity_and_hasher(total_exec_bytes / 12, Default::default());
    #[allow(unused_mut)]
    let mut function_entries: FastHashSet<u32> = FastHashSet::default();

    let mut seed = |va: u32| {
        if find_segment(&image.exec_segments, va).is_some() {
            #[cfg(test)]
            function_entries.insert(va);
            if queued.insert(va) {
                worklist.push_back(va);
            }
        }
    };

    seed(image.entry_rip);
    if image.at_entry != 0 {
        seed(image.at_entry);
    }

    let mut sym_addrs: Vec<u32> = image.symbols.keys().copied().collect();
    sym_addrs.sort_unstable();
    for va in sym_addrs {
        seed(va);
    }

    // Seed DT_INIT (12) and DT_FINI (13) from PT_DYNAMIC of each shared object.
    for so in &image.so_files {
        let b = &so.bytes;
        if b.len() >= 64 && &b[0..4] == b"\x7fELF" && b[4] == 2 && b[5] == 1 {
            let phoff = u64::from_le_bytes(b[32..40].try_into().unwrap()) as usize;
            let phentsize = u16::from_le_bytes(b[54..56].try_into().unwrap()) as usize;
            let phnum = u16::from_le_bytes(b[56..58].try_into().unwrap()) as usize;
            if phentsize >= 56 {
                for i in 0..phnum {
                    let off = phoff.saturating_add(i * phentsize);
                    if off + 56 > b.len() {
                        break;
                    }
                    let p_type = u32::from_le_bytes(b[off..off + 4].try_into().unwrap());
                    if p_type == 2 {
                        // PT_DYNAMIC
                        let dyn_off = u64::from_le_bytes(b[off + 8..off + 16].try_into().unwrap()) as usize;
                        let dyn_sz = u64::from_le_bytes(b[off + 32..off + 40].try_into().unwrap()) as usize;
                        let dyn_end = dyn_off.saturating_add(dyn_sz).min(b.len());
                        let mut p = dyn_off;
                        while p + 16 <= dyn_end {
                            let d_tag = i64::from_le_bytes(b[p..p + 8].try_into().unwrap());
                            let d_val = u64::from_le_bytes(b[p + 8..p + 16].try_into().unwrap());
                            if d_tag == 0 {
                                break;
                            }
                            if (d_tag == 12 || d_tag == 13) && d_val != 0 {
                                if let Ok(rel) = u32::try_from(d_val) {
                                    seed(so.base_addr.wrapping_add(rel));
                                }
                            }
                            p += 16;
                        }
                        break;
                    }
                }
            }
        }
    }

    // 1. Authoritative recursive descent pass.
    while let Some(va) = worklist.pop_front() {
        let Some(seg) = find_segment(&image.exec_segments, va) else {
            continue;
        };
        if blocks.contains_key(&va) {
            continue;
        }
        if let Some(&owner_va) = instr_to_block.get(&va) {
            if owner_va < va {
                split_block(&mut blocks, &mut instr_to_block, owner_va, va);
            }
            continue;
        }

        decode_single_block_recursive(
            seg,
            va,
            &mut blocks,
            &mut instr_to_block,
            &mut worklist,
            &mut queued,
            &mut function_entries,
        );
    }

    // 2. Gap-only linear sweep fallback over uncovered ranges in exec_segments.
    for seg in &image.exec_segments {
        let seg_start = seg.vaddr;
        let seg_end = seg.vaddr.saturating_add(seg.data.len() as u32);

        let mut covered_ranges: Vec<(u32, u32)> = blocks
            .values()
            .filter(|b| b.start_va >= seg_start && b.start_va < seg_end)
            .map(|b| (b.start_va, b.end_va.min(seg_end)))
            .collect();
        covered_ranges.sort_unstable_by_key(|&(s, _)| s);

        let mut cursor = seg_start;
        for (cov_start, cov_end) in covered_ranges {
            if cursor < cov_start {
                linear_sweep_gap(seg, cursor, cov_start, &mut blocks, &mut instr_to_block);
            }
            if cov_end > cursor {
                cursor = cov_end;
            }
        }
        if cursor < seg_end {
            linear_sweep_gap(seg, cursor, seg_end, &mut blocks, &mut instr_to_block);
        }
    }

    // 2b. Split existing blocks and register DirectCall function entries for
    // branches/calls discovered during linear_sweep_gap.
    let mut split_targets: Vec<u32> = Vec::new();
    for block in blocks.values() {
        match block.terminator {
            BlockTerminator::DirectJump(target) => split_targets.push(target),
            BlockTerminator::ConditionalBranch { taken, .. } => split_targets.push(taken),
            BlockTerminator::DirectCall { target, .. } => {
                if find_segment(&image.exec_segments, target).is_some() {
                    function_entries.insert(target);
                }
                split_targets.push(target);
            }
            _ => {}
        }
    }
    for target in split_targets {
        if !blocks.contains_key(&target) {
            if let Some(&owner_va) = instr_to_block.get(&target) {
                if owner_va < target {
                    split_block(&mut blocks, &mut instr_to_block, owner_va, target);
                }
            }
        }
    }

    let blocks = split_mem_read_write_blocks(blocks, &mut instr_to_block);

    // 3. Build functions map (only used by decoder unit tests).
    #[allow(unused_mut)]
    let mut functions: BTreeMap<u32, DecodedFunction> = BTreeMap::new();
    #[cfg(test)]
    {
    let mut sorted_func_entries: Vec<u32> = function_entries.iter().copied().collect();
    sorted_func_entries.sort_unstable();

    for entry_va in sorted_func_entries {
        if !blocks.contains_key(&entry_va) {
            continue;
        }
        let mut func_blocks = FastHashSet::default();
        let mut fqueue = VecDeque::new();
        func_blocks.insert(entry_va);
        fqueue.push_back(entry_va);

        while let Some(bva) = fqueue.pop_front() {
            let Some(block) = blocks.get(&bva) else {
                continue;
            };
            let next_vas: Vec<u32> = match block.terminator {
                BlockTerminator::Fallthrough(next) => vec![next],
                BlockTerminator::DirectJump(target) => {
                    if function_entries.contains(&target) && target != entry_va {
                        vec![]
                    } else {
                        vec![target]
                    }
                }
                BlockTerminator::ConditionalBranch { taken, fallthrough } => {
                    vec![taken, fallthrough]
                }
                BlockTerminator::DirectCall { fallthrough, .. } => vec![fallthrough],
                BlockTerminator::IndirectCall { fallthrough } => vec![fallthrough],
                BlockTerminator::IndirectJump
                | BlockTerminator::Return
                | BlockTerminator::Trap => vec![],
            };
            for nva in next_vas {
                if blocks.contains_key(&nva) && func_blocks.insert(nva) {
                    fqueue.push_back(nva);
                }
            }
        }

        let mut block_vas: Vec<u32> = func_blocks.into_iter().collect();
        block_vas.sort_unstable();

        functions.insert(
            entry_va,
            DecodedFunction {
                entry_va,
                name: image.symbols.get(&entry_va).cloned(),
                block_vas,
            },
        );
        }
    }

    let max_code_addr = blocks.values().map(|b| b.end_va).max().unwrap_or(0);
    let indirect_targets: Vec<u32> = blocks.keys().copied().collect();

    Ok(DecodedProgram {
        entry_rip: image.entry_rip,
        max_code_addr,
        blocks,
        functions,
        indirect_targets,
        instr_to_block,
    })
}

pub fn split_indirect_targets(image: &LoadedImage, prog: &mut DecodedProgram) {
    use iced_x86::{Mnemonic, OpKind, Register};
    use std::collections::BTreeSet;

    let in_exec = |va: u32| -> bool {
        image.exec_segments.iter().any(|seg| {
            let end = seg.vaddr.saturating_add(seg.data.len() as u32);
            va >= seg.vaddr && va < end
        })
    };

    let in_data = |va: u32| -> bool {
        image.data_segments.iter().any(|seg| {
            let end = seg.vaddr.saturating_add(seg.data.len() as u32);
            va >= seg.vaddr && va < end
        })
    };

    let read_data_i32 = |va: u32| -> Option<i32> {
        for seg in &image.data_segments {
            let end = seg.vaddr.saturating_add(seg.data.len() as u32);
            if va >= seg.vaddr && va + 4 <= end {
                let off = (va - seg.vaddr) as usize;
                return Some(i32::from_le_bytes(seg.data[off..off + 4].try_into().unwrap()));
            }
        }
        None
    };

    let read_data_u64 = |va: u32| -> Option<u64> {
        for seg in &image.data_segments {
            let end = seg.vaddr.saturating_add(seg.data.len() as u32);
            if va >= seg.vaddr && va + 8 <= end {
                let off = (va - seg.vaddr) as usize;
                return Some(u64::from_le_bytes(seg.data[off..off + 8].try_into().unwrap()));
            }
        }
        None
    };

    struct SoRoView<'a> {
        base_addr: u32,
        bytes: &'a [u8],
        loads: Vec<(u64, u64, u64)>, // (p_vaddr, p_filesz, p_offset)
    }

    let mut so_views = Vec::new();
    for so in &image.so_files {
        let b = &so.bytes;
        if b.len() >= 64
            && &b[0..4] == b"\x7fELF"
            && b[4] == 2 // ELFCLASS64
            && b[5] == 1 // ELFDATA2LSB
        {
            let phoff = u64::from_le_bytes(b[32..40].try_into().unwrap()) as usize;
            let phentsize = u16::from_le_bytes(b[54..56].try_into().unwrap()) as usize;
            let phnum = u16::from_le_bytes(b[56..58].try_into().unwrap()) as usize;
            if phentsize >= 56 {
                let mut loads = Vec::new();
                for i in 0..phnum {
                    let off = phoff.saturating_add(i * phentsize);
                    if off + 56 > b.len() {
                        break;
                    }
                    let p_type = u32::from_le_bytes(b[off..off + 4].try_into().unwrap());
                    if p_type == 1 {
                        // PT_LOAD
                        let p_offset = u64::from_le_bytes(b[off + 8..off + 16].try_into().unwrap());
                        let p_vaddr = u64::from_le_bytes(b[off + 16..off + 24].try_into().unwrap());
                        let p_filesz = u64::from_le_bytes(b[off + 32..off + 40].try_into().unwrap());
                        loads.push((p_vaddr, p_filesz, p_offset));
                    }
                }
                so_views.push(SoRoView {
                    base_addr: so.base_addr,
                    bytes: b,
                    loads,
                });
            }
        }
    }

    let read_so_i32 = |va: u32| -> Option<i32> {
        for sv in &so_views {
            if va < sv.base_addr {
                continue;
            }
            let rel_va = (va - sv.base_addr) as u64;
            for &(pvaddr, pfilesz, poff) in &sv.loads {
                if rel_va >= pvaddr && rel_va + 4 <= pvaddr + pfilesz {
                    let foff = (poff + (rel_va - pvaddr)) as usize;
                    if foff + 4 <= sv.bytes.len() {
                        return Some(i32::from_le_bytes(
                            sv.bytes[foff..foff + 4].try_into().unwrap(),
                        ));
                    }
                }
            }
        }
        None
    };

    let mut targets = BTreeSet::new();
    let mut ro_table_candidates = BTreeSet::new();
    let mut abs_table_candidates = BTreeSet::new();
    for block in prog.blocks.values() {
        for (i, instr) in block.instructions.iter().enumerate() {
            if instr.is_ip_rel_memory_operand() {
                if let Ok(va) = u32::try_from(instr.ip_rel_memory_address()) {
                    if in_exec(va) {
                        targets.insert(va);
                    } else {
                        ro_table_candidates.insert(va);
                    }
                }
            } else {
                for op_idx in 0..instr.op_count() {
                    match instr.op_kind(op_idx) {
                        OpKind::Memory => {
                            if instr.memory_base() == Register::None
                                && instr.memory_displacement64() != 0
                            {
                                if let Ok(va) = u32::try_from(instr.memory_displacement64()) {
                                    if in_data(va) {
                                        abs_table_candidates.insert(va);
                                    }
                                }
                            }
                        }
                        OpKind::Immediate32 | OpKind::Immediate32to64 | OpKind::Immediate64 => {
                            let imm = instr.immediate(op_idx);
                            if let Ok(va) = u32::try_from(imm) {
                                if in_data(va) {
                                    abs_table_candidates.insert(va);
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            if instr.mnemonic() == Mnemonic::Syscall {
                if let Ok(next_va) = u32::try_from(instr.next_ip()) {
                    if in_exec(next_va) {
                        targets.insert(next_va);
                    }
                }
            }
            if i > 0 {
                let va = instr.ip() as u32;
                if instr.mnemonic() == Mnemonic::Endbr64 {
                    targets.insert(va);
                } else if block.instructions[i - 1].mnemonic() == Mnemonic::Nop
                    && instr.mnemonic() != Mnemonic::Nop
                {
                    targets.insert(va);
                }
            }
        }
    }

    // Probe potential relative jump tables (i32 offsets relative to table_va)
    for &table_va in &ro_table_candidates {
        for idx in 0..512u32 {
            let entry_va = table_va.wrapping_add(idx * 4);
            let rel = read_data_i32(entry_va).or_else(|| read_so_i32(entry_va));
            let Some(rel) = rel else { break };
            let target = table_va.wrapping_add(rel as u32);
            if in_exec(target) {
                targets.insert(target);
            } else {
                break;
            }
        }
    }

    // Probe potential absolute u64 jump tables in data_segments (e.g. ET_EXEC python3)
    for table_va in abs_table_candidates.into_iter().chain(ro_table_candidates) {
        for idx in 0..1024u32 {
            let entry_va = table_va.wrapping_add(idx * 8);
            let Some(entry) = read_data_u64(entry_va) else {
                break;
            };
            let Ok(target) = u32::try_from(entry) else {
                break;
            };
            if in_exec(target) && prog.instr_to_block.contains_key(&target) {
                targets.insert(target);
            } else {
                break;
            }
        }
    }

    for split_va in targets {
        if prog.blocks.contains_key(&split_va) {
            continue;
        }
        let Some((&block_va, _)) = prog.blocks.range(..split_va).next_back() else {
            continue;
        };
        let Some(block) = prog.blocks.get(&block_va) else {
            continue;
        };
        if split_va >= block.end_va {
            continue;
        }
        let Some(idx) = block
            .instructions
            .iter()
            .position(|ins| ins.ip() as u32 == split_va)
        else {
            continue;
        };
        if idx == 0 {
            continue;
        }
        let mut orig = prog.blocks.remove(&block_va).unwrap();
        let tail_instrs = orig.instructions.split_off(idx);
        let tail_block = DecodedBlock {
            start_va: split_va,
            end_va: orig.end_va,
            instructions: tail_instrs,
            succs: orig.succs,
            terminator: orig.terminator,
        };
        for ins in &tail_block.instructions {
            prog.instr_to_block.insert(ins.ip() as u32, split_va);
        }
        orig.end_va = split_va;
        orig.succs = vec![split_va];
        orig.terminator = BlockTerminator::Fallthrough(split_va);
        prog.blocks.insert(block_va, orig);
        prog.blocks.insert(split_va, tail_block);
    }
    prog.indirect_targets = prog.blocks.keys().copied().collect();
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(all(not(target_arch = "wasm32"), feature = "std-fs"))]
    use crate::elf_loader::load_elf_and_sos;
    #[cfg(all(not(target_arch = "wasm32"), feature = "std-fs"))]
    use std::path::{Path, PathBuf};

    fn verify_program_invariants(prog: &DecodedProgram, image: &LoadedImage) {
        assert!(!prog.blocks.is_empty(), "blocks must not be empty");
        assert!(!prog.functions.is_empty(), "functions must not be empty");
        assert!(
            prog.blocks.contains_key(&image.entry_rip),
            "entry_rip 0x{:x} must be in blocks",
            image.entry_rip
        );
        if image.at_entry != 0 {
            assert!(
                prog.blocks.contains_key(&image.at_entry),
                "at_entry 0x{:x} must be in blocks",
                image.at_entry
            );
        }

        let expected_max = prog.blocks.values().map(|b| b.end_va).max().unwrap_or(0);
        assert_eq!(prog.max_code_addr, expected_max);

        // indirect_targets strictly sorted and unique
        for w in prog.indirect_targets.windows(2) {
            assert!(
                w[0] < w[1],
                "indirect_targets not strictly sorted/unique: 0x{:x} >= 0x{:x}",
                w[0],
                w[1]
            );
        }

        // Verify instr_to_block and no DirectCall { target: 0 } from syscall
        let mut total_instrs = 0usize;
        for (&start_va, block) in &prog.blocks {
            assert_eq!(block.start_va, start_va);
            assert!(!block.instructions.is_empty());
            assert!(block.end_va > block.start_va);

            if let BlockTerminator::DirectCall { target, .. } = block.terminator {
                assert_ne!(target, 0, "DirectCall target must not be 0 (syscall bug)");
            }

            for &succ in &block.succs {
                if find_segment(&image.exec_segments, succ).is_some() {
                    assert!(
                        prog.blocks.contains_key(&succ),
                        "in-segment succ 0x{:x} of block 0x{:x} (terminator {:?}) missing from prog.blocks",
                        succ,
                        start_va,
                        block.terminator
                    );
                    assert!(
                        prog.indirect_targets.binary_search(&succ).is_ok(),
                        "in-segment succ 0x{:x} of block 0x{:x} missing from prog.indirect_targets",
                        succ,
                        start_va
                    );
                }
            }

            for instr in &block.instructions {
                total_instrs += 1;
                let ip = instr.ip() as u32;
                assert_eq!(
                    prog.instr_to_block.get(&ip).copied(),
                    Some(start_va),
                    "instr_to_block mismatch at 0x{:x}",
                    ip
                );
            }
        }
        assert_eq!(prog.instr_to_block.len(), total_instrs);

        let expected_indirect: Vec<u32> = prog.blocks.keys().copied().collect();
        assert_eq!(
            prog.indirect_targets, expected_indirect,
            "indirect_targets must match sorted keys of prog.blocks"
        );
    }

    #[cfg(all(not(target_arch = "wasm32"), feature = "std-fs"))]
    #[test]
    fn test_decode_true() -> Result<()> {
        let image = load_elf_and_sos(
            Path::new("/usr/bin/true"),
            &[PathBuf::from("/lib64/ld-linux-x86-64.so.2")],
        )?;
        let prog = discover_code(&image)?;
        verify_program_invariants(&prog, &image);
        Ok(())
    }

    #[cfg(all(not(target_arch = "wasm32"), feature = "std-fs"))]
    #[test]
    fn test_decode_echo() -> Result<()> {
        let image = load_elf_and_sos(
            Path::new("/usr/bin/echo"),
            &[PathBuf::from("/lib64/ld-linux-x86-64.so.2")],
        )?;
        let prog = discover_code(&image)?;
        verify_program_invariants(&prog, &image);
        Ok(())
    }

    #[cfg(all(not(target_arch = "wasm32"), feature = "std-fs"))]
    #[test]
    fn test_decode_python3() -> Result<()> {
        let image = load_elf_and_sos(
            Path::new("/usr/bin/python3"),
            &[PathBuf::from("/lib64/ld-linux-x86-64.so.2")],
        )?;
        let prog = discover_code(&image)?;
        verify_program_invariants(&prog, &image);
        Ok(())
    }

    #[cfg(all(not(target_arch = "wasm32"), feature = "std-fs"))]
    #[test]
    fn test_decode_ld_so() -> Result<()> {
        let image = load_elf_and_sos(Path::new("/lib64/ld-linux-x86-64.so.2"), &[])?;
        let prog = discover_code(&image)?;
        verify_program_invariants(&prog, &image);
        Ok(())
    }

    #[cfg(all(not(target_arch = "wasm32"), feature = "std-fs"))]
    #[test]
    fn test_decode_libc() -> Result<()> {
        let image = load_elf_and_sos(
            Path::new("/lib/x86_64-linux-gnu/libc.so.6"),
            &[PathBuf::from("/lib64/ld-linux-x86-64.so.2")],
        )?;
        let prog = discover_code(&image)?;
        verify_program_invariants(&prog, &image);
        Ok(())
    }

    #[test]
    fn test_synthetic_syscall_endbr64_call_next_and_split() -> Result<()> {
        // 0x1000: endbr64        (f3 0f 1e fa)
        // 0x1004: syscall        (0f 05)
        // 0x1006: call $+5       (e8 00 00 00 00) -> target=0x100b, fallthrough=0x100b
        // 0x100b: jmp 0x1004     (eb f7)          -> mid-block split at 0x1004!
        let code = vec![
            0xf3, 0x0f, 0x1e, 0xfa, // endbr64
            0x0f, 0x05,             // syscall
            0xe8, 0x00, 0x00, 0x00, 0x00, // call $+5
            0xeb, 0xf7,             // jmp 0x1004
        ];
        let image = LoadedImage {
            entry_rip: 0x1000,
            at_phdr: 0,
            at_phent: 0,
            at_phnum: 0,
            at_entry: 0,
            at_base: 0,
            exec_segments: vec![ExecSegment {
                name: "synth".to_string(),
                vaddr: 0x1000,
                data: code,
            }],
            data_segments: vec![],
            so_files: vec![],
            symbols: HashMap::new(),
            elf_path: String::new(),
        };
        let prog = discover_code(&image)?;
        verify_program_invariants(&prog, &image);

        // 0x1000..0x1004 should be split with Fallthrough(0x1004)
        let b0 = &prog.blocks[&0x1000];
        assert_eq!(b0.instructions[0].mnemonic(), Mnemonic::Endbr64);
        assert_eq!(b0.terminator, BlockTerminator::Fallthrough(0x1004));

        // 0x1004..0x100b should contain syscall and call $+5
        let b1 = &prog.blocks[&0x1004];
        assert_eq!(b1.instructions[0].mnemonic(), Mnemonic::Syscall);
        assert_eq!(
            b1.terminator,
            BlockTerminator::DirectCall {
                target: 0x100b,
                fallthrough: 0x100b,
            }
        );

        // 0x100b..0x100d should contain jmp 0x1004
        let b2 = &prog.blocks[&0x100b];
        assert_eq!(b2.terminator, BlockTerminator::DirectJump(0x1004));
        Ok(())
    }

    fn synth_image(entry_rip: u32, code: Vec<u8>) -> LoadedImage {
        LoadedImage {
            entry_rip,
            at_phdr: 0,
            at_phent: 0,
            at_phnum: 0,
            at_entry: 0,
            at_base: 0,
            exec_segments: vec![ExecSegment {
                name: "synth".to_string(),
                vaddr: entry_rip,
                data: code,
            }],
            data_segments: vec![],
            so_files: vec![],
            symbols: HashMap::new(),
            elf_path: String::new(),
        }
    }

    #[test]
    fn test_synthetic_linear_sweep_mid_block_split_and_direct_call() -> Result<()> {
        // 0x1000: nop; nop; ret   (90 90 c3)       -> recursive descent [0x1000..0x1003)
        // 0x1003..0x1005: 00 00                    -> padding separating gap
        // 0x1005: call 0x1001     (e8 f7 ff ff ff) -> linear-sweep DirectCall to interior 0x1001
        // 0x100a: jmp 0x1001      (eb f5)          -> linear-sweep DirectJump to interior 0x1001
        let code = vec![
            0x90, 0x90, 0xc3,             // nop; nop; ret
            0x00, 0x00,                   // padding
            0xe8, 0xf7, 0xff, 0xff, 0xff, // call 0x1001
            0xeb, 0xf5,                   // jmp 0x1001
        ];
        let image = synth_image(0x1000, code);
        let prog = discover_code(&image)?;
        verify_program_invariants(&prog, &image);

        // [0x1000..0x1003) must be split into [0x1000..0x1001) and [0x1001..0x1003)
        let b0 = &prog.blocks[&0x1000];
        assert_eq!(b0.end_va, 0x1001);
        assert_eq!(b0.terminator, BlockTerminator::Fallthrough(0x1001));

        let b1 = &prog.blocks[&0x1001];
        assert_eq!(b1.end_va, 0x1003);
        assert_eq!(b1.terminator, BlockTerminator::Return);

        assert_eq!(prog.instr_to_block.get(&0x1001).copied(), Some(0x1001));
        assert_eq!(prog.instr_to_block.get(&0x1002).copied(), Some(0x1001));
        assert!(prog.indirect_targets.binary_search(&0x1001).is_ok());

        // DirectCall target 0x1001 must be registered as a function entry
        assert!(
            prog.functions.contains_key(&0x1001),
            "DirectCall target 0x1001 from linear sweep must be in functions"
        );
        assert_eq!(prog.functions[&0x1001].block_vas, vec![0x1001]);

        Ok(())
    }

    #[test]
    fn test_synthetic_linear_sweep_zero_padding() -> Result<()> {
        // 0x1000: ret             (c3)       -> recursive descent [0x1000..0x1001)
        // 0x1001..0x1003: 00 00              -> leading padding
        // 0x1003..0x1005: nop; nop (90 90)   -> linear-sweep gap block
        // 0x1005..0x1009: 00 00 00 00        -> trailing 0x00 0x00 padding
        let code = vec![
            0xc3,                   // ret
            0x00, 0x00,             // padding
            0x90, 0x90,             // nop; nop
            0x00, 0x00, 0x00, 0x00, // trailing padding
        ];
        let image = synth_image(0x1000, code);
        let prog = discover_code(&image)?;
        verify_program_invariants(&prog, &image);

        assert!(!prog.blocks.contains_key(&0x1001));
        assert!(!prog.blocks.contains_key(&0x1005));
        assert!(!prog.instr_to_block.contains_key(&0x1001));
        assert!(!prog.instr_to_block.contains_key(&0x1005));

        let gap_block = &prog.blocks[&0x1003];
        assert_eq!(gap_block.end_va, 0x1005);
        assert_eq!(gap_block.terminator, BlockTerminator::Trap);
        assert!(gap_block.succs.is_empty());

        Ok(())
    }

    #[test]
    fn test_synthetic_lock_prefix_overlap() -> Result<()> {
        // 0x1000: je 0x1003            (74 01)    -> skips 0xf0 lock prefix
        // 0x1002: lock add [rdi], eax  (f0 01 07)
        // 0x1005: ret                  (c3)
        let code = vec![
            0x74, 0x01,       // je +1 (to 0x1003)
            0xf0, 0x01, 0x07, // lock add [rdi], eax
            0xc3,             // ret
        ];
        let image = synth_image(0x1000, code);
        let prog = discover_code(&image)?;
        verify_program_invariants(&prog, &image);

        assert_eq!(
            prog.blocks[&0x1000].terminator,
            BlockTerminator::ConditionalBranch {
                taken: 0x1003,
                fallthrough: 0x1002,
            }
        );
        assert_eq!(prog.blocks[&0x1002].end_va, 0x1005);
        assert_eq!(
            prog.blocks[&0x1002].terminator,
            BlockTerminator::Fallthrough(0x1005)
        );
        assert_eq!(prog.blocks[&0x1003].end_va, 0x1005);
        assert_eq!(
            prog.blocks[&0x1003].terminator,
            BlockTerminator::Fallthrough(0x1005)
        );
        assert_eq!(prog.blocks[&0x1005].terminator, BlockTerminator::Return);

        assert!(prog.indirect_targets.binary_search(&0x1002).is_ok());
        assert!(prog.indirect_targets.binary_search(&0x1003).is_ok());

        Ok(())
    }
}
