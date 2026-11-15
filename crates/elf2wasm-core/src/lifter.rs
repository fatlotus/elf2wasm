use iced_x86::{Code, ConditionCode, Instruction as X86Inst, Mnemonic, OpKind, Register};
use wasm_encoder::{BlockType, Function, Instruction as WInst, MemArg};

// ============================================================================
// CPU State Global Indices
// ============================================================================

pub const GLOBAL_RAX: u32 = 0;
pub const GLOBAL_RCX: u32 = 1;
pub const GLOBAL_RDX: u32 = 2;
pub const GLOBAL_RBX: u32 = 3;
pub const GLOBAL_RSP: u32 = 4;
pub const GLOBAL_RBP: u32 = 5;
pub const GLOBAL_RSI: u32 = 6;
pub const GLOBAL_RDI: u32 = 7;
pub const GLOBAL_R8: u32 = 8;
pub const GLOBAL_R9: u32 = 9;
pub const GLOBAL_R10: u32 = 10;
pub const GLOBAL_R11: u32 = 11;
pub const GLOBAL_R12: u32 = 12;
pub const GLOBAL_R13: u32 = 13;
pub const GLOBAL_R14: u32 = 14;
pub const GLOBAL_R15: u32 = 15;

pub const GLOBAL_RIP: u32 = 16;
pub const GLOBAL_EXIT_FLAG: u32 = 17;
pub const GLOBAL_EXIT_CODE: u32 = 18;
pub const GLOBAL_FSBASE: u32 = 19;
pub const GLOBAL_GSBASE: u32 = 20;

pub const GLOBAL_CF: u32 = 21;
pub const GLOBAL_PF: u32 = 22;
pub const GLOBAL_AF: u32 = 23;
pub const GLOBAL_ZF: u32 = 24;
pub const GLOBAL_SF: u32 = 25;
pub const GLOBAL_OF: u32 = 26;
pub const GLOBAL_DF: u32 = 27;

pub const GLOBAL_XMM_BASE: u32 = 28; // 28..=43 (16 v128)
pub const GLOBAL_MXCSR: u32 = 44; // i32, init 0x1F80
pub const GLOBAL_TSC: u32 = 45; // i64, monotonic counter for rdtsc
pub const GLOBAL_X87_CW: u32 = 46; // i32, init 0x037F
pub const GLOBAL_YIELD_FLAG: u32 = 47; // i32, init 0 (0=running, 1=syscall yield, 2=quantum preempt)
pub const GLOBAL_QUANTUM: u32 = 48; // i32, init DEFAULT_QUANTUM
pub const DEFAULT_QUANTUM: i32 = 128;
pub const CTX_SIZE: usize = 464;

pub const GPR_NAMES: [&str; 16] = [
    "rax", "rcx", "rdx", "rbx", "rsp", "rbp", "rsi", "rdi", "r8", "r9", "r10", "r11", "r12", "r13",
    "r14", "r15",
];

// ============================================================================
// Chunk Function Scratch Locals Layout
// ============================================================================
// Local 0 is the function parameter `$entry_local_idx: i32`.
pub const LOCAL_PC_IDX: u32 = 0;
pub const LOCAL_I64_0: u32 = 1;
pub const LOCAL_I64_1: u32 = 2;
pub const LOCAL_I64_2: u32 = 3;
pub const LOCAL_I64_3: u32 = 4;
pub const LOCAL_I64_4: u32 = 5;
pub const LOCAL_I64_5: u32 = 6;
pub const LOCAL_I64_6: u32 = 7;
pub const LOCAL_I64_7: u32 = 8;
pub const LOCAL_I32_0: u32 = 9;
pub const LOCAL_I32_1: u32 = 10;
pub const LOCAL_I32_2: u32 = 11;
pub const LOCAL_I32_3: u32 = 12;
pub const LOCAL_I32_4: u32 = 13;
pub const LOCAL_I32_5: u32 = 14;
pub const LOCAL_I32_6: u32 = 15;
pub const LOCAL_I32_7: u32 = 16;
pub const LOCAL_F64_0: u32 = 17;
pub const LOCAL_F64_1: u32 = 18;
pub const LOCAL_F64_2: u32 = 19;
pub const LOCAL_F64_3: u32 = 20;
pub const LOCAL_F32_0: u32 = 21;
pub const LOCAL_F32_1: u32 = 22;
pub const LOCAL_F32_2: u32 = 23;
pub const LOCAL_F32_3: u32 = 24;
pub const LOCAL_V128_0: u32 = 25;
pub const LOCAL_V128_1: u32 = 26;
pub const LOCAL_V128_2: u32 = 27;
pub const LOCAL_V128_3: u32 = 28;

/// Imported syscall function index (always index 0 in the emitted module).
pub const FN_IMPORT_SYSCALL: u32 = 0;

// ============================================================================
// Register Mapping Helpers
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegWidth {
    W64,
    W32,
    W16,
    W8Low,
    W8High,
}

impl RegWidth {
    pub fn bits(self) -> u32 {
        match self {
            RegWidth::W64 => 64,
            RegWidth::W32 => 32,
            RegWidth::W16 => 16,
            RegWidth::W8Low | RegWidth::W8High => 8,
        }
    }

    pub fn bytes(self) -> u32 {
        self.bits() / 8
    }

    pub fn mask_i64(self) -> i64 {
        match self {
            RegWidth::W64 => -1i64,
            RegWidth::W32 => 0xFFFF_FFFFi64,
            RegWidth::W16 => 0xFFFFi64,
            RegWidth::W8Low | RegWidth::W8High => 0xFFi64,
        }
    }
}

pub fn map_gpr(reg: Register) -> Option<(u32, RegWidth)> {
    use RegWidth::*;
    match reg {
        // 64-bit
        Register::RAX => Some((GLOBAL_RAX, W64)),
        Register::RCX => Some((GLOBAL_RCX, W64)),
        Register::RDX => Some((GLOBAL_RDX, W64)),
        Register::RBX => Some((GLOBAL_RBX, W64)),
        Register::RSP => Some((GLOBAL_RSP, W64)),
        Register::RBP => Some((GLOBAL_RBP, W64)),
        Register::RSI => Some((GLOBAL_RSI, W64)),
        Register::RDI => Some((GLOBAL_RDI, W64)),
        Register::R8 => Some((GLOBAL_R8, W64)),
        Register::R9 => Some((GLOBAL_R9, W64)),
        Register::R10 => Some((GLOBAL_R10, W64)),
        Register::R11 => Some((GLOBAL_R11, W64)),
        Register::R12 => Some((GLOBAL_R12, W64)),
        Register::R13 => Some((GLOBAL_R13, W64)),
        Register::R14 => Some((GLOBAL_R14, W64)),
        Register::R15 => Some((GLOBAL_R15, W64)),
        // 32-bit
        Register::EAX => Some((GLOBAL_RAX, W32)),
        Register::ECX => Some((GLOBAL_RCX, W32)),
        Register::EDX => Some((GLOBAL_RDX, W32)),
        Register::EBX => Some((GLOBAL_RBX, W32)),
        Register::ESP => Some((GLOBAL_RSP, W32)),
        Register::EBP => Some((GLOBAL_RBP, W32)),
        Register::ESI => Some((GLOBAL_RSI, W32)),
        Register::EDI => Some((GLOBAL_RDI, W32)),
        Register::R8D => Some((GLOBAL_R8, W32)),
        Register::R9D => Some((GLOBAL_R9, W32)),
        Register::R10D => Some((GLOBAL_R10, W32)),
        Register::R11D => Some((GLOBAL_R11, W32)),
        Register::R12D => Some((GLOBAL_R12, W32)),
        Register::R13D => Some((GLOBAL_R13, W32)),
        Register::R14D => Some((GLOBAL_R14, W32)),
        Register::R15D => Some((GLOBAL_R15, W32)),
        // 16-bit
        Register::AX => Some((GLOBAL_RAX, W16)),
        Register::CX => Some((GLOBAL_RCX, W16)),
        Register::DX => Some((GLOBAL_RDX, W16)),
        Register::BX => Some((GLOBAL_RBX, W16)),
        Register::SP => Some((GLOBAL_RSP, W16)),
        Register::BP => Some((GLOBAL_RBP, W16)),
        Register::SI => Some((GLOBAL_RSI, W16)),
        Register::DI => Some((GLOBAL_RDI, W16)),
        Register::R8W => Some((GLOBAL_R8, W16)),
        Register::R9W => Some((GLOBAL_R9, W16)),
        Register::R10W => Some((GLOBAL_R10, W16)),
        Register::R11W => Some((GLOBAL_R11, W16)),
        Register::R12W => Some((GLOBAL_R12, W16)),
        Register::R13W => Some((GLOBAL_R13, W16)),
        Register::R14W => Some((GLOBAL_R14, W16)),
        Register::R15W => Some((GLOBAL_R15, W16)),
        // 8-bit low
        Register::AL => Some((GLOBAL_RAX, W8Low)),
        Register::CL => Some((GLOBAL_RCX, W8Low)),
        Register::DL => Some((GLOBAL_RDX, W8Low)),
        Register::BL => Some((GLOBAL_RBX, W8Low)),
        Register::SPL => Some((GLOBAL_RSP, W8Low)),
        Register::BPL => Some((GLOBAL_RBP, W8Low)),
        Register::SIL => Some((GLOBAL_RSI, W8Low)),
        Register::DIL => Some((GLOBAL_RDI, W8Low)),
        Register::R8L => Some((GLOBAL_R8, W8Low)),
        Register::R9L => Some((GLOBAL_R9, W8Low)),
        Register::R10L => Some((GLOBAL_R10, W8Low)),
        Register::R11L => Some((GLOBAL_R11, W8Low)),
        Register::R12L => Some((GLOBAL_R12, W8Low)),
        Register::R13L => Some((GLOBAL_R13, W8Low)),
        Register::R14L => Some((GLOBAL_R14, W8Low)),
        Register::R15L => Some((GLOBAL_R15, W8Low)),
        // 8-bit high
        Register::AH => Some((GLOBAL_RAX, W8High)),
        Register::CH => Some((GLOBAL_RCX, W8High)),
        Register::DH => Some((GLOBAL_RDX, W8High)),
        Register::BH => Some((GLOBAL_RBX, W8High)),
        _ => None,
    }
}

pub fn map_xmm(reg: Register) -> Option<u32> {
    match reg {
        Register::XMM0 => Some(GLOBAL_XMM_BASE),
        Register::XMM1 => Some(GLOBAL_XMM_BASE + 1),
        Register::XMM2 => Some(GLOBAL_XMM_BASE + 2),
        Register::XMM3 => Some(GLOBAL_XMM_BASE + 3),
        Register::XMM4 => Some(GLOBAL_XMM_BASE + 4),
        Register::XMM5 => Some(GLOBAL_XMM_BASE + 5),
        Register::XMM6 => Some(GLOBAL_XMM_BASE + 6),
        Register::XMM7 => Some(GLOBAL_XMM_BASE + 7),
        Register::XMM8 => Some(GLOBAL_XMM_BASE + 8),
        Register::XMM9 => Some(GLOBAL_XMM_BASE + 9),
        Register::XMM10 => Some(GLOBAL_XMM_BASE + 10),
        Register::XMM11 => Some(GLOBAL_XMM_BASE + 11),
        Register::XMM12 => Some(GLOBAL_XMM_BASE + 12),
        Register::XMM13 => Some(GLOBAL_XMM_BASE + 13),
        Register::XMM14 => Some(GLOBAL_XMM_BASE + 14),
        Register::XMM15 => Some(GLOBAL_XMM_BASE + 15),
        _ => None,
    }
}

#[inline]
fn memarg(offset: u64, align: u32) -> MemArg {
    MemArg {
        offset,
        align,
        memory_index: 0,
    }
}

// ============================================================================
// Lifter
// ============================================================================

pub struct Lifter<'a> {
    pub func: &'a mut Function,
}

impl<'a> Lifter<'a> {
    pub fn new(func: &'a mut Function) -> Self {
        Self { func }
    }

    #[inline]
    fn emit(&mut self, inst: WInst<'_>) {
        self.func.instruction(&inst);
    }

    // ------------------------------------------------------------------------
    // Register & Memory Read/Write Helpers
    // ------------------------------------------------------------------------

    fn read_gpr(&mut self, reg: Register) {
        if let Some((g, w)) = map_gpr(reg) {
            self.emit(WInst::GlobalGet(g));
            match w {
                RegWidth::W64 => {}
                RegWidth::W32 => {
                    self.emit(WInst::I64Const(0xFFFF_FFFF));
                    self.emit(WInst::I64And);
                }
                RegWidth::W16 => {
                    self.emit(WInst::I64Const(0xFFFF));
                    self.emit(WInst::I64And);
                }
                RegWidth::W8Low => {
                    self.emit(WInst::I64Const(0xFF));
                    self.emit(WInst::I64And);
                }
                RegWidth::W8High => {
                    self.emit(WInst::I64Const(8));
                    self.emit(WInst::I64ShrU);
                    self.emit(WInst::I64Const(0xFF));
                    self.emit(WInst::I64And);
                }
            }
        } else {
            self.emit(WInst::Unreachable);
            self.emit(WInst::I64Const(0));
        }
    }

    /// Consumes top-of-stack `i64` and writes to `reg` with proper width semantics.
    fn write_gpr(&mut self, reg: Register) {
        if let Some((g, w)) = map_gpr(reg) {
            match w {
                RegWidth::W64 => {
                    self.emit(WInst::GlobalSet(g));
                }
                RegWidth::W32 => {
                    self.emit(WInst::I64Const(0xFFFF_FFFF));
                    self.emit(WInst::I64And);
                    self.emit(WInst::GlobalSet(g));
                }
                RegWidth::W16 => {
                    self.emit(WInst::LocalSet(LOCAL_I64_7));
                    self.emit(WInst::GlobalGet(g));
                    self.emit(WInst::I64Const(!0xFFFFi64));
                    self.emit(WInst::I64And);
                    self.emit(WInst::LocalGet(LOCAL_I64_7));
                    self.emit(WInst::I64Const(0xFFFF));
                    self.emit(WInst::I64And);
                    self.emit(WInst::I64Or);
                    self.emit(WInst::GlobalSet(g));
                }
                RegWidth::W8Low => {
                    self.emit(WInst::LocalSet(LOCAL_I64_7));
                    self.emit(WInst::GlobalGet(g));
                    self.emit(WInst::I64Const(!0xFFi64));
                    self.emit(WInst::I64And);
                    self.emit(WInst::LocalGet(LOCAL_I64_7));
                    self.emit(WInst::I64Const(0xFF));
                    self.emit(WInst::I64And);
                    self.emit(WInst::I64Or);
                    self.emit(WInst::GlobalSet(g));
                }
                RegWidth::W8High => {
                    self.emit(WInst::LocalSet(LOCAL_I64_7));
                    self.emit(WInst::GlobalGet(g));
                    self.emit(WInst::I64Const(!0xFF00i64));
                    self.emit(WInst::I64And);
                    self.emit(WInst::LocalGet(LOCAL_I64_7));
                    self.emit(WInst::I64Const(0xFF));
                    self.emit(WInst::I64And);
                    self.emit(WInst::I64Const(8));
                    self.emit(WInst::I64Shl);
                    self.emit(WInst::I64Or);
                    self.emit(WInst::GlobalSet(g));
                }
            }
        } else {
            self.emit(WInst::Drop);
            self.emit(WInst::Unreachable);
        }
    }

    /// Pushes 64-bit effective address (without segment base) onto stack as `i64`.
    fn compute_ea_i64(&mut self, instr: &X86Inst, include_seg: bool) {
        if instr.is_ip_rel_memory_operand() {
            let target = instr.ip_rel_memory_address() as u32 as u64 as i64;
            self.emit(WInst::I64Const(target));
            if include_seg {
                match instr.segment_prefix() {
                    Register::FS => {
                        self.emit(WInst::GlobalGet(GLOBAL_FSBASE));
                        self.emit(WInst::I64Add);
                    }
                    Register::GS => {
                        self.emit(WInst::GlobalGet(GLOBAL_GSBASE));
                        self.emit(WInst::I64Add);
                    }
                    _ => {}
                }
            }
            return;
        }

        let base = instr.memory_base();
        let index = instr.memory_index();
        let scale = instr.memory_index_scale();
        let disp = instr.memory_displacement64() as i64;

        let mut has_term = false;
        if base != Register::None {
            self.read_gpr(base);
            has_term = true;
        }
        if index != Register::None {
            self.read_gpr(index);
            if scale > 1 {
                let shift = match scale {
                    2 => 1,
                    4 => 2,
                    8 => 3,
                    _ => 0,
                };
                if shift > 0 {
                    self.emit(WInst::I64Const(shift));
                    self.emit(WInst::I64Shl);
                }
            }
            if has_term {
                self.emit(WInst::I64Add);
            }
            has_term = true;
        }
        if disp != 0 || !has_term {
            self.emit(WInst::I64Const(disp));
            if has_term {
                self.emit(WInst::I64Add);
            }
            has_term = true;
        }
        if include_seg {
            match instr.segment_prefix() {
                Register::FS => {
                    self.emit(WInst::GlobalGet(GLOBAL_FSBASE));
                    if has_term {
                        self.emit(WInst::I64Add);
                    }
                }
                Register::GS => {
                    self.emit(WInst::GlobalGet(GLOBAL_GSBASE));
                    if has_term {
                        self.emit(WInst::I64Add);
                    }
                }
                _ => {}
            }
        }
    }

    /// Pushes 32-bit WASM linear memory address onto stack as `i32`.
    fn compute_ea_i32(&mut self, instr: &X86Inst) {
        self.compute_ea_i64(instr, true);
        self.emit(WInst::I32WrapI64);
    }

    fn load_mem_i64(&mut self, width_bytes: u32) {
        match width_bytes {
            1 => self.emit(WInst::I64Load8U(memarg(0, 0))),
            2 => self.emit(WInst::I64Load16U(memarg(0, 0))),
            4 => self.emit(WInst::I64Load32U(memarg(0, 0))),
            8 => self.emit(WInst::I64Load(memarg(0, 0))),
            _ => {
                self.emit(WInst::Drop);
                self.emit(WInst::Unreachable);
                self.emit(WInst::I64Const(0));
            }
        }
    }

    /// Expects `[addr_i32, val_i64]` on stack.
    fn store_mem_i64(&mut self, width_bytes: u32) {
        match width_bytes {
            1 => self.emit(WInst::I64Store8(memarg(0, 0))),
            2 => self.emit(WInst::I64Store16(memarg(0, 0))),
            4 => self.emit(WInst::I64Store32(memarg(0, 0))),
            8 => self.emit(WInst::I64Store(memarg(0, 0))),
            _ => {
                self.emit(WInst::Drop);
                self.emit(WInst::Drop);
                self.emit(WInst::Unreachable);
            }
        }
    }

    fn operand_width_bytes(&self, instr: &X86Inst, op_idx: u32) -> u32 {
        match instr.op_kind(op_idx) {
            OpKind::Register => {
                if let Some((_, w)) = map_gpr(instr.op_register(op_idx)) {
                    w.bytes()
                } else {
                    16
                }
            }
            OpKind::Memory => instr.memory_size().size() as u32,
            OpKind::Immediate8 | OpKind::Immediate8_2nd => 1,
            OpKind::Immediate16 => 2,
            OpKind::Immediate32 | OpKind::Immediate8to32 => 4,
            OpKind::Immediate64 | OpKind::Immediate8to64 | OpKind::Immediate32to64 => 8,
            OpKind::Immediate8to16 => 2,
            _ => 8,
        }
    }

    fn read_op_i64(&mut self, instr: &X86Inst, op_idx: u32, width_bytes: u32) {
        match instr.op_kind(op_idx) {
            OpKind::Register => self.read_gpr(instr.op_register(op_idx)),
            OpKind::Memory => {
                self.compute_ea_i32(instr);
                self.load_mem_i64(width_bytes);
            }
            OpKind::Immediate8 => {
                let v = instr.immediate8() as u64 & 0xFF;
                self.emit(WInst::I64Const(v as i64));
            }
            OpKind::Immediate8_2nd => {
                let v = instr.immediate8_2nd() as u64 & 0xFF;
                self.emit(WInst::I64Const(v as i64));
            }
            OpKind::Immediate16 => {
                let v = instr.immediate16() as u64 & 0xFFFF;
                self.emit(WInst::I64Const(v as i64));
            }
            OpKind::Immediate32 => {
                let v = instr.immediate32() as u64 & 0xFFFF_FFFF;
                self.emit(WInst::I64Const(v as i64));
            }
            OpKind::Immediate64 => {
                self.emit(WInst::I64Const(instr.immediate64() as i64));
            }
            OpKind::Immediate8to16 => {
                let v = (instr.immediate8to16() as u16) as u64;
                self.emit(WInst::I64Const(v as i64));
            }
            OpKind::Immediate8to32 => {
                let v = (instr.immediate8to32() as u32) as u64;
                self.emit(WInst::I64Const(v as i64));
            }
            OpKind::Immediate8to64 => {
                let v = instr.immediate8to64();
                self.emit(WInst::I64Const(v));
            }
            OpKind::Immediate32to64 => {
                let v = instr.immediate32to64();
                self.emit(WInst::I64Const(v));
            }
            _ => {
                self.emit(WInst::Unreachable);
                self.emit(WInst::I64Const(0));
            }
        }
    }

    /// Consumes top-of-stack `i64` and writes to `op_idx`.
    fn write_op_i64(&mut self, instr: &X86Inst, op_idx: u32, width_bytes: u32) {
        match instr.op_kind(op_idx) {
            OpKind::Register => self.write_gpr(instr.op_register(op_idx)),
            OpKind::Memory => {
                self.emit(WInst::LocalSet(LOCAL_I64_6));
                self.compute_ea_i32(instr);
                self.emit(WInst::LocalGet(LOCAL_I64_6));
                self.store_mem_i64(width_bytes);
            }
            _ => {
                self.emit(WInst::Drop);
                self.emit(WInst::Unreachable);
            }
        }
    }

