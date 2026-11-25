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

function parseDelayStddevMs(raw) {
  if (raw === undefined || typeof raw !== "string" || raw.trim() === "") {
    throw new Error(`Invalid --delay-stddev-ms '${raw ?? ""}': must be a finite non-negative number`);
  }
  const val = Number(raw);
  if (!Number.isFinite(val) || val < 0) {
    throw new Error(`Invalid --delay-stddev-ms '${raw}': must be a finite non-negative number`);
  }
  const MAX_STDDEV_NS = 1844674407370955161n; // u64::MAX / 10
  if (val > 1_844_674_407_370 || BigInt(Math.round(val * 1e6)) > MAX_STDDEV_NS) {
    throw new Error(
      `Invalid --delay-stddev-ms '${raw}': exceeds maximum supported delay`
    );
  }
  return val;
}

function parseDelaySeed(raw) {
  if (raw === undefined || typeof raw !== "string" || raw.trim() === "") {
    throw new Error(`Invalid --delay-seed '${raw ?? ""}': must be a non-negative integer`);
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid --delay-seed '${raw}': must be a non-negative integer`);
  }
  const seedBig = BigInt(trimmed);
  if (seedBig > 0xffff_ffff_ffff_ffffn) {
    throw new Error(
      `Invalid --delay-seed '${raw}': exceeds 64-bit unsigned integer range`
    );
  }
  return seedBig;
}

function parseArgs(argv) {
  if (argv.length === 0) {
    throw new Error(
      "Usage: cli.mjs <compile|run> --elf <path> [--so <path>...] [--vfs-ro <host:guest>...] [--out <out.wasm>] [--delay-stddev-ms <ms>] [--delay-seed <int>] [-- <args...>]"
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
    delayStddevMs: undefined,
    delaySeed: undefined,
  };
  let i = 1;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === "--") {
      opts.args = argv.slice(i + 1);
      break;
    }
    let flag = tok;
    let inlineVal;
    const eqIdx = tok.indexOf("=");
    if (tok.startsWith("--") && eqIdx > 2) {
      flag = tok.slice(0, eqIdx);
      inlineVal = tok.slice(eqIdx + 1);
    }
    const nextVal = () => {
      if (inlineVal !== undefined) return inlineVal;
      if (i + 1 >= argv.length) {
        throw new Error(`Missing value for option: ${flag}`);
      }
      return argv[++i];
    };
    switch (flag) {
      case "--compiler":
        opts.compiler = nextVal();
        break;
      case "--runtime":
        opts.runtime = nextVal();
        break;
      case "--elf":
        opts.elf = nextVal();
        break;
      case "--out":
        opts.out = nextVal();
        break;
      case "--so":
        opts.so.push(nextVal());
        break;
      case "--vfs-ro": {
        const spec = nextVal();
        const idx = spec.indexOf(":");
        opts.vfsRo.push({ hostPath: spec.slice(0, idx), guestPath: spec.slice(idx + 1) });
        break;
      }
      case "--vfs-rw": {
        const spec = nextVal();
        const idx = spec.indexOf(":");
        opts.vfsRw.push({ hostPath: spec.slice(0, idx), guestPath: spec.slice(idx + 1) });
        break;
      }
      case "--delay-stddev-ms":
        opts.delayStddevMs = parseDelayStddevMs(nextVal());
        break;
      case "--delay-seed":
        opts.delaySeed = parseDelaySeed(nextVal());
        break;
      default:
        throw new Error(`Unknown option: ${tok}`);
    }
    i++;
  }
  if (
    subcmd === "compile" &&
    (opts.delayStddevMs !== undefined || opts.delaySeed !== undefined)
  ) {
    throw new Error("--delay-stddev-ms and --delay-seed are only supported for 'run'");
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
      delayStddevMs: opts.delayStddevMs,
      delaySeed: opts.delaySeed,
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
