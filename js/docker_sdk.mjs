/**
 * Public JavaScript Docker-on-WASM SDK (Browser & Node.js compatible).
 *
 * Runs unmodified Linux x86-64 Docker/OCI images completely on the client side
 * using elf2wasm_compiler_wasm.wasm and elf2wasm_runtime_wasm.wasm.
 * Uses a dedicated Web Worker in browsers by default, with direct in-process
 * execution in Node.js (or when `useWorker: false`).
 */

import { Elf2WasmSystem, extractTarToVfs, validateDelayConfig } from "./elf2wasm_shim.mjs";
import {
  parseImageRef,
  pullImage as ociPullImage,
  loadOciTarball as ociLoadOciTarball,
  decompressLayer,
} from "./oci_client.mjs";
import { fetchGitArchive } from "./git_client.mjs";
import { expandSweepValues } from "../web/dockerfile.mjs";

export { parseImageRef, fetchGitArchive, getGoDefaultEnv, isGoImageRef, isGoContainer, mergeEnv };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: false });

/**
 * Gzip-compress bytes using Web CompressionStream with Node `node:zlib` fallback.
 *
 * @param {string|Uint8Array|ArrayBuffer|ArrayBufferView} input
 * @returns {Promise<Uint8Array>}
 */
export async function gzipBytes(input) {
  const bytes = toUint8Array(input);
  if (typeof CompressionStream === "function") {
    const cs = new CompressionStream("gzip");
    const writer = cs.writable.getWriter();
    const writePromise = writer.write(bytes).then(() => writer.close());
    const reader = cs.readable.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    await writePromise;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    return out;
  }
  const { gzipSync } = await import("node:zlib");
  return new Uint8Array(gzipSync(bytes));
}

/**
 * Gunzip bytes using Web DecompressionStream with Node `node:zlib` fallback.
 * Passes through uncompressed inputs unchanged when gzip magic (`0x1f 0x8b`) is absent.
 *
 * @param {string|Uint8Array|ArrayBuffer|ArrayBufferView} input
 * @returns {Promise<Uint8Array>}
 */
export async function gunzipBytes(input) {
  const bytes = toUint8Array(input);
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    return bytes;
  }
  if (typeof DecompressionStream === "function") {
    const ds = new DecompressionStream("gzip");
    const writer = ds.writable.getWriter();
    const writePromise = writer.write(bytes).then(() => writer.close());
    const reader = ds.readable.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    await writePromise;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    return out;
  }
  const { gunzipSync } = await import("node:zlib");
  return new Uint8Array(gunzipSync(bytes));
}

/**
 * Encode a Uint8Array to base64 (Node Buffer fast path; browser chunked loop).
 *
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView} bytes
 * @returns {string}
 */
export function uint8ArrayToBase64(bytes) {
  const u8 = toUint8Array(bytes);
  if (u8.byteLength === 0) return "";
  if (typeof Buffer !== "undefined" && typeof Buffer.from === "function") {
    return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString("base64");
  }
  const CHUNK_SIZE = 0x8000;
  let binary = "";
  for (let i = 0; i < u8.length; i += CHUNK_SIZE) {
    const slice = u8.subarray(i, Math.min(i + CHUNK_SIZE, u8.length));
    binary += String.fromCharCode.apply(null, slice);
  }
  return btoa(binary);
}

/**
 * Decode a base64 string to a Uint8Array (Node Buffer fast path; browser atob fallback).
 *
 * @param {string} b64
 * @returns {Uint8Array}
 */
