#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Elf2WasmSystem } from "./elf2wasm_shim.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

async function main() {
  const compilerWasmPath = path.join(
    REPO_ROOT,
    "target/wasm32-unknown-unknown/release/elf2wasm_compiler_wasm.wasm"
  );
  const runtimeWasmPath = path.join(
    REPO_ROOT,
    "target/wasm32-unknown-unknown/release/elf2wasm_runtime_wasm.wasm"
  );
  assert.ok(fs.existsSync(compilerWasmPath), `Missing ${compilerWasmPath}`);
  assert.ok(fs.existsSync(runtimeWasmPath), `Missing ${runtimeWasmPath}`);

  const compilerWasm = fs.readFileSync(compilerWasmPath);
  const runtimeWasm = fs.readFileSync(runtimeWasmPath);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "elf2wasm_m1_preempt_"));
  try {
    const srcPath = path.join(REPO_ROOT, "e2e_v2/fixtures/preempt_sleep_order.c");
    const binPath = path.join(tmpDir, "preempt_sleep_order");
    execFileSync("gcc", ["-O2", srcPath, "-o", binPath], { stdio: "inherit" });
    const elfBytes = fs.readFileSync(binPath);

    const sys = await Elf2WasmSystem.create({
      compilerWasm,
      runtimeWasm,
      vfsRo: [
        { hostRoot: "/lib/x86_64-linux-gnu", guestPrefix: "/lib/x86_64-linux-gnu" },
        { hostRoot: "/lib64", guestPrefix: "/lib64" },
      ],
    });

    const soEntries = [
      {
        path: "/lib64/ld-linux-x86-64.so.2",
        name: "ld-linux-x86-64.so.2",
        bytes: fs.readFileSync("/lib64/ld-linux-x86-64.so.2"),
      },
      {
        path: "/lib/x86_64-linux-gnu/libc.so.6",
        name: "libc.so.6",
        bytes: fs.readFileSync("/lib/x86_64-linux-gnu/libc.so.6"),
      },
    ];

    const res = await sys.runElf(elfBytes, soEntries, ["/preempt_sleep_order"], {
      elfPath: "/preempt_sleep_order",
    });

    const stdout = new TextDecoder().decode(res.stdout);
    const stderr = new TextDecoder().decode(res.stderr);
    if (res.exitCode !== 0) {
      console.error("stderr:", stderr);
      console.error("stdout:", stdout);
    }

    assert.equal(res.exitCode, 0, `Expected exitCode 0, got ${res.exitCode}`);
    assert.match(stdout, /EXIT1=22/, `Expected EXIT1=22 in stdout:\n${stdout}`);
    assert.match(stdout, /EXIT2=11/, `Expected EXIT2=11 in stdout:\n${stdout}`);
    assert.match(stdout, /ORDER_OK=1/, `Expected ORDER_OK=1 in stdout:\n${stdout}`);

    const pipeIdx = stdout.indexOf("PIPE:\n");
    assert.ok(pipeIdx >= 0, `Missing PIPE: section in stdout:\n${stdout}`);
    const pipeLines = stdout
      .slice(pipeIdx + "PIPE:\n".length)
      .split("\n")
      .filter((l) => l.startsWith("A:") || l.startsWith("B:"));
    assert.equal(pipeLines.length, 2, `Expected 2 pipe lines, got: ${JSON.stringify(pipeLines)}`);
    assert.ok(pipeLines[0].startsWith("B:"), `Expected B first, got ${pipeLines[0]}`);
    assert.ok(pipeLines[1].startsWith("A:"), `Expected A second, got ${pipeLines[1]}`);

    const bMs = Number(pipeLines[0].slice(2));
    const aMs = Number(pipeLines[1].slice(2));
    assert.ok(bMs >= 20 && bMs <= 25, `Expected B wake in [20, 25] ms, got ${bMs}`);
    assert.ok(aMs >= 50 && aMs <= 55, `Expected A wake in [50, 55] ms, got ${aMs}`);

    assert.ok(
      res.virtualTimeNs >= 50_000_000 && res.virtualTimeNs < 60_000_000,
      `Expected virtualTimeNs in [50ms, 60ms), got ${res.virtualTimeNs}`
    );

    console.log("PASS: M1 deterministic two-subprocess preemption verified!");
    console.log(`  B woke at ${bMs}ms, A woke at ${aMs}ms, virtualTimeNs=${res.virtualTimeNs}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
