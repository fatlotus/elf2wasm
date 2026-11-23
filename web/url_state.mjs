/**
 * Pure, zero-DOM URL query-parameter serialization and hydration helpers for
 * elf2wasm Web UI deep-linking.
 */

export const DEFAULT_UI_STATE = Object.freeze({
  image: "alpine:latest",
  cmd: "",
  repo: "",
  ref: "",
  mount: "/workspace",
  cwd: "",
  env: Object.freeze([]),
});

const MANAGED_QUERY_KEYS = Object.freeze([
  "preset",
  "image",
  "cmd",
  "repo",
  "ref",
  "repoRef",
  "mount",
  "repoMount",
  "cwd",
  "env",
]);

function cleanSingleLine(value) {
  return String(value ?? "")
    .replace(/\0/g, "")
    .trim();
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

function normalizeState(raw) {
  return {
    image: cleanSingleLine(raw?.image) || DEFAULT_UI_STATE.image,
    cmd: cleanSingleLine(raw?.cmd),
    repo: cleanSingleLine(raw?.repo),
    ref: cleanSingleLine(raw?.ref),
    mount: cleanSingleLine(raw?.mount ?? raw?.mountPath) || DEFAULT_UI_STATE.mount,
    cwd: cleanSingleLine(raw?.cwd),
    env: normalizeEnvList(raw?.env),
  };
}

/**
 * Return the preset ID whose fields exactly match `state`, or `null` if none match.
 *
 * @param {object} state
 * @param {Record<string, object> | null | undefined} presets
 * @returns {string | null}
 */
export function matchProjectPreset(state, presets) {
  if (!presets || typeof presets !== "object") {
    return null;
  }
  const normalized = normalizeState(state);
  for (const [id, preset] of Object.entries(presets)) {
    if (!preset || typeof preset !== "object") continue;
    const p = normalizeState(preset);
    if (
      normalized.image !== p.image ||
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
 * @returns {{ state: { image: string, cmd: string, repo: string, ref: string, mount: string, cwd: string, env: string[] }, activePresetId: string | null }}
 */
export function parseStateFromSearch(search, presets = null) {
  const params = new URLSearchParams(typeof search === "string" ? search : "");
  const state = {
    image: DEFAULT_UI_STATE.image,
    cmd: DEFAULT_UI_STATE.cmd,
    repo: DEFAULT_UI_STATE.repo,
    ref: DEFAULT_UI_STATE.ref,
    mount: DEFAULT_UI_STATE.mount,
    cwd: DEFAULT_UI_STATE.cwd,
    env: [],
  };

  if (params.has("preset") && presets && typeof presets === "object") {
    const presetId = cleanSingleLine(params.get("preset"));
    if (presetId && Object.prototype.hasOwnProperty.call(presets, presetId)) {
      const preset = presets[presetId];
      if (preset && typeof preset === "object") {
        const normalizedPreset = normalizeState(preset);
        state.image = normalizedPreset.image;
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
  if (params.has("cmd")) {
    state.cmd = cleanSingleLine(params.get("cmd"));
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
  const cmd = cleanSingleLine(state?.cmd);
  const repo = cleanSingleLine(state?.repo);
  const ref = cleanSingleLine(state?.ref);
  const mount = cleanSingleLine(state?.mount ?? state?.mountPath);
  const cwd = cleanSingleLine(state?.cwd);
  const env = normalizeEnvList(state?.env);

  if (image && image !== DEFAULT_UI_STATE.image) {
    params.append("image", image);
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

  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}
