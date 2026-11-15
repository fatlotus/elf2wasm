#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileElfToWasm, runElf } from "./elf2wasm_shim.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_COMPILER = path.resolve(
  __dirname,
  "../target/wasm32-unknown-unknown/release/elf2wasm_compiler_wasm.wasm"
);
const DEFAULT_RUNTIME = path.resolve(
  __dirname,
  "../target/wasm32-unknown-unknown/release/elf2wasm_runtime_wasm.wasm"
);

function parseArgs(argv) {
  if (argv.length === 0) {
    throw new Error(
      "Usage: cli.mjs <compile|run> --elf <path> [--so <path>...] [--vfs-ro <host:guest>...] [--out <out.wasm>] [-- <args...>]"
    );
  }
  const subcmd = argv[0];
  const opts = {
    compiler: DEFAULT_COMPILER,
    runtime: DEFAULT_RUNTIME,
    so: [],
    vfsRo: [],
    vfsRw: [],
    args: [],
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
      case "--out":
        opts.out = argv[++i];
        break;
      case "--so":
        opts.so.push(argv[++i]);
        break;
      case "--vfs-ro": {
        const spec = argv[++i];
        const idx = spec.indexOf(":");
        opts.vfsRo.push({ hostPath: spec.slice(0, idx), guestPath: spec.slice(idx + 1) });
        break;
      }
      case "--vfs-rw": {
        const spec = argv[++i];
        const idx = spec.indexOf(":");
        opts.vfsRw.push({ hostPath: spec.slice(0, idx), guestPath: spec.slice(idx + 1) });
        break;
      }
      default:
        throw new Error(`Unknown option: ${tok}`);
    }
    i++;
  }
  return { subcmd, opts };
}

async function main() {
  const { subcmd, opts } = parseArgs(process.argv.slice(2));
  if (!opts.elf) throw new Error("--elf is required");
  const compilerWasm = new Uint8Array(fs.readFileSync(opts.compiler));
  const elfBytes = new Uint8Array(fs.readFileSync(opts.elf));
  const soEntries = opts.so.map((p) => ({
    name: path.basename(p),
    path: p,
    bytes: new Uint8Array(fs.readFileSync(p)),
  }));

  if (subcmd === "compile") {
    if (!opts.out) throw new Error("--out is required for compile");
    const wasmBytes = await compileElfToWasm(compilerWasm, elfBytes, soEntries, {
      elfPath: opts.elf,
    });
    fs.writeFileSync(opts.out, wasmBytes);
  } else if (subcmd === "run") {
    const runtimeWasm = new Uint8Array(fs.readFileSync(opts.runtime));
    const res = await runElf({
      compilerWasm,
      runtimeWasm,
      elfBytes,
      elfPath: opts.elf,
      soEntries,
      args: [opts.elf, ...opts.args],
      vfsRo: opts.vfsRo,
      vfsRw: opts.vfsRw,
    });
    if (res.stdout.length > 0) process.stdout.write(Buffer.from(res.stdout));
    if (res.stderr.length > 0) process.stderr.write(Buffer.from(res.stderr));
    process.exit(res.exitCode);
  } else {
    throw new Error(`Unknown subcommand: ${subcmd}`);
  }
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || err}\n`);
  process.exit(1);
});