    fn read_xmm(&mut self, reg: Register) {
        if let Some(g) = map_xmm(reg) {
            self.emit(WInst::GlobalGet(g));
        } else {
            self.emit(WInst::Unreachable);
            self.emit(WInst::V128Const(0));
        }
    }

    fn write_xmm(&mut self, reg: Register) {
        if let Some(g) = map_xmm(reg) {
            self.emit(WInst::GlobalSet(g));
        } else {
            self.emit(WInst::Drop);
            self.emit(WInst::Unreachable);
        }
    }

    fn read_op_v128(&mut self, instr: &X86Inst, op_idx: u32) {
        match instr.op_kind(op_idx) {
            OpKind::Register => self.read_xmm(instr.op_register(op_idx)),
            OpKind::Memory => {
                self.compute_ea_i32(instr);
                self.emit(WInst::V128Load(memarg(0, 0)));
            }
            _ => {
                self.emit(WInst::Unreachable);
                self.emit(WInst::V128Const(0));
            }
        }
    }

    // ------------------------------------------------------------------------
    // Masking & Flag Helpers
    // ------------------------------------------------------------------------

    /// Masks top-of-stack `i64` to `width_bytes` (zero-extended).
    fn mask_i64(&mut self, width_bytes: u32) {
        match width_bytes {
            1 => {
                self.emit(WInst::I64Const(0xFF));
                self.emit(WInst::I64And);
            }
            2 => {
                self.emit(WInst::I64Const(0xFFFF));
                self.emit(WInst::I64And);
            }
            4 => {
                self.emit(WInst::I64Const(0xFFFF_FFFF));
                self.emit(WInst::I64And);
            }
            _ => {}
        }
    }

    /// Sign-extends low `width_bytes` of top-of-stack `i64` to full 64-bit `i64`.
    fn sext_i64(&mut self, width_bytes: u32) {
        match width_bytes {
            1 => self.emit(WInst::I64Extend8S),
            2 => self.emit(WInst::I64Extend16S),
            4 => self.emit(WInst::I64Extend32S),
            _ => {}
        }
    }

    /// Updates `ZF`, `SF`, `PF` from `local_res` (`i64`, already masked to `width_bytes`).
    fn set_zsp_flags(&mut self, local_res: u32, width_bytes: u32) {
        let bits = width_bytes * 8;
        // ZF = (res == 0)
        self.emit(WInst::LocalGet(local_res));
        self.emit(WInst::I64Eqz);
        self.emit(WInst::GlobalSet(GLOBAL_ZF));

        // SF = (res >> (bits - 1)) & 1
        self.emit(WInst::LocalGet(local_res));
        self.emit(WInst::I64Const((bits - 1) as i64));
        self.emit(WInst::I64ShrU);
        self.emit(WInst::I32WrapI64);
        self.emit(WInst::I32Const(1));
        self.emit(WInst::I32And);
        self.emit(WInst::GlobalSet(GLOBAL_SF));

        // PF = ((popcnt(res & 0xFF) & 1) ^ 1)
        self.emit(WInst::LocalGet(local_res));
        self.emit(WInst::I32WrapI64);
        self.emit(WInst::I32Const(0xFF));
        self.emit(WInst::I32And);
        self.emit(WInst::I32Popcnt);
        self.emit(WInst::I32Const(1));
        self.emit(WInst::I32And);
        self.emit(WInst::I32Const(1));
        self.emit(WInst::I32Xor);
        self.emit(WInst::GlobalSet(GLOBAL_PF));
    }

    /// Updates `CF, OF, AF, ZF, SF, PF` after `res = a + b` (or `adc`).
    /// `local_a`, `local_b`, `local_res` are `i64` masked to `width_bytes`.
    fn set_add_flags(
        &mut self,
        local_a: u32,
        local_b: u32,
        local_res: u32,
        width_bytes: u32,
        update_cf: bool,
        cf_override_local: Option<u32>,
    ) {
        let bits = width_bytes * 8;
        if update_cf {
            if let Some(cf_loc) = cf_override_local {
                self.emit(WInst::LocalGet(cf_loc));
                self.emit(WInst::GlobalSet(GLOBAL_CF));
            } else {
                // CF = (res < a) unsigned
                self.emit(WInst::LocalGet(local_res));
                self.emit(WInst::LocalGet(local_a));
                self.emit(WInst::I64LtU);
                self.emit(WInst::GlobalSet(GLOBAL_CF));
            }
        }
        // OF = (((a ^ res) & (b ^ res)) >> (bits - 1)) & 1
        self.emit(WInst::LocalGet(local_a));
        self.emit(WInst::LocalGet(local_res));
        self.emit(WInst::I64Xor);
        self.emit(WInst::LocalGet(local_b));
        self.emit(WInst::LocalGet(local_res));
        self.emit(WInst::I64Xor);
        self.emit(WInst::I64And);
        self.emit(WInst::I64Const((bits - 1) as i64));
        self.emit(WInst::I64ShrU);
        self.emit(WInst::I32WrapI64);
        self.emit(WInst::I32Const(1));
        self.emit(WInst::I32And);
        self.emit(WInst::GlobalSet(GLOBAL_OF));

        // AF = ((a ^ b ^ res) >> 4) & 1
        self.emit(WInst::LocalGet(local_a));
        self.emit(WInst::LocalGet(local_b));
        self.emit(WInst::I64Xor);
        self.emit(WInst::LocalGet(local_res));
        self.emit(WInst::I64Xor);
        self.emit(WInst::I64Const(4));
        self.emit(WInst::I64ShrU);
        self.emit(WInst::I32WrapI64);
        self.emit(WInst::I32Const(1));
        self.emit(WInst::I32And);
        self.emit(WInst::GlobalSet(GLOBAL_AF));

        self.set_zsp_flags(local_res, width_bytes);
    }

    /// Updates `CF, OF, AF, ZF, SF, PF` after `res = a - b` (or `sbb`).
    fn set_sub_flags(
        &mut self,
        local_a: u32,
        local_b: u32,
        local_res: u32,
        width_bytes: u32,
        update_cf: bool,
        cf_override_local: Option<u32>,
    ) {
        let bits = width_bytes * 8;
        if update_cf {
            if let Some(cf_loc) = cf_override_local {
                self.emit(WInst::LocalGet(cf_loc));
                self.emit(WInst::GlobalSet(GLOBAL_CF));
            } else {
                // CF = (a < b) unsigned
                self.emit(WInst::LocalGet(local_a));
                self.emit(WInst::LocalGet(local_b));
                self.emit(WInst::I64LtU);
                self.emit(WInst::GlobalSet(GLOBAL_CF));
            }
        }
        // OF = (((a ^ b) & (a ^ res)) >> (bits - 1)) & 1
        self.emit(WInst::LocalGet(local_a));
        self.emit(WInst::LocalGet(local_b));
        self.emit(WInst::I64Xor);
        self.emit(WInst::LocalGet(local_a));
        self.emit(WInst::LocalGet(local_res));
        self.emit(WInst::I64Xor);
        self.emit(WInst::I64And);
        self.emit(WInst::I64Const((bits - 1) as i64));
        self.emit(WInst::I64ShrU);
        self.emit(WInst::I32WrapI64);
        self.emit(WInst::I32Const(1));
        self.emit(WInst::I32And);
        self.emit(WInst::GlobalSet(GLOBAL_OF));

        // AF = ((a ^ b ^ res) >> 4) & 1
        self.emit(WInst::LocalGet(local_a));
        self.emit(WInst::LocalGet(local_b));
        self.emit(WInst::I64Xor);
        self.emit(WInst::LocalGet(local_res));
        self.emit(WInst::I64Xor);
        self.emit(WInst::I64Const(4));
        self.emit(WInst::I64ShrU);
        self.emit(WInst::I32WrapI64);
        self.emit(WInst::I32Const(1));
        self.emit(WInst::I32And);
        self.emit(WInst::GlobalSet(GLOBAL_AF));

        self.set_zsp_flags(local_res, width_bytes);
    }

    fn set_logic_flags(&mut self, local_res: u32, width_bytes: u32) {
        self.emit(WInst::I32Const(0));
        self.emit(WInst::GlobalSet(GLOBAL_CF));
        self.emit(WInst::I32Const(0));
        self.emit(WInst::GlobalSet(GLOBAL_OF));
        self.emit(WInst::I32Const(0));
        self.emit(WInst::GlobalSet(GLOBAL_AF));
        self.set_zsp_flags(local_res, width_bytes);
    }

    /// Evaluates x86 `ConditionCode` onto stack as `i32` (`0` or `1`).
    pub fn emit_condition(&mut self, cc: ConditionCode) {
        match cc {
            ConditionCode::o => {
                self.emit(WInst::GlobalGet(GLOBAL_OF));
            }
            ConditionCode::no => {
                self.emit(WInst::GlobalGet(GLOBAL_OF));
                self.emit(WInst::I32Eqz);
            }
            ConditionCode::b => {
                self.emit(WInst::GlobalGet(GLOBAL_CF));
            }
            ConditionCode::ae => {
                self.emit(WInst::GlobalGet(GLOBAL_CF));
                self.emit(WInst::I32Eqz);
            }
            ConditionCode::e => {
                self.emit(WInst::GlobalGet(GLOBAL_ZF));
            }
            ConditionCode::ne => {
                self.emit(WInst::GlobalGet(GLOBAL_ZF));
                self.emit(WInst::I32Eqz);
            }
            ConditionCode::be => {
                self.emit(WInst::GlobalGet(GLOBAL_CF));
                self.emit(WInst::GlobalGet(GLOBAL_ZF));
                self.emit(WInst::I32Or);
            }
            ConditionCode::a => {
                self.emit(WInst::GlobalGet(GLOBAL_CF));
                self.emit(WInst::GlobalGet(GLOBAL_ZF));
                self.emit(WInst::I32Or);
                self.emit(WInst::I32Eqz);
            }
            ConditionCode::s => {
                self.emit(WInst::GlobalGet(GLOBAL_SF));
            }
            ConditionCode::ns => {
                self.emit(WInst::GlobalGet(GLOBAL_SF));
                self.emit(WInst::I32Eqz);
            }
            ConditionCode::p => {
                self.emit(WInst::GlobalGet(GLOBAL_PF));
            }
            ConditionCode::np => {
                self.emit(WInst::GlobalGet(GLOBAL_PF));
                self.emit(WInst::I32Eqz);
            }
            ConditionCode::l => {
                self.emit(WInst::GlobalGet(GLOBAL_SF));
                self.emit(WInst::GlobalGet(GLOBAL_OF));
                self.emit(WInst::I32Xor);
            }
            ConditionCode::ge => {
                self.emit(WInst::GlobalGet(GLOBAL_SF));
                self.emit(WInst::GlobalGet(GLOBAL_OF));
                self.emit(WInst::I32Xor);
                self.emit(WInst::I32Eqz);
            }
            ConditionCode::le => {
                self.emit(WInst::GlobalGet(GLOBAL_SF));
                self.emit(WInst::GlobalGet(GLOBAL_OF));
                self.emit(WInst::I32Xor);
                self.emit(WInst::GlobalGet(GLOBAL_ZF));
                self.emit(WInst::I32Or);
            }
            ConditionCode::g => {
                self.emit(WInst::GlobalGet(GLOBAL_SF));
                self.emit(WInst::GlobalGet(GLOBAL_OF));
                self.emit(WInst::I32Xor);
                self.emit(WInst::GlobalGet(GLOBAL_ZF));
                self.emit(WInst::I32Or);
                self.emit(WInst::I32Eqz);
            }
            ConditionCode::None => {
                self.emit(WInst::I32Const(1));
            }
        }
    }

    fn emit_pack_rflags(&mut self) {
        // 0x202 | cf | (pf<<2) | (af<<4) | (zf<<6) | (sf<<7) | (df<<10) | (of<<11)
        self.emit(WInst::I64Const(0x202));
        let pairs = [
            (GLOBAL_CF, 0),
            (GLOBAL_PF, 2),
            (GLOBAL_AF, 4),
            (GLOBAL_ZF, 6),
            (GLOBAL_SF, 7),
            (GLOBAL_DF, 10),
            (GLOBAL_OF, 11),
        ];
        for (g, shift) in pairs {
            self.emit(WInst::GlobalGet(g));
            self.emit(WInst::I64ExtendI32U);
            if shift > 0 {
                self.emit(WInst::I64Const(shift));
                self.emit(WInst::I64Shl);
            }
            self.emit(WInst::I64Or);
        }
    }

    fn emit_unpack_rflags(&mut self, local_flags: u32) {
        let pairs = [
            (GLOBAL_CF, 0),
            (GLOBAL_PF, 2),
            (GLOBAL_AF, 4),
            (GLOBAL_ZF, 6),
            (GLOBAL_SF, 7),
            (GLOBAL_DF, 10),
            (GLOBAL_OF, 11),
        ];
        for (g, shift) in pairs {
            self.emit(WInst::LocalGet(local_flags));
            if shift > 0 {
                self.emit(WInst::I64Const(shift));
                self.emit(WInst::I64ShrU);
            }
            self.emit(WInst::I32WrapI64);
            self.emit(WInst::I32Const(1));
            self.emit(WInst::I32And);
            self.emit(WInst::GlobalSet(g));
        }
    }

    // ------------------------------------------------------------------------
    // 64x64 -> 128-bit Multiply Helper
    // ------------------------------------------------------------------------
    /// Inputs: `local_a` (`i64`), `local_b` (`i64`).
    /// Outputs: `local_lo` (`i64`), `local_hi` (`i64`).
    /// Clobbers `LOCAL_I64_4`, `LOCAL_I64_5`, `LOCAL_I64_6`.
    fn emit_umul128(&mut self, local_a: u32, local_b: u32, local_lo: u32, local_hi: u32) {
        // p00 = (a & mask32) * (b & mask32) -> LOCAL_I64_4
        // mid = (p00 >> 32) + ((a & mask32) * (b >> 32) & mask32) + ((a >> 32) * (b & mask32) & mask32) -> LOCAL_I64_5
        let mask32 = 0xFFFF_FFFFi64;

        // p00
        self.emit(WInst::LocalGet(local_a));
        self.emit(WInst::I64Const(mask32));
        self.emit(WInst::I64And);
        self.emit(WInst::LocalGet(local_b));
        self.emit(WInst::I64Const(mask32));
        self.emit(WInst::I64And);
        self.emit(WInst::I64Mul);
        self.emit(WInst::LocalSet(LOCAL_I64_4));

        // p01 = (a & mask32) * (b >> 32) -> LOCAL_I64_5
        self.emit(WInst::LocalGet(local_a));
        self.emit(WInst::I64Const(mask32));
        self.emit(WInst::I64And);
        self.emit(WInst::LocalGet(local_b));
        self.emit(WInst::I64Const(32));
        self.emit(WInst::I64ShrU);
        self.emit(WInst::I64Mul);
        self.emit(WInst::LocalSet(LOCAL_I64_5));

        // p10 = (a >> 32) * (b & mask32) -> LOCAL_I64_6
        self.emit(WInst::LocalGet(local_a));
        self.emit(WInst::I64Const(32));
        self.emit(WInst::I64ShrU);
        self.emit(WInst::LocalGet(local_b));
        self.emit(WInst::I64Const(mask32));
        self.emit(WInst::I64And);
        self.emit(WInst::I64Mul);
        self.emit(WInst::LocalSet(LOCAL_I64_6));

        // mid = (p00 >> 32) + (p01 & mask32) + (p10 & mask32) -> local_lo (temp)
        self.emit(WInst::LocalGet(LOCAL_I64_4));
        self.emit(WInst::I64Const(32));
        self.emit(WInst::I64ShrU);
        self.emit(WInst::LocalGet(LOCAL_I64_5));
        self.emit(WInst::I64Const(mask32));
        self.emit(WInst::I64And);
        self.emit(WInst::I64Add);
        self.emit(WInst::LocalGet(LOCAL_I64_6));
        self.emit(WInst::I64Const(mask32));
        self.emit(WInst::I64And);
        self.emit(WInst::I64Add);
        self.emit(WInst::LocalSet(local_lo)); // holds mid

        // hi = ((a >> 32) * (b >> 32)) + (p01 >> 32) + (p10 >> 32) + (mid >> 32)
        self.emit(WInst::LocalGet(local_a));
        self.emit(WInst::I64Const(32));
        self.emit(WInst::I64ShrU);
        self.emit(WInst::LocalGet(local_b));
        self.emit(WInst::I64Const(32));
        self.emit(WInst::I64ShrU);
        self.emit(WInst::I64Mul);
        self.emit(WInst::LocalGet(LOCAL_I64_5));
        self.emit(WInst::I64Const(32));
        self.emit(WInst::I64ShrU);
        self.emit(WInst::I64Add);
        self.emit(WInst::LocalGet(LOCAL_I64_6));
        self.emit(WInst::I64Const(32));
        self.emit(WInst::I64ShrU);
        self.emit(WInst::I64Add);
        self.emit(WInst::LocalGet(local_lo));
        self.emit(WInst::I64Const(32));
        self.emit(WInst::I64ShrU);
        self.emit(WInst::I64Add);
        self.emit(WInst::LocalSet(local_hi));

        // lo = (p00 & mask32) | (mid << 32)
        self.emit(WInst::LocalGet(LOCAL_I64_4));
        self.emit(WInst::I64Const(mask32));
        self.emit(WInst::I64And);
        self.emit(WInst::LocalGet(local_lo));
        self.emit(WInst::I64Const(32));
        self.emit(WInst::I64Shl);
        self.emit(WInst::I64Or);
        self.emit(WInst::LocalSet(local_lo));
    }

    // ------------------------------------------------------------------------
    // 128-by-64 Unsigned Division Helper
    // ------------------------------------------------------------------------
    /// Inputs: `LOCAL_I64_0` = lo, `LOCAL_I64_1` = hi, `LOCAL_I64_2` = divisor.
    /// Outputs: `LOCAL_I64_3` = quotient, `LOCAL_I64_1` = remainder.
    /// Uses `LOCAL_I32_0` as loop counter, `LOCAL_I64_4` as borrow/carry bit.
    fn emit_udiv128_64(&mut self) {
        // Fast path: hi == 0
        self.emit(WInst::LocalGet(LOCAL_I64_1));
        self.emit(WInst::I64Eqz);
        self.emit(WInst::If(BlockType::Empty));
        {
            self.emit(WInst::LocalGet(LOCAL_I64_0));
            self.emit(WInst::LocalGet(LOCAL_I64_2));
            self.emit(WInst::I64DivU);
            self.emit(WInst::LocalSet(LOCAL_I64_3));

            self.emit(WInst::LocalGet(LOCAL_I64_0));
            self.emit(WInst::LocalGet(LOCAL_I64_2));
            self.emit(WInst::I64RemU);
            self.emit(WInst::LocalSet(LOCAL_I64_1));
        }
        self.emit(WInst::Else);
        {
            // Restoring shift-and-subtract (64 iterations)
            // q = 0 (LOCAL_I64_3), rem = hi (LOCAL_I64_1), lo = lo (LOCAL_I64_0)
            self.emit(WInst::I64Const(0));
            self.emit(WInst::LocalSet(LOCAL_I64_3));
            self.emit(WInst::I32Const(64));
            self.emit(WInst::LocalSet(LOCAL_I32_0));

            self.emit(WInst::Loop(BlockType::Empty));
            {
                // msb_of_rem = (rem >> 63) & 1 -> LOCAL_I64_4
                self.emit(WInst::LocalGet(LOCAL_I64_1));
                self.emit(WInst::I64Const(63));
                self.emit(WInst::I64ShrU);
                self.emit(WInst::LocalSet(LOCAL_I64_4));

                // rem = (rem << 1) | (lo >> 63)
                self.emit(WInst::LocalGet(LOCAL_I64_1));
                self.emit(WInst::I64Const(1));
                self.emit(WInst::I64Shl);
                self.emit(WInst::LocalGet(LOCAL_I64_0));
                self.emit(WInst::I64Const(63));
                self.emit(WInst::I64ShrU);
                self.emit(WInst::I64Or);
                self.emit(WInst::LocalSet(LOCAL_I64_1));

                // lo <<= 1
                self.emit(WInst::LocalGet(LOCAL_I64_0));
                self.emit(WInst::I64Const(1));
                self.emit(WInst::I64Shl);
                self.emit(WInst::LocalSet(LOCAL_I64_0));

                // q <<= 1
                self.emit(WInst::LocalGet(LOCAL_I64_3));
                self.emit(WInst::I64Const(1));
                self.emit(WInst::I64Shl);
                self.emit(WInst::LocalSet(LOCAL_I64_3));

                // if msb_of_rem != 0 || rem >= divisor
                self.emit(WInst::LocalGet(LOCAL_I64_4));
                self.emit(WInst::I64Const(0));
                self.emit(WInst::I64Ne);
                self.emit(WInst::LocalGet(LOCAL_I64_1));
                self.emit(WInst::LocalGet(LOCAL_I64_2));
                self.emit(WInst::I64GeU);
                self.emit(WInst::I32Or);
                self.emit(WInst::If(BlockType::Empty));
                {
                    self.emit(WInst::LocalGet(LOCAL_I64_1));
                    self.emit(WInst::LocalGet(LOCAL_I64_2));
                    self.emit(WInst::I64Sub);
                    self.emit(WInst::LocalSet(LOCAL_I64_1));

                    self.emit(WInst::LocalGet(LOCAL_I64_3));
                    self.emit(WInst::I64Const(1));
                    self.emit(WInst::I64Or);
                    self.emit(WInst::LocalSet(LOCAL_I64_3));
                }
                self.emit(WInst::End);

                // i -= 1; br_if 0 if i > 0
                self.emit(WInst::LocalGet(LOCAL_I32_0));
                self.emit(WInst::I32Const(1));
                self.emit(WInst::I32Sub);
                self.emit(WInst::LocalTee(LOCAL_I32_0));
                self.emit(WInst::BrIf(0));
            }
            self.emit(WInst::End);
        }
        self.emit(WInst::End);
    }

