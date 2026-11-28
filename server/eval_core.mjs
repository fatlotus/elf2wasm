/**
 * Pure-ESM shared remote layer evaluation core (zero `node:*` imports).
 *
 * Shared between:
 * - Cloudflare Worker (`worker/src/handler.mjs`)
 * - Local Node.js dev server (`server/server.mjs`)
 *
 * Uses ONLY standard ECMAScript & Web APIs (`WebAssembly`, `CompressionStream`,
 * `DecompressionStream`, `TextEncoder`, `TextDecoder`, `Uint8Array`, `DataView`,
 * `atob`, `btoa`, `URL`, `URLSearchParams`, `Headers`) plus `./proxy_core.mjs`
 * and `./git_core.mjs`.
 *
 * ZERO dynamic `WebAssembly.compile()` calls — only instantiates a pre-compiled
 * `WebAssembly.Module` (`elf2wasm_worker_wasm.wasm`) with zero imports.
 */

import { DEFAULT_MANIFEST_ACCEPT } from "./proxy_core.mjs";
import { parseStripComponentsHeader } from "./git_core.mjs";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: false });

export const DEFAULT_PATH_ENV =
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
export const DEFAULT_MAX_EVAL_BODY_BYTES = 16 * 1024 * 1024; // 16 MiB
export const DEFAULT_MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024; // 64 MiB
export const DEFAULT_MAX_FUEL = 2_000_000_000;
export const MAX_FUEL_CAP = 2_000_000_000;
export const DEFAULT_MAX_MEMORY_BYTES = 96 * 1024 * 1024; // 96 MiB (allows 4-process shell pipelines under 2x fork budget)
export const MIN_MAX_MEMORY_BYTES = 65_536; // 64 KiB
export const MAX_MAX_MEMORY_BYTES = 128 * 1024 * 1024; // 128 MiB
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_INPUT_LAYER_DIFFS = 16;
export const MAX_MANIFEST_HOPS = 4;

const REPO_RE =
  /^[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*)*$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const HOST_PORT_RE =
  /^([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*)(?::([1-9]\d{0,4}))?$/;
const IPV6_BRACKET_RE = /^\[([0-9a-fA-F:.]+)\](?::([1-9]\d{0,4}))?$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

const DOCKER_HUB_ALIASES = new Set([
  "docker.io",
  "index.docker.io",
  "registry.hub.docker.com",
  "registry-1.docker.io",
]);

export class EvalError extends Error {
  /**
   * @param {number} statusCode
   * @param {"INVALID_REQUEST" | "FUEL_EXHAUSTED" | "MEMORY_LIMIT" | "UPSTREAM_ERROR"} code
   * @param {string} message
   */
  constructor(statusCode, code, message) {
    super(message);
    this.name = "EvalError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function uint8ArrayToBase64(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    bytes = new Uint8Array(bytes);
  }
  if (bytes.byteLength === 0) return "";
  const CHUNK_SIZE = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += CHUNK_SIZE) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.byteLength));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

export function base64ToUint8Array(b64, fieldName = "base64") {
  if (typeof b64 !== "string") {
    throw new EvalError(400, "INVALID_REQUEST", `${fieldName} must be a base64 string`);
  }
  const cleaned = b64.replace(/[\r\n\t ]+/g, "");
  if (cleaned.length === 0) {
    return new Uint8Array(0);
  }
  if (cleaned.length % 4 !== 0 || !BASE64_RE.test(cleaned)) {
    throw new EvalError(400, "INVALID_REQUEST", `Invalid base64 encoding in ${fieldName}`);
  }
  let binary;
  try {
    binary = atob(cleaned);
  } catch {
    throw new EvalError(400, "INVALID_REQUEST", `Invalid base64 encoding in ${fieldName}`);
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function isGzipBytes(bytes) {
  return bytes instanceof Uint8Array && bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

export async function gzipBytes(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  const reader = cs.readable.getReader();
  const chunks = [];
  let total = 0;

  const writePromise = (async () => {
    try {
      await writer.write(input);
      await writer.close();
    } catch (err) {
      try {
        await writer.abort(err);
      } catch {
        // Ignore abort errors
      }
      throw err;
    }
  })();

  const readPromise = (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  })();

  await Promise.all([writePromise, readPromise]);

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function gunzipBytes(
  bytes,
  { maxBytes = DEFAULT_MAX_DECOMPRESSED_BYTES, isUpstream = false } = {}
) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  const chunks = [];
  let total = 0;
  let limitError = null;

  const writePromise = (async () => {
    try {
      await writer.write(input);
      await writer.close();
    } catch (err) {
      if (!limitError) {
        throw err;
      }
    }
  })();

  const readPromise = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          total += value.byteLength;
          if (total > maxBytes) {
            limitError = new EvalError(
              507,
              "MEMORY_LIMIT",
              `Decompressed archive exceeded limit of ${maxBytes} bytes`
            );
            try {
              await reader.cancel(limitError);
            } catch {
              // Ignore cancel errors
            }
            try {
              await writer.abort(limitError);
            } catch {
              // Ignore abort errors
            }
            throw limitError;
          }
          chunks.push(value);
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Ignore release errors
      }
    }
  })();

  try {
    await Promise.all([writePromise, readPromise]);
  } catch (err) {
    if (limitError) throw limitError;
    if (err instanceof EvalError) throw err;
    throw new EvalError(
      isUpstream ? 502 : 400,
      isUpstream ? "UPSTREAM_ERROR" : "INVALID_REQUEST",
      `Failed to decompress gzip archive: ${err?.message || "corrupt gzip stream"}`
    );
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function detectCompression(bytes, mediaType = "") {
  const mt = String(mediaType || "").toLowerCase();
  if (
    (bytes.byteLength >= 4 &&
      bytes[0] === 0x28 &&
      bytes[1] === 0xb5 &&
      bytes[2] === 0x2f &&
      bytes[3] === 0xfd) ||
    mt.includes("zstd")
  ) {
    return "zstd";
  }
  if (
    bytes.byteLength >= 6 &&
    bytes[0] === 0xfd &&
    bytes[1] === 0x37 &&
    bytes[2] === 0x7a &&
    bytes[3] === 0x58 &&
    bytes[4] === 0x5a &&
    bytes[5] === 0x00
  ) {
    return "xz";
  }
  if (bytes.byteLength >= 3 && bytes[0] === 0x42 && bytes[1] === 0x5a && bytes[2] === 0x68) {
    return "bzip2";
  }
  if (
    isGzipBytes(bytes) ||
    mt.endsWith("+gzip") ||
    mt.endsWith(".gzip") ||
    mt.includes("application/gzip") ||
    mt.includes("application/x-gzip")
  ) {
    return "gzip";
  }
  return "none";
}

export async function maybeGunzipBytes(
  bytes,
  { mediaType = "", maxBytes = DEFAULT_MAX_DECOMPRESSED_BYTES, isUpstream = false } = {}
) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const comp = detectCompression(input, mediaType);
  if (comp === "zstd" || comp === "xz" || comp === "bzip2") {
    throw new EvalError(
      isUpstream ? 502 : 400,
      isUpstream ? "UPSTREAM_ERROR" : "INVALID_REQUEST",
      `Unsupported archive compression format: ${comp}`
    );
  }
  if (comp === "gzip") {
    return gunzipBytes(input, { maxBytes, isUpstream });
  }
  if (input.byteLength > maxBytes) {
    throw new EvalError(
      507,
      "MEMORY_LIMIT",
      `Archive size (${input.byteLength} bytes) exceeded limit of ${maxBytes} bytes`
    );
  }
  return input;
}

