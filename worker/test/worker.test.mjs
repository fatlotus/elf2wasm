import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import zlib from "node:zlib";
import { createWorkerHandler } from "../src/handler.mjs";
import {
  DEFAULT_MANIFEST_ACCEPT,
  MAX_TOKEN_RESPONSE_BYTES,
  classifyIp,
  isBlockedIp,
  extractRawPathname,
  parseWwwAuthenticate,
} from "../../server/proxy_core.mjs";
import {
  buildAssets,
  BROWSER_JS_FILES,
  WASM_FILES,
  WORKER_WASM_FILE,
  STATIC_HEADERS_CONTENT,
} from "../scripts/build_assets.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");

const VALID_DIGEST = "sha256:" + "a".repeat(64);
const WORKER_ORIGIN = "https://elf2wasm.workers.dev";

/**
 * Helper to create a Response with a spy-able ReadableStream so tests can assert
 * that non-returned upstream response bodies are explicitly canceled.
 */
function makeTrackedResponse(bodyChunks, init = {}) {
  let canceled = false;
  let readChunks = 0;
  const encoder = new TextEncoder();
  const normalizedChunks = (Array.isArray(bodyChunks) ? bodyChunks : [bodyChunks]).map((c) =>
    typeof c === "string" ? encoder.encode(c) : c
  );

  const stream = new ReadableStream({
    pull(controller) {
      if (readChunks < normalizedChunks.length) {
        controller.enqueue(normalizedChunks[readChunks++]);
      } else {
        controller.close();
      }
    },
    cancel() {
      canceled = true;
    },
  });

  const res = new Response(stream, init);
  return {
    response: res,
    wasCanceled: () => canceled,
  };
}

describe("Cloudflare Worker: /api/health", () => {
  it("GET /api/health returns 200 JSON with security headers and no-store", async () => {
    const worker = createWorkerHandler();
    const res = await worker.fetch(new Request(`${WORKER_ORIGIN}/api/health`));

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("cross-origin-opener-policy"), "same-origin");
    assert.equal(res.headers.get("cross-origin-embedder-policy"), "require-corp");
    assert.equal(res.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("access-control-allow-origin"), null);
    assert.deepEqual(await res.json(), { ok: true, mode: "client-side-wasm" });
  });

  it("HEAD /api/health returns 200 with empty body and Content-Length", async () => {
    const worker = createWorkerHandler();
    const res = await worker.fetch(new Request(`${WORKER_ORIGIN}/api/health`, { method: "HEAD" }));

    assert.equal(res.status, 200);
    assert.ok(Number(res.headers.get("content-length")) > 0);
    assert.equal(await res.text(), "");
  });

  it("POST /api/health returns 405 with Allow: GET, HEAD", async () => {
    const worker = createWorkerHandler();
    const res = await worker.fetch(new Request(`${WORKER_ORIGIN}/api/health`, { method: "POST" }));

    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "GET, HEAD");
    assert.deepEqual(await res.json(), { error: "Method Not Allowed" });
  });
});

describe("Cloudflare Worker: /api/v2/* Manifests, Blobs, Streaming & Header Allowlist", () => {
  it("proxies manifests with default Accept header and forwards only allowlisted headers", async () => {
    const calls = [];
    const manifestPayload = JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json" });
    const worker = createWorkerHandler({
      fetchImpl: async (url, init) => {
        calls.push({ url, method: init.method, headers: new Headers(init.headers), redirect: init.redirect });
        return new Response(manifestPayload, {
          status: 200,
          headers: {
            "Content-Type": "application/vnd.oci.image.manifest.v1+json",
            "Content-Length": String(manifestPayload.length),
            "Docker-Content-Digest": VALID_DIGEST,
            ETag: '"abc123"',
            "Cache-Control": "public, max-age=60",
            "Accept-Ranges": "bytes",
            "Set-Cookie": "secret=should-not-leak",
            "X-Internal-Debug": "should-not-leak",
          },
        });
      },
    });

    const res = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/v2/registry-1.docker.io/library/alpine/manifests/latest`)
    );

    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://registry-1.docker.io/v2/library/alpine/manifests/latest");
    assert.equal(calls[0].redirect, "manual");
    assert.equal(calls[0].headers.get("accept"), DEFAULT_MANIFEST_ACCEPT);

    assert.equal(res.headers.get("content-type"), "application/vnd.oci.image.manifest.v1+json");
    assert.equal(res.headers.get("docker-content-digest"), VALID_DIGEST);
    assert.equal(res.headers.get("etag"), '"abc123"');
    assert.equal(res.headers.get("cache-control"), "public, max-age=60");
    assert.equal(res.headers.get("accept-ranges"), "bytes");
    assert.equal(res.headers.get("set-cookie"), null);
    assert.equal(res.headers.get("x-internal-debug"), null);
    assert.equal(await res.text(), manifestPayload);
  });

  it("streams binary blob chunks zero-copy without mutation", async () => {
    const chunk1 = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xde, 0xad]);
    const chunk2 = new Uint8Array([0xbe, 0xef, 0x01, 0x02, 0x03, 0x04]);
    const tracked = makeTrackedResponse([chunk1, chunk2], {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(chunk1.byteLength + chunk2.byteLength),
      },
    });

    const worker = createWorkerHandler({
      fetchImpl: async () => tracked.response,
    });

    const res = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/v2/registry-1.docker.io/library/alpine/blobs/${VALID_DIGEST}`)
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/octet-stream");
    assert.equal(res.headers.get("content-length"), "12");
    const received = new Uint8Array(await res.arrayBuffer());
    assert.deepEqual(Array.from(received), [...chunk1, ...chunk2]);
  });

  it("cancels upstream response body on HEAD, 404, and 500 responses", async () => {
    const cases = [
      { method: "HEAD", upstreamStatus: 200, expectedStatus: 200 },
      { method: "GET", upstreamStatus: 404, expectedStatus: 404 },
      { method: "GET", upstreamStatus: 500, expectedStatus: 502 },
    ];

    for (const tc of cases) {
      const tracked = makeTrackedResponse(["unused body"], { status: tc.upstreamStatus });
      const worker = createWorkerHandler({
        fetchImpl: async () => tracked.response,
      });

      const res = await worker.fetch(
        new Request(`${WORKER_ORIGIN}/api/v2/registry-1.docker.io/library/alpine/manifests/latest`, {
          method: tc.method,
        })
      );

      assert.equal(res.status, tc.expectedStatus, `unexpected status for ${tc.method}/${tc.upstreamStatus}`);
      assert.equal(tracked.wasCanceled(), true, `upstream body must be canceled for ${tc.method}/${tc.upstreamStatus}`);
    }
  });

  it("rejects non-GET/HEAD/OPTIONS methods on /api/v2/* with 405", async () => {
    const worker = createWorkerHandler();
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await worker.fetch(
        new Request(`${WORKER_ORIGIN}/api/v2/registry-1.docker.io/library/alpine/manifests/latest`, {
          method,
        })
      );
      assert.equal(res.status, 405);
      assert.equal(res.headers.get("allow"), "GET, HEAD, OPTIONS");
    }
  });
});

describe("Cloudflare Worker: Input Validation (400) & Raw Pathname Preservation", () => {
  it("extractRawPathname preserves .. and // before URL normalization", () => {
    assert.equal(
      extractRawPathname("https://elf2wasm.workers.dev/api/v2/registry-1.docker.io/a/../b/manifests/latest?x=1"),
      "/api/v2/registry-1.docker.io/a/../b/manifests/latest"
    );
    assert.equal(
      extractRawPathname("https://elf2wasm.workers.dev/api/v2/registry-1.docker.io//library/alpine/manifests/latest"),
      "/api/v2/registry-1.docker.io//library/alpine/manifests/latest"
    );
  });

  it("returns 400 JSON for malformed paths, invalid digests, and traversal sequences", async () => {
    const worker = createWorkerHandler({
      fetchImpl: async () => {
        throw new Error("fetchImpl must not be called for 400 paths");
      },
    });

    const badUrls = [
      `${WORKER_ORIGIN}/api/v2`,
      `${WORKER_ORIGIN}/api/v2/`,
      `${WORKER_ORIGIN}/api/v2/registry-1.docker.io/library/alpine/blobs/not-a-valid-digest`,
      `${WORKER_ORIGIN}/api/v2/registry-1.docker.io/library/alpine/tags/latest`,
      `${WORKER_ORIGIN}/api/v2/registry-1.docker.io/library/%2e%2e/manifests/latest`,
      `${WORKER_ORIGIN}/api/v2/registry-1.docker.io//library/alpine/manifests/latest`,
      `${WORKER_ORIGIN}/api/v2/registry-1.docker.io/library/../alpine/manifests/latest`,
    ];

    for (const url of badUrls) {
      // Pass a Request-like object to simulate raw unnormalized Worker request.url
      const req = { url, method: "GET", headers: new Headers() };
      const res = await worker.fetch(req);
      assert.equal(res.status, 400, `Expected 400 for ${url}, got ${res.status}`);
      const json = await res.json();
      assert.equal(typeof json.error, "string");
    }
  });

  it("rejects malformed IPv4-before-:: IPv6 literals with 400 while preserving valid embedded-IPv4 IPv6 blocking", async () => {
    assert.equal(classifyIp("1.2.3.4::5"), 0);
    assert.equal(classifyIp("127.0.0.1::"), 0);

    for (const validEmbedded of [
      "::ffff:127.0.0.1",
      "64:ff9b::127.0.0.1",
      "::127.0.0.1",
      "0:0:0:0:0:ffff:127.0.0.1",
    ]) {
      assert.equal(classifyIp(validEmbedded), 6, `Expected valid IPv6 for ${validEmbedded}`);
      assert.equal(isBlockedIp(validEmbedded), true, `Expected blocked IP for ${validEmbedded}`);
    }

    const worker = createWorkerHandler({
      fetchImpl: async () => {
        throw new Error("fetchImpl must not be called for malformed IPv6");
      },
    });

    for (const badHost of ["%5B1.2.3.4::5%5D", "%5B127.0.0.1::%5D"]) {
      const res = await worker.fetch(
        new Request(`${WORKER_ORIGIN}/api/v2/${badHost}/library/alpine/manifests/latest`)
      );
      assert.equal(res.status, 400, `Expected 400 for ${badHost}, got ${res.status}`);
    }
  });

  it("extractRawPathname handles CRLF/newlines so Worker rejects them with 400 instead of 404", async () => {
    assert.equal(extractRawPathname("https://x.test/api/v2/a\r\n"), "/api/v2/a\r\n");

    const worker = createWorkerHandler({
      fetchImpl: async () => {
        throw new Error("fetchImpl must not be called for CRLF URLs");
      },
    });
    const req = {
      url: `${WORKER_ORIGIN}/api/v2/registry-1.docker.io/library/alpine/manifests/latest\r\n`,
      method: "GET",
      headers: new Headers(),
    };
    const res = await worker.fetch(req);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(typeof body.error, "string");
  });
});

describe("Cloudflare Worker: SSRF Protection (403)", () => {
  it("blocks IPv4/IPv6 private, loopback, link-local, IMDS, localhost, and metadata hosts", async () => {
    const worker = createWorkerHandler({
      fetchImpl: async () => {
        throw new Error("fetchImpl must not be called for SSRF-blocked hosts");
      },
    });

    const blockedRegistries = [
      "127.0.0.1",
      "127.0.0.1:5000",
      "10.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.1.1",
      "100.64.0.1",
      "localhost",
      "sub.localhost",
      "metadata.google.internal",
      "%5B::1%5D",
      "%5Bfc00::1%5D",
      "%5Bfe80::1%5D",
      "%5B::ffff:127.0.0.1%5D",
      "%5B::ffff:169.254.169.254%5D",
    ];

    for (const registry of blockedRegistries) {
      const res = await worker.fetch(
        new Request(`${WORKER_ORIGIN}/api/v2/${registry}/library/alpine/manifests/latest`)
      );
      assert.equal(res.status, 403, `Expected 403 for registry ${registry}, got ${res.status}`);
    }
  });

  it("blocks redirects to IMDS, non-HTTPS, and embedded credentials, canceling redirect body", async () => {
    const badLocations = [
      "https://169.254.169.254/latest/meta-data/",
      "http://cdn.example.com/blob",
      "https://user:pass@cdn.example.com/blob",
      "https://[::1]/secret",
      "ftp://cdn.example.com/blob",
    ];

    for (const location of badLocations) {
      const trackedRedirect = makeTrackedResponse(["redirecting"], {
        status: 302,
        headers: { Location: location },
      });

      const worker = createWorkerHandler({
        fetchImpl: async () => trackedRedirect.response,
      });

      const res = await worker.fetch(
        new Request(`${WORKER_ORIGIN}/api/v2/registry-1.docker.io/library/alpine/blobs/${VALID_DIGEST}`)
      );

      assert.equal(res.status, 403, `Expected 403 for redirect to ${location}`);
      assert.equal(trackedRedirect.wasCanceled(), true, `Redirect body must be canceled for ${location}`);
    }
  });
});

