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

#[derive(Debug, Clone, Copy)]
pub struct DecodedBlock {
    pub start_va: u32,
    /// Exclusive end VA (`last_instr.next_ip() as u32`).
    pub end_va: u32,
    /// Number of decoded instructions in `[start_va, end_va)`.
    pub instr_count: u32,
    pub terminator: BlockTerminator,
}

impl DecodedBlock {
    /// Derive static successor VAs directly from `self.terminator` (zero stored Vec).
    pub fn succs(&self) -> Vec<u32> {
        match self.terminator {
            BlockTerminator::Fallthrough(next) => vec![next],
            BlockTerminator::DirectJump(target) => vec![target],
            BlockTerminator::ConditionalBranch { taken, fallthrough } => {
                if fallthrough != taken {
                    vec![taken, fallthrough]
                } else {
                    vec![taken]
                }
            }
            BlockTerminator::DirectCall {
                target,
                fallthrough,
            } => {
                if fallthrough != target {
                    vec![target, fallthrough]
                } else {
                    vec![target]
                }
            }
            BlockTerminator::IndirectCall { fallthrough } => vec![fallthrough],
            BlockTerminator::IndirectJump | BlockTerminator::Return | BlockTerminator::Trap => {
                vec![]
            }
        }
    }
}

/// Compact 1-bit-per-byte bitmap tracking decoded instruction start VAs across executable segments.
#[derive(Debug, Clone, Default)]
pub struct ExecInstrBitmap {
    /// `(vaddr, byte_len, bitset)` per `ExecSegment`; bit `i` = `vaddr + i` is a decoded instruction start.
    segments: Vec<(u32, u32, Vec<u64>)>,
}

impl ExecInstrBitmap {
    pub fn new(exec_segments: &[ExecSegment]) -> Self {
        let segments = exec_segments
            .iter()
            .map(|s| {
                let len = s.data.len();
                let words = (len + 63) / 64;
                (s.vaddr, len as u32, vec![0u64; words])
            })
            .collect();
        Self { segments }
    }

    #[inline]
    pub fn set(&mut self, va: u32) {
        for (vaddr, len, words) in &mut self.segments {
            if va >= *vaddr && va - *vaddr < *len {
                let off = (va - *vaddr) as usize;
                words[off >> 6] |= 1u64 << (off & 63);
                return;
            }
        }
    }

    #[inline]
    pub fn contains(&self, va: u32) -> bool {
        for (vaddr, len, words) in &self.segments {
            if va >= *vaddr && va - *vaddr < *len {
                let off = (va - *vaddr) as usize;
                return (words[off >> 6] & (1u64 << (off & 63))) != 0;
            }
        }
        false
    }
}

#[derive(Debug, Clone)]
pub struct DecodedFunction {
    pub entry_va: u32,
    pub name: Option<String>,
    /// Sorted block start VAs belonging to this function (keys into `DecodedProgram::blocks`).
    pub block_vas: Vec<u32>,
}

#[derive(Debug, Clone, Default)]
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
    /// Compact bitmap of all decoded instruction start VAs.
    pub instr_bitmap: ExecInstrBitmap,
}

fn find_segment(segments: &[ExecSegment], addr: u32) -> Option<&ExecSegment> {
    segments.iter().find(|seg| {
        let end = seg.vaddr.saturating_add(seg.data.len() as u32);
        addr >= seg.vaddr && addr < end
    })
}

