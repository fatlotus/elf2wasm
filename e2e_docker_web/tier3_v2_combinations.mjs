// Tier 3 (v2): Cross-Feature Combinations (Offline)
// Covers Multi-Layer Stack (FROM+GIT+WORKDIR+ENV+RUN), Local-vs-Remote Determinism Parity,
// Mixed Local+Remote Stack + Browser .tar.gz Download, Generalized Sweep (env/delay/seed)
// across multiple downstream layers, and URL State Round-Trip (F4, F5, F7, F8, F9, F10, F12, F13).
// Zero external dependencies (Node.js 22 built-ins + e2e_docker_web/helpers/*).

import zlib from "node:zlib";
import {
  Suite,
  assert,
  assertIncludes,
  waitFor,
} from "./helpers/test_runner.mjs";
import { findChromeBinary, startServer } from "./helpers/server_harness.mjs";
import { startMockOciRegistry } from "./helpers/mock_oci_registry.mjs";
import { startMockGitServer } from "./helpers/mock_git_server.mjs";
import { parseTarEntries } from "./helpers/tar_builder.mjs";
import { launchCdpBrowser } from "./helpers/cdp_browser.mjs";
import { postEvalJson, decodeTarGzBase64 } from "./helpers/eval_client.mjs";
import {
  setDockerfileText,
  getDockerfileText,
  setEditorMode,
  clickGlobalRun,
  clickControlByLabel,
  getTerminalOutput,
  waitForTerminalMatch,
  getSweepTableRows,
  clickSweepTableRow,
} from "./helpers/v2_ui_helpers.mjs";