    // ------------------------------------------------------------------------
    // Main Instruction Dispatcher (Non-Terminator Instructions)
    // ------------------------------------------------------------------------

    /// Lifts a single non-terminating x86-64 instruction.
    /// Terminators (`Jcc`, `Jmp`, `Call`, `Ret`, `Trap`) are handled by `wasm_emit.rs`
    /// using `DecodedBlock::terminator` (with `Lifter::emit_condition` / `compute_ea_i64` etc.).
    pub fn lift_instruction(&mut self, instr: &X86Inst) {
        match instr.mnemonic() {
            // ----------------------------------------------------------------
            // NOPs & Hints
            // ----------------------------------------------------------------
            Mnemonic::Nop
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
            | Mnemonic::Wait => {}

            // ----------------------------------------------------------------
            // Data Movement
            // ----------------------------------------------------------------
            Mnemonic::Mov => {
                let w = self.operand_width_bytes(instr, 0);
                self.read_op_i64(instr, 1, w);
                self.write_op_i64(instr, 0, w);
            }
            Mnemonic::Movzx => {
                let dst_w = self.operand_width_bytes(instr, 0);
                let src_w = self.operand_width_bytes(instr, 1);
                self.read_op_i64(instr, 1, src_w);
                self.mask_i64(src_w);
                self.write_op_i64(instr, 0, dst_w);
            }
            Mnemonic::Movsx | Mnemonic::Movsxd => {
                let dst_w = self.operand_width_bytes(instr, 0);
                let src_w = self.operand_width_bytes(instr, 1);
                self.read_op_i64(instr, 1, src_w);
                self.sext_i64(src_w);
                self.write_op_i64(instr, 0, dst_w);
            }
            Mnemonic::Lea => {
                let dst_w = self.operand_width_bytes(instr, 0);
                self.compute_ea_i64(instr, false);
                self.write_op_i64(instr, 0, dst_w);
            }
            Mnemonic::Xchg => {
                let w = self.operand_width_bytes(instr, 0);
                if instr.op_kind(0) == OpKind::Memory {
                    self.compute_ea_i32(instr);
                    self.emit(WInst::LocalTee(LOCAL_I32_0));
                    self.load_mem_i64(w);
                    self.emit(WInst::LocalSet(LOCAL_I64_0));
                    self.emit(WInst::LocalGet(LOCAL_I32_0));
                    self.read_op_i64(instr, 1, w);
                    self.store_mem_i64(w);
                    self.emit(WInst::LocalGet(LOCAL_I64_0));
                    self.write_op_i64(instr, 1, w);
                } else if instr.op_kind(1) == OpKind::Memory {
                    self.compute_ea_i32(instr);
                    self.emit(WInst::LocalTee(LOCAL_I32_0));
                    self.load_mem_i64(w);
                    self.emit(WInst::LocalSet(LOCAL_I64_0));
                    self.emit(WInst::LocalGet(LOCAL_I32_0));
                    self.read_op_i64(instr, 0, w);
                    self.store_mem_i64(w);
                    self.emit(WInst::LocalGet(LOCAL_I64_0));
                    self.write_op_i64(instr, 0, w);
                } else {
                    self.read_op_i64(instr, 0, w);
                    self.emit(WInst::LocalSet(LOCAL_I64_0));
                    self.read_op_i64(instr, 1, w);
                    self.write_op_i64(instr, 0, w);
                    self.emit(WInst::LocalGet(LOCAL_I64_0));
                    self.write_op_i64(instr, 1, w);
                }
            }
            Mnemonic::Bswap => {
                let w = self.operand_width_bytes(instr, 0);
                self.read_op_i64(instr, 0, w);
                self.emit(WInst::LocalSet(LOCAL_I64_0));
                if w == 4 {
                    self.emit(WInst::I64Const(0));
                    for i in 0..4 {
                        self.emit(WInst::LocalGet(LOCAL_I64_0));
                        if i > 0 {
                            self.emit(WInst::I64Const((i * 8) as i64));
                            self.emit(WInst::I64ShrU);
                        }
                        self.emit(WInst::I64Const(0xFF));
                        self.emit(WInst::I64And);
                        let dst_shift = (3 - i) * 8;
                        if dst_shift > 0 {
                            self.emit(WInst::I64Const(dst_shift as i64));
                            self.emit(WInst::I64Shl);
                        }
                        self.emit(WInst::I64Or);
                    }
                    self.write_op_i64(instr, 0, 4);
                } else {
                    self.emit(WInst::I64Const(0));
                    for i in 0..8 {
                        self.emit(WInst::LocalGet(LOCAL_I64_0));
                        if i > 0 {
                            self.emit(WInst::I64Const((i * 8) as i64));
                            self.emit(WInst::I64ShrU);
                        }
                        self.emit(WInst::I64Const(0xFF));
                        self.emit(WInst::I64And);
                        let dst_shift = (7 - i) * 8;
                        if dst_shift > 0 {
                            self.emit(WInst::I64Const(dst_shift as i64));
                            self.emit(WInst::I64Shl);
                        }
                        self.emit(WInst::I64Or);
                    }
                    self.write_op_i64(instr, 0, 8);
                }
            }
            Mnemonic::Cbw => {
                self.read_gpr(Register::AL);
                self.emit(WInst::I64Extend8S);
                self.write_gpr(Register::AX);
            }
            Mnemonic::Cwde => {
                self.read_gpr(Register::AX);
                self.emit(WInst::I64Extend16S);
                self.write_gpr(Register::EAX);
            }
            Mnemonic::Cdqe => {
                self.read_gpr(Register::EAX);
                self.emit(WInst::I64Extend32S);
                self.write_gpr(Register::RAX);
            }
            Mnemonic::Cwd => {
                self.read_gpr(Register::AX);
                self.emit(WInst::I64Extend16S);
                self.emit(WInst::I64Const(16));
                self.emit(WInst::I64ShrS);
                self.write_gpr(Register::DX);
            }
            Mnemonic::Cdq => {
                self.read_gpr(Register::EAX);
                self.emit(WInst::I64Extend32S);
                self.emit(WInst::I64Const(32));
                self.emit(WInst::I64ShrS);
                self.write_gpr(Register::EDX);
            }
            Mnemonic::Cqo => {
                self.emit(WInst::GlobalGet(GLOBAL_RAX));
                self.emit(WInst::I64Const(63));
                self.emit(WInst::I64ShrS);
                self.emit(WInst::GlobalSet(GLOBAL_RDX));
            }
            Mnemonic::Push => {
                let w = self.operand_width_bytes(instr, 0).max(2);
                let push_w = if w == 4 { 8 } else { w };
                self.read_op_i64(instr, 0, push_w);
                if instr.op0_kind() != OpKind::Register && push_w == 8 {
                    // Immediate8to64 / Immediate32to64 already sign-extended in read_op_i64
                }
                self.emit(WInst::LocalSet(LOCAL_I64_0));
                self.emit(WInst::GlobalGet(GLOBAL_RSP));
                self.emit(WInst::I64Const(push_w as i64));
                self.emit(WInst::I64Sub);
                self.emit(WInst::GlobalSet(GLOBAL_RSP));
                self.emit(WInst::GlobalGet(GLOBAL_RSP));
                self.emit(WInst::I32WrapI64);
                self.emit(WInst::LocalGet(LOCAL_I64_0));
                self.store_mem_i64(push_w);
            }
            Mnemonic::Pop => {
                let w = self.operand_width_bytes(instr, 0).max(2);
                let pop_w = if w == 4 { 8 } else { w };
                self.emit(WInst::GlobalGet(GLOBAL_RSP));
                self.emit(WInst::I32WrapI64);
                self.load_mem_i64(pop_w);
                self.emit(WInst::LocalSet(LOCAL_I64_0));
                self.emit(WInst::GlobalGet(GLOBAL_RSP));
                self.emit(WInst::I64Const(pop_w as i64));
                self.emit(WInst::I64Add);
                self.emit(WInst::GlobalSet(GLOBAL_RSP));
                self.emit(WInst::LocalGet(LOCAL_I64_0));
                self.write_op_i64(instr, 0, pop_w);
            }
            Mnemonic::Leave => {
                self.emit(WInst::GlobalGet(GLOBAL_RBP));
                self.emit(WInst::GlobalSet(GLOBAL_RSP));
                self.emit(WInst::GlobalGet(GLOBAL_RSP));
                self.emit(WInst::I32WrapI64);
                self.load_mem_i64(8);
                self.emit(WInst::GlobalSet(GLOBAL_RBP));
                self.emit(WInst::GlobalGet(GLOBAL_RSP));
                self.emit(WInst::I64Const(8));
                self.emit(WInst::I64Add);
                self.emit(WInst::GlobalSet(GLOBAL_RSP));
            }
            Mnemonic::Pushfq | Mnemonic::Pushf => {
                self.emit_pack_rflags();
                self.emit(WInst::LocalSet(LOCAL_I64_0));
                self.emit(WInst::GlobalGet(GLOBAL_RSP));
                self.emit(WInst::I64Const(8));
                self.emit(WInst::I64Sub);
                self.emit(WInst::GlobalSet(GLOBAL_RSP));
                self.emit(WInst::GlobalGet(GLOBAL_RSP));
                self.emit(WInst::I32WrapI64);
                self.emit(WInst::LocalGet(LOCAL_I64_0));
                self.store_mem_i64(8);
            }
            Mnemonic::Popfq | Mnemonic::Popf => {
                self.emit(WInst::GlobalGet(GLOBAL_RSP));
                self.emit(WInst::I32WrapI64);
                self.load_mem_i64(8);
                self.emit(WInst::LocalSet(LOCAL_I64_0));
                self.emit(WInst::GlobalGet(GLOBAL_RSP));
                self.emit(WInst::I64Const(8));
                self.emit(WInst::I64Add);
                self.emit(WInst::GlobalSet(GLOBAL_RSP));
                self.emit_unpack_rflags(LOCAL_I64_0);
            }

            // ----------------------------------------------------------------
            // Conditional Moves & Setcc
            // ----------------------------------------------------------------
            m if is_cmovcc(m) => {
                let cc = instr.condition_code();
                let w = self.operand_width_bytes(instr, 0);
                self.emit_condition(cc);
                self.emit(WInst::If(BlockType::Empty));
                {
                    self.read_op_i64(instr, 1, w);
                    self.write_op_i64(instr, 0, w);
                }
                if w == 4 && instr.op0_kind() == OpKind::Register {
                    self.emit(WInst::Else);
                    self.read_op_i64(instr, 0, 4);
                    self.write_op_i64(instr, 0, 4);
                }
                self.emit(WInst::End);
            }
            m if is_setcc(m) => {
                let cc = instr.condition_code();
                self.emit_condition(cc);
                self.emit(WInst::I64ExtendI32U);
                self.write_op_i64(instr, 0, 1);
            }

            // ----------------------------------------------------------------
            // ALU & Flags
            // ----------------------------------------------------------------
            Mnemonic::Add => {
                let w = self.operand_width_bytes(instr, 0);
                self.read_op_i64(instr, 0, w);
                self.mask_i64(w);
                self.emit(WInst::LocalSet(LOCAL_I64_0));
                self.read_op_i64(instr, 1, w);
                self.mask_i64(w);
                self.emit(WInst::LocalSet(LOCAL_I64_1));

                self.emit(WInst::LocalGet(LOCAL_I64_0));
                self.emit(WInst::LocalGet(LOCAL_I64_1));
                self.emit(WInst::I64Add);
                self.mask_i64(w);
                self.emit(WInst::LocalTee(LOCAL_I64_2));
                self.write_op_i64(instr, 0, w);

                self.set_add_flags(LOCAL_I64_0, LOCAL_I64_1, LOCAL_I64_2, w, true, None);
            }
            Mnemonic::Adc => {
                let w = self.operand_width_bytes(instr, 0);
                self.read_op_i64(instr, 0, w);
                self.mask_i64(w);
                self.emit(WInst::LocalSet(LOCAL_I64_0));
                self.read_op_i64(instr, 1, w);
                self.mask_i64(w);
                self.emit(WInst::LocalSet(LOCAL_I64_1));

                // sum1 = a + b
                self.emit(WInst::LocalGet(LOCAL_I64_0));
                self.emit(WInst::LocalGet(LOCAL_I64_1));
                self.emit(WInst::I64Add);
                self.mask_i64(w);
                self.emit(WInst::LocalTee(LOCAL_I64_3));
                // cf1 = sum1 < a
                self.emit(WInst::LocalGet(LOCAL_I64_0));
                self.emit(WInst::I64LtU);
                self.emit(WInst::LocalSet(LOCAL_I32_0));

                // res = sum1 + cf
                self.emit(WInst::LocalGet(LOCAL_I64_3));
                self.emit(WInst::GlobalGet(GLOBAL_CF));
                self.emit(WInst::I64ExtendI32U);
                self.emit(WInst::I64Add);
                self.mask_i64(w);
                self.emit(WInst::LocalTee(LOCAL_I64_2));

                // cf2 = res < sum1
                self.emit(WInst::LocalGet(LOCAL_I64_3));
                self.emit(WInst::I64LtU);
                self.emit(WInst::LocalGet(LOCAL_I32_0));
                self.emit(WInst::I32Or);
                self.emit(WInst::LocalSet(LOCAL_I32_0));

                self.emit(WInst::LocalGet(LOCAL_I64_2));
                self.write_op_i64(instr, 0, w);
                self.set_add_flags(
                    LOCAL_I64_0,
                    LOCAL_I64_1,
                    LOCAL_I64_2,
                    w,
                    true,
                    Some(LOCAL_I32_0),
                );
            }
            Mnemonic::Sub | Mnemonic::Cmp => {
                let w = self.operand_width_bytes(instr, 0);
                let is_sub = instr.mnemonic() == Mnemonic::Sub;
                self.read_op_i64(instr, 0, w);
                self.mask_i64(w);
                self.emit(WInst::LocalSet(LOCAL_I64_0));
                self.read_op_i64(instr, 1, w);
                self.mask_i64(w);
                self.emit(WInst::LocalSet(LOCAL_I64_1));

                self.emit(WInst::LocalGet(LOCAL_I64_0));
                self.emit(WInst::LocalGet(LOCAL_I64_1));
                self.emit(WInst::I64Sub);
                self.mask_i64(w);
                self.emit(WInst::LocalSet(LOCAL_I64_2));

                if is_sub {
                    self.emit(WInst::LocalGet(LOCAL_I64_2));
                    self.write_op_i64(instr, 0, w);
                }
                self.set_sub_flags(LOCAL_I64_0, LOCAL_I64_1, LOCAL_I64_2, w, true, None);
            }
            Mnemonic::Sbb => {
                let w = self.operand_width_bytes(instr, 0);
                self.read_op_i64(instr, 0, w);
                self.mask_i64(w);
                self.emit(WInst::LocalSet(LOCAL_I64_0));
                self.read_op_i64(instr, 1, w);
                self.mask_i64(w);
                self.emit(WInst::LocalSet(LOCAL_I64_1));

                // diff1 = a - b
                self.emit(WInst::LocalGet(LOCAL_I64_0));
                self.emit(WInst::LocalGet(LOCAL_I64_1));
                self.emit(WInst::I64Sub);
                self.mask_i64(w);
                self.emit(WInst::LocalSet(LOCAL_I64_3));
                // cf1 = a < b
                self.emit(WInst::LocalGet(LOCAL_I64_0));
                self.emit(WInst::LocalGet(LOCAL_I64_1));
                self.emit(WInst::I64LtU);
                self.emit(WInst::LocalSet(LOCAL_I32_0));

                // res = diff1 - cf
                self.emit(WInst::LocalGet(LOCAL_I64_3));
                self.emit(WInst::GlobalGet(GLOBAL_CF));
                self.emit(WInst::I64ExtendI32U);
                self.emit(WInst::I64Sub);
                self.mask_i64(w);
                self.emit(WInst::LocalSet(LOCAL_I64_2));

                // cf2 = diff1 < cf
                self.emit(WInst::LocalGet(LOCAL_I64_3));
                self.emit(WInst::GlobalGet(GLOBAL_CF));
                self.emit(WInst::I64ExtendI32U);
                self.emit(WInst::I64LtU);
                self.emit(WInst::LocalGet(LOCAL_I32_0));
                self.emit(WInst::I32Or);
                self.emit(WInst::LocalSet(LOCAL_I32_0));

                self.emit(WInst::LocalGet(LOCAL_I64_2));
                self.write_op_i64(instr, 0, w);
                self.set_sub_flags(
                    LOCAL_I64_0,
                    LOCAL_I64_1,
                    LOCAL_I64_2,
                    w,
                    true,
                    Some(LOCAL_I32_0),
                );
            }
            Mnemonic::And | Mnemonic::Test => {
                let w = self.operand_width_bytes(instr, 0);
                let is_and = instr.mnemonic() == Mnemonic::And;
                self.read_op_i64(instr, 0, w);
                self.mask_i64(w);
                self.read_op_i64(instr, 1, w);
                self.mask_i64(w);
                self.emit(WInst::I64And);
                self.emit(WInst::LocalSet(LOCAL_I64_2));
                if is_and {
                    self.emit(WInst::LocalGet(LOCAL_I64_2));
                    self.write_op_i64(instr, 0, w);
                }
                self.set_logic_flags(LOCAL_I64_2, w);
            }
            Mnemonic::Or => {
                let w = self.operand_width_bytes(instr, 0);
                self.read_op_i64(instr, 0, w);
                self.mask_i64(w);
                self.read_op_i64(instr, 1, w);
                self.mask_i64(w);
                self.emit(WInst::I64Or);
                self.emit(WInst::LocalSet(LOCAL_I64_2));
                self.emit(WInst::LocalGet(LOCAL_I64_2));
                self.write_op_i64(instr, 0, w);
                self.set_logic_flags(LOCAL_I64_2, w);
            }
            Mnemonic::Xor => {
                let w = self.operand_width_bytes(instr, 0);
                self.read_op_i64(instr, 0, w);
                self.mask_i64(w);
                self.read_op_i64(instr, 1, w);
                self.mask_i64(w);
                self.emit(WInst::I64Xor);
                self.emit(WInst::LocalSet(LOCAL_I64_2));
                self.emit(WInst::LocalGet(LOCAL_I64_2));
                self.write_op_i64(instr, 0, w);
                self.set_logic_flags(LOCAL_I64_2, w);
            }
            Mnemonic::Not => {
                let w = self.operand_width_bytes(instr, 0);
                self.read_op_i64(instr, 0, w);
                self.emit(WInst::I64Const(-1));
                self.emit(WInst::I64Xor);
                self.mask_i64(w);
                self.write_op_i64(instr, 0, w);
            }
            Mnemonic::Neg => {
                let w = self.operand_width_bytes(instr, 0);
                self.emit(WInst::I64Const(0));
                self.emit(WInst::LocalSet(LOCAL_I64_0));
                self.read_op_i64(instr, 0, w);
                self.mask_i64(w);
                self.emit(WInst::LocalSet(LOCAL_I64_1));

                self.emit(WInst::I64Const(0));
                self.emit(WInst::LocalGet(LOCAL_I64_1));
                self.emit(WInst::I64Sub);
                self.mask_i64(w);
                self.emit(WInst::LocalTee(LOCAL_I64_2));
                self.write_op_i64(instr, 0, w);

                self.set_sub_flags(LOCAL_I64_0, LOCAL_I64_1, LOCAL_I64_2, w, true, None);
            }
            Mnemonic::Inc => {
                let w = self.operand_width_bytes(instr, 0);
                self.read_op_i64(instr, 0, w);
                self.mask_i64(w);
                self.emit(WInst::LocalSet(LOCAL_I64_0));
                self.emit(WInst::I64Const(1));
                self.emit(WInst::LocalSet(LOCAL_I64_1));

                self.emit(WInst::LocalGet(LOCAL_I64_0));
                self.emit(WInst::I64Const(1));
                self.emit(WInst::I64Add);
                self.mask_i64(w);
                self.emit(WInst::LocalTee(LOCAL_I64_2));
                self.write_op_i64(instr, 0, w);

                // Preserves CF!
                self.set_add_flags(LOCAL_I64_0, LOCAL_I64_1, LOCAL_I64_2, w, false, None);
            }
            Mnemonic::Dec => {
                let w = self.operand_width_bytes(instr, 0);
                self.read_op_i64(instr, 0, w);
                self.mask_i64(w);
                self.emit(WInst::LocalSet(LOCAL_I64_0));
                self.emit(WInst::I64Const(1));
                self.emit(WInst::LocalSet(LOCAL_I64_1));

                self.emit(WInst::LocalGet(LOCAL_I64_0));
                self.emit(WInst::I64Const(1));
                self.emit(WInst::I64Sub);
                self.mask_i64(w);
                self.emit(WInst::LocalTee(LOCAL_I64_2));
                self.write_op_i64(instr, 0, w);

                // Preserves CF!
                self.set_sub_flags(LOCAL_I64_0, LOCAL_I64_1, LOCAL_I64_2, w, false, None);
            }
            Mnemonic::Cmpxchg => {
                let w = self.operand_width_bytes(instr, 0);
                let acc = match w {
                    1 => Register::AL,
                    2 => Register::AX,
                    4 => Register::EAX,
                    _ => Register::RAX,
                };
                self.read_gpr(acc);
                self.mask_i64(w);
                self.emit(WInst::LocalSet(LOCAL_I64_0)); // acc
                self.read_op_i64(instr, 0, w);
                self.mask_i64(w);
                self.emit(WInst::LocalSet(LOCAL_I64_1)); // dst

                // Flags = cmp(acc, dst)
                self.emit(WInst::LocalGet(LOCAL_I64_0));
                self.emit(WInst::LocalGet(LOCAL_I64_1));
                self.emit(WInst::I64Sub);
                self.mask_i64(w);
                self.emit(WInst::LocalSet(LOCAL_I64_2));
                self.set_sub_flags(LOCAL_I64_0, LOCAL_I64_1, LOCAL_I64_2, w, true, None);

                // if acc == dst { dst = src } else { acc = dst }
                self.emit(WInst::GlobalGet(GLOBAL_ZF));
                self.emit(WInst::If(BlockType::Empty));
                {
                    self.read_op_i64(instr, 1, w);
                    self.write_op_i64(instr, 0, w);
                }
                self.emit(WInst::Else);
                {
                    self.emit(WInst::LocalGet(LOCAL_I64_1));
                    self.write_gpr(acc);
                }
                self.emit(WInst::End);
            }
            Mnemonic::Xadd => {
                let w = self.operand_width_bytes(instr, 0);
                self.read_op_i64(instr, 0, w);
                self.mask_i64(w);
                self.emit(WInst::LocalSet(LOCAL_I64_0)); // dst
                self.read_op_i64(instr, 1, w);
                self.mask_i64(w);
                self.emit(WInst::LocalSet(LOCAL_I64_1)); // src

                self.emit(WInst::LocalGet(LOCAL_I64_0));
                self.emit(WInst::LocalGet(LOCAL_I64_1));
                self.emit(WInst::I64Add);
                self.mask_i64(w);
                self.emit(WInst::LocalSet(LOCAL_I64_2)); // sum

                // src = old dst; dst = sum
                self.emit(WInst::LocalGet(LOCAL_I64_0));
                self.write_op_i64(instr, 1, w);
                self.emit(WInst::LocalGet(LOCAL_I64_2));
                self.write_op_i64(instr, 0, w);

                self.set_add_flags(LOCAL_I64_0, LOCAL_I64_1, LOCAL_I64_2, w, true, None);
            }
            Mnemonic::Mul => {
                let w = self.operand_width_bytes(instr, 0);
                self.lift_mul(instr, w);
            }
            Mnemonic::Imul => {
                self.lift_imul(instr);
            }
            Mnemonic::Div => {
                let w = self.operand_width_bytes(instr, 0);
                self.lift_div(instr, w, false);
            }
            Mnemonic::Idiv => {
                let w = self.operand_width_bytes(instr, 0);
                self.lift_div(instr, w, true);
            }

            // ----------------------------------------------------------------
            // Bit, Shift & Rotate
            // ----------------------------------------------------------------
            Mnemonic::Shl | Mnemonic::Sal => {
                self.lift_shift(instr, ShiftKind::Shl);
            }
            Mnemonic::Shr => {
                self.lift_shift(instr, ShiftKind::Shr);
            }
            Mnemonic::Sar => {
                self.lift_shift(instr, ShiftKind::Sar);
            }
            Mnemonic::Rol => {
                self.lift_rotate(instr, true);
            }
            Mnemonic::Ror => {
                self.lift_rotate(instr, false);
            }
            Mnemonic::Shld => {
                self.lift_double_shift(instr, true);
            }
            Mnemonic::Shrd => {
                self.lift_double_shift(instr, false);
            }
            Mnemonic::Bt | Mnemonic::Bts | Mnemonic::Btr | Mnemonic::Btc => {
                self.lift_bt(instr);
            }
            Mnemonic::Bsf | Mnemonic::Bsr | Mnemonic::Tzcnt | Mnemonic::Lzcnt => {
                self.lift_bitscan(instr);
            }
            Mnemonic::Popcnt => {
                let w = self.operand_width_bytes(instr, 0);
                self.read_op_i64(instr, 1, w);
                self.mask_i64(w);
                self.emit(WInst::I64Popcnt);
                self.emit(WInst::LocalTee(LOCAL_I64_0));
                self.write_op_i64(instr, 0, w);
                self.emit(WInst::LocalGet(LOCAL_I64_0));
                self.emit(WInst::I64Eqz);
                self.emit(WInst::GlobalSet(GLOBAL_ZF));
                self.emit(WInst::I32Const(0));
                self.emit(WInst::GlobalSet(GLOBAL_CF));
                self.emit(WInst::I32Const(0));
                self.emit(WInst::GlobalSet(GLOBAL_OF));
                self.emit(WInst::I32Const(0));
                self.emit(WInst::GlobalSet(GLOBAL_SF));
                self.emit(WInst::I32Const(0));
                self.emit(WInst::GlobalSet(GLOBAL_PF));
                self.emit(WInst::I32Const(0));
                self.emit(WInst::GlobalSet(GLOBAL_AF));
            }

            // ----------------------------------------------------------------
            // String & Direction Flag
            // ----------------------------------------------------------------
            Mnemonic::Cld => {
                self.emit(WInst::I32Const(0));
                self.emit(WInst::GlobalSet(GLOBAL_DF));
            }
            Mnemonic::Std => {
                self.emit(WInst::I32Const(1));
                self.emit(WInst::GlobalSet(GLOBAL_DF));
            }
            Mnemonic::Movsb => self.lift_rep_movs(instr, 1),
            Mnemonic::Movsw => self.lift_rep_movs(instr, 2),
            Mnemonic::Movsq => self.lift_rep_movs(instr, 8),
            Mnemonic::Stosb => self.lift_rep_stos(instr, 1),
            Mnemonic::Stosw => self.lift_rep_stos(instr, 2),
            Mnemonic::Stosd => self.lift_rep_stos(instr, 4),
            Mnemonic::Stosq => self.lift_rep_stos(instr, 8),
            Mnemonic::Scasb => self.lift_rep_scas(instr, 1),
            Mnemonic::Scasw => self.lift_rep_scas(instr, 2),
            Mnemonic::Scasd => self.lift_rep_scas(instr, 4),
            Mnemonic::Scasq => self.lift_rep_scas(instr, 8),
            Mnemonic::Cmpsb => self.lift_rep_cmps(instr, 1),
            Mnemonic::Cmpsw => self.lift_rep_cmps(instr, 2),
            Mnemonic::Cmpsd => {
                if matches!(
                    instr.op0_kind(),
                    OpKind::MemorySegRSI
                        | OpKind::MemorySegESI
                        | OpKind::MemorySegSI
                        | OpKind::MemoryESRDI
                        | OpKind::MemoryESEDI
                        | OpKind::MemoryESDI
                        | OpKind::MemorySegDI
                ) || matches!(
                    instr.op1_kind(),
                    OpKind::MemorySegRSI
                        | OpKind::MemorySegESI
                        | OpKind::MemorySegSI
                        | OpKind::MemoryESRDI
                        | OpKind::MemoryESEDI
                        | OpKind::MemoryESDI
                        | OpKind::MemorySegDI
                ) {
                    self.lift_rep_cmps(instr, 4);
                } else if !self.lift_sse(instr) {
                    self.emit(WInst::Unreachable);
                }
            }
            Mnemonic::Cmpsq => self.lift_rep_cmps(instr, 8),

            // ----------------------------------------------------------------
            // System / Misc
            // ----------------------------------------------------------------
            Mnemonic::Syscall => {
                // rcx = next_ip; r11 = rflags; rax = env.syscall(rax, rdi, rsi, rdx, r10, r8, r9)
                self.emit(WInst::I64Const(instr.next_ip() as u32 as u64 as i64));
                self.emit(WInst::GlobalSet(GLOBAL_RCX));
                self.emit_pack_rflags();
                self.emit(WInst::GlobalSet(GLOBAL_R11));

                self.emit(WInst::GlobalGet(GLOBAL_RAX));
                self.emit(WInst::GlobalGet(GLOBAL_RDI));
                self.emit(WInst::GlobalGet(GLOBAL_RSI));
                self.emit(WInst::GlobalGet(GLOBAL_RDX));
                self.emit(WInst::GlobalGet(GLOBAL_R10));
                self.emit(WInst::GlobalGet(GLOBAL_R8));
                self.emit(WInst::GlobalGet(GLOBAL_R9));
                self.emit(WInst::Call(FN_IMPORT_SYSCALL));
                self.emit(WInst::GlobalSet(GLOBAL_RAX));
                self.emit(WInst::GlobalGet(GLOBAL_EXIT_FLAG));
                self.emit(WInst::If(BlockType::Empty));
                self.emit(WInst::Return);
                self.emit(WInst::End);

                self.emit(WInst::GlobalGet(GLOBAL_YIELD_FLAG));
                self.emit(WInst::If(BlockType::Empty));
                self.emit(WInst::I64Const(instr.next_ip() as u32 as u64 as i64));
                self.emit(WInst::GlobalSet(GLOBAL_RIP));
                self.emit(WInst::Return);
                self.emit(WInst::End);
            }
            Mnemonic::Rdtsc => {
                self.emit(WInst::GlobalGet(GLOBAL_TSC));
                self.emit(WInst::I64Const(100));
                self.emit(WInst::I64Add);
                self.emit(WInst::GlobalSet(GLOBAL_TSC));

                self.emit(WInst::GlobalGet(GLOBAL_TSC));
                self.emit(WInst::I64Const(0xFFFF_FFFF));
                self.emit(WInst::I64And);
                self.emit(WInst::GlobalSet(GLOBAL_RAX));

                self.emit(WInst::GlobalGet(GLOBAL_TSC));
                self.emit(WInst::I64Const(32));
                self.emit(WInst::I64ShrU);
                self.emit(WInst::GlobalSet(GLOBAL_RDX));
            }
            Mnemonic::Cpuid => {
                self.lift_cpuid();
            }
            Mnemonic::Xgetbv => {
                self.emit(WInst::I64Const(3));
                self.emit(WInst::GlobalSet(GLOBAL_RAX));
                self.emit(WInst::I64Const(0));
                self.emit(WInst::GlobalSet(GLOBAL_RDX));
            }
            Mnemonic::Stmxcsr => {
                self.compute_ea_i32(instr);
                self.emit(WInst::GlobalGet(GLOBAL_MXCSR));
                self.emit(WInst::I32Store(memarg(0, 0)));
            }
            Mnemonic::Ldmxcsr => {
                self.compute_ea_i32(instr);
                self.emit(WInst::I32Load(memarg(0, 0)));
                self.emit(WInst::GlobalSet(GLOBAL_MXCSR));
            }
            Mnemonic::Fnstcw | Mnemonic::Fstcw => {
                self.compute_ea_i32(instr);
                self.emit(WInst::GlobalGet(GLOBAL_X87_CW));
                self.emit(WInst::I32Store16(memarg(0, 0)));
            }
            Mnemonic::Fldcw => {
                self.compute_ea_i32(instr);
                self.emit(WInst::I32Load16U(memarg(0, 0)));
                self.emit(WInst::GlobalSet(GLOBAL_X87_CW));
            }
            Mnemonic::Fxsave | Mnemonic::Fxsave64 => {
                self.compute_ea_i32(instr);
                self.emit(WInst::LocalSet(LOCAL_I32_7));
                // FCW
                self.emit(WInst::LocalGet(LOCAL_I32_7));
                self.emit(WInst::GlobalGet(GLOBAL_X87_CW));
                self.emit(WInst::I32Store16(memarg(0, 0)));
                // MXCSR at +24, MXCSR_MASK at +28
                self.emit(WInst::LocalGet(LOCAL_I32_7));
                self.emit(WInst::GlobalGet(GLOBAL_MXCSR));
                self.emit(WInst::I32Store(memarg(24, 0)));
                self.emit(WInst::LocalGet(LOCAL_I32_7));
                self.emit(WInst::I32Const(0xFFFF));
                self.emit(WInst::I32Store(memarg(28, 0)));
                // XMM0..XMM15 at +160..+416
                for i in 0..16u32 {
                    self.emit(WInst::LocalGet(LOCAL_I32_7));
                    self.emit(WInst::GlobalGet(GLOBAL_XMM_BASE + i));
                    self.emit(WInst::V128Store(memarg(160 + (i as u64) * 16, 0)));
                }
            }
            Mnemonic::Fxrstor | Mnemonic::Fxrstor64 => {
                self.compute_ea_i32(instr);
                self.emit(WInst::LocalSet(LOCAL_I32_7));
                self.emit(WInst::LocalGet(LOCAL_I32_7));
                self.emit(WInst::I32Load16U(memarg(0, 0)));
                self.emit(WInst::GlobalSet(GLOBAL_X87_CW));
                self.emit(WInst::LocalGet(LOCAL_I32_7));
                self.emit(WInst::I32Load(memarg(24, 0)));
                self.emit(WInst::GlobalSet(GLOBAL_MXCSR));
                for i in 0..16u32 {
                    self.emit(WInst::LocalGet(LOCAL_I32_7));
                    self.emit(WInst::V128Load(memarg(160 + (i as u64) * 16, 0)));
                    self.emit(WInst::GlobalSet(GLOBAL_XMM_BASE + i));
                }
            }

            // ----------------------------------------------------------------
            // Movsd (disambiguate string vs SSE2)
            // ----------------------------------------------------------------
            Mnemonic::Movsd => {
                if matches!(
                    instr.op0_kind(),
                    OpKind::MemoryESRDI
                        | OpKind::MemoryESEDI
                        | OpKind::MemoryESDI
                        | OpKind::MemorySegDI
                        | OpKind::MemorySegRSI
                        | OpKind::MemorySegESI
                        | OpKind::MemorySegSI
                ) || matches!(
                    instr.op1_kind(),
                    OpKind::MemoryESRDI
                        | OpKind::MemoryESEDI
                        | OpKind::MemoryESDI
                        | OpKind::MemorySegDI
                        | OpKind::MemorySegRSI
                        | OpKind::MemorySegESI
                        | OpKind::MemorySegSI
                ) {
                    self.lift_rep_movs(instr, 4);
                } else if !self.lift_sse(instr) {
                    self.emit(WInst::Unreachable);
                }
            }

            // ----------------------------------------------------------------
            // SSE / SSE2
            // ----------------------------------------------------------------
            _ => {
                if !self.lift_sse(instr) {
                    // Rare/VEX/EVEX/x87 unimplemented opcodes: emit trap at runtime.
                    self.emit(WInst::Unreachable);
                }
            }
        }
    }

