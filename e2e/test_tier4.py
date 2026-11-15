"""Tier 4 E2E Tests: Real-World Differential & Sandbox Verification (T4-01 .. T4-06)."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness


class TestTier4DifferentialAndSandbox(unittest.TestCase):
    """Real-world differential parity and sandbox isolation tests."""

    def test_t4_01_true_parity(self) -> None:
        wasm_res = harness.run_true_wasm()
        native_res = harness.run_native([harness.TRUE_BIN])
        harness.assert_differential_eq(self, wasm_res, native_res, "T4-01 true")
        self.assertEqual(wasm_res.exit_code, 0)
        self.assertEqual(wasm_res.stdout, b"")
        self.assertEqual(wasm_res.stderr, b"")

    def test_t4_02_echo_cli_suite_parity(self) -> None:
        cases = [
            [],
            ["hello world"],
            ["-n", "no newline"],
            ["-e", "a\\tb\\nc"],
            ["-E", "a\\nb"],
            ["héllo 🚀"],
        ]
        for args in cases:
            wasm_res = harness.run_echo_wasm(args)
            native_res = harness.run_native([harness.ECHO_BIN, *args])
            harness.assert_differential_eq(self, wasm_res, native_res, f"T4-02 echo {args!r}")

    def test_t4_03_python3_calc_differential(self) -> None:
        payload = '{"values": [1.0, 2.0, 3.0, 4.0, 5.0]}'
        wasm_res = harness.run_python3_wasm(
            ["/app/calc.py", payload],
            extra_vfs=[f"{harness.FIXTURES_DIR}:/app"],
        )
        native_res = harness.run_native(
            [harness.PYTHON3_BIN, os.path.join(harness.FIXTURES_DIR, "calc.py"), payload]
        )
        harness.assert_differential_eq(self, wasm_res, native_res, "T4-03 calc.py")
        self.assertEqual(wasm_res.exit_code, 0)

    def test_t4_04_python3_xml2json_differential(self) -> None:
        wasm_res = harness.run_python3_wasm(
            ["/app/xml2json.py", "/app/data.xml"],
            extra_vfs=[f"{harness.FIXTURES_DIR}:/app"],
        )
        native_res = harness.run_native(
            [
                harness.PYTHON3_BIN,
                os.path.join(harness.FIXTURES_DIR, "xml2json.py"),
                os.path.join(harness.FIXTURES_DIR, "data.xml"),
            ]
        )
        harness.assert_differential_eq(self, wasm_res, native_res, "T4-04 xml2json.py")
        self.assertEqual(wasm_res.exit_code, 0)

    def test_t4_05_python3_validate_error_contract(self) -> None:
        for arg in ("not_a_number", "-5", "42"):
            wasm_res = harness.run_python3_wasm(
                ["/app/validate.py", arg],
                extra_vfs=[f"{harness.FIXTURES_DIR}:/app"],
            )
            native_res = harness.run_native(
                [harness.PYTHON3_BIN, os.path.join(harness.FIXTURES_DIR, "validate.py"), arg]
            )
            harness.assert_differential_eq(self, wasm_res, native_res, f"T4-05 validate {arg!r}")

    def test_t4_06_host_isolation_and_sandbox_escape(self) -> None:
        with tempfile.TemporaryDirectory(prefix="e2e_t4_06_") as tmpdir:
            tmp_canary = os.path.join(tmpdir, "e2e_canary.txt")
            ro_canary = "/app/canary.txt"
            ro_existing = "/app/data.xml"
            res = harness.run_python3_wasm(
                ["/app/sandbox_probe.py", tmp_canary, ro_canary, ro_existing],
                extra_vfs=[f"{harness.FIXTURES_DIR}:/app"],
            )
            self.assertEqual(res.exit_code, 0, res.stderr.decode(errors="replace"))
            records = json.loads(res.stdout.decode("utf-8"))
            self.assertTrue(all(r["blocked"] for r in records), f"Expected all ops blocked: {records}")
            self.assertFalse(os.path.exists(tmp_canary))
            self.assertFalse(os.path.exists(os.path.join(harness.FIXTURES_DIR, "canary.txt")))
            self.assertTrue(os.path.exists(os.path.join(harness.FIXTURES_DIR, "data.xml")))


if __name__ == "__main__":
    unittest.main()
