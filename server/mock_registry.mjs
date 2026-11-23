import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);

export const OCI_INDEX_MEDIA_TYPE = "application/vnd.oci.image.index.v1+json";
export const OCI_MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json";
export const OCI_CONFIG_MEDIA_TYPE = "application/vnd.oci.image.config.v1+json";
export const OCI_LAYER_GZIP_MEDIA_TYPE = "application/vnd.oci.image.layer.v1.tar+gzip";

export const DOCKER_INDEX_MEDIA_TYPE = "application/vnd.docker.distribution.manifest.list.v2+json";
export const DOCKER_MANIFEST_MEDIA_TYPE = "application/vnd.docker.distribution.manifest.v2+json";
export const DOCKER_CONFIG_MEDIA_TYPE = "application/vnd.docker.container.image.v1+json";
export const DOCKER_LAYER_GZIP_MEDIA_TYPE = "application/vnd.docker.image.rootfs.diff.tar.gzip";

export function sha256Digest(buf) {
  const hash = crypto.createHash("sha256").update(buf).digest("hex");
  return `sha256:${hash}`;
}

function writeOctal(buf, offset, length, value) {
  const octal = Math.max(0, Math.floor(value)).toString(8);
  const maxDigits = length - 1;
  const padded = octal.padStart(maxDigits, "0").slice(-maxDigits);
  buf.write(padded, offset, maxDigits, "ascii");
  buf[offset + maxDigits] = 0;
}

function splitUstarName(rawPath) {
  const clean = rawPath.replace(/^\/+/, "");
  if (Buffer.byteLength(clean, "utf8") <= 100) {
    return { name: clean, prefix: "" };
  }
  // Split at a '/' boundary so name <= 100 and prefix <= 155
  const idx = clean.lastIndexOf("/");
  if (idx > 0) {
    const prefix = clean.slice(0, idx);
    const name = clean.slice(idx + 1);
    if (Buffer.byteLength(name, "utf8") <= 100 && Buffer.byteLength(prefix, "utf8") <= 155) {
      return { name, prefix };
    }
  }
  throw new Error(`TAR path exceeds POSIX USTAR limits: ${rawPath}`);
}

