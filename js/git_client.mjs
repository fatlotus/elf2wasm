/**
 * Pure ESM client-side Git repository snapshot fetcher (Browser & Node.js compatible).
 *
 * Streams a single `.tar.gz` archive from the thin git snapshot proxy
 * (`GET /api/git/archive?repo=...&ref=...`) and decompresses it client-side
 * using `DecompressionStream("gzip")` (with `node:zlib` fallback via `oci_client.mjs`).
 */

import { OCI_MEDIA_TYPES, decompressLayer } from "./oci_client.mjs";

function checkAborted(signal) {
  if (signal && signal.aborted) {
    const err = new Error("Operation aborted");
    err.name = "AbortError";
    throw err;
  }
}

const RETRYABLE_SOCKET_CODES = new Set([
  "UND_ERR_SOCKET",
  "ECONNRESET",
  "EPIPE",
  "ECONNABORTED",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function extractErrorCodes(err) {
  const codes = new Set();
  if (err && typeof err.code === "string" && err.code) {
    codes.add(err.code);
  }
  const cause = err && err.cause;
  if (cause && typeof cause.code === "string" && cause.code) {
    codes.add(cause.code);
  }
  if (cause && Array.isArray(cause.errors)) {
    for (const sub of cause.errors) {
      if (sub && typeof sub.code === "string" && sub.code) {
        codes.add(sub.code);
      }
    }
  }
  return [...codes];
}

function isRetryableFetchError(err, signal) {
  if (!err) return false;
  if (signal && signal.aborted) return false;
  if (err.name === "AbortError") return false;
  if (!(err instanceof TypeError)) return false;
  const codes = extractErrorCodes(err);
  if (codes.length > 0) {
    return codes.some((code) => RETRYABLE_SOCKET_CODES.has(code));
  }
  return true;
}

function formatFetchCause(err) {
  const cause = err && err.cause;
  const parts = [];
  const codes = extractErrorCodes(err);
  if (codes.length > 0) parts.push(codes.join(", "));
  if (cause && typeof cause.message === "string" && cause.message.trim()) {
    parts.push(cause.message.trim());
  }
  return parts.join(": ");
}

async function readErrorDetail(res) {
  try {
    const text = await res.text();
    if (!text) return "";
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.error === "string") return parsed.error;
    } catch {
      // ignore non-JSON body
    }
    return text.slice(0, 200);
  } catch {
    return "";
  }
}

function parseStripComponentsHeader(value) {
  if (typeof value !== "string") return 1;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return 1;
  const num = Number(trimmed);
  if (!Number.isInteger(num) || num < 0 || num > 16) return 1;
  return num;
}

/**
 * Fetches and decompresses a git repository snapshot as a raw `.tar` byte buffer.
 *
 * @param {object} options
 * @param {string} options.repo - Repository identifier (e.g. `owner/repo` or forge URL).
 * @param {string} [options.ref="HEAD"] - Commit SHA, branch, or tag.
 * @param {string} [options.gitProxyBase="/api/git/archive"] - Backend git archive proxy URL.
 * @param {(event: object) => void} [options.onProgress] - Progress callback.
 * @param {AbortSignal} [options.signal] - Optional abort signal.
 * @param {typeof fetch} [options.fetchImpl] - Optional custom fetch implementation.
 * @returns {Promise<{ tarBytes: Uint8Array, stripComponents: number, repo: string, ref: string }>}
 */
