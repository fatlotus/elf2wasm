use crate::lifter::GLOBAL_X87_CW;
use crate::lifter::GLOBAL_X87_SW;
use wasm_encoder::{BlockType, CodeSection, Function, FunctionSection, Instruction as WInst, TypeSection, ValType};

/// Number of module-level x87 80-bit extended-precision helper functions.
pub const X87_HELPER_COUNT: u32 = 12;

pub const X87_FN_F64_TO_F80: u32 = 0;
pub const X87_FN_F80_TO_F64: u32 = 1;
pub const X87_FN_I64_TO_F80: u32 = 2;
pub const X87_FN_F80_TO_I64: u32 = 3;
pub const X87_FN_ROUND_PACK: u32 = 4;
pub const X87_FN_F80_ADD: u32 = 5;
pub const X87_FN_F80_MUL: u32 = 6;
pub const X87_FN_F80_DIV: u32 = 7;
pub const X87_FN_F80_CMP: u32 = 8;
pub const X87_FN_F80_REM: u32 = 9;
pub const X87_FN_F80_SCALE: u32 = 10;
pub const X87_FN_F80_RNDINT: u32 = 11;

pub struct X87TypeIndices {
    pub f64_to_f80: u32,
    pub f80_to_f64: u32,
    pub i64_to_f80: u32,
    pub f80_to_i64: u32,
    pub round_pack: u32,
    pub f80_binop: u32,
    pub f80_cmp: u32,
    pub f80_rem: u32,
    pub f80_unop: u32,
}

/// Registers the WASM function types for the x87 helper functions, starting at `base_type_idx`.
pub fn register_x87_types(types: &mut TypeSection, base_type_idx: u32) -> X87TypeIndices {
    // 0: (f64) -> (i64, i32)
    types.ty().function([ValType::F64], [ValType::I64, ValType::I32]);
    // 1: (i64, i32) -> (f64)
    types.ty().function([ValType::I64, ValType::I32], [ValType::F64]);
    // 2: (i64) -> (i64, i32)
    types.ty().function([ValType::I64], [ValType::I64, ValType::I32]);
    // 3: (i64, i32, i32) -> (i64)
    types.ty().function([ValType::I64, ValType::I32, ValType::I32], [ValType::I64]);
    // 4: (i32, i32, i64, i64) -> (i64, i32)
    types.ty().function(
        [ValType::I32, ValType::I32, ValType::I64, ValType::I64],
        [ValType::I64, ValType::I32],
    );
    // 5: (i64, i32, i64, i32) -> (i64, i32)
    types.ty().function(
        [ValType::I64, ValType::I32, ValType::I64, ValType::I32],
        [ValType::I64, ValType::I32],
    );
    // 6: (i64, i32, i64, i32) -> (i32)
    types.ty().function(
        [ValType::I64, ValType::I32, ValType::I64, ValType::I32],
        [ValType::I32],
    );
    // 7: (i64, i32, i64, i32, i32) -> (i64, i32)
    types.ty().function(
        [ValType::I64, ValType::I32, ValType::I64, ValType::I32, ValType::I32],
        [ValType::I64, ValType::I32],
    );
    // 8: (i64, i32) -> (i64, i32)
    types.ty().function([ValType::I64, ValType::I32], [ValType::I64, ValType::I32]);

    X87TypeIndices {
        f64_to_f80: base_type_idx,
        f80_to_f64: base_type_idx + 1,
        i64_to_f80: base_type_idx + 2,
        f80_to_i64: base_type_idx + 3,
        round_pack: base_type_idx + 4,
        f80_binop: base_type_idx + 5,
        f80_cmp: base_type_idx + 6,
        f80_rem: base_type_idx + 7,
        f80_unop: base_type_idx + 8,
    }
}

pub fn register_x87_functions(functions: &mut FunctionSection, ty: &X87TypeIndices) {
    functions.function(ty.f64_to_f80); // 0: f64_to_f80
    functions.function(ty.f80_to_f64); // 1: f80_to_f64
    functions.function(ty.i64_to_f80); // 2: i64_to_f80
    functions.function(ty.f80_to_i64); // 3: f80_to_i64
    functions.function(ty.round_pack); // 4: round_pack
    functions.function(ty.f80_binop);  // 5: f80_add
    functions.function(ty.f80_binop);  // 6: f80_mul
    functions.function(ty.f80_binop);  // 7: f80_div
    functions.function(ty.f80_cmp);    // 8: f80_cmp
    functions.function(ty.f80_rem);    // 9: f80_rem
    functions.function(ty.f80_binop);  // 10: f80_scale
    functions.function(ty.f80_unop);   // 11: f80_rndint
}

pub fn emit_x87_functions(code: &mut CodeSection, helper_base: u32) {
    code.function(&emit_f64_to_f80());
    code.function(&emit_f80_to_f64());
    code.function(&emit_i64_to_f80());
    code.function(&emit_f80_to_i64());
    code.function(&emit_round_pack());
    code.function(&emit_f80_add(helper_base));
    code.function(&emit_f80_mul(helper_base));
    code.function(&emit_f80_div(helper_base));
    code.function(&emit_f80_cmp());
    code.function(&emit_f80_rem(helper_base));
    code.function(&emit_f80_scale(helper_base));
    code.function(&emit_f80_rndint(helper_base));
}

/// 0: f64_to_f80(val: f64) -> (mant: i64, se: i32)
fn emit_f64_to_f80() -> Function {
    // param 0: val (f64)
    // locals: 1: bits (i64), 2: frac52 (i64), 3: mant (i64), 4: sign (i32), 5: exp11 (i32), 6: se (i32), 7: lz (i32)
    let mut f = Function::new([(3, ValType::I64), (4, ValType::I32)]);
    let bits = 1;
    let frac52 = 2;
    let mant = 3;
    let sign = 4;
    let exp11 = 5;
    let se = 6;
    let lz = 7;

    f.instruction(&WInst::LocalGet(0));
    f.instruction(&WInst::I64ReinterpretF64);
    f.instruction(&WInst::LocalTee(bits));
    f.instruction(&WInst::I64Const(48));
    f.instruction(&WInst::I64ShrU);
    f.instruction(&WInst::I32WrapI64);
    f.instruction(&WInst::I32Const(0x8000));
    f.instruction(&WInst::I32And);
    f.instruction(&WInst::LocalSet(sign));

    f.instruction(&WInst::LocalGet(bits));
    f.instruction(&WInst::I64Const(52));
    f.instruction(&WInst::I64ShrU);
    f.instruction(&WInst::I32WrapI64);
    f.instruction(&WInst::I32Const(0x7FF));
    f.instruction(&WInst::I32And);
    f.instruction(&WInst::LocalSet(exp11));

    f.instruction(&WInst::LocalGet(bits));
    f.instruction(&WInst::I64Const(0x000F_FFFF_FFFF_FFFFu64 as i64));
    f.instruction(&WInst::I64And);
    f.instruction(&WInst::LocalSet(frac52));

    // Case A: exp11 == 0x7FF (Inf/NaN)
    f.instruction(&WInst::LocalGet(exp11));
    f.instruction(&WInst::I32Const(0x7FF));
    f.instruction(&WInst::I32Eq);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::LocalGet(sign));
        f.instruction(&WInst::I32Const(0x7FFF));
        f.instruction(&WInst::I32Or);
        f.instruction(&WInst::LocalSet(se));

        f.instruction(&WInst::LocalGet(frac52));
        f.instruction(&WInst::I64Eqz);
        f.instruction(&WInst::If(BlockType::Empty));
        {
            f.instruction(&WInst::I64Const(0x8000_0000_0000_0000u64 as i64));
            f.instruction(&WInst::LocalSet(mant));
        }
        f.instruction(&WInst::Else);
        {
            f.instruction(&WInst::I64Const(0xC000_0000_0000_0000u64 as i64));
            f.instruction(&WInst::LocalGet(frac52));
            f.instruction(&WInst::I64Const(11));
            f.instruction(&WInst::I64Shl);
            f.instruction(&WInst::I64Or);
            f.instruction(&WInst::LocalSet(mant));
        }
        f.instruction(&WInst::End);
    }
    f.instruction(&WInst::Else);
    {
        // Case B: exp11 == 0 (Zero or subnormal)
        f.instruction(&WInst::LocalGet(exp11));
        f.instruction(&WInst::I32Eqz);
        f.instruction(&WInst::If(BlockType::Empty));
        {
            f.instruction(&WInst::LocalGet(frac52));
            f.instruction(&WInst::I64Eqz);
            f.instruction(&WInst::If(BlockType::Empty));
            {
                f.instruction(&WInst::LocalGet(sign));
                f.instruction(&WInst::LocalSet(se));
                f.instruction(&WInst::I64Const(0));
                f.instruction(&WInst::LocalSet(mant));
            }
            f.instruction(&WInst::Else);
            {
                f.instruction(&WInst::LocalGet(frac52));
                f.instruction(&WInst::I64Clz);
                f.instruction(&WInst::I32WrapI64);
                f.instruction(&WInst::LocalTee(lz));
                f.instruction(&WInst::I64ExtendI32U);
                // mant = frac52 << lz
                f.instruction(&WInst::Drop);
                f.instruction(&WInst::LocalGet(frac52));
                f.instruction(&WInst::LocalGet(lz));
                f.instruction(&WInst::I64ExtendI32U);
                f.instruction(&WInst::I64Shl);
                f.instruction(&WInst::LocalSet(mant));
                // se = sign | (15372 - lz)
                f.instruction(&WInst::LocalGet(sign));
                f.instruction(&WInst::I32Const(15372));
                f.instruction(&WInst::LocalGet(lz));
                f.instruction(&WInst::I32Sub);
                f.instruction(&WInst::I32Or);
                f.instruction(&WInst::LocalSet(se));
            }
            f.instruction(&WInst::End);
        }
        f.instruction(&WInst::Else);
        {
            // Case C: normal f64
            f.instruction(&WInst::LocalGet(sign));
            f.instruction(&WInst::LocalGet(exp11));
            f.instruction(&WInst::I32Const(15360));
            f.instruction(&WInst::I32Add);
            f.instruction(&WInst::I32Or);
            f.instruction(&WInst::LocalSet(se));

            f.instruction(&WInst::I64Const(0x8000_0000_0000_0000u64 as i64));
            f.instruction(&WInst::LocalGet(frac52));
            f.instruction(&WInst::I64Const(11));
            f.instruction(&WInst::I64Shl);
            f.instruction(&WInst::I64Or);
            f.instruction(&WInst::LocalSet(mant));
        }
        f.instruction(&WInst::End);
    }
    f.instruction(&WInst::End);

    f.instruction(&WInst::LocalGet(mant));
    f.instruction(&WInst::LocalGet(se));
    f.instruction(&WInst::End);
    f
}

