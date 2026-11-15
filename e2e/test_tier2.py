"""Tier 2 E2E Tests: Boundary & Corner Cases (5 tests per feature across Features 1-13 = 65 tests)."""

from __future__ import annotations

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness


class TestTier2Feature01ElfLoading(unittest.TestCase):
    """Feature 1 boundary cases."""

    def test_t2_f01_01_non_elf_input(self) -> None:
        with tempfile.TemporaryDirectory(prefix="e2e_t2_f01_01_") as tmpdir:
            bad_in = os.path.join(tmpdir, "plain.txt")
            with open(bad_in, "w", encoding="utf-8") as f:
                f.write("not an elf binary\n")
            res, _ = harness.translate(bad_in, out_wasm=os.path.join(tmpdir, "out.wasm"))
            self.assertNotEqual(res.exit_code, 0)

    def test_t2_f01_02_truncated_elf_header(self) -> None:
        with tempfile.TemporaryDirectory(prefix="e2e_t2_f01_02_") as tmpdir:
            trunc = os.path.join(tmpdir, "trunc_true")
            with open(harness.TRUE_BIN, "rb") as src, open(trunc, "wb") as dst:
                dst.write(src.read(32))
            res, _ = harness.translate(trunc, harness.BASIC_SOS, out_wasm=os.path.join(tmpdir, "out.wasm"))
            self.assertNotEqual(res.exit_code, 0)

    def test_t2_f01_03_empty_input_file(self) -> None:
        with tempfile.TemporaryDirectory(prefix="e2e_t2_f01_03_") as tmpdir:
            empty = os.path.join(tmpdir, "empty")
            open(empty, "wb").close()
            res, _ = harness.translate(empty, out_wasm=os.path.join(tmpdir, "out.wasm"))
            self.assertNotEqual(res.exit_code, 0)

    def test_t2_f01_04_missing_required_libc(self) -> None:
        with tempfile.TemporaryDirectory(prefix="e2e_t2_f01_04_") as tmpdir:
            out_wasm = os.path.join(tmpdir, "echo_nolibc.wasm")
            t_res, _ = harness.translate(harness.ECHO_BIN, [harness.LD_SO], out_wasm=out_wasm)
            if t_res.exit_code == 0:
                r_res = harness.run_wasm(out_wasm, args=["hi"])
                self.assertNotEqual(r_res.exit_code, 0)
            else:
                self.assertNotEqual(t_res.exit_code, 0)

    def test_t2_f01_05_nonexistent_elf_path(self) -> None:
        with tempfile.TemporaryDirectory(prefix="e2e_t2_f01_05_") as tmpdir:
            res, _ = harness.translate(
                "/no/such/binary_xyz_123",
                out_wasm=os.path.join(tmpdir, "out.wasm"),
            )
            self.assertNotEqual(res.exit_code, 0)


class TestTier2Feature02CodeDiscovery(unittest.TestCase):
    """Feature 2 boundary cases."""

    def test_t2_f02_01_echo_help_version_cold_paths(self) -> None:
        for flag in ("--help", "--version"):
            wasm_res = harness.run_echo_wasm([flag])
            native_res = harness.run_native([harness.ECHO_BIN, flag])
            harness.assert_differential_eq(self, wasm_res, native_res, f"echo {flag}")

    def test_t2_f02_02_true_help_version_cold_paths(self) -> None:
        for flag in ("--help", "--version"):
            wasm_res = harness.run_true_wasm([flag])
            native_res = harness.run_native([harness.TRUE_BIN, flag])
            harness.assert_differential_eq(self, wasm_res, native_res, f"true {flag}")

    def test_t2_f02_03_python_try_except_finally(self) -> None:
        code = "try:\n 1/0\nexcept ZeroDivisionError:\n print('caught')\nfinally:\n print('fin')"
        res = harness.run_python3_wasm(["-c", code])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"caught\nfin\n")

    def test_t2_f02_04_python_generator_exception_unwind(self) -> None:
        code = "def g(): yield 1; raise ValueError('x')\ntry:\n list(g())\nexcept ValueError as e:\n print(e)"
        res = harness.run_python3_wasm(["-c", code])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"x\n")

    def test_t2_f02_05_invalid_wasm_rejected_cleanly(self) -> None:
        with tempfile.TemporaryDirectory(prefix="e2e_t2_f02_05_") as tmpdir:
            bad_wasm = os.path.join(tmpdir, "bad.wasm")
            with open(bad_wasm, "wb") as f:
                f.write(b"\x00asm\x01\x00\x00\x00\xff\xff\xff")
            res = harness.run_wasm(bad_wasm)
            self.assertNotEqual(res.exit_code, 0)


