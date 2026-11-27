/**
 * Pure ESM JavaScript shim for elf2wasm (Node.js & Browser compatible).
 *
 * Bridges `compiler.wasm`, `runtime.wasm`, and `guest_*.wasm` instances via
 * `WebAssembly.instantiate`, supporting writable VFS, deterministic virtual
 * time, cooperative multi-threading, and multi-process `fork`/`vfork`/`execve`.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: false });

const GLOBAL_NAMES = [
  "fsbase",
  "gsbase",
  "rcx",
  "rip",
  "rsp",
  "exit_flag",
  "exit_code",
  "yield_flag",
  "quantum",
  "rax",
  "rdi",
  "rsi",
  "rdx",
  "r10",
  "r8",
  "r9",
];
const I32_GLOBAL_IDS = new Set([5, 6, 7, 8]);

const DEFAULT_RO_ALLOWLIST = [
  "/usr/lib/locale/C.utf8",
  "/usr/share/locale/locale.alias",
  "/usr/lib/x86_64-linux-gnu",
];

const DEFAULT_SO_SEARCH_DIRS = [
  "/lib64",
  "/lib",
  "/lib/x86_64-linux-gnu",
  "/usr/lib/x86_64-linux-gnu",
  "/usr/lib64",
  "/usr/lib",
];

function toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new TypeError("Expected Uint8Array, ArrayBuffer, or ArrayBufferView");
}

async function compileWasmModule(input) {
  if (input instanceof WebAssembly.Module) return input;
  return await WebAssembly.compile(toUint8Array(input));
}

function fnv1a32(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

function normalizeGuestPath(p) {
  const parts = [];
  for (const comp of String(p).split("/")) {
    if (!comp || comp === ".") continue;
    if (comp === "..") {
      parts.pop();
    } else {
      parts.push(comp);
    }
  }
  return parts.length === 0 ? "/" : "/" + parts.join("/");
}

function resolveGuestPathWithCwd(rawPath, cwd = "/") {
  const p = String(rawPath || "");
  if (!p) return normalizeGuestPath(cwd || "/");
  if (p.startsWith("/")) return normalizeGuestPath(p);
  const base = normalizeGuestPath(cwd || "/");
  return normalizeGuestPath(base === "/" ? `/${p}` : `${base}/${p}`);
}

function basename(p) {
  const idx = p.lastIndexOf("/");
  return idx >= 0 ? p.slice(idx + 1) : p;
}

function dirname(p) {
  const norm = normalizeGuestPath(p);
  if (norm === "/") return "/";
  const idx = norm.lastIndexOf("/");
  return idx <= 0 ? "/" : norm.slice(0, idx);
}

function isElf64Bytes(bytes) {
  if (
    !bytes ||
    bytes.length < 64 ||
    bytes[0] !== 0x7f ||
    bytes[1] !== 0x45 ||
    bytes[2] !== 0x4c ||
    bytes[3] !== 0x46
  ) {
    return false;
  }
  // EI_CLASS=2 (ELFCLASS64), EI_DATA=1 (ELFDATA2LSB), EI_VERSION=1 (EV_CURRENT)
  if (bytes[4] !== 2 || bytes[5] !== 1 || bytes[6] !== 1) {
    return false;
  }
  const eType = bytes[16] | (bytes[17] << 8);
  const eMachine = bytes[18] | (bytes[19] << 8);
  // ET_EXEC (2) or ET_DYN (3), EM_X86_64 (62)
  if ((eType !== 2 && eType !== 3) || eMachine !== 62) {
    return false;
  }

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ePhoff = dv.getBigUint64(32, true);
  const ePhentsize = dv.getUint16(54, true);
  const ePhnum = dv.getUint16(56, true);
  if (ePhentsize !== 56 || ePhnum === 0) {
    return false;
  }
  const fileLen = BigInt(bytes.length);
  const phEnd = ePhoff + BigInt(ePhnum) * 56n;
  if (phEnd > fileLen) {
    return false;
  }

  let hasExecLoad = false;
  const phoffNum = Number(ePhoff);
  for (let i = 0; i < ePhnum; i++) {
    const off = phoffNum + i * 56;
    const pType = dv.getUint32(off, true);
    const pFlags = dv.getUint32(off + 4, true);
    const pOffset = dv.getBigUint64(off + 8, true);
    const pFilesz = dv.getBigUint64(off + 32, true);
    const pMemsz = dv.getBigUint64(off + 40, true);

    if (pType === 1) {
      // PT_LOAD
      if (pFilesz > pMemsz) {
        return false;
      }
      if (pOffset + pFilesz > fileLen) {
        return false;
      }
      if ((pFlags & 1) !== 0 && pFilesz > 0n) {
        hasExecLoad = true;
      }
    } else if (pType === 3) {
      // PT_INTERP
      if (pFilesz === 0n || pOffset + pFilesz > fileLen) {
        return false;
      }
    }
  }
  return hasExecLoad;
}

function parseShebang(bytes) {
  if (!bytes || bytes.length < 2 || bytes[0] !== 0x23 || bytes[1] !== 0x21) {
    return null;
  }
  const maxLen = Math.min(bytes.length, 256);
  let end = 2;
  while (end < maxLen && bytes[end] !== 0x0a) end++;
  const line = textDecoder.decode(bytes.subarray(2, end)).replace(/\r$/, "").trim();
  if (!line) return null;
  const match = line.match(/^(\S+)(?:\s+(.*))?$/);
  if (!match) return null;
  const interp = match[1];
  const arg = match[2] !== undefined && match[2].trim().length > 0 ? match[2].trim() : null;
  return { interp, arg };
}

function globToRegExp(pattern) {
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else if ("\\^$.|+()[]{}".includes(ch)) re += "\\" + ch;
    else re += ch;
  }
  re += "$";
  return new RegExp(re);
}

let _yieldChannel = null;
let _yieldQueue = null;

function yieldMacrotask() {
  if (typeof MessageChannel !== "undefined") {
    if (!_yieldChannel) {
      _yieldChannel = new MessageChannel();
      _yieldQueue = [];
      _yieldChannel.port1.onmessage = () => {
        const resolve = _yieldQueue.shift();
        if (_yieldQueue.length === 0) {
          if (typeof _yieldChannel.port1.unref === "function") _yieldChannel.port1.unref();
          if (typeof _yieldChannel.port2.unref === "function") _yieldChannel.port2.unref();
        }
        if (resolve) resolve();
      };
      if (typeof _yieldChannel.port1.unref === "function") _yieldChannel.port1.unref();
      if (typeof _yieldChannel.port2.unref === "function") _yieldChannel.port2.unref();
    }
    return new Promise((resolve) => {
      if (_yieldQueue.length === 0) {
        if (typeof _yieldChannel.port1.ref === "function") _yieldChannel.port1.ref();
        if (typeof _yieldChannel.port2.ref === "function") _yieldChannel.port2.ref();
      }
      _yieldQueue.push(resolve);
      _yieldChannel.port2.postMessage(null);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const COMPILER_MEM_RESET_THRESHOLD = 128 * 1024 * 1024;

const PYTHON_CORE_LIB_DYNLOAD = new Set([
  "math",
  "cmath",
  "_struct",
  "binascii",
  "zlib",
  "_json",
  "_random",
  "_datetime",
  "_csv",
  "_sha2",
  "_md5",
  "_sha1",
  "_blake2",
  "_sha3",
  "_posixsubprocess",
  "select",
  "_socket",
  "_opcode",
  "_bisect",
  "_heapq",
  "array",
  "_contextvars",
  "fcntl",
  "termios",
  "_pickle",
  "readline",
  "grp",
  "unicodedata",
  "_statistics",
  "_queue",
  "mmap",
  "pyexpat",
  "_elementtree",
  "_decimal",
]);

function readCStringFromBytes(bytes, offset, maxEnd = bytes.length) {
  let end = offset;
  while (end < maxEnd && bytes[end] !== 0) end++;
  return textDecoder.decode(bytes.subarray(offset, end));
}

/**
 * Pure-JS ELF64 parser to extract PT_INTERP, DT_NEEDED, DT_RPATH, and DT_RUNPATH.
 */
export function parseElf64Deps(elfBytes) {
  if (!isElf64Bytes(elfBytes)) {
    return { interp: null, needed: [], rpath: [], runpath: [] };
  }

  const dv = new DataView(
    elfBytes.buffer,
    elfBytes.byteOffset,
    elfBytes.byteLength
  );
  const phoff = Number(dv.getBigUint64(32, true));
  const phentsize = dv.getUint16(54, true);
  const phnum = dv.getUint16(56, true);

  let interp = null;
  const loadSegments = [];
  let dynOff = 0;
  let dynSize = 0;

  for (let i = 0; i < phnum; i++) {
    const off = phoff + i * phentsize;
    if (off + 56 > elfBytes.length) break;
    const pType = dv.getUint32(off, true);
    const pOffset = Number(dv.getBigUint64(off + 8, true));
    const pVaddr = Number(dv.getBigUint64(off + 16, true));
    const pFilesz = Number(dv.getBigUint64(off + 32, true));

    if (pType === 1) {
      // PT_LOAD
      loadSegments.push({ vaddr: pVaddr, offset: pOffset, filesz: pFilesz });
    } else if (pType === 3 && pFilesz > 0) {
      // PT_INTERP
      const end = pOffset + pFilesz;
      if (pOffset >= 0 && pOffset < elfBytes.length && end <= elfBytes.length) {
        interp = readCStringFromBytes(elfBytes, pOffset, end);
      }
    } else if (pType === 2 && pFilesz > 0) {
      // PT_DYNAMIC
      dynOff = pOffset;
      dynSize = pFilesz;
    }
  }

  const vaddrToOffset = (va) => {
    for (const seg of loadSegments) {
      if (va >= seg.vaddr && va < seg.vaddr + seg.filesz) {
        return seg.offset + (va - seg.vaddr);
      }
    }
    return null;
  };

  const neededOffsets = [];
  const rpathOffsets = [];
  const runpathOffsets = [];
  let strtabVa = 0;
  let strsz = 0;

  if (dynOff > 0 && dynSize > 0) {
    const end = Math.min(dynOff + dynSize, elfBytes.length);
    for (let p = dynOff; p + 16 <= end; p += 16) {
      const tag = Number(dv.getBigInt64(p, true));
      const val = Number(dv.getBigUint64(p + 8, true));
      if (tag === 0) break; // DT_NULL
      if (tag === 1) neededOffsets.push(val); // DT_NEEDED
      else if (tag === 5) strtabVa = val; // DT_STRTAB
      else if (tag === 10) strsz = val; // DT_STRSZ
      else if (tag === 15) rpathOffsets.push(val); // DT_RPATH
      else if (tag === 29) runpathOffsets.push(val); // DT_RUNPATH
    }
  }

  const needed = [];
  const rpath = [];
  const runpath = [];
  if (
    strtabVa !== 0 &&
    (neededOffsets.length > 0 || rpathOffsets.length > 0 || runpathOffsets.length > 0)
  ) {
    const strOff = vaddrToOffset(strtabVa);
    if (strOff !== null) {
      const strEnd =
        strsz > 0
          ? Math.min(strOff + strsz, elfBytes.length)
          : elfBytes.length;
      for (const noff of neededOffsets) {
        if (strOff + noff < strEnd) {
          needed.push(readCStringFromBytes(elfBytes, strOff + noff, strEnd));
        }
      }
      for (const roff of rpathOffsets) {
        if (strOff + roff < strEnd) {
          for (const entry of readCStringFromBytes(elfBytes, strOff + roff, strEnd).split(":")) {
            if (entry) rpath.push(entry);
          }
        }
      }
      for (const rpoff of runpathOffsets) {
        if (strOff + rpoff < strEnd) {
          for (const entry of readCStringFromBytes(elfBytes, strOff + rpoff, strEnd).split(":")) {
            if (entry) runpath.push(entry);
          }
        }
      }
    }
  }

  return { interp, needed, rpath, runpath };
}

function encodeE2wbBundle(mainPath, mainBytes, soEntries) {
  const mainPathBytes = textEncoder.encode(mainPath || "app");
  const normSos = (soEntries || []).map((so) => {
    const p = so.path || so.name || "";
    const pb = textEncoder.encode(p);
    const bytes = toUint8Array(so.bytes);
    return { pb, bytes };
  });

  let total = 4 + 4 + mainPathBytes.length + 4 + mainBytes.length + 4;
  for (const so of normSos) {
    total += 4 + so.pb.length + 4 + so.bytes.length;
  }

  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);
  let pos = 0;

  buf[pos++] = 0x45; // 'E'
  buf[pos++] = 0x32; // '2'
  buf[pos++] = 0x57; // 'W'
  buf[pos++] = 0x42; // 'B'

  dv.setUint32(pos, mainPathBytes.length, true);
  pos += 4;
  buf.set(mainPathBytes, pos);
  pos += mainPathBytes.length;

  dv.setUint32(pos, mainBytes.length, true);
  pos += 4;
  buf.set(mainBytes, pos);
  pos += mainBytes.length;

  dv.setUint32(pos, normSos.length, true);
  pos += 4;

  for (const so of normSos) {
    dv.setUint32(pos, so.pb.length, true);
    pos += 4;
    buf.set(so.pb, pos);
    pos += so.pb.length;

    dv.setUint32(pos, so.bytes.length, true);
    pos += 4;
    buf.set(so.bytes, pos);
    pos += so.bytes.length;
  }

  return buf;
}

