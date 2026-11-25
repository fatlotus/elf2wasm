import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { createServer } from "../server/server.mjs";
import { launchCdpBrowser } from "./helpers/cdp_browser.mjs";
import { startMockOciRegistry } from "./helpers/mock_oci_registry.mjs";

async function readDomState(browser) {
  return browser.evaluate(
    `(() => ({
      search: window.location.search,
      pathname: window.location.pathname,
      hash: window.location.hash,
      historyLength: window.history.length,
      image: document.getElementById("image-input")?.value ?? "",
      build: document.getElementById("build-cmd-input")?.value ?? "",
      cmd: document.getElementById("cmd-input")?.value ?? "",
      repo: document.getElementById("repo-input")?.value ?? "",
      ref: document.getElementById("repo-ref-input")?.value ?? "",
      mount: document.getElementById("repo-mount-input")?.value ?? "",
      cwd: document.getElementById("cwd-input")?.value ?? "",
      env: document.getElementById("env-input")?.value ?? "",
      stddev: document.getElementById("delay-stddev-input")?.value ?? "",
      seed: document.getElementById("delay-seed-input")?.value ?? "",
      sweep: Boolean(document.getElementById("sweep-mode-toggle")?.checked),
      runs: document.getElementById("sweep-runs-input")?.value ?? "",
      stddevStart: document.getElementById("sweep-stddev-start-input")?.value ?? "",
      stddevStep: document.getElementById("sweep-stddev-step-input")?.value ?? "",
      sweepPanelVisible: !document.getElementById("sweep-panel")?.hidden,
      startBtnText: document.getElementById("start-btn")?.textContent ?? "",
      hasWindowRunSweep: typeof window.runSweep === "function",
      advancedOpen: Boolean(document.getElementById("advanced-options")?.open),
      statusText: document.getElementById("status-text")?.textContent ?? "",
      statusState: document.getElementById("status-pill")?.dataset?.state ?? "",
      terminalTitle: document.getElementById("terminal-title")?.textContent ?? "",
      stopDisabled: Boolean(document.getElementById("stop-btn")?.disabled),
      activeElementId: document.activeElement?.id ?? "",
      activePresets: Array.from(document.querySelectorAll(".project-preset-chip"))
        .filter((el) => el.dataset.active === "true")
        .map((el) => el.dataset.preset),
      xssFlag: window.__xss,
    }))()`,
    { awaitPromise: false }
  );
}