    // ------------------------------------------------------------------------
    // Mul / Imul / Div / Idiv
    // ------------------------------------------------------------------------

    fn lift_mul(&mut self, instr: &X86Inst, w: u32) {
        self.read_op_i64(instr, 0, w);
        self.mask_i64(w);
        self.emit(WInst::LocalSet(LOCAL_I64_1));
        match w {
            1 => {
                self.read_gpr(Register::AL);
                self.emit(WInst::LocalGet(LOCAL_I64_1));
                self.emit(WInst::I64Mul);
                self.emit(WInst::LocalTee(LOCAL_I64_2));
                self.write_gpr(Register::AX);

                self.emit(WInst::LocalGet(LOCAL_I64_2));
                self.emit(WInst::I64Const(8));
                self.emit(WInst::I64ShrU);
                self.emit(WInst::I64Const(0));
                self.emit(WInst::I64Ne);
                self.emit(WInst::LocalTee(LOCAL_I32_0));
                self.emit(WInst::GlobalSet(GLOBAL_CF));
                self.emit(WInst::LocalGet(LOCAL_I32_0));
                self.emit(WInst::GlobalSet(GLOBAL_OF));
            }
            2 => {
                self.read_gpr(Register::AX);
                self.emit(WInst::LocalGet(LOCAL_I64_1));
                self.emit(WInst::I64Mul);
                self.emit(WInst::LocalTee(LOCAL_I64_2));
                self.write_gpr(Register::AX);
                self.emit(WInst::LocalGet(LOCAL_I64_2));
                self.emit(WInst::I64Const(16));
                self.emit(WInst::I64ShrU);
                self.emit(WInst::LocalTee(LOCAL_I64_3));
                self.write_gpr(Register::DX);

                self.emit(WInst::LocalGet(LOCAL_I64_3));
                self.emit(WInst::I64Const(0));
                self.emit(WInst::I64Ne);
                self.emit(WInst::LocalTee(LOCAL_I32_0));
                self.emit(WInst::GlobalSet(GLOBAL_CF));
                self.emit(WInst::LocalGet(LOCAL_I32_0));
                self.emit(WInst::GlobalSet(GLOBAL_OF));
            }
            4 => {
                self.read_gpr(Register::EAX);
                self.emit(WInst::LocalGet(LOCAL_I64_1));
                self.emit(WInst::I64Mul);
                self.emit(WInst::LocalTee(LOCAL_I64_2));
                self.write_gpr(Register::EAX);
                self.emit(WInst::LocalGet(LOCAL_I64_2));
                self.emit(WInst::I64Const(32));
                self.emit(WInst::I64ShrU);
                self.emit(WInst::LocalTee(LOCAL_I64_3));
                self.write_gpr(Register::EDX);

                self.emit(WInst::LocalGet(LOCAL_I64_3));
                self.emit(WInst::I64Const(0));
                self.emit(WInst::I64Ne);
                self.emit(WInst::LocalTee(LOCAL_I32_0));
                self.emit(WInst::GlobalSet(GLOBAL_CF));
                self.emit(WInst::LocalGet(LOCAL_I32_0));
                self.emit(WInst::GlobalSet(GLOBAL_OF));
            }
            _ => {
                self.emit(WInst::GlobalGet(GLOBAL_RAX));
                self.emit(WInst::LocalSet(LOCAL_I64_0));
                self.emit_umul128(LOCAL_I64_0, LOCAL_I64_1, LOCAL_I64_2, LOCAL_I64_3);
                self.emit(WInst::LocalGet(LOCAL_I64_2));
                self.emit(WInst::GlobalSet(GLOBAL_RAX));
                self.emit(WInst::LocalGet(LOCAL_I64_3));
                self.emit(WInst::GlobalSet(GLOBAL_RDX));

                self.emit(WInst::LocalGet(LOCAL_I64_3));
                self.emit(WInst::I64Const(0));
                self.emit(WInst::I64Ne);
                self.emit(WInst::LocalTee(LOCAL_I32_0));
                self.emit(WInst::GlobalSet(GLOBAL_CF));
                self.emit(WInst::LocalGet(LOCAL_I32_0));
                self.emit(WInst::GlobalSet(GLOBAL_OF));
            }
        }
    }

