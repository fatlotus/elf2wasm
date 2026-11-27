// Tier 4: Full Headless Google Chrome Browser Scenarios (Opaque-Box E2E)
// Drives real /usr/bin/google-chrome over CDP against server/server.mjs.

import crypto from "node:crypto";
import {
  assert,
  assertIncludes,
  assertNotIncludes,
  assertMatch,
  stripAnsi,
  sleep,
  skip,
  waitFor,
  waitWithTimeout,
  Suite,
} from "./helpers/test_runner.mjs";
import { startMockOciRegistry } from "./helpers/mock_oci_registry.mjs";
import { startMockGitServer } from "./helpers/mock_git_server.mjs";
import { startServer } from "./helpers/server_harness.mjs";
import { launchCdpBrowser } from "./helpers/cdp_browser.mjs";

const COLD_BOOT_TIMEOUT_MS = 90000;
const PYTHON_COLD_BOOT_TIMEOUT_MS = 120000;
const NODE_COLD_BOOT_TIMEOUT_MS = 180000;
const CMD_TIMEOUT_MS = 25000;
const PROJECT_PRESET_RUN_TIMEOUT_MS = 240000;

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

/**
 * Poll #status-text and #status-pill[data-state] until container exits ("Exited (code N)").
 * Checks for "Exited (code N)" before failing fast on "Error: ..." so non-zero guest exits
 * return cleanly with full terminal diagnostics.
 */
async function waitForContainerExit(browser, timeoutMs = COLD_BOOT_TIMEOUT_MS, label = "container exit") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await browser.evaluate(
      `(() => ({
        state: document.querySelector("#status-pill")?.dataset?.state || "",
        statusText: (document.querySelector("#status-text")?.textContent || "").trim(),
      }))()`,
      { awaitPromise: false }
    );
    const exitMatch = info.statusText.match(/^Exited \(code (\d+)\)/i);
    if (exitMatch) {
      const term = stripAnsi(await browser.getText("#terminal"));
      return {
        exitCode: Number(exitMatch[1]),
        statusText: info.statusText,
        state: info.state,
        term,
      };
    }
    if (info.state === "error") {
      const termTail = stripAnsi(await browser.getText("#terminal")).slice(-800);
      throw new Error(
        `Container entered error state while waiting for ${label}.\n` +
        `#status-text: ${JSON.stringify(info.statusText)}\n` +
        `#terminal tail:\n${termTail}`
      );
    }
    await sleep(250);
  }
  const finalStatus = await browser.getText("#status-text");
  const finalState = await browser.evaluate(
    'document.querySelector("#status-pill")?.dataset?.state || ""',
    { awaitPromise: false }
  );
  const finalTerm = stripAnsi(await browser.getText("#terminal"));
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${label}.\n` +
    `#status-text: ${JSON.stringify(finalStatus)} (state=${JSON.stringify(finalState)})\n` +
    `#terminal tail:\n${finalTerm.slice(-800)}`
  );
}