export function base64ToUint8Array(b64) {
  if (typeof b64 !== "string" || !b64.trim()) return new Uint8Array(0);
  if (typeof Buffer !== "undefined" && typeof Buffer.from === "function") {
    const buf = Buffer.from(b64, "base64");
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function toUint8Array(input) {
  if (typeof input === "string") return textEncoder.encode(input);
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new TypeError("Expected string, Uint8Array, ArrayBuffer, or ArrayBufferView");
}

function normalizeCmdArray(val) {
  if (val === null || val === undefined) return [];
  if (typeof val === "string") return val.trim() === "" ? [] : [val];
  if (Array.isArray(val)) return val.map((x) => String(x));
  return [];
}

function decodeChunks(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.length;
  }
  return textDecoder.decode(merged);
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

function makeAbortError() {
  const err = new Error("Operation aborted");
  err.name = "AbortError";
  return err;
}

function normalizeMountPath(rawPath, fallback = "/workspace") {
  if (typeof rawPath !== "string" || !rawPath.trim()) return fallback;
  const parts = [];
  for (const seg of rawPath.trim().split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (parts.length > 0) parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.length === 0 ? "/" : "/" + parts.join("/");
}

function mergeEnv(baseEnv, imageEnv, overrideEnv) {
  const map = new Map();
  const order = [];
  const applyList = (list) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (typeof item !== "string" || !item) continue;
      const eq = item.indexOf("=");
      if (eq <= 0) continue;
      const key = item.slice(0, eq);
      if (!map.has(key)) order.push(key);
      map.set(key, item);
    }
  };
  applyList(baseEnv);
  applyList(imageEnv);
  applyList(overrideEnv);
  return order.map((k) => map.get(k));
}

const NODE_DEFAULT_OPTIONS = "--jitless --v8-pool-size=1 --no-experimental-strip-types";
const NODE_LEGACY_DEFAULT_OPTIONS = "--jitless --v8-pool-size=1";

const NODE_DEFAULT_ENV_TAIL = Object.freeze([
  "MALLOC_ARENA_MAX=1",
  "UV_USE_IO_URING=0",
  "UV_THREADPOOL_SIZE=1",
]);

function parseNodeMajorVersion(imageEnv) {
  if (!Array.isArray(imageEnv)) return null;
  let versionStr = null;
  for (const entry of imageEnv) {
    if (typeof entry === "string" && entry.startsWith("NODE_VERSION=")) {
      versionStr = entry.slice("NODE_VERSION=".length).trim();
    }
  }
  if (!versionStr) return null;
  const normalized = versionStr.replace(/^v/i, "");
  const m = /^(\d+)(?:\.|$)/.exec(normalized);
  return m ? Number(m[1]) : null;
}

function getNodeDefaultEnv(imageEnv) {
  const major = parseNodeMajorVersion(imageEnv);
  const nodeOptions =
    major !== null && major < 22 ? NODE_LEGACY_DEFAULT_OPTIONS : NODE_DEFAULT_OPTIONS;
  return [`NODE_OPTIONS=${nodeOptions}`, ...NODE_DEFAULT_ENV_TAIL];
}

function execBasename(p) {
  const s = String(p || "");
  const idx = s.lastIndexOf("/");
  return idx >= 0 ? s.slice(idx + 1) : s;
}

function isNodeExecutable(arg) {
  const base = execBasename(arg);
  return base === "node" || base === "nodejs";
}

function isNodeContainer(imageEnv, entrypoint, cmd, fullArgv) {
  if (Array.isArray(imageEnv)) {
    for (const entry of imageEnv) {
      if (typeof entry === "string" && entry.startsWith("NODE_VERSION=")) {
        return true;
      }
    }
  }
  if (fullArgv.length > 0 && isNodeExecutable(fullArgv[0])) {
    return true;
  }
  if (entrypoint.length > 0 && cmd.length > 0 && isNodeExecutable(cmd[0])) {
    return true;
  }
  if (
    fullArgv.length > 1 &&
    execBasename(fullArgv[0]) === "env" &&
    isNodeExecutable(fullArgv[1])
  ) {
    return true;
  }
  return false;
}

const GO_DEFAULT_ENV = Object.freeze([
  "GODEBUG=asyncpreemptoff=1",
  "GOMEMLIMIT=256MiB",
  "GOMAXPROCS=1",
  "CGO_ENABLED=0",
]);

function getGoDefaultEnv() {
  return [...GO_DEFAULT_ENV];
}

function isGoExecutable(arg) {
  return execBasename(arg) === "go";
}

function isGoImageRef(imageRef) {
  if (!imageRef) return false;
  let repo = "";
  if (typeof imageRef === "string") {
    const withoutDigest = imageRef.split("@")[0];
    const lastSlash = withoutDigest.lastIndexOf("/");
    const lastColon = withoutDigest.lastIndexOf(":");
    repo = lastColon > lastSlash ? withoutDigest.slice(0, lastColon) : withoutDigest;
  } else if (typeof imageRef === "object") {
    repo = String(imageRef.repository || imageRef.name || "");
  }
  const lastSegment = (repo.split("/").pop() || "").toLowerCase();
  return lastSegment === "golang" || lastSegment === "golang-with-cache";
}

function isGoContainer(imageEnv, entrypoint = [], cmd = [], fullArgv = [], imageRef = null) {
  if (isGoImageRef(imageRef)) {
    return true;
  }
  if (Array.isArray(imageEnv)) {
    for (const entry of imageEnv) {
      if (
        typeof entry === "string" &&
        (entry.startsWith("GOLANG_VERSION=") || entry.startsWith("GOPATH="))
      ) {
        return true;
      }
    }
  }
  if (fullArgv.length > 0 && isGoExecutable(fullArgv[0])) {
    return true;
  }
  if (entrypoint.length > 0 && cmd.length > 0 && isGoExecutable(cmd[0])) {
    return true;
  }
  if (
    fullArgv.length > 1 &&
    execBasename(fullArgv[0]) === "env" &&
    isGoExecutable(fullArgv[1])
  ) {
    return true;
  }
  return false;
}

function resolveUserUidGid(sys, userSpec, explicitUid, explicitGid) {
  if (explicitUid !== undefined || explicitGid !== undefined) {
    return {
      uid: explicitUid !== undefined ? explicitUid >>> 0 : 0,
      gid: explicitGid !== undefined ? explicitGid >>> 0 : 0,
    };
  }
  const spec = String(userSpec || "").trim();
  if (!spec) return { uid: 0, gid: 0 };

  const parts = spec.split(":");
  const userPart = parts[0].trim();
  const groupPart = parts.length > 1 ? parts[1].trim() : "";

  let uid = 0;
  let gid = 0;
  let userResolved = false;

  if (/^\d+$/.test(userPart)) {
    uid = Number(userPart) >>> 0;
    userResolved = true;
  } else if (userPart) {
    const passwdBytes = sys.readVfsFile("/etc/passwd");
    if (passwdBytes) {
      const lines = textDecoder.decode(passwdBytes).split(/\r?\n/);
      for (const line of lines) {
        if (!line || line.startsWith("#")) continue;
        const fields = line.split(":");
        if (fields.length >= 4 && fields[0] === userPart) {
          uid = Number(fields[2]) >>> 0;
          gid = Number(fields[3]) >>> 0;
          userResolved = true;
          break;
        }
      }
    }
  }

  if (groupPart) {
    if (/^\d+$/.test(groupPart)) {
      gid = Number(groupPart) >>> 0;
    } else {
      const groupBytes = sys.readVfsFile("/etc/group");
      if (groupBytes) {
        const lines = textDecoder.decode(groupBytes).split(/\r?\n/);
        for (const line of lines) {
          if (!line || line.startsWith("#")) continue;
          const fields = line.split(":");
          if (fields.length >= 3 && fields[0] === groupPart) {
            gid = Number(fields[2]) >>> 0;
            break;
          }
        }
      }
    }
  } else if (userResolved && /^\d+$/.test(userPart)) {
    gid = uid;
  }

  return { uid, gid };
}

async function loadWasmModule(wasmInput, url) {
  if (wasmInput instanceof WebAssembly.Module) return wasmInput;
  if (wasmInput) {
    return await WebAssembly.compile(toUint8Array(wasmInput));
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch WASM module from ${url}: ${res.status} ${res.statusText}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  return await WebAssembly.compile(bytes);
}

/**
 * Shared client-side container engine used by both DirectBackend (Node.js / main thread)
 * and `js/container_worker.mjs` (browser Web Worker).
 */
export class ContainerEngine {
  constructor(options = {}) {
    this.compilerMod = null;
    this.runtimeMod = null;
    this.compilerInst = null;
    this.registryProxyBase = "/api/v2";
    this.gitProxyBase = "/api/git/archive";
    this.maxCachedImages =
      Number.isInteger(options.maxCachedImages) && options.maxCachedImages > 0
        ? options.maxCachedImages
        : 8;
    this.moduleCache = new Map();
    this.images = new Map();
    this.containers = new Map();
    this.nextImageId = 1;
    this.nextContainerId = 1;
    this.disposed = false;
  }

  async init(options = {}) {
    this.registryProxyBase = options.registryProxyBase ?? "/api/v2";
    this.gitProxyBase = options.gitProxyBase ?? "/api/git/archive";
    if (Number.isInteger(options.maxCachedImages) && options.maxCachedImages > 0) {
      this.maxCachedImages = options.maxCachedImages;
    }
    const compilerWasmUrl = options.compilerWasmUrl ?? "/wasm/elf2wasm_compiler_wasm.wasm";
    const runtimeWasmUrl = options.runtimeWasmUrl ?? "/wasm/elf2wasm_runtime_wasm.wasm";

    const [cMod, rMod] = await Promise.all([
      loadWasmModule(options.compilerWasm, compilerWasmUrl),
      loadWasmModule(options.runtimeWasm, runtimeWasmUrl),
    ]);
    this.compilerMod = cMod;
    this.runtimeMod = rMod;
    this.compilerInst = await WebAssembly.instantiate(cMod, {});
  }

  _registerImage(imageData) {
    while (this.images.size >= this.maxCachedImages) {
      const oldestKey = this.images.keys().next().value;
      if (oldestKey === undefined) break;
      this.images.delete(oldestKey);
    }
    const imageId = this.nextImageId++;
    this.images.set(imageId, imageData);
    return {
      imageId,
      ref: imageData.ref,
      digest: imageData.digest,
      config: imageData.config,
      layers: imageData.layers.map((l) => ({
        digest: l.digest,
        mediaType: l.mediaType,
        size: l.size,
      })),
    };
  }

  releaseImage(imageId) {
    this.images.delete(imageId);
  }

  async pullImage(imageRef, options = {}) {
    const data = await ociPullImage(imageRef, {
      registryProxyBase: options.registryProxyBase ?? this.registryProxyBase,
      platform: options.platform ?? "linux/amd64",
      onProgress: options.onProgress,
      signal: options.signal,
    });
    return this._registerImage(data);
  }

  async loadOciTarball(tarBytes, options = {}) {
    const data = await ociLoadOciTarball(tarBytes, options);
    return this._registerImage(data);
  }

  async createContainer(imageId, options = {}, callbacks = {}) {
    const assertActive = () => {
      if (this.disposed) {
        throw new Error("ContainerEngine has been disposed");
      }
      if (options.signal && options.signal.aborted) {
        const err = new Error("Operation aborted");
        err.name = "AbortError";
        throw err;
      }
    };
    assertActive();

    if (options.delayStddevMs !== undefined || options.delaySeed !== undefined) {
      validateDelayConfig(options.delayStddevMs ?? 0, options.delaySeed ?? 0);
    }

    const image = this.images.get(imageId);
    if (!image) {
      throw new Error(`Unknown imageId: ${imageId}`);
    }
    // Touch entry to keep active images warm in LRU order.
    this.images.delete(imageId);
    this.images.set(imageId, image);
    if ((!this.compilerInst && !this.compilerMod) || !this.runtimeMod) {
      throw new Error("ContainerEngine has not been initialized");
    }

    const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
    const sys = await Elf2WasmSystem.create({
      compilerInst: this.compilerInst,
      compilerMod: this.compilerMod,
      runtimeWasm: this.runtimeMod,
      moduleCache: this.moduleCache,
      onCompilerInstChange: (inst) => {
        this.compilerInst = inst;
      },
    });
    assertActive();
    if (sys.compilerInst) {
      this.compilerInst = sys.compilerInst;
    }

    const layerCount = image.layers.length;
    for (let i = 0; i < layerCount; i++) {
      if (onProgress) {
        onProgress({
          stage: "extract",
          message: `Extracting layer ${i + 1}/${layerCount} into VFS...`,
          layerIndex: i,
          layerCount,
          loaded: i,
          total: layerCount,
        });
      }
      extractTarToVfs(sys, image.layers[i].tarBytes);
    }

    let overlayDefaultCwd = null;

    if (options.gitRepo && typeof options.gitRepo === "object" && options.gitRepo.repo) {
      const mountPath = normalizeMountPath(options.gitRepo.mountPath, "/workspace");
      // Yield a macrotask tick after synchronous layer extraction so Node/libuv
      // processes any pending socket close events before fetch() picks a pooled socket.
      await new Promise((resolve) => setTimeout(resolve, 0));
      assertActive();
      let archive = await fetchGitArchive({
        repo: options.gitRepo.repo,
        ref: options.gitRepo.ref,
        gitProxyBase:
          options.gitRepo.gitProxyBase ?? options.gitProxyBase ?? this.gitProxyBase,
        onProgress,
        signal: options.signal,
      });
      assertActive();
      const stripComponents =
        options.gitRepo.stripComponents !== undefined
          ? options.gitRepo.stripComponents
          : archive.stripComponents;
      if (onProgress) {
        onProgress({
          stage: "git-overlay",
          message: `Overlaying ${archive.repo}@${archive.ref} onto ${mountPath}...`,
          layerIndex: 0,
          layerCount: 1,
          loaded: 0,
          total: 1,
        });
      }
      extractTarToVfs(sys, archive.tarBytes, {
        mountPath,
        stripComponents,
        ignoreWhiteouts: true,
      });
      // Release uncompressed git archive buffer immediately after VFS extraction.
      archive.tarBytes = null;
      archive = null;
      if (onProgress) {
        onProgress({
          stage: "git-overlay",
          message: `Overlayed ${options.gitRepo.repo} onto ${mountPath}`,
          layerIndex: 1,
          layerCount: 1,
          loaded: 1,
          total: 1,
        });
      }
      overlayDefaultCwd = mountPath;
    }

    if (options.overlayTarBytes) {
      const mountPath = normalizeMountPath(options.overlayMountPath, "/workspace");
      const stripComponents =
        options.overlayStripComponents !== undefined ? options.overlayStripComponents : 0;
      if (onProgress) {
        onProgress({
          stage: "git-overlay",
          message: `Overlaying archive onto ${mountPath}...`,
          layerIndex: 0,
          layerCount: 1,
          loaded: 0,
          total: 1,
        });
      }
      let rawBytes = toUint8Array(options.overlayTarBytes);
      let tarBytes =
        rawBytes.length >= 2 && rawBytes[0] === 0x1f && rawBytes[1] === 0x8b
          ? await decompressLayer(rawBytes)
          : rawBytes;
      assertActive();
      extractTarToVfs(sys, tarBytes, {
        mountPath,
        stripComponents,
        ignoreWhiteouts: true,
      });
      tarBytes = null;
      rawBytes = null;
      if (onProgress) {
        onProgress({
          stage: "git-overlay",
          message: `Overlayed archive onto ${mountPath}`,
          layerIndex: 1,
          layerCount: 1,
          loaded: 1,
          total: 1,
        });
      }
      overlayDefaultCwd = mountPath;
    }

    // Merge Entrypoint + Cmd following Docker semantics
    let entrypoint = [];
    let cmd = [];
    if (options.entrypoint !== undefined) {
      entrypoint = normalizeCmdArray(options.entrypoint);
      cmd = options.cmd !== undefined ? normalizeCmdArray(options.cmd) : [];
    } else {
      entrypoint = normalizeCmdArray(image.config.entrypoint);
      cmd =
        options.cmd !== undefined
          ? normalizeCmdArray(options.cmd)
          : normalizeCmdArray(image.config.cmd);
    }
    let fullArgv = [...entrypoint, ...cmd];
    if (fullArgv.length === 0) {
      fullArgv = ["/bin/sh"];
    }

    const hasExplicitCwd = typeof options.cwd === "string" && options.cwd.length > 0;
    const cwd = hasExplicitCwd
      ? options.cwd
      : overlayDefaultCwd || image.config.workingDir || "/";
    const tty = Boolean(options.tty);
    const cols = Number.isInteger(options.cols) && options.cols > 0 ? options.cols : 80;
    const rows = Number.isInteger(options.rows) && options.rows > 0 ? options.rows : 24;

    const baseEnv = [
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "HOME=/root",
      `PWD=${cwd}`,
    ];
    if (tty) baseEnv.push("TERM=xterm-256color");
    if (isNodeContainer(image.config.env, entrypoint, cmd, fullArgv)) {
      baseEnv.push(...getNodeDefaultEnv(image.config.env));
    }
    if (isGoContainer(image.config.env, entrypoint, cmd, fullArgv, image.ref)) {
      baseEnv.push(...getGoDefaultEnv());
    }
    const postImageEnv = hasExplicitCwd || overlayDefaultCwd ? [`PWD=${cwd}`] : [];
    const env = mergeEnv(
      baseEnv,
      image.config.env,
      postImageEnv.length ? [...postImageEnv, ...(options.env || [])] : options.env
    );

    const { uid, gid } = resolveUserUidGid(
      sys,
      options.user !== undefined ? options.user : image.config.user,
      options.uid,
      options.gid
    );

    const containerId = this.nextContainerId++;
    const rec = {
      containerId,
      sys,
      argv: fullArgv,
      env,
      imageConfigEnv: Array.isArray(image.config.env) ? image.config.env.slice() : [],
      imageRef: image.ref,
      cwd,
      tty,
      cols,
      rows,
      uid,
      gid,
      stdin: options.stdin,
      delayStddevMs: options.delayStddevMs,
      delaySeed: options.delaySeed,
      _hasDelayConfigured:
        options.delayStddevMs !== undefined || options.delaySeed !== undefined,
      onProgress,
      callbacks,
      started: false,
      busy: false,
      stopped: false,
      exited: false,
      exitCode: 0,
      runPromise: null,
      execPromise: null,
    };
    this.containers.set(containerId, rec);
    return { containerId };
  }

  _getContainer(containerId) {
    const rec = this.containers.get(containerId);
    if (!rec) {
      throw new Error(`Unknown containerId: ${containerId}`);
    }
    return rec;
  }

  async startContainer(containerId) {
    const rec = this._getContainer(containerId);
    if (rec.started) {
      throw new Error(`Container ${containerId} has already been started`);
    }
    if (rec.busy) {
      throw new Error(`Container ${containerId} already has an active execution`);
    }
    if (rec.stopped || rec.exited || !this.containers.has(containerId)) {
      return;
    }
    rec.started = true;
    rec.busy = true;
    let busyReleased = false;
    const releaseBusy = () => {
      if (!busyReleased) {
        busyReleased = true;
        rec.busy = false;
      }
    };

    if (rec.onProgress) {
      rec.onProgress({
        stage: "compile",
        message: `Compiling ${rec.argv[0]} to WebAssembly...`,
        layerIndex: 0,
        layerCount: 0,
        loaded: 0,
        total: 0,
      });
    }

    if (rec.argv.length > 0 && typeof rec.sys.precompileFromVfs === "function") {
      const entryPath = rec.sys.resolveCommandPath(rec.argv[0], rec.env, rec.cwd);
      const entryBytes = entryPath ? rec.sys.readVfsFile(entryPath) : null;
      if (entryBytes && entryBytes.length >= 2 && entryBytes[0] === 0x23 && entryBytes[1] === 0x21) {
        let targetCmd = null;
        if (rec.argv.length >= 2 && !rec.argv[1].startsWith("-")) {
          targetCmd = rec.argv[1];
        } else if (rec.argv[0].endsWith("docker-entrypoint.sh")) {
          targetCmd = "node";
        }
        if (targetCmd) {
          if (rec.onProgress) {
            rec.onProgress({
              stage: "compile",
              message: `Compiling ${targetCmd} to WebAssembly...`,
              layerIndex: 0,
              layerCount: 0,
              loaded: 0,
              total: 0,
            });
          }
          try {
            await rec.sys.precompileFromVfs(targetCmd, { env: rec.env, cwd: rec.cwd });
          } catch {
            // best-effort precompile
          }
        }
      }
    }

    if (rec.stopped || rec.exited || !this.containers.has(containerId)) {
      releaseBusy();
      return;
    }

    let resolveReady;
    let rejectReady;
    const readyPromise = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    let readySettled = false;

    const finishExit = (exitCode) => {
      if (rec.exited) return;
      rec.exited = true;
      rec.exitCode = exitCode;
      releaseBusy();
      if (rec.callbacks && typeof rec.callbacks.onExit === "function") {
        rec.callbacks.onExit(exitCode);
      }
    };

    const delayOpts =
      rec.delayStddevMs !== undefined ||
      rec.delaySeed !== undefined ||
      rec._hasDelayConfigured
        ? { delayStddevMs: rec.delayStddevMs ?? 0, delaySeed: rec.delaySeed ?? 0 }
        : {};

    rec.runPromise = rec.sys
      .runFromVfs(rec.argv[0], rec.argv, {
        env: rec.env,
        cwd: rec.cwd,
        tty: rec.tty,
        uid: rec.uid,
        gid: rec.gid,
        rows: rec.rows,
        cols: rec.cols,
        stdin: rec.stdin,
        keepStdinOpen: rec.stdin === undefined,
        preserveArgv0: true,
        ...delayOpts,
        onReady: () => {
          if (!readySettled) {
            readySettled = true;
            if (rec.onProgress) {
              rec.onProgress({
                stage: "run",
                message: `Running ${rec.argv[0]}`,
                layerIndex: 0,
                layerCount: 0,
                loaded: 1,
                total: 1,
              });
            }
            resolveReady();
          }
        },
        onStdout: (chunk) => {
          if (rec.callbacks && typeof rec.callbacks.onStdout === "function") {
            rec.callbacks.onStdout(chunk);
          }
        },
        onStderr: (chunk) => {
          if (rec.callbacks && typeof rec.callbacks.onStderr === "function") {
            rec.callbacks.onStderr(chunk);
          }
        },
      })
      .then((res) => {
        if (!readySettled) {
          readySettled = true;
          resolveReady();
        }
        finishExit(res.exitCode);
        return res;
      })
      .catch((err) => {
        if (!readySettled) {
          readySettled = true;
          rejectReady(err);
        }
        if (rec.callbacks && typeof rec.callbacks.onStderr === "function") {
          rec.callbacks.onStderr(textEncoder.encode(`Container error: ${err.message}\n`));
        }
        finishExit(err && err.code === "ENOEXEC" ? 126 : 127);
      })
      .finally(() => {
        releaseBusy();
      });

    await readyPromise;
  }

  writeStdin(containerId, data) {
    const rec = this._getContainer(containerId);
    rec.sys.pushStdin(data);
  }

  closeStdin(containerId) {
    const rec = this._getContainer(containerId);
    rec.sys.closeStdin();
  }

  resize(containerId, cols, rows) {
    const rec = this._getContainer(containerId);
    rec.cols = cols;
    rec.rows = rows;
    rec.sys.setWinsize(rows, cols);
  }

  sendSignal(containerId, signal = "SIGINT") {
    const rec = this._getContainer(containerId);
    if (signal === "SIGINT" || signal === 2) {
      rec.sys.sendSigint();
    } else if (signal === "SIGKILL" || signal === "SIGTERM" || signal === 9 || signal === 15) {
      rec.sys.stop();
    } else {
      throw new Error(`Unsupported signal: ${signal}`);
    }
  }

  readFile(containerId, path) {
    const rec = this._getContainer(containerId);
    return rec.sys.readVfsFile(path);
  }

  writeFile(containerId, path, data, mode = 0o644) {
    const rec = this._getContainer(containerId);
    rec.sys.writeVfsFile(path, toUint8Array(data), mode);
  }

  snapshotVfs(containerId) {
    const rec = this._getContainer(containerId);
    if (rec.stopped) throw new Error(`Container ${containerId} has been stopped`);
    if (rec.busy) {
      throw new Error(`Cannot snapshot container ${containerId} while an execution is active`);
    }
    return rec.sys.snapshotVfs();
  }

  restoreVfs(containerId, snapshotId) {
    const rec = this._getContainer(containerId);
    if (rec.stopped) throw new Error(`Container ${containerId} has been stopped`);
    if (rec.busy) {
      throw new Error(`Cannot restore snapshot on container ${containerId} while an execution is active`);
    }
    rec.sys.restoreVfs(snapshotId);
  }

  dropVfsSnapshot(containerId, snapshotId) {
    const rec = this.containers.get(containerId);
    if (!rec || rec.stopped) return;
    rec.sys.dropVfsSnapshot(snapshotId);
  }

  exportVfsDiffTar(containerId, { baseSnapshotId, pathPrefix } = {}) {
    const rec = this._getContainer(containerId);
    if (rec.stopped) throw new Error(`Container ${containerId} has been stopped`);
    if (rec.busy) {
      throw new Error(`Cannot export VFS diff on container ${containerId} while an execution is active`);
    }
    return rec.sys.exportVfsDiffTar({ baseSnapshotId, pathPrefix });
  }

  listVfsDiff(containerId, { baseSnapshotId, pathPrefix } = {}) {
    const rec = this._getContainer(containerId);
    if (rec.stopped) throw new Error(`Container ${containerId} has been stopped`);
    if (rec.busy) {
      throw new Error(`Cannot list VFS diff on container ${containerId} while an execution is active`);
    }
    return rec.sys.listVfsDiff({ baseSnapshotId, pathPrefix });
  }

  async applyTarOverlay(
    containerId,
    tarBytes,
    { mountPath = "/", stripComponents = 0, ignoreWhiteouts = false } = {}
  ) {
    const rec = this._getContainer(containerId);
    if (rec.stopped) throw new Error(`Container ${containerId} has been stopped`);
    if (rec.busy) {
      throw new Error(`Cannot apply tar overlay on container ${containerId} while an execution is active`);
    }
    const rawTar = await gunzipBytes(toUint8Array(tarBytes));
    extractTarToVfs(rec.sys, rawTar, {
      mountPath: normalizeMountPath(mountPath, "/"),
      stripComponents,
      ignoreWhiteouts,
    });
  }

  async mountGitRepo(
    containerId,
    { repo, ref, mountPath, stripComponents, gitProxyBase, onProgress, signal } = {}
  ) {
    const rec = this._getContainer(containerId);
    if (rec.stopped) throw new Error(`Container ${containerId} has been stopped`);
    if (rec.busy) {
      throw new Error(`Cannot mount git repo on container ${containerId} while an execution is active`);
    }
    if (signal?.aborted) throw makeAbortError();
    const resolvedMount = normalizeMountPath(mountPath, "/workspace");
    const archive = await fetchGitArchive({
      repo,
      ref,
      gitProxyBase: gitProxyBase ?? this.gitProxyBase,
      onProgress,
      signal,
    });
    if (signal?.aborted || rec.stopped) throw makeAbortError();
    const strip = stripComponents !== undefined ? stripComponents : archive.stripComponents;
    extractTarToVfs(rec.sys, archive.tarBytes, {
      mountPath: resolvedMount,
      stripComponents: strip,
      ignoreWhiteouts: true,
    });
    archive.tarBytes = null;
    return { repo: archive.repo, ref: archive.ref, mountPath: resolvedMount };
  }

  async runLayerPipeline(layers, options = {}) {
    return await executeLayerPipeline(layers, options, this);
  }

  async execContainer(containerId, options = {}) {
    const rec = this._getContainer(containerId);
    if (rec.stopped || this.disposed) {
      throw new Error(`Container ${containerId} has been stopped`);
    }
    if (rec.busy) {
      throw new Error(`Container ${containerId} already has an active execution`);
    }
    if (options.signal?.aborted) {
      throw makeAbortError();
    }

    const execArgv = options.cmd !== undefined ? normalizeCmdArray(options.cmd) : rec.argv;
    if (execArgv.length === 0 || String(execArgv[0]).trim() === "") {
      throw new TypeError("exec requires a non-empty cmd");
    }

    const hasExplicitCwd = typeof options.cwd === "string" && options.cwd.length > 0;
    const cwd = hasExplicitCwd ? options.cwd : rec.cwd;
    const tty = options.tty !== undefined ? Boolean(options.tty) : false;
    const stdin = options.stdin !== undefined ? options.stdin : tty ? undefined : "";

    const extraDefaults = [];
    if (tty) extraDefaults.push("TERM=xterm-256color");
    if (isNodeContainer(rec.imageConfigEnv, [], execArgv, execArgv)) {
      extraDefaults.push(...getNodeDefaultEnv(rec.imageConfigEnv));
    }
    if (isGoContainer(rec.imageConfigEnv, [], execArgv, execArgv, rec.imageRef)) {
      extraDefaults.push(...getGoDefaultEnv());
    }
    const cwdOverride = hasExplicitCwd ? [`PWD=${cwd}`] : [];
    const env = mergeEnv(
      extraDefaults,
      rec.env,
      cwdOverride.length ? [...cwdOverride, ...(options.env || [])] : options.env
    );

    const hasDelayArg =
      options.delayStddevMs !== undefined || options.delaySeed !== undefined;
    const effectiveStddevMs =
      options.delayStddevMs !== undefined ? options.delayStddevMs : rec.delayStddevMs;
    const effectiveSeed =
      options.delaySeed !== undefined ? options.delaySeed : rec.delaySeed;
    const shouldApplyDelay = hasDelayArg || rec._hasDelayConfigured;
    if (shouldApplyDelay) {
      validateDelayConfig(effectiveStddevMs ?? 0, effectiveSeed ?? 0);
    }
    if (hasDelayArg) rec._hasDelayConfigured = true;
    const delayOpts = shouldApplyDelay
      ? { delayStddevMs: effectiveStddevMs ?? 0, delaySeed: effectiveSeed ?? 0 }
      : {};

    const execCtrl = new AbortController();
    let abortedByCaller = false;
    let onCallerAbort = null;
    if (options.signal) {
      onCallerAbort = () => {
        abortedByCaller = true;
        execCtrl.abort();
        rec.sys.stop();
      };
      options.signal.addEventListener("abort", onCallerAbort, { once: true });
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    const onStdout = (chunk) => {
      const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      stdoutChunks.push(u8);
      if (typeof options.onStdout === "function") {
        options.onStdout(u8);
      }
    };
    const onStderr = (chunk) => {
      const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      stderrChunks.push(u8);
      if (typeof options.onStderr === "function") {
        options.onStderr(u8);
      }
    };

    rec.busy = true;
    const runPromise = (async () => {
      try {
        const res = await rec.sys.runFromVfs(execArgv[0], execArgv, {
          env,
          cwd,
          tty,
          uid: rec.uid,
          gid: rec.gid,
          rows: rec.rows,
          cols: rec.cols,
          stdin,
          keepStdinOpen: tty && stdin === undefined,
          preserveArgv0: true,
          timeoutMs: options.timeoutMs,
          signal: execCtrl.signal,
          ...delayOpts,
          onStdout,
          onStderr,
        });
        if (abortedByCaller || rec.stopped) {
          throw makeAbortError();
        }
        if (res.timedOut) {
          return {
            exitCode: 124,
            stdout: decodeChunks(stdoutChunks),
            stderr: decodeChunks(stderrChunks),
            virtualTimeNs: res.virtualTimeNs ?? rec.sys.getVirtualTimeNs(),
            timedOut: true,
            error: `Execution timed out after ${options.timeoutMs}ms`,
          };
        }
        return {
          exitCode: res.exitCode,
          stdout: decodeChunks(stdoutChunks),
          stderr: decodeChunks(stderrChunks),
          virtualTimeNs: res.virtualTimeNs ?? 0,
        };
      } catch (err) {
        if (abortedByCaller || rec.stopped) {
          throw makeAbortError();
        }
        if (err instanceof RangeError) {
          throw err;
        }
        return {
          exitCode: err?.code === "ENOEXEC" ? 126 : err?.code === "ENOENT" ? 127 : 1,
          stdout: decodeChunks(stdoutChunks),
          stderr: decodeChunks(stderrChunks),
          virtualTimeNs:
            typeof rec.sys.getVirtualTimeNs === "function" ? rec.sys.getVirtualTimeNs() : 0,
          error: err?.message ? String(err.message) : String(err),
        };
      } finally {
        if (options.signal && onCallerAbort) {
          options.signal.removeEventListener("abort", onCallerAbort);
        }
        rec.busy = false;
        rec.execPromise = null;
      }
    })();

    rec.execPromise = runPromise;
    return await runPromise;
  }

  async stopContainer(containerId) {
    const rec = this.containers.get(containerId);
    if (!rec) return;
    rec.stopped = true;
    rec.sys.stop();
    if (rec.runPromise) {
      try {
        await rec.runPromise;
      } catch {
        // ignore
      }
    }
    if (rec.execPromise) {
      try {
        await rec.execPromise;
      } catch {
        // ignore
      }
    }
    if (!rec.exited) {
      rec.exited = true;
      rec.exitCode = 137;
      rec.busy = false;
      if (rec.callbacks && typeof rec.callbacks.onExit === "function") {
        rec.callbacks.onExit(137);
      }
    }
    this.containers.delete(containerId);
  }

  getContainerStats(containerId) {
    const rec = this.containers.get(containerId);
    if (!rec) return null;
    return {
      activeProcesses: rec.sys.getActiveProcessCount(),
      reapedPidCount: rec.sys.reapedPidCount,
      moduleCacheSize: this.moduleCache.size,
    };
  }

  async dispose() {
    this.disposed = true;
    const ids = Array.from(this.containers.keys());
    for (const id of ids) {
      await this.stopContainer(id);
    }
    this.images.clear();
    this.moduleCache.clear();
  }
}

class DirectBackend {
  constructor() {
    this.engine = new ContainerEngine();
    this.containerHandlers = new Map();
  }

  get isAlive() {
    return !this.engine.disposed;
  }

  onCrash() {
    return () => {};
  }

  async init(options) {
    await this.engine.init(options);
  }

  async pullImage(imageRef, options) {
    return await this.engine.pullImage(imageRef, options);
  }

  async loadOciTarball(tarBytes, options) {
    return await this.engine.loadOciTarball(tarBytes, options);
  }

  async releaseImage(imageId) {
    this.engine.releaseImage(imageId);
  }

  async createContainer(imageId, options, handlers) {
    const { containerId } = await this.engine.createContainer(imageId, options, handlers);
    this.containerHandlers.set(containerId, handlers);
    return { containerId };
  }

  async startContainer(containerId) {
    await this.engine.startContainer(containerId);
  }

  writeStdin(containerId, data) {
    this.engine.writeStdin(containerId, data);
  }

  closeStdin(containerId) {
    this.engine.closeStdin(containerId);
  }

  resize(containerId, cols, rows) {
    this.engine.resize(containerId, cols, rows);
  }

  sendSignal(containerId, signal) {
    this.engine.sendSignal(containerId, signal);
  }

  async readFile(containerId, path) {
    return this.engine.readFile(containerId, path);
  }

  async writeFile(containerId, path, data, mode) {
    this.engine.writeFile(containerId, path, data, mode);
  }

  async snapshotVfs(containerId) {
    return this.engine.snapshotVfs(containerId);
  }

  async restoreVfs(containerId, snapshotId) {
    this.engine.restoreVfs(containerId, snapshotId);
  }

  async dropVfsSnapshot(containerId, snapshotId) {
    this.engine.dropVfsSnapshot(containerId, snapshotId);
  }

  async exportVfsDiffTar(containerId, options = {}) {
    return this.engine.exportVfsDiffTar(containerId, options);
  }

  async listVfsDiff(containerId, options = {}) {
    return this.engine.listVfsDiff(containerId, options);
  }

  async applyTarOverlay(containerId, tarBytes, options = {}) {
    await this.engine.applyTarOverlay(containerId, tarBytes, options);
  }

  async mountGitRepo(containerId, options = {}) {
    return await this.engine.mountGitRepo(containerId, options);
  }

  async runLayerPipeline(layers, options = {}) {
    return await this.engine.runLayerPipeline(layers, options);
  }

  async execContainer(containerId, options = {}) {
    return await this.engine.execContainer(containerId, options);
  }

  async stopContainer(containerId) {
    await this.engine.stopContainer(containerId);
    this.containerHandlers.delete(containerId);
  }

  getContainerStats(containerId) {
    return this.engine.getContainerStats(containerId);
  }

  async dispose() {
    await this.engine.dispose();
    this.containerHandlers.clear();
  }
}

class WorkerBackend {
  constructor(workerUrl) {
    this.worker = new Worker(
      workerUrl || new URL("./container_worker.mjs", import.meta.url),
      { type: "module" }
    );
    this.nextReqId = 1;
    this.pending = new Map();
    this.progressListeners = new Map();
    this.execHandlers = new Map();
    this.pipelineHandlers = new Map();
    this.containerHandlers = new Map();
    this._dead = false;
    this._deadError = null;
    this._crashListeners = new Set();

    this.worker.addEventListener("message", (ev) => {
      const msg = ev.data;
      if (!msg || typeof msg !== "object") return;

      if (msg.event === "progress") {
        const cb =
          this.progressListeners.get(msg.reqId) ||
          (msg.containerId ? this.containerHandlers.get(msg.containerId)?.onProgress : null);
        if (cb) cb(msg.data);
        return;
      }

      if (msg.event === "pipelineEvent") {
        const h = this.pipelineHandlers.get(msg.reqId);
        if (!h) return;
        if (msg.kind === "layerStart" && h.onLayerStart) h.onLayerStart(msg.data);
        else if (msg.kind === "layerOutput" && h.onLayerOutput) {
          const data = msg.data?.chunk
            ? { ...msg.data, chunk: new Uint8Array(msg.data.chunk) }
            : msg.data;
          h.onLayerOutput(data);
        } else if (msg.kind === "layerComplete" && h.onLayerComplete) h.onLayerComplete(msg.data);
        else if (msg.kind === "variationStart" && h.onVariationStart) h.onVariationStart(msg.data);
        else if (msg.kind === "variationComplete" && h.onVariationComplete) {
          h.onVariationComplete(msg.data);
        }
        return;
      }

      if (msg.event === "containerProgress") {
        const handlers = this.containerHandlers.get(msg.containerId);
        if (handlers && typeof handlers.onProgress === "function") {
          handlers.onProgress(msg.data);
        }
        return;
      }

      if (msg.event === "execStdout" || msg.event === "execStderr") {
        const h = this.execHandlers.get(msg.reqId);
        if (!h) return;
        const chunk = new Uint8Array(msg.chunk);
        if (msg.event === "execStdout" && h.onStdout) h.onStdout(chunk);
        else if (msg.event === "execStderr" && h.onStderr) h.onStderr(chunk);
        return;
      }

      if (msg.event === "stdout" || msg.event === "stderr" || msg.event === "exit") {
        const handlers = this.containerHandlers.get(msg.containerId);
        if (!handlers) return;
        if (msg.event === "stdout" && handlers.onStdout) {
          handlers.onStdout(new Uint8Array(msg.chunk));
        } else if (msg.event === "stderr" && handlers.onStderr) {
          handlers.onStderr(new Uint8Array(msg.chunk));
        } else if (msg.event === "exit" && handlers.onExit) {
          handlers.onExit(msg.exitCode);
        }
        return;
      }

      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        this.progressListeners.delete(msg.id);
        this.execHandlers.delete(msg.id);
        this.pipelineHandlers.delete(msg.id);
        if (msg.ok) {
          p.resolve(msg.result);
        } else {
          const errName = typeof msg.error?.name === "string" ? msg.error.name : "Error";
          const ERROR_CONSTRUCTORS = {
            Error,
            RangeError,
            TypeError,
            SyntaxError,
            URIError,
            ReferenceError,
          };
          const ErrCtor = Object.prototype.hasOwnProperty.call(ERROR_CONSTRUCTORS, errName)
            ? ERROR_CONSTRUCTORS[errName]
            : Error;
          const err = new ErrCtor(msg.error?.message || "Worker RPC error");
          if (msg.error?.name) err.name = msg.error.name;
          if (msg.error?.code) err.code = msg.error.code;
          p.reject(err);
        }
      }
    });

    this.worker.addEventListener("error", (ev) => {
      const err = new Error(ev.message || "Container worker crashed");
      this._dead = true;
      this._deadError = err;
      for (const [, p] of this.pending) {
        p.reject(err);
      }
      this.pending.clear();
      this.progressListeners.clear();
      this.execHandlers.clear();
      this.pipelineHandlers.clear();
      for (const [, handlers] of this.containerHandlers) {
        if (handlers && typeof handlers.onExit === "function") {
          try {
            handlers.onExit(1);
          } catch {
            // ignore callback errors during worker crash cleanup
          }
        }
      }
      this.containerHandlers.clear();
      for (const cb of Array.from(this._crashListeners)) {
        try {
          cb(err);
        } catch {
          // ignore listener errors
        }
      }
    });
  }

  get isAlive() {
    return !this._dead;
  }

  onCrash(cb) {
    if (typeof cb !== "function") return () => {};
    this._crashListeners.add(cb);
    if (this._dead) {
      queueMicrotask(() => cb(this._deadError || new Error("Container worker crashed")));
    }
    return () => this._crashListeners.delete(cb);
  }

  _call(
    type,
    payload = {},
    { onProgress, onStdout, onStderr, pipelineHandlers, signal, transfer = [] } = {}
  ) {
    if (this._dead) {
      return Promise.reject(this._deadError || new Error("Container worker is no longer alive"));
    }
    const id = this.nextReqId++;
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(makeAbortError());
        return;
      }
      if (typeof onProgress === "function") {
        this.progressListeners.set(id, onProgress);
      }
      if (typeof onStdout === "function" || typeof onStderr === "function") {
        this.execHandlers.set(id, { onStdout, onStderr });
      }
      if (pipelineHandlers) {
        this.pipelineHandlers.set(id, pipelineHandlers);
      }
      let onAbort = null;
      if (signal) {
        onAbort = () => {
          if (!this._dead) {
            this.worker.postMessage({ id: 0, type: "abort", payload: { targetId: id } });
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.pending.set(id, {
        resolve: (val) => {
          if (signal && onAbort) signal.removeEventListener("abort", onAbort);
          resolve(val);
        },
        reject: (err) => {
          if (signal && onAbort) signal.removeEventListener("abort", onAbort);
          reject(err);
        },
      });
      try {
        this.worker.postMessage({ id, type, payload }, transfer);
      } catch (err) {
        this.pending.delete(id);
        this.progressListeners.delete(id);
        this.execHandlers.delete(id);
        this.pipelineHandlers.delete(id);
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
        reject(err);
      }
    });
  }

  async init(options) {
    const payload = {
      compilerWasmUrl: options.compilerWasmUrl,
      runtimeWasmUrl: options.runtimeWasmUrl,
      registryProxyBase: options.registryProxyBase,
      gitProxyBase: options.gitProxyBase,
      maxCachedImages: options.maxCachedImages,
    };
    await this._call("init", payload);
  }

  async pullImage(imageRef, options = {}) {
    return await this._call(
      "pullImage",
      {
        imageRef,
        platform: options.platform,
        registryProxyBase: options.registryProxyBase,
      },
      { onProgress: options.onProgress, signal: options.signal }
    );
  }

  async loadOciTarball(tarBytes, options = {}) {
    const copy = toUint8Array(tarBytes).slice();
    return await this._call(
      "loadOciTarball",
      {
        tarBytes: copy,
        options: { platform: options.platform, name: options.name },
      },
      { onProgress: options.onProgress, transfer: [copy.buffer] }
    );
  }

  async releaseImage(imageId) {
    if (this._dead) return;
    await this._call("releaseImage", { imageId });
  }

  async createContainer(imageId, options = {}, handlers = {}) {
    const transfer = [];
    const cleanOptions = {
      cmd: options.cmd,
      entrypoint: options.entrypoint,
      env: options.env,
      cwd: options.cwd,
      tty: options.tty,
      cols: options.cols,
      rows: options.rows,
      user: options.user,
      uid: options.uid,
      gid: options.gid,
      stdin: options.stdin != null ? toUint8Array(options.stdin).slice() : undefined,
      delayStddevMs: options.delayStddevMs,
      delaySeed: options.delaySeed,
      gitRepo:
        options.gitRepo && typeof options.gitRepo === "object"
          ? {
              repo: options.gitRepo.repo,
              ref: options.gitRepo.ref,
              mountPath: options.gitRepo.mountPath,
              stripComponents: options.gitRepo.stripComponents,
              gitProxyBase: options.gitRepo.gitProxyBase,
            }
          : undefined,
      gitProxyBase: options.gitProxyBase,
      overlayMountPath: options.overlayMountPath,
      overlayStripComponents: options.overlayStripComponents,
    };
    if (options.overlayTarBytes != null) {
      const overlayCopy = toUint8Array(options.overlayTarBytes).slice();
      cleanOptions.overlayTarBytes = overlayCopy;
      transfer.push(overlayCopy.buffer);
    }
    const res = await this._call(
      "createContainer",
      { imageId, options: cleanOptions },
      { onProgress: options.onProgress, signal: options.signal, transfer }
    );
    this.containerHandlers.set(res.containerId, {
      ...handlers,
      onProgress: typeof options.onProgress === "function" ? options.onProgress : undefined,
    });
    return res;
  }

  async startContainer(containerId) {
    await this._call("start", { containerId });
  }

  writeStdin(containerId, data) {
    if (this._dead) return;
    const copy = toUint8Array(data).slice();
    this.worker.postMessage(
      { id: 0, type: "writeStdin", payload: { containerId, data: copy } },
      [copy.buffer]
    );
  }

  closeStdin(containerId) {
    if (this._dead) return;
    this.worker.postMessage({ id: 0, type: "closeStdin", payload: { containerId } });
  }

  resize(containerId, cols, rows) {
    if (this._dead) return;
    this.worker.postMessage({ id: 0, type: "resize", payload: { containerId, cols, rows } });
  }

  sendSignal(containerId, signal) {
    if (this._dead) return;
    this.worker.postMessage({ id: 0, type: "sendSignal", payload: { containerId, signal } });
  }

  async readFile(containerId, path) {
    const res = await this._call("readFile", { containerId, path });
    return res ? new Uint8Array(res) : null;
  }

  async writeFile(containerId, path, data, mode = 0o644) {
    const copy = toUint8Array(data).slice();
    await this._call(
      "writeFile",
      { containerId, path, data: copy, mode },
      { transfer: [copy.buffer] }
    );
  }

  async snapshotVfs(containerId) {
    return await this._call("snapshotVfs", { containerId });
  }

  async restoreVfs(containerId, snapshotId) {
    await this._call("restoreVfs", { containerId, snapshotId });
  }

  async dropVfsSnapshot(containerId, snapshotId) {
    if (this._dead) return;
    await this._call("dropVfsSnapshot", { containerId, snapshotId });
  }

  async exportVfsDiffTar(containerId, options = {}) {
    const res = await this._call("exportVfsDiffTar", {
      containerId,
      options: {
        baseSnapshotId: options.baseSnapshotId,
        pathPrefix: options.pathPrefix,
      },
    });
    return res ? new Uint8Array(res) : new Uint8Array(0);
  }

  async listVfsDiff(containerId, options = {}) {
    return await this._call("listVfsDiff", {
      containerId,
      options: {
        baseSnapshotId: options.baseSnapshotId,
        pathPrefix: options.pathPrefix,
      },
    });
  }

  async applyTarOverlay(containerId, tarBytes, options = {}) {
    const copy = toUint8Array(tarBytes).slice();
    await this._call(
      "applyTarOverlay",
      {
        containerId,
        tarBytes: copy,
        options: {
          mountPath: options.mountPath,
          stripComponents: options.stripComponents,
          ignoreWhiteouts: options.ignoreWhiteouts,
        },
      },
      { transfer: [copy.buffer] }
    );
  }

  async mountGitRepo(containerId, options = {}) {
    return await this._call(
      "mountGitRepo",
      {
        containerId,
        options: {
          repo: options.repo,
          ref: options.ref,
          mountPath: options.mountPath,
          stripComponents: options.stripComponents,
          gitProxyBase: options.gitProxyBase,
        },
      },
      { onProgress: options.onProgress, signal: options.signal }
    );
  }

  async runLayerPipeline(layers, options = {}) {
    const cleanOptions = {
      apiBase: options.apiBase,
      executorOverride: options.executorOverride,
      platform: options.platform,
      registryProxyBase: options.registryProxyBase,
      gitProxyBase: options.gitProxyBase,
      user: options.user,
      uid: options.uid,
      gid: options.gid,
      stdin: options.stdin,
      delayStddevMs: options.delayStddevMs,
      delaySeed: options.delaySeed,
      timeoutMs: options.timeoutMs,
      stopOnError: options.stopOnError,
      stopOnSweepFailure: options.stopOnSweepFailure,
      _hasLayerStart: typeof options.onLayerStart === "function",
      _hasLayerOutput: typeof options.onLayerOutput === "function",
      _hasLayerComplete: typeof options.onLayerComplete === "function",
      _hasVariationStart: typeof options.onVariationStart === "function",
      _hasVariationComplete: typeof options.onVariationComplete === "function",
    };
    const pipelineHandlers = {
      onLayerStart: options.onLayerStart,
      onLayerOutput: options.onLayerOutput,
      onLayerComplete: options.onLayerComplete,
      onVariationStart: options.onVariationStart,
      onVariationComplete: options.onVariationComplete,
    };
    return await this._call(
      "runLayerPipeline",
      { layers, options: cleanOptions },
      {
        onProgress: options.onProgress,
        pipelineHandlers,
        signal: options.signal,
      }
    );
  }

  async execContainer(containerId, options = {}) {
    const transfer = [];
    let stdinCopy;
    if (options.stdin != null) {
      stdinCopy = toUint8Array(options.stdin).slice();
      transfer.push(stdinCopy.buffer);
    }
    const cleanOptions = {
      cmd: options.cmd,
      env: options.env,
      cwd: options.cwd,
      tty: options.tty,
      stdin: stdinCopy,
      delayStddevMs: options.delayStddevMs,
      delaySeed: options.delaySeed,
      timeoutMs: options.timeoutMs,
      _streamStdout: typeof options.onStdout === "function",
      _streamStderr: typeof options.onStderr === "function",
    };
    return await this._call(
      "exec",
      { containerId, options: cleanOptions },
      {
        onStdout: options.onStdout,
        onStderr: options.onStderr,
        signal: options.signal,
        transfer,
      }
    );
  }

  async stopContainer(containerId) {
    if (!this._dead) {
      await this._call("stop", { containerId });
    }
    this.containerHandlers.delete(containerId);
  }

  getContainerStats() {
    return null;
  }

  async dispose() {
    if (!this._dead) {
      try {
        await this._call("dispose", {});
      } catch {
        // ignore
      }
    }
    this._dead = true;
    this._deadError = this._deadError || new Error("Container worker disposed");
    this.worker.terminate();
    for (const [, p] of this.pending) {
      p.reject(this._deadError);
    }
    this.pending.clear();
    this.progressListeners.clear();
    this.execHandlers.clear();
    this.pipelineHandlers.clear();
    this.containerHandlers.clear();
    this._crashListeners.clear();
  }
}

export class DockerContainer {
  constructor(backend, containerId) {
    this._backend = backend;
    this._containerId = containerId;
    this._stdoutCbs = new Set();
    this._stderrCbs = new Set();
    this._exitCbs = new Set();
    this._stdoutChunks = [];
    this._stderrChunks = [];
    this._exited = false;
    this._exitCode = 0;
    this._resolveWait = null;
    this._waitPromise = new Promise((resolve) => {
      this._resolveWait = resolve;
    });
  }

  _handleStdout(chunk) {
    const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    this._stdoutChunks.push(u8);
    for (const cb of this._stdoutCbs) {
      cb(u8);
    }
  }

  _handleStderr(chunk) {
    const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    this._stderrChunks.push(u8);
    for (const cb of this._stderrCbs) {
      cb(u8);
    }
  }

  _handleExit(exitCode) {
    if (this._exited) return;
    this._exited = true;
    this._exitCode = exitCode;
    for (const cb of this._exitCbs) {
      cb(exitCode);
    }
    this._resolveWait({
      exitCode,
      stdout: decodeChunks(this._stdoutChunks),
      stderr: decodeChunks(this._stderrChunks),
    });
  }

  _decodeChunks(chunks) {
    return decodeChunks(chunks);
  }

  onStdout(cb) {
    this._stdoutCbs.add(cb);
    return () => this._stdoutCbs.delete(cb);
  }

  onStderr(cb) {
    this._stderrCbs.add(cb);
    return () => this._stderrCbs.delete(cb);
  }

  onExit(cb) {
    this._exitCbs.add(cb);
    if (this._exited) {
      queueMicrotask(() => cb(this._exitCode));
    }
    return () => this._exitCbs.delete(cb);
  }

  async start() {
    await this._backend.startContainer(this._containerId);
  }

  writeStdin(data) {
    this._backend.writeStdin(this._containerId, data);
  }

  closeStdin() {
    this._backend.closeStdin(this._containerId);
  }

  resize(cols, rows) {
    this._backend.resize(this._containerId, cols, rows);
  }

  sendSignal(sig = "SIGINT") {
    this._backend.sendSignal(this._containerId, sig);
  }

  async wait() {
    return await this._waitPromise;
  }

  async readFile(path) {
    return await this._backend.readFile(this._containerId, path);
  }

  async writeFile(path, data, mode = 0o644) {
    await this._backend.writeFile(this._containerId, path, data, mode);
  }

  async snapshotVfs() {
    return await this._backend.snapshotVfs(this._containerId);
  }

  async restoreVfs(snapshotId) {
    await this._backend.restoreVfs(this._containerId, snapshotId);
  }

  async dropVfsSnapshot(snapshotId) {
    await this._backend.dropVfsSnapshot(this._containerId, snapshotId);
  }

  async exportVfsDiffTar(options = {}) {
    return await this._backend.exportVfsDiffTar(this._containerId, options);
  }

  async listVfsDiff(options = {}) {
    return await this._backend.listVfsDiff(this._containerId, options);
  }

  async applyTarOverlay(tarBytes, options = {}) {
    await this._backend.applyTarOverlay(this._containerId, tarBytes, options);
  }

  async mountGitRepo(options = {}) {
    return await this._backend.mountGitRepo(this._containerId, options);
  }

  async exec(options = {}) {
    return await this._backend.execContainer(this._containerId, options);
  }

  async stop() {
    await this._backend.stopContainer(this._containerId);
    if (!this._exited) {
      this._handleExit(137);
    }
  }

  _getStats() {
    return this._backend.getContainerStats(this._containerId);
  }
}

export class DockerImage {
  constructor(backend, meta) {
    this._backend = backend;
    this._imageId = meta.imageId;
    this._disposed = false;
    this.ref = meta.ref;
    this.digest = meta.digest;
    this.config = meta.config;
    this.layers = meta.layers;
  }

  async createContainer(options = {}) {
    let containerRef = null;
    const pendingStdout = [];
    const pendingStderr = [];
    let pendingExit = null;

    const handlers = {
      onStdout: (chunk) => {
        if (containerRef) containerRef._handleStdout(chunk);
        else pendingStdout.push(chunk);
      },
      onStderr: (chunk) => {
        if (containerRef) containerRef._handleStderr(chunk);
        else pendingStderr.push(chunk);
      },
      onExit: (code) => {
        if (containerRef) containerRef._handleExit(code);
        else pendingExit = code;
      },
    };

    const { containerId } = await this._backend.createContainer(this._imageId, options, handlers);
    containerRef = new DockerContainer(this._backend, containerId);
    for (const c of pendingStdout) containerRef._handleStdout(c);
    for (const c of pendingStderr) containerRef._handleStderr(c);
    if (pendingExit !== null) containerRef._handleExit(pendingExit);
    return containerRef;
  }

  async dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (typeof this._backend.releaseImage === "function") {
      await this._backend.releaseImage(this._imageId);
    }
  }

  async release() {
    await this.dispose();
  }
}

export class Elf2WasmDocker {
  constructor(backend, options) {
    this._backend = backend;
    this.options = options;
  }

  static async create(options = {}) {
    const resolvedOptions = {
      compilerWasmUrl: options.compilerWasmUrl ?? "/wasm/elf2wasm_compiler_wasm.wasm",
      runtimeWasmUrl: options.runtimeWasmUrl ?? "/wasm/elf2wasm_runtime_wasm.wasm",
      registryProxyBase: options.registryProxyBase ?? "/api/v2",
      gitProxyBase: options.gitProxyBase ?? "/api/git/archive",
      useWorker: options.useWorker ?? typeof Worker !== "undefined",
      compilerWasm: options.compilerWasm,
      runtimeWasm: options.runtimeWasm,
      workerUrl: options.workerUrl,
      maxCachedImages: options.maxCachedImages,
    };

    const backend =
      resolvedOptions.useWorker && typeof Worker !== "undefined"
        ? new WorkerBackend(resolvedOptions.workerUrl)
        : new DirectBackend();

    await backend.init(resolvedOptions);
    return new Elf2WasmDocker(backend, resolvedOptions);
  }

  get isAlive() {
    return this._backend.isAlive;
  }

  onCrash(cb) {
    return this._backend.onCrash(cb);
  }

  async pullImage(imageRef, options = {}) {
    const meta = await this._backend.pullImage(imageRef, options);
    return new DockerImage(this._backend, meta);
  }

  async loadOciTarball(tarBytes, options = {}) {
    const meta = await this._backend.loadOciTarball(tarBytes, options);
    return new DockerImage(this._backend, meta);
  }

  async runLayerPipeline(layers, options = {}) {
    return await this._backend.runLayerPipeline(layers, options);
  }

  async dispose() {
    await this._backend.dispose();
  }
}

/**
 * High-level one-shot helper to pull and execute a Docker image to completion.
 */
export async function runDockerImage(imageRef, options = {}) {
  const ownDocker = !options.docker;
  const docker =
    options.docker ||
    (await Elf2WasmDocker.create({
      compilerWasmUrl: options.compilerWasmUrl,
      runtimeWasmUrl: options.runtimeWasmUrl,
      registryProxyBase: options.registryProxyBase,
      gitProxyBase: options.gitProxyBase,
      useWorker: options.useWorker,
      compilerWasm: options.compilerWasm,
      runtimeWasm: options.runtimeWasm,
      workerUrl: options.workerUrl,
      maxCachedImages: options.maxCachedImages,
    }));

  let image = null;
  let container = null;
  try {
    image = await docker.pullImage(imageRef, {
      platform: options.platform,
      onProgress: options.onProgress,
      signal: options.signal,
    });
    const tty = options.tty ?? false;
    const stdin = !tty && options.stdin === undefined ? "" : options.stdin;
    container = await image.createContainer({
      cmd: options.cmd,
      entrypoint: options.entrypoint,
      env: options.env,
      cwd: options.cwd,
      tty,
      cols: options.cols,
      rows: options.rows,
      user: options.user,
      uid: options.uid,
      gid: options.gid,
      stdin,
      delayStddevMs: options.delayStddevMs,
      delaySeed: options.delaySeed,
      gitRepo: options.gitRepo,
      gitProxyBase: options.gitProxyBase,
      overlayTarBytes: options.overlayTarBytes,
      overlayMountPath: options.overlayMountPath,
      overlayStripComponents: options.overlayStripComponents,
      signal: options.signal,
      onProgress: options.onProgress,
    });
    // Release uncompressed layer tarBytes immediately after VFS extraction
    // before ELF-to-WASM compilation and guest instantiation.
    if (image) {
      try {
        await image.dispose();
      } catch {
        // ignore cleanup error
      }
      image = null;
    }
    if (typeof options.onStdout === "function") container.onStdout(options.onStdout);
    if (typeof options.onStderr === "function") container.onStderr(options.onStderr);
    await container.start();
    return await container.wait();
  } finally {
    if (ownDocker) {
      await docker.dispose();
    } else {
      if (container) {
        try {
          await container.stop();
        } catch {
          // ignore cleanup error
        }
      }
      if (image) {
        try {
          await image.dispose();
        } catch {
          // ignore cleanup error
        }
      }
    }
  }
}

/**
 * High-level sweep runner: builds once with deterministic zero-delay, captures a
 * Copy-on-Write VFS snapshot, then executes `runCmd` up to `runs` times with
 * increasing delay stddev and seed (restoring the snapshot before each run).
 */
export async function runSweep(imageRef, options = {}) {
  const runCmdArr = normalizeCmdArray(options.runCmd);
  if (runCmdArr.length === 0 || String(runCmdArr[0]).trim() === "") {
    throw new TypeError("runSweep requires a non-empty runCmd");
  }
  const rawBuildCmdArr = normalizeCmdArray(options.buildCmd);
  const buildCmdArr =
    rawBuildCmdArr.length === 0 ||
    (rawBuildCmdArr.length === 1 && String(rawBuildCmdArr[0]).trim() === "")
      ? []
      : rawBuildCmdArr;
  if (buildCmdArr.length > 0 && String(buildCmdArr[0]).trim() === "") {
    throw new TypeError("runSweep buildCmd executable must be non-empty");
  }

  const rawRuns = options.runs !== undefined ? Number(options.runs) : 20;
  if (!Number.isFinite(rawRuns) || Math.floor(rawRuns) < 1) {
    throw new RangeError(`runSweep requires runs >= 1 (got ${options.runs})`);
  }
  const totalRuns = Math.floor(rawRuns);

  const stddevStart = options.stddevStart !== undefined ? Number(options.stddevStart) : 1;
  if (!Number.isFinite(stddevStart) || stddevStart < 0) {
    throw new RangeError(`runSweep requires finite stddevStart >= 0 (got ${options.stddevStart})`);
  }

  const stddevStep = options.stddevStep !== undefined ? Number(options.stddevStep) : 1;
  if (!Number.isFinite(stddevStep) || stddevStep < 0) {
    throw new RangeError(`runSweep requires finite stddevStep >= 0 (got ${options.stddevStep})`);
  }

  let seedStart;
  let seedIsBigInt = false;
  if (typeof options.seedStart === "bigint") {
    seedIsBigInt = true;
    seedStart = options.seedStart;
    if (seedStart < 0n || seedStart > 0xffff_ffff_ffff_ffffn) {
      throw new RangeError(
        `runSweep requires seedStart in 0..2^64-1 (got ${options.seedStart})`
      );
    }
    if (seedStart + BigInt(totalRuns - 1) > 0xffff_ffff_ffff_ffffn) {
      throw new RangeError(
        `runSweep seed range overflows u64 (seedStart=${seedStart}, runs=${totalRuns})`
      );
    }
  } else {
    const rawSeedStart = options.seedStart !== undefined ? Number(options.seedStart) : 1;
    if (!Number.isSafeInteger(rawSeedStart) || rawSeedStart < 0) {
      throw new RangeError(
        `runSweep requires safe non-negative integer seedStart (got ${options.seedStart})`
      );
    }
    if (rawSeedStart + (totalRuns - 1) > Number.MAX_SAFE_INTEGER) {
      throw new RangeError(
        `runSweep seed range exceeds Number.MAX_SAFE_INTEGER (seedStart=${rawSeedStart}, runs=${totalRuns}); use BigInt for larger seeds`
      );
    }
    seedStart = rawSeedStart;
  }

  const maxSeed = seedIsBigInt ? seedStart + BigInt(totalRuns - 1) : seedStart + (totalRuns - 1);
  const maxStddevMs = round3(stddevStart + (totalRuns - 1) * stddevStep);
  validateDelayConfig(stddevStart, seedStart);
  validateDelayConfig(stddevStep, 0);
  validateDelayConfig(maxStddevMs, maxSeed);

  const stopOnFailure = options.stopOnFailure !== undefined ? Boolean(options.stopOnFailure) : true;

  let gitRepo = options.gitRepo;
  if (!gitRepo && typeof options.repo === "string" && options.repo.trim()) {
    gitRepo = {
      repo: options.repo.trim(),
      ref: options.ref,
      mountPath: options.mountPath,
    };
  }

  if (options.signal?.aborted) {
    throw makeAbortError();
  }

  const ownDocker = !options.docker;
  const docker =
    options.docker ||
    (await Elf2WasmDocker.create({
      compilerWasmUrl: options.compilerWasmUrl,
      runtimeWasmUrl: options.runtimeWasmUrl,
      registryProxyBase: options.registryProxyBase,
      gitProxyBase: options.gitProxyBase,
      useWorker: options.useWorker,
      compilerWasm: options.compilerWasm,
      runtimeWasm: options.runtimeWasm,
      workerUrl: options.workerUrl,
      maxCachedImages: options.maxCachedImages,
    }));

  let image = null;
  let container = null;
  let snapshotId = null;

  try {
    image = await docker.pullImage(imageRef, {
      platform: options.platform,
      onProgress: options.onProgress,
      signal: options.signal,
    });

    container = await image.createContainer({
      cmd: ["/bin/sh"],
      cwd: options.cwd,
      env: options.env,
      tty: false,
      stdin: "",
      user: options.user,
      uid: options.uid,
      gid: options.gid,
      gitRepo,
      gitProxyBase: options.gitProxyBase,
      overlayTarBytes: options.overlayTarBytes,
      overlayMountPath: options.overlayMountPath,
      overlayStripComponents: options.overlayStripComponents,
      signal: options.signal,
      onProgress: options.onProgress,
    });

    if (image) {
      try {
        await image.dispose();
      } catch {
        // ignore cleanup error
      }
      image = null;
    }

    let build;
    if (buildCmdArr.length > 0) {
      if (typeof options.onProgress === "function") {
        options.onProgress({
          stage: "build",
          message: `Building: ${buildCmdArr.join(" ")}`,
          layerIndex: 0,
          layerCount: 1,
          loaded: 0,
          total: 1,
        });
      }
      const buildRes = await container.exec({
        cmd: buildCmdArr,
        cwd: options.cwd,
        env: options.env,
        tty: false,
        stdin: "",
        delayStddevMs: 0,
        delaySeed: 0,
        timeoutMs: options.buildTimeoutMs,
        signal: options.signal,
        onStdout:
          typeof options.onBuildOutput === "function"
            ? (chunk) => options.onBuildOutput({ stream: "stdout", chunk })
            : undefined,
        onStderr:
          typeof options.onBuildOutput === "function"
            ? (chunk) => options.onBuildOutput({ stream: "stderr", chunk })
            : undefined,
      });
      build = {
        exitCode: buildRes.exitCode,
        stdout: buildRes.stdout,
        stderr: buildRes.stderr,
        skipped: false,
        ...(buildRes.error ? { error: buildRes.error } : {}),
        ...(buildRes.timedOut ? { timedOut: true } : {}),
      };
      if (buildRes.exitCode !== 0 || buildRes.error || buildRes.timedOut) {
        return {
          build,
          runs: [],
          failedRun: null,
          passed: false,
        };
      }
    } else {
      build = {
        exitCode: 0,
        stdout: "",
        stderr: "",
        skipped: true,
      };
    }

    if (options.signal?.aborted) {
      throw makeAbortError();
    }

    snapshotId = await container.snapshotVfs();

    const runs = [];
    let failedRun = null;

    for (let i = 0; i < totalRuns; i++) {
      if (options.signal?.aborted) {
        throw makeAbortError();
      }
      const index = i + 1;
      const stddevMs = round3(stddevStart + i * stddevStep);
      const seed = seedIsBigInt ? seedStart + BigInt(i) : seedStart + i;

      await container.restoreVfs(snapshotId);

      if (typeof options.onRunStart === "function") {
        options.onRunStart({ index, totalRuns, stddevMs, seed });
      }
      if (typeof options.onProgress === "function") {
        options.onProgress({
          stage: "sweep",
          message: `Sweep run ${index}/${totalRuns} (stddev=${stddevMs}ms, seed=${seed})`,
          layerIndex: i,
          layerCount: totalRuns,
          loaded: i,
          total: totalRuns,
        });
      }

      const res = await container.exec({
        cmd: runCmdArr,
        cwd: options.cwd,
        env: options.env,
        tty: false,
        stdin: "",
        delayStddevMs: stddevMs,
        delaySeed: seed,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        onStdout:
          typeof options.onRunOutput === "function"
            ? (chunk) => options.onRunOutput({ index, stream: "stdout", chunk })
            : undefined,
        onStderr:
          typeof options.onRunOutput === "function"
            ? (chunk) => options.onRunOutput({ index, stream: "stderr", chunk })
            : undefined,
      });

      const timedOut = Boolean(res.timedOut);
      const hasError = Boolean(res.error);
      const failed = res.exitCode !== 0 || timedOut || hasError;
      const status = timedOut
        ? "timeout"
        : hasError
          ? "error"
          : res.exitCode !== 0
            ? "fail"
            : "pass";

      const runResult = {
        index,
        stddevMs,
        seed,
        exitCode: res.exitCode,
        status,
        stdout: res.stdout,
        stderr: res.stderr,
        virtualTimeNs: res.virtualTimeNs ?? 0,
        error: res.error ?? null,
        ...(timedOut ? { timedOut: true } : {}),
      };

      runs.push(runResult);
      if (failed && !failedRun) {
        failedRun = runResult;
      }
      if (typeof options.onRunComplete === "function") {
        options.onRunComplete(runResult);
      }
      if (failed && stopOnFailure) {
        break;
      }
    }

    return {
      build,
      runs,
      failedRun,
      passed: failedRun === null,
    };
  } finally {
    if (container && snapshotId !== null) {
      try {
        await container.dropVfsSnapshot(snapshotId);
      } catch {
        // ignore cleanup error
      }
    }
    if (ownDocker) {
      await docker.dispose();
    } else {
      if (container) {
        try {
          await container.stop();
        } catch {
          // ignore cleanup error
        }
      }
      if (image) {
        try {
          await image.dispose();
        } catch {
          // ignore cleanup error
        }
      }
    }
  }
}

function resolveEffectiveExecutor(layer, executorOverride) {
  if (executorOverride === "local" || executorOverride === "remote") {
    return executorOverride;
  }
  return layer?.executor === "remote" ? "remote" : "local";
}

function pipelineNeedsLocalEngine(layers, executorOverride) {
  if (!Array.isArray(layers)) return false;
  for (const layer of layers) {
    if (!layer || typeof layer !== "object") continue;
    if (layer.type === "run" && resolveEffectiveExecutor(layer, executorOverride) === "local") {
      return true;
    }
  }
  return false;
}

function resolvePosixWorkdir(currentCwd, rawPath) {
  const raw = String(rawPath || "").trim();
  if (!raw) return currentCwd || "/";
  const base = raw.startsWith("/")
    ? "/"
    : currentCwd && currentCwd.startsWith("/")
      ? currentCwd
      : "/";
  const combined = raw.startsWith("/") ? raw : `${base}/${raw}`;
  const segments = [];
  for (const seg of combined.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (segments.length > 0) segments.pop();
    } else {
      segments.push(seg);
    }
  }
  return "/" + segments.join("/");
}

