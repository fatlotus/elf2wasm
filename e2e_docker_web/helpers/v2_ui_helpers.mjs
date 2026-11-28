// Semantic, opaque-box DOM interaction helpers for the elf2wasm v2 Developer-Tool UI.
// Locates controls via accessible labels, roles, semantic tags, and data-* attributes
// rather than fragile styling classes. Zero external dependencies.

import { parseRgb, relativeLuminance, contrastRatio } from "./cdp_browser.mjs";
import { stripAnsi, waitFor } from "./test_runner.mjs";

/**
 * Resolve the effective non-transparent background color of an element by walking up
 * its ancestor chain (falling back to documentElement / white if transparent).
 */
export async function getEffectiveColors(browser, selector) {
  const raw = await browser.evaluate(
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const cs = window.getComputedStyle(el);
      const color = cs.color;
      let bg = cs.backgroundColor;
      let cur = el;
      const isTransparent = (c) => !c || c === "transparent" || /^rgba\\(\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*0(?:\\.0+)?\\s*\\)$/.test(c) || /^color\\([^)]*\\/\\s*0(?:\\.0+)?\\s*\\)$/.test(c);
      while (cur && isTransparent(bg)) {
        cur = cur.parentElement;
        if (cur) bg = window.getComputedStyle(cur).backgroundColor;
      }
      if (isTransparent(bg)) {
        bg = window.getComputedStyle(document.documentElement).backgroundColor;
      }
      return {
        color,
        backgroundColor: bg,
        themeAttr: document.documentElement.getAttribute("data-theme") || document.body.getAttribute("data-theme") || "",
        prefersDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
      };
    })()`,
    { awaitPromise: false }
  );
  if (!raw) return null;
  const bgRgb = parseRgb(raw.backgroundColor);
  const fgRgb = parseRgb(raw.color);
  const bgLuminance = bgRgb ? relativeLuminance(bgRgb) : null;
  const fgLuminance = fgRgb ? relativeLuminance(fgRgb) : null;
  const contrast = bgLuminance !== null && fgLuminance !== null
    ? contrastRatio(bgLuminance, fgLuminance)
    : null;
  return {
    ...raw,
    bgRgb,
    fgRgb,
    bgLuminance,
    fgLuminance,
    contrast,
  };
}

/**
 * Click the first visible button/tab/control whose text, aria-label, or title matches `regex`.
 * Returns `{ clicked: boolean, label: string }`.
 */
export async function clickControlByLabel(browser, regex, opts = {}) {
  const {
    selector = "button, [role='button'], [role='tab'], [role='radio'], a.btn",
    allowDisabled = false,
  } = opts;
  return browser.evaluate(
    `(() => {
      const re = new RegExp(${JSON.stringify(regex.source)}, ${JSON.stringify(regex.flags)});
      const els = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
      for (const el of els) {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        if (!${JSON.stringify(allowDisabled)} && el.disabled) continue;
        const label = [
          el.textContent || "",
          el.getAttribute("aria-label") || "",
          el.getAttribute("title") || "",
          el.dataset?.action || "",
        ].join(" ").replace(/\\s+/g, " ").trim();
        if (re.test(label)) {
          el.click();
          return { clicked: true, label };
        }
      }
      return { clicked: false, label: "" };
    })()`,
    { awaitPromise: false }
  );
}

/**
 * Switch theme via either a theme `<select>` or theme switcher button/radio (`light` | `dark` | `system`).
 */
export async function selectThemeMode(browser, mode) {
  const modeRe = new RegExp(`\\b${mode}\\b`, "i");
  const changed = await browser.evaluate(
    `(() => {
      const target = ${JSON.stringify(mode.toLowerCase())};
      const re = new RegExp(${JSON.stringify(modeRe.source)}, ${JSON.stringify(modeRe.flags)});

      // 1. Check <select> elements related to theme
      for (const sel of document.querySelectorAll("select")) {
        const meta = [sel.id, sel.name, sel.getAttribute("aria-label") || "", sel.title || ""].join(" ").toLowerCase();
        const opts = Array.from(sel.options);
        const isThemeSelect = meta.includes("theme") || opts.some((o) => /^(system|light|dark)$/i.test(o.value.trim()));
        if (!isThemeSelect) continue;
        const match = opts.find((o) => o.value.toLowerCase() === target || re.test(o.textContent || ""));
        if (match) {
          sel.value = match.value;
          sel.dispatchEvent(new Event("input", { bubbles: true }));
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          return { ok: true, via: "select", value: sel.value };
        }
      }

      // 2. Check explicit data-theme-value / data-theme buttons or radios
      for (const el of document.querySelectorAll("button, [role='radio'], [role='button'], input[type='radio']")) {
        const dt = (el.dataset?.themeMode || el.dataset?.themeValue || el.dataset?.theme || el.value || "").toLowerCase();
        const label = [
          el.textContent || "",
          el.getAttribute("aria-label") || "",
          el.getAttribute("title") || "",
        ].join(" ").trim();
        const parentMeta = (el.closest("[data-theme-switcher], .theme-switcher, [aria-label*='theme' i]") ? "theme" : "");
        if (dt === target || (parentMeta && re.test(label)) || new RegExp("theme.*" + target + "|" + target + ".*mode|" + target + ".*theme", "i").test(label)) {
          el.click();
          return { ok: true, via: "button", label: label || dt };
        }
      }

      // 3. Fallback: single toggle button with theme in id/aria-label/title
      const toggle = document.querySelector("#theme-toggle, [data-theme-toggle], button[aria-label*='theme' i], button[title*='theme' i]");
      if (toggle) {
        toggle.click();
        return { ok: true, via: "toggle", label: toggle.textContent?.trim() || toggle.id };
      }
      return { ok: false };
    })()`,
    { awaitPromise: false }
  );
  return changed;
}

/**
 * Switch editor mode between `"dockerfile"` and `"builder"` (Visual Layer Builder) if a mode toggle exists.
 */
export async function setEditorMode(browser, mode) {
  const re = mode === "dockerfile"
    ? /\bdockerfile\b|raw\s+text|text\s+mode/i
    : /\blayer\s*builder\b|\bvisual\b|\blayers\b/i;
  return clickControlByLabel(browser, re);
}

/**
 * Locate and set the Dockerfile editor `<textarea>` value, dispatching `input` and `change`.
 */
export async function setDockerfileText(browser, text) {
  await setEditorMode(browser, "dockerfile");
  const ok = await browser.evaluate(
    `(() => {
      const candidates = Array.from(document.querySelectorAll("textarea"));
      const ta = candidates.find((el) => {
        const meta = [el.id, el.name, el.placeholder, el.getAttribute("aria-label") || "", el.dataset?.role || ""].join(" ").toLowerCase();
        return meta.includes("dockerfile") || meta.includes("stack") || meta.includes("editor");
      }) || candidates[0];
      if (!ta) return false;
      ta.focus();
      ta.value = ${JSON.stringify(text)};
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`,
    { awaitPromise: false }
  );
  if (!ok) {
    throw new Error("Could not find Dockerfile <textarea> in page DOM");
  }
}

/**
 * Read the current Dockerfile text from the Dockerfile `<textarea>`.
 */
export async function getDockerfileText(browser) {
  return browser.evaluate(
    `(() => {
      const candidates = Array.from(document.querySelectorAll("textarea"));
      const ta = candidates.find((el) => {
        const meta = [el.id, el.name, el.placeholder, el.getAttribute("aria-label") || "", el.dataset?.role || ""].join(" ").toLowerCase();
        return meta.includes("dockerfile") || meta.includes("stack") || meta.includes("editor");
      }) || candidates[0];
      return ta ? ta.value : "";
    })()`,
    { awaitPromise: false }
  );
}

/**
 * Read all visible preset buttons/chips in the UI.
 */
export async function getAllPresets(browser) {
  return browser.evaluate(
    `(() => {
      const els = Array.from(document.querySelectorAll(
        "button[data-preset], button[data-preset-id], button[data-example], .preset-chip, .project-preset-chip, .preset-card, [data-preset]"
      ));
      const seen = new Set();
      const out = [];
      for (const el of els) {
        if (seen.has(el)) continue;
        seen.add(el);
        out.push({
          id: el.dataset?.preset || el.dataset?.presetId || el.dataset?.example || el.dataset?.image || "",
          text: (el.textContent || "").replace(/\\s+/g, " ").trim(),
          title: el.getAttribute("title") || "",
          ariaLabel: el.getAttribute("aria-label") || "",
        });
      }
      return out;
    })()`,
    { awaitPromise: false }
  );
}

/**
 * Click a preset whose id or visible text matches `regex`.
 */
export async function clickPresetMatching(browser, regex) {
  return browser.evaluate(
    `(() => {
      const re = new RegExp(${JSON.stringify(regex.source)}, ${JSON.stringify(regex.flags)});
      const els = Array.from(document.querySelectorAll(
        "button[data-preset], button[data-preset-id], button[data-example], .preset-chip, .project-preset-chip, .preset-card, [data-preset]"
      ));
      for (const el of els) {
        const hay = [
          el.dataset?.preset || "",
          el.dataset?.presetId || "",
          el.dataset?.example || "",
          el.dataset?.image || "",
          el.textContent || "",
          el.getAttribute("aria-label") || "",
        ].join(" ");
        if (re.test(hay)) {
          el.click();
          return { clicked: true, text: (el.textContent || "").replace(/\\s+/g, " ").trim() };
        }
      }
      return { clicked: false, text: "" };
    })()`,
    { awaitPromise: false }
  );
}

/**
 * Read stripped terminal output text from the terminal container.
 */
export async function getTerminalOutput(browser) {
  const raw = await browser.evaluate(
    `(() => {
      const el = document.querySelector("#terminal, [data-terminal], .terminal-output, .terminal, .xterm");
      if (!el) return "";
      return el.innerText || el.textContent || "";
    })()`,
    { awaitPromise: false }
  );
  return stripAnsi(raw || "");
}

/**
 * Read sweep results table rows (if present).
 */
export async function getSweepTableRows(browser) {
  return browser.evaluate(
    `(() => {
      const rows = Array.from(document.querySelectorAll(
        "#sweep-panel tbody tr, [data-sweep-results] tbody tr, .sweep-table tbody tr, [data-sweep-row], .sweep-row"
      ));
      return rows.map((tr, index) => ({
        index,
        text: (tr.innerText || tr.textContent || "").replace(/\\s+/g, " ").trim(),
        cells: Array.from(tr.querySelectorAll("td, th")).map((c) => (c.innerText || c.textContent || "").trim()),
      }));
    })()`,
    { awaitPromise: false }
  );
}

/**
 * Click the Nth sweep result row (0-indexed).
 */
export async function clickSweepTableRow(browser, rowIndex) {
  return browser.evaluate(
    `(() => {
      const rows = Array.from(document.querySelectorAll(
        "#sweep-panel tbody tr, [data-sweep-results] tbody tr, .sweep-table tbody tr, [data-sweep-row], .sweep-row"
      ));
      const tr = rows[${Number(rowIndex)}];
      if (!tr) return false;
      tr.click();
      return true;
    })()`,
    { awaitPromise: false }
  );
}

/**
 * Click global "Run All Locally" or "Run All Remotely" control.
 */
export async function clickGlobalRun(browser, target) {
  const re = target === "remote"
    ? /run\s+all\s+remotely|run\s+remotely|all\s+remote/i
    : /run\s+all\s+locally|run\s+locally|all\s+local/i;
  const res = await clickControlByLabel(browser, re);
  if (res.clicked) return res;
  // Fallback: if there is a global target switcher + generic Run button
  const setRes = await clickControlByLabel(browser, target === "remote" ? /\bremote\b/i : /\blocal\b/i);
  if (setRes.clicked) {
    return clickControlByLabel(browser, /^run\b|run\s+stack|execute/i);
  }
  return { clicked: false, label: "" };
}

/**
 * Wait until terminal text satisfies `matcher` (string, RegExp, or predicate).
 */
export async function waitForTerminalMatch(browser, matcher, opts = {}) {
  const { timeoutMs = 120000, intervalMs = 250, label = "terminal match" } = opts;
  let lastText = "";
  await waitFor(
    async () => {
      lastText = await getTerminalOutput(browser);
      if (typeof matcher === "string") return lastText.includes(matcher);
      if (matcher instanceof RegExp) return matcher.test(lastText);
      if (typeof matcher === "function") return Boolean(matcher(lastText));
      return false;
    },
    { timeoutMs, intervalMs, label }
  );
  return lastText;
}

/**
 * Inspect per-layer execution target selectors and download buttons in the layer stack UI.
 */
export async function inspectLayerControls(browser) {
  return browser.evaluate(
    `(() => {
      const layerCards = Array.from(document.querySelectorAll(
        "[data-layer-id], [data-layer-index], .layer-card, .layer-row, .layer-item"
      ));
      const targetControls = Array.from(document.querySelectorAll(
        "select[data-executor], select[data-layer-executor], [data-layer-target], button[data-executor], .layer-executor-select, .layer-executor-toggle"
      ));
      const allSelects = Array.from(document.querySelectorAll("select")).filter((sel) =>
        Array.from(sel.options).some((o) => /local/i.test(o.value + " " + o.textContent)) &&
        Array.from(sel.options).some((o) => /remote/i.test(o.value + " " + o.textContent))
      );
      const downloadButtons = Array.from(document.querySelectorAll("button, a")).filter((el) => {
        const hay = [el.textContent || "", el.getAttribute("aria-label") || "", el.getAttribute("title") || "", el.dataset?.action || ""].join(" ");
        return /download|tar\\.gz|export/i.test(hay);
      });
      return {
        layerCardCount: layerCards.length,
        executorControlCount: Math.max(targetControls.length, allSelects.length),
        downloadButtonCount: downloadButtons.length,
      };
    })()`,
    { awaitPromise: false }
  );
}
