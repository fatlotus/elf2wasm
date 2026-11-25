/**
 * UI controller for the elf2wasm client-side Docker-on-WASM interactive web shell.
 */

import { Elf2WasmDocker, runDockerImage, runSweep, parseImageRef } from "/js/docker_sdk.mjs";
import { VT100Terminal } from "/web/terminal.mjs";
import {
  DEFAULT_UI_STATE,
  MAX_STDDEV_MS,
  MAX_SEED,
  MAX_SWEEP_RUNS,
  parseEnvLines,
  parseStateFromSearch,
  serializeStateToSearch,
  matchProjectPreset,
  computeSweepRunParams,
  buildRunSearch,
} from "./url_state.mjs";

// Immediately expose JS SDK globals on window (before any async work)
window.Elf2WasmDocker = Elf2WasmDocker;
window.runDockerImage = runDockerImage;
window.runSweep = runSweep;

const COMPILER_WASM_URL = "/wasm/elf2wasm_compiler_wasm.wasm";
const RUNTIME_WASM_URL = "/wasm/elf2wasm_runtime_wasm.wasm";

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
    if (content) {
      return content;
    }
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
    if (content) {
      return content;
    }
  }
  return "/api/git/archive";
}

const PROJECT_PRESETS = Object.freeze({
  "python-bottle": Object.freeze({
    id: "python-bottle",
    label: "Python: Bottle (359 tests)",
    language: "Python",
    image: "python:3.12-slim",
    repo: "bottlepy/bottle",
    ref: "0.13.4",
    mountPath: "/workspace",
    build: "",
    cmd: "python3 -m unittest discover -s test -t .",
    cwd: "/workspace",
    env: Object.freeze(["PYTHONUNBUFFERED=1"]),
  }),
  "js-nanoid": Object.freeze({
    id: "js-nanoid",
    label: "JavaScript: Nano ID (13 tests)",
    language: "JavaScript",
    image: "node:22-slim",
    repo: "ai/nanoid",
    ref: "6.0.2",
    mountPath: "/workspace",
    build: "",
    cmd: "node test/non-secure.test.js",
    cwd: "/workspace",
    env: Object.freeze([]),
  }),
  "rust-nushell": Object.freeze({
    id: "rust-nushell",
    label: "Rust: Nushell stdlib (35 tests)",
    language: "Rust",
    image: "ghcr.io/nushell/nushell:0.117.0-alpine",
    repo: "nushell/nushell",
    ref: "0.117.0",
    mountPath: "/workspace",
    build: "",
    cmd: "--no-config-file -c \"source crates/nu-std/tests/test_asserts.nu; source crates/nu-std/tests/test_iter.nu; source crates/nu-std/tests/test_formats.nu; assert_basic; assert_not; assert_equal; assert_not_equal; assert_error; assert_length; assert_less; assert_less_or_equal; assert_greater; assert_greater_or_equal; iter_find; iter_intersperse; iter_scan; iter_filter_map; iter_find_index; iter_zip_with; iter_flat_map; iter_zip_into_record; from_ndjson_multiple_objects; from_ndjson_single_object; from_ndjson_invalid_object; from_jsonl_multiple_objects; from_jsonl_single_object; from_jsonl_invalid_object; to_ndjson_multiple_objects; to_ndjson_single_object; to_jsonl_multiple_objects; to_jsonl_single_object; from_ndnuon_multiple_objects; from_ndnuon_single_object; from_ndnuon_invalid_object; to_ndnuon_multiple_objects; to_ndnuon_single_object; to_ndnuon_multiline_strings; from_ndnuon_multiline_strings; print 'OK: 35 nu-std tests passed'\"",
    cwd: "/workspace",
    env: Object.freeze(["HOME=/tmp"]),
  }),
  "go-raft-nodice": Object.freeze({
    id: "go-raft-nodice",
    label: "Go: Raft (nodice)",
    language: "Go",
    image: "ghcr.io/fatlotus/golang-with-cache:1.27-alpine",
    repo: "fatlotus/nodice",
    ref: "",
    mountPath: "/workspace",
    build: "go build",
    cmd: "./raft",
    cwd: "/workspace/example",
    env: Object.freeze([]),
  }),
});

// Primary DOM elements
const imageInput = document.getElementById("image-input");
const buildCmdInput = document.getElementById("build-cmd-input");
const cmdInput = document.getElementById("cmd-input");
const repoInput = document.getElementById("repo-input");
const repoRefInput = document.getElementById("repo-ref-input");
const repoMountInput = document.getElementById("repo-mount-input");
const delayStddevField = document.getElementById("delay-stddev-field");
const delayStddevInput = document.getElementById("delay-stddev-input");
const delaySeedInput = document.getElementById("delay-seed-input");
const sweepModeToggle = document.getElementById("sweep-mode-toggle");
const sweepParamsGrid = document.getElementById("sweep-params-grid");
const sweepRunsInput = document.getElementById("sweep-runs-input");
const sweepStddevStartInput = document.getElementById("sweep-stddev-start-input");
const sweepStddevStepInput = document.getElementById("sweep-stddev-step-input");
const sweepPanel = document.getElementById("sweep-panel");
const sweepOutcomeBadge = document.getElementById("sweep-outcome-badge");
const sweepBuildStatus = document.getElementById("sweep-build-status");
const sweepProgressText = document.getElementById("sweep-progress-text");
const copySweepLinkBtn = document.getElementById("copy-sweep-link-btn");
const sweepResultsBody = document.getElementById("sweep-results-body");
const envInput = document.getElementById("env-input");
const cwdInput = document.getElementById("cwd-input");
const advancedOptionsEl = document.getElementById("advanced-options");
const startBtn = document.getElementById("start-btn");
const stopBtn = document.getElementById("stop-btn");
const clearBtn = document.getElementById("clear-btn");
const statusPill = document.getElementById("status-pill");
const statusText = document.getElementById("status-text");
const progressBar = document.getElementById("progress-bar");
const progressFill = document.getElementById("progress-fill");
const terminalEl = document.getElementById("terminal");
const terminalTitleEl = document.getElementById("terminal-title");
const terminalSizeEl = document.getElementById("terminal-size");
const presetChips = Array.from(document.querySelectorAll(".preset-chip"));
const projectPresetChips = Array.from(document.querySelectorAll(".project-preset-chip"));
const stageStepEls = {
  pull: document.querySelector('.stage-step[data-step="pull"]'),
  unpack: document.querySelector('.stage-step[data-step="unpack"]'),
  compile: document.querySelector('.stage-step[data-step="compile"]'),
  run: document.querySelector('.stage-step[data-step="run"]'),
};

