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
];
const I32_GLOBAL_IDS = new Set([5, 6, 7, 8]);

const DEFAULT_RO_ALLOWLIST = [
  "/usr/lib/locale/C.utf8",
  "/usr/share/locale/locale.alias",
  "/usr/lib/x86_64-linux-gnu/gconv",
];

const DEFAULT_SO_SEARCH_DIRS = [
  "/lib64",
  "/lib",
  "/lib/x86_64-linux-gnu",
  "/usr/lib/x86_64-linux-gnu",
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

function fnv1a64(bytes) {
  let h = 0xcbf29ce484222325n;
  const prime = 0x0100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < bytes.length; i++) {
    h ^= BigInt(bytes[i]);
    h = (h * prime) & mask;
  }
  return h.toString(16);
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

function basename(p) {
  const idx = p.lastIndexOf("/");
  return idx >= 0 ? p.slice(idx + 1) : p;
}

function readCStringFromBytes(bytes, offset, maxEnd = bytes.length) {
  let end = offset;
  while (end < maxEnd && bytes[end] !== 0) end++;
  return textDecoder.decode(bytes.subarray(offset, end));
}

/**
 * Pure-JS ELF64 parser to extract PT_INTERP and DT_NEEDED library names.
 */
function parseElf64Deps(elfBytes) {
  if (elfBytes.length < 64) return { interp: null, needed: [] };
  if (
    elfBytes[0] !== 0x7f ||
    elfBytes[1] !== 0x45 ||
    elfBytes[2] !== 0x4c ||
    elfBytes[3] !== 0x46 ||
    elfBytes[4] !== 2 // ELFCLASS64
  ) {
    return { interp: null, needed: [] };
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
      const end = Math.min(pOffset + pFilesz, elfBytes.length);
      interp = readCStringFromBytes(elfBytes, pOffset, end);
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
    }
  }

  const needed = [];
  if (strtabVa !== 0 && neededOffsets.length > 0) {
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
    }
  }

  return { interp, needed };
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

  const inPtr = cExp.alloc(bundle.length);
  const outLenPtr = cExp.alloc(4);
  new Uint8Array(cExp.memory.buffer, inPtr, bundle.length).set(bundle);

  const outPtr = cExp.compile_bundle(inPtr, bundle.length, outLenPtr);
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
        const mode = st.isDirectory() ? 0o040755 : 0o100644;
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
        if (!fs.existsSync(m.hostPath)) continue;
        const guestBase = normalizeGuestPath(m.guestPath);
        const walk = (hostP, guestP) => {
          const st = fs.statSync(hostP);
          if (st.isDirectory()) {
            for (const ent of fs.readdirSync(hostP)) {
              walk(path.join(hostP, ent), guestP === "/" ? "/" + ent : guestP + "/" + ent);
            }
          } else if (st.isFile()) {
            writeFileFn(guestP, new Uint8Array(fs.readFileSync(hostP)), st.mode & 0o7777);
          }
        };
        walk(m.hostPath, guestBase);
      }
    },
  };
}

export class Elf2WasmSystem {
  constructor({ compilerInst, runtimeInst, hostVfs }) {
    this.compilerInst = compilerInst;
    this.runtimeInst = runtimeInst;
    this.hostVfs = hostVfs;
    this.moduleCache = new Map();
    this.initialSoMap = new Map();
    this.activeGuest = null;
  }