describe("Cloudflare Worker: Bearer Token Exchange, Caching & 64 KiB Limit", () => {
  it("exchanges 401 Bearer challenge, caches token across requests, and cancels 401 body", async () => {
    let authCalls = 0;
    let registryCalls = 0;
    const tracked401 = makeTrackedResponse(['{"errors":[{"code":"UNAUTHORIZED"}]}'], {
      status: 401,
      headers: {
        "WWW-Authenticate":
          'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/alpine:pull"',
      },
    });

    const worker = createWorkerHandler({
      fetchImpl: async (url, init) => {
        const headers = new Headers(init.headers);
        if (url.startsWith("https://auth.docker.io/token")) {
          authCalls++;
          const u = new URL(url);
          assert.equal(u.searchParams.get("service"), "registry.docker.io");
          assert.equal(u.searchParams.get("scope"), "repository:library/alpine:pull");
          return new Response(JSON.stringify({ token: "tok-secret-123", expires_in: 300 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        registryCalls++;
        if (headers.get("authorization") !== "Bearer tok-secret-123") {
          return tracked401.response;
        }
        return new Response('{"ok":true}', {
          status: 200,
          headers: { "Content-Type": "application/vnd.oci.image.manifest.v1+json" },
        });
      },
    });

    // First request: 401 -> auth -> retry 200
    const res1 = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/v2/registry-1.docker.io/library/alpine/manifests/latest`)
    );
    assert.equal(res1.status, 200);
    assert.equal(authCalls, 1);
    assert.equal(registryCalls, 2);
    assert.equal(tracked401.wasCanceled(), true);

    // Second request: uses cached token -> 1 upstream call, 0 additional auth calls
    const res2 = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/v2/registry-1.docker.io/library/alpine/blobs/${VALID_DIGEST}`)
    );
    assert.equal(res2.status, 200);
    assert.equal(authCalls, 1);
    assert.equal(registryCalls, 3);
  });

  it("rejects auth token responses exceeding 64 KiB with 502 and cancels stream", async () => {
    const chunkA = new Uint8Array(32 * 1024).fill(0x41);
    const chunkB = new Uint8Array(32 * 1024).fill(0x42);
    const chunkC = new Uint8Array(32 * 1024).fill(0x43);
    const chunkD = new Uint8Array(32 * 1024).fill(0x44);
    const trackedToken = makeTrackedResponse([chunkA, chunkB, chunkC, chunkD], {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

    const worker = createWorkerHandler({
      fetchImpl: async (url) => {
        if (url.startsWith("https://auth.docker.io/token")) {
          return trackedToken.response;
        }
        return new Response("unauthorized", {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"',
          },
        });
      },
    });

    const res = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/v2/registry-1.docker.io/library/alpine/manifests/latest`)
    );

    assert.equal(res.status, 502);
    const body = await res.json();
    assert.match(body.error, /exceeded maximum size/i);
    assert.equal(trackedToken.wasCanceled(), true);
  });

  it("parseWwwAuthenticate preserves Bearer params across multi-challenge headers and quoted escapes", async () => {
    assert.deepEqual(
      parseWwwAuthenticate(
        'Bearer realm="https://auth.example.com/token",service="registry",scope="repo:alpine:pull", Basic realm="fallback"'
      ),
      {
        realm: "https://auth.example.com/token",
        service: "registry",
        scope: "repo:alpine:pull",
      }
    );

    assert.deepEqual(
      parseWwwAuthenticate(
        'Basic realm="other", Bearer realm="https://auth.example.com/token", service="registry"'
      ),
      {
        realm: "https://auth.example.com/token",
        service: "registry",
      }
    );

    assert.deepEqual(
      parseWwwAuthenticate(
        'Bearer realm="https://auth.example.com/token", scope="a,b,\\"c\\"", Basic realm="ignored"'
      ),
      {
        realm: "https://auth.example.com/token",
        scope: 'a,b,"c"',
      }
    );

    assert.equal(
      parseWwwAuthenticate('Bearer service="registry", Basic realm="fallback"'),
      null
    );

    const requestedUrls = [];
    const worker = createWorkerHandler({
      fetchImpl: async (url, init) => {
        requestedUrls.push(url);
        const headers = new Headers(init.headers);
        if (url.startsWith("https://auth.example.com/token")) {
          return new Response(JSON.stringify({ token: "multi-tok", expires_in: 300 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (headers.get("authorization") === "Bearer multi-tok") {
          return new Response('{"ok":true}', { status: 200 });
        }
        return new Response("unauthorized", {
          status: 401,
          headers: {
            "WWW-Authenticate":
              'Bearer realm="https://auth.example.com/token",service="registry",scope="repo:alpine:pull", Basic realm="https://fallback.invalid/auth"',
          },
        });
      },
    });

    const res = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/v2/registry-1.docker.io/library/alpine/manifests/latest`)
    );
    assert.equal(res.status, 200);
    assert.ok(
      requestedUrls.some((u) => u.startsWith("https://auth.example.com/token")),
      "Expected token fetch from Bearer realm"
    );
    assert.ok(
      !requestedUrls.some((u) => u.includes("fallback.invalid")),
      "Must not fetch token from subsequent Basic realm"
    );
  });

  it("returns clean 502 error when auth server returns JSON null or primitive instead of object", async () => {
    for (const rawJson of ["null", "42", '"just-a-string"', "true"]) {
      const worker = createWorkerHandler({
        fetchImpl: async (url) => {
          if (url.startsWith("https://auth.docker.io/token")) {
            return new Response(rawJson, {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response("unauthorized", {
            status: 401,
            headers: {
              "WWW-Authenticate": 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"',
            },
          });
        },
      });

      const res = await worker.fetch(
        new Request(`${WORKER_ORIGIN}/api/v2/registry-1.docker.io/library/alpine/manifests/latest`)
      );
      assert.equal(res.status, 502, `Expected 502 for JSON ${rawJson}`);
      assert.deepEqual(await res.json(), { error: "Registry auth server response missing token" });
    }
  });
});

describe("Cloudflare Worker: Redirect Authorization Stripping & Loop Guard", () => {
  it("strips Authorization on cross-origin redirect and cancels intermediate redirect bodies", async () => {
    const seenAuth = [];
    const trackedRedirect1 = makeTrackedResponse(["redir1"], {
      status: 307,
      headers: { Location: "/v2/library/alpine/blobs/same-origin-hop" },
    });
    const trackedRedirect2 = makeTrackedResponse(["redir2"], {
      status: 302,
      headers: { Location: "https://cdn.cloudflare.example.com/signed-layer.tar.gz" },
    });

    const worker = createWorkerHandler({
      fetchImpl: async (url, init) => {
        const auth = new Headers(init.headers).get("authorization");
        if (url.startsWith("https://auth.docker.io/token")) {
          return new Response(JSON.stringify({ token: "my-bearer-token", expires_in: 300 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        seenAuth.push({ url, auth });
        if (url.endsWith(VALID_DIGEST) && !auth) {
          return new Response("unauth", {
            status: 401,
            headers: { "WWW-Authenticate": 'Bearer realm="https://auth.docker.io/token"' },
          });
        }
        if (url.endsWith(VALID_DIGEST)) {
          return trackedRedirect1.response;
        }
        if (url.endsWith("/same-origin-hop")) {
          return trackedRedirect2.response;
        }
        return new Response("layer-bytes", { status: 200 });
      },
    });

    const res = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/v2/registry-1.docker.io/library/alpine/blobs/${VALID_DIGEST}`)
    );

    assert.equal(res.status, 200);
    assert.equal(await res.text(), "layer-bytes");
    assert.equal(trackedRedirect1.wasCanceled(), true);
    assert.equal(trackedRedirect2.wasCanceled(), true);

    // Same-origin hop kept Authorization; cross-origin hop stripped it!
    const sameOriginHop = seenAuth.find((c) => c.url.endsWith("/same-origin-hop"));
    const crossOriginHop = seenAuth.find((c) => c.url.startsWith("https://cdn.cloudflare.example.com/"));
    assert.equal(sameOriginHop.auth, "Bearer my-bearer-token");
    assert.equal(crossOriginHop.auth, null);
  });

  it("stops redirect loops beyond maxRedirects with 502", async () => {
    const worker = createWorkerHandler({
      maxRedirects: 2,
      fetchImpl: async () =>
        new Response("loop", {
          status: 302,
          headers: { Location: "https://registry-1.docker.io/v2/loop" },
        }),
    });

    const res = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/v2/registry-1.docker.io/library/alpine/manifests/latest`)
    );
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.match(body.error, /Too many redirects/i);
  });
});

describe("Cloudflare Worker: CORS, CORP & OPTIONS Preflight Policy", () => {
  it("allows same-origin requests with CORP: same-origin and reflects own origin", async () => {
    const worker = createWorkerHandler({
      fetchImpl: async () => new Response("{}", { status: 200 }),
    });

    const res = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/v2/registry-1.docker.io/library/alpine/manifests/latest`, {
        headers: { Origin: WORKER_ORIGIN },
      }),
      { ALLOWED_ORIGINS: "" }
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), WORKER_ORIGIN);
    assert.equal(res.headers.get("vary"), "Origin");
    assert.equal(res.headers.get("cross-origin-resource-policy"), "same-origin");

    const preflight = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/v2/registry-1.docker.io/library/alpine/manifests/latest`, {
        method: "OPTIONS",
        headers: { Origin: WORKER_ORIGIN },
      }),
      { ALLOWED_ORIGINS: "" }
    );
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), WORKER_ORIGIN);
  });

  it("allows configured ALLOWED_ORIGINS with CORP: cross-origin and rejects untrusted origins", async () => {
    const worker = createWorkerHandler({
      fetchImpl: async () => new Response("{}", { status: 200 }),
    });
    const env = { ALLOWED_ORIGINS: "https://app.example.com, https://staging.example.com" };

    // Allowed cross-origin GET
    const allowedRes = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/v2/registry-1.docker.io/library/alpine/manifests/latest`, {
        headers: { Origin: "https://app.example.com" },
      }),
      env
    );
    assert.equal(allowedRes.status, 200);
    assert.equal(allowedRes.headers.get("access-control-allow-origin"), "https://app.example.com");
    assert.equal(allowedRes.headers.get("vary"), "Origin");
    assert.equal(allowedRes.headers.get("cross-origin-resource-policy"), "cross-origin");
    assert.match(allowedRes.headers.get("access-control-expose-headers"), /Docker-Content-Digest/);
    assert.match(allowedRes.headers.get("access-control-expose-headers"), /Content-Length/);

    // Allowed cross-origin OPTIONS preflight
    const allowedPreflight = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/v2/registry-1.docker.io/library/alpine/manifests/latest`, {
        method: "OPTIONS",
        headers: { Origin: "https://staging.example.com" },
      }),
      env
    );
    assert.equal(allowedPreflight.status, 204);
    assert.equal(allowedPreflight.headers.get("access-control-allow-origin"), "https://staging.example.com");
    assert.equal(allowedPreflight.headers.get("cross-origin-resource-policy"), "cross-origin");

    // Disallowed cross-origin GET (does NOT reflect origin, keeps CORP: same-origin)
    const blockedRes = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/v2/registry-1.docker.io/library/alpine/manifests/latest`, {
        headers: { Origin: "https://evil.example.com" },
      }),
      env
    );
    assert.equal(blockedRes.headers.get("access-control-allow-origin"), null);
    assert.equal(blockedRes.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(blockedRes.headers.get("vary"), "Origin");

    // Disallowed cross-origin OPTIONS preflight -> 403
    const blockedPreflight = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/v2/registry-1.docker.io/library/alpine/manifests/latest`, {
        method: "OPTIONS",
        headers: { Origin: "https://evil.example.com" },
      }),
      env
    );
    assert.equal(blockedPreflight.status, 403);
    assert.equal(blockedPreflight.headers.get("access-control-allow-origin"), null);
  });
});

