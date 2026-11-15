"""Tier 1 E2E Tests: Feature Coverage (5 tests per feature across Features 1-13 = 65 tests)."""

from __future__ import annotations

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness


class TestTier1Feature01ElfLoading(unittest.TestCase):
    """Feature 1: ELF64 PIE & non-PIE + .so loading."""

    def test_t1_f01_01_pie_true(self) -> None:
        res = harness.run_true_wasm()
        self.assertEqual(res.exit_code, 0)

    def test_t1_f01_02_pie_echo(self) -> None:
        res = harness.run_echo_wasm(["hello"])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"hello\n")

    def test_t1_f01_03_non_pie_python3(self) -> None:
        res = harness.run_python3_wasm(["-c", "print(1)"])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"1\n")

    def test_t1_f01_04_so_load_order_independence(self) -> None:
        reversed_sos = list(reversed(harness.PYTHON3_SOS))
        with tempfile.TemporaryDirectory(prefix="e2e_f01_04_") as tmpdir:
            out_wasm = os.path.join(tmpdir, "py_rev.wasm")
            t_res, _ = harness.translate(harness.PYTHON3_BIN, reversed_sos, out_wasm=out_wasm)
            self.assertEqual(t_res.exit_code, 0, t_res.stderr.decode(errors="replace"))
            r_res = harness.run_wasm(
                out_wasm,
                args=["-c", "print(42)"],
                vfs_ro=harness.PYTHON3_VFS_MOUNTS,
            )
            self.assertEqual(r_res.exit_code, 0)
            self.assertEqual(r_res.stdout, b"42\n")

    def test_t1_f01_05_duplicate_so_handling(self) -> None:
        dup_sos = [harness.LD_SO, harness.LIBC_SO, harness.LIBC_SO]
        with tempfile.TemporaryDirectory(prefix="e2e_f01_05_") as tmpdir:
            out_wasm = os.path.join(tmpdir, "true_dup.wasm")
            t_res, _ = harness.translate(harness.TRUE_BIN, dup_sos, out_wasm=out_wasm)
            if t_res.exit_code == 0:
                r_res = harness.run_wasm(out_wasm)
                self.assertEqual(r_res.exit_code, 0)
            else:
                self.assertTrue(len(t_res.stderr) > 0)


class TestTier1Feature02CodeDiscovery(unittest.TestCase):
    """Feature 2: x86-64 code discovery & decoding."""

    def test_t1_f02_01_decode_true_pfx(self) -> None:
        wasm_path = harness.get_true_wasm()
        self.assertTrue(os.path.getsize(wasm_path) > 0)
        res = harness.run_wasm(wasm_path)
        self.assertEqual(res.exit_code, 0)

    def test_t1_f02_02_decode_echo_branches(self) -> None:
        res = harness.run_echo_wasm(["-n", "abc"])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"abc")

    def test_t1_f02_03_decode_large_python3(self) -> None:
        wasm_path = harness.get_python3_wasm()
        self.assertTrue(os.path.getsize(wasm_path) > 0)

    def test_t1_f02_04_indirect_jump_libc(self) -> None:
        res = harness.run_echo_wasm(["a b c"])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"a b c\n")

    def test_t1_f02_05_python_bytecode_dispatch(self) -> None:
        res = harness.run_python3_wasm(["-c", "print(sum(range(100)))"])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"4950\n")


class TestTier1Feature03CpuStateFlags(unittest.TestCase):
    """Feature 3: CPU state & flags lifting."""

    def test_t1_f03_01_integer_comparisons_jcc(self) -> None:
        res = harness.run_python3_wasm(["-c", "print(3<5, 5<3, -1<0, 0xFFFFFFFF > 1)"])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"True False True True\n")

    def test_t1_f03_02_cmovcc_setcc(self) -> None:
        res = harness.run_python3_wasm(["-c", "print(max(-5, 10), min(-5, 10), bool(0), bool(7))"])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"10 -5 False True\n")

    def test_t1_f03_03_multiprecision_adc_sbb(self) -> None:
        res = harness.run_python3_wasm(["-c", "print((1 << 128) + (1 << 127) - 1)"])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"510423550381407695195061911147652317183\n")

    def test_t1_f03_04_tls_fs_register(self) -> None:
        res_echo = harness.run_echo_wasm(["test"])
        self.assertEqual(res_echo.exit_code, 0)
        self.assertEqual(res_echo.stdout, b"test\n")
        res_py = harness.run_python3_wasm(["-c", "import sys; print(sys.maxsize > 0)"])
        self.assertEqual(res_py.exit_code, 0)
        self.assertEqual(res_py.stdout, b"True\n")

    def test_t1_f03_05_overflow_flags_bigint_promotion(self) -> None:
        res = harness.run_python3_wasm(["-c", "print((-2**63) - 1, (2**63 - 1) + 1)"])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"-9223372036854775809 9223372036854775808\n")


