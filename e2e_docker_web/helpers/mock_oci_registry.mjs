// Self-contained opaque-box dual-origin mock OCI v2 registry & deterministic fixture builder.
// Zero external dependencies (Node.js 22 built-ins only).

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { createTar, createTarGz, parseTarEntries } from "./tar_builder.mjs";

const DEFAULT_CACHE_DIR = "/tmp/elf2wasm-e2e-cache";

const MEDIA_OCI_INDEX = "application/vnd.oci.image.index.v1+json";
const MEDIA_OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const MEDIA_OCI_CONFIG = "application/vnd.oci.image.config.v1+json";
const MEDIA_OCI_LAYER_GZIP = "application/vnd.oci.image.layer.v1.tar+gzip";

const MEDIA_DOCKER_LIST = "application/vnd.docker.distribution.manifest.list.v2+json";
const MEDIA_DOCKER_MANIFEST = "application/vnd.docker.distribution.manifest.v2+json";
const MEDIA_DOCKER_CONFIG = "application/vnd.docker.container.image.v1+json";
const MEDIA_DOCKER_LAYER_GZIP = "application/vnd.docker.image.rootfs.diff.tar.gzip";

function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function sha256Digest(bytes) {
  return `sha256:${sha256Hex(bytes)}`;
}

function isGzip(bytes) {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function sanitizeName(imageName) {
  return imageName.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function atomicWriteFile(filePath, data) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, data);
  fs.renameSync(tmpPath, filePath);
}

/**
 * Lazily extract a real linux/amd64 Docker image (e.g. "alpine:latest", "busybox:musl")
 * from local Docker into `/tmp/elf2wasm-e2e-cache/` so repeat runs take <5ms.
 */
