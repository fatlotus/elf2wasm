// Pure-JS POSIX ustar tar & tar.gz builder and parser.
// Supports files ('0'), empty dirs ('5'), symlinks ('2'), hardlinks ('1'),
// and GNU long names/linknames ('L'/'K') + PAX path overrides.
// Zero external dependencies (Node.js 22 built-ins only).

import zlib from "node:zlib";
import crypto from "node:crypto";

const BLOCK_SIZE = 512;

function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function writeString(buf, offset, length, str) {
  const encoded = Buffer.from(str, "utf8");
  encoded.copy(buf, offset, 0, Math.min(encoded.length, length));
}

function writeOctal(buf, offset, length, value) {
  const octal = Math.max(0, Math.floor(value)).toString(8);
  const padded = octal.padStart(length - 1, "0") + "\0";
  writeString(buf, offset, length, padded.slice(-length));
}

function normalizeTarPath(rawPath, isDir) {
  let p = String(rawPath || "").replace(/^\/+/, "");
  if (isDir && p.length > 0 && !p.endsWith("/")) {
    p += "/";
  }
  return p;
}

function buildHeaderBlock({ name, mode, size, typeFlag, linkname = "", mtime = 0 }) {
  const header = Buffer.alloc(BLOCK_SIZE, 0);

  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0); // uid
  writeOctal(header, 116, 8, 0); // gid
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, mtime);

  // Checksum field filled with spaces during checksum calculation
  header.fill(0x20, 148, 156);

  header[156] = typeFlag.charCodeAt(0);
  if (linkname) {
    writeString(header, 157, 100, linkname);
  }

  // POSIX ustar magic + version
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  writeString(header, 265, 32, "root");
  writeString(header, 297, 32, "root");
  writeOctal(header, 329, 8, 0); // devmajor
  writeOctal(header, 337, 8, 0); // devminor

  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) {
    sum += header[i];
  }
  const chksum = sum.toString(8).padStart(6, "0") + "\0 ";
  writeString(header, 148, 8, chksum);

  return header;
}

function padToBlock(buf) {
  const rem = buf.length % BLOCK_SIZE;
  if (rem === 0) return buf;
  return Buffer.concat([buf, Buffer.alloc(BLOCK_SIZE - rem, 0)]);
}

function appendLongEntry(chunks, typeFlag, value) {
  const payload = Buffer.from(value + "\0", "utf8");
  const header = buildHeaderBlock({
    name: "././@LongLink",
    mode: 0o644,
    size: payload.length,
    typeFlag,
  });
  chunks.push(header, padToBlock(payload));
}

/**
 * Create a POSIX ustar tar archive as a Uint8Array.
 *
 * Supported entry shapes:
 * - { path, type?: "file", content?: string|Uint8Array, mode?: number }
 * - { path, type: "dir", mode?: number }
 * - { path, type: "symlink", linkname: string, mode?: number }
 * - { path, type: "hardlink", linkname: string, mode?: number }
 *
 * @param {Array<object>} entries
 * @returns {Uint8Array}
 */
