import http from "node:http";
import https from "node:https";
import dns from "node:dns/promises";
import net from "node:net";

export const DEFAULT_MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "*/*;q=0.1",
].join(", ");

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "docker-content-digest",
  "etag",
  "cache-control",
  "accept-ranges",
];
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;

const IPV6_BRACKET_RE = /^\[([0-9a-fA-F:.]+)\](?::([1-9]\d{0,4}))?$/;
const HOST_PORT_RE =
  /^([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*)(?::([1-9]\d{0,4}))?$/;
const REPO_RE =
  /^[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*)*$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

class ProxyError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = "ProxyError";
    this.statusCode = statusCode;
  }
}

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
 * Parse and strictly validate `/api/v2/<registry>/<repo...>/manifests/<ref>`
 * or `/api/v2/<registry>/<repo...>/blobs/<digest>`.
 * Throws ProxyError(400) on any invalid input.
 */
export function parseProxyPath(rawPathname) {
  if (typeof rawPathname !== "string" || !rawPathname.startsWith("/api/v2/")) {
    throw new ProxyError(400, "Invalid OCI proxy path");
  }

  // Reject control chars, backslashes, double slashes, and dot-dot sequences early.
  if (
    /[\x00-\x1f\x7f\\]/.test(rawPathname) ||
    rawPathname.includes("//") ||
    rawPathname.includes("..")
  ) {
    throw new ProxyError(400, "Malformed path in OCI proxy request");
  }

  const rest = rawPathname.slice("/api/v2/".length);
  const rawSegments = rest.split("/");
  if (rawSegments.length < 4 || rawSegments.some((s) => s.length === 0)) {
    throw new ProxyError(400, "Expected /api/v2/<registry>/<repo...>/<manifests|blobs>/<ref>");
  }

  // Allow percent-encoded brackets ONLY in the registry segment (e.g. %5B::1%5D)
  // so IPv6 literals are validated by the SSRF guard as 403 rather than crashing.
  let registry = rawSegments[0].replace(/%5b/gi, "[").replace(/%5d/gi, "]");
  if (registry.includes("%")) {
    throw new ProxyError(400, "Invalid percent-encoding in registry host");
  }

  // No percent-encoding allowed in repo, kind, or target segments.
  for (let i = 1; i < rawSegments.length; i++) {
    if (rawSegments[i].includes("%")) {
      throw new ProxyError(400, "Invalid percent-encoding in OCI path");
    }
  }

  // Validate registry host[:port]
  let hostname;
  let portStr;
  const ipv6Match = IPV6_BRACKET_RE.exec(registry);
  if (ipv6Match) {
    hostname = ipv6Match[1];
    portStr = ipv6Match[2];
    if (!net.isIPv6(hostname)) {
      throw new ProxyError(400, "Invalid IPv6 registry host");
    }
  } else {
    const hostMatch = HOST_PORT_RE.exec(registry);
    if (!hostMatch) {
      throw new ProxyError(400, "Invalid registry host");
    }
    hostname = hostMatch[1];
    portStr = hostMatch[2];
  }

  if (portStr !== undefined) {
    const portNum = Number(portStr);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      throw new ProxyError(400, "Invalid registry port");
    }
  }

  const kind = rawSegments[rawSegments.length - 2];
  const target = rawSegments[rawSegments.length - 1];
  const repo = rawSegments.slice(1, -2).join("/");

  if (repo.length < 1 || repo.length > 255 || !REPO_RE.test(repo)) {
    throw new ProxyError(400, "Invalid repository name");
  }

  if (kind === "blobs") {
    if (!DIGEST_RE.test(target)) {
      throw new ProxyError(400, "Invalid blob digest (expected sha256:<64 hex chars>)");
    }
  } else if (kind === "manifests") {
    if (!DIGEST_RE.test(target) && !TAG_RE.test(target)) {
      throw new ProxyError(400, "Invalid manifest reference");
    }
  } else {
    throw new ProxyError(400, "Unsupported OCI resource type (expected manifests or blobs)");
  }

  return { registry, hostname, kind, repo, target };
}

