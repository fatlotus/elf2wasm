import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { createServer } from "../server/server.mjs";
import { launchCdpBrowser } from "./helpers/cdp_browser.mjs";

async function readDomState(browser) {
  return browser.evaluate(
    `(() => ({
      search: window.location.search,
      pathname: window.location.pathname,
      hash: window.location.hash,
      historyLength: window.history.length,
      image: document.getElementById("image-input")?.value ?? "",
      cmd: document.getElementById("cmd-input")?.value ?? "",
      repo: document.getElementById("repo-input")?.value ?? "",
      ref: document.getElementById("repo-ref-input")?.value ?? "",
      mount: document.getElementById("repo-mount-input")?.value ?? "",
      cwd: document.getElementById("cwd-input")?.value ?? "",
      env: document.getElementById("env-input")?.value ?? "",
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
});