export async function runTier4(opts = {}) {
  const skipLive = Boolean(opts.skipLive);

  let registry = null;
  let gitServer = null;
  let localServer = null;

  try {
    registry = await startMockOciRegistry({ requireAuth: true, redirectBlobs: true });
    gitServer = await startMockGitServer({ redirectArchives: true });
    localServer = await startServer({ allowLocalRegistries: true });

    gitServer.addRepo("acme/shell-proj", {
      main: [
        { path: "shell-proj-main/", type: "dir", mode: 0o755 },
        { path: "shell-proj-main/version.txt", type: "file", content: "branch-main-v2\n" },
        { path: "shell-proj-main/bin/", type: "dir", mode: 0o755 },
        {
          path: "shell-proj-main/bin/check.sh",
          type: "file",
          mode: 0o755,
          content: '#!/bin/sh\necho "PWD=$PWD"\necho "SHELL_TEST_PASS:main:$((20+22))"\ncat version.txt\n',
        },
      ],
    });

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

  // -------------------------------------------------------------------------
  // Git Repo Overlay & Project Test Presets Browser Scenarios (F25-F31, §7-§10)
  // -------------------------------------------------------------------------

  suite.add("T4.10", "Web UI Git Repo Overlay workflow (#repo-input/#repo-ref-input/#repo-mount-input), #terminal-title & client-side CDP audit (offline)", async () => {
    const browser = await launchCdpBrowser();
    try {
      browser.clearLogs();
      await browser.navigate(`${localServer.url}/`);
      await browser.waitForSelector("#image-input", 15000);
      await browser.waitForSelector("#repo-input", 15000);
      await browser.waitForSelector("#repo-ref-input", 15000);
      await browser.waitForSelector("#repo-mount-input", 15000);
      await browser.waitForSelector("#cmd-input", 15000);
      await browser.waitForSelector("#start-btn", 15000);
      await browser.waitForSelector("#terminal", 15000);
      await browser.waitForSelector("#terminal-title", 15000);

      assert.equal(await browser.getInputValue("#repo-mount-input"), "/workspace");

      await browser.setInputValue("#image-input", registry.imageRef("library/alpine", "latest"));
      await browser.setInputValue("#repo-input", gitServer.repoUrl("acme/shell-proj"));
      await browser.setInputValue("#repo-ref-input", "main");
      await browser.setInputValue("#repo-mount-input", "/opt/demo-repo");
      await browser.setInputValue("#cmd-input", "/bin/sh -c 'pwd && ./bin/check.sh && ls -1'");

      await browser.click("#start-btn");
      const exitRes = await waitForContainerExit(browser, COLD_BOOT_TIMEOUT_MS, "T4.10 git overlay");
      assert.equal(
        exitRes.exitCode,
        0,
        `T4.10 expected exit code 0, got ${exitRes.exitCode} (#status-text=${exitRes.statusText})\n${exitRes.term.slice(-800)}`
      );

      const title = await browser.getText("#terminal-title");
      assertIncludes(title, "shell-proj", `#terminal-title must reflect repo name (got ${JSON.stringify(title)})`);
      assertIncludes(title, "main", `#terminal-title must reflect ref (got ${JSON.stringify(title)})`);

      assertIncludes(exitRes.term, "/opt/demo-repo");
      assertIncludes(exitRes.term, "SHELL_TEST_PASS:main:42");
      assertIncludes(exitRes.term, "version.txt");

      // CDP Network Audit (Page + Dedicated Worker)
      const localOrigin = new URL(localServer.url).origin;
      for (const req of browser.networkRequests) {
        if (req.url.startsWith("http://") || req.url.startsWith("https://")) {
          assert.equal(new URL(req.url).origin, localOrigin, `Unexpected external request: ${req.url}`);
          assert.notEqual(req.method, "POST", `Unexpected POST request: ${req.url}`);
          const pathname = new URL(req.url).pathname;
          assertNotIncludes(pathname, "/compile", `Server must not expose /compile: ${req.url}`);
          assertNotIncludes(pathname, "/exec", `Server must not expose /exec: ${req.url}`);
        }
      }

      const sawGitArchive = browser.networkResponses.some(
        (r) => r.url.includes("/api/git/archive") && r.url.includes("ref=main") && r.status === 200
      );
      assert.ok(sawGitArchive, "Expected /api/git/archive 200 response with ref=main in CDP networkResponses");

      const sawCompilerWasm = browser.networkResponses.some(
        (r) => r.url.includes("/wasm/elf2wasm_compiler_wasm.wasm") && r.status === 200
      );
      const sawRuntimeWasm = browser.networkResponses.some(
        (r) => r.url.includes("/wasm/elf2wasm_runtime_wasm.wasm") && r.status === 200
      );
      assert.ok(sawCompilerWasm, "Expected elf2wasm_compiler_wasm.wasm 200");
      assert.ok(sawRuntimeWasm, "Expected elf2wasm_runtime_wasm.wasm 200");

      assert.deepEqual(browser.exceptions, [], `Uncaught exceptions: ${JSON.stringify(browser.exceptions)}`);
      assert.deepEqual(browser.consoleErrors, [], `Console errors: ${JSON.stringify(browser.consoleErrors)}`);
    } finally {
      await browser.close();
    }
  });

  suite.add("T4.11", "Web UI Project Test Presets (.project-presets-row) & backward-compatible Image Presets (.presets-row) DOM contract (offline)", async () => {
    const browser = await launchCdpBrowser();
    try {
      browser.clearLogs();
      await browser.navigate(`${localServer.url}/`);
      await browser.waitForSelector(".presets-row", 15000);
      await browser.waitForSelector(".project-presets-row", 15000);
      await browser.waitForSelector("#image-input", 15000);
      await browser.waitForSelector("#repo-input", 15000);
      await browser.waitForSelector("#repo-ref-input", 15000);
      await browser.waitForSelector("#repo-mount-input", 15000);
      await browser.waitForSelector("#cmd-input", 15000);
      await browser.waitForSelector("#cwd-input", 15000);
      await browser.waitForSelector("#env-input", 15000);

      // 1. All 5 backward-compatible image presets preserved
      const imageChips = await browser.getPresetChips();
      const imageNames = imageChips.map((c) => c.image);
      for (const expectedImg of [
        "alpine:latest",
        "busybox:latest",
        "debian:bookworm-slim",
        "python:3.12-slim",
        "node:22-slim",
      ]) {
        assert.ok(imageNames.includes(expectedImg), `Missing preserved image preset ${expectedImg}`);
      }

      // 2. 4 Project Test Presets covering Python, JavaScript, Rust, and Go
      const projectChips = await browser.getProjectPresetChips();
      assert.equal(projectChips.length, 4, `Expected 4 project preset chips, got ${JSON.stringify(projectChips)}`);

      const ecosystemDescriptions = [];
      for (const chip of projectChips) {
        const populated = await browser.clickProjectPresetChip(chip.preset);
        assert.ok(populated.image.trim().length > 0, `Preset ${chip.preset}: image must be non-empty`);
        assert.ok(populated.repo.trim().length > 0, `Preset ${chip.preset}: repo must be non-empty`);
        if (chip.preset !== "go-raft-nodice") {
          assert.ok(populated.ref.trim().length > 0, `Preset ${chip.preset}: ref must be non-empty`);
        }
        assert.ok(
          populated.mountPath.startsWith("/"),
          `Preset ${chip.preset}: mountPath must start with "/" (got ${JSON.stringify(populated.mountPath)})`
        );
        assert.ok(populated.cmd.trim().length > 0, `Preset ${chip.preset}: cmd must be non-empty`);
        ecosystemDescriptions.push(
          `${chip.preset} ${chip.language} ${chip.text} ${populated.image} ${populated.cmd}`
        );
      }

      assert.ok(ecosystemDescriptions.some((d) => /python/i.test(d)), "Expected Python project preset");
      assert.ok(ecosystemDescriptions.some((d) => /javascript|node|\bjs\b/i.test(d)), "Expected JavaScript project preset");
      assert.ok(ecosystemDescriptions.some((d) => /\bgo\b|golang|raft/i.test(d)), "Expected Go project preset");

      // 3. Dirty fields and click plain alpine:latest .preset-chip -> Contract §10 full reset
      await browser.setInputValue("#cwd-input", "/dirty/cwd");
      await browser.setInputValue("#env-input", "DIRTY=1");
      await browser.setInputValue("#repo-mount-input", "/custom-mount");

      await browser.clickPresetChip("alpine:latest");
      assert.equal(await browser.getInputValue("#image-input"), "alpine:latest");
      assert.equal(await browser.getInputValue("#repo-input"), "");
      assert.equal(await browser.getInputValue("#repo-ref-input"), "");
      assert.equal(await browser.getInputValue("#cmd-input"), "");
      assert.equal(await browser.getInputValue("#cwd-input"), "");
      assert.equal(await browser.getInputValue("#env-input"), "");
      assert.equal(await browser.getInputValue("#repo-mount-input"), "/workspace");
      const activeId = await browser.evaluate("document.activeElement?.id || ''", { awaitPromise: false });
      assert.equal(activeId, "image-input", "Plain .preset-chip click must focus #image-input");

      assert.deepEqual(browser.exceptions, [], `Uncaught exceptions: ${JSON.stringify(browser.exceptions)}`);
      assert.deepEqual(browser.consoleErrors, [], `Console errors: ${JSON.stringify(browser.consoleErrors)}`);
    } finally {
      await browser.close();
    }
  });

  suite.add("T4.12", "Live GitHub repo snapshot streamed through hardened /api/git/archive & overlaid on live alpine:latest", async () => {
    if (skipLive) {
      skip("skipped via --skip-live");
    }

    const LIVE_REPO = "octocat/Hello-World";
    const LIVE_SHA = "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d";

    const hardenedServer = await startServer({ allowLocalRegistries: false });
    let browser = null;
    try {
      // Part A: Direct HTTP contract verification against real GitHub
      const qs = new URLSearchParams({ repo: LIVE_REPO, ref: LIVE_SHA });
      const resp = await fetch(`${hardenedServer.url}/api/git/archive?${qs.toString()}`);
      assert.equal(resp.status, 200, `Live GitHub archive returned ${resp.status}`);
      assertIncludes(resp.headers.get("content-type") || "", "gzip");
      assert.equal(resp.headers.get("x-git-archive-format"), "tar.gz");
      assert.equal(resp.headers.get("x-git-strip-components"), "1");
      assertIncludes((resp.headers.get("cache-control") || "").toLowerCase(), "immutable");
      assert.equal(resp.headers.get("cross-origin-opener-policy"), "same-origin");
      assert.equal(resp.headers.get("cross-origin-embedder-policy"), "require-corp");
      assert.equal(resp.headers.get("x-content-type-options"), "nosniff");
      const bytes = new Uint8Array(await resp.arrayBuffer());
      assert.equal(bytes[0], 0x1f, "Live GitHub archive gzip magic byte 0");
      assert.equal(bytes[1], 0x8b, "Live GitHub archive gzip magic byte 1");

      // SSRF guard on hardened server
      const ssrfResp = await fetch(
        `${hardenedServer.url}/api/git/archive?repo=${encodeURIComponent("http://127.0.0.1:9999/a/b")}&ref=main`
      );
      assert.equal(ssrfResp.status, 403, `Hardened server must block loopback git repo with 403, got ${ssrfResp.status}`);

      // Part B: Browser SDK overlay on live alpine:latest
      browser = await launchCdpBrowser();
      await browser.navigate(`${hardenedServer.url}/`);
      await browser.waitForSelector("#image-input", 15000);

      const sdkRes = await waitWithTimeout(
        browser.evaluate(
          `window.runDockerImage("alpine:latest", {
            gitRepo: { repo: ${JSON.stringify(LIVE_REPO)}, ref: ${JSON.stringify(LIVE_SHA)} },
            cmd: ["/bin/sh", "-c", "pwd && cat README"],
            tty: false
          })`,
          { awaitPromise: true }
        ),
        120000,
        "T4.12 live window.runDockerImage with GitHub overlay"
      );
      assert.equal(sdkRes.exitCode, 0, `Live overlay exited with ${sdkRes.exitCode}, stderr: ${sdkRes.stderr}`);
      const out = stripAnsi(sdkRes.stdout);
      assertIncludes(out, "/workspace");
      assertIncludes(out, "Hello World!");
      assert.deepEqual(browser.exceptions, [], `Uncaught exceptions: ${JSON.stringify(browser.exceptions)}`);
    } finally {
      if (browser) await browser.close();
      if (hardenedServer) await hardenedServer.close();
    }
  });

  suite.add("T4.13", "Live execution of all 4 dynamically discovered .project-preset-chip Project Test Presets (Python, JavaScript, Rust, Go) on hardened server", async () => {
    if (skipLive) {
      skip("skipped via --skip-live");
    }

    const hardenedServer = await startServer({ allowLocalRegistries: false });
    try {
      const hardenedOrigin = new URL(hardenedServer.url).origin;

      // Discovery Phase: inspect the 4 .project-preset-chip buttons dynamically from the DOM
      let presets = [];
      const discoveryBrowser = await launchCdpBrowser();
      try {
        await discoveryBrowser.navigate(`${hardenedServer.url}/`);
        await discoveryBrowser.waitForSelector(".project-presets-row", 15000);
        presets = await discoveryBrowser.getProjectPresetChips();
      } finally {
        await discoveryBrowser.close();
      }

      assert.equal(
        presets.length,
        4,
        `Expected 4 dynamically discovered .project-preset-chip buttons, got ${JSON.stringify(presets)}`
      );

      // Sequential Isolated Execution Phase: fresh browser per preset so WASM heaps never coexist
      for (const preset of presets) {
        const browser = await launchCdpBrowser();
        try {
          browser.clearLogs();
          await browser.navigate(`${hardenedServer.url}/`);
          await browser.waitForSelector(".project-presets-row", 15000);

          const fields = await browser.clickProjectPresetChip(preset.preset);
          assert.ok(fields.image.trim().length > 0, `Live preset ${preset.preset}: empty #image-input`);
          assert.ok(fields.repo.trim().length > 0, `Live preset ${preset.preset}: empty #repo-input`);
          if (preset.preset !== "go-raft-nodice") {
            assert.ok(fields.ref.trim().length > 0, `Live preset ${preset.preset}: empty #repo-ref-input`);
          }
          assert.ok(fields.mountPath.startsWith("/"), `Live preset ${preset.preset}: invalid #repo-mount-input`);
          assert.ok(fields.cmd.trim().length > 0, `Live preset ${preset.preset}: empty #cmd-input`);

          await browser.click("#start-btn");
          const exitRes = await waitForContainerExit(
            browser,
            PROJECT_PRESET_RUN_TIMEOUT_MS,
            `Live preset ${preset.preset}`
          );
          assert.equal(
            exitRes.exitCode,
            0,
            `Live preset ${preset.preset} (${fields.repo}@${fields.ref || "HEAD"}) exited with code ${exitRes.exitCode} (#status-text=${exitRes.statusText})\n${exitRes.term.slice(-800)}`
          );
          assert.ok(
            exitRes.term.trim().length > 0,
            `Live preset ${preset.preset} produced empty terminal output`
          );

          const title = await browser.getText("#terminal-title");
          const repoBasename = fields.repo.replace(/\.git$/, "").split("/").filter(Boolean).pop() || fields.repo;
          assertIncludes(
            title.toLowerCase(),
            repoBasename.toLowerCase(),
            `Live preset ${preset.preset}: #terminal-title (${JSON.stringify(title)}) should reflect repo ${repoBasename}`
          );

          // CDP Network Proof: same-origin only, zero POST, observed /api/v2/ and /api/git/archive 200
          for (const req of browser.networkRequests) {
            if (req.url.startsWith("http://") || req.url.startsWith("https://")) {
              assert.equal(new URL(req.url).origin, hardenedOrigin, `Live preset ${preset.preset}: unexpected external origin ${req.url}`);
              assert.notEqual(req.method, "POST", `Live preset ${preset.preset}: unexpected POST ${req.url}`);
            }
          }
          assert.ok(
            browser.networkResponses.some((r) => r.url.includes("/api/v2/") && r.status === 200),
            `Live preset ${preset.preset}: expected /api/v2/ 200 response`
          );
          assert.ok(
            browser.networkResponses.some((r) => r.url.includes("/api/git/archive") && r.status === 200),
            `Live preset ${preset.preset}: expected /api/git/archive 200 response`
          );

          assert.deepEqual(browser.exceptions, [], `Live preset ${preset.preset} exceptions: ${JSON.stringify(browser.exceptions)}`);
          assert.deepEqual(browser.consoleErrors, [], `Live preset ${preset.preset} consoleErrors: ${JSON.stringify(browser.consoleErrors)}`);
        } finally {
          await browser.close();
        }
      }
    } finally {
      await hardenedServer.close();
    }
  });

    return await suite.run(opts);
  } finally {
    if (localServer) await localServer.close();
    if (gitServer) await gitServer.close();
    if (registry) await registry.close();
  }
}
