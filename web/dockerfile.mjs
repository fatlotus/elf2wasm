/**
 * Pure, zero-DOM Dockerfile parser, serializer, and sweep expander for elf2wasm.
 *
 * Bidirectional conversion between Dockerfile text (standard directives plus
 * `# elf2wasm:executor=...`, `# elf2wasm:git ...`, `# elf2wasm:sweep ...`) and
 * structured `Layer[]` objects matching PROJECT.md §3.
 */

export const DEFAULT_MOUNT_PATH = "/workspace";
export const DEFAULT_EXECUTOR = "local";
export const VALID_EXECUTORS = Object.freeze(["local", "remote"]);
export const VALID_SWEEP_PARAMS = Object.freeze(["delay", "seed", "env"]);
export const VALID_SWEEP_MODES = Object.freeze(["range", "list"]);
export const MAX_SWEEP_COUNT = 1000;
export const MAX_DELAY_MS = 3_600_000;
export const MAX_SEED = Number.MAX_SAFE_INTEGER;

const GITHUB_HTTPS_RE = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i;
const GITHUB_SSH_RE = /^git@github\.com:([^/\s]+)\/([^/\s#?]+?)(?:\.git)?$/i;
const OWNER_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function round3(n) {
  const r = Math.round(n * 1000) / 1000;
  return r === 0 ? 0 : r;
}

function normalizeZero(n) {
  return n === 0 ? 0 : n;
}

function cleanText(raw) {
  return String(raw ?? "").replace(/\0/g, "");
}

function cleanSingleLine(raw) {
  return cleanText(raw).trim();
}

/**
 * Normalize an execution target to `"local"` or `"remote"`.
 *
 * @param {unknown} raw
 * @param {"local"|"remote"} [fallback="local"]
 * @returns {"local"|"remote"}
 */
export function normalizeExecutor(raw, fallback = DEFAULT_EXECUTOR) {
  const fb = fallback === "remote" ? "remote" : "local";
  if (typeof raw !== "string") return fb;
  const v = raw.trim().toLowerCase();
  if (v === "remote") return "remote";
  if (v === "local") return "local";
  return fb;
}

/**
 * Normalize a GitHub URL or `owner/repo` string to canonical `owner/repo` for
 * GitHub repos, keeping non-GitHub URLs verbatim.
 *
 * @param {string} raw
 * @returns {string}
 */
function normalizeGitRepo(raw) {
  const s = cleanSingleLine(raw);
  if (!s) return "";
  let m = GITHUB_HTTPS_RE.exec(s);
  if (m) return `${m[1]}/${m[2]}`;
  m = GITHUB_SSH_RE.exec(s);
  if (m) return `${m[1]}/${m[2]}`;
  return s;
}

function normalizeMountPath(raw) {
  const s = cleanSingleLine(raw);
  if (!s) return DEFAULT_MOUNT_PATH;
  return s;
}

function normalizeSweepRangeNumbers(param, startRaw, stepRaw, countRaw) {
  const rawCount = Number(countRaw);
  const count =
    Number.isFinite(rawCount) && rawCount >= 0
      ? Math.min(MAX_SWEEP_COUNT, Math.floor(rawCount))
      : 1;

  if (param === "delay") {
    const rawStart = Number(startRaw);
    const rawStep = Number(stepRaw);
    const start =
      Number.isFinite(rawStart) && rawStart >= 0
        ? round3(Math.min(MAX_DELAY_MS, rawStart))
        : 0;
    const step =
      Number.isFinite(rawStep) && rawStep >= 0
        ? round3(Math.min(MAX_DELAY_MS, rawStep))
        : 1;
    return { start, step, count };
  }

  if (param === "seed") {
    const rawStart = Number(startRaw);
    const rawStep = Number(stepRaw);
    const start =
      Number.isFinite(rawStart) && rawStart >= 0
        ? normalizeZero(Math.min(MAX_SEED, Math.floor(rawStart)))
        : 0;
    const step =
      Number.isFinite(rawStep) && rawStep >= 0
        ? normalizeZero(Math.min(MAX_SEED, Math.floor(rawStep)))
        : 1;
    return { start, step, count };
  }

  // env numeric range
  const rawStart = Number(startRaw);
  const rawStep = Number(stepRaw);
  const start = Number.isFinite(rawStart) ? round3(rawStart) : 0;
  const step = Number.isFinite(rawStep) ? round3(rawStep) : 1;
  return { start, step, count };
}

/**
 * Create a normalized Layer object of the given type.
 *
 * @param {"from"|"git"|"workdir"|"env"|"run"|"sweep"} type
 * @param {object} [props]
 * @returns {object}
 */
export function createLayer(type, props = {}) {
  const id = cleanSingleLine(props.id) || `layer-${type}`;
  switch (type) {
    case "from":
      return {
        id,
        type: "from",
        image: cleanSingleLine(props.image) || "alpine:latest",
        executor: normalizeExecutor(props.executor),
      };
    case "git": {
      const ref = cleanSingleLine(props.ref);
      const layer = {
        id,
        type: "git",
        repo: normalizeGitRepo(props.repo),
        mountPath: normalizeMountPath(props.mountPath ?? props.mount),
        executor: normalizeExecutor(props.executor),
      };
      if (ref) layer.ref = ref;
      return layer;
    }
    case "workdir":
      return {
        id,
        type: "workdir",
        path: cleanSingleLine(props.path) || DEFAULT_MOUNT_PATH,
      };
    case "env":
      return {
        id,
        type: "env",
        key: cleanSingleLine(props.key),
        value: cleanText(props.value ?? ""),
      };
    case "run":
      return {
        id,
        type: "run",
        cmd: cleanText(props.cmd ?? "").replace(/\r\n?/g, "\n").trim(),
        executor: normalizeExecutor(props.executor),
      };
    case "sweep": {
      const param = VALID_SWEEP_PARAMS.includes(props.param) ? props.param : "delay";
      const mode = VALID_SWEEP_MODES.includes(props.mode) ? props.mode : "range";
      const envKey = param === "env" ? cleanSingleLine(props.envKey) : "";
      const base = {
        id,
        type: "sweep",
        param,
        ...(param === "env" && envKey ? { envKey } : {}),
        mode,
      };
      if (mode === "range") {
        const nums = normalizeSweepRangeNumbers(
          param,
          props.start ?? (param === "delay" ? 1 : 0),
          props.step ?? 1,
          props.count ?? 5
        );
        return { ...base, ...nums };
      }
      const values = Array.isArray(props.values)
        ? props.values.slice(0, MAX_SWEEP_COUNT).map((v) => cleanText(v))
        : [];
      return { ...base, values };
    }
    default:
      throw new TypeError(`Unknown layer type: ${type}`);
  }
}

/**
 * Quote-aware key=value parser for `# elf2wasm:...` directives.
 * Supports double quotes (with `\"` and `\\` escapes), single quotes, and bare values.
 *
 * @param {string} str
 * @returns {Record<string, string>}
 */
function parseKeyValuePairs(str) {
  const out = {};
  const s = String(str ?? "");
  let i = 0;
  const len = s.length;

  while (i < len) {
    while (i < len && /\s/.test(s[i])) i++;
    if (i >= len) break;

    const keyStart = i;
    while (i < len && s[i] !== "=" && !/\s/.test(s[i])) i++;
    const key = s.slice(keyStart, i);
    if (!key) break;

    if (i >= len || s[i] !== "=") {
      // Bare token without '=' -> treat as boolean flag
      out[key] = "true";
      continue;
    }
    i++; // skip '='

    let value = "";
    if (i < len && (s[i] === '"' || s[i] === "'")) {
      const quote = s[i++];
      while (i < len && s[i] !== quote) {
        if (quote === '"' && s[i] === "\\" && i + 1 < len) {
          const next = s[i + 1];
          if (next === '"' || next === "\\" || next === "n" || next === "t") {
            value += next === "n" ? "\n" : next === "t" ? "\t" : next;
            i += 2;
            continue;
          }
        }
        value += s[i++];
      }
      if (i < len && s[i] === quote) i++;
    } else {
      const valStart = i;
      while (i < len && !/\s/.test(s[i])) i++;
      value = s.slice(valStart, i);
    }

    out[key] = value;
  }

  return out;
}

/**
 * Parse a comma-separated list of sweep values with `\,` and `\\` unescaping.
 *
 * @param {string} raw
 * @returns {string[]}
 */
function parseSweepListValues(raw) {
  if (raw === undefined || raw === null) return [];
  const s = String(raw);
  if (!s.trim()) return [];
  const values = [];
  let cur = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\\" && i + 1 < s.length && (s[i + 1] === "," || s[i + 1] === "\\")) {
      cur += s[i + 1];
      i += 2;
      continue;
    }
    if (s[i] === ",") {
      values.push(cur.trim());
      cur = "";
      i++;
      continue;
    }
    cur += s[i++];
  }
  values.push(cur.trim());
  return values.filter((v) => v.length > 0).slice(0, MAX_SWEEP_COUNT);
}