// Manual upload drawer DOM elements
const manualFileInput = document.getElementById("manual-file-input");
const manualUploadPath = document.getElementById("manual-upload-path");
const manualCmdInput = document.getElementById("manual-cmd-input");
const manualRunBtn = document.getElementById("manual-run-btn");
const manualClearBtn = document.getElementById("manual-clear-btn");
const manualVfsSummary = document.getElementById("manual-vfs-summary");
const manualVfsList = document.getElementById("manual-vfs-list");

// Runtime state
let dockerPromise = null;
let activeContainer = null;
let activeAbortController = null;
let containerExited = true;
let sessionSeq = 0;

// Sweep UI state
const MAX_CAPTURED_STREAM_CHARS = 256 * 1024;
let selectedRunIndex = null;
let sweepRunRecords = new Map();
let sweepRowEls = new Map();
let sweepBaseState = null;
let userPinnedRun = false;
let activeSweepRunIndex = null;

// Manual upload state
let stagedTarball = null; // { name: string, bytes: Uint8Array } | null
const manualVfs = {
  files: new Map(),
  symlinks: new Map(),
};
let manualUploadQueue = Promise.resolve();
let manualWasmCache = null;

// Initialize interactive VT100 terminal widget
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

/**
 * Lazily initialize and reuse a single worker-backed Elf2WasmDocker instance
 * so the compiled WASM moduleCache stays warm across restarts & image switches.
 */
async function getDocker() {
  if (dockerPromise) {
    try {
      const existing = await dockerPromise;
      if (existing && existing.isAlive) {
        return existing;
      }
    } catch {
      // Fall through to recreate a fresh instance
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
          if (dockerPromise === pending) {
            dockerPromise = null;
          }
        });
      }
      return docker;
    })
    .catch((err) => {
      if (dockerPromise === pending) {
        dockerPromise = null;
      }
      throw err;
    });
  dockerPromise = pending;
  return await pending;
}

function setStatus(message, state = "idle") {
  statusText.textContent = message;
  statusPill.dataset.state = state;
  progressBar.dataset.state = state;
}

function setProgress(percent, stage = "idle") {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  progressBar.setAttribute("aria-valuenow", String(clamped));
  progressBar.dataset.stage = stage;
  progressFill.style.width = `${clamped}%`;
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

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
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
      const pct = 15 + overall * 40; // 15% -> 55%
      const sizeNote =
        total > 0 ? ` (${formatBytes(loaded)} / ${formatBytes(total)})` : loaded > 0 ? ` (${formatBytes(loaded)})` : "";
      setProgress(pct, "download");
      setStatus(`Downloading layer ${layerIdx + 1}/${layerCount}${sizeNote}...`, "busy");
      break;
    }
    case "decompress": {
      const overall = (layerIdx + 0.5) / layerCount;
      const pct = 55 + overall * 13; // 55% -> 68%
      setProgress(pct, "decompress");
      setStatus(`Decompressing layer ${layerIdx + 1}/${layerCount} in browser...`, "busy");
      break;
    }
    case "ready":
      // Note: Do NOT say "ready" yet — rootfs unpack and WASM compilation still follow.
      setProgress(70, "ready");
      setStatus("Unpacking rootfs in browser...", "busy");
      break;
    case "extract": {
      const overall = (layerIdx + 0.5) / layerCount;
      const pct = 70 + overall * 12; // 70% -> 82%
      setProgress(pct, "extract");
      setStatus(`Unpacking rootfs layer ${layerIdx + 1}/${layerCount} in browser...`, "busy");
      break;
    }
    case "git-download": {
      const frac = total > 0 ? Math.min(1, loaded / total) : loaded > 0 ? 0.5 : 0;
      const pct = 82 + frac * 4; // 82% -> 86%
      const sizeNote =
        total > 0 ? ` (${formatBytes(loaded)} / ${formatBytes(total)})` : loaded > 0 ? ` (${formatBytes(loaded)})` : "";
      const baseMsg = (ev.message || "Downloading git repository").replace(/\.+$/, "");
      setProgress(pct, "git-download");
      setStatus(`${baseMsg}${sizeNote}...`, "busy");
      break;
    }
    case "git-decompress":
      setProgress(87, "git-decompress");
      setStatus(ev.message || "Decompressing git repository in browser...", "busy");
      break;
    case "git-overlay": {
      const pct = total > 0 && loaded >= total ? 89 : 88;
      setProgress(pct, "git-overlay");
      setStatus(ev.message || "Overlaying git repository onto container VFS...", "busy");
      break;
    }
    case "compile":
      setProgress(90, "compile");
      setStatus("Compiling ELF → WASM in browser...", "busy");
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
      if (ev.message) {
        setStatus(ev.message, "busy");
      }
      break;
  }
}

/**
 * Shell-like argument tokenizer supporting single quotes, double quotes, and backslash escapes.
 */
function splitShellArgs(str) {
  const args = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let hasToken = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        current += ch;
      }
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
  if (hasToken) {
    args.push(current);
  }
  return args;
}

function parseShellCommand(str) {
  const raw = String(str ?? "").trim();
  if (!raw) return [];

  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === "\\" && i + 1 < raw.length) {
        i++;
      } else if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (ch === "\\" && i + 1 < raw.length) {
      i++;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    const next = i + 1 < raw.length ? raw[i + 1] : "";
    if (
      ch === ";" ||
      ch === "|" ||
      ch === ">" ||
      ch === "<" ||
      ch === "\n" ||
      ch === "\r" ||
      ch === "`" ||
      (ch === "&" && next === "&") ||
      (ch === "$" && next === "(")
    ) {
      return ["/bin/sh", "-c", raw];
    }
  }
  return splitShellArgs(raw);
}

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
      // Ignore errors when stopping an already-exited container
    }
  }

  if (updateUi) {
    stopBtn.disabled = true;
    startBtn.disabled = false;
    setProgress(0, "idle");
    setStatus("Stopped", "idle");
    if (sweepOutcomeBadge && sweepOutcomeBadge.dataset.outcome === "running") {
      sweepOutcomeBadge.dataset.outcome = "idle";
      sweepOutcomeBadge.textContent = "Stopped";
    }
    if (
      sweepBuildStatus &&
      (sweepBuildStatus.textContent === "Build: running..." ||
        sweepBuildStatus.textContent === "Build: pending")
    ) {
      sweepBuildStatus.textContent = "Build: stopped";
    }
    for (const rowEl of sweepRowEls.values()) {
      const pill = rowEl.querySelector('.run-status-pill[data-status="running"]');
      if (pill) {
        pill.dataset.status = "stopped";
        pill.textContent = "stopped";
        const cells = rowEl.querySelectorAll("td");
        if (cells[4] && cells[4].textContent === "…") {
          cells[4].textContent = "—";
        }
        if (cells[5] && cells[5].textContent === "…") {
          cells[5].textContent = "—";
        }
      }
    }
  }
}