/**
 * Parse an OCI `WWW-Authenticate: Bearer realm="...",service="...",scope="..."` header.
 * Returns `{ realm, service?, scope?, ... }` or `null` if not a valid Bearer challenge.
 */
export function parseWwwAuthenticate(headerValue) {
  if (typeof headerValue !== "string" || headerValue.trim().length === 0) {
    return null;
  }

  const match = /\bBearer\s+(.+)$/i.exec(headerValue.trim());
  if (!match) {
    return null;
  }

  const paramStr = match[1];
  const params = {};
  const pairRe = /([a-zA-Z0-9_-]+)=(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
  let m;
  while ((m = pairRe.exec(paramStr)) !== null) {
    const key = m[1].toLowerCase();
    const val = m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : m[3];
    params[key] = val;
  }

  if (!params.realm) {
    return null;
  }
  return params;
}

function parseIpv4ToUint32(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return null;
    n = (n * 256) + octet;
  }
  return n >>> 0;
}

function isBlockedIpv4Uint32(n, allowLoopback) {
  // 0.0.0.0/8 (unspecified)
  if ((n & 0xff000000) >>> 0 === 0x00000000) return true;
  // 10.0.0.0/8 (RFC 1918 private)
  if ((n & 0xff000000) >>> 0 === 0x0a000000) return true;
  // 100.64.0.0/10 (CGNAT — note: 100.55.x.x is public and NOT matched)
  if ((n & 0xffc00000) >>> 0 === 0x64400000) return true;
  // 127.0.0.0/8 (loopback)
  if ((n & 0xff000000) >>> 0 === 0x7f000000) return !allowLoopback;
  // 169.254.0.0/16 (link-local / cloud IMDS — ALWAYS blocked)
  if ((n & 0xffff0000) >>> 0 === 0xa9fe0000) return true;
  // 172.16.0.0/12 (RFC 1918 private — note: 172.64.x.x is public and NOT matched)
  if ((n & 0xfff00000) >>> 0 === 0xac100000) return true;
  // 192.0.0.0/24 (IETF protocol assignments)
  if ((n & 0xffffff00) >>> 0 === 0xc0000000) return true;
  // 192.0.2.0/24 (TEST-NET-1)
  if ((n & 0xffffff00) >>> 0 === 0xc0000200) return true;
  // 192.168.0.0/16 (RFC 1918 private)
  if ((n & 0xffff0000) >>> 0 === 0xc0a80000) return true;
  // 198.18.0.0/15 (benchmarking)
  if ((n & 0xfffe0000) >>> 0 === 0xc6120000) return true;
  // 198.51.100.0/24 (TEST-NET-2)
  if ((n & 0xffffff00) >>> 0 === 0xc6336400) return true;
  // 203.0.113.0/24 (TEST-NET-3)
  if ((n & 0xffffff00) >>> 0 === 0xcb007100) return true;
  // 224.0.0.0/4 (multicast) and 240.0.0.0/4 (reserved/broadcast)
  if ((n & 0xe0000000) >>> 0 === 0xe0000000) return true;
  return false;
}

function isLoopbackIpv4Uint32(n) {
  return ((n & 0xff000000) >>> 0) === 0x7f000000;
}

function parseIpv6ToGroups(rawIp) {
  const ip = rawIp.split("%")[0].toLowerCase();
  const halves = ip.split("::");
  if (halves.length > 2) return null;

  const parseHalf = (str) => {
    if (!str) return [];
    const tokens = str.split(":");
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok.includes(".")) {
        if (i !== tokens.length - 1) return null;
        const v4 = parseIpv4ToUint32(tok);
        if (v4 === null) return null;
        out.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(tok)) return null;
        out.push(parseInt(tok, 16));
      }
    }
    return out;
  };

  const left = parseHalf(halves[0]);
  if (left === null) return null;

  if (halves.length === 1) {
    return left.length === 8 ? left : null;
  }

  const right = parseHalf(halves[1]);
  if (right === null) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;

  return [...left, ...new Array(missing).fill(0), ...right];
}

