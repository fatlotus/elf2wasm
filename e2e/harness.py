"""Opaque-box E2E test harness for elf2wasm.

Interacts with elf2wasm exclusively through the external CLI:
  - elf2wasm translate <elf> [--so <so>...] -o <out.wasm>
  - elf2wasm run <out.wasm> [--vfs-ro <host:guest>...] [-- <args>...]
"""

from __future__ import annotations

import atexit
import os
import subprocess
import tempfile
import unittest
from dataclasses import dataclass
from typing import Iterable

DEFAULT_BIN = "/home/antigravity/elf2wasm/target/debug/elf2wasm"

TRUE_BIN = "/usr/bin/true"
ECHO_BIN = "/usr/bin/echo"
PYTHON3_BIN = "/usr/bin/python3"

LD_SO = "/lib64/ld-linux-x86-64.so.2"
LIBC_SO = "/lib/x86_64-linux-gnu/libc.so.6"
LIBM_SO = "/lib/x86_64-linux-gnu/libm.so.6"
LIBZ_SO = "/lib/x86_64-linux-gnu/libz.so.1"
LIBEXPAT_SO = "/lib/x86_64-linux-gnu/libexpat.so.1"

BASIC_SOS: tuple[str, ...] = (LD_SO, LIBC_SO)
PYTHON3_SOS: tuple[str, ...] = (LD_SO, LIBC_SO, LIBM_SO, LIBZ_SO, LIBEXPAT_SO)

PYTHON3_VFS_MOUNTS: tuple[str, ...] = (
    "/usr/lib/python3.11:/usr/lib/python3.11",
    "/usr/lib/python3/dist-packages:/usr/lib/python3/dist-packages",
)

E2E_DIR = os.path.dirname(os.path.abspath(__file__))
FIXTURES_DIR = os.path.join(E2E_DIR, "fixtures")


@dataclass(frozen=True)
class RunResult:
    exit_code: int
    stdout: bytes
    stderr: bytes


_CACHE_TEMP_DIR: tempfile.TemporaryDirectory[str] | None = None
_TRANSLATION_CACHE: dict[tuple[str, tuple[str, ...]], str] = {}


def _cleanup_cache() -> None:
    global _CACHE_TEMP_DIR
    if _CACHE_TEMP_DIR is not None:
        _CACHE_TEMP_DIR.cleanup()
        _CACHE_TEMP_DIR = None
    _TRANSLATION_CACHE.clear()


atexit.register(_cleanup_cache)


def get_cache_dir() -> str:
    global _CACHE_TEMP_DIR
    if _CACHE_TEMP_DIR is None:
        _CACHE_TEMP_DIR = tempfile.TemporaryDirectory(prefix="elf2wasm_e2e_cache_")
    return _CACHE_TEMP_DIR.name


def get_elf2wasm_bin() -> str:
    return os.environ.get("ELF2WASM_BIN", DEFAULT_BIN)


def translate(
    elf_path: str,
    so_paths: Iterable[str] = (),
    out_wasm: str | None = None,
    timeout: int = 120,
) -> tuple[RunResult, str]:
    """Invoke `elf2wasm translate <elf> [--so <so>...] -o <out.wasm>`."""
    if out_wasm is None:
        fd, out_wasm = tempfile.mkstemp(prefix="elf2wasm_", suffix=".wasm", dir=get_cache_dir())
        os.close(fd)

    cmd = [get_elf2wasm_bin(), "translate", elf_path]
    for so in so_paths:
        cmd.extend(["--so", so])
    cmd.extend(["-o", out_wasm])

    proc = subprocess.run(cmd, capture_output=True, timeout=timeout)
    return RunResult(proc.returncode, proc.stdout, proc.stderr), out_wasm


def run_wasm(
    wasm_path: str,
    args: Iterable[str] | None = None,
    vfs_ro: Iterable[str] = (),
    timeout: int = 60,
) -> RunResult:
    """Invoke `elf2wasm run <out.wasm> [--vfs-ro <host:guest>...] [-- <args>...]`."""
    cmd = [get_elf2wasm_bin(), "run", wasm_path]
    for mount in vfs_ro:
        cmd.extend(["--vfs-ro", mount])
    if args is not None:
        arg_list = list(args)
        if arg_list:
            cmd.append("--")
            cmd.extend(arg_list)

    proc = subprocess.run(cmd, capture_output=True, timeout=timeout)
    return RunResult(proc.returncode, proc.stdout, proc.stderr)


