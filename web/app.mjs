/**
 * UI controller for the elf2wasm deterministic Linux container runner.
 * Supports system-default Light/Dark mode, dual-mode Visual Layer Builder <-> Dockerfile Text,
 * generalized Sweep fan-out, per-layer/global Local & Remote Cloudflare Worker execution,
 * downloadable .tar.gz build outputs, interactive VT100 shell fallback, and manual local uploads.
 */

import {
  Elf2WasmDocker,
  runDockerImage,
  runSweep,
  runLayerPipeline,
  parseImageRef,
  base64ToUint8Array,
} from "/js/docker_sdk.mjs";
import { VT100Terminal } from "/web/terminal.mjs";
import {
  DEFAULT_MOUNT_PATH,
  MAX_SWEEP_COUNT,
  createLayer,
  parseDockerfile,
  serializeDockerfile,
  expandSweepValues,
} from "./dockerfile.mjs";
import {
  parseStateFromSearch,
  serializeStateToSearch,
  matchProjectPreset,
  buildRunSearch,
  inferExecutorMode,
} from "./url_state.mjs";

// Immediately expose JS SDK globals on window (before any async work)
window.Elf2WasmDocker = Elf2WasmDocker;
window.runDockerImage = runDockerImage;
window.runSweep = runSweep;
window.runLayerPipeline = runLayerPipeline;

const COMPILER_WASM_URL = "/wasm/elf2wasm_compiler_wasm.wasm";
const RUNTIME_WASM_URL = "/wasm/elf2wasm_runtime_wasm.wasm";
const THEME_STORAGE_KEY = "elf2wasm-theme";
const MAX_CAPTURED_STREAM_CHARS = 256 * 1024;

function resolveRegistryProxyBase() {
  if (
    typeof window !== "undefined" &&
    typeof window.ELF2WASM_PROXY_BASE === "string" &&
    window.ELF2WASM_PROXY_BASE.trim().length > 0
  ) {
    return window.ELF2WASM_PROXY_BASE.trim();
  }
  if (typeof document !== "undefined") {
    const meta = document.querySelector('meta[name="elf2wasm-proxy-base"]');
    const content = meta?.getAttribute("content")?.trim();
    if (content) return content;
  }
  return "/api/v2";
}

function resolveGitProxyBase() {
  if (
    typeof window !== "undefined" &&
    typeof window.ELF2WASM_GIT_PROXY_BASE === "string" &&
    window.ELF2WASM_GIT_PROXY_BASE.trim().length > 0
  ) {
    return window.ELF2WASM_GIT_PROXY_BASE.trim();
  }
  if (typeof document !== "undefined") {
    const meta = document.querySelector('meta[name="elf2wasm-git-proxy-base"]');
    const content = meta?.getAttribute("content")?.trim();
    if (content) return content;
  }
  return "/api/git/archive";
}

function resolveApiBase() {
  if (
    typeof window !== "undefined" &&
    typeof window.ELF2WASM_API_BASE === "string" &&
    window.ELF2WASM_API_BASE.trim().length > 0
  ) {
    return window.ELF2WASM_API_BASE.trim();
  }
  if (typeof document !== "undefined") {
    const meta = document.querySelector('meta[name="elf2wasm-api-base"]');
    const content = meta?.getAttribute("content")?.trim();
    if (content) return content;
  }
  return "";
}

// Empirically verified well-known project presets (zero outbound guest internet required)
const PROJECT_PRESETS = Object.freeze({
  "js-express": Object.freeze({
    id: "js-express",
    label: "Express.js",
    language: "JavaScript",
    dockerfile: [
      "FROM mirror.gcr.io/library/mongo-express:1.0.2-20-alpine3.19",
      "WORKDIR /app",
      `RUN node -e 'const express = require("express"), http = require("http"); const app = express(); app.get("/api/hello", (req, res) => res.json({ framework: "Express.js", version: require("express/package.json").version, ok: true })); const s = app.listen(0, "127.0.0.1", () => { http.get("http://127.0.0.1:" + s.address().port + "/api/hello", (r) => { let b = ""; r.on("data", (c) => b += c); r.on("end", () => { console.log("HTTP " + r.statusCode + " " + b); s.close(); }); }); });'`,
    ].join("\n"),
  }),
  "python-flask": Object.freeze({
    id: "python-flask",
    label: "Flask",
    language: "Python",
    dockerfile: [
      "FROM quay.io/computesphere/computesphere-python-flask-example:latest",
      "ENV PYTHONUNBUFFERED=1",
      `RUN python3 -c 'import importlib.metadata, flask; app = flask.Flask(__name__); app.add_url_rule("/api/hello", "hello", lambda: {"framework": "Flask", "version": importlib.metadata.version("flask"), "ok": True}); r = app.test_client().get("/api/hello"); assert r.status_code == 200; print("HTTP", r.status_code, r.get_json())'`,
    ].join("\n"),
  }),
  "go-raft-nodice": Object.freeze({
    id: "go-raft-nodice",
    label: "Go Raft (nodice)",
    language: "Go",
    dockerfile: [
      "FROM ghcr.io/fatlotus/golang-with-cache:1.27-alpine",
      "# elf2wasm:git repo=fatlotus/nodice mount=/workspace",
      "WORKDIR /workspace/example",
      "RUN go build",
      "RUN ./raft",
    ].join("\n"),
  }),
  "alpine-sweep": Object.freeze({
    id: "alpine-sweep",
    label: "Alpine Env Sweep",
    language: "Shell",
    dockerfile: [
      "FROM mirror.gcr.io/library/alpine:latest",
      "# elf2wasm:sweep param=env envKey=GREETING mode=list values=hello,bonjour,hola",
      'RUN echo "$GREETING from elf2wasm!"',
    ].join("\n"),
  }),
});

// ---------------------------------------------------------------------------
// DOM References
// ---------------------------------------------------------------------------

const themeButtons = Array.from(document.querySelectorAll("[data-theme-choice]"));
const runAllLocalBtn = document.getElementById("run-all-local-btn");
const runAllRemoteBtn = document.getElementById("run-all-remote-btn");
const startBtn = document.getElementById("start-btn");
const stopBtn = document.getElementById("stop-btn");
const clearBtn = document.getElementById("clear-btn");

const statusPill = document.getElementById("status-pill");
const statusText = document.getElementById("status-text");
const executorModeBadge = document.getElementById("executor-mode-badge");

const presetCards = Array.from(document.querySelectorAll(".preset-card"));

const tabVisualBtn = document.getElementById("tab-visual");
const tabDockerfileBtn = document.getElementById("tab-dockerfile");
const panelVisual = document.getElementById("panel-visual");
const panelDockerfile = document.getElementById("panel-dockerfile");
const layerListEl = document.getElementById("layer-list");
const layerCountBadge = document.getElementById("layer-count-badge");
const copyPipelineLinkBtn = document.getElementById("copy-pipeline-link-btn");
const addLayerButtons = Array.from(document.querySelectorAll("[data-add-layer]"));
const dockerfileEditor = document.getElementById("dockerfile-editor");
const dockerfileWarningsEl = document.getElementById("dockerfile-warnings");

const progressBar = document.getElementById("progress-bar");
const progressFill = document.getElementById("progress-fill");
const stageStepEls = {
  pull: document.querySelector('.stage-step[data-step="pull"]'),
  unpack: document.querySelector('.stage-step[data-step="unpack"]'),
  compile: document.querySelector('.stage-step[data-step="compile"]'),
  run: document.querySelector('.stage-step[data-step="run"]'),
};

const sweepPanel = document.getElementById("sweep-panel");
const sweepOutcomeBadge = document.getElementById("sweep-outcome-badge");
const sweepParamSummary = document.getElementById("sweep-param-summary");
const sweepProgressText = document.getElementById("sweep-progress-text");
const copySweepLinkBtn = document.getElementById("copy-sweep-link-btn");
const sweepVariedColHeader = document.getElementById("sweep-varied-col-header");
const sweepResultsBody = document.getElementById("sweep-results-body");

const terminalEl = document.getElementById("terminal");
const terminalContextBadge = document.getElementById("terminal-context-badge");
const terminalTitleEl = document.getElementById("terminal-title");
const terminalSizeEl = document.getElementById("terminal-size");

// Manual upload drawer DOM elements
const manualFileInput = document.getElementById("manual-file-input");
const manualUploadPath = document.getElementById("manual-upload-path");
const manualCmdInput = document.getElementById("manual-cmd-input");
const manualRunBtn = document.getElementById("manual-run-btn");
const manualClearBtn = document.getElementById("manual-clear-btn");
const manualVfsSummary = document.getElementById("manual-vfs-summary");
const manualVfsList = document.getElementById("manual-vfs-list");

// ---------------------------------------------------------------------------
// Application State
// ---------------------------------------------------------------------------

let layerIdSeq = 1;
function nextLayerId() {
  return `layer-${++layerIdSeq}`;
}

let layers = [createLayer("from", { id: "layer-1", image: "alpine:latest", executor: "local" })];
let dockerfileText = "FROM alpine:latest";
let dockerfileWarnings = [];
let activePresetId = null;
let currentThemePref = "system"; // "system" | "light" | "dark"
let selectedSweepRun = null; // 1-based variation index or null
let baseDelayStddevMs = 0;
let baseDelaySeed = 0;
let isSyncing = false;

// Runtime state
let dockerPromise = null;
let activeContainer = null;
let activeAbortController = null;
let containerExited = true;
let sessionSeq = 0;

// Layer execution result cache (keyed by 0-based layer index)
let layerResultsByIndex = new Map();
let layerStatusByIndex = new Map(); // "idle" | "running" | "pass" | "fail"

// Sweep execution state
let sweepRunRecords = new Map(); // variationIndex (1-based) -> VariationResult
let sweepRowEls = new Map(); // variationIndex (1-based) -> HTMLTableRowElement
let sweepRunBaseLayers = null;
let sweepActiveLayer = null;
let userPinnedRun = false;
let activeSweepRunIndex = null;

// Manual upload state
let stagedTarball = null;
const manualVfs = {
  files: new Map(),
  symlinks: new Map(),
};
let manualUploadQueue = Promise.resolve();
let manualWasmCache = null;

// ---------------------------------------------------------------------------
// Terminal Setup
// ---------------------------------------------------------------------------

const terminal = new VT100Terminal(terminalEl, {
  onData(data) {
    if (!activeContainer || containerExited) return;
    try {
      activeContainer.writeStdin(data);
    } catch {
      // Ignore write after stop/exit
    }
  },
  onSignal(sig) {
    if (!activeContainer || containerExited) return;
    try {
      activeContainer.sendSignal(sig);
    } catch {
      // Ignore signal after stop/exit
    }
  },
  onResize(cols, rows) {
    updateTerminalSizeLabel(cols, rows);
    if (!activeContainer || containerExited) return;
    try {
      activeContainer.resize(cols, rows);
    } catch {
      // Ignore resize after stop/exit
    }
  },
});

function updateTerminalSizeLabel(cols, rows) {
  if (terminalSizeEl) {
    terminalSizeEl.textContent = `${cols}×${rows}`;
  }
}

{
  const initialSize = terminal.getSize();
  updateTerminalSizeLabel(initialSize.cols, initialSize.rows);
}

// ---------------------------------------------------------------------------
// System-Default Light / Dark Theme Management (F11)
// ---------------------------------------------------------------------------

const colorSchemeMql =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

function resolveEffectiveTheme(pref) {
  if (pref === "light" || pref === "dark") return pref;
  return colorSchemeMql?.matches ? "dark" : "light";
}

