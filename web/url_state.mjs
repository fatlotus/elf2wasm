/**
 * Pure, zero-DOM URL query-parameter serialization and hydration helpers for
 * elf2wasm Web UI deep-linking.
 */

import {
  DEFAULT_MOUNT_PATH,
  parseDockerfile,
  serializeDockerfile,
  expandSweepValues,
} from "./dockerfile.mjs";

export const DEFAULT_UI_STATE = Object.freeze({
  image: "alpine:latest",
  build: "",
  cmd: "",
  repo: "",
  ref: "",
  mount: "/workspace",
  cwd: "",
  env: Object.freeze([]),
  stddev: 0,
  seed: 0,
  sweep: false,
  runs: 20,
  stddevStart: 1,
  stddevStep: 1,
  selectedRun: null,
});

export const MAX_STDDEV_MS = 3_600_000;
export const MAX_SEED = Number.MAX_SAFE_INTEGER;
export const MAX_SWEEP_RUNS = 1000;

export const VALID_EXECUTOR_MODES = Object.freeze(["local", "remote", "mixed"]);
export const VALID_THEMES = Object.freeze(["system", "light", "dark"]);

const DEFAULT_DOCKERFILE = "FROM alpine:latest";

const MANAGED_QUERY_KEYS = Object.freeze([
  "preset",
  "dockerfile",
  "executor",
  "theme",
  "selectedSweepRun",
  "image",
  "build",
  "cmd",
  "run",
  "repo",
  "ref",
  "repoRef",
  "mount",
  "repoMount",
  "cwd",
  "env",
  "stddev",
  "delay",
  "seed",
  "sweep",
  "runs",
  "stddevStart",
  "stddevStep",
  "sweepStart",
  "sweepStep",
  "sweepCount",
  "selectedRun",
]);

function cleanSingleLine(value) {
  return String(value ?? "")
    .replace(/\0/g, "")
    .trim();
}

function round3(n) {
  const r = Math.round(n * 1000) / 1000;
  return r === 0 ? 0 : r;
}

function parseNonNegNumber(raw, fallback, max = MAX_STDDEV_MS) {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw < 0) return fallback;
    return round3(Math.min(raw, max));
  }
  const cleaned = cleanSingleLine(raw);
  if (!cleaned) return fallback;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return round3(Math.min(n, max));
}

function parseNonNegInt(raw, fallback, { min = 0, max = MAX_SEED } = {}) {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw < min) return fallback;
    const floored = Math.floor(Math.min(raw, max));
    return floored >= min ? (floored === 0 ? 0 : floored) : fallback;
  }
  const cleaned = cleanSingleLine(raw);
  if (!cleaned) return fallback;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < min) return fallback;
  const floored = Math.floor(Math.min(n, max));
  return floored >= min ? (floored === 0 ? 0 : floored) : fallback;
}

function parseBoolFlag(raw) {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw === 1;
  const cleaned = cleanSingleLine(raw).toLowerCase();
  return cleaned === "1" || cleaned === "true" || cleaned === "yes" || cleaned === "on";
}

function parseSelectedRun(raw, runs) {
  if (raw === null || raw === undefined || runs < 1) return null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    const idx = Math.floor(raw);
    return idx >= 1 && idx <= runs ? idx : null;
  }
  const cleaned = cleanSingleLine(raw);
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  const idx = Math.floor(n);
  return idx >= 1 && idx <= runs ? idx : null;
}

function normalizeTheme(raw) {
  const v = cleanSingleLine(raw).toLowerCase();
  return VALID_THEMES.includes(v) ? v : "system";
}

function normalizeExecutorMode(raw, fallback = null) {
  const v = cleanSingleLine(raw).toLowerCase();
  if (VALID_EXECUTOR_MODES.includes(v)) return v;
  return fallback;
}

/**
 * Infer overall executor mode (`"local" | "remote" | "mixed"`) from a `Layer[]` stack.
 *
 * @param {object[]} layers
 * @returns {"local"|"remote"|"mixed"}
 */
export function inferExecutorMode(layers) {
  if (!Array.isArray(layers) || layers.length === 0) return "local";
  let hasLocal = false;
  let hasRemote = false;
  for (const layer of layers) {
    if (!layer || typeof layer !== "object") continue;
    if (layer.type !== "from" && layer.type !== "git" && layer.type !== "run") continue;
    if (layer.executor === "remote") hasRemote = true;
    else hasLocal = true;
  }
  if (hasLocal && hasRemote) return "mixed";
  if (hasRemote) return "remote";
  return "local";
}

