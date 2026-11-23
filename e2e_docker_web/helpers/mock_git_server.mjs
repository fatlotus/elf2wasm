// Local Dual-Origin Mock Git Archive Server for deterministic offline E2E testing.
// Mirrors mock_oci_registry.mjs architecture:
//   - Primary Forge Server (127.0.0.1:<gitPort>):
//       GET|HEAD /<repoPath...>/archive/<encodedRef>.tar.gz
//       Supports 302 redirect to separate-origin Archive CDN (default) or direct 200.
//   - Secondary Cross-Origin Archive CDN Server (127.0.0.1:<cdnPort>):
//       GET|HEAD /cdn/<archiveId>.tar.gz
//       Strictly rejects any leaked Authorization header with 400 and increments leakedAuthCount().
// Zero external dependencies (Node.js 22 built-ins + ./tar_builder.mjs).

import http from "node:http";
import crypto from "node:crypto";
import { createTarGz } from "./tar_builder.mjs";

export const MOCK_SHAS = Object.freeze({
  alpine: "1111111111111111111111111111111111111111",
  python: "2222222222222222222222222222222222222222",
  js: "3333333333333333333333333333333333333333",
});

/**
 * Build a gzipped tar archive for a mock git repository snapshot.
 * When `wrapperPrefix` is non-empty, each entry path is prefixed with `${wrapperPrefix}/`
 * (unless `entry.rawPath === true`), matching GitHub/GitLab/Codeberg archive layout.
 *
 * @param {string} wrapperPrefix
 * @param {Array<object>} entries
 * @param {{ stripComponents?: number }} [opts]
 * @returns {{ tarBytes: Uint8Array, gzBytes: Uint8Array, diffId: string, digest: string, size: number, stripComponents: number }}
 */
export function buildGitRepoArchive(wrapperPrefix, entries, opts = {}) {
  const prefix = wrapperPrefix ? String(wrapperPrefix).replace(/^\/+|\/+$/g, "") : "";
  const prepared = [];

  if (prefix) {
    prepared.push({ path: `${prefix}/`, type: "dir", mode: 0o755 });
  }

  for (const entry of entries) {
    const rawPath = Boolean(entry.rawPath);
    const cleanPath = String(entry.path || "").replace(/^\/+/, "");
    const fullPath = !rawPath && prefix ? `${prefix}/${cleanPath}` : cleanPath;

    const cloned = { ...entry, path: fullPath };
    delete cloned.rawPath;
    delete cloned.rawLinkname;

    if (entry.type === "hardlink" && entry.linkname) {
      const cleanLink = String(entry.linkname).replace(/^\/+/, "");
      const rawLink = Boolean(entry.rawLinkname);
      cloned.linkname =
        !rawLink && prefix && !cleanLink.startsWith(`${prefix}/`)
          ? `${prefix}/${cleanLink}`
          : cleanLink;
    }

    prepared.push(cloned);
  }

  const built = createTarGz(prepared);
  const stripComponents =
    opts.stripComponents !== undefined ? Number(opts.stripComponents) : prefix ? 1 : 0;

  return {
    ...built,
    stripComponents,
  };
}

