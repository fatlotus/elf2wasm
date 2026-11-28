import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_MOUNT_PATH,
  DEFAULT_EXECUTOR,
  VALID_EXECUTORS,
  VALID_SWEEP_PARAMS,
  VALID_SWEEP_MODES,
  MAX_SWEEP_COUNT,
  MAX_DELAY_MS,
  MAX_SEED,
  normalizeExecutor,
  createLayer,
  parseDockerfile,
  serializeDockerfile,
  expandSweepValues,
} from "../web/dockerfile.mjs";

describe("web/dockerfile.mjs: constants and helpers", () => {
  it("exports expected constants and normalizeExecutor/createLayer helpers", () => {
    assert.equal(DEFAULT_MOUNT_PATH, "/workspace");
    assert.equal(DEFAULT_EXECUTOR, "local");
    assert.deepEqual(VALID_EXECUTORS, ["local", "remote"]);
    assert.deepEqual(VALID_SWEEP_PARAMS, ["delay", "seed", "env"]);
    assert.deepEqual(VALID_SWEEP_MODES, ["range", "list"]);
    assert.equal(MAX_SWEEP_COUNT, 1000);
    assert.equal(MAX_DELAY_MS, 3_600_000);
    assert.equal(MAX_SEED, Number.MAX_SAFE_INTEGER);

    assert.equal(normalizeExecutor("remote"), "remote");
    assert.equal(normalizeExecutor("  REMOTE "), "remote");
    assert.equal(normalizeExecutor("local"), "local");
    assert.equal(normalizeExecutor("invalid", "remote"), "remote");
    assert.equal(normalizeExecutor(null), "local");

    assert.deepEqual(createLayer("from", { id: "l1", image: "node:22-slim", executor: "remote" }), {
      id: "l1",
      type: "from",
      image: "node:22-slim",
      executor: "remote",
    });
    assert.deepEqual(
      createLayer("git", {
        id: "l2",
        repo: "https://github.com/expressjs/express.git",
        ref: "v5.0.0",
      }),
      {
        id: "l2",
        type: "git",
        repo: "expressjs/express",
        ref: "v5.0.0",
        mountPath: "/workspace",
        executor: "local",
      }
    );
    assert.throws(() => createLayer("bogus"), TypeError);
  });
});