function readStoredThemePref() {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "light" || saved === "dark" || saved === "system") {
      return saved;
    }
  } catch {
    // Ignore storage errors in private browsing
  }
  return "system";
}

function applyTheme(pref, { persist = false, syncUrl = false } = {}) {
  currentThemePref = pref === "light" || pref === "dark" ? pref : "system";
  const effective = resolveEffectiveTheme(currentThemePref);

  if (currentThemePref === "system") {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = currentThemePref;
  }
  document.documentElement.dataset.themePreference = currentThemePref;
  document.documentElement.dataset.resolvedTheme = effective;

  for (const btn of themeButtons) {
    const active = btn.dataset.themeChoice === currentThemePref;
    btn.setAttribute("aria-checked", active ? "true" : "false");
    btn.dataset.active = active ? "true" : "false";
  }

  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, currentThemePref);
    } catch {
      // Ignore storage errors
    }
  }
  if (syncUrl) {
    syncUrlFromState({ push: false });
  }
}

for (const btn of themeButtons) {
  btn.addEventListener("click", () => {
    const choice = btn.dataset.themeChoice || "system";
    applyTheme(choice, { persist: true, syncUrl: true });
  });
}

const handleSystemThemeChange = () => {
  if (currentThemePref === "system") {
    applyTheme("system", { persist: false, syncUrl: false });
  }
};

if (colorSchemeMql) {
  if (typeof colorSchemeMql.addEventListener === "function") {
    colorSchemeMql.addEventListener("change", handleSystemThemeChange);
  } else if (typeof colorSchemeMql.addListener === "function") {
    colorSchemeMql.addListener(handleSystemThemeChange);
  }
}

// ---------------------------------------------------------------------------
// Formatting & Download Helpers
// ---------------------------------------------------------------------------

function formatBytes(n) {
  const num = Number(n);
  if (!Number.isFinite(num) || num <= 0) return "0 B";
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KiB`;
  return `${(num / (1024 * 1024)).toFixed(2)} MiB`;
}

function formatVirtualTime(ns) {
  const n = Number(ns);
  if (!Number.isFinite(n) || n <= 0) return "0 ms";
  if (n < 1_000_000) return `${Math.round(n / 1000)} µs`;
  if (n < 1_000_000_000) return `${(n / 1e6).toFixed(1)} ms`;
  return `${(n / 1e9).toFixed(2)} s`;
}

function capCapturedText(text) {
  const s = typeof text === "string" ? text : "";
  if (s.length <= MAX_CAPTURED_STREAM_CHARS) return s;
  return `${s.slice(0, MAX_CAPTURED_STREAM_CHARS)}\n... [truncated]`;
}

function extractTarGzBytes(layerResult) {
  if (!layerResult) return null;
  if (layerResult instanceof Uint8Array) {
    return layerResult.byteLength > 0 ? layerResult : null;
  }
  if (layerResult.outputDiffTarGz instanceof Uint8Array && layerResult.outputDiffTarGz.byteLength > 0) {
    return layerResult.outputDiffTarGz;
  }
  if (typeof layerResult.outputDiffTarGzBase64 === "string" && layerResult.outputDiffTarGzBase64.length > 0) {
    try {
      const decoded = base64ToUint8Array(layerResult.outputDiffTarGzBase64);
      return decoded.byteLength > 0 ? decoded : null;
    } catch {
      return null;
    }
  }
  return null;
}

function downloadLayerOutputsTarGz(layerResult, filename) {
  const bytes = extractTarGzBytes(layerResult);
  if (!bytes || bytes.byteLength === 0) return;

  const blob = new Blob([bytes], { type: "application/gzip" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function formatModifiedFilesTooltip(modifiedFiles) {
  if (!Array.isArray(modifiedFiles) || modifiedFiles.length === 0) return "";
  const lines = modifiedFiles.slice(0, 20).map((f) => {
    const tag = f.kind === "deleted" ? "D" : f.kind === "dir" ? "d" : "F";
    return `${tag} ${f.path} (${formatBytes(f.size)})`;
  });
  if (modifiedFiles.length > 20) {
    lines.push(`... +${modifiedFiles.length - 20} more`);
  }
  return lines.join("\n");
}

function splitShellArgs(str) {
  const args = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let hasToken = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else current += ch;
      hasToken = true;
    } else if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else if (ch === "\\" && i + 1 < str.length) {
        const next = str[i + 1];
        if (next === '"' || next === "\\" || next === "$" || next === "`") {
          i++;
          current += next;
        } else {
          current += ch;
        }
      } else {
        current += ch;
      }
      hasToken = true;
    } else if (ch === "'") {
      inSingle = true;
      hasToken = true;
    } else if (ch === '"') {
      inDouble = true;
      hasToken = true;
    } else if (ch === "\\" && i + 1 < str.length) {
      i++;
      current += str[i];
      hasToken = true;
    } else if (/\s/.test(ch)) {
      if (hasToken) {
        args.push(current);
        current = "";
        hasToken = false;
      }
    } else {
      current += ch;
      hasToken = true;
    }
  }
  if (hasToken) args.push(current);
  return args;
}

// ---------------------------------------------------------------------------
// Progress & Status Helpers
// ---------------------------------------------------------------------------

function setStatus(message, state = "idle") {
  if (statusText) statusText.textContent = message;
  if (statusPill) statusPill.dataset.state = state;
  if (progressBar) progressBar.dataset.state = state;
  if (terminalContextBadge) {
    terminalContextBadge.textContent =
      state === "busy" ? "Running" : state === "running" ? "Live Shell" : state === "error" ? "Error" : "Ready";
  }
}

function setProgress(percent, stage = "idle") {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  if (progressBar) {
    progressBar.setAttribute("aria-valuenow", String(clamped));
    progressBar.dataset.stage = stage;
  }
  if (progressFill) {
    progressFill.style.width = `${clamped}%`;
  }
  updateStageSteps(stage);
}

function updateStageSteps(stage) {
  const order = ["pull", "unpack", "compile", "run"];
  let activeIdx = -1;
  if (stage === "manifest" || stage === "config" || stage === "download" || stage === "decompress") {
    activeIdx = 0;
  } else if (
    stage === "ready" ||
    stage === "extract" ||
    stage === "git-download" ||
    stage === "git-decompress" ||
    stage === "git-overlay"
  ) {
    activeIdx = 1;
  } else if (stage === "compile" || stage === "build") {
    activeIdx = 2;
  } else if (stage === "run" || stage === "sweep") {
    activeIdx = 3;
  }

  for (let i = 0; i < order.length; i++) {
    const el = stageStepEls[order[i]];
    if (!el) continue;
    if (activeIdx === -1) {
      el.dataset.active = "false";
      el.dataset.done = "false";
    } else if (stage === "run") {
      el.dataset.active = i === 3 ? "true" : "false";
      el.dataset.done = "true";
    } else {
      el.dataset.active = i === activeIdx ? "true" : "false";
      el.dataset.done = i < activeIdx ? "true" : "false";
    }
  }
}

function handleProgressEvent(ev) {
  if (!ev || typeof ev !== "object") return;
  const stage = ev.stage || "idle";
  const layerIdx = Number.isFinite(ev.layerIndex) ? ev.layerIndex : 0;
  const layerCount = Number.isFinite(ev.layerCount) && ev.layerCount > 0 ? ev.layerCount : 1;
  const loaded = Number.isFinite(ev.loaded) ? ev.loaded : 0;
  const total = Number.isFinite(ev.total) ? ev.total : 0;

  switch (stage) {
    case "manifest":
      setProgress(8, "manifest");
      setStatus(ev.message || "Fetching manifest...", "busy");
      break;
    case "config":
      setProgress(14, "config");
      setStatus(ev.message || "Fetching image config...", "busy");
      break;
    case "download": {
      const frac = total > 0 ? Math.min(1, loaded / total) : 0.25;
      const overall = (layerIdx + frac) / layerCount;
      const pct = 15 + overall * 40;
      const sizeNote =
        total > 0 ? ` (${formatBytes(loaded)} / ${formatBytes(total)})` : loaded > 0 ? ` (${formatBytes(loaded)})` : "";
      setProgress(pct, "download");
      setStatus(`Downloading layer ${layerIdx + 1}/${layerCount}${sizeNote}...`, "busy");
      break;
    }
    case "decompress": {
      const overall = (layerIdx + 0.5) / layerCount;
      const pct = 55 + overall * 13;
      setProgress(pct, "decompress");
      setStatus(`Decompressing layer ${layerIdx + 1}/${layerCount}...`, "busy");
      break;
    }
    case "ready":
      setProgress(70, "ready");
      setStatus("Unpacking rootfs...", "busy");
      break;
    case "extract": {
      const overall = (layerIdx + 0.5) / layerCount;
      const pct = 70 + overall * 12;
      setProgress(pct, "extract");
      setStatus(`Unpacking rootfs layer ${layerIdx + 1}/${layerCount}...`, "busy");
      break;
    }
    case "git-download": {
      const frac = total > 0 ? Math.min(1, loaded / total) : loaded > 0 ? 0.5 : 0;
      const pct = 82 + frac * 4;
      const sizeNote =
        total > 0 ? ` (${formatBytes(loaded)} / ${formatBytes(total)})` : loaded > 0 ? ` (${formatBytes(loaded)})` : "";
      const baseMsg = (ev.message || "Downloading git repository").replace(/\.+$/, "");
      setProgress(pct, "git-download");
      setStatus(`${baseMsg}${sizeNote}...`, "busy");
      break;
    }
    case "git-decompress":
      setProgress(87, "git-decompress");
      setStatus(ev.message || "Decompressing git repository...", "busy");
      break;
    case "git-overlay": {
      const pct = total > 0 && loaded >= total ? 89 : 88;
      setProgress(pct, "git-overlay");
      setStatus(ev.message || "Overlaying git repository...", "busy");
      break;
    }
    case "compile":
      setProgress(90, "compile");
      setStatus("Compiling ELF → WASM...", "busy");
      break;
    case "build":
      setProgress(91, "build");
      setStatus(ev.message || "Building...", "busy");
      break;
    case "sweep": {
      const frac = total > 0 ? Math.min(1, loaded / total) : 0;
      const pct = 92 + frac * 7;
      setProgress(pct, "sweep");
      setStatus(ev.message || "Running sweep...", "busy");
      break;
    }
    case "run":
      setProgress(100, "run");
      setStatus("Running — Interactive shell ready", "running");
      break;
    default:
      if (ev.message) setStatus(ev.message, "busy");
      break;
  }
}

// ---------------------------------------------------------------------------
// Persistent Worker-Backed Docker Engine (Local / Mixed Only)
// ---------------------------------------------------------------------------

async function getDocker() {
  if (dockerPromise) {
    try {
      const existing = await dockerPromise;
      if (existing && existing.isAlive) {
        return existing;
      }
    } catch {
      // Recreate below
    }
    dockerPromise = null;
  }
  const pending = Elf2WasmDocker.create({
    compilerWasmUrl: COMPILER_WASM_URL,
    runtimeWasmUrl: RUNTIME_WASM_URL,
    registryProxyBase: resolveRegistryProxyBase(),
    gitProxyBase: resolveGitProxyBase(),
    useWorker: typeof Worker !== "undefined",
  })
    .then((docker) => {
      if (typeof docker.onCrash === "function") {
        docker.onCrash(() => {
          if (dockerPromise === pending) dockerPromise = null;
        });
      }
      return docker;
    })
    .catch((err) => {
      if (dockerPromise === pending) dockerPromise = null;
      throw err;
    });
  dockerPromise = pending;
  return await pending;
}