describe("Cloudflare Worker: Static Assets Fallback (env.ASSETS)", () => {
  it("delegates non-/api/* routes to env.ASSETS.fetch when present", async () => {
    const worker = createWorkerHandler();
    let delegatedUrl = null;
    const fakeAssets = {
      async fetch(req) {
        delegatedUrl = req.url;
        return new Response("<html>elf2wasm</html>", {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      },
    };

    const res = await worker.fetch(new Request(`${WORKER_ORIGIN}/`), { ASSETS: fakeAssets });
    assert.equal(res.status, 200);
    assert.equal(delegatedUrl, `${WORKER_ORIGIN}/`);
    assert.equal(await res.text(), "<html>elf2wasm</html>");
  });

  it("returns 404 JSON for non-/api/* routes when env.ASSETS is absent", async () => {
    const worker = createWorkerHandler();
    const res = await worker.fetch(new Request(`${WORKER_ORIGIN}/unknown`), {});
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "Not Found" });
  });
});

describe("Static Assets Staging Script (worker/scripts/build_assets.mjs)", () => {
  it("stages index.html, web/*, runtime js/*.mjs, wasm/*.wasm, worker/src/elf2wasm_worker_wasm.wasm, and _headers", async () => {
    const scratchRoot = path.join(REPO_ROOT, "worker", ".wrangler", `test-stage-${Date.now()}`);
    const fakeWasmDir = path.join(scratchRoot, "wasm-src");
    const testDistDir = path.join(scratchRoot, "dist");
    const testWorkerSrcDir = path.join(scratchRoot, "worker-src");
    const silentLogger = { log() {} };

    try {
      await fs.mkdir(fakeWasmDir, { recursive: true });
      const wasmMagic = Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
      for (const name of [...WASM_FILES, WORKER_WASM_FILE]) {
        await fs.writeFile(path.join(fakeWasmDir, name), wasmMagic);
      }

      const result = await buildAssets({
        repoRoot: REPO_ROOT,
        distDir: testDistDir,
        workerSrcDir: testWorkerSrcDir,
        wasmDir: fakeWasmDir,
        logger: silentLogger,
      });

      // Verify index.html & web/*
      const rootIndex = await fs.readFile(path.join(testDistDir, "index.html"), "utf8");
      const webIndex = await fs.readFile(path.join(testDistDir, "web", "index.html"), "utf8");
      assert.equal(rootIndex, webIndex);
      assert.match(rootIndex, /data-image="ghcr\.io\/fatlotus\/golang-with-cache:1\.27-alpine"/);
      assert.match(webIndex, /data-image="ghcr\.io\/fatlotus\/golang-with-cache:1\.27-alpine"/);
      await fs.access(path.join(testDistDir, "web", "app.mjs"));
      await fs.access(path.join(testDistDir, "web", "url_state.mjs"));
      await fs.access(path.join(testDistDir, "web", "styles.css"));
      await fs.access(path.join(testDistDir, "web", "terminal.mjs"));
      const stagedWebFiles = await fs.readdir(path.join(testDistDir, "web"));
      for (const name of stagedWebFiles) {
        assert.ok(
          !/^(test_|\.test\.)/i.test(name) && !/\.test\.mjs$/i.test(name),
          `Test file must not be staged in worker/dist/web/: ${name}`
        );
      }

      // Verify runtime js/*.mjs staged and test/CLI files excluded
      for (const jsFile of BROWSER_JS_FILES) {
        await fs.access(path.join(testDistDir, "js", jsFile));
      }
      await assert.rejects(() => fs.access(path.join(testDistDir, "js", "cli.mjs")));
      await assert.rejects(() => fs.access(path.join(testDistDir, "js", "test_docker_sdk.mjs")));
      await assert.rejects(() => fs.access(path.join(testDistDir, "js", "test_url_state.mjs")));

      // Verify browser WASM files staged in dist/wasm/ with exact bytes
      for (const wasmFile of WASM_FILES) {
        const bytes = await fs.readFile(path.join(testDistDir, "wasm", wasmFile));
        assert.deepEqual(Array.from(bytes), Array.from(wasmMagic));
        assert.equal(result.wasmSizes[wasmFile], wasmMagic.byteLength);
      }

      // Verify Worker WASM staged in workerSrcDir and NOT in public dist/wasm/
      const workerWasmBytes = await fs.readFile(path.join(testWorkerSrcDir, WORKER_WASM_FILE));
      assert.deepEqual(Array.from(workerWasmBytes), Array.from(wasmMagic));
      assert.equal(result.wasmSizes[WORKER_WASM_FILE], wasmMagic.byteLength);
      await assert.rejects(() => fs.access(path.join(testDistDir, "wasm", WORKER_WASM_FILE)));

      // Verify _headers
      const headersContent = await fs.readFile(path.join(testDistDir, "_headers"), "utf8");
      assert.equal(headersContent, STATIC_HEADERS_CONTENT);
      assert.match(headersContent, /Cross-Origin-Opener-Policy: same-origin/);
      assert.match(headersContent, /Cross-Origin-Embedder-Policy: require-corp/);
      assert.match(headersContent, /Cross-Origin-Resource-Policy: same-origin/);
      assert.match(headersContent, /X-Content-Type-Options: nosniff/);
    } finally {
      await fs.rm(scratchRoot, { recursive: true, force: true });
    }
  });

  it("throws a clear error when required WASM artifacts are missing", async () => {
    const scratchRoot = path.join(REPO_ROOT, "worker", ".wrangler", `test-missing-${Date.now()}`);
    const emptyWasmDir = path.join(scratchRoot, "empty-wasm");
    const testDistDir = path.join(scratchRoot, "dist");
    const silentLogger = { log() {} };

    try {
      await fs.mkdir(emptyWasmDir, { recursive: true });
      await assert.rejects(
        () =>
          buildAssets({
            repoRoot: REPO_ROOT,
            distDir: testDistDir,
            wasmDir: emptyWasmDir,
            logger: silentLogger,
          }),
        /Missing required WASM artifact/
      );
    } finally {
      await fs.rm(scratchRoot, { recursive: true, force: true });
    }
  });
});