/// 1: f80_to_f64(mant: i64, se: i32) -> f64
fn emit_f80_to_f64() -> Function {
    // params: 0: mant (i64), 1: se (i32)
    // locals: 2..6 (5 i64): sign64, out_bits, mant_norm, sig, rem
    //         7..10 (4 i32): exp15, exp11, lz, shift
    let mut f = Function::new([(5, ValType::I64), (4, ValType::I32)]);
    let mant = 0;
    let se = 1;
    let sign64 = 2;
    let out_bits = 3;
    let mant_norm = 4;
    let sig = 5;
    let rem = 6;
    let exp15 = 7;
    let exp11 = 8;
    let lz = 9;
    let shift = 10;

    // sign64 = ((se & 0x8000) as u64) << 48
    f.instruction(&WInst::LocalGet(se));
    f.instruction(&WInst::I32Const(0x8000));
    f.instruction(&WInst::I32And);
    f.instruction(&WInst::I64ExtendI32U);
    f.instruction(&WInst::I64Const(48));
    f.instruction(&WInst::I64Shl);
    f.instruction(&WInst::LocalSet(sign64));

    // exp15 = se & 0x7FFF
    f.instruction(&WInst::LocalGet(se));
    f.instruction(&WInst::I32Const(0x7FFF));
    f.instruction(&WInst::I32And);
    f.instruction(&WInst::LocalSet(exp15));

    // Case A: exp15 == 0x7FFF
    f.instruction(&WInst::LocalGet(exp15));
    f.instruction(&WInst::I32Const(0x7FFF));
    f.instruction(&WInst::I32Eq);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::LocalGet(mant));
        f.instruction(&WInst::I64Const(0x7FFF_FFFF_FFFF_FFFFu64 as i64));
        f.instruction(&WInst::I64And);
        f.instruction(&WInst::I64Eqz);
        f.instruction(&WInst::If(BlockType::Empty));
        {
            f.instruction(&WInst::LocalGet(sign64));
            f.instruction(&WInst::I64Const(0x7FF0_0000_0000_0000u64 as i64));
            f.instruction(&WInst::I64Or);
            f.instruction(&WInst::LocalSet(out_bits));
        }
        f.instruction(&WInst::Else);
        {
            f.instruction(&WInst::LocalGet(sign64));
            f.instruction(&WInst::I64Const(0x7FF8_0000_0000_0000u64 as i64));
            f.instruction(&WInst::I64Or);
            f.instruction(&WInst::LocalGet(mant));
            f.instruction(&WInst::I64Const(0x7FFF_FFFF_FFFF_FFFFu64 as i64));
            f.instruction(&WInst::I64And);
            f.instruction(&WInst::I64Const(11));
            f.instruction(&WInst::I64ShrU);
            f.instruction(&WInst::I64Or);
            f.instruction(&WInst::LocalSet(out_bits));
        }
        f.instruction(&WInst::End);
    }
    f.instruction(&WInst::Else);
    {
        // Case B: mant == 0
        f.instruction(&WInst::LocalGet(mant));
        f.instruction(&WInst::I64Eqz);
        f.instruction(&WInst::If(BlockType::Empty));
        {
            f.instruction(&WInst::LocalGet(sign64));
            f.instruction(&WInst::LocalSet(out_bits));
        }
        f.instruction(&WInst::Else);
        {
            // Case C: finite non-zero
            f.instruction(&WInst::LocalGet(mant));
            f.instruction(&WInst::I64Clz);
            f.instruction(&WInst::I32WrapI64);
            f.instruction(&WInst::LocalSet(lz));

            f.instruction(&WInst::LocalGet(mant));
            f.instruction(&WInst::LocalGet(lz));
            f.instruction(&WInst::I64ExtendI32U);
            f.instruction(&WInst::I64Shl);
            f.instruction(&WInst::LocalSet(mant_norm));

            // exp11 = (exp15 == 0 ? -16382 + 1023 : exp15 - (16383 - 1023)) - lz
            f.instruction(&WInst::LocalGet(exp15));
            f.instruction(&WInst::I32Eqz);
            f.instruction(&WInst::If(BlockType::Result(ValType::I32)));
            {
                f.instruction(&WInst::I32Const(-16382 + 1023));
            }
            f.instruction(&WInst::Else);
            {
                f.instruction(&WInst::LocalGet(exp15));
                f.instruction(&WInst::I32Const(16383 - 1023));
                f.instruction(&WInst::I32Sub);
            }
            f.instruction(&WInst::End);
            f.instruction(&WInst::LocalGet(lz));
            f.instruction(&WInst::I32Sub);
            f.instruction(&WInst::LocalSet(exp11));

            // C1: overflow
            f.instruction(&WInst::LocalGet(exp11));
            f.instruction(&WInst::I32Const(0x7FF));
            f.instruction(&WInst::I32GeS);
            f.instruction(&WInst::If(BlockType::Empty));
            {
                f.instruction(&WInst::LocalGet(sign64));
                f.instruction(&WInst::I64Const(0x7FF0_0000_0000_0000u64 as i64));
                f.instruction(&WInst::I64Or);
                f.instruction(&WInst::LocalSet(out_bits));
            }
            f.instruction(&WInst::Else);
            {
                // C2: normal f64
                f.instruction(&WInst::LocalGet(exp11));
                f.instruction(&WInst::I32Const(1));
                f.instruction(&WInst::I32GeS);
                f.instruction(&WInst::If(BlockType::Empty));
                {
                    f.instruction(&WInst::LocalGet(mant_norm));
                    f.instruction(&WInst::I64Const(11));
                    f.instruction(&WInst::I64ShrU);
                    f.instruction(&WInst::LocalSet(sig));

                    f.instruction(&WInst::LocalGet(mant_norm));
                    f.instruction(&WInst::I64Const(0x7FF));
                    f.instruction(&WInst::I64And);
                    f.instruction(&WInst::LocalSet(rem));

                    // Round to nearest even
                    f.instruction(&WInst::LocalGet(rem));
                    f.instruction(&WInst::I64Const(0x400));
                    f.instruction(&WInst::I64GtU);
                    f.instruction(&WInst::LocalGet(rem));
                    f.instruction(&WInst::I64Const(0x400));
                    f.instruction(&WInst::I64Eq);
                    f.instruction(&WInst::LocalGet(sig));
                    f.instruction(&WInst::I64Const(1));
                    f.instruction(&WInst::I64And);
                    f.instruction(&WInst::I64Const(0));
                    f.instruction(&WInst::I64Ne);
                    f.instruction(&WInst::I32And);
                    f.instruction(&WInst::I32Or);
                    f.instruction(&WInst::If(BlockType::Empty));
                    {
                        f.instruction(&WInst::LocalGet(sig));
                        f.instruction(&WInst::I64Const(1));
                        f.instruction(&WInst::I64Add);
                        f.instruction(&WInst::LocalTee(sig));
                        f.instruction(&WInst::I64Const(53));
                        f.instruction(&WInst::I64ShrU);
                        f.instruction(&WInst::I64Const(0));
                        f.instruction(&WInst::I64Ne);
                        f.instruction(&WInst::If(BlockType::Empty));
                        {
                            f.instruction(&WInst::LocalGet(sig));
                            f.instruction(&WInst::I64Const(1));
                            f.instruction(&WInst::I64ShrU);
                            f.instruction(&WInst::LocalSet(sig));
                            f.instruction(&WInst::LocalGet(exp11));
                            f.instruction(&WInst::I32Const(1));
                            f.instruction(&WInst::I32Add);
                            f.instruction(&WInst::LocalSet(exp11));
                        }
                        f.instruction(&WInst::End);
                    }
                    f.instruction(&WInst::End);

                    f.instruction(&WInst::LocalGet(exp11));
                    f.instruction(&WInst::I32Const(0x7FF));
                    f.instruction(&WInst::I32GeS);
                    f.instruction(&WInst::If(BlockType::Empty));
                    {
                        f.instruction(&WInst::LocalGet(sign64));
                        f.instruction(&WInst::I64Const(0x7FF0_0000_0000_0000u64 as i64));
                        f.instruction(&WInst::I64Or);
                        f.instruction(&WInst::LocalSet(out_bits));
                    }
                    f.instruction(&WInst::Else);
                    {
                        f.instruction(&WInst::LocalGet(sign64));
                        f.instruction(&WInst::LocalGet(exp11));
                        f.instruction(&WInst::I64ExtendI32U);
                        f.instruction(&WInst::I64Const(52));
                        f.instruction(&WInst::I64Shl);
                        f.instruction(&WInst::I64Or);
                        f.instruction(&WInst::LocalGet(sig));
                        f.instruction(&WInst::I64Const(0x000F_FFFF_FFFF_FFFFu64 as i64));
                        f.instruction(&WInst::I64And);
                        f.instruction(&WInst::I64Or);
                        f.instruction(&WInst::LocalSet(out_bits));
                    }
                    f.instruction(&WInst::End);
                }
                f.instruction(&WInst::Else);
                {
                    // C3: subnormal f64
                    f.instruction(&WInst::I32Const(12));
                    f.instruction(&WInst::LocalGet(exp11));
                    f.instruction(&WInst::I32Sub);
                    f.instruction(&WInst::LocalTee(shift));
                    f.instruction(&WInst::I32Const(64));
                    f.instruction(&WInst::I32LtS);
                    f.instruction(&WInst::If(BlockType::Empty));
                    {
                        f.instruction(&WInst::LocalGet(mant_norm));
                        f.instruction(&WInst::LocalGet(shift));
                        f.instruction(&WInst::I64ExtendI32U);
                        f.instruction(&WInst::I64ShrU);
                        f.instruction(&WInst::LocalGet(mant_norm));
                        f.instruction(&WInst::LocalGet(shift));
                        f.instruction(&WInst::I32Const(1));
                        f.instruction(&WInst::I32Sub);
                        f.instruction(&WInst::I64ExtendI32U);
                        f.instruction(&WInst::I64ShrU);
                        f.instruction(&WInst::I64Const(1));
                        f.instruction(&WInst::I64And);
                        f.instruction(&WInst::I64Add);
                        f.instruction(&WInst::LocalGet(sign64));
                        f.instruction(&WInst::I64Or);
                        f.instruction(&WInst::LocalSet(out_bits));
                    }
                    f.instruction(&WInst::Else);
                    {
                        f.instruction(&WInst::LocalGet(sign64));
                        f.instruction(&WInst::LocalSet(out_bits));
                    }
                    f.instruction(&WInst::End);
                }
                f.instruction(&WInst::End);
            }
            f.instruction(&WInst::End);
        }
        f.instruction(&WInst::End);
    }
    f.instruction(&WInst::End);

    f.instruction(&WInst::LocalGet(out_bits));
    f.instruction(&WInst::F64ReinterpretI64);
    f.instruction(&WInst::End);
    f
}

/// 2: i64_to_f80(val: i64) -> (mant: i64, se: i32)
fn emit_i64_to_f80() -> Function {
    // param 0: val (i64)
    // locals: 1: u (i64), 2: sign (i32), 3: lz (i32)
    let mut f = Function::new([(1, ValType::I64), (2, ValType::I32)]);
    let val = 0;
    let u = 1;
    let sign = 2;
    let lz = 3;

    f.instruction(&WInst::LocalGet(val));
    f.instruction(&WInst::I64Eqz);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::I64Const(0));
        f.instruction(&WInst::I32Const(0));
        f.instruction(&WInst::Return);
    }
    f.instruction(&WInst::End);

    f.instruction(&WInst::LocalGet(val));
    f.instruction(&WInst::I64Const(0));
    f.instruction(&WInst::I64LtS);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::I32Const(0x8000));
        f.instruction(&WInst::LocalSet(sign));
        f.instruction(&WInst::I64Const(0));
        f.instruction(&WInst::LocalGet(val));
        f.instruction(&WInst::I64Sub);
        f.instruction(&WInst::LocalSet(u));
    }
    f.instruction(&WInst::Else);
    {
        f.instruction(&WInst::I32Const(0));
        f.instruction(&WInst::LocalSet(sign));
        f.instruction(&WInst::LocalGet(val));
        f.instruction(&WInst::LocalSet(u));
    }
    f.instruction(&WInst::End);

    f.instruction(&WInst::LocalGet(u));
    f.instruction(&WInst::I64Clz);
    f.instruction(&WInst::I32WrapI64);
    f.instruction(&WInst::LocalSet(lz));

    // mant = u << lz
    f.instruction(&WInst::LocalGet(u));
    f.instruction(&WInst::LocalGet(lz));
    f.instruction(&WInst::I64ExtendI32U);
    f.instruction(&WInst::I64Shl);

    // se = sign | (16383 + 63 - lz)
    f.instruction(&WInst::LocalGet(sign));
    f.instruction(&WInst::I32Const(16383 + 63));
    f.instruction(&WInst::LocalGet(lz));
    f.instruction(&WInst::I32Sub);
    f.instruction(&WInst::I32Or);

    f.instruction(&WInst::End);
    f
}

/// 3: f80_to_i64(mant: i64, se: i32, trunc: i32) -> i64
/// Converts 80-bit float to signed 64-bit integer using CW rounding mode (or trunc if trunc != 0).
/// Returns i64::MIN (0x8000_0000_0000_0000) on NaN/Inf/overflow.
fn emit_f80_to_i64() -> Function {
    // params: 0: mant (i64), 1: se (i32), 2: trunc (i32)
    // locals: 3..5 (3 i64): m, q, rem
    //         6..13 (8 i32): sign, exp15, lz, exp, shift, half, sticky, rc
    let mut f = Function::new([(3, ValType::I64), (8, ValType::I32)]);
    let mant = 0;
    let se = 1;
    let trunc = 2;
    let m = 3;
    let q = 4;
    let rem = 5;
    let sign = 6;
    let exp15 = 7;
    let lz = 8;
    let exp = 9;
    let shift = 10;
    let half = 11;
    let sticky = 12;
    let rc = 13;

    f.instruction(&WInst::LocalGet(se));
    f.instruction(&WInst::I32Const(0x8000));
    f.instruction(&WInst::I32And);
    f.instruction(&WInst::LocalSet(sign));

    f.instruction(&WInst::LocalGet(se));
    f.instruction(&WInst::I32Const(0x7FFF));
    f.instruction(&WInst::I32And);
    f.instruction(&WInst::LocalTee(exp15));
    f.instruction(&WInst::I32Const(0x7FFF));
    f.instruction(&WInst::I32Eq);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::I64Const(i64::MIN));
        f.instruction(&WInst::Return);
    }
    f.instruction(&WInst::End);

    f.instruction(&WInst::LocalGet(mant));
    f.instruction(&WInst::I64Eqz);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::I64Const(0));
        f.instruction(&WInst::Return);
    }
    f.instruction(&WInst::End);

    // Normalize mant
    f.instruction(&WInst::LocalGet(mant));
    f.instruction(&WInst::I64Clz);
    f.instruction(&WInst::I32WrapI64);
    f.instruction(&WInst::LocalSet(lz));

    f.instruction(&WInst::LocalGet(mant));
    f.instruction(&WInst::LocalGet(lz));
    f.instruction(&WInst::I64ExtendI32U);
    f.instruction(&WInst::I64Shl);
    f.instruction(&WInst::LocalSet(m));

    // exp = (exp15 == 0 ? -16382 : exp15 - 16383) - lz
    f.instruction(&WInst::LocalGet(exp15));
    f.instruction(&WInst::I32Eqz);
    f.instruction(&WInst::If(BlockType::Result(ValType::I32)));
    {
        f.instruction(&WInst::I32Const(-16382));
    }
    f.instruction(&WInst::Else);
    {
        f.instruction(&WInst::LocalGet(exp15));
        f.instruction(&WInst::I32Const(16383));
        f.instruction(&WInst::I32Sub);
    }
    f.instruction(&WInst::End);
    f.instruction(&WInst::LocalGet(lz));
    f.instruction(&WInst::I32Sub);
    f.instruction(&WInst::LocalSet(exp));

    // If exp >= 63: only exact -2^63 is valid (returns i64::MIN either way!)
    f.instruction(&WInst::LocalGet(exp));
    f.instruction(&WInst::I32Const(63));
    f.instruction(&WInst::I32GeS);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::I64Const(i64::MIN));
        f.instruction(&WInst::Return);
    }
    f.instruction(&WInst::End);

    // Compute q, half, sticky
    f.instruction(&WInst::LocalGet(exp));
    f.instruction(&WInst::I32Const(0));
    f.instruction(&WInst::I32LtS);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::I64Const(0));
        f.instruction(&WInst::LocalSet(q));
        f.instruction(&WInst::LocalGet(exp));
        f.instruction(&WInst::I32Const(-1));
        f.instruction(&WInst::I32Eq);
        f.instruction(&WInst::If(BlockType::Empty));
        {
            f.instruction(&WInst::I32Const(1));
            f.instruction(&WInst::LocalSet(half));
            f.instruction(&WInst::LocalGet(m));
            f.instruction(&WInst::I64Const(0x7FFF_FFFF_FFFF_FFFFu64 as i64));
            f.instruction(&WInst::I64And);
            f.instruction(&WInst::I64Const(0));
            f.instruction(&WInst::I64Ne);
            f.instruction(&WInst::LocalSet(sticky));
        }
        f.instruction(&WInst::Else);
        {
            f.instruction(&WInst::I32Const(0));
            f.instruction(&WInst::LocalSet(half));
            f.instruction(&WInst::I32Const(1));
            f.instruction(&WInst::LocalSet(sticky));
        }
        f.instruction(&WInst::End);
    }
    f.instruction(&WInst::Else);
    {
        // 0 <= exp <= 62; shift = 63 - exp (1..=63)
        f.instruction(&WInst::I32Const(63));
        f.instruction(&WInst::LocalGet(exp));
        f.instruction(&WInst::I32Sub);
        f.instruction(&WInst::LocalSet(shift));

        f.instruction(&WInst::LocalGet(m));
        f.instruction(&WInst::LocalGet(shift));
        f.instruction(&WInst::I64ExtendI32U);
        f.instruction(&WInst::I64ShrU);
        f.instruction(&WInst::LocalSet(q));

        f.instruction(&WInst::LocalGet(m));
        f.instruction(&WInst::I32Const(64));
        f.instruction(&WInst::LocalGet(shift));
        f.instruction(&WInst::I32Sub);
        f.instruction(&WInst::I64ExtendI32U);
        f.instruction(&WInst::I64Shl);
        f.instruction(&WInst::LocalTee(rem));

        f.instruction(&WInst::I64Const(63));
        f.instruction(&WInst::I64ShrU);
        f.instruction(&WInst::I32WrapI64);
        f.instruction(&WInst::LocalSet(half));

        f.instruction(&WInst::LocalGet(rem));
        f.instruction(&WInst::I64Const(0x7FFF_FFFF_FFFF_FFFFu64 as i64));
        f.instruction(&WInst::I64And);
        f.instruction(&WInst::I64Const(0));
        f.instruction(&WInst::I64Ne);
        f.instruction(&WInst::LocalSet(sticky));
    }
    f.instruction(&WInst::End);

    // rc = trunc ? 3 : ((CW >>> 10) & 3)
    f.instruction(&WInst::LocalGet(trunc));
    f.instruction(&WInst::If(BlockType::Result(ValType::I32)));
    {
        f.instruction(&WInst::I32Const(3));
    }
    f.instruction(&WInst::Else);
    {
        f.instruction(&WInst::GlobalGet(GLOBAL_X87_CW));
        f.instruction(&WInst::I32Const(10));
        f.instruction(&WInst::I32ShrU);
        f.instruction(&WInst::I32Const(3));
        f.instruction(&WInst::I32And);
    }
    f.instruction(&WInst::End);
    f.instruction(&WInst::LocalSet(rc));

    // Apply rounding
    f.instruction(&WInst::LocalGet(rc));
    f.instruction(&WInst::I32Eqz);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        // Nearest even: half && (sticky || (q & 1))
        f.instruction(&WInst::LocalGet(half));
        f.instruction(&WInst::LocalGet(sticky));
        f.instruction(&WInst::LocalGet(q));
        f.instruction(&WInst::I32WrapI64);
        f.instruction(&WInst::I32Const(1));
        f.instruction(&WInst::I32And);
        f.instruction(&WInst::I32Or);
        f.instruction(&WInst::I32And);
        f.instruction(&WInst::If(BlockType::Empty));
        {
            f.instruction(&WInst::LocalGet(q));
            f.instruction(&WInst::I64Const(1));
            f.instruction(&WInst::I64Add);
            f.instruction(&WInst::LocalSet(q));
        }
        f.instruction(&WInst::End);
    }
    f.instruction(&WInst::Else);
    {
        f.instruction(&WInst::LocalGet(rc));
        f.instruction(&WInst::I32Const(1));
        f.instruction(&WInst::I32Eq);
        f.instruction(&WInst::If(BlockType::Empty));
        {
            // Floor (-inf): sign != 0 && (half || sticky)
            f.instruction(&WInst::LocalGet(sign));
            f.instruction(&WInst::I32Const(0));
            f.instruction(&WInst::I32Ne);
            f.instruction(&WInst::LocalGet(half));
            f.instruction(&WInst::LocalGet(sticky));
            f.instruction(&WInst::I32Or);
            f.instruction(&WInst::I32And);
            f.instruction(&WInst::If(BlockType::Empty));
            {
                f.instruction(&WInst::LocalGet(q));
                f.instruction(&WInst::I64Const(1));
                f.instruction(&WInst::I64Add);
                f.instruction(&WInst::LocalSet(q));
            }
            f.instruction(&WInst::End);
        }
        f.instruction(&WInst::Else);
        {
            f.instruction(&WInst::LocalGet(rc));
            f.instruction(&WInst::I32Const(2));
            f.instruction(&WInst::I32Eq);
            f.instruction(&WInst::If(BlockType::Empty));
            {
                // Ceil (+inf): sign == 0 && (half || sticky)
                f.instruction(&WInst::LocalGet(sign));
                f.instruction(&WInst::I32Eqz);
                f.instruction(&WInst::LocalGet(half));
                f.instruction(&WInst::LocalGet(sticky));
                f.instruction(&WInst::I32Or);
                f.instruction(&WInst::I32And);
                f.instruction(&WInst::If(BlockType::Empty));
                {
                    f.instruction(&WInst::LocalGet(q));
                    f.instruction(&WInst::I64Const(1));
                    f.instruction(&WInst::I64Add);
                    f.instruction(&WInst::LocalSet(q));
                }
                f.instruction(&WInst::End);
            }
            f.instruction(&WInst::End);
        }
        f.instruction(&WInst::End);
    }
    f.instruction(&WInst::End);

    // Check overflow: q == 0x8000_0000_0000_0000 -> returns i64::MIN (either valid -2^63 or overflow indefinite)
    f.instruction(&WInst::LocalGet(q));
    f.instruction(&WInst::I64Const(i64::MIN));
    f.instruction(&WInst::I64Eq);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::I64Const(i64::MIN));
        f.instruction(&WInst::Return);
    }
    f.instruction(&WInst::End);

    f.instruction(&WInst::LocalGet(sign));
    f.instruction(&WInst::If(BlockType::Result(ValType::I64)));
    {
        f.instruction(&WInst::I64Const(0));
        f.instruction(&WInst::LocalGet(q));
        f.instruction(&WInst::I64Sub);
    }
    f.instruction(&WInst::Else);
    {
        f.instruction(&WInst::LocalGet(q));
    }
    f.instruction(&WInst::End);

    f.instruction(&WInst::End);
    f
}