function buildUstarHeader(entry, dataLen) {
  const header = Buffer.alloc(512, 0);
  const type = entry.type || "file";
  let entryPath = entry.path.replace(/^\/+/, "");
  if (type === "dir" && !entryPath.endsWith("/")) {
    entryPath += "/";
  }

  const { name, prefix } = splitUstarName(entryPath);
  header.write(name, 0, Math.min(Buffer.byteLength(name, "utf8"), 100), "utf8");

  const defaultMode = type === "dir" ? 0o755 : type === "symlink" ? 0o777 : 0o644;
  writeOctal(header, 100, 8, entry.mode ?? defaultMode);
  writeOctal(header, 108, 8, 0); // uid
  writeOctal(header, 116, 8, 0); // gid
  writeOctal(header, 124, 12, type === "file" ? dataLen : 0);
  writeOctal(header, 136, 12, Math.floor(Date.now() / 1000));

  // Checksum field filled with spaces during computation
  header.fill(0x20, 148, 156);

  // typeFlag
  const typeFlag = type === "dir" ? "5" : type === "symlink" ? "2" : "0";
  header.write(typeFlag, 156, 1, "ascii");

  if (type === "symlink" && entry.linkname) {
    header.write(entry.linkname, 157, Math.min(Buffer.byteLength(entry.linkname, "utf8"), 100), "utf8");
  }

  // USTAR magic + version
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write("root", 265, 4, "ascii");
  header.write("root", 297, 4, "ascii");

  if (prefix) {
    header.write(prefix, 345, Math.min(Buffer.byteLength(prefix, "utf8"), 155), "utf8");
  }

  let chksum = 0;
  for (let i = 0; i < 512; i++) {
    chksum += header[i];
  }
  const chksumStr = chksum.toString(8).padStart(6, "0");
  header.write(chksumStr, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;

  return header;
}

/**
 * Build a POSIX USTAR + gzip layer blob from an array of file/dir/symlink entries.
 */
export function createTarGzLayer(entries = []) {
  const chunks = [];

  for (const entry of entries) {
    const type = entry.type || "file";
    let dataBuf = Buffer.alloc(0);
    if (type === "file") {
      if (Buffer.isBuffer(entry.content)) {
        dataBuf = entry.content;
      } else if (entry.content instanceof Uint8Array) {
        dataBuf = Buffer.from(entry.content);
      } else if (typeof entry.content === "string") {
        dataBuf = Buffer.from(entry.content, "utf8");
      }
    }

    chunks.push(buildUstarHeader(entry, dataBuf.length));
    if (dataBuf.length > 0) {
      chunks.push(dataBuf);
      const rem = dataBuf.length % 512;
      if (rem !== 0) {
        chunks.push(Buffer.alloc(512 - rem, 0));
      }
    }
  }

  // Two 512-byte zero blocks mark end-of-archive.
  chunks.push(Buffer.alloc(1024, 0));

  const tarBytes = Buffer.concat(chunks);
  const gzipBytes = zlib.gzipSync(tarBytes);

  return {
    tarBytes,
    gzipBytes,
    digest: sha256Digest(gzipBytes),
    diffId: sha256Digest(tarBytes),
    size: gzipBytes.length,
  };
}

/**
 * Standalone HTTP server on a separate ephemeral port to simulate cross-origin
 * CDN/S3 blob redirects and record incoming headers (for Authorization stripping tests).
 */
export function createBlobRedirectTarget(getBlobFn, options = {}) {
  const listenHost = options.host ?? "127.0.0.1";
  const listenPort = options.port ?? 0;
  const receivedRequests = [];

  const server = http.createServer((req, res) => {
    const method = (req.method || "GET").toUpperCase();
    const rawPath = (req.url || "/").split("?", 1)[0];

    receivedRequests.push({
      method,
      url: req.url,
      headers: { ...req.headers },
    });

    const m = /^\/blobs\/([^/]+)$/.exec(rawPath);
    if (!m) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not Found" }));
      return;
    }

    const digest = m[1];
    const blob = getBlobFn(digest);
    if (!blob) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Blob Not Found" }));
      return;
    }

    res.writeHead(200, {
      "Content-Type": blob.mediaType || "application/octet-stream",
      "Content-Length": blob.bytes.length,
      "Docker-Content-Digest": blob.digest,
    });
    if (method === "HEAD") {
      res.end();
    } else {
      res.end(blob.bytes);
    }
  });

  let boundPort = null;
  let boundHost = listenHost;

  async function start(port = listenPort, host = listenHost) {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        const addr = server.address();
        if (addr && typeof addr === "object") {
          boundPort = addr.port;
          boundHost = addr.address;
        }
        resolve();
      });
    });
    return handle;
  }

  async function stop() {
    if (!server.listening) return;
    await new Promise((resolve) => {
      server.close(() => resolve());
      if (typeof server.closeAllConnections === "function") {
        server.closeAllConnections();
      }
    });
  }

  const handle = {
    server,
    start,
    stop,
    receivedRequests,
    reset() {
      receivedRequests.length = 0;
    },
    get port() {
      return boundPort;
    },
    get host() {
      const h = boundHost.includes(":") ? `[${boundHost}]` : boundHost;
      return boundPort !== null ? `${h}:${boundPort}` : h;
    },
    get url() {
      return `http://${handle.host}`;
    },
  };

  return handle;
}

