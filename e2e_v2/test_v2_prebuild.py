"""Pre-build verification tests for E2E v2 fixtures and JS runner syntax.

These tests run on the pre-M1 baseline (no WASM artifacts required) to ensure:
  - All C11/POSIX fixtures in `e2e_v2/fixtures/` compile cleanly with `gcc`.
  - Non-sleeping fixtures execute cleanly on the host.
  - `e2e_v2/js_runner.mjs` (and any `js/*.mjs` if present) pass `node --check`.
"""

from __future__ import annotations

import glob
import os
import re
import subprocess
import tempfile
import unittest

from harness_v2 import (
    JS_RUNNER_PATH,
    REPO_ROOT,
    compile_fixture,
    get_node_bin,
    run_host_native,
)


class TestV2Prebuild(unittest.TestCase):
    def test_js_runner_syntax_valid(self) -> None:
        node = get_node_bin()
        proc = subprocess.run([node, "--check", JS_RUNNER_PATH], capture_output=True)
        self.assertEqual(
            proc.returncode,
            0,
            f"node --check failed on {JS_RUNNER_PATH}:\n{proc.stderr.decode(errors='replace')}",
        )

        js_dir = os.path.join(REPO_ROOT, "js")
        if os.path.isdir(js_dir):
            for mjs in sorted(glob.glob(os.path.join(js_dir, "*.mjs"))):
                p = subprocess.run([node, "--check", mjs], capture_output=True)
                self.assertEqual(
                    p.returncode,
                    0,
                    f"node --check failed on {mjs}:\n{p.stderr.decode(errors='replace')}",
                )

    def test_vfs_ops_fixture_compiles_and_runs_natively(self) -> None:
        bin_path = compile_fixture("vfs_ops")
        with tempfile.TemporaryDirectory(prefix="vfs_ops_pre_") as tmpdir:
            res = run_host_native([bin_path, os.path.join(tmpdir, "root")])
            self.assertEqual(res.exit_code, 0, res.stderr.decode(errors="replace"))
            self.assertIn(b"VFS_ALL_OK\n", res.stdout)

    def test_sleep_test_fixture_compiles_to_elf64(self) -> None:
        bin_path = compile_fixture("sleep_test")
        with open(bin_path, "rb") as f:
            hdr = f.read(5)
        self.assertEqual(hdr, b"\x7fELF\x02", "sleep_test is not ELF64")

    def test_racy_threads_fixture_compiles_and_runs_natively(self) -> None:
        bin_path = compile_fixture("racy_threads", extra_flags=("-pthread",))
        res = run_host_native([bin_path])
        self.assertEqual(res.exit_code, 0, res.stderr.decode(errors="replace"))
        m = re.search(rb"COUNTER=(\d+)\n", res.stdout)
        self.assertIsNotNone(m, f"Missing COUNTER= in stdout: {res.stdout!r}")
        assert m is not None
        val = int(m.group(1))
        self.assertGreater(val, 0)
        self.assertLessEqual(val, 400000)

    def test_multiproc_fixture_compiles_and_runs_natively(self) -> None:
        bin_path = compile_fixture("multiproc")
        with tempfile.TemporaryDirectory(prefix="multiproc_pre_") as tmpdir:
            shared = os.path.join(tmpdir, "shared.txt")
            res = run_host_native([bin_path, shared])
            self.assertEqual(res.exit_code, 0, res.stderr.decode(errors="replace"))
            self.assertIn(b"PIPE_MSG=FROM_CHILD_PIPE\n", res.stdout)
            self.assertIn(b"VFS_MSG=FROM_CHILD_VFS\n", res.stdout)
            self.assertIn(b"CHILD_EXIT=7\n", res.stdout)
            self.assertIn(b"MULTIPROC_OK\n", res.stdout)

    def test_hello_c_target_fixture_compiles_and_runs_natively(self) -> None:
        bin_path = compile_fixture("hello_c_target")
        res = run_host_native([bin_path])
        self.assertEqual(res.exit_code, 0, res.stderr.decode(errors="replace"))
        self.assertEqual(res.stdout, b"HELLO_FROM_HOSTED_CC\n")

    def test_futex_boundary_fixture_compiles_and_runs_natively(self) -> None:
        bin_path = compile_fixture("futex_boundary")
        res = run_host_native([bin_path])
        self.assertEqual(res.exit_code, 0, res.stderr.decode(errors="replace"))
        self.assertIn(b"FUTEX_EAGAIN=OK\n", res.stdout)
        self.assertIn(b"FUTEX_TIMEOUT=OK\n", res.stdout)
        self.assertIn(b"NANOSLEEP_ZERO=OK\n", res.stdout)
        self.assertIn(b"NANOSLEEP_EINVAL=OK\n", res.stdout)
        self.assertIn(b"FUTEX_BOUNDARY_OK\n", res.stdout)


if __name__ == "__main__":
    unittest.main()