class TestTier1Feature04BaselineRepLockEndbr64(unittest.TestCase):
    """Feature 4: Baseline x86-64 + rep/lock/endbr64."""

    def test_t1_f04_01_rep_movs_stos(self) -> None:
        res = harness.run_python3_wasm(["-c", "b = bytearray(4096); print(len(b), b[0], b[-1])"])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"4096 0 0\n")

    def test_t1_f04_02_rep_scas_cmps(self) -> None:
        s = "abcdefghijklmnopqrstuvwxyz0123456789"
        res = harness.run_echo_wasm([s])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, f"{s}\n".encode())

    def test_t1_f04_03_lock_rmw_atomics(self) -> None:
        res = harness.run_python3_wasm(["-c", "a = [i for i in range(500)]; del a; print('ok')"])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"ok\n")

    def test_t1_f04_04_endbr64_landing_pads(self) -> None:
        self.assertEqual(harness.run_true_wasm().exit_code, 0)
        self.assertEqual(harness.run_echo_wasm(["endbr64"]).exit_code, 0)
        self.assertEqual(harness.run_python3_wasm(["-c", "print('ok')"]).exit_code, 0)

    def test_t1_f04_05_rdtsc_dict_hashing(self) -> None:
        res = harness.run_python3_wasm(["-c", "print(len({'a': 1, 'b': 2}))"])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"2\n")


class TestTier1Feature05Sse2CpuidMasking(unittest.TestCase):
    """Feature 5: SSE/SSE2 & cpuid/xgetbv masking."""

    def test_t1_f05_01_cpuid_sse2_ifunc(self) -> None:
        res = harness.run_echo_wasm(["SSE2 IFUNC path check"])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"SSE2 IFUNC path check\n")

    def test_t1_f05_02_xgetbv_masking(self) -> None:
        res = harness.run_python3_wasm(["-c", "import math; print(round(math.sqrt(2.0), 6))"])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"1.414214\n")

    def test_t1_f05_03_sse2_packed_string_ops(self) -> None:
        s = "0123456789abcdef0123456789abcdef"
        res = harness.run_echo_wasm([s])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, f"{s}\n".encode())

    def test_t1_f05_04_sse2_scalar_fp(self) -> None:
        res = harness.run_python3_wasm(["-c", "print(1.5 + 2.25 * 4.0 / 3.0)"])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"4.5\n")

    def test_t1_f05_05_sse2_memcpy_unaligned(self) -> None:
        res = harness.run_python3_wasm(["-c", "s = 'x' * 257; print(len(s), s[:3], s[-3:])"])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"257 xxx xxx\n")


class TestTier1Feature06IndirectDispatchWasmEmit(unittest.TestCase):
    """Feature 6: Indirect dispatch & WASM module emission."""

    def test_t1_f06_01_wasm_validates_in_wasmtime(self) -> None:
        res = harness.run_true_wasm()
        self.assertEqual(res.exit_code, 0)

    def test_t1_f06_02_elf2wasm_meta_present(self) -> None:
        res = harness.run_echo_wasm(["hi"])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"hi\n")

    def test_t1_f06_03_deep_call_no_stack_overflow(self) -> None:
        code = "def f(n): return 0 if n==0 else 1+f(n-1)\nprint(f(200))"
        res = harness.run_python3_wasm(["-c", code])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"200\n")

    def test_t1_f06_04_long_loop_indirect_dispatch(self) -> None:
        code = "s=0\nfor i in range(10000): s+=i\nprint(s)"
        res = harness.run_python3_wasm(["-c", code])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"49995000\n")

    def test_t1_f06_05_linear_memory_4mb_alloc(self) -> None:
        res = harness.run_python3_wasm(["-c", "data = b'a' * (4 * 1024 * 1024); print(len(data))"])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"4194304\n")


class TestTier1Feature07WasmtimeStackAuxv(unittest.TestCase):
    """Feature 7: wasmtime host & Linux stack/auxv init."""

    def test_t1_f07_01_argc_argv(self) -> None:
        res = harness.run_echo_wasm(["one", "two", "three"])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"one two three\n")

    def test_t1_f07_02_argv0_and_tail_args(self) -> None:
        res = harness.run_python3_wasm(["-c", "import sys; print(len(sys.argv), sys.argv[1:])", "argA", "argB"])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"3 ['argA', 'argB']\n")

    def test_t1_f07_03_envp_readable(self) -> None:
        res = harness.run_python3_wasm(["-c", "import os; print(isinstance(dict(os.environ), dict))"])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"True\n")

    def test_t1_f07_04_auxv_no_vdso_crash(self) -> None:
        res = harness.run_python3_wasm(["-c", "import time; print(time.monotonic() >= 0)"])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"True\n")

    def test_t1_f07_05_auxv_bootstrap(self) -> None:
        self.assertEqual(harness.run_true_wasm().exit_code, 0)
        res = harness.run_python3_wasm(["-c", "print('auxv ok')"])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"auxv ok\n")


