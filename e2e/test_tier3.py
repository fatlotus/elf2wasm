"""Tier 3 E2E Tests: Cross-Feature Combinations (T3-01 .. T3-08)."""

from __future__ import annotations

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness


class TestTier3CrossFeature(unittest.TestCase):
    """Cross-feature pairwise and multi-feature integration tests."""

    def test_t3_01_echo_pie_sse2_argv_stdout_cli(self) -> None:
        args = ["-e", "hello\\tworld\\n"]
        wasm_res = harness.run_echo_wasm(args)
        native_res = harness.run_native([harness.ECHO_BIN, *args])
        harness.assert_differential_eq(self, wasm_res, native_res, "T3-01")

    def test_t3_02_python3_nonpie_all_sos_stdlib_vfs(self) -> None:
        code = "import json, math, zlib; print(len(json.dumps({'x': math.pi})))"
        wasm_res = harness.run_python3_wasm(["-c", code])
        native_res = harness.run_native([harness.PYTHON3_BIN, "-c", code])
        harness.assert_differential_eq(self, wasm_res, native_res, "T3-02")

    def test_t3_03_vfs_project_argv_getcwd_getdents_exit(self) -> None:
        wasm_res = harness.run_python3_wasm(
            ["/proj/app_proj.py", "alpha"],
            extra_vfs=[f"{harness.FIXTURES_DIR}:/proj"],
        )
        native_res = harness.run_native(
            [harness.PYTHON3_BIN, os.path.join(harness.FIXTURES_DIR, "app_proj.py"), "alpha"]
        )
        harness.assert_differential_eq(self, wasm_res, native_res, "T3-03")

    def test_t3_04_bigint_fib_atomics_indirect_mremap(self) -> None:
        code = (
            "def fib(n):\n"
            " a,b=0,1\n"
            " for _ in range(n): a,b=b,a+b\n"
            " return a\n"
            "print(len(str(fib(1000))))"
        )
        res = harness.run_python3_wasm(["-c", code])
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, b"209\n")

    def test_t3_05_ieee754_libm_libexpat_clock_gettime(self) -> None:
        code = (
            "import math, time, xml.etree.ElementTree as ET\n"
            "root = ET.fromstring(open('/app/data.xml').read())\n"
            "prices = [float(e.attrib['price']) for e in root.findall('item')]\n"
            "val = round(sum(math.sqrt(p) + math.sin(p) for p in prices), 6)\n"
            "t_ok = time.monotonic() >= 0\n"
            "print(val, t_ok)"
        )
        wasm_res = harness.run_python3_wasm(["-c", code], extra_vfs=[f"{harness.FIXTURES_DIR}:/app"])
        native_code = code.replace("/app/data.xml", os.path.join(harness.FIXTURES_DIR, "data.xml"))
        native_res = harness.run_native([harness.PYTHON3_BIN, "-c", native_code])
        harness.assert_differential_eq(self, wasm_res, native_res, "T3-05")

    def test_t3_06_vfs_ro_enforcement_openat_errno_sandbox(self) -> None:
        with tempfile.TemporaryDirectory(prefix="e2e_t3_06_") as tmpdir:
            canary = os.path.join(tmpdir, "out.txt")
            code = (
                "import sys\n"
                "try:\n"
                " open('/proj/out.txt', 'w').write('bad')\n"
                "except OSError:\n"
                " sys.stderr.write('ro_blocked\\n')\n"
                " sys.exit(5)\n"
            )
            res = harness.run_python3_wasm(["-c", code], extra_vfs=[f"{tmpdir}:/proj"])
            self.assertEqual(res.exit_code, 5)
            self.assertEqual(res.stderr, b"ro_blocked\n")
            self.assertFalse(os.path.exists(canary))

    def test_t3_07_exception_unwind_across_imported_module(self) -> None:
        code = (
            "import sys\n"
            "sys.path.insert(0, '/app')\n"
            "import err_mod\n"
            "err_mod.outer_call('boom')\n"
        )
        res = harness.run_python3_wasm(["-c", code], extra_vfs=[f"{harness.FIXTURES_DIR}:/app"])
        self.assertEqual(res.exit_code, 1)
        self.assertEqual(res.stdout, b"")
        self.assertIn(b"CustomAppError: boom", res.stderr)

    def test_t3_08_translate_once_run_many_isolated(self) -> None:
        echo_wasm = harness.get_echo_wasm()
        invocations = [
            [],
            ["-n", "a"],
            ["-e", "x\\ny"],
            ["z" * 1024],
            ["café", "🚀"],
        ]
        for args in invocations:
            wasm_res = harness.run_wasm(echo_wasm, args=args)
            native_res = harness.run_native([harness.ECHO_BIN, *args])
            harness.assert_differential_eq(self, wasm_res, native_res, f"T3-08 {args!r}")


if __name__ == "__main__":
    unittest.main()