    fn lift_imul(&mut self, instr: &X86Inst) {
        let count = instr.op_count();
        if count == 1 {
            let w = self.operand_width_bytes(instr, 0);
            self.read_op_i64(instr, 0, w);
            self.sext_i64(w);
            self.emit(WInst::LocalSet(LOCAL_I64_1));
            match w {
                1 => {
                    self.read_gpr(Register::AL);
                    self.emit(WInst::I64Extend8S);
                    self.emit(WInst::LocalGet(LOCAL_I64_1));
                    self.emit(WInst::I64Mul);
                    self.emit(WInst::LocalTee(LOCAL_I64_2));
                    self.write_gpr(Register::AX);

                    // CF = OF = (sext8(res) != res)
                    self.emit(WInst::LocalGet(LOCAL_I64_2));
                    self.emit(WInst::I64Extend8S);
                    self.emit(WInst::LocalGet(LOCAL_I64_2));
                    self.emit(WInst::I64Ne);
                    self.emit(WInst::LocalTee(LOCAL_I32_0));
                    self.emit(WInst::GlobalSet(GLOBAL_CF));
                    self.emit(WInst::LocalGet(LOCAL_I32_0));
                    self.emit(WInst::GlobalSet(GLOBAL_OF));
                }
                2 => {
                    self.read_gpr(Register::AX);
                    self.emit(WInst::I64Extend16S);
                    self.emit(WInst::LocalGet(LOCAL_I64_1));
                    self.emit(WInst::I64Mul);
                    self.emit(WInst::LocalTee(LOCAL_I64_2));
                    self.write_gpr(Register::AX);
                    self.emit(WInst::LocalGet(LOCAL_I64_2));
                    self.emit(WInst::I64Const(16));
                    self.emit(WInst::I64ShrS);
                    self.write_gpr(Register::DX);

                    self.emit(WInst::LocalGet(LOCAL_I64_2));
                    self.emit(WInst::I64Extend16S);
                    self.emit(WInst::LocalGet(LOCAL_I64_2));
                    self.emit(WInst::I64Ne);
                    self.emit(WInst::LocalTee(LOCAL_I32_0));
                    self.emit(WInst::GlobalSet(GLOBAL_CF));
                    self.emit(WInst::LocalGet(LOCAL_I32_0));
                    self.emit(WInst::GlobalSet(GLOBAL_OF));
                }
                4 => {
                    self.read_gpr(Register::EAX);
                    self.emit(WInst::I64Extend32S);
                    self.emit(WInst::LocalGet(LOCAL_I64_1));
                    self.emit(WInst::I64Mul);
                    self.emit(WInst::LocalTee(LOCAL_I64_2));
                    self.write_gpr(Register::EAX);
                    self.emit(WInst::LocalGet(LOCAL_I64_2));
                    self.emit(WInst::I64Const(32));
                    self.emit(WInst::I64ShrS);
                    self.write_gpr(Register::EDX);

                    self.emit(WInst::LocalGet(LOCAL_I64_2));
                    self.emit(WInst::I64Extend32S);
                    self.emit(WInst::LocalGet(LOCAL_I64_2));
                    self.emit(WInst::I64Ne);
                    self.emit(WInst::LocalTee(LOCAL_I32_0));
                    self.emit(WInst::GlobalSet(GLOBAL_CF));
                    self.emit(WInst::LocalGet(LOCAL_I32_0));
                    self.emit(WInst::GlobalSet(GLOBAL_OF));
                }
                _ => {
                    self.emit(WInst::GlobalGet(GLOBAL_RAX));
                    self.emit(WInst::LocalSet(LOCAL_I64_0));
                    self.emit_umul128(LOCAL_I64_0, LOCAL_I64_1, LOCAL_I64_2, LOCAL_I64_3);
                    // Signed correction: if a < 0 { hi -= b } if b < 0 { hi -= a }
                    self.emit(WInst::LocalGet(LOCAL_I64_0));
                    self.emit(WInst::I64Const(0));
                    self.emit(WInst::I64LtS);
                    self.emit(WInst::If(BlockType::Empty));
                    self.emit(WInst::LocalGet(LOCAL_I64_3));
                    self.emit(WInst::LocalGet(LOCAL_I64_1));
                    self.emit(WInst::I64Sub);
                    self.emit(WInst::LocalSet(LOCAL_I64_3));
                    self.emit(WInst::End);

                    self.emit(WInst::LocalGet(LOCAL_I64_1));
                    self.emit(WInst::I64Const(0));
                    self.emit(WInst::I64LtS);
                    self.emit(WInst::If(BlockType::Empty));
                    self.emit(WInst::LocalGet(LOCAL_I64_3));
                    self.emit(WInst::LocalGet(LOCAL_I64_0));
                    self.emit(WInst::I64Sub);
                    self.emit(WInst::LocalSet(LOCAL_I64_3));
                    self.emit(WInst::End);

                    self.emit(WInst::LocalGet(LOCAL_I64_2));
                    self.emit(WInst::GlobalSet(GLOBAL_RAX));
                    self.emit(WInst::LocalGet(LOCAL_I64_3));
                    self.emit(WInst::GlobalSet(GLOBAL_RDX));

                    // CF = OF = (hi != (lo >> 63))
                    self.emit(WInst::LocalGet(LOCAL_I64_3));
                    self.emit(WInst::LocalGet(LOCAL_I64_2));
                    self.emit(WInst::I64Const(63));
                    self.emit(WInst::I64ShrS);
                    self.emit(WInst::I64Ne);
                    self.emit(WInst::LocalTee(LOCAL_I32_0));
                    self.emit(WInst::GlobalSet(GLOBAL_CF));
                    self.emit(WInst::LocalGet(LOCAL_I32_0));
                    self.emit(WInst::GlobalSet(GLOBAL_OF));
                }
            }
            return;
        }

        // 2-op or 3-op imul
        let w = self.operand_width_bytes(instr, 0);
        if count == 2 {
            self.read_op_i64(instr, 0, w);
            self.sext_i64(w);
            self.emit(WInst::LocalSet(LOCAL_I64_0));
            self.read_op_i64(instr, 1, w);
            self.sext_i64(w);
            self.emit(WInst::LocalSet(LOCAL_I64_1));
        } else {
            self.read_op_i64(instr, 1, w);
            self.sext_i64(w);
            self.emit(WInst::LocalSet(LOCAL_I64_0));
            self.read_op_i64(instr, 2, w);
            self.sext_i64(w);
            self.emit(WInst::LocalSet(LOCAL_I64_1));
        }

        if w < 8 {
            self.emit(WInst::LocalGet(LOCAL_I64_0));
            self.emit(WInst::LocalGet(LOCAL_I64_1));
            self.emit(WInst::I64Mul);
            self.emit(WInst::LocalTee(LOCAL_I64_2));
            self.write_op_i64(instr, 0, w);

            self.emit(WInst::LocalGet(LOCAL_I64_2));
            self.sext_i64(w);
            self.emit(WInst::LocalGet(LOCAL_I64_2));
            self.emit(WInst::I64Ne);
            self.emit(WInst::LocalTee(LOCAL_I32_0));
            self.emit(WInst::GlobalSet(GLOBAL_CF));
            self.emit(WInst::LocalGet(LOCAL_I32_0));
            self.emit(WInst::GlobalSet(GLOBAL_OF));
        } else {
            self.emit_umul128(LOCAL_I64_0, LOCAL_I64_1, LOCAL_I64_2, LOCAL_I64_3);
            self.emit(WInst::LocalGet(LOCAL_I64_0));
            self.emit(WInst::I64Const(0));
            self.emit(WInst::I64LtS);
            self.emit(WInst::If(BlockType::Empty));
            self.emit(WInst::LocalGet(LOCAL_I64_3));
            self.emit(WInst::LocalGet(LOCAL_I64_1));
            self.emit(WInst::I64Sub);
            self.emit(WInst::LocalSet(LOCAL_I64_3));
            self.emit(WInst::End);

            self.emit(WInst::LocalGet(LOCAL_I64_1));
            self.emit(WInst::I64Const(0));
            self.emit(WInst::I64LtS);
            self.emit(WInst::If(BlockType::Empty));
            self.emit(WInst::LocalGet(LOCAL_I64_3));
            self.emit(WInst::LocalGet(LOCAL_I64_0));
            self.emit(WInst::I64Sub);
            self.emit(WInst::LocalSet(LOCAL_I64_3));
            self.emit(WInst::End);

            self.emit(WInst::LocalGet(LOCAL_I64_2));
            self.write_op_i64(instr, 0, 8);

            self.emit(WInst::LocalGet(LOCAL_I64_3));
            self.emit(WInst::LocalGet(LOCAL_I64_2));
            self.emit(WInst::I64Const(63));
            self.emit(WInst::I64ShrS);
            self.emit(WInst::I64Ne);
            self.emit(WInst::LocalTee(LOCAL_I32_0));
            self.emit(WInst::GlobalSet(GLOBAL_CF));
            self.emit(WInst::LocalGet(LOCAL_I32_0));
            self.emit(WInst::GlobalSet(GLOBAL_OF));
        }
    }

    fn lift_div(&mut self, instr: &X86Inst, w: u32, signed: bool) {
        self.read_op_i64(instr, 0, w);
        if signed {
            self.sext_i64(w);
        } else {
            self.mask_i64(w);
        }
        self.emit(WInst::LocalSet(LOCAL_I64_2)); // divisor

        match w {
            1 => {
                self.read_gpr(Register::AX);
                if signed {
                    self.emit(WInst::I64Extend16S);
                }
                self.emit(WInst::LocalSet(LOCAL_I64_0));
                self.emit(WInst::LocalGet(LOCAL_I64_0));
                self.emit(WInst::LocalGet(LOCAL_I64_2));
                self.emit(if signed { WInst::I64DivS } else { WInst::I64DivU });
                self.write_gpr(Register::AL);

                self.emit(WInst::LocalGet(LOCAL_I64_0));
                self.emit(WInst::LocalGet(LOCAL_I64_2));
                self.emit(if signed { WInst::I64RemS } else { WInst::I64RemU });
                self.write_gpr(Register::AH);
            }
            2 => {
                self.read_gpr(Register::DX);
                self.emit(WInst::I64Const(16));
                self.emit(WInst::I64Shl);
                self.read_gpr(Register::AX);
                self.emit(WInst::I64Or);
                if signed {
                    self.emit(WInst::I64Extend32S);
                }
                self.emit(WInst::LocalSet(LOCAL_I64_0));

                self.emit(WInst::LocalGet(LOCAL_I64_0));
                self.emit(WInst::LocalGet(LOCAL_I64_2));
                self.emit(if signed { WInst::I64DivS } else { WInst::I64DivU });
                self.write_gpr(Register::AX);

                self.emit(WInst::LocalGet(LOCAL_I64_0));
                self.emit(WInst::LocalGet(LOCAL_I64_2));
                self.emit(if signed { WInst::I64RemS } else { WInst::I64RemU });
                self.write_gpr(Register::DX);
            }
            4 => {
                self.read_gpr(Register::EDX);
                self.emit(WInst::I64Const(32));
                self.emit(WInst::I64Shl);
                self.read_gpr(Register::EAX);
                self.emit(WInst::I64Or);
                self.emit(WInst::LocalSet(LOCAL_I64_0));

                self.emit(WInst::LocalGet(LOCAL_I64_0));
                self.emit(WInst::LocalGet(LOCAL_I64_2));
                self.emit(if signed { WInst::I64DivS } else { WInst::I64DivU });
                self.write_gpr(Register::EAX);

                self.emit(WInst::LocalGet(LOCAL_I64_0));
                self.emit(WInst::LocalGet(LOCAL_I64_2));
                self.emit(if signed { WInst::I64RemS } else { WInst::I64RemU });
                self.write_gpr(Register::EDX);
            }
            _ => {
                self.emit(WInst::GlobalGet(GLOBAL_RAX));
                self.emit(WInst::LocalSet(LOCAL_I64_0));
                self.emit(WInst::GlobalGet(GLOBAL_RDX));
                self.emit(WInst::LocalSet(LOCAL_I64_1));
                if !signed {
                    self.emit_udiv128_64();
                    self.emit(WInst::LocalGet(LOCAL_I64_3));
                    self.emit(WInst::GlobalSet(GLOBAL_RAX));
                    self.emit(WInst::LocalGet(LOCAL_I64_1));
                    self.emit(WInst::GlobalSet(GLOBAL_RDX));
                } else {
                    // Signed 128-by-64:
                    // Fast path: rdx == (rax >> 63)
                    self.emit(WInst::LocalGet(LOCAL_I64_1));
                    self.emit(WInst::LocalGet(LOCAL_I64_0));
                    self.emit(WInst::I64Const(63));
                    self.emit(WInst::I64ShrS);
                    self.emit(WInst::I64Eq);
                    self.emit(WInst::If(BlockType::Empty));
                    {
                        self.emit(WInst::LocalGet(LOCAL_I64_0));
                        self.emit(WInst::LocalGet(LOCAL_I64_2));
                        self.emit(WInst::I64DivS);
                        self.emit(WInst::GlobalSet(GLOBAL_RAX));

                        self.emit(WInst::LocalGet(LOCAL_I64_0));
                        self.emit(WInst::LocalGet(LOCAL_I64_2));
                        self.emit(WInst::I64RemS);
                        self.emit(WInst::GlobalSet(GLOBAL_RDX));
                    }
                    self.emit(WInst::Else);
                    {
                        // neg_num = (hi < 0) -> LOCAL_I32_1
                        self.emit(WInst::LocalGet(LOCAL_I64_1));
                        self.emit(WInst::I64Const(0));
                        self.emit(WInst::I64LtS);
                        self.emit(WInst::LocalTee(LOCAL_I32_1));
                        self.emit(WInst::If(BlockType::Empty));
                        {
                            // negate 128-bit (hi, lo): lo = -lo; hi = ~hi + (lo == 0 ? 1 : 0)
                            self.emit(WInst::I64Const(0));
                            self.emit(WInst::LocalGet(LOCAL_I64_0));
                            self.emit(WInst::I64Sub);
                            self.emit(WInst::LocalSet(LOCAL_I64_0));

                            self.emit(WInst::LocalGet(LOCAL_I64_1));
                            self.emit(WInst::I64Const(-1));
                            self.emit(WInst::I64Xor);
                            self.emit(WInst::LocalGet(LOCAL_I64_0));
                            self.emit(WInst::I64Eqz);
                            self.emit(WInst::I64ExtendI32U);
                            self.emit(WInst::I64Add);
                            self.emit(WInst::LocalSet(LOCAL_I64_1));
                        }
                        self.emit(WInst::End);

                        // neg_div = (divisor < 0) -> LOCAL_I32_2
                        self.emit(WInst::LocalGet(LOCAL_I64_2));
                        self.emit(WInst::I64Const(0));
                        self.emit(WInst::I64LtS);
                        self.emit(WInst::LocalTee(LOCAL_I32_2));
                        self.emit(WInst::If(BlockType::Empty));
                        {
                            self.emit(WInst::I64Const(0));
                            self.emit(WInst::LocalGet(LOCAL_I64_2));
                            self.emit(WInst::I64Sub);
                            self.emit(WInst::LocalSet(LOCAL_I64_2));
                        }
                        self.emit(WInst::End);

                        self.emit_udiv128_64();

                        // if neg_num ^ neg_div { q = -q }
                        self.emit(WInst::LocalGet(LOCAL_I32_1));
                        self.emit(WInst::LocalGet(LOCAL_I32_2));
                        self.emit(WInst::I32Xor);
                        self.emit(WInst::If(BlockType::Empty));
                        {
                            self.emit(WInst::I64Const(0));
                            self.emit(WInst::LocalGet(LOCAL_I64_3));
                            self.emit(WInst::I64Sub);
                            self.emit(WInst::LocalSet(LOCAL_I64_3));
                        }
                        self.emit(WInst::End);

                        // if neg_num { rem = -rem }
                        self.emit(WInst::LocalGet(LOCAL_I32_1));
                        self.emit(WInst::If(BlockType::Empty));
                        {
                            self.emit(WInst::I64Const(0));
                            self.emit(WInst::LocalGet(LOCAL_I64_1));
                            self.emit(WInst::I64Sub);
                            self.emit(WInst::LocalSet(LOCAL_I64_1));
                        }
                        self.emit(WInst::End);

                        self.emit(WInst::LocalGet(LOCAL_I64_3));
                        self.emit(WInst::GlobalSet(GLOBAL_RAX));
                        self.emit(WInst::LocalGet(LOCAL_I64_1));
                        self.emit(WInst::GlobalSet(GLOBAL_RDX));
                    }
                    self.emit(WInst::End);
                }
            }
        }
    }

    // ------------------------------------------------------------------------
    // Shifts, Rotates, Bit Tests, Bit Scans
    // ------------------------------------------------------------------------

    fn lift_shift(&mut self, instr: &X86Inst, kind: ShiftKind) {
        let w = self.operand_width_bytes(instr, 0);
        let bits = w * 8;
        let count_mask = if w == 8 { 0x3Fi64 } else { 0x1Fi64 };

        self.read_op_i64(instr, 0, w);
        self.mask_i64(w);
        self.emit(WInst::LocalSet(LOCAL_I64_0));

        if instr.op_count() >= 2 {
            self.read_op_i64(instr, 1, 1);
        } else {
            self.emit(WInst::I64Const(1));
        }
        self.emit(WInst::I64Const(count_mask));
        self.emit(WInst::I64And);
        self.emit(WInst::LocalSet(LOCAL_I64_1));

        // Only modify value and flags if count != 0
        self.emit(WInst::LocalGet(LOCAL_I64_1));
        self.emit(WInst::I64Const(0));
        self.emit(WInst::I64Ne);
        self.emit(WInst::If(BlockType::Empty));
        {
            match kind {
                ShiftKind::Shl => {
                    // CF = (val >> (bits - count)) & 1 (if count <= bits, else 0)
                    if w < 4 {
                        self.emit(WInst::LocalGet(LOCAL_I64_1));
                        self.emit(WInst::I64Const(bits as i64));
                        self.emit(WInst::I64LeU);
                        self.emit(WInst::If(BlockType::Empty));
                    }
                    self.emit(WInst::LocalGet(LOCAL_I64_0));
                    self.emit(WInst::I64Const(bits as i64));
                    self.emit(WInst::LocalGet(LOCAL_I64_1));
                    self.emit(WInst::I64Sub);
                    self.emit(WInst::I64ShrU);
                    self.emit(WInst::I32WrapI64);
                    self.emit(WInst::I32Const(1));
                    self.emit(WInst::I32And);
                    self.emit(WInst::GlobalSet(GLOBAL_CF));
                    if w < 4 {
                        self.emit(WInst::Else);
                        self.emit(WInst::I32Const(0));
                        self.emit(WInst::GlobalSet(GLOBAL_CF));
                        self.emit(WInst::End);
                    }

                    self.emit(WInst::LocalGet(LOCAL_I64_0));
                    self.emit(WInst::LocalGet(LOCAL_I64_1));
                    self.emit(WInst::I64Shl);
                    self.mask_i64(w);
                    self.emit(WInst::LocalSet(LOCAL_I64_2));

                    // OF = CF ^ msb(res) (defined for count == 1)
                    self.emit(WInst::GlobalGet(GLOBAL_CF));
                    self.emit(WInst::LocalGet(LOCAL_I64_2));
                    self.emit(WInst::I64Const((bits - 1) as i64));
                    self.emit(WInst::I64ShrU);
                    self.emit(WInst::I32WrapI64);
                    self.emit(WInst::I32Const(1));
                    self.emit(WInst::I32And);
                    self.emit(WInst::I32Xor);
                    self.emit(WInst::GlobalSet(GLOBAL_OF));
                }
                ShiftKind::Shr => {
                    // CF = (val >> (count - 1)) & 1
                    self.emit(WInst::LocalGet(LOCAL_I64_0));
                    self.emit(WInst::LocalGet(LOCAL_I64_1));
                    self.emit(WInst::I64Const(1));
                    self.emit(WInst::I64Sub);
                    self.emit(WInst::I64ShrU);
                    self.emit(WInst::I32WrapI64);
                    self.emit(WInst::I32Const(1));
                    self.emit(WInst::I32And);
                    self.emit(WInst::GlobalSet(GLOBAL_CF));

                    self.emit(WInst::LocalGet(LOCAL_I64_0));
                    self.emit(WInst::LocalGet(LOCAL_I64_1));
                    self.emit(WInst::I64ShrU);
                    self.mask_i64(w);
                    self.emit(WInst::LocalSet(LOCAL_I64_2));

                    // OF = msb(val)
                    self.emit(WInst::LocalGet(LOCAL_I64_0));
                    self.emit(WInst::I64Const((bits - 1) as i64));
                    self.emit(WInst::I64ShrU);
                    self.emit(WInst::I32WrapI64);
                    self.emit(WInst::I32Const(1));
                    self.emit(WInst::I32And);
                    self.emit(WInst::GlobalSet(GLOBAL_OF));
                }
                ShiftKind::Sar => {
                    // Sign-extend val to 64 bits first
                    self.emit(WInst::LocalGet(LOCAL_I64_0));
                    self.sext_i64(w);
                    self.emit(WInst::LocalSet(LOCAL_I64_3));

                    // CF = (sext_val >> (count - 1)) & 1
                    self.emit(WInst::LocalGet(LOCAL_I64_3));
                    self.emit(WInst::LocalGet(LOCAL_I64_1));
                    self.emit(WInst::I64Const(1));
                    self.emit(WInst::I64Sub);
                    self.emit(WInst::I64ShrS);
                    self.emit(WInst::I32WrapI64);
                    self.emit(WInst::I32Const(1));
                    self.emit(WInst::I32And);
                    self.emit(WInst::GlobalSet(GLOBAL_CF));

                    self.emit(WInst::LocalGet(LOCAL_I64_3));
                    self.emit(WInst::LocalGet(LOCAL_I64_1));
                    self.emit(WInst::I64ShrS);
                    self.mask_i64(w);
                    self.emit(WInst::LocalSet(LOCAL_I64_2));

                    self.emit(WInst::I32Const(0));
                    self.emit(WInst::GlobalSet(GLOBAL_OF));
                }
            }
            self.emit(WInst::LocalGet(LOCAL_I64_2));
            self.write_op_i64(instr, 0, w);
            self.set_zsp_flags(LOCAL_I64_2, w);
        }
        self.emit(WInst::End);
    }

    fn lift_rotate(&mut self, instr: &X86Inst, left: bool) {
        let w = self.operand_width_bytes(instr, 0);
        let bits = w * 8;
        let count_mask = if w == 8 { 0x3Fi64 } else { 0x1Fi64 };

        self.read_op_i64(instr, 0, w);
        self.mask_i64(w);
        self.emit(WInst::LocalSet(LOCAL_I64_0));

        if instr.op_count() >= 2 {
            self.read_op_i64(instr, 1, 1);
        } else {
            self.emit(WInst::I64Const(1));
        }
        self.emit(WInst::I64Const(count_mask));
        self.emit(WInst::I64And);
        self.emit(WInst::LocalSet(LOCAL_I64_1));

        self.emit(WInst::LocalGet(LOCAL_I64_1));
        self.emit(WInst::I64Const(0));
        self.emit(WInst::I64Ne);
        self.emit(WInst::If(BlockType::Empty));
        {
            if w == 8 {
                self.emit(WInst::LocalGet(LOCAL_I64_0));
                self.emit(WInst::LocalGet(LOCAL_I64_1));
                self.emit(if left { WInst::I64Rotl } else { WInst::I64Rotr });
                self.emit(WInst::LocalSet(LOCAL_I64_2));
            } else if w == 4 {
                self.emit(WInst::LocalGet(LOCAL_I64_0));
                self.emit(WInst::I32WrapI64);
                self.emit(WInst::LocalGet(LOCAL_I64_1));
                self.emit(WInst::I32WrapI64);
                self.emit(if left { WInst::I32Rotl } else { WInst::I32Rotr });
                self.emit(WInst::I64ExtendI32U);
                self.emit(WInst::LocalSet(LOCAL_I64_2));
            } else {
                // 8-bit or 16-bit rotate: c = count % bits
                self.emit(WInst::LocalGet(LOCAL_I64_1));
                self.emit(WInst::I64Const(bits as i64));
                self.emit(WInst::I64RemU);
                self.emit(WInst::LocalSet(LOCAL_I64_1));
                self.emit(WInst::LocalGet(LOCAL_I64_1));
                self.emit(WInst::I64Eqz);
                self.emit(WInst::If(BlockType::Empty));
                {
                    self.emit(WInst::LocalGet(LOCAL_I64_0));
                    self.emit(WInst::LocalSet(LOCAL_I64_2));
                }
                self.emit(WInst::Else);
                {
                    if left {
                        self.emit(WInst::LocalGet(LOCAL_I64_0));
                        self.emit(WInst::LocalGet(LOCAL_I64_1));
                        self.emit(WInst::I64Shl);
                        self.emit(WInst::LocalGet(LOCAL_I64_0));
                        self.emit(WInst::I64Const(bits as i64));
                        self.emit(WInst::LocalGet(LOCAL_I64_1));
                        self.emit(WInst::I64Sub);
                        self.emit(WInst::I64ShrU);
                        self.emit(WInst::I64Or);
                    } else {
                        self.emit(WInst::LocalGet(LOCAL_I64_0));
                        self.emit(WInst::LocalGet(LOCAL_I64_1));
                        self.emit(WInst::I64ShrU);
                        self.emit(WInst::LocalGet(LOCAL_I64_0));
                        self.emit(WInst::I64Const(bits as i64));
                        self.emit(WInst::LocalGet(LOCAL_I64_1));
                        self.emit(WInst::I64Sub);
                        self.emit(WInst::I64Shl);
                        self.emit(WInst::I64Or);
                    }
                    self.mask_i64(w);
                    self.emit(WInst::LocalSet(LOCAL_I64_2));
                }
                self.emit(WInst::End);
            }

            self.emit(WInst::LocalGet(LOCAL_I64_2));
            self.write_op_i64(instr, 0, w);

            // CF = lsb(res) for rol, msb(res) for ror
            self.emit(WInst::LocalGet(LOCAL_I64_2));
            if !left {
                self.emit(WInst::I64Const((bits - 1) as i64));
                self.emit(WInst::I64ShrU);
            }
            self.emit(WInst::I32WrapI64);
            self.emit(WInst::I32Const(1));
            self.emit(WInst::I32And);
            self.emit(WInst::GlobalSet(GLOBAL_CF));
        }
        self.emit(WInst::End);
    }