function isLoopbackIp(ip) {
  const cleaned = ip.replace(/^\[|\]$/g, "");
  const fam = net.isIP(cleaned);
  if (fam === 4) {
    const n = parseIpv4ToUint32(cleaned);
    return n !== null && isLoopbackIpv4Uint32(n);
  }
  if (fam === 6) {
    const g = parseIpv6ToGroups(cleaned);
    if (!g) return false;
    return (
      g[0] === 0 &&
      g[1] === 0 &&
      g[2] === 0 &&
      g[3] === 0 &&
      g[4] === 0 &&
      g[5] === 0 &&
      g[6] === 0 &&
      g[7] === 1
    );
  }
  return false;
}

/**
 * Returns true if `ip` is in a blocked private/loopback/link-local/reserved range.
 */
export function isBlockedIp(ip, { allowLoopback = false } = {}) {
  if (typeof ip !== "string") return true;
  const cleaned = ip.trim().replace(/^\[|\]$/g, "");
  const fam = net.isIP(cleaned);

  if (fam === 4) {
    const n = parseIpv4ToUint32(cleaned);
    if (n === null) return true;
    return isBlockedIpv4Uint32(n, allowLoopback);
  }

  if (fam === 6) {
    const g = parseIpv6ToGroups(cleaned);
    if (!g) return true;

    // ::/128 (unspecified)
    if (g.every((v) => v === 0)) return true;

    // ::1/128 (loopback)
    if (
      g[0] === 0 &&
      g[1] === 0 &&
      g[2] === 0 &&
      g[3] === 0 &&
      g[4] === 0 &&
      g[5] === 0 &&
      g[6] === 0 &&
      g[7] === 1
    ) {
      return !allowLoopback;
    }

    // ::/96 (deprecated RFC 4291 IPv4-compatible IPv6; :: and ::1 already handled above)
    if (
      g[0] === 0 &&
      g[1] === 0 &&
      g[2] === 0 &&
      g[3] === 0 &&
      g[4] === 0 &&
      g[5] === 0
    ) {
      return true;
    }

    // ::ffff:0:0/96 (IPv4-mapped IPv6)
    if (
      g[0] === 0 &&
      g[1] === 0 &&
      g[2] === 0 &&
      g[3] === 0 &&
      g[4] === 0 &&
      g[5] === 0xffff
    ) {
      const v4 = ((g[6] << 16) | g[7]) >>> 0;
      return isBlockedIpv4Uint32(v4, false);
    }

    // ::ffff:0:0:0/96 (IPv4-translated IPv6)
    if (
      g[0] === 0 &&
      g[1] === 0 &&
      g[2] === 0 &&
      g[3] === 0 &&
      g[4] === 0xffff &&
      g[5] === 0
    ) {
      return true;
    }

    // 64:ff9b::/96 (NAT64 well-known prefix)
    if (
      g[0] === 0x0064 &&
      g[1] === 0xff9b &&
      g[2] === 0 &&
      g[3] === 0 &&
      g[4] === 0 &&
      g[5] === 0
    ) {
      const v4 = ((g[6] << 16) | g[7]) >>> 0;
      return isBlockedIpv4Uint32(v4, false);
    }

    // 64:ff9b:1::/48 (NAT64 local-use prefix)
    if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0x0001) return true;

    // 100::/64 (Discard-Only Address Block)
    if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true;

    // 2001:0000::/32 (Teredo tunneling)
    if (g[0] === 0x2001 && g[1] === 0x0000) return true;

    // 2001:0002::/48 (Benchmarking)
    if (g[0] === 0x2001 && g[1] === 0x0002 && g[2] === 0x0000) return true;

    // 2001:db8::/32 (Documentation)
    if (g[0] === 0x2001 && g[1] === 0x0db8) return true;

    // 2002::/16 (6to4)
    if (g[0] === 0x2002) return true;

    // fc00::/7 (Unique Local Address)
    if ((g[0] & 0xfe00) === 0xfc00) return true;

    // fe80::/10 (Link-Local)
    if ((g[0] & 0xffc0) === 0xfe80) return true;

    // fec0::/10 (Deprecated Site-Local)
    if ((g[0] & 0xffc0) === 0xfec0) return true;

    // ff00::/8 (Multicast)
    if ((g[0] & 0xff00) === 0xff00) return true;

    return false;
  }

  // Unparseable IP string -> fail closed
  return true;
}

