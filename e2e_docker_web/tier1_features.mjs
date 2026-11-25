// Tier 1: Isolated Feature Happy Paths (Opaque-Box E2E)
// Covers PROJECT.md Interface Contracts §1-§3 and Features F1-F11.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  assert,
  assertIncludes,
  assertMatch,
  stripAnsi,
  skip,
  waitFor,
  waitWithTimeout,
  Suite,
} from "./helpers/test_runner.mjs";
import { startMockOciRegistry } from "./helpers/mock_oci_registry.mjs";
import { startMockGitServer } from "./helpers/mock_git_server.mjs";
import { createTar, parseTarEntries } from "./helpers/tar_builder.mjs";
import { REPO_ROOT, REQUIRED_ARTIFACTS, findChromeBinary, startServer } from "./helpers/server_harness.mjs";
import { launchCdpBrowser } from "./helpers/cdp_browser.mjs";

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

function assertGitSecurityHeaders(headers, label) {
  assertCoopCoep(headers, label);
  assert.ok(
    headers.get("cross-origin-resource-policy"),
    `${label}: missing Cross-Origin-Resource-Policy header`
  );
  assert.equal(
    headers.get("x-content-type-options"),
    "nosniff",
    `${label}: missing X-Content-Type-Options: nosniff`
  );
}

