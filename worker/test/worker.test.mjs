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
