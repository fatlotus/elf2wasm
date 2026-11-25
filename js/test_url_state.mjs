import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_UI_STATE,
  parseEnvLines,
  matchProjectPreset,
  parseStateFromSearch,
  serializeStateToSearch,
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
      image: "alpine:latest",
      cmd: "",
      repo: "",
      ref: "",
      mount: "/workspace",
      cwd: "",
      env: [],
    });
    assert.equal(res.activePresetId, null);
  });

  it("hydrates all 7 fields with special characters, spaces, quotes, and repeated env params", () => {
    const search =
      "?image=python%3A3.12-slim&cmd=python3+-c+%22print('a%2Bb%26c%3Dd')%22&repo=https%3A%2F%2Fgithub.com%2Fowner%2Frepo&ref=v1.2.3&mount=%2Fapp&cwd=%2Fapp%2Fsrc&env=FOO%3D1&env=BAR%3Da%3Db";
    const { state, activePresetId } = parseStateFromSearch(search, SAMPLE_PRESETS);
    assert.deepEqual(state, {
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
      image,
      cmd: "",
      repo: "",
      ref: "",
      mount: "/workspace",
      cwd: "",
      env: [],
    });
  });
});
