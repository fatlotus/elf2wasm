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
 * Launch headless Chrome and return a connected CDP browser controller.
 * @param {{ chromePath?: string, timeoutMs?: number }} [opts]
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
