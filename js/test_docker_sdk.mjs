import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createServer } from "../server/server.mjs";
import { createMockRegistry, createTarGzLayer, sha256Digest } from "../server/mock_registry.mjs";
import { createMockGitServer, createGitArchiveTarGz } from "../server/mock_git_server.mjs";
import {
  compileElfToWasm,
  compileBundle,
  Elf2WasmSystem,
  VirtualSystem,
  runElf,
  compileAndRunInVfs,
  extractTarToVfs,
  extractTarGzToVfs,
  extractZipToVfs,
  runFromVfs,
  parseElf64Deps,
  formatWasmTrapError,
} from "./elf2wasm_shim.mjs";
import {
  OCI_MEDIA_TYPES,
  parseImageRef,
  decompressLayer,
  pullImage,
  loadOciTarball,
} from "./oci_client.mjs";
import {
  ContainerEngine,
  Elf2WasmDocker,
  DockerImage,
  DockerContainer,
  runDockerImage,
  fetchGitArchive,
  getGoDefaultEnv,
  isGoContainer,
  mergeEnv,
} from "./docker_sdk.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const WASM_DIR = path.join(REPO_ROOT, "target", "wasm32-unknown-unknown", "release");
const COMPILER_WASM_PATH = path.join(WASM_DIR, "elf2wasm_compiler_wasm.wasm");
const RUNTIME_WASM_PATH = path.join(WASM_DIR, "elf2wasm_runtime_wasm.wasm");

const textDecoder = new TextDecoder("utf-8");

