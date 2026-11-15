#!/usr/bin/env node
/**
 * Opaque-box Node ESM runner for elf2wasm_v2 E2E tests.
 *
 * Bridges Python unittest (`harness_v2.py`) to `js/elf2wasm_shim.mjs`.
 *
 * Subcommands:
 *   compile --compiler <compiler.wasm> --elf <path> [--so <path>...] --out <out.wasm>
 *   run --compiler <compiler.wasm> --runtime <runtime.wasm> --elf <path>
 *       [--so <path>...] [--vfs-ro <host:guest>...] [--vfs-rw <host:guest>...]
 *       [--json] [-- <args>...]
 *   compile-and-run-vfs --compiler <compiler.wasm> --runtime <runtime.wasm>
 *       --cc <host_cc_elf> [--so <path>...] [--vfs-ro <host:guest>...]
 *       [--vfs-rw <host:guest>...] --source <host_c_path>
 *       --guest-source <guest_c_path> --guest-out <guest_elf_path> [--json]
 */

import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveShimPath() {
  const envPath = process.env.ELF2WASM_SHIM_PATH;
  if (envPath && envPath.length > 0) {
    return path.resolve(envPath);
  }
  return path.resolve(__dirname, "../js/elf2wasm_shim.mjs");
}

async function loadShim() {
  const shimPath = resolveShimPath();
  if (!fs.existsSync(shimPath)) {
    throw new Error(
      `Missing elf2wasm JS shim at ${shimPath}. Set ELF2WASM_SHIM_PATH or build M3 js/elf2wasm_shim.mjs.`
    );
  }
  return await import(pathToFileURL(shimPath).href);
}

function parseMount(spec) {
  const idx = spec.indexOf(":");
  if (idx <= 0 || idx === spec.length - 1) {
    throw new Error(`Invalid VFS mount spec '${spec}', expected <host>:<guest>`);
  }
  return {
    hostPath: spec.slice(0, idx),
    guestPath: spec.slice(idx + 1),
  };
}

function parseArgs(argv) {
  if (argv.length === 0) {
    throw new Error("Usage: js_runner.mjs <compile|run|compile-and-run-vfs> [options]");
  }
  const subcmd = argv[0];
  const opts = {
    so: [],
    vfsRo: [],
    vfsRw: [],
    args: [],
    json: false,
  };

  let i = 1;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === "--") {
      opts.args = argv.slice(i + 1);
      break;
    }
    switch (tok) {
      case "--compiler":
        opts.compiler = argv[++i];
        break;
      case "--runtime":
        opts.runtime = argv[++i];
        break;
      case "--elf":
        opts.elf = argv[++i];
        break;
      case "--cc":
        opts.cc = argv[++i];
        break;
      case "--out":
        opts.out = argv[++i];
        break;
      case "--source":
        opts.source = argv[++i];
        break;
      case "--guest-source":
        opts.guestSource = argv[++i];
        break;
      case "--guest-out":
        opts.guestOut = argv[++i];
        break;
      case "--so":
        opts.so.push(argv[++i]);
        break;
      case "--vfs-ro":
        opts.vfsRo.push(parseMount(argv[++i]));
        break;
      case "--vfs-rw":
        opts.vfsRw.push(parseMount(argv[++i]));
        break;
      case "--json":
        opts.json = true;
        break;
      default:
        throw new Error(`Unknown option: ${tok}`);
    }
    i++;
  }
  return { subcmd, opts };
}

function loadSoEntries(soPaths) {
  return soPaths.map((p) => ({
    name: path.basename(p),
    path: p,
    bytes: new Uint8Array(fs.readFileSync(p)),
  }));
}

async function handleCompile(shim, opts) {
  if (!opts.compiler || !opts.elf || !opts.out) {
    throw new Error("compile requires --compiler, --elf, and --out");
  }
  const compilerBytes = new Uint8Array(fs.readFileSync(opts.compiler));
  const elfBytes = new Uint8Array(fs.readFileSync(opts.elf));
  const soEntries = loadSoEntries(opts.so);

  let wasmBytes;
  if (typeof shim.compileElfToWasm === "function") {
    wasmBytes = await shim.compileElfToWasm(compilerBytes, elfBytes, soEntries);
  } else if (typeof shim.compileBundle === "function") {
    wasmBytes = await shim.compileBundle(compilerBytes, elfBytes, soEntries);
  } else if (typeof shim.Elf2WasmSystem === "function") {
    const sys = await shim.Elf2WasmSystem.create({ compilerWasm: compilerBytes });
    wasmBytes = await sys.compile(elfBytes, soEntries);
  } else {
    throw new Error(
      "js/elf2wasm_shim.mjs must export compileElfToWasm, compileBundle, or Elf2WasmSystem"
    );
  }

  fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
  fs.writeFileSync(opts.out, Buffer.from(wasmBytes));
}

function emitRunResult(res, asJson) {
  const exitCode = Number.isInteger(res?.exitCode) ? res.exitCode : 1;
  const stdoutStr =
    typeof res?.stdout === "string"
      ? res.stdout
      : Buffer.from(res?.stdout ?? []).toString("utf8");
  const stderrStr =
    typeof res?.stderr === "string"
      ? res.stderr
      : Buffer.from(res?.stderr ?? []).toString("utf8");
  const wallMs = typeof res?.wallMs === "number" ? res.wallMs : 0;

  if (asJson) {
    process.stdout.write(
      JSON.stringify({
        exitCode,
        stdout: stdoutStr,
        stderr: stderrStr,
        wallMs,
      }) + "\n"
    );
    process.exit(0);
  } else {
    if (stdoutStr.length > 0) process.stdout.write(stdoutStr);
    if (stderrStr.length > 0) process.stderr.write(stderrStr);
    process.exit(exitCode);
  }
}