describe("Cloudflare Worker: Docker Hub 429 Mirror Fallback", () => {
  it("falls back to mirror.gcr.io when registry-1.docker.io returns 429 and uses cooldown", async () => {
    const requestedUrls = [];
    const tracked429 = makeTrackedResponse(["toomanyrequests"], { status: 429 });
    const manifestPayload = JSON.stringify({ schemaVersion: 2, mirrored: true });

    const worker = createWorkerHandler({
      fetchImpl: async (url) => {
        requestedUrls.push(url);
        if (url.startsWith("https://registry-1.docker.io/")) {
          return tracked429.response;
        }
        if (url.startsWith("https://mirror.gcr.io/")) {
          return new Response(manifestPayload, {
            status: 200,
            headers: {
              "Content-Type": "application/vnd.oci.image.index.v1+json",
              "Docker-Content-Digest": VALID_DIGEST,
            },
          });
        }
        return new Response("unexpected", { status: 500 });
      },
    });

    // First request hits Docker Hub -> 429 -> falls back to mirror.gcr.io -> 200
    const res1 = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/v2/registry-1.docker.io/library/alpine/manifests/latest`)
    );
    assert.equal(res1.status, 200);
    assert.equal(await res1.text(), manifestPayload);
    assert.equal(tracked429.wasCanceled(), true, "429 response body must be canceled");
    assert.deepEqual(requestedUrls, [
      "https://registry-1.docker.io/v2/library/alpine/manifests/latest",
      "https://mirror.gcr.io/v2/library/alpine/manifests/latest",
    ]);

    // Second request within cooldown goes directly to mirror.gcr.io
    const res2 = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/v2/registry-1.docker.io/library/alpine/blobs/${VALID_DIGEST}`)
    );
    assert.equal(res2.status, 200);
    assert.equal(requestedUrls.length, 3);
    assert.equal(
      requestedUrls[2],
      `https://mirror.gcr.io/v2/library/alpine/blobs/${VALID_DIGEST}`
    );
  });

  it("falls back to mirror.gcr.io when Docker Hub auth server returns 429", async () => {
    const requestedUrls = [];
    const worker = createWorkerHandler({
      fetchImpl: async (url) => {
        requestedUrls.push(url);
        if (url.startsWith("https://registry-1.docker.io/")) {
          return new Response("unauthorized", {
            status: 401,
            headers: {
              "WWW-Authenticate":
                'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/alpine:pull"',
            },
          });
        }
        if (url.startsWith("https://auth.docker.io/token")) {
          return new Response("rate limited", { status: 429 });
        }
        if (url.startsWith("https://mirror.gcr.io/")) {
          return new Response('{"mirrored":true}', {
            status: 200,
            headers: { "Content-Type": "application/vnd.oci.image.index.v1+json" },
          });
        }
        return new Response("unexpected", { status: 500 });
      },
    });

    const res = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/v2/registry-1.docker.io/library/alpine/manifests/latest`)
    );
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '{"mirrored":true}');
    assert.equal(requestedUrls.length, 3);
    assert.equal(requestedUrls[2], "https://mirror.gcr.io/v2/library/alpine/manifests/latest");
  });

  it("does not fall back for non-Docker-Hub registries or when DOCKER_HUB_MIRROR is empty", async () => {
    const requestedUrls = [];
    const worker = createWorkerHandler({
      fetchImpl: async (url) => {
        requestedUrls.push(url);
        return new Response("rate limited", { status: 429 });
      },
    });

    // Non-Docker-Hub registry returns 429 directly
    const ghcrRes = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/v2/ghcr.io/owner/app/manifests/latest`)
    );
    assert.equal(ghcrRes.status, 429);
    assert.deepEqual(requestedUrls, ["https://ghcr.io/v2/owner/app/manifests/latest"]);

    // Docker Hub with mirror disabled via env returns 429 directly
    const disabledRes = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/v2/registry-1.docker.io/library/alpine/manifests/latest`),
      { DOCKER_HUB_MIRROR: "" }
    );
    assert.equal(disabledRes.status, 429);
    assert.equal(requestedUrls.length, 2);
  });
});

describe("Cloudflare Worker: Edge Cache (caches.default)", () => {
  function createMemoryCache() {
    const store = new Map();
    return {
      store,
      async match(req) {
        const key = typeof req === "string" ? req : req.url;
        const entry = store.get(key);
        if (!entry) return undefined;
        return new Response(entry.body.slice(0), {
          status: entry.status,
          headers: new Headers(entry.headers),
        });
      },
      async put(req, res) {
        const key = typeof req === "string" ? req : req.url;
        const buf = new Uint8Array(await res.arrayBuffer());
        store.set(key, {
          status: res.status,
          headers: new Headers(res.headers),
          body: buf,
        });
      },
    };
  }

  it("caches blobs with immutable TTL, re-applies per-origin CORS headers, and serves HEAD hits", async () => {
    const cache = createMemoryCache();
    let upstreamCalls = 0;
    const blobBytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const waitUntilPromises = [];
    const ctx = { waitUntil: (p) => waitUntilPromises.push(p) };

    const worker = createWorkerHandler({
      cache,
      allowedOrigins: "https://a.example.com,https://b.example.com",
      fetchImpl: async () => {
        upstreamCalls++;
        return new Response(blobBytes, {
          status: 200,
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(blobBytes.byteLength),
            "Docker-Content-Digest": VALID_DIGEST,
          },
        });
      },
    });

    const blobUrl = `${WORKER_ORIGIN}/api/v2/registry-1.docker.io/library/alpine/blobs/${VALID_DIGEST}`;

    // 1. Cache miss from origin A
    const res1 = await worker.fetch(
      new Request(blobUrl, { headers: { Origin: "https://a.example.com" } }),
      {},
      ctx
    );
    assert.equal(res1.status, 200);
    assert.equal(res1.headers.get("access-control-allow-origin"), "https://a.example.com");
    assert.deepEqual(Array.from(new Uint8Array(await res1.arrayBuffer())), Array.from(blobBytes));
    await Promise.all(waitUntilPromises);

    assert.equal(upstreamCalls, 1);
    assert.equal(cache.store.size, 1);
    const cachedEntry = Array.from(cache.store.values())[0];
    assert.equal(cachedEntry.headers.get("cache-control"), "public, max-age=604800, immutable");
    assert.equal(cachedEntry.headers.get("access-control-allow-origin"), null);
    assert.equal(cachedEntry.headers.get("vary"), null);

    // 2. Cache hit from origin B gets origin B's CORS header without hitting upstream
    const res2 = await worker.fetch(
      new Request(blobUrl, { headers: { Origin: "https://b.example.com" } }),
      {},
      ctx
    );
    assert.equal(res2.status, 200);
    assert.equal(upstreamCalls, 1);
    assert.equal(res2.headers.get("access-control-allow-origin"), "https://b.example.com");
    assert.equal(res2.headers.get("cross-origin-resource-policy"), "cross-origin");
    assert.deepEqual(Array.from(new Uint8Array(await res2.arrayBuffer())), Array.from(blobBytes));

    // 3. HEAD request hits cache and returns empty body with Content-Length
    const res3 = await worker.fetch(new Request(blobUrl, { method: "HEAD" }), {}, ctx);
    assert.equal(res3.status, 200);
    assert.equal(upstreamCalls, 1);
    assert.equal(res3.headers.get("content-length"), "6");
    assert.equal(await res3.text(), "");
  });

  it("caches mutable tag manifests with 5-minute TTL and separates cache keys by Accept header", async () => {
    const cache = createMemoryCache();
    let upstreamCalls = 0;
    const waitUntilPromises = [];
    const ctx = { waitUntil: (p) => waitUntilPromises.push(p) };

    const worker = createWorkerHandler({
      cache,
      fetchImpl: async (_url, init) => {
        upstreamCalls++;
        const accept = new Headers(init.headers).get("accept");
        return new Response(JSON.stringify({ accept }), {
          status: 200,
          headers: { "Content-Type": "application/vnd.oci.image.index.v1+json" },
        });
      },
    });

    const manifestUrl = `${WORKER_ORIGIN}/api/v2/registry-1.docker.io/library/alpine/manifests/latest`;

    const r1 = await worker.fetch(
      new Request(manifestUrl, {
        headers: { Accept: "application/vnd.oci.image.index.v1+json" },
      }),
      {},
      ctx
    );
    assert.equal(r1.status, 200);
    assert.deepEqual(await r1.json(), { accept: "application/vnd.oci.image.index.v1+json" });
    await Promise.all(waitUntilPromises);

    const r2 = await worker.fetch(
      new Request(manifestUrl, {
        headers: { Accept: "application/vnd.docker.distribution.manifest.v2+json" },
      }),
      {},
      ctx
    );
    assert.equal(r2.status, 200);
    assert.deepEqual(await r2.json(), {
      accept: "application/vnd.docker.distribution.manifest.v2+json",
    });
    await Promise.all(waitUntilPromises);

    assert.equal(upstreamCalls, 2);
    assert.equal(cache.store.size, 2);
    for (const entry of cache.store.values()) {
      assert.equal(entry.headers.get("cache-control"), "public, max-age=300");
    }

    // Repeat first Accept -> cache hit
    const r3 = await worker.fetch(
      new Request(manifestUrl, {
        headers: { Accept: "application/vnd.oci.image.index.v1+json" },
      }),
      {},
      ctx
    );
    assert.equal(r3.status, 200);
    assert.equal(upstreamCalls, 2);
    assert.deepEqual(await r3.json(), { accept: "application/vnd.oci.image.index.v1+json" });
  });
});

describe("Cloudflare Worker: /api/git/archive Proxy", () => {
  const FULL_SHA = "0123456789abcdef0123456789abcdef01234567";
  const FAKE_GZIP = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x01, 0x02, 0x03, 0x04]);

  function createMemoryCache() {
    const store = new Map();
    return {
      store,
      async match(req) {
        const key = typeof req === "string" ? req : req.url;
        const entry = store.get(key);
        if (!entry) return undefined;
        return new Response(entry.body.slice(0), {
          status: entry.status,
          headers: new Headers(entry.headers),
        });
      },
      async put(req, res) {
        const key = typeof req === "string" ? req : req.url;
        const buf = new Uint8Array(await res.arrayBuffer());
        store.set(key, {
          status: res.status,
          headers: new Headers(res.headers),
          body: buf,
        });
      },
    };
  }

  it("streams GitHub archive across 302 cross-origin redirect, normalizes headers, and cancels redirect body", async () => {
    const seen = [];
    const redirectTracked = makeTrackedResponse("redirect body", {
      status: 302,
      headers: { Location: "https://objects.githubusercontent.com/octocat/Hello-World/HEAD.tar.gz" },
    });

    const worker = createWorkerHandler({
      fetchImpl: async (url, init) => {
        seen.push({ url, method: init.method, headers: new Headers(init.headers) });
        if (url === "https://codeload.github.com/octocat/Hello-World/tar.gz/HEAD") {
          return redirectTracked.response;
        }
        if (url === "https://objects.githubusercontent.com/octocat/Hello-World/HEAD.tar.gz") {
          return new Response(FAKE_GZIP, {
            status: 200,
            headers: {
              "Content-Type": "application/x-gzip",
              "Content-Length": String(FAKE_GZIP.byteLength),
            },
          });
        }
        throw new Error(`Unexpected upstream URL: ${url}`);
      },
    });

    const res = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/git/archive?repo=octocat/Hello-World`)
    );
    assert.equal(res.status, 200);
    assert.equal(redirectTracked.wasCanceled(), true);
    assert.equal(seen.length, 2);
    assert.equal(seen[1].headers.get("authorization"), null);
    assert.equal(res.headers.get("content-type"), "application/gzip");
    assert.equal(res.headers.get("content-length"), String(FAKE_GZIP.byteLength));
    assert.equal(res.headers.get("x-git-archive-format"), "tar.gz");
    assert.equal(res.headers.get("x-git-strip-components"), "1");
    assert.equal(res.headers.get("cache-control"), "public, max-age=300");
    assert.equal(res.headers.get("cross-origin-opener-policy"), "same-origin");
    assert.equal(res.headers.get("cross-origin-embedder-policy"), "require-corp");
    assert.equal(res.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Array.from(new Uint8Array(await res.arrayBuffer())), Array.from(FAKE_GZIP));
  });

  it("resolves GitLab nested groups, Codeberg, 40-char SHA immutable TTL, strip-components=0, HEAD, and 405", async () => {
    const seenUrls = [];
    let headTracked = null;
    const worker = createWorkerHandler({
      fetchImpl: async (url, init) => {
        seenUrls.push({ url, method: init.method });
        if (init.method === "HEAD") {
          headTracked = makeTrackedResponse("should be canceled", {
            status: 200,
            headers: {
              "Content-Type": "application/gzip",
              "Content-Length": "8",
              "X-Git-Strip-Components": "0",
            },
          });
          return headTracked.response;
        }
        return new Response(FAKE_GZIP, {
          status: 200,
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Git-Strip-Components": "0",
          },
        });
      },
    });

    // GitLab nested group + slash ref
    const glRes = await worker.fetch(
      new Request(
        `${WORKER_ORIGIN}/api/git/archive?repo=${encodeURIComponent(
          "https://gitlab.com/org/sub/proj.git"
        )}&ref=${encodeURIComponent("feature/foo")}`
      )
    );
    assert.equal(glRes.status, 200);
    assert.equal(
      seenUrls[0].url,
      "https://gitlab.com/org/sub/proj/-/archive/feature/foo/proj-feature-foo.tar.gz"
    );
    assert.equal(glRes.headers.get("x-git-strip-components"), "0");
    assert.equal(glRes.headers.get("cache-control"), "public, max-age=300");

    // Codeberg + 40-char SHA immutable
    const cbRes = await worker.fetch(
      new Request(
        `${WORKER_ORIGIN}/api/git/archive?repo=${encodeURIComponent(
          "https://codeberg.org/alice/demo"
        )}&ref=${FULL_SHA}`
      )
    );
    assert.equal(cbRes.status, 200);
    assert.equal(
      seenUrls[1].url,
      `https://codeberg.org/alice/demo/archive/${FULL_SHA}.tar.gz`
    );
    assert.equal(cbRes.headers.get("cache-control"), "public, max-age=604800, immutable");

    // HEAD cancels upstream body and returns empty response
    const headRes = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/git/archive?repo=octocat/Hello-World&ref=main`, {
        method: "HEAD",
      })
    );
    assert.equal(headRes.status, 200);
    assert.equal(headTracked.wasCanceled(), true);
    assert.equal(headRes.headers.get("content-length"), "8");
    assert.equal(headRes.headers.get("x-git-strip-components"), "0");
    assert.equal(await headRes.text(), "");

    // POST -> 405
    const postRes = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/git/archive?repo=octocat/Hello-World`, {
        method: "POST",
      })
    );
    assert.equal(postRes.status, 405);
    assert.equal(postRes.headers.get("allow"), "GET, HEAD, OPTIONS");
  });

  it("enforces 400 validation, 403 SSRF, ALLOW_LOCAL_REGISTRIES env toggle, and redirect SSRF", async () => {
    let fetchCalls = 0;
    const ssrfRedirect = makeTrackedResponse("ssrf", {
      status: 302,
      headers: { Location: "http://169.254.169.254/latest/meta-data" },
    });

    const worker = createWorkerHandler({
      fetchImpl: async (url) => {
        fetchCalls++;
        if (url === "https://codeload.github.com/evil/repo/tar.gz/HEAD") {
          return ssrfRedirect.response;
        }
        return new Response(FAKE_GZIP, { status: 200 });
      },
    });

    // 400 invalid inputs (must not call fetchImpl)
    for (const q of [
      "",
      "?repo=onlyowner",
      "?repo=https%3A%2F%2Fexample.com%2Fa%2Fb",
      "?repo=octocat/Hello-World&ref=-bad",
      "?repo=octocat/Hello-World&ref=a..b",
      `?repo=${encodeURIComponent("https://user:pass@github.com/a/b")}`,
      `?repo=${encodeURIComponent("http://github.com/a/b")}`,
      `?repo=${encodeURIComponent("ftp://github.com/a/b")}`,
      `?repo=${encodeURIComponent("file:///etc/passwd")}`,
      `?repo=${encodeURIComponent("javascript:alert(1)")}`,
    ]) {
      const r = await worker.fetch(new Request(`${WORKER_ORIGIN}/api/git/archive${q}`));
      assert.equal(r.status, 400, `Expected 400 for query ${q}`);
    }
    assert.equal(fetchCalls, 0);

    // 403 SSRF when ALLOW_LOCAL_REGISTRIES is unset
    for (const repo of [
      "http://127.0.0.1:5050/org/demo",
      "https://169.254.169.254/org/demo",
    ]) {
      const r = await worker.fetch(
        new Request(`${WORKER_ORIGIN}/api/git/archive?repo=${encodeURIComponent(repo)}`)
      );
      assert.equal(r.status, 403, `Expected 403 for repo ${repo}`);
    }
    assert.equal(fetchCalls, 0);

    // Loopback allowed with env.ALLOW_LOCAL_REGISTRIES="1", IMDS still 403
    const rLocal = await worker.fetch(
      new Request(
        `${WORKER_ORIGIN}/api/git/archive?repo=${encodeURIComponent("http://127.0.0.1:5050/org/demo")}`
      ),
      { ALLOW_LOCAL_REGISTRIES: "1" }
    );
    assert.equal(rLocal.status, 200);
    assert.equal(fetchCalls, 1);

    const rImds = await worker.fetch(
      new Request(
        `${WORKER_ORIGIN}/api/git/archive?repo=${encodeURIComponent("https://169.254.169.254/org/demo")}`
      ),
      { ALLOW_LOCAL_REGISTRIES: "1" }
    );
    assert.equal(rImds.status, 403);

    // Redirect to IMDS -> 403 and redirect body canceled
    const rRedirSsrf = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/git/archive?repo=evil/repo`)
    );
    assert.equal(rRedirSsrf.status, 403);
    assert.equal(ssrfRedirect.wasCanceled(), true);
  });

  it("maps upstream 404, 429, 500, network failure, and redirect loop with body cancellation", async () => {
    const tracked404 = makeTrackedResponse("not found", { status: 404 });
    const tracked429 = makeTrackedResponse("rate limited", {
      status: 429,
      headers: { "Retry-After": "45" },
    });
    const tracked500 = makeTrackedResponse("boom", { status: 500 });

    const worker = createWorkerHandler({
      maxRedirects: 2,
      fetchImpl: async (url) => {
        if (url.includes("/tar.gz/missing")) return tracked404.response;
        if (url.includes("/tar.gz/ratelimit")) return tracked429.response;
        if (url.includes("/tar.gz/fail500")) return tracked500.response;
        if (url.includes("/tar.gz/neterr")) throw new Error("ECONNRESET");
        if (url.includes("/tar.gz/loop")) {
          return new Response(null, { status: 302, headers: { Location: url } });
        }
        return new Response(FAKE_GZIP, { status: 200 });
      },
    });

    const r404 = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/git/archive?repo=octocat/Hello-World&ref=missing`)
    );
    assert.equal(r404.status, 404);
    assert.equal(tracked404.wasCanceled(), true);

    const r429 = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/git/archive?repo=octocat/Hello-World&ref=ratelimit`)
    );
    assert.equal(r429.status, 429);
    assert.equal(r429.headers.get("retry-after"), "45");
    assert.equal(tracked429.wasCanceled(), true);

    const r500 = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/git/archive?repo=octocat/Hello-World&ref=fail500`)
    );
    assert.equal(r500.status, 502);
    assert.equal(tracked500.wasCanceled(), true);

    const rNet = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/git/archive?repo=octocat/Hello-World&ref=neterr`)
    );
    assert.equal(rNet.status, 502);

    const rLoop = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/git/archive?repo=octocat/Hello-World&ref=loop`)
    );
    assert.equal(rLoop.status, 502);
  });

  it("handles CORS, CORP, exposed git headers, and OPTIONS preflight on /api/git/archive", async () => {
    const worker = createWorkerHandler({
      allowedOrigins: "https://app.example.com",
      fetchImpl: async () => new Response(FAKE_GZIP, { status: 200 }),
    });

    // Allowed cross-origin OPTIONS -> 204
    const optOk = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/git/archive?repo=octocat/Hello-World`, {
        method: "OPTIONS",
        headers: { Origin: "https://app.example.com" },
      })
    );
    assert.equal(optOk.status, 204);
    assert.equal(optOk.headers.get("access-control-allow-origin"), "https://app.example.com");
    assert.equal(optOk.headers.get("cross-origin-resource-policy"), "cross-origin");
    const exposed = optOk.headers.get("access-control-expose-headers") || "";
    assert.ok(exposed.includes("X-Git-Archive-Format"));
    assert.ok(exposed.includes("X-Git-Strip-Components"));

    // Disallowed cross-origin OPTIONS -> 403
    const optDenied = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/git/archive?repo=octocat/Hello-World`, {
        method: "OPTIONS",
        headers: { Origin: "https://evil.example.com" },
      })
    );
    assert.equal(optDenied.status, 403);

    // Disallowed GET omits ACAO and keeps CORP same-origin
    const getDenied = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/git/archive?repo=octocat/Hello-World`, {
        headers: { Origin: "https://evil.example.com" },
      })
    );
    assert.equal(getDenied.status, 200);
    assert.equal(getDenied.headers.get("access-control-allow-origin"), null);
    assert.equal(getDenied.headers.get("cross-origin-resource-policy"), "same-origin");
  });

  it("caches immutable/mutable git archives in caches.default with multi-origin isolation and HEAD semantics", async () => {
    const cache = createMemoryCache();
    let upstreamCalls = 0;
    const waitUntilPromises = [];
    const ctx = { waitUntil: (p) => waitUntilPromises.push(p) };

    const worker = createWorkerHandler({
      cache,
      allowedOrigins: "https://a.example.com,https://b.example.com",
      fetchImpl: async () => {
        upstreamCalls++;
        return new Response(FAKE_GZIP, {
          status: 200,
          headers: {
            "Content-Type": "application/x-gzip",
            "Content-Length": String(FAKE_GZIP.byteLength),
          },
        });
      },
    });

    // 1. HEAD miss must NOT populate cache
    const headMiss = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/git/archive?repo=octocat/Hello-World&ref=${FULL_SHA}`, {
        method: "HEAD",
      }),
      {},
      ctx
    );
    assert.equal(headMiss.status, 200);
    assert.equal(upstreamCalls, 1);
    assert.equal(cache.store.size, 0);

    // 2. GET miss from Origin A populates cache with immutable TTL and no ACAO/Vary in cache
    const res1 = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/git/archive?repo=octocat/Hello-World&ref=${FULL_SHA}`, {
        headers: { Origin: "https://a.example.com" },
      }),
      {},
      ctx
    );
    assert.equal(res1.status, 200);
    assert.equal(res1.headers.get("access-control-allow-origin"), "https://a.example.com");
    assert.deepEqual(Array.from(new Uint8Array(await res1.arrayBuffer())), Array.from(FAKE_GZIP));
    await Promise.all(waitUntilPromises);

    assert.equal(upstreamCalls, 2);
    assert.equal(cache.store.size, 1);
    const cachedEntry = Array.from(cache.store.values())[0];
    assert.equal(cachedEntry.headers.get("cache-control"), "public, max-age=604800, immutable");
    assert.equal(cachedEntry.headers.get("access-control-allow-origin"), null);
    assert.equal(cachedEntry.headers.get("vary"), null);

    // 3. Equivalent full GitHub URL from Origin B hits same cache key and gets Origin B's CORS headers
    const res2 = await worker.fetch(
      new Request(
        `${WORKER_ORIGIN}/api/git/archive?repo=${encodeURIComponent(
          "https://github.com/octocat/Hello-World.git"
        )}&ref=${FULL_SHA.toUpperCase()}`,
        { headers: { Origin: "https://b.example.com" } }
      ),
      {},
      ctx
    );
    assert.equal(res2.status, 200);
    assert.equal(upstreamCalls, 2);
    assert.equal(res2.headers.get("access-control-allow-origin"), "https://b.example.com");
    assert.equal(res2.headers.get("x-git-strip-components"), "1");
    assert.deepEqual(Array.from(new Uint8Array(await res2.arrayBuffer())), Array.from(FAKE_GZIP));

    // 4. HEAD hits cached GET entry
    const headHit = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/git/archive?repo=octocat/Hello-World&ref=${FULL_SHA}`, {
        method: "HEAD",
      }),
      {},
      ctx
    );
    assert.equal(headHit.status, 200);
    assert.equal(upstreamCalls, 2);
    assert.equal(headHit.headers.get("content-length"), String(FAKE_GZIP.byteLength));
    assert.equal(await headHit.text(), "");

    // 5. Mutable branch ref cached with 5-minute TTL
    const resBranch = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/git/archive?repo=octocat/Hello-World&ref=main`),
      {},
      ctx
    );
    assert.equal(resBranch.status, 200);
    await resBranch.arrayBuffer();
    await Promise.all(waitUntilPromises);
    assert.equal(upstreamCalls, 3);
    assert.equal(cache.store.size, 2);
    const branchEntry = Array.from(cache.store.values())[1];
    assert.equal(branchEntry.headers.get("cache-control"), "public, max-age=300");
  });
});

describe("Cloudflare Worker: M13 Phase 2 Adversarial Regressions (BUG-A1, A2, A3)", () => {
  const FAKE_GZIP = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xca, 0xfe]);
  const FULL_SHA = "0123456789abcdef0123456789abcdef01234567";

  it("BUG-A1: strips #fragment from Request URLs on /api/git/archive for both repo and ref", async () => {
    const requestedUrls = [];
    const worker = createWorkerHandler({
      fetchImpl: async (url) => {
        requestedUrls.push(String(url));
        return new Response(FAKE_GZIP, { status: 200 });
      },
    });

    const r1 = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/git/archive?repo=octocat/Hello-World#frag`)
    );
    assert.equal(r1.status, 200);
    assert.equal(requestedUrls[0], "https://codeload.github.com/octocat/Hello-World/tar.gz/HEAD");

    const r2 = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/git/archive?repo=octocat/Hello-World&ref=main#frag`)
    );
    assert.equal(r2.status, 200);
    assert.equal(requestedUrls[1], "https://codeload.github.com/octocat/Hello-World/tar.gz/main");
  });

  it("BUG-A2: emits Vary: Origin even when Origin header is absent if ALLOWED_ORIGINS is configured", async () => {
    const workerWithAllowed = createWorkerHandler({
      allowedOrigins: "https://app.example.com",
      fetchImpl: async () => new Response(FAKE_GZIP, { status: 200 }),
    });

    const noOriginRes = await workerWithAllowed.fetch(
      new Request(`${WORKER_ORIGIN}/api/git/archive?repo=octocat/Hello-World&ref=${FULL_SHA}`)
    );
    assert.equal(noOriginRes.status, 200);
    assert.equal(noOriginRes.headers.get("vary"), "Origin");
    assert.equal(noOriginRes.headers.get("access-control-allow-origin"), null);
    assert.equal(noOriginRes.headers.get("cross-origin-resource-policy"), "same-origin");

    const withOriginRes = await workerWithAllowed.fetch(
      new Request(`${WORKER_ORIGIN}/api/git/archive?repo=octocat/Hello-World&ref=${FULL_SHA}`, {
        headers: { Origin: "https://app.example.com" },
      })
    );
    assert.equal(withOriginRes.status, 200);
    assert.equal(withOriginRes.headers.get("vary"), "Origin");
    assert.equal(withOriginRes.headers.get("access-control-allow-origin"), "https://app.example.com");
    assert.equal(withOriginRes.headers.get("cross-origin-resource-policy"), "cross-origin");

    // When ALLOWED_ORIGINS is unset and Origin is absent, Vary: Origin is not needed
    const workerNoAllowed = createWorkerHandler({
      fetchImpl: async () => new Response(FAKE_GZIP, { status: 200 }),
    });
    const plainRes = await workerNoAllowed.fetch(
      new Request(`${WORKER_ORIGIN}/api/git/archive?repo=octocat/Hello-World&ref=${FULL_SHA}`)
    );
    assert.equal(plainRes.status, 200);
    assert.equal(plainRes.headers.get("vary"), null);
  });

  it("BUG-A3: maps upstream 204/206 to 502 JSON and cancels any upstream stream body", async () => {
    // 1. 204 with null body
    const wNull = createWorkerHandler({
      fetchImpl: async () => new Response(null, { status: 204 }),
    });
    const rNull = await wNull.fetch(
      new Request(`${WORKER_ORIGIN}/api/git/archive?repo=octocat/Hello-World`)
    );
    assert.equal(rNull.status, 502);
    const jNull = await rNull.json();
    assert.match(jNull.error, /HTTP 204/);

    // 2. 204-like object with tracked ReadableStream body -> must cancel stream & return 502
    let streamCanceled = false;
    const trackedStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
      cancel() {
        streamCanceled = true;
      },
    });
    const wStream = createWorkerHandler({
      fetchImpl: async () => ({ status: 204, headers: new Headers(), body: trackedStream }),
    });
    const rStream = await wStream.fetch(
      new Request(`${WORKER_ORIGIN}/api/git/archive?repo=octocat/Hello-World`)
    );
    assert.equal(rStream.status, 502);
    assert.equal(streamCanceled, true, "Upstream 204 stream body must be canceled");

    // 3. 206 Partial Content -> 502 with canceled body
    const tracked206 = makeTrackedResponse([FAKE_GZIP], { status: 206 });
    const w206 = createWorkerHandler({
      fetchImpl: async () => tracked206.response,
    });
    const r206 = await w206.fetch(
      new Request(`${WORKER_ORIGIN}/api/git/archive?repo=octocat/Hello-World`)
    );
    assert.equal(r206.status, 502);
    assert.equal(tracked206.wasCanceled(), true);
  });

  it("blocks adversarial redirect targets, sanitizes Retry-After/strip-components, enforces HEAD parity, and survives sync cache.put throws", async () => {
    const blockedRedirects = [
      "//169.254.169.254/latest/meta-data",
      "file:///etc/passwd",
      "ftp://evil.example/a.tar.gz",
      "http://evil.example/a.tar.gz",
      "https://user:pass@codeload.github.com/a/b",
      "http://[::ffff:127.0.0.1]/secret",
    ];
    for (const loc of blockedRedirects) {
      const worker = createWorkerHandler({
        allowLocalRegistries: true,
        fetchImpl: async () => new Response(null, { status: 302, headers: { Location: loc } }),
      });
      const res = await worker.fetch(
        new Request(`${WORKER_ORIGIN}/api/git/archive?repo=octocat/Hello-World`)
      );
      assert.equal(res.status, 403, `Expected 403 for redirect Location=${loc}, got ${res.status}`);
    }

    // 302 without Location -> 502
    const wNoLoc = createWorkerHandler({
      fetchImpl: async () => new Response(null, { status: 302 }),
    });
    const rNoLoc = await wNoLoc.fetch(
      new Request(`${WORKER_ORIGIN}/api/git/archive?repo=octocat/Hello-World`)
    );
    assert.equal(rNoLoc.status, 502);

    // 429 unsafe Retry-After omitted
    const wUnsafeRetry = createWorkerHandler({
      fetchImpl: async () =>
        new Response("rate limited", {
          status: 429,
          headers: { "Retry-After": "9".repeat(70) },
        }),
    });
    const rUnsafeRetry = await wUnsafeRetry.fetch(
      new Request(`${WORKER_ORIGIN}/api/git/archive?repo=octocat/Hello-World`)
    );
    assert.equal(rUnsafeRetry.status, 429);
    assert.equal(rUnsafeRetry.headers.get("retry-after"), null);

    // Invalid X-Git-Strip-Components falls back to 1
    for (const badStrip of ["-1", "99", "abc"]) {
      const wStrip = createWorkerHandler({
        fetchImpl: async () =>
          new Response(FAKE_GZIP, {
            status: 200,
            headers: { "X-Git-Strip-Components": badStrip },
          }),
      });
      const rStrip = await wStrip.fetch(
        new Request(`${WORKER_ORIGIN}/api/git/archive?repo=octocat/Hello-World`)
      );
      assert.equal(rStrip.status, 200);
      assert.equal(rStrip.headers.get("x-git-strip-components"), "1");
    }

    // HEAD error parity (400, 403, 404, 429, 502)
    const headSpecs = [
      { url: `${WORKER_ORIGIN}/api/git/archive`, status: 400, upstream: 200 },
      {
        url: `${WORKER_ORIGIN}/api/git/archive?repo=${encodeURIComponent("https://0x7f000001/a/b")}`,
        status: 403,
        upstream: 200,
      },
      { url: `${WORKER_ORIGIN}/api/git/archive?repo=octocat/Hello-World`, status: 404, upstream: 404 },
      { url: `${WORKER_ORIGIN}/api/git/archive?repo=octocat/Hello-World`, status: 429, upstream: 429 },
      { url: `${WORKER_ORIGIN}/api/git/archive?repo=octocat/Hello-World`, status: 502, upstream: 204 },
    ];
    for (const spec of headSpecs) {
      const w = createWorkerHandler({
        fetchImpl: async () => new Response(null, { status: spec.upstream }),
      });
      const r = await w.fetch(new Request(spec.url, { method: "HEAD" }));
      assert.equal(r.status, spec.status, `HEAD ${spec.url}`);
      assert.equal(r.headers.get("cross-origin-opener-policy"), "same-origin");
      assert.equal(r.headers.get("cross-origin-embedder-policy"), "require-corp");
      assert.equal(r.headers.get("x-content-type-options"), "nosniff");
      assert.ok(Number(r.headers.get("content-length")) > 0);
      assert.equal(await r.text(), "");
    }

    // Synchronous throw in edgeCache.put must not break a 200 streaming response
    const brokenCache = {
      async match() {
        return undefined;
      },
      put() {
        throw new Error("cache storage quota exceeded synchronously");
      },
    };
    const wSyncCache = createWorkerHandler({
      cache: brokenCache,
      fetchImpl: async () => new Response(FAKE_GZIP, { status: 200 }),
    });
    const rSyncCache = await wSyncCache.fetch(
      new Request(`${WORKER_ORIGIN}/api/git/archive?repo=octocat/Hello-World&ref=${FULL_SHA}`)
    );
    assert.equal(rSyncCache.status, 200);
    assert.deepEqual(
      Array.from(new Uint8Array(await rSyncCache.arrayBuffer())),
      Array.from(FAKE_GZIP)
    );
  });

  it("GAP-1: strips #fragment from edge cache keys on both /api/git/archive and /api/v2/*", async () => {
    const store = new Map();
    const cache = {
      store,
      async match(req) {
        const key = typeof req === "string" ? req : req.url;
        const entry = store.get(key);
        if (!entry) return undefined;
        return new Response(entry.body.slice(0), {
          status: entry.status,
          headers: new Headers(entry.headers),
        });
      },
      async put(req, res) {
        const key = typeof req === "string" ? req : req.url;
        const buf = new Uint8Array(await res.arrayBuffer());
        store.set(key, {
          status: res.status,
          headers: new Headers(res.headers),
          body: buf,
        });
      },
    };
    let gitUpstreamCalls = 0;
    let ociUpstreamCalls = 0;
    const waitUntilPromises = [];
    const ctx = { waitUntil: (p) => waitUntilPromises.push(p) };

    const worker = createWorkerHandler({
      cache,
      fetchImpl: async (url) => {
        if (url.startsWith("https://codeload.github.com/")) {
          gitUpstreamCalls++;
          return new Response(FAKE_GZIP, {
            status: 200,
            headers: {
              "Content-Type": "application/gzip",
              "Content-Length": String(FAKE_GZIP.byteLength),
            },
          });
        }
        ociUpstreamCalls++;
        return new Response(JSON.stringify({ schemaVersion: 2 }), {
          status: 200,
          headers: { "Content-Type": "application/vnd.oci.image.manifest.v1+json" },
        });
      },
    });

    // 1. /api/git/archive with and without #fragment must hit the same cache entry
    const gitBase = `${WORKER_ORIGIN}/api/git/archive?repo=octocat/Hello-World&ref=main`;
    const g1 = await worker.fetch(new Request(gitBase), {}, ctx);
    assert.equal(g1.status, 200);
    await g1.arrayBuffer();
    await Promise.all(waitUntilPromises.splice(0));

    const g2 = await worker.fetch(new Request(`${gitBase}#frag`), {}, ctx);
    assert.equal(g2.status, 200);
    await g2.arrayBuffer();
    await Promise.all(waitUntilPromises.splice(0));

    assert.equal(gitUpstreamCalls, 1, "Fragment-bearing /api/git/archive URL must hit edge cache");
    assert.equal(cache.store.size, 1);

    // 2. /api/v2/* with and without #fragment must hit the same cache entry
    const ociBase = `${WORKER_ORIGIN}/api/v2/ghcr.io/org/app/manifests/latest`;
    const o1 = await worker.fetch(new Request(ociBase), {}, ctx);
    assert.equal(o1.status, 200);
    await o1.text();
    await Promise.all(waitUntilPromises.splice(0));

    const o2 = await worker.fetch(new Request(`${ociBase}#frag`), {}, ctx);
    assert.equal(o2.status, 200);
    await o2.text();
    await Promise.all(waitUntilPromises.splice(0));

    assert.equal(ociUpstreamCalls, 1, "Fragment-bearing /api/v2/* URL must hit edge cache");
    assert.equal(cache.store.size, 2);
  });

  it("GAP-2: maps /api/v2/* upstream 204/206 to 502 and cancels upstream stream body", async () => {
    // 1. 204-like response with a tracked ReadableStream body
    let streamCanceled = false;
    const trackedStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
      cancel() {
        streamCanceled = true;
      },
    });
    const w204 = createWorkerHandler({
      fetchImpl: async () => ({ status: 204, headers: new Headers(), body: trackedStream }),
    });
    const r204 = await w204.fetch(
      new Request(`${WORKER_ORIGIN}/api/v2/ghcr.io/org/app/manifests/latest`)
    );
    assert.equal(r204.status, 502);
    assert.equal(streamCanceled, true, "Upstream 204 stream body must be canceled on /api/v2/*");
    const j204 = await r204.json();
    assert.match(j204.error, /HTTP 204/);

    // 2. 206 Partial Content -> 502 with canceled body
    const tracked206 = makeTrackedResponse("partial", { status: 206 });
    const w206 = createWorkerHandler({
      fetchImpl: async () => tracked206.response,
    });
    const r206 = await w206.fetch(
      new Request(`${WORKER_ORIGIN}/api/v2/ghcr.io/org/app/manifests/latest`)
    );
    assert.equal(r206.status, 502);
    assert.equal(tracked206.wasCanceled(), true, "Upstream 206 stream body must be canceled");
    const j206 = await r206.json();
    assert.match(j206.error, /HTTP 206/);
  });

  it("GAP-3: returns empty bodies on HEAD error responses for /api/v2/* and fallback 404", async () => {
    const cases = [
      {
        label: "invalid OCI path (400)",
        url: `${WORKER_ORIGIN}/api/v2/invalid`,
        expectedStatus: 400,
        fetchImpl: async () => new Response("ok", { status: 200 }),
      },
      {
        label: "SSRF blocked registry (403)",
        url: `${WORKER_ORIGIN}/api/v2/127.0.0.1:5000/org/app/manifests/latest`,
        expectedStatus: 403,
        fetchImpl: async () => new Response("ok", { status: 200 }),
      },
      {
        label: "upstream 404 on /api/v2/*",
        url: `${WORKER_ORIGIN}/api/v2/ghcr.io/org/app/manifests/missing`,
        expectedStatus: 404,
        fetchImpl: async () => new Response("not found", { status: 404 }),
      },
      {
        label: "upstream 429 on /api/v2/*",
        url: `${WORKER_ORIGIN}/api/v2/ghcr.io/org/app/manifests/ratelimited`,
        expectedStatus: 429,
        fetchImpl: async () => new Response("slow down", { status: 429 }),
      },
      {
        label: "upstream 204 -> 502 on /api/v2/*",
        url: `${WORKER_ORIGIN}/api/v2/ghcr.io/org/app/manifests/empty`,
        expectedStatus: 502,
        fetchImpl: async () => new Response(null, { status: 204 }),
      },
      {
        label: "upstream network error -> 502 on /api/v2/*",
        url: `${WORKER_ORIGIN}/api/v2/ghcr.io/org/app/manifests/boom`,
        expectedStatus: 502,
        fetchImpl: async () => {
          throw new Error("boom");
        },
      },
      {
        label: "fallback 404 without env.ASSETS",
        url: `${WORKER_ORIGIN}/nonexistent`,
        expectedStatus: 404,
        fetchImpl: async () => new Response("ok", { status: 200 }),
      },
    ];

    for (const c of cases) {
      const worker = createWorkerHandler({ fetchImpl: c.fetchImpl });
      const res = await worker.fetch(new Request(c.url, { method: "HEAD" }), {});
      assert.equal(res.status, c.expectedStatus, c.label);
      assert.ok(Number(res.headers.get("content-length")) > 0, `${c.label}: Content-Length`);
      assert.equal(await res.text(), "", `${c.label}: HEAD body must be empty`);
    }
  });
});