// ---------------------------------------------------------------------------
// Pipeline Metadata, Bidirectional Sync & URL State (F12, F13, F14)
// ---------------------------------------------------------------------------

function hasLocalRunLayer(layerList, executorOverride = null) {
  return layerList.some(
    (l) =>
      l &&
      l.type === "run" &&
      (executorOverride === "local" || executorOverride === "remote"
        ? executorOverride === "local"
        : l.executor !== "remote")
  );
}

function getPrimaryImageName(layerList) {
  const fromLayer = layerList.find((l) => l && l.type === "from" && l.image);
  return fromLayer ? fromLayer.image : "alpine:latest";
}

function getSweepLayer(layerList) {
  return layerList.find((l) => l && l.type === "sweep") || null;
}

function formatSweepParamLabel(sweepLayer) {
  if (!sweepLayer) return "Value";
  if (sweepLayer.param === "delay") return "Delay (ms)";
  if (sweepLayer.param === "seed") return "Seed";
  if (sweepLayer.param === "env") return `ENV: ${sweepLayer.envKey || "?"}`;
  return "Value";
}

function formatSweepVariationCell(sweepLayer, variation) {
  if (!variation) return "—";
  if (sweepLayer?.param === "delay") {
    return String(variation.delayStddevMs ?? variation.value ?? "—");
  }
  if (sweepLayer?.param === "seed") {
    return String(variation.delaySeed ?? variation.value ?? "—");
  }
  if (sweepLayer?.param === "env") {
    return String(variation.envOverride?.[1] ?? variation.value ?? "");
  }
  return String(variation.label ?? variation.value ?? "—");
}

function formatSweepHintText(sweepLayer) {
  const expanded = expandSweepValues(sweepLayer);
  const count = expanded.length;
  const label = formatSweepParamLabel(sweepLayer);
  if (count === 0) {
    return `0 variations configured for ${label}. Specify values or a valid count to fan out downstream layers.`;
  }
  const preview = expanded
    .slice(0, 6)
    .map((v) => formatSweepVariationCell(sweepLayer, v))
    .join(", ");
  const suffix = count > 6 ? `, … (+${count - 6} more)` : "";
  return `${count} variation${count === 1 ? "" : "s"} (${label}: ${preview}${suffix}) — all layers below run once per variation.`;
}

function updateGlobalControlsUi() {
  const execMode = inferExecutorMode(layers);
  if (runAllLocalBtn) {
    runAllLocalBtn.setAttribute("aria-pressed", execMode === "local" ? "true" : "false");
  }
  if (runAllRemoteBtn) {
    runAllRemoteBtn.setAttribute("aria-pressed", execMode === "remote" ? "true" : "false");
  }
  if (executorModeBadge) {
    executorModeBadge.dataset.mode = execMode;
    executorModeBadge.textContent =
      execMode === "remote"
        ? "Remote (Cloudflare Worker)"
        : execMode === "mixed"
        ? "Mixed (Local + Remote)"
        : "Local (Browser WASM)";
  }

  const sweepLayer = getSweepLayer(layers);
  const hasRun = layers.some((l) => l && l.type === "run");
  if (startBtn) {
    if (sweepLayer) {
      startBtn.textContent = "Run Sweep";
    } else if (hasRun) {
      startBtn.textContent = "Run";
    } else {
      startBtn.textContent = "Start Shell";
    }
  }

  if (layerCountBadge) {
    layerCountBadge.textContent = `${layers.length} layer${layers.length === 1 ? "" : "s"}`;
  }

  for (const card of presetCards) {
    card.dataset.active = activePresetId && card.dataset.preset === activePresetId ? "true" : "false";
  }

  if (dockerfileWarningsEl) {
    if (dockerfileWarnings.length > 0) {
      dockerfileWarningsEl.hidden = false;
      dockerfileWarningsEl.textContent = dockerfileWarnings.map((w) => `Warning: ${w}`).join("\n");
    } else {
      dockerfileWarningsEl.hidden = true;
      dockerfileWarningsEl.textContent = "";
    }
  }

  // Update idle status & terminal title when not actively running
  if (!activeContainer && !activeAbortController && containerExited) {
    const img = getPrimaryImageName(layers);
    if (statusText && statusPill?.dataset.state === "idle") {
      if (sweepLayer) {
        const count = expandSweepValues(sweepLayer).length;
        statusText.textContent = `Idle — click Run Sweep to run ${count} variation${count === 1 ? "" : "s"} on ${img}`;
      } else if (hasRun) {
        const runCount = layers.filter((l) => l.type === "run").length;
        statusText.textContent = `Idle — click Run to execute ${runCount} RUN layer${runCount === 1 ? "" : "s"} on ${img}`;
      } else {
        statusText.textContent = `Idle — click Start Shell to boot ${img}`;
      }
    }
    if (terminalTitleEl) {
      const gitLayer = layers.find((l) => l.type === "git" && l.repo);
      const repoSuffix = gitLayer ? ` + ${gitLayer.repo}@${gitLayer.ref || "HEAD"}` : "";
      const runLayers = layers.filter((l) => l.type === "run" && l.cmd);
      const summary = sweepLayer
        ? `Sweep (${formatSweepParamLabel(sweepLayer)})`
        : runLayers.length > 0
        ? runLayers.map((l) => l.cmd).join(" && ")
        : "/bin/sh";
      terminalTitleEl.textContent = `${img}${repoSuffix} — ${summary}`;
    }
  }
}

function syncUrlFromState({ push = false } = {}) {
  const nextSearch = serializeStateToSearch(
    {
      layers,
      executorMode: inferExecutorMode(layers),
      theme: currentThemePref,
      selectedSweepRun,
      stddev: baseDelayStddevMs,
      seed: baseDelaySeed,
    },
    { existingSearch: window.location.search }
  );
  if (nextSearch === window.location.search) return;
  const nextUrl = `${window.location.pathname}${nextSearch}${window.location.hash}`;
  try {
    if (push) {
      window.history.pushState(null, "", nextUrl);
    } else {
      window.history.replaceState(null, "", nextUrl);
    }
  } catch {
    // Ignore History API errors
  }
}

function syncFromVisual({ pushUrl = false, rerenderVisual = false, preserveWarnings = false } = {}) {
  if (isSyncing) return;
  isSyncing = true;
  try {
    const keepWarnings = preserveWarnings && dockerfileWarnings.length > 0;
    const hasFromLayer = layers.some((l) => l && l.type === "from");
    if (!keepWarnings || hasFromLayer) {
      dockerfileText = serializeDockerfile(layers);
      if (!keepWarnings) {
        dockerfileWarnings = [];
      }
      if (dockerfileEditor) {
        dockerfileEditor.value = dockerfileText;
      }
    }
    if (rerenderVisual) {
      renderLayerList();
    }
    activePresetId = matchProjectPreset({ layers, dockerfile: dockerfileText }, PROJECT_PRESETS);
    updateGlobalControlsUi();
    syncUrlFromState({ push: pushUrl });
  } finally {
    isSyncing = false;
  }
}

function syncFromDockerfileText(rawText, { pushUrl = false } = {}) {
  if (isSyncing) return;
  isSyncing = true;
  try {
    dockerfileText = rawText;
    const { layers: parsed, warnings } = parseDockerfile(rawText);
    layers = parsed;
    dockerfileWarnings = warnings;
    layerResultsByIndex.clear();
    layerStatusByIndex.clear();
    renderLayerList();
    activePresetId = matchProjectPreset({ layers, dockerfile: dockerfileText }, PROJECT_PRESETS);
    updateGlobalControlsUi();
    syncUrlFromState({ push: pushUrl });
  } finally {
    isSyncing = false;
  }
}

// ---------------------------------------------------------------------------
// Visual Layer Builder Renderer (F12 & F13 — zero innerHTML)
// ---------------------------------------------------------------------------

function makeField(labelText, inputEl) {
  const wrap = document.createElement("div");
  wrap.className = "field";
  const label = document.createElement("label");
  label.textContent = labelText;
  if (inputEl.id) {
    label.setAttribute("for", inputEl.id);
  }
  wrap.append(label, inputEl);
  return wrap;
}

function makeTextInput({ value = "", placeholder = "", field = "", id = "" }) {
  const input = document.createElement("input");
  input.type = "text";
  input.value = value;
  input.placeholder = placeholder;
  input.autocomplete = "off";
  input.spellcheck = false;
  if (field) input.dataset.field = field;
  if (id) input.id = id;
  return input;
}

function makeNumberInput({ value = 0, min = 0, max = null, step = "any", field = "", id = "" }) {
  const input = document.createElement("input");
  input.type = "number";
  input.value = String(value ?? 0);
  if (min !== null) input.min = String(min);
  if (max !== null) input.max = String(max);
  input.step = String(step);
  if (field) input.dataset.field = field;
  if (id) input.id = id;
  return input;
}

function updateLayerCardStatusUi(layerIndex) {
  const card = layerListEl?.querySelector(`.layer-card[data-layer-index="${layerIndex}"]`);
  if (!card) return;

  const status = layerStatusByIndex.get(layerIndex) || "idle";
  const res = layerResultsByIndex.get(layerIndex) || null;
  card.dataset.layerStatus = status;

  const pill = card.querySelector(".layer-status-pill");
  if (pill) {
    pill.dataset.status = status;
    if (status === "running") {
      pill.hidden = false;
      pill.textContent = "Running…";
    } else if (res) {
      pill.hidden = false;
      const timeStr = formatVirtualTime(res.virtualTimeNs);
      if (res.type === "run") {
        pill.textContent = res.ok
          ? `Exit ${res.exitCode} · ${timeStr}`
          : res.errorCode
          ? `Error (${res.errorCode})`
          : `Exit ${res.exitCode}`;
      } else {
        pill.textContent = res.ok ? "Done" : "Failed";
      }
    } else if (status === "pass") {
      pill.hidden = false;
      pill.textContent = "Done";
    } else if (status === "fail") {
      pill.hidden = false;
      pill.textContent = "Failed";
    } else {
      pill.hidden = true;
      pill.textContent = "";
    }
  }

  const filesBadge = card.querySelector(".layer-files-badge");
  const downloadBtn = card.querySelector(".layer-download-btn");
  const tarBytes = extractTarGzBytes(res);
  const modFiles = Array.isArray(res?.modifiedFiles) ? res.modifiedFiles : [];

  if (filesBadge) {
    if (modFiles.length > 0) {
      filesBadge.hidden = false;
      filesBadge.textContent = `${modFiles.length} file${modFiles.length === 1 ? "" : "s"}`;
      filesBadge.title = formatModifiedFilesTooltip(modFiles);
    } else {
      filesBadge.hidden = true;
      filesBadge.textContent = "";
      filesBadge.title = "";
    }
  }

  if (downloadBtn) {
    if (tarBytes && tarBytes.byteLength > 0) {
      downloadBtn.hidden = false;
      downloadBtn.textContent = `Download .tar.gz (${formatBytes(tarBytes.byteLength)})`;
      downloadBtn.title = modFiles.length > 0 ? formatModifiedFilesTooltip(modFiles) : "Download layer output archive";
    } else {
      downloadBtn.hidden = true;
    }
  }
}

