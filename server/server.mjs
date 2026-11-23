import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRegistryProxy } from "./registry_proxy.mjs";
import { createGitProxy } from "./git_proxy.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_ROOT_DIR = path.resolve(__dirname, "..");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

const WASM_FILENAME_RE = /^[a-zA-Z0-9_-]+\.wasm$/;

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

function setSecurityHeaders(res) {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function sendJson(res, statusCode, payload, method = "GET", extraHeaders = null) {
  const body = JSON.stringify(payload);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.setHeader("Cache-Control", "no-store");
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      res.setHeader(k, v);
    }
  }
  res.writeHead(statusCode);
  if (method === "HEAD") {
    res.end();
  } else {
    res.end(body);
  }
}

/**
 * Inspect raw URL path (before URL normalization) for traversal, null bytes,
 * backslashes, or encoded dot-segments.
 */
function hasRawPathTraversal(rawPath) {
  if (rawPath.includes("\0") || /%00/i.test(rawPath)) return true;
  if (rawPath.includes("\\") || /%5c/i.test(rawPath)) return true;
  if (
    rawPath.includes("/../") ||
    rawPath.endsWith("/..") ||
    rawPath === ".." ||
    /(%2e%2e|\.%2e|%2e\.)/i.test(rawPath)
  ) {
    return true;
  }
  return false;
}

async function serveStaticFile(req, res, baseDir, relPath, forcedContentType = null) {
  const method = (req.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    sendJson(res, 405, { error: "Method Not Allowed" }, method, { Allow: "GET, HEAD" });
    return;
  }

  // Decode and validate relative path segments.
  let decodedRel;
  try {
    decodedRel = decodeURIComponent(relPath);
  } catch {
    sendJson(res, 400, { error: "Malformed URL encoding" }, method);
    return;
  }

  if (
    !decodedRel ||
    decodedRel.includes("\0") ||
    decodedRel.includes("\\") ||
    decodedRel.startsWith("/")
  ) {
    sendJson(res, 400, { error: "Invalid static file path" }, method);
    return;
  }

  const segments = decodedRel.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    sendJson(res, 400, { error: "Invalid path segment" }, method);
    return;
  }

  const resolvedBase = path.resolve(baseDir);
  const candidate = path.resolve(resolvedBase, decodedRel);
  if (!candidate.startsWith(resolvedBase + path.sep)) {
    sendJson(res, 403, { error: "Forbidden" }, method);
    return;
  }

  let realBase;
  let realCandidate;
  try {
    realBase = await fsp.realpath(resolvedBase);
    realCandidate = await fsp.realpath(candidate);
  } catch (err) {
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) {
      sendJson(res, 404, { error: "Not Found" }, method);
      return;
    }
    sendJson(res, 500, { error: "Internal Server Error" }, method);
    return;
  }

  if (!realCandidate.startsWith(realBase + path.sep)) {
    sendJson(res, 403, { error: "Forbidden" }, method);
    return;
  }

  let stat;
  try {
    stat = await fsp.stat(realCandidate);
  } catch {
    sendJson(res, 404, { error: "Not Found" }, method);
    return;
  }

  if (!stat.isFile()) {
    sendJson(res, 404, { error: "Not Found" }, method);
    return;
  }

  const contentType = forcedContentType || getMimeType(realCandidate);
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Length", stat.size);
  res.writeHead(200);

  if (method === "HEAD") {
    res.end();
    return;
  }

  const stream = fs.createReadStream(realCandidate);
  const cleanup = () => {
    if (!stream.destroyed) {
      stream.destroy();
    }
  };
  res.on("close", cleanup);
  stream.on("error", () => {
    res.off("close", cleanup);
    if (!res.writableEnded) {
      res.destroy();
    }
  });
  stream.on("end", () => {
    res.off("close", cleanup);
  });
  stream.pipe(res);
}