// ============================================================================
// Pure-JS Synthetic x86-64 ELF64 + USTAR Tar Helpers for POST /api/eval Tests
// ============================================================================

function buildSyntheticElf64(codeBytes, dataBytes = new Uint8Array(0)) {
  const BASE_VADDR = 0x400000;
  const HEADER_SIZE = 64 + 56; // ELF64 header + 1 PT_LOAD phdr = 0x78
  const codeAligned = Math.ceil(codeBytes.length / 16) * 16;
  const totalLen = HEADER_SIZE + codeAligned + dataBytes.length;

  const buf = new Uint8Array(totalLen);
  const view = new DataView(buf.buffer);

  // ELF64 header
  buf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  view.setUint16(16, 2, true); // ET_EXEC
  view.setUint16(18, 62, true); // EM_X86_64
  view.setUint32(20, 1, true); // EV_CURRENT
  view.setBigUint64(24, BigInt(BASE_VADDR + HEADER_SIZE), true); // e_entry
  view.setBigUint64(32, 64n, true); // e_phoff
  view.setUint16(52, 64, true); // e_ehsize
  view.setUint16(54, 56, true); // e_phentsize
  view.setUint16(56, 1, true); // e_phnum

  // PT_LOAD program header at offset 64
  view.setUint32(64, 1, true); // PT_LOAD
  view.setUint32(68, 5, true); // PF_R | PF_X
  view.setBigUint64(72, 0n, true); // p_offset
  view.setBigUint64(80, BigInt(BASE_VADDR), true); // p_vaddr
  view.setBigUint64(88, BigInt(BASE_VADDR), true); // p_paddr
  view.setBigUint64(96, BigInt(totalLen), true); // p_filesz
  view.setBigUint64(104, BigInt(totalLen), true); // p_memsz
  view.setBigUint64(112, 0x1000n, true); // p_align

  buf.set(codeBytes, HEADER_SIZE);
  buf.set(dataBytes, HEADER_SIZE + codeAligned);
  return {
    elfBytes: buf,
    dataBaseVaddr: BASE_VADDR + HEADER_SIZE + codeAligned,
  };
}