/// 4: round_pack(sign: i32, exp: i32, mant: i64, rem: i64) -> (mant: i64, se: i32)
/// Expects `mant` normalized (bit 63 set) and `rem` as the 64-bit fractional/sticky word below bit 0 of `mant`.
fn emit_round_pack() -> Function {
    // params: 0: sign (i32), 1: exp (i32), 2: mant (i64), 3: rem (i64)
    // locals: 4: rc (i32), 5: shift (i32), 6: half (i32), 7: sticky (i32), 8: inc (i32)
    let mut f = Function::new([(5, ValType::I32)]);
    let sign = 0;
    let exp = 1;
    let mant = 2;
    let rem = 3;
    let rc = 4;
    let shift = 5;
    let half = 6;
    let sticky = 7;
    let inc = 8;

    // Subnormal / underflow handling when exp <= 0
    f.instruction(&WInst::LocalGet(exp));
    f.instruction(&WInst::I32Const(0));
    f.instruction(&WInst::I32LeS);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::I32Const(1));
        f.instruction(&WInst::LocalGet(exp));
        f.instruction(&WInst::I32Sub);
        f.instruction(&WInst::LocalTee(shift));
        f.instruction(&WInst::I32Const(65));
        f.instruction(&WInst::I32GeS);
        f.instruction(&WInst::If(BlockType::Empty));
        {
            f.instruction(&WInst::I64Const(0));
            f.instruction(&WInst::LocalSet(mant));
            f.instruction(&WInst::I64Const(1));
            f.instruction(&WInst::LocalSet(rem));
        }
        f.instruction(&WInst::Else);
        {
            f.instruction(&WInst::LocalGet(shift));
            f.instruction(&WInst::I32Const(64));
            f.instruction(&WInst::I32Eq);
            f.instruction(&WInst::If(BlockType::Empty));
            {
                f.instruction(&WInst::LocalGet(mant));
                f.instruction(&WInst::LocalGet(rem));
                f.instruction(&WInst::I64Const(0));
                f.instruction(&WInst::I64Ne);
                f.instruction(&WInst::I64ExtendI32U);
                f.instruction(&WInst::I64Or);
                f.instruction(&WInst::LocalSet(rem));
                f.instruction(&WInst::I64Const(0));
                f.instruction(&WInst::LocalSet(mant));
            }
            f.instruction(&WInst::Else);
            {
                // 1 <= shift <= 63
                f.instruction(&WInst::LocalGet(mant));
                f.instruction(&WInst::I32Const(64));
                f.instruction(&WInst::LocalGet(shift));
                f.instruction(&WInst::I32Sub);
                f.instruction(&WInst::I64ExtendI32U);
                f.instruction(&WInst::I64Shl);
                f.instruction(&WInst::LocalGet(rem));
                f.instruction(&WInst::I64Const(0));
                f.instruction(&WInst::I64Ne);
                f.instruction(&WInst::I64ExtendI32U);
                f.instruction(&WInst::I64Or);
                f.instruction(&WInst::LocalSet(rem));

                f.instruction(&WInst::LocalGet(mant));
                f.instruction(&WInst::LocalGet(shift));
                f.instruction(&WInst::I64ExtendI32U);
                f.instruction(&WInst::I64ShrU);
                f.instruction(&WInst::LocalSet(mant));
            }
            f.instruction(&WInst::End);
        }
        f.instruction(&WInst::End);
        f.instruction(&WInst::I32Const(0));
        f.instruction(&WInst::LocalSet(exp));
    }
    f.instruction(&WInst::End);

    // Compute half, sticky, rc
    f.instruction(&WInst::LocalGet(rem));
    f.instruction(&WInst::I64Const(63));
    f.instruction(&WInst::I64ShrU);
    f.instruction(&WInst::I32WrapI64);
    f.instruction(&WInst::LocalSet(half));

    f.instruction(&WInst::LocalGet(rem));
    f.instruction(&WInst::I64Const(0x7FFF_FFFF_FFFF_FFFFu64 as i64));
    f.instruction(&WInst::I64And);
    f.instruction(&WInst::I64Const(0));
    f.instruction(&WInst::I64Ne);
    f.instruction(&WInst::LocalSet(sticky));

    f.instruction(&WInst::GlobalGet(GLOBAL_X87_CW));
    f.instruction(&WInst::I32Const(10));
    f.instruction(&WInst::I32ShrU);
    f.instruction(&WInst::I32Const(3));
    f.instruction(&WInst::I32And);
    f.instruction(&WInst::LocalTee(rc));

    f.instruction(&WInst::I32Eqz);
    f.instruction(&WInst::If(BlockType::Result(ValType::I32)));
    {
        // Nearest even
        f.instruction(&WInst::LocalGet(half));
        f.instruction(&WInst::LocalGet(sticky));
        f.instruction(&WInst::LocalGet(mant));
        f.instruction(&WInst::I32WrapI64);
        f.instruction(&WInst::I32Const(1));
        f.instruction(&WInst::I32And);
        f.instruction(&WInst::I32Or);
        f.instruction(&WInst::I32And);
    }
    f.instruction(&WInst::Else);
    {
        f.instruction(&WInst::LocalGet(rc));
        f.instruction(&WInst::I32Const(1));
        f.instruction(&WInst::I32Eq);
        f.instruction(&WInst::If(BlockType::Result(ValType::I32)));
        {
            // Floor (-inf)
            f.instruction(&WInst::LocalGet(sign));
            f.instruction(&WInst::I32Const(0));
            f.instruction(&WInst::I32Ne);
            f.instruction(&WInst::LocalGet(half));
            f.instruction(&WInst::LocalGet(sticky));
            f.instruction(&WInst::I32Or);
            f.instruction(&WInst::I32And);
        }
        f.instruction(&WInst::Else);
        {
            f.instruction(&WInst::LocalGet(rc));
            f.instruction(&WInst::I32Const(2));
            f.instruction(&WInst::I32Eq);
            f.instruction(&WInst::If(BlockType::Result(ValType::I32)));
            {
                // Ceil (+inf)
                f.instruction(&WInst::LocalGet(sign));
                f.instruction(&WInst::I32Eqz);
                f.instruction(&WInst::LocalGet(half));
                f.instruction(&WInst::LocalGet(sticky));
                f.instruction(&WInst::I32Or);
                f.instruction(&WInst::I32And);
            }
            f.instruction(&WInst::Else);
            {
                // Trunc
                f.instruction(&WInst::I32Const(0));
            }
            f.instruction(&WInst::End);
        }
        f.instruction(&WInst::End);
    }
    f.instruction(&WInst::End);
    f.instruction(&WInst::LocalSet(inc));

    f.instruction(&WInst::LocalGet(inc));
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::LocalGet(mant));
        f.instruction(&WInst::I64Const(1));
        f.instruction(&WInst::I64Add);
        f.instruction(&WInst::LocalTee(mant));
        f.instruction(&WInst::I64Eqz);
        f.instruction(&WInst::If(BlockType::Empty));
        {
            f.instruction(&WInst::I64Const(0x8000_0000_0000_0000u64 as i64));
            f.instruction(&WInst::LocalSet(mant));
            f.instruction(&WInst::LocalGet(exp));
            f.instruction(&WInst::I32Const(1));
            f.instruction(&WInst::I32Add);
            f.instruction(&WInst::LocalSet(exp));
        }
        f.instruction(&WInst::Else);
        {
            f.instruction(&WInst::LocalGet(exp));
            f.instruction(&WInst::I32Eqz);
            f.instruction(&WInst::LocalGet(mant));
            f.instruction(&WInst::I64Const(63));
            f.instruction(&WInst::I64ShrU);
            f.instruction(&WInst::I32WrapI64);
            f.instruction(&WInst::I32And);
            f.instruction(&WInst::If(BlockType::Empty));
            {
                f.instruction(&WInst::I32Const(1));
                f.instruction(&WInst::LocalSet(exp));
            }
            f.instruction(&WInst::End);
        }
        f.instruction(&WInst::End);
    }
    f.instruction(&WInst::End);

    // Overflow -> ±Inf
    f.instruction(&WInst::LocalGet(exp));
    f.instruction(&WInst::I32Const(0x7FFF));
    f.instruction(&WInst::I32GeS);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::I64Const(0x8000_0000_0000_0000u64 as i64));
        f.instruction(&WInst::LocalGet(sign));
        f.instruction(&WInst::I32Const(0x7FFF));
        f.instruction(&WInst::I32Or);
        f.instruction(&WInst::Return);
    }
    f.instruction(&WInst::End);

    f.instruction(&WInst::LocalGet(mant));
    f.instruction(&WInst::LocalGet(sign));
    f.instruction(&WInst::LocalGet(exp));
    f.instruction(&WInst::I32Or);
    f.instruction(&WInst::End);
    f
}

