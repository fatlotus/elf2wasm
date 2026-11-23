/**
 * Pure ESM Client-Side OCI Image & Registry Loader (Browser & Node.js compatible).
 *
 * Parses Docker/OCI image references, resolves multi-arch linux/amd64 manifests
 * via a thin streaming OCI v2 proxy, streams and decompresses layer blobs on
 * the client side, and supports offline OCI layout / rootfs tarballs.
 */

import { extractTarToVfs } from "./elf2wasm_shim.mjs";

const textDecoder = new TextDecoder("utf-8", { fatal: false });

export const OCI_MEDIA_TYPES = Object.freeze({
  OCI_INDEX: "application/vnd.oci.image.index.v1+json",
  OCI_MANIFEST: "application/vnd.oci.image.manifest.v1+json",
  OCI_CONFIG: "application/vnd.oci.image.config.v1+json",
  OCI_LAYER_TAR: "application/vnd.oci.image.layer.v1.tar",
  OCI_LAYER_GZIP: "application/vnd.oci.image.layer.v1.tar+gzip",
  OCI_LAYER_ZSTD: "application/vnd.oci.image.layer.v1.tar+zstd",
  DOCKER_INDEX: "application/vnd.docker.distribution.manifest.list.v2+json",
  DOCKER_MANIFEST: "application/vnd.docker.distribution.manifest.v2+json",
  DOCKER_CONFIG: "application/vnd.docker.container.image.v1+json",
  DOCKER_LAYER_GZIP: "application/vnd.docker.image.rootfs.diff.tar.gzip",
});

const MANIFEST_ACCEPT_HEADER = [
  OCI_MEDIA_TYPES.OCI_INDEX,
  OCI_MEDIA_TYPES.DOCKER_INDEX,
  OCI_MEDIA_TYPES.OCI_MANIFEST,
  OCI_MEDIA_TYPES.DOCKER_MANIFEST,
  "*/*;q=0.1",
].join(", ");

const REPO_RE =
  /^[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*)*$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const HOST_PORT_RE =
  /^([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*)(?::([1-9]\d{0,4}))?$/;
const IPV6_BRACKET_RE = /^\[([0-9a-fA-F:.]+)\](?::([1-9]\d{0,4}))?$/;

const DOCKER_HUB_ALIASES = new Set([
  "docker.io",
  "index.docker.io",
  "registry.hub.docker.com",
  "registry-1.docker.io",
]);

function toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new TypeError("Expected Uint8Array, ArrayBuffer, or ArrayBufferView");
}

