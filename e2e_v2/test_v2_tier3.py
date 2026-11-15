"""Tier 3 E2E v2 tests: Multi-process & Victory Cases (F10, F12, F13, F14)."""

from __future__ import annotations

import os
import re
import unittest

from harness_v2 import (
    BASIC_SOS,
    FIXTURES_DIR,
    GCC_BIN,
    PTHREAD_SOS,
    compile_fixture,
    require_v2_artifacts,
    run_compile_and_run_vfs,
    run_native_cli,
    run_wasm_js,
    translate_native,
)


class TestV2Tier3VictoryCases(unittest.TestCase):
    def setUp(self) -> None:
        require_v2_artifacts()

    def test_f10_multiproc_fork_pipe_vfs_waitpid(self) -> None:
        elf = compile_fixture("multiproc")
        res = run_wasm_js(elf, BASIC_SOS, args=["/tmp/v2_multiproc_t3.txt"])
        self.assertEqual(res.exit_code, 0, res.stderr.decode(errors="replace"))
        self.assertIn(b"PIPE_MSG=FROM_CHILD_PIPE\n", res.stdout)
        self.assertIn(b"VFS_MSG=FROM_CHILD_VFS\n", res.stdout)
        self.assertIn(b"CHILD_EXIT=7\n", res.stdout)
        self.assertIn(b"MULTIPROC_OK\n", res.stdout)

    def test_f10_multiproc_fork_dup2_execve_two_modules(self) -> None:
        multiproc_elf = compile_fixture("multiproc")
        hello_elf = compile_fixture("hello_c_target")
        res = run_wasm_js(
            multiproc_elf,
            BASIC_SOS,
            args=["--exec", "/guest/hello.elf"],
            vfs_ro=[f"{hello_elf}:/guest/hello.elf"],
        )
        self.assertEqual(res.exit_code, 0, res.stderr.decode(errors="replace"))
        self.assertIn(b"PIPE_MSG=HELLO_FROM_HOSTED_CC\n", res.stdout)
        self.assertIn(b"CHILD_EXIT=0\n", res.stdout)
        self.assertIn(b"MULTIPROC_OK\n", res.stdout)

    def test_f13_easy_victory_fast_sleep_js_and_native(self) -> None:
        elf = compile_fixture("sleep_test")

        # 1. JS + WASM shim
        js_res = run_wasm_js(elf, BASIC_SOS)
        self.assertEqual(js_res.exit_code, 0, js_res.stderr.decode(errors="replace"))
        m = re.search(rb"ELAPSED_NS=(\d+)\n", js_res.stdout)
        self.assertIsNotNone(m, f"Missing ELAPSED_NS= in JS stdout: {js_res.stdout!r}")
        assert m is not None
        self.assertGreaterEqual(int(m.group(1)), 65_000_000_000)
        self.assertLess(
            js_res.wall_time_s,
            1.0,
            f"JS+WASM sleep_test took {js_res.wall_time_s:.3f}s wall time (expected < 1.0s)",
        )

        # 2. Native CLI
        tr_res, wasm_path = translate_native(elf, BASIC_SOS)
        self.assertEqual(tr_res.exit_code, 0, tr_res.stderr.decode(errors="replace"))
        nat_res = run_native_cli(wasm_path)
        self.assertEqual(nat_res.exit_code, 0, nat_res.stderr.decode(errors="replace"))
        m2 = re.search(rb"ELAPSED_NS=(\d+)\n", nat_res.stdout)
        self.assertIsNotNone(m2, f"Missing ELAPSED_NS= in native stdout: {nat_res.stdout!r}")
        assert m2 is not None
        self.assertGreaterEqual(int(m2.group(1)), 65_000_000_000)
        self.assertLess(
            nat_res.wall_time_s,
            1.0,
            f"Native CLI sleep_test took {nat_res.wall_time_s:.3f}s wall time (expected < 1.0s)",
        )

    def test_f14_hard_victory_deterministic_racy_threads(self) -> None:
        elf = compile_fixture("racy_threads", extra_flags=("-pthread",))
        outputs: list[bytes] = []
        for i in range(5):
            res = run_wasm_js(elf, PTHREAD_SOS)
            self.assertEqual(res.exit_code, 0, f"Run {i} failed: {res.stderr!r}")
            outputs.append(res.stdout)

        m = re.search(rb"COUNTER=(\d+)\n", outputs[0])
        self.assertIsNotNone(m, f"Missing COUNTER= in stdout: {outputs[0]!r}")
        assert m is not None
        counter = int(m.group(1))
        self.assertGreater(counter, 0, "counter must be > 0")
        self.assertLess(
            counter,
            400_000,
            f"Expected genuine data race (0 < counter < 400000), got {counter}",
        )

        for i in range(1, 5):
            self.assertEqual(
                outputs[i],
                outputs[0],
                f"Non-deterministic output on run {i}: {outputs[i]!r} != {outputs[0]!r}",
            )

    def test_f12_c_compiler_victory_case(self) -> None:
        source_path = os.path.join(FIXTURES_DIR, "hello_c_target.c")
        vfs_ro = [
            "/usr/include:/usr/include",
            "/usr/lib/gcc:/usr/lib/gcc",
            "/usr/bin:/usr/bin",
            "/lib:/lib",
            "/lib64:/lib64",
        ]
        res = run_compile_and_run_vfs(
            cc_path=GCC_BIN,
            source_host_path=source_path,
            guest_source_path="/work/hello.c",
            guest_out_path="/work/hello.elf",
            so_paths=BASIC_SOS,
            vfs_ro=vfs_ro,
            timeout=240,
        )
        self.assertEqual(res.exit_code, 0, res.stderr.decode(errors="replace"))
        self.assertEqual(res.stdout, b"HELLO_FROM_HOSTED_CC\n")


if __name__ == "__main__":
    unittest.main()