function buildBuiltinFixtures() {
  // 1. fixtures/alpine-shell: distinct files per ref (main/HEAD, dev, v1.0.0, 40-char SHA, short SHA)
  const makeAlpineShell = (wrapper, versionText, extraEntries = []) =>
    buildGitRepoArchive(wrapper, [
      { path: "VERSION", type: "file", content: `${versionText}\n` },
      {
        path: "run_tests.sh",
        type: "file",
        mode: 0o755,
        content: [
          "#!/bin/sh",
          "set -eu",
          'echo "PWD=$(pwd)"',
          'echo "VER=$(cat VERSION)"',
          'echo "ALPINE_SCRIPT_OK"',
          "",
        ].join("\n"),
      },
      { path: "bin/", type: "dir", mode: 0o755 },
      {
        path: "bin/greet.sh",
        type: "file",
        mode: 0o755,
        content: '#!/bin/sh\necho "GREET:$(cat VERSION)"\n',
      },
      ...extraEntries,
    ]);

  const alpineMain = makeAlpineShell("alpine-shell-main", "1.0.0-main");
  const alpineDev = makeAlpineShell("alpine-shell-dev", "2.0.0-dev", [
    { path: "dev_only.txt", type: "file", content: "DEV_BRANCH_MARKER\n" },
  ]);
  const alpineTag = makeAlpineShell("alpine-shell-1.0.0", "1.0.0-tag", [
    { path: "TAG_MARKER", type: "file", content: "TAG_V1_0_0\n" },
  ]);
  const alpineCommit = makeAlpineShell("alpine-shell-1111111", "0.9.0-commit", [
    { path: "COMMIT_MARKER", type: "file", content: `SHA_${MOCK_SHAS.alpine}\n` },
  ]);

  // 2. fixtures/py-unittest: Python stdlib unittest project
  const pyUnittest = buildGitRepoArchive("py-unittest-main", [
    { path: "pkg/", type: "dir", mode: 0o755 },
    { path: "pkg/__init__.py", type: "file", content: "" },
    {
      path: "pkg/calc.py",
      type: "file",
      content: [
        "import hashlib",
        "import json",
        "import math",
        "",
        "def factorial_sum(n):",
        "    return math.factorial(n) + n",
        "",
        "def sha256_prefix(text):",
        "    return hashlib.sha256(text.encode('utf-8')).hexdigest()[:12]",
        "",
        "def load_sample(path='data/sample.json'):",
        "    with open(path, 'r', encoding='utf-8') as f:",
        "        return json.load(f)",
        "",
      ].join("\n"),
    },
    { path: "tests/", type: "dir", mode: 0o755 },
    { path: "tests/__init__.py", type: "file", content: "" },
    {
      path: "tests/test_calc.py",
      type: "file",
      content: [
        "import os",
        "import unittest",
        "from pkg.calc import factorial_sum, sha256_prefix, load_sample",
        "",
        "class TestCalc(unittest.TestCase):",
        "    def test_factorial_sum(self):",
        "        self.assertEqual(factorial_sum(5), 125)",
        "",
        "    def test_sha256_prefix(self):",
        "        self.assertEqual(len(sha256_prefix('elf2wasm')), 12)",
        "",
        "    def test_load_sample_relative_path(self):",
        "        data = load_sample('data/sample.json')",
        "        self.assertEqual(data['project'], 'py-unittest')",
        "        self.assertEqual(data['answer'], 42)",
        "        self.assertTrue(os.path.isfile('data/sample.json'))",
        "",
        "if __name__ == '__main__':",
        "    unittest.main()",
        "",
      ].join("\n"),
    },
    { path: "data/", type: "dir", mode: 0o755 },
    {
      path: "data/sample.json",
      type: "file",
      content: JSON.stringify({ project: "py-unittest", answer: 42 }, null, 2) + "\n",
    },
  ]);

  // 3. fixtures/js-nodetest: Node.js ESM node:test project
  const jsNodetest = buildGitRepoArchive("js-nodetest-main", [
    {
      path: "package.json",
      type: "file",
      content: JSON.stringify({ name: "js-nodetest", version: "1.0.0", type: "module" }, null, 2) + "\n",
    },
    { path: "src/", type: "dir", mode: 0o755 },
    {
      path: "src/math.mjs",
      type: "file",
      content: [
        'import crypto from "node:crypto";',
        "",
        "export function add(a, b) {",
        "  return a + b;",
        "}",
        "",
        "export function sha12(text) {",
        '  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 12);',
        "}",
        "",
      ].join("\n"),
    },
    { path: "test/", type: "dir", mode: 0o755 },
    {
      path: "test/math.test.mjs",
      type: "file",
      content: [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import fs from "node:fs";',
        'import { add, sha12 } from "../src/math.mjs";',
        "",
        'test("add returns sum", () => {',
        "  assert.equal(add(20, 22), 42);",
        "});",
        "",
        'test("sha12 hashes deterministically", () => {',
        '  assert.equal(sha12("elf2wasm").length, 12);',
        "});",
        "",
        'test("reads relative data/input.json", () => {',
        '  const parsed = JSON.parse(fs.readFileSync("data/input.json", "utf8"));',
        '  assert.equal(parsed.project, "js-nodetest");',
        "  assert.equal(parsed.value, 99);",
        "});",
        "",
      ].join("\n"),
    },
    { path: "data/", type: "dir", mode: 0o755 },
    {
      path: "data/input.json",
      type: "file",
      content: JSON.stringify({ project: "js-nodetest", value: 99 }, null, 2) + "\n",
    },
  ]);

  // 4. fixtures/links-nested: empty dirs, relative symlinks, hardlink, literal .wh. file
  const linksNested = buildGitRepoArchive("links-nested-main", [
    { path: "empty_dir/", type: "dir", mode: 0o755 },
    { path: "deep/nested/empty_leaf/", type: "dir", mode: 0o755 },
    { path: "src/", type: "dir", mode: 0o755 },
    { path: "src/original.txt", type: "file", content: "ORIGINAL_LINK_DATA\n" },
    { path: "src/rel_symlink", type: "symlink", linkname: "original.txt" },
    { path: "nested_sym", type: "symlink", linkname: "src/original.txt" },
    { path: "hardlink_copy.txt", type: "hardlink", linkname: "links-nested-main/src/original.txt" },
    { path: "dir/", type: "dir", mode: 0o755 },
    { path: "dir/.wh.literal", type: "file", content: "LITERAL_WHITEOUT_FILE\n" },
  ]);

  // 5. fixtures/traversal-evil: adversarial .. path traversal entries
  const traversalEvil = buildGitRepoArchive("traversal-evil-main", [
    { path: "safe.txt", type: "file", content: "SAFE_ONLY\n" },
    { path: "traversal-evil-main/../escape.txt", type: "file", content: "ESCAPED_1\n", rawPath: true },
    { path: "traversal-evil-main/../../etc/pwned.txt", type: "file", content: "ESCAPED_2\n", rawPath: true },
    { path: "../direct_escape.txt", type: "file", content: "ESCAPED_3\n", rawPath: true },
    { path: "traversal-evil-main/sub/../../../tmp/escape2.txt", type: "file", content: "ESCAPED_4\n", rawPath: true },
  ]);

  // 6. fixtures/no-strip: flat archive with X-Git-Strip-Components: 0
  const noStrip = buildGitRepoArchive(
    "",
    [
      { path: "flat.txt", type: "file", content: "FLAT_NO_STRIP\n" },
      { path: "sub/", type: "dir", mode: 0o755 },
      { path: "sub/nested.txt", type: "file", content: "SUB_NO_STRIP\n" },
    ],
    { stripComponents: 0 }
  );

  return [
    [
      "fixtures/alpine-shell",
      {
        main: alpineMain,
        HEAD: alpineMain,
        "refs/heads/main": alpineMain,
        dev: alpineDev,
        "refs/heads/dev": alpineDev,
        "v1.0.0": alpineTag,
        "refs/tags/v1.0.0": alpineTag,
        [MOCK_SHAS.alpine]: alpineCommit,
        "1111111": alpineCommit,
      },
    ],
    [
      "fixtures/py-unittest",
      {
        main: pyUnittest,
        HEAD: pyUnittest,
        "v1.0.0": pyUnittest,
        [MOCK_SHAS.python]: pyUnittest,
        "2222222": pyUnittest,
      },
    ],
    [
      "fixtures/js-nodetest",
      {
        main: jsNodetest,
        HEAD: jsNodetest,
        "v1.0.0": jsNodetest,
        [MOCK_SHAS.js]: jsNodetest,
        "3333333": jsNodetest,
      },
    ],
    [
      "fixtures/links-nested",
      {
        main: linksNested,
        HEAD: linksNested,
      },
    ],
    [
      "fixtures/traversal-evil",
      {
        main: traversalEvil,
        HEAD: traversalEvil,
      },
    ],
    [
      "fixtures/no-strip",
      {
        main: noStrip,
        HEAD: noStrip,
      },
    ],
  ];
}

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.length),
    ...extraHeaders,
  });
  res.end(body);
}

