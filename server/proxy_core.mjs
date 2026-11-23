/**
 * Pure-ESM OCI v2 proxy core (zero `node:*` imports).
 * Shared between the Node.js local server (`server/registry_proxy.mjs`)
 * and the Cloudflare Worker entrypoint (`worker/src/index.mjs`).
 */

export const DEFAULT_MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "*/*;q=0.1",
].join(", ");

export const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "docker-content-digest",
  "etag",
  "cache-control",
  "accept-ranges",
];

export const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;

const IPV6_BRACKET_RE = /^\[([0-9a-fA-F:.]+)\](?::([1-9]\d{0,4}))?$/;
const HOST_PORT_RE =
  /^([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*)(?::([1-9]\d{0,4}))?$/;
const REPO_RE =
  /^[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*)*$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

export class ProxyError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = "ProxyError";
    this.statusCode = statusCode;
  }
}

/**
 * Extract the raw pathname from a relative path or full URL string
 * BEFORE `new URL()` normalizes `..` or `//` sequences.
 */
export function extractRawPathname(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    return "/";
  }
  const withoutQuery = rawUrl.split(/[?#]/, 1)[0];
  if (withoutQuery.startsWith("/")) {
    return withoutQuery;
  }
  const match = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*([\s\S]*)$/.exec(withoutQuery);
  if (match) {
    return match[1] || "/";
  }
  return withoutQuery;
}

export function parseIpv4ToUint32(ip) {
  if (typeof ip !== "string") return null;
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith("0")) return null;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return null;
    n = n * 256 + octet;
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

export function parseIpv6ToGroups(rawIp) {
  if (typeof rawIp !== "string" || !rawIp.includes(":")) return null;
  const ip = rawIp.split("%")[0].toLowerCase();
  const halves = ip.split("::");
  if (halves.length > 2) return null;

  const parseHalf = (str, allowIpv4) => {
    if (!str) return [];
    const tokens = str.split(":");
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok.includes(".")) {
        if (!allowIpv4 || i !== tokens.length - 1) return null;
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

  const left = parseHalf(halves[0], halves.length === 1);
  if (left === null) return null;

  if (halves.length === 1) {
    return left.length === 8 ? left : null;
  }

  const right = parseHalf(halves[1], true);
  if (right === null) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;

  return [...left, ...new Array(missing).fill(0), ...right];
}

/**
 * Pure-JS replacement for `net.isIP()`:
 * returns `4` for IPv4, `6` for IPv6, or `0` otherwise.
 */
export function classifyIp(ip) {
  if (typeof ip !== "string" || ip.length === 0) return 0;
  if (ip.includes("%")) return 0;
  if (parseIpv4ToUint32(ip) !== null) return 4;
  if (parseIpv6ToGroups(ip) !== null) return 6;
  return 0;
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
    if (classifyIp(hostname) !== 6) {
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

  const match = /(?:^|[,\s])Bearer\s+([\s\S]+)$/i.exec(headerValue.trim());
  if (!match) {
    return null;
  }

  const paramStr = match[1];
  const params = {};
  let pos = 0;
  const len = paramStr.length;

  while (pos < len) {
    // Skip leading whitespace and commas between auth-params.
    while (pos < len && (paramStr[pos] === " " || paramStr[pos] === "\t" || paramStr[pos] === ",")) {
      pos++;
    }
    if (pos >= len) break;

    const keyStart = pos;
    while (pos < len && /[a-zA-Z0-9_-]/.test(paramStr[pos])) {
      pos++;
    }
    if (pos === keyStart) break;
    const key = paramStr.slice(keyStart, pos).toLowerCase();

    // Skip optional whitespace before '='.
    let eqPos = pos;
    while (eqPos < len && (paramStr[eqPos] === " " || paramStr[eqPos] === "\t")) {
      eqPos++;
    }

    // If the token is not followed by '=', it is a bare auth-scheme starting
    // a subsequent challenge (e.g. `, Basic realm="..."`) — stop here.
    if (eqPos >= len || paramStr[eqPos] !== "=") {
      break;
    }

    pos = eqPos + 1;
    while (pos < len && (paramStr[pos] === " " || paramStr[pos] === "\t")) {
      pos++;
    }

    let val = "";
    if (pos < len && paramStr[pos] === '"') {
      pos++; // skip opening quote
      while (pos < len && paramStr[pos] !== '"') {
        if (paramStr[pos] === "\\" && pos + 1 < len) {
          val += paramStr[pos + 1];
          pos += 2;
        } else {
          val += paramStr[pos];
          pos++;
        }
      }
      if (pos >= len || paramStr[pos] !== '"') {
        break;
      }
      pos++; // skip closing quote
    } else {
      const valStart = pos;
      while (pos < len && paramStr[pos] !== "," && paramStr[pos] !== " " && paramStr[pos] !== "\t") {
        pos++;
      }
      val = paramStr.slice(valStart, pos);
    }

    params[key] = val;

    while (pos < len && (paramStr[pos] === " " || paramStr[pos] === "\t")) {
      pos++;
    }
    if (pos < len) {
      if (paramStr[pos] === ",") {
        pos++;
      } else {
        break;
      }
    }
  }

  if (!params.realm) {
    return null;
  }
  return params;
}

export function isLoopbackIp(ip) {
  if (typeof ip !== "string") return false;
  const cleaned = ip.trim().replace(/^\[|\]$/g, "");
  const fam = classifyIp(cleaned);
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
  const fam = classifyIp(cleaned);

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

export function isLocalhostName(host) {
  return host === "localhost" || host.endsWith(".localhost");
}

/**
 * Pure URL-level SSRF policy validation (no DNS calls).
 * Validates protocol, credentials, hostname, metadata hosts, localhost, and IP literals.
 * Returns `{ url, host, ipFamily }`.
 */
export function validateUrlPolicy(
  urlObj,
  { allowLocalRegistries = false, requireLoopbackHostForHttp = false } = {}
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

  const ipFamily = classifyIp(host);
  if (ipFamily !== 0) {
    if (isBlockedIp(host, { allowLoopback: allowLocalRegistries })) {
      throw new ProxyError(403, `Upstream address ${host} is blocked by SSRF policy`);
    }
    if (urlObj.protocol === "http:" && !isLoopbackIp(host)) {
      throw new ProxyError(403, "Plain HTTP is only permitted for loopback registries");
    }
  } else if (urlObj.protocol === "http:" && requireLoopbackHostForHttp && !isLocalhostName(host)) {
    throw new ProxyError(403, "Plain HTTP is only permitted for loopback registries");
  }

  return { url: urlObj, host, ipFamily };
}

export function selectInitialScheme(hostname, allowLocalRegistries) {
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

/**
 * Bounded in-memory Bearer token cache with TTL clamping and oldest-entry eviction.
 */
export function createTokenCache(options = {}) {
  const maxEntries = options.maxEntries ?? 256;
  const minTtlMs = options.minTtlMs ?? 30_000;
  const maxTtlMs = options.maxTtlMs ?? 3_600_000;
  const safetyMarginMs = options.safetyMarginMs ?? 15_000;

  // Map<string, { token: string, expiresAt: number }>
  const cache = new Map();

  function get(cacheKey) {
    const entry = cache.get(cacheKey);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      cache.delete(cacheKey);
      return null;
    }
    return entry.token;
  }

  function set(cacheKey, token, expiresInSeconds) {
    const now = Date.now();
    // Prune expired entries first if near capacity.
    if (cache.size >= maxEntries) {
      for (const [k, v] of cache.entries()) {
        if (now >= v.expiresAt) {
          cache.delete(k);
        }
      }
    }
    // Evict oldest entry if still at capacity.
    while (cache.size >= maxEntries) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey === undefined) break;
      cache.delete(oldestKey);
    }

    const rawMs =
      (Number.isFinite(expiresInSeconds) && expiresInSeconds > 0 ? expiresInSeconds : 300) * 1000;
    const clampedMs = Math.min(Math.max(rawMs, minTtlMs), maxTtlMs);
    const effectiveTtlMs = Math.max(clampedMs - safetyMarginMs, 5_000);
    cache.set(cacheKey, { token, expiresAt: now + effectiveTtlMs });
  }

  return {
    get,
    set,
    delete(cacheKey) {
      return cache.delete(cacheKey);
    },
    clear() {
      cache.clear();
    },
    size() {
      return cache.size;
    },
  };
}
