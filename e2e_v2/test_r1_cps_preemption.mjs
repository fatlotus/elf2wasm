#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const REQUIRED_EXPORTS = [
  "memory",
  "_start",
  "save_ctx",
  "load_ctx",
  "yield_flag",
  "quantum",
  "rip",
  "exit_flag",
  "exit_code",
  "fsbase",
  "gsbase",
  "rax",
  "rcx",
  "rdx",
  "rbx",
  "rsp",
  "rbp",
  "rsi",
  "rdi",
  "r8",
  "r9",
  "r10",
  "r11",
  "r12",
  "r13",
  "r14",
  "r15",
];

function findOrBuildElf2Wasm() {
  const releaseBin = path.join(REPO_ROOT, "target/release/elf2wasm");
  if (fs.existsSync(releaseBin)) return releaseBin;
  console.log("[R1] Building release elf2wasm binary with cargo build --release --bin elf2wasm...");
  execFileSync("cargo", ["build", "--release", "--bin", "elf2wasm"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    timeout: 600_000,
  });
  assert.ok(fs.existsSync(releaseBin), "Expected target/release/elf2wasm after cargo build --release");
  return releaseBin;
}

function runCmd(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    timeout: 60_000,
    ...opts,
  });
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "elf2wasm_r1_"));
  try {
    const elf2wasm = findOrBuildElf2Wasm();
    const ldPath = "/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2";
    const libcPath = "/lib/x86_64-linux-gnu/libc.so.6";

    // 1. Small C test program for WASM ABI & direct CPS instantiation check
    const helloC = path.join(tmpDir, "hello.c");
    const helloElf = path.join(tmpDir, "hello");
    const helloWasm = path.join(tmpDir, "hello.wasm");
    fs.writeFileSync(
      helloC,
      `#include <stdio.h>
int main(void) {
  puts("HELLO_CPS");
  return 0;
}
`
    );
    runCmd("gcc", ["-O2", helloC, "-o", helloElf]);
    runCmd(
      elf2wasm,
      [
        "translate",
        helloElf,
        "--so",
        ldPath,
        "--so",
        libcPath,
        "-o",
        helloWasm,
      ],
      { timeout: 180_000 }
    );

    const wasmBytes = fs.readFileSync(helloWasm);
    const mod = new WebAssembly.Module(wasmBytes);

    // Inspect imports: must have zero imports (env.syscall removed)
    const imports = WebAssembly.Module.imports(mod);
    assert.equal(
      imports.length,
      0,
      `Expected zero imports in CPS guest module, got: ${JSON.stringify(imports)}`
    );

    // Inspect exports
    const exports = WebAssembly.Module.exports(mod);
    const exportNames = new Set(exports.map((e) => e.name));
    for (const name of REQUIRED_EXPORTS) {
      assert.ok(
        exportNames.has(name),
        `Missing required guest WASM export: "${name}" (present: ${[...exportNames].join(", ")})`
      );
    }

    // Inspect custom section elf2wasm_meta
    const metaSections = WebAssembly.Module.customSections(mod, "elf2wasm_meta");
    assert.equal(
      metaSections.length,
      1,
      `Expected 1 elf2wasm_meta custom section, got ${metaSections.length}`
    );

    // Direct Node WebAssembly.Instance CPS check
    const inst = new WebAssembly.Instance(mod, {});
    const rspGlobal = inst.exports.rsp;
    rspGlobal.value = typeof rspGlobal.value === "bigint" ? 0x0bff0000n : 0x0bff0000;
    inst.exports._start();

    const yieldVal = Number(inst.exports.yield_flag.value);
    const ripVal = inst.exports.rip.value;
    assert.ok(
      yieldVal === 2 || yieldVal === 3,
      `Expected yield_flag to be 2 (YIELD_QUANTUM) or 3 (YIELD_SYSCALL_PENDING) after _start() return, got ${yieldVal}`
    );
    assert.ok(
      ripVal !== 0n && ripVal !== 0,
      `Expected non-zero rip after CPS return, got ${ripVal}`
    );
    console.log(`[R1] Direct CPS instantiation check passed (0 imports, yield_flag=${yieldVal}, rip!=0).`);

    // 2. Two-subprocess deterministic wait C program
    const forkWaitC = path.join(tmpDir, "fork_wait.c");
    const forkWaitElf = path.join(tmpDir, "fork_wait");
    const forkWaitWasm = path.join(tmpDir, "fork_wait.wasm");
    fs.writeFileSync(
      forkWaitC,
      `#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static void sleep_ms(long ms) {
  struct timespec req;
  req.tv_sec = ms / 1000;
  req.tv_nsec = (ms % 1000) * 1000000L;
  nanosleep(&req, NULL);
}

int main(void) {
  pid_t pid_a = fork();
  if (pid_a < 0) { perror("fork A"); return 1; }
  if (pid_a == 0) {
    sleep_ms(50);
    printf("CHILD_A_DONE\\n");
    fflush(stdout);
    _exit(0);
  }

  pid_t pid_b = fork();
  if (pid_b < 0) { perror("fork B"); return 1; }
  if (pid_b == 0) {
    sleep_ms(10);
    printf("CHILD_B_DONE\\n");
    fflush(stdout);
    _exit(0);
  }

  int st_a = 0, st_b = 0;
  if (waitpid(pid_a, &st_a, 0) < 0) { perror("waitpid A"); return 2; }
  if (waitpid(pid_b, &st_b, 0) < 0) { perror("waitpid B"); return 3; }
  printf("PARENT_DONE\\n");
  fflush(stdout);
  return 0;
}
`
    );

    runCmd("gcc", ["-O2", forkWaitC, "-o", forkWaitElf]);
    runCmd(
      elf2wasm,
      [
        "translate",
        forkWaitElf,
        "--so",
        ldPath,
        "--so",
        libcPath,
        "-o",
        forkWaitWasm,
      ],
      { timeout: 180_000 }
    );

    function verifyForkWaitOutput(stdout, label) {
      const idxB = stdout.indexOf("CHILD_B_DONE");
      const idxA = stdout.indexOf("CHILD_A_DONE");
      const idxP = stdout.indexOf("PARENT_DONE");
      assert.ok(idxB !== -1, `${label}: missing CHILD_B_DONE in stdout:\n${stdout}`);
      assert.ok(idxA !== -1, `${label}: missing CHILD_A_DONE in stdout:\n${stdout}`);
      assert.ok(idxP !== -1, `${label}: missing PARENT_DONE in stdout:\n${stdout}`);
      assert.ok(
        idxB < idxA,
        `${label}: expected CHILD_B_DONE strictly before CHILD_A_DONE, got:\n${stdout}`
      );
      assert.ok(
        idxA < idxP,
        `${label}: expected CHILD_A_DONE before PARENT_DONE, got:\n${stdout}`
      );
    }

    // Run twice via `elf2wasm run` and verify determinism
    const run1 = runCmd(elf2wasm, ["run", forkWaitWasm], { cwd: REPO_ROOT });
    verifyForkWaitOutput(run1, "elf2wasm run #1");
    const run2 = runCmd(elf2wasm, ["run", forkWaitWasm], { cwd: REPO_ROOT });
    assert.equal(run2, run1, "Repeated elf2wasm run produced non-deterministic stdout");
    console.log("[R1] elf2wasm run deterministic two-subprocess wait passed.");

    // Also run via `node js/cli.mjs run` and assert compiler.wasm and runtime.wasm exist
    const compilerWasmPath = path.join(
      REPO_ROOT,
      "target/wasm32-unknown-unknown/release/elf2wasm_compiler_wasm.wasm"
    );
    const runtimeWasmPath = path.join(
      REPO_ROOT,
      "target/wasm32-unknown-unknown/release/elf2wasm_runtime_wasm.wasm"
    );
    assert.ok(
      fs.existsSync(compilerWasmPath),
      `Missing compiler WASM module: ${compilerWasmPath}`
    );
    assert.ok(
      fs.existsSync(runtimeWasmPath),
      `Missing runtime WASM module: ${runtimeWasmPath}`
    );
    const jsRun1 = runCmd(
      "node",
      [
        path.join(REPO_ROOT, "js/cli.mjs"),
        "run",
        "--elf",
        forkWaitElf,
        "--so",
        ldPath,
        "--so",
        libcPath,
      ],
      { cwd: REPO_ROOT, timeout: 180_000 }
    );
    verifyForkWaitOutput(jsRun1, "js/cli.mjs run #1");
    const jsRun2 = runCmd(
      "node",
      [
        path.join(REPO_ROOT, "js/cli.mjs"),
        "run",
        "--elf",
        forkWaitElf,
        "--so",
        ldPath,
        "--so",
        libcPath,
      ],
      { cwd: REPO_ROOT, timeout: 180_000 }
    );
    assert.equal(jsRun2, jsRun1, "Repeated js/cli.mjs run produced non-deterministic stdout");
    console.log("[R1] node js/cli.mjs run deterministic two-subprocess wait passed.");

    console.log("PASS: R1 CPS Syscall ABI & Kernel Preemption");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("FAIL: R1 CPS Syscall ABI & Kernel Preemption");
  console.error(err?.stack || err);
  process.exit(1);
});
