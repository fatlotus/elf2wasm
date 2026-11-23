// Tier 2: Boundaries, Security, Error Handling & Stress (Opaque-Box E2E)
// Runs both a hardened server (no --allow-local-registries) and a local-mock server.

import { pathToFileURL } from "node:url";
import {
  assert,
  assertIncludes,
  assertNotIncludes,
  stripAnsi,
  sleep,
  waitFor,
  Suite,
} from "./helpers/test_runner.mjs";
import { startMockOciRegistry } from "./helpers/mock_oci_registry.mjs";
import { REQUIRED_ARTIFACTS, startServer } from "./helpers/server_harness.mjs";

export async function runTier2(opts = {}) {
  const sdk = await import(pathToFileURL(REQUIRED_ARTIFACTS.dockerSdk).href);
  const { Elf2WasmDocker, parseImageRef } = sdk;

  const registry = await startMockOciRegistry({ requireAuth: true, redirectBlobs: true });
  const hardenedServer = await startServer({ allowLocalRegistries: false });
  const localServer = await startServer({ allowLocalRegistries: true });

  const sdkOpts = {
    compilerWasmUrl: `${localServer.url}/wasm/elf2wasm_compiler_wasm.wasm`,
    runtimeWasmUrl: `${localServer.url}/wasm/elf2wasm_runtime_wasm.wasm`,
    registryProxyBase: `${localServer.url}/api/v2`,
    useWorker: false,
  };

  const docker = await Elf2WasmDocker.create(sdkOpts);
  let alpineImage = null;
  let layeredImage = null;

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

  try {
    return await suite.run(opts);
  } finally {
    await localServer.close();
    await hardenedServer.close();
    await registry.close();
  }
}
