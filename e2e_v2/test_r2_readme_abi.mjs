#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function findOrBuildElf2Wasm() {
  const releaseBin = path.join(REPO_ROOT, "target/release/elf2wasm");
  if (fs.existsSync(releaseBin)) return releaseBin;
  console.log("[R2] Building release elf2wasm binary with cargo build --release --bin elf2wasm...");
  execFileSync("cargo", ["build", "--release", "--bin", "elf2wasm"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    timeout: 600_000,
  });
  assert.ok(fs.existsSync(releaseBin), "Expected target/release/elf2wasm after cargo build --release");
  return releaseBin;
}

function checkModuleDocumented(label, wasmPath, readmeText) {
  assert.ok(fs.existsSync(wasmPath), `Missing WASM module for ${label}: ${wasmPath}`);
  const bytes = fs.readFileSync(wasmPath);
  const mod = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(mod);
  const exports = WebAssembly.Module.exports(mod);

  const missing = [];
  for (const imp of imports) {
    if (!readmeText.includes(imp.name)) {
      missing.push(`import ${imp.module}.${imp.name}`);
    }
  }
  for (const exp of exports) {
    if (!readmeText.includes(exp.name)) {
      missing.push(`export ${exp.name}`);
    }
  }
  assert.equal(
    missing.length,
    0,
    `${label} has undocumented WASM ABI symbols in README.md:\n  - ${missing.join("\n  - ")}`
  );
  console.log(
    `[R2] ${label}: all ${imports.length} imports and ${exports.length} exports documented in README.md.`
  );
}

async function main() {
  const readmePath = path.join(REPO_ROOT, "README.md");
  assert.ok(fs.existsSync(readmePath), `README.md does not exist at ${readmePath}`);
  const readme = fs.readFileSync(readmePath, "utf8");
  const lower = readme.toLowerCase();

  // Check core goal documentation
  assert.ok(
    lower.includes("deterministic"),
    "README.md must document the core goal: 'deterministic'"
  );
  assert.ok(
    lower.includes("linux"),
    "README.md must document the core goal: 'Linux-compatible'"
  );
  assert.ok(
    lower.includes("unmodified") && (lower.includes("x86") || lower.includes("x86-64")),
    "README.md must document running unmodified x86/x86-64 programs"
  );

  // Check build/install instructions
  assert.ok(
    readme.includes("wasm32-unknown-unknown"),
    "README.md must document building for wasm32-unknown-unknown"
  );
  assert.ok(
    readme.includes("cargo build"),
    "README.md must document cargo build instructions"
  );
  assert.ok(
    readme.includes(".wasm"),
    "README.md must document the .wasm modules"
  );

  // Check run instructions
  assert.ok(
    lower.includes("run") && (readme.includes("elf2wasm run") || readme.includes("cli.mjs")),
    "README.md must document how to run translated modules"
  );

  const compilerWasm = path.join(
    REPO_ROOT,
    "target/wasm32-unknown-unknown/release/elf2wasm_compiler_wasm.wasm"
  );
  const runtimeWasm = path.join(
    REPO_ROOT,
    "target/wasm32-unknown-unknown/release/elf2wasm_runtime_wasm.wasm"
  );

  checkModuleDocumented("elf2wasm_compiler_wasm.wasm", compilerWasm, readme);
  checkModuleDocumented("elf2wasm_runtime_wasm.wasm", runtimeWasm, readme);

  // Build a translated guest .wasm and check all its imports/exports against README.md
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "elf2wasm_r2_"));
  try {
    const elf2wasm = findOrBuildElf2Wasm();
    const guestC = path.join(tmpDir, "guest.c");
    const guestElf = path.join(tmpDir, "guest");
    const guestWasm = path.join(tmpDir, "guest.wasm");
    fs.writeFileSync(guestC, "int main(void) { return 0; }\n");
    execFileSync("gcc", ["-O2", guestC, "-o", guestElf], { timeout: 30_000 });
    execFileSync(
      elf2wasm,
      [
        "translate",
        guestElf,
        "--so",
        "/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2",
        "--so",
        "/lib/x86_64-linux-gnu/libc.so.6",
        "-o",
        guestWasm,
      ],
      { timeout: 180_000 }
    );
    checkModuleDocumented("translated guest .wasm", guestWasm, readme);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log("PASS: R2 README.md & Exhaustive WASM ABI Docs");
}

main().catch((err) => {
  console.error("FAIL: R2 README.md & Exhaustive WASM ABI Docs");
  console.error(err?.stack || err);
  process.exit(1);
});
