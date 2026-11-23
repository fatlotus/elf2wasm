import http from "node:http";
import https from "node:https";
import dns from "node:dns/promises";
import {
  DEFAULT_MANIFEST_ACCEPT,
  REDIRECT_STATUSES,
  FORWARDED_RESPONSE_HEADERS,
  MAX_TOKEN_RESPONSE_BYTES,
  ProxyError,
  classifyIp,
  parseProxyPath,
  parseWwwAuthenticate,
  isBlockedIp,
  isLoopbackIp,
  validateUrlPolicy,
  selectInitialScheme,
  createTokenCache,
} from "./proxy_core.mjs";

export {
  DEFAULT_MANIFEST_ACCEPT,
  parseProxyPath,
  parseWwwAuthenticate,
  isBlockedIp,
};

function sendJsonError(res, statusCode, message, extraHeaders = null) {
  if (res.headersSent) {
    if (!res.writableEnded) {
      res.destroy();
    }
    return;
  }
  const body = JSON.stringify({ error: message });
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.setHeader("Cache-Control", "no-store");
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      res.setHeader(k, v);
    }
  }
  res.writeHead(statusCode);
  res.end(body);
}

/**
 * Validates URL protocol, credentials, hostname, and ALL resolved DNS addresses
 * against SSRF rules, returning a DNS-rebinding-pinned `lookup` callback.
 */
export async function validateAndResolveUrl(
  urlObj,
  { allowLocalRegistries = false, lookupFn = dns.lookup } = {}
) {
  const { host, ipFamily } = validateUrlPolicy(urlObj, { allowLocalRegistries });

  let resolvedAddrs;
  if (ipFamily !== 0) {
    resolvedAddrs = [{ address: host, family: ipFamily }];
  } else {
    try {
      const results = await lookupFn(host, { all: true });
      if (!Array.isArray(results) || results.length === 0) {
        throw new ProxyError(502, `DNS resolution returned no addresses for ${host}`);
      }
      resolvedAddrs = results.map((r) => ({
        address: r.address,
        family: r.family || classifyIp(r.address),
      }));
    } catch (err) {
      if (err instanceof ProxyError) throw err;
      throw new ProxyError(502, `DNS resolution failed for ${host}: ${err.message}`);
    }
  }

  for (const addr of resolvedAddrs) {
    if (isBlockedIp(addr.address, { allowLoopback: allowLocalRegistries })) {
      throw new ProxyError(403, `Upstream address ${addr.address} is blocked by SSRF policy`);
    }
  }

  if (urlObj.protocol === "http:") {
    // Plain HTTP is strictly limited to loopback addresses even when allowLocalRegistries is enabled.
    const allLoopback = resolvedAddrs.every((a) => isLoopbackIp(a.address));
    if (!allLoopback) {
      throw new ProxyError(403, "Plain HTTP is only permitted for loopback registries");
    }
  }

  const lookup = (_hostname, opts, cb) => {
    if (typeof opts === "function") {
      cb = opts;
      opts = {};
    }
    if (opts && opts.all) {
      cb(null, resolvedAddrs);
    } else {
      cb(null, resolvedAddrs[0].address, resolvedAddrs[0].family);
    }
  };

  return { url: urlObj, resolvedAddrs, lookup };
}

function openUpstreamRequest(validated, { method, headers, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const client = validated.url.protocol === "https:" ? https : http;
    let settled = false;

    const upstreamReq = client.request(
      validated.url,
      {
        method,
        headers,
        lookup: validated.lookup,
      },
      (upstreamRes) => {
        if (!settled) {
          settled = true;
          resolve({ upstreamReq, upstreamRes });
        }
      }
    );

    upstreamReq.setTimeout(timeoutMs, () => {
      upstreamReq.destroy(new ProxyError(502, "Upstream request timed out"));
    });

    upstreamReq.on("error", (err) => {
      if (!settled) {
        settled = true;
        if (err instanceof ProxyError) {
          reject(err);
        } else {
          reject(new ProxyError(502, `Upstream request failed: ${err.message}`));
        }
      }
    });

    upstreamReq.end();
  });
}

function readBoundedBody(stream, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    stream.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        stream.destroy();
        reject(new ProxyError(502, "Auth token response exceeded maximum size"));
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", (err) => reject(new ProxyError(502, `Auth response stream error: ${err.message}`)));
  });
}