function renderLayerList() {
  if (!layerListEl) return;
  layerListEl.textContent = "";

  if (layers.length === 0) {
    const empty = document.createElement("div");
    empty.className = "layer-empty";
    empty.textContent = "No layers yet. Click + FROM below or switch to the Dockerfile tab to paste a Dockerfile.";
    layerListEl.appendChild(empty);
    return;
  }

  layers.forEach((layer, idx) => {
    const card = document.createElement("div");
    card.className = "layer-card";
    card.dataset.layerId = layer.id || `layer-${idx + 1}`;
    card.dataset.layerIndex = String(idx);
    card.dataset.layerType = layer.type;
    card.dataset.layerStatus = layerStatusByIndex.get(idx) || "idle";

    // Card header
    const header = document.createElement("div");
    header.className = "layer-card-header";

    const left = document.createElement("div");
    left.className = "layer-card-header-left";

    const indexEl = document.createElement("span");
    indexEl.className = "layer-index";
    indexEl.textContent = `#${idx + 1}`;

    const badge = document.createElement("span");
    badge.className = "layer-type-badge";
    badge.dataset.type = layer.type;
    badge.textContent = layer.type.toUpperCase();

    left.append(indexEl, badge);

    // Per-layer Local/Remote toggle for runnable layers (from, git, run)
    if (layer.type === "from" || layer.type === "git" || layer.type === "run") {
      const toggle = document.createElement("div");
      toggle.className = "segmented-control layer-executor-toggle";
      toggle.setAttribute("role", "group");
      toggle.setAttribute("aria-label", `Layer ${idx + 1} execution target`);

      const currentExec = layer.executor === "remote" ? "remote" : "local";
      toggle.dataset.layerTarget = currentExec;

      const localBtn = document.createElement("button");
      localBtn.type = "button";
      localBtn.className = "seg-btn seg-btn-xs";
      localBtn.dataset.layerExecutor = "local";
      localBtn.setAttribute("aria-pressed", currentExec === "local" ? "true" : "false");
      localBtn.textContent = "Local";

      const remoteBtn = document.createElement("button");
      remoteBtn.type = "button";
      remoteBtn.className = "seg-btn seg-btn-xs";
      remoteBtn.dataset.layerExecutor = "remote";
      remoteBtn.setAttribute("aria-pressed", currentExec === "remote" ? "true" : "false");
      remoteBtn.textContent = "Remote";

      const setExec = (target) => {
        layer.executor = target;
        toggle.dataset.layerTarget = target;
        localBtn.setAttribute("aria-pressed", target === "local" ? "true" : "false");
        remoteBtn.setAttribute("aria-pressed", target === "remote" ? "true" : "false");
        syncFromVisual({ pushUrl: false, rerenderVisual: false });
      };

      localBtn.addEventListener("click", () => setExec("local"));
      remoteBtn.addEventListener("click", () => setExec("remote"));

      toggle.append(localBtn, remoteBtn);
      left.appendChild(toggle);
    }

    const right = document.createElement("div");
    right.className = "layer-card-header-right";

    const statusPillEl = document.createElement("span");
    statusPillEl.className = "layer-status-pill";
    statusPillEl.dataset.status = "idle";
    statusPillEl.hidden = true;

    const filesBadge = document.createElement("span");
    filesBadge.className = "layer-files-badge";
    filesBadge.hidden = true;

    const downloadBtn = document.createElement("button");
    downloadBtn.type = "button";
    downloadBtn.className = "btn btn-secondary btn-xs layer-download-btn";
    downloadBtn.hidden = true;
    downloadBtn.textContent = "Download .tar.gz";
    downloadBtn.addEventListener("click", () => {
      const res = layerResultsByIndex.get(idx);
      if (res) {
        downloadLayerOutputsTarGz(res, `layer-${idx + 1}-outputs.tar.gz`);
      }
    });

    const actions = document.createElement("div");
    actions.className = "layer-card-actions";

    const upBtn = document.createElement("button");
    upBtn.type = "button";
    upBtn.className = "btn btn-secondary btn-icon";
    upBtn.dataset.layerAction = "up";
    upBtn.setAttribute("aria-label", "Move layer up");
    upBtn.title = "Move up";
    upBtn.textContent = "↑";
    upBtn.disabled = idx === 0;
    upBtn.addEventListener("click", () => {
      if (idx <= 0) return;
      [layers[idx - 1], layers[idx]] = [layers[idx], layers[idx - 1]];
      layerResultsByIndex.clear();
      layerStatusByIndex.clear();
      syncFromVisual({ pushUrl: false, rerenderVisual: true });
    });

    const downBtn = document.createElement("button");
    downBtn.type = "button";
    downBtn.className = "btn btn-secondary btn-icon";
    downBtn.dataset.layerAction = "down";
    downBtn.setAttribute("aria-label", "Move layer down");
    downBtn.title = "Move down";
    downBtn.textContent = "↓";
    downBtn.disabled = idx === layers.length - 1;
    downBtn.addEventListener("click", () => {
      if (idx >= layers.length - 1) return;
      [layers[idx], layers[idx + 1]] = [layers[idx + 1], layers[idx]];
      layerResultsByIndex.clear();
      layerStatusByIndex.clear();
      syncFromVisual({ pushUrl: false, rerenderVisual: true });
    });

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn btn-secondary btn-icon btn-delete";
    delBtn.dataset.layerAction = "delete";
    delBtn.setAttribute("aria-label", "Delete layer");
    delBtn.title = "Delete layer";
    delBtn.textContent = "×";
    delBtn.addEventListener("click", () => {
      layers.splice(idx, 1);
      layerResultsByIndex.clear();
      layerStatusByIndex.clear();
      syncFromVisual({ pushUrl: false, rerenderVisual: true });
    });

    actions.append(upBtn, downBtn, delBtn);
    right.append(statusPillEl, filesBadge, downloadBtn, actions);
    header.append(left, right);

    // Card body
    const body = document.createElement("div");
    body.className = "layer-card-body";

    const idPrefix = `layer-${idx}`;

    if (layer.type === "from") {
      const imgInput = makeTextInput({
        value: layer.image || "",
        placeholder: "alpine:latest",
        field: "image",
        id: `${idPrefix}-image`,
      });
      imgInput.addEventListener("input", () => {
        layer.image = imgInput.value.trim();
        syncFromVisual({ pushUrl: false, rerenderVisual: false });
      });
      body.appendChild(makeField("OCI / Docker Image", imgInput));
    } else if (layer.type === "git") {
      const grid = document.createElement("div");
      grid.className = "layer-grid-3";

      const repoIn = makeTextInput({
        value: layer.repo || "",
        placeholder: "owner/repo or https://github.com/owner/repo",
        field: "repo",
        id: `${idPrefix}-repo`,
      });
      repoIn.addEventListener("input", () => {
        layer.repo = repoIn.value.trim();
        syncFromVisual({ pushUrl: false, rerenderVisual: false });
      });

      const refIn = makeTextInput({
        value: layer.ref || "",
        placeholder: "HEAD (default)",
        field: "ref",
        id: `${idPrefix}-ref`,
      });
      refIn.addEventListener("input", () => {
        const val = refIn.value.trim();
        if (val) layer.ref = val;
        else delete layer.ref;
        syncFromVisual({ pushUrl: false, rerenderVisual: false });
      });

      const mountIn = makeTextInput({
        value: layer.mountPath || DEFAULT_MOUNT_PATH,
        placeholder: DEFAULT_MOUNT_PATH,
        field: "mountPath",
        id: `${idPrefix}-mount`,
      });
      mountIn.addEventListener("input", () => {
        layer.mountPath = mountIn.value.trim() || DEFAULT_MOUNT_PATH;
        syncFromVisual({ pushUrl: false, rerenderVisual: false });
      });

      grid.append(
        makeField("GitHub Repository", repoIn),
        makeField("Branch / Tag / Commit", refIn),
        makeField("Mount Path", mountIn)
      );
      body.appendChild(grid);
    } else if (layer.type === "workdir") {
      const pathIn = makeTextInput({
        value: layer.path || DEFAULT_MOUNT_PATH,
        placeholder: "/workspace",
        field: "path",
        id: `${idPrefix}-workdir`,
      });
      pathIn.addEventListener("input", () => {
        layer.path = pathIn.value.trim();
        syncFromVisual({ pushUrl: false, rerenderVisual: false });
      });
      body.appendChild(makeField("Working Directory", pathIn));
    } else if (layer.type === "env") {
      const grid = document.createElement("div");
      grid.className = "layer-grid-2";

      const keyIn = makeTextInput({
        value: layer.key || "",
        placeholder: "KEY",
        field: "key",
        id: `${idPrefix}-env-key`,
      });
      keyIn.addEventListener("input", () => {
        layer.key = keyIn.value.trim();
        syncFromVisual({ pushUrl: false, rerenderVisual: false });
      });

      const valIn = makeTextInput({
        value: layer.value ?? "",
        placeholder: "value",
        field: "value",
        id: `${idPrefix}-env-val`,
      });
      valIn.addEventListener("input", () => {
        layer.value = valIn.value;
        syncFromVisual({ pushUrl: false, rerenderVisual: false });
      });

      grid.append(makeField("Variable Name", keyIn), makeField("Value", valIn));
      body.appendChild(grid);
    } else if (layer.type === "run") {
      const cmdIn = makeTextInput({
        value: layer.cmd || "",
        placeholder: 'echo "hello from elf2wasm"',
        field: "cmd",
        id: `${idPrefix}-cmd`,
      });
      cmdIn.addEventListener("input", () => {
        layer.cmd = cmdIn.value;
        syncFromVisual({ pushUrl: false, rerenderVisual: false });
      });
      cmdIn.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void executePipeline({ executorOverride: null });
        }
      });
      body.appendChild(makeField("Shell Command", cmdIn));
    } else if (layer.type === "sweep") {
      const cfg = document.createElement("div");
      cfg.className = "sweep-layer-config";

      const row1 = document.createElement("div");
      row1.className = "layer-grid-3";

      const paramSelect = document.createElement("select");
      paramSelect.id = `${idPrefix}-sweep-param`;
      paramSelect.dataset.field = "param";
      for (const [val, text] of [
        ["delay", "Delay Stddev (ms)"],
        ["seed", "PRNG Seed"],
        ["env", "Environment Variable"],
      ]) {
        const opt = document.createElement("option");
        opt.value = val;
        opt.textContent = text;
        if (layer.param === val) opt.selected = true;
        paramSelect.appendChild(opt);
      }

      const envKeyIn = makeTextInput({
        value: layer.envKey || "",
        placeholder: "MY_VAR",
        field: "envKey",
        id: `${idPrefix}-sweep-envkey`,
      });
      const envKeyField = makeField("Environment Variable Name", envKeyIn);
      envKeyField.dataset.sweepEnvKey = "true";
      envKeyField.hidden = layer.param !== "env";

      const modeWrap = document.createElement("div");
      modeWrap.className = "field";
      const modeLabel = document.createElement("label");
      modeLabel.textContent = "Variation Mode";
      const modeSeg = document.createElement("div");
      modeSeg.className = "segmented-control";
      modeSeg.setAttribute("role", "group");
      modeSeg.setAttribute("aria-label", "Sweep variation mode");

      const rangeBtn = document.createElement("button");
      rangeBtn.type = "button";
      rangeBtn.className = "seg-btn seg-btn-xs";
      rangeBtn.dataset.sweepMode = "range";
      rangeBtn.setAttribute("aria-pressed", layer.mode === "range" ? "true" : "false");
      rangeBtn.textContent = "Range";

      const listBtn = document.createElement("button");
      listBtn.type = "button";
      listBtn.className = "seg-btn seg-btn-xs";
      listBtn.dataset.sweepMode = "list";
      listBtn.setAttribute("aria-pressed", layer.mode === "list" ? "true" : "false");
      listBtn.textContent = "Values List";

      modeSeg.append(rangeBtn, listBtn);
      modeWrap.append(modeLabel, modeSeg);

      row1.append(makeField("Parameter to Vary", paramSelect), envKeyField, modeWrap);

      // Range fields
      const rangeRow = document.createElement("div");
      rangeRow.className = "layer-grid-3";
      rangeRow.dataset.sweepRangeFields = "true";
      rangeRow.hidden = layer.mode !== "range";

      const startIn = makeNumberInput({
        value: layer.start ?? (layer.param === "delay" ? 1 : 0),
        min: 0,
        step: layer.param === "delay" ? "any" : "1",
        field: "start",
        id: `${idPrefix}-sweep-start`,
      });
      const stepIn = makeNumberInput({
        value: layer.step ?? 1,
        min: 0,
        step: layer.param === "delay" ? "any" : "1",
        field: "step",
        id: `${idPrefix}-sweep-step`,
      });
      const countIn = makeNumberInput({
        value: layer.count ?? 5,
        min: 1,
        max: MAX_SWEEP_COUNT,
        step: "1",
        field: "count",
        id: `${idPrefix}-sweep-count`,
      });

      rangeRow.append(
        makeField("Start", startIn),
        makeField("Step", stepIn),
        makeField("Count", countIn)
      );

      // List fields
      const listRow = document.createElement("div");
      listRow.dataset.sweepListFields = "true";
      listRow.hidden = layer.mode !== "list";

      const valuesIn = makeTextInput({
        value: Array.isArray(layer.values) ? layer.values.join(", ") : "",
        placeholder: layer.param === "env" ? "hello, bonjour, hola" : "0, 1, 5, 10",
        field: "values",
        id: `${idPrefix}-sweep-values`,
      });
      listRow.appendChild(makeField("Comma-Separated Values", valuesIn));

      const hintEl = document.createElement("div");
      hintEl.className = "sweep-layer-hint";
      hintEl.textContent = formatSweepHintText(layer);

      const refreshSweepHint = () => {
        hintEl.textContent = formatSweepHintText(layer);
      };

      paramSelect.addEventListener("change", () => {
        layer.param = paramSelect.value;
        if (layer.param === "env" && !layer.envKey) {
          layer.envKey = "VARIANT";
          envKeyIn.value = layer.envKey;
        }
        if (layer.param === "env" && layer.mode === "range") {
          layer.mode = "list";
          if (!Array.isArray(layer.values) || layer.values.length === 0) {
            layer.values = ["a", "b", "c"];
          }
          valuesIn.value = layer.values.join(", ");
          rangeBtn.setAttribute("aria-pressed", "false");
          listBtn.setAttribute("aria-pressed", "true");
          rangeRow.hidden = true;
          listRow.hidden = false;
        }
        envKeyField.hidden = layer.param !== "env";
        valuesIn.placeholder = layer.param === "env" ? "hello, bonjour, hola" : "0, 1, 5, 10";
        refreshSweepHint();
        syncFromVisual({ pushUrl: false, rerenderVisual: false });
      });

      envKeyIn.addEventListener("input", () => {
        layer.envKey = envKeyIn.value.trim();
        refreshSweepHint();
        syncFromVisual({ pushUrl: false, rerenderVisual: false });
      });

      const setSweepMode = (mode) => {
        layer.mode = mode;
        rangeBtn.setAttribute("aria-pressed", mode === "range" ? "true" : "false");
        listBtn.setAttribute("aria-pressed", mode === "list" ? "true" : "false");
        rangeRow.hidden = mode !== "range";
        listRow.hidden = mode !== "list";
        if (mode === "range") {
          if (layer.start === undefined) layer.start = Number(startIn.value) || 0;
          if (layer.step === undefined) layer.step = Number(stepIn.value) || 1;
          if (layer.count === undefined) layer.count = Number(countIn.value) || 5;
        } else {
          if (!Array.isArray(layer.values)) {
            layer.values = valuesIn.value
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
          }
        }
        refreshSweepHint();
        syncFromVisual({ pushUrl: false, rerenderVisual: false });
      };

      rangeBtn.addEventListener("click", () => setSweepMode("range"));
      listBtn.addEventListener("click", () => setSweepMode("list"));

      startIn.addEventListener("input", () => {
        const n = Number(startIn.value);
        layer.start = Number.isFinite(n) && n >= 0 ? n : 0;
        refreshSweepHint();
        syncFromVisual({ pushUrl: false, rerenderVisual: false });
      });

      stepIn.addEventListener("input", () => {
        const n = Number(stepIn.value);
        layer.step = Number.isFinite(n) && n >= 0 ? n : 0;
        refreshSweepHint();
        syncFromVisual({ pushUrl: false, rerenderVisual: false });
      });

      countIn.addEventListener("input", () => {
        const n = Math.floor(Number(countIn.value));
        layer.count = Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_SWEEP_COUNT) : 1;
        refreshSweepHint();
        syncFromVisual({ pushUrl: false, rerenderVisual: false });
      });

      valuesIn.addEventListener("input", () => {
        layer.values = valuesIn.value
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        refreshSweepHint();
        syncFromVisual({ pushUrl: false, rerenderVisual: false });
      });

      cfg.append(row1, rangeRow, listRow, hintEl);
      body.appendChild(cfg);
    }

    card.append(header, body);
    layerListEl.appendChild(card);
    updateLayerCardStatusUi(idx);
  });
}