function pushImm32(arr, val) {
  arr.push(val & 0xff, (val >>> 8) & 0xff, (val >>> 16) & 0xff, (val >>> 24) & 0xff);
}

/**
 * Build a real x86-64 static ELF that writes `stdoutText` to fd 1, optionally
 * creates `filePath` with `fileContent`, and exits with `exitCode`.
 */
function makeWriteAndExitElf({ stdoutText = "", filePath = null, fileContent = "", exitCode = 0 }) {
  const enc = new TextEncoder();
  const stdoutBytes = enc.encode(stdoutText);
  const pathBytes = filePath ? enc.encode(filePath + "\0") : new Uint8Array(0);
  const contentBytes = filePath ? enc.encode(fileContent) : new Uint8Array(0);

  const data = new Uint8Array(stdoutBytes.length + pathBytes.length + contentBytes.length);
  data.set(stdoutBytes, 0);
  data.set(pathBytes, stdoutBytes.length);
  data.set(contentBytes, stdoutBytes.length + pathBytes.length);

  // Two-pass to know exact dataBaseVaddr
  const emitCode = (dataBase) => {
    const stdoutAddr = dataBase;
    const pathAddr = dataBase + stdoutBytes.length;
    const contentAddr = pathAddr + pathBytes.length;
    const code = [];

    if (stdoutBytes.length > 0) {
      // write(1, stdoutAddr, stdoutBytes.length)
      code.push(0xb8); pushImm32(code, 1); // mov eax, 1 (SYS_write)
      code.push(0xbf); pushImm32(code, 1); // mov edi, 1 (stdout)
      code.push(0xbe); pushImm32(code, stdoutAddr); // mov esi, stdoutAddr
      code.push(0xba); pushImm32(code, stdoutBytes.length); // mov edx, len
      code.push(0x0f, 0x05); // syscall
    }

    if (filePath) {
      // openat(AT_FDCWD=-100, pathAddr, O_WRONLY|O_CREAT|O_TRUNC=0x241, 0644)
      code.push(0xb8); pushImm32(code, 257); // mov eax, 257 (SYS_openat)
      code.push(0x48, 0xc7, 0xc7); pushImm32(code, -100); // mov rdi, -100
      code.push(0xbe); pushImm32(code, pathAddr); // mov esi, pathAddr
      code.push(0xba); pushImm32(code, 0x241); // mov edx, 0x241
      code.push(0x41, 0xba); pushImm32(code, 0o644); // mov r10d, 0644
      code.push(0x0f, 0x05); // syscall
      // mov r12, rax (save fd)
      code.push(0x49, 0x89, 0xc4);
      // write(r12, contentAddr, contentBytes.length)
      code.push(0xb8); pushImm32(code, 1);
      code.push(0x4c, 0x89, 0xe7); // mov rdi, r12
      code.push(0xbe); pushImm32(code, contentAddr);
      code.push(0xba); pushImm32(code, contentBytes.length);
      code.push(0x0f, 0x05);
      // close(r12)
      code.push(0xb8); pushImm32(code, 3);
      code.push(0x4c, 0x89, 0xe7);
      code.push(0x0f, 0x05);
    }

    // exit_group(exitCode)
    code.push(0xb8); pushImm32(code, 231);
    code.push(0xbf); pushImm32(code, exitCode);
    code.push(0x0f, 0x05);
    return new Uint8Array(code);
  };

  const pass1 = emitCode(0x400100);
  const { dataBaseVaddr } = buildSyntheticElf64(pass1, data);
  return buildSyntheticElf64(emitCode(dataBaseVaddr), data).elfBytes;
}