/**
 * Format sweep list values for `# elf2wasm:sweep ... values=...`.
 *
 * @param {string[]} values
 * @returns {string}
 */
function formatSweepListValues(values) {
  const escaped = values
    .map((v) => String(v ?? "").replace(/\\/g, "\\\\").replace(/,/g, "\\,"))
    .join(",");
  return formatDirectiveValue(escaped);
}

function formatDirectiveValue(val) {
  const s = String(val ?? "");
  if (s === "" || /[\s"'\\]/.test(s)) {
    const escaped = s
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\t/g, "\\t");
    return `"${escaped}"`;
  }
  return s;
}

/**
 * Detect unquoted shell chaining, piping, redirection, or subshell operators.
 *
 * @param {string} cmd
 * @returns {boolean}
 */
function hasUnquotedShellOperators(cmd) {
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\" && i + 1 < cmd.length) {
        i++;
        continue;
      }
      if (ch === '"') {
        quote = null;
        continue;
      }
      if (ch === "`" || (ch === "$" && cmd[i + 1] === "(")) {
        return true;
      }
      continue;
    }
    if (ch === "\\" && i + 1 < cmd.length) {
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (
      ch === ";" ||
      ch === "|" ||
      ch === "&" ||
      ch === ">" ||
      ch === "<" ||
      ch === "`" ||
      ch === "\n"
    ) {
      return true;
    }
    if (ch === "$" && cmd[i + 1] === "(") {
      return true;
    }
  }
  return false;
}

