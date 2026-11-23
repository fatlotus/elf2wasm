/**
 * Cloudflare Worker entrypoint for elf2wasm:
 * - Serves `/api/health` and `/api/v2/*` thin streaming OCI Distribution v2 proxy
 * - Falls back to Workers Static Assets (`env.ASSETS`) for frontend HTML/JS/CSS/WASM
 *
 * Pure Web Standards (`fetch`, `Request`, `Response`, `Headers`, `ReadableStream`,
 * `TextDecoder`, `AbortSignal.timeout`) — zero `node:*` dependencies.
 */

import {
  DEFAULT_MANIFEST_ACCEPT,
  REDIRECT_STATUSES,
  FORWARDED_RESPONSE_HEADERS,
  MAX_TOKEN_RESPONSE_BYTES,
  ProxyError,
  extractRawPathname,
  parseProxyPath,
  parseWwwAuthenticate,
  validateUrlPolicy,
  selectInitialScheme,
  createTokenCache,
} from "../../server/proxy_core.mjs";

const CORS_ALLOW_METHODS = "GET, HEAD, OPTIONS";
const CORS_ALLOW_HEADERS = "Accept";
const CORS_EXPOSE_HEADERS = [
  "Content-Type",
  "Content-Length",
  "Docker-Content-Digest",
  "ETag",
  "Cache-Control",
  "Accept-Ranges",
].join(", ");

const USER_AGENT = "elf2wasm-registry-proxy/1.0";

const DOCKER_HUB_REGISTRIES = new Set([
  "registry-1.docker.io",
  "index.docker.io",
  "docker.io",
]);
const DEFAULT_DOCKER_HUB_MIRROR = "mirror.gcr.io";
const DOCKER_HUB_COOLDOWN_MS = 60_000;
const IMMUTABLE_CACHE_CONTROL = "public, max-age=604800, immutable";
const MUTABLE_MANIFEST_CACHE_CONTROL = "public, max-age=300";

function isDockerHubHost(hostname) {
  return DOCKER_HUB_REGISTRIES.has(String(hostname || "").toLowerCase());
}

function resolveDockerHubMirror(env, defaultMirror) {
  if (env && typeof env.DOCKER_HUB_MIRROR === "string") {
    return env.DOCKER_HUB_MIRROR.trim();
  }
  return defaultMirror;
}

function getEdgeCacheControl(kind, target) {
  if (kind === "blobs" || (typeof target === "string" && target.includes(":"))) {
    return IMMUTABLE_CACHE_CONTROL;
  }
  return MUTABLE_MANIFEST_CACHE_CONTROL;
}

function buildEdgeCacheKey(requestUrl, kind, acceptHeader) {
  const keyUrl = new URL(requestUrl);
  keyUrl.search = "";
  if (kind === "manifests" && acceptHeader) {
    keyUrl.searchParams.set("__accept", acceptHeader);
  }
  return new Request(keyUrl.toString(), { method: "GET" });
}

function parseAllowedOrigins(rawValue) {
  const set = new Set();
  if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
    return set;
  }
  for (const part of rawValue.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length > 0) {
      set.add(trimmed);
    }
  }
  return set;
}

function parseBoolEnv(val) {
  if (typeof val === "boolean") return val;
  if (typeof val === "string") {
    const normalized = val.trim().toLowerCase();
    return normalized === "1" || normalized === "true";
  }
  return false;
}

/**
 * Evaluate origin policy for an incoming request.
 * Returns `{ allowed, isCrossOrigin, allowOriginHeader, varyOrigin }`.
 */
