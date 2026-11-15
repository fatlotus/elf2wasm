"""Opaque-box E2E v2 test harness for elf2wasm.

Supports:
  - Compiling C11/POSIX fixtures in `e2e_v2/fixtures/` via `gcc`.
  - Exercising `compiler.wasm` + `runtime.wasm` + `js/elf2wasm_shim.mjs` via `e2e_v2/js_runner.mjs`.
  - Exercising the native `elf2wasm` CLI (`translate` and `run`) for parity & victory checks.
"""

from __future__ import annotations

import atexit
import json
import os
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass
from typing import Iterable

E2E_V2_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(E2E_V2_DIR, ".."))
FIXTURES_DIR = os.path.join(E2E_V2_DIR, "fixtures")
JS_RUNNER_PATH = os.path.join(E2E_V2_DIR, "js_runner.mjs")

TRUE_BIN = "/usr/bin/true"
ECHO_BIN = "/usr/bin/echo"
GCC_BIN = "/usr/bin/gcc"

LD_SO = "/lib64/ld-linux-x86-64.so.2"
LIBC_SO = "/lib/x86_64-linux-gnu/libc.so.6"
LIBPTHREAD_SO = "/lib/x86_64-linux-gnu/libpthread.so.0"
LIBM_SO = "/lib/x86_64-linux-gnu/libm.so.6"

BASIC_SOS: tuple[str, ...] = (LD_SO, LIBC_SO)
PTHREAD_SOS: tuple[str, ...] = tuple(
    p for p in (LD_SO, LIBC_SO, LIBPTHREAD_SO) if os.path.exists(p)
)


@dataclass(frozen=True)
class RunResult:
    exit_code: int
    stdout: bytes
    stderr: bytes
    wall_time_s: float = 0.0


_CACHE_TEMP_DIR: tempfile.TemporaryDirectory[str] | None = None
_FIXTURE_BIN_CACHE: dict[tuple[str, tuple[str, ...]], str] = {}


def _cleanup_cache() -> None:
    global _CACHE_TEMP_DIR
    if _CACHE_TEMP_DIR is not None:
        _CACHE_TEMP_DIR.cleanup()
        _CACHE_TEMP_DIR = None
    _FIXTURE_BIN_CACHE.clear()


atexit.register(_cleanup_cache)


def get_cache_dir() -> str:
    global _CACHE_TEMP_DIR
    if _CACHE_TEMP_DIR is None:
        _CACHE_TEMP_DIR = tempfile.TemporaryDirectory(prefix="elf2wasm_e2e_v2_")
    return _CACHE_TEMP_DIR.name


def get_node_bin() -> str:
    return shutil.which("node") or "/usr/local/bin/node"


def get_elf2wasm_bin() -> str:
    env_bin = os.environ.get("ELF2WASM_BIN")
    if env_bin:
        return env_bin
    for rel in ("target/release/elf2wasm", "target/debug/elf2wasm"):
        cand = os.path.join(REPO_ROOT, rel)
        if os.path.exists(cand):
            return cand
    return os.path.join(REPO_ROOT, "target/debug/elf2wasm")


def _resolve_wasm_artifact(env_var: str, candidates: Iterable[str]) -> str | None:
    env_val = os.environ.get(env_var)
    if env_val:
        return env_val
    for rel in candidates:
        cand = os.path.join(REPO_ROOT, rel)
        if os.path.exists(cand):
            return cand
    return None


def get_compiler_wasm() -> str | None:
    return _resolve_wasm_artifact(
        "ELF2WASM_COMPILER_WASM",
        (
            "target/wasm32-unknown-unknown/release/elf2wasm_compiler_wasm.wasm",
            "target/wasm32-unknown-unknown/debug/elf2wasm_compiler_wasm.wasm",
            "target/wasm32-unknown-unknown/release/compiler.wasm",
            "target/wasm32-unknown-unknown/debug/compiler.wasm",
            "js/compiler.wasm",
        ),
    )


def get_runtime_wasm() -> str | None:
    return _resolve_wasm_artifact(
        "ELF2WASM_RUNTIME_WASM",
        (
            "target/wasm32-unknown-unknown/release/elf2wasm_runtime_wasm.wasm",
            "target/wasm32-unknown-unknown/debug/elf2wasm_runtime_wasm.wasm",
            "target/wasm32-unknown-unknown/release/runtime.wasm",
            "target/wasm32-unknown-unknown/debug/runtime.wasm",
            "js/runtime.wasm",
        ),
    )


def get_js_shim_path() -> str | None:
    env_val = os.environ.get("ELF2WASM_SHIM_PATH")
    if env_val:
        return env_val
    cand = os.path.join(REPO_ROOT, "js/elf2wasm_shim.mjs")
    return cand if os.path.exists(cand) else None


