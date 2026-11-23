import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createServer, parseCliArgs } from "./server.mjs";
import {
  parseProxyPath,
  parseWwwAuthenticate,
  isBlockedIp,
  validateAndResolveUrl,
} from "./registry_proxy.mjs";
import {
  createMockRegistry,
  createBlobRedirectTarget,
  createTarGzLayer,
  sha256Digest,
  OCI_INDEX_MEDIA_TYPE,
  OCI_MANIFEST_MEDIA_TYPE,
} from "./mock_registry.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

function assertIsolationHeaders(headers, context = "") {
  const get = (name) =>
    typeof headers.get === "function" ? headers.get(name) : headers[name.toLowerCase()];
  assert.equal(
    get("cross-origin-opener-policy"),
    "same-origin",
    `Missing/wrong COOP header ${context}`
  );
  assert.equal(
    get("cross-origin-embedder-policy"),
    "require-corp",
    `Missing/wrong COEP header ${context}`
  );
}

/**
 * Send a raw HTTP request without client-side URL normalization (so `..`, `%2e`, `%00`
 * reach the server verbatim).
 */
function rawHttpRequest(port, rawPath, method = "GET", headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: rawPath,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function spawnServerCli(args = [], envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "server.mjs"), ...args], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ALLOW_LOCAL_REGISTRIES: "",
        ...envOverrides,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        child.kill("SIGKILL");
        reject(new Error(`Timed out waiting for server CLI. stdout=${stdout} stderr=${stderr}`));
      }
    }, 10_000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      const m = /Listening on (http:\/\/[^\s]+)/.exec(stdout);
      if (m && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ child, url: m[1] });
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("exit", (code) => {
      if (!resolved) {
        clearTimeout(timeout);
        reject(new Error(`Server CLI exited early (${code}). stdout=${stdout} stderr=${stderr}`));
      }
    });
  });
}

async function killChild(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolve();
    }, 2000).unref();
  });
}