function resolveEvalUrl(apiBase) {
  if (typeof apiBase === "string" && apiBase.trim()) {
    return `${apiBase.trim().replace(/\/+$/, "")}/api/eval`;
  }
  if (
    typeof self !== "undefined" &&
    self.location &&
    typeof self.location.origin === "string" &&
    self.location.origin &&
    self.location.origin !== "null"
  ) {
    return `${self.location.origin.replace(/\/+$/, "")}/api/eval`;
  }
  return "/api/eval";
}

/**
 * Internal multi-layer pipeline executor shared by `ContainerEngine.runLayerPipeline`
 * and standalone `runLayerPipeline` (with zero-WASM pure-remote support when `engine` is null).
 *
 * @param {object[]} layers
 * @param {object} options
 * @param {ContainerEngine | null} engine
 */
async function executeLayerPipeline(layers, options = {}, engine = null) {
  if (!Array.isArray(layers)) {
    throw new TypeError("runLayerPipeline requires an array of layers");
  }
  if (options.signal?.aborted) {
    throw makeAbortError();
  }

  const executorOverride =
    options.executorOverride === "local" || options.executorOverride === "remote"
      ? options.executorOverride
      : null;
  const stopOnError = options.stopOnError !== undefined ? Boolean(options.stopOnError) : true;
  const stopOnSweepFailure =
    options.stopOnSweepFailure !== undefined ? Boolean(options.stopOnSweepFailure) : false;
  const fetchFn = typeof options.fetch === "function" ? options.fetch : globalThis.fetch;
  const baseDelayStddevMs = options.delayStddevMs ?? 0;
  const baseDelaySeed = options.delaySeed ?? 0;

  let localContainerId = null;
  let localImageId = null;
  let preSweepSnapshotId = null;

  const state = {
    baseImage: "alpine:latest",
    gitRepos: [],
    mountedLocalGitCount: 0,
    cwd: "",
    env: [],
    inputLayerDiffs: [],
    pendingLocalDiffs: [],
  };

  const ensureLocalContainer = async () => {
    if (localContainerId !== null) {
      while (state.mountedLocalGitCount < state.gitRepos.length) {
        const g = state.gitRepos[state.mountedLocalGitCount];
        await engine.mountGitRepo(localContainerId, {
          repo: g.repo,
          ref: g.ref,
          mountPath: g.mountPath,
          gitProxyBase: options.gitProxyBase,
          onProgress: options.onProgress,
          signal: options.signal,
        });
        state.mountedLocalGitCount++;
      }
      while (state.pendingLocalDiffs.length > 0) {
        const diffBytes = state.pendingLocalDiffs.shift();
        await engine.applyTarOverlay(localContainerId, diffBytes, {
          mountPath: "/",
          stripComponents: 0,
          ignoreWhiteouts: false,
        });
      }
      return localContainerId;
    }

    if (!engine) {
      throw new Error("Local execution requires an initialized ContainerEngine");
    }

    const meta = await engine.pullImage(state.baseImage, {
      platform: options.platform ?? "linux/amd64",
      registryProxyBase: options.registryProxyBase,
      onProgress: options.onProgress,
      signal: options.signal,
    });
    localImageId = meta.imageId;

    const firstGit = state.gitRepos.length > 0 ? state.gitRepos[0] : undefined;
    const { containerId } = await engine.createContainer(localImageId, {
      cmd: ["/bin/sh"],
      cwd: state.cwd || undefined,
      env: state.env.length > 0 ? state.env : undefined,
      tty: false,
      stdin: "",
      user: options.user,
      uid: options.uid,
      gid: options.gid,
      gitRepo: firstGit
        ? {
            repo: firstGit.repo,
            ref: firstGit.ref,
            mountPath: firstGit.mountPath,
            gitProxyBase: options.gitProxyBase,
          }
        : undefined,
      gitProxyBase: options.gitProxyBase,
      onProgress: options.onProgress,
      signal: options.signal,
    });
    localContainerId = containerId;
    state.mountedLocalGitCount = firstGit ? 1 : 0;

    engine.releaseImage(localImageId);
    localImageId = null;

    while (state.mountedLocalGitCount < state.gitRepos.length) {
      const g = state.gitRepos[state.mountedLocalGitCount];
      await engine.mountGitRepo(localContainerId, {
        repo: g.repo,
        ref: g.ref,
        mountPath: g.mountPath,
        gitProxyBase: options.gitProxyBase,
        onProgress: options.onProgress,
        signal: options.signal,
      });
      state.mountedLocalGitCount++;
    }

    while (state.pendingLocalDiffs.length > 0) {
      const diffBytes = state.pendingLocalDiffs.shift();
      await engine.applyTarOverlay(localContainerId, diffBytes, {
        mountPath: "/",
        stripComponents: 0,
        ignoreWhiteouts: false,
      });
    }

    return localContainerId;
  };

  const executeSingleLayer = async (
    layer,
    layerIndex,
    { variationIndex = null, variation = null, delayStddevMs = baseDelayStddevMs, delaySeed = baseDelaySeed } = {}
  ) => {
    if (options.signal?.aborted) {
      throw makeAbortError();
    }

    const layerId = layer?.id || `layer-${layerIndex + 1}`;
    const type = layer?.type;

    if (type === "from") {
      const exec = resolveEffectiveExecutor(layer, executorOverride);
      if (typeof options.onLayerStart === "function") {
        options.onLayerStart({ layerIndex, layer, executor: exec, variationIndex, variation });
      }
      state.baseImage = String(layer.image || "alpine:latest").trim() || "alpine:latest";
      const res = {
        layerIndex,
        layerId,
        type: "from",
        executor: exec,
        ok: true,
        exitCode: 0,
        stdout: "",
        stderr: "",
        virtualTimeNs: 0,
        error: null,
        outputDiffTarGz: null,
        modifiedFiles: [],
        ...(variationIndex !== null ? { variationIndex } : {}),
      };
      if (typeof options.onLayerComplete === "function") options.onLayerComplete(res);
      return res;
    }

    if (type === "git") {
      const exec = resolveEffectiveExecutor(layer, executorOverride);
      if (typeof options.onLayerStart === "function") {
        options.onLayerStart({ layerIndex, layer, executor: exec, variationIndex, variation });
      }
      const gitSpec = {
        repo: String(layer.repo || "").trim(),
        ...(layer.ref ? { ref: String(layer.ref).trim() } : {}),
        mountPath: normalizeMountPath(layer.mountPath, "/workspace"),
      };
      state.gitRepos.push(gitSpec);
      if (localContainerId !== null && engine) {
        await engine.mountGitRepo(localContainerId, {
          ...gitSpec,
          gitProxyBase: options.gitProxyBase,
          onProgress: options.onProgress,
          signal: options.signal,
        });
        state.mountedLocalGitCount = state.gitRepos.length;
      }
      const res = {
        layerIndex,
        layerId,
        type: "git",
        executor: exec,
        ok: true,
        exitCode: 0,
        stdout: "",
        stderr: "",
        virtualTimeNs: 0,
        error: null,
        outputDiffTarGz: null,
        modifiedFiles: [],
        ...(variationIndex !== null ? { variationIndex } : {}),
      };
      if (typeof options.onLayerComplete === "function") options.onLayerComplete(res);
      return res;
    }

    if (type === "workdir") {
      if (typeof options.onLayerStart === "function") {
        options.onLayerStart({ layerIndex, layer, executor: null, variationIndex, variation });
      }
      const baseCwd =
        state.cwd ||
        (state.gitRepos.length > 0 ? state.gitRepos[state.gitRepos.length - 1].mountPath : "/");
      state.cwd = resolvePosixWorkdir(baseCwd, layer.path);
      const res = {
        layerIndex,
        layerId,
        type: "workdir",
        executor: null,
        ok: true,
        exitCode: 0,
        stdout: "",
        stderr: "",
        virtualTimeNs: 0,
        error: null,
        outputDiffTarGz: null,
        modifiedFiles: [],
        ...(variationIndex !== null ? { variationIndex } : {}),
      };
      if (typeof options.onLayerComplete === "function") options.onLayerComplete(res);
      return res;
    }

    if (type === "env") {
      if (typeof options.onLayerStart === "function") {
        options.onLayerStart({ layerIndex, layer, executor: null, variationIndex, variation });
      }
      if (layer.key) {
        state.env = mergeEnv(state.env, [], [`${layer.key}=${layer.value ?? ""}`]);
      }
      const res = {
        layerIndex,
        layerId,
        type: "env",
        executor: null,
        ok: true,
        exitCode: 0,
        stdout: "",
        stderr: "",
        virtualTimeNs: 0,
        error: null,
        outputDiffTarGz: null,
        modifiedFiles: [],
        ...(variationIndex !== null ? { variationIndex } : {}),
      };
      if (typeof options.onLayerComplete === "function") options.onLayerComplete(res);
      return res;
    }

    if (type === "run") {
      const target = resolveEffectiveExecutor(layer, executorOverride);
      if (typeof options.onLayerStart === "function") {
        options.onLayerStart({ layerIndex, layer, executor: target, variationIndex, variation });
      }

      const cmdArgv = Array.isArray(layer.cmd)
        ? layer.cmd.map(String)
        : ["sh", "-c", String(layer.cmd ?? "")];
      const effectiveCwd =
        state.cwd || (state.gitRepos.length > 0 ? state.gitRepos[state.gitRepos.length - 1].mountPath : "");
      const effectiveEnv = variation?.envOverride
        ? mergeEnv(state.env, [], [`${variation.envOverride[0]}=${variation.envOverride[1]}`])
        : state.env;

      if (target === "local") {
        const cid = await ensureLocalContainer();
        const beforeSnap = engine.snapshotVfs(cid);
        let execRes;
        let outputDiffTarGz = null;
        let modifiedFiles = [];
        try {
          execRes = await engine.execContainer(cid, {
            cmd: cmdArgv,
            env: effectiveEnv,
            cwd: effectiveCwd || undefined,
            tty: false,
            stdin: options.stdin !== undefined ? options.stdin : "",
            delayStddevMs,
            delaySeed,
            timeoutMs: options.timeoutMs,
            signal: options.signal,
            onStdout:
              typeof options.onLayerOutput === "function"
                ? (chunk) =>
                    options.onLayerOutput({
                      layerIndex,
                      layer,
                      stream: "stdout",
                      chunk,
                      variationIndex,
                      variation,
                    })
                : undefined,
            onStderr:
              typeof options.onLayerOutput === "function"
                ? (chunk) =>
                    options.onLayerOutput({
                      layerIndex,
                      layer,
                      stream: "stderr",
                      chunk,
                      variationIndex,
                      variation,
                    })
                : undefined,
          });
          modifiedFiles = engine.listVfsDiff(cid, { baseSnapshotId: beforeSnap });
          const rawDiffTar = engine.exportVfsDiffTar(cid, { baseSnapshotId: beforeSnap });
          if (rawDiffTar && rawDiffTar.byteLength > 0) {
            outputDiffTarGz = await gzipBytes(rawDiffTar);
            if (modifiedFiles.length > 0) {
              state.inputLayerDiffs.push(uint8ArrayToBase64(outputDiffTarGz));
            }
          }
        } finally {
          engine.dropVfsSnapshot(cid, beforeSnap);
        }

        const ok = execRes.exitCode === 0 && !execRes.timedOut && !execRes.error;
        const res = {
          layerIndex,
          layerId,
          type: "run",
          executor: "local",
          ok,
          exitCode: execRes.exitCode,
          stdout: execRes.stdout,
          stderr: execRes.stderr,
          virtualTimeNs: execRes.virtualTimeNs ?? 0,
          ...(execRes.timedOut ? { timedOut: true } : {}),
          error: execRes.error ?? null,
          outputDiffTarGz,
          modifiedFiles,
          ...(variationIndex !== null ? { variationIndex } : {}),
        };
        if (typeof options.onLayerComplete === "function") options.onLayerComplete(res);
        return res;
      }

      // Remote execution via POST /api/eval
      const evalUrl = resolveEvalUrl(options.apiBase);
      const remoteStdin =
        typeof options.stdin === "string"
          ? options.stdin
          : ArrayBuffer.isView(options.stdin)
            ? textDecoder.decode(
                new Uint8Array(
                  options.stdin.buffer,
                  options.stdin.byteOffset,
                  options.stdin.byteLength
                )
              )
            : "";
      const reqBody = {
        baseImage: state.baseImage,
        ...(state.gitRepos.length > 0
          ? { gitRepo: state.gitRepos[state.gitRepos.length - 1] }
          : {}),
        inputLayerDiffs: state.inputLayerDiffs,
        cmd: cmdArgv,
        env: effectiveEnv,
        cwd: effectiveCwd,
        user: options.user ?? "",
        stdin: remoteStdin,
        delayStddevMs,
        delaySeed,
        timeoutMs: options.timeoutMs ?? 30000,
        returnOutputDiff: true,
      };

      let resp;
      let data = null;
      try {
        resp = await fetchFn(evalUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(reqBody),
          signal: options.signal,
        });
        const text = await resp.text();
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = null;
        }
      } catch (err) {
        if (options.signal?.aborted || err?.name === "AbortError") {
          throw makeAbortError();
        }
        const failRes = {
          layerIndex,
          layerId,
          type: "run",
          executor: "remote",
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr: "",
          virtualTimeNs: 0,
          error: err?.message ? String(err.message) : String(err),
          errorCode: "NETWORK_ERROR",
          outputDiffTarGz: null,
          modifiedFiles: [],
          ...(variationIndex !== null ? { variationIndex } : {}),
        };
        if (typeof options.onLayerComplete === "function") options.onLayerComplete(failRes);
        return failRes;
      }

      if (!resp.ok || !data || data.ok === false) {
        const failStdout = typeof data?.stdout === "string" ? data.stdout : "";
        const failStderr = typeof data?.stderr === "string" ? data.stderr : "";
        if (typeof options.onLayerOutput === "function") {
          if (failStdout) {
            options.onLayerOutput({
              layerIndex,
              layer,
              stream: "stdout",
              chunk: textEncoder.encode(failStdout),
              variationIndex,
              variation,
            });
          }
          if (failStderr) {
            options.onLayerOutput({
              layerIndex,
              layer,
              stream: "stderr",
              chunk: textEncoder.encode(failStderr),
              variationIndex,
              variation,
            });
          }
        }
        const failRes = {
          layerIndex,
          layerId,
          type: "run",
          executor: data?.executor || "remote",
          ok: false,
          exitCode: typeof data?.exitCode === "number" ? data.exitCode : 1,
          stdout: failStdout,
          stderr: failStderr,
          virtualTimeNs: data?.virtualTimeNs ?? 0,
          ...(data?.timedOut ? { timedOut: true } : {}),
          error: data?.error || `Remote eval failed (HTTP ${resp.status})`,
          errorCode: data?.code || null,
          outputDiffTarGz: null,
          modifiedFiles: Array.isArray(data?.modifiedFiles) ? data.modifiedFiles : [],
          ...(variationIndex !== null ? { variationIndex } : {}),
        };
        if (typeof options.onLayerComplete === "function") options.onLayerComplete(failRes);
        return failRes;
      }

      const stdout = typeof data.stdout === "string" ? data.stdout : "";
      const stderr = typeof data.stderr === "string" ? data.stderr : "";
      if (typeof options.onLayerOutput === "function") {
        if (stdout) {
          options.onLayerOutput({
            layerIndex,
            layer,
            stream: "stdout",
            chunk: textEncoder.encode(stdout),
            variationIndex,
            variation,
          });
        }
        if (stderr) {
          options.onLayerOutput({
            layerIndex,
            layer,
            stream: "stderr",
            chunk: textEncoder.encode(stderr),
            variationIndex,
            variation,
          });
        }
      }

      let outputDiffTarGz = null;
      if (typeof data.outputDiffTarGzBase64 === "string" && data.outputDiffTarGzBase64.length > 0) {
        outputDiffTarGz = base64ToUint8Array(data.outputDiffTarGzBase64);
        state.inputLayerDiffs.push(data.outputDiffTarGzBase64);
        if (localContainerId !== null && engine) {
          await engine.applyTarOverlay(localContainerId, outputDiffTarGz, {
            mountPath: "/",
            stripComponents: 0,
            ignoreWhiteouts: false,
          });
        } else {
          state.pendingLocalDiffs.push(outputDiffTarGz);
        }
      }

      const exitCode = typeof data.exitCode === "number" ? data.exitCode : 0;
      const timedOut = Boolean(data.timedOut);
      const ok = exitCode === 0 && !timedOut && !data.error;
      const res = {
        layerIndex,
        layerId,
        type: "run",
        executor: data.executor || "remote-wasmi",
        ok,
        exitCode,
        stdout,
        stderr,
        virtualTimeNs: data.virtualTimeNs ?? 0,
        ...(timedOut ? { timedOut: true } : {}),
        error: data.error ?? null,
        outputDiffTarGz,
        modifiedFiles: Array.isArray(data.modifiedFiles) ? data.modifiedFiles : [],
        ...(variationIndex !== null ? { variationIndex } : {}),
      };
      if (typeof options.onLayerComplete === "function") options.onLayerComplete(res);
      return res;
    }

    // Unknown layer type -> no-op
    return {
      layerIndex,
      layerId,
      type: String(type || "unknown"),
      executor: null,
      ok: true,
      exitCode: 0,
      stdout: "",
      stderr: "",
      virtualTimeNs: 0,
      error: null,
      outputDiffTarGz: null,
      modifiedFiles: [],
      ...(variationIndex !== null ? { variationIndex } : {}),
    };
  };

  const preSweepResults = [];
  let sweepResult = null;
  let overallOk = true;

  try {
    for (let i = 0; i < layers.length; i++) {
      if (options.signal?.aborted) {
        throw makeAbortError();
      }
      const layer = layers[i];
      if (!layer || typeof layer !== "object") continue;

      if (layer.type === "sweep") {
        const variations = expandSweepValues(layer);
        const downstreamLayers = layers.slice(i + 1);
        const downstreamNeedsLocal = pipelineNeedsLocalEngine(downstreamLayers, executorOverride);

        if ((localContainerId !== null || downstreamNeedsLocal) && engine) {
          const cid = await ensureLocalContainer();
          preSweepSnapshotId = engine.snapshotVfs(cid);
        }

        const frozen = {
          baseImage: state.baseImage,
          gitRepos: state.gitRepos.map((g) => ({ ...g })),
          mountedLocalGitCount: state.mountedLocalGitCount,
          cwd: state.cwd,
          env: state.env.slice(),
          inputLayerDiffs: state.inputLayerDiffs.slice(),
          pendingLocalDiffs: state.pendingLocalDiffs.slice(),
        };

        const variationResults = [];
        let passedCount = 0;
        let failedCount = 0;

        for (let vIdx = 0; vIdx < variations.length; vIdx++) {
          if (options.signal?.aborted) {
            throw makeAbortError();
          }
          const variation = variations[vIdx];
          const variationIndex = vIdx + 1;

          if (localContainerId !== null && preSweepSnapshotId !== null && engine) {
            engine.restoreVfs(localContainerId, preSweepSnapshotId);
          }

          state.baseImage = frozen.baseImage;
          state.gitRepos = frozen.gitRepos.map((g) => ({ ...g }));
          state.mountedLocalGitCount = frozen.mountedLocalGitCount;
          state.cwd = frozen.cwd;
          state.env = frozen.env.slice();
          state.inputLayerDiffs = frozen.inputLayerDiffs.slice();
          state.pendingLocalDiffs = frozen.pendingLocalDiffs.slice();

          let varDelayStddevMs = baseDelayStddevMs;
          let varDelaySeed = baseDelaySeed;
          if (variation.delayStddevMs !== undefined) {
            varDelayStddevMs = variation.delayStddevMs;
          }
          if (variation.delaySeed !== undefined) {
            varDelaySeed = variation.delaySeed;
          }
          if (variation.envOverride) {
            state.env = mergeEnv(state.env, [], [
              `${variation.envOverride[0]}=${variation.envOverride[1]}`,
            ]);
          }

          if (typeof options.onVariationStart === "function") {
            options.onVariationStart({
              variationIndex,
              totalVariations: variations.length,
              variation,
            });
          }

          const varLayers = [];
          let varOk = true;
          let varExitCode = 0;
          let varStdout = "";
          let varStderr = "";

          for (let j = 0; j < downstreamLayers.length; j++) {
            const dl = downstreamLayers[j];
            const dlIndex = i + 1 + j;
            const lr = await executeSingleLayer(dl, dlIndex, {
              variationIndex,
              variation,
              delayStddevMs: varDelayStddevMs,
              delaySeed: varDelaySeed,
            });
            varLayers.push(lr);
            if (lr.stdout) varStdout += lr.stdout;
            if (lr.stderr) varStderr += lr.stderr;
            varExitCode = lr.exitCode;
            if (!lr.ok) {
              varOk = false;
              if (stopOnError) break;
            }
          }

          if (varOk) passedCount++;
          else failedCount++;

          const vRes = {
            variationIndex,
            label: variation.label,
            variation,
            ok: varOk,
            layers: varLayers,
            exitCode: varExitCode,
            stdout: varStdout,
            stderr: varStderr,
          };
          variationResults.push(vRes);

          if (typeof options.onVariationComplete === "function") {
            options.onVariationComplete(vRes);
          }

          if (!varOk && stopOnSweepFailure) {
            break;
          }
        }

        sweepResult = {
          layerIndex: i,
          layer,
          variations: variationResults,
          passedCount,
          failedCount,
        };
        if (failedCount > 0) overallOk = false;
        break;
      }

      const layerRes = await executeSingleLayer(layer, i);
      preSweepResults.push(layerRes);
      if (!layerRes.ok) {
        overallOk = false;
        if (stopOnError) break;
      }
    }

    return {
      ok: overallOk,
      layers: preSweepResults,
      sweep: sweepResult,
    };
  } finally {
    if (engine && localContainerId !== null && preSweepSnapshotId !== null) {
      try {
        engine.dropVfsSnapshot(localContainerId, preSweepSnapshotId);
      } catch {
        // ignore cleanup error
      }
    }
    if (engine && localContainerId !== null) {
      try {
        await engine.stopContainer(localContainerId);
      } catch {
        // ignore cleanup error
      }
    }
    if (engine && localImageId !== null) {
      try {
        engine.releaseImage(localImageId);
      } catch {
        // ignore cleanup error
      }
    }
  }
}