// ---------------------------------------------------------------------------
// Tab Switching, Add-Layer Buttons, Presets & Copy Link
// ---------------------------------------------------------------------------

function setActiveEditorTab(mode) {
  const isVisual = mode !== "dockerfile";
  if (tabVisualBtn) tabVisualBtn.setAttribute("aria-selected", isVisual ? "true" : "false");
  if (tabDockerfileBtn) tabDockerfileBtn.setAttribute("aria-selected", isVisual ? "false" : "true");
  if (panelVisual) panelVisual.hidden = !isVisual;
  if (panelDockerfile) panelDockerfile.hidden = isVisual;
}

tabVisualBtn?.addEventListener("click", () => setActiveEditorTab("visual"));
tabDockerfileBtn?.addEventListener("click", () => setActiveEditorTab("dockerfile"));

dockerfileEditor?.addEventListener("input", () => {
  syncFromDockerfileText(dockerfileEditor.value, { pushUrl: false });
});
dockerfileEditor?.addEventListener("change", () => {
  syncFromDockerfileText(dockerfileEditor.value, { pushUrl: false });
});

for (const btn of addLayerButtons) {
  btn.addEventListener("click", () => {
    const type = btn.dataset.addLayer;
    if (!type) return;
    const currentExec = inferExecutorMode(layers) === "remote" ? "remote" : "local";
    let newLayer;
    if (type === "from") {
      newLayer = createLayer("from", { id: nextLayerId(), image: "alpine:latest", executor: currentExec });
    } else if (type === "git") {
      newLayer = createLayer("git", { id: nextLayerId(), repo: "", mountPath: DEFAULT_MOUNT_PATH, executor: currentExec });
    } else if (type === "workdir") {
      newLayer = createLayer("workdir", { id: nextLayerId(), path: DEFAULT_MOUNT_PATH });
    } else if (type === "env") {
      newLayer = createLayer("env", { id: nextLayerId(), key: "", value: "" });
    } else if (type === "run") {
      newLayer = createLayer("run", { id: nextLayerId(), cmd: "", executor: currentExec });
    } else if (type === "sweep") {
      newLayer = createLayer("sweep", {
        id: nextLayerId(),
        param: "delay",
        mode: "range",
        start: 1,
        step: 1,
        count: 5,
      });
    } else {
      return;
    }

    layers.push(newLayer);
    syncFromVisual({ pushUrl: false, rerenderVisual: true });

    // Focus the first input inside the newly added card
    const lastCard = layerListEl?.lastElementChild;
    const firstInput = lastCard?.querySelector("input, select");
    if (firstInput) firstInput.focus();
  });
}

async function copyShareableUrl(buttonEl, defaultLabel) {
  const search = serializeStateToSearch(
    {
      layers,
      executorMode: inferExecutorMode(layers),
      theme: currentThemePref,
      selectedSweepRun,
      stddev: baseDelayStddevMs,
      seed: baseDelaySeed,
    },
    { existingSearch: window.location.search }
  );
  const url = `${window.location.origin}${window.location.pathname}${search}${window.location.hash}`;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(url);
    }
  } catch {
    // Clipboard may be unavailable in insecure contexts
  }
  if (buttonEl) {
    buttonEl.textContent = "Copied!";
    setTimeout(() => {
      buttonEl.textContent = defaultLabel;
    }, 1500);
  }
}

copyPipelineLinkBtn?.addEventListener("click", () => {
  void copyShareableUrl(copyPipelineLinkBtn, "Copy Link");
});

copySweepLinkBtn?.addEventListener("click", () => {
  void copyShareableUrl(copySweepLinkBtn, "Copy Sweep Link");
});

function loadPreset(presetId) {
  const preset = PROJECT_PRESETS[presetId];
  if (!preset) return;
  cancelActiveSessionForNavigation();
  clearSweepResults();
  layerResultsByIndex.clear();
  layerStatusByIndex.clear();
  baseDelayStddevMs = 0;
  baseDelaySeed = 0;

  isSyncing = true;
  try {
    dockerfileText = preset.dockerfile;
    const parsed = parseDockerfile(preset.dockerfile);
    layers = parsed.layers;
    dockerfileWarnings = parsed.warnings;
    activePresetId = presetId;
    if (dockerfileEditor) dockerfileEditor.value = dockerfileText;
    renderLayerList();
    updateGlobalControlsUi();
    syncUrlFromState({ push: true });
  } finally {
    isSyncing = false;
  }
  startBtn?.focus();
}

for (const card of presetCards) {
  card.addEventListener("click", () => {
    const id = card.dataset.preset;
    if (id) loadPreset(id);
  });
}

// ---------------------------------------------------------------------------
// Execution Stop & Cleanup Helpers
// ---------------------------------------------------------------------------

async function stopActiveSession({ updateUi = true } = {}) {
  if (activeAbortController) {
    try {
      activeAbortController.abort();
    } catch {
      // Ignore abort errors
    }
    activeAbortController = null;
  }

  const prev = activeContainer;
  activeContainer = null;
  containerExited = true;

  if (prev) {
    try {
      await prev.stop();
    } catch {
      // Ignore stop errors
    }
  }

  if (updateUi) {
    if (stopBtn) stopBtn.disabled = true;
    if (startBtn) startBtn.disabled = false;
    if (runAllLocalBtn) runAllLocalBtn.disabled = false;
    if (runAllRemoteBtn) runAllRemoteBtn.disabled = false;
    for (const [idx, status] of layerStatusByIndex.entries()) {
      if (status === "running") {
        layerStatusByIndex.set(idx, "idle");
        updateLayerCardStatusUi(idx);
      }
    }
    setProgress(0, "idle");
    setStatus("Stopped", "idle");
    if (sweepOutcomeBadge && sweepOutcomeBadge.dataset.outcome === "running") {
      sweepOutcomeBadge.dataset.outcome = "idle";
      sweepOutcomeBadge.textContent = "Stopped";
    }
    for (const rowEl of sweepRowEls.values()) {
      const pill = rowEl.querySelector('.run-status-pill[data-status="running"]');
      if (pill) {
        pill.dataset.status = "stopped";
        pill.textContent = "stopped";
      }
    }
  }
}