describe("web/dockerfile.mjs: parseDockerfile", () => {
  it("parses standard FROM, WORKDIR, ENV (modern, quoted, multi-pair, legacy), and RUN", () => {
    const df = [
      "# Leading comment",
      "FROM python:3.12-slim",
      "WORKDIR /app",
      'ENV FOO=bar BAZ="hello world" EMPTY=""',
      "ENV LEGACY_KEY some legacy value with spaces",
      "RUN python3 -m unittest",
    ].join("\r\n");

    const { layers, warnings } = parseDockerfile(df);
    assert.deepEqual(warnings, []);
    assert.deepEqual(layers, [
      { id: "layer-1", type: "from", image: "python:3.12-slim", executor: "local" },
      { id: "layer-2", type: "workdir", path: "/app" },
      { id: "layer-3", type: "env", key: "FOO", value: "bar" },
      { id: "layer-4", type: "env", key: "BAZ", value: "hello world" },
      { id: "layer-5", type: "env", key: "EMPTY", value: "" },
      { id: "layer-6", type: "env", key: "LEGACY_KEY", value: "some legacy value with spaces" },
      { id: "layer-7", type: "run", cmd: "python3 -m unittest", executor: "local" },
    ]);
  });

  it("parses RUN git clone shorthands and # elf2wasm:git into git layers, but keeps chained commands as run layers", () => {
    const df = `
FROM node:22-slim
RUN git clone --depth 1 --single-branch -b v5.0.0 https://github.com/expressjs/express.git
RUN git clone git@github.com:pallets/flask.git /src/flask
RUN git clone --branch=main https://gitlab.com/org/non-github.git /opt/proj
# elf2wasm:git repo=https://github.com/fatlotus/nodice ref=main mount=/code
RUN git clone https://github.com/expressjs/express.git && ls /workspace
RUN ["git", "clone", "--branch", "dev", "https://github.com/owner/exec-repo.git", "/exec"]
RUN ["echo", "hello world"]
`;
    const { layers, warnings } = parseDockerfile(df);
    assert.deepEqual(warnings, []);
    assert.deepEqual(layers, [
      { id: "layer-1", type: "from", image: "node:22-slim", executor: "local" },
      {
        id: "layer-2",
        type: "git",
        repo: "expressjs/express",
        ref: "v5.0.0",
        mountPath: "/workspace",
        executor: "local",
      },
      {
        id: "layer-3",
        type: "git",
        repo: "pallets/flask",
        mountPath: "/src/flask",
        executor: "local",
      },
      {
        id: "layer-4",
        type: "git",
        repo: "https://gitlab.com/org/non-github.git",
        ref: "main",
        mountPath: "/opt/proj",
        executor: "local",
      },
      {
        id: "layer-5",
        type: "git",
        repo: "fatlotus/nodice",
        ref: "main",
        mountPath: "/code",
        executor: "local",
      },
      {
        id: "layer-6",
        type: "run",
        cmd: "git clone https://github.com/expressjs/express.git && ls /workspace",
        executor: "local",
      },
      {
        id: "layer-7",
        type: "git",
        repo: "owner/exec-repo",
        ref: "dev",
        mountPath: "/exec",
        executor: "local",
      },
      {
        id: "layer-8",
        type: "run",
        cmd: 'echo "hello world"',
        executor: "local",
      },
    ]);
  });

  it("handles # elf2wasm:executor=remote/local and warns on invalid or misplaced executor annotations", () => {
    const df = `
# elf2wasm:executor=remote
FROM alpine:latest
# elf2wasm:executor=remote
RUN git clone https://github.com/owner/repo.git
# elf2wasm:executor=remote
WORKDIR /workspace
# elf2wasm:executor=bogus
RUN echo local-after-bogus
# elf2wasm:executor=remote
RUN echo remote-run
# elf2wasm:executor=remote
`;
    const { layers, warnings } = parseDockerfile(df);
    assert.equal(layers.length, 5);
    assert.equal(layers[0].executor, "remote");
    assert.equal(layers[1].executor, "remote");
    assert.equal(layers[2].type, "workdir");
    assert.equal(layers[3].executor, "local");
    assert.equal(layers[4].executor, "remote");
    assert.equal(warnings.length, 3);
    assert.match(warnings[0], /WORKDIR/);
    assert.match(warnings[1], /Invalid # elf2wasm:executor/);
    assert.match(warnings[2], /end of Dockerfile/);
  });

  it("parses # elf2wasm:sweep for delay, seed, and env in both range and list modes", () => {
    const df = `
FROM alpine:latest
# elf2wasm:sweep param=delay mode=range start=0.5 step=0.25 count=4
# elf2wasm:sweep param=seed mode=list values="1, 2, 42"
# elf2wasm:sweep param=env envKey=WORKERS mode=range start=1 step=2 count=3
# elf2wasm:sweep param=env envKey=MODE mode=list values="fast,slow,extra\\,comma"
# elf2wasm:sweep param=env mode=list values="missing-key"
# elf2wasm:sweep param=bogus mode=range start=0 step=1 count=2
`;
    const { layers, warnings } = parseDockerfile(df);
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /envKey/);
    assert.match(warnings[1], /invalid param/);
    assert.deepEqual(layers, [
      { id: "layer-1", type: "from", image: "alpine:latest", executor: "local" },
      {
        id: "layer-2",
        type: "sweep",
        param: "delay",
        mode: "range",
        start: 0.5,
        step: 0.25,
        count: 4,
      },
      {
        id: "layer-3",
        type: "sweep",
        param: "seed",
        mode: "list",
        values: ["1", "2", "42"],
      },
      {
        id: "layer-4",
        type: "sweep",
        param: "env",
        envKey: "WORKERS",
        mode: "range",
        start: 1,
        step: 2,
        count: 3,
      },
      {
        id: "layer-5",
        type: "sweep",
        param: "env",
        envKey: "MODE",
        mode: "list",
        values: ["fast", "slow", "extra,comma"],
      },
    ]);
  });

  it("handles backslash line continuations across blank and comment lines with single-space joining", () => {
    const df = `
FROM alpine:latest
RUN echo first \\
  # intermediate comment

  && echo second
RUN apk add --no-cache \\
  curl \\
  jq
RUN git clone \\
  --branch main \\
  https://github.com/org/repo /app
RUN echo foo\\\\\\
  && echo bar
`;
    const { layers, warnings } = parseDockerfile(df);
    assert.deepEqual(warnings, []);
    assert.equal(layers[1].type, "run");
    assert.equal(layers[1].cmd, "echo first && echo second");
    assert.equal(layers[2].type, "run");
    assert.equal(layers[2].cmd, "apk add --no-cache curl jq");
    assert.deepEqual(layers[3], {
      id: "layer-4",
      type: "git",
      repo: "org/repo",
      ref: "main",
      mountPath: "/app",
      executor: "local",
    });
    assert.equal(layers[4].type, "run");
    assert.equal(layers[4].cmd, "echo foo\\\\ && echo bar");
  });

  it("emits line-numbered warnings for unsupported directives, non-amd64 platform, and multi-stage AS", () => {
    const df = `
FROM --platform=linux/arm64 alpine:latest AS builder
COPY . /app
EXPOSE 8080
CMD ["sh"]
RUN echo ok
`;
    const { layers, warnings } = parseDockerfile(df);
    assert.deepEqual(layers, [
      { id: "layer-1", type: "from", image: "alpine:latest", executor: "local" },
      { id: "layer-2", type: "run", cmd: "echo ok", executor: "local" },
    ]);
    assert.equal(warnings.length, 5);
    assert.match(warnings[0], /Line 2:.*linux\/arm64/);
    assert.match(warnings[1], /Line 2:.*AS builder/);
    assert.match(warnings[2], /Line 3:.*COPY/);
    assert.match(warnings[3], /Line 4:.*EXPOSE/);
    assert.match(warnings[4], /Line 5:.*CMD/);
  });
});

