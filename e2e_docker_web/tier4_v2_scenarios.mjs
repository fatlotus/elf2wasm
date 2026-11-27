// Tier 4 (v2): Full End-to-End User Journeys (Offline) & Live Preset Scenarios (--skip-live gated).
// Zero external dependencies (Node.js 22 built-ins + e2e_docker_web/helpers/*).

import zlib from "node:zlib";
import {
  Suite,
  assert,
  assertIncludes,
  skip,
  waitFor,
} from "./helpers/test_runner.mjs";
import { findChromeBinary, startServer } from "./helpers/server_harness.mjs";
import { startMockOciRegistry } from "./helpers/mock_oci_registry.mjs";
import { parseTarEntries } from "./helpers/tar_builder.mjs";
import { launchCdpBrowser } from "./helpers/cdp_browser.mjs";
import { postEvalJson, postEvalTarGz } from "./helpers/eval_client.mjs";
import {
  getEffectiveColors,
  selectThemeMode,
  setDockerfileText,
  clickGlobalRun,
  clickControlByLabel,
  clickPresetMatching,
  waitForTerminalMatch,
} from "./helpers/v2_ui_helpers.mjs";

function findTarEntry(entries, suffix) {
  const norm = suffix.replace(/^\/+/, "");
  return entries.find((e) => e.name.replace(/^\.\//, "").replace(/^\/+/, "") === norm);
}

export async function runV2Tier4(opts = {}) {
  const skipLive = Boolean(opts.skipLive);
  const suite = new Suite("Tier 4 (v2): End-to-End User Journeys & Live Presets");
  const chromePath = findChromeBinary();

  let registry = null;
  let server = null;
  let alpineRef = null;

  async function ensureEnv() {
    if (!registry) {
      registry = await startMockOciRegistry({ requireAuth: false });
      alpineRef = registry.imageRef("library/alpine", "latest");
    }
    if (!server) {
      server = await startServer({ allowLocalRegistries: true });
    }
  }

  suite.add("T4-V2.1", "Offline full user journey: Light mode -> Dockerfile -> Run All Remotely -> download .tar.gz -> Dark mode -> Run All Locally -> identical output", async () => {
    await ensureEnv();
    const browser = await launchCdpBrowser({ chromePath, colorScheme: "light" });
    try {
      await browser.enableDownloads();
      await browser.navigate(server.url);
      await browser.waitForSelector("body", 10000);

      // 1. Verify initial Light mode
      const lightColors = await getEffectiveColors(browser, "body");
      assert.ok(lightColors.bgLuminance > 0.65, `Expected Light mode initially, got L=${lightColors.bgLuminance}`);

      // 2. Paste Dockerfile & Run All Remotely
      const df = [
        `FROM ${alpineRef}`,
        "ENV JOURNEY_TOKEN=e2e_journey_77",
        "RUN printf 'JOURNEY_FILE=%s\\n' \"$JOURNEY_TOKEN\" > /tmp/journey.txt && echo \"JOURNEY_OUT=$JOURNEY_TOKEN\"",
      ].join("\n");
      await setDockerfileText(browser, df);

      const remoteClick = await clickGlobalRun(browser, "remote");
      assert.ok(remoteClick.clicked, "Could not click Run All Remotely");

      const remoteTerminal = await waitForTerminalMatch(browser, "JOURNEY_OUT=e2e_journey_77", {
        timeoutMs: 120000,
        label: "remote journey output",
      });
      assertIncludes(remoteTerminal, "JOURNEY_OUT=e2e_journey_77");

      // 3. Download outputs (.tar.gz) and verify archive contents
      const dlClick = await clickControlByLabel(browser, /download|tar\.gz/i);
      assert.ok(dlClick.clicked, "Could not click Download outputs (.tar.gz) button");
      const download = await browser.waitForDownload(15000);
      assert.equal(download.bytes[0], 0x1f);
      assert.equal(download.bytes[1], 0x8b);
      const entries = parseTarEntries(zlib.gunzipSync(download.bytes));
      const journeyEntry = findTarEntry(entries, "tmp/journey.txt");
      assert.ok(journeyEntry, "Downloaded archive must contain tmp/journey.txt");
      assert.equal(Buffer.from(journeyEntry.data).toString("utf8"), "JOURNEY_FILE=e2e_journey_77\n");

      // 4. Switch to Dark mode
      const sw = await selectThemeMode(browser, "dark");
      assert.ok(sw.ok, "Could not switch theme to Dark mode");
      await waitFor(
        async () => {
          const c = await getEffectiveColors(browser, "body");
          return c && c.bgLuminance < 0.25;
        },
        { timeoutMs: 5000, intervalMs: 100, label: "switch to Dark mode" }
      );

      // 5. Run All Locally and verify identical output
      const localClick = await clickGlobalRun(browser, "local");
      assert.ok(localClick.clicked, "Could not click Run All Locally");

      const localTerminal = await waitForTerminalMatch(browser, "JOURNEY_OUT=e2e_journey_77", {
        timeoutMs: 120000,
        label: "local journey output",
      });
      assertIncludes(localTerminal, "JOURNEY_OUT=e2e_journey_77");

      assert.deepEqual(browser.exceptions, [], `Uncaught exceptions in user journey: ${JSON.stringify(browser.exceptions)}`);
    } finally {
      await browser.close();
    }
  });

  suite.add("T4-V2.2", "Offline remote failure recovery & Stop/Cancel mid-execution cleanly re-enables UI", async () => {
    await ensureEnv();
    const browser = await launchCdpBrowser({ chromePath, colorScheme: "light" });
    try {
      await browser.navigate(server.url);
      await browser.waitForSelector("body", 10000);

      // 1. Trigger failing remote run (non-existent image tag)
      await setDockerfileText(browser, `FROM 127.0.0.1:${registry.port}/library/does-not-exist:nope\nRUN echo hi\n`);
      await clickGlobalRun(browser, "remote");

      await waitFor(
        async () => {
          const bodyText = await browser.getText("body");
          return /error|failed|not\s+found|404|502/i.test(bodyText);
        },
        { timeoutMs: 30000, intervalMs: 250, label: "remote failure error message" }
      );
      assert.deepEqual(browser.exceptions, [], `Remote failure must not cause uncaught exception: ${JSON.stringify(browser.exceptions)}`);

      // 2. Recover cleanly and test Stop/Cancel on a long-running sleep
      await setDockerfileText(browser, `FROM ${alpineRef}\nRUN echo BEFORE_SLEEP && sleep 30 && echo AFTER_SLEEP\n`);
      await clickGlobalRun(browser, "local");

      await waitForTerminalMatch(browser, "BEFORE_SLEEP", {
        timeoutMs: 60000,
        label: "BEFORE_SLEEP before cancel",
      });

      const stopClicked = await clickControlByLabel(browser, /\bstop\b|\bcancel\b/i);
      assert.ok(stopClicked.clicked, "Stop/Cancel button must be clickable during execution");

      // Verify Run controls become enabled again after cancel
      await waitFor(
        async () => {
          return browser.evaluate(
            `(() => {
              const btns = Array.from(document.querySelectorAll("button"));
              const runBtn = btns.find((b) => /run\s+all\s+locally|run\s+locally|^run\b/i.test(b.textContent || ""));
              return Boolean(runBtn && !runBtn.disabled);
            })()`,
            { awaitPromise: false }
          );
        },
        { timeoutMs: 15000, intervalMs: 200, label: "Run controls re-enabled after Stop/Cancel" }
      );

      assert.deepEqual(browser.exceptions, [], `Uncaught exceptions after cancel: ${JSON.stringify(browser.exceptions)}`);
    } finally {
      await browser.close();
    }
  });

  suite.add("T4-V2.3", "Live preset: Express.js executes cleanly in browser UI (--skip-live gated)", async () => {
    if (skipLive) skip("skipped via --skip-live");
    await ensureEnv();
    const browser = await launchCdpBrowser({ chromePath, colorScheme: "light" });
    try {
      await browser.navigate(server.url);
      await browser.waitForSelector("body", 10000);

      const clicked = await clickPresetMatching(browser, /express/i);
      assert.ok(clicked.clicked, "Express.js preset must be clickable");
      await clickGlobalRun(browser, "local");

      const output = await waitForTerminalMatch(browser, /exit\s*(code)?\s*[:=]?\s*0|pass|ok|express/i, {
        timeoutMs: 180000,
        label: "Express.js preset execution",
      });
      assert.ok(output.length > 0, "Express.js preset must produce terminal output");
      assert.deepEqual(browser.exceptions, [], `Uncaught exceptions: ${JSON.stringify(browser.exceptions)}`);
    } finally {
      await browser.close();
    }
  });

  suite.add("T4-V2.4", "Live preset: Flask executes cleanly in browser UI (--skip-live gated)", async () => {
    if (skipLive) skip("skipped via --skip-live");
    await ensureEnv();
    const browser = await launchCdpBrowser({ chromePath, colorScheme: "light" });
    try {
      await browser.navigate(server.url);
      await browser.waitForSelector("body", 10000);

      const clicked = await clickPresetMatching(browser, /flask/i);
      assert.ok(clicked.clicked, "Flask preset must be clickable");
      await clickGlobalRun(browser, "local");

      const output = await waitForTerminalMatch(browser, /exit\s*(code)?\s*[:=]?\s*0|pass|ok|flask/i, {
        timeoutMs: 180000,
        label: "Flask preset execution",
      });
      assert.ok(output.length > 0, "Flask preset must produce terminal output");
      assert.deepEqual(browser.exceptions, [], `Uncaught exceptions: ${JSON.stringify(browser.exceptions)}`);
    } finally {
      await browser.close();
    }
  });

  suite.add("T4-V2.5", "Live alpine:latest remote POST /api/eval parity & .tar.gz download (--skip-live gated)", async () => {
    if (skipLive) skip("skipped via --skip-live");
    await ensureEnv();

    const payload = {
      baseImage: "alpine:latest",
      cmd: ["/bin/sh", "-c", "printf 'LIVE_ALPINE_OK\\n' > /tmp/live.txt && echo LIVE_EVAL_STDOUT"],
      cwd: "/",
      returnOutputDiff: true,
    };

    const jsonRes = await postEvalJson(server.url, payload, { timeoutMs: 180000 });
    assert.equal(jsonRes.status, 200, `Live /api/eval JSON failed: ${jsonRes.text}`);
    assert.equal(jsonRes.json?.ok, true);
    assert.equal(jsonRes.json?.exitCode, 0);
    assertIncludes(jsonRes.json?.stdout, "LIVE_EVAL_STDOUT");

    const tarRes = await postEvalTarGz(server.url, payload, { timeoutMs: 180000 });
    assert.equal(tarRes.status, 200, `Live /api/eval tar.gz failed: ${tarRes.text}`);
    const entry = findTarEntry(tarRes.entries, "tmp/live.txt");
    assert.ok(entry, "Live downloaded tar.gz must contain tmp/live.txt");
    assert.equal(Buffer.from(entry.data).toString("utf8"), "LIVE_ALPINE_OK\n");
  });

  try {
    return await suite.run(opts);
  } finally {
    if (server) await server.close();
    if (registry) await registry.close();
  }
}