/**
 * Convert a legacy flat UI state object into an ordered `Layer[]` stack.
 *
 * @param {object} state
 * @returns {object[]}
 */
export function legacyStateToLayers(state) {
  const s = state && typeof state === "object" ? state : DEFAULT_UI_STATE;
  const layers = [];
  let nextNum = 1;
  const makeId = () => `layer-${nextNum++}`;

  const image = cleanSingleLine(s.image) || DEFAULT_UI_STATE.image;
  layers.push({ id: makeId(), type: "from", image, executor: "local" });

  const repo = cleanSingleLine(s.repo);
  if (repo) {
    const ref = cleanSingleLine(s.ref);
    const mountPath = cleanSingleLine(s.mount ?? s.mountPath) || DEFAULT_MOUNT_PATH;
    layers.push({
      id: makeId(),
      type: "git",
      repo,
      ...(ref ? { ref } : {}),
      mountPath,
      executor: "local",
    });
  }

  const cwd = cleanSingleLine(s.cwd);
  if (cwd) {
    layers.push({ id: makeId(), type: "workdir", path: cwd });
  }

  const envLines = normalizeEnvList(s.env);
  for (const line of envLines) {
    const eq = line.indexOf("=");
    if (eq > 0) {
      layers.push({
        id: makeId(),
        type: "env",
        key: line.slice(0, eq),
        value: line.slice(eq + 1),
      });
    }
  }

  const build = cleanSingleLine(s.build);
  if (build) {
    layers.push({ id: makeId(), type: "run", cmd: build, executor: "local" });
  }

  if (parseBoolFlag(s.sweep)) {
    const count = parseNonNegInt(s.runs, DEFAULT_UI_STATE.runs, { min: 1, max: MAX_SWEEP_RUNS });
    const start = parseNonNegNumber(s.stddevStart, DEFAULT_UI_STATE.stddevStart);
    const step = parseNonNegNumber(s.stddevStep, DEFAULT_UI_STATE.stddevStep);
    layers.push({
      id: makeId(),
      type: "sweep",
      param: "delay",
      mode: "range",
      start,
      step,
      count,
    });
  }

  const cmd = cleanSingleLine(s.cmd);
  if (cmd) {
    layers.push({ id: makeId(), type: "run", cmd, executor: "local" });
  }

  return layers;
}

/**
 * Best-effort projection of a `Layer[]` stack back into legacy flat UI state fields.
 *
 * @param {object[]} layers
 * @returns {object}
 */