/// 5: f80_add(m1: i64, se1: i32, m2: i64, se2: i32) -> (mant: i64, se: i32)
fn emit_f80_add(helper_base: u32) -> Function {
    // params: 0: m1 (i64), 1: se1 (i32), 2: m2 (i64), 3: se2 (i32)
    // locals: 4..9 (6 i64): tmp64, m2_hi, m2_lo, sum, res_hi, res_lo
    //         10..16 (7 i32): s1, e1, s2, e2, lz, diff, tmp32
    let mut f = Function::new([(6, ValType::I64), (7, ValType::I32)]);
    let m1 = 0;
    let se1 = 1;
    let m2 = 2;
    let se2 = 3;
    let tmp64 = 4;
    let m2_hi = 5;
    let m2_lo = 6;
    let sum = 7;
    let res_hi = 8;
    let res_lo = 9;
    let s1 = 10;
    let e1 = 11;
    let s2 = 12;
    let e2 = 13;
    let lz = 14;
    let diff = 15;
    let tmp32 = 16;

    f.instruction(&WInst::LocalGet(se1));
    f.instruction(&WInst::I32Const(0x8000));
    f.instruction(&WInst::I32And);
    f.instruction(&WInst::LocalSet(s1));
    f.instruction(&WInst::LocalGet(se1));
    f.instruction(&WInst::I32Const(0x7FFF));
    f.instruction(&WInst::I32And);
    f.instruction(&WInst::LocalSet(e1));

    f.instruction(&WInst::LocalGet(se2));
    f.instruction(&WInst::I32Const(0x8000));
    f.instruction(&WInst::I32And);
    f.instruction(&WInst::LocalSet(s2));
    f.instruction(&WInst::LocalGet(se2));
    f.instruction(&WInst::I32Const(0x7FFF));
    f.instruction(&WInst::I32And);
    f.instruction(&WInst::LocalSet(e2));

    // NaN / Inf handling
    f.instruction(&WInst::LocalGet(e1));
    f.instruction(&WInst::I32Const(0x7FFF));
    f.instruction(&WInst::I32Eq);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::LocalGet(m1));
        f.instruction(&WInst::I64Const(0x7FFF_FFFF_FFFF_FFFFu64 as i64));
        f.instruction(&WInst::I64And);
        f.instruction(&WInst::I64Const(0));
        f.instruction(&WInst::I64Ne);
        f.instruction(&WInst::If(BlockType::Empty));
        {
            f.instruction(&WInst::LocalGet(m1));
            f.instruction(&WInst::I64Const(0xC000_0000_0000_0000u64 as i64));
            f.instruction(&WInst::I64Or);
            f.instruction(&WInst::LocalGet(se1));
            f.instruction(&WInst::Return);
        }
        f.instruction(&WInst::End);

        f.instruction(&WInst::LocalGet(e2));
        f.instruction(&WInst::I32Const(0x7FFF));
        f.instruction(&WInst::I32Eq);
        f.instruction(&WInst::If(BlockType::Empty));
        {
            f.instruction(&WInst::LocalGet(m2));
            f.instruction(&WInst::I64Const(0x7FFF_FFFF_FFFF_FFFFu64 as i64));
            f.instruction(&WInst::I64And);
            f.instruction(&WInst::I64Const(0));
            f.instruction(&WInst::I64Ne);
            f.instruction(&WInst::If(BlockType::Empty));
            {
                f.instruction(&WInst::LocalGet(m2));
                f.instruction(&WInst::I64Const(0xC000_0000_0000_0000u64 as i64));
                f.instruction(&WInst::I64Or);
                f.instruction(&WInst::LocalGet(se2));
                f.instruction(&WInst::Return);
            }
            f.instruction(&WInst::End);

            f.instruction(&WInst::LocalGet(s1));
            f.instruction(&WInst::LocalGet(s2));
            f.instruction(&WInst::I32Ne);
            f.instruction(&WInst::If(BlockType::Empty));
            {
                f.instruction(&WInst::I64Const(0xC000_0000_0000_0000u64 as i64));
                f.instruction(&WInst::I32Const(0xFFFF));
                f.instruction(&WInst::Return);
            }
            f.instruction(&WInst::End);
        }
        f.instruction(&WInst::End);

        f.instruction(&WInst::LocalGet(m1));
        f.instruction(&WInst::LocalGet(se1));
        f.instruction(&WInst::Return);
    }
    f.instruction(&WInst::End);

    f.instruction(&WInst::LocalGet(e2));
    f.instruction(&WInst::I32Const(0x7FFF));
    f.instruction(&WInst::I32Eq);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::LocalGet(m2));
        f.instruction(&WInst::I64Const(0x7FFF_FFFF_FFFF_FFFFu64 as i64));
        f.instruction(&WInst::I64And);
        f.instruction(&WInst::I64Const(0));
        f.instruction(&WInst::I64Ne);
        f.instruction(&WInst::If(BlockType::Empty));
        {
            f.instruction(&WInst::LocalGet(m2));
            f.instruction(&WInst::I64Const(0xC000_0000_0000_0000u64 as i64));
            f.instruction(&WInst::I64Or);
            f.instruction(&WInst::LocalGet(se2));
            f.instruction(&WInst::Return);
        }
        f.instruction(&WInst::End);
        f.instruction(&WInst::LocalGet(m2));
        f.instruction(&WInst::LocalGet(se2));
        f.instruction(&WInst::Return);
    }
    f.instruction(&WInst::End);

    // Zero handling
    f.instruction(&WInst::LocalGet(m1));
    f.instruction(&WInst::I64Eqz);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::LocalGet(m2));
        f.instruction(&WInst::I64Eqz);
        f.instruction(&WInst::If(BlockType::Empty));
        {
            f.instruction(&WInst::I64Const(0));
            f.instruction(&WInst::LocalGet(s1));
            f.instruction(&WInst::LocalGet(s2));
            f.instruction(&WInst::I32Eq);
            f.instruction(&WInst::If(BlockType::Result(ValType::I32)));
            {
                f.instruction(&WInst::LocalGet(s1));
            }
            f.instruction(&WInst::Else);
            {
                f.instruction(&WInst::GlobalGet(GLOBAL_X87_CW));
                f.instruction(&WInst::I32Const(10));
                f.instruction(&WInst::I32ShrU);
                f.instruction(&WInst::I32Const(3));
                f.instruction(&WInst::I32And);
                f.instruction(&WInst::I32Const(1));
                f.instruction(&WInst::I32Eq);
                f.instruction(&WInst::If(BlockType::Result(ValType::I32)));
                {
                    f.instruction(&WInst::I32Const(0x8000));
                }
                f.instruction(&WInst::Else);
                {
                    f.instruction(&WInst::I32Const(0));
                }
                f.instruction(&WInst::End);
            }
            f.instruction(&WInst::End);
            f.instruction(&WInst::Return);
        }
        f.instruction(&WInst::End);
        f.instruction(&WInst::LocalGet(m2));
        f.instruction(&WInst::LocalGet(se2));
        f.instruction(&WInst::Return);
    }
    f.instruction(&WInst::End);

    f.instruction(&WInst::LocalGet(m2));
    f.instruction(&WInst::I64Eqz);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::LocalGet(m1));
        f.instruction(&WInst::LocalGet(se1));
        f.instruction(&WInst::Return);
    }
    f.instruction(&WInst::End);

    // Normalize m1 and m2
    f.instruction(&WInst::LocalGet(m1));
    f.instruction(&WInst::I64Clz);
    f.instruction(&WInst::I32WrapI64);
    f.instruction(&WInst::LocalSet(lz));
    f.instruction(&WInst::LocalGet(m1));
    f.instruction(&WInst::LocalGet(lz));
    f.instruction(&WInst::I64ExtendI32U);
    f.instruction(&WInst::I64Shl);
    f.instruction(&WInst::LocalSet(m1));
    f.instruction(&WInst::LocalGet(e1));
    f.instruction(&WInst::I32Eqz);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::I32Const(1));
        f.instruction(&WInst::LocalSet(e1));
    }
    f.instruction(&WInst::End);
    f.instruction(&WInst::LocalGet(e1));
    f.instruction(&WInst::LocalGet(lz));
    f.instruction(&WInst::I32Sub);
    f.instruction(&WInst::LocalSet(e1));

    f.instruction(&WInst::LocalGet(m2));
    f.instruction(&WInst::I64Clz);
    f.instruction(&WInst::I32WrapI64);
    f.instruction(&WInst::LocalSet(lz));
    f.instruction(&WInst::LocalGet(m2));
    f.instruction(&WInst::LocalGet(lz));
    f.instruction(&WInst::I64ExtendI32U);
    f.instruction(&WInst::I64Shl);
    f.instruction(&WInst::LocalSet(m2));
    f.instruction(&WInst::LocalGet(e2));
    f.instruction(&WInst::I32Eqz);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::I32Const(1));
        f.instruction(&WInst::LocalSet(e2));
    }
    f.instruction(&WInst::End);
    f.instruction(&WInst::LocalGet(e2));
    f.instruction(&WInst::LocalGet(lz));
    f.instruction(&WInst::I32Sub);
    f.instruction(&WInst::LocalSet(e2));

    // Ensure (e1, m1) >= (e2, m2)
    f.instruction(&WInst::LocalGet(e1));
    f.instruction(&WInst::LocalGet(e2));
    f.instruction(&WInst::I32LtS);
    f.instruction(&WInst::LocalGet(e1));
    f.instruction(&WInst::LocalGet(e2));
    f.instruction(&WInst::I32Eq);
    f.instruction(&WInst::LocalGet(m1));
    f.instruction(&WInst::LocalGet(m2));
    f.instruction(&WInst::I64LtU);
    f.instruction(&WInst::I32And);
    f.instruction(&WInst::I32Or);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::LocalGet(s1));
        f.instruction(&WInst::LocalSet(tmp32));
        f.instruction(&WInst::LocalGet(s2));
        f.instruction(&WInst::LocalSet(s1));
        f.instruction(&WInst::LocalGet(tmp32));
        f.instruction(&WInst::LocalSet(s2));

        f.instruction(&WInst::LocalGet(e1));
        f.instruction(&WInst::LocalSet(tmp32));
        f.instruction(&WInst::LocalGet(e2));
        f.instruction(&WInst::LocalSet(e1));
        f.instruction(&WInst::LocalGet(tmp32));
        f.instruction(&WInst::LocalSet(e2));

        f.instruction(&WInst::LocalGet(m1));
        f.instruction(&WInst::LocalSet(tmp64));
        f.instruction(&WInst::LocalGet(m2));
        f.instruction(&WInst::LocalSet(m1));
        f.instruction(&WInst::LocalGet(tmp64));
        f.instruction(&WInst::LocalSet(m2));
    }
    f.instruction(&WInst::End);

    // Align m2 by diff = e1 - e2
    f.instruction(&WInst::LocalGet(e1));
    f.instruction(&WInst::LocalGet(e2));
    f.instruction(&WInst::I32Sub);
    f.instruction(&WInst::LocalTee(diff));
    f.instruction(&WInst::I32Eqz);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::LocalGet(m2));
        f.instruction(&WInst::LocalSet(m2_hi));
        f.instruction(&WInst::I64Const(0));
        f.instruction(&WInst::LocalSet(m2_lo));
    }
    f.instruction(&WInst::Else);
    {
        f.instruction(&WInst::LocalGet(diff));
        f.instruction(&WInst::I32Const(64));
        f.instruction(&WInst::I32LtS);
        f.instruction(&WInst::If(BlockType::Empty));
        {
            f.instruction(&WInst::LocalGet(m2));
            f.instruction(&WInst::LocalGet(diff));
            f.instruction(&WInst::I64ExtendI32U);
            f.instruction(&WInst::I64ShrU);
            f.instruction(&WInst::LocalSet(m2_hi));

            f.instruction(&WInst::LocalGet(m2));
            f.instruction(&WInst::I32Const(64));
            f.instruction(&WInst::LocalGet(diff));
            f.instruction(&WInst::I32Sub);
            f.instruction(&WInst::I64ExtendI32U);
            f.instruction(&WInst::I64Shl);
            f.instruction(&WInst::LocalSet(m2_lo));
        }
        f.instruction(&WInst::Else);
        {
            f.instruction(&WInst::I64Const(0));
            f.instruction(&WInst::LocalSet(m2_hi));
            f.instruction(&WInst::LocalGet(diff));
            f.instruction(&WInst::I32Const(64));
            f.instruction(&WInst::I32Eq);
            f.instruction(&WInst::If(BlockType::Empty));
            {
                f.instruction(&WInst::LocalGet(m2));
                f.instruction(&WInst::LocalSet(m2_lo));
            }
            f.instruction(&WInst::Else);
            {
                f.instruction(&WInst::I64Const(1));
                f.instruction(&WInst::LocalSet(m2_lo));
            }
            f.instruction(&WInst::End);
        }
        f.instruction(&WInst::End);
    }
    f.instruction(&WInst::End);

    // Same sign vs opposite sign
    f.instruction(&WInst::LocalGet(s1));
    f.instruction(&WInst::LocalGet(s2));
    f.instruction(&WInst::I32Eq);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        // Addition
        f.instruction(&WInst::LocalGet(m1));
        f.instruction(&WInst::LocalGet(m2_hi));
        f.instruction(&WInst::I64Add);
        f.instruction(&WInst::LocalTee(sum));
        f.instruction(&WInst::LocalGet(m1));
        f.instruction(&WInst::I64LtU);
        f.instruction(&WInst::If(BlockType::Empty));
        {
            // Carry out: shift (1, sum, m2_lo) right by 1
            f.instruction(&WInst::LocalGet(sum));
            f.instruction(&WInst::I64Const(63));
            f.instruction(&WInst::I64Shl);
            f.instruction(&WInst::LocalGet(m2_lo));
            f.instruction(&WInst::I64Const(1));
            f.instruction(&WInst::I64ShrU);
            f.instruction(&WInst::I64Or);
            f.instruction(&WInst::LocalGet(m2_lo));
            f.instruction(&WInst::I64Const(1));
            f.instruction(&WInst::I64And);
            f.instruction(&WInst::I64Or);
            f.instruction(&WInst::LocalSet(m2_lo));

            f.instruction(&WInst::I64Const(0x8000_0000_0000_0000u64 as i64));
            f.instruction(&WInst::LocalGet(sum));
            f.instruction(&WInst::I64Const(1));
            f.instruction(&WInst::I64ShrU);
            f.instruction(&WInst::I64Or);
            f.instruction(&WInst::LocalSet(sum));

            f.instruction(&WInst::LocalGet(e1));
            f.instruction(&WInst::I32Const(1));
            f.instruction(&WInst::I32Add);
            f.instruction(&WInst::LocalSet(e1));
        }
        f.instruction(&WInst::End);

        f.instruction(&WInst::LocalGet(s1));
        f.instruction(&WInst::LocalGet(e1));
        f.instruction(&WInst::LocalGet(sum));
        f.instruction(&WInst::LocalGet(m2_lo));
        f.instruction(&WInst::Call(helper_base + X87_FN_ROUND_PACK));
        f.instruction(&WInst::Return);
    }
    f.instruction(&WInst::Else);
    {
        // Subtraction: (m1, 0) - (m2_hi, m2_lo)
        f.instruction(&WInst::I64Const(0));
        f.instruction(&WInst::LocalGet(m2_lo));
        f.instruction(&WInst::I64Sub);
        f.instruction(&WInst::LocalSet(res_lo));

        f.instruction(&WInst::LocalGet(m1));
        f.instruction(&WInst::LocalGet(m2_hi));
        f.instruction(&WInst::I64Sub);
        f.instruction(&WInst::LocalGet(m2_lo));
        f.instruction(&WInst::I64Const(0));
        f.instruction(&WInst::I64Ne);
        f.instruction(&WInst::I64ExtendI32U);
        f.instruction(&WInst::I64Sub);
        f.instruction(&WInst::LocalSet(res_hi));

        // Exact cancellation?
        f.instruction(&WInst::LocalGet(res_hi));
        f.instruction(&WInst::I64Eqz);
        f.instruction(&WInst::LocalGet(res_lo));
        f.instruction(&WInst::I64Eqz);
        f.instruction(&WInst::I32And);
        f.instruction(&WInst::If(BlockType::Empty));
        {
            f.instruction(&WInst::I64Const(0));
            f.instruction(&WInst::GlobalGet(GLOBAL_X87_CW));
            f.instruction(&WInst::I32Const(10));
            f.instruction(&WInst::I32ShrU);
            f.instruction(&WInst::I32Const(3));
            f.instruction(&WInst::I32And);
            f.instruction(&WInst::I32Const(1));
            f.instruction(&WInst::I32Eq);
            f.instruction(&WInst::If(BlockType::Result(ValType::I32)));
            {
                f.instruction(&WInst::I32Const(0x8000));
            }
            f.instruction(&WInst::Else);
            {
                f.instruction(&WInst::I32Const(0));
            }
            f.instruction(&WInst::End);
            f.instruction(&WInst::Return);
        }
        f.instruction(&WInst::End);

        // Normalize (res_hi, res_lo)
        f.instruction(&WInst::LocalGet(res_hi));
        f.instruction(&WInst::I64Eqz);
        f.instruction(&WInst::If(BlockType::Empty));
        {
            f.instruction(&WInst::LocalGet(res_lo));
            f.instruction(&WInst::LocalSet(res_hi));
            f.instruction(&WInst::I64Const(0));
            f.instruction(&WInst::LocalSet(res_lo));
            f.instruction(&WInst::LocalGet(e1));
            f.instruction(&WInst::I32Const(64));
            f.instruction(&WInst::I32Sub);
            f.instruction(&WInst::LocalSet(e1));
        }
        f.instruction(&WInst::End);

        f.instruction(&WInst::LocalGet(res_hi));
        f.instruction(&WInst::I64Clz);
        f.instruction(&WInst::I32WrapI64);
        f.instruction(&WInst::LocalTee(lz));
        f.instruction(&WInst::I32Const(0));
        f.instruction(&WInst::I32Ne);
        f.instruction(&WInst::If(BlockType::Empty));
        {
            f.instruction(&WInst::LocalGet(res_hi));
            f.instruction(&WInst::LocalGet(lz));
            f.instruction(&WInst::I64ExtendI32U);
            f.instruction(&WInst::I64Shl);
            f.instruction(&WInst::LocalGet(res_lo));
            f.instruction(&WInst::I32Const(64));
            f.instruction(&WInst::LocalGet(lz));
            f.instruction(&WInst::I32Sub);
            f.instruction(&WInst::I64ExtendI32U);
            f.instruction(&WInst::I64ShrU);
            f.instruction(&WInst::I64Or);
            f.instruction(&WInst::LocalSet(res_hi));

            f.instruction(&WInst::LocalGet(res_lo));
            f.instruction(&WInst::LocalGet(lz));
            f.instruction(&WInst::I64ExtendI32U);
            f.instruction(&WInst::I64Shl);
            f.instruction(&WInst::LocalSet(res_lo));

            f.instruction(&WInst::LocalGet(e1));
            f.instruction(&WInst::LocalGet(lz));
            f.instruction(&WInst::I32Sub);
            f.instruction(&WInst::LocalSet(e1));
        }
        f.instruction(&WInst::End);

        f.instruction(&WInst::LocalGet(s1));
        f.instruction(&WInst::LocalGet(e1));
        f.instruction(&WInst::LocalGet(res_hi));
        f.instruction(&WInst::LocalGet(res_lo));
        f.instruction(&WInst::Call(helper_base + X87_FN_ROUND_PACK));
        f.instruction(&WInst::Return);
    }
    f.instruction(&WInst::End);

    f.instruction(&WInst::Unreachable);
    f.instruction(&WInst::End);
    f
}