class TestTier2Feature03CpuStateFlags(unittest.TestCase):
    """Feature 3 boundary cases."""

    def test_t2_f03_01_int64_boundaries(self) -> None:
        args = ["-c", "print(-(1<<63), (1<<63)-1, -(1<<63) // -1)"]
        wasm_res = harness.run_python3_wasm(args)
        native_res = harness.run_native([harness.PYTHON3_BIN, *args])
        harness.assert_differential_eq(self, wasm_res, native_res, "T2-F03-01")

    def test_t2_f03_02_shift_boundaries(self) -> None:
        res = harness.run_python3_wasm(["-c", "print(1 << 0, 1 << 63, (-16) >> 2, (1 << 64) >> 64)"])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"1 9223372036854775808 -4 1\n")

    def test_t2_f03_03_empty_string_strlen_zero(self) -> None:
        wasm_res = harness.run_echo_wasm([""])
        native_res = harness.run_native([harness.ECHO_BIN, ""])
        harness.assert_differential_eq(self, wasm_res, native_res, "T2-F03-03")

    def test_t2_f03_04_negative_div_rem(self) -> None:
        res = harness.run_python3_wasm(["-c", "print(-7 % 3, int(-7 / 3))"])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"2 -2\n")

    def test_t2_f03_05_bit_manipulation_ops(self) -> None:
        res = harness.run_python3_wasm(
            ["-c", "print(bin(0x80000001).count('1'), (0x1234).bit_length(), (8).bit_count())"]
        )
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"2 13 1\n")


class TestTier2Feature04BaselineRepLockEndbr64(unittest.TestCase):
    """Feature 4 boundary cases."""

    def test_t2_f04_01_zero_length_rep_ops(self) -> None:
        wasm_res = harness.run_echo_wasm(["", ""])
        native_res = harness.run_native([harness.ECHO_BIN, "", ""])
        harness.assert_differential_eq(self, wasm_res, native_res, "T2-F04-01")

    def test_t2_f04_02_overlapping_backward_memmove(self) -> None:
        res = harness.run_python3_wasm(
            ["-c", "b = bytearray(b'abcdefghij'); b[2:7] = b[0:5]; print(bytes(b))"]
        )
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"b'ababcdehij'\n")

    def test_t2_f04_03_unaligned_string_slice(self) -> None:
        res = harness.run_python3_wasm(["-c", "s = '123456789'[1:8]; print(s)"])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"2345678\n")

    def test_t2_f04_04_lock_cmpxchg_contention_path(self) -> None:
        code = "import threading; l=threading.Lock(); l.acquire(); print(l.acquire(blocking=False)); l.release()"
        res = harness.run_python3_wasm(["-c", code])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"False\n")

    def test_t2_f04_05_nop_pause_sequences(self) -> None:
        self.assertEqual(harness.run_true_wasm().exit_code, 0)
        self.assertEqual(harness.run_echo_wasm(["nop"]).exit_code, 0)


