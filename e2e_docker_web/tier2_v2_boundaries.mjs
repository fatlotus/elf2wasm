// Tier 2 (v2): Boundaries, Error Handling, SSRF Protection, OCI Whiteouts,
// Invalid Dockerfile Recovery, Sweep Validation, and Responsive Mobile Phone Viewport (390x844).
// Zero external dependencies (Node.js 22 built-ins + e2e_docker_web/helpers/*).

import {
  Suite,
  assert,
  assertIncludes,
  waitFor,
} from "./helpers/test_runner.mjs";
import { findChromeBinary, startServer } from "./helpers/server_harness.mjs";
import { startMockOciRegistry } from "./helpers/mock_oci_registry.mjs";
import { launchCdpBrowser } from "./helpers/cdp_browser.mjs";
import { postEvalJson, decodeTarGzBase64 } from "./helpers/eval_client.mjs";
import {
  getEffectiveColors,
  setDockerfileText,
  setEditorMode,
  clickGlobalRun,
  waitForTerminalMatch,
} from "./helpers/v2_ui_helpers.mjs";

function findTarEntry(entries, suffix) {
  const norm = suffix.replace(/^\/+/, "");
  return entries.find((e) => e.name.replace(/^\.\//, "").replace(/^\/+/, "") === norm);
}

export async function runV2Tier2(opts = {}) {
  const suite = new Suite("Tier 2 (v2): Boundaries, Errors, Whiteouts & Mobile Viewport");
  const chromePath = findChromeBinary();

  let registry = null;
  let serverLocalAllowed = null;
  let serverSsrfStrict = null;
  let alpineRef = null;

  async function ensureEnv() {
    if (!registry) {
      registry = await startMockOciRegistry({ requireAuth: false });
      alpineRef = registry.imageRef("library/alpine", "latest");
    }
    if (!serverLocalAllowed) {
      serverLocalAllowed = await startServer({ allowLocalRegistries: true });
    }
  }

  async function ensureStrictServer() {
    if (!serverSsrfStrict) {
      serverSsrfStrict = await startServer({ allowLocalRegistries: false });
    }
  }

  suite.add("T2-V2.1", "F5/F6 POST /api/eval rejects malformed JSON, missing baseImage, invalid cmd, and SSRF baseImage with COOP/COEP", async () => {
    await ensureEnv();
    await ensureStrictServer();

    // 1. Malformed JSON -> 400 + structured error
    const badJson = await postEvalJson(serverLocalAllowed.url, "", { rawBody: "{not-valid-json" });
    assert.equal(badJson.status, 400, `Malformed JSON must return 400, got ${badJson.status}: ${badJson.text}`);
    assert.equal(badJson.json?.ok, false, `Expected { ok: false }, got: ${badJson.text}`);
    assert.ok(typeof badJson.json?.error === "string" && badJson.json.error.length > 0, "Error message must be non-empty");
    assert.equal(badJson.headers["cross-origin-opener-policy"], "same-origin", "COOP header must be set on error responses");
    assert.equal(badJson.headers["cross-origin-embedder-policy"], "require-corp", "COEP header must be set on error responses");

    // 2. Missing baseImage -> 400
    const missingImg = await postEvalJson(serverLocalAllowed.url, { cmd: ["/bin/sh", "-c", "echo hi"] });
    assert.equal(missingImg.status, 400, `Missing baseImage must return 400, got ${missingImg.status}: ${missingImg.text}`);
    assert.equal(missingImg.json?.ok, false);
    assert.ok(typeof missingImg.json?.code === "string" && missingImg.json.code.length > 0, "Structured error code required");

    // 3. Invalid cmd (empty array / wrong type) -> 400
    const badCmd = await postEvalJson(serverLocalAllowed.url, { baseImage: alpineRef, cmd: [] });
    assert.equal(badCmd.status, 400, `Empty cmd must return 400, got ${badCmd.status}: ${badCmd.text}`);
    assert.equal(badCmd.json?.ok, false);

    // 4. SSRF baseImage (127.0.0.1) against strict allowLocalRegistries: false server -> 400/403/502 + ok:false
    const ssrfRes = await postEvalJson(serverSsrfStrict.url, {
      baseImage: alpineRef,
      cmd: ["/bin/sh", "-c", "echo should_not_run"],
    });
    assert.ok(
      [400, 403, 502].includes(ssrfRes.status),
      `SSRF baseImage against strict server must return 400/403/502, got ${ssrfRes.status}: ${ssrfRes.text}`
    );
    assert.equal(ssrfRes.json?.ok, false, `SSRF response must have ok:false, got ${ssrfRes.text}`);
    assert.equal(ssrfRes.headers["cross-origin-opener-policy"], "same-origin");
    assert.equal(ssrfRes.headers["cross-origin-embedder-policy"], "require-corp");
  });

  suite.add("T2-V2.2", "F3/F5 inputLayerDiffs chaining & OCI .wh.<name> whiteout emission on file deletion", async () => {
    await ensureEnv();

    // Layer 1 creates /tmp/a.txt and /tmp/del.txt
    const layer1 = await postEvalJson(serverLocalAllowed.url, {
      baseImage: alpineRef,
      cmd: ["/bin/sh", "-c", "printf 'V1\\n' > /tmp/a.txt && printf 'GONE\\n' > /tmp/del.txt"],
      cwd: "/",
      returnOutputDiff: true,
    });
    assert.equal(layer1.status, 200, `Layer 1 failed: ${layer1.text}`);
    assert.equal(layer1.json?.exitCode, 0, `Layer 1 exitCode != 0: ${JSON.stringify(layer1.json)}`);
    assert.ok(layer1.json?.outputDiffTarGzBase64, "Layer 1 must return outputDiffTarGzBase64");

    // Layer 2 receives Layer 1's diff, reads & modifies /tmp/a.txt, and deletes /tmp/del.txt
    const layer2 = await postEvalJson(serverLocalAllowed.url, {
      baseImage: alpineRef,
      inputLayerDiffs: [layer1.json.outputDiffTarGzBase64],
      cmd: [
        "/bin/sh",
        "-c",
        "cat /tmp/a.txt && printf 'V2\\n' >> /tmp/a.txt && rm /tmp/del.txt && echo LAYER2_DONE",
      ],
      cwd: "/",
      returnOutputDiff: true,
    });
    assert.equal(layer2.status, 200, `Layer 2 failed: ${layer2.text}`);
    assert.equal(layer2.json?.exitCode, 0, `Layer 2 exitCode != 0: ${JSON.stringify(layer2.json)}`);
    assertIncludes(layer2.json.stdout, "V1");
    assertIncludes(layer2.json.stdout, "LAYER2_DONE");

    const decoded = decodeTarGzBase64(layer2.json.outputDiffTarGzBase64);
    const updatedA = findTarEntry(decoded.entries, "tmp/a.txt");
    assert.ok(updatedA, `Layer 2 diff must include modified tmp/a.txt; got ${decoded.entries.map((e) => e.name).join(", ")}`);
    assert.equal(Buffer.from(updatedA.data).toString("utf8"), "V1\nV2\n");

    const whiteout = findTarEntry(decoded.entries, "tmp/.wh.del.txt");
    assert.ok(
      whiteout,
      `Layer 2 diff must emit OCI whiteout tmp/.wh.del.txt; entries=${decoded.entries.map((e) => e.name).join(", ")}`
    );

    const deletedMod = (layer2.json.modifiedFiles || []).find(
      (m) => m.path === "/tmp/del.txt" || m.path === "tmp/del.txt"
    );
    assert.ok(deletedMod, `modifiedFiles must include deleted /tmp/del.txt: ${JSON.stringify(layer2.json.modifiedFiles)}`);
    assert.equal(deletedMod.kind, "deleted", `Expected kind="deleted" for /tmp/del.txt, got ${JSON.stringify(deletedMod)}`);
  });

  suite.add("T2-V2.3", "F7/F12 Invalid Dockerfile displays clear validation error without uncaught exceptions and recovers when fixed", async () => {
    await ensureEnv();
    const browser = await launchCdpBrowser({ chromePath, colorScheme: "light" });
    try {
      await browser.navigate(serverLocalAllowed.url);
      await browser.waitForSelector("body", 10000);

      // Enter malformed Dockerfile (missing FROM / unknown instruction)
      await setDockerfileText(browser, "INVALID_DIRECTIVE_XYZ foo bar\nRUN echo nope\n");

      // Trigger execution or wait for inline error indicator
      const badRun = await clickGlobalRun(browser, "local");
      assert.equal(badRun.clicked, true, "Run All Locally must be clickable on invalid Dockerfile");

      await waitFor(
        async () => {
          const text = await browser.getText("body");
          return /error|invalid|missing\s+from|unknown/i.test(text);
        },
        { timeoutMs: 10000, intervalMs: 150, label: "validation error message for invalid Dockerfile" }
      );
      assert.deepEqual(browser.exceptions, [], `Invalid Dockerfile must not throw uncaught exceptions: ${JSON.stringify(browser.exceptions)}`);

      // Fix the Dockerfile and verify clean recovery
      await setDockerfileText(browser, `FROM ${alpineRef}\nRUN echo RECOVERED_OK\n`);
      const goodRun = await clickGlobalRun(browser, "local");
      assert.equal(goodRun.clicked, true, "Run All Locally must be clickable after fixing Dockerfile");
      await waitForTerminalMatch(browser, /^RECOVERED_OK$/m, {
        timeoutMs: 90000,
        label: "recovery after fixing Dockerfile",
      });

      assert.deepEqual(browser.exceptions, [], `Uncaught exceptions after recovery: ${JSON.stringify(browser.exceptions)}`);
    } finally {
      await browser.close();
    }
  });

  suite.add("T2-V2.4", "F9 Sweep boundary validation: empty list / invalid range handled cleanly without crashing", async () => {
    await ensureEnv();
    const browser = await launchCdpBrowser({ chromePath, colorScheme: "light" });
    try {
      await browser.navigate(serverLocalAllowed.url);
      await browser.waitForSelector("body", 10000);

      const invalidSweeps = [
        `FROM ${alpineRef}\n# elf2wasm:sweep param=env envKey=MODE mode=list values=\nRUN echo $MODE\n`,
        `FROM ${alpineRef}\n# elf2wasm:sweep param=delay mode=range start=-5 step=0 count=0\nRUN echo hi\n`,
      ];

      for (const df of invalidSweeps) {
        await setDockerfileText(browser, df);
        await setEditorMode(browser, "builder");
        await setEditorMode(browser, "dockerfile");
        const runRes = await clickGlobalRun(browser, "local");
        assert.ok(runRes.clicked, "Run All Locally must be clickable for invalid sweep boundary test");

        await waitFor(
          async () => {
            const state = await browser.evaluate(
              `(() => {
                const bodyText = document.body.innerText || "";
                const hasValidationError = /error|invalid|empty|must\\s+be|at\\s+least|clamp/i.test(bodyText);
                const btns = Array.from(document.querySelectorAll("button"));
                const runBtn = btns.find((b) => /run\\s+all\\s+locally|run\\s+locally|^run\\b/i.test(b.textContent || ""));
                const runEnabled = Boolean(runBtn && !runBtn.disabled);
                return { hasValidationError, runEnabled };
              })()`,
              { awaitPromise: false }
            );
            return state.hasValidationError || state.runEnabled;
          },
          { timeoutMs: 30000, intervalMs: 200, label: "invalid sweep validation error or safe clamped completion" }
        );
        assert.deepEqual(
          browser.exceptions,
          [],
          `Invalid sweep boundary must not crash UI: ${JSON.stringify(browser.exceptions)}`
        );
      }

      // Verify clean recovery with a valid Dockerfile after invalid sweep boundaries
      await setDockerfileText(browser, `FROM ${alpineRef}\nRUN echo SWEEP_BOUNDARY_RECOVERED\n`);
      const recoverRun = await clickGlobalRun(browser, "local");
      assert.ok(recoverRun.clicked, "Run All Locally must be clickable for sweep boundary recovery");
      await waitForTerminalMatch(browser, "SWEEP_BOUNDARY_RECOVERED", {
        timeoutMs: 90000,
        label: "recovery after invalid sweep boundaries",
      });
      assert.deepEqual(
        browser.exceptions,
        [],
        `Uncaught exceptions during sweep boundary recovery: ${JSON.stringify(browser.exceptions)}`
      );
    } finally {
      await browser.close();
    }
  });

  suite.add("T2-V2.5", "F11/F13 Responsive mobile phone viewport (390x844): no horizontal overflow, controls accessible, Light & Dark contrast", async () => {
    await ensureEnv();
    const browser = await launchCdpBrowser({
      chromePath,
      colorScheme: "light",
      viewport: { width: 390, height: 844, mobile: true, deviceScaleFactor: 2 },
    });
    try {
      await browser.navigate(serverLocalAllowed.url);
      await browser.waitForSelector("body", 10000);

      const layout = await browser.evaluate(
        `(() => ({
          innerWidth: window.innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          bodyText: document.body.innerText || "",
        }))()`,
        { awaitPromise: false }
      );
      assert.ok(
        layout.scrollWidth <= layout.innerWidth + 2,
        `Mobile viewport 390x844 must not horizontally overflow (scrollWidth=${layout.scrollWidth}, innerWidth=${layout.innerWidth})`
      );
      assert.ok(/run\s+all\s+remotely/i.test(layout.bodyText), "Run All Remotely must be accessible on mobile viewport");

      const lightColors = await getEffectiveColors(browser, "body");
      assert.ok(lightColors.bgLuminance > 0.65 && lightColors.contrast >= 4.5,
        `Mobile Light mode contrast failed: bgL=${lightColors.bgLuminance}, contrast=${lightColors.contrast}`);

      // Switch emulated media to dark on mobile
      await browser.setColorScheme("dark");
      await waitFor(
        async () => {
          const c = await getEffectiveColors(browser, "body");
          return c && c.bgLuminance < 0.25;
        },
        { timeoutMs: 5000, intervalMs: 100, label: "mobile dark mode switch" }
      );
      const darkColors = await getEffectiveColors(browser, "body");
      assert.ok(darkColors.bgLuminance < 0.25 && darkColors.contrast >= 4.5,
        `Mobile Dark mode contrast failed: bgL=${darkColors.bgLuminance}, contrast=${darkColors.contrast}`);

      assert.deepEqual(browser.exceptions, [], `Uncaught exceptions on mobile viewport: ${JSON.stringify(browser.exceptions)}`);
    } finally {
      await browser.close();
    }
  });

  try {
    return await suite.run(opts);
  } finally {
    if (serverLocalAllowed) await serverLocalAllowed.close();
    if (serverSsrfStrict) await serverSsrfStrict.close();
    if (registry) await registry.close();
  }
}