function clearSweepResults() {
  selectedSweepRun = null;
  sweepRunRecords.clear();
  sweepRowEls.clear();
  sweepRunBaseLayers = null;
  sweepActiveLayer = null;
  userPinnedRun = false;
  activeSweepRunIndex = null;
  if (sweepResultsBody) sweepResultsBody.textContent = "";
  if (sweepOutcomeBadge) {
    sweepOutcomeBadge.dataset.outcome = "idle";
    sweepOutcomeBadge.textContent = "Idle";
  }
  if (sweepParamSummary) sweepParamSummary.textContent = "Varying: —";
  if (sweepProgressText) sweepProgressText.textContent = "0 / 0 variations";
  if (sweepPanel) sweepPanel.hidden = true;
}

function cancelActiveSessionForNavigation() {
  if (
    activeAbortController !== null ||
    activeContainer !== null ||
    sweepOutcomeBadge?.dataset?.outcome === "running"
  ) {
    sessionSeq++;
    void stopActiveSession({ updateUi: false });
    if (stopBtn) stopBtn.disabled = true;
    if (startBtn) startBtn.disabled = false;
    setProgress(0, "idle");
    setStatus("Ready", "idle");
  }
}

// ---------------------------------------------------------------------------
// Sweep Results Table & Variation Replay (F12, F13)
// ---------------------------------------------------------------------------

function computeVariationVirtualTimeNs(vRes) {
  if (!vRes || !Array.isArray(vRes.layers)) return 0;
  return vRes.layers.reduce((sum, lr) => sum + (Number(lr?.virtualTimeNs) || 0), 0);
}

function findDownloadableLayerInVariation(vRes) {
  if (!vRes || !Array.isArray(vRes.layers)) return null;
  for (let i = vRes.layers.length - 1; i >= 0; i--) {
    const lr = vRes.layers[i];
    if (extractTarGzBytes(lr)) {
      return lr;
    }
  }
  return null;
}

function selectSweepVariation(variationIndex, { syncUrl = true } = {}) {
  const vRes = sweepRunRecords.get(variationIndex);
  selectedSweepRun = variationIndex;

  for (const [idx, rowEl] of sweepRowEls.entries()) {
    rowEl.dataset.selected = idx === variationIndex ? "true" : "false";
  }

  if (vRes) {
    const totalNs = computeVariationVirtualTimeNs(vRes);
    terminal.reset();
    terminal.write(
      `[sweep #${vRes.variationIndex}] ${vRes.label} — ${vRes.ok ? "PASS" : "FAIL"} (exit ${vRes.exitCode}, virtual ${formatVirtualTime(totalNs)})\r\n`
    );
    for (const lr of vRes.layers || []) {
      if (lr.type !== "run") continue;
      terminal.write(
        `\r\n--- Layer #${lr.layerIndex + 1} (${lr.executor}) [exit ${lr.exitCode}, ${formatVirtualTime(lr.virtualTimeNs)}] ---\r\n`
      );
      if (lr.stdout) terminal.write(lr.stdout);
      if (lr.stderr) {
        if (lr.stdout && !lr.stdout.endsWith("\n")) terminal.write("\r\n");
        terminal.write(lr.stderr);
      }
      if (lr.error) {
        terminal.write(`\r\n[error${lr.errorCode ? ` (${lr.errorCode})` : ""}] ${lr.error}\r\n`);
      }
    }
    if (typeof terminal._renderNow === "function") {
      terminal._renderNow();
    }
    if (terminalTitleEl) {
      terminalTitleEl.textContent = `${getPrimaryImageName(layers)} — Sweep #${vRes.variationIndex} (${vRes.label})`;
    }
  }

  if (syncUrl) {
    syncUrlFromState({ push: false });
  }
}

function createSweepRowElement(variationIndex, variedValueText, runHref) {
  const tr = document.createElement("tr");
  tr.dataset.variationIndex = String(variationIndex);
  tr.dataset.selected = "false";

  const tdIndex = document.createElement("td");
  tdIndex.textContent = String(variationIndex);

  const tdValue = document.createElement("td");
  tdValue.textContent = variedValueText;

  const tdStatus = document.createElement("td");
  const statusBadge = document.createElement("span");
  statusBadge.className = "run-status-pill";
  statusBadge.dataset.status = "running";
  statusBadge.textContent = "running";
  tdStatus.appendChild(statusBadge);

  const tdExit = document.createElement("td");
  tdExit.textContent = "…";

  const tdTime = document.createElement("td");
  tdTime.textContent = "…";

  const tdOutputs = document.createElement("td");
  tdOutputs.textContent = "—";

  const tdLink = document.createElement("td");
  const link = document.createElement("a");
  link.className = "run-link";
  link.setAttribute("href", runHref);
  link.textContent = "Open run";
  link.addEventListener("click", (e) => e.stopPropagation());
  tdLink.appendChild(link);

  tr.append(tdIndex, tdValue, tdStatus, tdExit, tdTime, tdOutputs, tdLink);
  tr.addEventListener("click", () => {
    userPinnedRun = true;
    selectSweepVariation(variationIndex, { syncUrl: true });
  });

  return { tr, statusBadge, tdExit, tdTime, tdOutputs };
}

// ---------------------------------------------------------------------------
// Interactive Shell Fallback (when layers have no RUN / SWEEP layers)
// ---------------------------------------------------------------------------

async function bootInteractiveShell({
  imageRef,
  tarball = null,
  cmdStr = "",
  envList = [],
  cwd = "",
  gitRepo = undefined,
  delayStddevMs = 0,
  delaySeed = 0,
}) {
  const seq = ++sessionSeq;
  await stopActiveSession({ updateUi: false });
  if (seq !== sessionSeq) return;

  clearSweepResults();

  const abortController = new AbortController();
  activeAbortController = abortController;

  if (stopBtn) stopBtn.disabled = false;
  if (startBtn) startBtn.disabled = true;
  terminal.reset();
  setProgress(3, "manifest");

  let sawStderr = false;
  let resolvedDisplayName = tarball ? tarball.name : imageRef;
  const cmdTokens = cmdStr ? splitShellArgs(cmdStr) : [];
  const hasDelay = delayStddevMs > 0 || delaySeed > 0;

  try {
    const docker = await getDocker();
    if (seq !== sessionSeq) return;

    let image;
    if (tarball) {
      setStatus(`Loading local tarball ${tarball.name}...`, "busy");
      const safeName =
        tarball.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "") || "tarball";
      image = await docker.loadOciTarball(tarball.bytes, {
        name: `local/${safeName}:latest`,
        onProgress: (ev) => {
          if (seq === sessionSeq) handleProgressEvent(ev);
        },
      });
    } else {
      try {
        const parsed = parseImageRef(imageRef);
        resolvedDisplayName = `${parsed.repository}:${parsed.reference}`;
      } catch (parseErr) {
        throw new Error(`Invalid Docker image reference "${imageRef}": ${parseErr.message}`);
      }
      setStatus(`Fetching manifest for ${imageRef}...`, "busy");
      image = await docker.pullImage(imageRef, {
        platform: "linux/amd64",
        signal: abortController.signal,
        onProgress: (ev) => {
          if (seq === sessionSeq) handleProgressEvent(ev);
        },
      });
    }

    let container;
    try {
      if (seq !== sessionSeq) return;
      const { cols, rows } = terminal.getSize();
      const displayCmd =
        cmdTokens.length > 0
          ? cmdTokens.join(" ")
          : (image.config?.cmd && image.config.cmd.join(" ")) ||
            (image.config?.entrypoint && image.config.entrypoint.join(" ")) ||
            "/bin/sh";
      if (terminalTitleEl) {
        const repoSuffix = gitRepo ? ` + ${gitRepo.repo}@${gitRepo.ref || "HEAD"}` : "";
        terminalTitleEl.textContent = `${resolvedDisplayName}${repoSuffix} — ${displayCmd}`;
      }

      container = await image.createContainer({
        cmd: cmdTokens.length > 0 ? cmdTokens : undefined,
        env: envList.length > 0 ? envList : undefined,
        cwd: cwd || undefined,
        gitRepo,
        tty: true,
        cols,
        rows,
        ...(hasDelay ? { delayStddevMs, delaySeed } : {}),
        signal: abortController.signal,
        onProgress: (ev) => {
          if (seq === sessionSeq) handleProgressEvent(ev);
        },
      });
    } finally {
      try {
        await image.dispose();
      } catch {
        // Ignore cleanup error
      }
    }

    if (seq !== sessionSeq) {
      try {
        await container.stop();
      } catch {
        // Ignore cleanup
      }
      return;
    }

    activeContainer = container;
    containerExited = false;

    container.onStdout((chunk) => {
      if (seq === sessionSeq) terminal.write(chunk);
    });
    container.onStderr((chunk) => {
      if (seq !== sessionSeq) return;
      sawStderr = true;
      terminal.write(chunk);
    });
    container.onExit((exitCode) => {
      if (seq !== sessionSeq) return;
      if (typeof terminal._renderNow === "function") terminal._renderNow();
      containerExited = true;
      activeContainer = null;
      activeAbortController = null;
      if (stopBtn) stopBtn.disabled = true;
      if (startBtn) startBtn.disabled = false;
      setStatus(`Exited (code ${exitCode})`, exitCode === 0 ? "idle" : "error");
      void container.stop().catch(() => {});
    });

    await container.start();
    if (seq !== sessionSeq) return;

    activeAbortController = null;
    if (startBtn) startBtn.disabled = false;
    if (stopBtn) stopBtn.disabled = containerExited;
    if (!containerExited) {
      setProgress(100, "run");
      setStatus("Running — Interactive shell ready", "running");
      terminal.focus();
    }
  } catch (err) {
    if (seq !== sessionSeq || err?.name === "AbortError") return;
    const leaked = activeContainer;
    activeAbortController = null;
    activeContainer = null;
    containerExited = true;
    if (leaked) void leaked.stop().catch(() => {});
    if (stopBtn) stopBtn.disabled = true;
    if (startBtn) startBtn.disabled = false;
    const msg = err?.message || String(err);
    setStatus(`Error: ${msg}`, "error");
    if (!sawStderr) terminal.write(`\r\n[elf2wasm] Error: ${msg}\r\n`);
  }
}

// ---------------------------------------------------------------------------
// Multi-Layer Local / Remote / Sweep Pipeline Execution (F12, F13)
// ---------------------------------------------------------------------------

