// Headless Google Chrome launcher and Node.js 22 native WebSocket CDP client.
// Supports Page, Runtime, Log, Input, Network, and Dedicated Web Worker network capture
// via Target.setAutoAttach({ autoAttach: true, waitForDebuggerOnStart: true, flatten: true }).
// Zero external dependencies (Node.js 22 built-ins only).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { findChromeBinary } from "./server_harness.mjs";
import { sleep, stripAnsi, waitFor } from "./test_runner.mjs";

export { findChromeBinary };

/**
 * Parse a CSS color string (`rgb(...)`, `rgba(...)`, `color(srgb ...)`, `#rgb`, `#rrggbb`)
 * into `{ r, g, b, a }` with r/g/b in [0, 255] and a in [0, 1]. Returns null if invalid.
 * @param {string} colorStr
 * @returns {{ r: number, g: number, b: number, a: number } | null}
 */
export function parseRgb(colorStr) {
  if (typeof colorStr !== "string") return null;
  const s = colorStr.trim().toLowerCase();
  if (!s || s === "transparent" || s === "none") return null;

  const rgbaMatch = s.match(
    /^rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/
  );
  if (rgbaMatch) {
    const r = Number(rgbaMatch[1]);
    const g = Number(rgbaMatch[2]);
    const b = Number(rgbaMatch[3]);
    let a = 1;
    if (rgbaMatch[4] !== undefined) {
      a = rgbaMatch[4].endsWith("%")
        ? Number(rgbaMatch[4].slice(0, -1)) / 100
        : Number(rgbaMatch[4]);
    }
    if ([r, g, b, a].some((n) => !Number.isFinite(n))) return null;
    return { r, g, b, a };
  }

  const srgbMatch = s.match(
    /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/
  );
  if (srgbMatch) {
    const r = Number(srgbMatch[1]) * 255;
    const g = Number(srgbMatch[2]) * 255;
    const b = Number(srgbMatch[3]) * 255;
    let a = 1;
    if (srgbMatch[4] !== undefined) {
      a = srgbMatch[4].endsWith("%")
        ? Number(srgbMatch[4].slice(0, -1)) / 100
        : Number(srgbMatch[4]);
    }
    if ([r, g, b, a].some((n) => !Number.isFinite(n))) return null;
    return { r, g, b, a };
  }

  const hexMatch = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (hexMatch) {
    const hex = hexMatch[1];
    if (hex.length === 3) {
      return {
        r: parseInt(hex[0] + hex[0], 16),
        g: parseInt(hex[1] + hex[1], 16),
        b: parseInt(hex[2] + hex[2], 16),
        a: 1,
      };
    }
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a: 1,
    };
  }

  return null;
}

/**
 * Compute WCAG 2.1 relative luminance in [0, 1] for an RGB color (or CSS color string).
 * @param {{ r: number, g: number, b: number } | string} color
 * @returns {number}
 */