function encodeE2waArgs(args, env) {
  const encArgs = (args || []).map((s) => textEncoder.encode(String(s)));
  const encEnv = (env || []).map((s) => textEncoder.encode(String(s)));

  let total = 4 + 4 + 4;
  for (const a of encArgs) total += 4 + a.length;
  for (const e of encEnv) total += 4 + e.length;

  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);
  let pos = 0;

  buf[pos++] = 0x45; // 'E'
  buf[pos++] = 0x32; // '2'
  buf[pos++] = 0x57; // 'W'
  buf[pos++] = 0x41; // 'A'

  dv.setUint32(pos, encArgs.length, true);
  pos += 4;
  for (const a of encArgs) {
    dv.setUint32(pos, a.length, true);
    pos += 4;
    buf.set(a, pos);
    pos += a.length;
  }

  dv.setUint32(pos, encEnv.length, true);
  pos += 4;
  for (const e of encEnv) {
    dv.setUint32(pos, e.length, true);
    pos += 4;
    buf.set(e, pos);
    pos += e.length;
  }

  return buf;
}

function decodeE2weExecInfo(bytes) {
  if (
    bytes.length < 16 ||
    bytes[0] !== 0x45 ||
    bytes[1] !== 0x32 ||
    bytes[2] !== 0x57 ||
    bytes[3] !== 0x45
  ) {
    throw new Error("Invalid E2WE exec info buffer");
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 4;
  const pid = dv.getInt32(pos, true);
  pos += 4;
  const readStr = () => {
    const len = dv.getUint32(pos, true);
    pos += 4;
    const s = textDecoder.decode(bytes.subarray(pos, pos + len));
    pos += len;
    return s;
  };
  const path = readStr();
  const argc = dv.getUint32(pos, true);
  pos += 4;
  const argv = [];
  for (let i = 0; i < argc; i++) argv.push(readStr());
  const envc = dv.getUint32(pos, true);
  pos += 4;
  const envp = [];
  for (let i = 0; i < envc; i++) envp.push(readStr());
  return { pid, path, argv, envp };
}

function compileWithInstance(compilerInst, elfBytes, soEntries = [], options = {}) {
  const cExp = compilerInst.exports;
  const bundle = encodeE2wbBundle(options.elfPath || "app", toUint8Array(elfBytes), soEntries);

  const inPtr = cExp.alloc(bundle.length) >>> 0;
  const outLenPtr = cExp.alloc(4) >>> 0;
  new Uint8Array(cExp.memory.buffer, inPtr, bundle.length).set(bundle);

  const outPtr = cExp.compile_bundle(inPtr, bundle.length, outLenPtr) >>> 0;
  cExp.dealloc(inPtr, bundle.length);

  const outLen = new DataView(cExp.memory.buffer).getUint32(outLenPtr, true);
  cExp.dealloc(outLenPtr, 4);

  if (outPtr === 0 || outLen === 0) {
    throw new Error("compiler.wasm returned null or empty buffer");
  }

  const outView = new Uint8Array(cExp.memory.buffer, outPtr, outLen);
  const status = outView[0];
  const payload = outView.slice(1);
  cExp.dealloc(outPtr, outLen);

  if (status !== 0) {
    throw new Error(textDecoder.decode(payload));
  }
  return payload;
}

/**
 * Compile an ELF64 binary + `.so` list into a guest `.wasm` module using `compiler.wasm`.
 */
export async function compileElfToWasm(compilerWasm, elfBytes, soEntries = [], options = {}) {
  const mod = await compileWasmModule(compilerWasm);
  const inst = await WebAssembly.instantiate(mod, {});
  return compileWithInstance(inst, elfBytes, soEntries, options);
}

export const compileBundle = compileElfToWasm;

async function createNodeHostVfs(vfsRo, vfsRw) {
  if ((!vfsRo || vfsRo.length === 0) && (!vfsRw || vfsRw.length === 0)) {
    return null;
  }
  const fs = await import("node:fs");
  const path = await import("node:path");

  const mounts = [];
  for (const m of vfsRo || []) {
    try {
      const hostRoot = fs.realpathSync(m.hostPath);
      mounts.push({
        hostRoot,
        guestPrefix: normalizeGuestPath(m.guestPath),
      });
    } catch {
      // Ignore unresolvable mount
    }
  }
  mounts.sort((a, b) => b.guestPrefix.length - a.guestPrefix.length);

  const resolveHostRo = (normPath) => {
    for (const m of mounts) {
      let rel = null;
      if (m.guestPrefix === "/") {
        rel = normPath.replace(/^\/+/, "");
      } else if (normPath === m.guestPrefix) {
        rel = "";
      } else if (normPath.startsWith(m.guestPrefix + "/")) {
        rel = normPath.slice(m.guestPrefix.length + 1);
      }
      if (rel !== null) {
        const candidate = rel === "" ? m.hostRoot : path.join(m.hostRoot, rel);
        try {
          const canon = fs.realpathSync(candidate);
          if (canon === m.hostRoot || canon.startsWith(m.hostRoot + path.sep)) {
            return { canon, hostRoot: m.hostRoot };
          }
        } catch {
          // Not found
        }
      }
    }
    for (const prefix of DEFAULT_RO_ALLOWLIST) {
      if (normPath === prefix || normPath.startsWith(prefix + "/")) {
        try {
          const rootCanon = fs.realpathSync(prefix);
          const canon = fs.realpathSync(normPath);
          if (canon === rootCanon || canon.startsWith(rootCanon + path.sep)) {
            return { canon, hostRoot: rootCanon };
          }
        } catch {
          // Not found
        }
      }
    }
    return null;
  };

  return {
    fs,
    path,
    mounts,
    isUnderRoMount(normPath) {
      for (const m of mounts) {
        if (m.guestPrefix === "/") return true;
        if (normPath === m.guestPrefix || normPath.startsWith(m.guestPrefix + "/")) {
          return true;
        }
      }
      for (const prefix of DEFAULT_RO_ALLOWLIST) {
        if (normPath === prefix || normPath.startsWith(prefix + "/")) return true;
      }
      return false;
    },
    isVirtualParent(normPath) {
      const prefixSlash = normPath === "/" ? "/" : normPath + "/";
      for (const m of mounts) {
        if (m.guestPrefix.startsWith(prefixSlash)) return true;
      }
      for (const allow of DEFAULT_RO_ALLOWLIST) {
        if (allow.startsWith(prefixSlash) && fs.existsSync(allow)) return true;
      }
      return false;
    },
    statRo(normPath) {
      const res = resolveHostRo(normPath);
      if (!res) return null;
      try {
        const st = fs.statSync(res.canon);
        const mode = st.isDirectory() ? 0o040755 : (0o100000 | (st.mode & 0o777));
        return { mode, size: st.isDirectory() ? 4096 : st.size };
      } catch {
        return null;
      }
    },
    readRo(normPath) {
      const res = resolveHostRo(normPath);
      if (!res) return null;
      try {
        const st = fs.statSync(res.canon);
        if (st.isDirectory()) return null;
        return new Uint8Array(fs.readFileSync(res.canon));
      } catch {
        return null;
      }
    },
    listDirRo(normPath) {
      const res = resolveHostRo(normPath);
      if (!res) return null;
      try {
        const st = fs.statSync(res.canon);
        if (!st.isDirectory()) return null;
        const entries = fs.readdirSync(res.canon, { withFileTypes: true });
        const out = [];
        for (const ent of entries) {
          let dType = 0;
          if (ent.isDirectory()) dType = 4;
          else if (ent.isFile()) dType = 8;
          else if (ent.isSymbolicLink()) {
            try {
              const target = fs.realpathSync(path.join(res.canon, ent.name));
              if (target !== res.hostRoot && !target.startsWith(res.hostRoot + path.sep)) {
                continue;
              }
              const tst = fs.statSync(target);
              dType = tst.isDirectory() ? 4 : 8;
            } catch {
              continue;
            }
          }
          out.push({ dType, name: ent.name });
        }
        return out;
      } catch {
        return null;
      }
    },
    seedRw(writeFileFn) {
      for (const m of vfsRw || []) {
        let baseReal;
        try {
          baseReal = fs.realpathSync(m.hostPath);
        } catch {
          continue;
        }
        const guestBase = normalizeGuestPath(m.guestPath);
        const walk = (hostP, guestP) => {
          let lst;
          try {
            lst = fs.lstatSync(hostP);
          } catch {
            return;
          }
          let st = lst;
          let targetP = hostP;
          if (lst.isSymbolicLink()) {
            let real;
            try {
              real = fs.realpathSync(hostP);
            } catch {
              return;
            }
            if (real !== baseReal && !real.startsWith(baseReal + path.sep)) {
              return;
            }
            try {
              st = fs.statSync(real);
            } catch {
              return;
            }
            targetP = real;
          }
          if (st.isDirectory()) {
            let entries;
            try {
              entries = fs.readdirSync(targetP);
            } catch {
              return;
            }
            for (const ent of entries) {
              walk(path.join(targetP, ent), guestP === "/" ? "/" + ent : guestP + "/" + ent);
            }
          } else if (st.isFile()) {
            try {
              writeFileFn(guestP, new Uint8Array(fs.readFileSync(targetP)), st.mode & 0o7777);
            } catch {
              // ignore unreadable files
            }
          }
        };
        walk(m.hostPath, guestBase);
      }
    },
  };
}

export function validateDelayConfig(stddevMs = 0, seed = 0) {
  let msNum;
  if (stddevMs === undefined || stddevMs === null) {
    msNum = 0;
  } else if (typeof stddevMs !== "number") {
    throw new RangeError(
      `Invalid delayStddevMs: ${String(stddevMs)} (must be a finite number >= 0)`
    );
  } else {
    msNum = stddevMs;
  }
  if (!Number.isFinite(msNum) || msNum < 0) {
    throw new RangeError(`Invalid delayStddevMs: ${msNum} (must be finite and >= 0)`);
  }
  if (msNum > 1_844_674_407_370) {
    throw new RangeError(
      `Invalid delayStddevMs: ${msNum} (exceeds maximum supported delay)`
    );
  }
  const stddevNs = BigInt(Math.max(0, Math.round(msNum * 1e6)));
  const MAX_STDDEV_NS = 1844674407370955161n; // u64::MAX / 10
  if (stddevNs > MAX_STDDEV_NS) {
    throw new RangeError(
      `Invalid delayStddevMs: ${msNum} (exceeds maximum supported delay)`
    );
  }
  let seedBig;
  if (typeof seed === "bigint") {
    if (seed < 0n || seed > 0xffff_ffff_ffff_ffffn) {
      throw new RangeError(`Invalid delaySeed: ${seed} (must be a 64-bit unsigned integer)`);
    }
    seedBig = BigInt.asUintN(64, seed);
  } else if (seed === undefined || seed === null) {
    seedBig = 0n;
  } else {
    if (typeof seed !== "number" || !Number.isInteger(seed)) {
      throw new RangeError(
        `Invalid delaySeed: ${String(seed)} (must be an integer in 0..2^64-1)`
      );
    }
    const rawBig = BigInt(seed);
    if (rawBig < 0n || rawBig > 0xffff_ffff_ffff_ffffn) {
      throw new RangeError(`Invalid delaySeed: ${seed} (must be a 64-bit unsigned integer)`);
    }
    seedBig = BigInt.asUintN(64, rawBig);
  }
  return { stddevNs, seedBig };
}

export class Elf2WasmSystem {
  constructor({
    compilerInst,
    compilerMod = null,
    runtimeInst,
    hostVfs,
    moduleCache = null,
    onCompilerInstChange = null,
  }) {
    this.compilerInst = compilerInst;
    this.compilerMod = compilerMod;
    this.runtimeInst = runtimeInst;
    this.hostVfs = hostVfs;
    this.moduleCache = moduleCache instanceof Map ? moduleCache : new Map();
    this._onCompilerInstChange =
      typeof onCompilerInstChange === "function" ? onCompilerInstChange : null;
    this.initialSoMap = new Map();
    this.vfsSymlinks = new Map();
    this.vfsFilePaths = new Set();
    this._vfsSnapshots = new Map();
    this.activeGuest = null;
    this._processes = null;
    this._inputWaiters = [];
    this._inputSignaled = false;
    this._aborted = false;
    this.reapedPidCount = 0;
    this.lastActiveProcessCount = 0;
  }

  static async create({
    compilerWasm,
    runtimeWasm,
    compilerInst: existingCompilerInst = null,
    compilerMod: existingCompilerMod = null,
    moduleCache = null,
    onCompilerInstChange = null,
    vfsRo = [],
    vfsRw = [],
  } = {}) {
    const [cMod, rMod] = await Promise.all([
      existingCompilerMod
        ? Promise.resolve(existingCompilerMod)
        : !existingCompilerInst && compilerWasm
          ? compileWasmModule(compilerWasm)
          : Promise.resolve(null),
      runtimeWasm ? compileWasmModule(runtimeWasm) : Promise.resolve(null),
    ]);

    let compilerInst = existingCompilerInst;
    if (!compilerInst && cMod) {
      compilerInst = await WebAssembly.instantiate(cMod, {});
    }

    const hostVfs = await createNodeHostVfs(vfsRo, vfsRw);
    let runtimeInst = null;
    const sys = new Elf2WasmSystem({
      compilerInst,
      compilerMod: cMod,
      runtimeInst: null,
      hostVfs,
      moduleCache,
      onCompilerInstChange,
    });

    if (rMod) {
      const env = sys._makeRuntimeEnv();
      runtimeInst = await WebAssembly.instantiate(rMod, { env });
      sys.runtimeInst = runtimeInst;
      runtimeInst.exports.runtime_new();
      if (hostVfs) {
        hostVfs.seedRw((gp, bytes, mode) => sys.writeVfsFile(gp, bytes, mode));
      }
    }

    return sys;
  }

  _makeRuntimeEnv() {
    const sys = this;
    let cachedGuest = null;
    let cachedGlobals = null;
    let cachedGMemBuf = null;
    let cachedGMem = null;
    let cachedRMemBuf = null;
    let cachedRMem = null;

    const getRMem = () => {
      const buf = sys.runtimeInst.exports.memory.buffer;
      if (buf !== cachedRMemBuf) {
        cachedRMemBuf = buf;
        cachedRMem = new Uint8Array(buf);
      }
      return cachedRMem;
    };

    const syncGuest = () => {
      const g = sys.activeGuest;
      if (g !== cachedGuest) {
        cachedGuest = g;
        cachedGMemBuf = null;
        cachedGMem = null;
        if (g) {
          const ex = g.exports;
          const arr = new Array(GLOBAL_NAMES.length);
          for (let i = 0; i < GLOBAL_NAMES.length; i++) {
            arr[i] = ex[GLOBAL_NAMES[i]] || null;
          }
          cachedGlobals = arr;
        } else {
          cachedGlobals = null;
        }
      }
      return g;
    };

    const getGMem = () => {
      const g = syncGuest();
      if (!g) return null;
      const buf = g.exports.memory.buffer;
      if (buf !== cachedGMemBuf) {
        cachedGMemBuf = buf;
        cachedGMem = new Uint8Array(buf);
      }
      return cachedGMem;
    };

    const readRtStr = (ptr, len) => {
      const rMem = getRMem();
      const p = ptr >>> 0;
      return normalizeGuestPath(textDecoder.decode(rMem.subarray(p, p + len)));
    };

    return {
      host_mem_size() {
        const gMem = getGMem();
        return gMem ? gMem.length >>> 0 : 0;
      },
      host_mem_grow(deltaPages) {
        const g = syncGuest();
        if (!g || !g.exports || !g.exports.memory) return -1;
        try {
          const prev = g.exports.memory.grow(deltaPages >>> 0);
          cachedGMemBuf = null;
          cachedGMem = null;
          return prev | 0;
        } catch (_) {
          return -1;
        }
      },
      host_read_guest(guestAddr, rtPtr, len) {
        const gMem = getGMem();
        if (!gMem) return -1;
        const gAddr = guestAddr >>> 0;
        const n = len >>> 0;
        if (gAddr + n > gMem.length) return -1;
        getRMem().set(gMem.subarray(gAddr, gAddr + n), rtPtr >>> 0);
        return 0;
      },
      host_write_guest(guestAddr, rtPtr, len) {
        const gMem = getGMem();
        if (!gMem) return -1;
        const gAddr = guestAddr >>> 0;
        const n = len >>> 0;
        if (gAddr + n > gMem.length) return -1;
        const rMem = getRMem();
        const rPtr = rtPtr >>> 0;
        gMem.set(rMem.subarray(rPtr, rPtr + n), gAddr);
        return 0;
      },
      host_zero_guest(guestAddr, len) {
        const gMem = getGMem();
        if (!gMem) return -1;
        const gAddr = guestAddr >>> 0;
        const n = len >>> 0;
        if (gAddr + n > gMem.length) return -1;
        gMem.fill(0, gAddr, gAddr + n);
        return 0;
      },
      host_get_global(id) {
        if (!syncGuest() || !cachedGlobals) return 0n;
        const g = cachedGlobals[id];
        if (!g) return 0n;
        if (I32_GLOBAL_IDS.has(id)) return BigInt(g.value | 0);
        return BigInt.asIntN(64, BigInt(g.value));
      },
      host_set_global(id, val) {
        if (!syncGuest() || !cachedGlobals) return;
        const g = cachedGlobals[id];
        if (!g) return;
        if (I32_GLOBAL_IDS.has(id)) {
          g.value = Number(BigInt.asIntN(32, val));
        } else {
          g.value = BigInt.asIntN(64, val);
        }
      },
      host_save_ctx(scratchAddr) {
        if (sys.activeGuest && typeof sys.activeGuest.exports.save_ctx === "function") {
          sys.activeGuest.exports.save_ctx(scratchAddr >>> 0);
        }
      },
      host_load_ctx(scratchAddr) {
        if (sys.activeGuest && typeof sys.activeGuest.exports.load_ctx === "function") {
          sys.activeGuest.exports.load_ctx(scratchAddr >>> 0);
        }
      },
      host_vfs_is_ro_mount(pathPtr, pathLen) {
        if (!sys.hostVfs) return 0;
        return sys.hostVfs.isUnderRoMount(readRtStr(pathPtr, pathLen)) ? 1 : 0;
      },
      host_vfs_stat_ro(pathPtr, pathLen, outModePtr, outSizePtr) {
        if (!sys.hostVfs) return -1;
        const st = sys.hostVfs.statRo(readRtStr(pathPtr, pathLen));
        if (!st) return -1;
        const dv = new DataView(sys.runtimeInst.exports.memory.buffer);
        dv.setUint32(outModePtr >>> 0, st.mode, true);
        dv.setBigInt64(outSizePtr >>> 0, BigInt(st.size), true);
        return 0;
      },
      host_vfs_read_ro(pathPtr, pathLen, outLenPtr) {
        if (!sys.hostVfs) return 0;
        const bytes = sys.hostVfs.readRo(readRtStr(pathPtr, pathLen));
        if (!bytes) return 0;
        const rExp = sys.runtimeInst.exports;
        const ptr = bytes.length > 0 ? rExp.alloc(bytes.length) : rExp.alloc(1);
        if (bytes.length > 0) {
          new Uint8Array(rExp.memory.buffer, ptr, bytes.length).set(bytes);
        }
        new DataView(rExp.memory.buffer).setUint32(outLenPtr >>> 0, bytes.length, true);
        return ptr;
      },
      host_vfs_list_dir_ro(pathPtr, pathLen, outLenPtr) {
        if (!sys.hostVfs) return 0;
        const entries = sys.hostVfs.listDirRo(readRtStr(pathPtr, pathLen));
        if (!entries) return 0;
        const chunks = [];
        let total = 0;
        for (const ent of entries) {
          const nb = textEncoder.encode(ent.name);
          if (nb.length > 65535) continue;
          chunks.push({ dType: ent.dType, nb });
          total += 3 + nb.length;
        }
        const rExp = sys.runtimeInst.exports;
        const ptr = total > 0 ? rExp.alloc(total) : rExp.alloc(1);
        const out = new Uint8Array(rExp.memory.buffer, ptr, total);
        let pos = 0;
        for (const c of chunks) {
          out[pos++] = c.dType;
          out[pos++] = c.nb.length & 0xff;
          out[pos++] = (c.nb.length >> 8) & 0xff;
          out.set(c.nb, pos);
          pos += c.nb.length;
        }
        new DataView(rExp.memory.buffer).setUint32(outLenPtr >>> 0, total, true);
        return ptr;
      },
      host_vfs_is_virtual_parent(pathPtr, pathLen) {
        if (!sys.hostVfs) return 0;
        return sys.hostVfs.isVirtualParent(readRtStr(pathPtr, pathLen)) ? 1 : 0;
      },
    };
  }

  compile(elfBytes, soEntries = [], options = {}) {
    if (!this.compilerInst) {
      throw new Error("Elf2WasmSystem created without compilerWasm");
    }
    return compileWithInstance(this.compilerInst, elfBytes, soEntries, options);
  }

  async _compileCached(elfBytes, soEntries, elfPath) {
    const soKey = (soEntries || [])
      .map((s) => {
        const b = toUint8Array(s.bytes);
        return `${s.path || s.guestPath || s.name || ""}:${b.length}:${fnv1a32(b)}`;
      })
      .join("|");
    const key = `${elfPath}:${elfBytes.length}:${fnv1a32(elfBytes)}:${soKey}`;
    const cached = this.moduleCache.get(key);
    if (cached) return cached;

    if (!this.compilerInst && this.compilerMod) {
      this.compilerInst = await WebAssembly.instantiate(this.compilerMod, {});
      if (this._onCompilerInstChange) this._onCompilerInstChange(this.compilerInst);
    }
    let wasmBytes;
    try {
      wasmBytes = this.compile(elfBytes, soEntries, { elfPath });
    } catch (err) {
      if (this.compilerMod) {
        this.compilerInst = null;
        if (this._onCompilerInstChange) this._onCompilerInstChange(null);
      }
      throw err;
    }
    if (
      this.compilerMod &&
      this.compilerInst?.exports?.memory?.buffer?.byteLength > COMPILER_MEM_RESET_THRESHOLD
    ) {
      this.compilerInst = null;
      if (this._onCompilerInstChange) this._onCompilerInstChange(null);
    }
    const mod = await WebAssembly.compile(wasmBytes);
    const sections = WebAssembly.Module.customSections(mod, "elf2wasm_meta");
    if (!sections || sections.length === 0) {
      throw new Error("Compiled WASM module missing elf2wasm_meta custom section");
    }
    const metaBytes = new Uint8Array(sections[0]);
    const entry = { mod, metaBytes };
    this.moduleCache.set(key, entry);
    return entry;
  }

  writeVfsFile(guestPath, bytes, mode = 0o644) {
    if (!this.runtimeInst) throw new Error("Elf2WasmSystem created without runtimeWasm");
    const rExp = this.runtimeInst.exports;
    const normPath = normalizeGuestPath(guestPath);
    this.vfsSymlinks.delete(normPath);
    this.vfsFilePaths.add(normPath);
    const pathBytes = textEncoder.encode(normPath);
    const data = toUint8Array(bytes);
    const pPtr = rExp.alloc(pathBytes.length);
    new Uint8Array(rExp.memory.buffer, pPtr, pathBytes.length).set(pathBytes);
    let dPtr = 0;
    if (data.length > 0) {
      dPtr = rExp.alloc(data.length);
      new Uint8Array(rExp.memory.buffer, dPtr, data.length).set(data);
    }
    const rc = rExp.runtime_add_vfs_file(pPtr, pathBytes.length, dPtr, data.length, mode);
    rExp.dealloc(pPtr, pathBytes.length);
    if (dPtr !== 0) rExp.dealloc(dPtr, data.length);
    if (rc !== 0) throw new Error(`runtime_add_vfs_file failed for ${guestPath}: ${rc}`);
  }

  writeVfsSymlink(guestPath, target) {
    if (!this.runtimeInst) throw new Error("Elf2WasmSystem created without runtimeWasm");
    const rExp = this.runtimeInst.exports;
    const normPath = normalizeGuestPath(guestPath);
    const targetStr = String(target);
    this.vfsSymlinks.set(normPath, targetStr);
    this.vfsFilePaths.add(normPath);
    if (typeof rExp.runtime_add_vfs_symlink === "function") {
      const pathBytes = textEncoder.encode(normPath);
      const targetBytes = textEncoder.encode(targetStr);
      const pPtr = rExp.alloc(Math.max(1, pathBytes.length));
      const tPtr = rExp.alloc(Math.max(1, targetBytes.length));
      if (pathBytes.length > 0) {
        new Uint8Array(rExp.memory.buffer, pPtr, pathBytes.length).set(pathBytes);
      }
      if (targetBytes.length > 0) {
        new Uint8Array(rExp.memory.buffer, tPtr, targetBytes.length).set(targetBytes);
      }
      const rc = rExp.runtime_add_vfs_symlink(
        pPtr,
        pathBytes.length,
        tPtr,
        targetBytes.length
      );
      rExp.dealloc(pPtr, Math.max(1, pathBytes.length));
      rExp.dealloc(tPtr, Math.max(1, targetBytes.length));
      if (rc !== 0) {
        throw new Error(`runtime_add_vfs_symlink failed for ${guestPath}: ${rc}`);
      }
    }
  }

  writeVfsDir(guestPath, mode = 0o755) {
    if (!this.runtimeInst) throw new Error("Elf2WasmSystem created without runtimeWasm");
    const rExp = this.runtimeInst.exports;
    const normPath = normalizeGuestPath(guestPath);
    if (normPath === "/") return;
    this.vfsSymlinks.delete(normPath);
    if (typeof rExp.runtime_add_vfs_dir === "function") {
      const pathBytes = textEncoder.encode(normPath);
      const pPtr = rExp.alloc(Math.max(1, pathBytes.length));
      if (pathBytes.length > 0) {
        new Uint8Array(rExp.memory.buffer, pPtr, pathBytes.length).set(pathBytes);
      }
      const rc = rExp.runtime_add_vfs_dir(pPtr, pathBytes.length, mode >>> 0);
      rExp.dealloc(pPtr, Math.max(1, pathBytes.length));
      if (rc !== 0) {
        throw new Error(`runtime_add_vfs_dir failed for ${guestPath}: ${rc}`);
      }
    }
  }

  removeVfsPath(guestPath) {
    if (!this.runtimeInst) throw new Error("Elf2WasmSystem created without runtimeWasm");
    const rExp = this.runtimeInst.exports;
    const normPath = normalizeGuestPath(guestPath);
    if (normPath === "/") return;
    const prefix = normPath + "/";
    for (const key of Array.from(this.vfsSymlinks.keys())) {
      if (key === normPath || key.startsWith(prefix)) {
        this.vfsSymlinks.delete(key);
      }
    }
    for (const key of Array.from(this.vfsFilePaths)) {
      if (key === normPath || key.startsWith(prefix)) {
        this.vfsFilePaths.delete(key);
      }
    }
    if (typeof rExp.runtime_remove_vfs_path === "function") {
      const pathBytes = textEncoder.encode(normPath);
      const pPtr = rExp.alloc(Math.max(1, pathBytes.length));
      if (pathBytes.length > 0) {
        new Uint8Array(rExp.memory.buffer, pPtr, pathBytes.length).set(pathBytes);
      }
      rExp.runtime_remove_vfs_path(pPtr, pathBytes.length);
      rExp.dealloc(pPtr, Math.max(1, pathBytes.length));
    }
  }

  setUidGid(uid, gid) {
    if (!this.runtimeInst) return;
    const rExp = this.runtimeInst.exports;
    if (typeof rExp.runtime_set_uid_gid === "function") {
      rExp.runtime_set_uid_gid(uid >>> 0, gid >>> 0);
    }
  }

  setTtyMode(enabled) {
    if (!this.runtimeInst) return;
    const rExp = this.runtimeInst.exports;
    if (typeof rExp.runtime_set_tty_mode === "function") {
      rExp.runtime_set_tty_mode(enabled ? 1 : 0);
    }
  }

  setStdinOpen(open) {
    if (!this.runtimeInst) return;
    const rExp = this.runtimeInst.exports;
    if (typeof rExp.runtime_set_stdin_open === "function") {
      rExp.runtime_set_stdin_open(open ? 1 : 0);
    }
  }

  setWinsize(rows, cols) {
    if (!this.runtimeInst) return;
    const rExp = this.runtimeInst.exports;
    if (typeof rExp.runtime_set_winsize === "function") {
      rExp.runtime_set_winsize(Math.max(1, rows | 0) >>> 0, Math.max(1, cols | 0) >>> 0);
    }
  }

  setDelayConfig(stddevMs = 0, seed = 0) {
    if (!this.runtimeInst) return;
    const rExp = this.runtimeInst.exports;
    if (typeof rExp.runtime_set_delay_config !== "function") return;
    const { stddevNs, seedBig } = validateDelayConfig(stddevMs, seed);
    rExp.runtime_set_delay_config(stddevNs, seedBig);
  }

  resetVirtualTime() {
    if (!this.runtimeInst) return;
    const rExp = this.runtimeInst.exports;
    if (typeof rExp.runtime_reset_virtual_time === "function") {
      rExp.runtime_reset_virtual_time();
    }
  }

  getVirtualTimeNs() {
    if (!this.runtimeInst) return 0;
    const rExp = this.runtimeInst.exports;
    if (typeof rExp.runtime_get_virtual_time_ns !== "function") return 0;
    return Number(BigInt.asUintN(64, rExp.runtime_get_virtual_time_ns()));
  }

  snapshotVfs() {
    if (!this.runtimeInst) {
      throw new Error("Elf2WasmSystem created without runtimeWasm");
    }
    const rExp = this.runtimeInst.exports;
    if (typeof rExp.runtime_snapshot_vfs !== "function") {
      throw new Error("runtime_snapshot_vfs is not exported by runtime WASM");
    }
    const id = rExp.runtime_snapshot_vfs() >>> 0;
    if (id === 0) {
      throw new Error("runtime_snapshot_vfs failed");
    }
    this._vfsSnapshots.set(id, {
      symlinks: new Map(this.vfsSymlinks),
      filePaths: new Set(this.vfsFilePaths),
    });
    return id;
  }

  restoreVfs(snapshotId) {
    if (!this.runtimeInst) {
      throw new Error("Elf2WasmSystem created without runtimeWasm");
    }
    const rExp = this.runtimeInst.exports;
    if (typeof rExp.runtime_restore_vfs !== "function") {
      throw new Error("runtime_restore_vfs is not exported by runtime WASM");
    }
    if (
      typeof snapshotId !== "number" ||
      !Number.isInteger(snapshotId) ||
      snapshotId < 1 ||
      snapshotId > 0xffff_ffff
    ) {
      throw new RangeError(
        `Invalid snapshotId: ${snapshotId} (must be an integer in 1..4294967295)`
      );
    }
    const id = snapshotId;
    const rc = rExp.runtime_restore_vfs(id);
    if (rc !== 0) {
      throw new Error(`runtime_restore_vfs failed for snapshot ${snapshotId}: ${rc}`);
    }
    const snap = this._vfsSnapshots.get(id);
    if (snap) {
      this.vfsSymlinks = new Map(snap.symlinks);
      this.vfsFilePaths = new Set(snap.filePaths);
    }
  }

  dropVfsSnapshot(snapshotId) {
    if (!this.runtimeInst) {
      throw new Error("Elf2WasmSystem created without runtimeWasm");
    }
    const rExp = this.runtimeInst.exports;
    if (typeof rExp.runtime_drop_vfs_snapshot !== "function") {
      throw new Error("runtime_drop_vfs_snapshot is not exported by runtime WASM");
    }
    if (
      typeof snapshotId !== "number" ||
      !Number.isInteger(snapshotId) ||
      snapshotId < 1 ||
      snapshotId > 0xffff_ffff
    ) {
      throw new RangeError(
        `Invalid snapshotId: ${snapshotId} (must be an integer in 1..4294967295)`
      );
    }
    const id = snapshotId;
    const rc = rExp.runtime_drop_vfs_snapshot(id);
    this._vfsSnapshots.delete(id);
    if (rc !== 0) {
      throw new Error(`runtime_drop_vfs_snapshot failed for snapshot ${snapshotId}: ${rc}`);
    }
  }

  _callVfsDiffExport(exportName, { baseSnapshotId = null, pathPrefix = null } = {}) {
    if (!this.runtimeInst) {
      throw new Error("Elf2WasmSystem created without runtimeWasm");
    }
    const rExp = this.runtimeInst.exports;
    if (typeof rExp[exportName] !== "function") {
      throw new Error(`${exportName} is not exported by runtime WASM`);
    }
    let useBase = 0;
    let snapId = 0;
    if (baseSnapshotId !== null && baseSnapshotId !== undefined) {
      if (
        typeof baseSnapshotId !== "number" ||
        !Number.isInteger(baseSnapshotId) ||
        baseSnapshotId < 1 ||
        baseSnapshotId > 0xffff_ffff
      ) {
        throw new RangeError(
          `Invalid baseSnapshotId: ${baseSnapshotId} (must be an integer in 1..4294967295)`
        );
      }
      useBase = 1;
      snapId = baseSnapshotId;
    }

    let pPtr = 0;
    let pLen = 0;
    if (typeof pathPrefix === "string" && pathPrefix.length > 0) {
      const pBytes = textEncoder.encode(pathPrefix);
      pLen = pBytes.length;
      pPtr = rExp.alloc(pLen) >>> 0;
      new Uint8Array(rExp.memory.buffer, pPtr, pLen).set(pBytes);
    }

    let outLenPtr = 0;
    let outPtr = 0;
    let outLen = 0;
    try {
      outLenPtr = rExp.alloc(4) >>> 0;
      outPtr = rExp[exportName](snapId, useBase, pPtr, pLen, outLenPtr) >>> 0;
      outLen = new DataView(rExp.memory.buffer).getUint32(outLenPtr, true);
    } finally {
      if (outLenPtr !== 0) {
        rExp.dealloc(outLenPtr, 4);
      }
      if (pPtr !== 0 && pLen > 0) {
        rExp.dealloc(pPtr, pLen);
      }
    }

    if (outPtr === 0 || outLen === 0) {
      throw new Error(
        `${exportName} failed (baseSnapshotId=${baseSnapshotId ?? "none"}, pathPrefix=${pathPrefix ?? ""})`
      );
    }
    try {
      return new Uint8Array(rExp.memory.buffer, outPtr, outLen).slice();
    } finally {
      rExp.dealloc(outPtr, outLen);
    }
  }

  exportVfsDiffTar(options = {}) {
    return this._callVfsDiffExport("runtime_export_vfs_tar", options);
  }

  listVfsDiff(options = {}) {
    const jsonBytes = this._callVfsDiffExport("runtime_list_vfs_diff", options);
    return JSON.parse(textDecoder.decode(jsonBytes));
  }

  _notifyInput() {
    this._inputSignaled = true;
    if (this._inputWaiters.length === 0) return;
    const waiters = this._inputWaiters.splice(0, this._inputWaiters.length);
    for (const resolve of waiters) {
      resolve();
    }
  }

  _waitForInput(signal) {
    if (this._aborted || signal?.aborted) {
      this._inputSignaled = false;
      return Promise.resolve();
    }
    if (this._inputSignaled) {
      this._inputSignaled = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let done = false;
      const onWake = () => {
        if (done) return;
        done = true;
        this._inputSignaled = false;
        if (signal) signal.removeEventListener("abort", onWake);
        resolve();
      };
      this._inputWaiters.push(onWake);
      if (signal) {
        signal.addEventListener("abort", onWake, { once: true });
      }
    });
  }

  pushStdin(data) {
    if (!this.runtimeInst) return;
    const rExp = this.runtimeInst.exports;
    const bytes = typeof data === "string" ? textEncoder.encode(data) : toUint8Array(data);
    if (typeof rExp.runtime_push_stdin === "function" && bytes.length > 0) {
      const ptr = rExp.alloc(bytes.length);
      new Uint8Array(rExp.memory.buffer, ptr, bytes.length).set(bytes);
      rExp.runtime_push_stdin(ptr, bytes.length);
      rExp.dealloc(ptr, bytes.length);
    }
    this._notifyInput();
  }

  closeStdin() {
    if (!this.runtimeInst) return;
    const rExp = this.runtimeInst.exports;
    if (typeof rExp.runtime_close_stdin === "function") {
      rExp.runtime_close_stdin();
    }
    this._notifyInput();
  }

  sendSigint() {
    if (!this.runtimeInst) return;
    const rExp = this.runtimeInst.exports;
    if (typeof rExp.runtime_send_sigint === "function") {
      rExp.runtime_send_sigint();
    }
    this._notifyInput();
  }

  stop() {
    this._aborted = true;
    this._notifyInput();
  }

  getActiveProcessCount() {
    return this._processes ? this._processes.size : this.lastActiveProcessCount;
  }

  readVfsLink(guestPath) {
    const normPath = normalizeGuestPath(guestPath);
    if (this.runtimeInst && typeof this.runtimeInst.exports.runtime_read_vfs_link === "function") {
      const rExp = this.runtimeInst.exports;
      const pathBytes = textEncoder.encode(normPath);
      const allocLen = Math.max(1, pathBytes.length);
      const pPtr = rExp.alloc(allocLen);
      const outLenPtr = rExp.alloc(4);
      if (pathBytes.length > 0) {
        new Uint8Array(rExp.memory.buffer, pPtr, pathBytes.length).set(pathBytes);
      }
      const outPtr = rExp.runtime_read_vfs_link(pPtr, pathBytes.length, outLenPtr);
      rExp.dealloc(pPtr, allocLen);
      const outLen = new DataView(rExp.memory.buffer).getUint32(outLenPtr, true);
      rExp.dealloc(outLenPtr, 4);
      if (outPtr === 0) return null;
      const targetBytes = new Uint8Array(rExp.memory.buffer, outPtr, outLen).slice();
      rExp.dealloc(outPtr, outLen);
      return textDecoder.decode(targetBytes);
    }
    return this.vfsSymlinks.get(normPath) ?? null;
  }

  resolveVfsPath(guestPath, maxHops = 40) {
    let parts = normalizeGuestPath(guestPath).split("/").filter(Boolean);
    let resolved = [];
    let hops = 0;

    while (parts.length > 0) {
      const comp = parts.shift();
      if (comp === "." || comp === "") continue;
      if (comp === "..") {
        resolved.pop();
        continue;
      }
      resolved.push(comp);
      const curPath = "/" + resolved.join("/");
      const target = this.readVfsLink(curPath);
      if (target !== null) {
        hops++;
        if (hops > maxHops) {
          throw new Error(`Too many levels of symbolic links: ${guestPath}`);
        }
        const targetParts = target.split("/").filter((c) => c.length > 0 && c !== ".");
        if (target.startsWith("/")) {
          resolved = [];
        } else {
          resolved.pop();
        }
        parts = targetParts.concat(parts);
      }
    }
    return resolved.length === 0 ? "/" : "/" + resolved.join("/");
  }

  readVfsFile(guestPath) {
    if (!this.runtimeInst) throw new Error("Elf2WasmSystem created without runtimeWasm");
    const rExp = this.runtimeInst.exports;
    const resolvedPath = this.resolveVfsPath(guestPath);
    const pathBytes = textEncoder.encode(resolvedPath);
    const pPtr = rExp.alloc(pathBytes.length);
    const outLenPtr = rExp.alloc(4);
    new Uint8Array(rExp.memory.buffer, pPtr, pathBytes.length).set(pathBytes);
    const outPtr = rExp.runtime_read_vfs_file(pPtr, pathBytes.length, outLenPtr);
    rExp.dealloc(pPtr, pathBytes.length);
    const outLen = new DataView(rExp.memory.buffer).getUint32(outLenPtr, true);
    rExp.dealloc(outLenPtr, 4);
    if (outPtr === 0) return null;
    const copy = new Uint8Array(rExp.memory.buffer, outPtr, outLen).slice();
    rExp.dealloc(outPtr, outLen);
    return copy;
  }

  resolveCommandPath(command, env = [], cwd = "/") {
    const cmd = String(command || "");
    if (!cmd) return null;
    if (cmd.includes("/")) {
      const norm = resolveGuestPathWithCwd(cmd, cwd);
      return this.readVfsFile(norm) ? norm : null;
    }
    let pathVal = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
    for (const entry of env || []) {
      if (typeof entry === "string" && entry.startsWith("PATH=")) {
        pathVal = entry.slice(5);
        break;
      }
    }
    for (const dir of pathVal.split(":")) {
      if (!dir) continue;
      const cand = resolveGuestPathWithCwd(`${dir}/${cmd}`, cwd);
      if (this.readVfsFile(cand)) return cand;
    }
    return null;
  }

  _getConfigSoSearchDirs() {
    const dirs = [];
    const seenDirs = new Set();
    const addDir = (d) => {
      if (!d) return;
      const norm = normalizeGuestPath(d);
      if (!seenDirs.has(norm)) {
        seenDirs.add(norm);
        dirs.push(norm);
      }
    };

    // musl search path file
    const muslPathBytes = this.readVfsFile("/etc/ld-musl-x86_64.path");
    if (muslPathBytes) {
      const text = textDecoder.decode(muslPathBytes);
      for (const line of text.split(/\r?\n/)) {
        const clean = line.replace(/#.*$/, "").trim();
        if (!clean) continue;
        for (const part of clean.split(":")) {
          const trimmed = part.trim();
          if (trimmed) addDir(trimmed);
        }
      }
    }

    // glibc /etc/ld.so.conf (with recursive include glob support)
    const visitedFiles = new Set();
    const parseLdSoConf = (confPath, depth) => {
      if (depth > 8) return;
      const normConf = normalizeGuestPath(confPath);
      if (visitedFiles.has(normConf)) return;
      visitedFiles.add(normConf);
      const bytes = this.readVfsFile(normConf);
      if (!bytes) return;
      const baseDir = dirname(normConf);
      const text = textDecoder.decode(bytes);
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.replace(/#.*$/, "").trim();
        if (!line) continue;
        if (/^include\s+/i.test(line)) {
          const patterns = line.replace(/^include\s+/i, "").trim().split(/\s+/);
          for (const pat of patterns) {
            if (!pat) continue;
            const fullPat = pat.startsWith("/")
              ? normalizeGuestPath(pat)
              : normalizeGuestPath(`${baseDir}/${pat}`);
            if (fullPat.includes("*") || fullPat.includes("?")) {
              const re = globToRegExp(fullPat);
              const matches = Array.from(this.vfsFilePaths)
                .filter((p) => re.test(p))
                .sort();
              for (const m of matches) {
                parseLdSoConf(m, depth + 1);
              }
            } else {
              parseLdSoConf(fullPat, depth + 1);
            }
          }
        } else if (line.startsWith("/")) {
          addDir(line);
        }
      }
    };
    parseLdSoConf("/etc/ld.so.conf", 0);

    return dirs;
  }

  _expandOrigin(entry, originDir) {
    if (!entry) return "";
    const expanded = entry
      .replace(/\$\{ORIGIN\}/g, originDir)
      .replace(/\$ORIGIN(?![A-Za-z0-9_])/g, originDir);
    return normalizeGuestPath(expanded);
  }

  _resolveElfSos(elfBytes, extraPaths = [], options = {}) {
    const resolved = [];
    const seen = new Set();
    const resolvedSeen = new Set();
    const queue = [];

    const env = options.env || [];
    const ldLibDirs = [];
    for (const entry of env) {
      if (typeof entry === "string" && entry.startsWith("LD_LIBRARY_PATH=")) {
        for (const p of entry.slice("LD_LIBRARY_PATH=".length).split(":")) {
          if (p) ldLibDirs.push(normalizeGuestPath(p));
        }
      }
    }
    const configDirs = this._getConfigSoSearchDirs();

    const resolvedElfPath = options.elfPath ? this.resolveVfsPath(options.elfPath) : "";
    const rootOriginDir = resolvedElfPath ? dirname(resolvedElfPath) : "/";

    const enqueue = (nameOrPath, { originDir = rootOriginDir, rpath = [], runpath = [], isInterp = false } = {}) => {
      if (!nameOrPath) return;
      const key = `${isInterp ? "I:" : "N:"}${nameOrPath}`;
      if (seen.has(key)) return;
      seen.add(key);
      queue.push({ target: nameOrPath, originDir, rpath, runpath, isInterp });
    };

    const rootDeps = parseElf64Deps(elfBytes);
    if (rootDeps.interp) {
      enqueue(rootDeps.interp, {
        originDir: rootOriginDir,
        rpath: rootDeps.rpath,
        runpath: rootDeps.runpath,
        isInterp: true,
      });
    }
    for (const n of rootDeps.needed) {
      enqueue(n, {
        originDir: rootOriginDir,
        rpath: rootDeps.rpath,
        runpath: rootDeps.runpath,
      });
    }
    for (const ep of extraPaths) {
      enqueue(ep, { originDir: rootOriginDir });
    }

    // F20: Auto-bundle core Python stdlib C extensions from lib-dynload/*.so
    const rawElfBase = options.elfPath ? basename(options.elfPath) : "";
    const resolvedElfBase = resolvedElfPath ? basename(resolvedElfPath) : "";
    const pyPattern = /^python3(?:\.\d+)?$/;
    if (pyPattern.test(rawElfBase) || pyPattern.test(resolvedElfBase)) {
      const verMatch = resolvedElfBase.match(/^python(3\.\d+)$/) || rawElfBase.match(/^python(3\.\d+)$/);
      const pyVer = verMatch ? verMatch[1] : null;
      const allDynload = [];
      for (const p of this.vfsFilePaths) {
        if (p.includes("/lib-dynload/") && p.endsWith(".so")) {
          allDynload.push(p);
        }
      }
      let candidates = allDynload;
      if (pyVer) {
        const verNeedle = `/python${pyVer}/lib-dynload/`;
        const verMatched = allDynload.filter((p) => p.includes(verNeedle));
        if (verMatched.length > 0) {
          candidates = verMatched;
        }
      }
      const selected = [];
      for (const p of candidates) {
        const base = basename(p);
        const dot = base.indexOf(".");
        const modName = dot > 0 ? base.slice(0, dot) : base;
        if (PYTHON_CORE_LIB_DYNLOAD.has(modName)) {
          selected.push(p);
        }
      }
      selected.sort();
      for (const soPath of selected) {
        enqueue(soPath, { originDir: dirname(soPath) });
      }
    }

    while (queue.length > 0) {
      const item = queue.shift();
      const target = item.target;
      let foundPath = null;
      let foundBytes = null;

      if (target.startsWith("/")) {
        const normTarget = normalizeGuestPath(target);
        const b = this.readVfsFile(normTarget);
        if (b) {
          foundPath = normTarget;
          foundBytes = b;
        }
      } else {
        const searchDirs = [];
        if (item.runpath.length === 0 && item.rpath.length > 0) {
          for (const d of item.rpath) searchDirs.push(this._expandOrigin(d, item.originDir));
        }
        for (const d of ldLibDirs) searchDirs.push(d);
        for (const d of item.runpath) searchDirs.push(this._expandOrigin(d, item.originDir));
        for (const d of configDirs) searchDirs.push(d);
        for (const d of DEFAULT_SO_SEARCH_DIRS) searchDirs.push(d);

        const triedDirs = new Set();
        for (const dir of searchDirs) {
          if (!dir || triedDirs.has(dir)) continue;
          triedDirs.add(dir);
          const cand = normalizeGuestPath(`${dir}/${target}`);
          const b = this.readVfsFile(cand);
          if (b) {
            foundPath = cand;
            foundBytes = b;
            break;
          }
        }
      }

      if (!foundBytes) {
        const base = basename(target);
        const init = this.initialSoMap.get(target) || this.initialSoMap.get(base);
        if (init) {
          foundPath = init.path;
          foundBytes = init.bytes;
        }
      }

      if (isElf64Bytes(foundBytes)) {
        const canonical = this.resolveVfsPath(foundPath);
        if (resolvedSeen.has(canonical)) continue;
        resolvedSeen.add(canonical);
        // Preserve requested PT_INTERP / DT_NEEDED foundPath so musl/glibc symlinks resolve cleanly
        const emitPath = foundPath || canonical;
        resolved.push({ path: emitPath, name: basename(emitPath), bytes: foundBytes });
        const sub = parseElf64Deps(foundBytes);
        const subOrigin = dirname(canonical);
        for (const n of sub.needed) {
          enqueue(n, {
            originDir: subOrigin,
            rpath: sub.rpath.length > 0 ? sub.rpath : item.rpath,
            runpath: sub.runpath,
          });
        }
      }
    }

    return resolved;
  }

  _initGuestStack(metaBytes, args, env) {
    const rExp = this.runtimeInst.exports;
    const argsBuf = encodeE2waArgs(args, env);
    const metaPtr = rExp.alloc(metaBytes.length);
    new Uint8Array(rExp.memory.buffer, metaPtr, metaBytes.length).set(metaBytes);
    const argsPtr = rExp.alloc(argsBuf.length);
    new Uint8Array(rExp.memory.buffer, argsPtr, argsBuf.length).set(argsBuf);
    const rc = rExp.runtime_init_guest_stack(metaPtr, metaBytes.length, argsPtr, argsBuf.length);
    rExp.dealloc(metaPtr, metaBytes.length);
    rExp.dealloc(argsPtr, argsBuf.length);
    if (rc !== 0) throw new Error(`runtime_init_guest_stack failed: ${rc}`);
  }

  _applyInitialCwd(cwd) {
    if (!cwd || !this.activeGuest || !this.runtimeInst) return;
    const normCwd = normalizeGuestPath(cwd);
    if (normCwd === "/") return;
    const rExp = this.runtimeInst.exports;
    if (typeof rExp.runtime_handle_syscall !== "function") return;

    const cwdBytes = textEncoder.encode(normCwd + "\0");
    const gMem = new Uint8Array(this.activeGuest.exports.memory.buffer);
    const rsp = this.activeGuest.exports.rsp ? Number(this.activeGuest.exports.rsp.value) : 0;
    const scratchSize = Math.max(256, cwdBytes.length + 16);
    const scratchAddr = rsp > scratchSize + 4096 ? rsp - scratchSize : 0x1000;
    if (scratchAddr + cwdBytes.length > gMem.length) return;

    const saved = gMem.slice(scratchAddr, scratchAddr + cwdBytes.length);
    gMem.set(cwdBytes, scratchAddr);
    try {
      // SYS_CHDIR = 80
      let rc = rExp.runtime_handle_syscall(80n, BigInt(scratchAddr), 0n, 0n, 0n, 0n, 0n);
      if (rc === -2n) {
        this.writeVfsDir(normCwd, 0o755);
        rExp.runtime_handle_syscall(80n, BigInt(scratchAddr), 0n, 0n, 0n, 0n, 0n);
      }
    } finally {
      new Uint8Array(this.activeGuest.exports.memory.buffer).set(saved, scratchAddr);
    }
  }

  _completeExec(pid, metaBytes, args, env) {
    const rExp = this.runtimeInst.exports;
    const argsBuf = encodeE2waArgs(args, env);
    const metaPtr = rExp.alloc(metaBytes.length);
    new Uint8Array(rExp.memory.buffer, metaPtr, metaBytes.length).set(metaBytes);
    const argsPtr = rExp.alloc(argsBuf.length);
    new Uint8Array(rExp.memory.buffer, argsPtr, argsBuf.length).set(argsBuf);
    const rc = rExp.runtime_complete_exec(pid, metaPtr, metaBytes.length, argsPtr, argsBuf.length);
    rExp.dealloc(metaPtr, metaBytes.length);
    rExp.dealloc(argsPtr, argsBuf.length);
    if (rc !== 0) throw new Error(`runtime_complete_exec failed: ${rc}`);
  }

  _readRtBytes(fn) {
    const rExp = this.runtimeInst.exports;
    const outLenPtr = rExp.alloc(4);
    const ptr = fn(outLenPtr);
    const len = new DataView(rExp.memory.buffer).getUint32(outLenPtr, true);
    rExp.dealloc(outLenPtr, 4);
    if (ptr === 0 || len === 0) return new Uint8Array(0);
    return new Uint8Array(rExp.memory.buffer, ptr, len).slice();
  }

  _readOwnedRtBytes(fn) {
    const rExp = this.runtimeInst.exports;
    const outLenPtr = rExp.alloc(4);
    const ptr = fn(outLenPtr);
    const len = new DataView(rExp.memory.buffer).getUint32(outLenPtr, true);
    rExp.dealloc(outLenPtr, 4);
    if (ptr === 0 || len === 0) return new Uint8Array(0);
    const copy = new Uint8Array(rExp.memory.buffer, ptr, len).slice();
    rExp.dealloc(ptr, len);
    return copy;
  }

  drainStdout() {
    if (!this.runtimeInst) return new Uint8Array(0);
    const rExp = this.runtimeInst.exports;
    if (typeof rExp.runtime_drain_stdout !== "function") return new Uint8Array(0);
    return this._readOwnedRtBytes((p) => rExp.runtime_drain_stdout(p));
  }

  drainStderr() {
    if (!this.runtimeInst) return new Uint8Array(0);
    const rExp = this.runtimeInst.exports;
    if (typeof rExp.runtime_drain_stderr !== "function") return new Uint8Array(0);
    return this._readOwnedRtBytes((p) => rExp.runtime_drain_stderr(p));
  }

  takeReapedPids() {
    if (!this.runtimeInst) return [];
    const rExp = this.runtimeInst.exports;
    if (typeof rExp.runtime_take_reaped_pids !== "function") return [];
    const raw = this._readOwnedRtBytes((p) => rExp.runtime_take_reaped_pids(p));
    if (raw.length < 4) return [];
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const count = Math.floor(raw.length / 4);
    const pids = [];
    for (let i = 0; i < count; i++) {
      pids.push(dv.getUint32(i * 4, true));
    }
    return pids;
  }

  async runElf(elfBytes, soEntries = [], args = [], options = {}) {
    if ((!this.compilerInst && !this.compilerMod) || !this.runtimeInst) {
      throw new Error("Elf2WasmSystem requires both compilerWasm and runtimeWasm to run ELFs");
    }

    this._aborted = false;
    this._inputSignaled = false;
    this._inputWaiters = [];
    const rExp = this.runtimeInst.exports;
    const elfU8 = toUint8Array(elfBytes);
    const elfPath = options.elfPath || "app";
    const normSos = (soEntries || []).map((so) => ({
      path: so.path || so.name || "",
      name: so.name || basename(so.path || ""),
      bytes: toUint8Array(so.bytes),
    }));

    this.initialSoMap.clear();
    for (const so of normSos) {
      if (so.path) this.initialSoMap.set(so.path, so);
      if (so.name) this.initialSoMap.set(so.name, so);
    }

    const { mod, metaBytes } = await this._compileCached(elfU8, normSos, elfPath);
    if (this._aborted || options.signal?.aborted) {
      return {
        exitCode: 137,
        stdout: new Uint8Array(0),
        stderr: new Uint8Array(0),
        virtualTimeNs: this.getVirtualTimeNs(),
      };
    }

    const guestImports = {};

    const mainInst = await WebAssembly.instantiate(mod, guestImports);
    if (this._aborted || options.signal?.aborted) {
      return {
        exitCode: 137,
        stdout: new Uint8Array(0),
        stderr: new Uint8Array(0),
        virtualTimeNs: this.getVirtualTimeNs(),
      };
    }

    const processes = new Map();
    this._processes = processes;
    let activePid = 1000;
    processes.set(activePid, { instance: mainInst, module: mod, elfPath });
    this.activeGuest = mainInst;

    const effArgs =
      !args || args.length === 0
        ? [elfPath]
        : options.preserveArgv0 || args[0] === elfPath
          ? args
          : [elfPath, ...args];
    const effEnv = options.env || ["PATH=/usr/local/bin:/usr/bin:/bin"];

    // Apply delay config, virtual time reset, UID/GID, TTY mode, and winsize
    // BEFORE _initGuestStack (which calls reset_for_new_run() and seeds AT_RANDOM).
    if (options.delayStddevMs !== undefined || options.delaySeed !== undefined) {
      this.setDelayConfig(options.delayStddevMs ?? 0, options.delaySeed ?? 0);
    }
    if (options.uid !== undefined || options.gid !== undefined) {
      this.setUidGid(options.uid ?? 0, options.gid ?? 0);
    }
    const isInteractive = Boolean(options.tty || options.interactive);
    const keepStdinOpen = Boolean(options.keepStdinOpen && options.stdin === undefined);
    this.setTtyMode(isInteractive);
    this.setStdinOpen(keepStdinOpen);
    if (options.rows !== undefined || options.cols !== undefined) {
      this.setWinsize(options.rows ?? 24, options.cols ?? 80);
    }

    this._initGuestStack(metaBytes, effArgs, effEnv);

    // Apply initial cwd AFTER _initGuestStack (reset_for_new_run() resets cwd to "/")
    if (options.cwd) {
      this._applyInitialCwd(options.cwd);
    }
    if (options.resetVirtualTime !== false) {
      this.resetVirtualTime();
    }

    // Pre-seed stdin after _initGuestStack
    if (options.stdin !== undefined) {
      this.pushStdin(options.stdin);
      if (!isInteractive) {
        this.closeStdin();
      }
    }

    if (typeof options.onReady === "function") {
      options.onReady();
    }

    const onStdout = typeof options.onStdout === "function" ? options.onStdout : null;
    const onStderr = typeof options.onStderr === "function" ? options.onStderr : null;
    const signal = options.signal || null;
    const yieldEvery =
      Number.isInteger(options.yieldEvery) && options.yieldEvery > 0
        ? options.yieldEvery
        : 0;
    const yieldIntervalMs =
      Number.isFinite(options.yieldIntervalMs) && options.yieldIntervalMs > 0
        ? options.yieldIntervalMs
        : 16;
    const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

    const flushStdio = () => {
      if (onStdout) {
        const chunk = this.drainStdout();
        if (chunk.length > 0) onStdout(chunk);
      }
      if (onStderr) {
        const chunk = this.drainStderr();
        if (chunk.length > 0) onStderr(chunk);
      }
    };

    const pendingReap = new Set();
    const reapChildren = () => {
      if (processes.size <= 1 && pendingReap.size === 0) return;
      const reaped = this.takeReapedPids();
      for (const pid of reaped) {
        this.reapedPidCount++;
        if (pid !== 1000) {
          pendingReap.add(pid);
        }
      }
      if (pendingReap.size === 0) return;
      const curActive = rExp.runtime_get_active_pid();
      for (const pid of Array.from(pendingReap)) {
        if (pid !== 1000 && pid !== curActive) {
          processes.delete(pid);
          pendingReap.delete(pid);
        }
      }
    };

    const onAbort = () => this._notifyInput();
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    const timeoutMs =
      Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : null;
    const deadlineMs = timeoutMs !== null ? nowMs() + timeoutMs : null;
    let timedOut = false;
    let timeoutTimer = null;
    if (timeoutMs !== null) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        this._notifyInput();
      }, timeoutMs);
      if (timeoutTimer && typeof timeoutTimer.unref === "function") {
        timeoutTimer.unref();
      }
    }

    let lastCode = 0;
    let steps = 0;
    let lastYieldTime = nowMs();
    let skipStart = false;

    try {
      while (true) {
        if (this._aborted || signal?.aborted) {
          break;
        }
        if (timedOut || (deadlineMs !== null && nowMs() >= deadlineMs)) {
          timedOut = true;
          break;
        }

        if (!skipStart) {
          try {
            lastCode = this.activeGuest.exports._start();
          } catch (err) {
            throw formatWasmTrapError(err, {
              phase: "guest._start",
              elfPath: processes.get(activePid)?.elfPath || elfPath,
              pid: activePid,
              guestExports: this.activeGuest?.exports,
            });
          }
        }
        skipStart = false;

        if (rExp.runtime_is_exited() !== 0) {
          flushStdio();
          reapChildren();
          break;
        }

        let yieldAction;
        try {
          yieldAction = rExp.runtime_on_yield();
        } catch (err) {
          if (err instanceof WebAssembly.RuntimeError) {
            throw formatWasmTrapError(err, {
              phase: "runtime_on_yield",
              elfPath: processes.get(activePid)?.elfPath || elfPath,
              pid: activePid,
              guestExports: this.activeGuest?.exports,
            });
          }
          throw err;
        }
        reapChildren();

        if (yieldAction === 0) {
          flushStdio();
          break;
        } else if (yieldAction === 1) {
          steps++;
          const hitStepYield = yieldEvery > 0 && steps % yieldEvery === 0;
          if (hitStepYield || (steps & 3) === 0) {
            const now = nowMs();
            if (deadlineMs !== null && now >= deadlineMs) {
              timedOut = true;
              break;
            }
            if (hitStepYield || now - lastYieldTime >= yieldIntervalMs) {
              flushStdio();
              await yieldMacrotask();
              lastYieldTime = nowMs();
            }
          }
          continue;
        } else if (yieldAction === 2) {
          activePid = rExp.runtime_get_active_pid();
          reapChildren();
          const entry = processes.get(activePid);
          if (!entry) throw new Error(`Missing guest instance for pid ${activePid}`);
          this.activeGuest = entry.instance;
          const resumed = rExp.runtime_resume_active();
          if (resumed === 0) {
            skipStart = true;
          }
          steps++;
          const hitStepYield = yieldEvery > 0 && steps % yieldEvery === 0;
          if (hitStepYield || (steps & 3) === 0) {
            const now = nowMs();
            if (deadlineMs !== null && now >= deadlineMs) {
              timedOut = true;
              break;
            }
            if (hitStepYield || now - lastYieldTime >= yieldIntervalMs) {
              flushStdio();
              await yieldMacrotask();
              lastYieldTime = nowMs();
            }
          }
        } else if (yieldAction === 3) {
          // NeedFork
          flushStdio();
          const childPid = rExp.runtime_get_pending_child_pid();
          const scratchAddr = rExp.runtime_get_pending_scratch_addr() >>> 0;
          const parentEntry = processes.get(activePid);
          const childInst = await WebAssembly.instantiate(parentEntry.module, guestImports);
          if (this._aborted || signal?.aborted) {
            break;
          }
          if (timedOut || (deadlineMs !== null && nowMs() >= deadlineMs)) {
            timedOut = true;
            break;
          }

          const parentMem = parentEntry.instance.exports.memory;
          const childMem = childInst.exports.memory;
          const parentByteLen = parentMem.buffer.byteLength;
          if (childMem.buffer.byteLength < parentByteLen) {
            const pagesNeeded =
              (parentByteLen - childMem.buffer.byteLength + 65535) >>> 16;
            childMem.grow(pagesNeeded);
          }
          const parentView = new Uint8Array(parentMem.buffer);
          const childView = new Uint8Array(childMem.buffer);
          let copiedSparse = false;
          if (typeof rExp.runtime_get_fork_copy_ranges === "function" && parentByteLen > 0) {
            const raw = this._readOwnedRtBytes((p) =>
              rExp.runtime_get_fork_copy_ranges(parentByteLen >>> 0, p)
            );
            if (raw.length >= 8 && (raw.length & 7) === 0) {
              const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
              const count = raw.length >>> 3;
              for (let i = 0; i < count; i++) {
                const start = dv.getUint32(i * 8, true);
                const end = dv.getUint32(i * 8 + 4, true);
                if (end > start && end <= parentByteLen) {
                  childView.set(parentView.subarray(start, end), start);
                }
              }
              copiedSparse = true;
            }
          }
          if (!copiedSparse) {
            childView.set(parentView);
          }

          for (const [name, exp] of Object.entries(parentEntry.instance.exports)) {
            if (exp instanceof WebAssembly.Global && childInst.exports[name]) {
              childInst.exports[name].value = exp.value;
            }
          }
          if (typeof childInst.exports.load_ctx === "function") {
            childInst.exports.load_ctx(scratchAddr);
          }

          processes.set(childPid, {
            instance: childInst,
            module: parentEntry.module,
            elfPath: parentEntry.elfPath,
          });
          rExp.runtime_ack_fork(childPid);
          activePid = rExp.runtime_get_active_pid();
          this.activeGuest = processes.get(activePid).instance;
          const resumed = rExp.runtime_resume_active();
          if (resumed === 0) {
            skipStart = true;
          }
        } else if (yieldAction === 4) {
          // NeedExec
          flushStdio();
          const infoBytes = this._readOwnedRtBytes((p) => rExp.runtime_get_exec_info(p));
          if (infoBytes.length === 0) {
            throw new Error("runtime_get_exec_info returned empty buffer");
          }

          const execInfo = decodeE2weExecInfo(infoBytes);
          const execElf = this.readVfsFile(execInfo.path);
          if (!execElf) {
            throw new Error(`execve target not found in VFS: ${execInfo.path}`);
          }
          const extraSos = [];
          for (const arg of execInfo.argv || []) {
            if (
              typeof arg === "string" &&
              arg.startsWith("/") &&
              (arg.endsWith(".so") || arg.includes(".so."))
            ) {
              extraSos.push(arg);
            }
          }
          const execSos = this._resolveElfSos(execElf, extraSos, {
            elfPath: execInfo.path,
            env: execInfo.envp,
          });
          let compiled;
          try {
            compiled = await this._compileCached(execElf, execSos, execInfo.path);
          } catch (err) {
            if (err instanceof WebAssembly.RuntimeError) {
              throw formatWasmTrapError(err, {
                phase: "needExec:compile",
                elfPath: execInfo.path,
                pid: execInfo.pid,
              });
            }
            throw err;
          }
          if (this._aborted || signal?.aborted) {
            break;
          }
          const newInst = await WebAssembly.instantiate(compiled.mod, guestImports);
          if (this._aborted || signal?.aborted) {
            break;
          }

          processes.set(execInfo.pid, {
            instance: newInst,
            module: compiled.mod,
            elfPath: execInfo.path,
          });
          activePid = execInfo.pid;
          this.activeGuest = newInst;
          this._completeExec(
            execInfo.pid,
            compiled.metaBytes,
            execInfo.argv.length > 0 ? execInfo.argv : [execInfo.path],
            execInfo.envp
          );
        } else if (yieldAction === 5) {
          // NeedStdin
          this._inputSignaled = false;
          flushStdio();
          reapChildren();
          if (this._aborted || signal?.aborted) {
            break;
          }
          if (timedOut || (deadlineMs !== null && nowMs() >= deadlineMs)) {
            timedOut = true;
            break;
          }
          await this._waitForInput(signal);
          if (this._aborted || signal?.aborted) {
            break;
          }
          if (timedOut || (deadlineMs !== null && nowMs() >= deadlineMs)) {
            timedOut = true;
            break;
          }
          if (rExp.runtime_is_exited() !== 0) {
            flushStdio();
            reapChildren();
            break;
          }
          activePid = rExp.runtime_get_active_pid();
          reapChildren();
          const entry = processes.get(activePid);
          if (entry) {
            this.activeGuest = entry.instance;
          }
          const resumed = rExp.runtime_resume_active();
          if (resumed === 0) {
            skipStart = true;
          }
          lastYieldTime = nowMs();
        } else {
          throw new Error(`Unexpected runtime_on_yield return code: ${yieldAction}`);
        }
      }
    } finally {
      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      flushStdio();
      reapChildren();
      this.lastActiveProcessCount = processes.size;
      for (const pid of Array.from(processes.keys())) {
        if (pid !== 1000) {
          processes.delete(pid);
        }
      }
      this._processes = null;
    }

    const mainGuest = processes.get(1000)?.instance || null;
    const exitFlag = mainGuest?.exports?.exit_flag ? mainGuest.exports.exit_flag.value | 0 : 0;
    const exitCode = timedOut
      ? 124
      : this._aborted || signal?.aborted
        ? 130
        : exitFlag !== 0 || rExp.runtime_is_exited() !== 0
          ? rExp.runtime_get_exit_code()
          : lastCode;
    // Release PID 1000's 256 MiB WASM instance between runs so GC can reclaim it.
    this.activeGuest = null;

    const stdout = this._readRtBytes((p) => rExp.runtime_get_stdout(p));
    const stderr = this._readRtBytes((p) => rExp.runtime_get_stderr(p));

    return {
      exitCode,
      stdout,
      stderr,
      virtualTimeNs: this.getVirtualTimeNs(),
      ...(timedOut ? { timedOut: true } : {}),
    };
  }

  async precompileFromVfs(guestPath, options = {}) {
    try {
      let currentPath = String(guestPath || "");
      if (!currentPath) return false;
      const env = options.env || ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"];
      const cwd = options.cwd || "/";

      if (!currentPath.includes("/")) {
        const found = this.resolveCommandPath(currentPath, env, cwd);
        if (!found) return false;
        currentPath = found;
      } else {
        currentPath = resolveGuestPathWithCwd(currentPath, cwd);
      }

      const normPath = resolveGuestPathWithCwd(currentPath, cwd);
      const resolvedPath = this.resolveVfsPath(normPath);
      const elfBytes = this.readVfsFile(resolvedPath);

      if (!elfBytes || !isElf64Bytes(elfBytes)) {
        return false;
      }

      const soEntries = this._resolveElfSos(elfBytes, options.extraSos || [], {
        elfPath: resolvedPath,
        env,
      });
      await this._compileCached(elfBytes, soEntries, normPath);
      return true;
    } catch {
      return false;
    }
  }

  async runFromVfs(guestPath, args = [], options = {}) {
    let currentPath = String(guestPath || "");
    let currentArgs = Array.isArray(args) ? args.slice() : [];
    const env = options.env || ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"];
    const cwd = options.cwd || "/";
    const initialArgv0Matches = currentArgs.length > 0 && currentArgs[0] === guestPath;
    let rewroteShebang = false;

    if (!currentPath.includes("/")) {
      const found = this.resolveCommandPath(currentPath, env, cwd);
      if (!found) {
        const err = new Error(`Command not found in PATH: ${guestPath}`);
        err.code = "ENOENT";
        throw err;
      }
      currentPath = found;
    } else {
      currentPath = resolveGuestPathWithCwd(currentPath, cwd);
    }

    let elfBytes = null;
    let normPath = currentPath;
    let resolvedPath = currentPath;

    for (let depth = 0; depth < 5; depth++) {
      normPath = resolveGuestPathWithCwd(currentPath, cwd);
      resolvedPath = this.resolveVfsPath(normPath);
      elfBytes = this.readVfsFile(resolvedPath);
      if (!elfBytes) {
        const err = new Error(`ELF not found in VFS: ${currentPath}`);
        err.code = "ENOENT";
        throw err;
      }
      const shebang = parseShebang(elfBytes);
      if (!shebang) break;
      const hasArgv0 = initialArgv0Matches || options.preserveArgv0 === true;
      const tailArgs =
        depth === 0 && !hasArgv0
          ? currentArgs
          : currentArgs.length > 0
            ? currentArgs.slice(1)
            : [];
      currentArgs = [
        shebang.interp,
        ...(shebang.arg ? [shebang.arg] : []),
        normPath,
        ...tailArgs,
      ];
      currentPath = shebang.interp;
      rewroteShebang = true;
    }

    if (!isElf64Bytes(elfBytes)) {
      const err = new Error(`Exec format error (not an ELF64 binary): ${normPath}`);
      err.code = "ENOEXEC";
      throw err;
    }

    const soEntries = this._resolveElfSos(elfBytes, options.extraSos || [], {
      elfPath: resolvedPath,
      env,
    });
    const preserveArgv0 =
      options.preserveArgv0 !== undefined
        ? options.preserveArgv0
        : rewroteShebang || initialArgv0Matches;
    return await this.runElf(elfBytes, soEntries, currentArgs, {
      ...options,
      env,
      preserveArgv0,
      elfPath: options.elfPath || normPath,
    });
  }
}

