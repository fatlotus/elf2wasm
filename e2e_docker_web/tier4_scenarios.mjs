// Tier 4: Full Headless Google Chrome Browser Scenarios (Opaque-Box E2E)
// Drives real /usr/bin/google-chrome over CDP against server/server.mjs.

import crypto from "node:crypto";
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
const PYTHON_COLD_BOOT_TIMEOUT_MS = 120000;
const NODE_COLD_BOOT_TIMEOUT_MS = 180000;
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

/**
 * Poll #progress-bar[data-stage] and #status-pill[data-state] until container reaches "run"/"running".
 * Fails fast if #status-pill[data-state="error"].
 */
async function waitForRunStage(browser, timeoutMs = PYTHON_COLD_BOOT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await browser.evaluate(
      `(() => ({
        stage: document.querySelector("#progress-bar")?.dataset?.stage || "",
        state: document.querySelector("#status-pill")?.dataset?.state || "",
        statusText: document.querySelector("#status-text")?.textContent || "",
      }))()`,
      { awaitPromise: false }
    );
    if (info.state === "error") {
      const termTail = stripAnsi(await browser.getText("#terminal")).slice(-600);
      throw new Error(
        `Container boot entered error state while waiting for run stage.\n` +
        `#status-text: ${JSON.stringify(info.statusText)}\n` +
        `#terminal tail:\n${termTail}`
      );
    }
    if (info.stage === "run" || info.state === "running") {
      return Date.now();
    }
    await sleep(100);
  }
  const finalStatus = await browser.getText("#status-text");
  const finalTerm = stripAnsi(await browser.getText("#terminal"));
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for container run stage.\n` +
    `#status-text: ${JSON.stringify(finalStatus)}\n` +
    `#terminal tail:\n${finalTerm.slice(-600)}`
  );
}

/**
 * Poll #terminal until `promptRegex` matches, failing fast on #status-pill[data-state="error"].
 */