    fn lift_double_shift(&mut self, instr: &X86Inst, left: bool) {
        let w = self.operand_width_bytes(instr, 0);
        let bits = w * 8;
        let count_mask = if w == 8 { 0x3Fi64 } else { 0x1Fi64 };

        self.read_op_i64(instr, 0, w);
        self.mask_i64(w);
        self.emit(WInst::LocalSet(LOCAL_I64_0));
        self.read_op_i64(instr, 1, w);
        self.mask_i64(w);
        self.emit(WInst::LocalSet(LOCAL_I64_1));
        self.read_op_i64(instr, 2, 1);
        self.emit(WInst::I64Const(count_mask));
        self.emit(WInst::I64And);
        if w < 4 {
            self.emit(WInst::I64Const(bits as i64));
            self.emit(WInst::I64RemU);
        }
        self.emit(WInst::LocalSet(LOCAL_I64_3)); // count

        self.emit(WInst::LocalGet(LOCAL_I64_3));
        self.emit(WInst::I64Const(0));
        self.emit(WInst::I64Ne);
        self.emit(WInst::If(BlockType::Empty));
        {
            if left {
                // CF = (dst >> (bits - count)) & 1
                self.emit(WInst::LocalGet(LOCAL_I64_0));
                self.emit(WInst::I64Const(bits as i64));
                self.emit(WInst::LocalGet(LOCAL_I64_3));
                self.emit(WInst::I64Sub);
                self.emit(WInst::I64ShrU);
                self.emit(WInst::I32WrapI64);
                self.emit(WInst::I32Const(1));
                self.emit(WInst::I32And);
                self.emit(WInst::GlobalSet(GLOBAL_CF));

                // res = (dst << count) | (src >> (bits - count))
                self.emit(WInst::LocalGet(LOCAL_I64_0));
                self.emit(WInst::LocalGet(LOCAL_I64_3));
                self.emit(WInst::I64Shl);
                self.emit(WInst::LocalGet(LOCAL_I64_1));
                self.emit(WInst::I64Const(bits as i64));
                self.emit(WInst::LocalGet(LOCAL_I64_3));
                self.emit(WInst::I64Sub);
                self.emit(WInst::I64ShrU);
                self.emit(WInst::I64Or);
                self.mask_i64(w);
                self.emit(WInst::LocalSet(LOCAL_I64_2));
            } else {
                // CF = (dst >> (count - 1)) & 1
                self.emit(WInst::LocalGet(LOCAL_I64_0));
                self.emit(WInst::LocalGet(LOCAL_I64_3));
                self.emit(WInst::I64Const(1));
                self.emit(WInst::I64Sub);
                self.emit(WInst::I64ShrU);
                self.emit(WInst::I32WrapI64);
                self.emit(WInst::I32Const(1));
                self.emit(WInst::I32And);
                self.emit(WInst::GlobalSet(GLOBAL_CF));

                // res = (dst >> count) | (src << (bits - count))
                self.emit(WInst::LocalGet(LOCAL_I64_0));
                self.emit(WInst::LocalGet(LOCAL_I64_3));
                self.emit(WInst::I64ShrU);
                self.emit(WInst::LocalGet(LOCAL_I64_1));
                self.emit(WInst::I64Const(bits as i64));
                self.emit(WInst::LocalGet(LOCAL_I64_3));
                self.emit(WInst::I64Sub);
                self.emit(WInst::I64Shl);
                self.emit(WInst::I64Or);
                self.mask_i64(w);
                self.emit(WInst::LocalSet(LOCAL_I64_2));
            }
            self.emit(WInst::LocalGet(LOCAL_I64_2));
            self.write_op_i64(instr, 0, w);
            self.set_zsp_flags(LOCAL_I64_2, w);
        }
        self.emit(WInst::End);
    }

    fn lift_bt(&mut self, instr: &X86Inst) {
        let w = self.operand_width_bytes(instr, 0);
        let bit_mask = (w * 8 - 1) as i64;
        self.read_op_i64(instr, 0, w);
        self.emit(WInst::LocalSet(LOCAL_I64_0));
        self.read_op_i64(instr, 1, w);
        self.emit(WInst::I64Const(bit_mask));
        self.emit(WInst::I64And);
        self.emit(WInst::LocalSet(LOCAL_I64_1));

        // CF = (val >> bit) & 1
        self.emit(WInst::LocalGet(LOCAL_I64_0));
        self.emit(WInst::LocalGet(LOCAL_I64_1));
        self.emit(WInst::I64ShrU);
        self.emit(WInst::I32WrapI64);
        self.emit(WInst::I32Const(1));
        self.emit(WInst::I32And);
        self.emit(WInst::GlobalSet(GLOBAL_CF));

        match instr.mnemonic() {
            Mnemonic::Bts => {
                self.emit(WInst::LocalGet(LOCAL_I64_0));
                self.emit(WInst::I64Const(1));
                self.emit(WInst::LocalGet(LOCAL_I64_1));
                self.emit(WInst::I64Shl);
                self.emit(WInst::I64Or);
                self.write_op_i64(instr, 0, w);
            }
            Mnemonic::Btr => {
                self.emit(WInst::LocalGet(LOCAL_I64_0));
                self.emit(WInst::I64Const(1));
                self.emit(WInst::LocalGet(LOCAL_I64_1));
                self.emit(WInst::I64Shl);
                self.emit(WInst::I64Const(-1));
                self.emit(WInst::I64Xor);
                self.emit(WInst::I64And);
                self.write_op_i64(instr, 0, w);
            }
            Mnemonic::Btc => {
                self.emit(WInst::LocalGet(LOCAL_I64_0));
                self.emit(WInst::I64Const(1));
                self.emit(WInst::LocalGet(LOCAL_I64_1));
                self.emit(WInst::I64Shl);
                self.emit(WInst::I64Xor);
                self.write_op_i64(instr, 0, w);
            }
            _ => {}
        }
    }

    fn lift_bitscan(&mut self, instr: &X86Inst) {
        let w = self.operand_width_bytes(instr, 0);
        let bits = w * 8;
        self.read_op_i64(instr, 1, w);
        self.mask_i64(w);
        self.emit(WInst::LocalSet(LOCAL_I64_0));

        let is_zero_check = || {
            // ZF = (src == 0)
        };
        let _ = is_zero_check;

        self.emit(WInst::LocalGet(LOCAL_I64_0));
        self.emit(WInst::I64Eqz);
        self.emit(WInst::GlobalSet(GLOBAL_ZF));

        match instr.mnemonic() {
            Mnemonic::Bsf => {
                self.emit(WInst::GlobalGet(GLOBAL_ZF));
                self.emit(WInst::I32Eqz);
                self.emit(WInst::If(BlockType::Empty));
                {
                    self.emit(WInst::LocalGet(LOCAL_I64_0));
                    self.emit(WInst::I64Ctz);
                    self.write_op_i64(instr, 0, w);
                }
                self.emit(WInst::End);
            }
            Mnemonic::Bsr => {
                self.emit(WInst::GlobalGet(GLOBAL_ZF));
                self.emit(WInst::I32Eqz);
                self.emit(WInst::If(BlockType::Empty));
                {
                    self.emit(WInst::I64Const(63));
                    self.emit(WInst::LocalGet(LOCAL_I64_0));
                    self.emit(WInst::I64Clz);
                    self.emit(WInst::I64Sub);
                    self.write_op_i64(instr, 0, w);
                }
                self.emit(WInst::End);
            }
            Mnemonic::Tzcnt => {
                self.emit(WInst::GlobalGet(GLOBAL_ZF));
                self.emit(WInst::GlobalSet(GLOBAL_CF));
                self.emit(WInst::GlobalGet(GLOBAL_ZF));
                self.emit(WInst::If(BlockType::Empty));
                {
                    self.emit(WInst::I64Const(bits as i64));
                    self.emit(WInst::LocalSet(LOCAL_I64_2));
                }
                self.emit(WInst::Else);
                {
                    self.emit(WInst::LocalGet(LOCAL_I64_0));
                    self.emit(WInst::I64Ctz);
                    self.emit(WInst::LocalSet(LOCAL_I64_2));
                }
                self.emit(WInst::End);
                self.emit(WInst::LocalGet(LOCAL_I64_2));
                self.write_op_i64(instr, 0, w);
                self.emit(WInst::LocalGet(LOCAL_I64_2));
                self.emit(WInst::I64Eqz);
                self.emit(WInst::GlobalSet(GLOBAL_ZF));
            }
            Mnemonic::Lzcnt => {
                self.emit(WInst::GlobalGet(GLOBAL_ZF));
                self.emit(WInst::GlobalSet(GLOBAL_CF));
                self.emit(WInst::LocalGet(LOCAL_I64_0));
                self.emit(WInst::I64Clz);
                self.emit(WInst::I64Const((64 - bits) as i64));
                self.emit(WInst::I64Sub);
                self.emit(WInst::LocalSet(LOCAL_I64_2));
                self.emit(WInst::LocalGet(LOCAL_I64_2));
                self.write_op_i64(instr, 0, w);
                self.emit(WInst::LocalGet(LOCAL_I64_2));
                self.emit(WInst::I64Eqz);
                self.emit(WInst::GlobalSet(GLOBAL_ZF));
            }
            _ => {}
        }
    }

    // ------------------------------------------------------------------------
    // String Instructions
    // ------------------------------------------------------------------------

    fn emit_df_step(&mut self, elem_bytes: u32) {
        // LOCAL_I64_4 = df == 0 ? elem_bytes : -elem_bytes
        self.emit(WInst::GlobalGet(GLOBAL_DF));
        self.emit(WInst::If(BlockType::Empty));
        self.emit(WInst::I64Const(-(elem_bytes as i64)));
        self.emit(WInst::LocalSet(LOCAL_I64_4));
        self.emit(WInst::Else);
        self.emit(WInst::I64Const(elem_bytes as i64));
        self.emit(WInst::LocalSet(LOCAL_I64_4));
        self.emit(WInst::End);
    }

    fn lift_rep_movs(&mut self, instr: &X86Inst, elem_bytes: u32) {
        let is_rep = instr.has_rep_prefix() || instr.has_repe_prefix() || instr.has_repne_prefix();
        self.emit_df_step(elem_bytes);

        let body = |this: &mut Self| {
            this.emit(WInst::GlobalGet(GLOBAL_RDI));
            this.emit(WInst::I32WrapI64);
            this.emit(WInst::GlobalGet(GLOBAL_RSI));
            this.emit(WInst::I32WrapI64);
            this.load_mem_i64(elem_bytes);
            this.store_mem_i64(elem_bytes);

            this.emit(WInst::GlobalGet(GLOBAL_RSI));
            this.emit(WInst::LocalGet(LOCAL_I64_4));
            this.emit(WInst::I64Add);
            this.emit(WInst::GlobalSet(GLOBAL_RSI));

            this.emit(WInst::GlobalGet(GLOBAL_RDI));
            this.emit(WInst::LocalGet(LOCAL_I64_4));
            this.emit(WInst::I64Add);
            this.emit(WInst::GlobalSet(GLOBAL_RDI));
        };

        if !is_rep {
            body(self);
        } else {
            self.emit(WInst::Block(BlockType::Empty));
            self.emit(WInst::Loop(BlockType::Empty));
            {
                self.emit(WInst::GlobalGet(GLOBAL_RCX));
                self.emit(WInst::I64Eqz);
                self.emit(WInst::BrIf(1));

                body(self);

                self.emit(WInst::GlobalGet(GLOBAL_RCX));
                self.emit(WInst::I64Const(1));
                self.emit(WInst::I64Sub);
                self.emit(WInst::GlobalSet(GLOBAL_RCX));
                self.emit(WInst::Br(0));
            }
            self.emit(WInst::End);
            self.emit(WInst::End);
        }
    }

    fn lift_rep_stos(&mut self, instr: &X86Inst, elem_bytes: u32) {
        let is_rep = instr.has_rep_prefix() || instr.has_repe_prefix() || instr.has_repne_prefix();
        self.emit_df_step(elem_bytes);

        let body = |this: &mut Self| {
            this.emit(WInst::GlobalGet(GLOBAL_RDI));
            this.emit(WInst::I32WrapI64);
            this.emit(WInst::GlobalGet(GLOBAL_RAX));
            this.store_mem_i64(elem_bytes);

            this.emit(WInst::GlobalGet(GLOBAL_RDI));
            this.emit(WInst::LocalGet(LOCAL_I64_4));
            this.emit(WInst::I64Add);
            this.emit(WInst::GlobalSet(GLOBAL_RDI));
        };

        if !is_rep {
            body(self);
        } else {
            self.emit(WInst::Block(BlockType::Empty));
            self.emit(WInst::Loop(BlockType::Empty));
            {
                self.emit(WInst::GlobalGet(GLOBAL_RCX));
                self.emit(WInst::I64Eqz);
                self.emit(WInst::BrIf(1));

                body(self);

                self.emit(WInst::GlobalGet(GLOBAL_RCX));
                self.emit(WInst::I64Const(1));
                self.emit(WInst::I64Sub);
                self.emit(WInst::GlobalSet(GLOBAL_RCX));
                self.emit(WInst::Br(0));
            }
            self.emit(WInst::End);
            self.emit(WInst::End);
        }
    }

    fn lift_rep_scas(&mut self, instr: &X86Inst, elem_bytes: u32) {
        let repe = instr.has_repe_prefix();
        let repne = instr.has_repne_prefix();
        let is_rep = repe || repne;
        self.emit_df_step(elem_bytes);

        let body = |this: &mut Self| {
            this.emit(WInst::GlobalGet(GLOBAL_RAX));
            this.mask_i64(elem_bytes);
            this.emit(WInst::LocalSet(LOCAL_I64_0));

            this.emit(WInst::GlobalGet(GLOBAL_RDI));
            this.emit(WInst::I32WrapI64);
            this.load_mem_i64(elem_bytes);
            this.emit(WInst::LocalSet(LOCAL_I64_1));

            this.emit(WInst::LocalGet(LOCAL_I64_0));
            this.emit(WInst::LocalGet(LOCAL_I64_1));
            this.emit(WInst::I64Sub);
            this.mask_i64(elem_bytes);
            this.emit(WInst::LocalSet(LOCAL_I64_2));
            this.set_sub_flags(LOCAL_I64_0, LOCAL_I64_1, LOCAL_I64_2, elem_bytes, true, None);

            this.emit(WInst::GlobalGet(GLOBAL_RDI));
            this.emit(WInst::LocalGet(LOCAL_I64_4));
            this.emit(WInst::I64Add);
            this.emit(WInst::GlobalSet(GLOBAL_RDI));
        };

        if !is_rep {
            body(self);
        } else {
            self.emit(WInst::Block(BlockType::Empty));
            self.emit(WInst::Loop(BlockType::Empty));
            {
                self.emit(WInst::GlobalGet(GLOBAL_RCX));
                self.emit(WInst::I64Eqz);
                self.emit(WInst::BrIf(1));

                body(self);

                self.emit(WInst::GlobalGet(GLOBAL_RCX));
                self.emit(WInst::I64Const(1));
                self.emit(WInst::I64Sub);
                self.emit(WInst::GlobalSet(GLOBAL_RCX));

                if repe {
                    self.emit(WInst::GlobalGet(GLOBAL_ZF));
                    self.emit(WInst::I32Eqz);
                    self.emit(WInst::BrIf(1));
                } else if repne {
                    self.emit(WInst::GlobalGet(GLOBAL_ZF));
                    self.emit(WInst::BrIf(1));
                }
                self.emit(WInst::Br(0));
            }
            self.emit(WInst::End);
            self.emit(WInst::End);
        }
    }

    fn lift_rep_cmps(&mut self, instr: &X86Inst, elem_bytes: u32) {
        let repe = instr.has_repe_prefix();
        let repne = instr.has_repne_prefix();
        let is_rep = repe || repne;
        self.emit_df_step(elem_bytes);

        let body = |this: &mut Self| {
            this.emit(WInst::GlobalGet(GLOBAL_RSI));
            this.emit(WInst::I32WrapI64);
            this.load_mem_i64(elem_bytes);
            this.emit(WInst::LocalSet(LOCAL_I64_0));

            this.emit(WInst::GlobalGet(GLOBAL_RDI));
            this.emit(WInst::I32WrapI64);
            this.load_mem_i64(elem_bytes);
            this.emit(WInst::LocalSet(LOCAL_I64_1));

            this.emit(WInst::LocalGet(LOCAL_I64_0));
            this.emit(WInst::LocalGet(LOCAL_I64_1));
            this.emit(WInst::I64Sub);
            this.mask_i64(elem_bytes);
            this.emit(WInst::LocalSet(LOCAL_I64_2));
            this.set_sub_flags(LOCAL_I64_0, LOCAL_I64_1, LOCAL_I64_2, elem_bytes, true, None);

            this.emit(WInst::GlobalGet(GLOBAL_RSI));
            this.emit(WInst::LocalGet(LOCAL_I64_4));
            this.emit(WInst::I64Add);
            this.emit(WInst::GlobalSet(GLOBAL_RSI));

            this.emit(WInst::GlobalGet(GLOBAL_RDI));
            this.emit(WInst::LocalGet(LOCAL_I64_4));
            this.emit(WInst::I64Add);
            this.emit(WInst::GlobalSet(GLOBAL_RDI));
        };

        if !is_rep {
            body(self);
        } else {
            self.emit(WInst::Block(BlockType::Empty));
            self.emit(WInst::Loop(BlockType::Empty));
            {
                self.emit(WInst::GlobalGet(GLOBAL_RCX));
                self.emit(WInst::I64Eqz);
                self.emit(WInst::BrIf(1));

                body(self);

                self.emit(WInst::GlobalGet(GLOBAL_RCX));
                self.emit(WInst::I64Const(1));
                self.emit(WInst::I64Sub);
                self.emit(WInst::GlobalSet(GLOBAL_RCX));

                if repe {
                    self.emit(WInst::GlobalGet(GLOBAL_ZF));
                    self.emit(WInst::I32Eqz);
                    self.emit(WInst::BrIf(1));
                } else if repne {
                    self.emit(WInst::GlobalGet(GLOBAL_ZF));
                    self.emit(WInst::BrIf(1));
                }
                self.emit(WInst::Br(0));
            }
            self.emit(WInst::End);
            self.emit(WInst::End);
        }
    }

    // ------------------------------------------------------------------------
    // CPUID (Masked to baseline x86-64 + SSE2)
    // ------------------------------------------------------------------------

    fn lift_cpuid(&mut self) {
        self.read_gpr(Register::EAX);
        self.emit(WInst::LocalSet(LOCAL_I64_0));

        // Leaf 0
        self.emit(WInst::LocalGet(LOCAL_I64_0));
        self.emit(WInst::I64Const(0));
        self.emit(WInst::I64Eq);
        self.emit(WInst::If(BlockType::Empty));
        {
            self.emit(WInst::I64Const(0x0000_0007));
            self.emit(WInst::GlobalSet(GLOBAL_RAX));
            self.emit(WInst::I64Const(0x756E_6547)); // "Genu"
            self.emit(WInst::GlobalSet(GLOBAL_RBX));
            self.emit(WInst::I64Const(0x4965_6E69)); // "ineI"
            self.emit(WInst::GlobalSet(GLOBAL_RDX));
            self.emit(WInst::I64Const(0x6C65_746E)); // "ntel"
            self.emit(WInst::GlobalSet(GLOBAL_RCX));
        }
        self.emit(WInst::Else);
        {
            // Leaf 1
            self.emit(WInst::LocalGet(LOCAL_I64_0));
            self.emit(WInst::I64Const(1));
            self.emit(WInst::I64Eq);
            self.emit(WInst::If(BlockType::Empty));
            {
                self.emit(WInst::I64Const(0x0003_06A9));
                self.emit(WInst::GlobalSet(GLOBAL_RAX));
                self.emit(WInst::I64Const(0x0001_0800));
                self.emit(WInst::GlobalSet(GLOBAL_RBX));
                self.emit(WInst::I64Const(0));
                self.emit(WInst::GlobalSet(GLOBAL_RCX));
                self.emit(WInst::I64Const(0x0780_8931));
                self.emit(WInst::GlobalSet(GLOBAL_RDX));
            }
            self.emit(WInst::Else);
            {
                // Leaf 0x8000_0000
                self.emit(WInst::LocalGet(LOCAL_I64_0));
                self.emit(WInst::I64Const(0x8000_0000u32 as i64));
                self.emit(WInst::I64Eq);
                self.emit(WInst::If(BlockType::Empty));
                {
                    self.emit(WInst::I64Const(0x8000_0001u32 as i64));
                    self.emit(WInst::GlobalSet(GLOBAL_RAX));
                    self.emit(WInst::I64Const(0));
                    self.emit(WInst::GlobalSet(GLOBAL_RBX));
                    self.emit(WInst::I64Const(0));
                    self.emit(WInst::GlobalSet(GLOBAL_RCX));
                    self.emit(WInst::I64Const(0));
                    self.emit(WInst::GlobalSet(GLOBAL_RDX));
                }
                self.emit(WInst::Else);
                {
                    // Leaf 0x8000_0001
                    self.emit(WInst::LocalGet(LOCAL_I64_0));
                    self.emit(WInst::I64Const(0x8000_0001u32 as i64));
                    self.emit(WInst::I64Eq);
                    self.emit(WInst::If(BlockType::Empty));
                    {
                        self.emit(WInst::I64Const(0));
                        self.emit(WInst::GlobalSet(GLOBAL_RAX));
                        self.emit(WInst::I64Const(0));
                        self.emit(WInst::GlobalSet(GLOBAL_RBX));
                        self.emit(WInst::I64Const(0));
                        self.emit(WInst::GlobalSet(GLOBAL_RCX));
                        self.emit(WInst::I64Const(0x2010_0800));
                        self.emit(WInst::GlobalSet(GLOBAL_RDX));
                    }
                    self.emit(WInst::Else);
                    {
                        // All other leaves (including 7 and 0x0D) -> 0
                        self.emit(WInst::I64Const(0));
                        self.emit(WInst::GlobalSet(GLOBAL_RAX));
                        self.emit(WInst::I64Const(0));
                        self.emit(WInst::GlobalSet(GLOBAL_RBX));
                        self.emit(WInst::I64Const(0));
                        self.emit(WInst::GlobalSet(GLOBAL_RCX));
                        self.emit(WInst::I64Const(0));
                        self.emit(WInst::GlobalSet(GLOBAL_RDX));
                    }
                    self.emit(WInst::End);
                }
                self.emit(WInst::End);
            }
            self.emit(WInst::End);
        }
        self.emit(WInst::End);
    }