function formatVirtualTime(ns) {
  if (!Number.isFinite(ns) || ns <= 0) return "0 ms";
  if (ns < 1_000_000) return `${Math.round(ns / 1000)} µs`;
  if (ns < 1_000_000_000) return `${(ns / 1e6).toFixed(1)} ms`;
  return `${(ns / 1e9).toFixed(2)} s`;
}

function capCapturedText(text) {
  const s = typeof text === "string" ? text : "";
  if (s.length <= MAX_CAPTURED_STREAM_CHARS) return s;
  return `${s.slice(0, MAX_CAPTURED_STREAM_CHARS)}\n... [truncated]`;
}

function resolveGitRepoFromOption(gitRepo) {
  if (gitRepo === null) {
    return undefined;
  }
  if (gitRepo && typeof gitRepo === "object") {
    const repoVal = String(gitRepo.repo || "").trim();
    if (repoVal) {
      return {
        repo: repoVal,
        ref: String(gitRepo.ref || "").trim() || "HEAD",
        mountPath: String(gitRepo.mountPath || "").trim() || "/workspace",
      };
    }
    return undefined;
  }
  const rawRepo = repoInput ? repoInput.value.trim() : "";
  const rawRef = repoRefInput ? repoRefInput.value.trim() : "";
  const rawMount = repoMountInput ? repoMountInput.value.trim() : "";
  if (rawRepo) {
    return {
      repo: rawRepo,
      ref: rawRef || "HEAD",
      mountPath: rawMount || "/workspace",
    };
  }
  return undefined;
}

function resolveDefaultImageCmd(imageConfig) {
  const ep = Array.isArray(imageConfig?.entrypoint) ? imageConfig.entrypoint : [];
  const cmd = Array.isArray(imageConfig?.cmd) ? imageConfig.cmd : [];
  const combined = [...ep, ...cmd].filter((s) => typeof s === "string" && s.length > 0);
  return combined.length > 0 ? combined : ["/bin/sh"];
}

function parseNonNegFloatOr(raw, fallback, max = MAX_STDDEV_MS) {
  const s = String(raw ?? "").trim();
  if (!s) return fallback;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return fallback;
  const clamped = Math.round(Math.min(n, max) * 1000) / 1000;
  return clamped === 0 ? 0 : clamped;
}

function parseNonNegIntOr(raw, fallback, min = 0, max = MAX_SEED) {
  const s = String(raw ?? "").trim();
  if (!s) return fallback;
  const n = Number(s);
  if (!Number.isFinite(n) || n < min) return fallback;
  const f = Math.floor(Math.min(n, max));
  return f >= min ? (f === 0 ? 0 : f) : fallback;
}