export async function runTier1(opts = {}) {
  const sdk = await import(pathToFileURL(REQUIRED_ARTIFACTS.dockerSdk).href);
  const { Elf2WasmDocker, parseImageRef, runDockerImage } = sdk;

  const registry = await startMockOciRegistry({ requireAuth: true, redirectBlobs: true });
  const gitServer = await startMockGitServer({ redirectArchives: true });
  const server = await startServer({ allowLocalRegistries: true });

  const GIT_SHA_40 = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
  const makeSampleRepoEntries = (refLabel) => [
    { path: `sample-${refLabel}/`, type: "dir", mode: 0o755 },
    { path: `sample-${refLabel}/README.md`, type: "file", content: `REF=${refLabel}\n` },
    { path: `sample-${refLabel}/src/`, type: "dir", mode: 0o755 },
    { path: `sample-${refLabel}/src/data.txt`, type: "file", content: "HARDLINK_TARGET_DATA\n" },
    {
      path: `sample-${refLabel}/src/data_hardlink.txt`,
      type: "hardlink",
      linkname: `sample-${refLabel}/src/data.txt`,
    },
    {
      path: `sample-${refLabel}/src/link_to_readme.txt`,
      type: "symlink",
      linkname: "../README.md",
    },
    { path: `sample-${refLabel}/bin/`, type: "dir", mode: 0o755 },
    {
      path: `sample-${refLabel}/bin/check.sh`,
      type: "file",
      mode: 0o755,
      content: "#!/bin/sh\necho SCRIPT_OK\n",
    },
  ];

  gitServer.addRepo("testorg/sample", {
    HEAD: makeSampleRepoEntries("HEAD"),
    main: makeSampleRepoEntries("main"),
    "v1.2.3": makeSampleRepoEntries("v1.2.3"),
    [GIT_SHA_40]: makeSampleRepoEntries(GIT_SHA_40),
  });

  const sdkOpts = {
    compilerWasmUrl: `${server.url}/wasm/elf2wasm_compiler_wasm.wasm`,
    runtimeWasmUrl: `${server.url}/wasm/elf2wasm_runtime_wasm.wasm`,
    registryProxyBase: `${server.url}/api/v2`,
    gitProxyBase: `${server.url}/api/git/archive`,
    useWorker: false,
  };

  let sharedDocker = null;
  let sharedAlpineImage = null;
  let sharedPythonImage = null;
  let sharedNodeImage = null;
  let alpineAmd64Digest = null;
  let alpineLayerDigest = null;

  async function getAlpine() {
    if (!sharedDocker) sharedDocker = await Elf2WasmDocker.create(sdkOpts);
    if (!sharedAlpineImage) {
      sharedAlpineImage = await sharedDocker.pullImage(registry.imageRef("library/alpine", "latest"));
    }
    return sharedAlpineImage;
  }

  async function getPython() {
    if (!sharedDocker) sharedDocker = await Elf2WasmDocker.create(sdkOpts);
    if (!sharedPythonImage) {
      const ref = registry.ensureBuiltinFixture("python");
      sharedPythonImage = await sharedDocker.pullImage(ref);
    }
    return sharedPythonImage;
  }

  async function getNode() {
    if (!sharedDocker) sharedDocker = await Elf2WasmDocker.create(sdkOpts);
    if (!sharedNodeImage) {
      const ref = registry.ensureBuiltinFixture("node");
      sharedNodeImage = await sharedDocker.pullImage(ref);
    }
    return sharedNodeImage;
  }

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

  suite.add("T1.1.8", "GET / includes python:3.12-slim and node:22-slim preset chips while keeping alpine:latest default", async () => {
    const resp = await fetch(`${server.url}/`);
    assert.equal(resp.status, 200);
    assertCoopCoep(resp.headers, "GET / presets");
    const html = await resp.text();
    assertIncludes(html, 'class="presets-row"', "index.html must contain .presets-row");
    assertMatch(
      html,
      /<input[^>]*id="image-input"[^>]*value="alpine:latest"|<input[^>]*value="alpine:latest"[^>]*id="image-input"/s,
      "#image-input must retain default value='alpine:latest'"
    );
    for (const preset of [
      "alpine:latest",
      "busybox:latest",
      "debian:bookworm-slim",
      "python:3.12-slim",
      "node:22-slim",
    ]) {
      assertIncludes(html, `data-image="${preset}"`, `Missing preset chip data-image="${preset}"`);
    }
    for (const preset of ["python:3.12-slim", "node:22-slim"]) {
      const escaped = preset.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      assertMatch(
        html,
        new RegExp(
          `<button[^>]*class="[^"]*preset-chip[^"]*"[^>]*data-image="${escaped}"|<button[^>]*data-image="${escaped}"[^>]*class="[^"]*preset-chip[^"]*"`,
          "s"
        ),
        `Preset chip for ${preset} must be a button.preset-chip[data-image="${preset}"]`
      );
    }
  });

  suite.add("T1.1.9", "Clicking .preset-chip buttons for python:3.12-slim and node:22-slim updates #image-input without breaking alpine:latest default", async () => {
    if (!findChromeBinary()) {
      skip("Chrome binary not available");
    }
    const browser = await launchCdpBrowser();
    try {
      await browser.navigate(`${server.url}/`);
      await browser.waitForSelector("#image-input", 15000);
      await browser.waitForSelector(".presets-row", 15000);

      const initialVal = await browser.evaluate('document.querySelector("#image-input").value', { awaitPromise: false });
      assert.equal(initialVal, "alpine:latest", "Initial #image-input value must be alpine:latest");

      const chips = await browser.getPresetChips();
      const chipImages = chips.map((c) => c.image);
      assert.ok(chipImages.includes("python:3.12-slim"), "Preset chips must include python:3.12-slim");
      assert.ok(chipImages.includes("node:22-slim"), "Preset chips must include node:22-slim");
      assert.ok(chipImages.includes("alpine:latest"), "Preset chips must include alpine:latest");

      const pyVal = await browser.clickPresetChip("python:3.12-slim");
      assert.equal(pyVal, "python:3.12-slim", "Clicking python:3.12-slim chip must populate #image-input");

      const nodeVal = await browser.clickPresetChip("node:22-slim");
      assert.equal(nodeVal, "node:22-slim", "Clicking node:22-slim chip must populate #image-input");

      const alpineVal = await browser.clickPresetChip("alpine:latest");
      assert.equal(alpineVal, "alpine:latest", "Clicking alpine:latest chip must restore #image-input");

      assert.deepEqual(browser.exceptions, [], `Uncaught exceptions: ${JSON.stringify(browser.exceptions)}`);
    } finally {
      await browser.close();
    }
  });

  suite.add("T1.7.1", "python:3.12-slim basic script execution (-c print(20+22))", async () => {
    const img = await getPython();
    const container = await img.createContainer({
      cmd: ["python3", "-c", "import sys; print('PY_OK', sys.version_info[:2], 20+22)"],
      tty: false,
    });
    await container.start();
    try {
      const res = await waitWithTimeout(container.wait(), 120000, "T1.7.1 python3 -c");
      assert.equal(res.exitCode, 0, `Expected exitCode 0, stderr: ${res.stderr}`);
      assertIncludes(stripAnsi(res.stdout), "PY_OK (3, 12) 42");
    } finally {
      await container.stop().catch(() => {});
    }
  });

  suite.add("T1.7.2", "python:3.12-slim core stdlib imports & operations (12 modules)", async () => {
    const img = await getPython();
    const script = [
      "import math, random, datetime, pathlib, json, hashlib, zlib, base64, struct, csv, urllib.parse, tempfile",
      "assert int(math.sqrt(1764)) == 42",
      "assert isinstance(random.Random(42).randint(1, 100), int)",
      "assert datetime.date(2026, 1, 1).isoformat() == '2026-01-01'",
      "assert pathlib.Path('/tmp').exists()",
      "assert json.loads(json.dumps({'k': 42}))['k'] == 42",
      "assert hashlib.sha256(b'abc').hexdigest().startswith('ba7816bf')",
      "assert zlib.decompress(zlib.compress(b'hello_zlib')) == b'hello_zlib'",
      "assert base64.b64decode(base64.b64encode(b'b64_ok')) == b'b64_ok'",
      "assert struct.unpack('<I', struct.pack('<I', 123456))[0] == 123456",
      "assert list(csv.reader(['a,b'])) == [['a', 'b']]",
      "assert urllib.parse.urlparse('https://example.com/p?q=1').path == '/p'",
      "with tempfile.NamedTemporaryFile(mode='w+', delete=True) as f:\n    f.write('tmp42'); f.flush(); f.seek(0); assert f.read() == 'tmp42'",
      "print('STDLIB_ALL_12_OK')",
    ].join("\n");
    const container = await img.createContainer({
      cmd: ["python3", "-c", script],
      tty: false,
    });
    await container.start();
    try {
      const res = await waitWithTimeout(container.wait(), 60000, "T1.7.2 python stdlib 12 modules");
      assert.equal(res.exitCode, 0, `Expected exitCode 0, stderr: ${res.stderr}`);
      assertIncludes(stripAnsi(res.stdout), "STDLIB_ALL_12_OK");
    } finally {
      await container.stop().catch(() => {});
    }
  });

  suite.add("T1.7.3", "python:3.12-slim interactive REPL (>>> prompt, canonical TTY echo, evaluation, exit)", async () => {
    const img = await getPython();
    const container = await img.createContainer({ tty: true });
    let liveOut = "";
    let liveErr = "";
    const decOut = new TextDecoder();
    const decErr = new TextDecoder();
    container.onStdout((chunk) => {
      liveOut += decOut.decode(chunk, { stream: true });
    });
    container.onStderr((chunk) => {
      liveErr += decErr.decode(chunk, { stream: true });
    });

    await container.start();
    try {
      await waitFor(() => stripAnsi(liveOut + liveErr).includes(">>> "), {
        timeoutMs: 60000,
        intervalMs: 150,
        label: "Python >>> prompt",
      });

      container.writeStdin("print(20 + 22)\n");
      await waitFor(() => /(?:^|\n)42(?:\n|$)/.test(stripAnsi(liveOut)), {
        timeoutMs: 25000,
        intervalMs: 150,
        label: "Python REPL computed output 42",
      });

      // Verify F17 visible canonical TTY echo
      assertIncludes(stripAnsi(liveOut + liveErr), "print(20 + 22)", "Expected canonical TTY echo of typed REPL input");

      container.writeStdin("exit()\n");
      const res = await waitWithTimeout(container.wait(), 20000, "T1.7.3 Python REPL exit()");
      assert.equal(res.exitCode, 0);
    } finally {
      await container.stop().catch(() => {});
    }
  });

  suite.add("T1.8.1", "node:22-slim basic script execution (node -e console.log(process.version, 6*7))", async () => {
    const img = await getNode();
    const container = await img.createContainer({
      cmd: ["node", "-e", "console.log('NODE_OK', process.version, 6*7)"],
      tty: false,
    });
    await container.start();
    try {
      const res = await waitWithTimeout(container.wait(), 180000, "T1.8.1 node -e");
      assert.equal(res.exitCode, 0, `Expected exitCode 0, stderr: ${res.stderr}`);
      assertMatch(stripAnsi(res.stdout), /NODE_OK v22\.\d+\.\d+ 42/);
    } finally {
      await container.stop().catch(() => {});
    }
  });

  suite.add("T1.8.2", "node:22-slim core built-ins (fs, path, crypto, zlib, Buffer, URL, JSON)", async () => {
    const img = await getNode();
    const script = [
      "const fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');",
      "if (!fs.existsSync('/tmp')) throw new Error('fs failed');",
      "if (path.join('/a', 'b') !== '/a/b') throw new Error('path failed');",
      "if (!crypto.createHash('sha256').update('abc').digest('hex').startsWith('ba7816bf')) throw new Error('crypto failed');",
      "if (zlib.inflateSync(zlib.deflateSync(Buffer.from('hi_zlib'))).toString() !== 'hi_zlib') throw new Error('zlib failed');",
      "if (Buffer.from('6e6f6465', 'hex').toString('utf8') !== 'node') throw new Error('Buffer failed');",
      "if (new URL('https://example.com/x?a=1').pathname !== '/x') throw new Error('URL failed');",
      "if (JSON.parse(JSON.stringify({ v: 42 })).v !== 42) throw new Error('JSON failed');",
      "console.log('NODE_BUILTINS_ALL_7_OK');",
    ].join("\n");
    const container = await img.createContainer({
      cmd: ["node", "-e", script],
      tty: false,
    });
    await container.start();
    try {
      const res = await waitWithTimeout(container.wait(), 60000, "T1.8.2 node built-ins");
      assert.equal(res.exitCode, 0, `Expected exitCode 0, stderr: ${res.stderr}`);
      assertIncludes(stripAnsi(res.stdout), "NODE_BUILTINS_ALL_7_OK");
    } finally {
      await container.stop().catch(() => {});
    }
  });

  suite.add("T1.8.3", "node:22-slim interactive REPL (> prompt, evaluation, .exit)", async () => {
    const img = await getNode();
    const container = await img.createContainer({ tty: true });
    let liveOut = "";
    const decOut = new TextDecoder();
    container.onStdout((chunk) => {
      liveOut += decOut.decode(chunk, { stream: true });
    });

    await container.start();
    try {
      await waitFor(() => stripAnsi(liveOut).includes("> "), {
        timeoutMs: 90000,
        intervalMs: 200,
        label: "Node > prompt",
      });

      container.writeStdin("console.log(19 + 23)\n");
      await waitFor(() => /(?:^|\n)42(?:\n|$)/.test(stripAnsi(liveOut)), {
        timeoutMs: 30000,
        intervalMs: 150,
        label: "Node REPL computed output 42",
      });

      container.writeStdin(".exit\n");
      const res = await waitWithTimeout(container.wait(), 25000, "T1.8.3 Node REPL .exit");
      assert.equal(res.exitCode, 0);
    } finally {
      await container.stop().catch(() => {});
    }
  });

  // -------------------------------------------------------------------------
  // Git Repo Overlay & Project Test Presets (Features F25-F31, Contracts §7-§10)
  // -------------------------------------------------------------------------

  suite.add("T1.9.1", "GET /api/git/archive streams tar.gz for 40-char SHA, branch, tag, and default HEAD with headers & 302 auth-stripping", async () => {
    gitServer.clearRequests();
    gitServer.resetLeakedAuthCount();

    const cases = [
      { ref: GIT_SHA_40, expectedRef: GIT_SHA_40, expectImmutable: true, label: "40-char SHA" },
      { ref: "main", expectedRef: "main", expectImmutable: false, label: "branch main" },
      { ref: "v1.2.3", expectedRef: "v1.2.3", expectImmutable: false, label: "tag v1.2.3" },
      { ref: null, expectedRef: "HEAD", expectImmutable: false, label: "omitted ref (HEAD)" },
    ];

    for (const c of cases) {
      const qs = new URLSearchParams({ repo: gitServer.repoUrl("testorg/sample") });
      if (c.ref !== null) qs.set("ref", c.ref);

      const resp = await fetch(`${server.url}/api/git/archive?${qs.toString()}`, {
        headers: { Authorization: "Bearer secret-must-not-leak" },
      });
      assert.equal(resp.status, 200, `${c.label}: expected 200, got ${resp.status}`);
      assertIncludes(resp.headers.get("content-type") || "", "application/gzip", `${c.label}: content-type`);
      assert.equal(resp.headers.get("x-git-archive-format"), "tar.gz", `${c.label}: X-Git-Archive-Format`);
      assert.equal(resp.headers.get("x-git-strip-components"), "1", `${c.label}: X-Git-Strip-Components`);
      assertGitSecurityHeaders(resp.headers, `T1.9.1 ${c.label}`);

      const cc = (resp.headers.get("cache-control") || "").toLowerCase();
      assertIncludes(cc, "public", `${c.label}: Cache-Control must include public`);
      if (c.expectImmutable) {
        assertIncludes(cc, "immutable", `${c.label}: 40-char SHA Cache-Control must include immutable`);
      } else {
        assert.equal(cc.includes("immutable"), false, `${c.label}: mutable ref Cache-Control must not include immutable (got ${cc})`);
      }

      const bytes = new Uint8Array(await resp.arrayBuffer());
      assert.equal(bytes[0], 0x1f, `${c.label}: gzip magic byte 0`);
      assert.equal(bytes[1], 0x8b, `${c.label}: gzip magic byte 1`);
      const contentLen = resp.headers.get("content-length");
      if (contentLen !== null) {
        assert.equal(Number(contentLen), bytes.byteLength, `${c.label}: Content-Length mismatch`);
      }

      const entries = parseTarEntries(zlib.gunzipSync(bytes));
      const readme = entries.find((e) => e.name.endsWith("/README.md"));
      assert.ok(readme, `${c.label}: archive must contain README.md`);
      assert.equal(Buffer.from(readme.data).toString("utf8"), `REF=${c.expectedRef}\n`);
    }

    assert.equal(gitServer.leakedAuthCount(), 0, "Proxy must strip Authorization on cross-origin 302 redirect");
    assert.ok(
      gitServer.getRequests((r) => r.server === "cdn" && r.status === 200).length >= 4,
      "Expected at least 4 successful cross-origin CDN archive fetches"
    );
  });

  suite.add("T1.9.2", "HEAD /api/git/archive returns 200 with empty body and matching archive headers", async () => {
    const qs = new URLSearchParams({
      repo: gitServer.repoUrl("testorg/sample"),
      ref: GIT_SHA_40,
    });
    const resp = await fetch(`${server.url}/api/git/archive?${qs.toString()}`, {
      method: "HEAD",
    });
    assert.equal(resp.status, 200);
    assertIncludes(resp.headers.get("content-type") || "", "application/gzip");
    assert.equal(resp.headers.get("x-git-archive-format"), "tar.gz");
    assert.equal(resp.headers.get("x-git-strip-components"), "1");
    assertIncludes((resp.headers.get("cache-control") || "").toLowerCase(), "immutable");
    assertGitSecurityHeaders(resp.headers, "HEAD /api/git/archive");
    assert.equal((await resp.arrayBuffer()).byteLength, 0, "HEAD response body must be empty");
  });

  suite.add("T1.9.3", "GET /js/git_client.mjs serves ESM and fetchGitArchive streams, decompresses & reports progress", async () => {
    const resp = await fetch(`${server.url}/js/git_client.mjs`);
    assert.equal(resp.status, 200, "GET /js/git_client.mjs must return 200");
    assertIncludes(resp.headers.get("content-type") || "", "javascript");
    assertCoopCoep(resp.headers, "GET /js/git_client.mjs");

    // Dynamic import inside test body so tier1_features.mjs loads cleanly prior to M11
    const gitClientPath = path.resolve(REPO_ROOT, "js/git_client.mjs");
    const { fetchGitArchive } = await import(pathToFileURL(gitClientPath).href);
    assert.equal(typeof fetchGitArchive, "function", "git_client.mjs must export fetchGitArchive");

    const progressStages = [];
    const res = await fetchGitArchive({
      repo: gitServer.repoUrl("testorg/sample"),
      ref: "v1.2.3",
      gitProxyBase: `${server.url}/api/git/archive`,
      onProgress: (ev) => {
        if (ev && ev.stage) progressStages.push(ev.stage);
      },
    });

    assert.ok(res.tarBytes instanceof Uint8Array, "fetchGitArchive must return tarBytes Uint8Array");
    assert.ok(res.tarBytes.byteLength >= 1024, `Expected tarBytes >= 1024 bytes, got ${res.tarBytes.byteLength}`);
    assert.equal(res.stripComponents, 1);
    assert.equal(typeof res.repo, "string");
    assert.equal(res.ref, "v1.2.3");

    const entries = parseTarEntries(res.tarBytes);
    const readme = entries.find((e) => e.name === "sample-v1.2.3/README.md");
    assert.ok(readme, "Decompressed tarBytes must contain sample-v1.2.3/README.md");
    assert.equal(Buffer.from(readme.data).toString("utf8"), "REF=v1.2.3\n");

    assert.ok(
      progressStages.includes("git-download"),
      `Expected progressStages to include "git-download", got ${JSON.stringify(progressStages)}`
    );
    assert.ok(
      progressStages.includes("git-decompress"),
      `Expected progressStages to include "git-decompress", got ${JSON.stringify(progressStages)}`
    );
  });

  suite.add("T1.9.4", "GET / exposes Git repo overlay controls & 4 project test presets while preserving all 5 image presets", async () => {
    const resp = await fetch(`${server.url}/`);
    assert.equal(resp.status, 200);
    assertCoopCoep(resp.headers, "GET /");
    const html = await resp.text();

    for (const id of ["repo-input", "repo-ref-input", "repo-mount-input"]) {
      assertIncludes(html, `id="${id}"`, `index.html missing #${id}`);
    }
    assertMatch(
      html,
      /id="repo-mount-input"[^>]*value="\/workspace"|value="\/workspace"[^>]*id="repo-mount-input"/,
      "#repo-mount-input must default to value=\"/workspace\""
    );
    assertIncludes(html, "project-presets-row", "index.html missing .project-presets-row");

    const projectPresetMatches = [...html.matchAll(/class="[^"]*\bproject-preset-chip\b[^"]*"[^>]*data-preset="([^"]+)"|data-preset="([^"]+)"[^>]*class="[^"]*\bproject-preset-chip\b[^"]*"/g)];
    const presetIds = new Set(projectPresetMatches.map((m) => m[1] || m[2]).filter(Boolean));
    assert.equal(presetIds.size, 4, `Expected 4 distinct .project-preset-chip[data-preset] buttons, found ${presetIds.size}`);

    for (const img of ["alpine:latest", "busybox:latest", "debian:bookworm-slim", "python:3.12-slim", "node:22-slim"]) {
      assertIncludes(html, `data-image="${img}"`, `Existing image preset ${img} must be preserved`);
    }
  });

  suite.add("T1.9.5", "Headless Chrome DOM contract: .project-preset-chip populates fields & plain .preset-chip resets repo/cmd/cwd/env", async () => {
    if (!findChromeBinary()) {
      skip("Google Chrome binary not found");
    }
    const browser = await launchCdpBrowser();
    try {
      await browser.navigate(`${server.url}/`);
      await browser.waitForSelector("#repo-input", 15000);
      await browser.waitForSelector("#repo-ref-input", 15000);
      await browser.waitForSelector("#repo-mount-input", 15000);
      await browser.waitForSelector(".project-presets-row", 15000);

      assert.equal(await browser.getInputValue("#repo-mount-input"), "/workspace");
      assert.equal(await browser.getInputValue("#repo-input"), "");
      assert.equal(await browser.getInputValue("#repo-ref-input"), "");

      const projectChips = await browser.getProjectPresetChips();
      assert.equal(projectChips.length, 4, `Expected 4 .project-preset-chip buttons, got ${JSON.stringify(projectChips)}`);
      const uniqueIds = new Set(projectChips.map((c) => c.preset).filter(Boolean));
      assert.equal(uniqueIds.size, 4, "All 4 project presets must have distinct data-preset values");

      const combinedDescriptions = [];
      for (const chip of projectChips) {
        const fields = await browser.clickProjectPresetChip(chip.preset);
        assert.ok(fields.image.trim().length > 0, `Preset ${chip.preset} must populate #image-input`);
        assert.ok(fields.repo.trim().length > 0, `Preset ${chip.preset} must populate #repo-input`);
        assert.ok(fields.cmd.trim().length > 0, `Preset ${chip.preset} must populate #cmd-input`);
        assert.ok(fields.mountPath.startsWith("/"), `Preset ${chip.preset} #repo-mount-input must start with "/" (got ${fields.mountPath})`);
        combinedDescriptions.push(
          `${chip.preset} ${chip.language} ${chip.text} ${fields.image} ${fields.cmd}`
        );
      }

      assert.ok(combinedDescriptions.some((d) => /python/i.test(d)), "Project presets must include a Python project");
      assert.ok(combinedDescriptions.some((d) => /javascript|node|\bjs\b/i.test(d)), "Project presets must include a JavaScript project");
      assert.ok(combinedDescriptions.some((d) => /rust|cargo|nushell|\bnu\b/i.test(d)), "Project presets must include a Rust project");
      assert.ok(combinedDescriptions.some((d) => /\bgo\b|golang|raft/i.test(d)), "Project presets must include a Go project");

      // Clicking a plain image .preset-chip must clear repo/cmd/cwd/env and restore /workspace
      await browser.clickPresetChip("alpine:latest");
      assert.equal(await browser.getInputValue("#image-input"), "alpine:latest");
      assert.equal(await browser.getInputValue("#repo-input"), "");
      assert.equal(await browser.getInputValue("#repo-ref-input"), "");
      assert.equal(await browser.getInputValue("#repo-mount-input"), "/workspace");
      assert.equal(await browser.getInputValue("#cmd-input"), "");
      assert.equal(await browser.getInputValue("#cwd-input"), "");
      assert.equal(await browser.getInputValue("#env-input"), "");
      const activeId = await browser.evaluate("document.activeElement?.id || ''", { awaitPromise: false });
      assert.equal(activeId, "image-input", "Clicking plain .preset-chip must focus #image-input");

      assert.deepEqual(browser.exceptions, [], `Uncaught exceptions: ${JSON.stringify(browser.exceptions)}`);
    } finally {
      await browser.close();
    }
  });

  suite.add("T1.9.6", "image.createContainer({ gitRepo }) overlays at /workspace & custom mountPath, sets cwd/PWD, rebases hardlinks & preserves relative symlinks", async () => {
    const alpineImg = await getAlpine();

    // Case A: default mountPath = /workspace
    const c1 = await alpineImg.createContainer({
      gitRepo: { repo: gitServer.repoUrl("testorg/sample"), ref: "main" },
      cmd: [
        "/bin/sh",
        "-c",
        'echo "PWD=$(pwd)|ENV_PWD=$PWD"; cat README.md; cat src/data_hardlink.txt; readlink src/link_to_readme.txt; cat src/link_to_readme.txt',
      ],
      tty: false,
    });
    await c1.start();
    try {
      const r1 = await waitWithTimeout(c1.wait(), 45000, "T1.9.6 Case A default /workspace");
      assert.equal(r1.exitCode, 0, `Case A failed (stderr: ${r1.stderr})`);
      const out1 = stripAnsi(r1.stdout);
      assertIncludes(out1, "PWD=/workspace|ENV_PWD=/workspace");
      assertIncludes(out1, "REF=main");
      assertIncludes(out1, "HARDLINK_TARGET_DATA");
      assertIncludes(out1, "../README.md");
    } finally {
      await c1.stop().catch(() => {});
    }

    // Case B: custom mountPath = /srv/custom_app with 40-char SHA
    const c2 = await alpineImg.createContainer({
      gitRepo: {
        repo: gitServer.repoUrl("testorg/sample"),
        ref: GIT_SHA_40,
        mountPath: "/srv/custom_app",
      },
      cmd: [
        "/bin/sh",
        "-c",
        'echo "PWD=$(pwd)|ENV_PWD=$PWD"; test -f /srv/custom_app/src/data_hardlink.txt && cat README.md && cat src/data_hardlink.txt',
      ],
      tty: false,
    });
    await c2.start();
    try {
      const r2 = await waitWithTimeout(c2.wait(), 45000, "T1.9.6 Case B custom mountPath");
      assert.equal(r2.exitCode, 0, `Case B failed (stderr: ${r2.stderr})`);
      const out2 = stripAnsi(r2.stdout);
      assertIncludes(out2, "PWD=/srv/custom_app|ENV_PWD=/srv/custom_app");
      assertIncludes(out2, `REF=${GIT_SHA_40}`);
      assertIncludes(out2, "HARDLINK_TARGET_DATA");
    } finally {
      await c2.stop().catch(() => {});
    }
  });

  suite.add("T1.9.7", "runDockerImage(ref, { gitRepo }) one-shot execution with git repo overlay", async () => {
    const res = await waitWithTimeout(
      runDockerImage(registry.imageRef("library/alpine", "latest"), {
        ...sdkOpts,
        gitRepo: {
          repo: gitServer.repoUrl("testorg/sample"),
          ref: "v1.2.3",
          mountPath: "/workspace",
        },
        cmd: ["/bin/sh", "-c", 'echo "RUN_PWD=$(pwd)"; cat /workspace/README.md'],
        tty: false,
      }),
      60000,
      "T1.9.7 runDockerImage with gitRepo"
    );
    assert.equal(res.exitCode, 0, `runDockerImage failed (stderr: ${res.stderr})`);
    const out = stripAnsi(res.stdout);
    assertIncludes(out, "RUN_PWD=/workspace");
    assertIncludes(out, "REF=v1.2.3");
  });

  suite.add("T1.9.8", "Offline overlayTarBytes + overlayMountPath + overlayStripComponents makes zero git network calls", async () => {
    const alpineImg = await getAlpine();
    const tarBytes = createTar([
      { path: "offline-pkg/", type: "dir", mode: 0o755 },
      { path: "offline-pkg/hello.txt", type: "file", content: "OFFLINE_HELLO\n" },
      { path: "offline-pkg/sub/", type: "dir", mode: 0o755 },
      { path: "offline-pkg/sub/orig.txt", type: "file", content: "OFFLINE_ORIG\n" },
      { path: "offline-pkg/sub/hard.txt", type: "hardlink", linkname: "offline-pkg/sub/orig.txt" },
      { path: "offline-pkg/sub/sym.txt", type: "symlink", linkname: "../hello.txt" },
    ]);

    gitServer.clearRequests();
    const c = await alpineImg.createContainer({
      overlayTarBytes: tarBytes,
      overlayMountPath: "/opt/repo",
      overlayStripComponents: 1,
      cmd: [
        "/bin/sh",
        "-c",
        'echo "PWD=$(pwd)|ENV=$PWD"; cat hello.txt; cat sub/hard.txt; readlink sub/sym.txt; cat sub/sym.txt',
      ],
      tty: false,
    });
    await c.start();
    try {
      const res = await waitWithTimeout(c.wait(), 45000, "T1.9.8 offline overlayTarBytes");
      assert.equal(res.exitCode, 0, `Offline overlay failed (stderr: ${res.stderr})`);
      const out = stripAnsi(res.stdout);
      assertIncludes(out, "PWD=/opt/repo|ENV=/opt/repo");
      assertIncludes(out, "OFFLINE_HELLO");
      assertIncludes(out, "OFFLINE_ORIG");
      assertIncludes(out, "../hello.txt");
      assert.equal(gitServer.getRequests().length, 0, "Offline overlayTarBytes must make zero git network requests");
    } finally {
      await c.stop().catch(() => {});
    }
  });

  try {
    return await suite.run(opts);
  } finally {
    await server.close();
    await gitServer.close();
    await registry.close();
  }
}