/**
 * Tokenize a simple POSIX shell command without chaining operators.
 * Returns `null` if quotes are unterminated.
 *
 * @param {string} cmd
 * @returns {string[] | null}
 */
function tokenizeShellArgs(cmd) {
  const tokens = [];
  let cur = "";
  let inToken = false;
  let quote = null;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote === "'") {
      if (ch === "'") {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (quote === '"') {
      if (ch === "\\" && i + 1 < cmd.length) {
        const next = cmd[i + 1];
        if (next === '"' || next === "\\" || next === "$" || next === "`") {
          cur += next;
          i++;
          continue;
        }
      }
      if (ch === '"') {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }

    if (/\s/.test(ch)) {
      if (inToken) {
        tokens.push(cur);
        cur = "";
        inToken = false;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inToken = true;
      continue;
    }
    if (ch === "\\" && i + 1 < cmd.length) {
      cur += cmd[i + 1];
      inToken = true;
      i++;
      continue;
    }
    cur += ch;
    inToken = true;
  }

  if (quote !== null) return null;
  if (inToken) tokens.push(cur);
  return tokens;
}

/**
 * Attempt to parse a `git clone ...` token array into `{ repo, ref, mountPath }`.
 * Returns `null` if the command is not a supported `git clone` shorthand.
 *
 * @param {string[]} tokens
 * @returns {{ repo: string, ref?: string, mountPath: string } | null}
 */
function tryParseGitCloneTokens(tokens) {
  if (!Array.isArray(tokens) || tokens.length < 3) return null;
  if (tokens[0] !== "git" || tokens[1] !== "clone") return null;

  let ref = "";
  const positionals = [];
  let endOfOpts = false;

  for (let i = 2; i < tokens.length; i++) {
    const tok = tokens[i];
    if (endOfOpts) {
      positionals.push(tok);
      continue;
    }
    if (tok === "--") {
      endOfOpts = true;
      continue;
    }
    if (tok === "-b" || tok === "--branch") {
      if (i + 1 >= tokens.length) return null;
      ref = tokens[++i];
      continue;
    }
    if (tok.startsWith("--branch=")) {
      ref = tok.slice("--branch=".length);
      continue;
    }
    if (tok === "--depth") {
      if (i + 1 >= tokens.length) return null;
      i++; // ignore depth value
      continue;
    }
    if (tok.startsWith("--depth=")) {
      continue;
    }
    if (
      tok === "--single-branch" ||
      tok === "--no-single-branch" ||
      tok === "-q" ||
      tok === "--quiet" ||
      tok === "--recursive" ||
      tok === "--recurse-submodules"
    ) {
      continue;
    }
    if (tok.startsWith("-")) {
      // Unknown flag -> fall back to generic RUN layer
      return null;
    }
    positionals.push(tok);
  }

  if (positionals.length < 1 || positionals.length > 2) return null;
  const repo = normalizeGitRepo(positionals[0]);
  if (!repo) return null;
  const mountPath = positionals[1] ? normalizeMountPath(positionals[1]) : DEFAULT_MOUNT_PATH;
  return {
    repo,
    ...(ref ? { ref } : {}),
    mountPath,
  };
}

/**
 * Parse Dockerfile `ENV` arguments supporting:
 * - `ENV KEY=VALUE`
 * - `ENV KEY="quoted val"` / `ENV KEY='quoted val'`
 * - Multi-pair `ENV A=1 B="two words"`
 * - Legacy `ENV KEY VALUE`
 *
 * @param {string} rest
 * @returns {Array<{ key: string, value: string }>}
 */
function parseEnvDirective(rest) {
  const s = String(rest ?? "").trim();
  if (!s) return [];

  // Determine whether the first token contains an unquoted '=' (modern syntax)
  let firstEq = -1;
  let firstWs = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "=") {
      firstEq = i;
      break;
    }
    if (/\s/.test(ch)) {
      firstWs = i;
      break;
    }
  }

  // Legacy form: `ENV KEY VALUE` (no '=' before first whitespace)
  if (firstEq === -1) {
    if (firstWs === -1) return [];
    const key = s.slice(0, firstWs).trim();
    const value = s.slice(firstWs).trim();
    if (!key) return [];
    return [{ key, value }];
  }

  // Modern form: one or more KEY=VALUE pairs
  const pairs = [];
  let i = 0;
  const len = s.length;
  while (i < len) {
    while (i < len && /\s/.test(s[i])) i++;
    if (i >= len) break;

    const keyStart = i;
    while (i < len && s[i] !== "=" && !/\s/.test(s[i])) i++;
    const key = s.slice(keyStart, i);
    if (!key || i >= len || s[i] !== "=") break;
    i++; // skip '='

    let value = "";
    if (i < len && (s[i] === '"' || s[i] === "'")) {
      const quote = s[i++];
      while (i < len && s[i] !== quote) {
        if (quote === '"' && s[i] === "\\" && i + 1 < len) {
          const next = s[i + 1];
          if (next === '"' || next === "\\" || next === "n" || next === "t") {
            value += next === "n" ? "\n" : next === "t" ? "\t" : next;
            i += 2;
            continue;
          }
        }
        value += s[i++];
      }
      if (i < len && s[i] === quote) i++;
    } else {
      while (i < len && !/\s/.test(s[i])) {
        if (s[i] === "\\" && i + 1 < len) {
          value += s[i + 1];
          i += 2;
          continue;
        }
        value += s[i++];
      }
    }

    pairs.push({ key, value });
  }

  return pairs;
}