function validateRegistry(registry) {
  if (!registry || registry.length > 255) {
    throw new Error(`Invalid registry host: ${JSON.stringify(registry)}`);
  }
  let portStr = null;
  const ipv6Match = registry.match(IPV6_BRACKET_RE);
  if (ipv6Match) {
    if (!ipv6Match[1].includes(":")) {
      throw new Error(`Invalid IPv6 registry host: ${registry}`);
    }
    portStr = ipv6Match[2] || null;
  } else {
    const hostMatch = registry.match(HOST_PORT_RE);
    if (!hostMatch) {
      throw new Error(`Invalid registry host: ${registry}`);
    }
    portStr = hostMatch[2] || null;
  }
  if (portStr !== null) {
    const port = Number(portStr);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid registry port in: ${registry}`);
    }
  }
}

/**
 * Parse a Docker/OCI image reference into canonical components.
 *
 * Examples:
 * - "alpine" -> { registry: "registry-1.docker.io", repository: "library/alpine", reference: "latest", canonical: "registry-1.docker.io/library/alpine:latest" }
 * - "127.0.0.1:5000/repo:v1" -> { registry: "127.0.0.1:5000", repository: "repo", reference: "v1", canonical: "127.0.0.1:5000/repo:v1" }
 * - "alpine@sha256:..." -> { registry: "registry-1.docker.io", repository: "library/alpine", reference: "sha256:...", canonical: "registry-1.docker.io/library/alpine@sha256:..." }
 */
export function parseImageRef(ref) {
  if (typeof ref !== "string") {
    throw new Error("Image reference must be a non-empty string");
  }
  const trimmed = ref.trim();
  if (!trimmed) {
    throw new Error("Image reference must be a non-empty string");
  }
  if (/[\x00-\x1f\x7f\s]/.test(trimmed)) {
    throw new Error(`Invalid whitespace or control character in image reference: ${JSON.stringify(ref)}`);
  }
  if (trimmed.includes("://")) {
    throw new Error(`Image reference must not include a URL scheme: ${trimmed}`);
  }
  if (trimmed.includes("\\") || trimmed.includes("..") || trimmed.includes("//")) {
    throw new Error(`Invalid path sequence in image reference: ${trimmed}`);
  }

  let namePart = trimmed;
  let digest = null;

  const atIdx = trimmed.indexOf("@");
  if (atIdx !== -1) {
    namePart = trimmed.slice(0, atIdx);
    digest = trimmed.slice(atIdx + 1);
    if (!DIGEST_RE.test(digest)) {
      throw new Error(`Invalid image digest: ${digest}`);
    }
    if (!namePart) {
      throw new Error(`Missing repository name before digest in: ${trimmed}`);
    }
  }

  let tag = null;
  const lastSlash = namePart.lastIndexOf("/");
  const lastColon = namePart.lastIndexOf(":");
  if (lastColon > lastSlash) {
    tag = namePart.slice(lastColon + 1);
    namePart = namePart.slice(0, lastColon);
    if (!tag || !TAG_RE.test(tag)) {
      throw new Error(`Invalid image tag: ${JSON.stringify(tag)}`);
    }
    if (!namePart) {
      throw new Error(`Missing repository name before tag in: ${trimmed}`);
    }
  }

  let registry = "registry-1.docker.io";
  let repository = namePart;

  const firstSlash = namePart.indexOf("/");
  if (firstSlash !== -1) {
    const first = namePart.slice(0, firstSlash);
    const rest = namePart.slice(firstSlash + 1);
    if (!first || !rest) {
      throw new Error(`Invalid image reference: ${trimmed}`);
    }
    if (first === "localhost" || first.includes(".") || first.includes(":")) {
      registry = first.toLowerCase();
      repository = rest;
    }
  }

  if (DOCKER_HUB_ALIASES.has(registry)) {
    registry = "registry-1.docker.io";
  }
  validateRegistry(registry);

  if (registry === "registry-1.docker.io" && !repository.includes("/")) {
    repository = `library/${repository}`;
  }

  if (repository.length === 0 || repository.length > 255 || !REPO_RE.test(repository)) {
    throw new Error(`Invalid image repository: ${repository}`);
  }

  const reference = digest || tag || "latest";
  const canonical = digest
    ? `${registry}/${repository}@${digest}`
    : `${registry}/${repository}:${reference}`;

  return { registry, repository, reference, canonical };
}

function detectCompression(bytes, mediaType = "") {
  const mt = String(mediaType || "").toLowerCase();
  if (
    (bytes.length >= 4 &&
      bytes[0] === 0x28 &&
      bytes[1] === 0xb5 &&
      bytes[2] === 0x2f &&
      bytes[3] === 0xfd) ||
    mt.includes("zstd")
  ) {
    return "zstd";
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0xfd &&
    bytes[1] === 0x37 &&
    bytes[2] === 0x7a &&
    bytes[3] === 0x58 &&
    bytes[4] === 0x5a &&
    bytes[5] === 0x00
  ) {
    return "xz";
  }
  if (bytes.length >= 3 && bytes[0] === 0x42 && bytes[1] === 0x5a && bytes[2] === 0x68) {
    return "bzip2";
  }
  if (
    (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) ||
    mt.endsWith("+gzip") ||
    mt.endsWith(".gzip")
  ) {
    return "gzip";
  }
  return "none";
}

async function gunzipBytes(input) {
  try {
    if (typeof DecompressionStream !== "undefined") {
      const ds = new DecompressionStream("gzip");
      const writer = ds.writable.getWriter();
      const reader = ds.readable.getReader();
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
            // ignore
          }
          throw err;
        }
      })();

      const readPromise = (async () => {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value && value.length > 0) {
            chunks.push(value);
            total += value.length;
          }
        }
      })();

      await Promise.all([writePromise, readPromise]);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
      }
      return out;
    }

    const zlib = await import("node:zlib");
    return new Uint8Array(zlib.gunzipSync(input));
  } catch (err) {
    const detail =
      err && typeof err.message === "string" && err.message.trim()
        ? err.message.trim()
        : err && err.name && err.name !== "TypeError" && err.name !== "Error"
          ? err.name
          : "corrupt or truncated gzip stream";
    throw new Error(`Failed to decompress gzip layer: ${detail}`, { cause: err });
  }
}

/**
 * Decompress an OCI layer blob (gzip or uncompressed tar).
 * Throws a clear error for unsupported compressions such as zstd, xz, or bzip2.
 */
export async function decompressLayer(bytes, mediaType = "") {
  const u8 = toUint8Array(bytes);
  if (u8.length === 0) return new Uint8Array(0);
  const comp = detectCompression(u8, mediaType);
  if (comp === "zstd" || comp === "xz" || comp === "bzip2") {
    throw new Error(
      `Unsupported OCI layer compression: ${comp} is not supported (expected gzip or uncompressed tar)`
    );
  }
  if (comp === "gzip") {
    return await gunzipBytes(u8);
  }
  return u8;
}

function parsePlatformSpec(platform = "linux/amd64") {
  const parts = String(platform || "linux/amd64").split("/");
  return {
    os: parts[0] || "linux",
    arch: parts[1] || "amd64",
    variant: parts[2] || null,
  };
}

function selectPlatformManifest(indexDoc, platform = "linux/amd64") {
  const target = parsePlatformSpec(platform);
  const manifests = Array.isArray(indexDoc.manifests) ? indexDoc.manifests : [];
  const available = [];

  for (const m of manifests) {
    if (!m || typeof m.digest !== "string") continue;
    if (
      m.annotations &&
      m.annotations["vnd.docker.reference.type"] === "attestation-manifest"
    ) {
      continue;
    }
    const p = m.platform || {};
    if (p.architecture === "unknown" || p.os === "unknown") continue;
    const desc = [p.os || "?", p.architecture || "?", p.variant].filter(Boolean).join("/");
    available.push(desc);

    if (p.os === target.os && p.architecture === target.arch) {
      if (!target.variant || p.variant === target.variant) {
        return m;
      }
    }
  }

  throw new Error(
    `No manifest found for platform ${platform} (available: ${available.join(", ") || "none"})`
  );
}

function normalizeImageConfig(rawConfig) {
  const cfg = (rawConfig && rawConfig.config) || {};
  return {
    entrypoint: Array.isArray(cfg.Entrypoint) ? cfg.Entrypoint.slice() : null,
    cmd: Array.isArray(cfg.Cmd) ? cfg.Cmd.slice() : null,
    env: Array.isArray(cfg.Env) ? cfg.Env.slice() : [],
    workingDir:
      typeof cfg.WorkingDir === "string" && cfg.WorkingDir.length > 0
        ? cfg.WorkingDir
        : "/",
    user: typeof cfg.User === "string" ? cfg.User : "",
    os: (rawConfig && rawConfig.os) || "linux",
    architecture: (rawConfig && rawConfig.architecture) || "amd64",
  };
}

function checkAborted(signal) {
  if (signal && signal.aborted) {
    const err = new Error("Operation aborted");
    err.name = "AbortError";
    throw err;
  }
}

async function readErrorBody(res) {
  try {
    const text = await res.text();
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.error === "string") return parsed.error;
    } catch {
      // ignore non-JSON
    }
    return text.slice(0, 200);
  } catch {
    return "";
  }
}

async function fetchJson(url, { headers, signal, fetchImpl }) {
  checkAborted(signal);
  const res = await fetchImpl(url, { headers, signal });
  if (!res.ok) {
    const detail = await readErrorBody(res);
    throw new Error(
      `Registry request failed (${res.status} ${res.statusText}) for ${url}${detail ? `: ${detail}` : ""}`
    );
  }
  const digest = res.headers.get("docker-content-digest") || null;
  const contentType = res.headers.get("content-type") || "";
  const data = await res.json();
  return { data, digest, contentType };
}

async function fetchStreamedBlob(url, { expectedSize = 0, signal, fetchImpl, onChunk }) {
  checkAborted(signal);
  const res = await fetchImpl(url, { signal });
  if (!res.ok) {
    const detail = await readErrorBody(res);
    throw new Error(
      `Blob download failed (${res.status} ${res.statusText}) for ${url}${detail ? `: ${detail}` : ""}`
    );
  }

  const headerLen = Number(res.headers.get("content-length"));
  const total =
    Number.isFinite(headerLen) && headerLen > 0 ? headerLen : expectedSize || 0;

  if (!res.body || typeof res.body.getReader !== "function") {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (onChunk) onChunk(buf.length, total || buf.length);
    return buf;
  }

  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;

  try {
    while (true) {
      checkAborted(signal);
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        chunks.push(value);
        loaded += value.length;
        if (onChunk) onChunk(loaded, total);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }

  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function buildProxyUrl(base, registry, repository, kind, target) {
  const cleanBase = String(base || "/api/v2").replace(/\/+$/, "");
  // Never encodeURIComponent() repository slashes or sha256: colons!
  return `${cleanBase}/${registry}/${repository}/${kind}/${target}`;
}

/**
 * Pull an OCI/Docker image through the thin streaming OCI v2 proxy.
 */
export async function pullImage(imageRef, options = {}) {
  const parsed = typeof imageRef === "string" ? parseImageRef(imageRef) : imageRef;
  const proxyBase = options.registryProxyBase ?? "/api/v2";
  const platform = options.platform ?? "linux/amd64";
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  const signal = options.signal || null;
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  if (typeof fetchImpl !== "function") {
    throw new Error("Global fetch() is not available");
  }

  const emit = (ev) => {
    if (onProgress) onProgress(ev);
  };

  checkAborted(signal);
  emit({
    stage: "manifest",
    message: `Fetching manifest for ${parsed.canonical}...`,
    layerIndex: 0,
    layerCount: 0,
    loaded: 0,
    total: 0,
  });

  let currentRef = parsed.reference;
  let manifestDoc = null;
  let manifestDigest = parsed.reference.startsWith("sha256:") ? parsed.reference : null;

  for (let depth = 0; depth < 4; depth++) {
    const manifestUrl = buildProxyUrl(
      proxyBase,
      parsed.registry,
      parsed.repository,
      "manifests",
      currentRef
    );
    const { data, digest } = await fetchJson(manifestUrl, {
      headers: { Accept: MANIFEST_ACCEPT_HEADER },
      signal,
      fetchImpl,
    });
    if (digest) manifestDigest = digest;

    if (Array.isArray(data.manifests)) {
      const selected = selectPlatformManifest(data, platform);
      currentRef = selected.digest;
      manifestDigest = selected.digest;
      emit({
        stage: "manifest",
        message: `Resolved ${platform} manifest (${selected.digest.slice(0, 19)}...)`,
        layerIndex: 0,
        layerCount: 0,
        loaded: 0,
        total: 0,
      });
      continue;
    }

    manifestDoc = data;
    break;
  }

  if (!manifestDoc || !manifestDoc.config || !manifestDoc.config.digest || !Array.isArray(manifestDoc.layers)) {
    throw new Error(
      `Unsupported or malformed OCI/Docker manifest for ${parsed.canonical} (schema v2/OCI required)`
    );
  }

  const layerCount = manifestDoc.layers.length;
  emit({
    stage: "config",
    message: `Fetching image config (${manifestDoc.config.digest.slice(0, 19)}...)`,
    layerIndex: 0,
    layerCount,
    loaded: 0,
    total: manifestDoc.config.size || 0,
  });

  const configUrl = buildProxyUrl(
    proxyBase,
    parsed.registry,
    parsed.repository,
    "blobs",
    manifestDoc.config.digest
  );
  const { data: rawConfig } = await fetchJson(configUrl, {
    headers: { Accept: "*/*" },
    signal,
    fetchImpl,
  });
  const config = normalizeImageConfig(rawConfig);

  const targetPlatform = parsePlatformSpec(platform);
  if (
    rawConfig &&
    typeof rawConfig.architecture === "string" &&
    rawConfig.architecture &&
    rawConfig.architecture !== targetPlatform.arch
  ) {
    throw new Error(
      `Image architecture mismatch: expected ${targetPlatform.arch}, got ${rawConfig.architecture}`
    );
  }

  const layers = [];
  for (let i = 0; i < layerCount; i++) {
    checkAborted(signal);
    const desc = manifestDoc.layers[i];
    if (!desc || !desc.digest) {
      throw new Error(`Manifest layer ${i} is missing digest`);
    }
    const blobUrl = buildProxyUrl(
      proxyBase,
      parsed.registry,
      parsed.repository,
      "blobs",
      desc.digest
    );

    emit({
      stage: "download",
      message: `Downloading layer ${i + 1}/${layerCount}...`,
      layerIndex: i,
      layerCount,
      loaded: 0,
      total: desc.size || 0,
    });

    const compressed = await fetchStreamedBlob(blobUrl, {
      expectedSize: desc.size || 0,
      signal,
      fetchImpl,
      onChunk: (loaded, total) => {
        emit({
          stage: "download",
          message: `Downloading layer ${i + 1}/${layerCount}...`,
          layerIndex: i,
          layerCount,
          loaded,
          total,
        });
      },
    });

    checkAborted(signal);
    emit({
      stage: "decompress",
      message: `Decompressing layer ${i + 1}/${layerCount}...`,
      layerIndex: i,
      layerCount,
      loaded: compressed.length,
      total: compressed.length,
    });

    const tarBytes = await decompressLayer(compressed, desc.mediaType);
    layers.push({
      digest: desc.digest,
      mediaType: desc.mediaType || OCI_MEDIA_TYPES.OCI_LAYER_GZIP,
      size: desc.size || compressed.length,
      tarBytes,
    });
  }

  emit({
    stage: "ready",
    message: `Pulled ${parsed.canonical} (${layerCount} layer${layerCount === 1 ? "" : "s"})`,
    layerIndex: layerCount,
    layerCount,
    loaded: layerCount,
    total: layerCount,
  });

  return {
    ref: parsed,
    digest: manifestDigest,
    config,
    layers,
  };
}

function readTarEntryBytes(filesMap, path) {
  const norm = path.startsWith("/") ? path : "/" + path.replace(/^\.\//, "");
  const entry = filesMap.get(norm);
  return entry ? entry.bytes : null;
}

function digestToBlobPath(digest) {
  const idx = digest.indexOf(":");
  if (idx <= 0) {
    throw new Error(`Invalid OCI digest in tarball: ${digest}`);
  }
  const algo = digest.slice(0, idx);
  const hex = digest.slice(idx + 1);
  return `/blobs/${algo}/${hex}`;
}

/**
 * Load an offline OCI Image Layout tarball (oci-layout + index.json + blobs/)
 * or a plain rootfs .tar / .tar.gz tarball.
 */
export async function loadOciTarball(tarBytes, options = {}) {
  const platform = options.platform ?? "linux/amd64";
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  const emit = (ev) => {
    if (onProgress) onProgress(ev);
  };

  emit({
    stage: "decompress",
    message: "Reading offline tarball...",
    layerIndex: 0,
    layerCount: 1,
    loaded: 0,
    total: 0,
  });

  const outerTar = await decompressLayer(toUint8Array(tarBytes));
  const parsedTar = extractTarToVfs(outerTar);
  const files = parsedTar.files;

  const ociLayoutBytes = readTarEntryBytes(files, "/oci-layout");
  const indexBytes = readTarEntryBytes(files, "/index.json");

  if (ociLayoutBytes && indexBytes) {
    const indexDoc = JSON.parse(textDecoder.decode(indexBytes));
    let currentDoc = indexDoc;
    let manifestDigest = null;

    for (let depth = 0; depth < 4; depth++) {
      if (Array.isArray(currentDoc.manifests)) {
        const selected = selectPlatformManifest(currentDoc, platform);
        manifestDigest = selected.digest;
        const nextBytes = readTarEntryBytes(files, digestToBlobPath(selected.digest));
        if (!nextBytes) {
          throw new Error(`Missing manifest blob in OCI tarball: ${selected.digest}`);
        }
        currentDoc = JSON.parse(textDecoder.decode(nextBytes));
        continue;
      }
      break;
    }

    if (!currentDoc.config || !currentDoc.config.digest || !Array.isArray(currentDoc.layers)) {
      throw new Error("Invalid OCI layout tarball: missing config or layers in manifest");
    }

    const configBytes = readTarEntryBytes(files, digestToBlobPath(currentDoc.config.digest));
    if (!configBytes) {
      throw new Error(`Missing config blob in OCI tarball: ${currentDoc.config.digest}`);
    }
    const rawConfig = JSON.parse(textDecoder.decode(configBytes));
    const config = normalizeImageConfig(rawConfig);

    const layers = [];
    const layerCount = currentDoc.layers.length;
    for (let i = 0; i < layerCount; i++) {
      const desc = currentDoc.layers[i];
      const blobBytes = readTarEntryBytes(files, digestToBlobPath(desc.digest));
      if (!blobBytes) {
        throw new Error(`Missing layer blob in OCI tarball: ${desc.digest}`);
      }
      emit({
        stage: "decompress",
        message: `Decompressing tarball layer ${i + 1}/${layerCount}...`,
        layerIndex: i,
        layerCount,
        loaded: blobBytes.length,
        total: blobBytes.length,
      });
      const layerTar = await decompressLayer(blobBytes, desc.mediaType);
      layers.push({
        digest: desc.digest,
        mediaType: desc.mediaType || OCI_MEDIA_TYPES.OCI_LAYER_GZIP,
        size: desc.size || blobBytes.length,
        tarBytes: layerTar,
      });
    }

    const refName = options.name || "local/oci-tarball:latest";
    const ref = parseImageRef(refName);
    emit({
      stage: "ready",
      message: `Loaded OCI tarball (${layerCount} layer${layerCount === 1 ? "" : "s"})`,
      layerIndex: layerCount,
      layerCount,
      loaded: layerCount,
      total: layerCount,
    });
    return { ref, digest: manifestDigest, config, layers };
  }

  // Classic `docker save` manifest.json support
  const dockerManifestBytes = readTarEntryBytes(files, "/manifest.json");
  if (dockerManifestBytes) {
    const arr = JSON.parse(textDecoder.decode(dockerManifestBytes));
    if (Array.isArray(arr) && arr.length > 0 && arr[0].Config && Array.isArray(arr[0].Layers)) {
      const item = arr[0];
      const cfgBytes = readTarEntryBytes(files, item.Config);
      const rawConfig = cfgBytes ? JSON.parse(textDecoder.decode(cfgBytes)) : {};
      const config = normalizeImageConfig(rawConfig);
      const layers = [];
      for (let i = 0; i < item.Layers.length; i++) {
        const lBytes = readTarEntryBytes(files, item.Layers[i]);
        if (!lBytes) throw new Error(`Missing layer in docker-save tarball: ${item.Layers[i]}`);
        const layerTar = await decompressLayer(lBytes);
        layers.push({
          digest: null,
          mediaType: OCI_MEDIA_TYPES.OCI_LAYER_TAR,
          size: lBytes.length,
          tarBytes: layerTar,
        });
      }
      const refName =
        (Array.isArray(item.RepoTags) && item.RepoTags[0]) ||
        options.name ||
        "local/docker-tarball:latest";
      const ref = parseImageRef(refName);
      emit({
        stage: "ready",
        message: `Loaded docker tarball (${layers.length} layers)`,
        layerIndex: layers.length,
        layerCount: layers.length,
        loaded: layers.length,
        total: layers.length,
      });
      return { ref, digest: null, config, layers };
    }
  }

  // Plain rootfs .tar / .tar.gz fallback
  const ref = parseImageRef(options.name || "local/rootfs:latest");
  const config = {
    entrypoint: null,
    cmd: ["/bin/sh"],
    env: ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],
    workingDir: "/",
    user: "",
    os: "linux",
    architecture: "amd64",
  };
  const layers = [
    {
      digest: null,
      mediaType: OCI_MEDIA_TYPES.OCI_LAYER_TAR,
      size: outerTar.length,
      tarBytes: outerTar,
    },
  ];
  emit({
    stage: "ready",
    message: "Loaded rootfs tarball (1 layer)",
    layerIndex: 1,
    layerCount: 1,
    loaded: 1,
    total: 1,
  });
  return { ref, digest: null, config, layers };
}