function validateRegistryHost(registry) {
  if (!registry || registry.length > 255) {
    throw new EvalError(400, "INVALID_REQUEST", `Invalid registry host: ${JSON.stringify(registry)}`);
  }
  let portStr = null;
  const ipv6Match = registry.match(IPV6_BRACKET_RE);
  if (ipv6Match) {
    if (!ipv6Match[1].includes(":")) {
      throw new EvalError(400, "INVALID_REQUEST", `Invalid IPv6 registry host: ${registry}`);
    }
    portStr = ipv6Match[2] || null;
  } else {
    const hostMatch = registry.match(HOST_PORT_RE);
    if (!hostMatch) {
      throw new EvalError(400, "INVALID_REQUEST", `Invalid registry host: ${registry}`);
    }
    portStr = hostMatch[2] || null;
  }
  if (portStr !== null) {
    const port = Number(portStr);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new EvalError(400, "INVALID_REQUEST", `Invalid registry port in: ${registry}`);
    }
  }
}

/**
 * Parse a Docker/OCI image reference into canonical components.
 * Mirrors `js/oci_client.mjs#parseImageRef`.
 */
export function parseImageRef(ref) {
  if (typeof ref !== "string") {
    throw new EvalError(400, "INVALID_REQUEST", "baseImage must be a non-empty string");
  }
  const trimmed = ref.trim();
  if (!trimmed) {
    throw new EvalError(400, "INVALID_REQUEST", "baseImage must be a non-empty string");
  }
  if (/[\x00-\x1f\x7f\s]/.test(trimmed)) {
    throw new EvalError(
      400,
      "INVALID_REQUEST",
      `Invalid whitespace or control character in baseImage: ${JSON.stringify(ref)}`
    );
  }
  if (trimmed.includes("://")) {
    throw new EvalError(400, "INVALID_REQUEST", `baseImage must not include a URL scheme: ${trimmed}`);
  }
  if (trimmed.includes("\\") || trimmed.includes("..") || trimmed.includes("//")) {
    throw new EvalError(400, "INVALID_REQUEST", `Invalid path sequence in baseImage: ${trimmed}`);
  }

  let namePart = trimmed;
  let digest = null;

  const atIdx = trimmed.indexOf("@");
  if (atIdx !== -1) {
    namePart = trimmed.slice(0, atIdx);
    digest = trimmed.slice(atIdx + 1);
    if (!DIGEST_RE.test(digest)) {
      throw new EvalError(400, "INVALID_REQUEST", `Invalid image digest: ${digest}`);
    }
    if (!namePart) {
      throw new EvalError(400, "INVALID_REQUEST", `Missing repository name before digest in: ${trimmed}`);
    }
  }

  let tag = null;
  const lastSlash = namePart.lastIndexOf("/");
  const lastColon = namePart.lastIndexOf(":");
  if (lastColon > lastSlash) {
    tag = namePart.slice(lastColon + 1);
    namePart = namePart.slice(0, lastColon);
    if (!tag || !TAG_RE.test(tag)) {
      throw new EvalError(400, "INVALID_REQUEST", `Invalid image tag: ${JSON.stringify(tag)}`);
    }
    if (!namePart) {
      throw new EvalError(400, "INVALID_REQUEST", `Missing repository name before tag in: ${trimmed}`);
    }
  }

  let registry = "registry-1.docker.io";
  let repository = namePart;

  const firstSlash = namePart.indexOf("/");
  if (firstSlash !== -1) {
    const first = namePart.slice(0, firstSlash);
    const rest = namePart.slice(firstSlash + 1);
    if (!first || !rest) {
      throw new EvalError(400, "INVALID_REQUEST", `Invalid baseImage reference: ${trimmed}`);
    }
    if (first === "localhost" || first.includes(".") || first.includes(":")) {
      registry = first.toLowerCase();
      repository = rest;
    }
  }

  if (DOCKER_HUB_ALIASES.has(registry)) {
    registry = "registry-1.docker.io";
  }
  validateRegistryHost(registry);

  if (registry === "registry-1.docker.io" && !repository.includes("/")) {
    repository = `library/${repository}`;
  }

  if (repository.length === 0 || repository.length > 255 || !REPO_RE.test(repository)) {
    throw new EvalError(400, "INVALID_REQUEST", `Invalid image repository: ${repository}`);
  }

  const reference = digest || tag || "latest";
  const canonical = digest
    ? `${registry}/${repository}@${digest}`
    : `${registry}/${repository}:${reference}`;

  return { registry, repository, reference, canonical };
}