function unquoteSimple(raw) {
  const s = String(raw ?? "").trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

function quoteShellArg(arg) {
  const s = String(arg ?? "");
  if (s === "" || /[\s"'\\$`|&;<>()!*?[\]{}]/.test(s)) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return s;
}

function formatEnvValue(val) {
  const s = String(val ?? "");
  if (s === "" || /[\s"'\\=\n\t]/.test(s)) {
    const escaped = s
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\t/g, "\\t");
    return `"${escaped}"`;
  }
  return s;
}

/**
 * Parse Dockerfile text into structured `Layer[]` and non-fatal `warnings[]`.
 *
 * @param {string} text
 * @returns {{ layers: object[], warnings: string[] }}
 */
export function parseDockerfile(text) {
  const normalized = cleanText(text).replace(/\r\n?/g, "\n");
  const rawLines = normalized.split("\n");

  const layers = [];
  const warnings = [];
  let nextLayerNum = 1;
  const makeId = () => `layer-${nextLayerNum++}`;

  let pendingExecutor = null;
  let pendingExecutorLine = 0;

  const consumePendingExecutor = () => {
    const exec = pendingExecutor ?? DEFAULT_EXECUTOR;
    pendingExecutor = null;
    pendingExecutorLine = 0;
    return exec;
  };

  const warnUnusedExecutor = (reason) => {
    if (pendingExecutor !== null) {
      warnings.push(
        `Line ${pendingExecutorLine}: # elf2wasm:executor=${pendingExecutor} ${reason} (ignored)`
      );
      pendingExecutor = null;
      pendingExecutorLine = 0;
    }
  };

  let i = 0;
  while (i < rawLines.length) {
    const startLineNum = i + 1;
    const trimmed = rawLines[i].trim();
    i++;

    if (!trimmed) continue;

    // Comment or # elf2wasm:... directive
    if (trimmed.startsWith("#")) {
      const metaMatch = /^#\s*elf2wasm:([a-zA-Z0-9_-]+)(?:=(.*)|(?:\s+(.*))|$)/i.exec(trimmed);
      if (!metaMatch) continue;

      const metaKind = metaMatch[1].toLowerCase();
      const eqVal = metaMatch[2];
      const spVal = metaMatch[3];

      if (metaKind === "executor") {
        const rawExec = cleanSingleLine(eqVal ?? spVal ?? "").toLowerCase();
        if (rawExec !== "local" && rawExec !== "remote") {
          warnings.push(
            `Line ${startLineNum}: Invalid # elf2wasm:executor value "${rawExec}" (expected "local" or "remote")`
          );
          pendingExecutor = null;
          pendingExecutorLine = 0;
        } else {
          if (pendingExecutor !== null) {
            warnUnusedExecutor("was followed by another executor directive");
          }
          pendingExecutor = rawExec;
          pendingExecutorLine = startLineNum;
        }
        continue;
      }

      if (metaKind === "git") {
        const kv = parseKeyValuePairs(spVal ?? eqVal ?? "");
        const repo = normalizeGitRepo(kv.repo ?? "");
        if (!repo) {
          warnings.push(`Line ${startLineNum}: # elf2wasm:git requires repo=<owner/repo>`);
          continue;
        }
        const ref = cleanSingleLine(kv.ref ?? "");
        const mountPath = normalizeMountPath(kv.mount ?? kv.mountPath ?? DEFAULT_MOUNT_PATH);
        const executor = consumePendingExecutor();
        const layer = {
          id: makeId(),
          type: "git",
          repo,
          ...(ref ? { ref } : {}),
          mountPath,
          executor,
        };
        layers.push(layer);
        continue;
      }

      if (metaKind === "sweep") {
        warnUnusedExecutor("cannot apply to a sweep layer");
        const kv = parseKeyValuePairs(spVal ?? eqVal ?? "");
        const param = cleanSingleLine(kv.param ?? "").toLowerCase();
        if (!VALID_SWEEP_PARAMS.includes(param)) {
          warnings.push(
            `Line ${startLineNum}: # elf2wasm:sweep has invalid param "${param}" (expected delay, seed, or env)`
          );
          continue;
        }
        let mode = cleanSingleLine(kv.mode ?? "").toLowerCase();
        if (!mode) {
          mode = kv.values !== undefined ? "list" : "range";
        }
        if (!VALID_SWEEP_MODES.includes(mode)) {
          warnings.push(
            `Line ${startLineNum}: # elf2wasm:sweep has invalid mode "${mode}" (expected range or list)`
          );
          continue;
        }
        const envKey = param === "env" ? cleanSingleLine(kv.envKey ?? kv.key ?? "") : "";
        if (param === "env" && !envKey) {
          warnings.push(`Line ${startLineNum}: # elf2wasm:sweep with param=env requires envKey=<KEY>`);
          continue;
        }
        if (mode === "range") {
          const nums = normalizeSweepRangeNumbers(
            param,
            kv.start ?? (param === "delay" ? 1 : 0),
            kv.step ?? 1,
            kv.count ?? 5
          );
          layers.push({
            id: makeId(),
            type: "sweep",
            param,
            ...(param === "env" ? { envKey } : {}),
            mode: "range",
            ...nums,
          });
        } else {
          const values = parseSweepListValues(kv.values ?? "");
          layers.push({
            id: makeId(),
            type: "sweep",
            param,
            ...(param === "env" ? { envKey } : {}),
            mode: "list",
            values,
          });
        }
        continue;
      }

      warnings.push(`Line ${startLineNum}: Unknown # elf2wasm:${metaKind} directive (ignored)`);
      continue;
    }

    // Non-comment Dockerfile instruction: handle trailing backslash continuations
    const parts = [];
    let currentLine = trimmed;
    while (currentLine.endsWith("\\") && !currentLine.endsWith("\\\\")) {
      parts.push(currentLine.slice(0, -1).replace(/[ \t]+$/, ""));
      // Skip intermediate blank lines and comments during continuation
      let nextFound = false;
      while (i < rawLines.length) {
        const nextRaw = rawLines[i];
        i++;
        const nextTrim = nextRaw.trim();
        if (!nextTrim || nextTrim.startsWith("#")) continue;
        currentLine = nextTrim;
        nextFound = true;
        break;
      }
      if (!nextFound) {
        currentLine = "";
        break;
      }
    }
    if (currentLine) {
      parts.push(currentLine);
    }

    const firstPart = parts[0] || "";
    const dirMatch = /^([A-Za-z]+)(?:\s+([\s\S]*))?$/.exec(firstPart);
    if (!dirMatch) {
      warnings.push(`Line ${startLineNum}: Could not parse Dockerfile line`);
      continue;
    }

    const directive = dirMatch[1].toUpperCase();
    let rest;
    if (directive === "RUN" && parts.length > 1) {
      const runParts = [dirMatch[2] ?? "", ...parts.slice(1)];
      // Join continuation lines: preserve newlines for multi-line scripts,
      // except when a continuation line begins with a shell chaining operator (`&&`, `||`, `|`, `;`).
      let combined = runParts[0];
      for (let p = 1; p < runParts.length; p++) {
        const seg = runParts[p];
        if (/^(?:&&|\|\||\||;)/.test(seg)) {
          combined += (combined.endsWith(" ") ? "" : " ") + seg;
        } else {
          combined += "\n" + seg;
        }
      }
      rest = combined.trim();
    } else {
      const joined = parts.join(" ");
      const m2 = /^[A-Za-z]+(?:\s+([\s\S]*))?$/.exec(joined);
      rest = (m2 && m2[1] ? m2[1] : "").trim();
    }

    switch (directive) {
      case "FROM": {
        const tokens = tokenizeShellArgs(rest) ?? rest.split(/\s+/).filter(Boolean);
        let idx = 0;
        while (idx < tokens.length && tokens[idx].startsWith("--")) {
          const flag = tokens[idx++];
          if (flag.startsWith("--platform=")) {
            const plat = flag.slice("--platform=".length).toLowerCase();
            if (plat && plat !== "linux/amd64" && plat !== "amd64") {
              warnings.push(
                `Line ${startLineNum}: FROM --platform=${plat} is not linux/amd64; elf2wasm executes linux/amd64 images`
              );
            }
          }
        }
        const image = tokens[idx] || "";
        if (!image) {
          warnings.push(`Line ${startLineNum}: FROM directive is missing an image reference`);
          consumePendingExecutor();
          break;
        }
        if (idx + 1 < tokens.length && tokens[idx + 1].toUpperCase() === "AS") {
          const stageName = tokens[idx + 2] || "";
          warnings.push(
            `Line ${startLineNum}: Multi-stage alias "AS ${stageName}" is stripped in single-stage layer stack`
          );
        }
        const executor = consumePendingExecutor();
        layers.push({
          id: makeId(),
          type: "from",
          image,
          executor,
        });
        break;
      }

      case "WORKDIR": {
        warnUnusedExecutor("cannot apply to WORKDIR");
        const pathVal = unquoteSimple(rest);
        if (!pathVal) {
          warnings.push(`Line ${startLineNum}: WORKDIR directive is missing a path`);
          break;
        }
        layers.push({
          id: makeId(),
          type: "workdir",
          path: pathVal,
        });
        break;
      }

      case "ENV": {
        warnUnusedExecutor("cannot apply to ENV");
        const pairs = parseEnvDirective(rest);
        if (pairs.length === 0) {
          warnings.push(`Line ${startLineNum}: ENV directive has no valid KEY=VALUE pairs`);
          break;
        }
        for (const pair of pairs) {
          layers.push({
            id: makeId(),
            type: "env",
            key: pair.key,
            value: pair.value,
          });
        }
        break;
      }

      case "RUN": {
        if (!rest) {
          warnings.push(`Line ${startLineNum}: RUN directive is missing a command`);
          consumePendingExecutor();
          break;
        }
        let cmdStr = rest;
        let parsedExecTokens = null;

        // Check JSON exec form: RUN ["cmd", "arg1", ...]
        if (rest.startsWith("[")) {
          try {
            const parsed = JSON.parse(rest);
            if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((x) => typeof x === "string")) {
              parsedExecTokens = parsed;
              cmdStr = parsed.map(quoteShellArg).join(" ");
            }
          } catch {
            // Not valid JSON exec form -> treat as shell form
          }
        }

        let gitParsed = null;
        if (parsedExecTokens) {
          gitParsed = tryParseGitCloneTokens(parsedExecTokens);
        } else if (!hasUnquotedShellOperators(cmdStr)) {
          const tokens = tokenizeShellArgs(cmdStr);
          if (tokens) {
            gitParsed = tryParseGitCloneTokens(tokens);
          }
        }

        const executor = consumePendingExecutor();
        if (gitParsed) {
          layers.push({
            id: makeId(),
            type: "git",
            repo: gitParsed.repo,
            ...(gitParsed.ref ? { ref: gitParsed.ref } : {}),
            mountPath: gitParsed.mountPath,
            executor,
          });
        } else {
          layers.push({
            id: makeId(),
            type: "run",
            cmd: cmdStr,
            executor,
          });
        }
        break;
      }

      default: {
        warnUnusedExecutor(`cannot apply to unsupported directive ${directive}`);
        warnings.push(
          `Line ${startLineNum}: Unsupported Dockerfile directive "${directive}" (ignored)`
        );
        break;
      }
    }
  }

  if (pendingExecutor !== null) {
    warnUnusedExecutor("reached end of Dockerfile without a following FROM/GIT/RUN layer");
  }

  return { layers, warnings };
}

/**
 * Serialize a `Layer[]` array into canonical Dockerfile text that losslessly
 * round-trips through `parseDockerfile()`.
 *
 * @param {object[]} layers
 * @returns {string}
 */
export function serializeDockerfile(layers) {
  if (!Array.isArray(layers) || layers.length === 0) return "";
  const lines = [];

  for (const rawLayer of layers) {
    if (!rawLayer || typeof rawLayer !== "object") continue;
    const type = rawLayer.type;

    if (type === "from") {
      const image = cleanSingleLine(rawLayer.image);
      if (!image) continue;
      if (normalizeExecutor(rawLayer.executor) === "remote") {
        lines.push("# elf2wasm:executor=remote");
      }
      lines.push(`FROM ${image}`);
      continue;
    }

    if (type === "git") {
      const repo = normalizeGitRepo(rawLayer.repo);
      if (!repo) continue;
      if (normalizeExecutor(rawLayer.executor) === "remote") {
        lines.push("# elf2wasm:executor=remote");
      }
      const parts = ["RUN", "git", "clone"];
      const ref = cleanSingleLine(rawLayer.ref);
      if (ref) {
        parts.push("--branch", quoteShellArg(ref));
      }
      const repoUrl = OWNER_REPO_RE.test(repo) ? `https://github.com/${repo}` : repo;
      parts.push(quoteShellArg(repoUrl));
      const mountPath = normalizeMountPath(rawLayer.mountPath);
      if (mountPath && mountPath !== DEFAULT_MOUNT_PATH) {
        parts.push(quoteShellArg(mountPath));
      }
      lines.push(parts.join(" "));
      continue;
    }

    if (type === "workdir") {
      const pathVal = cleanSingleLine(rawLayer.path);
      if (!pathVal) continue;
      lines.push(`WORKDIR ${/\s/.test(pathVal) ? quoteShellArg(pathVal) : pathVal}`);
      continue;
    }

    if (type === "env") {
      const key = cleanSingleLine(rawLayer.key);
      if (!key) continue;
      const value = cleanText(rawLayer.value ?? "");
      lines.push(`ENV ${key}=${formatEnvValue(value)}`);
      continue;
    }

    if (type === "run") {
      const cmd = cleanText(rawLayer.cmd ?? "").replace(/\r\n?/g, "\n").trim();
      if (!cmd) continue;
      if (normalizeExecutor(rawLayer.executor) === "remote") {
        lines.push("# elf2wasm:executor=remote");
      }
      const formatted = cmd.includes("\n")
        ? cmd
            .split("\n")
            .map((seg) => seg.trim())
            .join(" \\\n  ")
        : cmd;
      lines.push(`RUN ${formatted}`);
      continue;
    }

    if (type === "sweep") {
      const param = VALID_SWEEP_PARAMS.includes(rawLayer.param) ? rawLayer.param : "delay";
      const mode = VALID_SWEEP_MODES.includes(rawLayer.mode) ? rawLayer.mode : "range";
      const envKey = param === "env" ? cleanSingleLine(rawLayer.envKey) : "";
      if (param === "env" && !envKey) continue;

      const tokens = ["# elf2wasm:sweep", `param=${param}`];
      if (param === "env") {
        tokens.push(`envKey=${formatDirectiveValue(envKey)}`);
      }
      tokens.push(`mode=${mode}`);
      if (mode === "range") {
        const nums = normalizeSweepRangeNumbers(
          param,
          rawLayer.start ?? (param === "delay" ? 1 : 0),
          rawLayer.step ?? 1,
          rawLayer.count ?? 5
        );
        tokens.push(`start=${nums.start}`, `step=${nums.step}`, `count=${nums.count}`);
      } else {
        const values = Array.isArray(rawLayer.values)
          ? rawLayer.values.slice(0, MAX_SWEEP_COUNT).map((v) => cleanText(v))
          : [];
        tokens.push(`values=${formatSweepListValues(values)}`);
      }
      lines.push(tokens.join(" "));
    }
  }

  return lines.join("\n");
}

/**
 * Expand a `sweep` layer into a concrete ordered array of variation descriptors.
 *
 * @param {object} sweepLayer
 * @returns {Array<{ label: string, param: "delay"|"seed"|"env", envKey?: string, delayStddevMs?: number, delaySeed?: number, envOverride?: [string, string] }>}
 */
export function expandSweepValues(sweepLayer) {
  if (!sweepLayer || typeof sweepLayer !== "object") return [];
  const param = sweepLayer.param;
  if (!VALID_SWEEP_PARAMS.includes(param)) return [];
  const mode = sweepLayer.mode;
  if (!VALID_SWEEP_MODES.includes(mode)) return [];

  const envKey = param === "env" ? cleanSingleLine(sweepLayer.envKey) : "";
  if (param === "env" && !envKey) return [];

  const out = [];

  if (mode === "range") {
    const rawCount = Number(sweepLayer.count);
    if (!Number.isFinite(rawCount) || rawCount <= 0) return [];
    const count = Math.min(MAX_SWEEP_COUNT, Math.floor(rawCount));
    const nums = normalizeSweepRangeNumbers(param, sweepLayer.start ?? 0, sweepLayer.step ?? 1, count);

    for (let i = 0; i < nums.count; i++) {
      if (param === "delay") {
        const val = round3(Math.min(MAX_DELAY_MS, Math.max(0, nums.start + i * nums.step)));
        out.push({
          label: `delay=${val}ms`,
          param: "delay",
          delayStddevMs: val,
        });
      } else if (param === "seed") {
        const val = normalizeZero(
          Math.min(MAX_SEED, Math.max(0, Math.floor(nums.start + i * nums.step)))
        );
        out.push({
          label: `seed=${val}`,
          param: "seed",
          delaySeed: val,
        });
      } else {
        const val = round3(nums.start + i * nums.step);
        const strVal = String(val);
        out.push({
          label: `${envKey}=${strVal}`,
          param: "env",
          envKey,
          envOverride: [envKey, strVal],
        });
      }
    }
    return out;
  }

  // mode === "list"
  const rawValues = Array.isArray(sweepLayer.values)
    ? sweepLayer.values
    : typeof sweepLayer.values === "string"
      ? parseSweepListValues(sweepLayer.values)
      : [];

  for (let i = 0; i < rawValues.length && out.length < MAX_SWEEP_COUNT; i++) {
    const raw = rawValues[i];
    if (param === "delay") {
      const n = Number(String(raw ?? "").trim());
      if (!Number.isFinite(n) || n < 0) continue;
      const val = round3(Math.min(MAX_DELAY_MS, n));
      out.push({
        label: `delay=${val}ms`,
        param: "delay",
        delayStddevMs: val,
      });
    } else if (param === "seed") {
      const n = Number(String(raw ?? "").trim());
      if (!Number.isFinite(n) || n < 0) continue;
      const val = normalizeZero(Math.min(MAX_SEED, Math.floor(n)));
      out.push({
        label: `seed=${val}`,
        param: "seed",
        delaySeed: val,
      });
    } else {
      const strVal = cleanText(raw ?? "");
      out.push({
        label: `${envKey}=${strVal}`,
        param: "env",
        envKey,
        envOverride: [envKey, strVal],
      });
    }
  }

  return out;
}
