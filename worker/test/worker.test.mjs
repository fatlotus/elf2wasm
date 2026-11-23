import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createWorkerHandler } from "../src/index.mjs";
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
  it("stages index.html, web/*, runtime js/*.mjs, wasm/*.wasm, and _headers", async () => {
    const scratchRoot = path.join(REPO_ROOT, "worker", ".wrangler", `test-stage-${Date.now()}`);
    const fakeWasmDir = path.join(scratchRoot, "wasm-src");
    const testDistDir = path.join(scratchRoot, "dist");
    const silentLogger = { log() {} };

    try {
      await fs.mkdir(fakeWasmDir, { recursive: true });
      const wasmMagic = Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
      for (const name of WASM_FILES) {
        await fs.writeFile(path.join(fakeWasmDir, name), wasmMagic);
      }

      const result = await buildAssets({
        repoRoot: REPO_ROOT,
        distDir: testDistDir,
        wasmDir: fakeWasmDir,
        logger: silentLogger,
      });

      // Verify index.html & web/*
      const rootIndex = await fs.readFile(path.join(testDistDir, "index.html"), "utf8");
      const webIndex = await fs.readFile(path.join(testDistDir, "web", "index.html"), "utf8");
      assert.equal(rootIndex, webIndex);
      await fs.access(path.join(testDistDir, "web", "app.mjs"));
      await fs.access(path.join(testDistDir, "web", "styles.css"));
      await fs.access(path.join(testDistDir, "web", "terminal.mjs"));

      // Verify runtime js/*.mjs staged and test/CLI files excluded
      for (const jsFile of BROWSER_JS_FILES) {
        await fs.access(path.join(testDistDir, "js", jsFile));
      }
      await assert.rejects(() => fs.access(path.join(testDistDir, "js", "cli.mjs")));
      await assert.rejects(() => fs.access(path.join(testDistDir, "js", "test_docker_sdk.mjs")));

      // Verify WASM files staged with exact bytes
      for (const wasmFile of WASM_FILES) {
        const bytes = await fs.readFile(path.join(testDistDir, "wasm", wasmFile));
        assert.deepEqual(Array.from(bytes), Array.from(wasmMagic));
        assert.equal(result.wasmSizes[wasmFile], wasmMagic.byteLength);
      }

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

  it("streams GitHub archive across 302 codeload redirect, normalizes headers, and cancels redirect body", async () => {
    const seen = [];
    const redirectTracked = makeTrackedResponse("redirect body", {
      status: 302,
      headers: { Location: "https://codeload.github.com/octocat/Hello-World/tar.gz/HEAD" },
    });

    const worker = createWorkerHandler({
      fetchImpl: async (url, init) => {
        seen.push({ url, method: init.method, headers: new Headers(init.headers) });
        if (url === "https://github.com/octocat/Hello-World/archive/HEAD.tar.gz") {
          return redirectTracked.response;
        }
        if (url === "https://codeload.github.com/octocat/Hello-World/tar.gz/HEAD") {
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
        if (url === "https://github.com/evil/repo/archive/HEAD.tar.gz") {
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
        if (url.includes("/archive/missing.tar.gz")) return tracked404.response;
        if (url.includes("/archive/ratelimit.tar.gz")) return tracked429.response;
        if (url.includes("/archive/fail500.tar.gz")) return tracked500.response;
        if (url.includes("/archive/neterr.tar.gz")) throw new Error("ECONNRESET");
        if (url.includes("/archive/loop.tar.gz")) {
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
    assert.equal(requestedUrls[0], "https://github.com/octocat/Hello-World/archive/HEAD.tar.gz");

    const r2 = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/git/archive?repo=octocat/Hello-World&ref=main#frag`)
    );
    assert.equal(r2.status, 200);
    assert.equal(requestedUrls[1], "https://github.com/octocat/Hello-World/archive/main.tar.gz");
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
        if (url.startsWith("https://github.com/")) {
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