export const VirtualSystem = Elf2WasmSystem;

export async function runElf({
  compilerWasm,
  runtimeWasm,
  elfBytes,
  elfPath = "app",
  soEntries = [],
  args = [],
  env = undefined,
  vfsRo = [],
  vfsRw = [],
  delayStddevMs = undefined,
  delaySeed = undefined,
  timeoutMs = undefined,
  signal = undefined,
} = {}) {
  const sys = await Elf2WasmSystem.create({
    compilerWasm,
    runtimeWasm,
    vfsRo,
    vfsRw,
  });
  return await sys.runElf(elfBytes, soEntries, args, {
    elfPath,
    env,
    delayStddevMs,
    delaySeed,
    timeoutMs,
    signal,
  });
}

export async function compileAndRunInVfs({
  compilerWasm,
  runtimeWasm,
  ccBytes,
  ccPath = "/usr/bin/gcc",
  soEntries = [],
  vfsRo = [],
  vfsRw = [],
  sourceBytes,
  guestSourcePath,
  guestOutPath,
} = {}) {
  const sys = await Elf2WasmSystem.create({
    compilerWasm,
    runtimeWasm,
    vfsRo,
    vfsRw,
  });
  sys.writeVfsFile(guestSourcePath, sourceBytes, 0o644);
  const ccRes = await sys.runElf(
    ccBytes,
    soEntries,
    [ccPath, guestSourcePath, "-o", guestOutPath],
    { elfPath: ccPath }
  );
  if (ccRes.exitCode !== 0) {
    const errText = textDecoder.decode(ccRes.stderr);
    return {
      exitCode: ccRes.exitCode,
      stdout: ccRes.stdout,
      stderr: textEncoder.encode(`Hosted CC failed (exit ${ccRes.exitCode}): ${errText}`),
    };
  }
  const compiledElf = sys.readVfsFile(guestOutPath);
  if (!compiledElf) {
    return {
      exitCode: 1,
      stdout: new Uint8Array(0),
      stderr: textEncoder.encode(`Hosted CC did not produce ${guestOutPath}`),
    };
  }
  return await sys.runElf(compiledElf, soEntries, [guestOutPath], {
    elfPath: guestOutPath,
  });
}