function projectLayersToLegacyState(layers) {
  const state = {
    image: DEFAULT_UI_STATE.image,
    build: DEFAULT_UI_STATE.build,
    cmd: DEFAULT_UI_STATE.cmd,
    repo: DEFAULT_UI_STATE.repo,
    ref: DEFAULT_UI_STATE.ref,
    mount: DEFAULT_UI_STATE.mount,
    cwd: DEFAULT_UI_STATE.cwd,
    env: [],
    stddev: DEFAULT_UI_STATE.stddev,
    seed: DEFAULT_UI_STATE.seed,
    sweep: DEFAULT_UI_STATE.sweep,
    runs: DEFAULT_UI_STATE.runs,
    stddevStart: DEFAULT_UI_STATE.stddevStart,
    stddevStep: DEFAULT_UI_STATE.stddevStep,
    selectedRun: DEFAULT_UI_STATE.selectedRun,
  };

  if (!Array.isArray(layers) || layers.length === 0) return state;

  let sawFrom = false;
  let sawGit = false;
  let sawWorkdir = false;
  let sawSweep = false;
  const runsBeforeSweep = [];
  const runsAfterSweep = [];

  for (const layer of layers) {
    if (!layer || typeof layer !== "object") continue;
    switch (layer.type) {
      case "from":
        if (!sawFrom && layer.image) {
          state.image = cleanSingleLine(layer.image) || DEFAULT_UI_STATE.image;
          sawFrom = true;
        }
        break;
      case "git":
        if (!sawGit && layer.repo) {
          state.repo = cleanSingleLine(layer.repo);
          state.ref = cleanSingleLine(layer.ref);
          state.mount = cleanSingleLine(layer.mountPath) || DEFAULT_UI_STATE.mount;
          sawGit = true;
        }
        break;
      case "workdir":
        if (!sawWorkdir && layer.path) {
          state.cwd = cleanSingleLine(layer.path);
          sawWorkdir = true;
        }
        break;
      case "env":
        if (layer.key) {
          state.env.push(`${layer.key}=${layer.value ?? ""}`);
        }
        break;
      case "sweep":
        if (!sawSweep) {
          sawSweep = true;
          state.sweep = true;
          const expanded = expandSweepValues(layer);
          if (layer.mode === "range") {
            state.runs = parseNonNegInt(layer.count, DEFAULT_UI_STATE.runs, {
              min: 1,
              max: MAX_SWEEP_RUNS,
            });
            if (layer.param === "delay") {
              state.stddevStart = parseNonNegNumber(layer.start, DEFAULT_UI_STATE.stddevStart);
              state.stddevStep = parseNonNegNumber(layer.step, DEFAULT_UI_STATE.stddevStep);
            }
          } else if (expanded.length > 0) {
            state.runs = Math.min(MAX_SWEEP_RUNS, expanded.length);
          }
        }
        break;
      case "run":
        if (layer.cmd) {
          if (sawSweep) runsAfterSweep.push(layer.cmd);
          else runsBeforeSweep.push(layer.cmd);
        }
        break;
    }
  }

  if (sawSweep) {
    if (runsBeforeSweep.length > 0) {
      state.build = runsBeforeSweep.join(" && ");
    }
    if (runsAfterSweep.length > 0) {
      state.cmd = runsAfterSweep[runsAfterSweep.length - 1];
    }
  } else if (runsBeforeSweep.length === 1) {
    state.cmd = runsBeforeSweep[0];
  } else if (runsBeforeSweep.length > 1) {
    state.build = runsBeforeSweep.slice(0, -1).join(" && ");
    state.cmd = runsBeforeSweep[runsBeforeSweep.length - 1];
  }

  return state;
}

/**
 * Parse multi-line KEY=VALUE environment variable text into normalized lines.
 * Normalizes CRLF/CR to LF, strips NUL bytes, trims whitespace, ignores empty
 * lines and `#` comments, and requires `=` at index > 0.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseEnvLines(text) {
  const result = [];
  const normalized = String(text ?? "")
    .replace(/\0/g, "")
    .replace(/\r\n?/g, "\n");
  for (const rawLine of normalized.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq > 0) {
      result.push(line);
    }
  }
  return result;
}

function normalizeEnvList(env) {
  if (Array.isArray(env)) {
    const out = [];
    for (const entry of env) {
      for (const line of parseEnvLines(entry)) {
        out.push(line);
      }
    }
    return out;
  }
  return parseEnvLines(env);
}

function normalizeProjectFields(raw) {
  return {
    image: cleanSingleLine(raw?.image) || DEFAULT_UI_STATE.image,
    build: cleanSingleLine(raw?.build),
    cmd: cleanSingleLine(raw?.cmd),
    repo: cleanSingleLine(raw?.repo),
    ref: cleanSingleLine(raw?.ref),
    mount: cleanSingleLine(raw?.mount ?? raw?.mountPath) || DEFAULT_UI_STATE.mount,
    cwd: cleanSingleLine(raw?.cwd),
    env: normalizeEnvList(raw?.env),
  };
}

function canonicalDockerfileFromSource(src) {
  if (!src || typeof src !== "object") return null;
  if (Array.isArray(src.layers)) {
    return serializeDockerfile(parseDockerfile(serializeDockerfile(src.layers)).layers);
  }
  if (typeof src.dockerfile === "string") {
    return serializeDockerfile(parseDockerfile(src.dockerfile).layers);
  }
  return null;
}

/**
 * Return the preset ID whose project fields (or canonical Dockerfile) exactly
 * match `state`, or `null` if none match.
 * Delay and sweep execution parameters are intentionally excluded from legacy
 * preset matching so toggling Sweep Mode or setting delay/seed keeps the active
 * project preset highlighted.
 *
 * @param {object} state
 * @param {Record<string, object> | null | undefined} presets
 * @returns {string | null}
 */