    // ------------------------------------------------------------------------
    // SSE / SSE2 Lifting
    // ------------------------------------------------------------------------

    fn lift_sse(&mut self, instr: &X86Inst) -> bool {
        // Guard against VEX/EVEX forms that share mnemonics (just in case)
        if instr.code() >= Code::VEX_Vaddpd_xmm_xmm_xmmm128 {
            // Let's check encoding instead of Code enum ordering:
            // Actually iced_x86 has `instr.encoding()`, legacy is `EncodingKind::Legacy`.
        }
        if instr.encoding() != iced_x86::EncodingKind::Legacy {
            return false;
        }

        match instr.mnemonic() {
            // 128-bit packed moves
            Mnemonic::Movdqa
            | Mnemonic::Movdqu
            | Mnemonic::Movaps
            | Mnemonic::Movups
            | Mnemonic::Movapd
            | Mnemonic::Movupd
            | Mnemonic::Movntdq
            | Mnemonic::Movntps => {
                if instr.op0_kind() == OpKind::Register {
                    self.read_op_v128(instr, 1);
                    self.write_xmm(instr.op0_register());
                } else {
                    self.compute_ea_i32(instr);
                    self.read_xmm(instr.op1_register());
                    self.emit(WInst::V128Store(memarg(0, 0)));
                }
            }

            Mnemonic::Movq => {
                match (instr.op0_kind(), instr.op1_kind()) {
                    (OpKind::Register, OpKind::Register) => {
                        let r0 = instr.op0_register();
                        let r1 = instr.op1_register();
                        if map_xmm(r0).is_some() && map_xmm(r1).is_some() {
                            self.emit(WInst::V128Const(0));
                            self.read_xmm(r1);
                            self.emit(WInst::I64x2ExtractLane(0));
                            self.emit(WInst::I64x2ReplaceLane(0));
                            self.write_xmm(r0);
                        } else if map_xmm(r0).is_some() {
                            // xmm, r64
                            self.emit(WInst::V128Const(0));
                            self.read_gpr(r1);
                            self.emit(WInst::I64x2ReplaceLane(0));
                            self.write_xmm(r0);
                        } else {
                            // r64, xmm
                            self.read_xmm(r1);
                            self.emit(WInst::I64x2ExtractLane(0));
                            self.write_gpr(r0);
                        }
                    }
                    (OpKind::Register, OpKind::Memory) => {
                        let r0 = instr.op0_register();
                        self.compute_ea_i32(instr);
                        if map_xmm(r0).is_some() {
                            self.emit(WInst::V128Load64Zero(memarg(0, 0)));
                            self.write_xmm(r0);
                        } else {
                            self.load_mem_i64(8);
                            self.write_gpr(r0);
                        }
                    }
                    (OpKind::Memory, OpKind::Register) => {
                        let r1 = instr.op1_register();
                        self.compute_ea_i32(instr);
                        if map_xmm(r1).is_some() {
                            self.read_xmm(r1);
                            self.emit(WInst::I64x2ExtractLane(0));
                        } else {
                            self.read_gpr(r1);
                        }
                        self.store_mem_i64(8);
                    }
                    _ => return false,
                }
            }

            Mnemonic::Movd => {
                match (instr.op0_kind(), instr.op1_kind()) {
                    (OpKind::Register, OpKind::Register) => {
                        let r0 = instr.op0_register();
                        let r1 = instr.op1_register();
                        if map_xmm(r0).is_some() {
                            self.emit(WInst::V128Const(0));
                            self.read_gpr(r1);
                            self.emit(WInst::I32WrapI64);
                            self.emit(WInst::I32x4ReplaceLane(0));
                            self.write_xmm(r0);
                        } else {
                            self.read_xmm(r1);
                            self.emit(WInst::I32x4ExtractLane(0));
                            self.emit(WInst::I64ExtendI32U);
                            self.write_gpr(r0);
                        }
                    }
                    (OpKind::Register, OpKind::Memory) => {
                        self.emit(WInst::V128Const(0));
                        self.compute_ea_i32(instr);
                        self.emit(WInst::I32Load(memarg(0, 0)));
                        self.emit(WInst::I32x4ReplaceLane(0));
                        self.write_xmm(instr.op0_register());
                    }
                    (OpKind::Memory, OpKind::Register) => {
                        self.compute_ea_i32(instr);
                        self.read_xmm(instr.op1_register());
                        self.emit(WInst::I32x4ExtractLane(0));
                        self.emit(WInst::I32Store(memarg(0, 0)));
                    }
                    _ => return false,
                }
            }

            Mnemonic::Movsd => {
                match (instr.op0_kind(), instr.op1_kind()) {
                    (OpKind::Register, OpKind::Register) => {
                        self.read_xmm(instr.op0_register());
                        self.read_xmm(instr.op1_register());
                        self.emit(WInst::I64x2ExtractLane(0));
                        self.emit(WInst::I64x2ReplaceLane(0));
                        self.write_xmm(instr.op0_register());
                    }
                    (OpKind::Register, OpKind::Memory) => {
                        self.compute_ea_i32(instr);
                        self.emit(WInst::V128Load64Zero(memarg(0, 0)));
                        self.write_xmm(instr.op0_register());
                    }
                    (OpKind::Memory, OpKind::Register) => {
                        self.compute_ea_i32(instr);
                        self.read_xmm(instr.op1_register());
                        self.emit(WInst::I64x2ExtractLane(0));
                        self.store_mem_i64(8);
                    }
                    _ => return false,
                }
            }

            Mnemonic::Movss => {
                match (instr.op0_kind(), instr.op1_kind()) {
                    (OpKind::Register, OpKind::Register) => {
                        self.read_xmm(instr.op0_register());
                        self.read_xmm(instr.op1_register());
                        self.emit(WInst::I32x4ExtractLane(0));
                        self.emit(WInst::I32x4ReplaceLane(0));
                        self.write_xmm(instr.op0_register());
                    }
                    (OpKind::Register, OpKind::Memory) => {
                        self.compute_ea_i32(instr);
                        self.emit(WInst::V128Load32Zero(memarg(0, 0)));
                        self.write_xmm(instr.op0_register());
                    }
                    (OpKind::Memory, OpKind::Register) => {
                        self.compute_ea_i32(instr);
                        self.read_xmm(instr.op1_register());
                        self.emit(WInst::I32x4ExtractLane(0));
                        self.emit(WInst::I32Store(memarg(0, 0)));
                    }
                    _ => return false,
                }
            }

            Mnemonic::Movhps | Mnemonic::Movhpd => {
                if instr.op0_kind() == OpKind::Register {
                    self.read_xmm(instr.op0_register());
                    self.compute_ea_i32(instr);
                    self.load_mem_i64(8);
                    self.emit(WInst::I64x2ReplaceLane(1));
                    self.write_xmm(instr.op0_register());
                } else {
                    self.compute_ea_i32(instr);
                    self.read_xmm(instr.op1_register());
                    self.emit(WInst::I64x2ExtractLane(1));
                    self.store_mem_i64(8);
                }
            }
            Mnemonic::Movlps | Mnemonic::Movlpd => {
                if instr.op0_kind() == OpKind::Register {
                    self.read_xmm(instr.op0_register());
                    self.compute_ea_i32(instr);
                    self.load_mem_i64(8);
                    self.emit(WInst::I64x2ReplaceLane(0));
                    self.write_xmm(instr.op0_register());
                } else {
                    self.compute_ea_i32(instr);
                    self.read_xmm(instr.op1_register());
                    self.emit(WInst::I64x2ExtractLane(0));
                    self.store_mem_i64(8);
                }
            }
            Mnemonic::Movhlps => {
                self.read_xmm(instr.op0_register());
                self.read_xmm(instr.op1_register());
                self.emit(WInst::I64x2ExtractLane(1));
                self.emit(WInst::I64x2ReplaceLane(0));
                self.write_xmm(instr.op0_register());
            }
            Mnemonic::Movlhps => {
                self.read_xmm(instr.op0_register());
                self.read_xmm(instr.op1_register());
                self.emit(WInst::I64x2ExtractLane(0));
                self.emit(WInst::I64x2ReplaceLane(1));
                self.write_xmm(instr.op0_register());
            }

            // Unpack & Shuffle
            Mnemonic::Punpcklqdq | Mnemonic::Unpcklpd => {
                self.read_xmm(instr.op0_register());
                self.read_op_v128(instr, 1);
                self.emit(WInst::I8x16Shuffle([
                    0, 1, 2, 3, 4, 5, 6, 7, 16, 17, 18, 19, 20, 21, 22, 23,
                ]));
                self.write_xmm(instr.op0_register());
            }
            Mnemonic::Punpckhqdq | Mnemonic::Unpckhpd => {
                self.read_xmm(instr.op0_register());
                self.read_op_v128(instr, 1);
                self.emit(WInst::I8x16Shuffle([
                    8, 9, 10, 11, 12, 13, 14, 15, 24, 25, 26, 27, 28, 29, 30, 31,
                ]));
                self.write_xmm(instr.op0_register());
            }
            Mnemonic::Punpckldq | Mnemonic::Unpcklps => {
                self.read_xmm(instr.op0_register());
                self.read_op_v128(instr, 1);
                self.emit(WInst::I8x16Shuffle([
                    0, 1, 2, 3, 16, 17, 18, 19, 4, 5, 6, 7, 20, 21, 22, 23,
                ]));
                self.write_xmm(instr.op0_register());
            }
            Mnemonic::Punpckhdq | Mnemonic::Unpckhps => {
                self.read_xmm(instr.op0_register());
                self.read_op_v128(instr, 1);
                self.emit(WInst::I8x16Shuffle([
                    8, 9, 10, 11, 24, 25, 26, 27, 12, 13, 14, 15, 28, 29, 30, 31,
                ]));
                self.write_xmm(instr.op0_register());
            }
            Mnemonic::Punpcklbw => {
                self.read_xmm(instr.op0_register());
                self.read_op_v128(instr, 1);
                self.emit(WInst::I8x16Shuffle([
                    0, 16, 1, 17, 2, 18, 3, 19, 4, 20, 5, 21, 6, 22, 7, 23,
                ]));
                self.write_xmm(instr.op0_register());
            }
            Mnemonic::Punpckhbw => {
                self.read_xmm(instr.op0_register());
                self.read_op_v128(instr, 1);
                self.emit(WInst::I8x16Shuffle([
                    8, 24, 9, 25, 10, 26, 11, 27, 12, 28, 13, 29, 14, 30, 15, 31,
                ]));
                self.write_xmm(instr.op0_register());
            }
            Mnemonic::Punpcklwd => {
                self.read_xmm(instr.op0_register());
                self.read_op_v128(instr, 1);
                self.emit(WInst::I8x16Shuffle([
                    0, 1, 16, 17, 2, 3, 18, 19, 4, 5, 20, 21, 6, 7, 22, 23,
                ]));
                self.write_xmm(instr.op0_register());
            }
            Mnemonic::Punpckhwd => {
                self.read_xmm(instr.op0_register());
                self.read_op_v128(instr, 1);
                self.emit(WInst::I8x16Shuffle([
                    8, 9, 24, 25, 10, 11, 26, 27, 12, 13, 28, 29, 14, 15, 30, 31,
                ]));
                self.write_xmm(instr.op0_register());
            }
            Mnemonic::Pshufd => {
                let imm = instr.immediate8();
                let mut lanes = [0u8; 16];
                for d in 0..4 {
                    let s = ((imm >> (d * 2)) & 3) as u8;
                    for b in 0..4 {
                        lanes[d * 4 + b] = s * 4 + (b as u8);
                    }
                }
                self.read_op_v128(instr, 1);
                self.emit(WInst::V128Const(0));
                self.emit(WInst::I8x16Shuffle(lanes));
                self.write_xmm(instr.op0_register());
            }
            Mnemonic::Pshuflw => {
                let imm = instr.immediate8();
                let mut lanes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
                for w in 0..4 {
                    let s = ((imm >> (w * 2)) & 3) as u8;
                    lanes[w * 2] = s * 2;
                    lanes[w * 2 + 1] = s * 2 + 1;
                }
                self.read_op_v128(instr, 1);
                self.emit(WInst::V128Const(0));
                self.emit(WInst::I8x16Shuffle(lanes));
                self.write_xmm(instr.op0_register());
            }
            Mnemonic::Pshufhw => {
                let imm = instr.immediate8();
                let mut lanes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
                for w in 0..4 {
                    let s = ((imm >> (w * 2)) & 3) as u8;
                    lanes[8 + w * 2] = 8 + s * 2;
                    lanes[8 + w * 2 + 1] = 8 + s * 2 + 1;
                }
                self.read_op_v128(instr, 1);
                self.emit(WInst::V128Const(0));
                self.emit(WInst::I8x16Shuffle(lanes));
                self.write_xmm(instr.op0_register());
            }
            Mnemonic::Shufpd => {
                let imm = instr.immediate8();
                let s0 = if (imm & 1) == 0 { 0u8 } else { 8u8 };
                let s1 = if (imm & 2) == 0 { 16u8 } else { 24u8 };
                let mut lanes = [0u8; 16];
                for b in 0..8 {
                    lanes[b] = s0 + (b as u8);
                    lanes[8 + b] = s1 + (b as u8);
                }
                self.read_xmm(instr.op0_register());
                self.read_op_v128(instr, 1);
                self.emit(WInst::I8x16Shuffle(lanes));
                self.write_xmm(instr.op0_register());
            }
            Mnemonic::Shufps => {
                let imm = instr.immediate8();
                let mut lanes = [0u8; 16];
                for d in 0..2 {
                    let s = ((imm >> (d * 2)) & 3) as u8;
                    for b in 0..4 {
                        lanes[d * 4 + b] = s * 4 + (b as u8);
                    }
                }
                for d in 2..4 {
                    let s = ((imm >> (d * 2)) & 3) as u8;
                    for b in 0..4 {
                        lanes[d * 4 + b] = 16 + s * 4 + (b as u8);
                    }
                }
                self.read_xmm(instr.op0_register());
                self.read_op_v128(instr, 1);
                self.emit(WInst::I8x16Shuffle(lanes));
                self.write_xmm(instr.op0_register());
            }
            Mnemonic::Pinsrw => {
                let lane = (instr.immediate8() & 7) as u8;
                self.read_xmm(instr.op0_register());
                self.read_op_i64(instr, 1, 2);
                self.emit(WInst::I32WrapI64);
                self.emit(WInst::I16x8ReplaceLane(lane));
                self.write_xmm(instr.op0_register());
            }
            Mnemonic::Pextrw => {
                let lane = (instr.immediate8() & 7) as u8;
                self.read_xmm(instr.op1_register());
                self.emit(WInst::I16x8ExtractLaneU(lane));
                self.emit(WInst::I64ExtendI32U);
                self.write_op_i64(instr, 0, self.operand_width_bytes(instr, 0));
            }
            Mnemonic::Packuswb => {
                self.read_xmm(instr.op0_register());
                self.read_op_v128(instr, 1);
                self.emit(WInst::I8x16NarrowI16x8U);
                self.write_xmm(instr.op0_register());
            }
            Mnemonic::Packsswb => {
                self.read_xmm(instr.op0_register());
                self.read_op_v128(instr, 1);
                self.emit(WInst::I8x16NarrowI16x8S);
                self.write_xmm(instr.op0_register());
            }
            Mnemonic::Packssdw => {
                self.read_xmm(instr.op0_register());
                self.read_op_v128(instr, 1);
                self.emit(WInst::I16x8NarrowI32x4S);
                self.write_xmm(instr.op0_register());
            }

            // Packed integer ALU / compare / bitmask / shift
            Mnemonic::Pcmpeqb => self.emit_v128_binop(instr, WInst::I8x16Eq),
            Mnemonic::Pcmpeqw => self.emit_v128_binop(instr, WInst::I16x8Eq),
            Mnemonic::Pcmpeqd => self.emit_v128_binop(instr, WInst::I32x4Eq),
            Mnemonic::Pcmpgtb => self.emit_v128_binop(instr, WInst::I8x16GtS),
            Mnemonic::Pcmpgtw => self.emit_v128_binop(instr, WInst::I16x8GtS),
            Mnemonic::Pcmpgtd => self.emit_v128_binop(instr, WInst::I32x4GtS),
            Mnemonic::Pmovmskb => {
                self.read_xmm(instr.op1_register());
                self.emit(WInst::I8x16Bitmask);
                self.emit(WInst::I64ExtendI32U);
                self.write_gpr(instr.op0_register());
            }
            Mnemonic::Movmskpd => {
                self.read_xmm(instr.op1_register());
                self.emit(WInst::I64x2Bitmask);
                self.emit(WInst::I64ExtendI32U);
                self.write_gpr(instr.op0_register());
            }
            Mnemonic::Movmskps => {
                self.read_xmm(instr.op1_register());
                self.emit(WInst::I32x4Bitmask);
                self.emit(WInst::I64ExtendI32U);
                self.write_gpr(instr.op0_register());
            }
            Mnemonic::Paddb => self.emit_v128_binop(instr, WInst::I8x16Add),
            Mnemonic::Paddw => self.emit_v128_binop(instr, WInst::I16x8Add),
            Mnemonic::Paddd => self.emit_v128_binop(instr, WInst::I32x4Add),
            Mnemonic::Paddq => self.emit_v128_binop(instr, WInst::I64x2Add),
            Mnemonic::Psubb => self.emit_v128_binop(instr, WInst::I8x16Sub),
            Mnemonic::Psubw => self.emit_v128_binop(instr, WInst::I16x8Sub),
            Mnemonic::Psubd => self.emit_v128_binop(instr, WInst::I32x4Sub),
            Mnemonic::Psubq => self.emit_v128_binop(instr, WInst::I64x2Sub),
            Mnemonic::Pminub => self.emit_v128_binop(instr, WInst::I8x16MinU),
            Mnemonic::Pmaxub => self.emit_v128_binop(instr, WInst::I8x16MaxU),
            Mnemonic::Pxor | Mnemonic::Xorpd | Mnemonic::Xorps => {
                self.emit_v128_binop(instr, WInst::V128Xor);
            }
            Mnemonic::Pand | Mnemonic::Andpd | Mnemonic::Andps => {
                self.emit_v128_binop(instr, WInst::V128And);
            }
            Mnemonic::Pandn | Mnemonic::Andnpd | Mnemonic::Andnps => {
                // x86 pandn dst, src = (~dst) & src; WASM v128.andnot(a, b) = a & (~b), so swap!
                self.read_op_v128(instr, 1);
                self.read_xmm(instr.op0_register());
                self.emit(WInst::V128AndNot);
                self.write_xmm(instr.op0_register());
            }
            Mnemonic::Por | Mnemonic::Orpd | Mnemonic::Orps => {
                self.emit_v128_binop(instr, WInst::V128Or);
            }
            Mnemonic::Psrldq => {
                let k = instr.immediate8() as usize;
                if k >= 16 {
                    self.emit(WInst::V128Const(0));
                } else {
                    let mut lanes = [16u8; 16];
                    for i in 0..(16 - k) {
                        lanes[i] = (i + k) as u8;
                    }
                    self.read_xmm(instr.op0_register());
                    self.emit(WInst::V128Const(0));
                    self.emit(WInst::I8x16Shuffle(lanes));
                }
                self.write_xmm(instr.op0_register());
            }
            Mnemonic::Pslldq => {
                let k = instr.immediate8() as usize;
                if k >= 16 {
                    self.emit(WInst::V128Const(0));
                } else {
                    let mut lanes = [16u8; 16];
                    for i in k..16 {
                        lanes[i] = (i - k) as u8;
                    }
                    self.read_xmm(instr.op0_register());
                    self.emit(WInst::V128Const(0));
                    self.emit(WInst::I8x16Shuffle(lanes));
                }
                self.write_xmm(instr.op0_register());
            }
            Mnemonic::Psrlw => self.emit_v128_shift(instr, 16, false, WInst::I16x8ShrU),
            Mnemonic::Psllw => self.emit_v128_shift(instr, 16, false, WInst::I16x8Shl),
            Mnemonic::Psraw => self.emit_v128_shift(instr, 16, true, WInst::I16x8ShrS),
            Mnemonic::Psrld => self.emit_v128_shift(instr, 32, false, WInst::I32x4ShrU),
            Mnemonic::Pslld => self.emit_v128_shift(instr, 32, false, WInst::I32x4Shl),
            Mnemonic::Psrad => self.emit_v128_shift(instr, 32, true, WInst::I32x4ShrS),
            Mnemonic::Psrlq => self.emit_v128_shift(instr, 64, false, WInst::I64x2ShrU),
            Mnemonic::Psllq => self.emit_v128_shift(instr, 64, false, WInst::I64x2Shl),

            // Scalar FP (f64)
            Mnemonic::Addsd => self.emit_scalar_f64_binop(instr, WInst::F64Add),
            Mnemonic::Subsd => self.emit_scalar_f64_binop(instr, WInst::F64Sub),
            Mnemonic::Mulsd => self.emit_scalar_f64_binop(instr, WInst::F64Mul),
            Mnemonic::Divsd => self.emit_scalar_f64_binop(instr, WInst::F64Div),
            Mnemonic::Minsd => self.emit_scalar_f64_binop(instr, WInst::F64Min),
            Mnemonic::Maxsd => self.emit_scalar_f64_binop(instr, WInst::F64Max),
            Mnemonic::Sqrtsd => {
                self.read_xmm(instr.op0_register());
                self.read_op_f64(instr, 1);
                self.emit(WInst::F64Sqrt);
                self.emit(WInst::F64x2ReplaceLane(0));
                self.write_xmm(instr.op0_register());
            }
            Mnemonic::Cmpsd => {
                if instr.op0_kind() != OpKind::Register {
                    return false;
                }
                let pred = instr.immediate8() & 7;
                self.read_xmm(instr.op0_register());
                self.read_xmm(instr.op0_register());
                self.emit(WInst::F64x2ExtractLane(0));
                self.read_op_f64(instr, 1);
                self.emit_f64_cmp_mask(pred);
                self.emit(WInst::I64x2ReplaceLane(0));
                self.write_xmm(instr.op0_register());
            }

            // Scalar FP (f32)
            Mnemonic::Addss => self.emit_scalar_f32_binop(instr, WInst::F32Add),
            Mnemonic::Subss => self.emit_scalar_f32_binop(instr, WInst::F32Sub),
            Mnemonic::Mulss => self.emit_scalar_f32_binop(instr, WInst::F32Mul),
            Mnemonic::Divss => self.emit_scalar_f32_binop(instr, WInst::F32Div),
            Mnemonic::Minss => self.emit_scalar_f32_binop(instr, WInst::F32Min),
            Mnemonic::Maxss => self.emit_scalar_f32_binop(instr, WInst::F32Max),
            Mnemonic::Sqrtss => {
                self.read_xmm(instr.op0_register());
                self.read_op_f32(instr, 1);
                self.emit(WInst::F32Sqrt);
                self.emit(WInst::F32x4ReplaceLane(0));
                self.write_xmm(instr.op0_register());
            }
            Mnemonic::Cmpss => {
                let pred = instr.immediate8() & 7;
                self.read_xmm(instr.op0_register());
                self.read_xmm(instr.op0_register());
                self.emit(WInst::F32x4ExtractLane(0));
                self.read_op_f32(instr, 1);
                self.emit_f32_cmp_mask(pred);
                self.emit(WInst::I32x4ReplaceLane(0));
                self.write_xmm(instr.op0_register());
            }

            // Packed FP
            Mnemonic::Addpd => self.emit_v128_binop(instr, WInst::F64x2Add),
            Mnemonic::Subpd => self.emit_v128_binop(instr, WInst::F64x2Sub),
            Mnemonic::Mulpd => self.emit_v128_binop(instr, WInst::F64x2Mul),
            Mnemonic::Divpd => self.emit_v128_binop(instr, WInst::F64x2Div),
            Mnemonic::Addps => self.emit_v128_binop(instr, WInst::F32x4Add),
            Mnemonic::Subps => self.emit_v128_binop(instr, WInst::F32x4Sub),
            Mnemonic::Mulps => self.emit_v128_binop(instr, WInst::F32x4Mul),
            Mnemonic::Divps => self.emit_v128_binop(instr, WInst::F32x4Div),

            // Scalar FP Compare -> EFLAGS
            Mnemonic::Ucomisd | Mnemonic::Comisd => {
                self.read_xmm(instr.op0_register());
                self.emit(WInst::F64x2ExtractLane(0));
                self.emit(WInst::LocalSet(LOCAL_F64_0));
                self.read_op_f64(instr, 1);
                self.emit(WInst::LocalSet(LOCAL_F64_1));
                self.emit_fp_flags_f64();
            }
            Mnemonic::Ucomiss | Mnemonic::Comiss => {
                self.read_xmm(instr.op0_register());
                self.emit(WInst::F32x4ExtractLane(0));
                self.emit(WInst::F64PromoteF32);
                self.emit(WInst::LocalSet(LOCAL_F64_0));
                self.read_op_f32(instr, 1);
                self.emit(WInst::F64PromoteF32);
                self.emit(WInst::LocalSet(LOCAL_F64_1));
                self.emit_fp_flags_f64();
            }

            // Conversions
            Mnemonic::Cvtsi2sd => {
                let w = self.operand_width_bytes(instr, 1);
                self.read_xmm(instr.op0_register());
                self.read_op_i64(instr, 1, w);
                self.sext_i64(w);
                self.emit(WInst::F64ConvertI64S);
                self.emit(WInst::F64x2ReplaceLane(0));
                self.write_xmm(instr.op0_register());
            }
            Mnemonic::Cvtsi2ss => {
                let w = self.operand_width_bytes(instr, 1);
                self.read_xmm(instr.op0_register());
                self.read_op_i64(instr, 1, w);
                self.sext_i64(w);
                self.emit(WInst::F32ConvertI64S);
                self.emit(WInst::F32x4ReplaceLane(0));
                self.write_xmm(instr.op0_register());
            }
            Mnemonic::Cvttsd2si => {
                let w = self.operand_width_bytes(instr, 0);
                self.read_op_f64(instr, 1);
                if w == 8 {
                    self.emit(WInst::I64TruncSatF64S);
                } else {
                    self.emit(WInst::I32TruncSatF64S);
                    self.emit(WInst::I64ExtendI32U);
                }
                self.write_gpr(instr.op0_register());
            }
            Mnemonic::Cvtsd2si => {
                let w = self.operand_width_bytes(instr, 0);
                self.read_op_f64(instr, 1);
                self.emit(WInst::F64Nearest);
                if w == 8 {
                    self.emit(WInst::I64TruncSatF64S);
                } else {
                    self.emit(WInst::I32TruncSatF64S);
                    self.emit(WInst::I64ExtendI32U);
                }
                self.write_gpr(instr.op0_register());
            }
            Mnemonic::Cvttss2si => {
                let w = self.operand_width_bytes(instr, 0);
                self.read_op_f32(instr, 1);
                if w == 8 {
                    self.emit(WInst::I64TruncSatF32S);
                } else {
                    self.emit(WInst::I32TruncSatF32S);
                    self.emit(WInst::I64ExtendI32U);
                }
                self.write_gpr(instr.op0_register());
            }
            Mnemonic::Cvtss2si => {
                let w = self.operand_width_bytes(instr, 0);
                self.read_op_f32(instr, 1);
                self.emit(WInst::F32Nearest);
                if w == 8 {
                    self.emit(WInst::I64TruncSatF32S);
                } else {
                    self.emit(WInst::I32TruncSatF32S);
                    self.emit(WInst::I64ExtendI32U);
                }
                self.write_gpr(instr.op0_register());
            }
            Mnemonic::Cvtss2sd => {
                self.read_xmm(instr.op0_register());
                self.read_op_f32(instr, 1);
                self.emit(WInst::F64PromoteF32);
                self.emit(WInst::F64x2ReplaceLane(0));
                self.write_xmm(instr.op0_register());
            }
            Mnemonic::Cvtsd2ss => {
                self.read_xmm(instr.op0_register());
                self.read_op_f64(instr, 1);
                self.emit(WInst::F32DemoteF64);
                self.emit(WInst::F32x4ReplaceLane(0));
                self.write_xmm(instr.op0_register());
            }
            Mnemonic::Cvtpd2ps => {
                self.read_op_v128(instr, 1);
                self.emit(WInst::F32x4DemoteF64x2Zero);
                self.write_xmm(instr.op0_register());
            }
            Mnemonic::Cvtps2pd => {
                self.read_op_v128(instr, 1);
                self.emit(WInst::F64x2PromoteLowF32x4);
                self.write_xmm(instr.op0_register());
            }
            Mnemonic::Cvtdq2pd => {
                self.read_op_v128(instr, 1);
                self.emit(WInst::F64x2ConvertLowI32x4S);
                self.write_xmm(instr.op0_register());
            }
            Mnemonic::Cvttpd2dq => {
                self.read_op_v128(instr, 1);
                self.emit(WInst::I32x4TruncSatF64x2SZero);
                self.write_xmm(instr.op0_register());
            }
            Mnemonic::Cvtdq2ps => {
                self.read_op_v128(instr, 1);
                self.emit(WInst::F32x4ConvertI32x4S);
                self.write_xmm(instr.op0_register());
            }
            Mnemonic::Cvttps2dq => {
                self.read_op_v128(instr, 1);
                self.emit(WInst::I32x4TruncSatF32x4S);
                self.write_xmm(instr.op0_register());
            }

            _ => return false,
        }
        true
    }