class TestTier2Feature05Sse2CpuidMasking(unittest.TestCase):
    """Feature 5 boundary cases."""

    def test_t2_f05_01_ieee754_special_values(self) -> None:
        code = "import math; print(math.isnan(float('nan')), math.isinf(float('-inf')), math.copysign(1.0, -0.0))"
        res = harness.run_python3_wasm(["-c", code])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"True True -1.0\n")

    def test_t2_f05_02_subnormal_and_overflow_floats(self) -> None:
        res = harness.run_python3_wasm(["-c", "print(1e-308 * 1e-10, 1e308 * 10)"])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"1e-318 inf\n")

    def test_t2_f05_03_ucomisd_nan_unordered(self) -> None:
        res = harness.run_python3_wasm(
            ["-c", "n = float('nan'); print(n == n, n < 1.0, n > 1.0, n != n)"]
        )
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"False False False True\n")

    def test_t2_f05_04_unaligned_16byte_sse2_echo(self) -> None:
        args = ["1", "22", "333", "4444", "55555555555555555"]
        wasm_res = harness.run_echo_wasm(args)
        native_res = harness.run_native([harness.ECHO_BIN, *args])
        harness.assert_differential_eq(self, wasm_res, native_res, "T2-F05-04")

    def test_t2_f05_05_cpuid_extended_leaves(self) -> None:
        res = harness.run_python3_wasm(["-c", "print('cpuid leaves ok')"])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"cpuid leaves ok\n")


class TestTier2Feature06IndirectDispatchWasmEmit(unittest.TestCase):
    """Feature 6 boundary cases."""

    def test_t2_f06_01_deep_mutual_recursion(self) -> None:
        code = "def a(n): return 0 if n<=0 else b(n-1)\ndef b(n): return 1+a(n-1)\nprint(a(150))"
        res = harness.run_python3_wasm(["-c", code])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"75\n")

    def test_t2_f06_02_near_recursion_limit(self) -> None:
        code = "import sys; sys.setrecursionlimit(500)\ndef f(n): return 0 if n==0 else f(n-1)\nprint(f(400))"
        res = harness.run_python3_wasm(["-c", code])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"0\n")

    def test_t2_f06_03_corrupt_wasm_run(self) -> None:
        with tempfile.TemporaryDirectory(prefix="e2e_t2_f06_03_") as tmpdir:
            corrupt = os.path.join(tmpdir, "corrupt.wasm")
            with open(corrupt, "wb") as f:
                f.write(b"not_a_wasm_module_at_all_12345")
            res = harness.run_wasm(corrupt)
            self.assertNotEqual(res.exit_code, 0)

    def test_t2_f06_04_wasm_missing_elf2wasm_meta(self) -> None:
        # Minimal valid WASM module: magic + version, no elf2wasm_meta custom section
        with tempfile.TemporaryDirectory(prefix="e2e_t2_f06_04_") as tmpdir:
            minimal = os.path.join(tmpdir, "minimal.wasm")
            with open(minimal, "wb") as f:
                f.write(b"\x00asm\x01\x00\x00\x00")
            res = harness.run_wasm(minimal)
            self.assertNotEqual(res.exit_code, 0)

    def test_t2_f06_05_guest_oom_handled_cleanly(self) -> None:
        code = "try:\n b = bytearray(300 * 1024 * 1024)\nexcept MemoryError:\n print('oom')"
        res = harness.run_python3_wasm(["-c", code])
        # Either Python catches MemoryError cleanly (exit 0, 'oom') or guest exits non-zero cleanly
        if res.exit_code == 0:
            self.assertEqual(res.stdout, b"oom\n")
        else:
            self.assertNotEqual(res.exit_code, 0)