/**
 * Build a real x86-64 static ELF that reads `filePath` (up to 256 bytes)
 * and writes its contents to stdout.
 */
function makeReadAndPrintElf(filePath) {
  const pathBytes = new TextEncoder().encode(filePath + "\0");
  const emitCode = (dataBase) => {
    const code = [];
    // sub rsp, 256
    code.push(0x48, 0x81, 0xec); pushImm32(code, 256);
    // openat(-100, pathAddr, O_RDONLY=0, 0)
    code.push(0xb8); pushImm32(code, 257);
    code.push(0x48, 0xc7, 0xc7); pushImm32(code, -100);
    code.push(0xbe); pushImm32(code, dataBase);
    code.push(0x31, 0xd2); // xor edx, edx
    code.push(0x45, 0x31, 0xd2); // xor r10d, r10d
    code.push(0x0f, 0x05);
    // mov r12, rax (fd)
    code.push(0x49, 0x89, 0xc4);
    // read(r12, rsp, 256)
    code.push(0x31, 0xc0); // xor eax, eax (SYS_read = 0)
    code.push(0x4c, 0x89, 0xe7); // mov rdi, r12
    code.push(0x48, 0x89, 0xe6); // mov rsi, rsp
    code.push(0xba); pushImm32(code, 256);
    code.push(0x0f, 0x05);
    // mov rdx, rax (bytes read)
    code.push(0x48, 0x89, 0xc2);
    // write(1, rsp, rdx)
    code.push(0xb8); pushImm32(code, 1);
    code.push(0xbf); pushImm32(code, 1);
    code.push(0x48, 0x89, 0xe6);
    code.push(0x0f, 0x05);
    // close(r12)
    code.push(0xb8); pushImm32(code, 3);
    code.push(0x4c, 0x89, 0xe7);
    code.push(0x0f, 0x05);
    // exit_group(0)
    code.push(0xb8); pushImm32(code, 231);
    code.push(0x31, 0xff);
    code.push(0x0f, 0x05);
    return new Uint8Array(code);
  };
  const pass1 = emitCode(0x400100);
  const { dataBaseVaddr } = buildSyntheticElf64(pass1, pathBytes);
  return buildSyntheticElf64(emitCode(dataBaseVaddr), pathBytes).elfBytes;
}

/**
 * Build a real x86-64 static ELF with an infinite loop (`jmp -2`).
 */
function makeInfiniteLoopElf() {
  return buildSyntheticElf64(new Uint8Array([0xeb, 0xfe])).elfBytes;
}

/**
 * Build a real x86-64 static ELF that calls getrandom(rsp, 8, 0), maps each
 * byte's low nibble to 'a'..'p', writes the 8 ASCII chars to stdout, and exits 0.
 * Exercises deterministic PRNG seeding via delaySeed + delayStddevMs.
 */
function makeGetrandomElf() {
  const code = [];
  // sub rsp, 32
  code.push(0x48, 0x83, 0xec, 0x20);
  // getrandom(rsp, 8, 0) -> syscall 318
  code.push(0xb8); pushImm32(code, 318);
  code.push(0x48, 0x89, 0xe7); // mov rdi, rsp
  code.push(0xbe); pushImm32(code, 8); // mov esi, 8
  code.push(0x31, 0xd2); // xor edx, edx
  code.push(0x0f, 0x05);
  // mov ecx, 8
  code.push(0xb9); pushImm32(code, 8);
  // loop (18 bytes):
  //   mov al, [rsp + rcx - 1]   -> 8a 44 0c ff
  //   and al, 0x0f              -> 24 0f
  //   add al, 0x61              -> 04 61
  //   mov [rsp + rcx - 1], al   -> 88 44 0c ff
  //   dec ecx                   -> ff c9
  //   jnz loop (-16)            -> 75 ee
  code.push(0x8a, 0x44, 0x0c, 0xff);
  code.push(0x24, 0x0f);
  code.push(0x04, 0x61);
  code.push(0x88, 0x44, 0x0c, 0xff);
  code.push(0xff, 0xc9);
  code.push(0x75, 0xf0); // -16: 4+2+2+4+2+2 = 16 bytes
  // write(1, rsp, 8)
  code.push(0xb8); pushImm32(code, 1);
  code.push(0xbf); pushImm32(code, 1);
  code.push(0x48, 0x89, 0xe6); // mov rsi, rsp
  code.push(0xba); pushImm32(code, 8);
  code.push(0x0f, 0x05);
  // exit_group(0)
  code.push(0xb8); pushImm32(code, 231);
  code.push(0x31, 0xff);
  code.push(0x0f, 0x05);
  return buildSyntheticElf64(new Uint8Array(code)).elfBytes;
}

