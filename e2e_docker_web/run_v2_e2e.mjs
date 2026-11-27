#!/usr/bin/env node
// Unified CLI runner for the elf2wasm v2 Developer-Tool UX, Dockerfile/Sweep & Remote Worker E2E Suite (F16).
// Exit codes:
//   0 = all executed tests passed
//   1 = one or more test assertions failed
//   2 = prerequisite / environment / CLI usage error

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import { Suite, assert, assertIncludes, formatDuration } from "./helpers/test_runner.mjs";
import { checkPrerequisites, findChromeBinary } from "./helpers/server_harness.mjs";
import { createTarGz, parseTarEntries } from "./helpers/tar_builder.mjs";
import { startMockOciRegistry } from "./helpers/mock_oci_registry.mjs";
import { startMockGitServer } from "./helpers/mock_git_server.mjs";
import {
  launchCdpBrowser,
  parseRgb,
  relativeLuminance,
  contrastRatio,
} from "./helpers/cdp_browser.mjs";
import {
  encodeTarGzBase64,
  decodeTarGzBase64,
  postEvalJson,
  postEvalTarGz,
} from "./helpers/eval_client.mjs";
import { getEffectiveColors } from "./helpers/v2_ui_helpers.mjs";

function printHelp() {
  console.log(`Usage: node e2e_docker_web/run_v2_e2e.mjs [options]

Options:
  --tier <1|2|3|4|all>   Run a specific v2 tier or all tiers sequentially (default: all)
  --self-test            Verify v2 E2E harness infrastructure only (independent of M2-M5)
  --skip-live            Skip live Docker Hub / GitHub Tier 4 scenarios for offline runs
  --verbose              Stream detailed test progress and diagnostics
  --json <file>          Write machine-readable JSON results summary to <file>
  --help                 Print usage and exit 0

Exit Codes:
  0  All executed tests passed
  1  One or more test assertions failed
  2  Prerequisite, environment, or CLI usage error`);
}

function parseArgs(argv) {
  const opts = {
    tier: "all",
    selfTest: false,
    skipLive: false,
    verbose: false,
    jsonFile: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--self-test") {
      opts.selfTest = true;
    } else if (arg === "--skip-live") {
      opts.skipLive = true;
    } else if (arg === "--verbose" || arg === "-v") {
      opts.verbose = true;
    } else if (arg === "--tier") {
      const next = argv[++i];
      if (!next || !["1", "2", "3", "4", "all"].includes(next)) {
        throw new Error(`Invalid --tier value: ${next || "(missing)"}. Expected 1, 2, 3, 4, or all.`);
      }
      opts.tier = next;
    } else if (arg.startsWith("--tier=")) {
      const val = arg.slice("--tier=".length);
      if (!["1", "2", "3", "4", "all"].includes(val)) {
        throw new Error(`Invalid --tier value: ${val}. Expected 1, 2, 3, 4, or all.`);
      }
      opts.tier = val;
    } else if (arg === "--json") {
      const next = argv[++i];
      if (!next) throw new Error("Missing file path after --json");
      opts.jsonFile = next;
    } else if (arg.startsWith("--json=")) {
      const val = arg.slice("--json=".length);
      if (!val) throw new Error("Missing file path after --json=");
      opts.jsonFile = val;
    } else {
      throw new Error(`Unknown CLI argument: ${arg}`);
    }
  }

  return opts;
}