function isLocalhostName(host) {
  return host === "localhost" || host.endsWith(".localhost");
}

/**
 * Validates URL protocol, credentials, hostname, and ALL resolved DNS addresses
 * against SSRF rules, returning a DNS-rebinding-pinned `lookup` callback.
 */
export async function validateAndResolveUrl(
  urlObj,
  { allowLocalRegistries = false, lookupFn = dns.lookup } = {}
) {
  if (!(urlObj instanceof URL)) {
    throw new ProxyError(403, "Invalid upstream URL");
  }

  if (urlObj.username || urlObj.password) {
    throw new ProxyError(403, "Embedded credentials in upstream URL are forbidden");
  }

  if (urlObj.protocol !== "https:" && urlObj.protocol !== "http:") {
    throw new ProxyError(403, `Unsupported protocol: ${urlObj.protocol}`);
  }

  if (urlObj.protocol === "http:" && !allowLocalRegistries) {
    throw new ProxyError(403, "Plain HTTP upstream registries are forbidden (HTTPS required)");
  }

  const host = urlObj.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");

  if (!host) {
    throw new ProxyError(403, "Empty upstream hostname");
  }

  if (host === "metadata.google.internal") {
    throw new ProxyError(403, "Access to metadata host is forbidden");
  }

  if (isLocalhostName(host) && !allowLocalRegistries) {
    throw new ProxyError(403, "Access to localhost registry is forbidden");
  }

  let resolvedAddrs;
  const ipFamily = net.isIP(host);
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
        family: r.family || net.isIP(r.address),
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

function selectInitialScheme(hostname, allowLocalRegistries) {
  if (!allowLocalRegistries) return "https:";
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  if (isLocalhostName(normalized) || isLoopbackIp(normalized)) {
    return "http:";
  }
  return "https:";
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

  // Map<string, { token: string, expiresAt: number }>
  const tokenCache = new Map();

  function getCachedToken(cacheKey) {
    const entry = tokenCache.get(cacheKey);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      tokenCache.delete(cacheKey);
      return null;
    }
    return entry.token;
  }

  function setCachedToken(cacheKey, token, expiresInSeconds) {
    const now = Date.now();
    // Prune expired entries first if near capacity.
    if (tokenCache.size >= tokenCacheMaxEntries) {
      for (const [k, v] of tokenCache.entries()) {
        if (now >= v.expiresAt) {
          tokenCache.delete(k);
        }
      }
    }
    // Evict oldest entry if still at capacity.
    while (tokenCache.size >= tokenCacheMaxEntries) {
      const oldestKey = tokenCache.keys().next().value;
      if (oldestKey === undefined) break;
      tokenCache.delete(oldestKey);
    }

    const rawMs = (Number.isFinite(expiresInSeconds) && expiresInSeconds > 0 ? expiresInSeconds : 300) * 1000;
    const clampedMs = Math.min(Math.max(rawMs, tokenCacheMinTtlMs), tokenCacheMaxTtlMs);
    const effectiveTtlMs = Math.max(clampedMs - tokenCacheSafetyMarginMs, 5_000);
    tokenCache.set(cacheKey, { token, expiresAt: now + effectiveTtlMs });
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

    const token = parsed.token || parsed.access_token;
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
