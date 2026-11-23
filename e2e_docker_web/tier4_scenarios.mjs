// Tier 4: Full Headless Google Chrome Browser Scenarios (Opaque-Box E2E)
// Drives real /usr/bin/google-chrome over CDP against server/server.mjs.

import {
  assert,
  assertIncludes,
  assertMatch,
  stripAnsi,
  sleep,
  skip,
  waitFor,
  Suite,
} from "./helpers/test_runner.mjs";
import { startMockOciRegistry } from "./helpers/mock_oci_registry.mjs";
import { startServer } from "./helpers/server_harness.mjs";
import { launchCdpBrowser } from "./helpers/cdp_browser.mjs";

const COLD_BOOT_TIMEOUT_MS = 90000;
const CMD_TIMEOUT_MS = 25000;

/**
 * Wait until the interactive shell in `#terminal` is ready by observing status or probing a computed command.
 */
async function waitForShellReady(browser, timeoutMs = COLD_BOOT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastProbe = 0;
  let probeCounter = 0;

  while (Date.now() < deadline) {
    const status = (await browser.getText("#status-text")).toLowerCase();
    const term = stripAnsi(await browser.getText("#terminal"));

    // Once status looks running/ready or terminal has a prompt, send a computed probe
    const looksReady =
      status.includes("running") ||
      status.includes("ready") ||
      status.includes("interactive") ||
      /[#$]\s*$/.test(term.trim());

    if (looksReady && Date.now() - lastProbe > 2500) {
      probeCounter += 1;
      lastProbe = Date.now();
      const a = 100 + probeCounter;
      const b = 55;
      const expected = String(a + b);
      await browser.typeIntoTerminal(`echo $((${a}+${b}))`);
      try {
        await waitFor(
          async () => stripAnsi(await browser.getText("#terminal")).includes(expected),
          { timeoutMs: 4000, intervalMs: 250, label: `shell readiness probe ${expected}` }
        );
        return;
      } catch {
        // Keep waiting if shell wasn't quite ready to consume input yet
      }
    }

    await sleep(250);
  }

  const finalStatus = await browser.getText("#status-text");
  const finalTerm = stripAnsi(await browser.getText("#terminal"));
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for interactive shell ready.\n` +
    `#status-text: ${JSON.stringify(finalStatus)}\n` +
    `#terminal tail:\n${finalTerm.slice(-600)}`
  );
}