export function relativeLuminance(color) {
  const rgb = typeof color === "string" ? parseRgb(color) : color;
  if (!rgb) {
    throw new Error(`Cannot compute relative luminance for color: ${JSON.stringify(color)}`);
  }
  const linear = [rgb.r, rgb.g, rgb.b].map((channel) => {
    const c = Math.max(0, Math.min(255, channel)) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/**
 * Compute WCAG 2.1 contrast ratio in [1, 21] between two colors or luminance values.
 * @param {{ r: number, g: number, b: number } | string | number} a
 * @param {{ r: number, g: number, b: number } | string | number} b
 * @returns {number}
 */
export function contrastRatio(a, b) {
  const lA = typeof a === "number" ? a : relativeLuminance(a);
  const lB = typeof b === "number" ? b : relativeLuminance(b);
  const lighter = Math.max(lA, lB);
  const darker = Math.min(lA, lB);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Launch headless Chrome and return a connected CDP browser controller.
 * @param {{ chromePath?: string, timeoutMs?: number, colorScheme?: "light" | "dark" | null, viewport?: { width: number, height: number, mobile?: boolean, deviceScaleFactor?: number } }} [opts]
 */
export async function launchCdpBrowser(opts = {}) {
  const chromePath = opts.chromePath || findChromeBinary();
  if (!chromePath) {
    throw new Error(
      "No Chrome/Chromium binary found (checked CHROME_PATH, CHROME_BIN, /usr/bin/google-chrome, /usr/bin/chromium)"
    );
  }

  const launchTimeoutMs = opts.timeoutMs || 15000;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "elf2wasm-chrome-"));

  const args = [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-extensions",
    "--no-first-run",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "about:blank",
  ];

  const proc = spawn(chromePath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  let exited = false;
  const exitPromise = new Promise((resolve) => {
    proc.once("exit", (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
  });

  const stderrChunks = [];
  let browserWsUrl = null;

  const wsUrlPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `Timed out waiting for Chrome DevTools WebSocket URL.\nstderr:\n${stderrChunks.join("")}`
        )
      );
    }, launchTimeoutMs);

    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => {
      stderrChunks.push(chunk);
      if (!browserWsUrl) {
        const match = stderrChunks.join("").match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) {
          browserWsUrl = match[1];
          clearTimeout(timer);
          resolve(browserWsUrl);
        }
      }
    });

    proc.once("exit", (code, signal) => {
      if (!browserWsUrl) {
        clearTimeout(timer);
        reject(
          new Error(
            `Chrome exited before DevTools started (code=${code}, signal=${signal}).\nstderr:\n${stderrChunks.join("")}`
          )
        );
      }
    });
  });

  let ws = null;
  const tempDownloadDirs = [];

  async function cleanup() {
    if (ws) {
      try {
        ws.close();
      } catch {
        // ignore
      }
      ws = null;
    }

    if (!exited) {
      try {
        process.kill(-proc.pid, "SIGTERM");
      } catch {
        try {
          proc.kill("SIGTERM");
        } catch {
          // ignore
        }
      }
      const timedOut = await Promise.race([
        exitPromise.then(() => false),
        sleep(1500).then(() => true),
      ]);
      if (timedOut && !exited) {
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch {
          try {
            proc.kill("SIGKILL");
          } catch {
            // ignore
          }
        }
        await Promise.race([exitPromise, sleep(2000)]);
      }
    }

    try {
      fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // ignore cleanup race
    }
    for (const dir of tempDownloadDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch {
        // ignore cleanup race
      }
    }
  }

  try {
    const devToolsWs = await wsUrlPromise;
    const listUrl = devToolsWs
      .replace(/^ws:/, "http:")
      .replace(/\/devtools\/browser\/.*$/, "/json/list");

    const pageTarget = await waitFor(
      async () => {
        const resp = await fetch(listUrl);
        if (!resp.ok) return null;
        const targets = await resp.json();
        return targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl) || null;
      },
      { timeoutMs: 10000, intervalMs: 100, label: "Chrome page target" }
    );

    ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const onOpen = () => {
        ws.removeEventListener("error", onErr);
        resolve();
      };
      const onErr = (err) => {
        ws.removeEventListener("open", onOpen);
        reject(new Error(`Failed to connect CDP WebSocket: ${err.message || err}`));
      };
      ws.addEventListener("open", onOpen, { once: true });
      ws.addEventListener("error", onErr, { once: true });
    });

    let nextId = 1;
    const pending = new Map();
    const eventListeners = new Map();

    const exceptions = [];
    const consoleErrors = [];
    const consoleLogs = [];
    const networkRequests = [];
    const networkResponses = [];
    const workerTargets = [];

    function send(method, params = {}, sessionId = undefined) {
      return new Promise((resolve, reject) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          reject(new Error(`CDP WebSocket is not open (method=${method})`));
          return;
        }
        const id = nextId++;
        const payload = { id, method, params };
        if (sessionId) payload.sessionId = sessionId;
        pending.set(id, { resolve, reject, method });
        ws.send(JSON.stringify(payload));
      });
    }

    function on(eventName, handler) {
      if (!eventListeners.has(eventName)) {
        eventListeners.set(eventName, new Set());
      }
      eventListeners.get(eventName).add(handler);
      return () => eventListeners.get(eventName)?.delete(handler);
    }

    ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8"));
      } catch {
        return;
      }

      if (msg.id !== undefined) {
        const entry = pending.get(msg.id);
        if (entry) {
          pending.delete(msg.id);
          if (msg.error) {
            entry.reject(new Error(`CDP ${entry.method} error: ${msg.error.message} (${msg.error.code})`));
          } else {
            entry.resolve(msg.result);
          }
        }
        return;
      }

      const method = msg.method;
      const params = msg.params || {};
      const sessionId = msg.sessionId || "page";

      if (method === "Runtime.exceptionThrown") {
        const desc = params.exceptionDetails?.exception?.description
          || params.exceptionDetails?.text
          || JSON.stringify(params.exceptionDetails);
        exceptions.push({ sessionId, message: desc, details: params.exceptionDetails });
      } else if (method === "Runtime.consoleAPICalled") {
        const text = (params.args || [])
          .map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type))
          .join(" ");
        consoleLogs.push({ sessionId, type: params.type, text });
        if (params.type === "error") {
          consoleErrors.push({ sessionId, text });
        }
      } else if (method === "Log.entryAdded") {
        if (params.entry?.level === "error") {
          consoleErrors.push({ sessionId, text: params.entry.text || JSON.stringify(params.entry) });
        }
      } else if (method === "Network.requestWillBeSent") {
        networkRequests.push({
          sessionId,
          requestId: params.requestId,
          url: params.request?.url || "",
          method: params.request?.method || "GET",
          resourceType: params.type || "",
          timestamp: Date.now(),
        });
      } else if (method === "Network.responseReceived") {
        networkResponses.push({
          sessionId,
          requestId: params.requestId,
          url: params.response?.url || "",
          status: params.response?.status || 0,
          mimeType: params.response?.mimeType || "",
          headers: params.response?.headers || {},
          timestamp: Date.now(),
        });
      } else if (method === "Target.attachedToTarget") {
        const childSessionId = params.sessionId;
        const targetInfo = params.targetInfo || {};
        workerTargets.push({ sessionId: childSessionId, ...targetInfo });
        if (childSessionId) {
          // Enable Network + Runtime BEFORE resuming the paused target so early Worker fetches are never dropped
          (async () => {
            try {
              await Promise.allSettled([
                send("Network.enable", {}, childSessionId),
                send("Runtime.enable", {}, childSessionId),
              ]);
            } finally {
              if (params.waitingForDebugger) {
                await send("Runtime.runIfWaitingForDebugger", {}, childSessionId).catch(() => {});
              }
            }
          })();
        }
      }

      const listeners = eventListeners.get(method);
      if (listeners) {
        for (const fn of listeners) {
          try {
            fn(params, sessionId);
          } catch {
            // ignore listener error
          }
        }
      }
    });

    ws.addEventListener("close", () => {
      for (const [, entry] of pending) {
        entry.reject(new Error(`CDP WebSocket closed while awaiting ${entry.method}`));
      }
      pending.clear();
    });

    // Enable core domains + Worker auto-attach
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Log.enable");
    await send("Network.enable");
    await send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });

    async function setColorScheme(scheme) {
      const features = scheme ? [{ name: "prefers-color-scheme", value: scheme }] : [];
      await send("Emulation.setEmulatedMedia", { features });
    }

    async function setViewport(width, height, mobile = false, deviceScaleFactor = 1) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor,
        mobile: Boolean(mobile),
      });
    }

    if (opts.colorScheme) {
      await setColorScheme(opts.colorScheme);
    }
    if (opts.viewport && Number.isFinite(opts.viewport.width) && Number.isFinite(opts.viewport.height)) {
      await setViewport(
        opts.viewport.width,
        opts.viewport.height,
        Boolean(opts.viewport.mobile),
        opts.viewport.deviceScaleFactor || 1
      );
    }

    // Download tracking state
    let activeDownloadDir = null;
    const downloadMetaByGuid = new Map();
    const completedGuids = new Set();
    const completedDownloads = [];
    const downloadWaiters = [];
    let downloadListenersInstalled = false;

    function resolveDownloadFile(dir, guid, suggestedFilename) {
      const candidates = [];
      if (suggestedFilename) {
        candidates.push(path.join(dir, suggestedFilename));
      }
      if (guid) {
        candidates.push(path.join(dir, guid));
      }
      for (const candidate of candidates) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return candidate;
        }
      }
      const entries = fs.readdirSync(dir)
        .filter((name) => !name.endsWith(".crdownload") && !name.endsWith(".tmp"))
        .map((name) => {
          const full = path.join(dir, name);
          const stat = fs.statSync(full);
          return { full, mtimeMs: stat.mtimeMs, isFile: stat.isFile() };
        })
        .filter((e) => e.isFile)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      return entries.length > 0 ? entries[0].full : null;
    }

    function handleDownloadWillBegin(params) {
      const guid = params.guid || `dl-${Date.now()}`;
      downloadMetaByGuid.set(guid, {
        guid,
        suggestedFilename: params.suggestedFilename || "",
        url: params.url || "",
      });
    }

    function handleDownloadProgress(params) {
      const guid = params.guid || "";
      if (params.state === "completed") {
        if (guid && completedGuids.has(guid)) return;
        if (guid) completedGuids.add(guid);
        const meta = downloadMetaByGuid.get(guid) || { guid, suggestedFilename: "" };
        const dir = activeDownloadDir;
        let filePath = dir ? resolveDownloadFile(dir, guid, meta.suggestedFilename) : null;
        let bytes = new Uint8Array(0);
        if (filePath && fs.existsSync(filePath)) {
          const buf = fs.readFileSync(filePath);
          bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        }
        const record = {
          guid,
          suggestedFilename: meta.suggestedFilename || (filePath ? path.basename(filePath) : ""),
          filePath,
          bytes,
        };
        if (downloadWaiters.length > 0) {
          const waiter = downloadWaiters.shift();
          waiter.resolve(record);
        } else {
          completedDownloads.push(record);
        }
      } else if (params.state === "canceled") {
        if (downloadWaiters.length > 0) {
          const waiter = downloadWaiters.shift();
          waiter.reject(new Error(`Browser download canceled (guid=${guid})`));
        }
      }
    }

    async function enableDownloads(downloadDir) {
      let dir = downloadDir;
      if (!dir) {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "elf2wasm-downloads-"));
        tempDownloadDirs.push(dir);
      } else {
        fs.mkdirSync(dir, { recursive: true });
      }
      activeDownloadDir = dir;
      completedGuids.clear();
      completedDownloads.length = 0;

      if (!downloadListenersInstalled) {
        downloadListenersInstalled = true;
        on("Browser.downloadWillBegin", handleDownloadWillBegin);
        on("Page.downloadWillBegin", handleDownloadWillBegin);
        on("Browser.downloadProgress", handleDownloadProgress);
        on("Page.downloadProgress", handleDownloadProgress);
      }

      try {
        await send("Browser.setDownloadBehavior", {
          behavior: "allow",
          downloadPath: dir,
          eventsEnabled: true,
        });
      } catch {
        await send("Page.setDownloadBehavior", {
          behavior: "allow",
          downloadPath: dir,
        });
      }
      return dir;
    }

    async function waitForDownload(timeoutMs = 15000) {
      if (!activeDownloadDir) {
        throw new Error("enableDownloads() must be called before waitForDownload()");
      }
      if (completedDownloads.length > 0) {
        return completedDownloads.shift();
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          resolve(val) {
            clearTimeout(timer);
            resolve(val);
          },
          reject(err) {
            clearTimeout(timer);
            reject(err);
          },
        };
        const timer = setTimeout(() => {
          const idx = downloadWaiters.indexOf(waiter);
          if (idx !== -1) downloadWaiters.splice(idx, 1);
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for browser download in ${activeDownloadDir}`));
        }, timeoutMs);
        downloadWaiters.push(waiter);
      });
    }

    async function evaluate(expression, evalOpts = {}) {
      const { awaitPromise = true, returnByValue = true } = evalOpts;
      const result = await send("Runtime.evaluate", {
        expression,
        awaitPromise,
        returnByValue,
      });
      if (result.exceptionDetails) {
        const desc = result.exceptionDetails.exception?.description
          || result.exceptionDetails.text
          || "Evaluation exception";
        throw new Error(`Browser evaluate failed: ${desc}`);
      }
      return result.result?.value;
    }

    async function navigate(url, navOpts = {}) {
      const timeoutMs = navOpts.timeoutMs || 20000;
      const targetUrl = new URL(url);
      let loaded = false;
      const off = on("Page.loadEventFired", () => {
        loaded = true;
      });
      try {
        await send("Page.navigate", { url });
        await waitFor(
          async () => {
            if (loaded) return true;
            const state = await evaluate(
              "({ href: location.href, origin: location.origin, readyState: document.readyState })",
              { awaitPromise: false }
            );
            return Boolean(
              state &&
              state.href !== "about:blank" &&
              state.origin === targetUrl.origin &&
              state.readyState === "complete"
            );
          },
          { timeoutMs, intervalMs: 100, label: `page load for ${url}` }
        );
      } finally {
        off();
      }
    }

    async function waitForSelector(selector, timeoutMs = 15000) {
      await waitFor(
        () => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`, { awaitPromise: false }),
        { timeoutMs, intervalMs: 100, label: `selector ${selector}` }
      );
    }

    async function click(selector) {
      await waitForSelector(selector, 10000);
      const clicked = await evaluate(
        `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return false;
          el.click();
          return true;
        })()`,
        { awaitPromise: false }
      );
      if (!clicked) {
        throw new Error(`Could not click selector: ${selector}`);
      }
    }

    async function setInputValue(selector, value) {
      await waitForSelector(selector, 10000);
      await evaluate(
        `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) throw new Error("Missing element: " + ${JSON.stringify(selector)});
          el.focus();
          el.value = ${JSON.stringify(value)};
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return el.value;
        })()`,
        { awaitPromise: false }
      );
    }

    async function getInputValue(selector) {
      return evaluate(
        `document.querySelector(${JSON.stringify(selector)})?.value ?? ""`,
        { awaitPromise: false }
      );
    }

    async function getText(selector) {
      return evaluate(
        `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return "";
          return el.innerText || el.textContent || "";
        })()`,
        { awaitPromise: false }
      );
    }

    async function getComputedStyles(selector, props = ["backgroundColor", "color"]) {
      return evaluate(
        `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          const cs = window.getComputedStyle(el);
          const out = {};
          for (const prop of ${JSON.stringify(props)}) {
            const val = cs.getPropertyValue(prop) || cs[prop] || "";
            out[prop] = val;
          }
          return out;
        })()`,
        { awaitPromise: false }
      );
    }

    async function focusSelector(selector) {
      await evaluate(
        `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return false;
          const target = el.querySelector("textarea, input, [tabindex]") || el;
          if (typeof target.focus === "function") target.focus();
          return true;
        })()`,
        { awaitPromise: false }
      );
    }

    async function typeIntoTerminal(text, typeOpts = {}) {
      const { pressEnter = true, selector = "#terminal" } = typeOpts;
      await focusSelector(selector);
      if (text.length > 0) {
        const isEditable = await evaluate(
          `(() => {
            const active = document.activeElement;
            if (!active) return false;
            const tag = active.tagName;
            return tag === "INPUT" || tag === "TEXTAREA" || Boolean(active.isContentEditable);
          })()`,
          { awaitPromise: false }
        );
        if (isEditable) {
          await send("Input.insertText", { text });
        } else {
          for (const ch of text) {
            await send("Input.dispatchKeyEvent", {
              type: "keyDown",
              key: ch,
              text: ch,
            });
            await send("Input.dispatchKeyEvent", {
              type: "keyUp",
              key: ch,
            });
          }
        }
      }
      if (pressEnter) {
        await send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
          text: "\r",
        });
        await send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
        });
      }
    }

    async function getPresetChips() {
      return evaluate(
        `Array.from(document.querySelectorAll(".preset-chip")).map((el) => ({
          image: el.dataset.image || "",
          text: (el.textContent || "").trim(),
        }))`,
        { awaitPromise: false }
      );
    }

    async function clickPresetChip(imageName) {
      const selector = `button.preset-chip[data-image=${JSON.stringify(imageName)}]`;
      await click(selector);
      return evaluate(
        'document.querySelector("#image-input")?.value ?? ""',
        { awaitPromise: false }
      );
    }

    async function getProjectPresetChips() {
      return evaluate(
        `Array.from(document.querySelectorAll(".project-presets-row .project-preset-chip[data-preset], .project-preset-chip[data-preset]")).map((el) => ({
          preset: el.dataset.preset || "",
          language: el.dataset.language || "",
          text: (el.textContent || "").trim(),
        }))`,
        { awaitPromise: false }
      );
    }

    async function clickProjectPresetChip(presetId) {
      const selector = `button.project-preset-chip[data-preset=${JSON.stringify(presetId)}]`;
      await click(selector);
      return evaluate(
        `({
          image: document.querySelector("#image-input")?.value ?? "",
          repo: document.querySelector("#repo-input")?.value ?? "",
          ref: document.querySelector("#repo-ref-input")?.value ?? "",
          mountPath: document.querySelector("#repo-mount-input")?.value ?? "",
          cmd: document.querySelector("#cmd-input")?.value ?? "",
          cwd: document.querySelector("#cwd-input")?.value ?? "",
          env: document.querySelector("#env-input")?.value ?? "",
        })`,
        { awaitPromise: false }
      );
    }

    async function waitForTerminalText(matcher, waitOpts = {}) {
      const {
        timeoutMs = 90000,
        intervalMs = 250,
        label = "terminal text",
      } = waitOpts;
      const t0 = Date.now();
      let matchedText = "";
      await waitFor(
        async () => {
          const text = stripAnsi(await getText("#terminal"));
          let ok = false;
          if (typeof matcher === "string") {
            ok = text.includes(matcher);
          } else if (matcher instanceof RegExp) {
            ok = matcher.test(text);
          } else if (typeof matcher === "function") {
            ok = Boolean(matcher(text));
          }
          if (ok) {
            matchedText = text;
            return true;
          }
          return false;
        },
        { timeoutMs, intervalMs, label }
      );
      return { text: matchedText, elapsedMs: Date.now() - t0 };
    }

    async function sendControlKey(key, keyOpts = {}) {
      const { selector = "#terminal" } = keyOpts;
      await focusSelector(selector);
      const ch = String(key || "").toLowerCase();
      if (!ch || ch.length !== 1) {
        throw new Error(`sendControlKey expects a single character, got ${JSON.stringify(key)}`);
      }
      const upper = ch.toUpperCase();
      const vk = upper.charCodeAt(0);
      const code = /^[A-Z]$/.test(upper) ? `Key${upper}` : "";
      await send("Input.dispatchKeyEvent", {
        type: "keyDown",
        modifiers: 2,
        key: ch,
        code,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
      });
      await send("Input.dispatchKeyEvent", {
        type: "keyUp",
        modifiers: 2,
        key: ch,
        code,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
      });
    }

    return {
      chromePath,
      userDataDir,
      exceptions,
      consoleErrors,
      consoleLogs,
      networkRequests,
      networkResponses,
      workerTargets,
      send,
      on,
      navigate,
      evaluate,
      waitForSelector,
      click,
      setInputValue,
      getInputValue,
      getText,
      getComputedStyles,
      setColorScheme,
      setViewport,
      enableDownloads,
      waitForDownload,
      focusSelector,
      typeIntoTerminal,
      getPresetChips,
      clickPresetChip,
      getProjectPresetChips,
      clickProjectPresetChip,
      waitForTerminalText,
      sendControlKey,
      clearLogs() {
        exceptions.length = 0;
        consoleErrors.length = 0;
        consoleLogs.length = 0;
        networkRequests.length = 0;
        networkResponses.length = 0;
      },
      close: cleanup,
    };
  } catch (err) {
    await cleanup();
    throw err;
  }
}