function buildStaticTestElf(cSource) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "elf2wasm-m3-test-"));
  const srcPath = path.join(tmpDir, "prog.c");
  const outPath = path.join(tmpDir, "prog");
  fs.writeFileSync(srcPath, cSource, "utf8");
  try {
    execFileSync(
      "gcc",
      ["-nostdlib", "-static", "-O1", "-fno-stack-protector", "-s", srcPath, "-o", outPath],
      { stdio: "pipe" }
    );
    return new Uint8Array(fs.readFileSync(outPath));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function buildCustomTar(entries) {
  const blocks = [];
  for (const ent of entries) {
    const header = Buffer.alloc(512, 0);
    const nameBytes = Buffer.from(ent.path, "utf8");
    nameBytes.copy(header, 0, 0, Math.min(100, nameBytes.length));
    const mode = ent.mode ?? (ent.type === "5" ? 0o755 : 0o644);
    header.write(mode.toString(8).padStart(7, "0") + "\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    const content =
      ent.type === "0" || !ent.type
        ? Buffer.isBuffer(ent.content)
          ? ent.content
          : Buffer.from(ent.content || "")
        : Buffer.alloc(0);
    header.write(content.length.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(0x20, 148, 156);
    header.write(ent.type || "0", 156, 1, "ascii");
    if (ent.linkname) {
      const linkBytes = Buffer.from(ent.linkname, "utf8");
      linkBytes.copy(header, 157, 0, Math.min(100, linkBytes.length));
    }
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i];
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    blocks.push(header);
    if (content.length > 0) {
      blocks.push(content);
      const rem = content.length % 512;
      if (rem !== 0) blocks.push(Buffer.alloc(512 - rem, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return new Uint8Array(Buffer.concat(blocks));
}

function waitForOutput(container, predicate, timeoutMs = 15000) {
  let acc = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for output. Got: ${JSON.stringify(acc)}`));
    }, timeoutMs);
    const unsub = container.onStdout((chunk) => {
      acc += textDecoder.decode(chunk);
      if (predicate(acc)) {
        clearTimeout(timer);
        unsub();
        resolve(acc);
      }
    });
  });
}

// ============================================================================
// 1. parseImageRef unit tests
// ============================================================================
test("parseImageRef: valid Docker Hub, custom registries, ports, IPv6, and digests", () => {
  const validDigest = "sha256:" + "a".repeat(64);

  assert.deepEqual(parseImageRef("alpine"), {
    registry: "registry-1.docker.io",
    repository: "library/alpine",
    reference: "latest",
    canonical: "registry-1.docker.io/library/alpine:latest",
  });

  assert.deepEqual(parseImageRef("alpine:3.20"), {
    registry: "registry-1.docker.io",
    repository: "library/alpine",
    reference: "3.20",
    canonical: "registry-1.docker.io/library/alpine:3.20",
  });

  assert.deepEqual(parseImageRef("docker.io/alpine"), {
    registry: "registry-1.docker.io",
    repository: "library/alpine",
    reference: "latest",
    canonical: "registry-1.docker.io/library/alpine:latest",
  });

  assert.deepEqual(parseImageRef("index.docker.io/library/alpine:3.19"), {
    registry: "registry-1.docker.io",
    repository: "library/alpine",
    reference: "3.19",
    canonical: "registry-1.docker.io/library/alpine:3.19",
  });

  assert.deepEqual(parseImageRef("myuser/myapp:v1.2"), {
    registry: "registry-1.docker.io",
    repository: "myuser/myapp",
    reference: "v1.2",
    canonical: "registry-1.docker.io/myuser/myapp:v1.2",
  });

  assert.deepEqual(parseImageRef("ghcr.io/org/app:v2"), {
    registry: "ghcr.io",
    repository: "org/app",
    reference: "v2",
    canonical: "ghcr.io/org/app:v2",
  });

  assert.deepEqual(parseImageRef("127.0.0.1:5000/repo:tag"), {
    registry: "127.0.0.1:5000",
    repository: "repo",
    reference: "tag",
    canonical: "127.0.0.1:5000/repo:tag",
  });

  assert.deepEqual(parseImageRef("localhost:5000/ns/repo"), {
    registry: "localhost:5000",
    repository: "ns/repo",
    reference: "latest",
    canonical: "localhost:5000/ns/repo:latest",
  });

  assert.deepEqual(parseImageRef("[::1]:5000/repo:v1"), {
    registry: "[::1]:5000",
    repository: "repo",
    reference: "v1",
    canonical: "[::1]:5000/repo:v1",
  });

  assert.deepEqual(parseImageRef(`alpine@${validDigest}`), {
    registry: "registry-1.docker.io",
    repository: "library/alpine",
    reference: validDigest,
    canonical: `registry-1.docker.io/library/alpine@${validDigest}`,
  });

  assert.deepEqual(parseImageRef(`alpine:3.20@${validDigest}`), {
    registry: "registry-1.docker.io",
    repository: "library/alpine",
    reference: validDigest,
    canonical: `registry-1.docker.io/library/alpine@${validDigest}`,
  });
});

test("parseImageRef: rejects malformed references cleanly", () => {
  const badRefs = [
    "",
    "   ",
    null,
    123,
    "alpine:",
    "alpine@sha256:deadbeef",
    "UPPER/repo",
    "http://alpine",
    "https://registry-1.docker.io/library/alpine",
    "localhost:99999/repo",
    "a/../b",
    "alpine\nlatest",
    "alpine latest",
  ];
  for (const bad of badRefs) {
    assert.throws(() => parseImageRef(bad), `Expected parseImageRef(${JSON.stringify(bad)}) to throw`);
  }
});

// ============================================================================
// 2. decompressLayer & OCI multi-layer whiteouts / empty dirs / links
// ============================================================================
test("decompressLayer: supports gzip, uncompressed tar, and rejects zstd/xz/bzip2", async () => {
  const raw = new TextEncoder().encode("hello uncompressed tar payload");
  const gz = new Uint8Array(zlib.gzipSync(raw));

  const outGz = await decompressLayer(gz, OCI_MEDIA_TYPES.OCI_LAYER_GZIP);
  assert.deepEqual(outGz, raw);

  const outRaw = await decompressLayer(raw, OCI_MEDIA_TYPES.OCI_LAYER_TAR);
  assert.deepEqual(outRaw, raw);

  const zstdMagic = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01]);
  await assert.rejects(
    () => decompressLayer(zstdMagic, OCI_MEDIA_TYPES.OCI_LAYER_ZSTD),
    /zstd/i
  );

  const xzMagic = new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);
  await assert.rejects(() => decompressLayer(xzMagic), /xz/i);

  const corruptGzip = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xff, 0xde, 0xad, 0xbe, 0xef]);
  await assert.rejects(
    () => decompressLayer(corruptGzip, OCI_MEDIA_TYPES.OCI_LAYER_GZIP),
    (err) =>
      err instanceof Error &&
      typeof err.message === "string" &&
      err.message.trim().length > 0 &&
      /Failed to decompress gzip layer/i.test(err.message)
  );
});

test("OCI tar layer extraction: empty dirs, whiteouts (.wh.<name>, .wh..wh..opq), symlinks & hardlinks", async () => {
  const runtimeWasm = fs.readFileSync(RUNTIME_WASM_PATH);
  const sys = await Elf2WasmSystem.create({ runtimeWasm });

  // Layer 1: files, empty dir, symlink, and directories to be made opaque/whited out
  const layer1 = buildCustomTar([
    { path: "empty_dir", type: "5", mode: 0o755 },
    { path: "etc/keep.txt", type: "0", content: "keep-me", mode: 0o644 },
    { path: "etc/delete.txt", type: "0", content: "delete-me", mode: 0o644 },
    { path: "etc/link_keep", type: "2", linkname: "keep.txt" },
    { path: "var/cache/old1.txt", type: "0", content: "old1" },
    { path: "var/cache/old2.txt", type: "0", content: "old2" },
    { path: "opq2/old.txt", type: "0", content: "old-in-opq2" },
    { path: "same_wh/recreated.txt", type: "0", content: "old-version" },
    { path: "usr/bin/orig", type: "0", content: "binary-data", mode: 0o755 },
  ]);

  // Layer 2: .wh.delete.txt, .wh..wh..opq in var/cache + new file,
  // same-layer files appearing BEFORE .wh..wh..opq and .wh.<name> (OCI spec),
  // and cross-layer hardlink
  const layer2 = buildCustomTar([
    { path: "etc/.wh.delete.txt", type: "0", content: "" },
    { path: "var/cache/.wh..wh..opq", type: "0", content: "" },
    { path: "var/cache/fresh.txt", type: "0", content: "fresh-data" },
    { path: "opq2/new_before_opq.txt", type: "0", content: "must-survive" },
    { path: "opq2/.wh..wh..opq", type: "0", content: "" },
    { path: "same_wh/recreated.txt", type: "0", content: "new-version" },
    { path: "same_wh/.wh.recreated.txt", type: "0", content: "" },
    { path: "usr/bin/hardlinked", type: "1", linkname: "usr/bin/orig", mode: 0o755 },
  ]);

  const res1 = extractTarToVfs(sys, layer1);
  assert.ok(res1.dirs.has("/empty_dir"), "empty_dir should be recorded in dirs map");

  extractTarToVfs(sys, layer2);

  assert.equal(textDecoder.decode(sys.readVfsFile("/etc/keep.txt")), "keep-me");
  assert.equal(textDecoder.decode(sys.readVfsFile("/etc/link_keep")), "keep-me");
  assert.equal(sys.readVfsFile("/etc/delete.txt"), null, ".wh.delete.txt must remove /etc/delete.txt");
  assert.equal(sys.readVfsFile("/var/cache/old1.txt"), null, ".wh..wh..opq must remove old1.txt");
  assert.equal(sys.readVfsFile("/var/cache/old2.txt"), null, ".wh..wh..opq must remove old2.txt");
  assert.equal(textDecoder.decode(sys.readVfsFile("/var/cache/fresh.txt")), "fresh-data");
  assert.equal(sys.readVfsFile("/opq2/old.txt"), null, ".wh..wh..opq must remove lower-layer /opq2/old.txt");
  assert.equal(
    textDecoder.decode(sys.readVfsFile("/opq2/new_before_opq.txt")),
    "must-survive",
    "same-layer file appearing before .wh..wh..opq must survive per OCI spec"
  );
  assert.equal(
    textDecoder.decode(sys.readVfsFile("/same_wh/recreated.txt")),
    "new-version",
    "same-layer file appearing before .wh.<name> must survive per OCI spec"
  );
  assert.equal(textDecoder.decode(sys.readVfsFile("/usr/bin/hardlinked")), "binary-data");
});

// ============================================================================
// 3. Backward compatibility smoke test of js/elf2wasm_shim.mjs
// ============================================================================
test("js/elf2wasm_shim.mjs backward compatibility exports & runElf", async () => {
  assert.equal(typeof compileElfToWasm, "function");
  assert.equal(typeof compileBundle, "function");
  assert.equal(typeof Elf2WasmSystem, "function");
  assert.equal(VirtualSystem, Elf2WasmSystem);
  assert.equal(typeof runElf, "function");
  assert.equal(typeof compileAndRunInVfs, "function");
  assert.equal(typeof extractTarToVfs, "function");
  assert.equal(typeof extractTarGzToVfs, "function");
  assert.equal(typeof extractZipToVfs, "function");
  assert.equal(typeof runFromVfs, "function");
  assert.equal(typeof parseElf64Deps, "function");

  const helloElf = buildStaticTestElf(`
    static long sys3(long n, long a, long b, long c) {
      long r;
      __asm__ volatile("syscall" : "=a"(r) : "a"(n), "D"(a), "S"(b), "d"(c) : "rcx", "r11", "memory");
      return r;
    }
    static long slen(const char *s) { long n = 0; while (s && s[n]) n++; return n; }
    static void w_str(const char *s) { sys3(1, 1, (long)s, slen(s)); }
    static void w_num(long v) {
      char buf[32]; int i = 0;
      if (v == 0) { w_str("0"); return; }
      while (v > 0) { buf[i++] = '0' + (v % 10); v /= 10; }
      while (i > 0) { sys3(1, 1, (long)&buf[--i], 1); }
    }
    void entry_c(long *sp) {
      long argc = sp[0];
      char **argv = (char **)(sp + 1);
      w_str("HELLO_COMPAT:");
      w_num(argc);
      w_str(":");
      w_str(argc > 1 ? argv[1] : "none");
      w_str("\\n");
      sys3(231, 0, 0, 0);
    }
    __asm__(".global _start\\n_start:\\n mov %rsp, %rdi\\n and $-16, %rsp\\n call entry_c\\n");
  `);

  const res = await runElf({
    compilerWasm: fs.readFileSync(COMPILER_WASM_PATH),
    runtimeWasm: fs.readFileSync(RUNTIME_WASM_PATH),
    elfBytes: helloElf,
    elfPath: "/bin/hello",
    args: ["/bin/hello", "world"],
  });

  assert.equal(res.exitCode, 0);
  assert.ok(res.stdout instanceof Uint8Array);
  assert.ok(res.stderr instanceof Uint8Array);
  assert.equal(typeof res.virtualTimeNs, "number");
  assert.equal(textDecoder.decode(res.stdout).trim(), "HELLO_COMPAT:2:world");
});

// ============================================================================
// 4. OCI Client & Docker SDK against server/server.mjs + server/mock_registry.mjs
// ============================================================================
test("OCI client + Docker SDK against local mock registry & server proxy", async (t) => {
  const probeElf = buildStaticTestElf(`
    static long sys4(long n, long a, long b, long c, long d) {
      long r;
      register long r10 __asm__("r10") = d;
      __asm__ volatile("syscall" : "=a"(r) : "a"(n), "D"(a), "S"(b), "d"(c), "r"(r10) : "rcx", "r11", "memory");
      return r;
    }
    static long slen(const char *s) { long n = 0; while (s && s[n]) n++; return n; }
    static void w_str(const char *s) { sys4(1, 1, (long)s, slen(s), 0); }
    static void w_num(long v) {
      char buf[32]; int i = 0;
      if (v == 0) { w_str("0"); return; }
      while (v > 0) { buf[i++] = '0' + (v % 10); v /= 10; }
      while (i > 0) { sys4(1, 1, (long)&buf[--i], 1, 0); }
    }
    static int starts_with(const char *s, const char *p) {
      while (*p) { if (*s++ != *p++) return 0; }
      return 1;
    }
    void entry_c(long *sp) {
      long argc = sp[0];
      char **argv = (char **)(sp + 1);
      char **envp = argv + argc + 1;
      const char *greeting = "";
      for (int i = 0; envp[i]; i++) {
        if (starts_with(envp[i], "GREETING=")) {
          greeting = envp[i] + 9;
          break;
        }
      }
      long uid = sys4(102, 0, 0, 0, 0);
      long gid = sys4(104, 0, 0, 0, 0);
      char cwd[256];
      cwd[0] = 0;
      sys4(79, (long)cwd, sizeof(cwd), 0, 0);
      w_str("UID="); w_num(uid);
      w_str(" GID="); w_num(gid);
      w_str(" CWD="); w_str(cwd);
      w_str(" GREETING="); w_str(greeting);
      w_str(" ARGV1="); w_str(argc > 1 ? argv[1] : "");
      w_str("\\n");
      long fd = sys4(257, -100, (long)"/etc/removed.txt", 0, 0);
      w_str("REMOVED_EXISTS=");
      if (fd >= 0) {
        w_str("1\\n");
        sys4(3, fd, 0, 0, 0);
      } else {
        w_str("0\\n");
      }
      sys4(231, 0, 0, 0, 0);
    }
    __asm__(".global _start\\n_start:\\n mov %rsp, %rdi\\n and $-16, %rsp\\n call entry_c\\n");
  `);

  const reg = createMockRegistry({ requireAuth: true });
  reg.addImage("library/probe-oci", "latest", {
    mediaTypeMode: "oci",
    multiArch: true,
    config: {
      entrypoint: ["/bin/probe"],
      cmd: ["from-image"],
      env: ["PATH=/bin:/usr/bin", "GREETING=hello-oci"],
      workingDir: "/app",
    },
    layers: [
      {
        files: [
          { path: "bin", type: "dir", mode: 0o755 },
          { path: "bin/probe", type: "file", content: probeElf, mode: 0o755 },
          { path: "app", type: "dir", mode: 0o755 },
          { path: "etc/removed.txt", type: "file", content: "old" },
        ],
      },
      {
        files: [
          { path: "etc/.wh.removed.txt", type: "file", content: "" },
        ],
      },
    ],
  });

  reg.addImage("library/probe-docker", "v1", {
    mediaTypeMode: "docker",
    multiArch: true,
    config: {
      cmd: ["/bin/probe", "docker-v2"],
      env: ["GREETING=hello-docker"],
      workingDir: "/work",
    },
    layers: [
      {
        files: [
          { path: "bin/probe", type: "file", content: probeElf, mode: 0o755 },
        ],
      },
    ],
  });

  reg.addImage("library/probe-single", "v1", {
    mediaTypeMode: "oci",
    multiArch: false,
    config: {
      cmd: ["/bin/probe", "single-arch"],
      env: ["GREETING=single"],
      workingDir: "/",
    },
    layers: [
      {
        files: [
          { path: "bin/probe", type: "file", content: probeElf, mode: 0o755 },
        ],
      },
    ],
  });

  await reg.start();
  const srv = createServer({ port: 0, host: "127.0.0.1", allowLocalRegistries: true });
  await srv.start();

  const docker = await Elf2WasmDocker.create({
    compilerWasmUrl: `${srv.url}/wasm/elf2wasm_compiler_wasm.wasm`,
    runtimeWasmUrl: `${srv.url}/wasm/elf2wasm_runtime_wasm.wasm`,
    registryProxyBase: `${srv.url}/api/v2`,
    useWorker: false,
  });

  t.after(async () => {
    await docker.dispose();
    await srv.stop();
    await reg.stop();
  });

  await t.test("pullImage multi-arch OCI index, progress callbacks, whiteout & execution", async () => {
    const stages = new Set();
    let sawDownloadBytes = false;
    const image = await docker.pullImage(`${reg.host}/library/probe-oci:latest`, {
      onProgress: (ev) => {
        stages.add(ev.stage);
        if (ev.stage === "download" && ev.loaded > 0) sawDownloadBytes = true;
      },
    });

    assert.ok(image instanceof DockerImage);
    assert.equal(image.config.workingDir, "/app");
    assert.deepEqual(image.config.entrypoint, ["/bin/probe"]);
    assert.deepEqual(image.config.cmd, ["from-image"]);
    assert.equal(image.layers.length, 2);
    assert.ok(stages.has("manifest"));
    assert.ok(stages.has("config"));
    assert.ok(stages.has("download"));
    assert.ok(stages.has("decompress"));
    assert.ok(stages.has("ready"));
    assert.ok(sawDownloadBytes);

    const container = await image.createContainer();
    assert.ok(container instanceof DockerContainer);
    await container.writeFile("/app/extra.txt", "injected");
    const extra = await container.readFile("/app/extra.txt");
    assert.equal(textDecoder.decode(extra), "injected");
    assert.equal(await container.readFile("/etc/removed.txt"), null);

    await container.start();
    const res = await container.wait();
    assert.equal(res.exitCode, 0);
    assert.match(res.stdout, /UID=0 GID=0 CWD=\/app GREETING=hello-oci ARGV1=from-image/);
    assert.match(res.stdout, /REMOVED_EXISTS=0/);

    // Second container reuses moduleCache
    const c2 = await image.createContainer({ cmd: ["override-arg"] });
    await c2.start();
    const res2 = await c2.wait();
    assert.equal(res2.exitCode, 0);
    assert.match(res2.stdout, /ARGV1=override-arg/);
    assert.ok(c2._getStats().moduleCacheSize >= 1);
  });

  await t.test("pullImage Docker Manifest List v2 & single-arch manifest via runDockerImage", async () => {
    const resDocker = await runDockerImage(`${reg.host}/library/probe-docker:v1`, {
      docker,
    });
    assert.equal(resDocker.exitCode, 0);
    assert.match(resDocker.stdout, /CWD=\/work GREETING=hello-docker ARGV1=docker-v2/);

    const resSingle = await runDockerImage(`${reg.host}/library/probe-single:v1`, {
      docker,
    });
    assert.equal(resSingle.exitCode, 0);
    assert.match(resSingle.stdout, /CWD=\/ GREETING=single ARGV1=single-arch/);
  });

  await t.test("unsupported platform & AbortSignal cancellation", async () => {
    await assert.rejects(
      () =>
        pullImage(`${reg.host}/library/probe-oci:latest`, {
          registryProxyBase: `${srv.url}/api/v2`,
          platform: "linux/s390x",
        }),
      /No manifest found for platform linux\/s390x/
    );

    const ctrl = new AbortController();
    ctrl.abort();
    await assert.rejects(
      () =>
        docker.pullImage(`${reg.host}/library/probe-oci:latest`, {
          signal: ctrl.signal,
        }),
      (err) => err.name === "AbortError"
    );
  });

  await t.test("loadOciTarball: OCI layout tarball and plain rootfs tarball", async () => {
    // 1. Plain rootfs .tar.gz
    const rootfsLayer = createTarGzLayer([
      { path: "bin/probe", type: "file", content: probeElf, mode: 0o755 },
    ]);
    const rootfsImg = await docker.loadOciTarball(rootfsLayer.gzipBytes);
    const c1 = await rootfsImg.createContainer({
      cmd: ["/bin/probe", "from-rootfs"],
      env: ["GREETING=rootfs-ok"],
    });
    await c1.start();
    const r1 = await c1.wait();
    assert.equal(r1.exitCode, 0);
    assert.match(r1.stdout, /GREETING=rootfs-ok ARGV1=from-rootfs/);

    // 2. Full OCI Image Layout .tar.gz (oci-layout + index.json + blobs/sha256/...)
    const cfgObj = {
      architecture: "amd64",
      os: "linux",
      config: {
        Entrypoint: ["/bin/probe"],
        Cmd: ["from-oci-layout"],
        Env: ["GREETING=oci-layout-ok"],
        WorkingDir: "/ociwork",
      },
      rootfs: { type: "layers", diff_ids: [rootfsLayer.diffId] },
    };
    const cfgBuf = Buffer.from(JSON.stringify(cfgObj));
    const cfgDigest = sha256Digest(cfgBuf);

    const manifestObj = {
      schemaVersion: 2,
      mediaType: OCI_MEDIA_TYPES.OCI_MANIFEST,
      config: {
        mediaType: OCI_MEDIA_TYPES.OCI_CONFIG,
        digest: cfgDigest,
        size: cfgBuf.length,
      },
      layers: [
        {
          mediaType: OCI_MEDIA_TYPES.OCI_LAYER_GZIP,
          digest: rootfsLayer.digest,
          size: rootfsLayer.gzipBytes.length,
        },
      ],
    };
    const manifestBuf = Buffer.from(JSON.stringify(manifestObj));
    const manifestDigest = sha256Digest(manifestBuf);

    const indexObj = {
      schemaVersion: 2,
      mediaType: OCI_MEDIA_TYPES.OCI_INDEX,
      manifests: [
        {
          mediaType: OCI_MEDIA_TYPES.OCI_MANIFEST,
          digest: manifestDigest,
          size: manifestBuf.length,
          platform: { os: "linux", architecture: "amd64" },
        },
      ],
    };
    const indexBuf = Buffer.from(JSON.stringify(indexObj));

    const ociTar = buildCustomTar([
      { path: "oci-layout", type: "0", content: JSON.stringify({ imageLayoutVersion: "1.0.0" }) },
      { path: "index.json", type: "0", content: indexBuf },
      { path: `blobs/sha256/${manifestDigest.slice(7)}`, type: "0", content: manifestBuf },
      { path: `blobs/sha256/${cfgDigest.slice(7)}`, type: "0", content: cfgBuf },
      { path: `blobs/sha256/${rootfsLayer.digest.slice(7)}`, type: "0", content: rootfsLayer.gzipBytes },
    ]);
    const ociTarGz = new Uint8Array(zlib.gzipSync(ociTar));

    const ociImg = await docker.loadOciTarball(ociTarGz);
    const c2 = await ociImg.createContainer();
    await c2.start();
    const r2 = await c2.wait();
    assert.equal(r2.exitCode, 0);
    assert.match(r2.stdout, /CWD=\/ociwork GREETING=oci-layout-ok ARGV1=from-oci-layout/);
  });

  await t.test("unstarted container stop() settles wait() cleanly", async () => {
    const image = await docker.pullImage(`${reg.host}/library/probe-single:v1`);
    const c = await image.createContainer();
    const waitPromise = c.wait();
    await c.stop();
    const res = await waitPromise;
    assert.equal(res.exitCode, 137);
  });

  await t.test("WorkerBackend + container_worker.mjs delivers extract, compile, run progress and handles crash/unstarted stop", async () => {
    const origWorker = globalThis.Worker;
    const origSelf = globalThis.self;
    let activeMockWorker = null;

    class InProcessWorker {
      constructor(url) {
        this._listeners = new Map();
        this._terminated = false;
        this._workerListeners = [];
        activeMockWorker = this;

        const selfShim = {
          addEventListener: (type, fn) => {
            if (type === "message") this._workerListeners.push(fn);
          },
          postMessage: (data) => {
            if (this._terminated) return;
            queueMicrotask(() => {
              if (this._terminated) return;
              for (const fn of this._listeners.get("message") || []) {
                fn({ data });
              }
            });
          },
        };
        globalThis.self = selfShim;
        this._ready = import(`${url.href}?inproc=${Date.now()}_${Math.random()}`);
      }

      addEventListener(type, fn) {
        if (!this._listeners.has(type)) this._listeners.set(type, new Set());
        this._listeners.get(type).add(fn);
      }

      postMessage(data) {
        if (this._terminated) return;
        this._ready.then(() => {
          if (this._terminated) return;
          for (const fn of this._workerListeners) {
            fn({ data });
          }
        });
      }

      emitError(message) {
        for (const fn of this._listeners.get("error") || []) {
          fn({ message });
        }
      }

      terminate() {
        this._terminated = true;
      }
    }

    globalThis.Worker = InProcessWorker;
    let workerDocker = null;
    try {
      workerDocker = await Elf2WasmDocker.create({
        compilerWasmUrl: `${srv.url}/wasm/elf2wasm_compiler_wasm.wasm`,
        runtimeWasmUrl: `${srv.url}/wasm/elf2wasm_runtime_wasm.wasm`,
        registryProxyBase: `${srv.url}/api/v2`,
        useWorker: true,
      });

      const rootfsLayer = createTarGzLayer([
        { path: "bin/probe", type: "file", content: probeElf, mode: 0o755 },
      ]);
      const img = await workerDocker.loadOciTarball(rootfsLayer.gzipBytes);

      const stages = [];
      const container = await img.createContainer({
        cmd: ["/bin/probe", "worker-progress"],
        env: ["GREETING=worker-ok"],
        onProgress: (ev) => stages.push(ev.stage),
      });
      await container.start();
      const res = await container.wait();
      assert.equal(res.exitCode, 0);
      assert.match(res.stdout, /GREETING=worker-ok ARGV1=worker-progress/);
      assert.ok(stages.includes("extract"), `expected extract stage, got ${JSON.stringify(stages)}`);
      assert.ok(stages.includes("compile"), `expected compile stage, got ${JSON.stringify(stages)}`);
      assert.ok(stages.includes("run"), `expected run stage, got ${JSON.stringify(stages)}`);

      // Unstarted stop() in WorkerBackend settles wait()
      const unstarted = await img.createContainer({ cmd: ["/bin/probe", "never-started"] });
      const unstartedWait = unstarted.wait();
      await unstarted.stop();
      const unstartedRes = await unstartedWait;
      assert.equal(unstartedRes.exitCode, 137);

      // Worker crash settles active container.wait() with exitCode 1
      const crashed = await img.createContainer({ cmd: ["/bin/probe", "crash-test"] });
      const crashedWait = crashed.wait();
      let crashNotified = false;
      workerDocker.onCrash(() => {
        crashNotified = true;
      });
      assert.equal(workerDocker.isAlive, true);
      activeMockWorker.emitError("Simulated worker crash");
      const crashedRes = await crashedWait;
      assert.equal(crashedRes.exitCode, 1);
      assert.equal(workerDocker.isAlive, false);
      assert.equal(crashNotified, true);

      // Post-crash RPC must reject promptly instead of hanging forever
      await assert.rejects(
        () =>
          Promise.race([
            workerDocker.pullImage(`${reg.host}/library/probe-oci:latest`),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("HUNG_AFTER_CRASH")), 500)
            ),
          ]),
        /Simulated worker crash/
      );
    } finally {
      if (workerDocker) {
        try {
          await workerDocker.dispose();
        } catch {
          // worker already terminated/crashed
        }
      }
      if (origWorker === undefined) delete globalThis.Worker;
      else globalThis.Worker = origWorker;
      if (origSelf === undefined) delete globalThis.self;
      else globalThis.self = origSelf;
    }
  });

  await t.test("Bounded LRU image cache eviction, image.dispose(), and runDockerImage cleanup on reused docker", async () => {
    const boundedDocker = await Elf2WasmDocker.create({
      compilerWasmUrl: `${srv.url}/wasm/elf2wasm_compiler_wasm.wasm`,
      runtimeWasmUrl: `${srv.url}/wasm/elf2wasm_runtime_wasm.wasm`,
      registryProxyBase: `${srv.url}/api/v2`,
      useWorker: false,
      maxCachedImages: 3,
    });
    try {
      const engine = boundedDocker._backend.engine;
      const imgs = [];
      for (let i = 0; i < 5; i++) {
        imgs.push(await boundedDocker.pullImage(`${reg.host}/library/probe-single:v1`));
      }
      assert.equal(engine.images.size, 3, "LRU cache must stay bounded at maxCachedImages=3");
      // Oldest images (0, 1) were evicted; newest (2, 3, 4) remain
      await assert.rejects(() => imgs[0].createContainer(), /Unknown imageId/);

      // Explicit image.dispose() removes the image from cache
      await imgs[4].dispose();
      assert.equal(engine.images.size, 2);
      await assert.rejects(() => imgs[4].createContainer(), /Unknown imageId/);
      // Idempotent release() alias
      await imgs[4].release();
      assert.equal(engine.images.size, 2);

      // runDockerImage with reused docker cleans up both container and image in finally
      const beforeImages = engine.images.size;
      const beforeContainers = engine.containers.size;
      const runRes = await runDockerImage(`${reg.host}/library/probe-single:v1`, {
        docker: boundedDocker,
      });
      assert.equal(runRes.exitCode, 0);
      assert.equal(
        engine.images.size,
        beforeImages,
        "runDockerImage must dispose temporary image on reused docker"
      );
      assert.equal(
        engine.containers.size,
        beforeContainers,
        "runDockerImage must stop/delete temporary container on reused docker"
      );
    } finally {
      await boundedDocker.dispose();
    }
  });
});

// ============================================================================
// 4b. M7 Unit & Integration Tests (F19 NeedStdin Race, F20 Python lib-dynload,
//     F21 Node.js Default --jitless Env Injection)
// ============================================================================
test("F19: NeedStdin lost-wakeup race fix (_inputSignaled) prevents hang on synchronous/early stdin", async () => {
  const compilerWasm = fs.readFileSync(COMPILER_WASM_PATH);
  const runtimeWasm = fs.readFileSync(RUNTIME_WASM_PATH);
  const sys = await Elf2WasmSystem.create({ compilerWasm, runtimeWasm });

  // 1. Direct _waitForInput() after pushStdin() must resolve immediately (no lost wakeup)
  sys.pushStdin("early\n");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const first = await Promise.race([
    sys._waitForInput().then(() => "woke"),
    sleep(500).then(() => "hung"),
  ]);
  assert.equal(first, "woke", "_waitForInput must consume pending _inputSignaled immediately");

  // 2. Subsequent _waitForInput() without new signal must park until signaled
  let secondWoke = false;
  const secondPromise = sys._waitForInput().then(() => {
    secondWoke = true;
    return "woke";
  });
  await sleep(30);
  assert.equal(secondWoke, false, "Second _waitForInput must remain parked until new input");
  sys.pushStdin("later\n");
  assert.equal(await secondPromise, "woke");

  // 3. Interactive ELF race: write prompt on stdout, then read stdin; pushStdin/closeStdin
  //    triggered synchronously from onStdout (inside flushStdio before _waitForInput) must not hang.
  const promptEchoElf = buildStaticTestElf(`
    static long sys3(long n, long a, long b, long c) {
      long r;
      __asm__ volatile("syscall" : "=a"(r) : "a"(n), "D"(a), "S"(b), "d"(c) : "rcx", "r11", "memory");
      return r;
    }
    void _start(void) {
      const char prompt[] = "PROMPT>";
      sys3(1, 1, (long)prompt, 7);
      char buf[64];
      for (;;) {
        long n = sys3(0, 0, (long)buf, sizeof(buf));
        if (n <= 0) break;
        sys3(1, 1, (long)buf, n);
      }
      sys3(60, 0, 0, 0);
    }
  `);

  const sys2 = await Elf2WasmSystem.create({ compilerWasm, runtimeWasm });
  let pushed = false;
  let accOut = "";
  const runRes = await Promise.race([
    sys2.runElf(promptEchoElf, [], ["/bin/prompt_echo"], {
      tty: false,
      keepStdinOpen: true,
      onStdout: (chunk) => {
        accOut += textDecoder.decode(chunk);
        if (!pushed && accOut.includes("PROMPT>")) {
          pushed = true;
          // Synchronous pushStdin + closeStdin inside flushStdio() right before _waitForInput()
          sys2.pushStdin("RACE_FREE_OK\n");
          sys2.closeStdin();
        }
      },
    }),
    sleep(5000).then(() => {
      sys2.stop();
      throw new Error("Timed out waiting for promptEchoElf (lost NeedStdin wakeup)");
    }),
  ]);
  assert.equal(runRes.exitCode, 0);
  assert.equal(textDecoder.decode(runRes.stdout), "PROMPT>RACE_FREE_OK\n");
});

test("F20: _resolveElfSos auto-bundles core Python lib-dynload/*.so extensions deterministically", async () => {
  const runtimeWasm = fs.readFileSync(RUNTIME_WASM_PATH);
  const sys = await Elf2WasmSystem.create({ runtimeWasm });

  // Build minimal valid ELF64 bytes for testing _resolveElfSos discovery & filtering
  const dummyElf = buildStaticTestElf(`
    void _start(void) {
      __asm__ volatile("syscall" :: "a"(60), "D"(0) : "rcx", "r11");
    }
  `);

  sys.writeVfsFile("/usr/local/bin/python3.12", dummyElf, 0o755);
  sys.writeVfsSymlink("/usr/local/bin/python3", "python3.12");
  sys.writeVfsFile(
    "/usr/local/lib/python3.12/lib-dynload/math.cpython-312-x86_64-linux-gnu.so",
    dummyElf,
    0o755
  );
  sys.writeVfsFile(
    "/usr/local/lib/python3.12/lib-dynload/_sha2.cpython-312-x86_64-linux-gnu.so",
    dummyElf,
    0o755
  );
  sys.writeVfsFile(
    "/usr/local/lib/python3.12/lib-dynload/_json.cpython-312-x86_64-linux-gnu.so",
    dummyElf,
    0o755
  );
  sys.writeVfsFile(
    "/usr/local/lib/python3.12/lib-dynload/_testcapi.cpython-312-x86_64-linux-gnu.so",
    dummyElf,
    0o755
  );
  // Different Python version directory should be ignored when python3.12 matches
  sys.writeVfsFile(
    "/usr/lib/python3.11/lib-dynload/math.cpython-311-x86_64-linux-gnu.so",
    dummyElf,
    0o755
  );
  sys.writeVfsFile("/bin/other", dummyElf, 0o755);

  const pySos = sys._resolveElfSos(dummyElf, [], { elfPath: "/usr/local/bin/python3" });
  const pyPaths = pySos.map((s) => s.path);
  assert.deepEqual(pyPaths, [
    "/usr/local/lib/python3.12/lib-dynload/_json.cpython-312-x86_64-linux-gnu.so",
    "/usr/local/lib/python3.12/lib-dynload/_sha2.cpython-312-x86_64-linux-gnu.so",
    "/usr/local/lib/python3.12/lib-dynload/math.cpython-312-x86_64-linux-gnu.so",
  ]);

  const otherSos = sys._resolveElfSos(dummyElf, [], { elfPath: "/bin/other" });
  assert.deepEqual(otherSos, [], "Non-Python executable must not auto-bundle lib-dynload/*.so");
});

test("F21: Node.js default --jitless env injection, user override, and non-Node negative case", async (t) => {
  const envProbeElf = buildStaticTestElf(`
    static long sys3(long n, long a, long b, long c) {
      long r;
      __asm__ volatile("syscall" : "=a"(r) : "a"(n), "D"(a), "S"(b), "d"(c) : "rcx", "r11", "memory");
      return r;
    }
    static long slen(const char *s) { long n = 0; while (s && s[n]) n++; return n; }
    static void w_str(const char *s) { sys3(1, 1, (long)s, slen(s)); }
    static int starts_with(const char *s, const char *p) {
      while (*p) { if (*s++ != *p++) return 0; }
      return 1;
    }
    static void print_var(char **envp, const char *key_eq) {
      long klen = slen(key_eq);
      const char *val = "UNSET";
      for (int i = 0; envp[i]; i++) {
        if (starts_with(envp[i], key_eq)) {
          val = envp[i] + klen;
          break;
        }
      }
      w_str(key_eq);
      w_str(val);
      w_str("\\n");
    }
    void entry_c(long *sp) {
      long argc = sp[0];
      char **argv = (char **)(sp + 1);
      char **envp = argv + argc + 1;
      print_var(envp, "NODE_OPTIONS=");
      print_var(envp, "MALLOC_ARENA_MAX=");
      print_var(envp, "UV_USE_IO_URING=");
      print_var(envp, "UV_THREADPOOL_SIZE=");
      sys3(60, 0, 0, 0);
    }
    __asm__(
      ".global _start\\n"
      "_start:\\n"
      "  mov %rsp, %rdi\\n"
      "  and $-16, %rsp\\n"
      "  call entry_c\\n"
    );
  `);

  const reg = createMockRegistry({ port: 0, host: "127.0.0.1" });
  await reg.start();
  const srv = createServer({ port: 0, host: "127.0.0.1", allowLocalRegistries: true });
  await srv.start();

  const docker = await Elf2WasmDocker.create({
    compilerWasmUrl: `${srv.url}/wasm/elf2wasm_compiler_wasm.wasm`,
    runtimeWasmUrl: `${srv.url}/wasm/elf2wasm_runtime_wasm.wasm`,
    registryProxyBase: `${srv.url}/api/v2`,
    useWorker: false,
  });

  t.after(async () => {
    await docker.dispose();
    await srv.stop();
    await reg.stop();
  });

  const probeFiles = [
    { path: "bin/envprobe", type: "file", content: envProbeElf, mode: 0o755 },
    { path: "usr/local/bin/node", type: "file", content: envProbeElf, mode: 0o755 },
  ];

  reg.addImage("library/mock-node", "22-slim", {
    mediaTypeMode: "oci",
    multiArch: false,
    config: {
      entrypoint: ["/bin/envprobe"],
      cmd: ["node"],
      env: ["PATH=/usr/local/bin:/usr/bin:/bin", "NODE_VERSION=22.23.5"],
    },
    layers: [{ files: probeFiles }],
  });

  reg.addImage("library/mock-node", "20-slim", {
    mediaTypeMode: "oci",
    multiArch: false,
    config: {
      entrypoint: ["/bin/envprobe"],
      cmd: ["node"],
      env: ["PATH=/usr/local/bin:/usr/bin:/bin", "NODE_VERSION=20.11.0"],
    },
    layers: [{ files: probeFiles }],
  });

  reg.addImage("library/mock-custom-node", "latest", {
    mediaTypeMode: "oci",
    multiArch: false,
    config: {
      cmd: ["/usr/local/bin/node"],
      env: ["PATH=/usr/local/bin:/usr/bin:/bin"],
    },
    layers: [{ files: probeFiles }],
  });

  reg.addImage("library/mock-plain", "latest", {
    mediaTypeMode: "oci",
    multiArch: false,
    config: {
      cmd: ["/bin/envprobe", "node"],
      env: ["PATH=/bin:/usr/bin"],
    },
    layers: [{ files: probeFiles }],
  });

  const parseVars = (stdout) => {
    const out = {};
    for (const line of stdout.trim().split(/\r?\n/)) {
      const idx = line.indexOf("=");
      if (idx > 0) out[line.slice(0, idx)] = line.slice(idx + 1);
    }
    return out;
  };

  // 1. Official Node >= 22 image (NODE_VERSION=22.23.5) receives all 4 defaults including --no-experimental-strip-types
  const defRes = await runDockerImage(`${reg.host}/library/mock-node:22-slim`, { docker });
  assert.equal(defRes.exitCode, 0);
  assert.deepEqual(parseVars(defRes.stdout), {
    NODE_OPTIONS: "--jitless --v8-pool-size=1 --no-experimental-strip-types",
    MALLOC_ARENA_MAX: "1",
    UV_USE_IO_URING: "0",
    UV_THREADPOOL_SIZE: "1",
  });

  // 2. User-supplied options.env strictly overrides defaults while preserving non-overridden ones
  const ovRes = await runDockerImage(`${reg.host}/library/mock-node:22-slim`, {
    docker,
    env: ["NODE_OPTIONS=--jitless --max-old-space-size=128", "UV_THREADPOOL_SIZE=2"],
  });
  assert.equal(ovRes.exitCode, 0);
  assert.deepEqual(parseVars(ovRes.stdout), {
    NODE_OPTIONS: "--jitless --max-old-space-size=128",
    MALLOC_ARENA_MAX: "1",
    UV_USE_IO_URING: "0",
    UV_THREADPOOL_SIZE: "2",
  });

  // 3. Empty string clearing (NODE_OPTIONS=) is honored
  const clearRes = await runDockerImage(`${reg.host}/library/mock-node:22-slim`, {
    docker,
    env: ["NODE_OPTIONS="],
  });
  assert.equal(clearRes.exitCode, 0);
  assert.deepEqual(parseVars(clearRes.stdout), {
    NODE_OPTIONS: "",
    MALLOC_ARENA_MAX: "1",
    UV_USE_IO_URING: "0",
    UV_THREADPOOL_SIZE: "1",
  });

  // 4. Custom image without NODE_VERSION= detected via node executable basename (includes --no-experimental-strip-types)
  const customRes = await runDockerImage(`${reg.host}/library/mock-custom-node:latest`, { docker });
  assert.equal(customRes.exitCode, 0);
  assert.deepEqual(parseVars(customRes.stdout), {
    NODE_OPTIONS: "--jitless --v8-pool-size=1 --no-experimental-strip-types",
    MALLOC_ARENA_MAX: "1",
    UV_USE_IO_URING: "0",
    UV_THREADPOOL_SIZE: "1",
  });

  // 5. Older Node image (NODE_VERSION=20.11.0 < 22) omits --no-experimental-strip-types
  const legacyRes = await runDockerImage(`${reg.host}/library/mock-node:20-slim`, { docker });
  assert.equal(legacyRes.exitCode, 0);
  assert.deepEqual(parseVars(legacyRes.stdout), {
    NODE_OPTIONS: "--jitless --v8-pool-size=1",
    MALLOC_ARENA_MAX: "1",
    UV_USE_IO_URING: "0",
    UV_THREADPOOL_SIZE: "1",
  });

  // 6. Non-Node image running ["/bin/envprobe", "node"] must NOT receive Node defaults
  const plainRes = await runDockerImage(`${reg.host}/library/mock-plain:latest`, { docker });
  assert.equal(plainRes.exitCode, 0);
  assert.deepEqual(parseVars(plainRes.stdout), {
    NODE_OPTIONS: "UNSET",
    MALLOC_ARENA_MAX: "UNSET",
    UV_USE_IO_URING: "UNSET",
    UV_THREADPOOL_SIZE: "UNSET",
  });
});

test("Go container default env helpers (getGoDefaultEnv, isGoContainer, override precedence)", () => {
  const defaults = getGoDefaultEnv();
  assert.deepEqual(defaults, [
    "GODEBUG=asyncpreemptoff=1",
    "GOMEMLIMIT=256MiB",
    "GOMAXPROCS=1",
    "CGO_ENABLED=0",
  ]);

  // Positive Go container detections
  assert.equal(isGoContainer([], [], [], ["/bin/sh"], "golang:1.27"), true);
  assert.equal(isGoContainer([], [], [], ["/bin/sh"], "library/golang:1.24"), true);
  assert.equal(isGoContainer([], [], [], ["/bin/sh"], "localhost:5000/golang:1.27"), true);
  assert.equal(
    isGoContainer([], [], [], ["/bin/sh"], "registry.example.com:5000/library/golang:1.27-alpine"),
    true
  );
  assert.equal(isGoContainer([], [], [], ["/bin/sh"], "localhost:5000/golang@sha256:deadbeef"), true);
  assert.equal(isGoContainer([], [], [], ["/bin/sh"], "localhost:5000/golang"), true);
  assert.equal(isGoContainer([], [], [], ["/bin/sh"], { repository: "library/golang" }), true);
  assert.equal(isGoContainer(["GOLANG_VERSION=1.24.3"], [], [], ["/bin/sh"], "custom:latest"), true);
  assert.equal(isGoContainer(["GOPATH=/go"], [], [], ["/bin/sh"], "custom:latest"), true);
  assert.equal(isGoContainer(["PATH=/bin"], [], [], ["/usr/local/go/bin/go", "version"], "custom:latest"), true);
  assert.equal(isGoContainer(["PATH=/bin"], [], [], ["env", "go", "build"], "custom:latest"), true);

  // Negative non-Go container detections
  assert.equal(isGoContainer(["PATH=/bin"], [], [], ["/bin/sh"], "alpine:latest"), false);
  assert.equal(isGoContainer(["PATH=/bin"], [], [], ["/bin/sh"], "golang:5000/nginx:latest"), false);
  assert.equal(isGoContainer(["NODE_VERSION=22.0.0"], [], [], ["node"], "node:22"), false);
  assert.equal(isGoContainer(["PYTHON_VERSION=3.12"], [], [], ["python3"], "python:3.12"), false);

  // Override precedence: baseEnv (with Go defaults) < image.config.env < options.env
  const toMap = (list) => Object.fromEntries(list.map((e) => {
    const idx = e.indexOf("=");
    return [e.slice(0, idx), e.slice(idx + 1)];
  }));

  const defaultMerged = toMap(mergeEnv(["PATH=/bin", ...defaults], ["GOLANG_VERSION=1.27.0"], []));
  assert.equal(defaultMerged.GODEBUG, "asyncpreemptoff=1");
  assert.equal(defaultMerged.GOMEMLIMIT, "256MiB");
  assert.equal(defaultMerged.GOMAXPROCS, "1");
  assert.equal(defaultMerged.CGO_ENABLED, "0");

  // Explicit image env overrides only that default without losing others
  const imgOverride = toMap(mergeEnv(["PATH=/bin", ...defaults], ["GOMAXPROCS=4"], []));
  assert.equal(imgOverride.GODEBUG, "asyncpreemptoff=1");
  assert.equal(imgOverride.GOMEMLIMIT, "256MiB");
  assert.equal(imgOverride.GOMAXPROCS, "4");
  assert.equal(imgOverride.CGO_ENABLED, "0");

  // User options.env overrides both defaults and image env (including empty-string clearing)
  const userOverride = toMap(
    mergeEnv(
      ["PATH=/bin", ...defaults],
      ["GOMAXPROCS=4"],
      ["GOMEMLIMIT=512MiB", "CGO_ENABLED=1", "GODEBUG="]
    )
  );
  assert.equal(userOverride.GODEBUG, "");
  assert.equal(userOverride.GOMEMLIMIT, "512MiB");
  assert.equal(userOverride.GOMAXPROCS, "4");
  assert.equal(userOverride.CGO_ENABLED, "1");
});

test("Go container default env injection via mock registry", async (t) => {
  if (!fs.existsSync(COMPILER_WASM_PATH) || !fs.existsSync(RUNTIME_WASM_PATH)) {
    t.skip("wasm32 compiler/runtime artifacts not built");
    return;
  }

  const envProbeElf = buildStaticTestElf(`
    static long sys3(long n, long a, long b, long c) {
      long r;
      __asm__ volatile("syscall" : "=a"(r) : "a"(n), "D"(a), "S"(b), "d"(c) : "rcx", "r11", "memory");
      return r;
    }
    static long slen(const char *s) { long n = 0; while (s[n]) n++; return n; }
    static void w_str(const char *s) { sys3(1, 1, (long)s, slen(s)); }
    static int starts_with(const char *s, const char *p) {
      while (*p) { if (*s++ != *p++) return 0; }
      return 1;
    }
    static void print_var(char **envp, const char *key_eq) {
      long klen = slen(key_eq);
      const char *val = "UNSET";
      for (int i = 0; envp[i]; i++) {
        if (starts_with(envp[i], key_eq)) {
          val = envp[i] + klen;
          break;
        }
      }
      w_str(key_eq);
      w_str(val);
      w_str("\\n");
    }
    void entry_c(long *sp) {
      long argc = sp[0];
      char **argv = (char **)(sp + 1);
      char **envp = argv + argc + 1;
      print_var(envp, "GODEBUG=");
      print_var(envp, "GOMEMLIMIT=");
      print_var(envp, "GOMAXPROCS=");
      print_var(envp, "CGO_ENABLED=");
      sys3(60, 0, 0, 0);
    }
    __asm__(
      ".global _start\\n"
      "_start:\\n"
      "  mov %rsp, %rdi\\n"
      "  and $-16, %rsp\\n"
      "  call entry_c\\n"
    );
  `);

  const reg = createMockRegistry({ port: 0, host: "127.0.0.1" });
  await reg.start();
  const srv = createServer({ port: 0, host: "127.0.0.1", allowLocalRegistries: true });
  await srv.start();
  let docker = null;

  t.after(async () => {
    if (docker) await docker.dispose();
    await srv.stop();
    await reg.stop();
  });

  docker = await Elf2WasmDocker.create({
    compilerWasmUrl: `${srv.url}/wasm/elf2wasm_compiler_wasm.wasm`,
    runtimeWasmUrl: `${srv.url}/wasm/elf2wasm_runtime_wasm.wasm`,
    registryProxyBase: `${srv.url}/api/v2`,
    useWorker: false,
  });

  const probeFiles = [
    { path: "bin/envprobe", type: "file", content: envProbeElf, mode: 0o755 },
  ];

  reg.addImage("library/golang", "1.27", {
    mediaTypeMode: "oci",
    multiArch: false,
    config: {
      cmd: ["/bin/envprobe"],
      env: ["PATH=/usr/local/go/bin:/usr/bin:/bin", "GOLANG_VERSION=1.27.0", "GOPATH=/go"],
    },
    layers: [{ files: probeFiles }],
  });

  reg.addImage("library/golang", "custom-img-override", {
    mediaTypeMode: "oci",
    multiArch: false,
    config: {
      cmd: ["/bin/envprobe"],
      env: ["PATH=/usr/local/go/bin:/usr/bin:/bin", "GOMAXPROCS=4"],
    },
    layers: [{ files: probeFiles }],
  });

  reg.addImage("library/alpine", "3.20", {
    mediaTypeMode: "oci",
    multiArch: false,
    config: {
      cmd: ["/bin/envprobe"],
      env: ["PATH=/bin:/usr/bin"],
    },
    layers: [{ files: probeFiles }],
  });

  const parseVars = (stdout) => {
    const out = {};
    for (const line of stdout.trim().split(/\r?\n/)) {
      const idx = line.indexOf("=");
      if (idx > 0) out[line.slice(0, idx)] = line.slice(idx + 1);
    }
    return out;
  };

  // 1. Go image gets all 4 defaults
  const goRes = await runDockerImage(`${reg.host}/library/golang:1.27`, { docker });
  assert.equal(goRes.exitCode, 0);
  assert.deepEqual(parseVars(goRes.stdout), {
    GODEBUG: "asyncpreemptoff=1",
    GOMEMLIMIT: "256MiB",
    GOMAXPROCS: "1",
    CGO_ENABLED: "0",
  });

  // 2. Explicit image env var overrides individual default without losing others
  const imgOvRes = await runDockerImage(`${reg.host}/library/golang:custom-img-override`, { docker });
  assert.equal(imgOvRes.exitCode, 0);
  assert.deepEqual(parseVars(imgOvRes.stdout), {
    GODEBUG: "asyncpreemptoff=1",
    GOMEMLIMIT: "256MiB",
    GOMAXPROCS: "4",
    CGO_ENABLED: "0",
  });

  // 3. Explicit user options.env overrides individual defaults (including empty string clearing)
  const userOvRes = await runDockerImage(`${reg.host}/library/golang:1.27`, {
    docker,
    env: ["GOMEMLIMIT=512MiB", "CGO_ENABLED=1", "GODEBUG="],
  });
  assert.equal(userOvRes.exitCode, 0);
  assert.deepEqual(parseVars(userOvRes.stdout), {
    GODEBUG: "",
    GOMEMLIMIT: "512MiB",
    GOMAXPROCS: "1",
    CGO_ENABLED: "1",
  });

  // 4. Non-Go image (alpine) does NOT receive Go defaults
  const alpineRes = await runDockerImage(`${reg.host}/library/alpine:3.20`, { docker });
  assert.equal(alpineRes.exitCode, 0);
  assert.deepEqual(parseVars(alpineRes.stdout), {
    GODEBUG: "UNSET",
    GOMEMLIMIT: "UNSET",
    GOMAXPROCS: "UNSET",
    CGO_ENABLED: "UNSET",
  });
});

// ============================================================================
// 5. Real alpine:latest from Docker Hub via server/server.mjs
// ============================================================================
test("Real alpine:latest via server/server.mjs: one-shot, interactive shell, SIGINT, resize, VFS & zero child leak", async (t) => {
  const srv = createServer({ port: 0, host: "127.0.0.1", allowLocalRegistries: false });
  await srv.start();

  const docker = await Elf2WasmDocker.create({
    compilerWasmUrl: `${srv.url}/wasm/elf2wasm_compiler_wasm.wasm`,
    runtimeWasmUrl: `${srv.url}/wasm/elf2wasm_runtime_wasm.wasm`,
    registryProxyBase: `${srv.url}/api/v2`,
    useWorker: false,
  });

  t.after(async () => {
    await docker.dispose();
    await srv.stop();
  });

  let alpineImage;
  try {
    alpineImage = await docker.pullImage("alpine:latest");
  } catch (err) {
    if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|502/.test(String(err.message))) {
      t.skip(`Docker Hub unreachable in this environment: ${err.message}`);
      return;
    }
    throw err;
  }

  assert.equal(alpineImage.ref.canonical, "registry-1.docker.io/library/alpine:latest");
  assert.ok(alpineImage.layers.length >= 1);

  await t.test("one-shot command: id -u (UID 0), uname -m, WorkingDir, readFile/writeFile", async () => {
    const c = await alpineImage.createContainer({
      cmd: [
        "/bin/sh",
        "-c",
        "id -u && uname -m && pwd && cat /tmp/from_host.txt && echo FROM_GUEST > /tmp/from_guest.txt",
      ],
      cwd: "/etc",
      tty: false,
    });
    await c.writeFile("/tmp/from_host.txt", "HOST_DATA\n");
    await c.start();
    const res = await c.wait();
    assert.equal(res.exitCode, 0, `stderr: ${res.stderr}`);
    const lines = res.stdout.trim().split(/\r?\n/);
    assert.equal(lines[0], "0", "Container should run as UID 0");
    assert.equal(lines[1], "x86_64");
    assert.equal(lines[2], "/etc");
    assert.equal(lines[3], "HOST_DATA");

    const guestFile = await c.readFile("/tmp/from_guest.txt");
    assert.ok(guestFile);
    assert.equal(textDecoder.decode(guestFile).trim(), "FROM_GUEST");
  });

  await t.test("interactive /bin/sh: live stdout streaming, writeStdin, resize, SIGINT, closeStdin", async () => {
    const c = await alpineImage.createContainer({
      cmd: ["/bin/sh"],
      tty: true,
      cols: 80,
      rows: 24,
    });

    const streamedChunks = [];
    c.onStdout((chunk) => streamedChunks.push(textDecoder.decode(chunk)));

    let exitEventCode = null;
    c.onExit((code) => {
      exitEventCode = code;
    });

    const waitEcho = waitForOutput(c, (s) => s.includes("INTERACTIVE_STREAM_OK"));
    await c.start();

    c.resize(100, 30);
    c.writeStdin("echo INTERACTIVE_STREAM_OK\n");
    await waitEcho;

    // Send SIGINT while shell is waiting for stdin; shell must stay responsive
    c.sendSignal("SIGINT");
    const waitAfterInt = waitForOutput(c, (s) => s.includes("AFTER_SIGINT_OK"));
    c.writeStdin("echo AFTER_SIGINT_OK\n");
    await waitAfterInt;

    // Close stdin (EOF) so interactive /bin/sh exits cleanly
    c.closeStdin();
    const res = await c.wait();
    assert.equal(res.exitCode, 0);
    assert.equal(exitEventCode, 0);
    assert.ok(streamedChunks.join("").includes("INTERACTIVE_STREAM_OK"));
    assert.ok(streamedChunks.join("").includes("AFTER_SIGINT_OK"));
  });

  await t.test("25 sequential forked commands verify zero child process leak in processes Map", async () => {
    const c = await alpineImage.createContainer({
      cmd: [
        "/bin/sh",
        "-c",
        "i=0; while [ $i -lt 25 ]; do /bin/true; i=$((i+1)); done; echo LEAK_TEST_DONE:$i",
      ],
      tty: false,
    });
    await c.start();
    const res = await c.wait();
    assert.equal(res.exitCode, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, /LEAK_TEST_DONE:25/);

    const stats = c._getStats();
    assert.ok(stats, "DirectBackend should provide container stats");
    assert.ok(
      stats.reapedPidCount >= 25,
      `Expected >= 25 reaped child PIDs, got ${stats.reapedPidCount}`
    );
    assert.ok(
      stats.activeProcesses <= 2,
      `Expected activeProcesses <= 2 (no child leak), got ${stats.activeProcesses}`
    );
  });
});

// ============================================================================
// 6. M8 Tier 5 Adversarial Regression Tests
// ============================================================================
test("Adversarial: stopContainer() during precompileFromVfs() prevents zombie container boot", async () => {
  // Static ELF that prints ZOMBIE_BOOTED\n and blocks reading stdin forever
  const zombieElf = buildStaticTestElf(`
    static long sys_write(int fd, const void *buf, unsigned long len) {
      long ret;
      __asm__ volatile ("syscall" : "=a"(ret) : "a"(1), "D"(fd), "S"(buf), "d"(len) : "rcx", "r11", "memory");
      return ret;
    }
    static long sys_read(int fd, void *buf, unsigned long len) {
      long ret;
      __asm__ volatile ("syscall" : "=a"(ret) : "a"(0), "D"(fd), "S"(buf), "d"(len) : "rcx", "r11", "memory");
      return ret;
    }
    static void sys_exit(int code) {
      __asm__ volatile ("syscall" :: "a"(60), "D"(code));
      __builtin_unreachable();
    }
    void _start(void) {
      static const char msg[] = "ZOMBIE_BOOTED\\n";
      char buf[16];
      sys_write(1, msg, sizeof(msg) - 1);
      sys_read(0, buf, sizeof(buf));
      sys_exit(0);
    }
  `);

  const tarBytes = buildCustomTar([
    { path: "bin/", type: "5", mode: 0o755 },
    { path: "bin/sh", type: "0", mode: 0o755, content: Buffer.from(zombieElf) },
    { path: "usr/", type: "5", mode: 0o755 },
    { path: "usr/local/", type: "5", mode: 0o755 },
    { path: "usr/local/bin/", type: "5", mode: 0o755 },
    {
      path: "usr/local/bin/docker-entrypoint.sh",
      type: "0",
      mode: 0o755,
      content: Buffer.from("#!/bin/sh\nexec \"$@\"\n"),
    },
    { path: "usr/local/bin/node", type: "0", mode: 0o755, content: Buffer.from(zombieElf) },
  ]);

  const engine = new ContainerEngine();
  await engine.init({
    compilerWasm: fs.readFileSync(COMPILER_WASM_PATH),
    runtimeWasm: fs.readFileSync(RUNTIME_WASM_PATH),
  });

  try {
    const imgMeta = await engine.loadOciTarball(tarBytes, { name: "local/zombie-race:latest" });
    const stdoutChunks = [];
    const exitCodes = [];
    const { containerId } = await engine.createContainer(
      imgMeta.imageId,
      {
        entrypoint: ["/usr/local/bin/docker-entrypoint.sh"],
        cmd: ["node"],
        tty: false,
      },
      {
        onStdout: (c) => stdoutChunks.push(textDecoder.decode(c)),
        onExit: (code) => exitCodes.push(code),
      }
    );

    const rec = engine.containers.get(containerId);
    assert.ok(rec, "Container record should exist before start");

    // Pause precompileFromVfs so we can deterministically call stopContainer() mid-precompile
    let precompileEntered;
    const precompileEnteredPromise = new Promise((r) => {
      precompileEntered = r;
    });
    let releasePrecompile;
    const precompileGate = new Promise((r) => {
      releasePrecompile = r;
    });

    const origPrecompile = rec.sys.precompileFromVfs.bind(rec.sys);
    rec.sys.precompileFromVfs = async (...args) => {
      precompileEntered();
      await precompileGate;
      return await origPrecompile(...args);
    };

    const startPromise = engine.startContainer(containerId);
    await precompileEnteredPromise;

    await engine.stopContainer(containerId);
    assert.equal(engine.containers.has(containerId), false);
    assert.deepEqual(exitCodes, [137]);

    // Release precompileFromVfs and let startContainer finish
    releasePrecompile();
    await startPromise;

    // Give event loop a brief turn to ensure nothing booted asynchronously
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(stdoutChunks.join(""), "", "Stopped container must emit zero stdout");
    assert.equal(rec.sys.getActiveProcessCount(), 0, "Stopped container must have 0 active processes");
    assert.deepEqual(exitCodes, [137], "onExit must fire exactly once with 137");
  } finally {
    await engine.dispose();
  }
});

test("Adversarial: Elf2WasmSystem.runElf() aborts cleanly if stop() is called during _compileCached()", async () => {
  const helloElf = buildStaticTestElf(`
    static long sys_write(int fd, const void *buf, unsigned long len) {
      long ret;
      __asm__ volatile ("syscall" : "=a"(ret) : "a"(1), "D"(fd), "S"(buf), "d"(len) : "rcx", "r11", "memory");
      return ret;
    }
    static void sys_exit(int code) {
      __asm__ volatile ("syscall" :: "a"(60), "D"(code));
      __builtin_unreachable();
    }
    void _start(void) {
      static const char msg[] = "SHOULD_NOT_RUN\\n";
      sys_write(1, msg, sizeof(msg) - 1);
      sys_exit(0);
    }
  `);

  const sys = await Elf2WasmSystem.create({
    compilerWasm: fs.readFileSync(COMPILER_WASM_PATH),
    runtimeWasm: fs.readFileSync(RUNTIME_WASM_PATH),
  });

  const origCompileCached = sys._compileCached.bind(sys);
  sys._compileCached = async (...args) => {
    const res = await origCompileCached(...args);
    // Simulate stop() arriving while compilation was in flight
    sys.stop();
    return res;
  };

  let readyCalled = false;
  let stdout = "";
  const res = await sys.runElf(helloElf, [], ["/hello"], {
    elfPath: "/hello",
    onReady: () => {
      readyCalled = true;
    },
    onStdout: (c) => {
      stdout += textDecoder.decode(c);
    },
  });

  assert.equal(res.exitCode, 137);
  assert.equal(readyCalled, false, "onReady must not be called when stopped during compile");
  assert.equal(stdout, "", "Aborted runElf must not emit stdout");
  assert.equal(sys.getActiveProcessCount(), 0, "Aborted runElf must leave 0 active processes");
});

test("Adversarial: _compileCached() drops bloated/failed compilerInst on compile error and re-instantiates cleanly", async () => {
  const validElf = buildStaticTestElf(`
    static void sys_exit(int code) {
      __asm__ volatile ("syscall" :: "a"(60), "D"(code));
      __builtin_unreachable();
    }
    void _start(void) { sys_exit(0); }
  `);

  const compilerMod = await WebAssembly.compile(fs.readFileSync(COMPILER_WASM_PATH));
  const compilerInst = await WebAssembly.instantiate(compilerMod, {});
  const changes = [];
  const sys = await Elf2WasmSystem.create({
    compilerInst,
    compilerMod,
    onCompilerInstChange: (inst) => changes.push(inst === null ? "null" : "inst"),
    runtimeWasm: fs.readFileSync(RUNTIME_WASM_PATH),
  });

  // Grow compiler memory past COMPILER_MEM_RESET_THRESHOLD (128 MiB = 2048 pages)
  const mem = sys.compilerInst.exports.memory;
  const curPages = mem.buffer.byteLength >>> 16;
  const targetPages = 2050;
  if (curPages < targetPages) {
    mem.grow(targetPages - curPages);
  }
  assert.ok(mem.buffer.byteLength > 128 * 1024 * 1024);

  const corruptElf = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x00, 0x00, 0x00]);
  await assert.rejects(() => sys._compileCached(corruptElf, [], "/corrupt"));

  assert.equal(sys.compilerInst, null, "Failed compile must drop compilerInst when compilerMod is available");
  assert.deepEqual(changes, ["null"], "onCompilerInstChange must be notified with null on compile error");

  // Subsequent valid compile must cleanly re-instantiate from compilerMod
  const compiled = await sys._compileCached(validElf, [], "/valid");
  assert.ok(compiled.mod instanceof WebAssembly.Module);
  assert.ok(sys.compilerInst !== null, "compilerInst should be re-instantiated for next compile");
  assert.deepEqual(changes, ["null", "inst"]);
});

test("Adversarial: MessageChannel yield exits cleanly in Node.js and falls back to setTimeout(0) when unavailable", () => {
  const loopElf = buildStaticTestElf(`
    static long sys_write(int fd, const void *buf, unsigned long len) {
      long ret;
      __asm__ volatile ("syscall" : "=a"(ret) : "a"(1), "D"(fd), "S"(buf), "d"(len) : "rcx", "r11", "memory");
      return ret;
    }
    static long sys_getpid(void) {
      long ret;
      __asm__ volatile ("syscall" : "=a"(ret) : "a"(39) : "rcx", "r11", "memory");
      return ret;
    }
    static void sys_exit(int code) {
      __asm__ volatile ("syscall" :: "a"(60), "D"(code));
      __builtin_unreachable();
    }
    void _start(void) {
      for (int i = 0; i < 6; i++) sys_getpid();
      static const char msg[] = "YIELD_OK\\n";
      sys_write(1, msg, sizeof(msg) - 1);
      sys_exit(0);
    }
  `);
  const elfB64 = Buffer.from(loopElf).toString("base64");

  const runChild = (disableMessageChannel) => {
    const script = `
      ${disableMessageChannel ? "globalThis.MessageChannel = undefined;" : ""}
      import fs from "node:fs";
      import { Elf2WasmSystem } from "./js/elf2wasm_shim.mjs";
      const elf = Buffer.from(${JSON.stringify(elfB64)}, "base64");
      const sys = await Elf2WasmSystem.create({
        compilerWasm: fs.readFileSync(${JSON.stringify(COMPILER_WASM_PATH)}),
        runtimeWasm: fs.readFileSync(${JSON.stringify(RUNTIME_WASM_PATH)}),
      });
      const res = await sys.runElf(elf, [], ["/loop"], { elfPath: "/loop", yieldEvery: 1 });
      const out = new TextDecoder().decode(res.stdout).trim();
      if (res.exitCode !== 0 || out !== "YIELD_OK") {
        console.error("Unexpected:", res.exitCode, out);
        process.exit(2);
      }
      console.log("CHILD_DONE:" + out);
      // Intentionally do NOT call process.exit() — verify event loop drains cleanly
    `;
    return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 15000,
    });
  };

  const withMc = runChild(false);
  assert.equal(withMc.status, 0, `With MessageChannel failed: ${withMc.stderr}`);
  assert.match(withMc.stdout, /CHILD_DONE:YIELD_OK/);

  const withoutMc = runChild(true);
  assert.equal(withoutMc.status, 0, `Without MessageChannel fallback failed: ${withoutMc.stderr}`);
  assert.match(withoutMc.stdout, /CHILD_DONE:YIELD_OK/);
});

// ============================================================================
// 8. M11 Contract 8: VFS Tar Overlay Extraction (mountPath, stripComponents,
//    path-escape blocking, hardlink rebasing, symlinks, ignoreWhiteouts)
// ============================================================================

test("Contract 8: extractTarToVfs mountPath, stripComponents, path-escape blocking, hardlinks & symlinks", async () => {
  const tarBytes = buildCustomTar([
    { path: "repo-main/", type: "5" },
    { path: "./repo-main/src/", type: "5" },
    { path: "/repo-main//src/./app.py", type: "0", content: "print('ok')\n" },
    { path: "repo-main/a/../b.txt", type: "0", content: "internal-dotdot" },
    { path: "repo-main/../escape1.txt", type: "0", content: "BAD1" },
    { path: "repo-main/a/../../escape2.txt", type: "0", content: "BAD2" },
    { path: "../repo-main/escape3.txt", type: "0", content: "BAD3" },
    { path: "repo-main/src/app_hard.py", type: "1", linkname: "repo-main/src/app.py" },
    { path: "repo-main/bad_hard", type: "1", linkname: "repo-main/../escape1.txt" },
    { path: "repo-main/src/link_rel", type: "2", linkname: "../b.txt" },
    { path: "repo-main/src/link_abs", type: "2", linkname: "/usr/bin/env" },
  ]);

  const vfs = extractTarToVfs(tarBytes, {
    mountPath: "/workspace",
    stripComponents: 1,
  });

  // mountPath directory itself is seeded in dirs
  assert.equal(vfs.dirs.has("/workspace"), true);
  assert.equal(vfs.dirs.has("/workspace/src"), true);

  // Normal & internal-dotdot entries are rebased under /workspace
  assert.equal(textDecoder.decode(vfs.files.get("/workspace/src/app.py").bytes), "print('ok')\n");
  assert.equal(textDecoder.decode(vfs.files.get("/workspace/b.txt").bytes), "internal-dotdot");

  // Escaping entries are strictly rejected
  assert.equal(vfs.files.has("/escape1.txt"), false);
  assert.equal(vfs.files.has("/escape2.txt"), false);
  assert.equal(vfs.files.has("/escape3.txt"), false);
  assert.equal(vfs.files.has("/workspace/escape3.txt"), false);

  // Hardlink target is rebased under /workspace with stripComponents; escaping hardlink skipped
  assert.equal(textDecoder.decode(vfs.files.get("/workspace/src/app_hard.py").bytes), "print('ok')\n");
  assert.equal(vfs.files.has("/workspace/bad_hard"), false);
  assert.equal(vfs.symlinks.has("/workspace/bad_hard"), false);

  // Relative & absolute symlinks are preserved verbatim
  assert.equal(vfs.symlinks.get("/workspace/src/link_rel"), "../b.txt");
  assert.equal(vfs.symlinks.get("/workspace/src/link_abs"), "/usr/bin/env");

  // Also test stripComponents: 2 and extractTarGzToVfs forwarding
  const gzBytes = new Uint8Array(zlib.gzipSync(Buffer.from(tarBytes)));
  const vfs2 = await extractTarGzToVfs(gzBytes, {
    mountPath: "/opt/code",
    stripComponents: 2,
  });
  assert.equal(vfs2.dirs.has("/opt/code"), true);
  assert.equal(textDecoder.decode(vfs2.files.get("/opt/code/app.py").bytes), "print('ok')\n");
  assert.equal(vfs2.files.has("/opt/code/b.txt"), false, "entry with <= 2 segments must be skipped");

  // Empty tar still seeds mountPath dir
  const emptyTar = buildCustomTar([]);
  const emptyVfs = extractTarToVfs(emptyTar, { mountPath: "/empty_ws" });
  assert.equal(emptyVfs.dirs.has("/empty_ws"), true);
});

test("Contract 8: ignoreWhiteouts=true preserves base VFS files while ignoreWhiteouts=false removes them", async () => {
  const sys = await Elf2WasmSystem.create({
    compilerWasm: fs.readFileSync(COMPILER_WASM_PATH),
    runtimeWasm: fs.readFileSync(RUNTIME_WASM_PATH),
  });

  // Base layer seeds /workspace/keep.txt and /workspace/opaque/a.txt
  const baseTar = buildCustomTar([
    { path: "workspace/keep.txt", type: "0", content: "base-keep" },
    { path: "workspace/opaque/a.txt", type: "0", content: "base-opaque" },
  ]);
  extractTarToVfs(sys, baseTar);
  assert.equal(textDecoder.decode(sys.readVfsFile("/workspace/keep.txt")), "base-keep");

  // Overlay tar with .wh.keep.txt and .wh..wh..opq using ignoreWhiteouts: true
  const overlayTar = buildCustomTar([
    { path: "repo-ref/.wh.keep.txt", type: "0", content: "literal-wh" },
    { path: "repo-ref/opaque/.wh..wh..opq", type: "0", content: "literal-opq" },
  ]);
  const overlayGz = new Uint8Array(zlib.gzipSync(Buffer.from(overlayTar)));
  await extractTarGzToVfs(sys, overlayGz, {
    mountPath: "/workspace",
    stripComponents: 1,
    ignoreWhiteouts: true,
  });

  assert.equal(textDecoder.decode(sys.readVfsFile("/workspace/keep.txt")), "base-keep");
  assert.equal(textDecoder.decode(sys.readVfsFile("/workspace/opaque/a.txt")), "base-opaque");
  assert.equal(textDecoder.decode(sys.readVfsFile("/workspace/.wh.keep.txt")), "literal-wh");

  // Now apply the same overlay with ignoreWhiteouts: false (default) -> deletes base files
  extractTarToVfs(sys, overlayTar, {
    mountPath: "/workspace",
    stripComponents: 1,
    ignoreWhiteouts: false,
  });
  assert.equal(sys.readVfsFile("/workspace/keep.txt"), null);
  assert.equal(sys.readVfsFile("/workspace/opaque/a.txt"), null);
});

// ============================================================================
// 9. M11 Contract 9: Git Client, Docker SDK Git Overlay & WorkerBackend RPC
// ============================================================================

test("Contract 9: fetchGitArchive streaming, progress, stripComponents, errors & AbortSignal", async () => {
  const mockGit = createMockGitServer();
  mockGit.addRepo("acme/demo", "v1.0.0", [
    { path: "README.md", content: "# Demo\n" },
    { path: "src/hello.txt", content: "hello-git\n" },
  ]);
  mockGit.addRepo("acme/flat", "main", [
    { path: "flat.txt", content: "flat-content\n" },
  ], { stripComponents: 0, explicitStripHeader: 0 });
  mockGit.addRepo("acme/corrupt", "main", {
    tarGzBytes: Buffer.from("NOT_A_VALID_GZIP_STREAM_1234567890"),
    stripComponents: 1,
  });
  mockGit.addRepo("acme/slow", "main", [
    { path: "slow.txt", content: "slow" },
  ]);
  mockGit.setRouteBehavior("acme/slow", "main", { delayMs: 2000 });
  await mockGit.start();

  const srv = createServer({ port: 0, host: "127.0.0.1", allowLocalRegistries: true });
  await srv.start();

  try {
    const gitProxyBase = `${srv.url}/api/git/archive`;

    // 1. Happy path: streaming + progress + decompression
    const events = [];
    const archive = await fetchGitArchive({
      repo: `${mockGit.url}/acme/demo`,
      ref: "v1.0.0",
      gitProxyBase,
      onProgress: (ev) => events.push(ev),
    });
    assert.equal(archive.stripComponents, 1);
    assert.equal(archive.ref, "v1.0.0");
    assert.ok(archive.tarBytes instanceof Uint8Array && archive.tarBytes.length > 0);
    assert.ok(events.some((e) => e.stage === "git-download" && e.loaded > 0));
    assert.ok(events.some((e) => e.stage === "git-decompress"));

    const extracted = extractTarToVfs(archive.tarBytes, {
      mountPath: "/workspace",
      stripComponents: archive.stripComponents,
    });
    assert.equal(textDecoder.decode(extracted.files.get("/workspace/src/hello.txt").bytes), "hello-git\n");

    // 2. Respects X-Git-Strip-Components: 0
    const flatArchive = await fetchGitArchive({
      repo: `${mockGit.url}/acme/flat`,
      ref: "main",
      gitProxyBase,
    });
    assert.equal(flatArchive.stripComponents, 0);
    const flatVfs = extractTarToVfs(flatArchive.tarBytes, {
      mountPath: "/workspace",
      stripComponents: flatArchive.stripComponents,
    });
    assert.equal(textDecoder.decode(flatVfs.files.get("/workspace/flat.txt").bytes), "flat-content\n");

    // 3. Error handling: 404, 400, 403, corrupt gzip
    await assert.rejects(
      () => fetchGitArchive({ repo: `${mockGit.url}/acme/missing`, ref: "main", gitProxyBase }),
      /404/
    );
    await assert.rejects(
      () => fetchGitArchive({ repo: `${mockGit.url}/acme/demo`, ref: "bad..ref", gitProxyBase }),
      /400/
    );
    await assert.rejects(
      () => fetchGitArchive({ repo: "http://169.254.169.254/latest/meta-data", ref: "main", gitProxyBase }),
      /403|400/
    );
    await assert.rejects(
      () => fetchGitArchive({ repo: `${mockGit.url}/acme/corrupt`, ref: "main", gitProxyBase }),
      /Failed to decompress git archive/
    );

    // 4. Pre-aborted signal
    const preCtrl = new AbortController();
    preCtrl.abort();
    await assert.rejects(
      () =>
        fetchGitArchive({
          repo: `${mockGit.url}/acme/demo`,
          ref: "v1.0.0",
          gitProxyBase,
          signal: preCtrl.signal,
        }),
      (err) => err.name === "AbortError"
    );

    // 5. In-flight abort against delayed route
    const inflightCtrl = new AbortController();
    setTimeout(() => inflightCtrl.abort(), 80);
    await assert.rejects(
      () =>
        fetchGitArchive({
          repo: `${mockGit.url}/acme/slow`,
          ref: "main",
          gitProxyBase,
          signal: inflightCtrl.signal,
        }),
      (err) => err.name === "AbortError"
    );
  } finally {
    await srv.stop();
    await mockGit.stop();
  }
});

test("Contract 9: Elf2WasmDocker, runDockerImage & WorkerBackend gitRepo + overlayTarBytes integration", async () => {
  // Build a static ELF that prints getcwd(), PWD env var, and contents of a relative file + /workspace/keep.txt
  const probeElf = buildStaticTestElf(`
    static long sys_write(int fd, const void *buf, unsigned long len) {
      long ret;
      __asm__ volatile ("syscall" : "=a"(ret) : "a"(1), "D"(fd), "S"(buf), "d"(len) : "rcx", "r11", "memory");
      return ret;
    }
    static long sys_openat(int dirfd, const char *p, int flags, int mode) {
      long ret;
      register long r10 __asm__("r10") = mode;
      __asm__ volatile ("syscall" : "=a"(ret) : "a"(257), "D"(dirfd), "S"(p), "d"(flags), "r"(r10) : "rcx", "r11", "memory");
      return ret;
    }
    static long sys_read(int fd, void *buf, unsigned long len) {
      long ret;
      __asm__ volatile ("syscall" : "=a"(ret) : "a"(0), "D"(fd), "S"(buf), "d"(len) : "rcx", "r11", "memory");
      return ret;
    }
    static long sys_close(int fd) {
      long ret;
      __asm__ volatile ("syscall" : "=a"(ret) : "a"(3), "D"(fd) : "rcx", "r11", "memory");
      return ret;
    }
    static long sys_getcwd(char *buf, unsigned long size) {
      long ret;
      __asm__ volatile ("syscall" : "=a"(ret) : "a"(79), "D"(buf), "S"(size) : "rcx", "r11", "memory");
      return ret;
    }
    static void sys_exit(int code) {
      __asm__ volatile ("syscall" :: "a"(60), "D"(code));
      __builtin_unreachable();
    }
    static unsigned long slen(const char *s) {
      unsigned long n = 0;
      while (s[n]) n++;
      return n;
    }
    static void print_str(const char *s) { sys_write(1, s, slen(s)); }
    static void dump_file(const char *label, const char *path) {
      print_str(label);
      int fd = (int)sys_openat(-100, path, 0, 0);
      if (fd < 0) {
        print_str("MISSING\\n");
        return;
      }
      char buf[256];
      long n = sys_read(fd, buf, sizeof(buf));
      if (n > 0) sys_write(1, buf, (unsigned long)n);
      sys_close(fd);
    }
    void entry_c(long *sp) {
      long argc = sp[0];
      char **envp = (char **)&sp[argc + 2];

      char cwd[256];
      sys_getcwd(cwd, sizeof(cwd));
      print_str("CWD=");
      print_str(cwd);
      print_str("\\n");

      const char *pwd = "UNSET";
      for (int i = 0; envp[i]; i++) {
        if (envp[i][0] == 'P' && envp[i][1] == 'W' && envp[i][2] == 'D' && envp[i][3] == '=') {
          pwd = envp[i] + 4;
          break;
        }
      }
      print_str("PWD=");
      print_str(pwd);
      print_str("\\n");

      dump_file("FILE=", "data/msg.txt");
      dump_file("KEEP=", "/workspace/keep.txt");
      sys_exit(0);
    }
    __asm__(".global _start\\n_start:\\n  mov %rsp, %rdi\\n  call entry_c\\n");
  `);

  const mockReg = createMockRegistry();
  const baseLayer = createTarGzLayer([
    { path: "bin/probe", content: probeElf, mode: 0o755 },
    { path: "workspace/keep.txt", content: "BASE_KEEP_OK\n", mode: 0o644 },
  ]);
  mockReg.addImage("test/probe", "latest", {
    config: {
      cmd: ["/bin/probe"],
      workingDir: "/base_dir",
      env: ["PWD=/base_dir", "PATH=/bin"],
    },
    layers: [{ tarGzBytes: baseLayer.gzipBytes }],
  });
  await mockReg.start();

  const mockGit = createMockGitServer();
  mockGit.addRepo("acme/app", "v2", [
    { path: "data/msg.txt", content: "FROM_GIT_V2\n" },
    { path: ".wh.keep.txt", content: "not-a-whiteout\n" },
  ]);
  mockGit.addRepo("acme/slow", "main", [{ path: "data/msg.txt", content: "SLOW\n" }]);
  mockGit.setRouteBehavior("acme/slow", "main", { delayMs: 2000 });
  await mockGit.start();

  const srv = createServer({ port: 0, host: "127.0.0.1", allowLocalRegistries: true });
  await srv.start();

  try {
    const imageRef = `${mockReg.host}/test/probe:latest`;
    const registryProxyBase = `${srv.url}/api/v2`;
    const gitProxyBase = `${srv.url}/api/git/archive`;

    // 1. runDockerImage with gitRepo (default mountPath=/workspace, default cwd=/workspace, PWD=/workspace)
    const stages = [];
    const res1 = await runDockerImage(imageRef, {
      compilerWasmUrl: `${srv.url}/wasm/elf2wasm_compiler_wasm.wasm`,
      runtimeWasmUrl: `${srv.url}/wasm/elf2wasm_runtime_wasm.wasm`,
      registryProxyBase,
      gitProxyBase,
      useWorker: false,
      gitRepo: { repo: `${mockGit.url}/acme/app`, ref: "v2" },
      onProgress: (ev) => stages.push(ev.stage),
    });
    assert.equal(res1.exitCode, 0);
    assert.match(res1.stdout, /CWD=\/workspace\n/);
    assert.match(res1.stdout, /PWD=\/workspace\n/);
    assert.match(res1.stdout, /FILE=FROM_GIT_V2\n/);
    assert.match(res1.stdout, /KEEP=BASE_KEEP_OK\n/, "ignoreWhiteouts: true must preserve base file");
    assert.ok(stages.includes("git-download"));
    assert.ok(stages.includes("git-decompress"));
    assert.ok(stages.includes("git-overlay"));

    // 2. Custom mountPath + explicit cwd override
    const res2 = await runDockerImage(imageRef, {
      compilerWasmUrl: `${srv.url}/wasm/elf2wasm_compiler_wasm.wasm`,
      runtimeWasmUrl: `${srv.url}/wasm/elf2wasm_runtime_wasm.wasm`,
      registryProxyBase,
      gitProxyBase,
      useWorker: false,
      gitRepo: { repo: `${mockGit.url}/acme/app`, ref: "v2", mountPath: "/src/app" },
    });
    assert.equal(res2.exitCode, 0);
    assert.match(res2.stdout, /CWD=\/src\/app\n/);
    assert.match(res2.stdout, /PWD=\/src\/app\n/);
    assert.match(res2.stdout, /FILE=FROM_GIT_V2\n/);

    const res3 = await runDockerImage(imageRef, {
      compilerWasmUrl: `${srv.url}/wasm/elf2wasm_compiler_wasm.wasm`,
      runtimeWasmUrl: `${srv.url}/wasm/elf2wasm_runtime_wasm.wasm`,
      registryProxyBase,
      gitProxyBase,
      useWorker: false,
      gitRepo: { repo: `${mockGit.url}/acme/app`, ref: "v2", mountPath: "/src/app" },
      cwd: "/src",
    });
    assert.equal(res3.exitCode, 0);
    assert.match(res3.stdout, /CWD=\/src\n/);
    assert.match(res3.stdout, /PWD=\/src\n/);

    // 3. Offline overlayTarBytes (both gzipped .tar.gz and plain .tar)
    const { tarBytes: offlineTar, gzipBytes: offlineGz } = createGitArchiveTarGz(
      [{ path: "data/msg.txt", content: "FROM_OFFLINE_TAR\n" }],
      { rootDir: "offline-main" }
    );
    const resOffline = await runDockerImage(imageRef, {
      compilerWasmUrl: `${srv.url}/wasm/elf2wasm_compiler_wasm.wasm`,
      runtimeWasmUrl: `${srv.url}/wasm/elf2wasm_runtime_wasm.wasm`,
      registryProxyBase,
      useWorker: false,
      overlayTarBytes: offlineGz,
      overlayMountPath: "/offline_ws",
      overlayStripComponents: 1,
    });
    assert.equal(resOffline.exitCode, 0);
    assert.match(resOffline.stdout, /CWD=\/offline_ws\n/);
    assert.match(resOffline.stdout, /FILE=FROM_OFFLINE_TAR\n/);

    // 4. WorkerBackend + container_worker.mjs via InProcessWorker
    const origWorker = globalThis.Worker;
    const origSelf = globalThis.self;
    class InProcessWorker {
      constructor(url) {
        this._listeners = new Map();
        this._terminated = false;
        this._workerListeners = [];
        const selfShim = {
          addEventListener: (type, fn) => {
            if (type === "message") this._workerListeners.push(fn);
          },
          postMessage: (data) => {
            if (this._terminated) return;
            queueMicrotask(() => {
              if (this._terminated) return;
              for (const fn of this._listeners.get("message") || []) fn({ data });
            });
          },
        };
        globalThis.self = selfShim;
        this._ready = import(`${url.href}?inproc_m11=${Date.now()}_${Math.random()}`);
      }
      addEventListener(type, fn) {
        if (!this._listeners.has(type)) this._listeners.set(type, new Set());
        this._listeners.get(type).add(fn);
      }
      postMessage(data) {
        if (this._terminated) return;
        this._ready.then(() => {
          if (this._terminated) return;
          for (const fn of this._workerListeners) fn({ data });
        });
      }
      terminate() {
        this._terminated = true;
      }
    }

    globalThis.Worker = InProcessWorker;
    let wDocker = null;
    try {
      wDocker = await Elf2WasmDocker.create({
        compilerWasmUrl: `${srv.url}/wasm/elf2wasm_compiler_wasm.wasm`,
        runtimeWasmUrl: `${srv.url}/wasm/elf2wasm_runtime_wasm.wasm`,
        registryProxyBase,
        gitProxyBase,
        useWorker: true,
      });
      const wImg = await wDocker.pullImage(imageRef);

      // 4a. WorkerBackend gitRepo overlay + progress
      const wStages = [];
      const wCont = await wImg.createContainer({
        gitRepo: { repo: `${mockGit.url}/acme/app`, ref: "v2" },
        onProgress: (ev) => wStages.push(ev.stage),
      });
      await wCont.start();
      const wRes = await wCont.wait();
      assert.equal(wRes.exitCode, 0);
      assert.match(wRes.stdout, /CWD=\/workspace\n/);
      assert.match(wRes.stdout, /PWD=\/workspace\n/);
      assert.match(wRes.stdout, /FILE=FROM_GIT_V2\n/);
      assert.ok(wStages.includes("git-download"));
      assert.ok(wStages.includes("git-decompress"));
      assert.ok(wStages.includes("git-overlay"));

      // 4b. WorkerBackend transferable overlayTarBytes (plain tar)
      const wCont2 = await wImg.createContainer({
        overlayTarBytes: offlineTar,
        overlayMountPath: "/worker_ws",
        overlayStripComponents: 1,
      });
      await wCont2.start();
      const wRes2 = await wCont2.wait();
      assert.equal(wRes2.exitCode, 0);
      assert.match(wRes2.stdout, /CWD=\/worker_ws\n/);
      assert.match(wRes2.stdout, /FILE=FROM_OFFLINE_TAR\n/);

      // 4c. WorkerBackend in-flight AbortSignal cancellation during gitRepo download
      const abortCtrl = new AbortController();
      setTimeout(() => abortCtrl.abort(), 80);
      await assert.rejects(
        () =>
          wImg.createContainer({
            gitRepo: { repo: `${mockGit.url}/acme/slow`, ref: "main" },
            signal: abortCtrl.signal,
          }),
        (err) => err.name === "AbortError"
      );
    } finally {
      if (wDocker) await wDocker.dispose();
      globalThis.Worker = origWorker;
      globalThis.self = origSelf;
    }
  } finally {
    await srv.stop();
    await mockGit.stop();
    await mockReg.stop();
  }
});

test("Contract 9: fetchGitArchive retries once on transient TypeError and fails fast on ECONNREFUSED / AbortError / HTTP 404", async () => {
  const { gzipBytes } = createGitArchiveTarGz(
    [{ path: "hello.txt", content: "retried-ok\n" }],
    { rootDir: "demo-main" }
  );

  const makeOkResponse = () =>
    new Response(gzipBytes, {
      status: 200,
      headers: {
        "content-type": "application/gzip",
        "content-length": String(gzipBytes.length),
        "x-git-archive-format": "tar.gz",
        "x-git-strip-components": "1",
      },
    });

  // 1. Transient UND_ERR_SOCKET TypeError on attempt 1 succeeds on attempt 2
  let socketCalls = 0;
  const socketResult = await fetchGitArchive({
    repo: "acme/demo",
    ref: "main",
    gitProxyBase: "http://127.0.0.1:1/api/git/archive",
    fetchImpl: async () => {
      socketCalls++;
      if (socketCalls === 1) {
        const cause = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
        throw new TypeError("fetch failed", { cause });
      }
      return makeOkResponse();
    },
  });
  assert.equal(socketCalls, 2);
  assert.ok(socketResult.tarBytes.length > 0);
  assert.equal(socketResult.stripComponents, 1);

  // 2. Codeless browser-style TypeError on attempt 1 succeeds on attempt 2
  let codelessCalls = 0;
  const codelessResult = await fetchGitArchive({
    repo: "acme/demo",
    ref: "main",
    gitProxyBase: "http://127.0.0.1:1/api/git/archive",
    fetchImpl: async () => {
      codelessCalls++;
      if (codelessCalls === 1) {
        throw new TypeError("Failed to fetch");
      }
      return makeOkResponse();
    },
  });
  assert.equal(codelessCalls, 2);
  assert.ok(codelessResult.tarBytes.length > 0);

  // 3. Deterministic ECONNREFUSED inside AggregateError fails fast without retry & surfaces cause
  let refusedCalls = 0;
  await assert.rejects(
    () =>
      fetchGitArchive({
        repo: "acme/demo",
        ref: "main",
        gitProxyBase: "http://127.0.0.1:1/api/git/archive",
        fetchImpl: async () => {
          refusedCalls++;
          const e1 = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), {
            code: "ECONNREFUSED",
          });
          const agg = new AggregateError([e1], "");
          throw new TypeError("fetch failed", { cause: agg });
        },
      }),
    (err) =>
      err instanceof Error &&
      /ECONNREFUSED/.test(err.message) &&
      err.cause instanceof TypeError
  );
  assert.equal(refusedCalls, 1);

  // 4. AbortError fails fast without retry
  let abortCalls = 0;
  await assert.rejects(
    () =>
      fetchGitArchive({
        repo: "acme/demo",
        ref: "main",
        gitProxyBase: "http://127.0.0.1:1/api/git/archive",
        fetchImpl: async () => {
          abortCalls++;
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          throw err;
        },
      }),
    (err) => err.name === "AbortError"
  );
  assert.equal(abortCalls, 1);

  // 5. Non-2xx HTTP response fails fast without retry
  let http404Calls = 0;
  await assert.rejects(
    () =>
      fetchGitArchive({
        repo: "acme/demo",
        ref: "missing",
        gitProxyBase: "http://127.0.0.1:1/api/git/archive",
        fetchImpl: async () => {
          http404Calls++;
          return new Response(JSON.stringify({ error: "not found" }), {
            status: 404,
            statusText: "Not Found",
            headers: { "content-type": "application/json" },
          });
        },
      }),
    /404/
  );
  assert.equal(http404Calls, 1);
});

// ============================================================================
// 8. M13 Phase 2 Adversarial Regressions (BUG-B1, B2, B5, B6 + GAP-B1..B3)
// ============================================================================
test("BUG-B1: extractTarToVfs rejects negative tar entry sizes (ASCII octal and GNU base-256) without hanging", () => {
  function makeRawHeader(name, sizeMutator) {
    const hdr = new Uint8Array(512);
    const enc = new TextEncoder();
    hdr.set(enc.encode(name), 0);
    hdr.set(enc.encode("0000644\0"), 100);
    hdr.set(enc.encode("0000000\0"), 108);
    hdr.set(enc.encode("0000000\0"), 116);
    sizeMutator(hdr);
    hdr[156] = "0".charCodeAt(0);
    hdr.set(enc.encode("ustar\0"), 257);
    hdr.set(enc.encode("00"), 263);
    const full = new Uint8Array(1536);
    full.set(hdr, 0);
    return full;
  }

  // 1. ASCII octal "-1000" (-512)
  const negOctalTar = makeRawHeader("repo-main/evil.txt", (hdr) => {
    hdr.set(new TextEncoder().encode("-1000\0"), 124);
  });
  const resOctal = extractTarToVfs(negOctalTar, { mountPath: "/workspace", stripComponents: 1 });
  assert.equal(resOctal.files.size, 0, "Negative octal size tar must terminate immediately with 0 files");

  // 2. GNU base-256 negative (-512: 0xff ... 0xfe 0x00)
  const negBase256Tar = makeRawHeader("repo-main/evil2.txt", (hdr) => {
    for (let i = 124; i < 134; i++) hdr[i] = 0xff;
    hdr[134] = 0xfe;
    hdr[135] = 0x00;
  });
  const resBase256 = extractTarToVfs(negBase256Tar, { mountPath: "/workspace", stripComponents: 1 });
  assert.equal(resBase256.files.size, 0, "Negative base-256 size tar must terminate immediately with 0 files");
});

test("GAP-B1: PAX x/g and GNU L/K path traversal blocked under mountPath; negative/NaN/huge stripComponents safe", () => {
  function buildHeader(name, typeFlag, size, linkName = "") {
    const hdr = new Uint8Array(512);
    const enc = new TextEncoder();
    hdr.set(enc.encode(name).subarray(0, 100), 0);
    hdr.set(enc.encode("0000644\0"), 100);
    hdr.set(enc.encode("0000000\0"), 108);
    hdr.set(enc.encode("0000000\0"), 116);
    hdr.set(enc.encode(size.toString(8).padStart(11, "0") + "\0"), 124);
    hdr[156] = typeFlag.charCodeAt(0);
    hdr.set(enc.encode(linkName).subarray(0, 100), 157);
    hdr.set(enc.encode("ustar\0"), 257);
    hdr.set(enc.encode("00"), 263);
    return hdr;
  }
  function padBlock(bytes) {
    const padded = new Uint8Array(Math.ceil(bytes.length / 512) * 512);
    padded.set(bytes);
    return padded;
  }
  function makePaxRecord(key, value) {
    const body = `${key}=${value}\n`;
    let len = body.length + 2;
    while (String(len).length + 1 + body.length !== len) {
      len = String(len).length + 1 + body.length;
    }
    return new TextEncoder().encode(`${len} ${body}`);
  }

  const enc = new TextEncoder();
  const paxEscapePayload = makePaxRecord("path", "repo-main/../../etc/pwned_pax");
  const gnuEscapeName = enc.encode("repo-main/../../etc/pwned_gnu\0");
  const safeData = enc.encode("safe-content");

  const chunks = [
    // PAX x traversal attempt
    buildHeader("pax_hdr", "x", paxEscapePayload.length),
    padBlock(paxEscapePayload),
    buildHeader("placeholder", "0", 4),
    padBlock(enc.encode("evil")),
    // GNU LongName L traversal attempt
    buildHeader("././@LongLink", "L", gnuEscapeName.length),
    padBlock(gnuEscapeName),
    buildHeader("placeholder2", "0", 4),
    padBlock(enc.encode("evil")),
    // Legitimate file inside mountPath
    buildHeader("repo-main/sub/ok.txt", "0", safeData.length),
    padBlock(safeData),
    new Uint8Array(1024),
  ];
  const totalLen = chunks.reduce((a, b) => a + b.length, 0);
  const tarBuf = new Uint8Array(totalLen);
  let pos = 0;
  for (const c of chunks) {
    tarBuf.set(c, pos);
    pos += c.length;
  }

  const out = extractTarToVfs(tarBuf, { mountPath: "/workspace", stripComponents: 1 });
  assert.equal(out.files.has("/etc/pwned_pax"), false, "PAX traversal must not escape /workspace");
  assert.equal(out.files.has("/etc/pwned_gnu"), false, "GNU LongName traversal must not escape /workspace");
  assert.equal(textDecoder.decode(out.files.get("/workspace/sub/ok.txt").bytes), "safe-content");

  // Negative, NaN, and huge stripComponents must not crash or escape
  const negStrip = extractTarToVfs(tarBuf, { mountPath: "/workspace", stripComponents: -5 });
  assert.ok(negStrip.files.has("/workspace/repo-main/sub/ok.txt"));
  const nanStrip = extractTarToVfs(tarBuf, { mountPath: "/workspace", stripComponents: Number.NaN });
  assert.ok(nanStrip.files.has("/workspace/repo-main/sub/ok.txt"));
  const hugeStrip = extractTarToVfs(tarBuf, { mountPath: "/workspace", stripComponents: 999 });
  assert.equal(hugeStrip.files.size, 0);
});

test("BUG-B2 & BUG-B6 & GAP-B2: fetchGitArchive post-decompress abort, direct err.code fast-fail, bad strip header & gitProxyBase query", async () => {
  const { gzipBytes } = createGitArchiveTarGz(
    [{ path: "file.txt", content: "hello\n" }],
    { rootDir: "demo-main" }
  );

  // 1. BUG-B2: AbortSignal triggered during git-decompress rejects with AbortError
  const ac = new AbortController();
  await assert.rejects(
    () =>
      fetchGitArchive({
        repo: "acme/demo",
        ref: "main",
        gitProxyBase: "http://127.0.0.1:1/api/git/archive",
        signal: ac.signal,
        onProgress: (ev) => {
          if (ev.stage === "git-decompress") {
            ac.abort();
          }
        },
        fetchImpl: async () =>
          new Response(gzipBytes, {
            status: 200,
            headers: {
              "content-type": "application/gzip",
              "x-git-archive-format": "tar.gz",
              "x-git-strip-components": "1",
            },
          }),
      }),
    (err) => err && err.name === "AbortError"
  );

  // 2. BUG-B6: Direct err.code = "ECONNREFUSED" on TypeError fails fast (1 call) and surfaces code
  let directCodeCalls = 0;
  await assert.rejects(
    () =>
      fetchGitArchive({
        repo: "acme/demo",
        ref: "main",
        gitProxyBase: "http://127.0.0.1:1/api/git/archive",
        fetchImpl: async () => {
          directCodeCalls++;
          const err = new TypeError("fetch failed");
          err.code = "ECONNREFUSED";
          throw err;
        },
      }),
    (err) => err instanceof Error && /ECONNREFUSED/.test(err.message)
  );
  assert.equal(directCodeCalls, 1, "Direct err.code=ECONNREFUSED must not retry");

  // 3. GAP-B2: Malformed X-Git-Strip-Components falls back to 1
  for (const badHeader of ["-1", "NaN", "1.5", "999", ""]) {
    const res = await fetchGitArchive({
      repo: "acme/demo",
      ref: "main",
      gitProxyBase: "http://127.0.0.1:1/api/git/archive",
      fetchImpl: async () =>
        new Response(gzipBytes, {
          status: 200,
          headers: {
            "content-type": "application/gzip",
            "x-git-archive-format": "tar.gz",
            "x-git-strip-components": badHeader,
          },
        }),
    });
    assert.equal(res.stripComponents, 1, `Expected stripComponents=1 for header=${JSON.stringify(badHeader)}`);
  }

  // 4. GAP-B2: gitProxyBase with trailing slash and existing query string
  const seenUrls = [];
  await fetchGitArchive({
    repo: "acme/demo",
    ref: "main",
    gitProxyBase: "http://127.0.0.1:1/api/git/archive/?token=abc",
    fetchImpl: async (url) => {
      seenUrls.push(String(url));
      return new Response(gzipBytes, { status: 200 });
    },
  });
  assert.equal(
    seenUrls[0],
    "http://127.0.0.1:1/api/git/archive/?token=abc&repo=acme%2Fdemo&ref=main"
  );
});

test("BUG-B2: ContainerEngine.createContainer racing with dispose() during gitRepo fetch leaks zero containers", async () => {
  const { gzipBytes } = createGitArchiveTarGz(
    [{ path: "readme.txt", content: "ok\n" }],
    { rootDir: "demo-main" }
  );

  // Hold the upstream git proxy response until after dispose() is called
  let releaseGitResponse;
  let gitRequestArrived;
  const gitRequestArrivedPromise = new Promise((r) => {
    gitRequestArrived = r;
  });
  const gitGate = new Promise((r) => {
    releaseGitResponse = r;
  });

  const slowGitProxy = http.createServer(async (_req, res) => {
    gitRequestArrived();
    await gitGate;
    res.writeHead(200, {
      "Content-Type": "application/gzip",
      "Content-Length": String(gzipBytes.length),
      "X-Git-Archive-Format": "tar.gz",
      "X-Git-Strip-Components": "1",
    });
    res.end(gzipBytes);
  });
  await new Promise((resolve) => slowGitProxy.listen(0, "127.0.0.1", resolve));
  const slowPort = slowGitProxy.address().port;

  const engine = new ContainerEngine();
  await engine.init({
    compilerWasm: fs.readFileSync(COMPILER_WASM_PATH),
    runtimeWasm: fs.readFileSync(RUNTIME_WASM_PATH),
  });

  try {
    const emptyTar = buildCustomTar([{ path: "bin/", type: "5", mode: 0o755 }]);
    const imgMeta = await engine.loadOciTarball(emptyTar, { name: "local/dispose-race:latest" });

    const createPromise = engine.createContainer(imgMeta.imageId, {
      gitRepo: {
        repo: "acme/demo",
        ref: "main",
        gitProxyBase: `http://127.0.0.1:${slowPort}/api/git/archive`,
      },
    });

    await gitRequestArrivedPromise;
    await engine.dispose();
    releaseGitResponse();

    await assert.rejects(createPromise, /disposed/i);
    assert.equal(engine.containers.size, 0, "Disposed engine must not retain leaked containers");
  } finally {
    await engine.dispose();
    await new Promise((resolve) => slowGitProxy.close(resolve));
  }
});

test("BUG-B5 & GAP-B3: WorkerBackend null overlayTarBytes/stdin parity, non-detachment, and combined gitRepo+overlayTarBytes precedence", async () => {
  // Verify WorkerBackend handles overlayTarBytes: null and stdin: null without TypeError,
  // and does not detach caller's Uint8Array when transferring overlayTarBytes.
  const calls = [];
  class FakeWorker {
    constructor() {
      this._listeners = new Map();
    }
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(fn);
    }
    postMessage(msg, transfer) {
      calls.push({ msg, transfer });
      queueMicrotask(() => {
        const result = msg.method === "createContainer" ? { containerId: calls.length } : {};
        for (const fn of this._listeners.get("message") || []) {
          fn({ data: { type: "res", id: msg.id, ok: true, result } });
        }
      });
    }
    terminate() {}
  }

  const origWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  try {
    const docker = await Elf2WasmDocker.create({
      compilerWasm: fs.readFileSync(COMPILER_WASM_PATH),
      runtimeWasm: fs.readFileSync(RUNTIME_WASM_PATH),
      useWorker: true,
    });
    try {
      const img = await docker.loadOciTarball(
        buildCustomTar([{ path: "bin/", type: "5", mode: 0o755 }]),
        { name: "local/worker-parity:latest" }
      );
      // 1. null overlayTarBytes & null stdin must not throw TypeError
      const cNull = await img.createContainer({ overlayTarBytes: null, stdin: null });
      assert.ok(cNull);

      // 2. Non-null overlayTarBytes must slice-copy so caller's buffer is never detached
      const callerBuf = new Uint8Array([1, 2, 3, 4]);
      const cBuf = await img.createContainer({ overlayTarBytes: callerBuf });
      assert.ok(cBuf);
      assert.equal(callerBuf.byteLength, 4, "Caller overlayTarBytes must not be detached");
      const lastCall = calls[calls.length - 1];
      assert.equal(lastCall.transfer.length, 1);
      assert.notEqual(lastCall.transfer[0], callerBuf.buffer, "Worker must transfer a cloned buffer");
    } finally {
      await docker.dispose();
    }
  } finally {
    globalThis.Worker = origWorker;
  }

  // Combined gitRepo + overlayTarBytes precedence and mountPath normalization
  const mockGit = createMockGitServer();
  mockGit.addRepo("acme/combo", "main", [
    { path: "shared.txt", content: "from-git\n" },
    { path: "only-git.txt", content: "git-only\n" },
  ]);
  await mockGit.start();

  const srv = createServer({ port: 0, host: "127.0.0.1", allowLocalRegistries: true });
  await srv.start();
  const docker = await Elf2WasmDocker.create({
    compilerWasm: fs.readFileSync(COMPILER_WASM_PATH),
    runtimeWasm: fs.readFileSync(RUNTIME_WASM_PATH),
    gitProxyBase: `${srv.url}/api/git/archive`,
    useWorker: false,
  });

  try {
    const baseTar = buildCustomTar([{ path: "bin/", type: "5", mode: 0o755 }]);
    const img = await docker.loadOciTarball(baseTar, { name: "local/combo:latest" });
    const overlayTar = buildCustomTar([
      { path: "shared.txt", type: "0", mode: 0o644, content: Buffer.from("from-overlay\n") },
      { path: "only-overlay.txt", type: "0", mode: 0o644, content: Buffer.from("overlay-only\n") },
    ]);

    const c = await img.createContainer({
      gitRepo: {
        repo: `${mockGit.url}/acme/combo`,
        ref: "main",
        mountPath: "relative/dir/",
      },
      overlayTarBytes: overlayTar,
      overlayMountPath: "/relative/dir",
      overlayStripComponents: 0,
    });
    assert.equal(textDecoder.decode(await c.readFile("/relative/dir/shared.txt")), "from-overlay\n");
    assert.equal(textDecoder.decode(await c.readFile("/relative/dir/only-git.txt")), "git-only\n");
    assert.equal(textDecoder.decode(await c.readFile("/relative/dir/only-overlay.txt")), "overlay-only\n");
  } finally {
    await docker.dispose();
    await srv.stop();
    await mockGit.stop();
  }
});