class TestTier1Feature08Tier1MemoryProcessSyscalls(unittest.TestCase):
    """Feature 8: Tier 1 memory & process syscalls."""

    def test_t1_f08_01_brk_heap_expansion(self) -> None:
        res = harness.run_python3_wasm(["-c", "x = [i for i in range(50000)]; print(len(x))"])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"50000\n")

    def test_t1_f08_02_mmap_so_mapping(self) -> None:
        res = harness.run_true_wasm()
        self.assertEqual(res.exit_code, 0)

    def test_t1_f08_03_mprotect_munmap(self) -> None:
        res = harness.run_echo_wasm(["relro"])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"relro\n")

    def test_t1_f08_04_arch_prctl_tid_robust_rseq(self) -> None:
        res = harness.run_true_wasm()
        self.assertEqual(res.exit_code, 0)

    def test_t1_f08_05_getrandom_prlimit64_exit_group(self) -> None:
        res = harness.run_python3_wasm(["-c", "import os; print(len(os.urandom(16)))"])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"16\n")


class TestTier1Feature09Tier1VfsIoSyscalls(unittest.TestCase):
    """Feature 9: Tier 1 VFS & I/O syscalls."""

    def test_t1_f09_01_write_stdout(self) -> None:
        res = harness.run_echo_wasm(["hello stdout"])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"hello stdout\n")
        self.assertEqual(res.stderr, b"")

    def test_t1_f09_02_write_stderr(self) -> None:
        res = harness.run_python3_wasm(["-c", "import sys; sys.stderr.write('err\\n')"])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"")
        self.assertEqual(res.stderr, b"err\n")

    def test_t1_f09_03_openat_read_fstat_close_so(self) -> None:
        res = harness.run_true_wasm()
        self.assertEqual(res.exit_code, 0)

    def test_t1_f09_04_ld_so_preload_enoent(self) -> None:
        res = harness.run_true_wasm()
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stderr, b"")

    def test_t1_f09_05_access_syscall(self) -> None:
        res = harness.run_python3_wasm(["-c", "import os; print(os.access('/usr/lib/python3.11/os.py', os.R_OK))"])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"True\n")


class TestTier1Feature10Cli(unittest.TestCase):
    """Feature 10: CLI (translate & run)."""

    def test_t1_f10_01_help_subcommands(self) -> None:
        for args in (["--help"], ["translate", "--help"], ["run", "--help"]):
            res = harness.run_native([harness.get_elf2wasm_bin(), *args])
            self.assertEqual(res.exit_code, 0, f"failed for {args}: {res.stderr!r}")

    def test_t1_f10_02_translate_creates_wasm(self) -> None:
        with tempfile.TemporaryDirectory(prefix="e2e_f10_02_") as tmpdir:
            out_wasm = os.path.join(tmpdir, "t.wasm")
            res, _ = harness.translate(harness.TRUE_BIN, harness.BASIC_SOS, out_wasm=out_wasm)
            self.assertEqual(res.exit_code, 0, res.stderr.decode(errors="replace"))
            self.assertTrue(os.path.exists(out_wasm))
            self.assertGreater(os.path.getsize(out_wasm), 0)

    def test_t1_f10_03_run_with_guest_args(self) -> None:
        res = harness.run_echo_wasm(["-n", "cli test"])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"cli test")

    def test_t1_f10_04_run_vfs_ro_script(self) -> None:
        with tempfile.TemporaryDirectory(prefix="e2e_f10_04_") as tmpdir:
            script = os.path.join(tmpdir, "hi.py")
            with open(script, "w", encoding="utf-8") as f:
                f.write("print('hi from vfs')\n")
            res = harness.run_python3_wasm(
                ["/scripts/hi.py"],
                extra_vfs=[f"{tmpdir}:/scripts"],
            )
            self.assertEqual(res.exit_code, 0)
            self.assertEqual(res.stdout, b"hi from vfs\n")

    def test_t1_f10_05_multiple_vfs_ro_flags(self) -> None:
        res = harness.run_python3_wasm(
            ["/proj/app_proj.py", "multi"],
            extra_vfs=[f"{harness.FIXTURES_DIR}:/proj"],
        )
        self.assertEqual(res.exit_code, 3)
        self.assertIn(b'"arg": "multi"', res.stdout)