def require_v2_artifacts() -> tuple[str, str, str]:
    """Verify that compiler.wasm, runtime.wasm, and js/elf2wasm_shim.mjs exist.

    Raises AssertionError with actionable build instructions if any are missing.
    Never skips or silently passes.
    """
    compiler = get_compiler_wasm()
    runtime = get_runtime_wasm()
    shim = get_js_shim_path()
    missing: list[str] = []
    if not compiler or not os.path.exists(compiler):
        missing.append(
            "compiler.wasm (build crates/elf2wasm-compiler-wasm for wasm32-unknown-unknown or set ELF2WASM_COMPILER_WASM)"
        )
    if not runtime or not os.path.exists(runtime):
        missing.append(
            "runtime.wasm (build crates/elf2wasm-runtime-wasm for wasm32-unknown-unknown or set ELF2WASM_RUNTIME_WASM)"
        )
    if not shim or not os.path.exists(shim):
        missing.append("js/elf2wasm_shim.mjs (implement M3 JS shim or set ELF2WASM_SHIM_PATH)")

    if missing:
        raise AssertionError(
            "Missing required E2E v2 WASM/JS artifacts:\n  - " + "\n  - ".join(missing)
        )
    assert compiler is not None and runtime is not None and shim is not None
    return compiler, runtime, shim


def compile_fixture(name: str, extra_flags: Iterable[str] = ()) -> str:
    """Compile `e2e_v2/fixtures/<name>.c` with `gcc` and return the ELF binary path."""
    flags_tuple = tuple(extra_flags)
    key = (name, flags_tuple)
    if key in _FIXTURE_BIN_CACHE and os.path.exists(_FIXTURE_BIN_CACHE[key]):
        return _FIXTURE_BIN_CACHE[key]

    src_path = os.path.join(FIXTURES_DIR, f"{name}.c")
    if not os.path.exists(src_path):
        raise FileNotFoundError(f"Fixture source not found: {src_path}")

    out_bin = os.path.join(get_cache_dir(), f"{name}_{len(_FIXTURE_BIN_CACHE)}")
    cmd = [GCC_BIN, "-Wall", "-Wextra", "-O2", src_path, "-o", out_bin, *flags_tuple]
    proc = subprocess.run(cmd, capture_output=True, timeout=60)
    if proc.returncode != 0:
        raise AssertionError(
            f"gcc failed compiling {src_path}:\n"
            f"cmd: {' '.join(cmd)}\n"
            f"stdout: {proc.stdout.decode(errors='replace')}\n"
            f"stderr: {proc.stderr.decode(errors='replace')}"
        )
    _FIXTURE_BIN_CACHE[key] = out_bin
    return out_bin


def compile_via_compiler_wasm(
    elf_path: str,
    so_paths: Iterable[str] = (),
    out_wasm: str | None = None,
    timeout: int = 120,
) -> tuple[RunResult, str]:
    """Invoke `js_runner.mjs compile` using `compiler.wasm`."""
    compiler_wasm, _, shim_path = require_v2_artifacts()
    if out_wasm is None:
        fd, out_wasm = tempfile.mkstemp(prefix="v2_guest_", suffix=".wasm", dir=get_cache_dir())
        os.close(fd)

    cmd = [
        get_node_bin(),
        JS_RUNNER_PATH,
        "compile",
        "--compiler",
        compiler_wasm,
        "--elf",
        elf_path,
        "--out",
        out_wasm,
    ]
    for so in so_paths:
        cmd.extend(["--so", so])

    env = os.environ.copy()
    env["ELF2WASM_SHIM_PATH"] = shim_path
    t0 = time.monotonic()
    proc = subprocess.run(cmd, capture_output=True, timeout=timeout, env=env)
    wall = time.monotonic() - t0
    return RunResult(proc.returncode, proc.stdout, proc.stderr, wall), out_wasm