/// Losslessly re-decode all instructions in `block` (`[start_va, end_va)`) into `out`.
pub fn decode_block_instructions_into(
    segments: &[ExecSegment],
    block: &DecodedBlock,
    out: &mut Vec<Instruction>,
) {
    out.clear();
    if block.end_va <= block.start_va {
        return;
    }
    let Some(seg) = find_segment(segments, block.start_va) else {
        return;
    };
    let start_off = (block.start_va - seg.vaddr) as usize;
    let end_off = (block.end_va.saturating_sub(seg.vaddr) as usize).min(seg.data.len());
    if start_off >= end_off {
        return;
    }
    let mut decoder = Decoder::with_ip(
        64,
        &seg.data[start_off..end_off],
        block.start_va as u64,
        DecoderOptions::NONE,
    );
    while decoder.can_decode() {
        let cur_ip = decoder.ip() as u32;
        if cur_ip >= block.end_va {
            break;
        }
        let instr = decoder.decode();
        if instr.is_invalid() {
            break;
        }
        out.push(instr);
    }
}

fn is_near_branch(instr: &Instruction) -> bool {
    matches!(
        instr.op0_kind(),
        OpKind::NearBranch16 | OpKind::NearBranch32 | OpKind::NearBranch64
    )
}

fn find_owner_block(blocks: &BTreeMap<u32, DecodedBlock>, va: u32) -> Option<u32> {
    for (&bva, block) in blocks.range(..=va).rev().take(4) {
        if va < block.end_va {
            return Some(bva);
        }
    }
    None
}