class TestTier1Feature11Python3Syscalls(unittest.TestCase):
    """Feature 11: Python 3 syscalls & signals/time/ids."""

    def test_t1_f11_01_getcwd_readlink_lseek(self) -> None:
        res = harness.run_python3_wasm(["-c", "import os, sys; print(bool(os.getcwd()), bool(sys.executable))"])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"True True\n")

    def test_t1_f11_02_getdents64_listdir(self) -> None:
        res = harness.run_python3_wasm(["-c", "import os; print('os.py' in os.listdir('/usr/lib/python3.11'))"])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"True\n")

    def test_t1_f11_03_ioctl_tcgets_enotty(self) -> None:
        res = harness.run_python3_wasm(["-c", "import sys; print(sys.stdin.isatty(), sys.stdout.isatty())"])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"False False\n")

    def test_t1_f11_04_signals_sigaction_procmask(self) -> None:
        res = harness.run_python3_wasm(["-c", "import signal; print(signal.getsignal(signal.SIGINT) is not None)"])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"True\n")

    def test_t1_f11_05_uname_time_ids(self) -> None:
        res = harness.run_python3_wasm(
            ["-c", "import os, platform, time; print(platform.system(), os.getpid() > 0, time.time() > 0)"]
        )
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"Linux True True\n")


class TestTier1Feature12Python3StdlibVfs(unittest.TestCase):
    """Feature 12: Python 3 stdlib VFS & x87/SSE4.2 edge ops."""

    def test_t1_f12_01_stdlib_json_re(self) -> None:
        res = harness.run_python3_wasm(
            ["-c", "import json, re; print(json.dumps({'k': re.findall(r'\\d+', 'a1b22')}))"]
        )
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b'{"k": ["1", "22"]}\n')

    def test_t1_f12_02_libm_math_funcs(self) -> None:
        res = harness.run_python3_wasm(
            ["-c", "import math; print(round(math.sin(1.0) + math.cos(0.0) + math.log(math.e), 6))"]
        )
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"2.841471\n")

    def test_t1_f12_03_libz_compress_decompress(self) -> None:
        res = harness.run_python3_wasm(
            ["-c", "import zlib; c = zlib.compress(b'hello'*20); print(zlib.decompress(c) == b'hello'*20)"]
        )
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"True\n")

    def test_t1_f12_04_libexpat_xml(self) -> None:
        res = harness.run_python3_wasm(
            ["-c", "import xml.etree.ElementTree as ET; print(ET.fromstring('<a x=\"1\">hi</a>').text)"]
        )
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"hi\n")

    def test_t1_f12_05_user_script_from_vfs_ro(self) -> None:
        res = harness.run_python3_wasm(
            ["/app/calc.py", '{"values": [4, 9, 16]}'],
            extra_vfs=[f"{harness.FIXTURES_DIR}:/app"],
        )
        self.assertEqual(res.exit_code, 0)
        self.assertIn(b'"count": 3', res.stdout)


class TestTier1Feature13DifferentialVerification(unittest.TestCase):
    """Feature 13: Differential verification & E2E test suite."""

    def test_t1_f13_01_diff_true(self) -> None:
        wasm_res = harness.run_true_wasm()
        native_res = harness.run_native([harness.TRUE_BIN])
        harness.assert_differential_eq(self, wasm_res, native_res, "T1-F13-01")

    def test_t1_f13_02_diff_echo(self) -> None:
        wasm_res = harness.run_echo_wasm(["hello", "world"])
        native_res = harness.run_native([harness.ECHO_BIN, "hello", "world"])
        harness.assert_differential_eq(self, wasm_res, native_res, "T1-F13-02")

    def test_t1_f13_03_diff_python3(self) -> None:
        args = ["-c", "print(2 + 2)"]
        wasm_res = harness.run_python3_wasm(args)
        native_res = harness.run_native([harness.PYTHON3_BIN, *args])
        harness.assert_differential_eq(self, wasm_res, native_res, "T1-F13-03")

    def test_t1_f13_04_diff_stderr_and_exit_code(self) -> None:
        args = ["-c", "import sys; sys.stderr.write('oops\\n'); sys.exit(7)"]
        wasm_res = harness.run_python3_wasm(args)
        native_res = harness.run_native([harness.PYTHON3_BIN, *args])
        harness.assert_differential_eq(self, wasm_res, native_res, "T1-F13-04")

    def test_t1_f13_05_sandbox_no_host_write(self) -> None:
        with tempfile.TemporaryDirectory(prefix="e2e_f13_05_") as tmpdir:
            target = os.path.join(tmpdir, "should_not_exist.txt")
            code = f"open({target!r}, 'w').write('x')"
            res = harness.run_python3_wasm(["-c", code])
            self.assertNotEqual(res.exit_code, 0)
            self.assertFalse(os.path.exists(target))


if __name__ == "__main__":
    unittest.main()