async function bootImage({
  imageRef,
  tarball = null,
  buildCmdStr = null,
  cmdStr = null,
  envList = null,
  cwd = null,
  gitRepo = undefined,
  delayStddevMs = null,
  delaySeed = null,
}) {
  const seq = ++sessionSeq;

  // Snapshot all form controls synchronously before any await so clicking a preset
  // or editing fields mid-pull cannot corrupt this in-flight boot.
  const rawBuild = buildCmdStr !== null ? buildCmdStr : (buildCmdInput ? buildCmdInput.value.trim() : "");
  const buildCmdTokens = rawBuild ? parseShellCommand(rawBuild) : [];
  const rawCmd = cmdStr !== null ? cmdStr : cmdInput.value.trim();
  const cmdTokens = rawCmd ? parseShellCommand(rawCmd) : [];
  const envEntries = envList !== null ? envList : parseEnvLines(envInput.value);
  const workdir = cwd !== null ? cwd : cwdInput.value.trim();
  const resolvedGitRepo = resolveGitRepoFromOption(gitRepo);

  const effStddev =
    delayStddevMs !== null
      ? parseNonNegFloatOr(delayStddevMs, 0)
      : parseNonNegFloatOr(delayStddevInput?.value, 0);
  const effSeed =
    delaySeed !== null
      ? parseNonNegIntOr(delaySeed, 0)
      : parseNonNegIntOr(delaySeedInput?.value, 0);
  const hasDelay = effStddev > 0 || effSeed > 0;

  // Cancel any in-flight pull and cleanly stop any previous container
  await stopActiveSession({ updateUi: false });
  if (seq !== sessionSeq) return;

  clearSweepResults();
  if (sweepPanel) {
    sweepPanel.hidden = true;
  }

  const abortController = new AbortController();
  activeAbortController = abortController;

  stopBtn.disabled = false;
  startBtn.disabled = true;
  terminal.reset();
  setProgress(3, "manifest");

  let sawStderr = false;
  let resolvedDisplayName = tarball ? tarball.name : imageRef;

  try {
    const docker = await getDocker();
    if (seq !== sessionSeq) return;

    let image;
    if (tarball) {
      setStatus(`Loading local tarball ${tarball.name} in browser...`, "busy");
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
      let parsed;
      try {
        parsed = parseImageRef(imageRef);
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
    let imageDefaultCmd = ["/bin/sh"];
    try {
      if (seq !== sessionSeq) return;

      const { cols, rows } = terminal.getSize();
      imageDefaultCmd = resolveDefaultImageCmd(image.config);

      const displayCmd =
        cmdTokens.length > 0
          ? cmdTokens.join(" ")
          : (image.config?.cmd && image.config.cmd.join(" ")) ||
            (image.config?.entrypoint && image.config.entrypoint.join(" ")) ||
            "/bin/sh";
      if (terminalTitleEl) {
        const repoSuffix = resolvedGitRepo
          ? ` + ${resolvedGitRepo.repo}@${resolvedGitRepo.ref}`
          : "";
        const cmdSummary = buildCmdTokens.length > 0 ? `${rawBuild} && ${displayCmd}` : displayCmd;
        terminalTitleEl.textContent = `${resolvedDisplayName}${repoSuffix} — ${cmdSummary}`;
      }

      if (buildCmdTokens.length > 0) {
        container = await image.createContainer({
          env: envEntries.length > 0 ? envEntries : undefined,
          cwd: workdir || undefined,
          gitRepo: resolvedGitRepo,
          tty: false,
          stdin: "",
          signal: abortController.signal,
          onProgress: (ev) => {
            if (seq === sessionSeq) handleProgressEvent(ev);
          },
        });
      } else {
        container = await image.createContainer({
          cmd: cmdTokens.length > 0 ? cmdTokens : undefined,
          env: envEntries.length > 0 ? envEntries : undefined,
          cwd: workdir || undefined,
          gitRepo: resolvedGitRepo,
          tty: true,
          cols,
          rows,
          ...(hasDelay ? { delayStddevMs: effStddev, delaySeed: effSeed } : {}),
          signal: abortController.signal,
          onProgress: (ev) => {
            if (seq === sessionSeq) handleProgressEvent(ev);
          },
        });
      }
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
        // Ignore cleanup error
      }
      return;
    }

    activeContainer = container;
    containerExited = false;

    if (buildCmdTokens.length > 0) {
      setProgress(91, "build");
      setStatus(`Building: ${rawBuild}...`, "busy");
      terminal.write(`[build] ${rawBuild}\r\n`);

      const buildRes = await container.exec({
        cmd: buildCmdTokens,
        cwd: workdir || undefined,
        env: envEntries.length > 0 ? envEntries : undefined,
        tty: false,
        stdin: "",
        delayStddevMs: 0,
        delaySeed: 0,
        signal: abortController.signal,
        onStdout: (chunk) => {
          if (seq === sessionSeq) terminal.write(chunk);
        },
        onStderr: (chunk) => {
          if (seq === sessionSeq) {
            sawStderr = true;
            terminal.write(chunk);
          }
        },
      });
      if (seq !== sessionSeq) return;

      if (buildRes.exitCode !== 0 || buildRes.error || buildRes.timedOut) {
        if (buildRes.error && !sawStderr) {
          terminal.write(`\r\n[build] Error: ${buildRes.error}\r\n`);
        }
        if (typeof terminal._renderNow === "function") {
          terminal._renderNow();
        }
        containerExited = true;
        activeContainer = null;
        activeAbortController = null;
        stopBtn.disabled = true;
        startBtn.disabled = false;
        setProgress(100, "build");
        setStatus(`Build failed (exit ${buildRes.exitCode})`, "error");
        void container.stop().catch(() => {});
        return;
      }

      sawStderr = false;
      const effectiveRunCmd = cmdTokens.length > 0 ? cmdTokens : imageDefaultCmd;
      const delayNote = hasDelay ? ` (stddev=${effStddev}ms, seed=${effSeed})` : "";
      setProgress(95, "run");
      setStatus(`Running${delayNote}...`, "busy");
      terminal.write(`\r\n[run] ${effectiveRunCmd.join(" ")}${delayNote}\r\n`);

      const runRes = await container.exec({
        cmd: effectiveRunCmd,
        cwd: workdir || undefined,
        env: envEntries.length > 0 ? envEntries : undefined,
        tty: false,
        stdin: "",
        delayStddevMs: hasDelay ? effStddev : 0,
        delaySeed: hasDelay ? effSeed : 0,
        signal: abortController.signal,
        onStdout: (chunk) => {
          if (seq === sessionSeq) terminal.write(chunk);
        },
        onStderr: (chunk) => {
          if (seq === sessionSeq) {
            sawStderr = true;
            terminal.write(chunk);
          }
        },
      });
      if (seq !== sessionSeq) return;

      if (runRes.error && !sawStderr) {
        terminal.write(`\r\n[run] Error: ${runRes.error}\r\n`);
      }

      if (typeof terminal._renderNow === "function") {
        terminal._renderNow();
      }
      containerExited = true;
      activeContainer = null;
      activeAbortController = null;
      stopBtn.disabled = true;
      startBtn.disabled = false;
      setProgress(100, "run");
      setStatus(`Exited (code ${runRes.exitCode})`, runRes.exitCode === 0 ? "idle" : "error");
      void container.stop().catch(() => {});
      return;
    }

    // Register stdout, stderr, and exit handlers BEFORE container.start()
    container.onStdout((chunk) => {
      if (seq !== sessionSeq) return;
      terminal.write(chunk);
    });

    container.onStderr((chunk) => {
      if (seq !== sessionSeq) return;
      sawStderr = true;
      terminal.write(chunk);
    });

    container.onExit((exitCode) => {
      if (seq !== sessionSeq) return;
      if (typeof terminal._renderNow === "function") {
        terminal._renderNow();
      }
      containerExited = true;
      activeContainer = null;
      activeAbortController = null;
      stopBtn.disabled = true;
      startBtn.disabled = false;
      setStatus(`Exited (code ${exitCode})`, exitCode === 0 ? "idle" : "error");
      void container.stop().catch(() => {});
    });

    await container.start();
    if (seq !== sessionSeq) return;

    activeAbortController = null;
    startBtn.disabled = false;
    stopBtn.disabled = containerExited;
    if (!containerExited) {
      setProgress(100, "run");
      setStatus("Running — Interactive shell ready", "running");
      terminal.focus();
    }
  } catch (err) {
    if (seq !== sessionSeq || err?.name === "AbortError") {
      return;
    }
    const leakedContainer = activeContainer;
    activeAbortController = null;
    activeContainer = null;
    containerExited = true;
    if (leakedContainer) {
      void leakedContainer.stop().catch(() => {});
    }
    stopBtn.disabled = true;
    startBtn.disabled = false;
    const msg = err?.message || String(err);
    setStatus(`Error: ${msg}`, "error");
    if (!sawStderr) {
      terminal.write(`\r\n[elf2wasm] Error: ${msg}\r\n`);
    }
  }
}

function selectSweepRun(index, { syncUrl = true } = {}) {
  const record = sweepRunRecords.get(index);
  selectedRunIndex = index;

  for (const [idx, rowEl] of sweepRowEls.entries()) {
    rowEl.dataset.selected = idx === index ? "true" : "false";
  }

  if (record) {
    terminal.reset();
    terminal.write(
      `[sweep run #${record.index}] stddev=${record.stddevMs}ms, seed=${record.seed}, status=${record.status}, exit=${record.exitCode}, virtual=${formatVirtualTime(record.virtualTimeNs)}\r\n`
    );
    if (record.stdout) {
      terminal.write(record.stdout);
    }
    if (record.stderr) {
      if (record.stdout && !record.stdout.endsWith("\n")) {
        terminal.write("\r\n");
      }
      terminal.write(record.stderr);
    }
    if (record.error) {
      terminal.write(`\r\n[error] ${record.error}\r\n`);
    }
    if (typeof terminal._renderNow === "function") {
      terminal._renderNow();
    }
    if (terminalTitleEl && sweepBaseState) {
      terminalTitleEl.textContent = `${sweepBaseState.image} — Run #${record.index} (stddev=${record.stddevMs}ms, seed=${record.seed})`;
    }
  }

  if (syncUrl) {
    syncUrlFromControls({ push: false });
  }
}

function createSweepRowElement(index, stddevMs, seed, runHref) {
  const tr = document.createElement("tr");
  tr.dataset.runIndex = String(index);
  tr.dataset.selected = "false";

  const tdIndex = document.createElement("td");
  tdIndex.textContent = String(index);

  const tdStddev = document.createElement("td");
  tdStddev.textContent = String(stddevMs);

  const tdSeed = document.createElement("td");
  tdSeed.textContent = String(seed);

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

  const tdLink = document.createElement("td");
  const link = document.createElement("a");
  link.className = "run-link";
  link.setAttribute("href", runHref);
  link.textContent = "Open run";
  link.addEventListener("click", (e) => {
    e.stopPropagation();
  });
  tdLink.appendChild(link);

  tr.append(tdIndex, tdStddev, tdSeed, tdStatus, tdExit, tdTime, tdLink);
  tr.addEventListener("click", () => {
    userPinnedRun = true;
    selectSweepRun(index, { syncUrl: true });
  });

  return { tr, statusBadge, tdExit, tdTime };
}

async function runSweepFromControls(state) {
  const buildCmdTokens = state.build ? parseShellCommand(state.build) : [];
  const runCmdTokens = state.cmd ? parseShellCommand(state.cmd) : [];
  if (runCmdTokens.length === 0) {
    setStatus("Error: Sweep mode requires a Run Command", "error");
    cmdInput.focus();
    return;
  }

  const seq = ++sessionSeq;
  await stopActiveSession({ updateUi: false });
  if (seq !== sessionSeq) return;

  const abortController = new AbortController();
  activeAbortController = abortController;
  containerExited = false;

  stopBtn.disabled = false;
  startBtn.disabled = true;
  terminal.reset();
  setProgress(3, "manifest");

  const maxSweepSeedStart = Math.max(0, MAX_SEED - Math.max(0, state.runs - 1));
  const effectiveSeedStart = Math.min(state.seed, maxSweepSeedStart);

  sweepRunRecords.clear();
  sweepRowEls.clear();
  const rowRefs = new Map();
  userPinnedRun = false;
  activeSweepRunIndex = null;
  const runBaseState = { ...state, seed: effectiveSeedStart };
  sweepBaseState = runBaseState;

  if (sweepResultsBody) {
    sweepResultsBody.textContent = "";
  }
  if (sweepPanel) {
    sweepPanel.hidden = false;
  }
  if (sweepOutcomeBadge) {
    sweepOutcomeBadge.dataset.outcome = "running";
    sweepOutcomeBadge.textContent = "Running";
  }
  if (sweepBuildStatus) {
    sweepBuildStatus.textContent =
      buildCmdTokens.length > 0 ? "Build: pending" : "Build: skipped";
  }
  if (sweepProgressText) {
    sweepProgressText.textContent = `0 / ${state.runs} runs`;
  }

  const resolvedGitRepo = state.repo
    ? {
        repo: state.repo,
        ref: state.ref || "HEAD",
        mountPath: state.mount || "/workspace",
      }
    : undefined;

  if (terminalTitleEl) {
    const repoSuffix = resolvedGitRepo
      ? ` + ${resolvedGitRepo.repo}@${resolvedGitRepo.ref}`
      : "";
    terminalTitleEl.textContent = `${state.image}${repoSuffix} — Sweep (${state.runs} runs)`;
  }

  try {
    const docker = await getDocker();
    if (seq !== sessionSeq) return;

    const result = await runSweep(state.image, {
      docker,
      platform: "linux/amd64",
      buildCmd: buildCmdTokens.length > 0 ? buildCmdTokens : undefined,
      runCmd: runCmdTokens,
      runs: state.runs,
      stddevStart: state.stddevStart,
      stddevStep: state.stddevStep,
      seedStart: effectiveSeedStart,
      stopOnFailure: true,
      cwd: state.cwd || undefined,
      env: state.env.length > 0 ? state.env : undefined,
      gitRepo: resolvedGitRepo,
      signal: abortController.signal,
      onProgress: (ev) => {
        if (seq === sessionSeq) handleProgressEvent(ev);
      },
      onBuildOutput: ({ chunk }) => {
        if (seq !== sessionSeq) return;
        if (sweepBuildStatus) {
          sweepBuildStatus.textContent = "Build: running...";
        }
        terminal.write(chunk);
      },
      onRunStart: ({ index, totalRuns, stddevMs, seed }) => {
        if (seq !== sessionSeq) return;
        if (
          sweepBuildStatus &&
          buildCmdTokens.length > 0 &&
          sweepBuildStatus.textContent !== "Build: passed (exit 0)"
        ) {
          sweepBuildStatus.textContent = "Build: passed (exit 0)";
        }
        const computed = computeSweepRunParams(runBaseState, index);
        const effStddev = Number.isFinite(stddevMs) ? stddevMs : computed.stddev;
        const effSeed =
          typeof seed === "bigint" ? seed : Number.isFinite(seed) ? seed : computed.seed;
        const runSearch = buildRunSearch(
          runBaseState,
          { stddev: effStddev, seed: effSeed },
          { existingSearch: window.location.search }
        );
        const runHref = `${window.location.pathname}${runSearch}`;
        const rowRef = createSweepRowElement(index, effStddev, effSeed, runHref);
        rowRefs.set(index, rowRef);
        sweepRowEls.set(index, rowRef.tr);
        sweepResultsBody?.appendChild(rowRef.tr);

        activeSweepRunIndex = index;
        if (!userPinnedRun) {
          terminal.reset();
          terminal.write(
            `[sweep run #${index}/${totalRuns}] stddev=${effStddev}ms, seed=${effSeed}\r\n`
          );
        }
      },
      onRunOutput: ({ index, chunk }) => {
        if (seq !== sessionSeq) return;
        if (
          (!userPinnedRun && activeSweepRunIndex === index) ||
          (userPinnedRun && selectedRunIndex === index && activeSweepRunIndex === index)
        ) {
          terminal.write(chunk);
        }
      },
      onRunComplete: (runResult) => {
        if (seq !== sessionSeq) return;
        const capped = {
          ...runResult,
          stdout: capCapturedText(runResult.stdout),
          stderr: capCapturedText(runResult.stderr),
        };
        sweepRunRecords.set(runResult.index, capped);

        const rowRef = rowRefs.get(runResult.index);
        if (rowRef) {
          const statusStr = String(runResult.status || (runResult.exitCode === 0 ? "pass" : "fail"));
          rowRef.statusBadge.dataset.status = statusStr;
          rowRef.statusBadge.textContent = statusStr;
          rowRef.tdExit.textContent = String(runResult.exitCode);
          rowRef.tdTime.textContent = formatVirtualTime(runResult.virtualTimeNs);
        }
        if (sweepProgressText) {
          sweepProgressText.textContent = `${sweepRunRecords.size} / ${state.runs} runs`;
        }
        if (userPinnedRun && selectedRunIndex === runResult.index) {
          selectSweepRun(runResult.index, { syncUrl: false });
        }
      },
    });

    if (seq !== sessionSeq) return;

    activeAbortController = null;
    containerExited = true;
    stopBtn.disabled = true;
    startBtn.disabled = false;

    const buildFailed =
      !result.build.skipped &&
      (result.build.exitCode !== 0 || Boolean(result.build.error) || Boolean(result.build.timedOut));

    if (sweepBuildStatus) {
      if (result.build.skipped) {
        sweepBuildStatus.textContent = "Build: skipped";
      } else if (buildFailed) {
        sweepBuildStatus.textContent = `Build: failed (exit ${result.build.exitCode})`;
      } else {
        sweepBuildStatus.textContent = "Build: passed (exit 0)";
      }
    }

    if (sweepProgressText) {
      sweepProgressText.textContent = `${result.runs.length} / ${state.runs} runs`;
    }

    if (buildFailed) {
      if (sweepOutcomeBadge) {
        sweepOutcomeBadge.dataset.outcome = "fail";
        sweepOutcomeBadge.textContent = "Build Failed";
      }
      setProgress(100, "build");
      setStatus(`Build failed (exit ${result.build.exitCode})`, "error");
    } else if (result.failedRun) {
      if (sweepOutcomeBadge) {
        sweepOutcomeBadge.dataset.outcome = "fail";
        sweepOutcomeBadge.textContent = `Failed (#${result.failedRun.index})`;
      }
      setProgress(100, "run");
      setStatus(
        `Sweep failed on run #${result.failedRun.index} (stddev=${result.failedRun.stddevMs}ms, seed=${result.failedRun.seed}, exit=${result.failedRun.exitCode})`,
        "error"
      );
    } else {
      if (sweepOutcomeBadge) {
        sweepOutcomeBadge.dataset.outcome = "pass";
        sweepOutcomeBadge.textContent = "Passed";
      }
      setProgress(100, "run");
      setStatus(`Sweep passed (${result.runs.length}/${state.runs} runs)`, "idle");
    }

    const hadStaleSelectedRun =
      selectedRunIndex !== null && !sweepRunRecords.has(selectedRunIndex);
    if (selectedRunIndex !== null && sweepRunRecords.has(selectedRunIndex)) {
      selectSweepRun(selectedRunIndex, { syncUrl: false });
    } else if (result.runs.length === 0) {
      if (hadStaleSelectedRun) {
        selectedRunIndex = null;
        syncUrlFromControls({ push: false });
      }
    } else if ((!userPinnedRun || hadStaleSelectedRun) && result.failedRun) {
      selectSweepRun(result.failedRun.index, { syncUrl: hadStaleSelectedRun });
    } else if ((!userPinnedRun || hadStaleSelectedRun) && result.runs.length > 0) {
      selectSweepRun(result.runs[result.runs.length - 1].index, {
        syncUrl: hadStaleSelectedRun,
      });
    }
  } catch (err) {
    if (seq !== sessionSeq) return;
    activeAbortController = null;
    containerExited = true;
    stopBtn.disabled = true;
    startBtn.disabled = false;

    if (err?.name === "AbortError") {
      if (sweepOutcomeBadge) {
        sweepOutcomeBadge.dataset.outcome = "idle";
        sweepOutcomeBadge.textContent = "Stopped";
      }
      if (
        sweepBuildStatus &&
        (sweepBuildStatus.textContent === "Build: running..." ||
          sweepBuildStatus.textContent === "Build: pending")
      ) {
        sweepBuildStatus.textContent = "Build: stopped";
      }
      return;
    }

    const msg = err?.message || String(err);
    if (sweepOutcomeBadge) {
      sweepOutcomeBadge.dataset.outcome = "fail";
      sweepOutcomeBadge.textContent = "Error";
    }
    if (
      sweepBuildStatus &&
      (sweepBuildStatus.textContent === "Build: running..." ||
        sweepBuildStatus.textContent === "Build: pending")
    ) {
      sweepBuildStatus.textContent = "Build: error";
    }
    for (const rowEl of sweepRowEls.values()) {
      const pill = rowEl.querySelector('.run-status-pill[data-status="running"]');
      if (pill) {
        pill.dataset.status = "error";
        pill.textContent = "error";
        const cells = rowEl.querySelectorAll("td");
        if (cells[4] && cells[4].textContent === "…") {
          cells[4].textContent = "—";
        }
        if (cells[5] && cells[5].textContent === "…") {
          cells[5].textContent = "—";
        }
      }
    }
    setStatus(`Error: ${msg}`, "error");
    terminal.write(`\r\n[elf2wasm] Sweep error: ${msg}\r\n`);
  }
}

let isHydrating = false;

function readStateFromControls() {
  const sweep = Boolean(sweepModeToggle?.checked);
  const runs = parseNonNegIntOr(
    sweepRunsInput?.value,
    DEFAULT_UI_STATE.runs,
    1,
    MAX_SWEEP_RUNS
  );
  return {
    image: imageInput.value.trim() || DEFAULT_UI_STATE.image,
    build: buildCmdInput ? buildCmdInput.value.trim() : "",
    cmd: cmdInput.value.trim(),
    repo: repoInput ? repoInput.value.trim() : "",
    ref: repoRefInput ? repoRefInput.value.trim() : "",
    mount: (repoMountInput ? repoMountInput.value.trim() : "") || DEFAULT_UI_STATE.mount,
    cwd: cwdInput.value.trim(),
    env: parseEnvLines(envInput.value),
    stddev: parseNonNegFloatOr(delayStddevInput?.value, DEFAULT_UI_STATE.stddev, MAX_STDDEV_MS),
    seed: parseNonNegIntOr(delaySeedInput?.value, DEFAULT_UI_STATE.seed, 0, MAX_SEED),
    sweep,
    runs,
    stddevStart: parseNonNegFloatOr(
      sweepStddevStartInput?.value,
      DEFAULT_UI_STATE.stddevStart,
      MAX_STDDEV_MS
    ),
    stddevStep: parseNonNegFloatOr(
      sweepStddevStepInput?.value,
      DEFAULT_UI_STATE.stddevStep,
      MAX_STDDEV_MS
    ),
    selectedRun:
      sweep && selectedRunIndex !== null && selectedRunIndex >= 1 && selectedRunIndex <= runs
        ? selectedRunIndex
        : null,
  };
}

function setActiveProjectPreset(activePresetId) {
  for (const c of projectPresetChips) {
    c.dataset.active = activePresetId && c.dataset.preset === activePresetId ? "true" : "false";
  }
}

function updateSweepModeUi(state) {
  const isSweep = Boolean(state.sweep);
  if (startBtn) {
    startBtn.textContent = isSweep ? "Run Sweep" : "Start Shell";
  }
  if (sweepParamsGrid) {
    sweepParamsGrid.hidden = !isSweep;
  }
  if (delayStddevField) {
    delayStddevField.dataset.dimmed = isSweep ? "true" : "false";
  }
  if (sweepPanel) {
    sweepPanel.hidden = !isSweep && sweepRunRecords.size === 0;
  }
  if (sweepProgressText && sweepRunRecords.size === 0) {
    sweepProgressText.textContent = `0 / ${state.runs} runs`;
  }
}

function updateIdleDisplayFromState(state) {
  if (activeContainer || activeAbortController || !containerExited) {
    return;
  }
  if (statusText && statusPill?.dataset.state === "idle") {
    statusText.textContent = state.sweep
      ? `Idle — click Run Sweep to sweep ${state.image} (${state.runs} runs)`
      : `Idle — click Start Shell to boot ${state.image}`;
  }
  if (terminalTitleEl) {
    const repoSuffix = state.repo ? ` + ${state.repo}@${state.ref || "HEAD"}` : "";
    const displayCmd = state.cmd || "/bin/sh";
    const cmdSummary = state.build ? `${state.build} && ${displayCmd}` : displayCmd;
    terminalTitleEl.textContent = `${state.image}${repoSuffix} — ${cmdSummary}`;
  }
}

function syncUrlFromControls({ push = false } = {}) {
  if (isHydrating) return;
  const nextSearch = serializeStateToSearch(readStateFromControls(), {
    existingSearch: window.location.search,
  });
  if (nextSearch === window.location.search) return;
  const nextUrl = `${window.location.pathname}${nextSearch}${window.location.hash}`;
  try {
    if (push) {
      window.history.pushState(null, "", nextUrl);
    } else {
      window.history.replaceState(null, "", nextUrl);
    }
  } catch {
    // Ignore History API errors in restricted environments
  }
}

function applyStateToControls(state, activePresetId) {
  isHydrating = true;
  try {
    imageInput.value = state.image;
    if (buildCmdInput) buildCmdInput.value = state.build || "";
    cmdInput.value = state.cmd;
    if (repoInput) repoInput.value = state.repo;
    if (repoRefInput) repoRefInput.value = state.ref;
    if (repoMountInput) repoMountInput.value = state.mount;
    cwdInput.value = state.cwd;
    envInput.value = state.env.join("\n");
    if (delayStddevInput) delayStddevInput.value = String(state.stddev ?? DEFAULT_UI_STATE.stddev);
    if (delaySeedInput) delaySeedInput.value = String(state.seed ?? DEFAULT_UI_STATE.seed);
    if (sweepModeToggle) sweepModeToggle.checked = Boolean(state.sweep);
    if (sweepRunsInput) sweepRunsInput.value = String(state.runs ?? DEFAULT_UI_STATE.runs);
    if (sweepStddevStartInput) {
      sweepStddevStartInput.value = String(state.stddevStart ?? DEFAULT_UI_STATE.stddevStart);
    }
    if (sweepStddevStepInput) {
      sweepStddevStepInput.value = String(state.stddevStep ?? DEFAULT_UI_STATE.stddevStep);
    }
    selectedRunIndex = state.sweep ? (state.selectedRun ?? null) : null;
    setActiveProjectPreset(activePresetId);
    if (advancedOptionsEl) {
      advancedOptionsEl.open = state.cwd.length > 0 || state.env.length > 0;
    }
    updateSweepModeUi(state);
    updateIdleDisplayFromState(state);
  } finally {
    isHydrating = false;
  }
}

function applyStateFromUrl() {
  const { state, activePresetId } = parseStateFromSearch(window.location.search, PROJECT_PRESETS);
  applyStateToControls(state, activePresetId);
}

async function startFromControls() {
  const imageRef = imageInput.value.trim() || DEFAULT_UI_STATE.image;
  imageInput.value = imageRef;
  const state = readStateFromControls();
  syncUrlFromControls({ push: false });
  if (state.sweep) {
    await runSweepFromControls(state);
  } else {
    await bootImage({
      imageRef,
      buildCmdStr: state.build,
      delayStddevMs: state.stddev,
      delaySeed: state.seed,
    });
  }
}

// Wire primary controls
startBtn.addEventListener("click", () => {
  void startFromControls();
});

stopBtn.addEventListener("click", () => {
  sessionSeq++;
  void stopActiveSession({ updateUi: true });
});

clearBtn.addEventListener("click", () => {
  terminal.clear();
  terminal.focus();
});

let copySweepLinkResetTimer = null;
copySweepLinkBtn?.addEventListener("click", async () => {
  const search = serializeStateToSearch(readStateFromControls(), {
    existingSearch: window.location.search,
  });
  const url = `${window.location.origin}${window.location.pathname}${search}${window.location.hash}`;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(url);
    }
  } catch {
    // Clipboard access may be denied in non-secure contexts
  }
  copySweepLinkBtn.textContent = "Copied!";
  if (copySweepLinkResetTimer !== null) {
    clearTimeout(copySweepLinkResetTimer);
  }
  copySweepLinkResetTimer = setTimeout(() => {
    copySweepLinkResetTimer = null;
    copySweepLinkBtn.textContent = "Copy Sweep Link";
  }, 1500);
});