export function matchProjectPreset(state, presets) {
  if (!presets || typeof presets !== "object") {
    return null;
  }
  const stateCanonicalDf = canonicalDockerfileFromSource(state);
  const normalized = normalizeProjectFields(state);

  for (const [id, preset] of Object.entries(presets)) {
    if (!preset || typeof preset !== "object") continue;

    const presetCanonicalDf = canonicalDockerfileFromSource(preset);
    if (presetCanonicalDf !== null) {
      const targetDf = stateCanonicalDf ?? serializeDockerfile(legacyStateToLayers(state));
      if (targetDf === presetCanonicalDf) {
        return id;
      }
      continue;
    }

    const p = normalizeProjectFields(preset);
    if (
      normalized.image !== p.image ||
      normalized.build !== p.build ||
      normalized.cmd !== p.cmd ||
      normalized.repo !== p.repo ||
      normalized.ref !== p.ref ||
      normalized.mount !== p.mount ||
      normalized.cwd !== p.cwd ||
      normalized.env.length !== p.env.length
    ) {
      continue;
    }
    let envMatch = true;
    for (let i = 0; i < normalized.env.length; i++) {
      if (normalized.env[i] !== p.env[i]) {
        envMatch = false;
        break;
      }
    }
    if (envMatch) {
      return id;
    }
  }
  return null;
}

/**
 * Parse a URL query string (`location.search`) into normalized UI state,
 * optional active preset ID, and Dockerfile layer stack metadata.
 *
 * @param {string} search
 * @param {Record<string, object> | null} [presets]
 * @returns {{ state: object, activePresetId: string | null, layers: object[], dockerfile: string, executorMode: "local"|"remote"|"mixed", theme: "system"|"light"|"dark", selectedSweepRun: number | null }}
 */