  static async create({ compilerWasm, runtimeWasm, vfsRo = [], vfsRw = [] } = {}) {
    let compilerInst = null;
    if (compilerWasm) {
      const cMod = await compileWasmModule(compilerWasm);
      compilerInst = await WebAssembly.instantiate(cMod, {});
    }

    const hostVfs = await createNodeHostVfs(vfsRo, vfsRw);
    let runtimeInst = null;
    const sys = new Elf2WasmSystem({ compilerInst, runtimeInst: null, hostVfs });

    if (runtimeWasm) {
      const rMod = await compileWasmModule(runtimeWasm);
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
    const readRtStr = (ptr, len) => {
      const mem = new Uint8Array(sys.runtimeInst.exports.memory.buffer, ptr, len);
      return normalizeGuestPath(textDecoder.decode(mem));
    };

    return {
      host_mem_size() {
        return sys.activeGuest ? sys.activeGuest.exports.memory.buffer.byteLength >>> 0 : 0;
      },
      host_read_guest(guestAddr, rtPtr, len) {
        if (!sys.activeGuest) return -1;
        const gAddr = guestAddr >>> 0;
        const gMem = new Uint8Array(sys.activeGuest.exports.memory.buffer);
        if (gAddr + len > gMem.length) return -1;
        const rMem = new Uint8Array(sys.runtimeInst.exports.memory.buffer);
        rMem.set(gMem.subarray(gAddr, gAddr + len), rtPtr >>> 0);
        return 0;
      },
      host_write_guest(guestAddr, rtPtr, len) {
        if (!sys.activeGuest) return -1;
        const gAddr = guestAddr >>> 0;
        const gMem = new Uint8Array(sys.activeGuest.exports.memory.buffer);
        if (gAddr + len > gMem.length) return -1;
        const rMem = new Uint8Array(sys.runtimeInst.exports.memory.buffer);
        gMem.set(rMem.subarray(rtPtr >>> 0, (rtPtr >>> 0) + len), gAddr);
        return 0;
      },
      host_zero_guest(guestAddr, len) {
        if (!sys.activeGuest) return -1;
        const gAddr = guestAddr >>> 0;
        const gMem = new Uint8Array(sys.activeGuest.exports.memory.buffer);
        if (gAddr + len > gMem.length) return -1;
        gMem.fill(0, gAddr, gAddr + len);
        return 0;
      },
      host_get_global(id) {
        if (!sys.activeGuest) return 0n;
        const name = GLOBAL_NAMES[id];
        const g = name ? sys.activeGuest.exports[name] : null;
        if (!g) return 0n;
        if (I32_GLOBAL_IDS.has(id)) return BigInt(g.value | 0);
        return BigInt.asIntN(64, BigInt(g.value));
      },
      host_set_global(id, val) {
        if (!sys.activeGuest) return;
        const name = GLOBAL_NAMES[id];
        const g = name ? sys.activeGuest.exports[name] : null;
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

  _compileCached(elfBytes, soEntries, elfPath) {
    const key = `${elfPath}:${fnv1a64(elfBytes)}`;
    const cached = this.moduleCache.get(key);
    if (cached) return cached;

    const wasmBytes = this.compile(elfBytes, soEntries, { elfPath });
    const mod = new WebAssembly.Module(wasmBytes);
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
    const pathBytes = textEncoder.encode(guestPath);
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

  readVfsFile(guestPath) {
    if (!this.runtimeInst) throw new Error("Elf2WasmSystem created without runtimeWasm");
    const rExp = this.runtimeInst.exports;
    const pathBytes = textEncoder.encode(guestPath);
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

  _resolveElfSos(elfBytes) {
    const resolved = [];
    const seen = new Set();
    const queue = [];

    const enqueue = (nameOrPath) => {
      if (!nameOrPath || seen.has(nameOrPath)) return;
      seen.add(nameOrPath);
      queue.push(nameOrPath);
    };

    const { interp, needed } = parseElf64Deps(elfBytes);
    if (interp) enqueue(interp);
    for (const n of needed) enqueue(n);

    while (queue.length > 0) {
      const target = queue.shift();
      let foundPath = null;
      let foundBytes = null;

      if (target.startsWith("/")) {
        const b = this.readVfsFile(target);
        if (b) {
          foundPath = target;
          foundBytes = b;
        }
      } else {
        for (const dir of DEFAULT_SO_SEARCH_DIRS) {
          const cand = `${dir}/${target}`;
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

      if (foundBytes) {
        resolved.push({ path: foundPath, name: basename(foundPath), bytes: foundBytes });
        const sub = parseElf64Deps(foundBytes);
        for (const n of sub.needed) enqueue(n);
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

  async runElf(elfBytes, soEntries = [], args = [], options = {}) {
    if (!this.compilerInst || !this.runtimeInst) {
      throw new Error("Elf2WasmSystem requires both compilerWasm and runtimeWasm to run ELFs");
    }

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

    const { mod, metaBytes } = this._compileCached(elfU8, normSos, elfPath);

    const guestImports = {
      env: {
        syscall: (nr, a0, a1, a2, a3, a4, a5) =>
          rExp.runtime_handle_syscall(nr, a0, a1, a2, a3, a4, a5),
      },
    };

    const processes = new Map();
    let activePid = 1000;
    const mainInst = new WebAssembly.Instance(mod, guestImports);
    processes.set(activePid, { instance: mainInst, module: mod });
    this.activeGuest = mainInst;

    const effArgs =
      !args || args.length === 0
        ? [elfPath]
        : args[0] === elfPath
          ? args
          : [elfPath, ...args];
    const effEnv = options.env || ["PATH=/usr/local/bin:/usr/bin:/bin"];
    this._initGuestStack(metaBytes, effArgs, effEnv);

    let lastCode = 0;
    while (true) {
      lastCode = this.activeGuest.exports._start();

      if (rExp.runtime_is_exited() !== 0) {
        break;
      }

      const yieldAction = rExp.runtime_on_yield();
      if (yieldAction === 0) {
        break;
      } else if (yieldAction === 1) {
        continue;
      } else if (yieldAction === 2) {
        activePid = rExp.runtime_get_active_pid();
        const entry = processes.get(activePid);
        if (!entry) throw new Error(`Missing guest instance for pid ${activePid}`);
        this.activeGuest = entry.instance;
        rExp.runtime_resume_active();
      } else if (yieldAction === 3) {
        // NeedFork
        const childPid = rExp.runtime_get_pending_child_pid();
        const scratchAddr = rExp.runtime_get_pending_scratch_addr() >>> 0;
        const parentEntry = processes.get(activePid);
        const childInst = new WebAssembly.Instance(parentEntry.module, guestImports);

        const parentMem = parentEntry.instance.exports.memory;
        const childMem = childInst.exports.memory;
        if (childMem.buffer.byteLength < parentMem.buffer.byteLength) {
          const pagesNeeded =
            (parentMem.buffer.byteLength - childMem.buffer.byteLength + 65535) >>> 16;
          childMem.grow(pagesNeeded);
        }
        new Uint8Array(childMem.buffer).set(new Uint8Array(parentMem.buffer));

        for (const [name, exp] of Object.entries(parentEntry.instance.exports)) {
          if (exp instanceof WebAssembly.Global && childInst.exports[name]) {
            childInst.exports[name].value = exp.value;
          }
        }
        if (typeof childInst.exports.load_ctx === "function") {
          childInst.exports.load_ctx(scratchAddr);
        }

        processes.set(childPid, { instance: childInst, module: parentEntry.module });
        rExp.runtime_ack_fork(childPid);
        activePid = rExp.runtime_get_active_pid();
        this.activeGuest = processes.get(activePid).instance;
        rExp.runtime_resume_active();
      } else if (yieldAction === 4) {
        // NeedExec
        const outLenPtr = rExp.alloc(4);
        const infoPtr = rExp.runtime_get_exec_info(outLenPtr);
        const infoLen = new DataView(rExp.memory.buffer).getUint32(outLenPtr, true);
        rExp.dealloc(outLenPtr, 4);
        if (infoPtr === 0 || infoLen === 0) {
          throw new Error("runtime_get_exec_info returned empty buffer");
        }
        const infoBytes = new Uint8Array(rExp.memory.buffer, infoPtr, infoLen).slice();
        rExp.dealloc(infoPtr, infoLen);

        const execInfo = decodeE2weExecInfo(infoBytes);
        const execElf = this.readVfsFile(execInfo.path);
        if (!execElf) {
          throw new Error(`execve target not found in VFS: ${execInfo.path}`);
        }
        const execSos = this._resolveElfSos(execElf);
        const compiled = this._compileCached(execElf, execSos, execInfo.path);
        const newInst = new WebAssembly.Instance(compiled.mod, guestImports);

        processes.set(execInfo.pid, { instance: newInst, module: compiled.mod });
        activePid = execInfo.pid;
        this.activeGuest = newInst;
        this._completeExec(
          execInfo.pid,
          compiled.metaBytes,
          execInfo.argv.length > 0 ? execInfo.argv : [execInfo.path],
          execInfo.envp
        );
      } else {
        throw new Error(`Unexpected runtime_on_yield return code: ${yieldAction}`);
      }
    }

    this.activeGuest = processes.get(1000).instance;
    const exitFlag = this.activeGuest.exports.exit_flag
      ? this.activeGuest.exports.exit_flag.value | 0
      : 0;
    const exitCode =
      exitFlag !== 0 || rExp.runtime_is_exited() !== 0
        ? rExp.runtime_get_exit_code()
        : lastCode;

    const stdout = this._readRtBytes((p) => rExp.runtime_get_stdout(p));
    const stderr = this._readRtBytes((p) => rExp.runtime_get_stderr(p));

    return {
      exitCode,
      stdout,
      stderr,
      virtualTimeNs: Number(rExp.runtime_get_virtual_time_ns()),
    };
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
} = {}) {
  const sys = await Elf2WasmSystem.create({
    compilerWasm,
    runtimeWasm,
    vfsRo,
    vfsRw,
  });
  return await sys.runElf(elfBytes, soEntries, args, { elfPath, env });
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