for (const inputEl of [
  imageInput,
  buildCmdInput,
  cmdInput,
  repoInput,
  repoRefInput,
  repoMountInput,
]) {
  inputEl?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void startFromControls();
    }
  });
}

function handleControlChange() {
  if (isHydrating) return;
  const state = readStateFromControls();
  if (!state.sweep) {
    selectedRunIndex = null;
  }
  setActiveProjectPreset(matchProjectPreset(state, PROJECT_PRESETS));
  updateSweepModeUi(state);
  updateIdleDisplayFromState(state);
  syncUrlFromControls({ push: false });
}

for (const controlEl of [
  imageInput,
  buildCmdInput,
  cmdInput,
  repoInput,
  repoRefInput,
  repoMountInput,
  delayStddevInput,
  delaySeedInput,
  sweepModeToggle,
  sweepRunsInput,
  sweepStddevStartInput,
  sweepStddevStepInput,
  envInput,
  cwdInput,
]) {
  if (!controlEl) continue;
  controlEl.addEventListener("input", handleControlChange);
  controlEl.addEventListener("change", handleControlChange);
}

function clearActiveProjectPreset() {
  setActiveProjectPreset(null);
}

function clearSweepResults() {
  selectedRunIndex = null;
  sweepRunRecords.clear();
  sweepRowEls.clear();
  if (sweepResultsBody) sweepResultsBody.textContent = "";
  sweepBaseState = null;
  userPinnedRun = false;
  activeSweepRunIndex = null;
  if (sweepOutcomeBadge) {
    sweepOutcomeBadge.dataset.outcome = "idle";
    sweepOutcomeBadge.textContent = "Idle";
  }
  if (sweepBuildStatus) {
    sweepBuildStatus.textContent = "Build: —";
  }
}