describe("F7: Static & WASM Serving + COOP/COEP Headers", () => {
  let tmpDir;
  let wasmDir;
  let webDir;
  let srv;
  const wasmMagic = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

  before(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "elf2wasm-f7-"));
    wasmDir = path.join(tmpDir, "wasm");
    webDir = path.join(tmpDir, "web");
    await fsp.mkdir(wasmDir, { recursive: true });
    await fsp.mkdir(webDir, { recursive: true });
    await fsp.writeFile(path.join(wasmDir, "test_mod.wasm"), wasmMagic);
    await fsp.writeFile(path.join(webDir, "index.html"), "<!doctype html><title>test</title>");
    await fsp.writeFile(path.join(webDir, "styles.css"), "body { color: #fff; }");
    await fsp.symlink(path.join(REPO_ROOT, "Cargo.toml"), path.join(webDir, "escape.txt"));

    srv = createServer({
      port: 0,
      host: "127.0.0.1",
      webDir,
      wasmDir,
      allowLocalRegistries: false,
    });
    await srv.start();
  });

  after(async () => {
    await srv.stop();
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  test("GET / returns 200 text/html with COOP/COEP", async () => {
    const res = await fetch(`${srv.url}/`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
    assertIsolationHeaders(res.headers, "GET /");
    const text = await res.text();
    assert.match(text, /<title>test<\/title>/);
  });

  test("GET /web/styles.css returns 200 text/css with COOP/COEP", async () => {
    const res = await fetch(`${srv.url}/web/styles.css`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/css; charset=utf-8");
    assertIsolationHeaders(res.headers, "GET /web/styles.css");
    assert.equal(await res.text(), "body { color: #fff; }");
  });

  test("GET /js/elf2wasm_shim.mjs returns 200 application/javascript with COOP/COEP", async () => {
    const res = await fetch(`${srv.url}/js/elf2wasm_shim.mjs`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/javascript; charset=utf-8");
    assertIsolationHeaders(res.headers, "GET /js/elf2wasm_shim.mjs");
    const body = await res.text();
    assert.ok(body.length > 100);
  });

  test("GET /wasm/test_mod.wasm returns 200 application/wasm with exact bytes and COOP/COEP", async () => {
    const res = await fetch(`${srv.url}/wasm/test_mod.wasm`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/wasm");
    assert.equal(Number(res.headers.get("content-length")), wasmMagic.length);
    assertIsolationHeaders(res.headers, "GET /wasm/test_mod.wasm");
    const buf = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(buf, wasmMagic);
  });

  test("GET /api/health returns 200 JSON { ok: true, mode: 'client-side-wasm' }", async () => {
    const res = await fetch(`${srv.url}/api/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
    assertIsolationHeaders(res.headers, "GET /api/health");
    assert.deepEqual(await res.json(), { ok: true, mode: "client-side-wasm" });
  });

  test("HEAD on /, /api/health, /wasm/test_mod.wasm returns 200 with Content-Length and empty body", async () => {
    for (const p of ["/", "/api/health", "/wasm/test_mod.wasm"]) {
      const res = await fetch(`${srv.url}${p}`, { method: "HEAD" });
      assert.equal(res.status, 200, `HEAD ${p}`);
      assert.ok(Number(res.headers.get("content-length")) > 0, `Content-Length on HEAD ${p}`);
      assertIsolationHeaders(res.headers, `HEAD ${p}`);
      const buf = Buffer.from(await res.arrayBuffer());
      assert.equal(buf.length, 0, `Empty body on HEAD ${p}`);
    }
  });

  test("POST /api/health and DELETE / return 405 with Allow: GET, HEAD and COOP/COEP", async () => {
    const r1 = await fetch(`${srv.url}/api/health`, { method: "POST" });
    assert.equal(r1.status, 405);
    assert.equal(r1.headers.get("allow"), "GET, HEAD");
    assertIsolationHeaders(r1.headers, "POST /api/health");

    const r2 = await fetch(`${srv.url}/`, { method: "DELETE" });
    assert.equal(r2.status, 405);
    assert.equal(r2.headers.get("allow"), "GET, HEAD");
    assertIsolationHeaders(r2.headers, "DELETE /");
  });

  test("GET /nonexistent returns 404 with COOP/COEP", async () => {
    const res = await fetch(`${srv.url}/nonexistent`);
    assert.equal(res.status, 404);
    assertIsolationHeaders(res.headers, "GET /nonexistent");
    const body = await res.json();
    assert.equal(typeof body.error, "string");
  });

  test("Server starts cleanly when wasmDir does not exist and returns 404 for missing .wasm", async () => {
    const missingWasmSrv = createServer({
      port: 0,
      host: "127.0.0.1",
      wasmDir: path.join(tmpDir, "does-not-exist"),
    });
    await missingWasmSrv.start();
    try {
      const res = await fetch(`${missingWasmSrv.url}/wasm/elf2wasm_compiler_wasm.wasm`);
      assert.equal(res.status, 404);
      assertIsolationHeaders(res.headers, "missing wasmDir 404");
    } finally {
      await missingWasmSrv.stop();
    }
  });

  test("Path traversal & symlink escape matrix is strictly rejected", async () => {
    const traversalPaths = [
      "/web/../Cargo.toml",
      "/web/%2e%2e/Cargo.toml",
      "/js/../Cargo.toml",
      "/js/%2e%2e%2fCargo.toml",
      "/web/..%5cCargo.toml",
      "/web/index.html%00.js",
      "/wasm/../Cargo.toml",
      "/wasm/%2e%2e%2fCargo.toml",
      "/wasm/../../Cargo.toml",
      "/wasm/sub/mod.wasm",
      "/wasm/not_wasm.txt",
    ];

    for (const p of traversalPaths) {
      const res = await rawHttpRequest(srv.port, p);
      assert.ok(
        res.status === 400 || res.status === 403 || res.status === 404,
        `Expected 400/403/404 for ${p}, got ${res.status}`
      );
      assertIsolationHeaders(res.headers, `traversal ${p}`);
      assert.ok(
        !res.body.toString("utf8").includes("[workspace]"),
        `Leaked Cargo.toml on ${p}`
      );
    }

    // Symlink pointing outside webDir -> 403 Forbidden
    const symRes = await rawHttpRequest(srv.port, "/web/escape.txt");
    assert.equal(symRes.status, 403);
    assertIsolationHeaders(symRes.headers, "symlink escape");
    assert.ok(!symRes.body.toString("utf8").includes("[workspace]"));
  });

  test("parseCliArgs handles defaults, --port, --host, --allow-local-registries", () => {
    const a1 = parseCliArgs(["--port", "0", "--host", "0.0.0.0", "--allow-local-registries"]);
    assert.equal(a1.port, 0);
    assert.equal(a1.host, "0.0.0.0");
    assert.equal(a1.allowLocalRegistries, true);

    const a2 = parseCliArgs(["--port=9090", "--host=127.0.0.1"]);
    assert.equal(a2.port, 9090);
    assert.equal(a2.host, "127.0.0.1");
  });
});

describe("F9: Mock OCI v2 Registry Standalone", () => {
  let tmpDir;
  let reg;

  before(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "elf2wasm-f9-"));
  });

  after(async () => {
    if (reg) await reg.stop();
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  test("createTarGzLayer produces valid gzip + POSIX USTAR tar with accurate digest and diffId", () => {
    const layer = createTarGzLayer([
      { path: "bin", type: "dir", mode: 0o755 },
      { path: "bin/hello.txt", type: "file", content: "hello world\n", mode: 0o644 },
      { path: "bin/link", type: "symlink", linkname: "hello.txt" },
    ]);

    assert.equal(layer.gzipBytes[0], 0x1f);
    assert.equal(layer.gzipBytes[1], 0x8b);
    assert.equal(layer.digest, sha256Digest(layer.gzipBytes));
    assert.equal(layer.diffId, sha256Digest(layer.tarBytes));
    assert.equal(layer.size, layer.gzipBytes.length);

    const gunzipped = zlib.gunzipSync(layer.gzipBytes);
    assert.deepEqual(gunzipped, layer.tarBytes);
    // Verify USTAR magic at offset 257 of first header
    assert.equal(gunzipped.subarray(257, 263).toString("ascii"), "ustar\0");
  });

  test("Mock registry serves multi-arch index, single-arch manifest, disk .tar.gz fixtures, and Bearer auth", async () => {
    const diskLayer = createTarGzLayer([
      { path: "etc/release", type: "file", content: "mock-alpine 1.0\n" },
    ]);
    const tarPath = path.join(tmpDir, "demo.tar.gz");
    await fsp.writeFile(tarPath, diskLayer.gzipBytes);

    reg = createMockRegistry({ requireAuth: true });
    reg.loadFixtureDir(tmpDir);
    const singleImg = reg.addImage("org/single", "v1", { multiArch: false });
    await reg.start();

    // Unauthenticated request -> 401 with WWW-Authenticate
    const unauth = await fetch(`${reg.url}/v2/library/demo/manifests/latest`);
    assert.equal(unauth.status, 401);
    const wwwAuth = unauth.headers.get("www-authenticate");
    assert.match(wwwAuth, /^Bearer realm="http:\/\/127\.0\.0\.1:\d+\/token"/);

    // Fetch token
    const tokRes = await fetch(`${reg.url}/token?service=mock-registry&scope=repository:library/demo:pull`);
    assert.equal(tokRes.status, 200);
    const { token } = await tokRes.json();
    assert.ok(token);

    // Fetch multi-arch index
    const idxRes = await fetch(`${reg.url}/v2/library/demo/manifests/latest`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(idxRes.status, 200);
    assert.equal(idxRes.headers.get("content-type"), OCI_INDEX_MEDIA_TYPE);
    const idx = await idxRes.json();
    assert.equal(idx.manifests.length, 2);
    assert.equal(idx.manifests[0].platform.architecture, "arm64");
    assert.equal(idx.manifests[1].platform.architecture, "amd64");

    // Fetch single-arch manifest by digest
    const singleRes = await fetch(`${reg.url}/v2/org/single/manifests/${singleImg.manifestDigest}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(singleRes.status, 200);
    assert.equal(singleRes.headers.get("content-type"), OCI_MANIFEST_MEDIA_TYPE);
    assert.equal(singleRes.headers.get("docker-content-digest"), singleImg.manifestDigest);
  });
});

describe("F8: Registry Proxy Pure Helpers (Path, WWW-Authenticate, SSRF & DNS Rebinding)", () => {
  test("parseProxyPath accepts valid paths and rejects malformed/traversal inputs", () => {
    const validSha = `sha256:${"a".repeat(64)}`;
    assert.deepEqual(
      parseProxyPath("/api/v2/registry-1.docker.io/library/alpine/manifests/latest"),
      {
        registry: "registry-1.docker.io",
        hostname: "registry-1.docker.io",
        kind: "manifests",
        repo: "library/alpine",
        target: "latest",
      }
    );
    assert.deepEqual(
      parseProxyPath(`/api/v2/127.0.0.1:5000/org/sub/repo/blobs/${validSha}`),
      {
        registry: "127.0.0.1:5000",
        hostname: "127.0.0.1",
        kind: "blobs",
        repo: "org/sub/repo",
        target: validSha,
      }
    );
    assert.equal(
      parseProxyPath("/api/v2/[::ffff:127.0.0.1]/library/alpine/manifests/latest").hostname,
      "::ffff:127.0.0.1"
    );

    const invalidPaths = [
      "/api/v2/registry-1.docker.io/library/alpine/blobs/sha256:short",
      "/api/v2/registry-1.docker.io/library/alpine/blobs/md5:" + "a".repeat(32),
      "/api/v2/registry-1.docker.io/Upper/Case/manifests/latest",
      "/api/v2/user:pass@evil.com/library/alpine/manifests/latest",
      "/api/v2/registry-1.docker.io/library/../alpine/manifests/latest",
      "/api/v2/registry-1.docker.io/library/alpine/unknown/latest",
      "/api/v2//library/alpine/manifests/latest",
    ];
    for (const p of invalidPaths) {
      assert.throws(() => parseProxyPath(p), (err) => err.statusCode === 400, `Should reject ${p}`);
    }
  });

  test("parseWwwAuthenticate parses arbitrary parameter order and quoted/unquoted values", () => {
    const p1 = parseWwwAuthenticate(
      'Bearer scope="repository:library/alpine:pull", realm="https://auth.docker.io/token", service=registry.docker.io'
    );
    assert.deepEqual(p1, {
      scope: "repository:library/alpine:pull",
      realm: "https://auth.docker.io/token",
      service: "registry.docker.io",
    });
    assert.equal(parseWwwAuthenticate("Basic realm=\"foo\""), null);
  });

  test("isBlockedIp accurately blocks private/loopback/link-local/CGNAT/ULA/mapped IPs while allowing Docker Hub public IPs", () => {
    const blocked = [
      "0.0.0.0",
      "10.0.0.1",
      "100.64.0.1",
      "100.127.255.254",
      "127.0.0.1",
      "127.1.2.3",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.1",
      "224.0.0.1",
      "::",
      "::1",
      "fc00::1",
      "fd12::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:169.254.169.254",
      "64:ff9b::10.0.0.1",
      "::127.0.0.1",
      "::7f00:1",
      "::10.0.0.1",
      "::169.254.169.254",
      "::ffff:0:127.0.0.1",
      "64:ff9b:1::7f00:1",
      "100::1",
      "2001:0::1",
      "2001:2::1",
      "2002:7f00:1::",
      "2002:a9fe:a9fe::",
      "fec0::1",
    ];
    for (const ip of blocked) {
      assert.equal(isBlockedIp(ip, { allowLoopback: false }), true, `Should block ${ip}`);
    }

    // Public IPs including Docker Hub's 100.55.x.x and 172.64.x.x MUST NOT be blocked
    const allowed = ["100.55.234.118", "172.64.144.78", "1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"];
    for (const ip of allowed) {
      assert.equal(isBlockedIp(ip, { allowLoopback: false }), false, `Should allow public ${ip}`);
    }

    // Loopback allowed ONLY when allowLoopback: true, while IMDS remains blocked
    assert.equal(isBlockedIp("127.0.0.1", { allowLoopback: true }), false);
    assert.equal(isBlockedIp("::1", { allowLoopback: true }), false);
    assert.equal(isBlockedIp("169.254.169.254", { allowLoopback: true }), true);
  });

  test("validateAndResolveUrl catches DNS rebinding to private IP and supports Node 22 opts.all lookup", async () => {
    const evilLookup = async () => [{ address: "169.254.169.254", family: 4 }];
    await assert.rejects(
      () => validateAndResolveUrl(new URL("https://evil.example/v2/"), { lookupFn: evilLookup }),
      (err) => err.statusCode === 403
    );

    const goodLookup = async () => [{ address: "100.55.234.118", family: 4 }];
    const validated = await validateAndResolveUrl(new URL("https://registry-1.docker.io/v2/"), {
      lookupFn: goodLookup,
    });
    // Test pinned lookup with opts.all === true (Node 22 Happy Eyeballs)
    const allRes = await new Promise((resolve, reject) =>
      validated.lookup("registry-1.docker.io", { all: true }, (err, addrs) =>
        err ? reject(err) : resolve(addrs)
      )
    );
    assert.deepEqual(allRes, [{ address: "100.55.234.118", family: 4 }]);
  });
});

describe("F8: Proxy Streaming, Bearer Auth, Token Caching & Redirect Authorization Stripping", () => {
  let openReg;
  let authReg;
  let redirectTarget;
  let srv;
  let openImg;
  let authImg;
  let largeLayerBytes;

  before(async () => {
    // 256 KiB deterministic payload to verify streaming & Content-Length preservation
    const payload = Buffer.alloc(256 * 1024, 0x41);
    const layerSpec = {
      files: [
        { path: "bin", type: "dir", mode: 0o755 },
        { path: "bin/data.bin", type: "file", content: payload, mode: 0o644 },
      ],
    };

    openReg = createMockRegistry({ requireAuth: false });
    openImg = openReg.addImage("library/alpine", "latest", { layers: [layerSpec] });
    largeLayerBytes = openReg.getBlob(openImg.layers[0].digest).bytes;
    await openReg.start();

    authReg = createMockRegistry({ requireAuth: true });
    authImg = authReg.addImage("library/private", "latest", { layers: [layerSpec] });
    await authReg.start();

    redirectTarget = createBlobRedirectTarget((digest) => authReg.getBlob(digest));
    await redirectTarget.start();

    srv = createServer({ port: 0, host: "127.0.0.1", allowLocalRegistries: true });
    await srv.start();
  });

  after(async () => {
    await srv.stop();
    await redirectTarget.stop();
    await authReg.stop();
    await openReg.stop();
  });

  test("Streams multi-arch index, digest manifest, and raw gzipped blob without unpacking", async () => {
    const idxRes = await fetch(`${srv.url}/api/v2/${openReg.host}/library/alpine/manifests/latest`);
    assert.equal(idxRes.status, 200);
    assert.equal(idxRes.headers.get("content-type"), OCI_INDEX_MEDIA_TYPE);
    assert.equal(idxRes.headers.get("docker-content-digest"), openImg.indexDigest);
    assertIsolationHeaders(idxRes.headers, "proxy manifest index");
    const idx = await idxRes.json();
    assert.equal(idx.manifests[1].digest, openImg.manifestDigest);

    const manRes = await fetch(
      `${srv.url}/api/v2/${openReg.host}/library/alpine/manifests/${openImg.manifestDigest}`
    );
    assert.equal(manRes.status, 200);
    assert.equal(manRes.headers.get("content-type"), OCI_MANIFEST_MEDIA_TYPE);
    assert.equal(manRes.headers.get("docker-content-digest"), openImg.manifestDigest);
    assertIsolationHeaders(manRes.headers, "proxy manifest by digest");

    const blobRes = await fetch(
      `${srv.url}/api/v2/${openReg.host}/library/alpine/blobs/${openImg.layers[0].digest}`
    );
    assert.equal(blobRes.status, 200);
    assert.equal(Number(blobRes.headers.get("content-length")), largeLayerBytes.length);
    assertIsolationHeaders(blobRes.headers, "proxy blob");
    const gotBytes = Buffer.from(await blobRes.arrayBuffer());
    assert.equal(gotBytes[0], 0x1f);
    assert.equal(gotBytes[1], 0x8b);
    assert.deepEqual(gotBytes, largeLayerBytes);
  });

  test("Maps upstream 404 to 404 JSON and unreachable upstream to 502 JSON with COOP/COEP", async () => {
    const r404 = await fetch(`${srv.url}/api/v2/${openReg.host}/library/alpine/manifests/nonexistent`);
    assert.equal(r404.status, 404);
    assertIsolationHeaders(r404.headers, "proxy 404");
    const b404 = await r404.json();
    assert.equal(typeof b404.error, "string");

    // Pick an unused closed port by starting and immediately stopping a temporary server
    const tempReg = createMockRegistry();
    await tempReg.start();
    const closedHost = tempReg.host;
    await tempReg.stop();

    const r502 = await fetch(`${srv.url}/api/v2/${closedHost}/library/alpine/manifests/latest`);
    assert.equal(r502.status, 502);
    assertIsolationHeaders(r502.headers, "proxy 502");
    const b502 = await r502.json();
    assert.equal(typeof b502.error, "string");
  });

  test("Handles 401 Bearer auth and caches token across subsequent manifest/config/blob fetches", async () => {
    authReg.resetStats();
    srv.proxy.clearTokenCache();

    const r1 = await fetch(`${srv.url}/api/v2/${authReg.host}/library/private/manifests/latest`);
    assert.equal(r1.status, 200);
    await r1.json();
    assert.equal(authReg.stats.tokenRequests, 1);

    const r2 = await fetch(
      `${srv.url}/api/v2/${authReg.host}/library/private/manifests/${authImg.manifestDigest}`
    );
    assert.equal(r2.status, 200);
    await r2.json();

    const r3 = await fetch(
      `${srv.url}/api/v2/${authReg.host}/library/private/blobs/${authImg.configDigest}`
    );
    assert.equal(r3.status, 200);
    await r3.json();

    const r4 = await fetch(
      `${srv.url}/api/v2/${authReg.host}/library/private/blobs/${authImg.layers[0].digest}`
    );
    assert.equal(r4.status, 200);
    await r4.arrayBuffer();

    assert.equal(authReg.stats.tokenRequests, 1, "Token should have been cached for the repo");
  });

  test("Strips Authorization header on cross-origin blob redirect and blocks SSRF redirect to IMDS", async () => {
    redirectTarget.reset();
    authReg.setRedirectBlobsTo(redirectTarget.url);

    const res = await fetch(
      `${srv.url}/api/v2/${authReg.host}/library/private/blobs/${authImg.layers[0].digest}`
    );
    assert.equal(res.status, 200);
    assertIsolationHeaders(res.headers, "cross-origin redirect blob");
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(bytes, authReg.getBlob(authImg.layers[0].digest).bytes);

    assert.equal(redirectTarget.receivedRequests.length, 1);
    assert.equal(
      redirectTarget.receivedRequests[0].headers.authorization,
      undefined,
      "Authorization header MUST be stripped on cross-origin redirect"
    );

    // SSRF redirect to cloud IMDS MUST be blocked with 403 even when allowLocalRegistries is true
    authReg.setRedirectBlobsTo("http://169.254.169.254/latest/meta-data");
    const ssrfRes = await fetch(
      `${srv.url}/api/v2/${authReg.host}/library/private/blobs/${authImg.layers[0].digest}`
    );
    assert.equal(ssrfRes.status, 403);
    assertIsolationHeaders(ssrfRes.headers, "SSRF redirect 403");
    const errBody = await ssrfRes.json();
    assert.equal(typeof errBody.error, "string");

    authReg.setRedirectBlobsTo(null);
  });

  test("Follows 302 redirect on Bearer auth token endpoint, blocks SSRF auth redirect (403), and stops auth redirect loop (502)", async () => {
    let redirectMode = "ok";
    let authRedirectHits = 0;

    // Spin up a tiny HTTP server acting as a registry whose WWW-Authenticate realm redirects.
    const authRedirectSrv = http.createServer((req, res) => {
      const urlObj = new URL(req.url, "http://127.0.0.1");
      if (urlObj.pathname.startsWith("/v2/")) {
        if (req.headers.authorization === "Bearer redirected-token-123") {
          const manifest = JSON.stringify({
            schemaVersion: 2,
            mediaType: OCI_MANIFEST_MEDIA_TYPE,
            config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: "sha256:" + "0".repeat(64), size: 2 },
            layers: [],
          });
          res.writeHead(200, { "Content-Type": OCI_MANIFEST_MEDIA_TYPE });
          res.end(manifest);
          return;
        }
        const addr = authRedirectSrv.address();
        res.writeHead(401, {
          "WWW-Authenticate": `Bearer realm="http://127.0.0.1:${addr.port}/auth-redirect",service="test",scope="repository:library/redir:pull"`,
        });
        res.end();
        return;
      }

      if (urlObj.pathname === "/auth-redirect") {
        authRedirectHits++;
        const addr = authRedirectSrv.address();
        if (redirectMode === "ok") {
          res.writeHead(302, { Location: `http://127.0.0.1:${addr.port}/auth-final${urlObj.search}` });
          res.end();
          return;
        }
        if (redirectMode === "ssrf") {
          res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data" });
          res.end();
          return;
        }
        if (redirectMode === "loop") {
          res.writeHead(302, { Location: `http://127.0.0.1:${addr.port}/auth-redirect` });
          res.end();
          return;
        }
      }

      if (urlObj.pathname === "/auth-final") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ token: "redirected-token-123", expires_in: 60 }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise((resolve) => authRedirectSrv.listen(0, "127.0.0.1", resolve));
    const { port } = authRedirectSrv.address();

    try {
      // 1. Successful 302 auth redirect -> 200
      srv.proxy.clearTokenCache();
      redirectMode = "ok";
      authRedirectHits = 0;
      const rOk = await fetch(`${srv.url}/api/v2/127.0.0.1:${port}/library/redir/manifests/latest`);
      assert.equal(rOk.status, 200);
      assert.equal(authRedirectHits, 1);

      // 2. SSRF-blocked auth redirect -> 403
      srv.proxy.clearTokenCache();
      redirectMode = "ssrf";
      const rSsrf = await fetch(`${srv.url}/api/v2/127.0.0.1:${port}/library/redir/manifests/latest`);
      assert.equal(rSsrf.status, 403);

      // 3. Auth redirect loop -> 502
      srv.proxy.clearTokenCache();
      redirectMode = "loop";
      const rLoop = await fetch(`${srv.url}/api/v2/127.0.0.1:${port}/library/redir/manifests/latest`);
      assert.equal(rLoop.status, 502);
    } finally {
      await new Promise((resolve) => authRedirectSrv.close(resolve));
    }
  });
});

describe("F8: Input Validation (400) & SSRF Protection (403, default allowLocalRegistries: false)", () => {
  let srv;

  before(async () => {
    srv = createServer({ port: 0, host: "127.0.0.1", allowLocalRegistries: false });
    await srv.start();
  });

  after(async () => {
    await srv.stop();
  });

  test("Invalid digests, refs, repos, and registry hosts return 400 JSON with COOP/COEP", async () => {
    const badPaths = [
      "/api/v2/registry-1.docker.io/library/alpine/blobs/sha256:short",
      "/api/v2/registry-1.docker.io/library/alpine/blobs/sha256:" + "Z".repeat(64),
      "/api/v2/registry-1.docker.io/library/alpine/blobs/md5:" + "0".repeat(32),
      "/api/v2/registry-1.docker.io/library/alpine/blobs/../etc/passwd",
      "/api/v2/registry-1.docker.io/Upper/Case/manifests/latest",
      "/api/v2/user:pass@evil.com/library/alpine/manifests/latest",
      "/api/v2/registry-1.docker.io/library/alpine/manifests/..",
    ];

    for (const p of badPaths) {
      const res = await rawHttpRequest(srv.port, p);
      assert.equal(res.status, 400, `Expected 400 for ${p}, got ${res.status}`);
      assertIsolationHeaders(res.headers, `400 ${p}`);
      const parsed = JSON.parse(res.body.toString("utf8"));
      assert.equal(typeof parsed.error, "string");
    }
  });

  test("Blocks all loopback/private/link-local/CGNAT/ULA/IPv4-mapped-IPv6 registries with 403", async () => {
    const blockedHosts = [
      "127.0.0.1",
      "127.0.0.1:5000",
      "127.1.2.3",
      "localhost",
      "sub.localhost",
      "10.0.0.1",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "0.0.0.0",
      "100.64.0.1",
      "[::1]",
      "[::1]:5000",
      "[fc00::1]",
      "[fd12::1]",
      "[fe80::1]",
      "[::ffff:127.0.0.1]",
      "[::ffff:169.254.169.254]",
      "[::127.0.0.1]",
      "[::7f00:1]",
      "[::10.0.0.1]",
      "[::169.254.169.254]",
      "[::ffff:0:127.0.0.1]",
      "[64:ff9b:1::7f00:1]",
      "[100::1]",
      "[2001:0::1]",
      "[2001:2::1]",
      "[2002:7f00:1::]",
      "[fec0::1]",
    ];

    for (const host of blockedHosts) {
      const p = `/api/v2/${host}/library/alpine/manifests/latest`;
      const res = await rawHttpRequest(srv.port, p);
      assert.equal(res.status, 403, `Expected 403 for ${host}, got ${res.status} (${res.body})`);
      assertIsolationHeaders(res.headers, `403 ${host}`);
      const parsed = JSON.parse(res.body.toString("utf8"));
      assert.equal(typeof parsed.error, "string");
    }
  });
});

describe("CLI Flags & ALLOW_LOCAL_REGISTRIES=1", () => {
  let mockReg;

  before(async () => {
    mockReg = createMockRegistry();
    mockReg.addImage("library/cli-test", "latest");
    await mockReg.start();
  });

  after(async () => {
    await mockReg.stop();
  });

  test("Default CLI blocks local registry (403); --allow-local-registries and ALLOW_LOCAL_REGISTRIES=1 allow (200)", async () => {
    // 1. Default -> 403
    const c1 = await spawnServerCli(["--port", "0", "--host", "127.0.0.1"]);
    try {
      const r1 = await fetch(`${c1.url}/api/v2/${mockReg.host}/library/cli-test/manifests/latest`);
      assert.equal(r1.status, 403);
    } finally {
      await killChild(c1.child);
    }

    // 2. ALLOW_LOCAL_REGISTRIES=1 -> 200
    const c2 = await spawnServerCli(["--port", "0", "--host", "127.0.0.1"], {
      ALLOW_LOCAL_REGISTRIES: "1",
    });
    try {
      const r2 = await fetch(`${c2.url}/api/v2/${mockReg.host}/library/cli-test/manifests/latest`);
      assert.equal(r2.status, 200);
    } finally {
      await killChild(c2.child);
    }

    // 3. --allow-local-registries -> 200
    const c3 = await spawnServerCli([
      "--port",
      "0",
      "--host",
      "127.0.0.1",
      "--allow-local-registries",
    ]);
    try {
      const r3 = await fetch(`${c3.url}/api/v2/${mockReg.host}/library/cli-test/manifests/latest`);
      assert.equal(r3.status, 200);
    } finally {
      await killChild(c3.child);
    }
  });
});

describe("Live Docker Hub Smoke Test", () => {
  let srv;

  before(async () => {
    srv = createServer({ port: 0, host: "127.0.0.1", allowLocalRegistries: false });
    await srv.start();
  });

  after(async () => {
    await srv.stop();
  });

  test("Pulls library/alpine:latest manifest index from registry-1.docker.io through the proxy", async () => {
    const res = await fetch(
      `${srv.url}/api/v2/registry-1.docker.io/library/alpine/manifests/latest`
    );
    assert.equal(res.status, 200);
    assertIsolationHeaders(res.headers, "live Docker Hub");

    const digest = res.headers.get("docker-content-digest");
    assert.match(digest || "", /^sha256:[0-9a-f]{64}$/);

    const body = await res.json();
    assert.ok(Array.isArray(body.manifests), "Expected multi-arch manifest list from Docker Hub");
    const amd64 = body.manifests.find(
      (m) => m.platform && m.platform.os === "linux" && m.platform.architecture === "amd64"
    );
    assert.ok(amd64, "Expected a linux/amd64 manifest entry for alpine:latest");
  });
});