export function parseCliArgs(argv = process.argv.slice(2)) {
  let host = "127.0.0.1";
  let port = 8080;
  let allowLocalRegistries =
    process.env.ALLOW_LOCAL_REGISTRIES === "1" ||
    process.env.ALLOW_LOCAL_REGISTRIES === "true";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--allow-local-registries") {
      allowLocalRegistries = true;
    } else if (arg === "--port" && i + 1 < argv.length) {
      port = Number(argv[++i]);
    } else if (arg.startsWith("--port=")) {
      port = Number(arg.slice("--port=".length));
    } else if (arg === "--host" && i + 1 < argv.length) {
      host = argv[++i];
    } else if (arg.startsWith("--host=")) {
      host = arg.slice("--host=".length);
    } else if (arg === "--help" || arg === "-h") {
      return { help: true, host, port, allowLocalRegistries };
    } else {
      throw new Error(`Unknown CLI argument: ${arg}`);
    }
  }

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${port}`);
  }
  if (!host || typeof host !== "string") {
    throw new Error(`Invalid host: ${host}`);
  }

  return { help: false, host, port, allowLocalRegistries };
}

export function createServer(options = {}) {
  const rootDir = options.rootDir ?? DEFAULT_ROOT_DIR;
  const webDir = options.webDir ?? path.join(rootDir, "web");
  const jsDir = options.jsDir ?? path.join(rootDir, "js");
  const wasmDir =
    options.wasmDir ?? path.join(rootDir, "target", "wasm32-unknown-unknown", "release");
  const listenHost = options.host ?? "127.0.0.1";
  const listenPort = options.port ?? 8080;
  const allowLocalRegistries =
    options.allowLocalRegistries ??
    (process.env.ALLOW_LOCAL_REGISTRIES === "1" ||
      process.env.ALLOW_LOCAL_REGISTRIES === "true");

  const proxy =
    options.proxy ??
    createRegistryProxy({
      allowLocalRegistries,
      lookupFn: options.lookupFn,
      maxRedirects: options.maxRedirects,
      requestTimeoutMs: options.requestTimeoutMs,
    });

  const proxyHandler =
    options.proxyHandler ?? ((req, res, rawPath) => proxy.handleRequest(req, res, rawPath));

  const gitProxy =
    options.gitProxy ??
    createGitProxy({
      allowLocalRegistries,
      lookupFn: options.lookupFn,
      maxRedirects: options.maxRedirects,
      requestTimeoutMs: options.requestTimeoutMs,
    });

  const gitProxyHandler =
    options.gitProxyHandler ?? ((req, res) => gitProxy.handleRequest(req, res));

  const server = http.createServer(async (req, res) => {
    setSecurityHeaders(res);

    try {
      const method = (req.method || "GET").toUpperCase();
      const rawUrl = req.url || "/";
      const rawPath = rawUrl.split("?", 1)[0];

      // Health check route
      if (rawPath === "/api/health") {
        if (method !== "GET" && method !== "HEAD") {
          sendJson(res, 405, { error: "Method Not Allowed" }, method, { Allow: "GET, HEAD" });
          return;
        }
        sendJson(res, 200, { ok: true, mode: "client-side-wasm" }, method);
        return;
      }

      // OCI v2 thin streaming registry proxy
      if (rawPath.startsWith("/api/v2/")) {
        await proxyHandler(req, res, rawPath);
        return;
      }

      // Git repository snapshot archive streaming proxy
      if (rawPath === "/api/git/archive") {
        await gitProxyHandler(req, res);
        return;
      }

      // Defense-in-depth raw path traversal check for all non-proxy routes
      if (hasRawPathTraversal(rawPath)) {
        sendJson(res, 400, { error: "Invalid request path" }, method);
        return;
      }

      // Home page
      if (rawPath === "/") {
        await serveStaticFile(req, res, webDir, "index.html", "text/html; charset=utf-8");
        return;
      }

      // Static web assets
      if (rawPath.startsWith("/web/")) {
        const rel = rawPath.slice("/web/".length);
        await serveStaticFile(req, res, webDir, rel);
        return;
      }

      // Static JS modules
      if (rawPath.startsWith("/js/")) {
        const rel = rawPath.slice("/js/".length);
        await serveStaticFile(req, res, jsDir, rel);
        return;
      }

      // WASM artifacts (strict filename validation)
      if (rawPath.startsWith("/wasm/")) {
        const rawSuffix = rawPath.slice("/wasm/".length);
        if (
          rawSuffix.includes("/") ||
          /%2f/i.test(rawSuffix) ||
          !WASM_FILENAME_RE.test(rawSuffix)
        ) {
          sendJson(res, 400, { error: "Invalid WASM artifact name" }, method);
          return;
        }
        await serveStaticFile(req, res, wasmDir, rawSuffix, "application/wasm");
        return;
      }

      sendJson(res, 404, { error: "Not Found" }, method);
    } catch {
      if (!res.headersSent) {
        sendJson(res, 500, { error: "Internal Server Error" }, (req.method || "GET").toUpperCase());
      } else if (!res.writableEnded) {
        res.destroy();
      }
    }
  });

  const keepAliveTimeout = options.keepAliveTimeout ?? 65_000;
  server.keepAliveTimeout = keepAliveTimeout;
  server.headersTimeout =
    options.headersTimeout ?? Math.max(keepAliveTimeout + 1_000, 66_000);

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
    proxy,
    gitProxy,
    start,
    stop,
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
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "Usage: node server/server.mjs [--host <addr>] [--port <n>] [--allow-local-registries]"
    );
    process.exit(0);
  }

  const srv = createServer({
    host: args.host,
    port: args.port,
    allowLocalRegistries: args.allowLocalRegistries,
  });

  await srv.start();
  console.log(`Listening on ${srv.url}`);

  const shutdown = async () => {
    await srv.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