function cancelActiveSessionForNavigation() {
  if (
    activeAbortController !== null ||
    activeContainer !== null ||
    sweepOutcomeBadge?.dataset?.outcome === "running"
  ) {
    sessionSeq++;
    void stopActiveSession({ updateUi: false });
    stopBtn.disabled = true;
    startBtn.disabled = false;
    setProgress(0, "idle");
    setStatus("Ready", "idle");
  }
}

function resetDelayAndSweepControls() {
  if (delayStddevInput) delayStddevInput.value = String(DEFAULT_UI_STATE.stddev);
  if (delaySeedInput) delaySeedInput.value = String(DEFAULT_UI_STATE.seed);
  if (sweepModeToggle) sweepModeToggle.checked = false;
  if (sweepRunsInput) sweepRunsInput.value = String(DEFAULT_UI_STATE.runs);
  if (sweepStddevStartInput) {
    sweepStddevStartInput.value = String(DEFAULT_UI_STATE.stddevStart);
  }
  if (sweepStddevStepInput) {
    sweepStddevStepInput.value = String(DEFAULT_UI_STATE.stddevStep);
  }
  clearSweepResults();
}

for (const chip of presetChips) {
  chip.addEventListener("click", () => {
    const img = chip.dataset.image;
    if (img) {
      cancelActiveSessionForNavigation();
      clearActiveProjectPreset();
      imageInput.value = img;
      if (buildCmdInput) buildCmdInput.value = "";
      if (repoInput) repoInput.value = "";
      if (repoRefInput) repoRefInput.value = "";
      if (repoMountInput) repoMountInput.value = "/workspace";
      cmdInput.value = "";
      cwdInput.value = "";
      envInput.value = "";
      resetDelayAndSweepControls();
      imageInput.focus();
      const nextState = readStateFromControls();
      updateSweepModeUi(nextState);
      updateIdleDisplayFromState(nextState);
      syncUrlFromControls({ push: true });
    }
  });
}