async function setCheckbox(browser, selector, checked) {
  await browser.evaluate(
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error("Checkbox not found: " + ${JSON.stringify(selector)});
      el.checked = ${Boolean(checked)};
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    })()`,
    { awaitPromise: false }
  );
}

describe("Web UI URL Query-Parameter Deep-Linking (Headless Chrome CDP)", () => {
  let server;
  let browser;

  before(async () => {
    server = createServer({ port: 0, host: "127.0.0.1", allowLocalRegistries: false });
    await server.start();
    browser = await launchCdpBrowser();
  });

  after(async () => {
    if (browser) await browser.close();
    if (server) await server.stop();
  });

  it("hydrates all 7 fields from deep-link URL, opens #advanced-options, updates idle display, and does NOT auto-boot", async () => {
    browser.clearLogs();
    const url =
      `${server.url}/?image=python%3A3.12-slim&repo=bottlepy%2Fbottle&ref=0.13.4&mount=%2Fapp&cmd=python3%20-V&cwd=%2Fapp&env=FOO%3D1&env=BAR%3Da%3Db`;
    await browser.navigate(url);
    await browser.waitForSelector("#image-input");

    const s = await readDomState(browser);
    assert.equal(s.image, "python:3.12-slim");
    assert.equal(s.repo, "bottlepy/bottle");
    assert.equal(s.ref, "0.13.4");
    assert.equal(s.mount, "/app");
    assert.equal(s.cmd, "python3 -V");
    assert.equal(s.cwd, "/app");
    assert.equal(s.env, "FOO=1\nBAR=a=b");
    assert.equal(s.advancedOpen, true, "#advanced-options should auto-open when cwd/env hydrated");
    assert.equal(s.statusState, "idle", "Must never auto-boot on deep-link load");
    assert.equal(s.stopDisabled, true, "Stop button must remain disabled when not booted");
    assert.match(s.statusText, /python:3\.12-slim/);
    assert.equal(s.terminalTitle, "python:3.12-slim + bottlepy/bottle@0.13.4 — python3 -V");
    assert.equal(browser.exceptions.length, 0, `Unexpected exceptions: ${JSON.stringify(browser.exceptions)}`);

    // Verify no OCI/Git proxy fetches occurred on page load (no auto-boot)
    const apiReqs = browser.networkRequests.filter((r) => r.url.includes("/api/v2/") || r.url.includes("/api/git/"));
    assert.equal(apiReqs.length, 0, `Unexpected auto-boot API requests: ${JSON.stringify(apiReqs)}`);
  });

  it("hydrates ?preset=<id> with overrides and empty-string override clearing cmd/env", async () => {
    await browser.navigate(`${server.url}/?preset=python-bottle`);
    let s = await readDomState(browser);
    assert.equal(s.image, "python:3.12-slim");
    assert.equal(s.repo, "bottlepy/bottle");
    assert.equal(s.ref, "0.13.4");
    assert.equal(s.cmd, "python3 -m unittest discover -s test -t .");
    assert.equal(s.cwd, "/workspace");
    assert.equal(s.env, "PYTHONUNBUFFERED=1");
    assert.deepEqual(s.activePresets, ["python-bottle"]);
    assert.equal(s.advancedOpen, true);

    await browser.navigate(`${server.url}/?preset=python-bottle&ref=main&cmd=&env=&cwd=`);
    s = await readDomState(browser);
    assert.equal(s.image, "python:3.12-slim");
    assert.equal(s.repo, "bottlepy/bottle");
    assert.equal(s.ref, "main");
    assert.equal(s.cmd, "");
    assert.equal(s.cwd, "");
    assert.equal(s.env, "");
    assert.deepEqual(s.activePresets, []);
    assert.equal(s.advancedOpen, false);
  });

  it("syncs live edits via replaceState without growing history.length and preserves unmanaged query params + hash", async () => {
    await browser.navigate(`${server.url}/?utm_source=share#section1`);
    const before = await readDomState(browser);
    assert.equal(before.image, "alpine:latest");
    assert.equal(before.advancedOpen, false);
    const startLen = before.historyLength;

    await browser.setInputValue("#image-input", "node:22-slim");
    await browser.setInputValue("#cmd-input", "node -v");
    await browser.setInputValue("#repo-input", "ai/nanoid");
    await browser.setInputValue("#repo-ref-input", "6.0.2");

    const after = await readDomState(browser);
    assert.equal(after.historyLength, startLen, "Typing should use replaceState without growing history.length");
    assert.equal(after.hash, "#section1", "Hash fragment must be preserved");
    const params = new URLSearchParams(after.search);
    assert.equal(params.get("utm_source"), "share", "Unmanaged query param must be preserved");
    assert.equal(params.get("image"), "node:22-slim");
    assert.equal(params.get("cmd"), "node -v");
    assert.equal(params.get("repo"), "ai/nanoid");
    assert.equal(params.get("ref"), "6.0.2");
  });

  it("project-preset click uses pushState, survives full reload, and plain preset-chip preserves reset + focus + popstate back/forward", async () => {
    await browser.navigate(`${server.url}/`);
    const initial = await readDomState(browser);
    const initialLen = initial.historyLength;

    // Click python-bottle project preset -> pushState
    await browser.click('button.project-preset-chip[data-preset="python-bottle"]');
    const afterPreset = await readDomState(browser);
    assert.equal(afterPreset.historyLength, initialLen + 1, "Project preset click should pushState");
    assert.equal(afterPreset.activeElementId, "start-btn");
    assert.deepEqual(afterPreset.activePresets, ["python-bottle"]);
    assert.ok(afterPreset.search.includes("repo=bottlepy%2Fbottle"));

    // Navigate directly to the generated URL in a fresh page load (reload round-trip)
    const shareUrl = `${server.url}${afterPreset.pathname}${afterPreset.search}`;
    await browser.navigate(shareUrl);
    const reloaded = await readDomState(browser);
    assert.equal(reloaded.image, "python:3.12-slim");
    assert.equal(reloaded.repo, "bottlepy/bottle");
    assert.equal(reloaded.ref, "0.13.4");
    assert.equal(reloaded.cmd, "python3 -m unittest discover -s test -t .");
    assert.equal(reloaded.cwd, "/workspace");
    assert.equal(reloaded.env, "PYTHONUNBUFFERED=1");
    assert.deepEqual(reloaded.activePresets, ["python-bottle"]);
    assert.equal(reloaded.advancedOpen, true);

    // Click plain alpine:latest preset chip -> resets fields, focuses #image-input (T1.9.5/T4.11), pushes clean "/"
    const beforePlainLen = reloaded.historyLength;
    await browser.click('button.preset-chip[data-image="alpine:latest"]');
    const afterPlain = await readDomState(browser);
    assert.equal(afterPlain.historyLength, beforePlainLen + 1, "Plain preset chip should pushState");
    assert.equal(afterPlain.activeElementId, "image-input", "T1.9.5/T4.11: must focus #image-input");
    assert.equal(afterPlain.image, "alpine:latest");
    assert.equal(afterPlain.repo, "");
    assert.equal(afterPlain.ref, "");
    assert.equal(afterPlain.mount, "/workspace");
    assert.equal(afterPlain.cmd, "");
    assert.equal(afterPlain.cwd, "");
    assert.equal(afterPlain.env, "");
    assert.equal(afterPlain.search, "", "Default alpine:latest state must serialize to clean URL");
    assert.deepEqual(afterPlain.activePresets, []);

    // history.back() -> popstate restores python-bottle
    await browser.evaluate("new Promise((r) => { window.addEventListener('popstate', () => setTimeout(r, 20), { once: true }); window.history.back(); })");
    const afterBack = await readDomState(browser);
    assert.equal(afterBack.image, "python:3.12-slim");
    assert.equal(afterBack.repo, "bottlepy/bottle");
    assert.equal(afterBack.ref, "0.13.4");
    assert.deepEqual(afterBack.activePresets, ["python-bottle"]);
    assert.equal(afterBack.advancedOpen, true);

    // history.forward() -> popstate restores default alpine:latest and closes #advanced-options
    await browser.evaluate("new Promise((r) => { window.addEventListener('popstate', () => setTimeout(r, 20), { once: true }); window.history.forward(); })");
    const afterForward = await readDomState(browser);
    assert.equal(afterForward.image, "alpine:latest");
    assert.equal(afterForward.repo, "");
    assert.equal(afterForward.cwd, "");
    assert.equal(afterForward.env, "");
    assert.deepEqual(afterForward.activePresets, []);
    assert.equal(afterForward.advancedOpen, false);
  });

  it("is immune to XSS payloads in query parameters (window.__xss remains undefined)", async () => {
    browser.clearLogs();
    const xssImage = '"><script>window.__xss=1</script>';
    const xssRepo = '<img src=x onerror="window.__xss=2">';
    const xssCmd = '";window.__xss=3;//';
    const url =
      `${server.url}/?image=${encodeURIComponent(xssImage)}&repo=${encodeURIComponent(xssRepo)}&cmd=${encodeURIComponent(xssCmd)}`;
    await browser.navigate(url);
    const s = await readDomState(browser);
    assert.equal(s.xssFlag, undefined, "XSS payload must never execute");
    assert.equal(s.image, xssImage);
    assert.equal(s.repo, xssRepo);
    assert.equal(s.cmd, xssCmd);
    assert.equal(browser.exceptions.length, 0);
  });

  it("hydrates build, run alias, stddev, and seed without auto-booting and canonicalizes run -> cmd", async () => {
    browser.clearLogs();
    const url =
      `${server.url}/?image=alpine%3Alatest&build=go%20build&run=.%2Fraft&stddev=2.5&seed=42&cwd=%2Fworkspace%2Fexample`;
    await browser.navigate(url);
    await browser.waitForSelector("#build-cmd-input");

    const s = await readDomState(browser);
    assert.equal(s.image, "alpine:latest");
    assert.equal(s.build, "go build");
    assert.equal(s.cmd, "./raft");
    assert.equal(s.stddev, "2.5");
    assert.equal(s.seed, "42");
    assert.equal(s.sweep, false);
    assert.equal(s.startBtnText, "Start Shell");
    assert.equal(s.hasWindowRunSweep, true);
    assert.equal(s.advancedOpen, true);
    assert.equal(s.statusState, "idle");
    assert.equal(s.stopDisabled, true);
    assert.equal(browser.exceptions.length, 0);

    const apiReqs = browser.networkRequests.filter((r) => r.url.includes("/api/v2/") || r.url.includes("/api/git/"));
    assert.equal(apiReqs.length, 0, `Unexpected auto-boot API requests: ${JSON.stringify(apiReqs)}`);

    // Editing a control triggers replaceState with canonical `cmd` (not `run`)
    await browser.setInputValue("#delay-seed-input", "43");
    const afterEdit = await readDomState(browser);
    const params = new URLSearchParams(afterEdit.search);
    assert.equal(params.get("build"), "go build");
    assert.equal(params.get("cmd"), "./raft");
    assert.equal(params.has("run"), false);
    assert.equal(params.get("stddev"), "2.5");
    assert.equal(params.get("seed"), "43");
  });

  it("hydrates Sweep Mode URL params without auto-booting and syncs sweep edits via replaceState", async () => {
    browser.clearLogs();
    const url =
      `${server.url}/?image=ghcr.io%2Ffatlotus%2Fgolang-with-cache%3A1.27-alpine&repo=fatlotus%2Fnodice&cwd=%2Fworkspace%2Fexample&build=go%20build&cmd=.%2Fraft&sweep=1&runs=15&stddevStart=0.5&stddevStep=1.5&seed=7&selectedRun=3`;
    await browser.navigate(url);
    await browser.waitForSelector("#sweep-mode-toggle");

    const s = await readDomState(browser);
    assert.equal(s.sweep, true);
    assert.equal(s.runs, "15");
    assert.equal(s.stddevStart, "0.5");
    assert.equal(s.stddevStep, "1.5");
    assert.equal(s.seed, "7");
    assert.equal(s.startBtnText, "Run Sweep");
    assert.deepEqual(s.activePresets, ["go-raft-nodice"]);
    assert.equal(s.statusState, "idle");
    assert.equal(s.stopDisabled, true);
    assert.equal(browser.exceptions.length, 0);

    const apiReqs = browser.networkRequests.filter((r) => r.url.includes("/api/v2/") || r.url.includes("/api/git/"));
    assert.equal(apiReqs.length, 0, `Unexpected auto-boot API requests: ${JSON.stringify(apiReqs)}`);

    const startLen = s.historyLength;
    await browser.setInputValue("#sweep-runs-input", "25");
    let updated = await readDomState(browser);
    assert.equal(updated.historyLength, startLen);
    assert.equal(new URLSearchParams(updated.search).get("runs"), "25");

    await setCheckbox(browser, "#sweep-mode-toggle", false);
    updated = await readDomState(browser);
    assert.equal(updated.historyLength, startLen);
    assert.equal(updated.startBtnText, "Start Shell");
    assert.equal(new URLSearchParams(updated.search).has("sweep"), false);
    assert.equal(new URLSearchParams(updated.search).has("selectedRun"), false);
  });

  it("go-raft-nodice preset chip populates build+run+repo+cwd, survives reload, and alpine:latest resets all M18 fields", async () => {
    await browser.navigate(`${server.url}/`);
    const before = await readDomState(browser);
    const startLen = before.historyLength;

    await browser.click('button.project-preset-chip[data-preset="go-raft-nodice"]');
    const afterPreset = await readDomState(browser);
    assert.equal(afterPreset.historyLength, startLen + 1);
    assert.equal(afterPreset.activeElementId, "start-btn");
    assert.deepEqual(afterPreset.activePresets, ["go-raft-nodice"]);
    assert.equal(afterPreset.image, "ghcr.io/fatlotus/golang-with-cache:1.27-alpine");
    assert.equal(afterPreset.repo, "fatlotus/nodice");
    assert.equal(afterPreset.cwd, "/workspace/example");
    assert.equal(afterPreset.build, "go build");
    assert.equal(afterPreset.cmd, "./raft");

    const params = new URLSearchParams(afterPreset.search);
    assert.equal(params.get("build"), "go build");
    assert.equal(params.get("cmd"), "./raft");

    // Reload round-trip
    await browser.navigate(`${server.url}${afterPreset.pathname}${afterPreset.search}`);
    const reloaded = await readDomState(browser);
    assert.equal(reloaded.build, "go build");
    assert.equal(reloaded.cmd, "./raft");
    assert.deepEqual(reloaded.activePresets, ["go-raft-nodice"]);

    // Toggle sweep on and set delay values, then click plain alpine:latest chip -> full reset
    await setCheckbox(browser, "#sweep-mode-toggle", true);
    await browser.setInputValue("#delay-stddev-input", "5");
    await browser.setInputValue("#delay-seed-input", "9");
    await browser.click('button.preset-chip[data-image="alpine:latest"]');
    const reset = await readDomState(browser);
    assert.equal(reset.activeElementId, "image-input");
    assert.equal(reset.image, "alpine:latest");
    assert.equal(reset.build, "");
    assert.equal(reset.cmd, "");
    assert.equal(reset.stddev, "0");
    assert.equal(reset.seed, "0");
    assert.equal(reset.sweep, false);
    assert.equal(reset.search, "");
  });

  it("is immune to XSS payloads in M18 query parameters (build, run, stddev, seed, sweep, selectedRun)", async () => {
    browser.clearLogs();
    const xssBuild = "<img src=x onerror=window.__xss=10>";
    const xssRun = '"><script>window.__xss=11</script>';
    const url =
      `${server.url}/?build=${encodeURIComponent(xssBuild)}&run=${encodeURIComponent(xssRun)}&stddev=${encodeURIComponent("<svg onload=window.__xss=12>")}&seed=abc&sweep=${encodeURIComponent("<script>window.__xss=13</script>")}&selectedRun=${encodeURIComponent("<img src=x onerror=window.__xss=14>")}`;
    await browser.navigate(url);
    const s = await readDomState(browser);
    assert.equal(s.xssFlag, undefined, "XSS payload must never execute");
    assert.equal(s.build, xssBuild);
    assert.equal(s.cmd, xssRun);
    assert.equal(s.stddev, "0");
    assert.equal(s.seed, "0");
    assert.equal(s.sweep, false);
    assert.equal(browser.exceptions.length, 0);
  });
});