function normalizeArchiveInput(value, defaultStrip = 1) {
  if (Array.isArray(value)) {
    const built = createTarGz(value);
    return {
      ...built,
      stripComponents: defaultStrip,
    };
  }
  if (value && value.gzBytes instanceof Uint8Array) {
    return {
      ...value,
      stripComponents: value.stripComponents !== undefined ? Number(value.stripComponents) : defaultStrip,
    };
  }
  throw new Error("Expected archive object with gzBytes Uint8Array or array of tar entries");
}

function sendArchiveResponse(req, res, archive) {
  const buf = Buffer.from(
    archive.gzBytes.buffer,
    archive.gzBytes.byteOffset,
    archive.gzBytes.byteLength
  );
  res.writeHead(200, {
    "Content-Type": "application/gzip",
    "Content-Length": String(buf.length),
    "X-Git-Strip-Components": String(archive.stripComponents),
    "X-Git-Archive-Format": "tar.gz",
    ETag: `"${String(archive.digest || "").slice(7, 23)}"`,
  });
  if (req.method === "HEAD") {
    res.end();
  } else {
    res.end(buf);
  }
}

/**
 * Start a dual-origin local mock git archive server on ephemeral 127.0.0.1 ports.
 *
 * @param {{ redirectArchives?: boolean }} [opts]
 */
