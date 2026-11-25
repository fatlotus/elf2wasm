/**
 * Public JavaScript Docker-on-WASM SDK (Browser & Node.js compatible).
 *
 * Runs unmodified Linux x86-64 Docker/OCI images completely on the client side
 * using elf2wasm_compiler_wasm.wasm and elf2wasm_runtime_wasm.wasm.
 * Uses a dedicated Web Worker in browsers by default, with direct in-process
 * execution in Node.js (or when `useWorker: false`).
 */

import { Elf2WasmSystem, extractTarToVfs } from "./elf2wasm_shim.mjs";
import {
  parseImageRef,
  pullImage as ociPullImage,
  loadOciTarball as ociLoadOciTarball,
  decompressLayer,
} from "./oci_client.mjs";
import { fetchGitArchive } from "./git_client.mjs";

export { parseImageRef, fetchGitArchive, getGoDefaultEnv, isGoImageRef, isGoContainer, mergeEnv };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: false });

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
  if (typeof val === "string") return [val];
  if (Array.isArray(val)) return val.map((x) => String(x));
  return [];
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
      cwd,
      tty,
      cols,
      rows,
      uid,
      gid,
      stdin: options.stdin,
      onProgress,
      callbacks,
      started: false,
      stopped: false,
      exited: false,
      exitCode: 0,
      runPromise: null,
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
    if (rec.stopped || rec.exited || !this.containers.has(containerId)) {
      return;
    }
    rec.started = true;

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
      const entryPath = rec.sys.resolveCommandPath(rec.argv[0], rec.env);
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
            await rec.sys.precompileFromVfs(targetCmd, { env: rec.env });
          } catch {
            // best-effort precompile
          }
        }
      }
    }

    if (rec.stopped || rec.exited || !this.containers.has(containerId)) {
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
      if (rec.callbacks && typeof rec.callbacks.onExit === "function") {
        rec.callbacks.onExit(exitCode);
      }
    };

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
    if (!rec.exited) {
      rec.exited = true;
      rec.exitCode = 137;
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

      if (msg.event === "containerProgress") {
        const handlers = this.containerHandlers.get(msg.containerId);
        if (handlers && typeof handlers.onProgress === "function") {
          handlers.onProgress(msg.data);
        }
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
        if (msg.ok) {
          p.resolve(msg.result);
        } else {
          const err = new Error(msg.error?.message || "Worker RPC error");
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

  _call(type, payload = {}, { onProgress, signal, transfer = [] } = {}) {
    if (this._dead) {
      return Promise.reject(this._deadError || new Error("Container worker is no longer alive"));
    }
    const id = this.nextReqId++;
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        const err = new Error("Operation aborted");
        err.name = "AbortError";
        reject(err);
        return;
      }
      if (typeof onProgress === "function") {
        this.progressListeners.set(id, onProgress);
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
      this.worker.postMessage({ id, type, payload }, transfer);
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
      stdout: this._decodeChunks(this._stdoutChunks),
      stderr: this._decodeChunks(this._stderrChunks),
    });
  }

  _decodeChunks(chunks) {
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
