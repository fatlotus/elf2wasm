import http from "node:http";
import https from "node:https";
import dns from "node:dns/promises";
import { REDIRECT_STATUSES, ProxyError } from "./proxy_core.mjs";
import { validateAndResolveUrl } from "./registry_proxy.mjs";
import {
  GIT_ARCHIVE_USER_AGENT,
  parseGitArchiveQuery,
  parseStripComponentsHeader,
} from "./git_core.mjs";

const RETRY_AFTER_SAFE_RE = /^[A-Za-z0-9, :+-]{1,64}$/;

function sendJsonError(res, statusCode, message, method = "GET", extraHeaders = null) {
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
  if (method === "HEAD") {
    res.end();
  } else {
    res.end(body);
  }
}

function discardUpstream(upstreamReq, upstreamRes) {
  if (upstreamRes) {
    upstreamRes.on("error", () => {});
    upstreamRes.resume();
  }
  if (upstreamReq && !upstreamReq.destroyed) {
    upstreamReq.destroy();
  }
}

function openUpstreamRequest(validated, { method, headers, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new ProxyError(499, "Client disconnected"));
      return;
    }

    const client = validated.url.protocol === "https:" ? https : http;
    let settled = false;

    const cleanupSignal = () => {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
    };

    const upstreamReq = client.request(
      validated.url,
      {
        method,
        headers,
        lookup: validated.lookup,
        agent: false,
      },
      (upstreamRes) => {
        if (settled) {
          discardUpstream(upstreamReq, upstreamRes);
          return;
        }
        settled = true;
        cleanupSignal();
        resolve({ upstreamReq, upstreamRes });
      }
    );

    const onAbort = () => {
      upstreamReq.destroy(new ProxyError(499, "Client disconnected"));
    };
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    upstreamReq.setTimeout(timeoutMs, () => {
      upstreamReq.destroy(new ProxyError(502, "Upstream git request timed out"));
    });

    upstreamReq.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanupSignal();
      if (err instanceof ProxyError) {
        reject(err);
      } else {
        reject(new ProxyError(502, `Upstream git request failed: ${err.message}`));
      }
    });

    upstreamReq.end();
  });
}

