import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTarGzLayer } from "./mock_registry.mjs";

const __filename = fileURLToPath(import.meta.url);

const ARCHIVE_PATH_RE = /^\/(.+?)\/archive\/(.+)\.tar\.gz$/;

function normalizeRepoPath(repoPath) {
  let cleaned = String(repoPath || "").trim();
  while (cleaned.startsWith("/")) cleaned = cleaned.slice(1);
  while (cleaned.endsWith("/")) cleaned = cleaned.slice(0, -1);
  if (cleaned.endsWith(".git")) {
    cleaned = cleaned.slice(0, -4);
  }
  return cleaned;
}

/**
 * Create a POSIX USTAR `.tar.gz` archive suitable for a mock git snapshot.
 * Reuses `createTarGzLayer` from `./mock_registry.mjs`.
 * When `rootDir` is non-empty, prepends a directory entry and prefixes all
 * member paths with `${rootDir}/` (matching GitHub/GitLab/Codeberg behavior).
 */
export function createGitArchiveTarGz(entries = [], { rootDir = "" } = {}) {
  const cleanRoot = String(rootDir || "").replace(/^\/+|\/+$/g, "");
  const normalizedEntries = [];

  if (cleanRoot) {
    normalizedEntries.push({
      path: cleanRoot,
      type: "dir",
      mode: 0o755,
    });
  }

  for (const entry of entries) {
    const relPath = String(entry.path || "").replace(/^\/+/, "");
    const fullPath = cleanRoot ? (relPath ? `${cleanRoot}/${relPath}` : cleanRoot) : relPath;
    normalizedEntries.push({
      ...entry,
      path: fullPath,
    });
  }

  const layer = createTarGzLayer(normalizedEntries);
  return {
    tarBytes: layer.tarBytes,
    gzipBytes: layer.gzipBytes,
    size: layer.size,
  };
}

/**
 * Separate HTTP server simulating a cross-origin archive CDN (e.g. `codeload.github.com`).
 * Records all incoming requests so tests can verify `Authorization` header stripping
 * and redirect handling.
 */