export function createMockRegistry(options = {}) {
  const listenHost = options.host ?? "127.0.0.1";
  const listenPort = options.port ?? 0;
  const requireAuth = Boolean(options.requireAuth);
  const authService = options.authService ?? "mock-registry";
  const tokenTtl = options.tokenTtl ?? 300;
  let redirectBlobsTo = options.redirectBlobsTo ?? null;

  // Map<digest, { digest, bytes: Buffer, mediaType: string, size: number }>
  const blobs = new Map();
  // Map<`${repo}:${ref}`, { digest, bytes: Buffer, mediaType: string }>
  const manifests = new Map();
  const validTokens = new Set();
  let tokenSeq = 0;

  const stats = {
    tokenRequests: 0,
    manifestRequests: 0,
    blobRequests: 0,
    v2PingRequests: 0,
  };

  function resetStats() {
    stats.tokenRequests = 0;
    stats.manifestRequests = 0;
    stats.blobRequests = 0;
    stats.v2PingRequests = 0;
  }

  function addBlob(bytes, mediaType = "application/octet-stream") {
    const buf = Buffer.isBuffer(bytes)
      ? bytes
      : bytes instanceof Uint8Array
        ? Buffer.from(bytes)
        : Buffer.from(String(bytes), "utf8");
    const digest = sha256Digest(buf);
    blobs.set(digest, { digest, bytes: buf, mediaType, size: buf.length });
    return { digest, size: buf.length, mediaType };
  }

  function getBlob(digest) {
    return blobs.get(digest) || null;
  }

  function addManifest(repo, ref, manifestObjOrBuf, mediaType = OCI_MANIFEST_MEDIA_TYPE) {
    const buf = Buffer.isBuffer(manifestObjOrBuf)
      ? manifestObjOrBuf
      : Buffer.from(JSON.stringify(manifestObjOrBuf, null, 2), "utf8");
    const digest = sha256Digest(buf);
    const entry = { digest, bytes: buf, mediaType };
    manifests.set(`${repo}:${ref}`, entry);
    manifests.set(`${repo}:${digest}`, entry);
    return { digest, size: buf.length, mediaType };
  }

  function addImage(repo, tag, spec = {}) {
    const mode = spec.mediaTypeMode === "docker" ? "docker" : "oci";
    const indexMediaType = mode === "docker" ? DOCKER_INDEX_MEDIA_TYPE : OCI_INDEX_MEDIA_TYPE;
    const manifestMediaType = mode === "docker" ? DOCKER_MANIFEST_MEDIA_TYPE : OCI_MANIFEST_MEDIA_TYPE;
    const configMediaType = mode === "docker" ? DOCKER_CONFIG_MEDIA_TYPE : OCI_CONFIG_MEDIA_TYPE;
    const layerMediaType = mode === "docker" ? DOCKER_LAYER_GZIP_MEDIA_TYPE : OCI_LAYER_GZIP_MEDIA_TYPE;

    const layerSpecs = spec.layers ?? [
      {
        files: [
          { path: "etc", type: "dir", mode: 0o755 },
          { path: "etc/hello.txt", type: "file", content: "hello from mock oci registry\n", mode: 0o644 },
        ],
      },
    ];

    const layerDescriptors = [];
    const diffIds = [];

    for (const ls of layerSpecs) {
      let gzipBytes;
      let diffId;
      if (ls.files) {
        const built = createTarGzLayer(ls.files);
        gzipBytes = built.gzipBytes;
        diffId = built.diffId;
      } else if (ls.tarGzPath) {
        gzipBytes = fs.readFileSync(ls.tarGzPath);
        const tarBytes = zlib.gunzipSync(gzipBytes);
        diffId = sha256Digest(tarBytes);
      } else if (ls.tarGzBytes) {
        gzipBytes = Buffer.isBuffer(ls.tarGzBytes) ? ls.tarGzBytes : Buffer.from(ls.tarGzBytes);
        const tarBytes = zlib.gunzipSync(gzipBytes);
        diffId = sha256Digest(tarBytes);
      } else {
        throw new Error("Layer spec must provide files, tarGzPath, or tarGzBytes");
      }

      const stored = addBlob(gzipBytes, layerMediaType);
      layerDescriptors.push({
        mediaType: layerMediaType,
        digest: stored.digest,
        size: stored.size,
      });
      diffIds.push(diffId);
    }

    const cfgSpec = spec.config ?? {};
    const configObj = {
      architecture: cfgSpec.architecture ?? "amd64",
      os: cfgSpec.os ?? "linux",
      config: {
        Env: cfgSpec.env ?? ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],
        Cmd: cfgSpec.cmd ?? ["/bin/sh"],
        ...(cfgSpec.entrypoint ? { Entrypoint: cfgSpec.entrypoint } : {}),
        WorkingDir: cfgSpec.workingDir ?? "/",
        ...(cfgSpec.user ? { User: cfgSpec.user } : {}),
      },
      rootfs: {
        type: "layers",
        diff_ids: diffIds,
      },
    };

    const configStored = addBlob(Buffer.from(JSON.stringify(configObj, null, 2), "utf8"), configMediaType);

    const amd64Manifest = {
      schemaVersion: 2,
      mediaType: manifestMediaType,
      config: {
        mediaType: configMediaType,
        digest: configStored.digest,
        size: configStored.size,
      },
      layers: layerDescriptors,
    };

    const multiArch = spec.multiArch !== false;
    if (multiArch) {
      const amd64Stored = addManifest(repo, `${tag}-amd64`, amd64Manifest, manifestMediaType);
      const arm64StubDigest = sha256Digest(Buffer.from(`arm64-stub-${repo}-${tag}`, "utf8"));

      // Put arm64 FIRST and amd64 SECOND to validate platform selection in OCI clients.
      const indexObj = {
        schemaVersion: 2,
        mediaType: indexMediaType,
        manifests: [
          {
            mediaType: manifestMediaType,
            digest: arm64StubDigest,
            size: 128,
            platform: { architecture: "arm64", os: "linux" },
          },
          {
            mediaType: manifestMediaType,
            digest: amd64Stored.digest,
            size: amd64Stored.size,
            platform: { architecture: "amd64", os: "linux" },
          },
        ],
      };

      const indexStored = addManifest(repo, tag, indexObj, indexMediaType);
      return {
        repo,
        tag,
        indexDigest: indexStored.digest,
        manifestDigest: amd64Stored.digest,
        configDigest: configStored.digest,
        layers: layerDescriptors,
      };
    }

    const singleStored = addManifest(repo, tag, amd64Manifest, manifestMediaType);
    return {
      repo,
      tag,
      indexDigest: null,
      manifestDigest: singleStored.digest,
      configDigest: configStored.digest,
      layers: layerDescriptors,
    };
  }

  function loadFixtureDir(dirPath) {
    const files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".tar.gz")).sort();
    const loaded = [];
    for (const file of files) {
      const name = file.slice(0, -".tar.gz".length).toLowerCase().replace(/[^a-z0-9._-]/g, "-");
      const fullPath = path.join(dirPath, file);
      const imgLib = addImage(`library/${name}`, "latest", { layers: [{ tarGzPath: fullPath }] });
      addImage(name, "latest", { layers: [{ tarGzPath: fullPath }] });
      loaded.push(imgLib);
    }
    return loaded;
  }

  if (options.fixtureDir) {
    loadFixtureDir(options.fixtureDir);
  }

  let boundPort = null;
  let boundHost = listenHost;

  function currentBaseUrl() {
    const h = boundHost.includes(":") ? `[${boundHost}]` : boundHost;
    return `http://${h}:${boundPort}`;
  }

  function checkAuth(req, res, repo = null) {
    if (!requireAuth) return true;
    const authHeader = req.headers.authorization || "";
    const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (m && validTokens.has(m[1])) {
      return true;
    }

    let challenge = `Bearer realm="${currentBaseUrl()}/token",service="${authService}"`;
    if (repo) {
      challenge += `,scope="repository:${repo}:pull"`;
    }
    const body = JSON.stringify({
      errors: [{ code: "UNAUTHORIZED", message: "authentication required" }],
    });
    res.writeHead(401, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "WWW-Authenticate": challenge,
      "Docker-Distribution-Api-Version": "registry/2.0",
    });
    res.end(body);
    return false;
  }

  const server = http.createServer((req, res) => {
    const method = (req.method || "GET").toUpperCase();
    const parsedUrl = new URL(req.url || "/", "http://localhost");
    const pathname = parsedUrl.pathname;

    res.setHeader("Docker-Distribution-Api-Version", "registry/2.0");

    // Token endpoint
    if (pathname === "/token") {
      stats.tokenRequests++;
      const token = `mock-token-${++tokenSeq}`;
      validTokens.add(token);
      const body = JSON.stringify({
        token,
        access_token: token,
        expires_in: tokenTtl,
        issued_at: new Date().toISOString(),
      });
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
      });
      res.end(method === "HEAD" ? undefined : body);
      return;
    }

    // /v2/ ping
    if (pathname === "/v2" || pathname === "/v2/") {
      if (!checkAuth(req, res, null)) return;
      stats.v2PingRequests++;
      const body = "{}";
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
      });
      res.end(method === "HEAD" ? undefined : body);
      return;
    }

    // /v2/<repo...>/manifests/<ref>
    const manifestMatch = /^\/v2\/(.+)\/manifests\/([^/]+)$/.exec(pathname);
    if (manifestMatch) {
      const repo = manifestMatch[1];
      const ref = manifestMatch[2];
      if (!checkAuth(req, res, repo)) return;
      stats.manifestRequests++;

      const entry = manifests.get(`${repo}:${ref}`);
      if (!entry) {
        const body = JSON.stringify({
          errors: [{ code: "MANIFEST_UNKNOWN", message: `manifest unknown: ${repo}:${ref}` }],
        });
        res.writeHead(404, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(body),
        });
        res.end(method === "HEAD" ? undefined : body);
        return;
      }

      res.writeHead(200, {
        "Content-Type": entry.mediaType,
        "Content-Length": entry.bytes.length,
        "Docker-Content-Digest": entry.digest,
      });
      res.end(method === "HEAD" ? undefined : entry.bytes);
      return;
    }

    // /v2/<repo...>/blobs/<digest>
    const blobMatch = /^\/v2\/(.+)\/blobs\/([^/]+)$/.exec(pathname);
    if (blobMatch) {
      const repo = blobMatch[1];
      const digest = blobMatch[2];
      if (!checkAuth(req, res, repo)) return;
      stats.blobRequests++;

      const entry = blobs.get(digest);
      if (!entry) {
        const body = JSON.stringify({
          errors: [{ code: "BLOB_UNKNOWN", message: `blob unknown: ${digest}` }],
        });
        res.writeHead(404, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(body),
        });
        res.end(method === "HEAD" ? undefined : body);
        return;
      }

      if (redirectBlobsTo) {
        const base = redirectBlobsTo.replace(/\/+$/, "");
        res.writeHead(302, {
          Location: `${base}/blobs/${digest}`,
        });
        res.end();
        return;
      }

      res.writeHead(200, {
        "Content-Type": entry.mediaType,
        "Content-Length": entry.bytes.length,
        "Docker-Content-Digest": entry.digest,
      });
      res.end(method === "HEAD" ? undefined : entry.bytes);
      return;
    }

    const body = JSON.stringify({ errors: [{ code: "NAME_UNKNOWN", message: "Not Found" }] });
    res.writeHead(404, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(method === "HEAD" ? undefined : body);
  });

  async function start(port = listenPort, host = listenHost) {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        const addr = server.address();
        if (addr && typeof addr === "object") {
          boundPort = addr.port;
          boundHost = addr.address;
        }
        resolve();
      });
    });
    return handle;
  }

  async function stop() {
    if (!server.listening) return;
    await new Promise((resolve) => {
      server.close(() => resolve());
      if (typeof server.closeAllConnections === "function") {
        server.closeAllConnections();
      }
    });
  }

  const handle = {
    server,
    start,
    stop,
    addBlob,
    getBlob,
    addManifest,
    addImage,
    loadFixtureDir,
    setRedirectBlobsTo(url) {
      redirectBlobsTo = url;
    },
    stats,
    resetStats,
    get hostname() {
      return boundHost;
    },
    get port() {
      return boundPort;
    },
    get host() {
      const h = boundHost.includes(":") ? `[${boundHost}]` : boundHost;
      return boundPort !== null ? `${h}:${boundPort}` : h;
    },
    get url() {
      return `http://${handle.host}`;
    },
  };

  return handle;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename);
  } catch {
    return path.resolve(process.argv[1]) === __filename;
  }
}

