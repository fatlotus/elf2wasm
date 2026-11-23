// Tier 1: Isolated Feature Happy Paths (Opaque-Box E2E)
// Covers PROJECT.md Interface Contracts §1-§3 and Features F1-F11.

import fs from "node:fs";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  assert,
  assertIncludes,
  stripAnsi,
  waitFor,
  Suite,
} from "./helpers/test_runner.mjs";
import { startMockOciRegistry } from "./helpers/mock_oci_registry.mjs";
import { REQUIRED_ARTIFACTS, startServer } from "./helpers/server_harness.mjs";

function assertCoopCoep(headers, label) {
  assert.equal(
    headers.get("cross-origin-opener-policy"),
    "same-origin",
    `${label}: missing COOP same-origin`
  );
  assert.equal(
    headers.get("cross-origin-embedder-policy"),
    "require-corp",
    `${label}: missing COEP require-corp`
  );
}

export async function runTier1(opts = {}) {
  const sdk = await import(pathToFileURL(REQUIRED_ARTIFACTS.dockerSdk).href);
  const { Elf2WasmDocker, parseImageRef, runDockerImage } = sdk;

  const registry = await startMockOciRegistry({ requireAuth: true, redirectBlobs: true });
  const server = await startServer({ allowLocalRegistries: true });

  const sdkOpts = {
    compilerWasmUrl: `${server.url}/wasm/elf2wasm_compiler_wasm.wasm`,
    runtimeWasmUrl: `${server.url}/wasm/elf2wasm_runtime_wasm.wasm`,
    registryProxyBase: `${server.url}/api/v2`,
    useWorker: false,
  };

  let sharedDocker = null;
  let sharedAlpineImage = null;
  let alpineAmd64Digest = null;
  let alpineLayerDigest = null;

  const suite = new Suite("Tier 1 (Features)");

  suite.add("T1.1.1", "GET / serves web/index.html with COOP/COEP and key DOM IDs", async () => {
    const resp = await fetch(`${server.url}/`);
    assert.equal(resp.status, 200);
    assertIncludes(resp.headers.get("content-type") || "", "text/html");
    assertCoopCoep(resp.headers, "GET /");
    const html = await resp.text();
    assertIncludes(html, 'id="image-input"', "index.html should contain #image-input");
    assertIncludes(html, 'id="terminal"', "index.html should contain #terminal");
    assertIncludes(html, 'id="start-btn"', "index.html should contain #start-btn");
  });

  suite.add("T1.1.2", "GET /js/docker_sdk.mjs & /js/container_worker.mjs serve ESM with COOP/COEP", async () => {
    for (const p of ["/js/docker_sdk.mjs", "/js/container_worker.mjs"]) {
      const resp = await fetch(`${server.url}${p}`);
      assert.equal(resp.status, 200, `${p} status`);
      assertIncludes(resp.headers.get("content-type") || "", "javascript", `${p} content-type`);
      assertCoopCoep(resp.headers, `GET ${p}`);
      const text = await resp.text();
      assert.ok(text.length > 0, `${p} non-empty`);
    }
  });

  suite.add("T1.1.3", "GET /wasm/*.wasm serves valid WASM binaries with application/wasm & COOP/COEP", async () => {
    for (const name of ["elf2wasm_compiler_wasm.wasm", "elf2wasm_runtime_wasm.wasm"]) {
      const resp = await fetch(`${server.url}/wasm/${name}`);
      assert.equal(resp.status, 200, `${name} status`);
      assertIncludes(resp.headers.get("content-type") || "", "application/wasm", `${name} content-type`);
      assertCoopCoep(resp.headers, `GET /wasm/${name}`);
      const buf = new Uint8Array(await resp.arrayBuffer());
      assert.ok(buf.length > 8, `${name} size`);
      assert.deepEqual(Array.from(buf.subarray(0, 4)), [0x00, 0x61, 0x73, 0x6d], `${name} \\0asm magic`);
    }
  });

  suite.add("T1.1.4", "GET /api/health returns 200 JSON { ok: true, mode: 'client-side-wasm' }", async () => {
    const resp = await fetch(`${server.url}/api/health`);
    assert.equal(resp.status, 200);
    assertCoopCoep(resp.headers, "GET /api/health");
    const json = await resp.json();
    assert.equal(json.ok, true);
    assert.equal(json.mode, "client-side-wasm");
  });

  suite.add("T1.1.5", "OCI Proxy negotiates 401 Bearer auth for multi-arch manifest", async () => {
    registry.clearRequests();
    const resp = await fetch(`${server.url}/api/v2/${registry.host}/library/alpine/manifests/latest`);
    assert.equal(resp.status, 200);
    assert.ok(resp.headers.get("content-type"), "Content-Type preserved");
    assert.ok(resp.headers.get("docker-content-digest"), "Docker-Content-Digest preserved");
    const index = await resp.json();
    assert.ok(Array.isArray(index.manifests), "Expected multi-arch Image Index");
    const amd64 = index.manifests.find((m) => m.platform?.os === "linux" && m.platform?.architecture === "amd64");
    assert.ok(amd64 && amd64.digest, "Image Index must contain linux/amd64 descriptor");
    alpineAmd64Digest = amd64.digest;

    const reqs = registry.getRequests();
    assert.ok(reqs.some((r) => r.status === 401), "Mock registry should have issued 401 Bearer challenge");
    assert.ok(reqs.some((r) => r.path === "/token" && r.status === 200), "Proxy should have fetched /token");
  });

  suite.add("T1.1.7", "OCI Proxy resolves linux/amd64 manifest by digest", async () => {
    assert.ok(alpineAmd64Digest, "Requires T1.1.5 digest");
    const resp = await fetch(`${server.url}/api/v2/${registry.host}/library/alpine/manifests/${alpineAmd64Digest}`);
    assert.equal(resp.status, 200);
    const manifest = await resp.json();
    assert.ok(manifest.config?.digest, "Manifest must contain config.digest");
    assert.ok(Array.isArray(manifest.layers) && manifest.layers.length >= 1, "Manifest must contain layers");
    alpineLayerDigest = manifest.layers[0].digest;
  });

  suite.add("T1.1.6", "OCI Proxy follows cross-origin 302 blob redirect and strips Authorization", async () => {
    assert.ok(alpineLayerDigest, "Requires T1.1.7 layer digest");
    registry.clearRequests();
    const resp = await fetch(`${server.url}/api/v2/${registry.host}/library/alpine/blobs/${alpineLayerDigest}`);
    assert.equal(resp.status, 200);
    const contentLength = resp.headers.get("content-length");
    const bytes = new Uint8Array(await resp.arrayBuffer());
    if (contentLength) {
      assert.equal(Number(contentLength), bytes.length, "Content-Length must match streamed bytes");
    }
    assert.equal(bytes[0], 0x1f, "Raw gzip byte 0");
    assert.equal(bytes[1], 0x8b, "Raw gzip byte 1");
    const actualDigest = `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
    assert.equal(actualDigest, alpineLayerDigest, "Streamed blob SHA-256 must match requested digest");
    assert.equal(registry.leakedAuthCount(), 0, "Authorization header must NEVER leak on cross-origin 302 redirect");
    assert.ok(
      registry.getRequests((r) => r.server === "blob" && r.status === 200).length >= 1,
      "Blob CDN server must have served the redirected blob"
    );
  });

  suite.add("T1.2.1", "parseImageRef normalizes shorthand, tags, registries, host:port, and digests", () => {
    const r1 = parseImageRef("alpine");
    assert.equal(r1.registry, "registry-1.docker.io");
    assert.equal(r1.repository, "library/alpine");
    assert.equal(r1.reference, "latest");
    assert.equal(r1.canonical, "registry-1.docker.io/library/alpine:latest");

    const r2 = parseImageRef("alpine:3.20");
    assert.equal(r2.registry, "registry-1.docker.io");
    assert.equal(r2.repository, "library/alpine");
    assert.equal(r2.reference, "3.20");

    const r3 = parseImageRef("myorg/app:v1");
    assert.equal(r3.registry, "registry-1.docker.io");
    assert.equal(r3.repository, "myorg/app");
    assert.equal(r3.reference, "v1");

    const r4 = parseImageRef("ghcr.io/org/img:tag");
    assert.equal(r4.registry, "ghcr.io");
    assert.equal(r4.repository, "org/img");
    assert.equal(r4.reference, "tag");

    const r5 = parseImageRef("127.0.0.1:5000/library/alpine:latest");
    assert.equal(r5.registry, "127.0.0.1:5000");
    assert.equal(r5.repository, "library/alpine");
    assert.equal(r5.reference, "latest");

    const digest = "sha256:" + "a".repeat(64);
    const r6 = parseImageRef(`alpine@${digest}`);
    assert.equal(r6.registry, "registry-1.docker.io");
    assert.equal(r6.repository, "library/alpine");
    assert.equal(r6.reference, digest);
  });

  suite.add("T1.2.2", "Elf2WasmDocker.create instantiates cleanly with Node direct fallback", async () => {
    sharedDocker = await Elf2WasmDocker.create(sdkOpts);
    assert.ok(sharedDocker, "Elf2WasmDocker instance created");
    assert.equal(typeof sharedDocker.pullImage, "function");
    assert.equal(typeof sharedDocker.loadOciTarball, "function");
  });

  suite.add("T1.2.3", "docker.pullImage resolves multi-arch index to linux/amd64 with progress events", async () => {
    const progressEvents = [];
    sharedAlpineImage = await sharedDocker.pullImage(registry.imageRef("library/alpine", "latest"), {
      platform: "linux/amd64",
      onProgress: (ev) => progressEvents.push(ev),
    });
    assert.ok(sharedAlpineImage, "DockerImage returned");
    assert.ok(sharedAlpineImage.ref, "image.ref present");
    assert.ok(sharedAlpineImage.digest, "image.digest present");
    assert.ok(sharedAlpineImage.config, "image.config present");
    assert.ok(Array.isArray(sharedAlpineImage.layers) && sharedAlpineImage.layers.length >= 1, "image.layers populated");
    assert.ok(progressEvents.length >= 1, "onProgress should receive at least one progress event");
    assert.ok(progressEvents.some((e) => typeof e.stage === "string"), "Progress events must have stage");
  });

  suite.add("T1.2.4", "docker.loadOciTarball loads offline OCI tarball without registry network calls", async () => {
    registry.clearRequests();
    const tarBytes = registry.getOciTarball("library/alpine", "latest");
    const offlineImage = await sharedDocker.loadOciTarball(tarBytes);
    assert.ok(offlineImage, "Offline DockerImage returned");
    assert.equal(registry.getRequests().length, 0, "loadOciTarball must not hit mock registry");

    const container = await offlineImage.createContainer({
      cmd: ["/bin/sh", "-c", "echo $((19+23))"],
      tty: false,
    });
    await container.start();
    const res = await container.wait();
    assert.equal(res.exitCode, 0);
    assertIncludes(stripAnsi(res.stdout), "42");
  });

  suite.add("T1.2.5", "runDockerImage executes one-shot Alpine command cleanly", async () => {
    const res = await runDockerImage(registry.imageRef("library/alpine", "latest"), {
      ...sdkOpts,
      cmd: ["/bin/sh", "-c", "echo $((21+21))"],
      tty: false,
    });
    assert.equal(res.exitCode, 0);
    assertIncludes(stripAnsi(res.stdout), "42");
  });

  suite.add("T1.2.6", "createContainer honors custom env and cwd overrides", async () => {
    const container = await sharedAlpineImage.createContainer({
      env: ["FOO=bar_baz_99"],
      cwd: "/tmp",
      cmd: ["/bin/sh", "-c", "pwd && echo $FOO"],
      tty: false,
    });
    await container.start();
    const res = await container.wait();
    assert.equal(res.exitCode, 0);
    const out = stripAnsi(res.stdout);
    assertIncludes(out, "/tmp");
    assertIncludes(out, "bar_baz_99");
  });

  suite.add("T1.3.1", "Client-side execution proof: SDK only makes GET /wasm & /api/v2 calls and server rejects compile/exec/POST", async () => {
    // (a) Spy on globalThis.fetch during a real runDockerImage call
    const serverOrigin = new URL(server.url).origin;
    const recorded = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const urlStr = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method || (typeof input === "object" && "method" in input ? input.method : "GET") || "GET").toUpperCase();
      try {
        const parsed = new URL(urlStr);
        if (parsed.origin === serverOrigin) {
          recorded.push({ method, pathname: parsed.pathname, url: urlStr });
        }
      } catch {
        // non-absolute URL; ignore
      }
      return origFetch(input, init);
    };

    try {
      const res = await runDockerImage(registry.imageRef("library/alpine", "latest"), {
        ...sdkOpts,
        cmd: ["/bin/sh", "-c", "echo CLIENT_$((20+22))"],
        tty: false,
      });
      assert.equal(res.exitCode, 0);
      assertIncludes(stripAnsi(res.stdout), "CLIENT_42");
    } finally {
      globalThis.fetch = origFetch;
    }

    assert.ok(recorded.length > 0, "Fetch spy must observe real HTTP requests to server.url");
    for (const req of recorded) {
      assert.equal(req.method, "GET", `SDK must only issue GET requests to server, saw ${req.method} ${req.pathname}`);
      assert.ok(
        !/\/(compile|exec)\b/i.test(req.pathname),
        `SDK must never call compile/exec endpoints, saw ${req.pathname}`
      );
      const allowedPath =
        /^\/wasm\/[^/]+\.wasm$/.test(req.pathname) ||
        req.pathname.startsWith("/api/v2/") ||
        req.pathname === "/api/health";
      assert.ok(
        allowedPath,
        `SDK requested unexpected server route: ${req.method} ${req.pathname}`
      );
    }

    // (b) Directly probe forbidden server-side compile/exec/POST routes
    const forbiddenProbes = [
      { method: "POST", path: "/api/compile" },
      { method: "POST", path: "/api/exec" },
      { method: "GET", path: "/api/compile" },
      { method: "GET", path: "/api/exec" },
      { method: "POST", path: `/api/v2/${registry.host}/library/alpine/manifests/latest` },
    ];
    for (const probe of forbiddenProbes) {
      const resp = await fetch(`${server.url}${probe.path}`, { method: probe.method });
      assert.ok(
        resp.status === 404 || resp.status === 405,
        `Expected 404 or 405 for ${probe.method} ${probe.path}, got ${resp.status}`
      );
    }

    assert.equal(registry.leakedAuthCount(), 0);
  });

  suite.add("T1.4.1", "Interactive TTY shell: echo, pwd, cd, ls with computed outputs", async () => {
    const container = await sharedAlpineImage.createContainer({ tty: true });
    let liveOut = "";
    const decoder = new TextDecoder();
    container.onStdout((chunk) => {
      liveOut += decoder.decode(chunk, { stream: true });
    });

    await container.start();
    try {
      container.writeStdin("echo $((10+5))\n");
      await waitFor(() => stripAnsi(liveOut).includes("15"), { timeoutMs: 30000, label: "echo 15" });

      container.writeStdin("pwd\n");
      await waitFor(() => /\n\/\s*\n|^\/\s*\n/.test(stripAnsi(liveOut)), { timeoutMs: 15000, label: "pwd /" });

      container.writeStdin('cd /etc && printf "CWD=%s\\n" "$(pwd)"\n');
      await waitFor(() => stripAnsi(liveOut).includes("CWD=/etc"), { timeoutMs: 15000, label: "cd /etc" });

      container.writeStdin("ls /\n");
      await waitFor(() => {
        const clean = stripAnsi(liveOut);
        return clean.includes("bin") && clean.includes("etc") && clean.includes("tmp");
      }, { timeoutMs: 15000, label: "ls /" });

      container.writeStdin("exit\n");
      const res = await container.wait();
      assert.equal(res.exitCode, 0);
    } finally {
      await container.stop().catch(() => {});
    }
  });

  suite.add("T1.4.2", "Interactive shell: file creation and cat", async () => {
    const container = await sharedAlpineImage.createContainer({
      cmd: ["/bin/sh", "-c", 'printf "%s_%s\\n" hello vfs > /tmp/t1.txt && cat /tmp/t1.txt'],
      tty: false,
    });
    await container.start();
    const res = await container.wait();
    assert.equal(res.exitCode, 0);
    assertIncludes(stripAnsi(res.stdout), "hello_vfs");
  });

  suite.add("T1.4.3", "uname -a reports Linux and x86_64", async () => {
    const container = await sharedAlpineImage.createContainer({
      cmd: ["/bin/sh", "-c", "uname -a"],
      tty: false,
    });
    await container.start();
    const res = await container.wait();
    assert.equal(res.exitCode, 0);
    const out = stripAnsi(res.stdout);
    assertIncludes(out, "Linux");
    assertIncludes(out, "x86_64");
  });

  suite.add("T1.4.4", "env prints PATH and container environment", async () => {
    const container = await sharedAlpineImage.createContainer({
      cmd: ["/bin/sh", "-c", "env"],
      tty: false,
    });
    await container.start();
    const res = await container.wait();
    assert.equal(res.exitCode, 0);
    assertIncludes(stripAnsi(res.stdout), "PATH=");
  });

  suite.add("T1.4.7", "Default Docker container runs as UID 0 and GID 0", async () => {
    const container = await sharedAlpineImage.createContainer({
      cmd: ["/bin/sh", "-c", 'echo "UID=$(id -u) GID=$(id -g)"'],
      tty: false,
    });
    await container.start();
    const res = await container.wait();
    assert.equal(res.exitCode, 0);
    assertIncludes(stripAnsi(res.stdout), "UID=0 GID=0");
  });

  suite.add("T1.4.8", "Live streaming: onStdout and onStderr fire before container exit", async () => {
    const container = await sharedAlpineImage.createContainer({ tty: false });
    const decOut = new TextDecoder();
    const decErr = new TextDecoder();
    let streamedOut = "";
    let streamedErr = "";
    let exited = false;

    container.onStdout((chunk) => {
      streamedOut += decOut.decode(chunk, { stream: true });
    });
    container.onStderr((chunk) => {
      streamedErr += decErr.decode(chunk, { stream: true });
    });
    container.onExit(() => {
      exited = true;
    });

    await container.start();
    try {
      container.writeStdin('printf "%s_%s\\n" STREAM ONE; printf "%s_%s\\n" ERR ONE >&2\n');
      await waitFor(
        () => stripAnsi(streamedOut).includes("STREAM_ONE") && stripAnsi(streamedErr).includes("ERR_ONE"),
        { timeoutMs: 25000, label: "live stdout/stderr before exit" }
      );
      assert.equal(exited, false, "Callbacks must fire BEFORE container exits");
      container.writeStdin("exit\n");
      const res = await container.wait();
      assert.equal(res.exitCode, 0);
    } finally {
      await container.stop().catch(() => {});
    }
  });

  suite.add("T1.5.1", "Virtual /dev/null, /dev/zero, /dev/urandom work cleanly", async () => {
    const cmd = [
      "echo hi > /dev/null",
      "N=$(cat /dev/null | wc -c | tr -d ' ')",
      "Z=$(dd if=/dev/zero bs=16 count=1 2>/dev/null | wc -c | tr -d ' ')",
      "U=$(dd if=/dev/urandom bs=8 count=1 2>/dev/null | wc -c | tr -d ' ')",
      'echo "DEV=$N:$Z:$U"',
    ].join(" && ");
    const container = await sharedAlpineImage.createContainer({
      cmd: ["/bin/sh", "-c", cmd],
      tty: false,
    });
    await container.start();
    const res = await container.wait();
    assert.equal(res.exitCode, 0);
    assertIncludes(stripAnsi(res.stdout), "DEV=0:16:8");
  });

  suite.add("T1.5.2", "Virtual /proc/self/cmdline, /proc/self/fd, /proc/version, /proc/uptime exist", async () => {
    const cmd = "test -r /proc/self/cmdline && test -d /proc/self/fd && test -r /proc/version && test -r /proc/uptime && echo PROC_OK";
    const container = await sharedAlpineImage.createContainer({
      cmd: ["/bin/sh", "-c", cmd],
      tty: false,
    });
    await container.start();
    const res = await container.wait();
    assert.equal(res.exitCode, 0);
    assertIncludes(stripAnsi(res.stdout), "PROC_OK");
  });

  suite.add("T1.5.3", "#! shebang execution and access(X_OK) execute bit check", async () => {
    const cmd = [
      "printf '#!/bin/sh\\necho SHEBANG_%s\\n' '$1' > /tmp/run.sh",
      "chmod 0644 /tmp/run.sh",
      "if test -x /tmp/run.sh; then echo BAD_X; else echo NO_X_OK; fi",
      "chmod 0755 /tmp/run.sh",
      "/tmp/run.sh WORKS",
    ].join(" && ");
    const container = await sharedAlpineImage.createContainer({
      cmd: ["/bin/sh", "-c", cmd],
      tty: false,
    });
    await container.start();
    const res = await container.wait();
    assert.equal(res.exitCode, 0);
    const out = stripAnsi(res.stdout);
    assertIncludes(out, "NO_X_OK");
    assertIncludes(out, "SHEBANG_WORKS");
  });

  suite.add("T1.6.1", "elf2wasm_runtime_wasm.wasm exports all 12 Contract §1 C-ABI functions", async () => {
    const wasmBytes = fs.readFileSync(REQUIRED_ARTIFACTS.runtimeWasm);
    const mod = await WebAssembly.compile(wasmBytes);
    const exportNames = new Set(WebAssembly.Module.exports(mod).map((e) => e.name));
    const required = [
      "runtime_on_yield",
      "runtime_push_stdin",
      "runtime_close_stdin",
      "runtime_drain_stdout",
      "runtime_drain_stderr",
      "runtime_take_reaped_pids",
      "runtime_set_winsize",
      "runtime_set_tty_mode",
      "runtime_send_sigint",
      "runtime_set_uid_gid",
      "runtime_add_vfs_dir",
      "runtime_remove_vfs_path",
    ];
    for (const sym of required) {
      assert.ok(exportNames.has(sym), `Missing Contract §1 export in runtime-wasm: ${sym}`);
    }
  });

  try {
    return await suite.run(opts);
  } finally {
    await server.close();
    await registry.close();
  }
}