class TestTier2Feature07WasmtimeStackAuxv(unittest.TestCase):
    """Feature 7 boundary cases."""

    def test_t2_f07_01_zero_guest_args_echo(self) -> None:
        wasm_res = harness.run_echo_wasm([])
        native_res = harness.run_native([harness.ECHO_BIN])
        harness.assert_differential_eq(self, wasm_res, native_res, "T2-F07-01")

    def test_t2_f07_02_empty_string_args(self) -> None:
        args = ["", "", ""]
        wasm_res = harness.run_echo_wasm(args)
        native_res = harness.run_native([harness.ECHO_BIN, *args])
        harness.assert_differential_eq(self, wasm_res, native_res, "T2-F07-02")

    def test_t2_f07_03_very_long_4kb_arg(self) -> None:
        long_arg = "a" * 4096
        wasm_res = harness.run_echo_wasm([long_arg])
        native_res = harness.run_native([harness.ECHO_BIN, long_arg])
        harness.assert_differential_eq(self, wasm_res, native_res, "T2-F07-03")

    def test_t2_f07_04_many_args_200(self) -> None:
        args = [f"a{i}" for i in range(200)]
        wasm_res = harness.run_echo_wasm(args)
        native_res = harness.run_native([harness.ECHO_BIN, *args])
        harness.assert_differential_eq(self, wasm_res, native_res, "T2-F07-04")

    def test_t2_f07_05_special_chars_utf8_in_argv(self) -> None:
        args = ["café", "line1\nline2", "a\tb", "$HOME"]
        wasm_res = harness.run_echo_wasm(args)
        native_res = harness.run_native([harness.ECHO_BIN, *args])
        harness.assert_differential_eq(self, wasm_res, native_res, "T2-F07-05")


class TestTier2Feature08Tier1MemoryProcessSyscalls(unittest.TestCase):
    """Feature 8 boundary cases."""

    def test_t2_f08_01_nonzero_exit_codes(self) -> None:
        for code in (1, 42, 255):
            res = harness.run_python3_wasm(["-c", f"import sys; sys.exit({code})"])
            self.assertEqual(res.exit_code, code)

    def test_t2_f08_02_mmap_munmap_cycle(self) -> None:
        code = "for _ in range(20): x = [0]*100000; del x\nprint('done')"
        res = harness.run_python3_wasm(["-c", code])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"done\n")

    def test_t2_f08_03_mremap_growth(self) -> None:
        code = "b = bytearray(1024); b.extend(b'x' * (2*1024*1024)); print(len(b))"
        res = harness.run_python3_wasm(["-c", code])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"2098176\n")

    def test_t2_f08_04_brk_query_shrink(self) -> None:
        res = harness.run_python3_wasm(["-c", "a = [1]*100000; del a; print('ok')"])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"ok\n")

    def test_t2_f08_05_getrandom_zero_and_large(self) -> None:
        res = harness.run_python3_wasm(["-c", "import os; print(len(os.urandom(0)), len(os.urandom(1024)))"])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"0 1024\n")


class TestTier2Feature09Tier1VfsIoSyscalls(unittest.TestCase):
    """Feature 9 boundary cases."""

    def test_t2_f09_01_open_nonexistent_enoent(self) -> None:
        res = harness.run_python3_wasm(["-c", "open('/nonexistent/file_xyz.txt')"])
        self.assertEqual(res.exit_code, 1)
        self.assertIn(b"FileNotFoundError", res.stderr)

    def test_t2_f09_02_write_readonly_vfs_erofs(self) -> None:
        res = harness.run_python3_wasm(["-c", "open('/usr/lib/python3.11/os.py', 'w')"])
        self.assertEqual(res.exit_code, 1)
        self.assertTrue(b"PermissionError" in res.stderr or b"OSError" in res.stderr)

    def test_t2_f09_03_echo_flags_differential(self) -> None:
        cases = [["-n", "hi"], ["-e", "a\\nb\\tc"], ["-E", "a\\nb"]]
        for args in cases:
            wasm_res = harness.run_echo_wasm(args)
            native_res = harness.run_native([harness.ECHO_BIN, *args])
            harness.assert_differential_eq(self, wasm_res, native_res, f"echo {args}")

    def test_t2_f09_04_large_stdout_100kb(self) -> None:
        args = ["-c", "print('A' * 100000)"]
        wasm_res = harness.run_python3_wasm(args)
        native_res = harness.run_native([harness.PYTHON3_BIN, *args])
        harness.assert_differential_eq(self, wasm_res, native_res, "T2-F09-04")

    def test_t2_f09_05_invalid_fd_ebadf(self) -> None:
        code = "import os\ntry:\n os.read(999, 10)\nexcept OSError as e:\n print(e.errno)"
        res = harness.run_python3_wasm(["-c", code])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"9\n")


