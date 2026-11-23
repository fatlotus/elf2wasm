// Self-test for e2e_docker_web infrastructure (runs independently of M1-M4).
// Verifies tar_builder.mjs, mock_oci_registry.mjs, cdp_browser.mjs (with Dedicated Web Worker),
// and test_runner.mjs against live local HTTP servers and real headless Google Chrome.

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import {
  assert,
  assertIncludes,
  stripAnsi,
  waitFor,
  Suite,
} from "./helpers/test_runner.mjs";
import { createTar, createTarGz, parseTarEntries } from "./helpers/tar_builder.mjs";
import { buildOciImage, startMockOciRegistry } from "./helpers/mock_oci_registry.mjs";
import { launchCdpBrowser } from "./helpers/cdp_browser.mjs";

function sha256Digest(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

export async function runSelfTest(opts = {}) {
  const suite = new Suite("Self-Test (E2E Harness Infrastructure)");

  suite.add("ST-1", "test_runner: stripAnsi removes CSI/OSC/DCS sequences and normalizes CRLF", () => {
    const raw = "\x1b]0;alpine-shell\x07\x1b[32m/ #\x1b[0m hello\r\n\x1b[1;34mworld\x1b[K\r\n";
    assert.equal(stripAnsi(raw), "/ # hello\nworld\n");
    // ECMA-48 CSI parameter bytes (':', '>', '=') and DCS sequences
    assert.equal(stripAnsi("\x1b[38:2:255:0:0mRED\x1b[0m"), "RED");
    assert.equal(stripAnsi("\x1b[>0cHELLO"), "HELLO");
    assert.equal(stripAnsi("\x1b[=1hWORLD"), "WORLD");
    assert.equal(stripAnsi("\x1bP+q544e\x1b\\TEXT"), "TEXT");
  });

  suite.add("ST-2", "test_runner: waitFor polls until truthy and rejects on timeout", async () => {
    let n = 0;
    const val = await waitFor(
      () => {
        n += 1;
        return n >= 3 ? "READY" : false;
      },
      { timeoutMs: 2000, intervalMs: 20, label: "counter>=3" }
    );
    assert.equal(val, "READY");

    await assert.rejects(
      () => waitFor(() => false, { timeoutMs: 80, intervalMs: 20, label: "never-true" }),
      /Timed out after 80ms waiting for never-true/
    );
  });

  suite.add("ST-3", "tar_builder: round-trip files, empty dirs, symlinks, hardlinks, whiteouts, long names & gzip", () => {
    const longPath = "deep/" + "segment_".repeat(14) + "longfile.txt";
    assert.ok(longPath.length > 100, "longPath must exceed 100 bytes");

    const built = createTarGz([
      { path: "app/", type: "dir", mode: 0o755 },
      { path: "app/empty/", type: "dir", mode: 0o755 },
      { path: "app/hello.txt", type: "file", content: "hello-tar\n", mode: 0o644 },
      { path: "app/sym", type: "symlink", linkname: "/app/hello.txt" },
      { path: "app/hard", type: "hardlink", linkname: "app/hello.txt" },
      { path: "app/.wh.old.txt", type: "file", content: "" },
      { path: "app/.wh..wh..opq", type: "file", content: "" },
      { path: longPath, type: "file", content: "long-ok" },
    ]);

    assert.equal(built.gzBytes[0], 0x1f, "gzip magic byte 0");
    assert.equal(built.gzBytes[1], 0x8b, "gzip magic byte 1");
    assert.equal(built.digest, sha256Digest(built.gzBytes));
    assert.equal(built.diffId, sha256Digest(built.tarBytes));

    const gunzipped = zlib.gunzipSync(built.gzBytes);
    const parsed = parseTarEntries(gunzipped);
    const byName = new Map(parsed.map((e) => [e.name, e]));

    assert.equal(byName.get("app/empty/")?.typeFlag, "5");
    assert.equal(Buffer.from(byName.get("app/hello.txt").data).toString("utf8"), "hello-tar\n");
    assert.equal(byName.get("app/sym")?.typeFlag, "2");
    assert.equal(byName.get("app/sym")?.linkname, "/app/hello.txt");
    assert.equal(byName.get("app/hard")?.typeFlag, "1");
    assert.equal(byName.get("app/hard")?.linkname, "app/hello.txt");
    assert.ok(byName.has("app/.wh.old.txt"));
    assert.ok(byName.has("app/.wh..wh..opq"));
    assert.equal(Buffer.from(byName.get(longPath).data).toString("utf8"), "long-ok");
  });

  suite.add("ST-4", "mock_oci_registry: Bearer 401->/token, multi-arch index, 302 cross-origin auth-stripping & error routes", async () => {
    const registry = await startMockOciRegistry({ requireAuth: true, redirectBlobs: true });
    try {
      // 1. Unauthenticated /v2/ -> 401 + WWW-Authenticate
      const r401 = await fetch(`${registry.url}/v2/`);
      assert.equal(r401.status, 401);
      const wwwAuth = r401.headers.get("www-authenticate") || "";
      assertIncludes(wwwAuth, "Bearer ");
      const realmMatch = wwwAuth.match(/realm="([^"]+)"/);
      assert.ok(realmMatch, "WWW-Authenticate must contain realm");

      // Helper to mint a scoped Bearer token from the mock registry's /token endpoint
      const getAuthHeaders = async (scope) => {
        const tokResp = await fetch(`${realmMatch[1]}?service=mock-registry&scope=${encodeURIComponent(scope)}`);
        assert.equal(tokResp.status, 200);
        const { token } = await tokResp.json();
        assert.ok(token, `Token must be returned for scope ${scope}`);
        return { Authorization: `Bearer ${token}` };
      };

      // 2. Fetch Bearer token for library/alpine and registry:catalog:*
      const catalogHeaders = await getAuthHeaders("registry:catalog:*");
      const alpineHeaders = await getAuthHeaders("repository:library/alpine:pull");

      // 3. Authenticated /v2/ -> 200 with catalog scope, 401 with wrong scope
      const rV2Wrong = await fetch(`${registry.url}/v2/`, { headers: alpineHeaders });
      assert.equal(rV2Wrong.status, 401, "Wrong-scope token must be rejected on /v2/");
      const rV2 = await fetch(`${registry.url}/v2/`, { headers: catalogHeaders });
      assert.equal(rV2.status, 200);

      // 4. Multi-arch Image Index has linux/arm64 and unknown/unknown BEFORE linux/amd64
      const idxResp = await fetch(`${registry.url}/v2/library/alpine/manifests/latest`, { headers: alpineHeaders });
      assert.equal(idxResp.status, 200);
      const index = await idxResp.json();
      assert.equal(index.manifests.length, 3);
      assert.equal(index.manifests[0].platform.architecture, "arm64");
      assert.equal(index.manifests[1].platform.architecture, "unknown");
      assert.equal(index.manifests[2].platform.architecture, "amd64");

      // 5. Fetch linux/amd64 manifest by digest
      const amd64Digest = index.manifests[2].digest;
      const manResp = await fetch(`${registry.url}/v2/library/alpine/manifests/${amd64Digest}`, { headers: alpineHeaders });
      assert.equal(manResp.status, 200);
      const manifest = await manResp.json();
      const layerDigest = manifest.layers[0].digest;
      assert.ok(layerDigest.startsWith("sha256:"));

      // 6. Blob endpoint returns 302 redirect to separate-port Blob CDN
      const blobRedirect = await fetch(`${registry.url}/v2/library/alpine/blobs/${layerDigest}`, {
        headers: alpineHeaders,
        redirect: "manual",
      });
      assert.equal(blobRedirect.status, 302);
      const location = blobRedirect.headers.get("location");
      assert.ok(location && location.includes(registry.blobHost), "302 Location must point to separate blobHost");

      // 7. Blob CDN rejects Authorization header with 400 and increments leakedAuthCount()
      assert.equal(registry.leakedAuthCount(), 0);
      const leakedResp = await fetch(location, { headers: alpineHeaders });
      assert.equal(leakedResp.status, 400);
      assert.equal(registry.leakedAuthCount(), 1);

      // 8. Blob CDN succeeds without Authorization with exact SHA-256 & 1f 8b gzip magic
      const cleanResp = await fetch(location);
      assert.equal(cleanResp.status, 200);
      const blobBytes = new Uint8Array(await cleanResp.arrayBuffer());
      assert.equal(blobBytes[0], 0x1f);
      assert.equal(blobBytes[1], 0x8b);
      assert.equal(sha256Digest(blobBytes), layerDigest);

      // 9. Scope enforcement: alpine token rejected with 401 on custom/layered
      const wrongRepoResp = await fetch(`${registry.url}/v2/custom/layered/manifests/v1`, { headers: alpineHeaders });
      assert.equal(wrongRepoResp.status, 401, "Token minted for library/alpine must be rejected on custom/layered");

      // 10. custom/layered:v1 layer 2 contains whiteout entries (with properly scoped token)
      const layeredHeaders = await getAuthHeaders("repository:custom/layered:pull");
      const layIdx = await (await fetch(`${registry.url}/v2/custom/layered/manifests/v1`, { headers: layeredHeaders })).json();
      const layAmd64 = layIdx.manifests.find((m) => m.platform.architecture === "amd64");
      const layMan = await (await fetch(`${registry.url}/v2/custom/layered/manifests/${layAmd64.digest}`, { headers: layeredHeaders })).json();
      assert.equal(layMan.layers.length, 3);
      const l2Redir = await fetch(`${registry.url}/v2/custom/layered/blobs/${layMan.layers[2].digest}`, {
        headers: layeredHeaders,
        redirect: "manual",
      });
      const l2Gz = new Uint8Array(await (await fetch(l2Redir.headers.get("location"))).arrayBuffer());
      const l2Names = parseTarEntries(zlib.gunzipSync(l2Gz)).map((e) => e.name);
      assert.ok(l2Names.includes("app/.wh.delete_me.txt"), "Layer 2 must contain .wh.delete_me.txt");
      assert.ok(l2Names.includes("app/opaque_dir/.wh..wh..opq"), "Layer 2 must contain .wh..wh..opq");

      // 11. getOciTarball returns valid OCI tarball
      const ociTar = registry.getOciTarball("library/alpine", "latest");
      const ociNames = parseTarEntries(ociTar).map((e) => e.name);
      assert.ok(ociNames.includes("oci-layout"));
      assert.ok(ociNames.includes("index.json"));
      assert.ok(ociNames.includes("manifest.json"));
      assert.ok(ociNames.some((n) => n.startsWith("blobs/sha256/")));

      // 12. Error routes: 404 & 500 (with properly scoped tokens)
      const r404Headers = await getAuthHeaders("repository:does/notexist:pull");
      const r404 = await fetch(`${registry.url}/v2/does/notexist/manifests/latest`, { headers: r404Headers });
      assert.equal(r404.status, 404);
      const r500Headers = await getAuthHeaders("repository:error/upstream500:pull");
      const r500 = await fetch(`${registry.url}/v2/error/upstream500/manifests/latest`, { headers: r500Headers });
      assert.equal(r500.status, 500);

      // 13. Synthetic multi-layer + disk-backed filePath blob streaming + HEAD + getOciTarball
      const tmpDiskDir = fs.mkdtempSync(path.join(os.tmpdir(), "elf2wasm-st4-disk-"));
      try {
        const synLayer0 = createTarGz([{ path: "base/a.txt", type: "file", content: "disk-layer-0\n" }]);
        const synLayer1 = createTarGz([{ path: "app/b.txt", type: "file", content: "disk-layer-1\n" }]);
        const diskPath0 = path.join(tmpDiskDir, "layer0.tar.gz");
        const diskPath1 = path.join(tmpDiskDir, "layer1.tar.gz");
        fs.writeFileSync(diskPath0, synLayer0.gzBytes);
        fs.writeFileSync(diskPath1, synLayer1.gzBytes);

        const diskImg = buildOciImage({
          config: {
            Entrypoint: ["docker-entrypoint.sh"],
            Cmd: ["synthetic"],
            Env: ["SYN_ENV=1"],
            WorkingDir: "/app",
          },
          layers: [
            { filePath: diskPath0, digest: synLayer0.digest, diffId: synLayer0.diffId, size: synLayer0.gzBytes.length },
            { filePath: diskPath1, digest: synLayer1.digest, diffId: synLayer1.diffId, size: synLayer1.gzBytes.length },
          ],
          multiArch: true,
        });
        registry.registerImage("synthetic/diskmulti", "v1", diskImg);

        const diskHeaders = await getAuthHeaders("repository:synthetic/diskmulti:pull");
        const dIdx = await (await fetch(`${registry.url}/v2/synthetic/diskmulti/manifests/v1`, { headers: diskHeaders })).json();
        const dAmd64 = dIdx.manifests.find((m) => m.platform.architecture === "amd64");
        const dMan = await (await fetch(`${registry.url}/v2/synthetic/diskmulti/manifests/${dAmd64.digest}`, { headers: diskHeaders })).json();
        assert.equal(dMan.layers.length, 2, "Synthetic disk-backed image must have 2 layers");

        for (const [idx, expected] of [synLayer0, synLayer1].entries()) {
          const redir = await fetch(`${registry.url}/v2/synthetic/diskmulti/blobs/${dMan.layers[idx].digest}`, {
            headers: diskHeaders,
            redirect: "manual",
          });
          assert.equal(redir.status, 302);
          const loc = redir.headers.get("location");
          const headResp = await fetch(loc, { method: "HEAD" });
          assert.equal(headResp.status, 200);
          assert.equal(Number(headResp.headers.get("content-length")), expected.gzBytes.length);

          const getResp = await fetch(loc);
          assert.equal(getResp.status, 200);
          assert.equal(Number(getResp.headers.get("content-length")), expected.gzBytes.length);
          const gotBytes = new Uint8Array(await getResp.arrayBuffer());
          assert.equal(sha256Digest(gotBytes), expected.digest);
        }

        const diskTar = registry.getOciTarball("synthetic/diskmulti", "v1");
        const diskTarNames = parseTarEntries(diskTar).map((e) => e.name);
        assert.ok(diskTarNames.includes(`blobs/sha256/${synLayer0.digest.slice(7)}`));
        assert.ok(diskTarNames.includes(`blobs/sha256/${synLayer1.digest.slice(7)}`));
      } finally {
        fs.rmSync(tmpDiskDir, { recursive: true, force: true });
      }
    } finally {
      await registry.close();
    }
  });

  suite.add("ST-5", "cdp_browser: headless Chrome COOP/COEP + Dedicated Web Worker network capture + editable/non-editable Input + clean teardown", async () => {
    const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>CDP Self-Test</title></head>
<body>
  <input id="term-input" type="text" value="" />
  <div id="terminal" tabindex="0"></div>
  <div id="worker-out">pending</div>
  <script>
    window.__divKeys = [];
    document.getElementById("terminal").addEventListener("keydown", (e) => {
      window.__divKeys.push(e.key);
    });
    const w = new Worker("/worker.js");
    w.onmessage = (e) => {
      document.getElementById("worker-out").textContent = e.data;
    };
  </script>
</body>
</html>`;

    const workerJs = `
fetch("/worker-ping")
  .then((r) => r.text())
  .then((t) => postMessage("WORKER:" + t));
`;

    const testServer = http.createServer((req, res) => {
      const headers = {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      };
      if (req.url === "/") {
        res.writeHead(200, { ...headers, "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      } else if (req.url === "/worker.js") {
        res.writeHead(200, { ...headers, "Content-Type": "application/javascript; charset=utf-8" });
        res.end(workerJs);
      } else if (req.url === "/worker-ping") {
        res.writeHead(200, { ...headers, "Content-Type": "text/plain" });
        res.end("PONG_FROM_SERVER");
      } else {
        res.writeHead(404, headers);
        res.end("not found");
      }
    });

    await new Promise((resolve) => testServer.listen(0, "127.0.0.1", resolve));
    const { port } = testServer.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    let userDataDir = null;
    const browser = await launchCdpBrowser();
    userDataDir = browser.userDataDir;

    try {
      await browser.navigate(`${baseUrl}/`);

      const isolated = await browser.evaluate("window.crossOriginIsolated", { awaitPromise: false });
      assert.equal(isolated, true, "window.crossOriginIsolated must be true");

      await waitFor(
        async () => (await browser.getText("#worker-out")) === "WORKER:PONG_FROM_SERVER",
        { timeoutMs: 10000, intervalMs: 100, label: "Dedicated Worker fetch result" }
      );

      // Verify Target.setAutoAttach(waitForDebuggerOnStart: true) + Network.enable captured immediate top-level Worker fetch("/worker-ping")
      const sawWorkerPingReq = browser.networkRequests.some((r) => r.url.endsWith("/worker-ping"));
      const sawWorkerPingResp = browser.networkResponses.some(
        (r) => r.url.endsWith("/worker-ping") && r.status === 200
      );
      assert.equal(sawWorkerPingReq, true, "CDP must capture Dedicated Web Worker networkRequests");
      assert.equal(sawWorkerPingResp, true, "CDP must capture Dedicated Web Worker networkResponses");

      // Verify Input.insertText into editable <input>
      await browser.typeIntoTerminal("hello_cdp", { selector: "#term-input", pressEnter: false });
      const val = await browser.evaluate('document.getElementById("term-input").value', { awaitPromise: false });
      assert.equal(val, "hello_cdp");

      // Verify per-character keyDown/keyUp on non-editable <div id="terminal" tabindex="0">
      await browser.typeIntoTerminal("echo_div_42", { selector: "#terminal", pressEnter: true });
      const divKeys = await browser.evaluate("window.__divKeys", { awaitPromise: false });
      assert.deepEqual(
        divKeys,
        [..."echo_div_42", "Enter"],
        "typeIntoTerminal must deliver keydown events for every char + Enter on non-editable #terminal"
      );

      assert.deepEqual(browser.exceptions, [], "Zero uncaught exceptions in self-test page");
    } finally {
      await browser.close();
      await new Promise((resolve) => testServer.close(resolve));
    }

    // Verify clean teardown removed userDataDir
    assert.equal(fs.existsSync(userDataDir), false, `Expected Chrome userDataDir ${userDataDir} to be cleaned up`);
  });

  return suite.run(opts);
}
