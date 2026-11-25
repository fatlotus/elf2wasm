/**
 * Pure-ESM shared git repository snapshot specification, validation, and
 * forge tarball URL resolution core.
 *
 * Shared by both the Node.js streaming proxy (`server/git_proxy.mjs`) and the
 * Cloudflare Worker (`worker/src/index.mjs`).
 *
 * ZERO `node:*` imports — relies strictly on standard ECMAScript & Web APIs
 * (`URL`, `URLSearchParams`, `Set`, `RegExp`) plus `./proxy_core.mjs`.
 */

import {
  ProxyError,
  validateUrlPolicy,
  classifyIp,
  isBlockedIp,
  isLoopbackIp,
  isLocalhostName,
} from "./proxy_core.mjs";

export const DEFAULT_GIT_REF = "HEAD";
export const GIT_ARCHIVE_USER_AGENT = "elf2wasm-git-proxy/1.0";
export const GIT_ARCHIVE_IMMUTABLE_CACHE_CONTROL = "public, max-age=604800, immutable";
export const GIT_ARCHIVE_MUTABLE_CACHE_CONTROL = "public, max-age=300";

export const SUPPORTED_FORGE_HOSTS = new Set([
  "github.com",
  "gitlab.com",
  "codeberg.org",
]);

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const WHITESPACE_RE = /\s/;
const GIT_REF_FORBIDDEN_RE = /[~^:?*\[\\]/;
const REPO_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const ENCODED_TRAVERSAL_RE = /(%2e%2e|\.%2e|%2e\.)/i;
const ENCODED_BAD_CHARS_RE = /(%00|%2f|%5c)/i;
const SCHEME_PREFIX_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

const MAX_REPO_LENGTH = 512;
const MAX_REF_LENGTH = 255;
const MAX_PATH_SEGMENTS = 20;

export function isImmutableGitRef(ref) {
  return typeof ref === "string" && FULL_SHA_RE.test(ref);
}

export function getGitArchiveCacheControl(ref) {
  return isImmutableGitRef(ref)
    ? GIT_ARCHIVE_IMMUTABLE_CACHE_CONTROL
    : GIT_ARCHIVE_MUTABLE_CACHE_CONTROL;
}

/**
 * Validate a git ref (commit SHA, branch name, tag name, or refs/heads|tags/...).
 * Empty/omitted ref defaults to "HEAD".
 * Throws ProxyError(400, ...) on invalid input.
 */
export function validateGitRef(rawRef) {
  if (rawRef === undefined || rawRef === null || rawRef === "") {
    return DEFAULT_GIT_REF;
  }
  if (typeof rawRef !== "string") {
    throw new ProxyError(400, "Invalid git ref");
  }
  if (rawRef.length > MAX_REF_LENGTH) {
    throw new ProxyError(400, `Git ref exceeds maximum length (${MAX_REF_LENGTH})`);
  }
  if (CONTROL_CHAR_RE.test(rawRef) || WHITESPACE_RE.test(rawRef)) {
    throw new ProxyError(400, "Git ref contains control characters or whitespace");
  }
  if (rawRef.startsWith("-")) {
    throw new ProxyError(400, "Git ref must not start with '-'");
  }
  if (rawRef.startsWith("/") || rawRef.endsWith("/") || rawRef.includes("//")) {
    throw new ProxyError(400, "Git ref has invalid slash placement");
  }
  if (rawRef.endsWith(".")) {
    throw new ProxyError(400, "Git ref must not end with '.'");
  }
  if (rawRef.includes("..") || rawRef.includes("@{") || GIT_REF_FORBIDDEN_RE.test(rawRef)) {
    throw new ProxyError(400, "Git ref contains forbidden characters or sequences");
  }

  const segments = rawRef.split("/");
  for (const seg of segments) {
    if (
      seg.length === 0 ||
      seg === "." ||
      seg === ".." ||
      seg.startsWith(".") ||
      seg.endsWith(".") ||
      seg.endsWith(".lock")
    ) {
      throw new ProxyError(400, "Git ref contains an invalid path component");
    }
  }

  if (FULL_SHA_RE.test(rawRef)) {
    return rawRef.toLowerCase();
  }
  return rawRef;
}

function validateRepoSegment(seg, label = "repository path segment") {
  if (!seg || seg === "." || seg === ".." || seg.includes("..") || !REPO_SEGMENT_RE.test(seg)) {
    throw new ProxyError(400, `Invalid ${label}`);
  }
  return seg;
}

function stripOptionalDotGit(segment) {
  if (segment.endsWith(".git")) {
    const stripped = segment.slice(0, -4);
    if (!stripped) {
      throw new ProxyError(400, "Invalid repository name");
    }
    return stripped;
  }
  return segment;
}

function encodeRefPath(ref) {
  return ref
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

/**
 * Parse and validate a `repo` identifier:
 * - GitHub shorthand: `owner/repo` or `owner/repo.git`
 * - GitHub URL: `https://github.com/<owner>/<repo>[.git]`
 * - GitLab URL: `https://gitlab.com/<group...>/<repo>[.git]`
 * - Codeberg URL: `https://codeberg.org/<owner>/<repo>[.git]`
 * - Loopback URL (ONLY when `allowLocalRegistries` is true):
 *   `http://127.0.0.1:<port>/<path...>` / `http://[::1]:<port>/<path...>` / `http://localhost:<port>/<path...>`
 *
 * Throws ProxyError(400) for invalid syntax / embedded credentials / disallowed protocols /
 * plain HTTP on public hosts / unsupported public forge hosts, and ProxyError(403) for
 * SSRF / blocked hosts.
 */
export function parseGitRepo(rawRepo, { allowLocalRegistries = false } = {}) {
  if (typeof rawRepo !== "string" || rawRepo.length === 0) {
    throw new ProxyError(400, "Missing required repository parameter");
  }
  if (rawRepo.length > MAX_REPO_LENGTH) {
    throw new ProxyError(400, `Repository identifier exceeds maximum length (${MAX_REPO_LENGTH})`);
  }
  if (CONTROL_CHAR_RE.test(rawRepo) || WHITESPACE_RE.test(rawRepo)) {
    throw new ProxyError(400, "Repository identifier contains control characters or whitespace");
  }
  if (
    rawRepo.includes("\\") ||
    rawRepo.includes("..") ||
    ENCODED_TRAVERSAL_RE.test(rawRepo) ||
    ENCODED_BAD_CHARS_RE.test(rawRepo)
  ) {
    throw new ProxyError(400, "Repository identifier contains forbidden characters or traversal");
  }

  // Full URL form (contains "://" or starts with a URI scheme like "ftp:", "file:", "javascript:")
  if (rawRepo.includes("://") || SCHEME_PREFIX_RE.test(rawRepo)) {
    let urlObj;
    try {
      urlObj = new URL(rawRepo);
    } catch {
      throw new ProxyError(400, "Invalid repository URL");
    }

    if (urlObj.protocol !== "https:" && urlObj.protocol !== "http:") {
      throw new ProxyError(400, `Unsupported repository URL protocol: ${urlObj.protocol}`);
    }

    const host = urlObj.hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .replace(/\.+$/, "");

    if (!host) {
      throw new ProxyError(400, "Repository URL must include a hostname");
    }

    // Enforce SSRF / blocked-host policy (403) BEFORE rejecting credentials or plain HTTP
    // on public hosts (400), so loopback/private/link-local/IMDS/metadata hosts always return 403.
    if (host === "metadata.google.internal") {
      throw new ProxyError(403, "Access to metadata host is forbidden");
    }
    if (isLocalhostName(host) && !allowLocalRegistries) {
      throw new ProxyError(403, "Access to localhost repository is forbidden");
    }
    const ipFamily = classifyIp(host);
    if (ipFamily !== 0 && isBlockedIp(host, { allowLoopback: allowLocalRegistries })) {
      throw new ProxyError(403, `Upstream address ${host} is blocked by SSRF policy`);
    }

    if (urlObj.username || urlObj.password) {
      throw new ProxyError(400, "Repository URL must not contain embedded credentials");
    }
    if (
      urlObj.protocol === "http:" &&
      !(allowLocalRegistries && (isLoopbackIp(host) || isLocalhostName(host)))
    ) {
      throw new ProxyError(400, "Repository URL must use HTTPS");
    }

    // Defense-in-depth URL policy enforcement.
    validateUrlPolicy(urlObj, {
      allowLocalRegistries,
      requireLoopbackHostForHttp: true,
    });

    if (urlObj.search || urlObj.hash) {
      throw new ProxyError(400, "Repository URL must not contain query parameters or fragments");
    }

    // Check raw path after authority for duplicate slashes
    const schemeEnd = rawRepo.indexOf("://");
    if (schemeEnd !== -1) {
      const pathStart = rawRepo.indexOf("/", schemeEnd + 3);
      if (pathStart !== -1) {
        const rawPathPart = rawRepo.slice(pathStart);
        if (rawPathPart.includes("//")) {
          throw new ProxyError(400, "Repository URL path must not contain empty segments");
        }
      }
    }

    let pathname = urlObj.pathname;
    if (pathname.endsWith("/") && pathname.length > 1) {
      pathname = pathname.slice(0, -1);
    }

    const rawSegments = pathname.split("/").slice(1);
    if (rawSegments.length === 0 || rawSegments.some((s) => s.length === 0)) {
      throw new ProxyError(400, "Repository URL must include a repository path");
    }
    if (rawSegments.length > MAX_PATH_SEGMENTS) {
      throw new ProxyError(400, "Repository URL path has too many segments");
    }

    const segments = rawSegments.map((seg, idx) => {
      const cleaned = idx === rawSegments.length - 1 ? stripOptionalDotGit(seg) : seg;
      return validateRepoSegment(cleaned);
    });

    if (host === "github.com" || host === "www.github.com") {
      if (urlObj.protocol !== "https:" || urlObj.port !== "") {
        throw new ProxyError(400, "GitHub repositories must use standard HTTPS");
      }
      if (segments.length !== 2) {
        throw new ProxyError(400, "GitHub repository URL must have format https://github.com/<owner>/<repo>");
      }
      const [owner, repo] = segments;
      return {
        provider: "github",
        host: "github.com",
        owner,
        repo,
        pathSegments: [owner, repo],
        canonicalRepo: `${owner}/${repo}`,
        origin: "https://github.com",
      };
    }

    if (host === "gitlab.com") {
      if (urlObj.protocol !== "https:" || urlObj.port !== "") {
        throw new ProxyError(400, "GitLab repositories must use standard HTTPS");
      }
      if (segments.length < 2) {
        throw new ProxyError(400, "GitLab repository URL must include group and repository name");
      }
      const repo = segments[segments.length - 1];
      const owner = segments.slice(0, -1).join("/");
      return {
        provider: "gitlab",
        host: "gitlab.com",
        owner,
        repo,
        pathSegments: segments,
        canonicalRepo: segments.join("/"),
        origin: "https://gitlab.com",
      };
    }

    if (host === "codeberg.org") {
      if (urlObj.protocol !== "https:" || urlObj.port !== "") {
        throw new ProxyError(400, "Codeberg repositories must use standard HTTPS");
      }
      if (segments.length !== 2) {
        throw new ProxyError(400, "Codeberg repository URL must have format https://codeberg.org/<owner>/<repo>");
      }
      const [owner, repo] = segments;
      return {
        provider: "codeberg",
        host: "codeberg.org",
        owner,
        repo,
        pathSegments: [owner, repo],
        canonicalRepo: `${owner}/${repo}`,
        origin: "https://codeberg.org",
      };
    }

    if (allowLocalRegistries && (isLoopbackIp(host) || isLocalhostName(host))) {
      const repo = segments[segments.length - 1];
      const owner = segments.length > 1 ? segments.slice(0, -1).join("/") : "";
      return {
        provider: "local",
        host,
        owner,
        repo,
        pathSegments: segments,
        canonicalRepo: `${urlObj.origin}/${segments.join("/")}`,
        origin: urlObj.origin,
      };
    }

    throw new ProxyError(400, `Unsupported git forge host: ${host}`);
  }

  // GitHub shorthand: `owner/repo` or `owner/repo.git`
  if (
    rawRepo.includes("@") ||
    rawRepo.includes(":") ||
    rawRepo.includes("?") ||
    rawRepo.includes("#") ||
    rawRepo.includes("%")
  ) {
    throw new ProxyError(400, "Invalid repository shorthand");
  }

  const parts = rawRepo.split("/");
  if (parts.length !== 2) {
    throw new ProxyError(400, "Repository shorthand must have format <owner>/<repo>");
  }

  const owner = validateRepoSegment(parts[0], "repository owner");
  const repo = validateRepoSegment(stripOptionalDotGit(parts[1]), "repository name");

  return {
    provider: "github",
    host: "github.com",
    owner,
    repo,
    pathSegments: [owner, repo],
    canonicalRepo: `${owner}/${repo}`,
    origin: "https://github.com",
  };
}

/**
 * Resolve a validated git repo + ref into a canonical upstream tarball URL
 * and caching/extraction metadata.
 */
export function resolveGitArchiveSpec(rawRepo, rawRef, { allowLocalRegistries = false } = {}) {
  const parsed = parseGitRepo(rawRepo, { allowLocalRegistries });
  const ref = validateGitRef(rawRef);
  const encodedRefPath = encodeRefPath(ref);

  let archiveUrl;
  if (parsed.provider === "github") {
    archiveUrl = new URL(
      `https://codeload.github.com/${parsed.owner}/${parsed.repo}/tar.gz/${encodedRefPath}`
    );
  } else if (parsed.provider === "gitlab") {
    const safeFilenameRef = encodeURIComponent(ref.replaceAll("/", "-"));
    archiveUrl = new URL(
      `https://gitlab.com/${parsed.pathSegments.join("/")}/-/archive/${encodedRefPath}/${encodeURIComponent(parsed.repo)}-${safeFilenameRef}.tar.gz`
    );
  } else if (parsed.provider === "codeberg") {
    archiveUrl = new URL(
      `https://codeberg.org/${parsed.owner}/${parsed.repo}/archive/${encodedRefPath}.tar.gz`
    );
  } else if (parsed.provider === "local") {
    archiveUrl = new URL(
      `${parsed.origin}/${parsed.pathSegments.join("/")}/archive/${encodedRefPath}.tar.gz`
    );
  } else {
    throw new ProxyError(400, `Unsupported git provider: ${parsed.provider}`);
  }

  const isImmutableRef = isImmutableGitRef(ref);
  const cacheControl = getGitArchiveCacheControl(ref);

  return {
    ...parsed,
    ref,
    isImmutableRef,
    cacheControl,
    defaultStripComponents: 1,
    archiveUrl,
  };
}

/**
 * Extract `repo` and `ref` from a raw request URL string, `URL`, or `URLSearchParams`,
 * validating raw query hygiene before decoding.
 */
export function parseGitArchiveQuery(rawUrlOrParams, { allowLocalRegistries = false } = {}) {
  let params;
  if (rawUrlOrParams instanceof URLSearchParams) {
    params = rawUrlOrParams;
  } else if (rawUrlOrParams instanceof URL) {
    const rawSearch = rawUrlOrParams.search || "";
    if (CONTROL_CHAR_RE.test(rawSearch) || /%00/i.test(rawSearch)) {
      throw new ProxyError(400, "Invalid characters in query string");
    }
    params = rawUrlOrParams.searchParams;
  } else if (typeof rawUrlOrParams === "string") {
    if (CONTROL_CHAR_RE.test(rawUrlOrParams) || /%00/i.test(rawUrlOrParams)) {
      throw new ProxyError(400, "Invalid characters in request URL");
    }
    const withoutHash = rawUrlOrParams.split("#", 1)[0];
    const qIdx = withoutHash.indexOf("?");
    const rawQuery = qIdx === -1 ? "" : withoutHash.slice(qIdx + 1);
    params = new URLSearchParams(rawQuery);
  } else {
    throw new ProxyError(400, "Invalid git archive query");
  }

  const repo = params.get("repo");
  const ref = params.get("ref");
  if (!repo) {
    throw new ProxyError(400, "Missing required query parameter: repo");
  }

  return resolveGitArchiveSpec(repo, ref, { allowLocalRegistries });
}

/**
 * Parse an optional upstream `X-Git-Strip-Components` header safely.
 * Returns an integer in [0, 16], or `fallback` if absent/invalid.
 */
export function parseStripComponentsHeader(rawHeader, fallback = 1) {
  if (typeof rawHeader === "string" && /^\d+$/.test(rawHeader.trim())) {
    const n = Number.parseInt(rawHeader.trim(), 10);
    if (Number.isInteger(n) && n >= 0 && n <= 16) {
      return n;
    }
  }
  return fallback;
}