/// 6: f80_mul(m1: i64, se1: i32, m2: i64, se2: i32) -> (mant: i64, se: i32)
fn emit_f80_mul(helper_base: u32) -> Function {
    // params: 0: m1 (i64), 1: se1 (i32), 2: m2 (i64), 3: se2 (i32)
    // locals: 4..14 (11 i64): a0, a1, b0, b1, p00, p01, p10, p11, mid, hi, lo
    //         15..19 (5 i32): sign, e1, e2, lz, exp
    let mut f = Function::new([(11, ValType::I64), (5, ValType::I32)]);
    let m1 = 0;
    let se1 = 1;
    let m2 = 2;
    let se2 = 3;
    let a0 = 4;
    let a1 = 5;
    let b0 = 6;
    let b1 = 7;
    let p00 = 8;
    let p01 = 9;
    let p10 = 10;
    let p11 = 11;
    let mid = 12;
    let hi = 13;
    let lo = 14;
    let sign = 15;
    let e1 = 16;
    let e2 = 17;
    let lz = 18;
    let exp = 19;

    f.instruction(&WInst::LocalGet(se1));
    f.instruction(&WInst::LocalGet(se2));
    f.instruction(&WInst::I32Xor);
    f.instruction(&WInst::I32Const(0x8000));
    f.instruction(&WInst::I32And);
    f.instruction(&WInst::LocalSet(sign));

    f.instruction(&WInst::LocalGet(se1));
    f.instruction(&WInst::I32Const(0x7FFF));
    f.instruction(&WInst::I32And);
    f.instruction(&WInst::LocalSet(e1));

    f.instruction(&WInst::LocalGet(se2));
    f.instruction(&WInst::I32Const(0x7FFF));
    f.instruction(&WInst::I32And);
    f.instruction(&WInst::LocalSet(e2));

    // NaN checks
    f.instruction(&WInst::LocalGet(e1));
    f.instruction(&WInst::I32Const(0x7FFF));
    f.instruction(&WInst::I32Eq);
    f.instruction(&WInst::LocalGet(m1));
    f.instruction(&WInst::I64Const(0x7FFF_FFFF_FFFF_FFFFu64 as i64));
    f.instruction(&WInst::I64And);
    f.instruction(&WInst::I64Const(0));
    f.instruction(&WInst::I64Ne);
    f.instruction(&WInst::I32And);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::LocalGet(m1));
        f.instruction(&WInst::I64Const(0xC000_0000_0000_0000u64 as i64));
        f.instruction(&WInst::I64Or);
        f.instruction(&WInst::LocalGet(se1));
        f.instruction(&WInst::Return);
    }
    f.instruction(&WInst::End);

    f.instruction(&WInst::LocalGet(e2));
    f.instruction(&WInst::I32Const(0x7FFF));
    f.instruction(&WInst::I32Eq);
    f.instruction(&WInst::LocalGet(m2));
    f.instruction(&WInst::I64Const(0x7FFF_FFFF_FFFF_FFFFu64 as i64));
    f.instruction(&WInst::I64And);
    f.instruction(&WInst::I64Const(0));
    f.instruction(&WInst::I64Ne);
    f.instruction(&WInst::I32And);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::LocalGet(m2));
        f.instruction(&WInst::I64Const(0xC000_0000_0000_0000u64 as i64));
        f.instruction(&WInst::I64Or);
        f.instruction(&WInst::LocalGet(se2));
        f.instruction(&WInst::Return);
    }
    f.instruction(&WInst::End);

    // Inf checks
    f.instruction(&WInst::LocalGet(e1));
    f.instruction(&WInst::I32Const(0x7FFF));
    f.instruction(&WInst::I32Eq);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::LocalGet(m2));
        f.instruction(&WInst::I64Eqz);
        f.instruction(&WInst::If(BlockType::Empty));
        {
            f.instruction(&WInst::I64Const(0xC000_0000_0000_0000u64 as i64));
            f.instruction(&WInst::I32Const(0xFFFF));
            f.instruction(&WInst::Return);
        }
        f.instruction(&WInst::End);
        f.instruction(&WInst::I64Const(0x8000_0000_0000_0000u64 as i64));
        f.instruction(&WInst::LocalGet(sign));
        f.instruction(&WInst::I32Const(0x7FFF));
        f.instruction(&WInst::I32Or);
        f.instruction(&WInst::Return);
    }
    f.instruction(&WInst::End);

    f.instruction(&WInst::LocalGet(e2));
    f.instruction(&WInst::I32Const(0x7FFF));
    f.instruction(&WInst::I32Eq);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::LocalGet(m1));
        f.instruction(&WInst::I64Eqz);
        f.instruction(&WInst::If(BlockType::Empty));
        {
            f.instruction(&WInst::I64Const(0xC000_0000_0000_0000u64 as i64));
            f.instruction(&WInst::I32Const(0xFFFF));
            f.instruction(&WInst::Return);
        }
        f.instruction(&WInst::End);
        f.instruction(&WInst::I64Const(0x8000_0000_0000_0000u64 as i64));
        f.instruction(&WInst::LocalGet(sign));
        f.instruction(&WInst::I32Const(0x7FFF));
        f.instruction(&WInst::I32Or);
        f.instruction(&WInst::Return);
    }
    f.instruction(&WInst::End);

    // Zero checks
    f.instruction(&WInst::LocalGet(m1));
    f.instruction(&WInst::I64Eqz);
    f.instruction(&WInst::LocalGet(m2));
    f.instruction(&WInst::I64Eqz);
    f.instruction(&WInst::I32Or);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::I64Const(0));
        f.instruction(&WInst::LocalGet(sign));
        f.instruction(&WInst::Return);
    }
    f.instruction(&WInst::End);

    // Normalize m1, m2
    f.instruction(&WInst::LocalGet(m1));
    f.instruction(&WInst::I64Clz);
    f.instruction(&WInst::I32WrapI64);
    f.instruction(&WInst::LocalSet(lz));
    f.instruction(&WInst::LocalGet(m1));
    f.instruction(&WInst::LocalGet(lz));
    f.instruction(&WInst::I64ExtendI32U);
    f.instruction(&WInst::I64Shl);
    f.instruction(&WInst::LocalSet(m1));
    f.instruction(&WInst::LocalGet(e1));
    f.instruction(&WInst::I32Eqz);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::I32Const(1));
        f.instruction(&WInst::LocalSet(e1));
    }
    f.instruction(&WInst::End);
    f.instruction(&WInst::LocalGet(e1));
    f.instruction(&WInst::LocalGet(lz));
    f.instruction(&WInst::I32Sub);
    f.instruction(&WInst::LocalSet(e1));

    f.instruction(&WInst::LocalGet(m2));
    f.instruction(&WInst::I64Clz);
    f.instruction(&WInst::I32WrapI64);
    f.instruction(&WInst::LocalSet(lz));
    f.instruction(&WInst::LocalGet(m2));
    f.instruction(&WInst::LocalGet(lz));
    f.instruction(&WInst::I64ExtendI32U);
    f.instruction(&WInst::I64Shl);
    f.instruction(&WInst::LocalSet(m2));
    f.instruction(&WInst::LocalGet(e2));
    f.instruction(&WInst::I32Eqz);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::I32Const(1));
        f.instruction(&WInst::LocalSet(e2));
    }
    f.instruction(&WInst::End);
    f.instruction(&WInst::LocalGet(e2));
    f.instruction(&WInst::LocalGet(lz));
    f.instruction(&WInst::I32Sub);
    f.instruction(&WInst::LocalSet(e2));

    // exp = e1 + e2 - 16382
    f.instruction(&WInst::LocalGet(e1));
    f.instruction(&WInst::LocalGet(e2));
    f.instruction(&WInst::I32Add);
    f.instruction(&WInst::I32Const(16382));
    f.instruction(&WInst::I32Sub);
    f.instruction(&WInst::LocalSet(exp));

    // 64x64 -> 128 unsigned multiply
    f.instruction(&WInst::LocalGet(m1));
    f.instruction(&WInst::I64Const(0xFFFF_FFFF));
    f.instruction(&WInst::I64And);
    f.instruction(&WInst::LocalSet(a0));
    f.instruction(&WInst::LocalGet(m1));
    f.instruction(&WInst::I64Const(32));
    f.instruction(&WInst::I64ShrU);
    f.instruction(&WInst::LocalSet(a1));

    f.instruction(&WInst::LocalGet(m2));
    f.instruction(&WInst::I64Const(0xFFFF_FFFF));
    f.instruction(&WInst::I64And);
    f.instruction(&WInst::LocalSet(b0));
    f.instruction(&WInst::LocalGet(m2));
    f.instruction(&WInst::I64Const(32));
    f.instruction(&WInst::I64ShrU);
    f.instruction(&WInst::LocalSet(b1));

    f.instruction(&WInst::LocalGet(a0));
    f.instruction(&WInst::LocalGet(b0));
    f.instruction(&WInst::I64Mul);
    f.instruction(&WInst::LocalSet(p00));

    f.instruction(&WInst::LocalGet(a0));
    f.instruction(&WInst::LocalGet(b1));
    f.instruction(&WInst::I64Mul);
    f.instruction(&WInst::LocalSet(p01));

    f.instruction(&WInst::LocalGet(a1));
    f.instruction(&WInst::LocalGet(b0));
    f.instruction(&WInst::I64Mul);
    f.instruction(&WInst::LocalSet(p10));

    f.instruction(&WInst::LocalGet(a1));
    f.instruction(&WInst::LocalGet(b1));
    f.instruction(&WInst::I64Mul);
    f.instruction(&WInst::LocalSet(p11));

    // mid = (p00 >>> 32) + (p01 & 0xFFFF_FFFF) + (p10 & 0xFFFF_FFFF)
    f.instruction(&WInst::LocalGet(p00));
    f.instruction(&WInst::I64Const(32));
    f.instruction(&WInst::I64ShrU);
    f.instruction(&WInst::LocalGet(p01));
    f.instruction(&WInst::I64Const(0xFFFF_FFFF));
    f.instruction(&WInst::I64And);
    f.instruction(&WInst::I64Add);
    f.instruction(&WInst::LocalGet(p10));
    f.instruction(&WInst::I64Const(0xFFFF_FFFF));
    f.instruction(&WInst::I64And);
    f.instruction(&WInst::I64Add);
    f.instruction(&WInst::LocalSet(mid));

    // lo = (p00 & 0xFFFF_FFFF) | (mid << 32)
    f.instruction(&WInst::LocalGet(p00));
    f.instruction(&WInst::I64Const(0xFFFF_FFFF));
    f.instruction(&WInst::I64And);
    f.instruction(&WInst::LocalGet(mid));
    f.instruction(&WInst::I64Const(32));
    f.instruction(&WInst::I64Shl);
    f.instruction(&WInst::I64Or);
    f.instruction(&WInst::LocalSet(lo));

    // hi = p11 + (p01 >>> 32) + (p10 >>> 32) + (mid >>> 32)
    f.instruction(&WInst::LocalGet(p11));
    f.instruction(&WInst::LocalGet(p01));
    f.instruction(&WInst::I64Const(32));
    f.instruction(&WInst::I64ShrU);
    f.instruction(&WInst::I64Add);
    f.instruction(&WInst::LocalGet(p10));
    f.instruction(&WInst::I64Const(32));
    f.instruction(&WInst::I64ShrU);
    f.instruction(&WInst::I64Add);
    f.instruction(&WInst::LocalGet(mid));
    f.instruction(&WInst::I64Const(32));
    f.instruction(&WInst::I64ShrU);
    f.instruction(&WInst::I64Add);
    f.instruction(&WInst::LocalTee(hi));

    // Normalize if bit 63 of hi is 0
    f.instruction(&WInst::I64Const(63));
    f.instruction(&WInst::I64ShrU);
    f.instruction(&WInst::I64Eqz);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::LocalGet(hi));
        f.instruction(&WInst::I64Const(1));
        f.instruction(&WInst::I64Shl);
        f.instruction(&WInst::LocalGet(lo));
        f.instruction(&WInst::I64Const(63));
        f.instruction(&WInst::I64ShrU);
        f.instruction(&WInst::I64Or);
        f.instruction(&WInst::LocalSet(hi));

        f.instruction(&WInst::LocalGet(lo));
        f.instruction(&WInst::I64Const(1));
        f.instruction(&WInst::I64Shl);
        f.instruction(&WInst::LocalSet(lo));

        f.instruction(&WInst::LocalGet(exp));
        f.instruction(&WInst::I32Const(1));
        f.instruction(&WInst::I32Sub);
        f.instruction(&WInst::LocalSet(exp));
    }
    f.instruction(&WInst::End);

    f.instruction(&WInst::LocalGet(sign));
    f.instruction(&WInst::LocalGet(exp));
    f.instruction(&WInst::LocalGet(hi));
    f.instruction(&WInst::LocalGet(lo));
    f.instruction(&WInst::Call(helper_base + X87_FN_ROUND_PACK));
    f.instruction(&WInst::End);
    f
}