export async function startMockGitServer(opts = {}) {
  const defaultRedirectArchives = opts.redirectArchives !== false;

  // Map<repoPath, { refs: Map<string, ArchiveRecord>, redirectArchives?: boolean }>
  const repos = new Map();
  // Map<archiveId, ArchiveRecord>
  const archivesById = new Map();
  // Map<string, { status: number, headers?: object, body?: string|Buffer|object, delayMs?: number }>
  const errorTriggers = new Map();

  const requests = [];
  let leakedAuthCounter = 0;

  function indexArchive(archive) {
    const id = crypto
      .createHash("sha256")
      .update(archive.gzBytes)
      .update(String(archive.stripComponents))
      .digest("hex")
      .slice(0, 24);
    const record = { ...archive, id };
    archivesById.set(id, record);
    return record;
  }

  function registerRepo(repoPath, refsMap, repoOpts = {}) {
    const cleanRepo = String(repoPath || "").replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
    if (!cleanRepo) {
      throw new Error("registerRepo requires a non-empty repoPath");
    }
    const existing = repos.get(cleanRepo) || {
      refs: new Map(),
      redirectArchives: repoOpts.redirectArchives,
    };
    if (repoOpts.redirectArchives !== undefined) {
      existing.redirectArchives = repoOpts.redirectArchives;
    }
    const defaultStrip = repoOpts.stripComponents !== undefined ? Number(repoOpts.stripComponents) : 1;

    for (const [ref, rawVal] of Object.entries(refsMap || {})) {
      const normalized = normalizeArchiveInput(rawVal, defaultStrip);
      const indexed = indexArchive(normalized);
      existing.refs.set(ref, indexed);
    }

    repos.set(cleanRepo, existing);
  }

  // Flexible addRepo supporting both:
  //   addRepo("owner/repo", { main: [...], v1: [...] }, repoOpts?)
  //   addRepo("owner/repo", "main", [...], repoOpts?)
  function addRepo(repoPath, refOrMap, entriesOrOpts, maybeOpts) {
    if (typeof refOrMap === "string") {
      registerRepo(repoPath, { [refOrMap]: entriesOrOpts }, maybeOpts || {});
    } else {
      registerRepo(repoPath, refOrMap, entriesOrOpts || {});
    }
  }

  function resolveRef(repoEntry, ref) {
    if (!repoEntry) return null;
    if (repoEntry.refs.has(ref)) {
      return repoEntry.refs.get(ref);
    }
    if (ref === "HEAD" && repoEntry.refs.has("main")) {
      return repoEntry.refs.get("main");
    }
    if (ref.startsWith("refs/heads/")) {
      const branch = ref.slice("refs/heads/".length);
      if (repoEntry.refs.has(branch)) return repoEntry.refs.get(branch);
    }
    if (ref.startsWith("refs/tags/")) {
      const tag = ref.slice("refs/tags/".length);
      if (repoEntry.refs.has(tag)) return repoEntry.refs.get(tag);
    }
    return null;
  }

  function getArchive(repoPath, ref = "main") {
    const cleanRepo = String(repoPath || "").replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
    const entry = repos.get(cleanRepo);
    return resolveRef(entry, ref);
  }

  // Seed built-in fixtures
  for (const [repoPath, refsMap] of buildBuiltinFixtures()) {
    registerRepo(repoPath, refsMap);
  }

  let gitPort = 0;
  let cdnPort = 0;

  // Secondary cross-origin Archive CDN server
  const cdnServer = http.createServer((req, res) => {
    const parsed = new URL(req.url || "/", `http://127.0.0.1:${cdnPort || 80}`);
    const hasAuth = Boolean(req.headers.authorization);

    if (req.method !== "GET" && req.method !== "HEAD") {
      requests.push({
        server: "cdn",
        method: req.method,
        path: parsed.pathname,
        status: 405,
        hasAuth,
      });
      res.writeHead(405, { Allow: "GET, HEAD", "Content-Length": "0" });
      res.end();
      return;
    }

    if (hasAuth) {
      leakedAuthCounter += 1;
      requests.push({
        server: "cdn",
        method: req.method,
        path: parsed.pathname,
        status: 400,
        hasAuth: true,
        leakedAuth: true,
      });
      sendJson(res, 400, {
        error: "Authorization header leaked to cross-origin archive CDN",
      });
      return;
    }

    const match = parsed.pathname.match(/^\/cdn\/([a-f0-9]+)\.tar\.gz$/);
    if (!match) {
      requests.push({
        server: "cdn",
        method: req.method,
        path: parsed.pathname,
        status: 404,
        hasAuth: false,
      });
      sendJson(res, 404, { error: "CDN archive not found" });
      return;
    }

    const archive = archivesById.get(match[1]);
    if (!archive) {
      requests.push({
        server: "cdn",
        method: req.method,
        path: parsed.pathname,
        status: 404,
        hasAuth: false,
      });
      sendJson(res, 404, { error: "CDN archive ID not found" });
      return;
    }

    requests.push({
      server: "cdn",
      method: req.method,
      path: parsed.pathname,
      status: 200,
      hasAuth: false,
    });
    sendArchiveResponse(req, res, archive);
  });

  // Primary Forge server
  const forgeServer = http.createServer((req, res) => {
    const parsed = new URL(req.url || "/", `http://127.0.0.1:${gitPort || 80}`);
    const hasAuth = Boolean(req.headers.authorization);

    if (req.method !== "GET" && req.method !== "HEAD") {
      requests.push({
        server: "forge",
        method: req.method,
        path: parsed.pathname,
        status: 405,
        hasAuth,
      });
      res.writeHead(405, { Allow: "GET, HEAD", "Content-Length": "0" });
      res.end();
      return;
    }

    const match = parsed.pathname.match(/^\/(.+?)\/archive\/(.+)\.tar\.gz$/);
    if (!match) {
      requests.push({
        server: "forge",
        method: req.method,
        path: parsed.pathname,
        status: 404,
        hasAuth,
      });
      sendJson(res, 404, { error: `Unknown git server route: ${parsed.pathname}` });
      return;
    }

    const repoPath = match[1].replace(/\.git$/, "");
    let ref;
    try {
      ref = decodeURIComponent(match[2]);
    } catch {
      requests.push({
        server: "forge",
        method: req.method,
        path: parsed.pathname,
        repo: repoPath,
        status: 400,
        hasAuth,
      });
      sendJson(res, 400, { error: "Invalid percent-encoding in ref" });
      return;
    }

    // 1. Dynamic runtime error triggers
    const dynamicTrigger =
      errorTriggers.get(`${repoPath}@${ref}`) || errorTriggers.get(repoPath);
    if (dynamicTrigger) {
      const respondTrigger = () => {
        const status = Number(dynamicTrigger.status || 500);
        requests.push({
          server: "forge",
          method: req.method,
          path: parsed.pathname,
          repo: repoPath,
          ref,
          status,
          hasAuth,
        });
        const extraHeaders = dynamicTrigger.headers || {};
        if (dynamicTrigger.body === undefined) {
          sendJson(res, status, { error: `Triggered error ${status} for ${repoPath}@${ref}` }, extraHeaders);
        } else if (typeof dynamicTrigger.body === "object" && !(dynamicTrigger.body instanceof Uint8Array)) {
          sendJson(res, status, dynamicTrigger.body, extraHeaders);
        } else {
          const buf =
            dynamicTrigger.body instanceof Uint8Array
              ? Buffer.from(dynamicTrigger.body.buffer, dynamicTrigger.body.byteOffset, dynamicTrigger.body.byteLength)
              : Buffer.from(String(dynamicTrigger.body), "utf8");
          res.writeHead(status, {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(buf.length),
            ...extraHeaders,
          });
          res.end(req.method === "HEAD" ? undefined : buf);
        }
      };

      if (dynamicTrigger.delayMs && dynamicTrigger.delayMs > 0) {
        const timer = setTimeout(respondTrigger, dynamicTrigger.delayMs);
        res.on("close", () => { if (!res.writableEnded) clearTimeout(timer); });
      } else {
        respondTrigger();
      }
      return;
    }

    // 2. Built-in deterministic error repos
    if (repoPath === "error/notfound") {
      requests.push({ server: "forge", method: req.method, path: parsed.pathname, repo: repoPath, ref, status: 404, hasAuth });
      sendJson(res, 404, { error: `repository not found: ${repoPath}` });
      return;
    }
    if (repoPath === "error/ratelimit" || repoPath === "error/429") {
      requests.push({ server: "forge", method: req.method, path: parsed.pathname, repo: repoPath, ref, status: 429, hasAuth });
      sendJson(res, 429, { error: "rate limit exceeded" }, { "Retry-After": "60" });
      return;
    }
    if (repoPath === "error/upstream500" || repoPath === "error/500") {
      requests.push({ server: "forge", method: req.method, path: parsed.pathname, repo: repoPath, ref, status: 500, hasAuth });
      sendJson(res, 500, { error: "simulated upstream 500" });
      return;
    }
    if (repoPath === "error/redirect-loop") {
      const hop = Number(parsed.searchParams.get("hop") || "0") + 1;
      const nextLoc = `http://127.0.0.1:${gitPort}/error/redirect-loop/archive/${encodeURIComponent(ref)}.tar.gz?hop=${hop}`;
      requests.push({ server: "forge", method: req.method, path: parsed.pathname, repo: repoPath, ref, status: 302, hasAuth });
      res.writeHead(302, { Location: nextLoc, "Content-Length": "0" });
      res.end();
      return;
    }
    if (repoPath === "error/bad-gzip") {
      const corrupt = Buffer.from("NOT_A_VALID_GZIP_STREAM", "utf8");
      requests.push({ server: "forge", method: req.method, path: parsed.pathname, repo: repoPath, ref, status: 200, hasAuth });
      res.writeHead(200, {
        "Content-Type": "application/gzip",
        "Content-Length": String(corrupt.length),
        "X-Git-Strip-Components": "1",
        "X-Git-Archive-Format": "tar.gz",
      });
      res.end(req.method === "HEAD" ? undefined : corrupt);
      return;
    }
    if (repoPath === "error/slow") {
      const timer = setTimeout(() => {
        requests.push({ server: "forge", method: req.method, path: parsed.pathname, repo: repoPath, ref, status: 504, hasAuth });
        sendJson(res, 504, { error: "simulated slow upstream timeout" });
      }, 5000);
      res.on("close", () => { if (!res.writableEnded) clearTimeout(timer); });
      return;
    }

    // 3. Repository & ref lookup
    const repoEntry = repos.get(repoPath);
    const archive = resolveRef(repoEntry, ref);
    if (!archive) {
      requests.push({
        server: "forge",
        method: req.method,
        path: parsed.pathname,
        repo: repoPath,
        ref,
        status: 404,
        hasAuth,
      });
      sendJson(res, 404, { error: `repository or ref not found: ${repoPath}@${ref}` });
      return;
    }

    const shouldRedirect =
      repoEntry.redirectArchives !== undefined ? repoEntry.redirectArchives : defaultRedirectArchives;

    if (shouldRedirect) {
      const location = `http://127.0.0.1:${cdnPort}/cdn/${archive.id}.tar.gz?sig=mock-presigned`;
      requests.push({
        server: "forge",
        method: req.method,
        path: parsed.pathname,
        repo: repoPath,
        ref,
        status: 302,
        hasAuth,
      });
      res.writeHead(302, {
        Location: location,
        "Content-Length": "0",
      });
      res.end();
      return;
    }

    requests.push({
      server: "forge",
      method: req.method,
      path: parsed.pathname,
      repo: repoPath,
      ref,
      status: 200,
      hasAuth,
    });
    sendArchiveResponse(req, res, archive);
  });

  await new Promise((resolve) => cdnServer.listen(0, "127.0.0.1", resolve));
  cdnPort = cdnServer.address().port;

  await new Promise((resolve) => forgeServer.listen(0, "127.0.0.1", resolve));
  gitPort = forgeServer.address().port;

  const host = `127.0.0.1:${gitPort}`;
  const url = `http://${host}`;
  const cdnHost = `127.0.0.1:${cdnPort}`;
  const cdnUrl = `http://${cdnHost}`;

  return {
    host,
    url,
    port: gitPort,
    cdnHost,
    cdnUrl,
    cdnPort,
    repoUrl(repoPath) {
      const clean = String(repoPath || "").replace(/^\/+/, "");
      return `${url}/${clean}`;
    },
    requests,
    getRequests(predicate) {
      return typeof predicate === "function" ? requests.filter(predicate) : [...requests];
    },
    clearRequests() {
      requests.length = 0;
    },
    resetRequests() {
      requests.length = 0;
    },
    leakedAuthCount() {
      return leakedAuthCounter;
    },
    resetLeakedAuthCount() {
      leakedAuthCounter = 0;
    },
    registerRepo,
    addRepo,
    setErrorTrigger(key, trigger) {
      errorTriggers.set(String(key), trigger);
    },
    clearErrorTriggers() {
      errorTriggers.clear();
    },
    getArchive,
    async close() {
      await Promise.all([
        new Promise((resolve) => forgeServer.close(resolve)),
        new Promise((resolve) => cdnServer.close(resolve)),
      ]);
    },
  };
}