function normalizeVfsPath(rawPath, fieldName) {
  if (typeof rawPath !== "string") {
    throw new EvalError(400, "INVALID_REQUEST", `${fieldName} must be a string`);
  }
  if (rawPath.includes("\0")) {
    throw new EvalError(400, "INVALID_REQUEST", `${fieldName} must not contain null bytes`);
  }
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return "";
  }
  const withLeading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const collapsed = withLeading.replace(/\/{2,}/g, "/");
  return collapsed.length > 1 && collapsed.endsWith("/") ? collapsed.slice(0, -1) : collapsed;
}

export function parseUserSpec(userStr, { strict = true } = {}) {
  if (userStr === undefined || userStr === null) {
    return { uid: 0, gid: 0 };
  }
  if (typeof userStr !== "string") {
    if (strict) {
      throw new EvalError(400, "INVALID_REQUEST", "user must be a string");
    }
    return { uid: 0, gid: 0 };
  }
  const trimmed = userStr.trim();
  if (trimmed === "" || trimmed === "root" || trimmed === "root:root") {
    return { uid: 0, gid: 0 };
  }
  const parts = trimmed.split(":");
  if (parts.length > 2) {
    if (strict) {
      throw new EvalError(400, "INVALID_REQUEST", `Invalid user specification: ${JSON.stringify(userStr)}`);
    }
    return { uid: 0, gid: 0 };
  }
  const parseId = (token, allowRoot) => {
    if (allowRoot && token === "root") return 0;
    if (!/^\d+$/.test(token)) return null;
    const n = Number(token);
    if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) return null;
    return n;
  };
  const uid = parseId(parts[0], true);
  if (uid === null) {
    if (strict) {
      throw new EvalError(400, "INVALID_REQUEST", `Invalid user specification: ${JSON.stringify(userStr)}`);
    }
    return { uid: 0, gid: 0 };
  }
  let gid = 0;
  if (parts.length === 2 && parts[1] !== "") {
    gid = parseId(parts[1], true);
    if (gid === null) {
      if (strict) {
        throw new EvalError(400, "INVALID_REQUEST", `Invalid group in user specification: ${JSON.stringify(userStr)}`);
      }
      return { uid, gid: 0 };
    }
  }
  return { uid, gid };
}

export function mergeEnvLists(...lists) {
  const entries = [];
  const keyToIdx = new Map();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item !== "string") continue;
      const eq = item.indexOf("=");
      if (eq <= 0) continue;
      const key = item.slice(0, eq);
      if (keyToIdx.has(key)) {
        entries[keyToIdx.get(key)] = item;
      } else {
        keyToIdx.set(key, entries.length);
        entries.push(item);
      }
    }
  }
  return entries;
}