for (const chip of projectPresetChips) {
  chip.addEventListener("click", () => {
    const preset = PROJECT_PRESETS[chip.dataset.preset];
    if (!preset) return;
    cancelActiveSessionForNavigation();
    clearActiveProjectPreset();
    chip.dataset.active = "true";
    imageInput.value = preset.image;
    if (buildCmdInput) buildCmdInput.value = preset.build || "";
    if (repoInput) repoInput.value = preset.repo;
    if (repoRefInput) repoRefInput.value = preset.ref;
    if (repoMountInput) repoMountInput.value = preset.mountPath || "/workspace";
    cmdInput.value = preset.cmd;
    cwdInput.value = preset.cwd || preset.mountPath || "/workspace";
    envInput.value = Array.isArray(preset.env) ? preset.env.join("\n") : "";
    resetDelayAndSweepControls();
    startBtn.focus();
    const nextState = readStateFromControls();
    updateSweepModeUi(nextState);
    updateIdleDisplayFromState(nextState);
    syncUrlFromControls({ push: true });
  });
}

window.addEventListener("popstate", () => {
  const { state, activePresetId } = parseStateFromSearch(window.location.search, PROJECT_PRESETS);
  cancelActiveSessionForNavigation();
  clearSweepResults();
  applyStateToControls(state, activePresetId);
});

// Synchronously hydrate UI controls from URL query parameters on initial load (never auto-boot)
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
    await bootImage({
      imageRef: stagedTarball.name,
      tarball: stagedTarball,
      cmdStr: manualCmdInput?.value.trim() || "",
      gitRepo: null,
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

    if (res.stdout && res.stdout.length > 0) {
      terminal.write(res.stdout);
    }
    if (res.stderr && res.stderr.length > 0) {
      terminal.write(res.stderr);
    }
    setProgress(100, "run");
    setStatus(`Exited (code ${res.exitCode})`, res.exitCode === 0 ? "idle" : "error");
  } catch (err) {
    if (seq !== sessionSeq) return;
    const msg = err?.message || String(err);
    setStatus(`Error: ${msg}`, "error");
    terminal.write(`\r\n[elf2wasm] Error: ${msg}\r\n`);
  }
});