async function executePipeline({ executorOverride = null } = {}) {
  const effectiveLayers = layers.filter((l) => l && l.type);
  if (effectiveLayers.length === 0) {
    setStatus("Add a FROM layer or enter a Dockerfile to run", "error");
    return;
  }

  const hasFrom = effectiveLayers.some(
    (l) => l.type === "from" && typeof l.image === "string" && l.image.trim().length > 0
  );
  if (!hasFrom) {
    setStatus("Invalid Dockerfile: missing FROM base image layer", "error");
    return;
  }

  const hasRun = effectiveLayers.some((l) => l.type === "run" && l.cmd && l.cmd.trim().length > 0);
  const sweepLayer = getSweepLayer(effectiveLayers);

  // Interactive shell fallback when there are no RUN/SWEEP layers
  if (!hasRun && !sweepLayer) {
    if (executorOverride === "remote") {
      setStatus("Add at least one RUN layer to evaluate remotely (interactive shells run locally)", "error");
      return;
    }
    const fromLayer = effectiveLayers.find((l) => l.type === "from");
    const gitLayer = effectiveLayers.find((l) => l.type === "git" && l.repo);
    const workdirLayers = effectiveLayers.filter((l) => l.type === "workdir" && l.path);
    const envList = effectiveLayers
      .filter((l) => l.type === "env" && l.key)
      .map((l) => `${l.key}=${l.value ?? ""}`);
    const cwd = workdirLayers.length > 0 ? workdirLayers[workdirLayers.length - 1].path : "";
    await bootInteractiveShell({
      imageRef: fromLayer?.image || "alpine:latest",
      gitRepo: gitLayer
        ? {
            repo: gitLayer.repo,
            ref: gitLayer.ref || "HEAD",
            mountPath: gitLayer.mountPath || DEFAULT_MOUNT_PATH,
          }
        : undefined,
      cwd,
      envList,
      delayStddevMs: baseDelayStddevMs,
      delaySeed: baseDelaySeed,
    });
    return;
  }

  const seq = ++sessionSeq;
  await stopActiveSession({ updateUi: false });
  if (seq !== sessionSeq) return;

  layerResultsByIndex.clear();
  layerStatusByIndex.clear();
  for (let i = 0; i < effectiveLayers.length; i++) {
    layerStatusByIndex.set(i, "idle");
    updateLayerCardStatusUi(i);
  }

  clearSweepResults();
  const rowRefs = new Map();
  let totalSweepVariations = 0;
  if (sweepLayer) {
    sweepActiveLayer = sweepLayer;
    sweepRunBaseLayers = effectiveLayers.map((l) => ({ ...l }));
    totalSweepVariations = expandSweepValues(sweepLayer).length;
    if (sweepPanel) sweepPanel.hidden = false;
    if (sweepOutcomeBadge) {
      sweepOutcomeBadge.dataset.outcome = "running";
      sweepOutcomeBadge.textContent = "Running";
    }
    if (sweepVariedColHeader) {
      sweepVariedColHeader.textContent = formatSweepParamLabel(sweepLayer);
    }
    if (sweepParamSummary) {
      sweepParamSummary.textContent = `Varying: ${formatSweepParamLabel(sweepLayer)} (${totalSweepVariations} variations)`;
    }
    if (sweepProgressText) {
      sweepProgressText.textContent = `0 / ${totalSweepVariations} variations`;
    }
  }

  const abortController = new AbortController();
  activeAbortController = abortController;
  containerExited = false;

  if (stopBtn) stopBtn.disabled = false;
  if (startBtn) startBtn.disabled = true;
  if (runAllLocalBtn) runAllLocalBtn.disabled = true;
  if (runAllRemoteBtn) runAllRemoteBtn.disabled = true;
  terminal.reset();
  setProgress(5, "manifest");

  const needsLocal = hasLocalRunLayer(effectiveLayers, executorOverride);
  setStatus(
    needsLocal ? "Starting pipeline (Browser WASM)..." : "Evaluating pipeline remotely on Cloudflare Worker...",
    "busy"
  );

  const pipelineOptions = {
    executorOverride: executorOverride || undefined,
    apiBase: resolveApiBase(),
    delayStddevMs: baseDelayStddevMs,
    delaySeed: baseDelaySeed,
    stopOnFailure: false,
    signal: abortController.signal,
    onProgress: (ev) => {
      if (seq === sessionSeq) handleProgressEvent(ev);
    },
    onLayerStart: ({ layerIndex, layer, executor, variationIndex }) => {
      if (seq !== sessionSeq) return;
      if (variationIndex === null || variationIndex === undefined) {
        layerStatusByIndex.set(layerIndex, "running");
        updateLayerCardStatusUi(layerIndex);
      }
      const execLabel = executor || layer?.executor || "local";
      if (layer?.type === "run") {
        if (execLabel === "remote") {
          setProgress(50, "run");
        }
        const prefix =
          variationIndex != null
            ? `[sweep #${variationIndex} · ${execLabel} #${layerIndex + 1}]`
            : `[${execLabel} #${layerIndex + 1}]`;
        setStatus(`Running layer #${layerIndex + 1} (${execLabel})...`, "busy");
        const shouldWrite =
          variationIndex == null ||
          (!userPinnedRun && activeSweepRunIndex === variationIndex) ||
          (userPinnedRun && selectedSweepRun === variationIndex && activeSweepRunIndex === variationIndex);
        if (shouldWrite) {
          terminal.write(`\r\n${prefix} $ ${layer.cmd}\r\n`);
        }
      }
    },
    onLayerOutput: ({ chunk, variationIndex }) => {
      if (seq !== sessionSeq) return;
      if (variationIndex == null) {
        terminal.write(chunk);
        return;
      }
      if (
        (!userPinnedRun && activeSweepRunIndex === variationIndex) ||
        (userPinnedRun && selectedSweepRun === variationIndex && activeSweepRunIndex === variationIndex)
      ) {
        terminal.write(chunk);
      }
    },
    onLayerComplete: (res) => {
      if (seq !== sessionSeq) return;
      if (res.variationIndex == null) {
        layerResultsByIndex.set(res.layerIndex, res);
        layerStatusByIndex.set(res.layerIndex, res.ok ? "pass" : "fail");
        updateLayerCardStatusUi(res.layerIndex);
      }
      if (res.error && !res.stderr) {
        const shouldWrite =
          res.variationIndex == null ||
          (!userPinnedRun && activeSweepRunIndex === res.variationIndex);
        if (shouldWrite) {
          terminal.write(
            `\r\n[layer #${res.layerIndex + 1} error${res.errorCode ? ` (${res.errorCode})` : ""}] ${res.error}\r\n`
          );
        }
      }
    },
    onVariationStart: ({ variationIndex, totalVariations, variation }) => {
      if (seq !== sessionSeq) return;
      activeSweepRunIndex = variationIndex;
      const variedVal = formatSweepVariationCell(sweepActiveLayer, variation);
      const runSearch = buildRunSearch(
        {
          layers: sweepRunBaseLayers || effectiveLayers,
          executorMode: inferExecutorMode(sweepRunBaseLayers || effectiveLayers),
          theme: currentThemePref,
        },
        {
          stddev: variation?.delayStddevMs ?? baseDelayStddevMs,
          seed: variation?.delaySeed ?? baseDelaySeed,
          envOverride: variation?.envOverride ?? null,
        },
        { existingSearch: window.location.search }
      );
      const runHref = `${window.location.pathname}${runSearch}`;
      const rowRef = createSweepRowElement(variationIndex, variedVal, runHref);
      rowRefs.set(variationIndex, rowRef);
      sweepRowEls.set(variationIndex, rowRef.tr);
      sweepResultsBody?.appendChild(rowRef.tr);

      if (!userPinnedRun) {
        terminal.reset();
        terminal.write(
          `[sweep #${variationIndex}/${totalVariations}] ${variation?.label || variedVal}\r\n`
        );
      }
    },
    onVariationComplete: (vRes) => {
      if (seq !== sessionSeq) return;
      const cappedLayers = (vRes.layers || []).map((lr) => ({
        ...lr,
        stdout: capCapturedText(lr.stdout),
        stderr: capCapturedText(lr.stderr),
      }));
      const capped = {
        ...vRes,
        stdout: capCapturedText(vRes.stdout),
        stderr: capCapturedText(vRes.stderr),
        layers: cappedLayers,
      };
      sweepRunRecords.set(vRes.variationIndex, capped);

      const rowRef = rowRefs.get(vRes.variationIndex);
      if (rowRef) {
        const statusStr = vRes.ok ? "pass" : "fail";
        rowRef.statusBadge.dataset.status = statusStr;
        rowRef.statusBadge.textContent = statusStr;
        rowRef.tdExit.textContent = String(vRes.exitCode ?? "—");
        rowRef.tdTime.textContent = formatVirtualTime(computeVariationVirtualTimeNs(vRes));

        const dlLayer = findDownloadableLayerInVariation(vRes);
        if (dlLayer) {
          rowRef.tdOutputs.textContent = "";
          const dlBtn = document.createElement("button");
          dlBtn.type = "button";
          dlBtn.className = "btn-link";
          const fileCount = Array.isArray(dlLayer.modifiedFiles) ? dlLayer.modifiedFiles.length : 0;
          dlBtn.textContent = fileCount > 0 ? `.tar.gz (${fileCount})` : ".tar.gz";
          dlBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            downloadLayerOutputsTarGz(
              dlLayer,
              `sweep-run-${vRes.variationIndex}-layer-${dlLayer.layerIndex + 1}-outputs.tar.gz`
            );
          });
          rowRef.tdOutputs.appendChild(dlBtn);
        }
      }

      if (sweepProgressText) {
        sweepProgressText.textContent = `${sweepRunRecords.size} / ${totalSweepVariations} variations`;
      }
      if (userPinnedRun && selectedSweepRun === vRes.variationIndex) {
        selectSweepVariation(vRes.variationIndex, { syncUrl: false });
      }
    },
  };

  try {
    let result;
    if (needsLocal) {
      // Reuse persistent worker-backed Elf2WasmDocker for local and mixed pipelines
      const docker = await getDocker();
      if (seq !== sessionSeq) return;
      result = await docker.runLayerPipeline(effectiveLayers, pipelineOptions);
    } else {
      // Pure-remote pipeline: skip local WASM download/compilation completely!
      result = await runLayerPipeline(effectiveLayers, pipelineOptions);
    }

    if (seq !== sessionSeq) return;

    activeAbortController = null;
    containerExited = true;
    if (stopBtn) stopBtn.disabled = true;
    if (startBtn) startBtn.disabled = false;
    if (runAllLocalBtn) runAllLocalBtn.disabled = false;
    if (runAllRemoteBtn) runAllRemoteBtn.disabled = false;

    // Refresh final layer results (ensuring outputDiffTarGz buffers transferred from worker are stored)
    for (const lr of result.layers || []) {
      layerResultsByIndex.set(lr.layerIndex, lr);
      layerStatusByIndex.set(lr.layerIndex, lr.ok ? "pass" : "fail");
      updateLayerCardStatusUi(lr.layerIndex);
    }

    if (typeof terminal._renderNow === "function") {
      terminal._renderNow();
    }

    if (result.sweep) {
      const variations = result.sweep.variations || [];
      const failedVariation = variations.find((v) => !v.ok) || null;
      if (sweepProgressText) {
        sweepProgressText.textContent = `${variations.length} / ${totalSweepVariations} variations`;
      }
      if (failedVariation) {
        if (sweepOutcomeBadge) {
          sweepOutcomeBadge.dataset.outcome = "fail";
          sweepOutcomeBadge.textContent = `Failed (${result.sweep.failedCount}/${variations.length})`;
        }
        setProgress(100, "run");
        setStatus(
          `Sweep finished: ${result.sweep.passedCount} passed, ${result.sweep.failedCount} failed`,
          "error"
        );
      } else {
        if (sweepOutcomeBadge) {
          sweepOutcomeBadge.dataset.outcome = "pass";
          sweepOutcomeBadge.textContent = "Passed";
        }
        setProgress(100, "run");
        setStatus(`Sweep passed (${result.sweep.passedCount}/${variations.length} variations)`, "idle");
      }

      if (selectedSweepRun !== null && sweepRunRecords.has(selectedSweepRun)) {
        selectSweepVariation(selectedSweepRun, { syncUrl: false });
      } else if (!userPinnedRun && failedVariation) {
        selectSweepVariation(failedVariation.variationIndex, { syncUrl: false });
      } else if (!userPinnedRun && variations.length > 0) {
        selectSweepVariation(variations[variations.length - 1].variationIndex, { syncUrl: false });
      }
    } else {
      setProgress(100, "run");
      if (result.ok) {
        const lastRun = [...(result.layers || [])].reverse().find((l) => l.type === "run");
        const exitCode = lastRun ? lastRun.exitCode : 0;
        const execLabel =
          typeof lastRun?.executor === "string" && lastRun.executor.startsWith("remote")
            ? "remote"
            : "local";
        setStatus(`Completed (${execLabel}, exit code: ${exitCode})`, "idle");
        terminal.write(`\r\n[elf2wasm] Completed (${execLabel}, exit code: ${exitCode})\r\n`);
      } else {
        const failedLayer = (result.layers || []).find((l) => !l.ok);
        const reason = failedLayer?.error
          ? failedLayer.error
          : failedLayer
          ? `Layer #${failedLayer.layerIndex + 1} failed (exit ${failedLayer.exitCode})`
          : "Pipeline failed";
        setStatus(`Failed: ${reason}`, "error");
        terminal.write(`\r\n[elf2wasm] Failed (exit code: ${failedLayer?.exitCode ?? 1})\r\n`);
      }
    }
  } catch (err) {
    if (seq !== sessionSeq) return;
    activeAbortController = null;
    containerExited = true;
    if (stopBtn) stopBtn.disabled = true;
    if (startBtn) startBtn.disabled = false;
    if (runAllLocalBtn) runAllLocalBtn.disabled = false;
    if (runAllRemoteBtn) runAllRemoteBtn.disabled = false;

    if (err?.name === "AbortError") {
      if (sweepOutcomeBadge) {
        sweepOutcomeBadge.dataset.outcome = "idle";
        sweepOutcomeBadge.textContent = "Stopped";
      }
      return;
    }

    const msg = err?.message || String(err);
    if (sweepOutcomeBadge && sweepPanel && !sweepPanel.hidden) {
      sweepOutcomeBadge.dataset.outcome = "fail";
      sweepOutcomeBadge.textContent = "Error";
    }
    setStatus(`Error: ${msg}`, "error");
    terminal.write(`\r\n[elf2wasm] Error: ${msg}\r\n`);
  }
}