function findTarEntry(entries, suffix) {
  const norm = suffix.replace(/^\/+/, "");
  return entries.find((e) => e.name.replace(/^\.\//, "").replace(/^\/+/, "") === norm);
}

export async function runV2Tier3(opts = {}) {
  const suite = new Suite("Tier 3 (v2): Cross-Feature Combinations (Offline)");
  const chromePath = findChromeBinary();

  let registry = null;
  let gitServer = null;
  let server = null;
  let alpineRef = null;
  let gitRepoUrl = null;

  async function ensureEnv() {
    if (!registry) {
      registry = await startMockOciRegistry({ requireAuth: false });
      alpineRef = registry.imageRef("library/alpine", "latest");
    }
    if (!gitServer) {
      gitServer = await startMockGitServer({ redirectArchives: false });
      gitServer.addRepo("testorg/demo", {
        main: [
          { path: "demo-main/", type: "dir", mode: 0o755 },
          { path: "demo-main/msg.txt", type: "file", content: "FROM_MOCK_GIT_REPO\n", mode: 0o644 },
          {
            path: "demo-main/build.sh",
            type: "file",
            mode: 0o755,
            content: "#!/bin/sh\necho \"BUILT:${BUILD_TAG}:$(cat msg.txt)\" > /workspace/artifact.txt\n",
          },
        ],
      });
      gitRepoUrl = gitServer.repoUrl("testorg/demo");
    }
    if (!server) {
      server = await startServer({ allowLocalRegistries: true });
    }
  }

  suite.add("T3-V2.1", "F7/F8/F12 Multi-layer stack (FROM + GIT + WORKDIR + ENV + chained RUN layers)", async () => {
    await ensureEnv();
    const browser = await launchCdpBrowser({ chromePath, colorScheme: "light" });
    try {
      await browser.navigate(server.url);
      await browser.waitForSelector("body", 10000);

      const df = [
        `FROM ${alpineRef}`,
        `RUN git clone --branch main ${gitRepoUrl} /workspace`,
        "WORKDIR /workspace",
        "ENV BUILD_TAG=v2_combo",
        "RUN sh /workspace/build.sh",
        "RUN cat /workspace/artifact.txt && echo STACK_CHAIN_DONE",
      ].join("\n");

      await setDockerfileText(browser, df);
      const clicked = await clickGlobalRun(browser, "local");
      assert.ok(clicked.clicked, "Could not trigger Run All Locally");

      const termText = await waitForTerminalMatch(browser, /^STACK_CHAIN_DONE$/m, {
        timeoutMs: 120000,
        label: "multi-layer stack completion",
      });
      assertIncludes(termText, "BUILT:v2_combo:FROM_MOCK_GIT_REPO");
      assert.deepEqual(browser.exceptions, [], `Uncaught exceptions: ${JSON.stringify(browser.exceptions)}`);
    } finally {
      await browser.close();
    }
  });

  suite.add("T3-V2.2", "F4/F5/F8 Local browser vs Remote Worker determinism parity (delaySeed=0 and delaySeed=4242)", async () => {
    await ensureEnv();

    const makeCmd = (tag) =>
      `od -An -tx1 -N8 /dev/urandom | tr -d ' \\n' > /tmp/det.hex && echo ${tag}=$(cat /tmp/det.hex)`;

    // 1a. Remote evaluation with default delayStddevMs=0, delaySeed=0
    const remoteDefault = await postEvalJson(server.url, {
      baseImage: alpineRef,
      cmd: ["/bin/sh", "-c", makeCmd("PARITY_DEFAULT")],
      cwd: "/",
      delayStddevMs: 0,
      delaySeed: 0,
      returnOutputDiff: true,
    });
    assert.equal(remoteDefault.status, 200, `Remote default /api/eval failed: ${remoteDefault.text}`);
    assert.equal(remoteDefault.json?.exitCode, 0, `Remote default exitCode != 0: ${JSON.stringify(remoteDefault.json)}`);
    const remoteDefaultMatch = remoteDefault.json.stdout.match(/PARITY_DEFAULT=([0-9a-f]{16})/);
    assert.ok(remoteDefaultMatch, `Remote default stdout missing PARITY_DEFAULT=<hex>: ${remoteDefault.json.stdout}`);
    const remoteDefaultHex = remoteDefaultMatch[1];

    const decodedDefault = decodeTarGzBase64(remoteDefault.json.outputDiffTarGzBase64);
    const detDefaultFile = findTarEntry(decodedDefault.entries, "tmp/det.hex");
    assert.ok(detDefaultFile, "Remote default diff tar must include tmp/det.hex");
    assert.equal(Buffer.from(detDefaultFile.data).toString("utf8"), remoteDefaultHex);

    // 1b. Remote evaluation with non-zero delaySeed=4242
    const remoteSeed = await postEvalJson(server.url, {
      baseImage: alpineRef,
      cmd: ["/bin/sh", "-c", makeCmd("PARITY_SEED4242")],
      cwd: "/",
      delayStddevMs: 0,
      delaySeed: 4242,
      returnOutputDiff: true,
    });
    assert.equal(remoteSeed.status, 200, `Remote seeded /api/eval failed: ${remoteSeed.text}`);
    assert.equal(remoteSeed.json?.exitCode, 0, `Remote seeded exitCode != 0: ${JSON.stringify(remoteSeed.json)}`);
    const remoteSeedMatch = remoteSeed.json.stdout.match(/PARITY_SEED4242=([0-9a-f]{16})/);
    assert.ok(remoteSeedMatch, `Remote seeded stdout missing PARITY_SEED4242=<hex>: ${remoteSeed.json.stdout}`);
    const remoteSeedHex = remoteSeedMatch[1];

    const decodedSeed = decodeTarGzBase64(remoteSeed.json.outputDiffTarGzBase64);
    const detSeedFile = findTarEntry(decodedSeed.entries, "tmp/det.hex");
    assert.ok(detSeedFile, "Remote seeded diff tar must include tmp/det.hex");
    assert.equal(Buffer.from(detSeedFile.data).toString("utf8"), remoteSeedHex);

    assert.notEqual(
      remoteSeedHex,
      remoteDefaultHex,
      `Varying delaySeed (0 vs 4242) must produce distinct deterministic PRNG output (both were ${remoteDefaultHex})`
    );

    // 2. Local browser evaluation with identical commands for BOTH delaySeed=0 and delaySeed=4242
    const browser = await launchCdpBrowser({ chromePath, colorScheme: "light" });
    try {
      await browser.navigate(server.url);
      await browser.waitForSelector("body", 10000);

      // 2a. Local default run (delaySeed=0)
      const defaultDf = [
        `FROM ${alpineRef}`,
        `RUN ${makeCmd("PARITY_DEFAULT")}`,
      ].join("\n");
      await setDockerfileText(browser, defaultDf);
      const clickedDefault = await clickGlobalRun(browser, "local");
      assert.ok(clickedDefault.clicked, "Could not trigger Run All Locally for default parity run");

      const localDefaultOut = await waitForTerminalMatch(browser, /PARITY_DEFAULT=[0-9a-f]{16}/, {
        timeoutMs: 120000,
        label: "local browser default parity output",
      });
      const localDefaultMatch = localDefaultOut.match(/PARITY_DEFAULT=([0-9a-f]{16})/);
      assert.ok(localDefaultMatch, `Local default output missing PARITY_DEFAULT=<hex>: ${localDefaultOut}`);
      assert.equal(
        localDefaultMatch[1],
        remoteDefaultHex,
        `Local vs Remote deterministic mismatch (delaySeed=0)! local=${localDefaultMatch[1]} remote=${remoteDefaultHex}`
      );

      // 2b. Local seeded run (delaySeed=4242 via single-value seed sweep)
      const seededDf = [
        `FROM ${alpineRef}`,
        "# elf2wasm:sweep param=seed mode=list values=4242",
        `RUN ${makeCmd("PARITY_SEED4242")}`,
      ].join("\n");
      await setDockerfileText(browser, seededDf);
      const clickedSeed = await clickGlobalRun(browser, "local");
      assert.ok(clickedSeed.clicked, "Could not trigger Run All Locally for seeded parity run");

      await waitFor(
        async () => {
          const rows = await getSweepTableRows(browser);
          return rows.length >= 1 && rows.some((r) => r.text.includes("4242")) ? rows : false;
        },
        { timeoutMs: 120000, intervalMs: 300, label: "seeded sweep row (4242)" }
      );
      await clickSweepTableRow(browser, 0);

      const localSeedOut = await waitForTerminalMatch(browser, /PARITY_SEED4242=[0-9a-f]{16}/, {
        timeoutMs: 30000,
        label: "local browser seeded (4242) parity output",
      });
      const localSeedMatch = localSeedOut.match(/PARITY_SEED4242=([0-9a-f]{16})/);
      assert.ok(localSeedMatch, `Local seeded output missing PARITY_SEED4242=<hex>: ${localSeedOut}`);
      assert.equal(
        localSeedMatch[1],
        remoteSeedHex,
        `Local vs Remote deterministic mismatch (delaySeed=4242)! local=${localSeedMatch[1]} remote=${remoteSeedHex}`
      );

      assert.deepEqual(browser.exceptions, [], `Uncaught exceptions: ${JSON.stringify(browser.exceptions)}`);
    } finally {
      await browser.close();
    }
  });

  suite.add("T3-V2.3", "F8/F13 Mixed Local + Remote stack & per-layer browser .tar.gz download verification", async () => {
    await ensureEnv();
    const browser = await launchCdpBrowser({ chromePath, colorScheme: "light" });
    try {
      await browser.enableDownloads();
      await browser.navigate(server.url);
      await browser.waitForSelector("body", 10000);

      const df = [
        `FROM ${alpineRef}`,
        "RUN printf 'REMOTE_BUILT_ARTIFACT\\n' > /tmp/layer1.txt && echo LAYER1_REMOTE_OK",
        "RUN cat /tmp/layer1.txt && echo LAYER2_LOCAL_OK",
      ].join("\n");
      await setDockerfileText(browser, df);
      await setEditorMode(browser, "builder");

      // Configure Layer 1 (first RUN) -> Remote, Layer 2 (second RUN) -> Local
      const configured = await browser.evaluate(
        `(() => {
          const toggles = Array.from(document.querySelectorAll(".layer-executor-toggle"));
          if (toggles.length >= 2) {
            const runToggles = toggles.slice(-2);
            const clickTarget = (group, target) => {
              const btn = group.querySelector('button[data-layer-executor="' + target + '"]');
              if (!btn) return false;
              btn.click();
              return btn.getAttribute("aria-pressed") === "true";
            };
            const firstOk = clickTarget(runToggles[0], "remote");
            const secondOk = clickTarget(runToggles[1], "local");
            return { ok: firstOk && secondOk, count: runToggles.length, mode: "segmented" };
          }
          const selects = Array.from(document.querySelectorAll("select")).filter((sel) =>
            Array.from(sel.options).some((o) => /local/i.test(o.value + " " + o.textContent)) &&
            Array.from(sel.options).some((o) => /remote/i.test(o.value + " " + o.textContent))
          );
          const runSelects = selects.length >= 2 ? selects.slice(-2) : selects;
          if (runSelects.length < 2) return { ok: false, count: selects.length };
          const setVal = (sel, target) => {
            const opt = Array.from(sel.options).find((o) => new RegExp(target, "i").test(o.value + " " + o.textContent));
            if (opt) {
              sel.value = opt.value;
              sel.dispatchEvent(new Event("input", { bubbles: true }));
              sel.dispatchEvent(new Event("change", { bubbles: true }));
            }
          };
          setVal(runSelects[0], "remote");
          setVal(runSelects[1], "local");
          return { ok: true, count: runSelects.length, mode: "select" };
        })()`,
        { awaitPromise: false }
      );
      assert.ok(configured.ok, `Expected >= 2 per-layer local/remote selectors, found ${configured.count}`);

      browser.clearLogs();

      // Run stack preserving per-layer executor choices
      const runClicked = await clickControlByLabel(browser, /^run(\s+stack|\s+all)?$|^execute$/i);
      assert.ok(runClicked.clicked, "Could not click Run stack button");

      const termText = await waitForTerminalMatch(browser, /^LAYER2_LOCAL_OK$/m, {
        timeoutMs: 120000,
        label: "mixed remote->local stack completion",
      });
      assertIncludes(termText, "REMOTE_BUILT_ARTIFACT", "Local Layer 2 must see Remote Layer 1's output file");

      // Verify /api/eval was called for the Remote layer ONLY (exactly 1 POST /api/eval)
      const evalCalls = browser.networkRequests.filter(
        (r) => r.method === "POST" && r.url.includes("/api/eval")
      );
      assert.equal(
        evalCalls.length,
        1,
        `Expected exactly 1 POST /api/eval call (for Remote Layer 1 only), saw ${evalCalls.length}`
      );

      // Click per-layer Download button and verify downloaded .tar.gz archive via CDP
      const dlClicked = await clickControlByLabel(browser, /download|tar\.gz/i);
      assert.ok(dlClicked.clicked, "Expected a per-layer Download outputs (.tar.gz) button after execution");
      const download = await browser.waitForDownload(15000);
      assert.ok(download.bytes.length >= 2, "Downloaded archive must be non-empty");
      assert.equal(download.bytes[0], 0x1f, "Downloaded file must have gzip magic byte 0");
      assert.equal(download.bytes[1], 0x8b, "Downloaded file must have gzip magic byte 1");

      const tarBuf = zlib.gunzipSync(download.bytes);
      const entries = parseTarEntries(tarBuf);
      const artifact = findTarEntry(entries, "tmp/layer1.txt");
      assert.ok(artifact, `Downloaded tar.gz must contain tmp/layer1.txt; got ${entries.map((e) => e.name).join(", ")}`);
      assert.equal(Buffer.from(artifact.data).toString("utf8"), "REMOTE_BUILT_ARTIFACT\n");
    } finally {
      await browser.close();
    }
  });

  suite.add("T3-V2.4", "F9/F12 Configurable env sweep (list mode) across 2 downstream RUN layers + row-click terminal inspection", async () => {
    await ensureEnv();
    const browser = await launchCdpBrowser({ chromePath, colorScheme: "light" });
    try {
      await browser.navigate(server.url);
      await browser.waitForSelector("body", 10000);

      const df = [
        `FROM ${alpineRef}`,
        "# elf2wasm:sweep param=env envKey=MODE mode=list values=alpha,beta,gamma",
        "RUN printf '%s' \"$MODE\" > /tmp/stage1.txt",
        "RUN echo \"SWEEP_ENV_OUT=$(cat /tmp/stage1.txt)_STEP2\"",
      ].join("\n");
      await setDockerfileText(browser, df);
      const clicked = await clickGlobalRun(browser, "local");
      assert.ok(clicked.clicked, "Could not start env sweep");

      await waitFor(
        async () => {
          const rows = await getSweepTableRows(browser);
          return rows.length === 3 ? rows : false;
        },
        { timeoutMs: 120000, intervalMs: 300, label: "3 env sweep result rows" }
      );

      const expectedOutputs = ["SWEEP_ENV_OUT=alpha_STEP2", "SWEEP_ENV_OUT=beta_STEP2", "SWEEP_ENV_OUT=gamma_STEP2"];
      const seenOutputs = new Set();
      for (let i = 0; i < 3; i++) {
        const rowClicked = await clickSweepTableRow(browser, i);
        assert.ok(rowClicked, `Could not click sweep result row ${i}`);
        await waitFor(
          async () => {
            const text = await getTerminalOutput(browser);
            return expectedOutputs.some((exp) => !seenOutputs.has(exp) && text.includes(exp));
          },
          { timeoutMs: 5000, intervalMs: 100, label: `terminal update for sweep row ${i}` }
        );
        const text = await getTerminalOutput(browser);
        for (const exp of expectedOutputs) {
          if (text.includes(exp)) seenOutputs.add(exp);
        }
      }

      assert.equal(
        seenOutputs.size,
        3,
        `Clicking each of the 3 sweep rows must display all 3 distinct outputs; saw ${Array.from(seenOutputs).join(", ")}`
      );
      assert.deepEqual(browser.exceptions, [], `Uncaught exceptions: ${JSON.stringify(browser.exceptions)}`);
    } finally {
      await browser.close();
    }
  });

  suite.add("T3-V2.5", "F9/F12 Configurable delay sweep (range) & seed sweep (range) produce 3 varied rows", async () => {
    await ensureEnv();
    const browser = await launchCdpBrowser({ chromePath, colorScheme: "light" });
    try {
      await browser.navigate(server.url);
      await browser.waitForSelector("body", 10000);

      // 1. Delay range sweep: start=0, step=5, count=3 -> 0, 5, 10
      const delayDf = [
        `FROM ${alpineRef}`,
        "# elf2wasm:sweep param=delay mode=range start=0 step=5 count=3",
        "RUN echo DELAY_SWEEP_OK",
      ].join("\n");
      await setDockerfileText(browser, delayDf);
      const delayRun = await clickGlobalRun(browser, "local");
      assert.ok(delayRun.clicked, "Could not start delay sweep");

      const delayRows = await waitFor(
        async () => {
          const rows = await getSweepTableRows(browser);
          return rows.length === 3 ? rows : false;
        },
        { timeoutMs: 120000, intervalMs: 300, label: "3 delay sweep rows" }
      );
      const delayText = delayRows.map((r) => r.text).join(" | ");
      assertIncludes(delayText, "0");
      assertIncludes(delayText, "5");
      assertIncludes(delayText, "10");

      // 2. Seed range sweep: start=10, step=1, count=3 -> 10, 11, 12 with distinct /dev/urandom outputs
      const seedDf = [
        `FROM ${alpineRef}`,
        "# elf2wasm:sweep param=seed mode=range start=10 step=1 count=3",
        "RUN echo SEED_HEX=$(od -An -tx1 -N8 /dev/urandom | tr -d ' \\n')",
      ].join("\n");
      await setDockerfileText(browser, seedDf);
      const seedRun = await clickGlobalRun(browser, "local");
      assert.ok(seedRun.clicked, "Could not start seed sweep");

      const seedRows = await waitFor(
        async () => {
          const rows = await getSweepTableRows(browser);
          if (rows.length !== 3) return false;
          const joined = rows.map((r) => r.text).join(" | ");
          return joined.includes("11") && joined.includes("12") ? rows : false;
        },
        { timeoutMs: 120000, intervalMs: 300, label: "3 seed sweep rows (10, 11, 12)" }
      );
      const seedText = seedRows.map((r) => r.text).join(" | ");
      assertIncludes(seedText, "10");
      assertIncludes(seedText, "11");
      assertIncludes(seedText, "12");

      // Click each of the 3 seed rows and verify 3 distinct SEED_HEX values are produced
      const seenSeedHexes = new Set();
      for (let i = 0; i < 3; i++) {
        const rowClicked = await clickSweepTableRow(browser, i);
        assert.ok(rowClicked, `Could not click seed sweep row ${i}`);
        const hex = await waitFor(
          async () => {
            const text = await getTerminalOutput(browser);
            const m = text.match(/SEED_HEX=([0-9a-f]{16})/);
            return m && !seenSeedHexes.has(m[1]) ? m[1] : false;
          },
          { timeoutMs: 5000, intervalMs: 100, label: `distinct SEED_HEX for seed sweep row ${i}` }
        );
        seenSeedHexes.add(hex);
      }
      assert.equal(
        seenSeedHexes.size,
        3,
        `Seed sweep (10, 11, 12) must produce 3 distinct SEED_HEX values; saw ${Array.from(seenSeedHexes).join(", ")}`
      );

      assert.deepEqual(browser.exceptions, [], `Uncaught exceptions: ${JSON.stringify(browser.exceptions)}`);
    } finally {
      await browser.close();
    }
  });

  suite.add("T3-V2.6", "F10 URL state round-trip preserves multi-layer Dockerfile, sweep config & execution targets", async () => {
    await ensureEnv();
    const browser1 = await launchCdpBrowser({ chromePath, colorScheme: "light" });
    let sharedUrl = "";
    try {
      await browser1.navigate(server.url);
      await browser1.waitForSelector("body", 10000);

      const df = [
        `FROM ${alpineRef}`,
        "WORKDIR /workspace",
        "ENV URL_RT=preserved_99",
        "# elf2wasm:sweep param=env envKey=VARIANT mode=list values=one,two",
        "RUN echo $URL_RT:$VARIANT",
      ].join("\n");
      await setDockerfileText(browser1, df);

      // Wait briefly for URL state sync (or click Share/Copy Link if present)
      await clickControlByLabel(browser1, /share|copy\s+link|permalink/i).catch(() => {});
      sharedUrl = await waitFor(
        async () => {
          const href = await browser1.evaluate("window.location.href", { awaitPromise: false });
          return href && new URL(href).search.length > 1 ? href : false;
        },
        { timeoutMs: 5000, intervalMs: 100, label: "URL query state update" }
      );
    } finally {
      await browser1.close();
    }

    // Load sharedUrl in a brand-new clean browser instance
    const browser2 = await launchCdpBrowser({ chromePath, colorScheme: "light" });
    try {
      await browser2.navigate(sharedUrl);
      await browser2.waitForSelector("body", 10000);
      await setEditorMode(browser2, "dockerfile");
      const restoredDf = await getDockerfileText(browser2);
      assertIncludes(restoredDf, alpineRef, "Restored Dockerfile must preserve FROM image");
      assertIncludes(restoredDf, "URL_RT=preserved_99", "Restored Dockerfile must preserve ENV");
      assertIncludes(restoredDf, "VARIANT", "Restored Dockerfile must preserve sweep envKey");
      assertIncludes(restoredDf, "one", "Restored Dockerfile must preserve sweep values");
      assert.deepEqual(browser2.exceptions, [], `Uncaught exceptions on URL restore: ${JSON.stringify(browser2.exceptions)}`);
    } finally {
      await browser2.close();
    }
  });

  try {
    return await suite.run(opts);
  } finally {
    if (server) await server.close();
    if (gitServer) await gitServer.close();
    if (registry) await registry.close();
  }
}