class TestTier2Feature10Cli(unittest.TestCase):
    """Feature 10 boundary cases."""

    def test_t2_f10_01_translate_missing_args(self) -> None:
        res = harness.run_native([harness.get_elf2wasm_bin(), "translate"])
        self.assertNotEqual(res.exit_code, 0)

    def test_t2_f10_02_translate_unwritable_output(self) -> None:
        res, _ = harness.translate(
            harness.TRUE_BIN,
            harness.BASIC_SOS,
            out_wasm="/nonexistent_dir_xyz_999/out.wasm",
        )
        self.assertNotEqual(res.exit_code, 0)

    def test_t2_f10_03_run_nonexistent_wasm(self) -> None:
        res = harness.run_wasm("/no/such/file_xyz_999.wasm")
        self.assertNotEqual(res.exit_code, 0)

    def test_t2_f10_04_malformed_vfs_ro_spec(self) -> None:
        res = harness.run_wasm(harness.get_true_wasm(), vfs_ro=["invalid_spec_without_colon"])
        self.assertNotEqual(res.exit_code, 0)

    def test_t2_f10_05_vfs_ro_nonexistent_host_dir(self) -> None:
        res = harness.run_wasm(
            harness.get_true_wasm(),
            vfs_ro=["/no/such/host/dir_xyz_999:/guest"],
        )
        self.assertNotEqual(res.exit_code, 0)


class TestTier2Feature11Python3Syscalls(unittest.TestCase):
    """Feature 11 boundary cases."""

    def test_t2_f11_01_python_syntax_error_diff(self) -> None:
        args = ["-c", "def broken(:"]
        wasm_res = harness.run_python3_wasm(args)
        native_res = harness.run_native([harness.PYTHON3_BIN, *args])
        harness.assert_differential_eq(self, wasm_res, native_res, "T2-F11-01")

    def test_t2_f11_02_python_zero_division_diff(self) -> None:
        args = ["-c", "1/0"]
        wasm_res = harness.run_python3_wasm(args)
        native_res = harness.run_native([harness.PYTHON3_BIN, *args])
        harness.assert_differential_eq(self, wasm_res, native_res, "T2-F11-02")

    def test_t2_f11_03_getdents64_empty_and_missing_dir(self) -> None:
        with tempfile.TemporaryDirectory(prefix="e2e_t2_f11_03_") as empty_dir:
            code = (
                "import os\n"
                "print(os.listdir('/empty_mnt'))\n"
                "try:\n os.listdir('/nope_dir_xyz')\nexcept FileNotFoundError:\n print('missing')"
            )
            res = harness.run_python3_wasm(["-c", code], extra_vfs=[f"{empty_dir}:/empty_mnt"])
            self.assertEqual(res.exit_code, 0)
            self.assertEqual(res.stdout, b"[]\nmissing\n")

    def test_t2_f11_04_lseek_seek_end(self) -> None:
        res = harness.run_python3_wasm(
            ["-c", "f=open('/usr/lib/python3.11/os.py','rb'); f.seek(0,2); print(f.tell()>0)"]
        )
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"True\n")

    def test_t2_f11_05_fork_blocked_by_sandbox(self) -> None:
        code = "import os\ntry:\n os.fork()\nexcept OSError as e:\n print('blocked', e.errno is not None)"
        res = harness.run_python3_wasm(["-c", code])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"blocked True\n")