function evaluateCors(request, env, defaultAllowedOrigins) {
  const requestOrigin = request.headers.get("origin");
  if (!requestOrigin) {
    return {
      hasOrigin: false,
      allowed: true,
      isCrossOrigin: false,
      allowOriginHeader: null,
      varyOrigin: false,
    };
  }

  let selfOrigin = null;
  try {
    selfOrigin = new URL(request.url).origin;
  } catch {
    selfOrigin = null;
  }

  if (selfOrigin && requestOrigin === selfOrigin) {
    return {
      hasOrigin: true,
      allowed: true,
      isCrossOrigin: false,
      allowOriginHeader: requestOrigin,
      varyOrigin: true,
    };
  }

  const configuredRaw =
    env && typeof env.ALLOWED_ORIGINS === "string"
      ? env.ALLOWED_ORIGINS
      : defaultAllowedOrigins;
  const allowedSet = parseAllowedOrigins(configuredRaw);

  if (allowedSet.has(requestOrigin)) {
    return {
      hasOrigin: true,
      allowed: true,
      isCrossOrigin: true,
      allowOriginHeader: requestOrigin,
      varyOrigin: true,
    };
  }

  if (allowedSet.has("*")) {
    return {
      hasOrigin: true,
      allowed: true,
      isCrossOrigin: true,
      allowOriginHeader: "*",
      varyOrigin: false,
    };
  }

  return {
    hasOrigin: true,
    allowed: false,
    isCrossOrigin: true,
    allowOriginHeader: null,
    varyOrigin: true,
  };
}

function applyApiHeaders(headers, cors) {
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set(
    "Cross-Origin-Resource-Policy",
    cors.allowed && cors.isCrossOrigin ? "cross-origin" : "same-origin"
  );

  if (cors.allowOriginHeader) {
    headers.set("Access-Control-Allow-Origin", cors.allowOriginHeader);
    headers.set("Access-Control-Allow-Methods", CORS_ALLOW_METHODS);
    headers.set("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
    headers.set("Access-Control-Expose-Headers", CORS_EXPOSE_HEADERS);
  }
  if (cors.varyOrigin) {
    headers.set("Vary", "Origin");
  }
}

function jsonResponse(bodyObj, status, cors, { headOnly = false, extraHeaders = null } = {}) {
  const headers = new Headers();
  applyApiHeaders(headers, cors);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      headers.set(k, v);
    }
  }
  const bodyStr = JSON.stringify(bodyObj);
  headers.set("Content-Length", String(new TextEncoder().encode(bodyStr).byteLength));
  return new Response(headOnly ? null : bodyStr, { status, headers });
}

async function cancelBodySafely(res) {
  if (res && res.body && typeof res.body.cancel === "function") {
    try {
      await res.body.cancel();
    } catch {
      // Ignore already-closed or errored streams.
    }
  }
}

async function readBoundedText(res, maxBytes) {
  if (!res.body) {
    return "";
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let totalBytes = 0;
  let result = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Ignore cancel error
        }
        throw new ProxyError(502, "Auth token response exceeded maximum size");
      }
      result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode();
    return result;
  } catch (err) {
    if (err instanceof ProxyError) throw err;
    throw new ProxyError(502, `Auth response stream error: ${err?.message || "unknown error"}`);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignore release errors
    }
  }
}