// ---------------------------------------------------------------------------
// Global Header Actions (Run, Run All Locally, Run All Remotely, Stop, Clear)
// ---------------------------------------------------------------------------

function setAllLayersExecutor(target) {
  for (const l of layers) {
    if (l && (l.type === "from" || l.type === "git" || l.type === "run")) {
      l.executor = target;
    }
  }
  syncFromVisual({ pushUrl: false, rerenderVisual: true, preserveWarnings: true });
}

runAllLocalBtn?.addEventListener("click", () => {
  setAllLayersExecutor("local");
  void executePipeline({ executorOverride: "local" });
});

runAllRemoteBtn?.addEventListener("click", () => {
  setAllLayersExecutor("remote");
  void executePipeline({ executorOverride: "remote" });
});

startBtn?.addEventListener("click", () => {
  void executePipeline({ executorOverride: null });
});

stopBtn?.addEventListener("click", () => {
  sessionSeq++;
  void stopActiveSession({ updateUi: true });
});

clearBtn?.addEventListener("click", () => {
  terminal.clear();
  terminal.focus();
});

// ---------------------------------------------------------------------------
// URL Hydration & Browser Navigation
// ---------------------------------------------------------------------------

function applyStateFromUrl() {
  const parsed = parseStateFromSearch(window.location.search, PROJECT_PRESETS);
  const urlParams = new URLSearchParams(window.location.search);
  const explicitUrlTheme = urlParams.get("theme");

  isSyncing = true;
  try {
    layers =
      Array.isArray(parsed.layers) && parsed.layers.length > 0
        ? parsed.layers
        : [createLayer("from", { id: "layer-1", image: "alpine:latest", executor: "local" })];

    if (parsed.executorMode === "remote" && inferExecutorMode(layers) !== "remote") {
      for (const l of layers) {
        if (l && (l.type === "from" || l.type === "git" || l.type === "run")) {
          l.executor = "remote";
        }
      }
    }

    dockerfileText = serializeDockerfile(layers);
    dockerfileWarnings = [];
    activePresetId = parsed.activePresetId;
    baseDelayStddevMs = Number(parsed.state?.stddev) || 0;
    baseDelaySeed = Number(parsed.state?.seed) || 0;
    selectedSweepRun = parsed.selectedSweepRun ?? null;

    if (dockerfileEditor) {
      dockerfileEditor.value = dockerfileText;
    }

    const themePref =
      explicitUrlTheme === "light" || explicitUrlTheme === "dark"
        ? explicitUrlTheme
        : readStoredThemePref();
    applyTheme(themePref, { persist: false, syncUrl: false });

    renderLayerList();
    updateGlobalControlsUi();
  } finally {
    isSyncing = false;
  }
}

window.addEventListener("popstate", () => {
  cancelActiveSessionForNavigation();
  clearSweepResults();
  layerResultsByIndex.clear();
  layerStatusByIndex.clear();
  applyStateFromUrl();
});

// Hydrate synchronously on page load (never auto-boot)
applyStateFromUrl();

// ---------------------------------------------------------------------------
// Secondary Manual Local Archive / ELF64 Upload Drawer
// ---------------------------------------------------------------------------

function isElf64(bytes) {
  return (
    bytes.length >= 5 &&
    bytes[0] === 0x7f &&
    bytes[1] === 0x45 &&
    bytes[2] === 0x4c &&
    bytes[3] === 0x46 &&
    bytes[4] === 2
  );
}

function isTarOrGzip(bytes, name) {
  return (
    /\.tar(\.gz)?$/i.test(name) ||
    /\.tgz$/i.test(name) ||
    (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) ||
    (bytes.length >= 263 &&
      bytes[257] === 0x75 &&
      bytes[258] === 0x73 &&
      bytes[259] === 0x74 &&
      bytes[260] === 0x61 &&
      bytes[261] === 0x72)
  );
}

function isZip(bytes, name) {
  return (
    /\.zip$/i.test(name) ||
    (bytes.length >= 4 &&
      bytes[0] === 0x50 &&
      bytes[1] === 0x4b &&
      bytes[2] === 0x03 &&
      bytes[3] === 0x04)
  );
}

function normalizeGuestPath(p) {
  const parts = [];
  for (const seg of String(p || "").split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return "/" + parts.join("/");
}

function renderManualSummary() {
  if (!manualVfsSummary || !manualVfsList) return;
  if (stagedTarball) {
    manualVfsSummary.textContent = `Staged OCI/rootfs tarball: ${stagedTarball.name} (${formatBytes(stagedTarball.bytes.length)})`;
    manualVfsList.textContent = "";
    return;
  }
  if (manualVfs.files.size === 0 && manualVfs.symlinks.size === 0) {
    manualVfsSummary.textContent = "No local archive or binary staged.";
    manualVfsList.textContent = "";
    return;
  }
  manualVfsSummary.textContent = `Manual VFS: ${manualVfs.files.size} file(s), ${manualVfs.symlinks.size} symlink(s)`;
  const lines = [];
  for (const [p, entry] of manualVfs.files.entries()) {
    if (lines.length >= 50) {
      lines.push(`... (${manualVfs.files.size + manualVfs.symlinks.size - 50} more)`);
      break;
    }
    lines.push(`F ${p} (${entry.bytes.length} B, 0o${entry.mode.toString(8)})`);
  }
  if (lines.length < 50) {
    for (const [p, target] of manualVfs.symlinks.entries()) {
      if (lines.length >= 50) {
        lines.push("...");
        break;
      }
      lines.push(`L ${p} -> ${target}`);
    }
  }
  manualVfsList.textContent = lines.join("\n");
}

async function compileWasmFromUrl(url) {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${resp.status}`);
  }
  if (typeof WebAssembly.compileStreaming === "function") {
    try {
      return await WebAssembly.compileStreaming(resp.clone());
    } catch {
      // Fallback to ArrayBuffer
    }
  }
  return await WebAssembly.compile(await resp.arrayBuffer());
}

async function getManualShimAndWasm() {
  if (!manualWasmCache) {
    manualWasmCache = (async () => {
      const [shim, compilerModule, runtimeModule] = await Promise.all([
        import("/js/elf2wasm_shim.mjs"),
        compileWasmFromUrl(COMPILER_WASM_URL),
        compileWasmFromUrl(RUNTIME_WASM_URL),
      ]);
      return { shim, compilerModule, runtimeModule };
    })().catch((err) => {
      manualWasmCache = null;
      throw err;
    });
  }
  return manualWasmCache;
}

manualFileInput?.addEventListener("change", () => {
  const files = Array.from(manualFileInput.files || []);
  manualUploadQueue = manualUploadQueue
    .then(async () => {
      for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (isTarOrGzip(bytes, file.name)) {
          stagedTarball = { name: file.name, bytes };
          manualVfs.files.clear();
          manualVfs.symlinks.clear();
        } else if (isZip(bytes, file.name)) {
          stagedTarball = null;
          const { shim } = await getManualShimAndWasm();
          const extracted = await shim.extractZipToVfs(bytes);
          for (const [p, entry] of extracted.files.entries()) {
            manualVfs.symlinks.delete(p);
            manualVfs.files.set(p, entry);
          }
          for (const [p, target] of extracted.symlinks.entries()) {
            manualVfs.files.delete(p);
            manualVfs.symlinks.set(p, target);
          }
        } else {
          stagedTarball = null;
          const customPath = manualUploadPath?.value.trim() || "";
          const guestPath = normalizeGuestPath(customPath || `/bin/${file.name}`);
          const mode = isElf64(bytes) ? 0o755 : 0o644;
          manualVfs.symlinks.delete(guestPath);
          manualVfs.files.set(guestPath, { bytes, mode });
          if (manualCmdInput && !manualCmdInput.value.trim() && isElf64(bytes)) {
            manualCmdInput.value = guestPath;
          }
        }
      }
      renderManualSummary();
    })
    .catch((err) => {
      setStatus(`Upload error: ${err?.message || err}`, "error");
    });
});

manualClearBtn?.addEventListener("click", () => {
  stagedTarball = null;
  manualVfs.files.clear();
  manualVfs.symlinks.clear();
  if (manualFileInput) manualFileInput.value = "";
  renderManualSummary();
});

manualRunBtn?.addEventListener("click", async () => {
  await manualUploadQueue;

  if (stagedTarball) {
    await bootInteractiveShell({
      imageRef: stagedTarball.name,
      tarball: stagedTarball,
      cmdStr: manualCmdInput?.value.trim() || "",
      gitRepo: undefined,
    });
    return;
  }

  if (manualVfs.files.size === 0) {
    setStatus("Error: No local archive or ELF64 binary selected", "error");
    return;
  }

  const tokens = splitShellArgs(manualCmdInput?.value.trim() || "");
  if (tokens.length === 0) {
    setStatus("Error: Specify a command path (e.g. /bin/app)", "error");
    return;
  }

  const seq = ++sessionSeq;
  await stopActiveSession({ updateUi: false });
  if (seq !== sessionSeq) return;

  terminal.reset();
  setProgress(50, "compile");
  setStatus(`Compiling ${tokens[0]} → WASM in browser...`, "busy");

  try {
    const { shim, compilerModule, runtimeModule } = await getManualShimAndWasm();
    if (seq !== sessionSeq) return;

    const res = await shim.runFromVfs({
      compilerWasm: compilerModule,
      runtimeWasm: runtimeModule,
      vfs: manualVfs,
      command: tokens[0],
      args: tokens.slice(1),
    });

    if (seq !== sessionSeq) return;

    if (res.stdout && res.stdout.length > 0) terminal.write(res.stdout);
    if (res.stderr && res.stderr.length > 0) terminal.write(res.stderr);
    setProgress(100, "run");
    setStatus(`Exited (code ${res.exitCode})`, res.exitCode === 0 ? "idle" : "error");
  } catch (err) {
    if (seq !== sessionSeq) return;
    const msg = err?.message || String(err);
    setStatus(`Error: ${msg}`, "error");
    terminal.write(`\r\n[elf2wasm] Error: ${msg}\r\n`);
  }
});