describe("web/dockerfile.mjs: serializeDockerfile lossless round-trip", () => {
  it("losslessly round-trips all 6 layer types with zero warnings and strict deepEqual", () => {
    const inputLayers = [
      { id: "layer-1", type: "from", image: "ghcr.io/fatlotus/golang-with-cache:1.27-alpine", executor: "remote" },
      { id: "layer-2", type: "git", repo: "fatlotus/nodice", ref: "main", mountPath: "/workspace", executor: "local" },
      { id: "layer-3", type: "git", repo: "pallets/flask", mountPath: "/opt/flask", executor: "remote" },
      { id: "layer-4", type: "workdir", path: "/workspace/example" },
      { id: "layer-5", type: "env", key: "SIMPLE", value: "123" },
      { id: "layer-6", type: "env", key: "QUOTED", value: 'hello "world" = 1' },
      { id: "layer-7", type: "env", key: "EMPTY", value: "" },
      { id: "layer-8", type: "run", cmd: "go build", executor: "local" },
      { id: "layer-9", type: "run", cmd: "echo step1\necho step2", executor: "remote" },
      { id: "layer-10", type: "sweep", param: "delay", mode: "range", start: 0.1, step: 0.2, count: 5 },
      { id: "layer-11", type: "sweep", param: "seed", mode: "list", values: ["1", "7", "99"] },
      { id: "layer-12", type: "sweep", param: "env", envKey: "LOG_LEVEL", mode: "list", values: ["debug", "info,warn"] },
      { id: "layer-13", type: "run", cmd: "./raft --check", executor: "remote" },
    ];

    const text = serializeDockerfile(inputLayers);
    const { layers, warnings } = parseDockerfile(text);
    assert.deepEqual(warnings, []);
    assert.deepEqual(layers, inputLayers);
    assert.equal(serializeDockerfile(layers), text);
  });
});