export function parseStateFromSearch(search, presets = null) {
  const params = new URLSearchParams(typeof search === "string" ? search : "");
  const theme = normalizeTheme(params.get("theme"));

  // Dockerfile-mode URL hydration
  if (params.has("dockerfile")) {
    const rawDf = params.get("dockerfile") ?? "";
    const { layers } = parseDockerfile(rawDf);
    const dockerfile = serializeDockerfile(layers);
    const inferredExecutor = inferExecutorMode(layers);
    const executorMode = normalizeExecutorMode(params.get("executor"), inferredExecutor);
    const state = projectLayersToLegacyState(layers);

    if (params.has("stddev")) {
      state.stddev = parseNonNegNumber(params.get("stddev"), DEFAULT_UI_STATE.stddev);
    } else if (params.has("delay")) {
      state.stddev = parseNonNegNumber(params.get("delay"), DEFAULT_UI_STATE.stddev);
    }
    if (params.has("seed")) {
      state.seed = parseNonNegInt(params.get("seed"), DEFAULT_UI_STATE.seed);
    }

    const sweepLayer = layers.find((l) => l.type === "sweep") || null;
    const sweepCount = sweepLayer ? expandSweepValues(sweepLayer).length : 0;
    const rawSelected =
      params.get("selectedSweepRun") ??
      params.get("selectedRun") ??
      (params.has("run") && /^\d+$/.test(cleanSingleLine(params.get("run")))
        ? params.get("run")
        : null);
    const selectedSweepRun = sweepLayer ? parseSelectedRun(rawSelected, sweepCount) : null;
    state.selectedRun = selectedSweepRun;

    const activePresetId =
      matchProjectPreset({ layers, dockerfile, ...state }, presets) ??
      matchProjectPreset(state, presets);

    return {
      state,
      activePresetId,
      layers,
      dockerfile,
      executorMode,
      theme,
      selectedSweepRun,
    };
  }

  // Legacy flat query-parameter hydration (with optional dockerfile-based preset)
  const state = {
    image: DEFAULT_UI_STATE.image,
    build: DEFAULT_UI_STATE.build,
    cmd: DEFAULT_UI_STATE.cmd,
    repo: DEFAULT_UI_STATE.repo,
    ref: DEFAULT_UI_STATE.ref,
    mount: DEFAULT_UI_STATE.mount,
    cwd: DEFAULT_UI_STATE.cwd,
    env: [],
    stddev: DEFAULT_UI_STATE.stddev,
    seed: DEFAULT_UI_STATE.seed,
    sweep: DEFAULT_UI_STATE.sweep,
    runs: DEFAULT_UI_STATE.runs,
    stddevStart: DEFAULT_UI_STATE.stddevStart,
    stddevStep: DEFAULT_UI_STATE.stddevStep,
    selectedRun: DEFAULT_UI_STATE.selectedRun,
  };

  let presetLayers = null;
  if (params.has("preset") && presets && typeof presets === "object") {
    const presetId = cleanSingleLine(params.get("preset"));
    if (presetId && Object.prototype.hasOwnProperty.call(presets, presetId)) {
      const preset = presets[presetId];
      if (preset && typeof preset === "object") {
        const presetDf = canonicalDockerfileFromSource(preset);
        if (presetDf !== null) {
          presetLayers = parseDockerfile(presetDf).layers;
          Object.assign(state, projectLayersToLegacyState(presetLayers));
        } else {
          const normalizedPreset = normalizeProjectFields(preset);
          state.image = normalizedPreset.image;
          state.build = normalizedPreset.build;
          state.cmd = normalizedPreset.cmd;
          state.repo = normalizedPreset.repo;
          state.ref = normalizedPreset.ref;
          state.mount = normalizedPreset.mount;
          state.cwd = normalizedPreset.cwd;
          state.env = normalizedPreset.env;
        }
      }
    }
  }

  let hasLegacyFieldOverride = false;
  if (params.has("image")) {
    state.image = cleanSingleLine(params.get("image")) || DEFAULT_UI_STATE.image;
    hasLegacyFieldOverride = true;
  }
  if (params.has("build")) {
    state.build = cleanSingleLine(params.get("build"));
    hasLegacyFieldOverride = true;
  }
  if (params.has("cmd")) {
    state.cmd = cleanSingleLine(params.get("cmd"));
    hasLegacyFieldOverride = true;
  } else if (params.has("run")) {
    state.cmd = cleanSingleLine(params.get("run"));
    hasLegacyFieldOverride = true;
  }
  if (params.has("repo")) {
    state.repo = cleanSingleLine(params.get("repo"));
    hasLegacyFieldOverride = true;
  }
  if (params.has("ref")) {
    state.ref = cleanSingleLine(params.get("ref"));
    hasLegacyFieldOverride = true;
  } else if (params.has("repoRef")) {
    state.ref = cleanSingleLine(params.get("repoRef"));
    hasLegacyFieldOverride = true;
  }
  if (params.has("mount")) {
    state.mount = cleanSingleLine(params.get("mount")) || DEFAULT_UI_STATE.mount;
    hasLegacyFieldOverride = true;
  } else if (params.has("repoMount")) {
    state.mount = cleanSingleLine(params.get("repoMount")) || DEFAULT_UI_STATE.mount;
    hasLegacyFieldOverride = true;
  }
  if (params.has("cwd")) {
    state.cwd = cleanSingleLine(params.get("cwd"));
    hasLegacyFieldOverride = true;
  }
  if (params.has("env")) {
    const envLines = [];
    for (const rawEntry of params.getAll("env")) {
      for (const line of parseEnvLines(rawEntry)) {
        envLines.push(line);
      }
    }
    state.env = envLines;
    hasLegacyFieldOverride = true;
  }

  if (params.has("stddev")) {
    state.stddev = parseNonNegNumber(params.get("stddev"), DEFAULT_UI_STATE.stddev);
  } else if (params.has("delay")) {
    state.stddev = parseNonNegNumber(params.get("delay"), DEFAULT_UI_STATE.stddev);
  }
  if (params.has("seed")) {
    state.seed = parseNonNegInt(params.get("seed"), DEFAULT_UI_STATE.seed);
  }
  let hasLegacySweepOverride = false;
  if (params.has("sweep")) {
    state.sweep = parseBoolFlag(params.get("sweep"));
    hasLegacySweepOverride = true;
  }
  if (params.has("runs")) {
    state.runs = parseNonNegInt(params.get("runs"), DEFAULT_UI_STATE.runs, {
      min: 1,
      max: MAX_SWEEP_RUNS,
    });
    hasLegacySweepOverride = true;
  } else if (params.has("sweepCount")) {
    state.runs = parseNonNegInt(params.get("sweepCount"), DEFAULT_UI_STATE.runs, {
      min: 1,
      max: MAX_SWEEP_RUNS,
    });
    hasLegacySweepOverride = true;
  }
  if (params.has("stddevStart")) {
    state.stddevStart = parseNonNegNumber(
      params.get("stddevStart"),
      DEFAULT_UI_STATE.stddevStart
    );
    hasLegacySweepOverride = true;
  } else if (params.has("sweepStart")) {
    state.stddevStart = parseNonNegNumber(
      params.get("sweepStart"),
      DEFAULT_UI_STATE.stddevStart
    );
    hasLegacySweepOverride = true;
  }
  if (params.has("stddevStep")) {
    state.stddevStep = parseNonNegNumber(
      params.get("stddevStep"),
      DEFAULT_UI_STATE.stddevStep
    );
    hasLegacySweepOverride = true;
  } else if (params.has("sweepStep")) {
    state.stddevStep = parseNonNegNumber(
      params.get("sweepStep"),
      DEFAULT_UI_STATE.stddevStep
    );
    hasLegacySweepOverride = true;
  }
  if (state.sweep && (params.has("selectedRun") || params.has("selectedSweepRun"))) {
    state.selectedRun = parseSelectedRun(
      params.get("selectedRun") ?? params.get("selectedSweepRun"),
      state.runs
    );
  } else {
    state.selectedRun = null;
  }

  let layers;
  if (presetLayers && !hasLegacyFieldOverride) {
    if (hasLegacySweepOverride) {
      const updated = presetLayers.filter((l) => l.type !== "sweep");
      if (state.sweep) {
        const sweepLayer = {
          id: "layer-sweep",
          type: "sweep",
          param: "delay",
          mode: "range",
          start: state.stddevStart,
          step: state.stddevStep,
          count: state.runs,
        };
        const existingSweepIdx = presetLayers.findIndex((l) => l.type === "sweep");
        if (existingSweepIdx >= 0) {
          const insertIdx = Math.min(existingSweepIdx, updated.length);
          updated.splice(insertIdx, 0, sweepLayer);
        } else {
          let lastRunIdx = -1;
          for (let idx = updated.length - 1; idx >= 0; idx--) {
            if (updated[idx].type === "run") {
              lastRunIdx = idx;
              break;
            }
          }
          if (lastRunIdx >= 0) {
            updated.splice(lastRunIdx, 0, sweepLayer);
          } else {
            updated.push(sweepLayer);
          }
        }
      }
      layers = parseDockerfile(serializeDockerfile(updated)).layers;
    } else {
      layers = presetLayers;
    }
  } else {
    layers = legacyStateToLayers(state);
  }
  const dockerfile = serializeDockerfile(layers);
  const executorMode = normalizeExecutorMode(params.get("executor"), inferExecutorMode(layers));
  const selectedSweepRun = state.selectedRun;

  const activePresetId =
    presetLayers && !hasLegacyFieldOverride
      ? matchProjectPreset({ layers, dockerfile, ...state }, presets)
      : matchProjectPreset(state, presets);

  return {
    state,
    activePresetId,
    layers,
    dockerfile,
    executorMode,
    theme,
    selectedSweepRun,
  };
}