export function createRegistryProxy(options = {}) {
  const allowLocalRegistries = Boolean(options.allowLocalRegistries);
  const maxRedirects = options.maxRedirects ?? 5;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const tokenCacheMaxEntries = options.tokenCacheMaxEntries ?? 256;
  const tokenCacheMinTtlMs = options.tokenCacheMinTtlMs ?? 30_000;
  const tokenCacheMaxTtlMs = options.tokenCacheMaxTtlMs ?? 3_600_000;
  const tokenCacheSafetyMarginMs = options.tokenCacheSafetyMarginMs ?? 15_000;
  const lookupFn = options.lookupFn ?? dns.lookup;

  const tokenCache = createTokenCache({
    maxEntries: tokenCacheMaxEntries,
    minTtlMs: tokenCacheMinTtlMs,
    maxTtlMs: tokenCacheMaxTtlMs,
    safetyMarginMs: tokenCacheSafetyMarginMs,
  });

  function getCachedToken(cacheKey) {
    return tokenCache.get(cacheKey);
  }

  function setCachedToken(cacheKey, token, expiresInSeconds) {
    tokenCache.set(cacheKey, token, expiresInSeconds);
  }

  async function fetchBearerToken(wwwAuthHeader) {
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

    const { upstreamRes } = await requestWithRedirects(tokenUrl, {
      method: "GET",
      baseHeaders: {
        Accept: "application/json",
        "User-Agent": "elf2wasm-registry-proxy/1.0",
      },
      authToken: null,
    });

    if (upstreamRes.statusCode !== 200) {
      upstreamRes.resume();
      throw new ProxyError(502, `Registry auth server returned HTTP ${upstreamRes.statusCode}`);
    }

    const bodyText = await readBoundedBody(upstreamRes, MAX_TOKEN_RESPONSE_BYTES);
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

  async function requestWithRedirects(initialUrl, { method, baseHeaders, authToken }) {
    let currentUrl = initialUrl;
    let currentHeaders = { ...baseHeaders };
    if (authToken) {
      currentHeaders.Authorization = `Bearer ${authToken}`;
    }

    for (let hop = 0; hop <= maxRedirects; hop++) {
      const validated = await validateAndResolveUrl(currentUrl, { allowLocalRegistries, lookupFn });
      const { upstreamReq, upstreamRes } = await openUpstreamRequest(validated, {
        method,
        headers: currentHeaders,
        timeoutMs: requestTimeoutMs,
      });

      const status = upstreamRes.statusCode || 502;
      const location = upstreamRes.headers.location;

      if (REDIRECT_STATUSES.has(status) && location) {
        upstreamRes.resume();
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
          delete currentHeaders.Authorization;
        }
        currentUrl = nextUrl;
        continue;
      }

      return { upstreamReq, upstreamRes };
    }

    throw new ProxyError(502, "Too many redirects from upstream registry");
  }

  async function handleRequest(req, res, rawPathnameOverride = null) {
    try {
      const method = (req.method || "GET").toUpperCase();
      if (method !== "GET" && method !== "HEAD") {
        sendJsonError(res, 405, "Method Not Allowed", { Allow: "GET, HEAD" });
        return;
      }

      const rawPathname = rawPathnameOverride ?? (req.url || "/").split("?", 1)[0];
      const { registry, hostname, kind, repo, target } = parseProxyPath(rawPathname);

      const scheme = selectInitialScheme(hostname, allowLocalRegistries);
      const upstreamUrl = new URL(`${scheme}//${registry}/v2/${repo}/${kind}/${target}`);

      const baseHeaders = {
        "User-Agent": "elf2wasm-registry-proxy/1.0",
      };
      if (kind === "manifests") {
        const clientAccept = req.headers.accept;
        baseHeaders.Accept =
          clientAccept && clientAccept.trim() !== "*/*" && clientAccept.trim() !== ""
            ? clientAccept
            : DEFAULT_MANIFEST_ACCEPT;
      } else {
        baseHeaders.Accept = "*/*";
      }

      const cacheKey = `${registry}|${repo}`;
      let token = getCachedToken(cacheKey);

      let { upstreamReq, upstreamRes } = await requestWithRedirects(upstreamUrl, {
        method,
        baseHeaders,
        authToken: token,
      });

      // Handle OCI v2 401 Bearer challenge with at most one retry.
      if (upstreamRes.statusCode === 401) {
        const wwwAuth = upstreamRes.headers["www-authenticate"];
        upstreamRes.resume();
        tokenCache.delete(cacheKey);

        if (!wwwAuth) {
          throw new ProxyError(502, "Upstream registry returned 401 without WWW-Authenticate header");
        }

        const fetched = await fetchBearerToken(wwwAuth);
        setCachedToken(cacheKey, fetched.token, fetched.expiresIn);

        ({ upstreamReq, upstreamRes } = await requestWithRedirects(upstreamUrl, {
          method,
          baseHeaders,
          authToken: fetched.token,
        }));

        if (upstreamRes.statusCode === 401) {
          upstreamRes.resume();
          tokenCache.delete(cacheKey);
          throw new ProxyError(502, "Upstream registry rejected Bearer token");
        }
      }

      const status = upstreamRes.statusCode || 502;
      if (status === 404) {
        upstreamRes.resume();
        sendJsonError(res, 404, "Upstream OCI resource not found");
        return;
      }
      if (status < 200 || status >= 300) {
        upstreamRes.resume();
        sendJsonError(res, 502, `Upstream registry returned HTTP ${status}`);
        return;
      }

      // Forward explicit allowlist of headers without clobbering COOP/COEP set by server.mjs.
      for (const headerName of FORWARDED_RESPONSE_HEADERS) {
        const val = upstreamRes.headers[headerName];
        if (val !== undefined) {
          res.setHeader(headerName, val);
        }
      }

      res.writeHead(status);

      if (method === "HEAD") {
        upstreamRes.resume();
        res.end();
        return;
      }

      const onClientClose = () => {
        if (!res.writableEnded) {
          upstreamReq.destroy();
          upstreamRes.destroy();
        }
      };
      res.on("close", onClientClose);

      upstreamRes.on("error", () => {
        res.off("close", onClientClose);
        if (!res.writableEnded) {
          res.destroy();
        }
      });

      upstreamRes.on("end", () => {
        res.off("close", onClientClose);
      });

      upstreamRes.pipe(res);
    } catch (err) {
      if (err instanceof ProxyError) {
        sendJsonError(res, err.statusCode, err.message);
      } else {
        sendJsonError(res, 502, `Registry proxy error: ${err?.message || "unknown error"}`);
      }
    }
  }

  return {
    handleRequest,
    clearTokenCache() {
      tokenCache.clear();
    },
  };
}