/// 7: f80_div(m1: i64, se1: i32, m2: i64, se2: i32) -> (mant: i64, se: i32)
fn emit_f80_div(helper_base: u32) -> Function {
    // params: 0: m1 (i64), 1: se1 (i32), 2: m2 (i64), 3: se2 (i32)
    // locals: 4..6 (3 i64): rem, q, round_word
    //         7..14 (8 i32): sign, e1, e2, lz, exp, i, carry, half
    let mut f = Function::new([(3, ValType::I64), (8, ValType::I32)]);
    let m1 = 0;
    let se1 = 1;
    let m2 = 2;
    let se2 = 3;
    let rem = 4;
    let q = 5;
    let round_word = 6;
    let sign = 7;
    let e1 = 8;
    let e2 = 9;
    let lz = 10;
    let exp = 11;
    let i = 12;
    let carry = 13;
    let half = 14;

    f.instruction(&WInst::LocalGet(se1));
    f.instruction(&WInst::LocalGet(se2));
    f.instruction(&WInst::I32Xor);
    f.instruction(&WInst::I32Const(0x8000));
    f.instruction(&WInst::I32And);
    f.instruction(&WInst::LocalSet(sign));

    f.instruction(&WInst::LocalGet(se1));
    f.instruction(&WInst::I32Const(0x7FFF));
    f.instruction(&WInst::I32And);
    f.instruction(&WInst::LocalSet(e1));

    f.instruction(&WInst::LocalGet(se2));
    f.instruction(&WInst::I32Const(0x7FFF));
    f.instruction(&WInst::I32And);
    f.instruction(&WInst::LocalSet(e2));

    // NaN checks
    f.instruction(&WInst::LocalGet(e1));
    f.instruction(&WInst::I32Const(0x7FFF));
    f.instruction(&WInst::I32Eq);
    f.instruction(&WInst::LocalGet(m1));
    f.instruction(&WInst::I64Const(0x7FFF_FFFF_FFFF_FFFFu64 as i64));
    f.instruction(&WInst::I64And);
    f.instruction(&WInst::I64Const(0));
    f.instruction(&WInst::I64Ne);
    f.instruction(&WInst::I32And);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::LocalGet(m1));
        f.instruction(&WInst::I64Const(0xC000_0000_0000_0000u64 as i64));
        f.instruction(&WInst::I64Or);
        f.instruction(&WInst::LocalGet(se1));
        f.instruction(&WInst::Return);
    }
    f.instruction(&WInst::End);

    f.instruction(&WInst::LocalGet(e2));
    f.instruction(&WInst::I32Const(0x7FFF));
    f.instruction(&WInst::I32Eq);
    f.instruction(&WInst::LocalGet(m2));
    f.instruction(&WInst::I64Const(0x7FFF_FFFF_FFFF_FFFFu64 as i64));
    f.instruction(&WInst::I64And);
    f.instruction(&WInst::I64Const(0));
    f.instruction(&WInst::I64Ne);
    f.instruction(&WInst::I32And);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::LocalGet(m2));
        f.instruction(&WInst::I64Const(0xC000_0000_0000_0000u64 as i64));
        f.instruction(&WInst::I64Or);
        f.instruction(&WInst::LocalGet(se2));
        f.instruction(&WInst::Return);
    }
    f.instruction(&WInst::End);

    // Inf / Zero special cases
    f.instruction(&WInst::LocalGet(e1));
    f.instruction(&WInst::I32Const(0x7FFF));
    f.instruction(&WInst::I32Eq);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::LocalGet(e2));
        f.instruction(&WInst::I32Const(0x7FFF));
        f.instruction(&WInst::I32Eq);
        f.instruction(&WInst::If(BlockType::Empty));
        {
            f.instruction(&WInst::I64Const(0xC000_0000_0000_0000u64 as i64));
            f.instruction(&WInst::I32Const(0xFFFF));
            f.instruction(&WInst::Return);
        }
        f.instruction(&WInst::End);
        f.instruction(&WInst::I64Const(0x8000_0000_0000_0000u64 as i64));
        f.instruction(&WInst::LocalGet(sign));
        f.instruction(&WInst::I32Const(0x7FFF));
        f.instruction(&WInst::I32Or);
        f.instruction(&WInst::Return);
    }
    f.instruction(&WInst::End);

    f.instruction(&WInst::LocalGet(e2));
    f.instruction(&WInst::I32Const(0x7FFF));
    f.instruction(&WInst::I32Eq);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::I64Const(0));
        f.instruction(&WInst::LocalGet(sign));
        f.instruction(&WInst::Return);
    }
    f.instruction(&WInst::End);

    f.instruction(&WInst::LocalGet(m2));
    f.instruction(&WInst::I64Eqz);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::LocalGet(m1));
        f.instruction(&WInst::I64Eqz);
        f.instruction(&WInst::If(BlockType::Empty));
        {
            f.instruction(&WInst::I64Const(0xC000_0000_0000_0000u64 as i64));
            f.instruction(&WInst::I32Const(0xFFFF));
            f.instruction(&WInst::Return);
        }
        f.instruction(&WInst::End);
        f.instruction(&WInst::I64Const(0x8000_0000_0000_0000u64 as i64));
        f.instruction(&WInst::LocalGet(sign));
        f.instruction(&WInst::I32Const(0x7FFF));
        f.instruction(&WInst::I32Or);
        f.instruction(&WInst::Return);
    }
    f.instruction(&WInst::End);

    f.instruction(&WInst::LocalGet(m1));
    f.instruction(&WInst::I64Eqz);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::I64Const(0));
        f.instruction(&WInst::LocalGet(sign));
        f.instruction(&WInst::Return);
    }
    f.instruction(&WInst::End);

    // Normalize m1, m2
    f.instruction(&WInst::LocalGet(m1));
    f.instruction(&WInst::I64Clz);
    f.instruction(&WInst::I32WrapI64);
    f.instruction(&WInst::LocalSet(lz));
    f.instruction(&WInst::LocalGet(m1));
    f.instruction(&WInst::LocalGet(lz));
    f.instruction(&WInst::I64ExtendI32U);
    f.instruction(&WInst::I64Shl);
    f.instruction(&WInst::LocalSet(m1));
    f.instruction(&WInst::LocalGet(e1));
    f.instruction(&WInst::I32Eqz);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::I32Const(1));
        f.instruction(&WInst::LocalSet(e1));
    }
    f.instruction(&WInst::End);
    f.instruction(&WInst::LocalGet(e1));
    f.instruction(&WInst::LocalGet(lz));
    f.instruction(&WInst::I32Sub);
    f.instruction(&WInst::LocalSet(e1));

    f.instruction(&WInst::LocalGet(m2));
    f.instruction(&WInst::I64Clz);
    f.instruction(&WInst::I32WrapI64);
    f.instruction(&WInst::LocalSet(lz));
    f.instruction(&WInst::LocalGet(m2));
    f.instruction(&WInst::LocalGet(lz));
    f.instruction(&WInst::I64ExtendI32U);
    f.instruction(&WInst::I64Shl);
    f.instruction(&WInst::LocalSet(m2));
    f.instruction(&WInst::LocalGet(e2));
    f.instruction(&WInst::I32Eqz);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::I32Const(1));
        f.instruction(&WInst::LocalSet(e2));
    }
    f.instruction(&WInst::End);
    f.instruction(&WInst::LocalGet(e2));
    f.instruction(&WInst::LocalGet(lz));
    f.instruction(&WInst::I32Sub);
    f.instruction(&WInst::LocalSet(e2));

    // exp = e1 - e2 + 16383
    f.instruction(&WInst::LocalGet(e1));
    f.instruction(&WInst::LocalGet(e2));
    f.instruction(&WInst::I32Sub);
    f.instruction(&WInst::I32Const(16383));
    f.instruction(&WInst::I32Add);
    f.instruction(&WInst::LocalSet(exp));

    // First quotient bit is always 1:
    // If m1 >= m2: rem = m1 - m2
    // Else: exp -= 1; rem = (m1 << 1) - m2
    f.instruction(&WInst::I64Const(1));
    f.instruction(&WInst::LocalSet(q));
    f.instruction(&WInst::LocalGet(m1));
    f.instruction(&WInst::LocalGet(m2));
    f.instruction(&WInst::I64GeU);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::LocalGet(m1));
        f.instruction(&WInst::LocalGet(m2));
        f.instruction(&WInst::I64Sub);
        f.instruction(&WInst::LocalSet(rem));
    }
    f.instruction(&WInst::Else);
    {
        f.instruction(&WInst::LocalGet(exp));
        f.instruction(&WInst::I32Const(1));
        f.instruction(&WInst::I32Sub);
        f.instruction(&WInst::LocalSet(exp));

        f.instruction(&WInst::LocalGet(m1));
        f.instruction(&WInst::I64Const(1));
        f.instruction(&WInst::I64Shl);
        f.instruction(&WInst::LocalGet(m2));
        f.instruction(&WInst::I64Sub);
        f.instruction(&WInst::LocalSet(rem));
    }
    f.instruction(&WInst::End);

    // 63 restoring division iterations
    f.instruction(&WInst::I32Const(63));
    f.instruction(&WInst::LocalSet(i));
    f.instruction(&WInst::Loop(BlockType::Empty));
    {
        f.instruction(&WInst::LocalGet(rem));
        f.instruction(&WInst::I64Const(63));
        f.instruction(&WInst::I64ShrU);
        f.instruction(&WInst::I32WrapI64);
        f.instruction(&WInst::LocalSet(carry));

        f.instruction(&WInst::LocalGet(rem));
        f.instruction(&WInst::I64Const(1));
        f.instruction(&WInst::I64Shl);
        f.instruction(&WInst::LocalSet(rem));

        f.instruction(&WInst::LocalGet(q));
        f.instruction(&WInst::I64Const(1));
        f.instruction(&WInst::I64Shl);
        f.instruction(&WInst::LocalSet(q));

        f.instruction(&WInst::LocalGet(carry));
        f.instruction(&WInst::LocalGet(rem));
        f.instruction(&WInst::LocalGet(m2));
        f.instruction(&WInst::I64GeU);
        f.instruction(&WInst::I32Or);
        f.instruction(&WInst::If(BlockType::Empty));
        {
            f.instruction(&WInst::LocalGet(rem));
            f.instruction(&WInst::LocalGet(m2));
            f.instruction(&WInst::I64Sub);
            f.instruction(&WInst::LocalSet(rem));

            f.instruction(&WInst::LocalGet(q));
            f.instruction(&WInst::I64Const(1));
            f.instruction(&WInst::I64Or);
            f.instruction(&WInst::LocalSet(q));
        }
        f.instruction(&WInst::End);

        f.instruction(&WInst::LocalGet(i));
        f.instruction(&WInst::I32Const(1));
        f.instruction(&WInst::I32Sub);
        f.instruction(&WInst::LocalTee(i));
        f.instruction(&WInst::BrIf(0));
    }
    f.instruction(&WInst::End);

    // Compute half & sticky from remaining rem
    f.instruction(&WInst::LocalGet(rem));
    f.instruction(&WInst::I64Const(63));
    f.instruction(&WInst::I64ShrU);
    f.instruction(&WInst::I32WrapI64);
    f.instruction(&WInst::LocalSet(carry));

    f.instruction(&WInst::LocalGet(rem));
    f.instruction(&WInst::I64Const(1));
    f.instruction(&WInst::I64Shl);
    f.instruction(&WInst::LocalSet(rem));

    f.instruction(&WInst::LocalGet(carry));
    f.instruction(&WInst::LocalGet(rem));
    f.instruction(&WInst::LocalGet(m2));
    f.instruction(&WInst::I64GeU);
    f.instruction(&WInst::I32Or);
    f.instruction(&WInst::LocalTee(half));
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::LocalGet(rem));
        f.instruction(&WInst::LocalGet(m2));
        f.instruction(&WInst::I64Sub);
        f.instruction(&WInst::LocalSet(rem));
    }
    f.instruction(&WInst::End);

    f.instruction(&WInst::LocalGet(half));
    f.instruction(&WInst::I64ExtendI32U);
    f.instruction(&WInst::I64Const(63));
    f.instruction(&WInst::I64Shl);
    f.instruction(&WInst::LocalGet(rem));
    f.instruction(&WInst::I64Const(0));
    f.instruction(&WInst::I64Ne);
    f.instruction(&WInst::I64ExtendI32U);
    f.instruction(&WInst::I64Or);
    f.instruction(&WInst::LocalSet(round_word));

    f.instruction(&WInst::LocalGet(sign));
    f.instruction(&WInst::LocalGet(exp));
    f.instruction(&WInst::LocalGet(q));
    f.instruction(&WInst::LocalGet(round_word));
    f.instruction(&WInst::Call(helper_base + X87_FN_ROUND_PACK));
    f.instruction(&WInst::End);
    f
}

/// 8: f80_cmp(m1: i64, se1: i32, m2: i64, se2: i32) -> i32
/// Returns: 0 (eq), 1 (lt), 2 (gt), 3 (unordered/NaN).
fn emit_f80_cmp() -> Function {
    // params: 0: m1 (i64), 1: se1 (i32), 2: m2 (i64), 3: se2 (i32)
    // locals: 4..8 (5 i32): s1, e1, s2, e2, lz
    let mut f = Function::new([(5, ValType::I32)]);
    let m1 = 0;
    let se1 = 1;
    let m2 = 2;
    let se2 = 3;
    let s1 = 4;
    let e1 = 5;
    let s2 = 6;
    let e2 = 7;
    let lz = 8;

    f.instruction(&WInst::LocalGet(se1));
    f.instruction(&WInst::I32Const(0x8000));
    f.instruction(&WInst::I32And);
    f.instruction(&WInst::LocalSet(s1));
    f.instruction(&WInst::LocalGet(se1));
    f.instruction(&WInst::I32Const(0x7FFF));
    f.instruction(&WInst::I32And);
    f.instruction(&WInst::LocalSet(e1));

    f.instruction(&WInst::LocalGet(se2));
    f.instruction(&WInst::I32Const(0x8000));
    f.instruction(&WInst::I32And);
    f.instruction(&WInst::LocalSet(s2));
    f.instruction(&WInst::LocalGet(se2));
    f.instruction(&WInst::I32Const(0x7FFF));
    f.instruction(&WInst::I32And);
    f.instruction(&WInst::LocalSet(e2));

    // NaN check
    f.instruction(&WInst::LocalGet(e1));
    f.instruction(&WInst::I32Const(0x7FFF));
    f.instruction(&WInst::I32Eq);
    f.instruction(&WInst::LocalGet(m1));
    f.instruction(&WInst::I64Const(0x7FFF_FFFF_FFFF_FFFFu64 as i64));
    f.instruction(&WInst::I64And);
    f.instruction(&WInst::I64Const(0));
    f.instruction(&WInst::I64Ne);
    f.instruction(&WInst::I32And);
    f.instruction(&WInst::LocalGet(e2));
    f.instruction(&WInst::I32Const(0x7FFF));
    f.instruction(&WInst::I32Eq);
    f.instruction(&WInst::LocalGet(m2));
    f.instruction(&WInst::I64Const(0x7FFF_FFFF_FFFF_FFFFu64 as i64));
    f.instruction(&WInst::I64And);
    f.instruction(&WInst::I64Const(0));
    f.instruction(&WInst::I64Ne);
    f.instruction(&WInst::I32And);
    f.instruction(&WInst::I32Or);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::I32Const(3));
        f.instruction(&WInst::Return);
    }
    f.instruction(&WInst::End);

    // Zero checks
    f.instruction(&WInst::LocalGet(m1));
    f.instruction(&WInst::I64Eqz);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::LocalGet(m2));
        f.instruction(&WInst::I64Eqz);
        f.instruction(&WInst::If(BlockType::Empty));
        {
            f.instruction(&WInst::I32Const(0)); // +0 == -0
            f.instruction(&WInst::Return);
        }
        f.instruction(&WInst::End);
        f.instruction(&WInst::LocalGet(s2));
        f.instruction(&WInst::If(BlockType::Result(ValType::I32)));
        {
            f.instruction(&WInst::I32Const(2)); // 0 > negative
        }
        f.instruction(&WInst::Else);
        {
            f.instruction(&WInst::I32Const(1)); // 0 < positive
        }
        f.instruction(&WInst::End);
        f.instruction(&WInst::Return);
    }
    f.instruction(&WInst::End);

    f.instruction(&WInst::LocalGet(m2));
    f.instruction(&WInst::I64Eqz);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::LocalGet(s1));
        f.instruction(&WInst::If(BlockType::Result(ValType::I32)));
        {
            f.instruction(&WInst::I32Const(1)); // negative < 0
        }
        f.instruction(&WInst::Else);
        {
            f.instruction(&WInst::I32Const(2)); // positive > 0
        }
        f.instruction(&WInst::End);
        f.instruction(&WInst::Return);
    }
    f.instruction(&WInst::End);

    // Opposite signs (both non-zero)
    f.instruction(&WInst::LocalGet(s1));
    f.instruction(&WInst::LocalGet(s2));
    f.instruction(&WInst::I32Ne);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::LocalGet(s1));
        f.instruction(&WInst::If(BlockType::Result(ValType::I32)));
        {
            f.instruction(&WInst::I32Const(1));
        }
        f.instruction(&WInst::Else);
        {
            f.instruction(&WInst::I32Const(2));
        }
        f.instruction(&WInst::End);
        f.instruction(&WInst::Return);
    }
    f.instruction(&WInst::End);

    // Normalize both finite values (Inf keeps e=0x7FFF, m=0x8000...)
    f.instruction(&WInst::LocalGet(e1));
    f.instruction(&WInst::I32Const(0x7FFF));
    f.instruction(&WInst::I32Ne);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::LocalGet(m1));
        f.instruction(&WInst::I64Clz);
        f.instruction(&WInst::I32WrapI64);
        f.instruction(&WInst::LocalSet(lz));
        f.instruction(&WInst::LocalGet(m1));
        f.instruction(&WInst::LocalGet(lz));
        f.instruction(&WInst::I64ExtendI32U);
        f.instruction(&WInst::I64Shl);
        f.instruction(&WInst::LocalSet(m1));
        f.instruction(&WInst::LocalGet(e1));
        f.instruction(&WInst::I32Eqz);
        f.instruction(&WInst::If(BlockType::Empty));
        {
            f.instruction(&WInst::I32Const(1));
            f.instruction(&WInst::LocalSet(e1));
        }
        f.instruction(&WInst::End);
        f.instruction(&WInst::LocalGet(e1));
        f.instruction(&WInst::LocalGet(lz));
        f.instruction(&WInst::I32Sub);
        f.instruction(&WInst::LocalSet(e1));
    }
    f.instruction(&WInst::End);

    f.instruction(&WInst::LocalGet(e2));
    f.instruction(&WInst::I32Const(0x7FFF));
    f.instruction(&WInst::I32Ne);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::LocalGet(m2));
        f.instruction(&WInst::I64Clz);
        f.instruction(&WInst::I32WrapI64);
        f.instruction(&WInst::LocalSet(lz));
        f.instruction(&WInst::LocalGet(m2));
        f.instruction(&WInst::LocalGet(lz));
        f.instruction(&WInst::I64ExtendI32U);
        f.instruction(&WInst::I64Shl);
        f.instruction(&WInst::LocalSet(m2));
        f.instruction(&WInst::LocalGet(e2));
        f.instruction(&WInst::I32Eqz);
        f.instruction(&WInst::If(BlockType::Empty));
        {
            f.instruction(&WInst::I32Const(1));
            f.instruction(&WInst::LocalSet(e2));
        }
        f.instruction(&WInst::End);
        f.instruction(&WInst::LocalGet(e2));
        f.instruction(&WInst::LocalGet(lz));
        f.instruction(&WInst::I32Sub);
        f.instruction(&WInst::LocalSet(e2));
    }
    f.instruction(&WInst::End);

    // Equal?
    f.instruction(&WInst::LocalGet(e1));
    f.instruction(&WInst::LocalGet(e2));
    f.instruction(&WInst::I32Eq);
    f.instruction(&WInst::LocalGet(m1));
    f.instruction(&WInst::LocalGet(m2));
    f.instruction(&WInst::I64Eq);
    f.instruction(&WInst::I32And);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::I32Const(0));
        f.instruction(&WInst::Return);
    }
    f.instruction(&WInst::End);

    // mag_lt = e1 < e2 || (e1 == e2 && m1 <u m2)
    f.instruction(&WInst::LocalGet(e1));
    f.instruction(&WInst::LocalGet(e2));
    f.instruction(&WInst::I32LtS);
    f.instruction(&WInst::LocalGet(e1));
    f.instruction(&WInst::LocalGet(e2));
    f.instruction(&WInst::I32Eq);
    f.instruction(&WInst::LocalGet(m1));
    f.instruction(&WInst::LocalGet(m2));
    f.instruction(&WInst::I64LtU);
    f.instruction(&WInst::I32And);
    f.instruction(&WInst::I32Or);
    f.instruction(&WInst::If(BlockType::Result(ValType::I32)));
    {
        f.instruction(&WInst::LocalGet(s1));
        f.instruction(&WInst::If(BlockType::Result(ValType::I32)));
        {
            f.instruction(&WInst::I32Const(2));
        }
        f.instruction(&WInst::Else);
        {
            f.instruction(&WInst::I32Const(1));
        }
        f.instruction(&WInst::End);
    }
    f.instruction(&WInst::Else);
    {
        f.instruction(&WInst::LocalGet(s1));
        f.instruction(&WInst::If(BlockType::Result(ValType::I32)));
        {
            f.instruction(&WInst::I32Const(1));
        }
        f.instruction(&WInst::Else);
        {
            f.instruction(&WInst::I32Const(2));
        }
        f.instruction(&WInst::End);
    }
    f.instruction(&WInst::End);

    f.instruction(&WInst::End);
    f
}