export function createGitRedirectTarget(getArchiveFn, options = {}) {
  const listenHost = options.host ?? "127.0.0.1";
  const listenPort = options.port ?? 0;
  const receivedRequests = [];

  const server = http.createServer((req, res) => {
    const method = (req.method || "GET").toUpperCase();
    const rawUrl = req.url || "/";
    receivedRequests.push({
      method,
      url: rawUrl,
      headers: { ...req.headers },
    });

    if (method !== "GET" && method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "text/plain" });
      res.end("Method Not Allowed");
      return;
    }

    const rawPath = rawUrl.split("?", 1)[0];
    if (!rawPath.startsWith("/tar.gz/")) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    let key;
    try {
      key = decodeURIComponent(rawPath.slice("/tar.gz/".length));
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Bad Request");
      return;
    }

    const archive = getArchiveFn(key);
    if (!archive) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Archive Not Found");
      return;
    }

    const headers = {
      "Content-Type": archive.contentType ?? "application/x-gzip",
    };
    if (!archive.omitContentLength) {
      headers["Content-Length"] = String(archive.gzipBytes.length);
    }
    if (archive.etag) {
      headers.ETag = archive.etag;
    }
    if (archive.explicitStripHeader !== undefined && archive.explicitStripHeader !== null) {
      headers["X-Git-Strip-Components"] = String(archive.explicitStripHeader);
    }

    res.writeHead(200, headers);
    if (method === "HEAD") {
      res.end();
    } else {
      res.end(archive.gzipBytes);
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
    receivedRequests,
    reset() {
      receivedRequests.length = 0;
    },
    start,
    stop,
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

/**
 * Local mock git archive HTTP server for deterministic offline testing.
 * Serves `GET|HEAD /<repoPath>/archive/<ref>.tar.gz`.
 */
export function createMockGitServer(options = {}) {
  const listenHost = options.host ?? "127.0.0.1";
  const listenPort = options.port ?? 0;
  let redirectArchivesTo = options.redirectArchivesTo ?? null;

  const archives = new Map();
  const behaviors = new Map();
  const receivedRequests = [];
  const stats = {
    archiveRequests: 0,
    redirectRequests: 0,
    notFoundRequests: 0,
  };

  function makeKey(repoPath, ref) {
    return `${normalizeRepoPath(repoPath)}@${ref}`;
  }

  function addRepo(repoPath, ref = "HEAD", entriesOrSpec = [], opts = {}) {
    const cleanRepo = normalizeRepoPath(repoPath);
    const repoName = cleanRepo.split("/").pop() || "repo";

    let spec;
    if (Array.isArray(entriesOrSpec)) {
      spec = { files: entriesOrSpec, ...opts };
    } else {
      spec = { ...entriesOrSpec, ...opts };
    }

    const stripComponents = spec.stripComponents ?? 1;
    let tarBytes = null;
    let gzipBytes;

    if (spec.tarGzBytes) {
      gzipBytes = Buffer.isBuffer(spec.tarGzBytes)
        ? spec.tarGzBytes
        : Buffer.from(spec.tarGzBytes);
    } else {
      const defaultRootDir =
        stripComponents === 1 ? `${repoName}-${String(ref).replaceAll("/", "-")}` : "";
      const rootDir = spec.rootDir !== undefined ? spec.rootDir : defaultRootDir;
      const built = createGitArchiveTarGz(spec.files || [], { rootDir });
      tarBytes = built.tarBytes;
      gzipBytes = built.gzipBytes;
    }

    const explicitStripHeader =
      spec.explicitStripHeader !== undefined
        ? spec.explicitStripHeader
        : stripComponents !== 1
          ? stripComponents
          : undefined;

    const key = makeKey(cleanRepo, ref);
    const record = {
      key,
      repoPath: cleanRepo,
      ref,
      tarBytes,
      gzipBytes,
      size: gzipBytes.length,
      stripComponents,
      explicitStripHeader,
      contentType: spec.contentType ?? "application/x-gzip",
      omitContentLength: Boolean(spec.omitContentLength),
      etag: spec.etag ?? null,
    };

    archives.set(key, record);
    return record;
  }

  function setRouteBehavior(repoPath, ref, behavior) {
    const key = makeKey(repoPath, ref);
    if (!behavior) {
      behaviors.delete(key);
    } else {
      behaviors.set(key, behavior);
    }
  }

  function setRedirectArchivesTo(baseUrl) {
    redirectArchivesTo = baseUrl || null;
  }

  function getArchive(key) {
    return archives.get(key) || null;
  }

  const server = http.createServer((req, res) => {
    const method = (req.method || "GET").toUpperCase();
    const rawUrl = req.url || "/";
    const rawPath = rawUrl.split("?", 1)[0];

    receivedRequests.push({
      method,
      url: rawUrl,
      headers: { ...req.headers },
    });

    if (method !== "GET" && method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "text/plain", Allow: "GET, HEAD" });
      res.end("Method Not Allowed");
      return;
    }

    const match = ARCHIVE_PATH_RE.exec(rawPath);
    if (!match) {
      stats.notFoundRequests++;
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    const repoPath = normalizeRepoPath(match[1]);
    let ref;
    try {
      ref = match[2]
        .split("/")
        .map((seg) => decodeURIComponent(seg))
        .join("/");
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Bad Request");
      return;
    }

    const key = makeKey(repoPath, ref);
    const behavior = behaviors.get(key);

    if (behavior) {
      if (behavior.delayMs && behavior.delayMs > 0) {
        const timer = setTimeout(() => {
          if (!res.writableEnded && !res.destroyed) {
            res.writeHead(behavior.status ?? 200, { "Content-Type": "application/gzip" });
            res.end();
          }
        }, behavior.delayMs);
        timer.unref?.();
        res.on("close", () => clearTimeout(timer));
        return;
      }

      if (behavior.redirectTo) {
        stats.redirectRequests++;
        const location = behavior.redirectTo === "loop" ? rawPath : behavior.redirectTo;
        res.writeHead(behavior.status ?? 302, { Location: location });
        res.end();
        return;
      }

      if (behavior.status) {
        const headers = { "Content-Type": "text/plain" };
        if (behavior.retryAfter) {
          headers["Retry-After"] = String(behavior.retryAfter);
        }
        res.writeHead(behavior.status, headers);
        res.end(behavior.body ?? `HTTP ${behavior.status}`);
        return;
      }
    }

    const archive = archives.get(key);
    if (!archive) {
      stats.notFoundRequests++;
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Archive Not Found");
      return;
    }

    if (redirectArchivesTo) {
      stats.redirectRequests++;
      const targetUrl = `${redirectArchivesTo}/tar.gz/${encodeURIComponent(key)}`;
      res.writeHead(302, { Location: targetUrl });
      res.end();
      return;
    }

    stats.archiveRequests++;
    const headers = {
      "Content-Type": archive.contentType,
    };
    if (!archive.omitContentLength) {
      headers["Content-Length"] = String(archive.gzipBytes.length);
    }
    if (archive.etag) {
      headers.ETag = archive.etag;
    }
    if (archive.explicitStripHeader !== undefined && archive.explicitStripHeader !== null) {
      headers["X-Git-Strip-Components"] = String(archive.explicitStripHeader);
    }

    res.writeHead(200, headers);
    if (method === "HEAD") {
      res.end();
    } else {
      res.end(archive.gzipBytes);
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
    stats,
    receivedRequests,
    addRepo,
    setRouteBehavior,
    setRedirectArchivesTo,
    getArchive,
    resetStats() {
      stats.archiveRequests = 0;
      stats.redirectRequests = 0;
      stats.notFoundRequests = 0;
    },
    resetRequests() {
      receivedRequests.length = 0;
    },
    start,
    stop,
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
    return path.resolve(process.argv[1]) === path.resolve(__filename);
  }
}

if (isMainModule()) {
  let host = "127.0.0.1";
  let port = 5050;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--host" && i + 1 < args.length) {
      host = args[++i];
    } else if (args[i].startsWith("--host=")) {
      host = args[i].slice("--host=".length);
    } else if (args[i] === "--port" && i + 1 < args.length) {
      port = Number(args[++i]);
    } else if (args[i].startsWith("--port=")) {
      port = Number(args[i].slice("--port=".length));
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log("Usage: node server/mock_git_server.mjs [--host 127.0.0.1] [--port 5050]");
      process.exit(0);
    }
  }

  const mock = createMockGitServer({ host, port });
  mock.addRepo("demo/hello", "HEAD", [
    { path: "README.md", content: "# Hello from mock git server\n" },
  ]);
  await mock.start();
  console.log(`Mock git archive server listening on ${mock.url}`);

  const shutdown = async () => {
    await mock.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