async function decompressStreamBytes(bytes, format) {
  const input = toUint8Array(bytes);
  if (typeof DecompressionStream !== "undefined") {
    const ds = new DecompressionStream(format);
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();
    const chunks = [];
    let total = 0;

    const writePromise = (async () => {
      await writer.write(input);
      await writer.close();
    })();

    const readPromise = (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.length > 0) {
          chunks.push(value);
          total += value.length;
        }
      }
    })();

    await Promise.all([writePromise, readPromise]);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    chunks.length = 0;
    return out;
  }

  const zlib = await import("node:zlib");
  if (format === "gzip") {
    return new Uint8Array(zlib.gunzipSync(input));
  }
  if (format === "deflate-raw") {
    return new Uint8Array(zlib.inflateRawSync(input));
  }
  throw new Error(`Unsupported compression format: ${format}`);
}

function parseTarOctalOrBase256(buf, offset, length) {
  if ((buf[offset] & 0x80) !== 0) {
    let val = (buf[offset] & 0x7f) !== 0 ? -1 : 0;
    for (let i = 1; i < length; i++) {
      val = val * 256 + buf[offset + i];
    }
    return val;
  }
  let s = "";
  for (let i = 0; i < length; i++) {
    const b = buf[offset + i];
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  s = s.trim();
  if (!s) return 0;
  return parseInt(s, 8) || 0;
}

function readTarString(buf, offset, length) {
  let end = offset;
  const max = offset + length;
  while (end < max && buf[end] !== 0) end++;
  return textDecoder.decode(buf.subarray(offset, end));
}

function parsePaxRecords(bytes) {
  const buf = toUint8Array(bytes);
  const records = {};
  let idx = 0;
  while (idx < buf.length) {
    let spaceIdx = -1;
    for (let i = idx; i < buf.length; i++) {
      if (buf[i] === 0x20) {
        spaceIdx = i;
        break;
      }
    }
    if (spaceIdx < 0) break;
    const lenStr = textDecoder.decode(buf.subarray(idx, spaceIdx));
    const len = parseInt(lenStr, 10);
    if (!Number.isFinite(len) || len <= 0 || idx + len > buf.length) break;
    const recEnd = idx + len;
    let eqIdx = -1;
    for (let i = spaceIdx + 1; i < recEnd; i++) {
      if (buf[i] === 0x3d) {
        eqIdx = i;
        break;
      }
    }
    if (eqIdx >= 0) {
      const key = textDecoder.decode(buf.subarray(spaceIdx + 1, eqIdx));
      let valEnd = recEnd;
      if (valEnd > eqIdx + 1 && buf[valEnd - 1] === 0x0a) {
        valEnd--;
      }
      const val = textDecoder.decode(buf.subarray(eqIdx + 1, valEnd));
      records[key] = val;
    }
    idx += len;
  }
  return records;
}

function resolveTarEntryPath(rawPath, mountPath, stripComponents) {
  const str = String(rawPath || "");
  if (!str || str.includes("\0")) return null;

  const rawParts = [];
  for (const seg of str.split("/")) {
    if (!seg || seg === ".") continue;
    rawParts.push(seg);
  }

  if (rawParts.length <= stripComponents) {
    return null;
  }

  // Reject any '..' inside the stripped prefix so '../repo/file' cannot bypass escape checks.
  for (let i = 0; i < stripComponents; i++) {
    if (rawParts[i] === "..") return null;
  }

  const relParts = [];
  for (let i = stripComponents; i < rawParts.length; i++) {
    const seg = rawParts[i];
    if (seg === "..") {
      if (relParts.length === 0) {
        if (mountPath !== "/") {
          // Path escapes mountPath (e.g., '../outside' or 'a/../../outside') — reject entry.
          return null;
        }
        // mountPath === "/": preserve legacy normalizeGuestPath clamping at root.
      } else {
        relParts.pop();
      }
    } else {
      relParts.push(seg);
    }
  }

  if (relParts.length === 0) {
    return null;
  }

  return mountPath === "/"
    ? "/" + relParts.join("/")
    : `${mountPath}/${relParts.join("/")}`;
}

export function extractTarToVfs(arg1, arg2, arg3) {
  let sys = null;
  let rawBytes;
  let options;
  if (arg1 && typeof arg1.writeVfsFile === "function") {
    sys = arg1;
    rawBytes = arg2;
    options = arg3;
  } else {
    rawBytes = arg1;
    options = arg2;
  }

  const opts = options && typeof options === "object" ? options : {};
  const mountPath = normalizeGuestPath(opts.mountPath ?? "/");
  const stripComponents = Math.max(
    0,
    Number.isFinite(Number(opts.stripComponents))
      ? Math.floor(Number(opts.stripComponents))
      : 0
  );
  const ignoreWhiteouts = Boolean(opts.ignoreWhiteouts);

  const tar = toUint8Array(rawBytes);
  const files = new Map();
  const symlinks = new Map();
  const dirs = new Map();
  const whiteouts = [];

  if (mountPath !== "/") {
    dirs.set(mountPath, 0o755);
  }

  let offset = 0;
  let nextLongName = null;
  let nextLongLink = null;
  let nextPax = null;
  let globalPax = {};

  while (offset + 512 <= tar.length) {
    let allZero = true;
    for (let i = 0; i < 512; i++) {
      if (tar[offset + i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) {
      offset += 512;
      continue;
    }

    const nameField = readTarString(tar, offset, 100);
    const mode = parseTarOctalOrBase256(tar, offset + 100, 8);
    let size = parseTarOctalOrBase256(tar, offset + 124, 12);
    const typeFlag = String.fromCharCode(tar[offset + 156]);
    const linkNameField = readTarString(tar, offset + 157, 100);
    const prefixField = readTarString(tar, offset + 345, 155);

    offset += 512;

    if (nextPax && nextPax.size !== undefined) {
      const paxSize = Number(nextPax.size);
      if (Number.isFinite(paxSize) && paxSize >= 0) size = paxSize;
    }

    if (!Number.isFinite(size) || size < 0) {
      break;
    }

    const dataEnd = Math.min(offset + size, tar.length);
    const payload = sys ? tar.subarray(offset, dataEnd) : tar.slice(offset, dataEnd);
    const paddedBlocks = Math.ceil(size / 512) * 512;
    if (!Number.isFinite(paddedBlocks) || paddedBlocks < 0) {
      break;
    }
    offset += paddedBlocks;

    if (typeFlag === "L") {
      nextLongName = textDecoder.decode(payload).replace(/\0+$/, "");
      continue;
    }
    if (typeFlag === "K") {
      nextLongLink = textDecoder.decode(payload).replace(/\0+$/, "");
      continue;
    }
    if (typeFlag === "x") {
      nextPax = parsePaxRecords(payload);
      continue;
    }
    if (typeFlag === "g") {
      globalPax = { ...globalPax, ...parsePaxRecords(payload) };
      continue;
    }

    let rawPath = prefixField ? `${prefixField}/${nameField}` : nameField;
    if (nextLongName !== null) rawPath = nextLongName;
    if (nextPax && nextPax.path !== undefined) rawPath = nextPax.path;
    else if (globalPax.path !== undefined) rawPath = globalPax.path;

    let linkTarget = linkNameField;
    if (nextLongLink !== null) linkTarget = nextLongLink;
    if (nextPax && nextPax.linkpath !== undefined) linkTarget = nextPax.linkpath;
    else if (globalPax.linkpath !== undefined) linkTarget = globalPax.linkpath;

    nextLongName = null;
    nextLongLink = null;
    nextPax = null;

    const guestPath = resolveTarEntryPath(rawPath, mountPath, stripComponents);
    if (!guestPath) continue;

    // OCI whiteout markers (.wh..wh..opq and .wh.<name>) apply only to lower
    // layers (handled in applyVfsOverlay before applying this layer's entries),
    // never to sibling entries within the same layer.
    if (!ignoreWhiteouts) {
      const base = basename(guestPath);
      const parentDir = dirname(guestPath);
      if (base === ".wh..wh..opq") {
        whiteouts.push({ type: "opaque", dir: parentDir });
        continue;
      }
      if (base.startsWith(".wh.")) {
        const targetName = base.slice(4);
        if (targetName) {
          const targetPath =
            parentDir === "/" ? "/" + targetName : `${parentDir}/${targetName}`;
          whiteouts.push({ type: "remove", path: targetPath });
        }
        continue;
      }
    }

    if (typeFlag === "5") {
      symlinks.delete(guestPath);
      files.delete(guestPath);
      dirs.set(guestPath, mode || 0o755);
      continue;
    }
    if (typeFlag === "2") {
      files.delete(guestPath);
      dirs.delete(guestPath);
      symlinks.set(guestPath, linkTarget);
      continue;
    }
    if (typeFlag === "1") {
      const targetGuestPath = resolveTarEntryPath(linkTarget, mountPath, stripComponents);
      if (!targetGuestPath) continue;
      const existing = files.get(targetGuestPath);
      if (existing) {
        const copy = sys ? existing.bytes : existing.bytes.slice();
        symlinks.delete(guestPath);
        dirs.delete(guestPath);
        files.set(guestPath, { bytes: copy, mode: mode || existing.mode || 0o644 });
      } else if (sys) {
        const targetBytes = sys.readVfsFile(targetGuestPath);
        if (targetBytes) {
          symlinks.delete(guestPath);
          dirs.delete(guestPath);
          files.set(guestPath, { bytes: targetBytes, mode: mode || 0o644 });
        } else {
          files.delete(guestPath);
          dirs.delete(guestPath);
          symlinks.set(guestPath, targetGuestPath);
        }
      } else {
        files.delete(guestPath);
        dirs.delete(guestPath);
        symlinks.set(guestPath, targetGuestPath);
      }
      continue;
    }
    if (typeFlag === "0" || typeFlag === "\0") {
      const fileMode = mode || 0o644;
      symlinks.delete(guestPath);
      dirs.delete(guestPath);
      files.set(guestPath, { bytes: payload, mode: fileMode });
    }
  }

  const vfs = { files, symlinks, dirs, whiteouts };
  if (sys) {
    applyVfsOverlay(sys, vfs);
  }

  return vfs;
}

export async function extractTarGzToVfs(arg1, arg2, arg3) {
  let sys = null;
  let rawBytes;
  let options;
  if (arg1 && typeof arg1.writeVfsFile === "function") {
    sys = arg1;
    rawBytes = arg2;
    options = arg3;
  } else {
    rawBytes = arg1;
    options = arg2;
  }
  const tarBytes = await decompressStreamBytes(rawBytes, "gzip");
  return sys
    ? extractTarToVfs(sys, tarBytes, options)
    : extractTarToVfs(tarBytes, options);
}

export async function extractZipToVfs(arg1, arg2) {
  let sys = null;
  let rawBytes;
  if (arg1 && typeof arg1.writeVfsFile === "function") {
    sys = arg1;
    rawBytes = arg2;
  } else {
    rawBytes = arg1;
  }

  const zip = toUint8Array(rawBytes);
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const files = new Map();
  const symlinks = new Map();
  const dirs = new Map();

  let eocdOffset = -1;
  const minOff = Math.max(0, zip.length - 65557);
  for (let i = zip.length - 22; i >= minOff; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error("Invalid ZIP archive: EOCD not found");
  }

  const cdCount = view.getUint16(eocdOffset + 10, true);
  let cdOffset = view.getUint32(eocdOffset + 16, true);

  for (let i = 0; i < cdCount; i++) {
    if (cdOffset + 46 > zip.length || view.getUint32(cdOffset, true) !== 0x02014b50) {
      throw new Error("Invalid ZIP central directory header");
    }
    const method = view.getUint16(cdOffset + 10, true);
    const compSize = view.getUint32(cdOffset + 20, true);
    const nameLen = view.getUint16(cdOffset + 28, true);
    const extraLen = view.getUint16(cdOffset + 30, true);
    const commentLen = view.getUint16(cdOffset + 32, true);
    const externalAttrs = view.getUint32(cdOffset + 38, true);
    const localHeaderOffset = view.getUint32(cdOffset + 42, true);

    const rawName = textDecoder.decode(zip.subarray(cdOffset + 46, cdOffset + 46 + nameLen));
    cdOffset += 46 + nameLen + extraLen + commentLen;

    if (
      localHeaderOffset + 30 > zip.length ||
      view.getUint32(localHeaderOffset, true) !== 0x04034b50
    ) {
      throw new Error("Invalid ZIP local file header");
    }
    const lfNameLen = view.getUint16(localHeaderOffset + 26, true);
    const lfExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + lfNameLen + lfExtraLen;
    const compData = zip.subarray(dataStart, dataStart + compSize);

    let data;
    if (method === 0) {
      data = compData.slice();
    } else if (method === 8) {
      data = await decompressStreamBytes(compData, "deflate-raw");
    } else {
      throw new Error(`Unsupported ZIP compression method: ${method}`);
    }

    const guestPath = normalizeGuestPath("/" + rawName.replace(/^\.\//, ""));
    if (guestPath === "/") continue;

    const unixMode = (externalAttrs >>> 16) & 0xffff;
    const fileType = unixMode & 0o170000;
    const isDir = fileType === 0o040000 || rawName.endsWith("/");
    if (isDir) {
      const perm = unixMode & 0o7777 ? unixMode & 0o7777 : 0o755;
      dirs.set(guestPath, perm);
      continue;
    }

    if (fileType === 0o120000) {
      const target = textDecoder.decode(data);
      files.delete(guestPath);
      dirs.delete(guestPath);
      symlinks.set(guestPath, target);
    } else {
      const perm = unixMode & 0o7777 ? unixMode & 0o7777 : 0o644;
      symlinks.delete(guestPath);
      dirs.delete(guestPath);
      files.set(guestPath, { bytes: data, mode: perm });
    }
  }

  const vfs = { files, symlinks, dirs };
  if (sys) {
    applyVfsOverlay(sys, vfs);
  }

  return vfs;
}

function pathDepth(p) {
  return normalizeGuestPath(p).split("/").filter(Boolean).length;
}

export function applyVfsOverlay(sys, vfs) {
  if (!vfs) return;
  if (Array.isArray(vfs.whiteouts)) {
    for (const w of vfs.whiteouts) {
      if (w.type === "opaque") {
        if (w.dir && w.dir !== "/") {
          sys.removeVfsPath(w.dir);
          sys.writeVfsDir(w.dir, 0o755);
        }
      } else if (w.type === "remove" && w.path) {
        sys.removeVfsPath(w.path);
      }
    }
  }
  if (vfs.dirs instanceof Map) {
    const sortedDirs = Array.from(vfs.dirs.entries()).sort(
      ([a], [b]) => pathDepth(a) - pathDepth(b)
    );
    for (const [path, mode] of sortedDirs) {
      sys.writeVfsDir(path, mode ?? 0o755);
    }
  }
  if (vfs.symlinks instanceof Map) {
    const sortedSymlinks = Array.from(vfs.symlinks.entries()).sort(
      ([a], [b]) => pathDepth(a) - pathDepth(b)
    );
    for (const [path, target] of sortedSymlinks) {
      sys.writeVfsSymlink(path, target);
    }
  }
  if (vfs.files instanceof Map) {
    for (const [path, entry] of vfs.files.entries()) {
      if (entry instanceof Uint8Array || ArrayBuffer.isView(entry)) {
        sys.writeVfsFile(path, entry, 0o755);
      } else {
        sys.writeVfsFile(path, entry.bytes, entry.mode ?? 0o644);
      }
    }
  }
}

export async function runFromVfs({
  compilerWasm,
  runtimeWasm,
  vfs,
  command,
  args = [],
  env = undefined,
  cwd = undefined,
  vfsRo = [],
  vfsRw = [],
  delayStddevMs = undefined,
  delaySeed = undefined,
  timeoutMs = undefined,
  signal = undefined,
} = {}) {
  const sys = await Elf2WasmSystem.create({
    compilerWasm,
    runtimeWasm,
    vfsRo,
    vfsRw,
  });
  applyVfsOverlay(sys, vfs);
  return await sys.runFromVfs(command, args, {
    env,
    cwd,
    delayStddevMs,
    delaySeed,
    timeoutMs,
    signal,
  });
}

function readGuestRegHex(guestExports, name) {
  if (!guestExports || guestExports[name] == null) return null;
  try {
    const raw =
      typeof guestExports[name] === "object" && "value" in guestExports[name]
        ? guestExports[name].value
        : guestExports[name];
    if (typeof raw === "bigint") {
      return `0x${BigInt.asUintN(64, raw).toString(16)}`;
    }
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return `0x${BigInt.asUintN(64, BigInt(Math.trunc(raw))).toString(16)}`;
    }
  } catch {
    // Ignore errors while reading diagnostic registers
  }
  return null;
}

export function formatWasmTrapError(err, context = {}) {
  const origMsg =
    err && typeof err.message === "string" && err.message.length > 0
      ? err.message
      : String(err);
  const phase = context.phase || "unknown";
  const elfPath = context.elfPath || "unknown";
  const pidPart = context.pid !== undefined && context.pid !== null ? `pid ${context.pid}, ` : "";

  const regs = [];
  if (context.guestExports) {
    for (const reg of ["rip", "rsp", "rax"]) {
      const hex = readGuestRegHex(context.guestExports, reg);
      if (hex !== null) regs.push(`${reg}=${hex}`);
    }
  }
  const regSuffix = regs.length > 0 ? ` at ${regs.join(" ")}` : "";
  const message = `WASM trap (${origMsg}) in ${elfPath} (${pidPart}phase ${phase})${regSuffix}`;

  const wrapped =
    err instanceof WebAssembly.RuntimeError
      ? new WebAssembly.RuntimeError(message)
      : new Error(message);
  wrapped.cause = err;
  if (err && err.code !== undefined) {
    wrapped.code = err.code;
  }
  return wrapped;
}