export function createTar(entries) {
  const chunks = [];

  for (const entry of entries) {
    const type = entry.type || "file";
    const isDir = type === "dir";
    const name = normalizeTarPath(entry.path, isDir);
    if (!name) {
      throw new Error(`Invalid empty tar entry path: ${JSON.stringify(entry)}`);
    }

    let typeFlag = "0";
    let mode = entry.mode;
    let payload = Buffer.alloc(0);
    let linkname = "";

    if (type === "file") {
      typeFlag = "0";
      if (mode === undefined) mode = 0o644;
      if (typeof entry.content === "string") {
        payload = Buffer.from(entry.content, "utf8");
      } else if (entry.content instanceof Uint8Array) {
        payload = Buffer.from(entry.content.buffer, entry.content.byteOffset, entry.content.byteLength);
      } else if (entry.content !== undefined && entry.content !== null) {
        payload = Buffer.from(String(entry.content), "utf8");
      }
    } else if (type === "dir") {
      typeFlag = "5";
      if (mode === undefined) mode = 0o755;
    } else if (type === "symlink") {
      typeFlag = "2";
      if (mode === undefined) mode = 0o777;
      linkname = String(entry.linkname ?? "");
    } else if (type === "hardlink") {
      typeFlag = "1";
      if (mode === undefined) mode = 0o644;
      linkname = String(entry.linkname ?? "").replace(/^\/+/, "");
    } else {
      throw new Error(`Unsupported tar entry type: ${type}`);
    }

    const nameBytes = Buffer.byteLength(name, "utf8");
    const linkBytes = Buffer.byteLength(linkname, "utf8");

    if (nameBytes > 100) {
      appendLongEntry(chunks, "L", name);
    }
    if (linkBytes > 100) {
      appendLongEntry(chunks, "K", linkname);
    }

    const header = buildHeaderBlock({
      name: nameBytes > 100 ? name.slice(0, 100) : name,
      mode,
      size: payload.length,
      typeFlag,
      linkname: linkBytes > 100 ? linkname.slice(0, 100) : linkname,
    });

    chunks.push(header);
    if (payload.length > 0) {
      chunks.push(padToBlock(payload));
    }
  }

  // Two 512-byte zero blocks for EOF
  chunks.push(Buffer.alloc(BLOCK_SIZE * 2, 0));

  const out = Buffer.concat(chunks);
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

/**
 * Create a gzipped tar archive and compute OCI diffId (uncompressed sha256)
 * and layer digest (compressed sha256).
 * @param {Array<object>} entries
 * @returns {{ tarBytes: Uint8Array, gzBytes: Uint8Array, diffId: string, digest: string, size: number }}
 */
export function createTarGz(entries) {
  const tarBytes = createTar(entries);
  const gzBuf = zlib.gzipSync(tarBytes, { level: 6 });
  const gzBytes = new Uint8Array(gzBuf.buffer, gzBuf.byteOffset, gzBuf.byteLength);
  return {
    tarBytes,
    gzBytes,
    diffId: `sha256:${sha256Hex(tarBytes)}`,
    digest: `sha256:${sha256Hex(gzBytes)}`,
    size: gzBytes.length,
  };
}

function readCString(buf, start, length) {
  const slice = buf.subarray(start, start + length);
  const nul = slice.indexOf(0);
  const end = nul === -1 ? slice.length : nul;
  return Buffer.from(slice.subarray(0, end)).toString("utf8");
}

function readOctal(buf, start, length) {
  const raw = readCString(buf, start, length).trim();
  if (!raw) return 0;
  return parseInt(raw, 8);
}

function isZeroBlock(buf, offset) {
  for (let i = 0; i < BLOCK_SIZE; i++) {
    if (buf[offset + i] !== 0) return false;
  }
  return true;
}

function parsePaxRecords(data) {
  const text = Buffer.from(data).toString("utf8");
  const records = {};
  let idx = 0;
  while (idx < text.length) {
    const sp = text.indexOf(" ", idx);
    if (sp === -1) break;
    const len = parseInt(text.slice(idx, sp), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = text.slice(sp + 1, idx + len).replace(/\n$/, "");
    const eq = record.indexOf("=");
    if (eq !== -1) {
      records[record.slice(0, eq)] = record.slice(eq + 1);
    }
    idx += len;
  }
  return records;
}

/**
 * Parse a POSIX ustar / GNU tar buffer into structured entries.
 * @param {Uint8Array|Buffer} tarInput
 * @returns {Array<{ name: string, typeFlag: string, mode: number, size: number, linkname: string, data: Uint8Array }>}
 */
export function parseTarEntries(tarInput) {
  const buf = tarInput instanceof Buffer
    ? tarInput
    : Buffer.from(tarInput.buffer, tarInput.byteOffset, tarInput.byteLength);

  const entries = [];
  let offset = 0;
  let pendingLongName = null;
  let pendingLongLink = null;
  let pendingPax = null;

  while (offset + BLOCK_SIZE <= buf.length) {
    if (isZeroBlock(buf, offset)) {
      break;
    }

    const rawName = readCString(buf, offset, 100);
    const mode = readOctal(buf, offset + 100, 8);
    const size = readOctal(buf, offset + 124, 12);
    const typeFlagByte = buf[offset + 156];
    const typeFlag = typeFlagByte === 0 ? "0" : String.fromCharCode(typeFlagByte);
    const rawLink = readCString(buf, offset + 157, 100);
    const prefix = readCString(buf, offset + 345, 155);

    const dataStart = offset + BLOCK_SIZE;
    const dataEnd = dataStart + size;
    const paddedSize = Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
    const data = new Uint8Array(buf.subarray(dataStart, dataEnd));
    offset = dataStart + paddedSize;

    if (typeFlag === "L") {
      pendingLongName = Buffer.from(data).toString("utf8").replace(/\0+$/, "");
      continue;
    }
    if (typeFlag === "K") {
      pendingLongLink = Buffer.from(data).toString("utf8").replace(/\0+$/, "");
      continue;
    }
    if (typeFlag === "x" || typeFlag === "g") {
      const pax = parsePaxRecords(data);
      if (typeFlag === "x") {
        pendingPax = { ...(pendingPax || {}), ...pax };
      }
      continue;
    }

    let name = prefix ? `${prefix}/${rawName}` : rawName;
    let linkname = rawLink;
    if (pendingLongName !== null) {
      name = pendingLongName;
      pendingLongName = null;
    }
    if (pendingLongLink !== null) {
      linkname = pendingLongLink;
      pendingLongLink = null;
    }
    if (pendingPax !== null) {
      if (pendingPax.path) name = pendingPax.path;
      if (pendingPax.linkpath) linkname = pendingPax.linkpath;
      pendingPax = null;
    }

    entries.push({
      name,
      typeFlag,
      mode,
      size,
      linkname,
      data,
    });
  }

  return entries;
}