export function loadDockerBaseImage(imageName, cacheDir = DEFAULT_CACHE_DIR) {
  const dir = path.join(cacheDir, sanitizeName(imageName));
  const metaPath = path.join(dir, "meta.json");
  const configPath = path.join(dir, "config.json");
  const layerPath = path.join(dir, "layer0.tar.gz");

  if (fs.existsSync(metaPath) && fs.existsSync(configPath) && fs.existsSync(layerPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      const configBytes = new Uint8Array(fs.readFileSync(configPath));
      const gzBytes = new Uint8Array(fs.readFileSync(layerPath));
      if (
        meta &&
        meta.layerDigest === sha256Digest(gzBytes) &&
        meta.configDigest === sha256Digest(configBytes) &&
        isGzip(gzBytes)
      ) {
        return {
          configJson: JSON.parse(Buffer.from(configBytes).toString("utf8")),
          configBytes,
          layer: {
            gzBytes,
            digest: meta.layerDigest,
            diffId: meta.layerDiffId,
            size: gzBytes.length,
          },
        };
      }
    } catch {
      // Fall through and rebuild cache
    }
  }

  fs.mkdirSync(dir, { recursive: true });
  const tmpTar = path.join(os.tmpdir(), `elf2wasm-save-${sanitizeName(imageName)}-${process.pid}-${Date.now()}.tar`);

  try {
    try {
      execFileSync("docker", ["save", "-o", tmpTar, imageName], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60000,
      });
    } catch {
      execFileSync("docker", ["pull", "--platform", "linux/amd64", imageName], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120000,
      });
      execFileSync("docker", ["save", "-o", tmpTar, imageName], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60000,
      });
    }

    const tarBuf = fs.readFileSync(tmpTar);
    const entries = parseTarEntries(tarBuf);
    const byName = new Map();
    for (const e of entries) {
      byName.set(e.name.replace(/^\.\//, ""), e);
    }

    const manifestEntry = byName.get("manifest.json");
    if (!manifestEntry) {
      throw new Error(`docker save ${imageName} did not contain manifest.json`);
    }
    const manifestList = JSON.parse(Buffer.from(manifestEntry.data).toString("utf8"));
    const first = manifestList[0];
    if (!first || !first.Config || !first.Layers || first.Layers.length === 0) {
      throw new Error(`Unexpected manifest.json structure for ${imageName}`);
    }

    const cfgEntry = byName.get(first.Config.replace(/^\.\//, ""));
    const layerEntry = byName.get(first.Layers[0].replace(/^\.\//, ""));
    if (!cfgEntry || !layerEntry) {
      throw new Error(`Missing config or layer blob in docker save archive for ${imageName}`);
    }

    const configBytes = cfgEntry.data;
    const rawLayer = layerEntry.data;
    let gzBytes;
    let tarBytes;
    if (isGzip(rawLayer)) {
      gzBytes = rawLayer;
      const gunzipped = zlib.gunzipSync(rawLayer);
      tarBytes = new Uint8Array(gunzipped.buffer, gunzipped.byteOffset, gunzipped.byteLength);
    } else {
      tarBytes = rawLayer;
      const gzipped = zlib.gzipSync(rawLayer, { level: 6 });
      gzBytes = new Uint8Array(gzipped.buffer, gzipped.byteOffset, gzipped.byteLength);
    }

    const configDigest = sha256Digest(configBytes);
    const layerDigest = sha256Digest(gzBytes);
    const layerDiffId = sha256Digest(tarBytes);

    atomicWriteFile(configPath, configBytes);
    atomicWriteFile(layerPath, gzBytes);
    atomicWriteFile(
      metaPath,
      JSON.stringify({ imageName, configDigest, layerDigest, layerDiffId }, null, 2)
    );

    return {
      configJson: JSON.parse(Buffer.from(configBytes).toString("utf8")),
      configBytes,
      layer: {
        gzBytes,
        digest: layerDigest,
        diffId: layerDiffId,
        size: gzBytes.length,
      },
    };
  } finally {
    try {
      fs.rmSync(tmpTar, { force: true });
    } catch {
      // ignore
    }
  }
}

/**
 * Build a complete OCI or Docker v2 image record (manifests + config + layer blobs).
 */
export function buildOciImage({
  config,
  layers,
  multiArch = true,
  dockerV2 = false,
}) {
  const indexMediaType = dockerV2 ? MEDIA_DOCKER_LIST : MEDIA_OCI_INDEX;
  const manifestMediaType = dockerV2 ? MEDIA_DOCKER_MANIFEST : MEDIA_OCI_MANIFEST;
  const configMediaType = dockerV2 ? MEDIA_DOCKER_CONFIG : MEDIA_OCI_CONFIG;
  const layerMediaType = dockerV2 ? MEDIA_DOCKER_LAYER_GZIP : MEDIA_OCI_LAYER_GZIP;

  const fullConfig = {
    architecture: "amd64",
    os: "linux",
    config: {
      Env: config.Env || ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],
      ...(config.Entrypoint !== undefined ? { Entrypoint: config.Entrypoint } : {}),
      ...(config.Cmd !== undefined ? { Cmd: config.Cmd } : {}),
      ...(config.WorkingDir !== undefined ? { WorkingDir: config.WorkingDir } : {}),
      ...(config.User !== undefined ? { User: config.User } : {}),
    },
    rootfs: {
      type: "layers",
      diff_ids: layers.map((l) => l.diffId),
    },
  };

  const configBytes = new Uint8Array(Buffer.from(JSON.stringify(fullConfig), "utf8"));
  const configDigest = sha256Digest(configBytes);

  const amd64ManifestObj = {
    schemaVersion: 2,
    mediaType: manifestMediaType,
    config: {
      mediaType: configMediaType,
      digest: configDigest,
      size: configBytes.length,
    },
    layers: layers.map((l) => ({
      mediaType: layerMediaType,
      digest: l.digest,
      size: l.gzBytes.length,
    })),
  };
  const amd64ManifestBytes = new Uint8Array(Buffer.from(JSON.stringify(amd64ManifestObj), "utf8"));
  const amd64ManifestDigest = sha256Digest(amd64ManifestBytes);

  const manifestsByDigest = new Map();
  manifestsByDigest.set(amd64ManifestDigest, {
    bytes: amd64ManifestBytes,
    mediaType: manifestMediaType,
    digest: amd64ManifestDigest,
  });

  const blobsByDigest = new Map();
  blobsByDigest.set(configDigest, {
    bytes: configBytes,
    mediaType: configMediaType,
    digest: configDigest,
  });
  for (const l of layers) {
    blobsByDigest.set(l.digest, {
      bytes: l.gzBytes,
      mediaType: layerMediaType,
      digest: l.digest,
    });
  }

  let rootManifest;
  if (multiArch) {
    // Place linux/arm64 and unknown/unknown attestation BEFORE linux/amd64
    const dummyArm64 = new Uint8Array(Buffer.from(JSON.stringify({
      schemaVersion: 2,
      mediaType: manifestMediaType,
      config: { mediaType: configMediaType, digest: configDigest, size: configBytes.length },
      layers: [],
    }), "utf8"));
    const dummyArm64Digest = sha256Digest(dummyArm64);
    manifestsByDigest.set(dummyArm64Digest, {
      bytes: dummyArm64,
      mediaType: manifestMediaType,
      digest: dummyArm64Digest,
    });

    const dummyAttest = new Uint8Array(Buffer.from(JSON.stringify({
      schemaVersion: 2,
      mediaType: MEDIA_OCI_MANIFEST,
      config: { mediaType: MEDIA_OCI_CONFIG, digest: configDigest, size: configBytes.length },
      layers: [],
    }), "utf8"));
    const dummyAttestDigest = sha256Digest(dummyAttest);
    manifestsByDigest.set(dummyAttestDigest, {
      bytes: dummyAttest,
      mediaType: MEDIA_OCI_MANIFEST,
      digest: dummyAttestDigest,
    });

    const indexObj = {
      schemaVersion: 2,
      mediaType: indexMediaType,
      manifests: [
        {
          mediaType: manifestMediaType,
          digest: dummyArm64Digest,
          size: dummyArm64.length,
          platform: { architecture: "arm64", os: "linux" },
        },
        {
          mediaType: MEDIA_OCI_MANIFEST,
          digest: dummyAttestDigest,
          size: dummyAttest.length,
          platform: { architecture: "unknown", os: "unknown" },
          annotations: { "vnd.docker.reference.type": "attestation-manifest" },
        },
        {
          mediaType: manifestMediaType,
          digest: amd64ManifestDigest,
          size: amd64ManifestBytes.length,
          platform: { architecture: "amd64", os: "linux" },
        },
      ],
    };
    const indexBytes = new Uint8Array(Buffer.from(JSON.stringify(indexObj), "utf8"));
    const indexDigest = sha256Digest(indexBytes);
    rootManifest = {
      bytes: indexBytes,
      mediaType: indexMediaType,
      digest: indexDigest,
    };
    manifestsByDigest.set(indexDigest, rootManifest);
  } else {
    rootManifest = {
      bytes: amd64ManifestBytes,
      mediaType: manifestMediaType,
      digest: amd64ManifestDigest,
    };
  }

  return {
    rootManifest,
    amd64Manifest: {
      bytes: amd64ManifestBytes,
      mediaType: manifestMediaType,
      digest: amd64ManifestDigest,
    },
    configDigest,
    configBytes,
    layers,
    manifestsByDigest,
    blobsByDigest,
  };
}

function buildBuiltinFixtures(cacheDir, selectedFixtures) {
  const want = new Set(selectedFixtures || ["alpine", "layered", "combo", "busybox", "app_v2"]);
  const images = new Map();

  let alpineBase = null;
  if (want.has("alpine") || want.has("layered") || want.has("combo") || want.has("app_v2")) {
    alpineBase = loadDockerBaseImage("alpine:latest", cacheDir);
  }

  if (want.has("alpine") && alpineBase) {
    const alpineCfg = alpineBase.configJson.config || {};
    const baseOpts = {
      config: {
        Env: alpineCfg.Env || ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],
        Cmd: alpineCfg.Cmd || ["/bin/sh"],
        WorkingDir: alpineCfg.WorkingDir || "/",
      },
      layers: [alpineBase.layer],
    };
    images.set("library/alpine:latest", buildOciImage({ ...baseOpts, multiArch: true, dockerV2: false }));
    images.set("direct/alpine:latest", buildOciImage({ ...baseOpts, multiArch: false, dockerV2: false }));
    images.set("docker-v2/alpine:latest", buildOciImage({ ...baseOpts, multiArch: true, dockerV2: true }));
  }

  if (want.has("layered") && alpineBase) {
    const layer1 = createTarGz([
      { path: "app/", type: "dir", mode: 0o755 },
      { path: "app/empty_dir/", type: "dir", mode: 0o755 },
      { path: "var/empty_dir/", type: "dir", mode: 0o755 },
      { path: "opt/nested/empty/", type: "dir", mode: 0o755 },
      { path: "app/keep.txt", type: "file", content: "layer1-keep\n", mode: 0o644 },
      { path: "app/update.txt", type: "file", content: "version-1\n", mode: 0o644 },
      { path: "app/delete_me.txt", type: "file", content: "must-be-deleted\n", mode: 0o644 },
      { path: "app/opaque_dir/", type: "dir", mode: 0o755 },
      { path: "app/opaque_dir/old_a.txt", type: "file", content: "old-a\n", mode: 0o644 },
      { path: "app/opaque_dir/old_b.txt", type: "file", content: "old-b\n", mode: 0o644 },
      { path: "app/symlink_keep", type: "symlink", linkname: "/app/keep.txt" },
      { path: "app/hardlink_keep", type: "hardlink", linkname: "app/keep.txt" },
      { path: "app/shebang.sh", type: "file", content: "#!/bin/sh\necho SHEBANG_OK:$1:$APP_MODE\n", mode: 0o755 },
      { path: "app/not_elf.bin", type: "file", content: "plain text not an ELF binary\n", mode: 0o755 },
      { path: "app/no_exec.sh", type: "file", content: "#!/bin/sh\necho SHOULD_NOT_RUN\n", mode: 0o644 },
    ]);
    const layer2 = createTarGz([
      { path: "app/.wh.delete_me.txt", type: "file", content: "", mode: 0o644 },
      { path: "app/opaque_dir/.wh..wh..opq", type: "file", content: "", mode: 0o644 },
      { path: "app/opaque_dir/new_c.txt", type: "file", content: "new-c\n", mode: 0o644 },
      { path: "app/update.txt", type: "file", content: "version-2\n", mode: 0o644 },
    ]);
    images.set("custom/layered:v1", buildOciImage({
      config: {
        Env: [
          "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          "APP_MODE=layered-v1",
          "CUSTOM_VAR=hello_oci",
        ],
        WorkingDir: "/app",
        Entrypoint: ["/bin/sh", "-c"],
        Cmd: ["pwd && echo $APP_MODE:$CUSTOM_VAR"],
        User: "0:0",
      },
      layers: [alpineBase.layer, layer1, layer2],
      multiArch: true,
    }));
  }

  if (want.has("combo") && alpineBase) {
    const layer1 = createTarGz([
      { path: "opt/app/", type: "dir", mode: 0o755 },
      { path: "opt/app/bin/", type: "dir", mode: 0o755 },
      { path: "usr/local/bin/", type: "dir", mode: 0o755 },
      {
        path: "opt/app/bin/tool.sh",
        type: "file",
        content: "#!/bin/sh\necho \"TOOL_OK:$(pwd):$APP_MODE:$(cat /opt/app/data.txt)\"\n",
        mode: 0o755,
      },
      { path: "usr/local/bin/mytool", type: "symlink", linkname: "/opt/app/bin/tool.sh" },
      { path: "opt/app/stale.txt", type: "file", content: "stale-content\n", mode: 0o644 },
    ]);
    const layer2 = createTarGz([
      { path: "opt/app/.wh.stale.txt", type: "file", content: "", mode: 0o644 },
      { path: "opt/app/data.txt", type: "file", content: "COMBO_DATA_99", mode: 0o644 },
    ]);
    images.set("custom/combo:v1", buildOciImage({
      config: {
        Env: [
          "APP_MODE=prod",
          "PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        ],
        WorkingDir: "/opt/app",
        Cmd: ["/bin/sh"],
        User: "0:0",
      },
      layers: [alpineBase.layer, layer1, layer2],
      multiArch: true,
    }));
  }

  if (want.has("busybox")) {
    const busyboxBase = loadDockerBaseImage("busybox:musl", cacheDir);
    const bbCfg = busyboxBase.configJson.config || {};
    images.set("library/busybox:musl", buildOciImage({
      config: {
        Env: bbCfg.Env || ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],
        Cmd: bbCfg.Cmd || ["sh"],
      },
      layers: [busyboxBase.layer],
      multiArch: true,
    }));
  }

  if (want.has("app_v2") && alpineBase) {
    const appLayer = createTarGz([
      { path: "srv/", type: "dir", mode: 0o755 },
      { path: "srv/marker.txt", type: "file", content: "MARKER_V2\n", mode: 0o644 },
      { path: "etc/second_image_id", type: "file", content: "SECOND_IMAGE_APP_V2\n", mode: 0o644 },
    ]);
    images.set("custom/app:v2", buildOciImage({
      config: {
        Env: [
          "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          "IMAGE_ID=app-v2",
        ],
        WorkingDir: "/srv",
        Cmd: ["/bin/sh"],
        User: "0:0",
      },
      layers: [alpineBase.layer, appLayer],
      multiArch: true,
    }));
  }

  return images;
}

function listenServer(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(addr.port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

/**
 * Start a dual-origin mock OCI v2 registry on ephemeral localhost ports.
 * @param {{ requireAuth?: boolean, redirectBlobs?: boolean, fixtures?: string[], cacheDir?: string }} [opts]
 */
export async function startMockOciRegistry(opts = {}) {
  const {
    requireAuth = true,
    redirectBlobs = true,
    fixtures = undefined,
    cacheDir = DEFAULT_CACHE_DIR,
  } = opts;

  const images = buildBuiltinFixtures(cacheDir, fixtures);
  const allBlobs = new Map();
  const allManifestsByRepo = new Map();

  function indexImage(repo, tag, img) {
    images.set(`${repo}:${tag}`, img);
    if (!allManifestsByRepo.has(repo)) {
      allManifestsByRepo.set(repo, new Map());
    }
    const repoManifests = allManifestsByRepo.get(repo);
    repoManifests.set(tag, img.rootManifest);
    for (const [digest, entry] of img.manifestsByDigest.entries()) {
      repoManifests.set(digest, entry);
    }
    for (const [digest, entry] of img.blobsByDigest.entries()) {
      allBlobs.set(digest, entry);
    }
  }

  for (const [key, img] of images.entries()) {
    const idx = key.lastIndexOf(":");
    const repo = key.slice(0, idx);
    const tag = key.slice(idx + 1);
    indexImage(repo, tag, img);
  }

  const validTokens = new Map(); // token -> scope
  const requests = [];
  let leakedAuthCounter = 0;

  let regPort = 0;
  let blobPort = 0;

  // Separate-port Blob CDN server that strictly rejects Authorization headers
  const blobServer = http.createServer((req, res) => {
    const urlObj = new URL(req.url || "/", `http://127.0.0.1:${blobPort}`);
    const hasAuth = Boolean(req.headers.authorization);

    const match = urlObj.pathname.match(/^\/blobs\/(sha256:[0-9a-f]{64})$/);
    if (hasAuth) {
      leakedAuthCounter += 1;
      requests.push({
        server: "blob",
        method: req.method,
        path: urlObj.pathname,
        query: urlObj.search,
        status: 400,
        hasAuth: true,
        leakedAuth: true,
        timestamp: Date.now(),
      });
      const body = JSON.stringify({ error: "Authorization header leaked to cross-origin blob storage" });
      res.writeHead(400, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }

    if (!match) {
      requests.push({
        server: "blob",
        method: req.method,
        path: urlObj.pathname,
        query: urlObj.search,
        status: 404,
        hasAuth: false,
        leakedAuth: false,
        timestamp: Date.now(),
      });
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(req.method === "HEAD" ? undefined : JSON.stringify({ error: "blob not found" }));
      return;
    }

    const blob = allBlobs.get(match[1]);
    if (!blob) {
      requests.push({
        server: "blob",
        method: req.method,
        path: urlObj.pathname,
        query: urlObj.search,
        status: 404,
        hasAuth: false,
        leakedAuth: false,
        timestamp: Date.now(),
      });
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(req.method === "HEAD" ? undefined : JSON.stringify({ error: "blob not found" }));
      return;
    }

    requests.push({
      server: "blob",
      method: req.method,
      path: urlObj.pathname,
      query: urlObj.search,
      status: 200,
      hasAuth: false,
      leakedAuth: false,
      timestamp: Date.now(),
    });
    res.writeHead(200, {
      "Content-Type": blob.mediaType || "application/octet-stream",
      "Content-Length": String(blob.bytes.length),
      "Docker-Content-Digest": blob.digest,
    });
    res.end(req.method === "HEAD" ? undefined : Buffer.from(blob.bytes));
  });

  function checkBearerAuth(req, res, scope, pathname, search) {
    if (!requireAuth) return true;
    const authHeader = req.headers.authorization || "";
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    const grantedScope = match ? validTokens.get(match[1].trim()) : null;
    if (grantedScope && grantedScope === scope) {
      return true;
    }
    const challenge = `Bearer realm="http://127.0.0.1:${regPort}/token",service="mock-registry",scope="${scope}"`;
    requests.push({
      server: "registry",
      method: req.method,
      path: pathname,
      query: search,
      status: 401,
      hasAuth: Boolean(authHeader),
      leakedAuth: false,
      timestamp: Date.now(),
    });
    const body = JSON.stringify({
      errors: [{ code: "UNAUTHORIZED", message: "authentication required" }],
    });
    res.writeHead(401, {
      "WWW-Authenticate": challenge,
      "Docker-Distribution-Api-Version": "registry/2.0",
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body)),
    });
    res.end(req.method === "HEAD" ? undefined : body);
    return false;
  }

  // Primary OCI v2 Registry server
  const registryServer = http.createServer((req, res) => {
    const urlObj = new URL(req.url || "/", `http://127.0.0.1:${regPort}`);
    const pathname = urlObj.pathname;
    const search = urlObj.search;
    const hasAuth = Boolean(req.headers.authorization);

    const record = (status) => {
      requests.push({
        server: "registry",
        method: req.method,
        path: pathname,
        query: search,
        status,
        hasAuth,
        leakedAuth: false,
        timestamp: Date.now(),
      });
    };

    // Bearer token endpoint
    if (pathname === "/token") {
      const scope = urlObj.searchParams.get("scope") || "registry:catalog:*";
      const token = `mocktok_${crypto.randomBytes(12).toString("hex")}`;
      validTokens.set(token, scope);
      const body = JSON.stringify({
        token,
        access_token: token,
        expires_in: 300,
      });
      record(200);
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(body)),
      });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }

    // OCI v2 base check
    if (pathname === "/v2/" || pathname === "/v2") {
      if (!checkBearerAuth(req, res, "registry:catalog:*", pathname, search)) return;
      record(200);
      res.writeHead(200, {
        "Docker-Distribution-Api-Version": "registry/2.0",
        "Content-Type": "application/json",
        "Content-Length": "2",
      });
      res.end(req.method === "HEAD" ? undefined : "{}");
      return;
    }

    // Manifest route: /v2/<repo...>/manifests/<ref>
    const manifestMatch = pathname.match(/^\/v2\/(.+)\/manifests\/([^/]+)$/);
    if (manifestMatch) {
      const repo = manifestMatch[1];
      const ref = manifestMatch[2];
      if (!checkBearerAuth(req, res, `repository:${repo}:pull`, pathname, search)) return;

      if (repo === "error/upstream500") {
        record(500);
        const body = JSON.stringify({ errors: [{ code: "UNKNOWN", message: "simulated upstream 500" }] });
        res.writeHead(500, { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) });
        res.end(req.method === "HEAD" ? undefined : body);
        return;
      }

      if (repo === "error/arm64only") {
        const armOnly = JSON.stringify({
          schemaVersion: 2,
          mediaType: MEDIA_OCI_INDEX,
          manifests: [
            {
              mediaType: MEDIA_OCI_MANIFEST,
              digest: "sha256:" + "a".repeat(64),
              size: 123,
              platform: { architecture: "arm64", os: "linux" },
            },
          ],
        });
        const buf = Buffer.from(armOnly, "utf8");
        record(200);
        res.writeHead(200, {
          "Content-Type": MEDIA_OCI_INDEX,
          "Docker-Content-Digest": sha256Digest(buf),
          "Content-Length": String(buf.length),
          "Docker-Distribution-Api-Version": "registry/2.0",
        });
        res.end(req.method === "HEAD" ? undefined : buf);
        return;
      }

      if (repo === "error/slow") {
        const timer = setTimeout(() => {
          record(200);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
        }, 5000);
        req.on("close", () => clearTimeout(timer));
        return;
      }

      const repoManifests = allManifestsByRepo.get(repo);
      const entry = repoManifests ? repoManifests.get(ref) : null;
      if (!entry) {
        record(404);
        const body = JSON.stringify({
          errors: [{ code: "MANIFEST_UNKNOWN", message: `manifest unknown: ${repo}:${ref}` }],
        });
        res.writeHead(404, {
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(body)),
          "Docker-Distribution-Api-Version": "registry/2.0",
        });
        res.end(req.method === "HEAD" ? undefined : body);
        return;
      }

      record(200);
      res.writeHead(200, {
        "Content-Type": entry.mediaType,
        "Docker-Content-Digest": entry.digest,
        "Content-Length": String(entry.bytes.length),
        "Docker-Distribution-Api-Version": "registry/2.0",
      });
      res.end(req.method === "HEAD" ? undefined : Buffer.from(entry.bytes));
      return;
    }

    // Blob route: /v2/<repo...>/blobs/<digest>
    const blobMatch = pathname.match(/^\/v2\/(.+)\/blobs\/([^/]+)$/);
    if (blobMatch) {
      const repo = blobMatch[1];
      const digest = blobMatch[2];
      if (!checkBearerAuth(req, res, `repository:${repo}:pull`, pathname, search)) return;

      const blob = allBlobs.get(digest);
      if (!blob) {
        record(404);
        const body = JSON.stringify({
          errors: [{ code: "BLOB_UNKNOWN", message: `blob unknown: ${digest}` }],
        });
        res.writeHead(404, {
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(body)),
        });
        res.end(req.method === "HEAD" ? undefined : body);
        return;
      }

      if (redirectBlobs) {
        const location = `http://127.0.0.1:${blobPort}/blobs/${digest}?sig=presigned`;
        record(302);
        res.writeHead(302, {
          Location: location,
          "Content-Length": "0",
        });
        res.end();
        return;
      }

      record(200);
      res.writeHead(200, {
        "Content-Type": blob.mediaType || "application/octet-stream",
        "Content-Length": String(blob.bytes.length),
        "Docker-Content-Digest": blob.digest,
      });
      res.end(req.method === "HEAD" ? undefined : Buffer.from(blob.bytes));
      return;
    }

    record(404);
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ errors: [{ code: "NAME_UNKNOWN", message: "not found" }] }));
  });

  blobPort = await listenServer(blobServer);
  regPort = await listenServer(registryServer);

  return {
    host: `127.0.0.1:${regPort}`,
    url: `http://127.0.0.1:${regPort}`,
    port: regPort,
    blobHost: `127.0.0.1:${blobPort}`,
    blobPort,
    requests,
    imageRef(repo, tag = "latest") {
      return `127.0.0.1:${regPort}/${repo}:${tag}`;
    },
    clearRequests() {
      requests.length = 0;
    },
    getRequests(predicate) {
      return predicate ? requests.filter(predicate) : [...requests];
    },
    leakedAuthCount() {
      return leakedAuthCounter;
    },
    registerImage(repo, tag, ociImage) {
      indexImage(repo, tag, ociImage);
    },
    /**
     * Build an in-memory OCI + Docker-compatible tarball (Uint8Array) for offline loadOciTarball tests.
     */
    getOciTarball(repo, tag = "latest") {
      const img = images.get(`${repo}:${tag}`);
      if (!img) {
        throw new Error(`Unknown fixture image: ${repo}:${tag}`);
      }
      const cfgHex = img.configDigest.replace(/^sha256:/, "");
      const manifestHex = img.amd64Manifest.digest.replace(/^sha256:/, "");

      const tarEntries = [
        {
          path: "oci-layout",
          type: "file",
          content: JSON.stringify({ imageLayoutVersion: "1.0.0" }),
        },
        {
          path: "index.json",
          type: "file",
          content: JSON.stringify({
            schemaVersion: 2,
            mediaType: MEDIA_OCI_INDEX,
            manifests: [
              {
                mediaType: img.amd64Manifest.mediaType,
                digest: img.amd64Manifest.digest,
                size: img.amd64Manifest.bytes.length,
                platform: { architecture: "amd64", os: "linux" },
              },
            ],
          }),
        },
        {
          path: "manifest.json",
          type: "file",
          content: JSON.stringify([
            {
              Config: `blobs/sha256/${cfgHex}`,
              RepoTags: [`${repo}:${tag}`],
              Layers: img.layers.map((l) => `blobs/sha256/${l.digest.replace(/^sha256:/, "")}`),
            },
          ]),
        },
        {
          path: `blobs/sha256/${manifestHex}`,
          type: "file",
          content: img.amd64Manifest.bytes,
        },
        {
          path: `blobs/sha256/${cfgHex}`,
          type: "file",
          content: img.configBytes,
        },
      ];

      for (const l of img.layers) {
        const lHex = l.digest.replace(/^sha256:/, "");
        tarEntries.push({
          path: `blobs/sha256/${lHex}`,
          type: "file",
          content: l.gzBytes,
        });
      }

      return createTar(tarEntries);
    },
    async close() {
      await Promise.all([closeServer(registryServer), closeServer(blobServer)]);
    },
  };
}