async function waitForReplPrompt(browser, promptRegex, timeoutMs, label = "REPL prompt") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await browser.evaluate(
      'document.querySelector("#status-pill")?.dataset?.state || ""',
      { awaitPromise: false }
    );
    const term = stripAnsi(await browser.getText("#terminal"));
    if (promptRegex.test(term)) {
      return { term, promptTimeMs: Date.now() };
    }
    if (state === "error") {
      const statusText = await browser.getText("#status-text");
      throw new Error(
        `Container entered error state while waiting for ${label}.\n` +
        `#status-text: ${JSON.stringify(statusText)}\n` +
        `#terminal tail:\n${term.slice(-600)}`
      );
    }
    await sleep(150);
  }
  const finalStatus = await browser.getText("#status-text");
  const finalTerm = stripAnsi(await browser.getText("#terminal"));
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${label}.\n` +
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

  suite.add("T4.6", "python:3.12-slim preset chip, <15s REPL startup latency, canonical echo & data-processing workload in Chrome", async () => {
    const pyRef = registry.ensureBuiltinFixture("python");
    const expectedSha12 = crypto.createHash("sha256").update("elf2wasm").digest("hex").slice(0, 12);
    const browser = await launchCdpBrowser();
    try {
      await browser.navigate(`${localServer.url}/`);
      await browser.waitForSelector(".presets-row", 15000);
      await browser.waitForSelector("#image-input", 15000);
      await browser.waitForSelector("#start-btn", 15000);
      await browser.waitForSelector("#terminal", 15000);

      const defaultImage = await browser.evaluate('document.querySelector("#image-input").value', { awaitPromise: false });
      assert.equal(defaultImage, "alpine:latest", "#image-input must default to alpine:latest");

      // Click python:3.12-slim preset chip and verify focus + value
      const chipVal = await browser.clickPresetChip("python:3.12-slim");
      assert.equal(chipVal, "python:3.12-slim", "Clicking python:3.12-slim preset chip must populate #image-input");
      const activeId = await browser.evaluate("document.activeElement?.id || ''", { awaitPromise: false });
      assert.equal(activeId, "image-input", "Clicking preset chip must focus #image-input");

      // Point at local mock registry for deterministic offline pull; keep #cmd-input empty for default python3 REPL
      await browser.setInputValue("#image-input", pyRef);
      await browser.click("#start-btn");

      const tRunStart = await waitForRunStage(browser, PYTHON_COLD_BOOT_TIMEOUT_MS);
      const { term: promptTerm, promptTimeMs } = await waitForReplPrompt(
        browser,
        />>>\s*$/,
        15000,
        "Python >>> prompt"
      );
      const replLatencyMs = promptTimeMs - tRunStart;
      assert.ok(
        replLatencyMs < 15000,
        `Post-compile Python REPL startup latency must be < 15000ms (took ${replLatencyMs}ms)`
      );
      assertMatch(promptTerm, /Python 3\.12/, "Python REPL banner must report Python 3.12");

      // Interactive math + json + visible canonical TTY echo (F17 + F20)
      await browser.typeIntoTerminal("import math, json");
      await browser.waitForTerminalText("import math, json", {
        timeoutMs: CMD_TIMEOUT_MS,
        intervalMs: 150,
        label: "canonical TTY echo of import math, json",
      });

      await browser.typeIntoTerminal('print(json.dumps({"fact": math.factorial(10), "sum": 20 + 22}))');
      const { text: mathTerm } = await browser.waitForTerminalText(
        (t) => t.includes("3628800") && /"sum":\s*42/.test(t),
        { timeoutMs: CMD_TIMEOUT_MS, intervalMs: 150, label: "Python factorial(10)=3628800 and sum=42" }
      );
      assertIncludes(mathTerm, "math.factorial(10)", "Canonical TTY echo must display typed Python expression");

      // Realistic Python data-processing workload (json / csv / hashlib / zlib)
      await browser.typeIntoTerminal("import csv, io, hashlib, zlib");
      await browser.typeIntoTerminal('rows = list(csv.DictReader(io.StringIO("k,v\\na,10\\nb,25\\nc,7\\n")))');
      await browser.typeIntoTerminal('total = sum(int(r["v"]) for r in rows); blob = zlib.compress(json.dumps(rows).encode())');
      await browser.typeIntoTerminal('print("PY_WORK", total, len(zlib.decompress(blob)), hashlib.sha256(b"elf2wasm").hexdigest()[:12])');

      await browser.waitForTerminalText(
        (t) => t.includes("PY_WORK 42 ") && t.includes(expectedSha12),
        { timeoutMs: CMD_TIMEOUT_MS, intervalMs: 150, label: `PY_WORK 42 and SHA ${expectedSha12}` }
      );

      await browser.click("#stop-btn");
      await sleep(300);
      assert.deepEqual(browser.exceptions, [], `Uncaught exceptions: ${JSON.stringify(browser.exceptions)}`);
      assert.deepEqual(browser.consoleErrors, [], `Console errors: ${JSON.stringify(browser.consoleErrors)}`);
    } finally {
      await browser.close();
    }
  });

  suite.add("T4.7", "node:22-slim preset chip, interactive > REPL & realistic workload (JSON/crypto/fs/Buffer) in Chrome", async () => {
    const nodeRef = registry.ensureBuiltinFixture("node");
    const expectedPayload = JSON.stringify({ items: [10, 20, 12] });
    const expectedSha12 = crypto.createHash("sha256").update(expectedPayload).digest("hex").slice(0, 12);
    const browser = await launchCdpBrowser();
    try {
      await browser.navigate(`${localServer.url}/`);
      await browser.waitForSelector(".presets-row", 15000);
      await browser.waitForSelector("#image-input", 15000);
      await browser.waitForSelector("#start-btn", 15000);
      await browser.waitForSelector("#terminal", 15000);

      // Click node:22-slim preset chip and verify focus + value
      const chipVal = await browser.clickPresetChip("node:22-slim");
      assert.equal(chipVal, "node:22-slim", "Clicking node:22-slim preset chip must populate #image-input");
      const activeId = await browser.evaluate("document.activeElement?.id || ''", { awaitPromise: false });
      assert.equal(activeId, "image-input", "Clicking preset chip must focus #image-input");

      // Point at local mock registry; leave #cmd-input empty for default Node REPL + F21 --jitless env injection
      await browser.setInputValue("#image-input", nodeRef);
      await browser.click("#start-btn");

      await waitForRunStage(browser, NODE_COLD_BOOT_TIMEOUT_MS);
      const { term: promptTerm } = await waitForReplPrompt(
        browser,
        /(?:^|\n)>\s*$/,
        30000,
        "Node > prompt"
      );
      assertMatch(promptTerm, /Welcome to Node\.js v22\./, "Node REPL banner must report Node.js v22");

      // Interactive Node.js evaluation (computed output avoids TTY echo false positive)
      await browser.typeIntoTerminal("JSON.stringify({ v: process.versions.node.split('.')[0], ans: 20 + 22 })");
      await browser.waitForTerminalText('{"v":"22","ans":42}', {
        timeoutMs: CMD_TIMEOUT_MS,
        intervalMs: 150,
        label: 'Node REPL JSON.stringify {"v":"22","ans":42}',
      });

      // Realistic Node.js data-processing workload (JSON / crypto / fs / Buffer)
      await browser.typeIntoTerminal("const fs = require('fs'), crypto = require('crypto');");
      await browser.typeIntoTerminal("const buf = Buffer.from(JSON.stringify({ items: [10, 20, 12] })); fs.writeFileSync('/tmp/n.json', buf);");
      await browser.typeIntoTerminal("const d = JSON.parse(fs.readFileSync('/tmp/n.json', 'utf8')); console.log('NODE_WORK', d.items.reduce((a,b)=>a+b,0), crypto.createHash('sha256').update(buf).digest('hex').slice(0,12));");

      await browser.waitForTerminalText(
        (t) => t.includes("NODE_WORK 42 ") && t.includes(expectedSha12),
        { timeoutMs: CMD_TIMEOUT_MS, intervalMs: 150, label: `NODE_WORK 42 and SHA ${expectedSha12}` }
      );

      await browser.click("#stop-btn");
      await sleep(300);
      assert.deepEqual(browser.exceptions, [], `Uncaught exceptions: ${JSON.stringify(browser.exceptions)}`);
      assert.deepEqual(browser.consoleErrors, [], `Console errors: ${JSON.stringify(browser.consoleErrors)}`);
    } finally {
      await browser.close();
    }
  });

  suite.add("T4.8", "Web UI preset switching (alpine:latest -> python:3.12-slim -> node:22-slim) in one Chrome tab", async () => {
    const alpineRef = registry.imageRef("library/alpine", "latest");
    const pyRef = registry.ensureBuiltinFixture("python");
    const nodeRef = registry.ensureBuiltinFixture("node");

    const browser = await launchCdpBrowser();
    try {
      await browser.navigate(`${localServer.url}/`);
      await browser.waitForSelector(".presets-row", 15000);
      await browser.waitForSelector("#image-input", 15000);

      // Verify chip clicking sequence updates #image-input cleanly
      assert.equal(await browser.clickPresetChip("python:3.12-slim"), "python:3.12-slim");
      assert.equal(await browser.clickPresetChip("node:22-slim"), "node:22-slim");
      assert.equal(await browser.clickPresetChip("alpine:latest"), "alpine:latest");

      // 1. Boot alpine:latest
      await browser.setInputValue("#image-input", alpineRef);
      await browser.click("#start-btn");
      await waitForShellReady(browser, COLD_BOOT_TIMEOUT_MS);
      await browser.typeIntoTerminal("echo $((10+5))");
      await browser.waitForTerminalText("15", { timeoutMs: CMD_TIMEOUT_MS, intervalMs: 150, label: "Alpine 10+5=15" });
      await browser.click("#stop-btn");
      await sleep(300);

      // 2. Switch to python:3.12-slim
      assert.equal(await browser.clickPresetChip("python:3.12-slim"), "python:3.12-slim");
      await browser.click("#clear-btn");
      await browser.setInputValue("#image-input", pyRef);
      await browser.click("#start-btn");
      await waitForRunStage(browser, PYTHON_COLD_BOOT_TIMEOUT_MS);
      await waitForReplPrompt(browser, />>>\s*$/, 15000, "T4.8 Python >>> prompt");
      await browser.typeIntoTerminal("7 * 6");
      await browser.waitForTerminalText(/(?:^|\n)42(?:\n|$)/, {
        timeoutMs: CMD_TIMEOUT_MS,
        intervalMs: 150,
        label: "T4.8 Python 7*6=42",
      });
      await browser.click("#stop-btn");
      await sleep(300);

      // 3. Switch to node:22-slim
      assert.equal(await browser.clickPresetChip("node:22-slim"), "node:22-slim");
      await browser.click("#clear-btn");
      await browser.setInputValue("#image-input", nodeRef);
      await browser.click("#start-btn");
      await waitForRunStage(browser, NODE_COLD_BOOT_TIMEOUT_MS);
      await waitForReplPrompt(browser, /(?:^|\n)>\s*$/, 30000, "T4.8 Node > prompt");
      await browser.typeIntoTerminal("8 * 9");
      await browser.waitForTerminalText(/(?:^|\n)72(?:\n|$)/, {
        timeoutMs: CMD_TIMEOUT_MS,
        intervalMs: 150,
        label: "T4.8 Node 8*9=72",
      });
      await browser.click("#stop-btn");
      await sleep(300);

      assert.deepEqual(browser.exceptions, [], `Uncaught exceptions: ${JSON.stringify(browser.exceptions)}`);
      assert.deepEqual(browser.consoleErrors, [], `Console errors: ${JSON.stringify(browser.consoleErrors)}`);
    } finally {
      await browser.close();
    }
  });

  suite.add("T4.9", "Live Docker Hub python:3.12-slim preset chip click & REPL boot on hardened server", async () => {
    if (skipLive) {
      skip("skipped via --skip-live");
    }

    let hardenedServer = null;
    let browser = null;
    try {
      hardenedServer = await startServer({ allowLocalRegistries: false });
      browser = await launchCdpBrowser();
      await browser.navigate(`${hardenedServer.url}/`);
      await browser.waitForSelector(".presets-row", 15000);
      await browser.waitForSelector("#image-input", 15000);

      // Click python:3.12-slim preset chip and leave #image-input untouched at "python:3.12-slim"
      const chipVal = await browser.clickPresetChip("python:3.12-slim");
      assert.equal(chipVal, "python:3.12-slim", "#image-input must be python:3.12-slim after clicking preset chip");

      await browser.click("#start-btn");
      const tRunStart = await waitForRunStage(browser, 180000);
      const { promptTimeMs } = await waitForReplPrompt(browser, />>>\s*$/, 15000, "Live Python >>> prompt");
      const replLatencyMs = promptTimeMs - tRunStart;
      assert.ok(replLatencyMs < 15000, `Live Python REPL startup latency must be < 15000ms (took ${replLatencyMs}ms)`);

      await browser.typeIntoTerminal('import math; print("LIVE_PY", math.factorial(6))');
      await browser.waitForTerminalText("LIVE_PY 720", {
        timeoutMs: CMD_TIMEOUT_MS,
        intervalMs: 150,
        label: "LIVE_PY 720",
      });

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