/**
 * Serialize UI state (either Dockerfile/Layer[] mode or legacy flat state) into
 * a canonical `?query` string (or `""` if all values are defaults and no
 * unmanaged query parameters remain).
 *
 * @param {object} state
 * @param {{ existingSearch?: string }} [options]
 * @returns {string}
 */
export function serializeStateToSearch(state, { existingSearch = "" } = {}) {
  const params = new URLSearchParams(typeof existingSearch === "string" ? existingSearch : "");
  for (const key of MANAGED_QUERY_KEYS) {
    params.delete(key);
  }

  const theme = normalizeTheme(state?.theme);

  // Dockerfile / Layer[] mode
  if (Array.isArray(state?.layers) || typeof state?.dockerfile === "string") {
    const rawDf = Array.isArray(state.layers)
      ? serializeDockerfile(state.layers)
      : String(state.dockerfile ?? "");
    const { layers } = parseDockerfile(rawDf);
    const canonicalDf = serializeDockerfile(layers);

    if (canonicalDf && canonicalDf !== DEFAULT_DOCKERFILE) {
      params.append("dockerfile", canonicalDf);
    }

    const explicitExec = normalizeExecutorMode(state?.executorMode ?? state?.executor, null);
    const effectiveExec = explicitExec ?? inferExecutorMode(layers);
    if (effectiveExec === "remote" || effectiveExec === "mixed") {
      params.append("executor", effectiveExec);
    }

    if (theme === "light" || theme === "dark") {
      params.append("theme", theme);
    }

    const sweepLayer = layers.find((l) => l.type === "sweep") || null;
    if (sweepLayer) {
      const count = expandSweepValues(sweepLayer).length;
      const sel = parseSelectedRun(state?.selectedSweepRun ?? state?.selectedRun, count);
      if (sel !== null) {
        params.append("selectedRun", String(sel));
      }
    } else {
      const stddev = parseNonNegNumber(state?.stddev, DEFAULT_UI_STATE.stddev);
      const seed = parseNonNegInt(state?.seed, DEFAULT_UI_STATE.seed);
      if (stddev > 0) {
        params.append("stddev", String(stddev));
      }
      if (seed > 0 || stddev > 0) {
        params.append("seed", String(seed));
      }
    }

    const serialized = params.toString();
    return serialized ? `?${serialized}` : "";
  }

  // Legacy flat state mode
  const image = cleanSingleLine(state?.image);
  const build = cleanSingleLine(state?.build);
  const cmd = cleanSingleLine(state?.cmd);
  const repo = cleanSingleLine(state?.repo);
  const ref = cleanSingleLine(state?.ref);
  const mount = cleanSingleLine(state?.mount ?? state?.mountPath);
  const cwd = cleanSingleLine(state?.cwd);
  const env = normalizeEnvList(state?.env);
  const stddev = parseNonNegNumber(state?.stddev, DEFAULT_UI_STATE.stddev);
  const seed = parseNonNegInt(state?.seed, DEFAULT_UI_STATE.seed);
  const sweep = parseBoolFlag(state?.sweep);
  const runs = parseNonNegInt(state?.runs, DEFAULT_UI_STATE.runs, {
    min: 1,
    max: MAX_SWEEP_RUNS,
  });
  const stddevStart = parseNonNegNumber(state?.stddevStart, DEFAULT_UI_STATE.stddevStart);
  const stddevStep = parseNonNegNumber(state?.stddevStep, DEFAULT_UI_STATE.stddevStep);
  const selectedRun = sweep ? parseSelectedRun(state?.selectedRun, runs) : null;

  if (image && image !== DEFAULT_UI_STATE.image) {
    params.append("image", image);
  }
  if (build) {
    params.append("build", build);
  }
  if (cmd) {
    params.append("cmd", cmd);
  }
  if (repo) {
    params.append("repo", repo);
    if (ref && ref !== "HEAD") {
      params.append("ref", ref);
    }
    if (mount && mount !== DEFAULT_UI_STATE.mount) {
      params.append("mount", mount);
    }
  }
  if (cwd) {
    params.append("cwd", cwd);
  }
  for (const line of env) {
    params.append("env", line);
  }

  if (!sweep && stddev > 0) {
    params.append("stddev", String(stddev));
  }
  if (seed > 0 || (!sweep && stddev > 0) || sweep) {
    params.append("seed", String(seed));
  }
  if (sweep) {
    params.append("sweep", "1");
    if (runs !== DEFAULT_UI_STATE.runs) {
      params.append("runs", String(runs));
    }
    if (stddevStart !== DEFAULT_UI_STATE.stddevStart) {
      params.append("stddevStart", String(stddevStart));
    }
    if (stddevStep !== DEFAULT_UI_STATE.stddevStep) {
      params.append("stddevStep", String(stddevStep));
    }
    if (selectedRun !== null) {
      params.append("selectedRun", String(selectedRun));
    }
  }

  const legacyExec = normalizeExecutorMode(state?.executorMode ?? state?.executor, null);
  if (legacyExec === "remote" || legacyExec === "mixed") {
    params.append("executor", legacyExec);
  }
  if (theme === "light" || theme === "dark") {
    params.append("theme", theme);
  }

  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}