/// 9: f80_rem(m1: i64, se1: i32, m2: i64, se2: i32, is_ieee: i32) -> (mant: i64, se: i32)
/// Exact 80-bit FPREM / FPREM1; updates GLOBAL_X87_SW C0/C1/C2/C3.
fn emit_f80_rem(helper_base: u32) -> Function {
    // params: 0: m1 (i64), 1: se1 (i32), 2: m2 (i64), 3: se2 (i32), 4: is_ieee (i32)
    // locals: 5..6 (2 i64): rem, rem2
    //         7..16 (10 i32): s1, e1, e2, lz, diff, steps, k, carry, q_low, sw_cc
    let mut f = Function::new([(2, ValType::I64), (10, ValType::I32)]);
    let m1 = 0;
    let se1 = 1;
    let m2 = 2;
    let se2 = 3;
    let is_ieee = 4;
    let rem = 5;
    let rem2 = 6;
    let s1 = 7;
    let e1 = 8;
    let e2 = 9;
    let lz = 10;
    let diff = 11;
    let steps = 12;
    let k = 13;
    let carry = 14;
    let q_low = 15;
    let sw_cc = 16;

    f.instruction(&WInst::LocalGet(se1));
    f.instruction(&WInst::I32Const(0x8000));
    f.instruction(&WInst::I32And);
    f.instruction(&WInst::LocalSet(s1));
    f.instruction(&WInst::LocalGet(se1));
    f.instruction(&WInst::I32Const(0x7FFF));
    f.instruction(&WInst::I32And);
    f.instruction(&WInst::LocalSet(e1));
    f.instruction(&WInst::LocalGet(se2));
    f.instruction(&WInst::I32Const(0x7FFF));
    f.instruction(&WInst::I32And);
    f.instruction(&WInst::LocalSet(e2));

    // Clear C0/C1/C2/C3 in SW by default
    f.instruction(&WInst::GlobalGet(GLOBAL_X87_SW));
    f.instruction(&WInst::I32Const(!0x4700i32 & 0xFFFF));
    f.instruction(&WInst::I32And);
    f.instruction(&WInst::GlobalSet(GLOBAL_X87_SW));

    // NaN / Inf / div-by-zero checks
    f.instruction(&WInst::LocalGet(e1));
    f.instruction(&WInst::I32Const(0x7FFF));
    f.instruction(&WInst::I32Eq);
    f.instruction(&WInst::LocalGet(m2));
    f.instruction(&WInst::I64Eqz);
    f.instruction(&WInst::I32Or);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::I64Const(0xC000_0000_0000_0000u64 as i64));
        f.instruction(&WInst::I32Const(0xFFFF));
        f.instruction(&WInst::Return);
    }
    f.instruction(&WInst::End);

    f.instruction(&WInst::LocalGet(e2));
    f.instruction(&WInst::I32Const(0x7FFF));
    f.instruction(&WInst::I32Eq);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::LocalGet(m2));
        f.instruction(&WInst::I64Const(0x7FFF_FFFF_FFFF_FFFFu64 as i64));
        f.instruction(&WInst::I64And);
        f.instruction(&WInst::I64Const(0));
        f.instruction(&WInst::I64Ne);
        f.instruction(&WInst::If(BlockType::Empty));
        {
            f.instruction(&WInst::LocalGet(m2));
            f.instruction(&WInst::I64Const(0xC000_0000_0000_0000u64 as i64));
            f.instruction(&WInst::I64Or);
            f.instruction(&WInst::LocalGet(se2));
            f.instruction(&WInst::Return);
        }
        f.instruction(&WInst::End);
        f.instruction(&WInst::LocalGet(m1));
        f.instruction(&WInst::LocalGet(se1));
        f.instruction(&WInst::Return);
    }
    f.instruction(&WInst::End);

    f.instruction(&WInst::LocalGet(m1));
    f.instruction(&WInst::I64Eqz);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::I64Const(0));
        f.instruction(&WInst::LocalGet(s1));
        f.instruction(&WInst::Return);
    }
    f.instruction(&WInst::End);

    // Normalize m1, m2
    f.instruction(&WInst::LocalGet(m1));
    f.instruction(&WInst::I64Clz);
    f.instruction(&WInst::I32WrapI64);
    f.instruction(&WInst::LocalSet(lz));
    f.instruction(&WInst::LocalGet(m1));
    f.instruction(&WInst::LocalGet(lz));
    f.instruction(&WInst::I64ExtendI32U);
    f.instruction(&WInst::I64Shl);
    f.instruction(&WInst::LocalSet(m1));
    f.instruction(&WInst::LocalGet(e1));
    f.instruction(&WInst::I32Eqz);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::I32Const(1));
        f.instruction(&WInst::LocalSet(e1));
    }
    f.instruction(&WInst::End);
    f.instruction(&WInst::LocalGet(e1));
    f.instruction(&WInst::LocalGet(lz));
    f.instruction(&WInst::I32Sub);
    f.instruction(&WInst::LocalSet(e1));

    f.instruction(&WInst::LocalGet(m2));
    f.instruction(&WInst::I64Clz);
    f.instruction(&WInst::I32WrapI64);
    f.instruction(&WInst::LocalSet(lz));
    f.instruction(&WInst::LocalGet(m2));
    f.instruction(&WInst::LocalGet(lz));
    f.instruction(&WInst::I64ExtendI32U);
    f.instruction(&WInst::I64Shl);
    f.instruction(&WInst::LocalSet(m2));
    f.instruction(&WInst::LocalGet(e2));
    f.instruction(&WInst::I32Eqz);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::I32Const(1));
        f.instruction(&WInst::LocalSet(e2));
    }
    f.instruction(&WInst::End);
    f.instruction(&WInst::LocalGet(e2));
    f.instruction(&WInst::LocalGet(lz));
    f.instruction(&WInst::I32Sub);
    f.instruction(&WInst::LocalSet(e2));

    // diff = e1 - e2
    f.instruction(&WInst::LocalGet(e1));
    f.instruction(&WInst::LocalGet(e2));
    f.instruction(&WInst::I32Sub);
    f.instruction(&WInst::LocalTee(diff));
    f.instruction(&WInst::I32Const(0));
    f.instruction(&WInst::I32LtS);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        // |a| < |b|
        f.instruction(&WInst::LocalGet(is_ieee));
        f.instruction(&WInst::LocalGet(diff));
        f.instruction(&WInst::I32Const(-1));
        f.instruction(&WInst::I32Eq);
        f.instruction(&WInst::I32And);
        f.instruction(&WInst::LocalGet(m1));
        f.instruction(&WInst::LocalGet(m2));
        f.instruction(&WInst::I64GtU);
        f.instruction(&WInst::I32And);
        f.instruction(&WInst::If(BlockType::Empty));
        {
            // IEEE remainder: |a| > |b|/2 -> rem = -(b - a), q = 1 (C1=1)
            f.instruction(&WInst::GlobalGet(GLOBAL_X87_SW));
            f.instruction(&WInst::I32Const(0x0200));
            f.instruction(&WInst::I32Or);
            f.instruction(&WInst::GlobalSet(GLOBAL_X87_SW));
            f.instruction(&WInst::LocalGet(m1));
            f.instruction(&WInst::LocalGet(se1));
            f.instruction(&WInst::LocalGet(m2));
            f.instruction(&WInst::LocalGet(s1));
            f.instruction(&WInst::I32Const(0x8000));
            f.instruction(&WInst::I32Xor);
            f.instruction(&WInst::LocalGet(e2));
            f.instruction(&WInst::I32Or);
            f.instruction(&WInst::Call(helper_base + X87_FN_F80_ADD));
            f.instruction(&WInst::Return);
        }
        f.instruction(&WInst::End);
        f.instruction(&WInst::LocalGet(m1));
        f.instruction(&WInst::LocalGet(se1));
        f.instruction(&WInst::Return);
    }
    f.instruction(&WInst::End);

    // steps = min(diff, 63)
    f.instruction(&WInst::LocalGet(diff));
    f.instruction(&WInst::I32Const(63));
    f.instruction(&WInst::I32GtS);
    f.instruction(&WInst::If(BlockType::Result(ValType::I32)));
    {
        f.instruction(&WInst::I32Const(63));
    }
    f.instruction(&WInst::Else);
    {
        f.instruction(&WInst::LocalGet(diff));
    }
    f.instruction(&WInst::End);
    f.instruction(&WInst::LocalSet(steps));

    f.instruction(&WInst::LocalGet(m1));
    f.instruction(&WInst::LocalSet(rem));
    f.instruction(&WInst::I32Const(0));
    f.instruction(&WInst::LocalSet(q_low));
    f.instruction(&WInst::I32Const(0));
    f.instruction(&WInst::LocalSet(carry));
    f.instruction(&WInst::I32Const(0));
    f.instruction(&WInst::LocalSet(k));

    f.instruction(&WInst::Loop(BlockType::Empty));
    {
        f.instruction(&WInst::LocalGet(q_low));
        f.instruction(&WInst::I32Const(1));
        f.instruction(&WInst::I32Shl);
        f.instruction(&WInst::I32Const(7));
        f.instruction(&WInst::I32And);
        f.instruction(&WInst::LocalSet(q_low));

        f.instruction(&WInst::LocalGet(carry));
        f.instruction(&WInst::LocalGet(rem));
        f.instruction(&WInst::LocalGet(m2));
        f.instruction(&WInst::I64GeU);
        f.instruction(&WInst::I32Or);
        f.instruction(&WInst::If(BlockType::Empty));
        {
            f.instruction(&WInst::LocalGet(rem));
            f.instruction(&WInst::LocalGet(m2));
            f.instruction(&WInst::I64Sub);
            f.instruction(&WInst::LocalSet(rem));

            f.instruction(&WInst::LocalGet(q_low));
            f.instruction(&WInst::I32Const(1));
            f.instruction(&WInst::I32Or);
            f.instruction(&WInst::LocalSet(q_low));
        }
        f.instruction(&WInst::End);

        f.instruction(&WInst::LocalGet(k));
        f.instruction(&WInst::LocalGet(steps));
        f.instruction(&WInst::I32LtS);
        f.instruction(&WInst::If(BlockType::Empty));
        {
            f.instruction(&WInst::LocalGet(rem));
            f.instruction(&WInst::I64Const(63));
            f.instruction(&WInst::I64ShrU);
            f.instruction(&WInst::I32WrapI64);
            f.instruction(&WInst::LocalSet(carry));

            f.instruction(&WInst::LocalGet(rem));
            f.instruction(&WInst::I64Const(1));
            f.instruction(&WInst::I64Shl);
            f.instruction(&WInst::LocalSet(rem));

            f.instruction(&WInst::LocalGet(k));
            f.instruction(&WInst::I32Const(1));
            f.instruction(&WInst::I32Add);
            f.instruction(&WInst::LocalSet(k));
            f.instruction(&WInst::Br(1));
        }
        f.instruction(&WInst::End);
    }
    f.instruction(&WInst::End);

    // Partial reduction if diff >= 64
    f.instruction(&WInst::LocalGet(diff));
    f.instruction(&WInst::I32Const(64));
    f.instruction(&WInst::I32GeS);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::LocalGet(rem));
        f.instruction(&WInst::I64Eqz);
        f.instruction(&WInst::If(BlockType::Empty));
        {
            // Exact 0 -> reduction complete (C2 already 0)
            f.instruction(&WInst::I64Const(0));
            f.instruction(&WInst::LocalGet(s1));
            f.instruction(&WInst::Return);
        }
        f.instruction(&WInst::End);

        // Set C2 = 1 (bit 10 = 0x0400)
        f.instruction(&WInst::GlobalGet(GLOBAL_X87_SW));
        f.instruction(&WInst::I32Const(0x0400));
        f.instruction(&WInst::I32Or);
        f.instruction(&WInst::GlobalSet(GLOBAL_X87_SW));

        f.instruction(&WInst::LocalGet(rem));
        f.instruction(&WInst::I64Clz);
        f.instruction(&WInst::I32WrapI64);
        f.instruction(&WInst::LocalSet(lz));

        f.instruction(&WInst::LocalGet(s1));
        f.instruction(&WInst::LocalGet(e1));
        f.instruction(&WInst::LocalGet(steps));
        f.instruction(&WInst::I32Sub);
        f.instruction(&WInst::LocalGet(lz));
        f.instruction(&WInst::I32Sub);
        f.instruction(&WInst::LocalGet(rem));
        f.instruction(&WInst::LocalGet(lz));
        f.instruction(&WInst::I64ExtendI32U);
        f.instruction(&WInst::I64Shl);
        f.instruction(&WInst::I64Const(0));
        f.instruction(&WInst::Call(helper_base + X87_FN_ROUND_PACK));
        f.instruction(&WInst::Return);
    }
    f.instruction(&WInst::End);

    // Complete reduction: if is_ieee, check if 2*rem > m2 || (2*rem == m2 && (q_low & 1))
    f.instruction(&WInst::LocalGet(is_ieee));
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::LocalGet(rem));
        f.instruction(&WInst::I64Const(63));
        f.instruction(&WInst::I64ShrU);
        f.instruction(&WInst::I32WrapI64);
        f.instruction(&WInst::LocalSet(carry));

        f.instruction(&WInst::LocalGet(rem));
        f.instruction(&WInst::I64Const(1));
        f.instruction(&WInst::I64Shl);
        f.instruction(&WInst::LocalSet(rem2));

        f.instruction(&WInst::LocalGet(carry));
        f.instruction(&WInst::LocalGet(rem2));
        f.instruction(&WInst::LocalGet(m2));
        f.instruction(&WInst::I64GtU);
        f.instruction(&WInst::I32Or);
        f.instruction(&WInst::LocalGet(rem2));
        f.instruction(&WInst::LocalGet(m2));
        f.instruction(&WInst::I64Eq);
        f.instruction(&WInst::LocalGet(q_low));
        f.instruction(&WInst::I32Const(1));
        f.instruction(&WInst::I32And);
        f.instruction(&WInst::I32And);
        f.instruction(&WInst::I32Or);
        f.instruction(&WInst::If(BlockType::Empty));
        {
            f.instruction(&WInst::LocalGet(m2));
            f.instruction(&WInst::LocalGet(rem));
            f.instruction(&WInst::I64Sub);
            f.instruction(&WInst::LocalSet(rem));
            f.instruction(&WInst::LocalGet(s1));
            f.instruction(&WInst::I32Const(0x8000));
            f.instruction(&WInst::I32Xor);
            f.instruction(&WInst::LocalSet(s1));
            f.instruction(&WInst::LocalGet(q_low));
            f.instruction(&WInst::I32Const(1));
            f.instruction(&WInst::I32Add);
            f.instruction(&WInst::I32Const(7));
            f.instruction(&WInst::I32And);
            f.instruction(&WInst::LocalSet(q_low));
        }
        f.instruction(&WInst::End);
    }
    f.instruction(&WInst::End);

    // Update SW with C1=(q&1)<<9, C3=((q>>1)&1)<<14, C0=((q>>2)&1)<<8
    f.instruction(&WInst::LocalGet(q_low));
    f.instruction(&WInst::I32Const(1));
    f.instruction(&WInst::I32And);
    f.instruction(&WInst::I32Const(9));
    f.instruction(&WInst::I32Shl);
    f.instruction(&WInst::LocalGet(q_low));
    f.instruction(&WInst::I32Const(2));
    f.instruction(&WInst::I32And);
    f.instruction(&WInst::I32Const(13));
    f.instruction(&WInst::I32Shl);
    f.instruction(&WInst::I32Or);
    f.instruction(&WInst::LocalGet(q_low));
    f.instruction(&WInst::I32Const(4));
    f.instruction(&WInst::I32And);
    f.instruction(&WInst::I32Const(6));
    f.instruction(&WInst::I32Shl);
    f.instruction(&WInst::I32Or);
    f.instruction(&WInst::LocalSet(sw_cc));

    f.instruction(&WInst::GlobalGet(GLOBAL_X87_SW));
    f.instruction(&WInst::LocalGet(sw_cc));
    f.instruction(&WInst::I32Or);
    f.instruction(&WInst::GlobalSet(GLOBAL_X87_SW));

    f.instruction(&WInst::LocalGet(rem));
    f.instruction(&WInst::I64Eqz);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::I64Const(0));
        f.instruction(&WInst::LocalGet(s1));
        f.instruction(&WInst::Return);
    }
    f.instruction(&WInst::End);

    f.instruction(&WInst::LocalGet(rem));
    f.instruction(&WInst::I64Clz);
    f.instruction(&WInst::I32WrapI64);
    f.instruction(&WInst::LocalSet(lz));

    f.instruction(&WInst::LocalGet(s1));
    f.instruction(&WInst::LocalGet(e2));
    f.instruction(&WInst::LocalGet(lz));
    f.instruction(&WInst::I32Sub);
    f.instruction(&WInst::LocalGet(rem));
    f.instruction(&WInst::LocalGet(lz));
    f.instruction(&WInst::I64ExtendI32U);
    f.instruction(&WInst::I64Shl);
    f.instruction(&WInst::I64Const(0));
    f.instruction(&WInst::Call(helper_base + X87_FN_ROUND_PACK));
    f.instruction(&WInst::End);
    f
}