def run_wasm_js(
    elf_path: str,
    so_paths: Iterable[str] = (),
    args: Iterable[str] = (),
    vfs_ro: Iterable[str] = (),
    vfs_rw: Iterable[str] = (),
    timeout: int = 120,
) -> RunResult:
    """Run an ELF binary through `compiler.wasm` + `runtime.wasm` + `js/elf2wasm_shim.mjs`."""
    compiler_wasm, runtime_wasm, shim_path = require_v2_artifacts()
    cmd = [
        get_node_bin(),
        JS_RUNNER_PATH,
        "run",
        "--compiler",
        compiler_wasm,
        "--runtime",
        runtime_wasm,
        "--elf",
        elf_path,
        "--json",
    ]
    for so in so_paths:
        cmd.extend(["--so", so])
    for m in vfs_ro:
        cmd.extend(["--vfs-ro", m])
    for m in vfs_rw:
        cmd.extend(["--vfs-rw", m])

    arg_list = list(args)
    if arg_list:
        cmd.append("--")
        cmd.extend(arg_list)

    env = os.environ.copy()
    env["ELF2WASM_SHIM_PATH"] = shim_path
    t0 = time.monotonic()
    proc = subprocess.run(cmd, capture_output=True, timeout=timeout, env=env)
    wall = time.monotonic() - t0

    if proc.returncode != 0:
        return RunResult(proc.returncode, proc.stdout, proc.stderr, wall)

    try:
        payload = json.loads(proc.stdout.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise AssertionError(
            f"js_runner.mjs --json produced invalid JSON: {exc}\n"
            f"stdout: {proc.stdout!r}\nstderr: {proc.stderr!r}"
        ) from exc

    return RunResult(
        exit_code=int(payload["exitCode"]),
        stdout=str(payload.get("stdout", "")).encode("utf-8"),
        stderr=str(payload.get("stderr", "")).encode("utf-8"),
        wall_time_s=float(payload.get("wallMs", wall * 1000.0)) / 1000.0,
    )


def run_compile_and_run_vfs(
    cc_path: str,
    source_host_path: str,
    guest_source_path: str = "/work/hello.c",
    guest_out_path: str = "/work/hello.elf",
    so_paths: Iterable[str] = (),
    vfs_ro: Iterable[str] = (),
    vfs_rw: Iterable[str] = (),
    timeout: int = 180,
) -> RunResult:
    """Run C compiler inside WASM system -> ELF in VFS -> compiler.wasm -> run guest WASM."""
    compiler_wasm, runtime_wasm, shim_path = require_v2_artifacts()
    cmd = [
        get_node_bin(),
        JS_RUNNER_PATH,
        "compile-and-run-vfs",
        "--compiler",
        compiler_wasm,
        "--runtime",
        runtime_wasm,
        "--cc",
        cc_path,
        "--source",
        source_host_path,
        "--guest-source",
        guest_source_path,
        "--guest-out",
        guest_out_path,
        "--json",
    ]
    for so in so_paths:
        cmd.extend(["--so", so])
    for m in vfs_ro:
        cmd.extend(["--vfs-ro", m])
    for m in vfs_rw:
        cmd.extend(["--vfs-rw", m])

    env = os.environ.copy()
    env["ELF2WASM_SHIM_PATH"] = shim_path
    t0 = time.monotonic()
    proc = subprocess.run(cmd, capture_output=True, timeout=timeout, env=env)
    wall = time.monotonic() - t0

    if proc.returncode != 0:
        return RunResult(proc.returncode, proc.stdout, proc.stderr, wall)

    payload = json.loads(proc.stdout.decode("utf-8"))
    return RunResult(
        exit_code=int(payload["exitCode"]),
        stdout=str(payload.get("stdout", "")).encode("utf-8"),
        stderr=str(payload.get("stderr", "")).encode("utf-8"),
        wall_time_s=float(payload.get("wallMs", wall * 1000.0)) / 1000.0,
    )


def translate_native(
    elf_path: str,
    so_paths: Iterable[str] = (),
    out_wasm: str | None = None,
    timeout: int = 120,
) -> tuple[RunResult, str]:
    """Invoke native `elf2wasm translate <elf> [--so <so>...] -o <out.wasm>`."""
    if out_wasm is None:
        fd, out_wasm = tempfile.mkstemp(prefix="v2_native_", suffix=".wasm", dir=get_cache_dir())
        os.close(fd)

    cmd = [get_elf2wasm_bin(), "translate", elf_path]
    for so in so_paths:
        cmd.extend(["--so", so])
    cmd.extend(["-o", out_wasm])

    t0 = time.monotonic()
    proc = subprocess.run(cmd, capture_output=True, timeout=timeout)
    wall = time.monotonic() - t0
    return RunResult(proc.returncode, proc.stdout, proc.stderr, wall), out_wasm


def run_native_cli(
    wasm_path: str,
    args: Iterable[str] = (),
    vfs_ro: Iterable[str] = (),
    timeout: int = 120,
) -> RunResult:
    """Invoke native `elf2wasm run <out.wasm> [--vfs-ro ...] [-- <args>...]`."""
    cmd = [get_elf2wasm_bin(), "run", wasm_path]
    for m in vfs_ro:
        cmd.extend(["--vfs-ro", m])
    arg_list = list(args)
    if arg_list:
        cmd.append("--")
        cmd.extend(arg_list)

    t0 = time.monotonic()
    proc = subprocess.run(cmd, capture_output=True, timeout=timeout)
    wall = time.monotonic() - t0
    return RunResult(proc.returncode, proc.stdout, proc.stderr, wall)


def run_host_native(cmd: list[str], timeout: int = 60) -> RunResult:
    """Run a host-native command directly for fixture prebuild / differential checks."""
    t0 = time.monotonic()
    proc = subprocess.run(cmd, capture_output=True, timeout=timeout)
    wall = time.monotonic() - t0
    return RunResult(proc.returncode, proc.stdout, proc.stderr, wall)
