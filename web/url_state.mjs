/**
 * Pure, zero-DOM URL query-parameter serialization and hydration helpers for
 * elf2wasm Web UI deep-linking.
 */

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

const MANAGED_QUERY_KEYS = Object.freeze([
  "preset",
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
  "seed",
  "sweep",
  "runs",
  "stddevStart",
  "stddevStep",
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
  if (raw === null || raw === undefined) return null;
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

/**
 * Return the preset ID whose project fields exactly match `state`, or `null` if none match.
 * Delay and sweep execution parameters are intentionally excluded from preset matching so
 * toggling Sweep Mode or setting delay/seed keeps the active project preset highlighted.
 *
 * @param {object} state
 * @param {Record<string, object> | null | undefined} presets
 * @returns {string | null}
 */
export function matchProjectPreset(state, presets) {
  if (!presets || typeof presets !== "object") {
    return null;
  }
  const normalized = normalizeProjectFields(state);
  for (const [id, preset] of Object.entries(presets)) {
    if (!preset || typeof preset !== "object") continue;
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
 * Parse a URL query string (`location.search`) into normalized UI state and
 * optional active preset ID.
 *
 * @param {string} search
 * @param {Record<string, object> | null} [presets]
 * @returns {{ state: object, activePresetId: string | null }}
 */
export function parseStateFromSearch(search, presets = null) {
  const params = new URLSearchParams(typeof search === "string" ? search : "");
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

  if (params.has("preset") && presets && typeof presets === "object") {
    const presetId = cleanSingleLine(params.get("preset"));
    if (presetId && Object.prototype.hasOwnProperty.call(presets, presetId)) {
      const preset = presets[presetId];
      if (preset && typeof preset === "object") {
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

  if (params.has("image")) {
    state.image = cleanSingleLine(params.get("image")) || DEFAULT_UI_STATE.image;
  }
  if (params.has("build")) {
    state.build = cleanSingleLine(params.get("build"));
  }
  if (params.has("cmd")) {
    state.cmd = cleanSingleLine(params.get("cmd"));
  } else if (params.has("run")) {
    state.cmd = cleanSingleLine(params.get("run"));
  }
  if (params.has("repo")) {
    state.repo = cleanSingleLine(params.get("repo"));
  }
  if (params.has("ref")) {
    state.ref = cleanSingleLine(params.get("ref"));
  } else if (params.has("repoRef")) {
    state.ref = cleanSingleLine(params.get("repoRef"));
  }
  if (params.has("mount")) {
    state.mount = cleanSingleLine(params.get("mount")) || DEFAULT_UI_STATE.mount;
  } else if (params.has("repoMount")) {
    state.mount = cleanSingleLine(params.get("repoMount")) || DEFAULT_UI_STATE.mount;
  }
  if (params.has("cwd")) {
    state.cwd = cleanSingleLine(params.get("cwd"));
  }
  if (params.has("env")) {
    const envLines = [];
    for (const rawEntry of params.getAll("env")) {
      for (const line of parseEnvLines(rawEntry)) {
        envLines.push(line);
      }
    }
    state.env = envLines;
  }

  if (params.has("stddev")) {
    state.stddev = parseNonNegNumber(params.get("stddev"), DEFAULT_UI_STATE.stddev);
  }
  if (params.has("seed")) {
    state.seed = parseNonNegInt(params.get("seed"), DEFAULT_UI_STATE.seed);
  }
  if (params.has("sweep")) {
    state.sweep = parseBoolFlag(params.get("sweep"));
  }
  if (params.has("runs")) {
    state.runs = parseNonNegInt(params.get("runs"), DEFAULT_UI_STATE.runs, {
      min: 1,
      max: MAX_SWEEP_RUNS,
    });
  }
  if (params.has("stddevStart")) {
    state.stddevStart = parseNonNegNumber(
      params.get("stddevStart"),
      DEFAULT_UI_STATE.stddevStart
    );
  }
  if (params.has("stddevStep")) {
    state.stddevStep = parseNonNegNumber(
      params.get("stddevStep"),
      DEFAULT_UI_STATE.stddevStep
    );
  }
  if (state.sweep && params.has("selectedRun")) {
    state.selectedRun = parseSelectedRun(params.get("selectedRun"), state.runs);
  } else {
    state.selectedRun = null;
  }

  const activePresetId = matchProjectPreset(state, presets);
  return { state, activePresetId };
}

/**
 * Serialize UI state into a canonical `?query` string (or `""` if all values
 * are defaults and no unmanaged query parameters remain).
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
