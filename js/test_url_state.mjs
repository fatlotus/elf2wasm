import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_UI_STATE,
  MAX_STDDEV_MS,
  MAX_SEED,
  MAX_SWEEP_RUNS,
  VALID_EXECUTOR_MODES,
  VALID_THEMES,
  legacyStateToLayers,
  inferExecutorMode,
  parseEnvLines,
  matchProjectPreset,
  parseStateFromSearch,
  serializeStateToSearch,
  computeSweepRunParams,
  buildRunSearch,
} from "../web/url_state.mjs";

const SAMPLE_PRESETS = Object.freeze({
  "python-bottle": Object.freeze({
    image: "python:3.12-slim",
    repo: "bottlepy/bottle",
    ref: "0.13.4",
    mountPath: "/workspace",
    cmd: "python3 -m unittest discover -s test -t .",
    cwd: "/workspace",
    env: Object.freeze(["PYTHONUNBUFFERED=1"]),
  }),
  "js-nanoid": Object.freeze({
    image: "node:22-slim",
    repo: "ai/nanoid",
    ref: "6.0.2",
    mountPath: "/workspace",
    cmd: "node test/non-secure.test.js",
    cwd: "/workspace",
    env: Object.freeze([]),
  }),
  "rust-nushell": Object.freeze({
    image: "ghcr.io/nushell/nushell:0.117.0-alpine",
    repo: "nushell/nushell",
    ref: "0.117.0",
    mountPath: "/workspace",
    cmd: `--no-config-file -c "source crates/nu-std/tests/test_asserts.nu; print 'OK: 35 nu-std tests passed'"`,
    cwd: "/workspace",
    env: Object.freeze(["HOME=/tmp"]),
  }),
  "go-raft-nodice": Object.freeze({
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

describe("web/url_state.mjs: parseEnvLines", () => {
  it("normalizes CRLF/CR, strips NULs, trims lines, skips blanks and comments, and requires '=' at index > 0", () => {
    const raw = "  # comment\r\nFOO=bar\r\n\r\nBAZ=a=b=c\r=missingkey\nNOEQUALS\n  SPACED=val\0ue  \n";
    assert.deepEqual(parseEnvLines(raw), ["FOO=bar", "BAZ=a=b=c", "SPACED=value"]);
  });

  it("handles null, undefined, and empty inputs gracefully", () => {
    assert.deepEqual(parseEnvLines(""), []);
    assert.deepEqual(parseEnvLines(null), []);
    assert.deepEqual(parseEnvLines(undefined), []);
  });
});

describe("web/url_state.mjs: parseStateFromSearch", () => {
  it("returns DEFAULT_UI_STATE and null activePresetId for empty search", () => {
    const res = parseStateFromSearch("", SAMPLE_PRESETS);
    assert.deepEqual(res.state, {
      ...DEFAULT_UI_STATE,
      env: [],
    });
    assert.equal(res.activePresetId, null);
  });

  it("hydrates all 7 fields with special characters, spaces, quotes, and repeated env params", () => {
    const search =
      "?image=python%3A3.12-slim&cmd=python3+-c+%22print('a%2Bb%26c%3Dd')%22&repo=https%3A%2F%2Fgithub.com%2Fowner%2Frepo&ref=v1.2.3&mount=%2Fapp&cwd=%2Fapp%2Fsrc&env=FOO%3D1&env=BAR%3Da%3Db";
    const { state, activePresetId } = parseStateFromSearch(search, SAMPLE_PRESETS);
    assert.deepEqual(state, {
      ...DEFAULT_UI_STATE,
      image: "python:3.12-slim",
      cmd: `python3 -c "print('a+b&c=d')"`,
      repo: "https://github.com/owner/repo",
      ref: "v1.2.3",
      mount: "/app",
      cwd: "/app/src",
      env: ["FOO=1", "BAR=a=b"],
    });
    assert.equal(activePresetId, null);
  });

  it("supports newline-separated env entries as well as repeated env params", () => {
    const { state } = parseStateFromSearch("?env=A%3D1%0AB%3D2%0D%0A%23ignored%0AC%3D3&env=D%3D4");
    assert.deepEqual(state.env, ["A=1", "B=2", "C=3", "D=4"]);
  });

  it("supports repoRef and repoMount read aliases, with canonical ref and mount taking precedence", () => {
    const aliasOnly = parseStateFromSearch("?repo=owner/repo&repoRef=dev&repoMount=/src");
    assert.equal(aliasOnly.state.ref, "dev");
    assert.equal(aliasOnly.state.mount, "/src");

    const both = parseStateFromSearch(
      "?repo=owner/repo&ref=main&repoRef=dev&mount=/canonical&repoMount=/alias"
    );
    assert.equal(both.state.ref, "main");
    assert.equal(both.state.mount, "/canonical");
  });

  it("hydrates ?preset=<id>, allows explicit overrides, and allows empty-string override to clear cmd/cwd/env", () => {
    const exact = parseStateFromSearch("?preset=python-bottle", SAMPLE_PRESETS);
    assert.equal(exact.activePresetId, "python-bottle");
    assert.equal(exact.state.image, "python:3.12-slim");
    assert.equal(exact.state.repo, "bottlepy/bottle");
    assert.equal(exact.state.ref, "0.13.4");
    assert.equal(exact.state.mount, "/workspace");
    assert.equal(exact.state.cmd, "python3 -m unittest discover -s test -t .");
    assert.equal(exact.state.cwd, "/workspace");
    assert.deepEqual(exact.state.env, ["PYTHONUNBUFFERED=1"]);

    const overridden = parseStateFromSearch(
      "?preset=python-bottle&ref=main&cmd=&cwd=&env=",
      SAMPLE_PRESETS
    );
    assert.equal(overridden.activePresetId, null);
    assert.equal(overridden.state.image, "python:3.12-slim");
    assert.equal(overridden.state.repo, "bottlepy/bottle");
    assert.equal(overridden.state.ref, "main");
    assert.equal(overridden.state.cmd, "");
    assert.equal(overridden.state.cwd, "");
    assert.deepEqual(overridden.state.env, []);
  });

  it("falls back to defaults when image or mount are explicitly empty, even with ?preset=", () => {
    const res = parseStateFromSearch("?preset=python-bottle&image=&mount=", SAMPLE_PRESETS);
    assert.equal(res.state.image, DEFAULT_UI_STATE.image);
    assert.equal(res.state.mount, DEFAULT_UI_STATE.mount);
  });

  it("ignores unknown or prototype-key preset IDs gracefully", () => {
    for (const badPreset of ["nonexistent", "toString", "__proto__", "constructor"]) {
      const res = parseStateFromSearch(`?preset=${badPreset}`, SAMPLE_PRESETS);
      assert.deepEqual(res.state, {
        ...DEFAULT_UI_STATE,
        env: [],
      });
      assert.equal(res.activePresetId, null);
    }
  });

  it("handles malformed percent-encoding, NUL bytes, whitespace, and unknown query params safely", () => {
    const res = parseStateFromSearch(
      "?utm_source=test&image=%20node:22-slim%00%20&cmd=%E0%A4%A&repo=%20owner/repo%00"
    );
    assert.equal(res.state.image, "node:22-slim");
    assert.equal(res.state.repo, "owner/repo");
    assert.equal(typeof res.state.cmd, "string");
  });
});

describe("web/url_state.mjs: serializeStateToSearch & round-trip", () => {
  it("omits default values and returns empty string for DEFAULT_UI_STATE", () => {
    assert.equal(serializeStateToSearch(DEFAULT_UI_STATE), "");
    assert.equal(
      serializeStateToSearch({
        image: "",
        cmd: "",
        repo: "",
        ref: "HEAD",
        mount: "/workspace",
        cwd: "",
        env: [],
      }),
      ""
    );
  });

  it("omits ref and mount when repo is empty, and omits default ref='HEAD' and mount='/workspace'", () => {
    assert.equal(
      serializeStateToSearch({
        image: "alpine:latest",
        repo: "",
        ref: "v1.0.0",
        mount: "/custom",
      }),
      ""
    );

    assert.equal(
      serializeStateToSearch({
        image: "alpine:latest",
        repo: "owner/repo",
        ref: "HEAD",
        mount: "/workspace",
      }),
      "?repo=owner%2Frepo"
    );
  });

  it("serializes keys in deterministic order and preserves unmanaged query parameters", () => {
    const search = serializeStateToSearch(
      {
        image: "python:3.12-slim",
        cmd: "python3 -V",
        repo: "bottlepy/bottle",
        ref: "0.13.4",
        mount: "/app",
        cwd: "/app",
        env: ["FOO=1", "BAR=2"],
      },
      { existingSearch: "?utm_source=docs&preset=old&repoRef=stale&foo=bar" }
    );
    assert.equal(
      search,
      "?utm_source=docs&foo=bar&image=python%3A3.12-slim&cmd=python3+-V&repo=bottlepy%2Fbottle&ref=0.13.4&mount=%2Fapp&cwd=%2Fapp&env=FOO%3D1&env=BAR%3D2"
    );
  });

  it("round-trips all sample presets (including long rust-nushell cmd) losslessly", () => {
    for (const [id, preset] of Object.entries(SAMPLE_PRESETS)) {
      const search = serializeStateToSearch(preset);
      assert.ok(search.startsWith("?"));
      const parsed = parseStateFromSearch(search, SAMPLE_PRESETS);
      assert.equal(parsed.activePresetId, id);
      assert.equal(matchProjectPreset(parsed.state, SAMPLE_PRESETS), id);
      assert.equal(parsed.state.image, preset.image);
      assert.equal(parsed.state.cmd, preset.cmd);
      assert.equal(parsed.state.repo, preset.repo);
      assert.equal(parsed.state.ref, preset.ref);
      assert.equal(parsed.state.mount, preset.mountPath);
      assert.equal(parsed.state.cwd, preset.cwd);
      assert.deepEqual(parsed.state.env, [...preset.env]);
    }
  });

  it("round-trips ghcr.io/fatlotus/golang-with-cache:1.27-alpine base image preset", () => {
    const image = "ghcr.io/fatlotus/golang-with-cache:1.27-alpine";
    const expectedSearch = "?image=ghcr.io%2Ffatlotus%2Fgolang-with-cache%3A1.27-alpine";

    const search = serializeStateToSearch({
      ...DEFAULT_UI_STATE,
      image,
    });
    assert.equal(search, expectedSearch);

    const parsed = parseStateFromSearch(search, SAMPLE_PRESETS);
    assert.equal(parsed.activePresetId, null);
    assert.deepEqual(parsed.state, {
      ...DEFAULT_UI_STATE,
      image,
      env: [],
    });
  });
});

describe("web/url_state.mjs: Contract 13 build/run split, delay injection & sweep mode", () => {
  it("parses build and run read alias, gives canonical cmd precedence over run, and serializes canonical cmd", () => {
    const aliasOnly = parseStateFromSearch("?build=go+build&run=.%2Fraft");
    assert.equal(aliasOnly.state.build, "go build");
    assert.equal(aliasOnly.state.cmd, "./raft");

    const serialized = serializeStateToSearch(aliasOnly.state, {
      existingSearch: "?run=stale&utm_source=ci",
    });
    assert.equal(serialized, "?utm_source=ci&build=go+build&cmd=.%2Fraft");

    const both = parseStateFromSearch("?cmd=.%2Fcanonical&run=.%2Falias");
    assert.equal(both.state.cmd, "./canonical");

    const cleared = parseStateFromSearch("?preset=go-raft-nodice&build=&run=", SAMPLE_PRESETS);
    assert.equal(cleared.state.build, "");
    assert.equal(cleared.state.cmd, "");
    assert.equal(cleared.activePresetId, null);
  });

  it("handles stddev and seed defaults, omission rules, and fractional round-trip", () => {
    // Omitted when stddev=0, seed=0, sweep=false
    assert.equal(
      serializeStateToSearch({ ...DEFAULT_UI_STATE, stddev: 0, seed: 0, sweep: false }),
      ""
    );

    // Non-zero stddev emits both stddev and seed (even when seed=0)
    const withStddev = serializeStateToSearch({
      ...DEFAULT_UI_STATE,
      stddev: 2.5,
      seed: 0,
      sweep: false,
    });
    assert.equal(withStddev, "?stddev=2.5&seed=0");
    const parsedStddev = parseStateFromSearch(withStddev);
    assert.equal(parsedStddev.state.stddev, 2.5);
    assert.equal(parsedStddev.state.seed, 0);

    // Zero stddev with non-zero seed emits seed only
    const withSeedOnly = serializeStateToSearch({
      ...DEFAULT_UI_STATE,
      stddev: 0,
      seed: 42,
      sweep: false,
    });
    assert.equal(withSeedOnly, "?seed=42");
    const parsedSeedOnly = parseStateFromSearch(withSeedOnly);
    assert.equal(parsedSeedOnly.state.stddev, 0);
    assert.equal(parsedSeedOnly.state.seed, 42);
  });

  it("handles sweep mode serialization, default omission, custom params, and selectedRun", () => {
    // When sweep=false, sweep-only fields are omitted even if provided
    assert.equal(
      serializeStateToSearch({
        ...DEFAULT_UI_STATE,
        sweep: false,
        runs: 50,
        stddevStart: 5,
        stddevStep: 2.5,
        selectedRun: 3,
      }),
      ""
    );

    // When sweep=true with default runs/stddevStart/stddevStep, only seed & sweep=1 are emitted
    const defaultSweep = serializeStateToSearch({
      ...DEFAULT_UI_STATE,
      sweep: true,
    });
    assert.equal(defaultSweep, "?seed=0&sweep=1");
    const parsedDefaultSweep = parseStateFromSearch(defaultSweep);
    assert.equal(parsedDefaultSweep.state.sweep, true);
    assert.equal(parsedDefaultSweep.state.runs, 20);
    assert.equal(parsedDefaultSweep.state.stddevStart, 1);
    assert.equal(parsedDefaultSweep.state.stddevStep, 1);
    assert.equal(parsedDefaultSweep.state.seed, 0);
    assert.equal(parsedDefaultSweep.state.selectedRun, null);

    // Full custom sweep round-trip (omits single-run stddev when sweep=true)
    const customSweep = serializeStateToSearch({
      ...DEFAULT_UI_STATE,
      image: "ghcr.io/fatlotus/golang-with-cache:1.27-alpine",
      repo: "fatlotus/nodice",
      cwd: "/workspace/example",
      build: "go build",
      cmd: "./raft",
      stddev: 99,
      seed: 7,
      sweep: true,
      runs: 15,
      stddevStart: 0.5,
      stddevStep: 1.25,
      selectedRun: 4,
    });
    const p = new URLSearchParams(customSweep);
    assert.equal(p.has("stddev"), false);
    assert.equal(p.get("seed"), "7");
    assert.equal(p.get("sweep"), "1");
    assert.equal(p.get("runs"), "15");
    assert.equal(p.get("stddevStart"), "0.5");
    assert.equal(p.get("stddevStep"), "1.25");
    assert.equal(p.get("selectedRun"), "4");

    const parsedCustom = parseStateFromSearch(customSweep, SAMPLE_PRESETS);
    assert.equal(parsedCustom.activePresetId, "go-raft-nodice");
    assert.equal(parsedCustom.state.sweep, true);
    assert.equal(parsedCustom.state.runs, 15);
    assert.equal(parsedCustom.state.stddevStart, 0.5);
    assert.equal(parsedCustom.state.stddevStep, 1.25);
    assert.equal(parsedCustom.state.seed, 7);
    assert.equal(parsedCustom.state.selectedRun, 4);

    // selectedRun is ignored (null) when sweep is false
    const nonSweepSelected = parseStateFromSearch("?selectedRun=3");
    assert.equal(nonSweepSelected.state.sweep, false);
    assert.equal(nonSweepSelected.state.selectedRun, null);
  });

  it("sanitizes and clamps adversarial/boundary numeric and boolean parameters", () => {
    const neg = parseStateFromSearch(
      "?stddev=-5&seed=-10&runs=0&stddevStart=-1&stddevStep=-2&sweep=true&selectedRun=0"
    );
    assert.equal(neg.state.stddev, 0);
    assert.equal(neg.state.seed, 0);
    assert.equal(neg.state.runs, 20);
    assert.equal(neg.state.stddevStart, 1);
    assert.equal(neg.state.stddevStep, 1);
    assert.equal(neg.state.sweep, true);
    assert.equal(neg.state.selectedRun, null);

    const garbage = parseStateFromSearch(
      "?stddev=NaN&seed=Infinity&runs=abc&stddevStart=oops&stddevStep=1e999&sweep=garbage&selectedRun=999"
    );
    assert.equal(garbage.state.stddev, 0);
    assert.equal(garbage.state.seed, 0);
    assert.equal(garbage.state.runs, 20);
    assert.equal(garbage.state.stddevStart, 1);
    assert.equal(garbage.state.stddevStep, 1);
    assert.equal(garbage.state.sweep, false);
    assert.equal(garbage.state.selectedRun, null);

    const clamped = parseStateFromSearch(
      "?stddev=99999999&seed=99999999999999999999&runs=999999&stddevStart=99999999&stddevStep=99999999&sweep=1&selectedRun=1001"
    );
    assert.equal(clamped.state.stddev, 3_600_000);
    assert.equal(clamped.state.seed, Number.MAX_SAFE_INTEGER);
    assert.equal(clamped.state.runs, 1000);
    assert.equal(clamped.state.stddevStart, 3_600_000);
    assert.equal(clamped.state.stddevStep, 3_600_000);
    assert.equal(clamped.state.selectedRun, null);

    const validBoundary = parseStateFromSearch("?sweep=yes&runs=5&selectedRun=5.9");
    assert.equal(validBoundary.state.sweep, true);
    assert.equal(validBoundary.state.runs, 5);
    assert.equal(validBoundary.state.selectedRun, 5);

    const negZero = parseStateFromSearch("?seed=-0&stddev=-0&sweep=1&stddevStart=-0&stddevStep=-0");
    assert.ok(Object.is(negZero.state.seed, 0), "expected ?seed=-0 to normalize to +0");
    assert.ok(Object.is(negZero.state.stddev, 0), "expected ?stddev=-0 to normalize to +0");
    assert.ok(Object.is(negZero.state.stddevStart, 0), "expected ?stddevStart=-0 to normalize to +0");
    assert.ok(Object.is(negZero.state.stddevStep, 0), "expected ?stddevStep=-0 to normalize to +0");
  });

  it("hydrates go-raft-nodice preset, preserves preset match with sweep/delay params, and clears match on build edit", () => {
    const base = parseStateFromSearch("?preset=go-raft-nodice", SAMPLE_PRESETS);
    assert.equal(base.activePresetId, "go-raft-nodice");
    assert.equal(base.state.image, "ghcr.io/fatlotus/golang-with-cache:1.27-alpine");
    assert.equal(base.state.repo, "fatlotus/nodice");
    assert.equal(base.state.cwd, "/workspace/example");
    assert.equal(base.state.build, "go build");
    assert.equal(base.state.cmd, "./raft");

    const withSweep = parseStateFromSearch(
      "?preset=go-raft-nodice&sweep=1&runs=15&seed=3",
      SAMPLE_PRESETS
    );
    assert.equal(withSweep.activePresetId, "go-raft-nodice");

    const editedBuild = parseStateFromSearch("?preset=go-raft-nodice&build=", SAMPLE_PRESETS);
    assert.equal(editedBuild.activePresetId, null);
    assert.equal(editedBuild.state.build, "");
  });

  it("computeSweepRunParams calculates deterministic progression without float drift", () => {
    assert.deepEqual(computeSweepRunParams(DEFAULT_UI_STATE, 1), {
      index: 1,
      stddev: 1,
      seed: 0,
    });
    assert.deepEqual(computeSweepRunParams(DEFAULT_UI_STATE, 7), {
      index: 7,
      stddev: 7,
      seed: 6,
    });

    // Avoid IEEE-754 0.1 + 2 * 0.1 = 0.30000000000000004 drift
    assert.deepEqual(
      computeSweepRunParams({ stddevStart: 0.1, stddevStep: 0.1, seed: 10 }, 3),
      { index: 3, stddev: 0.3, seed: 12 }
    );

    // Zero stddevStart and invalid runIndex1Based clamping
    assert.deepEqual(
      computeSweepRunParams({ stddevStart: 0, stddevStep: 0.5, seed: 5 }, 0),
      { index: 1, stddev: 0, seed: 5 }
    );
    assert.deepEqual(
      computeSweepRunParams({ stddevStart: 0, stddevStep: 0.5, seedStart: 5 }, 2),
      { index: 2, stddev: 0.5, seed: 6 }
    );
  });

  it("buildRunSearch generates standalone deterministic reproducer URLs stripping sweep keys", () => {
    const sweepState = {
      image: "ghcr.io/fatlotus/golang-with-cache:1.27-alpine",
      repo: "fatlotus/nodice",
      ref: "main",
      mount: "/src",
      cwd: "/src/example",
      build: "go build",
      cmd: "./raft",
      env: ["FOO=1"],
      sweep: true,
      runs: 25,
      stddevStart: 1,
      stddevStep: 2,
      seed: 10,
      selectedRun: 4,
    };

    const runSearch = buildRunSearch(
      sweepState,
      { stddevMs: 7, seed: 13 },
      { existingSearch: "?utm_source=sweep&preset=go-raft-nodice&run=old&sweep=1&selectedRun=4" }
    );
    const params = new URLSearchParams(runSearch);
    assert.equal(params.get("utm_source"), "sweep");
    assert.equal(params.get("image"), "ghcr.io/fatlotus/golang-with-cache:1.27-alpine");
    assert.equal(params.get("build"), "go build");
    assert.equal(params.get("cmd"), "./raft");
    assert.equal(params.get("repo"), "fatlotus/nodice");
    assert.equal(params.get("ref"), "main");
    assert.equal(params.get("mount"), "/src");
    assert.equal(params.get("cwd"), "/src/example");
    assert.deepEqual(params.getAll("env"), ["FOO=1"]);
    assert.equal(params.get("stddev"), "7");
    assert.equal(params.get("seed"), "13");
    assert.equal(params.has("sweep"), false);
    assert.equal(params.has("runs"), false);
    assert.equal(params.has("stddevStart"), false);
    assert.equal(params.has("stddevStep"), false);
    assert.equal(params.has("selectedRun"), false);
    assert.equal(params.has("preset"), false);
    assert.equal(params.has("run"), false);

    // Even { stddev: 0, seed: 0 } emits explicit stddev=0&seed=0
    const zeroSearch = buildRunSearch(DEFAULT_UI_STATE, { stddev: 0, seed: 0 });
    assert.equal(zeroSearch, "?stddev=0&seed=0");

    // Round-trip through parseStateFromSearch
    const reparsed = parseStateFromSearch(runSearch);
    assert.equal(reparsed.state.sweep, false);
    assert.equal(reparsed.state.selectedRun, null);
    assert.equal(reparsed.state.stddev, 7);
    assert.equal(reparsed.state.seed, 13);
    assert.equal(reparsed.state.build, "go build");
    assert.equal(reparsed.state.cmd, "./raft");
  });

  it("Tier 5 adversarial: exact ORIGINAL_REQUEST.md query round-trip, duplicate params, unicode/%00/+ vs %20, and 100-step float-drift invariance", () => {
    // Exported numeric bounds match expected contract
    assert.equal(MAX_STDDEV_MS, 3_600_000);
    assert.equal(MAX_SEED, Number.MAX_SAFE_INTEGER);
    assert.equal(MAX_SWEEP_RUNS, 1000);

    // 1. Exact ORIGINAL_REQUEST.md query string round-trip
    const origQuery =
      "?image=ghcr.io%2Ffatlotus%2Fgolang-with-cache%3A1.27-alpine&cmd=%2Fbin%2Fsh+-c+%22go+build+%26%26+.%2Fraft%22&repo=fatlotus%2Fnodice&cwd=%2Fworkspace%2Fexample";
    const parsedOrig = parseStateFromSearch(origQuery, SAMPLE_PRESETS);
    assert.equal(parsedOrig.state.image, "ghcr.io/fatlotus/golang-with-cache:1.27-alpine");
    assert.equal(parsedOrig.state.cmd, '/bin/sh -c "go build && ./raft"');
    assert.equal(parsedOrig.state.build, "");
    assert.equal(parsedOrig.state.repo, "fatlotus/nodice");
    assert.equal(parsedOrig.state.cwd, "/workspace/example");
    assert.equal(parsedOrig.state.sweep, false);
    assert.equal(parsedOrig.state.stddev, 0);
    assert.equal(parsedOrig.state.seed, 0);
    const reserializedOrig = serializeStateToSearch(parsedOrig.state);
    assert.deepEqual(parseStateFromSearch(reserializedOrig).state, parsedOrig.state);

    // 2. Duplicate params: URLSearchParams.get() returns first occurrence deterministically
    const dupCmd = parseStateFromSearch("?cmd=first&cmd=second");
    assert.equal(dupCmd.state.cmd, "first");
    const dupSweep = parseStateFromSearch("?sweep=1&sweep=0&runs=7&runs=99");
    assert.equal(dupSweep.state.sweep, true);
    assert.equal(dupSweep.state.runs, 7);
    const dupRoundTrip = serializeStateToSearch(dupSweep.state);
    assert.deepEqual(parseStateFromSearch(dupRoundTrip).state, dupSweep.state);

    // 3. Unicode, embedded %00 (NUL stripped), and '+' vs '%20' space equivalence
    const plusQuery = parseStateFromSearch("?cmd=echo+hello+world+%F0%9F%9A%80%00&build=make%20all%00&env=MSG%3D%E4%BD%A0%E5%A5%BD%00");
    const pct20Query = parseStateFromSearch("?cmd=echo%20hello%20world%20%F0%9F%9A%80&build=make+all&env=MSG%3D%E4%BD%A0%E5%A5%BD");
    assert.equal(plusQuery.state.cmd, "echo hello world 🚀");
    assert.equal(plusQuery.state.build, "make all");
    assert.deepEqual(plusQuery.state.env, ["MSG=你好"]);
    assert.deepEqual(plusQuery.state, pct20Query.state);
    assert.equal(plusQuery.state.cmd.includes("\0"), false);
    const uniSerialized = serializeStateToSearch(plusQuery.state);
    assert.deepEqual(parseStateFromSearch(uniSerialized).state, plusQuery.state);

    // 4. 100-step computeSweepRunParams float-drift invariance
    const stepState = { stddevStart: 0.1, stddevStep: 0.1, seed: 42 };
    for (let i = 1; i <= 100; i++) {
      const p = computeSweepRunParams(stepState, i);
      assert.equal(p.index, i);
      assert.equal(p.seed, 42 + (i - 1));
      const expected = Math.round(i * 100) / 1000;
      assert.equal(
        p.stddev,
        expected,
        `step ${i}: expected stddev=${expected}, got ${p.stddev}`
      );
      assert.equal(
        String(p.stddev).length <= 6,
        true,
        `step ${i}: unexpected float drift string ${p.stddev}`
      );
    }

    // 5. MAX_SEED boundary in computeSweepRunParams keeps all sweep runs unique and <= MAX_SEED
    const maxSeedState = { stddevStart: 1, stddevStep: 1, seed: MAX_SEED, runs: 2 };
    assert.deepEqual(computeSweepRunParams(maxSeedState, 1), {
      index: 1,
      stddev: 1,
      seed: MAX_SEED - 1,
    });
    assert.deepEqual(computeSweepRunParams(maxSeedState, 2), {
      index: 2,
      stddev: 2,
      seed: MAX_SEED,
    });
  });
});

describe("web/url_state.mjs: M4 Dockerfile layer stack, executorMode, theme & selectedSweepRun", () => {
  it("exports VALID_EXECUTOR_MODES, VALID_THEMES, inferExecutorMode, and legacyStateToLayers", () => {
    assert.deepEqual(VALID_EXECUTOR_MODES, ["local", "remote", "mixed"]);
    assert.deepEqual(VALID_THEMES, ["system", "light", "dark"]);

    assert.equal(inferExecutorMode([]), "local");
    assert.equal(
      inferExecutorMode([
        { type: "from", image: "alpine:latest", executor: "local" },
        { type: "run", cmd: "echo hi", executor: "local" },
      ]),
      "local"
    );
    assert.equal(
      inferExecutorMode([
        { type: "from", image: "alpine:latest", executor: "remote" },
        { type: "run", cmd: "echo hi", executor: "remote" },
      ]),
      "remote"
    );
    assert.equal(
      inferExecutorMode([
        { type: "from", image: "alpine:latest", executor: "local" },
        { type: "run", cmd: "echo hi", executor: "remote" },
      ]),
      "mixed"
    );

    const layers = legacyStateToLayers({
      ...DEFAULT_UI_STATE,
      image: "python:3.12-slim",
      repo: "pallets/flask",
      ref: "3.1.0",
      mount: "/workspace",
      cwd: "/workspace",
      env: ["PYTHONUNBUFFERED=1"],
      build: "pip --version",
      sweep: true,
      runs: 5,
      stddevStart: 0.5,
      stddevStep: 0.5,
      cmd: "pytest",
    });
    assert.equal(layers.length, 7);
    assert.equal(layers[0].type, "from");
    assert.equal(layers[1].type, "git");
    assert.equal(layers[2].type, "workdir");
    assert.equal(layers[3].type, "env");
    assert.equal(layers[4].type, "run");
    assert.equal(layers[4].cmd, "pip --version");
    assert.equal(layers[5].type, "sweep");
    assert.equal(layers[5].count, 5);
    assert.equal(layers[6].type, "run");
    assert.equal(layers[6].cmd, "pytest");
  });

  it("round-trips Dockerfile layer stack, executorMode, theme, selectedSweepRun, and preserves unmanaged params", () => {
    const layers = [
      { id: "layer-1", type: "from", image: "node:22-slim", executor: "local" },
      { id: "layer-2", type: "git", repo: "expressjs/express", ref: "5.0.0", mountPath: "/workspace", executor: "local" },
      { id: "layer-3", type: "workdir", path: "/workspace" },
      { id: "layer-4", type: "env", key: "NODE_ENV", value: "test" },
      { id: "layer-5", type: "sweep", param: "env", envKey: "MODE", mode: "list", values: ["a", "b", "c"] },
      { id: "layer-6", type: "run", cmd: "node -e 'console.log(process.env.MODE)'", executor: "remote" },
    ];

    const search = serializeStateToSearch(
      {
        layers,
        theme: "dark",
        selectedSweepRun: 2,
      },
      { existingSearch: "?utm_source=share&image=stale&sweep=1&runs=99" }
    );

    const params = new URLSearchParams(search);
    assert.equal(params.get("utm_source"), "share");
    assert.equal(params.has("image"), false);
    assert.equal(params.has("sweep"), false);
    assert.equal(params.has("runs"), false);
    assert.ok(params.has("dockerfile"));
    assert.equal(params.get("executor"), "mixed");
    assert.equal(params.get("theme"), "dark");
    assert.equal(params.get("selectedRun"), "2");

    const parsed = parseStateFromSearch(search);
    assert.deepEqual(parsed.layers, layers);
    assert.equal(parsed.executorMode, "mixed");
    assert.equal(parsed.theme, "dark");
    assert.equal(parsed.selectedSweepRun, 2);
    assert.equal(parsed.state.image, "node:22-slim");
    assert.equal(parsed.state.repo, "expressjs/express");
    assert.equal(parsed.state.sweep, true);
    assert.equal(parsed.state.selectedRun, 2);
  });

  it("omits default single local FROM alpine:latest, system theme, and local executor", () => {
    assert.equal(
      serializeStateToSearch({
        layers: [{ id: "layer-1", type: "from", image: "alpine:latest", executor: "local" }],
        executorMode: "local",
        theme: "system",
      }),
      ""
    );
    assert.equal(
      serializeStateToSearch({
        dockerfile: "FROM alpine:latest",
        theme: "light",
      }),
      "?theme=light"
    );
  });

  it("migrates legacy flat URLs (including sweepStart/sweepStep/sweepCount aliases) into layers and dockerfile", () => {
    const res = parseStateFromSearch(
      "?image=alpine:3.20&build=echo+build&cmd=echo+run&sweep=1&sweepStart=2&sweepStep=3&sweepCount=4&selectedSweepRun=3&theme=light&executor=remote"
    );
    assert.equal(res.state.runs, 4);
    assert.equal(res.state.stddevStart, 2);
    assert.equal(res.state.stddevStep, 3);
    assert.equal(res.state.selectedRun, 3);
    assert.equal(res.selectedSweepRun, 3);
    assert.equal(res.theme, "light");
    assert.equal(res.executorMode, "remote");
    assert.equal(res.layers.length, 4);
    assert.equal(res.layers[0].image, "alpine:3.20");
    assert.equal(res.layers[2].type, "sweep");
    assert.equal(res.layers[2].start, 2);
    assert.equal(res.layers[2].step, 3);
    assert.equal(res.layers[2].count, 4);
    assert.match(res.dockerfile, /FROM alpine:3\.20/);
    assert.match(res.dockerfile, /# elf2wasm:sweep param=delay mode=range start=2 step=3 count=4/);
  });

  it("matches Dockerfile-based presets via canonical serialization", () => {
    const dfPresets = {
      express: {
        dockerfile: "FROM node:22-slim\nRUN git clone https://github.com/expressjs/express.git\nWORKDIR /workspace\nRUN node -v",
      },
    };
    const parsed = parseStateFromSearch("?preset=express", dfPresets);
    assert.equal(parsed.activePresetId, "express");
    assert.equal(parsed.layers.length, 4);
    assert.equal(parsed.state.image, "node:22-slim");
    assert.equal(parsed.state.repo, "expressjs/express");

    const serialized = serializeStateToSearch({ layers: parsed.layers });
    const reparsed = parseStateFromSearch(serialized, dfPresets);
    assert.equal(reparsed.activePresetId, "express");
  });
});

