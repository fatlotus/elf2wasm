"""Tier 2 E2E v2 tests: Boundary, error-handling, and corner cases."""

from __future__ import annotations

import os
import re
import tempfile
import unittest

from harness_v2 import (
    BASIC_SOS,
    ECHO_BIN,
    compile_fixture,
    compile_via_compiler_wasm,
    require_v2_artifacts,
    run_wasm_js,
)


class TestV2Tier2Boundaries(unittest.TestCase):
    def setUp(self) -> None:
        require_v2_artifacts()

    def test_invalid_elf_rejected_by_compiler_wasm(self) -> None:
        with tempfile.NamedTemporaryFile(prefix="bad_elf_", delete=False) as tf:
            tf.write(b"NOT_AN_ELF_BINARY_0123456789")
            bad_path = tf.name
        try:
            res, _ = compile_via_compiler_wasm(bad_path, BASIC_SOS)
            self.assertNotEqual(res.exit_code, 0, "compiler.wasm must reject invalid ELF")
            self.assertGreater(len(res.stderr), 0, "expected diagnostic on stderr for invalid ELF")
        finally:
            if os.path.exists(bad_path):
                os.unlink(bad_path)

    def test_missing_vfs_file_returns_nonzero(self) -> None:
        cat_bin = "/usr/bin/cat"
        res = run_wasm_js(cat_bin, BASIC_SOS, args=["/nonexistent_v2_file_99999.txt"])
        self.assertNotEqual(res.exit_code, 0)
        self.assertGreater(len(res.stderr), 0)

    def test_large_argv_to_echo(self) -> None:
        args = [f"arg_{i:03d}_payload" for i in range(100)]
        res = run_wasm_js(ECHO_BIN, BASIC_SOS, args=args)
        self.assertEqual(res.exit_code, 0, res.stderr.decode(errors="replace"))
        expected = (" ".join(args) + "\n").encode("utf-8")
        self.assertEqual(res.stdout, expected)

    def test_vfs_rdonly_write_rejected_with_ebadf_or_eacces(self) -> None:
        elf = compile_fixture("vfs_ops")
        res = run_wasm_js(elf, BASIC_SOS, args=["/tmp/v2_vfs_ro_check"])
        self.assertEqual(res.exit_code, 0, res.stderr.decode(errors="replace"))
        m = re.search(rb"VFS_RDONLY_WRITE_ERR=(\d+)\n", res.stdout)
        self.assertIsNotNone(m, f"Missing VFS_RDONLY_WRITE_ERR in stdout: {res.stdout!r}")
        assert m is not None
        err_no = int(m.group(1))
        self.assertIn(err_no, (9, 13), f"Expected EBADF(9) or EACCES(13), got {err_no}")

    def test_futex_and_nanosleep_boundaries(self) -> None:
        elf = compile_fixture("futex_boundary")
        res = run_wasm_js(elf, BASIC_SOS)
        self.assertEqual(res.exit_code, 0, res.stderr.decode(errors="replace"))
        self.assertIn(b"FUTEX_EAGAIN=OK\n", res.stdout)
        self.assertIn(b"FUTEX_TIMEOUT=OK\n", res.stdout)
        self.assertIn(b"NANOSLEEP_ZERO=OK\n", res.stdout)
        self.assertIn(b"NANOSLEEP_EINVAL=OK\n", res.stdout)
        self.assertIn(b"FUTEX_BOUNDARY_OK\n", res.stdout)

    def test_multiproc_pipe_eof_and_exit_status(self) -> None:
        elf = compile_fixture("multiproc")
        res = run_wasm_js(elf, BASIC_SOS, args=["/tmp/v2_multiproc_t2.txt"])
        self.assertEqual(res.exit_code, 0, res.stderr.decode(errors="replace"))
        self.assertIn(b"PIPE_MSG=FROM_CHILD_PIPE\n", res.stdout)
        self.assertIn(b"CHILD_EXIT=7\n", res.stdout)


if __name__ == "__main__":
    unittest.main()