export async function fetchGitArchive({
  repo,
  ref = "HEAD",
  gitProxyBase = "/api/git/archive",
  onProgress,
  signal,
  fetchImpl,
} = {}) {
  const trimmedRepo = typeof repo === "string" ? repo.trim() : "";
  if (!trimmedRepo) {
    throw new Error("Repository identifier must be a non-empty string");
  }
  const normalizedRef =
    typeof ref === "string" && ref.trim().length > 0 ? ref.trim() : "HEAD";

  const fetchFn = fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new Error("Global fetch() is not available");
  }

  checkAborted(signal);

  const cleanBase = String(gitProxyBase || "/api/git/archive").replace(/\/+$/, "");
  const params = new URLSearchParams();
  params.set("repo", trimmedRepo);
  params.set("ref", normalizedRef);
  const sep = cleanBase.includes("?") ? "&" : "?";
  const url = `${cleanBase}${sep}${params.toString()}`;

  const emit = (ev) => {
    if (typeof onProgress === "function") {
      try {
        onProgress(ev);
      } catch {
        // ignore user progress callback errors
      }
    }
  };

  emit({
    stage: "git-download",
    message: `Downloading git repo ${trimmedRepo}@${normalizedRef}...`,
    layerIndex: 0,
    layerCount: 1,
    loaded: 0,
    total: 0,
  });

  let res;
  const maxAttempts = 2;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    checkAborted(signal);
    try {
      res = await fetchFn(url, signal ? { signal } : undefined);
      break;
    } catch (err) {
      if (signal && signal.aborted) {
        checkAborted(signal);
      }
      if (err && err.name === "AbortError") {
        throw err;
      }
      if (attempt + 1 < maxAttempts && isRetryableFetchError(err, signal)) {
        // Yield one macrotask so pending socket close/FIN events are drained before retrying.
        await new Promise((resolve) => setTimeout(resolve, 0));
        checkAborted(signal);
        continue;
      }
      const msg = err && err.message ? err.message : String(err);
      const causeDetail = formatFetchCause(err);
      throw new Error(
        `Git archive fetch failed for ${trimmedRepo}@${normalizedRef}: ${msg}${causeDetail ? ` (${causeDetail})` : ""}`,
        { cause: err }
      );
    }
  }
  if (!res.ok) {
    const detail = await readErrorDetail(res);
    throw new Error(
      `Git archive download failed (${res.status} ${res.statusText}) for ${trimmedRepo}@${normalizedRef}${detail ? `: ${detail}` : ""}`
    );
  }

  const stripComponents = parseStripComponentsHeader(
    res.headers.get("x-git-strip-components")
  );
  const archiveFormat = (res.headers.get("x-git-archive-format") || "").toLowerCase();
  const headerLen = Number(res.headers.get("content-length"));
  const total = Number.isFinite(headerLen) && headerLen > 0 ? headerLen : 0;

  let compressed;
  if (res.body && typeof res.body.getReader === "function") {
    const reader = res.body.getReader();
    const chunks = [];
    let loaded = 0;
    try {
      while (true) {
        checkAborted(signal);
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        chunks.push(chunk);
        loaded += chunk.length;
        emit({
          stage: "git-download",
          message: `Downloading git repo ${trimmedRepo}@${normalizedRef}...`,
          layerIndex: 0,
          layerCount: 1,
          loaded,
          total,
        });
      }
    } finally {
      reader.releaseLock();
    }
    compressed = new Uint8Array(loaded);
    let offset = 0;
    for (const c of chunks) {
      compressed.set(c, offset);
      offset += c.length;
    }
  } else {
    checkAborted(signal);
    compressed = new Uint8Array(await res.arrayBuffer());
    emit({
      stage: "git-download",
      message: `Downloading git repo ${trimmedRepo}@${normalizedRef}...`,
      layerIndex: 0,
      layerCount: 1,
      loaded: compressed.length,
      total: total || compressed.length,
    });
  }

  checkAborted(signal);

  emit({
    stage: "git-decompress",
    message: `Decompressing git repo ${trimmedRepo}@${normalizedRef}...`,
    layerIndex: 0,
    layerCount: 1,
    loaded: compressed.length,
    total: compressed.length,
  });

  const isGzipMagic =
    compressed.length >= 2 && compressed[0] === 0x1f && compressed[1] === 0x8b;
  const mediaType =
    archiveFormat.includes("gz") || isGzipMagic ? OCI_MEDIA_TYPES.OCI_LAYER_GZIP : "";

  let tarBytes;
  try {
    tarBytes = await decompressLayer(compressed, mediaType);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    throw new Error(
      `Failed to decompress git archive for ${trimmedRepo}@${normalizedRef}: ${msg}`,
      { cause: err }
    );
  }

  checkAborted(signal);

  return {
    tarBytes,
    stripComponents,
    repo: trimmedRepo,
    ref: normalizedRef,
  };
}
