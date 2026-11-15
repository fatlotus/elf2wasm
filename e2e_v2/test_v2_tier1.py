"""Tier 1 E2E v2 tests: Feature coverage F1-F11 via compiler.wasm + runtime.wasm + JS shim."""

from __future__ import annotations

import re
import unittest

from harness_v2 import (
    BASIC_SOS,
    ECHO_BIN,
    PTHREAD_SOS,
    TRUE_BIN,
    compile_fixture,
    compile_via_compiler_wasm,
    require_v2_artifacts,
    run_wasm_js,
)

WASM_MAGIC = b"\x00asm\x01\x00\x00\x00"


class TestV2Tier1Features(unittest.TestCase):
    def setUp(self) -> None:
        require_v2_artifacts()

    def test_f3_compiler_wasm_compiles_true(self) -> None:
        res, out_wasm = compile_via_compiler_wasm(TRUE_BIN, BASIC_SOS)
        self.assertEqual(res.exit_code, 0, res.stderr.decode(errors="replace"))
        with open(out_wasm, "rb") as f:
            magic = f.read(8)
        self.assertEqual(magic, WASM_MAGIC, "compiler.wasm did not emit valid WASM magic")

    def test_f3_compiler_wasm_compiles_echo(self) -> None:
        res, out_wasm = compile_via_compiler_wasm(ECHO_BIN, BASIC_SOS)
        self.assertEqual(res.exit_code, 0, res.stderr.decode(errors="replace"))
        with open(out_wasm, "rb") as f:
            magic = f.read(8)
        self.assertEqual(magic, WASM_MAGIC)

    def test_f11_js_shim_runs_true(self) -> None:
        res = run_wasm_js(TRUE_BIN, BASIC_SOS)
        self.assertEqual(res.exit_code, 0, res.stderr.decode(errors="replace"))
        self.assertEqual(res.stdout, b"")
        self.assertEqual(res.stderr, b"")

    def test_f11_js_shim_runs_echo(self) -> None:
        res = run_wasm_js(ECHO_BIN, BASIC_SOS, args=["hello", "wasm_v2"])
        self.assertEqual(res.exit_code, 0, res.stderr.decode(errors="replace"))
        self.assertEqual(res.stdout, b"hello wasm_v2\n")

    def test_f6_writable_vfs_ops(self) -> None:
        elf = compile_fixture("vfs_ops")
        res = run_wasm_js(elf, BASIC_SOS, args=["/tmp/v2_vfs_t1"])
        self.assertEqual(res.exit_code, 0, res.stderr.decode(errors="replace"))
        self.assertIn(b"VFS_MKDIR=OK\n", res.stdout)
        self.assertIn(b"VFS_WRITE_READ=OK\n", res.stdout)
        self.assertIn(b"VFS_FTRUNCATE=OK\n", res.stdout)
        self.assertIn(b"VFS_APPEND=OK\n", res.stdout)
        self.assertIn(b"VFS_RENAME=OK\n", res.stdout)
        self.assertIn(b"VFS_UNLINK=OK\n", res.stdout)
        self.assertIn(b"VFS_ALL_OK\n", res.stdout)

    def test_f7_simulated_time_clock_advances(self) -> None:
        elf = compile_fixture("sleep_test")
        res = run_wasm_js(elf, BASIC_SOS)
        self.assertEqual(res.exit_code, 0, res.stderr.decode(errors="replace"))
        m = re.search(rb"ELAPSED_NS=(\d+)\n", res.stdout)
        self.assertIsNotNone(m, f"Missing ELAPSED_NS= in stdout: {res.stdout!r}")
        assert m is not None
        self.assertGreaterEqual(int(m.group(1)), 65_000_000_000)

    def test_f8_cooperative_pthreads_join(self) -> None:
        elf = compile_fixture("racy_threads", extra_flags=("-pthread",))
        res = run_wasm_js(elf, PTHREAD_SOS)
        self.assertEqual(res.exit_code, 0, res.stderr.decode(errors="replace"))
        m = re.search(rb"COUNTER=(\d+)\n", res.stdout)
        self.assertIsNotNone(m, f"Missing COUNTER= in stdout: {res.stdout!r}")
        assert m is not None
        val = int(m.group(1))
        self.assertGreater(val, 0)
        self.assertLessEqual(val, 400_000)


if __name__ == "__main__":
    unittest.main()