/**
 * Compute deterministic `{ index, stddev, seed }` for a 1-based run index inside a sweep.
 *
 * @param {object} state
 * @param {number} runIndex1Based
 * @returns {{ index: number, stddev: number, seed: number }}
 */
export function computeSweepRunParams(state, runIndex1Based) {
  const rawIdx = Number(runIndex1Based);
  const index = Number.isFinite(rawIdx) && rawIdx >= 1 ? Math.floor(rawIdx) : 1;
  const runs = parseNonNegInt(state?.runs, DEFAULT_UI_STATE.runs, {
    min: 1,
    max: MAX_SWEEP_RUNS,
  });
  const stddevStart = parseNonNegNumber(state?.stddevStart, DEFAULT_UI_STATE.stddevStart);
  const stddevStep = parseNonNegNumber(state?.stddevStep, DEFAULT_UI_STATE.stddevStep);
  const seedStart = parseNonNegInt(
    state?.seed ?? state?.seedStart,
    DEFAULT_UI_STATE.seed
  );
  const maxSeedStart = Math.max(0, MAX_SEED - Math.max(0, runs - 1));
  const effectiveSeedStart = Math.min(seedStart, maxSeedStart);
  const stddev = round3(Math.min(MAX_STDDEV_MS, stddevStart + (index - 1) * stddevStep));
  const seed = Math.min(MAX_SEED, effectiveSeedStart + (index - 1));
  return { index, stddev, seed };
}

