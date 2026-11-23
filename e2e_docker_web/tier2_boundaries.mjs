// Tier 2: Boundaries, Security, Error Handling & Stress (Opaque-Box E2E)
// Runs both a hardened server (no --allow-local-registries) and a local-mock server.

import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  assert,
  assertIncludes,
  assertNotIncludes,
  stripAnsi,
  sleep,
  waitFor,
  waitWithTimeout,
  Suite,
} from "./helpers/test_runner.mjs";
import { startMockOciRegistry } from "./helpers/mock_oci_registry.mjs";
import { startMockGitServer } from "./helpers/mock_git_server.mjs";
import { createTar } from "./helpers/tar_builder.mjs";
import { REQUIRED_ARTIFACTS, getFreePort, startServer } from "./helpers/server_harness.mjs";

export async function runTier2(opts = {}) {
  const sdk = await import(pathToFileURL(REQUIRED_ARTIFACTS.dockerSdk).href);
  const { Elf2WasmDocker, parseImageRef } = sdk;

  const registry = await startMockOciRegistry({ requireAuth: true, redirectBlobs: true });
  const gitServer = await startMockGitServer({ redirectArchives: true });
  const hardenedServer = await startServer({ allowLocalRegistries: false });
  const localServer = await startServer({ allowLocalRegistries: true });

  const BINARY_BLOB = Uint8Array.from({ length: 4096 }, (_, i) => (i * 31 + 7) & 0xff);
  const UTF8_TEXT = "café 日本語 🚀\n";

  gitServer.addRepo("testorg/demo", {
    main: [
      { path: "demo-main/", type: "dir", mode: 0o755 },
      { path: "demo-main/README.md", type: "file", content: "DEMO_OK\n" },
    ],
    HEAD: [
      { path: "demo-main/", type: "dir", mode: 0o755 },
      { path: "demo-main/README.md", type: "file", content: "DEMO_OK\n" },
    ],
  });

  gitServer.addRepo("testorg/binutf8", {
    main: [
      { path: "binutf8-main/", type: "dir", mode: 0o755 },
      { path: "binutf8-main/assets/", type: "dir", mode: 0o755 },
      { path: "binutf8-main/assets/blob.bin", type: "file", content: BINARY_BLOB },
      { path: "binutf8-main/docs/", type: "dir", mode: 0o755 },
      { path: "binutf8-main/docs/unicode.txt", type: "file", content: UTF8_TEXT },
    ],
  });

  const sdkOpts = {
    compilerWasmUrl: `${localServer.url}/wasm/elf2wasm_compiler_wasm.wasm`,
    runtimeWasmUrl: `${localServer.url}/wasm/elf2wasm_runtime_wasm.wasm`,
    registryProxyBase: `${localServer.url}/api/v2`,
    gitProxyBase: `${localServer.url}/api/git/archive`,
    useWorker: false,
  };

  const docker = await Elf2WasmDocker.create(sdkOpts);
  let alpineImage = null;
  let layeredImage = null;
  let pythonImage = null;
  let nodeImage = null;

  async function getAlpine() {
    if (!alpineImage) {
      alpineImage = await docker.pullImage(registry.imageRef("library/alpine", "latest"));
    }
    return alpineImage;
  }

  async function getLayered() {
    if (!layeredImage) {
      layeredImage = await docker.pullImage(registry.imageRef("custom/layered", "v1"));
    }
    return layeredImage;
  }

  async function getPython() {
    if (!pythonImage) {
      const ref = registry.ensureBuiltinFixture("python");
      pythonImage = await docker.pullImage(ref);
    }
    return pythonImage;
  }

  async function getNode() {
    if (!nodeImage) {
      const ref = registry.ensureBuiltinFixture("node");
      nodeImage = await docker.pullImage(ref);
    }
    return nodeImage;
  }

  const suite = new Suite("Tier 2 (Boundaries)");

  suite.add("T2.1", "Malformed image refs rejected cleanly by parseImageRef", () => {
    const badRefs = [
      "",
      "   ",
      "ALPINE:UPPER",
      "alpine:tag:extra",
      "../etc/passwd",
      "http://evil.example/img",
    ];
    for (const ref of badRefs) {
      assert.throws(
        () => parseImageRef(ref),
        Error,
        `parseImageRef(${JSON.stringify(ref)}) must throw`
      );
    }
  });

  suite.add("T2.2", "Nonexistent image/tag returns 404 JSON and pullImage rejects cleanly", async () => {
    const r1 = await fetch(`${localServer.url}/api/v2/${registry.host}/library/doesnotexist/manifests/latest`);
    assert.equal(r1.status, 404);
    const j1 = await r1.json();
    assert.ok(j1 && typeof j1.error === "string", "404 response must contain JSON error");

    const r2 = await fetch(`${localServer.url}/api/v2/${registry.host}/library/alpine/manifests/notag`);
    assert.equal(r2.status, 404);
    const j2 = await r2.json();
    assert.ok(j2 && typeof j2.error === "string", "404 tag response must contain JSON error");

    await assert.rejects(
      () => docker.pullImage(registry.imageRef("library/doesnotexist", "latest")),
      Error
    );

    // Also verify upstream 500 maps to 502 JSON
    const r500 = await fetch(`${localServer.url}/api/v2/${registry.host}/error/upstream500/manifests/latest`);
    assert.equal(r500.status, 502, "Upstream 500 must map to 502 Bad Gateway");
    const j500 = await r500.json();
    assert.ok(j500 && typeof j500.error === "string");
  });

  suite.add("T2.3", "SSRF Guard: hardened server blocks loopback/private/link-local hosts with 403", async () => {
    const blockedHosts = [
      "127.0.0.1",
      registry.host,
      "localhost",
      `localhost:${registry.port}`,
      "169.254.169.254",
      "10.0.0.1",
      "192.168.1.1",
      "172.16.0.1",
      "[::1]",
      "0.0.0.0",
    ];
    for (const host of blockedHosts) {
      const resp = await fetch(`${hardenedServer.url}/api/v2/${host}/library/alpine/manifests/latest`);
      assert.equal(
        resp.status,
        403,
        `Hardened server must reject ${host} with 403 Forbidden (got ${resp.status})`
      );
      const body = await resp.json();
      assert.ok(body && typeof body.error === "string", `403 for ${host} must return JSON { error }`);
    }
  });

  suite.add("T2.4", "Path traversal blocked on /js/*, /web/*, and /wasm/*", async () => {
    const paths = [
      "/js/../Cargo.toml",
      "/web/..%2f..%2fetc/passwd",
      "/web/%2e%2e/Cargo.toml",
      "/wasm/../../Cargo.toml",
      "/web/..%5c..%5cCargo.toml",
    ];
    for (const p of paths) {
      const resp = await fetch(`${hardenedServer.url}${p}`);
      assert.ok(
        [400, 403, 404].includes(resp.status),
        `Traversal path ${p} must return 400/403/404 (got ${resp.status})`
      );
      const text = await resp.text();
      assertNotIncludes(text, "[workspace]", `Traversal ${p} leaked Cargo.toml`);
      assertNotIncludes(text, "root:x:0:0", `Traversal ${p} leaked /etc/passwd`);
    }
  });

  suite.add("T2.5", "Invalid blob digest formats rejected with 400 Bad Request JSON", async () => {
    const badDigests = [
      "sha256:nothex",
      "sha256:1234",
      "md5:d41d8cd98f00b204e9800998ecf8427e",
      "sha256:..%2f..%2f..%2fetc%2fpasswd",
    ];
    for (const d of badDigests) {
      const resp = await fetch(`${localServer.url}/api/v2/${registry.host}/library/alpine/blobs/${d}`);
      assert.equal(resp.status, 400, `Invalid digest ${d} must return 400 (got ${resp.status})`);
      const body = await resp.json();
      assert.ok(body && typeof body.error === "string", `400 for ${d} must return JSON { error }`);
    }
  });

  suite.add("T2.6", "Empty directories (typeFlag '5') preserved across OCI layers", async () => {
    const img = await getLayered();
    const container = await img.createContainer({
      entrypoint: ["/bin/sh", "-c"],
      cmd: ["test -d /app/empty_dir && test -d /var/empty_dir && test -d /opt/nested/empty && echo EMPTY_OK"],
      tty: false,
    });
    await container.start();
    const res = await container.wait();
    assert.equal(res.exitCode, 0);
    assertIncludes(stripAnsi(res.stdout), "EMPTY_OK");
  });

  suite.add("T2.7", "OCI whiteouts (.wh.<name> and .wh..wh..opq) applied cleanly with no leaked markers", async () => {
    const img = await getLayered();
    const script = [
      'test -f /app/keep.txt && echo KEEP_OK',
      'test ! -e /app/delete_me.txt && echo DEL_OK',
      'test ! -e /app/.wh.delete_me.txt && echo NO_WH_FILE',
      'test ! -e /app/opaque_dir/old_a.txt && test ! -e /app/opaque_dir/old_b.txt && echo OPQ_OLD_GONE',
      'test ! -e /app/opaque_dir/.wh..wh..opq && echo NO_OPQ_MARKER',
      'test -f /app/opaque_dir/new_c.txt && echo OPQ_NEW_OK',
      'cat /app/update.txt',
    ].join(" && ");
    const container = await img.createContainer({
      entrypoint: ["/bin/sh", "-c"],
      cmd: [script],
      tty: false,
    });
    await container.start();
    const res = await container.wait();
    assert.equal(res.exitCode, 0);
    const out = stripAnsi(res.stdout);
    assertIncludes(out, "KEEP_OK");
    assertIncludes(out, "DEL_OK");
    assertIncludes(out, "NO_WH_FILE");
    assertIncludes(out, "OPQ_OLD_GONE");
    assertIncludes(out, "NO_OPQ_MARKER");
    assertIncludes(out, "OPQ_NEW_OK");
    assertIncludes(out, "version-2");
    assertNotIncludes(out, "version-1");
  });

  suite.add("T2.8", "Non-ELF executable returns -ENOEXEC cleanly without crashing shell/WASM", async () => {
    const img = await getAlpine();
    const script = [
      "printf '\\x7fNOT_ELF_BINARY_DATA\\n' > /tmp/not_an_elf",
      "chmod 0755 /tmp/not_an_elf",
      "/tmp/not_an_elf 2>/dev/null; RC=$?",
      'echo "BAD_RC=$RC"',
      'echo "STILL_ALIVE"',
    ].join("; ");
    const container = await img.createContainer({
      cmd: ["/bin/sh", "-c", script],
      tty: false,
    });
    await container.start();
    const res = await container.wait();
    assert.equal(res.exitCode, 0);
    const out = stripAnsi(res.stdout);
    assertIncludes(out, "STILL_ALIVE");
    assertNotIncludes(out, "BAD_RC=0");
  });

  suite.add("T2.9", "Large stdout (>128KB) streams cleanly without truncation or deadlock", async () => {
    const img = await getAlpine();
    // 2048 lines * 64 bytes (63 chars + '\n') = 131,072 bytes exact
    const line63 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde";
    const script = `i=0; while [ $i -lt 2048 ]; do echo "${line63}"; i=$((i+1)); done`;
    const container = await img.createContainer({
      cmd: ["/bin/sh", "-c", script],
      tty: false,
    });
    let totalBytes = 0;
    container.onStdout((chunk) => {
      totalBytes += chunk.byteLength;
    });
    await container.start();
    const res = await container.wait();
    assert.equal(res.exitCode, 0);
    assert.equal(totalBytes, 131072, `Expected exact 131072 bytes, got ${totalBytes}`);
  });

  suite.add("T2.10", "Memory hygiene: 25 sequential forked external commands complete without OOM", async () => {
    const img = await getAlpine();
    const script = 'i=1; while [ $i -le 25 ]; do /bin/uname -s > /dev/null; echo "ITER_$i"; i=$((i+1)); done';
    const container = await img.createContainer({
      cmd: ["/bin/sh", "-c", script],
      tty: false,
    });
    await container.start();
    const res = await container.wait();
    assert.equal(res.exitCode, 0);
    const out = stripAnsi(res.stdout);
    assertIncludes(out, "ITER_1");
    assertIncludes(out, "ITER_25");
  });

  suite.add("T2.11", "Ctrl-C (SIGINT) interrupts blocking foreground sleep and keeps shell alive", async () => {
    const img = await getAlpine();
    const container = await img.createContainer({ tty: true });
    let liveOut = "";
    const dec = new TextDecoder();
    container.onStdout((chunk) => {
      liveOut += dec.decode(chunk, { stream: true });
    });

    await container.start();
    try {
      container.writeStdin("echo $((1+1))\n");
      await waitFor(() => stripAnsi(liveOut).includes("2"), { timeoutMs: 25000, label: "shell ready" });

      const t0 = Date.now();
      container.writeStdin("sleep 30\n");
      await sleep(600);
      container.sendSignal("SIGINT");
      await sleep(300);
      container.writeStdin('printf "%s_%s\\n" AFTER SIGINT\n');
      await waitFor(() => stripAnsi(liveOut).includes("AFTER_SIGINT"), {
        timeoutMs: 10000,
        label: "AFTER_SIGINT output",
      });
      const elapsed = Date.now() - t0;
      assert.ok(elapsed < 15000, `SIGINT should interrupt sleep 30 promptly (took ${elapsed}ms)`);

      container.writeStdin("exit\n");
      await container.wait();
    } finally {
      await container.stop().catch(() => {});
    }
  });

  suite.add("T2.12", "EOF (closeStdin) terminates interactive shell cleanly with exitCode 0", async () => {
    const img = await getAlpine();
    const container = await img.createContainer({ tty: true });
    let liveOut = "";
    const dec = new TextDecoder();
    container.onStdout((chunk) => {
      liveOut += dec.decode(chunk, { stream: true });
    });

    await container.start();
    try {
      container.writeStdin('printf "%s_%s\\n" PRE EOF\n');
      await waitFor(() => stripAnsi(liveOut).includes("PRE_EOF"), { timeoutMs: 25000, label: "PRE_EOF" });
      container.closeStdin();
      const res = await Promise.race([
        container.wait(),
        sleep(15000).then(() => {
          throw new Error("Timed out waiting for shell to exit after closeStdin()");
        }),
      ]);
      assert.equal(res.exitCode, 0);
    } finally {
      await container.stop().catch(() => {});
    }
  });

  suite.add("T2.13", "Terminal resize updates TIOCGWINSZ (stty size)", async () => {
    const img = await getAlpine();
    const container = await img.createContainer({ tty: true, cols: 80, rows: 24 });
    let liveOut = "";
    const dec = new TextDecoder();
    container.onStdout((chunk) => {
      liveOut += dec.decode(chunk, { stream: true });
    });

    await container.start();
    try {
      container.writeStdin("stty size\n");
      await waitFor(() => stripAnsi(liveOut).includes("24 80"), { timeoutMs: 25000, label: "stty size 24 80" });

      container.resize(132, 43);
      container.writeStdin("stty size\n");
      await waitFor(() => stripAnsi(liveOut).includes("43 132"), { timeoutMs: 15000, label: "stty size 43 132" });

      container.writeStdin("exit\n");
      const res = await container.wait();
      assert.equal(res.exitCode, 0);
    } finally {
      await container.stop().catch(() => {});
    }
  });

  suite.add("T2.14", "python:3.12-slim non-zero exit codes & stderr (sys.exit(7), SyntaxError, unhandled exception)", async () => {
    const img = await getPython();

    const c1 = await img.createContainer({ cmd: ["python3", "-c", "import sys; sys.exit(7)"], tty: false });
    await c1.start();
    try {
      const r1 = await waitWithTimeout(c1.wait(), 120000, "T2.14 sys.exit(7)");
      assert.equal(r1.exitCode, 7);
    } finally {
      await c1.stop().catch(() => {});
    }

    const c2 = await img.createContainer({ cmd: ["python3", "-c", "def broken(:"], tty: false });
    await c2.start();
    try {
      const r2 = await waitWithTimeout(c2.wait(), 45000, "T2.14 SyntaxError");
      assert.notEqual(r2.exitCode, 0, "SyntaxError must exit non-zero");
      assertIncludes(stripAnsi(r2.stderr), "SyntaxError");
    } finally {
      await c2.stop().catch(() => {});
    }

    const c3 = await img.createContainer({ cmd: ["python3", "-c", "raise ValueError('BOOM_PY_ERR')"], tty: false });
    await c3.start();
    try {
      const r3 = await waitWithTimeout(c3.wait(), 45000, "T2.14 ValueError");
      assert.notEqual(r3.exitCode, 0, "Unhandled exception must exit non-zero");
      const err3 = stripAnsi(r3.stderr);
      assertIncludes(err3, "Traceback");
      assertIncludes(err3, "ValueError: BOOM_PY_ERR");
    } finally {
      await c3.stop().catch(() => {});
    }
  });

  suite.add("T2.15", "node:22-slim non-zero exit codes & stderr (process.exit(5), SyntaxError, uncaught exception)", async () => {
    const img = await getNode();

    const c1 = await img.createContainer({ cmd: ["node", "-e", "process.exit(5)"], tty: false });
    await c1.start();
    try {
      const r1 = await waitWithTimeout(c1.wait(), 180000, "T2.15 process.exit(5)");
      assert.equal(r1.exitCode, 5);
    } finally {
      await c1.stop().catch(() => {});
    }

    const c2 = await img.createContainer({ cmd: ["node", "-e", "function broken( {"], tty: false });
    await c2.start();
    try {
      const r2 = await waitWithTimeout(c2.wait(), 45000, "T2.15 SyntaxError");
      assert.notEqual(r2.exitCode, 0, "SyntaxError must exit non-zero");
      assertIncludes(stripAnsi(r2.stderr), "SyntaxError");
    } finally {
      await c2.stop().catch(() => {});
    }

    const c3 = await img.createContainer({ cmd: ["node", "-e", "throw new Error('BOOM_NODE_ERR')"], tty: false });
    await c3.start();
    try {
      const r3 = await waitWithTimeout(c3.wait(), 45000, "T2.15 uncaught Error");
      assert.notEqual(r3.exitCode, 0, "Uncaught Error must exit non-zero");
      assertIncludes(stripAnsi(r3.stderr), "Error: BOOM_NODE_ERR");
    } finally {
      await c3.stop().catch(() => {});
    }
  });

  suite.add("T2.16", "python:3.12-slim large stdout (>128 KiB) & 64 KiB stdin piping with exact SHA-256", async () => {
    const img = await getPython();
    const payload = "0123456789abcdef".repeat(4096);
    assert.equal(Buffer.byteLength(payload), 65536);
    const expectedSha16 = crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);

    const script =
      "import sys, hashlib; d = sys.stdin.buffer.read(); " +
      "print('STDIN_LEN=' + str(len(d)), 'SHA=' + hashlib.sha256(d).hexdigest()[:16]); " +
      "sys.stdout.write(('A'*63 + '\\n') * 2048)";
    const container = await img.createContainer({
      cmd: ["python3", "-c", script],
      tty: false,
    });
    let totalBytes = 0;
    container.onStdout((chunk) => {
      totalBytes += chunk.byteLength;
    });

    await container.start();
    try {
      container.writeStdin(payload);
      container.closeStdin();
      const res = await waitWithTimeout(container.wait(), 60000, "T2.16 python large stdin/stdout");
      assert.equal(res.exitCode, 0, `Expected exitCode 0, stderr: ${res.stderr}`);
      const out = stripAnsi(res.stdout);
      assertIncludes(out, "STDIN_LEN=65536");
      assertIncludes(out, `SHA=${expectedSha16}`);
      assert.ok(totalBytes > 131072, `Expected > 131072 stdout bytes, got ${totalBytes}`);
    } finally {
      await container.stop().catch(() => {});
    }
  });

  suite.add("T2.17", "node:22-slim large stdout (>128 KiB) & 64 KiB stdin piping with exact SHA-256", async () => {
    const img = await getNode();
    const payload = "0123456789abcdef".repeat(4096);
    assert.equal(Buffer.byteLength(payload), 65536);
    const expectedSha16 = crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);

    const script =
      "const fs=require('fs'), crypto=require('crypto'); " +
      "const d=fs.readFileSync(0); " +
      "console.log('STDIN_LEN='+d.length, 'SHA='+crypto.createHash('sha256').update(d).digest('hex').slice(0,16)); " +
      "process.stdout.write(('B'.repeat(63)+'\\n').repeat(2048));";
    const container = await img.createContainer({
      cmd: ["node", "-e", script],
      tty: false,
    });
    let totalBytes = 0;
    container.onStdout((chunk) => {
      totalBytes += chunk.byteLength;
    });

    await container.start();
    try {
      container.writeStdin(payload);
      container.closeStdin();
      const res = await waitWithTimeout(container.wait(), 60000, "T2.17 node large stdin/stdout");
      assert.equal(res.exitCode, 0, `Expected exitCode 0, stderr: ${res.stderr}`);
      const out = stripAnsi(res.stdout);
      assertIncludes(out, "STDIN_LEN=65536");
      assertIncludes(out, `SHA=${expectedSha16}`);
      assert.ok(totalBytes > 131072, `Expected > 131072 stdout bytes, got ${totalBytes}`);
    } finally {
      await container.stop().catch(() => {});
    }
  });

  suite.add("T2.18", "Unicode / UTF-8 multi-byte I/O in python:3.12-slim and node:22-slim", async () => {
    const payload = "café 日本語 🚀\n";

    const pyImg = await getPython();
    const pyContainer = await pyImg.createContainer({
      env: ["LANG=C.UTF-8", "PYTHONIOENCODING=utf-8"],
      cmd: [
        "python3",
        "-c",
        "import sys; s = sys.stdin.read().strip(); print(f'PY_U8:{s}|CHARS={len(s)}|BYTES={len(s.encode(\"utf-8\"))}')",
      ],
      tty: false,
    });
    await pyContainer.start();
    try {
      pyContainer.writeStdin(payload);
      pyContainer.closeStdin();
      const pyRes = await waitWithTimeout(pyContainer.wait(), 45000, "T2.18 python UTF-8");
      assert.equal(pyRes.exitCode, 0, `Python UTF-8 failed, stderr: ${pyRes.stderr}`);
      assertIncludes(stripAnsi(pyRes.stdout), "PY_U8:café 日本語 🚀|CHARS=10|BYTES=20");
    } finally {
      await pyContainer.stop().catch(() => {});
    }

    const nodeImg = await getNode();
    const nodeContainer = await nodeImg.createContainer({
      cmd: [
        "node",
        "-e",
        "const fs=require('fs'); const s=fs.readFileSync(0,'utf8').trim(); console.log(`NODE_U8:${s}|CHARS=${[...s].length}|BYTES=${Buffer.byteLength(s,'utf8')}`);",
      ],
      tty: false,
    });
    await nodeContainer.start();
    try {
      nodeContainer.writeStdin(payload);
      nodeContainer.closeStdin();
      const nodeRes = await waitWithTimeout(nodeContainer.wait(), 45000, "T2.18 node UTF-8");
      assert.equal(nodeRes.exitCode, 0, `Node UTF-8 failed, stderr: ${nodeRes.stderr}`);
      assertIncludes(stripAnsi(nodeRes.stdout), "NODE_U8:café 日本語 🚀|CHARS=10|BYTES=20");
    } finally {
      await nodeContainer.stop().catch(() => {});
    }
  });

  suite.add("T2.19", "python:3.12-slim custom env overrides (PYTHONUNBUFFERED=1) & live unbuffered stdout flushing", async () => {
    const img = await getPython();
    const container = await img.createContainer({
      env: ["PYTHONUNBUFFERED=1", "CUSTOM_PY_VAR=py_env_987", "LANG=C.UTF-8"],
      cmd: [
        "python3",
        "-c",
        "import os, sys; print('ENV=' + os.environ['PYTHONUNBUFFERED'] + ':' + os.environ['CUSTOM_PY_VAR']); line = sys.stdin.readline().strip(); print('GOT=' + line.upper())",
      ],
      tty: false,
    });
    let liveOut = "";
    let exited = false;
    const dec = new TextDecoder();
    container.onStdout((chunk) => {
      liveOut += dec.decode(chunk, { stream: true });
    });
    container.onExit(() => {
      exited = true;
    });

    await container.start();
    try {
      await waitFor(() => stripAnsi(liveOut).includes("ENV=1:py_env_987"), {
        timeoutMs: 30000,
        intervalMs: 150,
        label: "PYTHONUNBUFFERED=1 live stdout before EOF",
      });
      assert.equal(exited, false, "PYTHONUNBUFFERED=1 must flush stdout before container exits");

      container.writeStdin("done_42\n");
      container.closeStdin();
      const res = await waitWithTimeout(container.wait(), 20000, "T2.19 python unbuffered exit");
      assert.equal(res.exitCode, 0);
      assertIncludes(stripAnsi(res.stdout), "GOT=DONE_42");
    } finally {
      await container.stop().catch(() => {});
    }
  });

  suite.add("T2.20", "node:22-slim default NODE_OPTIONS injection (Contract §6) & strict user env override", async () => {
    const img = await getNode();

    // 1. Default injected environment variables
    const c1 = await img.createContainer({
      cmd: [
        "node",
        "-e",
        "console.log(JSON.stringify({no:process.env.NODE_OPTIONS||'',ma:process.env.MALLOC_ARENA_MAX||'',uio:process.env.UV_USE_IO_URING||'',utp:process.env.UV_THREADPOOL_SIZE||''}))",
      ],
      tty: false,
    });
    await c1.start();
    try {
      const r1 = await waitWithTimeout(c1.wait(), 45000, "T2.20 default node env");
      assert.equal(r1.exitCode, 0, `Expected exitCode 0, stderr: ${r1.stderr}`);
      const lines1 = stripAnsi(r1.stdout).trim().split("\n").filter(Boolean);
      const env1 = JSON.parse(lines1[lines1.length - 1]);
      assertIncludes(env1.no, "--jitless", "Default NODE_OPTIONS must include --jitless");
      assertIncludes(env1.no, "--v8-pool-size=1", "Default NODE_OPTIONS must include --v8-pool-size=1");
      assert.equal(env1.ma, "1", "Default MALLOC_ARENA_MAX must be 1");
      assert.equal(env1.uio, "0", "Default UV_USE_IO_URING must be 0");
      assert.equal(env1.utp, "1", "Default UV_THREADPOOL_SIZE must be 1");
    } finally {
      await c1.stop().catch(() => {});
    }

    // 2. Strict user env override
    const c2 = await img.createContainer({
      env: ["NODE_OPTIONS=--jitless --max-old-space-size=128", "CUSTOM_NODE_VAR=node_env_654"],
      cmd: [
        "node",
        "-e",
        "console.log(JSON.stringify({no:process.env.NODE_OPTIONS||'',cv:process.env.CUSTOM_NODE_VAR||''}))",
      ],
      tty: false,
    });
    await c2.start();
    try {
      const r2 = await waitWithTimeout(c2.wait(), 45000, "T2.20 user env override");
      assert.equal(r2.exitCode, 0, `Expected exitCode 0, stderr: ${r2.stderr}`);
      const lines2 = stripAnsi(r2.stdout).trim().split("\n").filter(Boolean);
      const env2 = JSON.parse(lines2[lines2.length - 1]);
      assert.equal(env2.no, "--jitless --max-old-space-size=128", "User NODE_OPTIONS override must strictly win");
      assert.equal(env2.cv, "node_env_654", "Custom user env var must be preserved");
    } finally {
      await c2.stop().catch(() => {});
    }
  });

  suite.add("T2.21", "Warm startup latency bounds (python:3.12-slim < 15s, node:22-slim < 30s)", async () => {
    const pyImg = await getPython();
    const tPy0 = Date.now();
    const pyC = await pyImg.createContainer({ cmd: ["python3", "-c", "print('FAST_PY')"], tty: false });
    await pyC.start();
    try {
      const pyRes = await waitWithTimeout(pyC.wait(), 30000, "T2.21 warm python startup");
      const pyElapsedMs = Date.now() - tPy0;
      assert.equal(pyRes.exitCode, 0);
      assertIncludes(stripAnsi(pyRes.stdout), "FAST_PY");
      assert.ok(pyElapsedMs < 15000, `Warm python:3.12-slim startup must be < 15000ms (took ${pyElapsedMs}ms)`);
    } finally {
      await pyC.stop().catch(() => {});
    }

    const nodeImg = await getNode();
    const tNode0 = Date.now();
    const nodeC = await nodeImg.createContainer({ cmd: ["node", "-e", "console.log('FAST_NODE')"], tty: false });
    await nodeC.start();
    try {
      const nodeRes = await waitWithTimeout(nodeC.wait(), 45000, "T2.21 warm node startup");
      const nodeElapsedMs = Date.now() - tNode0;
      assert.equal(nodeRes.exitCode, 0);
      assertIncludes(stripAnsi(nodeRes.stdout), "FAST_NODE");
      assert.ok(nodeElapsedMs < 30000, `Warm node:22-slim startup must be < 30000ms (took ${nodeElapsedMs}ms)`);
    } finally {
      await nodeC.stop().catch(() => {});
    }
  });

  // -------------------------------------------------------------------------
  // Git Repo Overlay Boundaries, Security & Error Handling (F25-F28, §7-§9)
  // -------------------------------------------------------------------------

  suite.add("T2.22", "Input validation 400 JSON matrix for /api/git/archive (missing/invalid repo & ref)", async () => {
    gitServer.clearRequests();

    const assert400Json = async (url, label) => {
      const resp = await fetch(url);
      assert.equal(resp.status, 400, `${label}: expected 400, got ${resp.status}`);
      let body;
      try {
        body = await resp.json();
      } catch (err) {
        assert.fail(`${label}: expected JSON error body, parse failed: ${err.message}`);
      }
      assert.equal(typeof body?.error, "string", `${label}: JSON must include string error field`);
      assert.ok(body.error.length > 0, `${label}: error message must be non-empty`);
    };

    // 1. Missing repo
    for (const qs of ["", "?ref=main", "?repo="]) {
      await assert400Json(`${localServer.url}/api/git/archive${qs}`, `missing repo (${qs || "empty"})`);
    }

    // 2. Invalid repo specs
    const badRepos = [
      "https://user:pass@github.com/owner/repo",
      "owner/../evil",
      "https://github.com/owner/../repo",
      "owner/repo\x00",
      "owner/repo\n",
      "http://github.com/owner/repo",
      "ftp://github.com/owner/repo",
      "file:///etc/passwd",
      "javascript:alert(1)",
    ];
    for (const repo of badRepos) {
      const qs = new URLSearchParams({ repo, ref: "main" });
      await assert400Json(`${localServer.url}/api/git/archive?${qs.toString()}`, `bad repo ${JSON.stringify(repo)}`);
    }

    // 3. Invalid refs paired with valid local mock repo (zero upstream hits expected)
    const validRepo = gitServer.repoUrl("testorg/demo");
    const badRefs = [
      "main branch",
      "main\ttab",
      "main..evil",
      "../secret",
      "HEAD~1",
      "HEAD^",
      "a:b",
      "v1?",
      "v1*",
      "v1[0]",
      "a\\b",
      "-main",
      "--upload-pack=x",
      "/main",
      "main/",
      "a".repeat(256),
      "main\x00",
      "main\n",
    ];
    for (const ref of badRefs) {
      const qs = new URLSearchParams({ repo: validRepo, ref });
      await assert400Json(`${localServer.url}/api/git/archive?${qs.toString()}`, `bad ref ${JSON.stringify(ref)}`);
    }

    assert.equal(gitServer.getRequests().length, 0, "Invalid repo/ref requests must be rejected before hitting upstream");
  });

  suite.add("T2.23", "SSRF 403 matrix on hardened /api/git/archive blocks loopback, private & link-local hosts", async () => {
    gitServer.clearRequests();

    const blockedRepos = [
      "https://127.0.0.1/org/repo",
      "https://[::1]/org/repo",
      "https://localhost/org/repo",
      "https://169.254.169.254/org/repo",
      "https://10.0.0.1/org/repo",
      "https://192.168.1.1/org/repo",
      gitServer.repoUrl("testorg/demo"),
    ];

    for (const repo of blockedRepos) {
      const qs = new URLSearchParams({ repo, ref: "main" });
      const resp = await fetch(`${hardenedServer.url}/api/git/archive?${qs.toString()}`);
      assert.equal(resp.status, 403, `Hardened server must block ${repo} with 403, got ${resp.status}`);
      const body = await resp.json();
      assert.equal(typeof body?.error, "string", `403 response for ${repo} must include JSON error string`);
    }

    assert.equal(gitServer.getRequests().length, 0, "No SSRF request may reach local mock git server");
  });

  suite.add("T2.24", "Upstream error propagation (404, 429, 502 JSON) on /api/git/archive and SDK rejection", async () => {
    const assertErrorStatus = async (repoUrl, ref, expectedStatus, label) => {
      const qs = new URLSearchParams({ repo: repoUrl, ref });
      const resp = await fetch(`${localServer.url}/api/git/archive?${qs.toString()}`);
      assert.equal(resp.status, expectedStatus, `${label}: expected ${expectedStatus}, got ${resp.status}`);
      const body = await resp.json();
      assert.equal(typeof body?.error, "string", `${label}: expected JSON { error }`);
      assert.ok(body.error.length > 0, `${label}: error string must be non-empty`);
    };

    await assertErrorStatus(gitServer.repoUrl("testorg/doesnotexist"), "main", 404, "unknown repo");
    await assertErrorStatus(gitServer.repoUrl("testorg/demo"), "nonexistent-ref-999", 404, "unknown ref");
    await assertErrorStatus(gitServer.repoUrl("error/ratelimit"), "main", 429, "upstream 429");
    await assertErrorStatus(gitServer.repoUrl("error/upstream500"), "main", 502, "upstream 500 -> 502");

    const deadPort = await getFreePort();
    await assertErrorStatus(`http://127.0.0.1:${deadPort}/testorg/demo`, "main", 502, "connection refused -> 502");

    const alpineImg = await getAlpine();
    await assert.rejects(
      () =>
        alpineImg.createContainer({
          gitRepo: { repo: gitServer.repoUrl("testorg/doesnotexist"), ref: "main" },
          cmd: ["/bin/sh", "-c", "echo unreachable"],
          tty: false,
        }),
      Error,
      "createContainer with 404 gitRepo must reject"
    );
  });

  suite.add("T2.25", "Tar overlay security: .. path traversal cannot escape mountPath & stripComponents skips root-only entries", async () => {
    const alpineImg = await getAlpine();
    const evilTar = createTar([
      { path: "repo-main/", type: "dir", mode: 0o755 },
      { path: "root_only_file.txt", type: "file", content: "SHOULD_BE_SKIPPED\n" },
      { path: "repo-main/../../etc/escaped_pwn.txt", type: "file", content: "PWN\n" },
      { path: "repo-main/sub/../../../tmp/escaped_tmp.txt", type: "file", content: "PWN\n" },
      { path: "repo-main/../../../escaped_root.txt", type: "file", content: "PWN\n" },
      { path: "repo-main/safe/", type: "dir", mode: 0o755 },
      { path: "repo-main/safe/ok.txt", type: "file", content: "SAFE_OK\n" },
    ]);

    const c = await alpineImg.createContainer({
      overlayTarBytes: evilTar,
      overlayMountPath: "/workspace",
      overlayStripComponents: 1,
      cmd: [
        "/bin/sh",
        "-c",
        [
          "set -eu",
          "cat /workspace/safe/ok.txt",
          "test ! -e /etc/escaped_pwn.txt",
          "test ! -e /tmp/escaped_tmp.txt",
          "test ! -e /escaped_root.txt",
          "test ! -e /root_only_file.txt",
          "test ! -e /workspace/root_only_file.txt",
          "echo TRAVERSAL_BLOCKED_OK",
        ].join(" && "),
      ],
      tty: false,
    });
    await c.start();
    try {
      const res = await waitWithTimeout(c.wait(), 45000, "T2.25 tar overlay traversal guard");
      assert.equal(res.exitCode, 0, `Traversal check failed (stderr: ${res.stderr})`);
      const out = stripAnsi(res.stdout);
      assertIncludes(out, "SAFE_OK");
      assertIncludes(out, "TRAVERSAL_BLOCKED_OK");
    } finally {
      await c.stop().catch(() => {});
    }
  });

  suite.add("T2.26", "Tar overlay edge cases: explicit cwd overrides mountPath & binary/UTF-8 byte integrity", async () => {
    const alpineImg = await getAlpine();

    // 1. Explicit cwd overrides mountPath
    const c1 = await alpineImg.createContainer({
      gitRepo: {
        repo: gitServer.repoUrl("testorg/demo"),
        ref: "main",
        mountPath: "/workspace",
      },
      cwd: "/tmp",
      cmd: ["/bin/sh", "-c", 'echo "CWD=$(pwd)|ENV_PWD=$PWD"; cat /workspace/README.md'],
      tty: false,
    });
    await c1.start();
    try {
      const r1 = await waitWithTimeout(c1.wait(), 45000, "T2.26 explicit cwd override");
      assert.equal(r1.exitCode, 0, `Explicit cwd override failed (stderr: ${r1.stderr})`);
      const out1 = stripAnsi(r1.stdout);
      assertIncludes(out1, "CWD=/tmp");
      assertIncludes(out1, "DEMO_OK");
    } finally {
      await c1.stop().catch(() => {});
    }

    // 2. Binary + UTF-8 byte-for-byte integrity across gzip + tar overlay
    const expectedBlobSha = crypto.createHash("sha256").update(BINARY_BLOB).digest("hex");
    const expectedUtf8Sha = crypto.createHash("sha256").update(Buffer.from(UTF8_TEXT, "utf8")).digest("hex");

    const c2 = await alpineImg.createContainer({
      gitRepo: {
        repo: gitServer.repoUrl("testorg/binutf8"),
        ref: "main",
        mountPath: "/workspace",
      },
      cmd: ["/bin/sh", "-c", "sha256sum /workspace/assets/blob.bin /workspace/docs/unicode.txt"],
      tty: false,
    });
    await c2.start();
    try {
      const r2 = await waitWithTimeout(c2.wait(), 45000, "T2.26 binary+UTF-8 sha256sum");
      assert.equal(r2.exitCode, 0, `Binary+UTF-8 sha256sum failed (stderr: ${r2.stderr})`);
      const out2 = stripAnsi(r2.stdout);
      assertIncludes(out2, expectedBlobSha, "Guest sha256sum for blob.bin must match host SHA-256");
      assertIncludes(out2, expectedUtf8Sha, "Guest sha256sum for unicode.txt must match host SHA-256");

      const readBlob = await c2.readFile("/workspace/assets/blob.bin");
      assert.ok(readBlob instanceof Uint8Array, "readFile(blob.bin) must return Uint8Array");
      assert.equal(Buffer.compare(Buffer.from(readBlob), Buffer.from(BINARY_BLOB)), 0, "blob.bin bytes must match exactly");

      const readUtf8 = await c2.readFile("/workspace/docs/unicode.txt");
      assert.ok(readUtf8 instanceof Uint8Array, "readFile(unicode.txt) must return Uint8Array");
      assert.equal(new TextDecoder().decode(readUtf8), UTF8_TEXT, "unicode.txt UTF-8 content must match exactly");
    } finally {
      await c2.stop().catch(() => {});
    }
  });

  try {
    return await suite.run(opts);
  } finally {
    await localServer.close();
    await hardenedServer.close();
    await gitServer.close();
    await registry.close();
  }
}