export function createGitProxy(options = {}) {
  const allowLocalRegistries = Boolean(options.allowLocalRegistries);
  const maxRedirects = options.maxRedirects ?? 5;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const lookupFn = options.lookupFn ?? dns.lookup;

  async function requestWithRedirects(initialUrl, { method, baseHeaders, signal }) {
    let currentUrl = initialUrl;
    const currentHeaders = { ...baseHeaders };

    for (let hop = 0; hop <= maxRedirects; hop++) {
      if (signal && signal.aborted) {
        throw new ProxyError(499, "Client disconnected");
      }

      const validated = await validateAndResolveUrl(currentUrl, {
        allowLocalRegistries,
        lookupFn,
      });

      const { upstreamReq, upstreamRes } = await openUpstreamRequest(validated, {
        method,
        headers: currentHeaders,
        timeoutMs: requestTimeoutMs,
        signal,
      });

      const status = upstreamRes.statusCode || 502;
      const location = upstreamRes.headers.location;

      if (REDIRECT_STATUSES.has(status) && location) {
        discardUpstream(upstreamReq, upstreamRes);
        if (hop === maxRedirects) {
          throw new ProxyError(502, "Too many redirects from upstream git host");
        }
        let nextUrl;
        try {
          nextUrl = new URL(location, currentUrl);
        } catch {
          throw new ProxyError(502, "Invalid redirect Location URL from upstream git host");
        }
        // Strip Authorization header on cross-origin redirect (e.g. github.com -> codeload.github.com).
        if (nextUrl.origin !== currentUrl.origin) {
          delete currentHeaders.Authorization;
          delete currentHeaders.authorization;
        }
        currentUrl = nextUrl;
        continue;
      }

      return { upstreamReq, upstreamRes, finalUrl: currentUrl };
    }

    throw new ProxyError(502, "Too many redirects from upstream git host");
  }

  async function handleRequest(req, res) {
    const method = (req.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      sendJsonError(res, 405, "Method Not Allowed", method, { Allow: "GET, HEAD" });
      return;
    }

    const clientAbort = new AbortController();
    const onPreStreamClose = () => {
      if (!res.writableFinished) {
        clientAbort.abort();
      }
    };
    res.on("close", onPreStreamClose);

    try {
      const spec = parseGitArchiveQuery(req.url || "/", { allowLocalRegistries });

      const baseHeaders = {
        "User-Agent": GIT_ARCHIVE_USER_AGENT,
        Accept: "application/gzip, application/octet-stream, */*",
      };

      const { upstreamReq, upstreamRes } = await requestWithRedirects(spec.archiveUrl, {
        method,
        baseHeaders,
        signal: clientAbort.signal,
      });

      if (res.destroyed || res.writableEnded || clientAbort.signal.aborted) {
        discardUpstream(upstreamReq, upstreamRes);
        return;
      }

      const status = upstreamRes.statusCode || 502;
      if (status === 404) {
        discardUpstream(upstreamReq, upstreamRes);
        sendJsonError(res, 404, "Upstream git repository or ref not found", method);
        return;
      }
      if (status === 429) {
        const rawRetryAfter = upstreamRes.headers["retry-after"];
        discardUpstream(upstreamReq, upstreamRes);
        const extraHeaders =
          typeof rawRetryAfter === "string" && RETRY_AFTER_SAFE_RE.test(rawRetryAfter.trim())
            ? { "Retry-After": rawRetryAfter.trim() }
            : null;
        sendJsonError(res, 429, "Upstream git host rate-limited (HTTP 429)", method, extraHeaders);
        return;
      }
      if (status !== 200) {
        discardUpstream(upstreamReq, upstreamRes);
        sendJsonError(res, 502, `Upstream git host returned HTTP ${status}`, method);
        return;
      }

      const stripComponents = parseStripComponentsHeader(
        upstreamRes.headers["x-git-strip-components"],
        spec.defaultStripComponents
      );

      res.setHeader("Content-Type", "application/gzip");
      if (upstreamRes.headers["content-length"] !== undefined) {
        res.setHeader("Content-Length", upstreamRes.headers["content-length"]);
      }
      if (upstreamRes.headers.etag !== undefined) {
        res.setHeader("ETag", upstreamRes.headers.etag);
      }
      res.setHeader("X-Git-Archive-Format", "tar.gz");
      res.setHeader("X-Git-Strip-Components", String(stripComponents));
      res.setHeader("Cache-Control", spec.cacheControl);

      res.writeHead(status);

      if (method === "HEAD") {
        discardUpstream(upstreamReq, upstreamRes);
        res.end();
        return;
      }

      const cleanupStreamListeners = () => {
        res.off("close", onClientClose);
        res.off("error", onClientError);
      };

      const onClientClose = () => {
        if (!res.writableFinished) {
          upstreamReq.destroy();
          upstreamRes.destroy();
        }
      };

      const onClientError = () => {
        cleanupStreamListeners();
        upstreamReq.destroy();
        upstreamRes.destroy();
      };

      const onUpstreamAbort = () => {
        cleanupStreamListeners();
        if (!res.writableEnded) {
          res.destroy();
        }
      };

      res.off("close", onPreStreamClose);
      res.on("close", onClientClose);
      res.on("error", onClientError);

      upstreamRes.on("error", onUpstreamAbort);
      upstreamRes.on("aborted", onUpstreamAbort);
      upstreamRes.on("close", () => {
        cleanupStreamListeners();
        if (!upstreamRes.complete && !res.writableEnded) {
          res.destroy();
        }
      });
      upstreamRes.on("end", () => {
        cleanupStreamListeners();
      });

      upstreamRes.pipe(res);
    } catch (err) {
      if (res.destroyed || res.writableEnded || clientAbort.signal.aborted) {
        return;
      }
      if (err instanceof ProxyError) {
        sendJsonError(res, err.statusCode, err.message, method);
      } else {
        sendJsonError(
          res,
          502,
          `Git archive proxy error: ${err?.message || "unknown error"}`,
          method
        );
      }
    } finally {
      res.off("close", onPreStreamClose);
    }
  }

  return {
    handleRequest,
  };
}