/**
 * Build a standalone deterministic single-run query string (`?...`) for a specific
 * `(stddev, seed)` run. Preserves project fields (`image`, `build`, `cmd`, `repo`,
 * `ref`, `mount`, `cwd`, `env`) and any unmanaged params from `existingSearch`,
 * strips sweep-only keys (`sweep`, `runs`, `stddevStart`, `stddevStep`, `selectedRun`),
 * and always writes explicit `stddev` and `seed`.
 *
 * @param {object} state
 * @param {{ stddev?: number, stddevMs?: number, seed?: number }} [runParams]
 * @param {{ existingSearch?: string } | string} [options]
 * @returns {string}
 */
export function buildRunSearch(state, runParams = {}, options = {}) {
  const existingSearch =
    typeof options === "string"
      ? options
      : typeof options?.existingSearch === "string"
        ? options.existingSearch
        : "";

  const stddev = parseNonNegNumber(runParams?.stddev ?? runParams?.stddevMs, 0);
  const seed = parseNonNegInt(runParams?.seed, 0);

  if (Array.isArray(state?.layers) || typeof state?.dockerfile === "string") {
    const rawDf = Array.isArray(state.layers)
      ? serializeDockerfile(state.layers)
      : String(state.dockerfile ?? "");
    const parsedLayers = parseDockerfile(rawDf).layers;

    const filtered = [];
    let insertAt = -1;
    for (const l of parsedLayers) {
      if (l.type === "sweep") {
        if (insertAt === -1) insertAt = filtered.length;
        continue;
      }
      filtered.push(l);
    }

    let envPair = null;
    if (Array.isArray(runParams?.envOverride) && runParams.envOverride.length >= 2) {
      const k = cleanSingleLine(runParams.envOverride[0]);
      if (k) envPair = [k, String(runParams.envOverride[1] ?? "")];
    } else if (runParams?.envOverride && typeof runParams.envOverride === "object") {
      const k = cleanSingleLine(runParams.envOverride.key);
      if (k) envPair = [k, String(runParams.envOverride.value ?? "")];
    }

    if (envPair) {
      const [k, v] = envPair;
      const pos = insertAt >= 0 ? insertAt : filtered.length;
      const before = filtered.slice(0, pos);
      const after = filtered.slice(pos).filter((l) => !(l.type === "env" && l.key === k));
      filtered.length = 0;
      filtered.push(...before, { id: "layer-env-override", type: "env", key: k, value: v }, ...after);
    }

    const baseSearch = serializeStateToSearch(
      {
        ...state,
        layers: filtered,
        dockerfile: undefined,
        selectedSweepRun: null,
        selectedRun: null,
      },
      { existingSearch }
    );

    const params = new URLSearchParams(baseSearch);
    params.set("stddev", String(stddev));
    params.set("seed", String(seed));
    return `?${params.toString()}`;
  }

  const baseSearch = serializeStateToSearch(
    {
      ...state,
      stddev: 0,
      seed: 0,
      sweep: false,
      runs: DEFAULT_UI_STATE.runs,
      stddevStart: DEFAULT_UI_STATE.stddevStart,
      stddevStep: DEFAULT_UI_STATE.stddevStep,
      selectedRun: null,
    },
    { existingSearch }
  );

  const params = new URLSearchParams(baseSearch);
  params.set("stddev", String(stddev));
  params.set("seed", String(seed));
  return `?${params.toString()}`;
}