export async function runTier4(opts = {}) {
  const skipLive = Boolean(opts.skipLive);

  let registry = null;
  let localServer = null;

  try {
    registry = await startMockOciRegistry({ requireAuth: true, redirectBlobs: true });
    localServer = await startServer({ allowLocalRegistries: true });

    const suite = new Suite("Tier 4 (Browser E2E)");

  suite.add("T4.1", "Default Alpine Linux Interactive Shell UI in headless Google Chrome", async () => {
    const browser = await launchCdpBrowser();
    try {
      await browser.navigate(`${localServer.url}/`);
      await browser.waitForSelector("#image-input", 15000);
      await browser.waitForSelector("#start-btn", 15000);
      await browser.waitForSelector("#terminal", 15000);

      const isolated = await browser.evaluate("window.crossOriginIsolated", { awaitPromise: false });
      assert.equal(isolated, true, "window.crossOriginIsolated must be true (COOP/COEP)");

      const defaultImage = await browser.evaluate(
        'document.querySelector("#image-input").value',
        { awaitPromise: false }
      );
      assert.equal(defaultImage, "alpine:latest", "#image-input must default to alpine:latest");

      // Point at local mock registry for deterministic offline verification
      await browser.setInputValue("#image-input", registry.imageRef("library/alpine", "latest"));
      await browser.click("#start-btn");

      await waitForShellReady(browser, COLD_BOOT_TIMEOUT_MS);

      // 1. Computed arithmetic (prevents TTY echo false positives)
      await browser.typeIntoTerminal("echo $((20 + 22))");
      await waitFor(
        async () => stripAnsi(await browser.getText("#terminal")).includes("42"),
        { timeoutMs: CMD_TIMEOUT_MS, intervalMs: 250, label: "computed output 42" }
      );

      // 2. uname -a
      await browser.typeIntoTerminal("uname -a");
      await waitFor(
        async () => {
          const t = stripAnsi(await browser.getText("#terminal"));
          return t.includes("Linux") && t.includes("x86_64");
        },
        { timeoutMs: CMD_TIMEOUT_MS, intervalMs: 250, label: "uname -a Linux x86_64" }
      );

      // 3. ls /
      await browser.typeIntoTerminal("ls /");
      await waitFor(
        async () => {
          const t = stripAnsi(await browser.getText("#terminal"));
          return t.includes("etc") && t.includes("bin");
        },
        { timeoutMs: CMD_TIMEOUT_MS, intervalMs: 250, label: "ls / etc bin" }
      );

      // 4. mkdir + file write + cat
      await browser.typeIntoTerminal('mkdir -p /tmp/demo && printf "%s_%s\\n" hi demo > /tmp/demo/f && cat /tmp/demo/f');
      await waitFor(
        async () => stripAnsi(await browser.getText("#terminal")).includes("hi_demo"),
        { timeoutMs: CMD_TIMEOUT_MS, intervalMs: 250, label: "hi_demo" }
      );

      // 5. Pipeline (computed output avoids TTY echo false positive)
      await browser.typeIntoTerminal('ls / | grep etc | sed "s/etc/PIPE_&_OK/"');
      await waitFor(
        async () => stripAnsi(await browser.getText("#terminal")).includes("PIPE_etc_OK"),
        { timeoutMs: CMD_TIMEOUT_MS, intervalMs: 250, label: "PIPE_etc_OK" }
      );

      // 6. Clear button & Stop button
      const beforeClearLen = (await browser.getText("#terminal")).trim().length;
      assert.ok(beforeClearLen > 0, "Terminal should have output before clicking #clear-btn");
      await browser.click("#clear-btn");
      await waitFor(
        async () => (await browser.getText("#terminal")).trim().length < beforeClearLen,
        { timeoutMs: 5000, intervalMs: 100, label: "#clear-btn clears terminal" }
      );

      await browser.click("#stop-btn");
      await sleep(300);

      assert.deepEqual(browser.exceptions, [], `Uncaught page exceptions: ${JSON.stringify(browser.exceptions)}`);
      assert.deepEqual(browser.consoleErrors, [], `Console errors: ${JSON.stringify(browser.consoleErrors)}`);
    } finally {
      await browser.close();
    }
  });

  suite.add("T4.2", "Programmatic Browser JS API (window.Elf2WasmDocker & window.runDockerImage)", async () => {
    const browser = await launchCdpBrowser();
    try {
      await browser.navigate(`${localServer.url}/`);
      await browser.waitForSelector("#image-input", 15000);

      const apiShape = await browser.evaluate(
        `({
          hasDocker: Boolean(window.Elf2WasmDocker && typeof window.Elf2WasmDocker.create === "function"),
          hasRunHelper: typeof window.runDockerImage === "function",
        })`,
        { awaitPromise: false }
      );
      assert.equal(apiShape.hasDocker, true, "window.Elf2WasmDocker.create must be exposed");
      assert.equal(apiShape.hasRunHelper, true, "window.runDockerImage must be exposed");

      const ref = registry.imageRef("library/alpine", "latest");
      const res = await browser.evaluate(
        `window.runDockerImage(${JSON.stringify(ref)}, { cmd: ["/bin/sh", "-c", "echo API_RESULT_$((6*7))"], tty: false })`,
        { awaitPromise: true }
      );
      assert.ok(res && typeof res === "object", "runDockerImage must resolve to result object");
      assert.equal(res.exitCode, 0, `Expected exitCode 0, got ${JSON.stringify(res)}`);
      assertIncludes(stripAnsi(res.stdout), "API_RESULT_42");

      assert.deepEqual(browser.exceptions, [], `Uncaught exceptions: ${JSON.stringify(browser.exceptions)}`);
    } finally {
      await browser.close();
    }
  });

  suite.add("T4.3", "Arbitrary second Docker image (custom/app:v2) started from HTML UI", async () => {
    const browser = await launchCdpBrowser();
    try {
      await browser.navigate(`${localServer.url}/`);
      await browser.waitForSelector("#image-input", 15000);

      await browser.setInputValue("#image-input", registry.imageRef("custom/app", "v2"));
      await browser.click("#start-btn");

      await waitForShellReady(browser, COLD_BOOT_TIMEOUT_MS);

      await browser.typeIntoTerminal("cat /etc/second_image_id");
      await waitFor(
        async () => stripAnsi(await browser.getText("#terminal")).includes("SECOND_IMAGE_APP_V2"),
        { timeoutMs: CMD_TIMEOUT_MS, intervalMs: 250, label: "SECOND_IMAGE_APP_V2 output" }
      );

      await browser.typeIntoTerminal("pwd");
      await waitFor(
        async () => stripAnsi(await browser.getText("#terminal")).includes("/srv"),
        { timeoutMs: CMD_TIMEOUT_MS, intervalMs: 250, label: "WorkingDir /srv" }
      );

      await browser.click("#stop-btn");
      assert.deepEqual(browser.exceptions, [], `Uncaught exceptions: ${JSON.stringify(browser.exceptions)}`);
      assert.deepEqual(browser.consoleErrors, [], `Console errors: ${JSON.stringify(browser.consoleErrors)}`);
    } finally {
      await browser.close();
    }
  });

  suite.add("T4.4", "Strictly client-side execution & zero-CDN proof (Page + Worker CDP network audit)", async () => {
    const browser = await launchCdpBrowser();
    try {
      browser.clearLogs();
      registry.clearRequests();

      await browser.navigate(`${localServer.url}/`);
      await browser.waitForSelector("#image-input", 15000);

      await browser.setInputValue("#image-input", registry.imageRef("library/alpine", "latest"));
      await browser.click("#start-btn");
      await waitForShellReady(browser, COLD_BOOT_TIMEOUT_MS);

      await browser.typeIntoTerminal("echo $((7*8))");
      await waitFor(
        async () => stripAnsi(await browser.getText("#terminal")).includes("56"),
        { timeoutMs: CMD_TIMEOUT_MS, intervalMs: 250, label: "computed output 56" }
      );

      await browser.click("#stop-btn");

      const expectedOrigin = new URL(localServer.url).origin;
      const httpReqs = browser.networkRequests.filter((r) => /^https?:\/\//i.test(r.url));
      assert.ok(httpReqs.length > 0, "Expected recorded HTTP requests in CDP log");

      // 1. Zero external CDN origins
      const externalReqs = httpReqs.filter((r) => new URL(r.url).origin !== expectedOrigin);
      assert.deepEqual(
        externalReqs,
        [],
        `Expected zero external CDN requests, found: ${JSON.stringify(externalReqs)}`
      );

      // 2. Zero POST / compile / exec requests
      const postReqs = httpReqs.filter((r) => r.method.toUpperCase() === "POST");
      assert.deepEqual(postReqs, [], `Expected zero POST requests, found: ${JSON.stringify(postReqs)}`);

      const serverSideExecReqs = httpReqs.filter((r) => /\/(compile|exec)\b/i.test(new URL(r.url).pathname));
      assert.deepEqual(
        serverSideExecReqs,
        [],
        `Expected zero server-side compile/exec endpoints, found: ${JSON.stringify(serverSideExecReqs)}`
      );

      // 3. Required client-side WASM & raw OCI fetches observed across Page + Worker sessions
      const allUrls = browser.networkResponses.map((r) => r.url);
      assert.ok(
        allUrls.some((u) => u.includes("/wasm/elf2wasm_compiler_wasm.wasm")),
        `Expected /wasm/elf2wasm_compiler_wasm.wasm in CDP responses (got ${allUrls.length} responses)`
      );
      assert.ok(
        allUrls.some((u) => u.includes("/wasm/elf2wasm_runtime_wasm.wasm")),
        `Expected /wasm/elf2wasm_runtime_wasm.wasm in CDP responses`
      );
      assert.ok(
        allUrls.some((u) => /\/api\/v2\/.+\/manifests\//.test(u)),
        "Expected /api/v2/.../manifests/... in CDP responses"
      );
      assert.ok(
        allUrls.some((u) => /\/api\/v2\/.+\/blobs\/sha256:[0-9a-f]{64}/.test(u)),
        "Expected /api/v2/.../blobs/sha256:... in CDP responses"
      );

      // 4. Verify compiler/runtime WASM served with 200 OK
      for (const wasmName of ["elf2wasm_compiler_wasm.wasm", "elf2wasm_runtime_wasm.wasm"]) {
        const wasmResp = browser.networkResponses.find((r) => r.url.includes(`/wasm/${wasmName}`));
        assert.ok(wasmResp && wasmResp.status === 200, `${wasmName} must be fetched with 200 OK`);
      }

      // 5. Cross-check mock registry auth stripping
      assert.equal(registry.leakedAuthCount(), 0, "Zero leaked Authorization headers on cross-origin blob redirect");
    } finally {
      await browser.close();
    }
  });

  suite.add("T4.5", "Live Docker Hub alpine:latest pull & interactive shell on hardened server", async () => {
    if (skipLive) {
      skip("skipped via --skip-live");
    }

    let hardenedServer = null;
    let browser = null;
    try {
      hardenedServer = await startServer({ allowLocalRegistries: false });
      browser = await launchCdpBrowser();
      await browser.navigate(`${hardenedServer.url}/`);
      await browser.waitForSelector("#image-input", 15000);

      // Leave #image-input untouched at its default "alpine:latest"
      const defaultVal = await browser.evaluate(
        'document.querySelector("#image-input").value',
        { awaitPromise: false }
      );
      assert.equal(defaultVal, "alpine:latest", "#image-input must default to alpine:latest");

      await browser.click("#start-btn");
      await waitForShellReady(browser, 120000);

      await browser.typeIntoTerminal("cat /etc/alpine-release");
      await waitFor(
        async () => /\b\d+\.\d+(?:\.\d+)?\b/.test(stripAnsi(await browser.getText("#terminal"))),
        { timeoutMs: CMD_TIMEOUT_MS, intervalMs: 250, label: "real Alpine version in /etc/alpine-release" }
      );

      await browser.typeIntoTerminal("echo $((100 + 23))");
      await waitFor(
        async () => stripAnsi(await browser.getText("#terminal")).includes("123"),
        { timeoutMs: CMD_TIMEOUT_MS, intervalMs: 250, label: "computed output 123" }
      );

      const finalTerm = stripAnsi(await browser.getText("#terminal"));
      assertMatch(finalTerm, /\b\d+\.\d+/);
      assertIncludes(finalTerm, "123");

      await browser.click("#stop-btn");
      assert.deepEqual(browser.exceptions, [], `Uncaught exceptions: ${JSON.stringify(browser.exceptions)}`);
    } finally {
      if (browser) await browser.close();
      if (hardenedServer) await hardenedServer.close();
    }
  });

    return await suite.run(opts);
  } finally {
    if (localServer) await localServer.close();
    if (registry) await registry.close();
  }
}