export function createWorkerHandler(options = {}) {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const defaultAllowLocalRegistries = Boolean(options.allowLocalRegistries);
  const defaultAllowedOrigins = options.allowedOrigins ?? "";
  const defaultDockerHubMirror =
    options.dockerHubMirror !== undefined ? options.dockerHubMirror : DEFAULT_DOCKER_HUB_MIRROR;
  const dockerHubCooldownMs = options.dockerHubCooldownMs ?? DOCKER_HUB_COOLDOWN_MS;
  const edgeCache =
    options.cache !== undefined
      ? options.cache
      : typeof caches !== "undefined" && caches.default
        ? caches.default
        : null;
  const maxRedirects = options.maxRedirects ?? 5;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;

  let dockerHubRateLimitedUntil = 0;

  const tokenCache = createTokenCache({
    maxEntries: options.tokenCacheMaxEntries ?? 256,
    minTtlMs: options.tokenCacheMinTtlMs ?? 30_000,
    maxTtlMs: options.tokenCacheMaxTtlMs ?? 3_600_000,
    safetyMarginMs: options.tokenCacheSafetyMarginMs ?? 15_000,
  });

  async function requestWithRedirects(
    initialUrl,
    { method, baseHeaders, authToken, allowLocalRegistries }
  ) {
    let currentUrl = initialUrl;
    const currentHeaders = new Headers(baseHeaders);
    if (authToken) {
      currentHeaders.set("Authorization", `Bearer ${authToken}`);
    }

    for (let hop = 0; hop <= maxRedirects; hop++) {
      validateUrlPolicy(currentUrl, {
        allowLocalRegistries,
        requireLoopbackHostForHttp: true,
      });

      let upstreamRes;
      try {
        upstreamRes = await fetchImpl(currentUrl.toString(), {
          method,
          headers: currentHeaders,
          redirect: "manual",
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
      } catch (err) {
        if (err instanceof ProxyError) throw err;
        if (err?.name === "TimeoutError" || err?.name === "AbortError") {
          throw new ProxyError(502, "Upstream request timed out");
        }
        throw new ProxyError(502, `Upstream request failed: ${err?.message || "network error"}`);
      }

      const status = upstreamRes.status || 502;
      const location = upstreamRes.headers.get("location");

      if (REDIRECT_STATUSES.has(status) && location) {
        await cancelBodySafely(upstreamRes);
        if (hop === maxRedirects) {
          throw new ProxyError(502, "Too many redirects from upstream registry");
        }
        let nextUrl;
        try {
          nextUrl = new URL(location, currentUrl);
        } catch {
          throw new ProxyError(502, "Invalid redirect Location URL from upstream registry");
        }
        // Strip Authorization header on cross-origin redirect (e.g. Docker Hub -> S3/R2).
        if (nextUrl.origin !== currentUrl.origin) {
          currentHeaders.delete("Authorization");
        }
        currentUrl = nextUrl;
        continue;
      }

      return upstreamRes;
    }

    throw new ProxyError(502, "Too many redirects from upstream registry");
  }

  async function fetchBearerToken(wwwAuthHeader, allowLocalRegistries) {
    const challenge = parseWwwAuthenticate(wwwAuthHeader);
    if (!challenge) {
      throw new ProxyError(502, "Unsupported or malformed WWW-Authenticate challenge from registry");
    }

    let tokenUrl;
    try {
      tokenUrl = new URL(challenge.realm);
    } catch {
      throw new ProxyError(502, "Invalid realm URL in WWW-Authenticate header");
    }

    if (challenge.service) {
      tokenUrl.searchParams.set("service", challenge.service);
    }
    if (challenge.scope) {
      tokenUrl.searchParams.set("scope", challenge.scope);
    }

    const tokenRes = await requestWithRedirects(tokenUrl, {
      method: "GET",
      baseHeaders: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      authToken: null,
      allowLocalRegistries,
    });

    if (tokenRes.status !== 200) {
      await cancelBodySafely(tokenRes);
      const errStatus = tokenRes.status === 429 ? 429 : 502;
      throw new ProxyError(errStatus, `Registry auth server returned HTTP ${tokenRes.status}`);
    }

    const bodyText = await readBoundedText(tokenRes, MAX_TOKEN_RESPONSE_BYTES);
    let parsed;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      throw new ProxyError(502, "Registry auth server returned invalid JSON");
    }

    const token =
      parsed && typeof parsed === "object" ? parsed.token || parsed.access_token : null;
    if (typeof token !== "string" || token.length === 0) {
      throw new ProxyError(502, "Registry auth server response missing token");
    }

    return {
      token,
      expiresIn: Number(parsed.expires_in) || 300,
    };
  }

  async function fetchFromRegistry({
    registry,
    hostname,
    kind,
    repo,
    target,
    method,
    baseHeaders,
    allowLocalRegistries,
  }) {
    const scheme = selectInitialScheme(hostname, allowLocalRegistries);
    const upstreamUrl = new URL(`${scheme}//${registry}/v2/${repo}/${kind}/${target}`);
    const cacheKey = `${registry}|${repo}`;
    const cachedToken = tokenCache.get(cacheKey);

    let upstreamRes = await requestWithRedirects(upstreamUrl, {
      method,
      baseHeaders,
      authToken: cachedToken,
      allowLocalRegistries,
    });

    // Handle OCI v2 401 Bearer challenge with at most one retry.
    if (upstreamRes.status === 401) {
      const wwwAuth = upstreamRes.headers.get("www-authenticate");
      await cancelBodySafely(upstreamRes);
      tokenCache.delete(cacheKey);

      if (!wwwAuth) {
        throw new ProxyError(502, "Upstream registry returned 401 without WWW-Authenticate header");
      }

      const fetched = await fetchBearerToken(wwwAuth, allowLocalRegistries);
      tokenCache.set(cacheKey, fetched.token, fetched.expiresIn);

      upstreamRes = await requestWithRedirects(upstreamUrl, {
        method,
        baseHeaders,
        authToken: fetched.token,
        allowLocalRegistries,
      });

      if (upstreamRes.status === 401) {
        await cancelBodySafely(upstreamRes);
        tokenCache.delete(cacheKey);
        throw new ProxyError(502, "Upstream registry rejected Bearer token");
      }
    }

    return upstreamRes;
  }

  async function handleOciProxy(request, env, ctx, rawPathname, cors) {
    const method = (request.method || "GET").toUpperCase();

    if (method === "OPTIONS") {
      if (!cors.allowed) {
        return jsonResponse({ error: "Origin not allowed" }, 403, cors);
      }
      const headers = new Headers();
      applyApiHeaders(headers, cors);
      headers.set("Access-Control-Max-Age", "86400");
      return new Response(null, { status: 204, headers });
    }

    if (method !== "GET" && method !== "HEAD") {
      return jsonResponse({ error: "Method Not Allowed" }, 405, cors, {
        extraHeaders: { Allow: "GET, HEAD, OPTIONS" },
      });
    }

    const allowLocalRegistries =
      defaultAllowLocalRegistries || parseBoolEnv(env?.ALLOW_LOCAL_REGISTRIES);

    try {
      const { registry, hostname, kind, repo, target } = parseProxyPath(rawPathname);

      const baseHeaders = {
        "User-Agent": USER_AGENT,
      };
      if (kind === "manifests") {
        const clientAccept = request.headers.get("accept");
        baseHeaders.Accept =
          clientAccept && clientAccept.trim() !== "*/*" && clientAccept.trim() !== ""
            ? clientAccept
            : DEFAULT_MANIFEST_ACCEPT;
      } else {
        baseHeaders.Accept = "*/*";
      }

      const edgeCacheKey = edgeCache
        ? buildEdgeCacheKey(request.url, kind, kind === "manifests" ? baseHeaders.Accept : null)
        : null;

      if (edgeCache && edgeCacheKey) {
        let cachedRes = null;
        try {
          cachedRes = await edgeCache.match(edgeCacheKey);
        } catch {
          cachedRes = null;
        }
        if (cachedRes) {
          const outHeaders = new Headers();
          applyApiHeaders(outHeaders, cors);
          for (const headerName of FORWARDED_RESPONSE_HEADERS) {
            const val = cachedRes.headers.get(headerName);
            if (val !== null) {
              outHeaders.set(headerName, val);
            }
          }
          if (method === "HEAD") {
            await cancelBodySafely(cachedRes);
            return new Response(null, { status: cachedRes.status, headers: outHeaders });
          }
          return new Response(cachedRes.body, { status: cachedRes.status, headers: outHeaders });
        }
      }

      const mirrorHost = isDockerHubHost(hostname)
        ? resolveDockerHubMirror(env, defaultDockerHubMirror)
        : "";
      const canUseMirror =
        mirrorHost.length > 0 && mirrorHost.toLowerCase() !== hostname.toLowerCase();
      const inCooldown = canUseMirror && Date.now() < dockerHubRateLimitedUntil;

      let upstreamRes;
      if (inCooldown) {
        const mirrorHostname = mirrorHost.split(":")[0];
        upstreamRes = await fetchFromRegistry({
          registry: mirrorHost,
          hostname: mirrorHostname,
          kind,
          repo,
          target,
          method,
          baseHeaders,
          allowLocalRegistries,
        });
      } else {
        let rateLimitedError = null;
        try {
          upstreamRes = await fetchFromRegistry({
            registry,
            hostname,
            kind,
            repo,
            target,
            method,
            baseHeaders,
            allowLocalRegistries,
          });
        } catch (err) {
          if (canUseMirror && err instanceof ProxyError && err.statusCode === 429) {
            rateLimitedError = err;
          } else {
            throw err;
          }
        }

        if (canUseMirror && (rateLimitedError || upstreamRes.status === 429)) {
          if (upstreamRes) {
            await cancelBodySafely(upstreamRes);
          }
          dockerHubRateLimitedUntil = Date.now() + dockerHubCooldownMs;
          const mirrorHostname = mirrorHost.split(":")[0];
          upstreamRes = await fetchFromRegistry({
            registry: mirrorHost,
            hostname: mirrorHostname,
            kind,
            repo,
            target,
            method,
            baseHeaders,
            allowLocalRegistries,
          });
        }
      }

      const status = upstreamRes.status || 502;
      if (status === 404) {
        await cancelBodySafely(upstreamRes);
        return jsonResponse({ error: "Upstream OCI resource not found" }, 404, cors);
      }
      if (status === 429) {
        await cancelBodySafely(upstreamRes);
        return jsonResponse({ error: "Upstream registry rate-limited (HTTP 429)" }, 429, cors);
      }
      if (status < 200 || status >= 300) {
        await cancelBodySafely(upstreamRes);
        return jsonResponse({ error: `Upstream registry returned HTTP ${status}` }, 502, cors);
      }

      const outHeaders = new Headers();
      applyApiHeaders(outHeaders, cors);
      for (const headerName of FORWARDED_RESPONSE_HEADERS) {
        const val = upstreamRes.headers.get(headerName);
        if (val !== null) {
          outHeaders.set(headerName, val);
        }
      }

      if (method === "HEAD") {
        await cancelBodySafely(upstreamRes);
        return new Response(null, { status, headers: outHeaders });
      }

      if (edgeCache && edgeCacheKey && status === 200) {
        const cacheHeaders = new Headers();
        for (const headerName of FORWARDED_RESPONSE_HEADERS) {
          const val = upstreamRes.headers.get(headerName);
          if (val !== null) {
            cacheHeaders.set(headerName, val);
          }
        }
        cacheHeaders.set("Cache-Control", getEdgeCacheControl(kind, target));

        if (upstreamRes.body && typeof upstreamRes.body.tee === "function") {
          const [clientStream, cacheStream] = upstreamRes.body.tee();
          const cacheRes = new Response(cacheStream, { status, headers: cacheHeaders });
          const putPromise = Promise.resolve(edgeCache.put(edgeCacheKey, cacheRes)).catch(() =>
            cancelBodySafely(cacheRes)
          );
          if (ctx && typeof ctx.waitUntil === "function") {
            ctx.waitUntil(putPromise);
          }
          return new Response(clientStream, { status, headers: outHeaders });
        }

        const cacheRes = new Response(null, { status, headers: cacheHeaders });
        const putPromise = Promise.resolve(edgeCache.put(edgeCacheKey, cacheRes)).catch(() => {});
        if (ctx && typeof ctx.waitUntil === "function") {
          ctx.waitUntil(putPromise);
        }
        return new Response(upstreamRes.body, { status, headers: outHeaders });
      }

      return new Response(upstreamRes.body, { status, headers: outHeaders });
    } catch (err) {
      if (err instanceof ProxyError) {
        return jsonResponse({ error: err.message }, err.statusCode, cors);
      }
      return jsonResponse(
        { error: `Registry proxy error: ${err?.message || "unknown error"}` },
        502,
        cors
      );
    }
  }

  return {
    clearTokenCache() {
      tokenCache.clear();
      dockerHubRateLimitedUntil = 0;
    },

    async fetch(request, env = {}, ctx) {
      const rawPathname = extractRawPathname(request.url);
      const cors = evaluateCors(request, env, defaultAllowedOrigins);

      if (rawPathname === "/api/health") {
        const method = (request.method || "GET").toUpperCase();
        if (method !== "GET" && method !== "HEAD") {
          return jsonResponse({ error: "Method Not Allowed" }, 405, cors, {
            extraHeaders: { Allow: "GET, HEAD" },
          });
        }
        return jsonResponse({ ok: true, mode: "client-side-wasm" }, 200, cors, {
          headOnly: method === "HEAD",
        });
      }

      if (rawPathname === "/api/v2" || rawPathname.startsWith("/api/v2/")) {
        return handleOciProxy(request, env, ctx, rawPathname, cors);
      }

      if (env && env.ASSETS && typeof env.ASSETS.fetch === "function") {
        return env.ASSETS.fetch(request);
      }

      return jsonResponse({ error: "Not Found" }, 404, cors);
    },
  };
}

const defaultHandler = createWorkerHandler();
export default defaultHandler;