function buildTestTarGz(entries) {
  const blocks = [];
  for (const ent of entries) {
    const header = Buffer.alloc(512, 0);
    const nameBytes = Buffer.from(ent.path, "utf8");
    nameBytes.copy(header, 0, 0, Math.min(100, nameBytes.length));
    const mode = ent.mode ?? (ent.type === "5" ? 0o755 : 0o644);
    header.write(mode.toString(8).padStart(7, "0") + "\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    const content =
      ent.type === "5"
        ? Buffer.alloc(0)
        : Buffer.isBuffer(ent.content)
          ? ent.content
          : ent.content instanceof Uint8Array
            ? Buffer.from(ent.content)
            : Buffer.from(ent.content || "", "utf8");
    header.write(content.length.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(0x20, 148, 156);
    header.write(ent.type || "0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i];
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    blocks.push(header);
    if (content.length > 0) {
      blocks.push(content);
      const rem = content.length % 512;
      if (rem !== 0) blocks.push(Buffer.alloc(512 - rem, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(blocks));
}

describe("Cloudflare Worker: POST /api/eval Remote Layer Evaluation", async () => {
  const workerWasmPath = path.join(
    REPO_ROOT,
    "target",
    "wasm32-unknown-unknown",
    "release",
    WORKER_WASM_FILE
  );
  const workerWasmModule = await WebAssembly.compile(await fs.readFile(workerWasmPath));

  const writerElf = makeWriteAndExitElf({
    stdoutText: "hello from remote wasmi\n",
    filePath: "/workspace/out.txt",
    fileContent: "artifact-v1\n",
    exitCode: 0,
  });
  const readerElf = makeReadAndPrintElf("/workspace/out.txt");
  const readGitElf = makeReadAndPrintElf("/workspace/README.md");
  const loopElf = makeInfiniteLoopElf();
  const randElf = makeGetrandomElf();

  const baseLayerTarGz = buildTestTarGz([
    { path: "bin/", type: "5", mode: 0o755 },
    { path: "workspace/", type: "5", mode: 0o755 },
    { path: "bin/writer", content: writerElf, mode: 0o755 },
    { path: "bin/reader", content: readerElf, mode: 0o755 },
    { path: "bin/readgit", content: readGitElf, mode: 0o755 },
    { path: "bin/spin", content: loopElf, mode: 0o755 },
    { path: "bin/rand", content: randElf, mode: 0o755 },
  ]);
  const baseLayerB64 = baseLayerTarGz.toString("base64");

  it("evaluates a layer via JSON, returns VFS diff, and chains outputDiffTarGzBase64 into a second layer", async () => {
    const worker = createWorkerHandler({ workerWasmModule });

    // Layer 1: runs /bin/writer -> prints stdout & writes /workspace/out.txt
    const res1 = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/eval`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inputLayerDiffs: [baseLayerB64],
          cmd: ["/bin/writer"],
          cwd: "/workspace",
        }),
      })
    );
    assert.equal(res1.status, 200);
    assert.equal(res1.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(res1.headers.get("cache-control"), "no-store");
    const j1 = await res1.json();
    assert.equal(j1.ok, true);
    assert.equal(j1.executor, "remote-wasmi");
    assert.equal(j1.exitCode, 0);
    assert.equal(j1.stdout, "hello from remote wasmi\n");
    assert.equal(j1.stderr, "");
    assert.equal(j1.timedOut, false);
    assert.equal(j1.error, null);
    assert.match(j1.virtualTimeNs, /^\d+$/);
    assert.equal(typeof j1.outputDiffTarGzBase64, "string");
    assert.ok(j1.outputDiffTarGzBase64.length > 0);
    assert.ok(
      j1.modifiedFiles.some((f) => f.path === "/workspace/out.txt" && f.kind === "file" && f.size === 12),
      `Expected /workspace/out.txt in modifiedFiles, got: ${JSON.stringify(j1.modifiedFiles)}`
    );

    // Layer 2: chains baseLayer + Layer 1's outputDiffTarGzBase64 and runs /bin/reader
    const res2 = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/eval`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inputLayerDiffs: [baseLayerB64, j1.outputDiffTarGzBase64],
          cmd: ["/bin/reader"],
          cwd: "/workspace",
        }),
      })
    );
    assert.equal(res2.status, 200);
    const j2 = await res2.json();
    assert.equal(j2.ok, true);
    assert.equal(j2.exitCode, 0);
    assert.equal(j2.stdout, "artifact-v1\n");
  });

  it("supports direct .tar.gz download via Accept: application/gzip and ?format=tar.gz", async () => {
    const worker = createWorkerHandler({ workerWasmModule });
    const reqBody = JSON.stringify({
      inputLayerDiffs: [baseLayerB64],
      cmd: ["/bin/writer"],
      cwd: "/workspace",
    });

    for (const { url, headers, label } of [
      {
        url: `${WORKER_ORIGIN}/api/eval`,
        headers: { "Content-Type": "application/json", Accept: "application/gzip" },
        label: "Accept: application/gzip",
      },
      {
        url: `${WORKER_ORIGIN}/api/eval?format=tar.gz`,
        headers: { "Content-Type": "application/json" },
        label: "?format=tar.gz",
      },
    ]) {
      const res = await worker.fetch(new Request(url, { method: "POST", headers, body: reqBody }));
      assert.equal(res.status, 200, label);
      assert.equal(res.headers.get("content-type"), "application/gzip", label);
      assert.equal(
        res.headers.get("content-disposition"),
        'attachment; filename="layer-output.tar.gz"',
        label
      );
      assert.equal(res.headers.get("x-eval-exit-code"), "0", label);
      assert.match(res.headers.get("x-eval-virtual-time-ns") || "", /^\d+$/, label);
      assert.equal(res.headers.get("cache-control"), "no-store", label);

      const gzBytes = Buffer.from(await res.arrayBuffer());
      assert.equal(gzBytes[0], 0x1f, `${label}: gzip magic byte 0`);
      assert.equal(gzBytes[1], 0x8b, `${label}: gzip magic byte 1`);
      const tarText = zlib.gunzipSync(gzBytes).toString("utf8");
      assert.ok(tarText.includes("workspace/out.txt"), `${label}: tar should contain workspace/out.txt`);
      assert.ok(tarText.includes("artifact-v1\n"), `${label}: tar should contain artifact-v1`);
    }
  });

  it("is deterministic for delayStddevMs + delaySeed and varies across different seeds", async () => {
    const worker = createWorkerHandler({ workerWasmModule });
    const runWithSeed = async (delaySeed) => {
      const res = await worker.fetch(
        new Request(`${WORKER_ORIGIN}/api/eval`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            inputLayerDiffs: [baseLayerB64],
            cmd: ["/bin/rand"],
            delayStddevMs: 5,
            delaySeed,
            returnOutputDiff: false,
          }),
        })
      );
      assert.equal(res.status, 200);
      return res.json();
    };

    const a1 = await runWithSeed(42);
    const a2 = await runWithSeed(42);
    const b1 = await runWithSeed(99);

    assert.match(a1.stdout, /^[a-p]{8}$/);
    assert.equal(a1.stdout, a2.stdout, "Same seed must produce identical getrandom output");
    assert.equal(a1.virtualTimeNs, a2.virtualTimeNs, "Same seed must produce identical virtualTimeNs");
    assert.notEqual(
      a1.stdout,
      b1.stdout,
      "Different delaySeed values must produce different deterministic PRNG output"
    );
  });

  it("fetches baseImage + gitRepo internally through edgeCache with zero self-fetch", async () => {
    const store = new Map();
    const cache = {
      async match(req) {
        const entry = store.get(typeof req === "string" ? req : req.url);
        if (!entry) return undefined;
        return new Response(entry.body.slice(0), {
          status: entry.status,
          headers: new Headers(entry.headers),
        });
      },
      async put(req, res) {
        const buf = new Uint8Array(await res.arrayBuffer());
        store.set(typeof req === "string" ? req : req.url, {
          status: res.status,
          headers: new Headers(res.headers),
          body: buf,
        });
      },
    };

    const configDigest = "sha256:" + "1".repeat(64);
    const layerDigest = "sha256:" + "2".repeat(64);
    const amd64ManifestDigest = "sha256:" + "3".repeat(64);

    const indexJson = JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [
        {
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          digest: amd64ManifestDigest,
          platform: { os: "linux", architecture: "amd64" },
        },
      ],
    });
    const manifestJson = JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: configDigest },
      layers: [{ mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", digest: layerDigest }],
    });
    const configJson = JSON.stringify({
      config: { WorkingDir: "/workspace", Cmd: ["/bin/readgit"] },
    });
    const gitTarGz = buildTestTarGz([
      { path: "demo-main/README.md", content: "hello from git repo\n" },
    ]);

    let upstreamFetches = 0;
    const waitUntilPromises = [];
    const ctx = { waitUntil: (p) => waitUntilPromises.push(p) };

    const worker = createWorkerHandler({
      workerWasmModule,
      cache,
      fetchImpl: async (url) => {
        upstreamFetches++;
        if (url.endsWith("/manifests/latest")) {
          return new Response(indexJson, {
            status: 200,
            headers: { "Content-Type": "application/vnd.oci.image.index.v1+json" },
          });
        }
        if (url.endsWith(`/manifests/${amd64ManifestDigest}`)) {
          return new Response(manifestJson, {
            status: 200,
            headers: { "Content-Type": "application/vnd.oci.image.manifest.v1+json" },
          });
        }
        if (url.endsWith(`/blobs/${configDigest}`)) {
          return new Response(configJson, {
            status: 200,
            headers: { "Content-Type": "application/vnd.oci.image.config.v1+json" },
          });
        }
        if (url.endsWith(`/blobs/${layerDigest}`)) {
          return new Response(baseLayerTarGz, {
            status: 200,
            headers: { "Content-Type": "application/vnd.oci.image.layer.v1.tar+gzip" },
          });
        }
        if (url === "https://codeload.github.com/octocat/demo/tar.gz/main") {
          return new Response(gitTarGz, {
            status: 200,
            headers: { "Content-Type": "application/gzip" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    const evalPayload = JSON.stringify({
      baseImage: "ghcr.io/test/app:latest",
      gitRepo: { repo: "octocat/demo", ref: "main", mountPath: "/workspace" },
    });

    const r1 = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/eval`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: evalPayload,
      }),
      {},
      ctx
    );
    assert.equal(r1.status, 200);
    const j1 = await r1.json();
    assert.equal(j1.ok, true);
    assert.equal(j1.stdout, "hello from git repo\n");
    await Promise.all(waitUntilPromises);
    assert.equal(upstreamFetches, 5, "First eval fetches index, manifest, config, layer, and git archive");

    // Second eval hits edgeCache with zero additional upstream fetches
    const r2 = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/eval`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: evalPayload,
      }),
      {},
      ctx
    );
    assert.equal(r2.status, 200);
    const j2 = await r2.json();
    assert.equal(j2.stdout, "hello from git repo\n");
    assert.equal(upstreamFetches, 5, "Second eval must hit edgeCache with 0 upstream fetches");
  });

  it("handles OPTIONS CORS preflight, 405 methods, and structured 400/408/413/502/507 errors", async () => {
    const worker = createWorkerHandler({
      workerWasmModule,
      allowedOrigins: "https://app.example.com",
      maxEvalBodyBytes: 1024,
      fetchImpl: async () => new Response("not found", { status: 404 }),
    });

    // OPTIONS allowed origin -> 204
    const optOk = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/eval`, {
        method: "OPTIONS",
        headers: { Origin: "https://app.example.com" },
      })
    );
    assert.equal(optOk.status, 204);
    assert.equal(optOk.headers.get("access-control-allow-origin"), "https://app.example.com");
    assert.ok((optOk.headers.get("access-control-allow-methods") || "").includes("POST"));
    assert.ok((optOk.headers.get("access-control-allow-headers") || "").includes("Content-Type"));
    const exposed = optOk.headers.get("access-control-expose-headers") || "";
    assert.ok(exposed.includes("Content-Disposition"));
    assert.ok(exposed.includes("X-Eval-Exit-Code"));
    assert.ok(exposed.includes("X-Eval-Virtual-Time-Ns"));

    // OPTIONS disallowed origin -> 403
    const optBad = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/eval`, {
        method: "OPTIONS",
        headers: { Origin: "https://evil.example.com" },
      })
    );
    assert.equal(optBad.status, 403);

    // GET -> 405
    const getRes = await worker.fetch(new Request(`${WORKER_ORIGIN}/api/eval`, { method: "GET" }));
    assert.equal(getRes.status, 405);
    assert.equal(getRes.headers.get("allow"), "POST, OPTIONS");

    // 400 INVALID_REQUEST (malformed JSON)
    const badJson = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/eval`, { method: "POST", body: "{not json" })
    );
    assert.equal(badJson.status, 400);
    assert.equal((await badJson.json()).code, "INVALID_REQUEST");

    // 413 payload too large
    const tooLarge = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/eval`, {
        method: "POST",
        body: "x".repeat(2048),
      })
    );
    assert.equal(tooLarge.status, 413);
    assert.equal((await tooLarge.json()).code, "INVALID_REQUEST");

    // 502 UPSTREAM_ERROR (upstream 404)
    const upErr = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/eval`, {
        method: "POST",
        body: JSON.stringify({ baseImage: "ghcr.io/missing/img:latest", cmd: ["/bin/writer"] }),
      })
    );
    assert.equal(upErr.status, 502);
    assert.equal((await upErr.json()).code, "UPSTREAM_ERROR");

    // Use default body limit for 408 and 507 tests
    const fullWorker = createWorkerHandler({ workerWasmModule });

    // 408 FUEL_EXHAUSTED (infinite loop ELF)
    const fuelRes = await fullWorker.fetch(
      new Request(`${WORKER_ORIGIN}/api/eval`, {
        method: "POST",
        body: JSON.stringify({
          inputLayerDiffs: [baseLayerB64],
          cmd: ["/bin/spin"],
          maxFuel: 5000,
        }),
      })
    );
    assert.equal(fuelRes.status, 408);
    assert.equal((await fuelRes.json()).code, "FUEL_EXHAUSTED");

    // 507 MEMORY_LIMIT
    const memRes = await fullWorker.fetch(
      new Request(`${WORKER_ORIGIN}/api/eval`, {
        method: "POST",
        body: JSON.stringify({
          inputLayerDiffs: [baseLayerB64],
          cmd: ["/bin/writer"],
          maxMemoryBytes: 65536,
        }),
      })
    );
    assert.equal(memRes.status, 507);
    assert.equal((await memRes.json()).code, "MEMORY_LIMIT");
  });
});