describe("Web UI Offline Sweep Mode & Linkable Runs (Headless Chrome CDP)", () => {
  let mockRegistry;
  let server;
  let browser;

  before(async () => {
    mockRegistry = await startMockOciRegistry();
    mockRegistry.ensureBuiltinFixture("alpine");
    server = createServer({ port: 0, host: "127.0.0.1", allowLocalRegistries: true });
    await server.start();
    browser = await launchCdpBrowser();
  });

  after(async () => {
    if (browser) await browser.close();
    if (server) await server.stop();
    if (mockRegistry) await mockRegistry.close();
  });

  it("runs a 2-run build+sweep offline, renders #sweep-panel & <a class='run-link'>, syncs selectedRun, and opens standalone reproducer URL", async () => {
    browser.clearLogs();
    const imageRef = mockRegistry.imageRef("library/alpine", "latest");
    const buildCmd = `/bin/sh -c "echo BUILD_ONCE_OK > /tmp/m18_built.txt"`;
    const runCmd = `/bin/sh -c "cat /tmp/m18_built.txt && od -An -tx1 -N4 /dev/urandom"`;
    const sweepParams = new URLSearchParams({
      image: imageRef,
      build: buildCmd,
      cmd: runCmd,
      sweep: "1",
      runs: "2",
      stddevStart: "1",
      stddevStep: "2",
      seed: "10",
    });

    await browser.navigate(`${server.url}/?${sweepParams.toString()}`);
    await browser.waitForSelector("#start-btn");

    // Verify strict no-auto-boot before clicking Run Sweep
    const preBoot = await readDomState(browser);
    assert.equal(preBoot.statusState, "idle");
    assert.equal(preBoot.stopDisabled, true);
    assert.equal(preBoot.startBtnText, "Run Sweep");
    const preApiReqs = browser.networkRequests.filter((r) => r.url.includes("/api/v2/"));
    assert.equal(preApiReqs.length, 0, "Sweep URL must not auto-boot");

    // Start sweep
    await browser.click("#start-btn");

    // Wait for both rows to complete and UI to leave busy state
    const deadline = Date.now() + 60_000;
    let finished = false;
    while (Date.now() < deadline) {
      const poll = await browser.evaluate(
        `(() => {
          const rows = document.querySelectorAll("#sweep-results-body tr");
          const stopDisabled = Boolean(document.getElementById("stop-btn")?.disabled);
          const statusState = document.getElementById("status-pill")?.dataset?.state ?? "";
          return { rowCount: rows.length, stopDisabled, statusState };
        })()`,
        { awaitPromise: false }
      );
      if (
        poll.rowCount === 2 &&
        poll.stopDisabled &&
        poll.statusState !== "busy" &&
        poll.statusState !== "running"
      ) {
        finished = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(finished, true, "2-run offline sweep did not finish within 60s");

    const rowsInfo = await browser.evaluate(
      `(() => {
        const panel = document.getElementById("sweep-panel");
        const rows = Array.from(document.querySelectorAll("#sweep-results-body tr")).map((tr) => {
          const cells = Array.from(tr.querySelectorAll("td")).map((td) => td.textContent.trim());
          const link = tr.querySelector("a.run-link");
          return { cells, href: link?.getAttribute("href") ?? "" };
        });
        return { panelVisible: !panel?.hidden, rows };
      })()`,
      { awaitPromise: false }
    );

    assert.equal(rowsInfo.panelVisible, true);
    assert.equal(rowsInfo.rows.length, 2);

    // Verify per-run standalone reproducer links
    const href1 = rowsInfo.rows[0].href;
    const href2 = rowsInfo.rows[1].href;
    assert.ok(href1.includes("?"), `Row 1 run-link missing query: ${href1}`);
    assert.ok(href2.includes("?"), `Row 2 run-link missing query: ${href2}`);

    const p1 = new URLSearchParams(href1.slice(href1.indexOf("?")));
    assert.equal(p1.get("stddev"), "1");
    assert.equal(p1.get("seed"), "10");
    assert.equal(p1.get("image"), imageRef);
    assert.equal(p1.get("build"), buildCmd);
    assert.equal(p1.get("cmd"), runCmd);
    assert.equal(p1.has("sweep"), false);
    assert.equal(p1.has("runs"), false);
    assert.equal(p1.has("stddevStart"), false);
    assert.equal(p1.has("stddevStep"), false);
    assert.equal(p1.has("selectedRun"), false);

    const p2 = new URLSearchParams(href2.slice(href2.indexOf("?")));
    assert.equal(p2.get("stddev"), "3");
    assert.equal(p2.get("seed"), "11");
    assert.equal(p2.has("sweep"), false);
    assert.equal(p2.has("selectedRun"), false);

    // Click row 1 -> displays output in #terminal and syncs selectedRun=1
    await browser.click("#sweep-results-body tr:nth-child(1)");
    const out1 = await browser.getText("#terminal");
    assert.ok(out1.includes("BUILD_ONCE_OK"), `Row 1 terminal missing BUILD_ONCE_OK: ${out1}`);
    const searchAfterRow1 = await browser.evaluate("window.location.search", { awaitPromise: false });
    assert.equal(new URLSearchParams(searchAfterRow1).get("selectedRun"), "1");

    // Click row 2 -> displays different seeded output in #terminal and syncs selectedRun=2
    await browser.click("#sweep-results-body tr:nth-child(2)");
    const out2 = await browser.getText("#terminal");
    assert.ok(out2.includes("BUILD_ONCE_OK"), `Row 2 terminal missing BUILD_ONCE_OK: ${out2}`);
    assert.notEqual(out2, out1, "Seeded /dev/urandom output should differ between seed=10 and seed=11");
    const searchAfterRow2 = await browser.evaluate("window.location.search", { awaitPromise: false });
    assert.equal(new URLSearchParams(searchAfterRow2).get("selectedRun"), "2");

    // Navigate directly to row 2's standalone reproducer URL
    browser.clearLogs();
    await browser.navigate(`${server.url}${href2}`);
    await browser.waitForSelector("#delay-stddev-input");
    const reproState = await readDomState(browser);
    assert.equal(reproState.sweep, false);
    assert.equal(reproState.stddev, "3");
    assert.equal(reproState.seed, "11");
    assert.equal(reproState.build, buildCmd);
    assert.equal(reproState.cmd, runCmd);
    assert.equal(reproState.statusState, "idle");
    assert.equal(reproState.stopDisabled, true);
    const reproApiReqs = browser.networkRequests.filter((r) => r.url.includes("/api/v2/"));
    assert.equal(reproApiReqs.length, 0, "Standalone reproducer URL must not auto-boot");
    assert.equal(browser.exceptions.length, 0, `Unexpected exceptions: ${JSON.stringify(browser.exceptions)}`);
  });
});
