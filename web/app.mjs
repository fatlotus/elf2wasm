/**
 * UI controller for the elf2wasm client-side Docker-on-WASM interactive web shell.
 */

import { Elf2WasmDocker, runDockerImage, parseImageRef } from "/js/docker_sdk.mjs";
import { VT100Terminal } from "/web/terminal.mjs";

// Immediately expose JS SDK globals on window (before any async work)
window.Elf2WasmDocker = Elf2WasmDocker;
window.runDockerImage = runDockerImage;

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

// Primary DOM elements
const imageInput = document.getElementById("image-input");
const cmdInput = document.getElementById("cmd-input");
const envInput = document.getElementById("env-input");
const cwdInput = document.getElementById("cwd-input");
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
  } else if (stage === "ready" || stage === "extract") {
    activeIdx = 1;
  } else if (stage === "compile") {
    activeIdx = 2;
  } else if (stage === "run") {
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
    case "compile":
      setProgress(90, "compile");
      setStatus("Compiling ELF → WASM in browser...", "busy");
      break;
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
        i++;
        current += str[i];
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

function parseEnvLines(text) {
  const result = [];
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq > 0) {
      result.push(line);
    }
  }
  return result;
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
  }
}

async function bootImage({ imageRef, tarball = null, cmdStr = null, envList = null, cwd = null }) {
  const seq = ++sessionSeq;

  // Cancel any in-flight pull and cleanly stop any previous container
  await stopActiveSession({ updateUi: false });
  if (seq !== sessionSeq) return;

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
    try {
      if (seq !== sessionSeq) return;

      const rawCmd = cmdStr !== null ? cmdStr : cmdInput.value.trim();
      const cmdTokens = rawCmd ? splitShellArgs(rawCmd) : [];
      const envEntries = envList !== null ? envList : parseEnvLines(envInput.value);
      const workdir = cwd !== null ? cwd : cwdInput.value.trim();
      const { cols, rows } = terminal.getSize();

      const displayCmd =
        cmdTokens.length > 0
          ? cmdTokens.join(" ")
          : (image.config?.cmd && image.config.cmd.join(" ")) || "/bin/sh";
      if (terminalTitleEl) {
        terminalTitleEl.textContent = `${resolvedDisplayName} — ${displayCmd}`;
      }

      container = await image.createContainer({
        cmd: cmdTokens.length > 0 ? cmdTokens : undefined,
        env: envEntries.length > 0 ? envEntries : undefined,
        cwd: workdir || undefined,
        tty: true,
        cols,
        rows,
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
        // Ignore cleanup error
      }
      return;
    }

    activeContainer = container;
    containerExited = false;

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
    activeAbortController = null;
    activeContainer = null;
    containerExited = true;
    stopBtn.disabled = true;
    startBtn.disabled = false;
    const msg = err?.message || String(err);
    setStatus(`Error: ${msg}`, "error");
    if (!sawStderr) {
      terminal.write(`\r\n[elf2wasm] Error: ${msg}\r\n`);
    }
  }
}

async function startFromControls() {
  const imageRef = imageInput.value.trim() || "alpine:latest";
  imageInput.value = imageRef;
  await bootImage({ imageRef });
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

imageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    void startFromControls();
  }
});

cmdInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    void startFromControls();
  }
});

for (const chip of presetChips) {
  chip.addEventListener("click", () => {
    const img = chip.dataset.image;
    if (img) {
      imageInput.value = img;
      imageInput.focus();
    }
  });
}

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
