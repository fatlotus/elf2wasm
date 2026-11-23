#!/usr/bin/env node
/**
 * Stages static frontend assets (`web/`, runtime `js/`, `/wasm/*.wasm`, and `_headers`)
 * into `worker/dist/` for Cloudflare Workers Static Assets.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const CLOUDFLARE_ASSET_MAX_BYTES = 25 * 1024 * 1024; // 25 MiB per-file limit

export const BROWSER_JS_FILES = [
  "container_worker.mjs",
  "docker_sdk.mjs",
  "elf2wasm_shim.mjs",
  "git_client.mjs",
  "oci_client.mjs",
];

export const WASM_FILES = [
  "elf2wasm_compiler_wasm.wasm",
  "elf2wasm_runtime_wasm.wasm",
];

export const STATIC_HEADERS_CONTENT = [
  "/*",
  "  Cross-Origin-Opener-Policy: same-origin",
  "  Cross-Origin-Embedder-Policy: require-corp",
  "  Cross-Origin-Resource-Policy: same-origin",
  "  X-Content-Type-Options: nosniff",
  "",
].join("\n");

function formatMiB(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export async function buildAssets(options = {}) {
  const repoRoot = options.repoRoot ?? path.resolve(__dirname, "..", "..");
  const distDir = options.distDir ?? path.resolve(repoRoot, "worker", "dist");
  const webDir = options.webDir ?? path.resolve(repoRoot, "web");
  const jsDir = options.jsDir ?? path.resolve(repoRoot, "js");
  const wasmDir =
    options.wasmDir ??
    process.env.ELF2WASM_WASM_DIR ??
    path.resolve(repoRoot, "target", "wasm32-unknown-unknown", "release");
  const logger = options.logger ?? console;

  // Clean and recreate dist/
  await fs.rm(distDir, { recursive: true, force: true });
  await fs.mkdir(path.join(distDir, "web"), { recursive: true });
  await fs.mkdir(path.join(distDir, "js"), { recursive: true });
  await fs.mkdir(path.join(distDir, "wasm"), { recursive: true });

  const stagedFiles = [];

  // 1. Copy web/index.html -> dist/index.html (serves /)
  const indexSrc = path.join(webDir, "index.html");
  const indexDst = path.join(distDir, "index.html");
  await fs.copyFile(indexSrc, indexDst);
  stagedFiles.push("index.html");

  // 2. Copy all files in web/ -> dist/web/
  const webEntries = await fs.readdir(webDir, { withFileTypes: true });
  for (const entry of webEntries) {
    if (!entry.isFile()) continue;
    const src = path.join(webDir, entry.name);
    const dst = path.join(distDir, "web", entry.name);
    await fs.copyFile(src, dst);
    stagedFiles.push(`web/${entry.name}`);
  }

  // 3. Copy browser runtime js/*.mjs -> dist/js/ (excluding CLI & test files)
  for (const fileName of BROWSER_JS_FILES) {
    const src = path.join(jsDir, fileName);
    const dst = path.join(distDir, "js", fileName);
    await fs.copyFile(src, dst);
    stagedFiles.push(`js/${fileName}`);
  }

  // 4. Copy & validate WASM artifacts -> dist/wasm/
  const wasmSizes = {};
  for (const fileName of WASM_FILES) {
    const src = path.join(wasmDir, fileName);
    let stat;
    try {
      stat = await fs.stat(src);
    } catch {
      throw new Error(
        `Missing required WASM artifact: ${src}. ` +
          "Build it first with: cargo build --release --target wasm32-unknown-unknown " +
          "-p elf2wasm-compiler-wasm -p elf2wasm-runtime-wasm"
      );
    }
    if (!stat.isFile() || stat.size === 0) {
      throw new Error(`Invalid WASM artifact (empty or not a file): ${src}`);
    }
    if (stat.size >= CLOUDFLARE_ASSET_MAX_BYTES) {
      throw new Error(
        `WASM artifact ${fileName} is ${stat.size} bytes (${formatMiB(stat.size)}), ` +
          `which exceeds Cloudflare Workers Static Assets' 25 MiB per-file limit.`
      );
    }
    const dst = path.join(distDir, "wasm", fileName);
    await fs.copyFile(src, dst);
    wasmSizes[fileName] = stat.size;
    stagedFiles.push(`wasm/${fileName}`);
    logger.log(`[build_assets] staged wasm/${fileName} (${stat.size} bytes / ${formatMiB(stat.size)})`);
  }

  // 5. Write _headers for COOP/COEP/CORP/nosniff on all static assets
  await fs.writeFile(path.join(distDir, "_headers"), STATIC_HEADERS_CONTENT, "utf8");
  stagedFiles.push("_headers");

  logger.log(`[build_assets] staged ${stagedFiles.length} files into ${distDir}`);
  return { distDir, stagedFiles, wasmSizes };
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMain) {
  buildAssets().catch((err) => {
    console.error(`[build_assets] ERROR: ${err.message}`);
    process.exitCode = 1;
  });
}