/// 10: f80_scale(m0: i64, se0: i32, m1: i64, se1: i32) -> (mant: i64, se: i32)
/// ST(0) = ST(0) * 2^(trunc(ST(1)))
fn emit_f80_scale(helper_base: u32) -> Function {
    // params: 0: m0 (i64), 1: se0 (i32), 2: m1 (i64), 3: se1 (i32)
    // locals: 4: n64 (i64), 5..9 (5 i32): s0, e0, e1, lz, n32
    let mut f = Function::new([(1, ValType::I64), (5, ValType::I32)]);
    let m0 = 0;
    let se0 = 1;
    let m1 = 2;
    let se1 = 3;
    let n64 = 4;
    let s0 = 5;
    let e0 = 6;
    let e1 = 7;
    let lz = 8;
    let n32 = 9;

    f.instruction(&WInst::LocalGet(se0));
    f.instruction(&WInst::I32Const(0x8000));
    f.instruction(&WInst::I32And);
    f.instruction(&WInst::LocalSet(s0));
    f.instruction(&WInst::LocalGet(se0));
    f.instruction(&WInst::I32Const(0x7FFF));
    f.instruction(&WInst::I32And);
    f.instruction(&WInst::LocalSet(e0));
    f.instruction(&WInst::LocalGet(se1));
    f.instruction(&WInst::I32Const(0x7FFF));
    f.instruction(&WInst::I32And);
    f.instruction(&WInst::LocalSet(e1));

    // NaN checks
    f.instruction(&WInst::LocalGet(e0));
    f.instruction(&WInst::I32Const(0x7FFF));
    f.instruction(&WInst::I32Eq);
    f.instruction(&WInst::LocalGet(m0));
    f.instruction(&WInst::I64Const(0x7FFF_FFFF_FFFF_FFFFu64 as i64));
    f.instruction(&WInst::I64And);
    f.instruction(&WInst::I64Const(0));
    f.instruction(&WInst::I64Ne);
    f.instruction(&WInst::I32And);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::LocalGet(m0));
        f.instruction(&WInst::I64Const(0xC000_0000_0000_0000u64 as i64));
        f.instruction(&WInst::I64Or);
        f.instruction(&WInst::LocalGet(se0));
        f.instruction(&WInst::Return);
    }
    f.instruction(&WInst::End);

    f.instruction(&WInst::LocalGet(e1));
    f.instruction(&WInst::I32Const(0x7FFF));
    f.instruction(&WInst::I32Eq);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::LocalGet(m1));
        f.instruction(&WInst::I64Const(0x7FFF_FFFF_FFFF_FFFFu64 as i64));
        f.instruction(&WInst::I64And);
        f.instruction(&WInst::I64Const(0));
        f.instruction(&WInst::I64Ne);
        f.instruction(&WInst::If(BlockType::Empty));
        {
            f.instruction(&WInst::LocalGet(m1));
            f.instruction(&WInst::I64Const(0xC000_0000_0000_0000u64 as i64));
            f.instruction(&WInst::I64Or);
            f.instruction(&WInst::LocalGet(se1));
            f.instruction(&WInst::Return);
        }
        f.instruction(&WInst::End);
        // ST(1) is ±Inf
        f.instruction(&WInst::LocalGet(se1));
        f.instruction(&WInst::I32Const(0x8000));
        f.instruction(&WInst::I32And);
        f.instruction(&WInst::If(BlockType::Empty));
        {
            // -Inf -> 0 if finite, NaN if ST(0) is Inf
            f.instruction(&WInst::LocalGet(e0));
            f.instruction(&WInst::I32Const(0x7FFF));
            f.instruction(&WInst::I32Eq);
            f.instruction(&WInst::If(BlockType::Empty));
            {
                f.instruction(&WInst::I64Const(0xC000_0000_0000_0000u64 as i64));
                f.instruction(&WInst::I32Const(0xFFFF));
                f.instruction(&WInst::Return);
            }
            f.instruction(&WInst::End);
            f.instruction(&WInst::I64Const(0));
            f.instruction(&WInst::LocalGet(s0));
            f.instruction(&WInst::Return);
        }
        f.instruction(&WInst::Else);
        {
            // +Inf -> Inf if non-zero, NaN if ST(0) is 0
            f.instruction(&WInst::LocalGet(m0));
            f.instruction(&WInst::I64Eqz);
            f.instruction(&WInst::If(BlockType::Empty));
            {
                f.instruction(&WInst::I64Const(0xC000_0000_0000_0000u64 as i64));
                f.instruction(&WInst::I32Const(0xFFFF));
                f.instruction(&WInst::Return);
            }
            f.instruction(&WInst::End);
            f.instruction(&WInst::I64Const(0x8000_0000_0000_0000u64 as i64));
            f.instruction(&WInst::LocalGet(s0));
            f.instruction(&WInst::I32Const(0x7FFF));
            f.instruction(&WInst::I32Or);
            f.instruction(&WInst::Return);
        }
        f.instruction(&WInst::End);
    }
    f.instruction(&WInst::End);

    // If ST(0) is 0 or Inf, return unchanged
    f.instruction(&WInst::LocalGet(m0));
    f.instruction(&WInst::I64Eqz);
    f.instruction(&WInst::LocalGet(e0));
    f.instruction(&WInst::I32Const(0x7FFF));
    f.instruction(&WInst::I32Eq);
    f.instruction(&WInst::I32Or);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::LocalGet(m0));
        f.instruction(&WInst::LocalGet(se0));
        f.instruction(&WInst::Return);
    }
    f.instruction(&WInst::End);

    // Clamp trunc(ST(1)) to [-40000, 40000]
    f.instruction(&WInst::LocalGet(m1));
    f.instruction(&WInst::LocalGet(se1));
    f.instruction(&WInst::I32Const(1)); // trunc
    f.instruction(&WInst::Call(helper_base + X87_FN_F80_TO_I64));
    f.instruction(&WInst::LocalTee(n64));
    f.instruction(&WInst::I64Const(i64::MIN));
    f.instruction(&WInst::I64Eq);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        // Overflowed i64 -> clamp based on sign of ST(1)
        f.instruction(&WInst::LocalGet(se1));
        f.instruction(&WInst::I32Const(0x8000));
        f.instruction(&WInst::I32And);
        f.instruction(&WInst::If(BlockType::Result(ValType::I32)));
        {
            f.instruction(&WInst::I32Const(-40000));
        }
        f.instruction(&WInst::Else);
        {
            f.instruction(&WInst::I32Const(40000));
        }
        f.instruction(&WInst::End);
        f.instruction(&WInst::LocalSet(n32));
    }
    f.instruction(&WInst::Else);
    {
        f.instruction(&WInst::LocalGet(n64));
        f.instruction(&WInst::I64Const(40000));
        f.instruction(&WInst::I64GtS);
        f.instruction(&WInst::If(BlockType::Result(ValType::I32)));
        {
            f.instruction(&WInst::I32Const(40000));
        }
        f.instruction(&WInst::Else);
        {
            f.instruction(&WInst::LocalGet(n64));
            f.instruction(&WInst::I64Const(-40000));
            f.instruction(&WInst::I64LtS);
            f.instruction(&WInst::If(BlockType::Result(ValType::I32)));
            {
                f.instruction(&WInst::I32Const(-40000));
            }
            f.instruction(&WInst::Else);
            {
                f.instruction(&WInst::LocalGet(n64));
                f.instruction(&WInst::I32WrapI64);
            }
            f.instruction(&WInst::End);
        }
        f.instruction(&WInst::End);
        f.instruction(&WInst::LocalSet(n32));
    }
    f.instruction(&WInst::End);

    // Normalize m0
    f.instruction(&WInst::LocalGet(m0));
    f.instruction(&WInst::I64Clz);
    f.instruction(&WInst::I32WrapI64);
    f.instruction(&WInst::LocalSet(lz));
    f.instruction(&WInst::LocalGet(m0));
    f.instruction(&WInst::LocalGet(lz));
    f.instruction(&WInst::I64ExtendI32U);
    f.instruction(&WInst::I64Shl);
    f.instruction(&WInst::LocalSet(m0));
    f.instruction(&WInst::LocalGet(e0));
    f.instruction(&WInst::I32Eqz);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::I32Const(1));
        f.instruction(&WInst::LocalSet(e0));
    }
    f.instruction(&WInst::End);
    f.instruction(&WInst::LocalGet(e0));
    f.instruction(&WInst::LocalGet(lz));
    f.instruction(&WInst::I32Sub);
    f.instruction(&WInst::LocalGet(n32));
    f.instruction(&WInst::I32Add);
    f.instruction(&WInst::LocalSet(e0));

    f.instruction(&WInst::LocalGet(s0));
    f.instruction(&WInst::LocalGet(e0));
    f.instruction(&WInst::LocalGet(m0));
    f.instruction(&WInst::I64Const(0));
    f.instruction(&WInst::Call(helper_base + X87_FN_ROUND_PACK));
    f.instruction(&WInst::End);
    f
}

/// 11: f80_rndint(m: i64, se: i32) -> (mant: i64, se: i32)
/// Rounds 80-bit float to integer using CW rounding mode, preserving sign of zero.
fn emit_f80_rndint(helper_base: u32) -> Function {
    // params: 0: m (i64), 1: se (i32)
    // locals: 2: q (i64), 3: s (i32), 4: e (i32)
    let mut f = Function::new([(1, ValType::I64), (2, ValType::I32)]);
    let m = 0;
    let se = 1;
    let q = 2;
    let s = 3;
    let e = 4;

    f.instruction(&WInst::LocalGet(se));
    f.instruction(&WInst::I32Const(0x8000));
    f.instruction(&WInst::I32And);
    f.instruction(&WInst::LocalSet(s));
    f.instruction(&WInst::LocalGet(se));
    f.instruction(&WInst::I32Const(0x7FFF));
    f.instruction(&WInst::I32And);
    f.instruction(&WInst::LocalSet(e));

    // If zero, NaN, Inf, or already integer (exp >= 16383 + 63): return unchanged
    f.instruction(&WInst::LocalGet(m));
    f.instruction(&WInst::I64Eqz);
    f.instruction(&WInst::LocalGet(e));
    f.instruction(&WInst::I32Const(16383 + 63));
    f.instruction(&WInst::I32GeS);
    f.instruction(&WInst::I32Or);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        f.instruction(&WInst::LocalGet(m));
        f.instruction(&WInst::LocalGet(se));
        f.instruction(&WInst::Return);
    }
    f.instruction(&WInst::End);

    f.instruction(&WInst::LocalGet(m));
    f.instruction(&WInst::LocalGet(se));
    f.instruction(&WInst::I32Const(0)); // use CW rounding mode
    f.instruction(&WInst::Call(helper_base + X87_FN_F80_TO_I64));
    f.instruction(&WInst::LocalTee(q));
    f.instruction(&WInst::I64Eqz);
    f.instruction(&WInst::If(BlockType::Empty));
    {
        // Preserve sign of zero
        f.instruction(&WInst::I64Const(0));
        f.instruction(&WInst::LocalGet(s));
        f.instruction(&WInst::Return);
    }
    f.instruction(&WInst::End);

    f.instruction(&WInst::LocalGet(q));
    f.instruction(&WInst::Call(helper_base + X87_FN_I64_TO_F80));
    f.instruction(&WInst::End);
    f
}