describe("web/dockerfile.mjs: expandSweepValues", () => {
  it("expands delay range with float-drift protection and clamping", () => {
    const vals = expandSweepValues({
      type: "sweep",
      param: "delay",
      mode: "range",
      start: 0.1,
      step: 0.2,
      count: 4,
    });
    assert.deepEqual(vals, [
      { label: "delay=0.1ms", param: "delay", delayStddevMs: 0.1 },
      { label: "delay=0.3ms", param: "delay", delayStddevMs: 0.3 },
      { label: "delay=0.5ms", param: "delay", delayStddevMs: 0.5 },
      { label: "delay=0.7ms", param: "delay", delayStddevMs: 0.7 },
    ]);

    const clamped = expandSweepValues({
      type: "sweep",
      param: "delay",
      mode: "range",
      start: MAX_DELAY_MS - 10,
      step: 50,
      count: 3,
    });
    assert.equal(clamped[1].delayStddevMs, MAX_DELAY_MS);
    assert.equal(clamped[2].delayStddevMs, MAX_DELAY_MS);
  });

  it("expands seed range and list with integer coercion and clamping", () => {
    const rangeVals = expandSweepValues({
      type: "sweep",
      param: "seed",
      mode: "range",
      start: 10,
      step: 5,
      count: 3,
    });
    assert.deepEqual(rangeVals, [
      { label: "seed=10", param: "seed", delaySeed: 10 },
      { label: "seed=15", param: "seed", delaySeed: 15 },
      { label: "seed=20", param: "seed", delaySeed: 20 },
    ]);

    const listVals = expandSweepValues({
      type: "sweep",
      param: "seed",
      mode: "list",
      values: ["0", "3.9", "-5", "abc", String(MAX_SEED + 1000)],
    });
    assert.deepEqual(listVals, [
      { label: "seed=0", param: "seed", delaySeed: 0 },
      { label: "seed=3", param: "seed", delaySeed: 3 },
      { label: `seed=${MAX_SEED}`, param: "seed", delaySeed: MAX_SEED },
    ]);
  });

  it("expands env range and list, and returns [] for empty envKey or count <= 0", () => {
    const rangeVals = expandSweepValues({
      type: "sweep",
      param: "env",
      envKey: "SCALE",
      mode: "range",
      start: -0.5,
      step: 0.5,
      count: 3,
    });
    assert.deepEqual(rangeVals, [
      { label: "SCALE=-0.5", param: "env", envKey: "SCALE", envOverride: ["SCALE", "-0.5"] },
      { label: "SCALE=0", param: "env", envKey: "SCALE", envOverride: ["SCALE", "0"] },
      { label: "SCALE=0.5", param: "env", envKey: "SCALE", envOverride: ["SCALE", "0.5"] },
    ]);

    const listVals = expandSweepValues({
      type: "sweep",
      param: "env",
      envKey: "MODE",
      mode: "list",
      values: ["fast", "accurate"],
    });
    assert.deepEqual(listVals, [
      { label: "MODE=fast", param: "env", envKey: "MODE", envOverride: ["MODE", "fast"] },
      { label: "MODE=accurate", param: "env", envKey: "MODE", envOverride: ["MODE", "accurate"] },
    ]);

    assert.deepEqual(
      expandSweepValues({ type: "sweep", param: "env", envKey: "   ", mode: "list", values: ["a"] }),
      []
    );
    assert.deepEqual(
      expandSweepValues({ type: "sweep", param: "delay", mode: "range", start: 1, step: 1, count: 0 }),
      []
    );
    assert.equal(
      expandSweepValues({ type: "sweep", param: "delay", mode: "range", start: 0, step: 1, count: 5000 }).length,
      MAX_SWEEP_COUNT
    );
  });

  it("round-trips multi-line literal-newline RUN scripts losslessly via BuildKit heredoc", () => {
    const input = [
      { id: "layer-1", type: "from", image: "alpine:latest", executor: "local" },
      { id: "layer-2", type: "run", cmd: "echo line1\necho ELF2WASM_EOF\nELF2WASM_EOF\necho line2", executor: "remote" },
    ];
    const text = serializeDockerfile(input);
    assert.match(text, /# elf2wasm:executor=remote\nRUN <<'ELF2WASM_EOF_1'/);
    const { layers, warnings } = parseDockerfile(text);
    assert.deepEqual(warnings, []);
    assert.deepEqual(layers, input);
  });

  it("keeps huge finite env sweep range values finite without round3() Infinity overflow", () => {
    const df = "# elf2wasm:sweep param=env envKey=BIG mode=range start=1e306 step=1 count=2";
    const { layers, warnings } = parseDockerfile(df);
    assert.deepEqual(warnings, []);
    assert.equal(layers.length, 1);
    assert.equal(Number.isFinite(layers[0].start), true);
    assert.equal(layers[0].start, 1e306);
    const serialized = serializeDockerfile(layers);
    const reparsed = parseDockerfile(serialized);
    assert.deepEqual(reparsed.warnings, []);
    assert.deepEqual(reparsed.layers, layers);
    const expanded = expandSweepValues(layers[0]);
    assert.equal(expanded.length, 2);
    assert.equal(expanded[0].envOverride[1], String(1e306));
  });

  it("escapes $ and backtick in quoteShellArg for JSON exec-form RUN and git layer ref/mountPath", () => {
    const parsedExec = parseDockerfile(
      'FROM alpine:latest\nRUN ["echo", "$HOME", "$(id)", "`uname`"]'
    );
    assert.deepEqual(parsedExec.warnings, []);
    assert.equal(parsedExec.layers[1].type, "run");
    assert.equal(parsedExec.layers[1].cmd, 'echo "\\$HOME" "\\$(id)" "\\`uname\\`"');

    // git layer with $, $(...), and backticks in ref & mountPath round-trips as type "git"
    const gitLayers = [
      { id: "layer-1", type: "from", image: "alpine:latest", executor: "local" },
      {
        id: "layer-2",
        type: "git",
        repo: "owner/repo",
        ref: "v1$(id)`uname`$HOME",
        mountPath: "/work/$dir/`sub`",
        executor: "local",
      },
    ];
    const serialized = serializeDockerfile(gitLayers);
    const reparsed = parseDockerfile(serialized);
    assert.deepEqual(reparsed.warnings, []);
    assert.deepEqual(reparsed.layers, gitLayers);
  });

  it("round-trips single-line RUN ending with continuation backslash or heredoc syntax safely", () => {
    const backslashLayers = [
      { id: "layer-1", type: "from", image: "alpine:latest", executor: "local" },
      { id: "layer-2", type: "run", cmd: "echo foo \\", executor: "local" },
      { id: "layer-3", type: "run", cmd: "echo bar", executor: "local" },
    ];
    const bsText = serializeDockerfile(backslashLayers);
    assert.match(bsText, /RUN <<'ELF2WASM_EOF'/);
    const bsParsed = parseDockerfile(bsText);
    assert.deepEqual(bsParsed.warnings, []);
    assert.deepEqual(bsParsed.layers, backslashLayers);

    const heredocCmdLayers = [
      { id: "layer-1", type: "from", image: "alpine:latest", executor: "local" },
      { id: "layer-2", type: "run", cmd: "<<'EOF'", executor: "local" },
      { id: "layer-3", type: "run", cmd: "echo after", executor: "local" },
    ];
    const hdText = serializeDockerfile(heredocCmdLayers);
    const hdParsed = parseDockerfile(hdText);
    assert.deepEqual(hdParsed.warnings, []);
    assert.deepEqual(hdParsed.layers, heredocCmdLayers);
  });

  it("round-trips WORKDIR paths containing spaces, quotes, and backslashes without double-escaping", () => {
    const wdLayers = [
      { id: "layer-1", type: "from", image: "alpine:latest", executor: "local" },
      { id: "layer-2", type: "workdir", path: '/app/my "dir" \\ path' },
    ];
    const s1 = serializeDockerfile(wdLayers);
    const p1 = parseDockerfile(s1);
    assert.deepEqual(p1.warnings, []);
    assert.deepEqual(p1.layers, wdLayers);

    const s2 = serializeDockerfile(p1.layers);
    const p2 = parseDockerfile(s2);
    assert.deepEqual(p2.warnings, []);
    assert.deepEqual(p2.layers, wdLayers);
  });
});