def translate_cached(elf_path: str, so_paths: Iterable[str], name: str | None = None) -> str:
    """Translate `elf_path` with `so_paths` once per test run and cache the `.wasm` path."""
    so_tuple = tuple(so_paths)
    key = (elf_path, so_tuple)
    if key in _TRANSLATION_CACHE and os.path.exists(_TRANSLATION_CACHE[key]):
        return _TRANSLATION_CACHE[key]

    tag = name or os.path.basename(elf_path)
    out_wasm = os.path.join(get_cache_dir(), f"{tag}_{len(_TRANSLATION_CACHE)}.wasm")
    res, wasm_path = translate(elf_path, so_tuple, out_wasm=out_wasm)
    if res.exit_code != 0:
        raise AssertionError(
            f"elf2wasm translate failed for {elf_path} (exit {res.exit_code}):\n"
            f"stdout: {res.stdout.decode(errors='replace')}\n"
            f"stderr: {res.stderr.decode(errors='replace')}"
        )
    if not os.path.exists(wasm_path) or os.path.getsize(wasm_path) == 0:
        raise AssertionError(f"elf2wasm translate produced missing/empty wasm at {wasm_path}")

    _TRANSLATION_CACHE[key] = wasm_path
    return wasm_path


def get_true_wasm() -> str:
    return translate_cached(TRUE_BIN, BASIC_SOS, name="true")


def get_echo_wasm() -> str:
    return translate_cached(ECHO_BIN, BASIC_SOS, name="echo")


def get_python3_wasm() -> str:
    return translate_cached(PYTHON3_BIN, PYTHON3_SOS, name="python3")


def run_true_wasm(args: Iterable[str] | None = None, timeout: int = 60) -> RunResult:
    return run_wasm(get_true_wasm(), args=args, timeout=timeout)


def run_echo_wasm(args: Iterable[str] | None = None, timeout: int = 60) -> RunResult:
    return run_wasm(get_echo_wasm(), args=args, timeout=timeout)


def run_python3_wasm(
    args: Iterable[str] | None = None,
    extra_vfs: Iterable[str] = (),
    include_stdlib: bool = True,
    timeout: int = 60,
) -> RunResult:
    mounts: list[str] = []
    if include_stdlib:
        mounts.extend(PYTHON3_VFS_MOUNTS)
    mounts.extend(extra_vfs)
    return run_wasm(get_python3_wasm(), args=args, vfs_ro=mounts, timeout=timeout)


def run_native(cmd: list[str], timeout: int = 60) -> RunResult:
    """Execute a native host command for differential comparison."""
    proc = subprocess.run(cmd, capture_output=True, timeout=timeout)
    return RunResult(proc.returncode, proc.stdout, proc.stderr)


def assert_differential_eq(
    test_case: unittest.TestCase,
    wasm_res: RunResult,
    native_res: RunResult,
    context: str = "",
) -> None:
    """Assert byte-for-byte identical exit_code, stdout, and stderr."""
    prefix = f"[{context}] " if context else ""
    test_case.assertEqual(
        wasm_res.exit_code,
        native_res.exit_code,
        f"{prefix}exit_code mismatch: wasm={wasm_res.exit_code} vs native={native_res.exit_code}\n"
        f"wasm stderr: {wasm_res.stderr!r}\nnative stderr: {native_res.stderr!r}",
    )
    test_case.assertEqual(
        wasm_res.stdout,
        native_res.stdout,
        f"{prefix}stdout mismatch:\nwasm:   {wasm_res.stdout!r}\nnative: {native_res.stdout!r}",
    )
    test_case.assertEqual(
        wasm_res.stderr,
        native_res.stderr,
        f"{prefix}stderr mismatch:\nwasm:   {wasm_res.stderr!r}\nnative: {native_res.stderr!r}",
    )