async function handleRun(shim, opts) {
  if (!opts.compiler || !opts.runtime || !opts.elf) {
    throw new Error("run requires --compiler, --runtime, and --elf");
  }
  const compilerBytes = new Uint8Array(fs.readFileSync(opts.compiler));
  const runtimeBytes = new Uint8Array(fs.readFileSync(opts.runtime));
  const elfBytes = new Uint8Array(fs.readFileSync(opts.elf));
  const soEntries = loadSoEntries(opts.so);

  const t0 = performance.now();
  let res;
  if (typeof shim.runElf === "function") {
    res = await shim.runElf({
      compilerWasm: compilerBytes,
      runtimeWasm: runtimeBytes,
      elfBytes,
      elfPath: opts.elf,
      soEntries,
      args: opts.args,
      vfsRo: opts.vfsRo,
      vfsRw: opts.vfsRw,
    });
  } else if (typeof shim.Elf2WasmSystem === "function") {
    const sys = await shim.Elf2WasmSystem.create({
      compilerWasm: compilerBytes,
      runtimeWasm: runtimeBytes,
      vfsRo: opts.vfsRo,
      vfsRw: opts.vfsRw,
    });
    res = await sys.runElf(elfBytes, soEntries, opts.args, { elfPath: opts.elf });
  } else {
    throw new Error("js/elf2wasm_shim.mjs must export runElf or Elf2WasmSystem");
  }
  const wallMs = performance.now() - t0;
  emitRunResult({ ...res, wallMs: res?.wallMs ?? wallMs }, opts.json);
}

async function handleCompileAndRunVfs(shim, opts) {
  if (
    !opts.compiler ||
    !opts.runtime ||
    !opts.cc ||
    !opts.source ||
    !opts.guestSource ||
    !opts.guestOut
  ) {
    throw new Error(
      "compile-and-run-vfs requires --compiler, --runtime, --cc, --source, --guest-source, --guest-out"
    );
  }
  const compilerBytes = new Uint8Array(fs.readFileSync(opts.compiler));
  const runtimeBytes = new Uint8Array(fs.readFileSync(opts.runtime));
  const ccBytes = new Uint8Array(fs.readFileSync(opts.cc));
  const sourceBytes = new Uint8Array(fs.readFileSync(opts.source));
  const soEntries = loadSoEntries(opts.so);

  const t0 = performance.now();
  let res;
  if (typeof shim.compileAndRunInVfs === "function") {
    res = await shim.compileAndRunInVfs({
      compilerWasm: compilerBytes,
      runtimeWasm: runtimeBytes,
      ccBytes,
      ccPath: opts.cc,
      soEntries,
      vfsRo: opts.vfsRo,
      vfsRw: opts.vfsRw,
      sourceBytes,
      guestSourcePath: opts.guestSource,
      guestOutPath: opts.guestOut,
    });
  } else if (typeof shim.Elf2WasmSystem === "function") {
    const sys = await shim.Elf2WasmSystem.create({
      compilerWasm: compilerBytes,
      runtimeWasm: runtimeBytes,
      vfsRo: opts.vfsRo,
      vfsRw: opts.vfsRw,
    });
    await sys.writeVfsFile(opts.guestSource, sourceBytes);
    const ccRes = await sys.runElf(
      ccBytes,
      soEntries,
      [opts.cc, opts.guestSource, "-o", opts.guestOut],
      { elfPath: opts.cc }
    );
    if (ccRes.exitCode !== 0) {
      const wallMs = performance.now() - t0;
      emitRunResult(
        {
          exitCode: ccRes.exitCode,
          stdout: ccRes.stdout,
          stderr: `Hosted CC failed (exit ${ccRes.exitCode}): ${ccRes.stderr ?? ""}`,
          wallMs,
        },
        opts.json
      );
      return;
    }
    const compiledElfBytes = await sys.readVfsFile(opts.guestOut);
    res = await sys.runElf(compiledElfBytes, soEntries, [opts.guestOut], {
      elfPath: opts.guestOut,
    });
  } else {
    throw new Error(
      "js/elf2wasm_shim.mjs must export compileAndRunInVfs or Elf2WasmSystem"
    );
  }
  const wallMs = performance.now() - t0;
  emitRunResult({ ...res, wallMs: res?.wallMs ?? wallMs }, opts.json);
}

async function main() {
  const { subcmd, opts } = parseArgs(process.argv.slice(2));
  const shim = await loadShim();

  if (subcmd === "compile") {
    await handleCompile(shim, opts);
  } else if (subcmd === "run") {
    await handleRun(shim, opts);
  } else if (subcmd === "compile-and-run-vfs") {
    await handleCompileAndRunVfs(shim, opts);
  } else {
    throw new Error(`Unknown subcommand: ${subcmd}`);
  }
}

main().catch((err) => {
  process.stderr.write(`js_runner error: ${err?.stack || err}\n`);
  process.exit(1);
});