    fn emit_v128_binop(&mut self, instr: &X86Inst, op: WInst<'static>) {
        self.read_xmm(instr.op0_register());
        self.read_op_v128(instr, 1);
        self.emit(op);
        self.write_xmm(instr.op0_register());
    }

    fn emit_v128_shift(
        &mut self,
        instr: &X86Inst,
        lane_bits: u32,
        is_arithmetic: bool,
        op: WInst<'static>,
    ) {
        if instr.op1_kind() == OpKind::Immediate8 {
            let count = instr.immediate8() as u32;
            if count >= lane_bits {
                if is_arithmetic {
                    self.read_xmm(instr.op0_register());
                    self.emit(WInst::I32Const((lane_bits - 1) as i32));
                    self.emit(op);
                } else {
                    self.emit(WInst::V128Const(0));
                }
            } else {
                self.read_xmm(instr.op0_register());
                self.emit(WInst::I32Const(count as i32));
                self.emit(op);
            }
            self.write_xmm(instr.op0_register());
            return;
        }

        if is_arithmetic {
            self.read_xmm(instr.op0_register());
            self.read_op_v128(instr, 1);
            self.emit(WInst::I64x2ExtractLane(0));
            self.emit(WInst::LocalTee(LOCAL_I64_0));
            self.emit(WInst::I64Const(lane_bits as i64));
            self.emit(WInst::I64GeU);
            self.emit(WInst::If(BlockType::Result(wasm_encoder::ValType::I32)));
            self.emit(WInst::I32Const((lane_bits - 1) as i32));
            self.emit(WInst::Else);
            self.emit(WInst::LocalGet(LOCAL_I64_0));
            self.emit(WInst::I32WrapI64);
            self.emit(WInst::End);
            self.emit(op);
            self.write_xmm(instr.op0_register());
        } else {
            self.read_op_v128(instr, 1);
            self.emit(WInst::I64x2ExtractLane(0));
            self.emit(WInst::LocalTee(LOCAL_I64_0));
            self.emit(WInst::I64Const(lane_bits as i64));
            self.emit(WInst::I64GeU);
            self.emit(WInst::If(BlockType::Result(wasm_encoder::ValType::V128)));
            self.emit(WInst::V128Const(0));
            self.emit(WInst::Else);
            self.read_xmm(instr.op0_register());
            self.emit(WInst::LocalGet(LOCAL_I64_0));
            self.emit(WInst::I32WrapI64);
            self.emit(op);
            self.emit(WInst::End);
            self.write_xmm(instr.op0_register());
        }
    }

    fn read_op_f64(&mut self, instr: &X86Inst, op_idx: u32) {
        match instr.op_kind(op_idx) {
            OpKind::Register => {
                self.read_xmm(instr.op_register(op_idx));
                self.emit(WInst::F64x2ExtractLane(0));
            }
            OpKind::Memory => {
                self.compute_ea_i32(instr);
                self.emit(WInst::F64Load(memarg(0, 0)));
            }
            _ => {
                self.emit(WInst::Unreachable);
                self.emit(WInst::F64Const(0.0));
            }
        }
    }

    fn read_op_f32(&mut self, instr: &X86Inst, op_idx: u32) {
        match instr.op_kind(op_idx) {
            OpKind::Register => {
                self.read_xmm(instr.op_register(op_idx));
                self.emit(WInst::F32x4ExtractLane(0));
            }
            OpKind::Memory => {
                self.compute_ea_i32(instr);
                self.emit(WInst::F32Load(memarg(0, 0)));
            }
            _ => {
                self.emit(WInst::Unreachable);
                self.emit(WInst::F32Const(0.0));
            }
        }
    }

    fn emit_scalar_f64_binop(&mut self, instr: &X86Inst, op: WInst<'static>) {
        self.read_xmm(instr.op0_register());
        self.read_xmm(instr.op0_register());
        self.emit(WInst::F64x2ExtractLane(0));
        self.read_op_f64(instr, 1);
        self.emit(op);
        self.emit(WInst::F64x2ReplaceLane(0));
        self.write_xmm(instr.op0_register());
    }

    fn emit_scalar_f32_binop(&mut self, instr: &X86Inst, op: WInst<'static>) {
        self.read_xmm(instr.op0_register());
        self.read_xmm(instr.op0_register());
        self.emit(WInst::F32x4ExtractLane(0));
        self.read_op_f32(instr, 1);
        self.emit(op);
        self.emit(WInst::F32x4ReplaceLane(0));
        self.write_xmm(instr.op0_register());
    }

    fn emit_f64_cmp_mask(&mut self, pred: u8) {
        self.emit(WInst::LocalSet(LOCAL_F64_1));
        self.emit(WInst::LocalSet(LOCAL_F64_0));
        self.emit(WInst::LocalGet(LOCAL_F64_0));
        self.emit(WInst::LocalGet(LOCAL_F64_1));
        match pred {
            0 => self.emit(WInst::F64Eq),
            1 => self.emit(WInst::F64Lt),
            2 => self.emit(WInst::F64Le),
            4 => self.emit(WInst::F64Ne),
            5 => {
                self.emit(WInst::F64Lt);
                self.emit(WInst::I32Eqz);
            }
            6 => {
                self.emit(WInst::F64Le);
                self.emit(WInst::I32Eqz);
            }
            3 => {
                // unordered: a != a || b != b
                self.emit(WInst::Drop);
                self.emit(WInst::Drop);
                self.emit(WInst::LocalGet(LOCAL_F64_0));
                self.emit(WInst::LocalGet(LOCAL_F64_0));
                self.emit(WInst::F64Ne);
                self.emit(WInst::LocalGet(LOCAL_F64_1));
                self.emit(WInst::LocalGet(LOCAL_F64_1));
                self.emit(WInst::F64Ne);
                self.emit(WInst::I32Or);
            }
            7 => {
                // ordered: a == a && b == b
                self.emit(WInst::Drop);
                self.emit(WInst::Drop);
                self.emit(WInst::LocalGet(LOCAL_F64_0));
                self.emit(WInst::LocalGet(LOCAL_F64_0));
                self.emit(WInst::F64Eq);
                self.emit(WInst::LocalGet(LOCAL_F64_1));
                self.emit(WInst::LocalGet(LOCAL_F64_1));
                self.emit(WInst::F64Eq);
                self.emit(WInst::I32And);
            }
            _ => unreachable!(),
        }
        self.emit(WInst::If(BlockType::Result(wasm_encoder::ValType::I64)));
        self.emit(WInst::I64Const(-1));
        self.emit(WInst::Else);
        self.emit(WInst::I64Const(0));
        self.emit(WInst::End);
    }

    fn emit_f32_cmp_mask(&mut self, pred: u8) {
        self.emit(WInst::LocalSet(LOCAL_F32_1));
        self.emit(WInst::LocalSet(LOCAL_F32_0));
        self.emit(WInst::LocalGet(LOCAL_F32_0));
        self.emit(WInst::LocalGet(LOCAL_F32_1));
        match pred {
            0 => self.emit(WInst::F32Eq),
            1 => self.emit(WInst::F32Lt),
            2 => self.emit(WInst::F32Le),
            4 => self.emit(WInst::F32Ne),
            5 => {
                self.emit(WInst::F32Lt);
                self.emit(WInst::I32Eqz);
            }
            6 => {
                self.emit(WInst::F32Le);
                self.emit(WInst::I32Eqz);
            }
            3 => {
                self.emit(WInst::Drop);
                self.emit(WInst::Drop);
                self.emit(WInst::LocalGet(LOCAL_F32_0));
                self.emit(WInst::LocalGet(LOCAL_F32_0));
                self.emit(WInst::F32Ne);
                self.emit(WInst::LocalGet(LOCAL_F32_1));
                self.emit(WInst::LocalGet(LOCAL_F32_1));
                self.emit(WInst::F32Ne);
                self.emit(WInst::I32Or);
            }
            7 => {
                self.emit(WInst::Drop);
                self.emit(WInst::Drop);
                self.emit(WInst::LocalGet(LOCAL_F32_0));
                self.emit(WInst::LocalGet(LOCAL_F32_0));
                self.emit(WInst::F32Eq);
                self.emit(WInst::LocalGet(LOCAL_F32_1));
                self.emit(WInst::LocalGet(LOCAL_F32_1));
                self.emit(WInst::F32Eq);
                self.emit(WInst::I32And);
            }
            _ => unreachable!(),
        }
        self.emit(WInst::If(BlockType::Result(wasm_encoder::ValType::I32)));
        self.emit(WInst::I32Const(-1));
        self.emit(WInst::Else);
        self.emit(WInst::I32Const(0));
        self.emit(WInst::End);
    }

    fn emit_fp_flags_f64(&mut self) {
        self.emit(WInst::I32Const(0));
        self.emit(WInst::GlobalSet(GLOBAL_OF));
        self.emit(WInst::I32Const(0));
        self.emit(WInst::GlobalSet(GLOBAL_SF));
        self.emit(WInst::I32Const(0));
        self.emit(WInst::GlobalSet(GLOBAL_AF));

        // Check unordered: a != a || b != b
        self.emit(WInst::LocalGet(LOCAL_F64_0));
        self.emit(WInst::LocalGet(LOCAL_F64_0));
        self.emit(WInst::F64Ne);
        self.emit(WInst::LocalGet(LOCAL_F64_1));
        self.emit(WInst::LocalGet(LOCAL_F64_1));
        self.emit(WInst::F64Ne);
        self.emit(WInst::I32Or);
        self.emit(WInst::If(BlockType::Empty));
        {
            self.emit(WInst::I32Const(1));
            self.emit(WInst::GlobalSet(GLOBAL_ZF));
            self.emit(WInst::I32Const(1));
            self.emit(WInst::GlobalSet(GLOBAL_PF));
            self.emit(WInst::I32Const(1));
            self.emit(WInst::GlobalSet(GLOBAL_CF));
        }
        self.emit(WInst::Else);
        {
            self.emit(WInst::I32Const(0));
            self.emit(WInst::GlobalSet(GLOBAL_PF));

            self.emit(WInst::LocalGet(LOCAL_F64_0));
            self.emit(WInst::LocalGet(LOCAL_F64_1));
            self.emit(WInst::F64Eq);
            self.emit(WInst::GlobalSet(GLOBAL_ZF));

            self.emit(WInst::LocalGet(LOCAL_F64_0));
            self.emit(WInst::LocalGet(LOCAL_F64_1));
            self.emit(WInst::F64Lt);
            self.emit(WInst::GlobalSet(GLOBAL_CF));
        }
        self.emit(WInst::End);
    }

    /// Computes indirect jump/call target address from `instr.op0` onto stack as `i64`.
    pub fn emit_indirect_target_i64(&mut self, instr: &X86Inst) {
        self.read_op_i64(instr, 0, 8);
    }
}

#[derive(Clone, Copy)]
enum ShiftKind {
    Shl,
    Shr,
    Sar,
}

fn is_cmovcc(m: Mnemonic) -> bool {
    matches!(
        m,
        Mnemonic::Cmovo
            | Mnemonic::Cmovno
            | Mnemonic::Cmovb
            | Mnemonic::Cmovae
            | Mnemonic::Cmove
            | Mnemonic::Cmovne
            | Mnemonic::Cmovbe
            | Mnemonic::Cmova
            | Mnemonic::Cmovs
            | Mnemonic::Cmovns
            | Mnemonic::Cmovp
            | Mnemonic::Cmovnp
            | Mnemonic::Cmovl
            | Mnemonic::Cmovge
            | Mnemonic::Cmovle
            | Mnemonic::Cmovg
    )
}

fn is_setcc(m: Mnemonic) -> bool {
    matches!(
        m,
        Mnemonic::Seto
            | Mnemonic::Setno
            | Mnemonic::Setb
            | Mnemonic::Setae
            | Mnemonic::Sete
            | Mnemonic::Setne
            | Mnemonic::Setbe
            | Mnemonic::Seta
            | Mnemonic::Sets
            | Mnemonic::Setns
            | Mnemonic::Setp
            | Mnemonic::Setnp
            | Mnemonic::Setl
            | Mnemonic::Setge
            | Mnemonic::Setle
            | Mnemonic::Setg
    )
}
