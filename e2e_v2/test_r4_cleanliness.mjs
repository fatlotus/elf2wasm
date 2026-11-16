#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const FORBIDDEN_FILES = [
  "src/syscalls.rs",
  "src/vfs.rs",
  "tests/m2_runtime.rs",
  "tests/m3_true_echo.rs",
  "tests/m4_python3.rs",
  "TEST_READY_V2.md",
];

const FORBIDDEN_ROOT_DEPS = ["goblin", "iced-x86", "wasm-encoder"];

async function main() {
  // 1. Verify unnecessary/redundant files are deleted
  const stillPresent = FORBIDDEN_FILES.filter((rel) =>
    fs.existsSync(path.join(REPO_ROOT, rel))
  );
  assert.equal(
    stillPresent.length,
    0,
    `Expected these unnecessary files to be deleted, but they still exist: ${stillPresent.join(", ")}`
  );
  console.log("[R4] All 6 forbidden/redundant files are absent.");

  // 2. Verify root Cargo.toml [dependencies] does not contain unused deps
  const cargoTomlPath = path.join(REPO_ROOT, "Cargo.toml");
  const cargoToml = fs.readFileSync(cargoTomlPath, "utf8");
  const depsMatch = cargoToml.match(/\[dependencies\]([\s\S]*?)(\n\[|$)/);
  assert.ok(depsMatch, "Could not locate [dependencies] section in root Cargo.toml");
  const depsSection = depsMatch[1];
  for (const dep of FORBIDDEN_ROOT_DEPS) {
    const re = new RegExp(`^\\s*${dep.replace("-", "\\-")}\\s*=`, "m");
    assert.ok(
      !re.test(depsSection),
      `Root Cargo.toml [dependencies] still contains unused dependency "${dep}"`
    );
  }
  console.log("[R4] Root Cargo.toml [dependencies] is clean.");

  // 3. Run cargo test --workspace and assert exit code 0
  execFileSync("cargo", ["test", "--workspace"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    timeout: 900_000,
  });
  console.log("[R4] cargo test --workspace passed.");
  console.log("PASS: R4 Codebase Simplification & Cleanup");
}

main().catch((err) => {
  console.error("FAIL: R4 Codebase Simplification & Cleanup");
  console.error(err?.stack || err);
  process.exit(1);
});