export function wantsGzipResponse(urlOrSearch, acceptHeader = "") {
  let search = "";
  if (urlOrSearch instanceof URL) {
    search = urlOrSearch.search;
  } else if (typeof urlOrSearch === "string") {
    const withoutHash = urlOrSearch.split("#", 1)[0];
    const qIdx = withoutHash.indexOf("?");
    search = qIdx === -1 ? (withoutHash.startsWith("?") ? withoutHash : "") : withoutHash.slice(qIdx);
  }
  if (search) {
    const params = new URLSearchParams(search);
    const fmt = (params.get("format") || "").trim().toLowerCase();
    if (fmt === "tar.gz" || fmt === "tgz" || fmt === "gzip") {
      return true;
    }
  }

  if (typeof acceptHeader === "string" && acceptHeader.trim().length > 0) {
    const mediaRanges = acceptHeader.split(",");
    for (const rawRange of mediaRanges) {
      const parts = rawRange.trim().split(";");
      const mediaType = (parts[0] || "").trim().toLowerCase();
      if (mediaType !== "application/gzip" && mediaType !== "application/x-gzip") {
        continue;
      }
      let q = 1;
      for (let i = 1; i < parts.length; i++) {
        const kv = parts[i].trim().split("=");
        if (kv.length === 2 && kv[0].trim().toLowerCase() === "q") {
          const parsedQ = Number(kv[1].trim());
          if (Number.isFinite(parsedQ)) {
            q = parsedQ;
          }
        }
      }
      if (q > 0) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Parse and strictly validate a `POST /api/eval` request payload.
 */
export function parseAndValidateEvalRequest(rawInput) {
  let obj;
  if (rawInput instanceof Uint8Array) {
    const text = textDecoder.decode(rawInput);
    try {
      obj = JSON.parse(text);
    } catch {
      throw new EvalError(400, "INVALID_REQUEST", "Request body must be valid JSON");
    }
  } else if (typeof rawInput === "string") {
    try {
      obj = JSON.parse(rawInput);
    } catch {
      throw new EvalError(400, "INVALID_REQUEST", "Request body must be valid JSON");
    }
  } else if (rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)) {
    obj = rawInput;
  } else {
    throw new EvalError(400, "INVALID_REQUEST", "Request body must be a JSON object");
  }

  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new EvalError(400, "INVALID_REQUEST", "Request body must be a JSON object");
  }

  // baseImage
  let baseImage = null;
  if (obj.baseImage !== undefined && obj.baseImage !== null && obj.baseImage !== "") {
    if (typeof obj.baseImage !== "string") {
      throw new EvalError(400, "INVALID_REQUEST", "baseImage must be a string");
    }
    baseImage = parseImageRef(obj.baseImage);
  }

  // gitRepo
  let gitRepo = null;
  if (obj.gitRepo !== undefined && obj.gitRepo !== null) {
    if (typeof obj.gitRepo !== "object" || Array.isArray(obj.gitRepo)) {
      throw new EvalError(400, "INVALID_REQUEST", "gitRepo must be an object or null");
    }
    if (typeof obj.gitRepo.repo !== "string" || obj.gitRepo.repo.trim().length === 0) {
      throw new EvalError(400, "INVALID_REQUEST", "gitRepo.repo must be a non-empty string");
    }
    let ref = "HEAD";
    if (obj.gitRepo.ref !== undefined && obj.gitRepo.ref !== null && obj.gitRepo.ref !== "") {
      if (typeof obj.gitRepo.ref !== "string") {
        throw new EvalError(400, "INVALID_REQUEST", "gitRepo.ref must be a string");
      }
      ref = obj.gitRepo.ref.trim() || "HEAD";
    }
    let mountPath = "/workspace";
    if (
      obj.gitRepo.mountPath !== undefined &&
      obj.gitRepo.mountPath !== null &&
      obj.gitRepo.mountPath !== ""
    ) {
      mountPath = normalizeVfsPath(obj.gitRepo.mountPath, "gitRepo.mountPath") || "/workspace";
    }
    gitRepo = { repo: obj.gitRepo.repo.trim(), ref, mountPath };
  }

  // inputLayerDiffs
  const inputLayerDiffs = [];
  if (obj.inputLayerDiffs !== undefined && obj.inputLayerDiffs !== null) {
    if (!Array.isArray(obj.inputLayerDiffs)) {
      throw new EvalError(400, "INVALID_REQUEST", "inputLayerDiffs must be an array of base64 strings");
    }
    if (obj.inputLayerDiffs.length > MAX_INPUT_LAYER_DIFFS) {
      throw new EvalError(
        400,
        "INVALID_REQUEST",
        `inputLayerDiffs exceeds maximum of ${MAX_INPUT_LAYER_DIFFS} entries`
      );
    }
    for (let i = 0; i < obj.inputLayerDiffs.length; i++) {
      const entry = obj.inputLayerDiffs[i];
      const decoded = base64ToUint8Array(entry, `inputLayerDiffs[${i}]`);
      inputLayerDiffs.push(decoded);
    }
  }

  // cmd
  let cmd = null;
  if (obj.cmd !== undefined && obj.cmd !== null) {
    if (!Array.isArray(obj.cmd) || obj.cmd.length === 0) {
      throw new EvalError(400, "INVALID_REQUEST", "cmd must be a non-empty array of strings");
    }
    for (let i = 0; i < obj.cmd.length; i++) {
      if (typeof obj.cmd[i] !== "string") {
        throw new EvalError(400, "INVALID_REQUEST", `cmd[${i}] must be a string`);
      }
    }
    if (obj.cmd[0].length === 0) {
      throw new EvalError(400, "INVALID_REQUEST", "cmd[0] must be a non-empty string");
    }
    cmd = [...obj.cmd];
  }

  // env
  const env = [];
  if (obj.env !== undefined && obj.env !== null) {
    if (!Array.isArray(obj.env)) {
      throw new EvalError(400, "INVALID_REQUEST", "env must be an array of KEY=VALUE strings");
    }
    for (let i = 0; i < obj.env.length; i++) {
      const entry = obj.env[i];
      if (typeof entry !== "string" || entry.indexOf("=") <= 0) {
        throw new EvalError(400, "INVALID_REQUEST", `env[${i}] must be a KEY=VALUE string`);
      }
      env.push(entry);
    }
  }

  // cwd
  let cwd = null;
  if (obj.cwd !== undefined && obj.cwd !== null && obj.cwd !== "") {
    cwd = normalizeVfsPath(obj.cwd, "cwd");
  }

  // user
  let user = null;
  if (obj.user !== undefined && obj.user !== null && obj.user !== "") {
    user = parseUserSpec(obj.user, { strict: true });
  }

  // stdin / stdinBase64
  let stdinBase64 = "";
  if (obj.stdinBase64 !== undefined && obj.stdinBase64 !== null && obj.stdinBase64 !== "") {
    const rawStdin = base64ToUint8Array(obj.stdinBase64, "stdinBase64");
    stdinBase64 = uint8ArrayToBase64(rawStdin);
  } else if (obj.stdin !== undefined && obj.stdin !== null) {
    if (typeof obj.stdin !== "string") {
      throw new EvalError(400, "INVALID_REQUEST", "stdin must be a string");
    }
    if (obj.stdin.length > 0) {
      stdinBase64 = uint8ArrayToBase64(textEncoder.encode(obj.stdin));
    }
  }

  // delayStddevMs
  let delayStddevMs = 0;
  if (obj.delayStddevMs !== undefined && obj.delayStddevMs !== null) {
    if (
      typeof obj.delayStddevMs !== "number" ||
      !Number.isFinite(obj.delayStddevMs) ||
      obj.delayStddevMs < 0
    ) {
      throw new EvalError(400, "INVALID_REQUEST", "delayStddevMs must be a finite number >= 0");
    }
    delayStddevMs = obj.delayStddevMs;
  }

  // delaySeed
  let delaySeed = 0;
  if (obj.delaySeed !== undefined && obj.delaySeed !== null) {
    if (
      typeof obj.delaySeed !== "number" ||
      !Number.isSafeInteger(obj.delaySeed) ||
      obj.delaySeed < 0
    ) {
      throw new EvalError(400, "INVALID_REQUEST", "delaySeed must be a non-negative safe integer");
    }
    delaySeed = obj.delaySeed;
  }

  // timeoutMs
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (obj.timeoutMs !== undefined && obj.timeoutMs !== null) {
    if (typeof obj.timeoutMs !== "number" || !Number.isFinite(obj.timeoutMs) || obj.timeoutMs <= 0) {
      throw new EvalError(400, "INVALID_REQUEST", "timeoutMs must be a positive number");
    }
    timeoutMs = obj.timeoutMs;
  }

  // maxFuel
  let maxFuel = DEFAULT_MAX_FUEL;
  if (obj.maxFuel !== undefined && obj.maxFuel !== null) {
    if (
      typeof obj.maxFuel !== "number" ||
      !Number.isSafeInteger(obj.maxFuel) ||
      obj.maxFuel <= 0
    ) {
      throw new EvalError(400, "INVALID_REQUEST", "maxFuel must be a positive integer");
    }
    maxFuel = Math.min(Math.max(obj.maxFuel, 1), MAX_FUEL_CAP);
  }

  // maxMemoryBytes
  let maxMemoryBytes = DEFAULT_MAX_MEMORY_BYTES;
  if (obj.maxMemoryBytes !== undefined && obj.maxMemoryBytes !== null) {
    if (
      typeof obj.maxMemoryBytes !== "number" ||
      !Number.isSafeInteger(obj.maxMemoryBytes) ||
      obj.maxMemoryBytes <= 0
    ) {
      throw new EvalError(400, "INVALID_REQUEST", "maxMemoryBytes must be a positive integer");
    }
    maxMemoryBytes = Math.min(Math.max(obj.maxMemoryBytes, MIN_MAX_MEMORY_BYTES), MAX_MAX_MEMORY_BYTES);
  }

  // returnOutputDiff
  let returnOutputDiff = true;
  if (obj.returnOutputDiff !== undefined && obj.returnOutputDiff !== null) {
    if (typeof obj.returnOutputDiff !== "boolean") {
      throw new EvalError(400, "INVALID_REQUEST", "returnOutputDiff must be a boolean");
    }
    returnOutputDiff = obj.returnOutputDiff;
  }

  // downloadPath
  let downloadPath = "";
  if (obj.downloadPath !== undefined && obj.downloadPath !== null && obj.downloadPath !== "") {
    downloadPath = normalizeVfsPath(obj.downloadPath, "downloadPath");
  }

  if (!baseImage && inputLayerDiffs.length === 0 && !gitRepo) {
    throw new EvalError(400, "INVALID_REQUEST", "baseImage or inputLayerDiffs is required");
  }

  if (!baseImage && !cmd) {
    throw new EvalError(400, "INVALID_REQUEST", "cmd is required when baseImage is not provided");
  }

  return {
    baseImage,
    gitRepo,
    inputLayerDiffs,
    cmd,
    env,
    cwd,
    user,
    stdinBase64,
    delayStddevMs,
    delaySeed,
    timeoutMs,
    maxFuel,
    maxMemoryBytes,
    returnOutputDiff,
    downloadPath,
  };
}

function selectLinuxAmd64Manifest(manifests) {
  let fallback = null;
  for (const m of manifests) {
    if (!m || typeof m !== "object" || typeof m.digest !== "string") continue;
    if (m.annotations && m.annotations["vnd.docker.reference.type"] === "attestation-manifest") {
      continue;
    }
    const p = m.platform;
    if (p && p.os === "linux" && p.architecture === "amd64") {
      return m;
    }
    if (!fallback && p && p.os === "linux" && !p.architecture) {
      fallback = m;
    }
  }
  return fallback;
}

async function fetchBaseImageLayers(parsedImage, fetchOciResource) {
  if (typeof fetchOciResource !== "function") {
    throw new EvalError(502, "UPSTREAM_ERROR", "OCI fetcher is not configured");
  }

  let currentTarget = parsedImage.reference;
  let manifest = null;

  for (let hop = 0; hop < MAX_MANIFEST_HOPS; hop++) {
    const res = await fetchOciResource({
      registry: parsedImage.registry,
      repository: parsedImage.repository,
      kind: "manifests",
      target: currentTarget,
      accept: DEFAULT_MANIFEST_ACCEPT,
    });
    if (!res || res.status !== 200) {
      throw new EvalError(
        502,
        "UPSTREAM_ERROR",
        `Failed to fetch OCI manifest for ${parsedImage.canonical} (HTTP ${res?.status ?? "error"})`
      );
    }

    let parsed;
    try {
      parsed = JSON.parse(textDecoder.decode(res.bytes));
    } catch {
      throw new EvalError(502, "UPSTREAM_ERROR", `Invalid JSON in OCI manifest for ${parsedImage.canonical}`);
    }
    if (!parsed || typeof parsed !== "object") {
      throw new EvalError(502, "UPSTREAM_ERROR", `Malformed OCI manifest for ${parsedImage.canonical}`);
    }

    if (Array.isArray(parsed.manifests)) {
      const selected = selectLinuxAmd64Manifest(parsed.manifests);
      if (!selected || !DIGEST_RE.test(selected.digest)) {
        throw new EvalError(
          502,
          "UPSTREAM_ERROR",
          `No linux/amd64 manifest found in image index for ${parsedImage.canonical}`
        );
      }
      currentTarget = selected.digest;
      continue;
    }

    manifest = parsed;
    break;
  }

  if (!manifest) {
    throw new EvalError(502, "UPSTREAM_ERROR", `Exceeded manifest resolution hops for ${parsedImage.canonical}`);
  }

  let imageConfig = {};
  if (manifest.config && typeof manifest.config.digest === "string") {
    const cfgRes = await fetchOciResource({
      registry: parsedImage.registry,
      repository: parsedImage.repository,
      kind: "blobs",
      target: manifest.config.digest,
      accept: "*/*",
    });
    if (!cfgRes || cfgRes.status !== 200) {
      throw new EvalError(
        502,
        "UPSTREAM_ERROR",
        `Failed to fetch OCI image config blob (HTTP ${cfgRes?.status ?? "error"})`
      );
    }
    try {
      const cfgDoc = JSON.parse(textDecoder.decode(cfgRes.bytes));
      if (cfgDoc && typeof cfgDoc === "object" && cfgDoc.config && typeof cfgDoc.config === "object") {
        imageConfig = cfgDoc.config;
      }
    } catch {
      throw new EvalError(502, "UPSTREAM_ERROR", "Invalid JSON in OCI image config blob");
    }
  }

  const layers = [];
  const manifestLayers = Array.isArray(manifest.layers) ? manifest.layers : [];
  for (const layerDesc of manifestLayers) {
    if (!layerDesc || typeof layerDesc.digest !== "string") continue;
    const blobRes = await fetchOciResource({
      registry: parsedImage.registry,
      repository: parsedImage.repository,
      kind: "blobs",
      target: layerDesc.digest,
      accept: "*/*",
    });
    if (!blobRes || blobRes.status !== 200) {
      throw new EvalError(
        502,
        "UPSTREAM_ERROR",
        `Failed to fetch OCI layer blob ${layerDesc.digest} (HTTP ${blobRes?.status ?? "error"})`
      );
    }
    const tarBytes = await maybeGunzipBytes(blobRes.bytes, {
      mediaType: layerDesc.mediaType || "",
      maxBytes: DEFAULT_MAX_DECOMPRESSED_BYTES,
      isUpstream: true,
    });
    layers.push(tarBytes);
  }

  return { imageConfig, layers };
}

function getHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") {
    return headers.get(name);
  }
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) {
      return Array.isArray(v) ? v.join(", ") : String(v);
    }
  }
  return null;
}