/**
 * High-level multi-layer pipeline runner supporting per-layer `local` vs `remote`
 * execution, `.tar.gz` VFS diff handoff, and generalized `sweep` fan-out.
 *
 * Pure-remote optimization: if no `run` layer resolves to `"local"` and no
 * `options.docker` is provided, executes directly against `/api/eval` without
 * initializing local WASM modules.
 *
 * @param {object[]} layers
 * @param {object} [options]
 */
export async function runLayerPipeline(layers, options = {}) {
  if (options.docker) {
    return await options.docker.runLayerPipeline(layers, options);
  }

  const executorOverride =
    options.executorOverride === "local" || options.executorOverride === "remote"
      ? options.executorOverride
      : null;

  if (!pipelineNeedsLocalEngine(layers, executorOverride)) {
    return await executeLayerPipeline(layers, options, null);
  }

  const docker = await Elf2WasmDocker.create({
    compilerWasmUrl: options.compilerWasmUrl,
    runtimeWasmUrl: options.runtimeWasmUrl,
    registryProxyBase: options.registryProxyBase,
    gitProxyBase: options.gitProxyBase,
    useWorker: options.useWorker,
    compilerWasm: options.compilerWasm,
    runtimeWasm: options.runtimeWasm,
    workerUrl: options.workerUrl,
    maxCachedImages: options.maxCachedImages,
  });

  try {
    return await docker.runLayerPipeline(layers, options);
  } finally {
    await docker.dispose();
  }
}

