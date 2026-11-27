// Client helpers for POST /api/eval (JSON & direct .tar.gz download) and base64 tar.gz diff encoding.
// Zero external dependencies (Node.js 22 built-ins + helpers/tar_builder.mjs).

import zlib from "node:zlib";
import { createTarGz, parseTarEntries } from "./tar_builder.mjs";

/**
 * Encode tar entries into a base64-encoded gzipped POSIX ustar tar archive.
 * @param {Array<object>} entries
 * @returns {string}
 */
export function encodeTarGzBase64(entries) {
  const { gzBytes } = createTarGz(entries);
  return Buffer.from(gzBytes).toString("base64");
}

/**
 * Decode a base64-encoded gzipped tar archive, verifying gzip magic bytes (0x1f 0x8b),
 * and parse all USTAR/PAX/GNU tar entries.
 * @param {string} b64
 * @returns {{ gzBytes: Uint8Array, tarBytes: Uint8Array, entries: Array<{ name: string, typeFlag: string, mode: number, size: number, linkname: string, data: Uint8Array }> }}
 */
export function decodeTarGzBase64(b64) {
  if (typeof b64 !== "string" || b64.length === 0) {
    throw new Error("Expected non-empty base64 string for tar.gz archive");
  }
  const gzBuf = Buffer.from(b64, "base64");
  if (gzBuf.length < 2 || gzBuf[0] !== 0x1f || gzBuf[1] !== 0x8b) {
    throw new Error(
      `Invalid gzip magic bytes in base64 archive: got [${gzBuf[0]}, ${gzBuf[1]}], expected [0x1f, 0x8b]`
    );
  }
  const tarBuf = zlib.gunzipSync(gzBuf);
  const gzBytes = new Uint8Array(gzBuf.buffer, gzBuf.byteOffset, gzBuf.byteLength);
  const tarBytes = new Uint8Array(tarBuf.buffer, tarBuf.byteOffset, tarBuf.byteLength);
  const entries = parseTarEntries(tarBytes);
  return { gzBytes, tarBytes, entries };
}

function buildEvalUrl(serverUrl, query = "") {
  const base = String(serverUrl || "").replace(/\/+$/, "");
  if (!query) return `${base}/api/eval`;
  const q = query.startsWith("?") ? query : `?${query}`;
  return `${base}/api/eval${q}`;
}

function headersToObject(headers) {
  const out = {};
  for (const [k, v] of headers.entries()) {
    out[k.toLowerCase()] = v;
  }
  return out;
}

/**
 * POST to `/api/eval` expecting a JSON response.
 * @param {string} serverUrl
 * @param {object | string} payload
 * @param {{ headers?: Record<string, string>, query?: string, rawBody?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<{ status: number, ok: boolean, headers: Record<string, string>, json: any, text: string }>}
 */
export async function postEvalJson(serverUrl, payload, opts = {}) {
  const {
    headers = {},
    query = "",
    rawBody = undefined,
    timeoutMs = 120000,
  } = opts;

  const body = rawBody !== undefined
    ? rawBody
    : (typeof payload === "string" ? payload : JSON.stringify(payload));

  const resp = await fetch(buildEvalUrl(serverUrl, query), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...headers,
    },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  return {
    status: resp.status,
    ok: resp.ok,
    headers: headersToObject(resp.headers),
    json,
    text,
  };
}

/**
 * POST to `/api/eval` expecting a direct `.tar.gz` download response.
 * Verifies gzip magic (`0x1f 0x8b`) and parses USTAR tar entries when HTTP 200 is returned.
 * @param {string} serverUrl
 * @param {object} payload
 * @param {{ headers?: Record<string, string>, query?: string, useQueryFormat?: boolean, timeoutMs?: number }} [opts]
 * @returns {Promise<{ status: number, ok: boolean, headers: Record<string, string>, bytes: Uint8Array, entries: Array<object> | null, text: string | null }>}
 */
export async function postEvalTarGz(serverUrl, payload, opts = {}) {
  const {
    headers = {},
    query = "",
    useQueryFormat = false,
    timeoutMs = 120000,
  } = opts;

  const effectiveQuery = useQueryFormat
    ? (query ? `${query}&format=tar.gz` : "format=tar.gz")
    : query;

  const reqHeaders = {
    "content-type": "application/json",
    ...(useQueryFormat ? {} : { accept: "application/gzip" }),
    ...headers,
  };

  const resp = await fetch(buildEvalUrl(serverUrl, effectiveQuery), {
    method: "POST",
    headers: reqHeaders,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const arrBuf = await resp.arrayBuffer();
  const bytes = new Uint8Array(arrBuf);
  const respHeaders = headersToObject(resp.headers);

  if (resp.status !== 200) {
    return {
      status: resp.status,
      ok: false,
      headers: respHeaders,
      bytes,
      entries: null,
      text: Buffer.from(bytes).toString("utf8"),
    };
  }

  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    throw new Error(
      `POST /api/eval returned 200 but body lacks gzip magic [0x1f, 0x8b]: got [${bytes[0]}, ${bytes[1]}]`
    );
  }

  const tarBuf = zlib.gunzipSync(bytes);
  const entries = parseTarEntries(tarBuf);

  return {
    status: resp.status,
    ok: true,
    headers: respHeaders,
    bytes,
    entries,
    text: null,
  };
}