/**
 * Create a serialized remote evaluation runtime backed by a pre-compiled
 * `elf2wasm_worker_wasm.wasm` `WebAssembly.Module`.
 */
export function createWorkerEvalRuntime(workerWasmModule) {
  let instancePromise = null;
  let queue = Promise.resolve();

  function runSerialized(fn) {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  }

  async function getExports() {
    if (!workerWasmModule) {
      throw new EvalError(502, "UPSTREAM_ERROR", "Worker WASM module is not configured");
    }
    if (!instancePromise) {
      instancePromise = (async () => {
        const instantiated = await WebAssembly.instantiate(workerWasmModule, {});
        const instance =
          instantiated instanceof WebAssembly.Instance ? instantiated : instantiated.instance;
        return instance.exports;
      })();
    }
    try {
      return await instancePromise;
    } catch (err) {
      instancePromise = null;
      throw err;
    }
  }

  function dropInstance() {
    instancePromise = null;
  }

  function allocAndWrite(exports, bytes) {
    const len = bytes.byteLength;
    if (len === 0) return { ptr: 0, len: 0 };
    const ptr = exports.worker_alloc(len) >>> 0;
    if (ptr === 0) {
      throw new EvalError(507, "MEMORY_LIMIT", `WASM worker_alloc(${len}) returned null`);
    }
    new Uint8Array(exports.memory.buffer, ptr, len).set(bytes);
    return { ptr, len };
  }

  function freeBuf(exports, buf) {
    if (buf && buf.ptr !== 0 && buf.len > 0) {
      exports.worker_dealloc(buf.ptr, buf.len);
    }
  }

  function callExtractTar(exports, tarBytes, mountPath, stripComponents, ignoreWhiteouts, isUpstream) {
    const mountBytes = textEncoder.encode(mountPath);
    let tarBuf = null;
    let mountBuf = null;
    try {
      tarBuf = allocAndWrite(exports, tarBytes);
      mountBuf = allocAndWrite(exports, mountBytes);
      const rc = exports.worker_extract_tar(
        tarBuf.ptr,
        tarBuf.len,
        mountBuf.ptr,
        mountBuf.len,
        stripComponents >>> 0,
        ignoreWhiteouts ? 1 : 0
      );
      if (rc < 0) {
        throw new EvalError(
          isUpstream ? 502 : 400,
          isUpstream ? "UPSTREAM_ERROR" : "INVALID_REQUEST",
          `Failed to extract tar archive into ${mountPath} (code ${rc})`
        );
      }
      return rc;
    } finally {
      freeBuf(exports, mountBuf);
      freeBuf(exports, tarBuf);
    }
  }

  function callRunCommand(exports, reqObj) {
    const reqBytes = textEncoder.encode(JSON.stringify(reqObj));
    let reqBuf = null;
    let outLenBuf = null;
    let outPtr = 0;
    let outLen = 0;
    try {
      reqBuf = allocAndWrite(exports, reqBytes);
      outLenBuf = allocAndWrite(exports, new Uint8Array(4));
      outPtr = exports.worker_run_command(reqBuf.ptr, reqBuf.len, outLenBuf.ptr) >>> 0;
      const view = new DataView(exports.memory.buffer);
      outLen = view.getUint32(outLenBuf.ptr, true);
      if (outPtr === 0 || outLen === 0) {
        throw new EvalError(502, "UPSTREAM_ERROR", "worker_run_command returned empty output");
      }
      const copy = new Uint8Array(exports.memory.buffer, outPtr, outLen).slice();
      return JSON.parse(textDecoder.decode(copy));
    } finally {
      if (outPtr !== 0 && outLen > 0) {
        exports.worker_dealloc(outPtr, outLen);
      }
      freeBuf(exports, outLenBuf);
      freeBuf(exports, reqBuf);
    }
  }

  function callExportVfsTar(exports, snapId, pathPrefix) {
    const prefixBytes = pathPrefix ? textEncoder.encode(pathPrefix) : new Uint8Array(0);
    let prefixBuf = null;
    let outLenBuf = null;
    let outPtr = 0;
    let outLen = 0;
    try {
      prefixBuf = allocAndWrite(exports, prefixBytes);
      outLenBuf = allocAndWrite(exports, new Uint8Array(4));
      outPtr =
        exports.worker_export_vfs_tar(
          snapId >>> 0,
          1,
          prefixBuf.ptr,
          prefixBuf.len,
          outLenBuf.ptr
        ) >>> 0;
      const view = new DataView(exports.memory.buffer);
      outLen = view.getUint32(outLenBuf.ptr, true);
      if (outPtr === 0) {
        throw new EvalError(502, "UPSTREAM_ERROR", "worker_export_vfs_tar failed");
      }
      return new Uint8Array(exports.memory.buffer, outPtr, outLen).slice();
    } finally {
      if (outPtr !== 0 && outLen > 0) {
        exports.worker_dealloc(outPtr, outLen);
      }
      freeBuf(exports, outLenBuf);
      freeBuf(exports, prefixBuf);
    }
  }

  function callListVfsDiff(exports, snapId, pathPrefix) {
    const prefixBytes = pathPrefix ? textEncoder.encode(pathPrefix) : new Uint8Array(0);
    let prefixBuf = null;
    let outLenBuf = null;
    let outPtr = 0;
    let outLen = 0;
    try {
      prefixBuf = allocAndWrite(exports, prefixBytes);
      outLenBuf = allocAndWrite(exports, new Uint8Array(4));
      outPtr =
        exports.worker_list_vfs_diff(
          snapId >>> 0,
          1,
          prefixBuf.ptr,
          prefixBuf.len,
          outLenBuf.ptr
        ) >>> 0;
      const view = new DataView(exports.memory.buffer);
      outLen = view.getUint32(outLenBuf.ptr, true);
      if (outPtr === 0) {
        throw new EvalError(502, "UPSTREAM_ERROR", "worker_list_vfs_diff failed");
      }
      const copy = new Uint8Array(exports.memory.buffer, outPtr, outLen).slice();
      return JSON.parse(textDecoder.decode(copy));
    } finally {
      if (outPtr !== 0 && outLen > 0) {
        exports.worker_dealloc(outPtr, outLen);
      }
      freeBuf(exports, outLenBuf);
      freeBuf(exports, prefixBuf);
    }
  }

  /**
   * Evaluate a single container layer deterministically using `elf2wasm_worker_wasm.wasm`.
   */
  async function evaluateLayer(
    rawRequest,
    { fetchOciResource, fetchGitArchive, wantGzip = false } = {}
  ) {
    const req = parseAndValidateEvalRequest(rawRequest);

    // 1. Fetch and decompress external resources (baseImage, gitRepo, inputLayerDiffs)
    //    outside the WASM execution lock.
    let imageConfig = {};
    let baseLayers = [];
    if (req.baseImage) {
      const fetched = await fetchBaseImageLayers(req.baseImage, fetchOciResource);
      imageConfig = fetched.imageConfig;
      baseLayers = fetched.layers;
    }

    let gitArchive = null;
    if (req.gitRepo) {
      if (typeof fetchGitArchive !== "function") {
        throw new EvalError(502, "UPSTREAM_ERROR", "Git archive fetcher is not configured");
      }
      const gitRes = await fetchGitArchive({
        repo: req.gitRepo.repo,
        ref: req.gitRepo.ref,
      });
      if (!gitRes || gitRes.status !== 200) {
        throw new EvalError(
          502,
          "UPSTREAM_ERROR",
          `Failed to fetch git archive for ${req.gitRepo.repo}@${req.gitRepo.ref} (HTTP ${gitRes?.status ?? "error"})`
        );
      }
      const stripComponents = parseStripComponentsHeader(
        getHeader(gitRes.headers, "x-git-strip-components"),
        1
      );
      const tarBytes = await maybeGunzipBytes(gitRes.bytes, {
        mediaType: getHeader(gitRes.headers, "content-type") || "application/gzip",
        maxBytes: DEFAULT_MAX_DECOMPRESSED_BYTES,
        isUpstream: true,
      });
      gitArchive = { tarBytes, mountPath: req.gitRepo.mountPath, stripComponents };
    }

    const inputLayerTars = [];
    for (let i = 0; i < req.inputLayerDiffs.length; i++) {
      const tarBytes = await maybeGunzipBytes(req.inputLayerDiffs[i], {
        maxBytes: DEFAULT_MAX_DECOMPRESSED_BYTES,
        isUpstream: false,
      });
      inputLayerTars.push(tarBytes);
    }

    // 2. Resolve final command, environment, cwd, and user.
    let finalCmd = req.cmd;
    if (!finalCmd) {
      const ep = Array.isArray(imageConfig.Entrypoint) ? imageConfig.Entrypoint : [];
      const icmd = Array.isArray(imageConfig.Cmd) ? imageConfig.Cmd : [];
      finalCmd = [...ep, ...icmd].filter((s) => typeof s === "string" && s.length > 0);
    }
    if (!finalCmd || finalCmd.length === 0) {
      throw new EvalError(
        400,
        "INVALID_REQUEST",
        "No command specified and baseImage has no Entrypoint or Cmd"
      );
    }

    const finalEnv = mergeEnvLists([DEFAULT_PATH_ENV], imageConfig.Env || [], req.env);
    const finalCwd =
      req.cwd ||
      (typeof imageConfig.WorkingDir === "string" && imageConfig.WorkingDir.trim()
        ? imageConfig.WorkingDir.trim()
        : "/");
    const finalUser =
      req.user ??
      (typeof imageConfig.User === "string" && imageConfig.User.trim()
        ? parseUserSpec(imageConfig.User, { strict: false })
        : { uid: 0, gid: 0 });

    const needOutputDiff = req.returnOutputDiff !== false || wantGzip;

    // 3. Execute atomically inside serialized WASM session.
    const execOutcome = await runSerialized(async () => {
      let exports;
      try {
        exports = await getExports();
        exports.worker_reset();

        for (const layerTar of baseLayers) {
          callExtractTar(exports, layerTar, "/", 0, false, true);
        }

        if (gitArchive) {
          callExtractTar(
            exports,
            gitArchive.tarBytes,
            gitArchive.mountPath,
            gitArchive.stripComponents,
            true,
            true
          );
        }

        for (const diffTar of inputLayerTars) {
          callExtractTar(exports, diffTar, "/", 0, false, false);
        }

        const snapId = exports.worker_snapshot_vfs() >>> 0;
        if (snapId === 0) {
          throw new EvalError(502, "UPSTREAM_ERROR", "Failed to snapshot VFS before command execution");
        }

        const resp = callRunCommand(exports, {
          cmd: finalCmd,
          env: finalEnv,
          cwd: finalCwd,
          uid: finalUser.uid,
          gid: finalUser.gid,
          stdinBase64: req.stdinBase64,
          delayStddevMs: req.delayStddevMs,
          delaySeed: req.delaySeed,
          maxFuel: req.maxFuel,
          maxMemoryBytes: req.maxMemoryBytes,
        });

        if (resp && resp.errorCode === "FUEL_EXHAUSTED") {
          throw new EvalError(
            408,
            "FUEL_EXHAUSTED",
            resp.error || "Execution exceeded fuel limit"
          );
        }
        if (resp && resp.errorCode === "MEMORY_LIMIT") {
          throw new EvalError(
            507,
            "MEMORY_LIMIT",
            resp.error || "Execution exceeded memory limit"
          );
        }
        if (resp && resp.errorCode === "INVALID_REQUEST") {
          throw new EvalError(
            400,
            "INVALID_REQUEST",
            resp.error || "Invalid command request"
          );
        }

        let diffTarBytes = null;
        let modifiedFiles = [];
        if (needOutputDiff) {
          diffTarBytes = callExportVfsTar(exports, snapId, req.downloadPath);
          modifiedFiles = callListVfsDiff(exports, snapId, req.downloadPath);
        }

        return { resp, diffTarBytes, modifiedFiles };
      } catch (err) {
        if (err instanceof WebAssembly.RuntimeError) {
          dropInstance();
          if (/memory|out of bounds|oom|allocation/i.test(err.message || "")) {
            throw new EvalError(507, "MEMORY_LIMIT", `WASM runtime memory error: ${err.message}`);
          }
          throw new EvalError(502, "UPSTREAM_ERROR", `WASM runtime trap: ${err.message}`);
        }
        throw err;
      } finally {
        if (exports && instancePromise) {
          try {
            exports.worker_reset();
          } catch {
            dropInstance();
          }
        }
      }
    });

    // 4. Compress output diff tar & decode stdout/stderr outside the lock.
    let outputDiffTarGzBytes = null;
    let outputDiffTarGzBase64 = null;
    if (needOutputDiff && execOutcome.diffTarBytes) {
      outputDiffTarGzBytes = await gzipBytes(execOutcome.diffTarBytes);
      if (!wantGzip) {
        outputDiffTarGzBase64 = uint8ArrayToBase64(outputDiffTarGzBytes);
      }
    }

    const resp = execOutcome.resp || {};
    const stdout = resp.stdoutBase64
      ? textDecoder.decode(base64ToUint8Array(resp.stdoutBase64, "stdoutBase64"))
      : "";
    const stderr = resp.stderrBase64
      ? textDecoder.decode(base64ToUint8Array(resp.stderrBase64, "stderrBase64"))
      : "";

    return {
      ok: Boolean(resp.ok),
      executor: "remote-wasmi",
      exitCode: typeof resp.exitCode === "number" ? resp.exitCode : 0,
      stdout,
      stderr,
      virtualTimeNs: String(resp.virtualTimeNs ?? "0"),
      timedOut: Boolean(resp.timedOut),
      error: resp.error ?? null,
      outputDiffTarGzBytes,
      outputDiffTarGzBase64,
      modifiedFiles: Array.isArray(execOutcome.modifiedFiles) ? execOutcome.modifiedFiles : [],
    };
  }

  return {
    evaluateLayer,
    resetInstance: dropInstance,
  };
}

/**
 * Format the JSON response body for `POST /api/eval` per `PROJECT.md § Interface Contracts #2`.
 */
export function formatEvalJsonResponse(result) {
  return {
    ok: result.ok,
    executor: result.executor,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    virtualTimeNs: result.virtualTimeNs,
    timedOut: result.timedOut,
    error: result.error,
    outputDiffTarGzBase64: result.outputDiffTarGzBase64,
    modifiedFiles: result.modifiedFiles,
  };
}

/**
 * Build standard headers for a direct `.tar.gz` download response from `POST /api/eval`.
 */
export function buildGzipEvalHeaders(result) {
  return {
    "Content-Type": "application/gzip",
    "Content-Disposition": 'attachment; filename="layer-output.tar.gz"',
    "X-Eval-Exit-Code": String(result.exitCode),
    "X-Eval-Virtual-Time-Ns": String(result.virtualTimeNs),
    "Cache-Control": "no-store",
  };
}