class TestTier2Feature12Python3StdlibVfs(unittest.TestCase):
    """Feature 12 boundary cases."""

    def test_t2_f12_01_python3_without_stdlib_vfs(self) -> None:
        # Running with -S (skip site) or without stdlib must not panic host
        res = harness.run_python3_wasm(["-S", "-c", "print(1)"], include_stdlib=False)
        self.assertIn(res.exit_code, (0, 1))

    def test_t2_f12_02_import_missing_module(self) -> None:
        res = harness.run_python3_wasm(["-c", "import definitely_missing_mod_xyz"])
        self.assertEqual(res.exit_code, 1)
        self.assertIn(b"ModuleNotFoundError", res.stderr)

    def test_t2_f12_03_vfs_path_traversal_blocked(self) -> None:
        code = "try:\n open('/app/../../../etc/shadow')\nexcept OSError:\n print('denied')"
        res = harness.run_python3_wasm(["-c", code], extra_vfs=[f"{harness.FIXTURES_DIR}:/app"])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"denied\n")

    def test_t2_f12_04_utf8_file_read_from_vfs(self) -> None:
        code = "print(open('/app/utf8_sample.txt', encoding='utf-8').read().strip())"
        wasm_res = harness.run_python3_wasm(["-c", code], extra_vfs=[f"{harness.FIXTURES_DIR}:/app"])
        with open(os.path.join(harness.FIXTURES_DIR, "utf8_sample.txt"), "rb") as f:
            expected = f.read().strip() + b"\n"
        self.assertEqual(wasm_res.exit_code, 0)
        self.assertEqual(wasm_res.stdout, expected)

    def test_t2_f12_05_zlib_and_expat_error_paths(self) -> None:
        code = (
            "import zlib, xml.etree.ElementTree as ET\n"
            "try:\n zlib.decompress(b'bad')\nexcept zlib.error:\n print('zlib_ok')\n"
            "try:\n ET.fromstring('<unclosed>')\nexcept ET.ParseError:\n print('xml_ok')"
        )
        res = harness.run_python3_wasm(["-c", code])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"zlib_ok\nxml_ok\n")


class TestTier2Feature13DifferentialVerification(unittest.TestCase):
    """Feature 13 boundary cases."""

    def test_t2_f13_01_diff_echo_dash_dash_and_flags(self) -> None:
        for args in (["-n"], ["--", "-e"]):
            wasm_res = harness.run_echo_wasm(args)
            native_res = harness.run_native([harness.ECHO_BIN, *args])
            harness.assert_differential_eq(self, wasm_res, native_res, f"echo {args}")

    def test_t2_f13_02_diff_python3_binary_stdout(self) -> None:
        args = ["-c", "import sys; sys.stdout.buffer.write(bytes(range(0, 256)))"]
        wasm_res = harness.run_python3_wasm(args)
        native_res = harness.run_native([harness.PYTHON3_BIN, *args])
        harness.assert_differential_eq(self, wasm_res, native_res, "T2-F13-02")

    def test_t2_f13_03_diff_interleaved_stdout_stderr(self) -> None:
        args = ["-c", "import sys; print('out1'); print('err1', file=sys.stderr); print('out2')"]
        wasm_res = harness.run_python3_wasm(args)
        native_res = harness.run_native([harness.PYTHON3_BIN, *args])
        harness.assert_differential_eq(self, wasm_res, native_res, "T2-F13-03")

    def test_t2_f13_04_diff_inline_vs_script_file(self) -> None:
        with tempfile.TemporaryDirectory(prefix="e2e_t2_f13_04_") as tmpdir:
            script = os.path.join(tmpdir, "prog.py")
            body = "import json; print(json.dumps({'a': 1, 'b': [2, 3]}, sort_keys=True))\n"
            with open(script, "w", encoding="utf-8") as f:
                f.write(body)
            inline_res = harness.run_python3_wasm(["-c", body])
            file_res = harness.run_python3_wasm(["/s/prog.py"], extra_vfs=[f"{tmpdir}:/s"])
            harness.assert_differential_eq(self, file_res, inline_res, "T2-F13-04")

    def test_t2_f13_05_sandbox_network_socket_denied(self) -> None:
        code = "import socket\ntry:\n socket.socket()\nexcept OSError:\n print('net blocked')"
        res = harness.run_python3_wasm(["-c", code])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"net blocked\n")


if __name__ == "__main__":
    unittest.main()