/// Split an existing block at `split_va` (which must be a valid instruction boundary
/// strictly inside `(owner_va, owner_block.end_va)`).
fn split_block(
    segments: &[ExecSegment],
    blocks: &mut BTreeMap<u32, DecodedBlock>,
    owner_va: u32,
    split_va: u32,
) {
    let Some(&owner) = blocks.get(&owner_va) else {
        return;
    };
    if split_va <= owner_va || split_va >= owner.end_va {
        return;
    }
    let Some(seg) = find_segment(segments, owner_va) else {
        return;
    };
    let start_off = (owner_va - seg.vaddr) as usize;
    let end_off = (owner.end_va.saturating_sub(seg.vaddr) as usize).min(seg.data.len());
    if start_off >= end_off {
        return;
    }
    let mut decoder = Decoder::with_ip(
        64,
        &seg.data[start_off..end_off],
        owner_va as u64,
        DecoderOptions::NONE,
    );
    let mut head_count = 0u32;
    let mut found = false;
    while decoder.can_decode() {
        let cur_ip = decoder.ip() as u32;
        if cur_ip == split_va {
            found = true;
            break;
        }
        if cur_ip > split_va || cur_ip >= owner.end_va {
            break;
        }
        let instr = decoder.decode();
        if instr.is_invalid() {
            break;
        }
        head_count += 1;
    }
    if !found || head_count == 0 {
        return;
    }

    let tail_count = owner.instr_count.saturating_sub(head_count).max(1);
    if let Some(ob) = blocks.get_mut(&owner_va) {
        ob.end_va = split_va;
        ob.instr_count = head_count;
        ob.terminator = BlockTerminator::Fallthrough(split_va);
    }

    let new_block = DecodedBlock {
        start_va: split_va,
        end_va: owner.end_va,
        instr_count: tail_count,
        terminator: owner.terminator,
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

fn decode_single_block_recursive(
    seg: &ExecSegment,
    start_va: u32,
    blocks: &mut BTreeMap<u32, DecodedBlock>,
    instr_bitmap: &mut ExecInstrBitmap,
    worklist: &mut VecDeque<u32>,
    queued: &mut FastHashSet<u32>,
    function_entries: &mut FastHashSet<u32>,
) {
    let seg_end = seg.vaddr.saturating_add(seg.data.len() as u32);
    let offset = (start_va - seg.vaddr) as usize;
    let mut decoder = Decoder::with_ip(64, &seg.data[offset..], start_va as u64, DecoderOptions::NONE);

    let mut instr_count = 0u32;
    let mut seen_mem_read = false;
    let mut terminator = BlockTerminator::Trap;
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

        if cur_ip != start_va && instr_bitmap.contains(cur_ip) {
            terminator = BlockTerminator::Fallthrough(cur_ip);
            end_va = cur_ip;
            if !blocks.contains_key(&cur_ip) {
                enqueue(cur_ip, false);
            }
            break;
        }

        let instr = decoder.decode();
        if instr.is_invalid() {
            terminator = BlockTerminator::Trap;
            break;
        }

        if instr_count > 0 && seen_mem_read && is_non_stack_mem_write(&instr) {
            terminator = BlockTerminator::Fallthrough(cur_ip);
            end_va = cur_ip;
            enqueue(cur_ip, false);
            break;
        }
        if is_non_stack_mem_read(&instr) {
            seen_mem_read = true;
        }

        let next_ip = instr.next_ip() as u32;
        instr_bitmap.set(cur_ip);
        instr_count += 1;
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

    if instr_count == 0 {
        return;
    }

    blocks.insert(
        start_va,
        DecodedBlock {
            start_va,
            end_va,
            instr_count,
            terminator,
        },
    );
}

fn linear_sweep_gap(
    seg: &ExecSegment,
    gap_start: u32,
    gap_end: u32,
    blocks: &mut BTreeMap<u32, DecodedBlock>,
    instr_bitmap: &mut ExecInstrBitmap,
) {
    let mut pos_va = gap_start;
    let mut skip_zero_pad = true;

    while pos_va < gap_end {
        // Skip zero-padding bytes at block start so 0x00 doesn't eat into aligned stubs.
        let byte_idx = (pos_va - seg.vaddr) as usize;
        if skip_zero_pad && seg.data[byte_idx] == 0x00 {
            pos_va += 1;
            continue;
        }
        skip_zero_pad = true;

        let start_va = pos_va;
        let end_idx = (gap_end - seg.vaddr) as usize;
        let mut decoder = Decoder::with_ip(
            64,
            &seg.data[byte_idx..end_idx],
            start_va as u64,
            DecoderOptions::NONE,
        );

        let mut instr_count = 0u32;
        let mut seen_mem_read = false;
        let mut terminator = BlockTerminator::Trap;
        let mut end_va = start_va;
        let mut split_on_mem_write = false;

        while decoder.can_decode() {
            let cur_ip = decoder.ip() as u32;
            if cur_ip >= gap_end {
                break;
            }

            // Avoid decoding a run of 0x00 padding mid-block if it appears.
            let cur_idx = (cur_ip - seg.vaddr) as usize;
            if instr_count > 0
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
                if instr_count == 0 {
                    pos_va = start_va + 1;
                } else {
                    terminator = BlockTerminator::Trap;
                }
                break;
            }

            let next_ip = instr.next_ip() as u32;
            if next_ip > gap_end {
                // Would overlap a recursive-descent block; stop cleanly.
                if instr_count == 0 {
                    pos_va = gap_end;
                } else {
                    terminator = BlockTerminator::Trap;
                }
                break;
            }

            if instr_count > 0 && seen_mem_read && is_non_stack_mem_write(&instr) {
                terminator = BlockTerminator::Fallthrough(cur_ip);
                end_va = cur_ip;
                split_on_mem_write = true;
                break;
            }
            if is_non_stack_mem_read(&instr) {
                seen_mem_read = true;
            }

            instr_bitmap.set(cur_ip);
            instr_count += 1;
            end_va = next_ip;

            if instr.mnemonic() == Mnemonic::Syscall {
                if next_ip == gap_end {
                    if blocks.contains_key(&gap_end) {
                        terminator = BlockTerminator::Fallthrough(gap_end);
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

        if instr_count > 0 {
            blocks.insert(
                start_va,
                DecodedBlock {
                    start_va,
                    end_va,
                    instr_count,
                    terminator,
                },
            );
            pos_va = end_va;
            if split_on_mem_write {
                skip_zero_pad = false;
            }
        }
    }
}

pub fn discover_code(image: &LoadedImage) -> Result<DecodedProgram> {
    let total_exec_bytes: usize = image.exec_segments.iter().map(|s| s.data.len()).sum();
    let mut blocks: BTreeMap<u32, DecodedBlock> = BTreeMap::new();
    let mut instr_bitmap = ExecInstrBitmap::new(&image.exec_segments);
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
                    let Some(off) = i.checked_mul(phentsize).and_then(|d| phoff.checked_add(d)) else {
                        break;
                    };
                    let Some(ph_end) = off.checked_add(56) else {
                        break;
                    };
                    if ph_end > b.len() {
                        break;
                    }
                    let p_type = u32::from_le_bytes(b[off..off + 4].try_into().unwrap());
                    if p_type == 2 {
                        // PT_DYNAMIC
                        let dyn_off = u64::from_le_bytes(b[off + 8..off + 16].try_into().unwrap()) as usize;
                        let dyn_sz = u64::from_le_bytes(b[off + 32..off + 40].try_into().unwrap()) as usize;
                        let dyn_end = dyn_off.saturating_add(dyn_sz).min(b.len());
                        let mut p = dyn_off;
                        while let Some(next_p) = p.checked_add(16) {
                            if next_p > dyn_end {
                                break;
                            }
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
                            p = next_p;
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
        if instr_bitmap.contains(va) {
            if let Some(owner_va) = find_owner_block(&blocks, va) {
                if owner_va < va {
                    split_block(&image.exec_segments, &mut blocks, owner_va, va);
                }
            }
            continue;
        }

        decode_single_block_recursive(
            seg,
            va,
            &mut blocks,
            &mut instr_bitmap,
            &mut worklist,
            &mut queued,
            &mut function_entries,
        );
    }
    drop(worklist);
    drop(queued);

    // 2. Gap-only linear sweep fallback over uncovered ranges in exec_segments.
    for seg in &image.exec_segments {
        let seg_start = seg.vaddr;
        let seg_end = seg.vaddr.saturating_add(seg.data.len() as u32);

        let covered_ranges: Vec<(u32, u32)> = blocks
            .range(seg_start..seg_end)
            .map(|(_, b)| (b.start_va, b.end_va.min(seg_end)))
            .collect();

        let mut cursor = seg_start;
        for (cov_start, cov_end) in covered_ranges {
            if cursor < cov_start {
                linear_sweep_gap(seg, cursor, cov_start, &mut blocks, &mut instr_bitmap);
            }
            if cov_end > cursor {
                cursor = cov_end;
            }
        }
        if cursor < seg_end {
            linear_sweep_gap(seg, cursor, seg_end, &mut blocks, &mut instr_bitmap);
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
        if !blocks.contains_key(&target) && instr_bitmap.contains(target) {
            if let Some(owner_va) = find_owner_block(&blocks, target) {
                if owner_va < target {
                    split_block(&image.exec_segments, &mut blocks, owner_va, target);
                }
            }
        }
    }

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
        instr_bitmap,
    })
}

pub fn split_indirect_targets(image: &LoadedImage, prog: &mut DecodedProgram) {
    use iced_x86::{Mnemonic, OpKind, Register};

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

    let mut targets = FastHashSet::default();
    let mut ro_table_candidates = FastHashSet::default();
    let mut abs_table_candidates = FastHashSet::default();
    let mut scratch_instrs = Vec::with_capacity(64);
    for block in prog.blocks.values() {
        decode_block_instructions_into(&image.exec_segments, block, &mut scratch_instrs);
        for (i, instr) in scratch_instrs.iter().enumerate() {
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
                } else if scratch_instrs[i - 1].mnemonic() == Mnemonic::Nop
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
            if in_exec(target) && prog.instr_bitmap.contains(target) {
                targets.insert(target);
            } else {
                break;
            }
        }
    }

    let mut sorted_targets: Vec<u32> = targets.into_iter().collect();
    sorted_targets.sort_unstable();
    for split_va in sorted_targets {
        if prog.blocks.contains_key(&split_va) || !prog.instr_bitmap.contains(split_va) {
            continue;
        }
        if let Some(owner_va) = find_owner_block(&prog.blocks, split_va) {
            if owner_va < split_va {
                split_block(&image.exec_segments, &mut prog.blocks, owner_va, split_va);
            }
        }
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

        // Verify instr_bitmap and no DirectCall { target: 0 } from syscall
        let mut instrs = Vec::new();
        for (&start_va, block) in &prog.blocks {
            assert_eq!(block.start_va, start_va);
            decode_block_instructions_into(&image.exec_segments, block, &mut instrs);
            assert!(!instrs.is_empty());
            assert_eq!(instrs.len() as u32, block.instr_count);
            assert!(block.end_va > block.start_va);

            if let BlockTerminator::DirectCall { target, .. } = block.terminator {
                assert_ne!(target, 0, "DirectCall target must not be 0 (syscall bug)");
            }

            for succ in block.succs() {
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

            for instr in &instrs {
                let ip = instr.ip() as u32;
                assert!(
                    prog.instr_bitmap.contains(ip),
                    "instr_bitmap missing instruction at 0x{:x}",
                    ip
                );
            }
        }

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
            brk_start: crate::meta::DEFAULT_BRK_START,
            mmap_start: crate::meta::DEFAULT_MMAP_START,
            mmap_end: crate::meta::DEFAULT_MMAP_END,
            stack_top: crate::meta::DEFAULT_STACK_TOP,
            dispatch_hash_addr: crate::meta::DEFAULT_DISPATCH_HASH_ADDR,
            initial_mem_pages: crate::elf_loader::INITIAL_MEM_PAGES,
            max_mem_pages: crate::elf_loader::MAX_MEM_PAGES,
        };
        let prog = discover_code(&image)?;
        verify_program_invariants(&prog, &image);

        let mut instrs = Vec::new();
        // 0x1000..0x1004 should be split with Fallthrough(0x1004)
        let b0 = &prog.blocks[&0x1000];
        decode_block_instructions_into(&image.exec_segments, b0, &mut instrs);
        assert_eq!(instrs[0].mnemonic(), Mnemonic::Endbr64);
        assert_eq!(b0.terminator, BlockTerminator::Fallthrough(0x1004));

        // 0x1004..0x100b should contain syscall and call $+5
        let b1 = &prog.blocks[&0x1004];
        decode_block_instructions_into(&image.exec_segments, b1, &mut instrs);
        assert_eq!(instrs[0].mnemonic(), Mnemonic::Syscall);
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
            brk_start: crate::meta::DEFAULT_BRK_START,
            mmap_start: crate::meta::DEFAULT_MMAP_START,
            mmap_end: crate::meta::DEFAULT_MMAP_END,
            stack_top: crate::meta::DEFAULT_STACK_TOP,
            dispatch_hash_addr: crate::meta::DEFAULT_DISPATCH_HASH_ADDR,
            initial_mem_pages: crate::elf_loader::INITIAL_MEM_PAGES,
            max_mem_pages: crate::elf_loader::MAX_MEM_PAGES,
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

        assert!(prog.instr_bitmap.contains(0x1001));
        assert!(prog.instr_bitmap.contains(0x1002));
        assert_eq!(find_owner_block(&prog.blocks, 0x1001), Some(0x1001));
        assert_eq!(find_owner_block(&prog.blocks, 0x1002), Some(0x1001));
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
        assert!(!prog.instr_bitmap.contains(0x1001));
        assert!(!prog.instr_bitmap.contains(0x1005));

        let gap_block = &prog.blocks[&0x1003];
        assert_eq!(gap_block.end_va, 0x1005);
        assert_eq!(gap_block.terminator, BlockTerminator::Trap);
        assert!(gap_block.succs().is_empty());

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