test("formatWasmTrapError annotates WebAssembly.RuntimeError with phase, elfPath, pid, and unsigned 64-bit hex regs", () => {
  const orig = new WebAssembly.RuntimeError("unreachable");
  // Simulate signed 64-bit WebAssembly.Global values (e.g. rip = 0xffffffffff600000 = -10485760n)
  const fakeExports = {
    rip: new WebAssembly.Global({ value: "i64", mutable: true }, -10485760n),
    rsp: new WebAssembly.Global({ value: "i64", mutable: true }, 0xbfef908n),
    rax: new WebAssembly.Global({ value: "i64", mutable: true }, -10485760n),
  };
  const annotated = formatWasmTrapError(orig, {
    phase: "guest._start",
    elfPath: "/usr/local/go/bin/go",
    pid: 1001,
    guestExports: fakeExports,
  });

  assert.ok(annotated instanceof WebAssembly.RuntimeError);
  assert.equal(annotated.cause, orig);
  assert.match(annotated.message, /unreachable/);
  assert.match(annotated.message, /\/usr\/local\/go\/bin\/go/);
  assert.match(annotated.message, /pid 1001/);
  assert.match(annotated.message, /phase guest\._start/);
  assert.match(annotated.message, /rip=0xffffffffff600000/);
  assert.match(annotated.message, /rsp=0xbfef908/);
  assert.match(annotated.message, /rax=0xffffffffff600000/);

  // Non-guest compile phase without guestExports omits register suffix cleanly
  const compileTrap = formatWasmTrapError(new WebAssembly.RuntimeError("unreachable"), {
    phase: "needExec:compile",
    elfPath: "/usr/local/go/bin/go",
    pid: 1002,
  });
  assert.ok(compileTrap instanceof WebAssembly.RuntimeError);
  assert.match(compileTrap.message, /needExec:compile/);
  assert.doesNotMatch(compileTrap.message, /rip=/);
});