async function runV2SelfTest(opts = {}) {
  const suite = new Suite("Self-Test (v2 E2E Harness Infrastructure)");

  suite.add("V2-ST-1", "tar_builder & eval_client: base64 tar.gz round-trip including OCI whiteouts", () => {
    const b64 = encodeTarGzBase64([
      { path: "tmp/", type: "dir", mode: 0o755 },
      { path: "tmp/out.txt", type: "file", content: "hello-v2-eval\n", mode: 0o644 },
      { path: "tmp/.wh.removed.txt", type: "file", content: "", mode: 0o644 },
    ]);
    const decoded = decodeTarGzBase64(b64);
    assert.equal(decoded.gzBytes[0], 0x1f);
    assert.equal(decoded.gzBytes[1], 0x8b);
    const byName = new Map(decoded.entries.map((e) => [e.name, e]));
    assert.equal(Buffer.from(byName.get("tmp/out.txt").data).toString("utf8"), "hello-v2-eval\n");
    assert.ok(byName.has("tmp/.wh.removed.txt"), "OCI whiteout entry must survive round-trip");
  });

  suite.add("V2-ST-2", "eval_client: postEvalJson & postEvalTarGz against local mock HTTP /api/eval endpoint", async () => {
    const { gzBytes } = createTarGz([
      { path: "tmp/artifact.txt", type: "file", content: "MOCK_EVAL_OK\n" },
    ]);
    const srv = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        const u = new URL(req.url, "http://127.0.0.1");
        const wantsTar = u.searchParams.get("format") === "tar.gz"
          || (req.headers.accept || "").includes("application/gzip");
        if (wantsTar) {
          res.writeHead(200, {
            "content-type": "application/gzip",
            "content-disposition": 'attachment; filename="layer-output.tar.gz"',
            "x-eval-exit-code": "0",
            "x-eval-virtual-time-ns": "12345",
          });
          res.end(Buffer.from(gzBytes));
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            ok: true,
            executor: "remote-wasmi",
            exitCode: 0,
            stdout: "ok\n",
            virtualTimeNs: "12345",
            outputDiffTarGzBase64: Buffer.from(gzBytes).toString("base64"),
            modifiedFiles: [{ path: "/tmp/artifact.txt", kind: "file", size: 13 }],
          }));
        }
      });
    });

    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = srv.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const jsonRes = await postEvalJson(baseUrl, { baseImage: "alpine:latest", cmd: ["echo", "ok"] });
      assert.equal(jsonRes.status, 200);
      assert.equal(jsonRes.json.ok, true);
      assert.equal(jsonRes.json.executor, "remote-wasmi");

      const tarAccept = await postEvalTarGz(baseUrl, { baseImage: "alpine:latest", cmd: ["echo", "ok"] });
      assert.equal(tarAccept.status, 200);
      assert.equal(tarAccept.headers["x-eval-exit-code"], "0");
      assert.equal(Buffer.from(tarAccept.entries[0].data).toString("utf8"), "MOCK_EVAL_OK\n");

      const tarQuery = await postEvalTarGz(baseUrl, { baseImage: "alpine:latest", cmd: ["echo", "ok"] }, { useQueryFormat: true });
      assert.equal(tarQuery.status, 200);
      assert.equal(tarQuery.entries.length, 1);
    } finally {
      await new Promise((resolve) => srv.close(resolve));
    }
  });

  suite.add("V2-ST-3", "mock_oci_registry & mock_git_server: start cleanly and serve fixtures", async () => {
    const registry = await startMockOciRegistry({ requireAuth: false });
    const gitServer = await startMockGitServer({ redirectArchives: false });
    try {
      const v2Resp = await fetch(`${registry.url}/v2/`);
      assert.equal(v2Resp.status, 200);

      gitServer.addRepo("selftest/repo", {
        main: [
          { path: "repo-main/", type: "dir", mode: 0o755 },
          { path: "repo-main/hello.txt", type: "file", content: "GIT_OK\n" },
        ],
      });
      const archiveResp = await fetch(`${gitServer.url}/selftest/repo/archive/main.tar.gz`);
      assert.equal(archiveResp.status, 200);
      const gz = new Uint8Array(await archiveResp.arrayBuffer());
      assert.equal(gz[0], 0x1f);
      assert.equal(gz[1], 0x8b);
      const entries = parseTarEntries(zlib.gunzipSync(gz));
      assert.ok(entries.some((e) => e.name.endsWith("hello.txt")));
    } finally {
      await gitServer.close();
      await registry.close();
    }
  });

  suite.add("V2-ST-4", "cdp_browser: WCAG helpers, setColorScheme (light/dark), setViewport (390x844), and real blob download capture", async () => {
    // Pure WCAG math sanity checks
    assert.deepEqual(parseRgb("rgb(255, 255, 255)"), { r: 255, g: 255, b: 255, a: 1 });
    assert.ok(Math.abs(relativeLuminance("#ffffff") - 1) < 1e-6);
    assert.ok(Math.abs(relativeLuminance("#000000") - 0) < 1e-6);
    assert.ok(Math.abs(contrastRatio("#ffffff", "#000000") - 21) < 1e-4);

    const chromePath = findChromeBinary();
    assert.ok(chromePath, "Chrome/Chromium binary must be available for CDP self-test");

    const { gzBytes } = createTarGz([
      { path: "download/hello.txt", type: "file", content: "CDP_DOWNLOAD_OK\n" },
    ]);
    const b64Gz = Buffer.from(gzBytes).toString("base64");

    const pageHtml = `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { background: #ffffff; color: #111111; margin: 0; }
  @media (prefers-color-scheme: dark) {
    body { background: #0d1117; color: #e6edf3; }
  }
</style>
</head>
<body>
  <div id="transparent-child" style="background: transparent; color: #111111;">hi</div>
  <button id="dl-btn" type="button">Download</button>
  <script>
    document.getElementById("dl-btn").addEventListener("click", () => {
      const bin = atob(${JSON.stringify(b64Gz)});
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const blob = new Blob([arr], { type: "application/gzip" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "selftest-output.tar.gz";
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
  </script>
</body>
</html>`;

    const srv = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(pageHtml);
    });
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${srv.address().port}/`;

    const browser = await launchCdpBrowser({
      chromePath,
      colorScheme: "light",
      viewport: { width: 390, height: 844, mobile: true },
    });
    try {
      await browser.enableDownloads();
      await browser.navigate(url);

      // Verify initial Light scheme & viewport 390x844
      const lightInfo = await browser.evaluate(
        `({
          prefersDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
          width: window.innerWidth,
          height: window.innerHeight,
        })`,
        { awaitPromise: false }
      );
      assert.equal(lightInfo.prefersDark, false, "colorScheme='light' must set prefers-color-scheme: light");
      assert.equal(lightInfo.width, 390, "viewport width must be 390");
      assert.equal(lightInfo.height, 844, "viewport height must be 844");

      const lightStyles = await browser.getComputedStyles("body", ["backgroundColor", "color"]);
      assert.ok(relativeLuminance(lightStyles.backgroundColor) > 0.9, `Light bg expected, got ${lightStyles.backgroundColor}`);
      assert.ok(contrastRatio(lightStyles.backgroundColor, lightStyles.color) >= 10);

      // Verify getEffectiveColors walks up from transparent child to opaque Light body background
      const transparentChildColors = await getEffectiveColors(browser, "#transparent-child");
      assert.ok(
        transparentChildColors && transparentChildColors.bgLuminance > 0.9,
        `Expected transparent child to inherit Light body bg (L > 0.9), got ${JSON.stringify(transparentChildColors)}`
      );
      assert.ok(
        transparentChildColors.contrast >= 10,
        `Expected transparent child contrast >= 10, got ${transparentChildColors.contrast}`
      );

      // Flip to Dark scheme dynamically
      await browser.setColorScheme("dark");
      const darkPref = await browser.evaluate(
        `window.matchMedia("(prefers-color-scheme: dark)").matches`,
        { awaitPromise: false }
      );
      assert.equal(darkPref, true, "setColorScheme('dark') must activate prefers-color-scheme: dark");
      const darkStyles = await browser.getComputedStyles("body", ["backgroundColor", "color"]);
      assert.ok(relativeLuminance(darkStyles.backgroundColor) < 0.05, `Dark bg expected, got ${darkStyles.backgroundColor}`);
      assert.ok(contrastRatio(darkStyles.backgroundColor, darkStyles.color) >= 10);

      // Trigger real Chrome blob download and verify captured tar.gz bytes
      await browser.click("#dl-btn");
      const dl = await browser.waitForDownload(15000);
      assertIncludes(dl.suggestedFilename, "selftest-output.tar.gz");
      assert.equal(dl.bytes[0], 0x1f);
      assert.equal(dl.bytes[1], 0x8b);
      const parsed = parseTarEntries(zlib.gunzipSync(dl.bytes));
      assert.equal(Buffer.from(parsed[0].data).toString("utf8"), "CDP_DOWNLOAD_OK\n");
    } finally {
      await browser.close();
      await new Promise((resolve) => srv.close(resolve));
    }
  });

  return suite.run(opts);
}

function printSummary(suites, totalDurationMs) {
  console.log("\n=== elf2wasm v2 E2E Summary ===");
  let totalPassed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;

  for (const s of suites) {
    totalPassed += s.passed;
    totalFailed += s.failed;
    totalSkipped += s.skipped;
    const status = s.failed === 0 ? "PASS" : "FAIL";
    const skipStr = s.skipped > 0 ? `, ${s.skipped} skipped` : "";
    console.log(`${s.name}: ${status} (${s.passed}/${s.total}${skipStr}, ${formatDuration(s.durationMs)})`);
  }

  console.log(
    `TOTAL: ${totalPassed} passed, ${totalFailed} failed, ${totalSkipped} skipped (${formatDuration(totalDurationMs)})`
  );
  return { totalPassed, totalFailed, totalSkipped };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`CLI Error: ${err.message}`);
    printHelp();
    process.exit(2);
  }

  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  const startAll = Date.now();
  const suites = [];

  if (opts.selfTest) {
    suites.push(await runV2SelfTest({ verbose: opts.verbose }));
  } else {
    const selectedTiers = opts.tier === "all" ? ["1", "2", "3", "4"] : [opts.tier];
    const prereq = checkPrerequisites({
      requireChrome: true,
      requireWorkerWasm: true,
      requireDockerfile: true,
    });

    if (!prereq.ok) {
      console.error("Prerequisite check failed — cannot run v2 E2E tiers:");
      for (const item of prereq.missing) {
        console.error(`  - Missing ${item}`);
      }
      console.error(
        "\nBuild M2-M5 artifacts first, or run `node e2e_docker_web/run_v2_e2e.mjs --self-test` to verify harness health."
      );
      process.exit(2);
    }

    for (const tier of selectedTiers) {
      if (tier === "1") {
        const { runV2Tier1 } = await import("./tier1_v2_features.mjs");
        suites.push(await runV2Tier1({ verbose: opts.verbose }));
      } else if (tier === "2") {
        const { runV2Tier2 } = await import("./tier2_v2_boundaries.mjs");
        suites.push(await runV2Tier2({ verbose: opts.verbose }));
      } else if (tier === "3") {
        const { runV2Tier3 } = await import("./tier3_v2_combinations.mjs");
        suites.push(await runV2Tier3({ verbose: opts.verbose }));
      } else if (tier === "4") {
        const { runV2Tier4 } = await import("./tier4_v2_scenarios.mjs");
        suites.push(await runV2Tier4({ verbose: opts.verbose, skipLive: opts.skipLive }));
      }
    }
  }

  const totalDurationMs = Date.now() - startAll;
  const totals = printSummary(suites, totalDurationMs);

  if (opts.jsonFile) {
    const outPath = path.resolve(opts.jsonFile);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(
      outPath,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          options: opts,
          durationMs: totalDurationMs,
          ...totals,
          suites,
        },
        null,
        2
      )
    );
  }

  process.exit(totals.totalFailed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`Fatal v2 E2E runner error: ${err && err.stack ? err.stack : err}`);
  process.exit(2);
});