if (isMainModule()) {
  const argv = process.argv.slice(2);
  let host = "127.0.0.1";
  let port = 5000;
  let fixtureDir = null;
  let requireAuth = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node server/mock_registry.mjs [--host <addr>] [--port <n>] [--fixture-dir <dir>] [--require-auth]"
      );
      process.exit(0);
    } else if (arg === "--host" && i + 1 < argv.length) {
      host = argv[++i];
    } else if (arg.startsWith("--host=")) {
      host = arg.slice("--host=".length);
    } else if (arg === "--port" && i + 1 < argv.length) {
      port = Number(argv[++i]);
    } else if (arg.startsWith("--port=")) {
      port = Number(arg.slice("--port=".length));
    } else if (arg === "--fixture-dir" && i + 1 < argv.length) {
      fixtureDir = argv[++i];
    } else if (arg.startsWith("--fixture-dir=")) {
      fixtureDir = arg.slice("--fixture-dir=".length);
    } else if (arg === "--require-auth") {
      requireAuth = true;
    } else {
      throw new Error(`Unknown CLI argument: ${arg}`);
    }
  }

  const reg = createMockRegistry({ host, port, fixtureDir, requireAuth });
  if (!fixtureDir) {
    reg.addImage("library/hello", "latest");
  }
  await reg.start();
  console.log(`Mock OCI v2 registry listening on ${reg.url}`);

  const shutdown = async () => {
    await reg.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
