// Tier 3: Multi-Feature Combinations & Cross-Component Workflows (Opaque-Box E2E)

import { pathToFileURL } from "node:url";
import {
  assert,
  assertIncludes,
  assertNotIncludes,
  assertMatch,
  stripAnsi,
  sleep,
  waitFor,
  waitWithTimeout,
  Suite,
} from "./helpers/test_runner.mjs";
import { startMockOciRegistry } from "./helpers/mock_oci_registry.mjs";
import { startMockGitServer } from "./helpers/mock_git_server.mjs";
import { REQUIRED_ARTIFACTS, startServer } from "./helpers/server_harness.mjs";

const T3_PINNED_SHA = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

export async function runTier3(opts = {}) {
  const sdk = await import(pathToFileURL(REQUIRED_ARTIFACTS.dockerSdk).href);
  const { Elf2WasmDocker } = sdk;

  let registry = null;
  let gitServer = null;
  let server = null;

  try {
    registry = await startMockOciRegistry({ requireAuth: true, redirectBlobs: true });
    gitServer = await startMockGitServer({ redirectArchives: true });
    server = await startServer({ allowLocalRegistries: true });

    gitServer.addRepo("acme/shell-proj", {
      main: [
        { path: "shell-proj-main/", type: "dir", mode: 0o755 },
        { path: "shell-proj-main/version.txt", type: "file", content: "branch-main-v2\n" },
        { path: "shell-proj-main/bin/", type: "dir", mode: 0o755 },
        {
          path: "shell-proj-main/bin/check.sh",
          type: "file",
          mode: 0o755,
          content: '#!/bin/sh\necho "PWD=$PWD"\necho "SHELL_TEST_PASS:main:$((20+22))"\ncat version.txt\n',
        },
      ],
      [T3_PINNED_SHA]: [
        { path: "shell-proj-a1b2c3d4/", type: "dir", mode: 0o755 },
        { path: "shell-proj-a1b2c3d4/version.txt", type: "file", content: "pinned-sha-v1\n" },
        { path: "shell-proj-a1b2c3d4/bin/", type: "dir", mode: 0o755 },
        {
          path: "shell-proj-a1b2c3d4/bin/check.sh",
          type: "file",
          mode: 0o755,
          content: '#!/bin/sh\necho "PWD=$PWD"\necho "SHELL_TEST_PASS:sha:$((90+9))"\ncat version.txt\n',
        },
      ],
    });

    gitServer.addRepo("acme/py-mathlib", {
      "v1.0.0": [
        { path: "py-mathlib-v1.0.0/", type: "dir", mode: 0o755 },
        { path: "py-mathlib-v1.0.0/mathlib/", type: "dir", mode: 0o755 },
        { path: "py-mathlib-v1.0.0/mathlib/__init__.py", type: "file", content: "" },
        {
          path: "py-mathlib-v1.0.0/mathlib/calc.py",
          type: "file",
          content: [
            "import hashlib",
            "import json",
            "import math",
            "",
            "def add(a, b):",
            "    return a + b",
            "",
            "def fact_and_hash(n, label):",
            "    val = math.factorial(n)",
            "    h = hashlib.sha256(f'{label}:{val}'.encode('utf-8')).hexdigest()[:12]",
            "    return json.loads(json.dumps({'val': val, 'hash': h}))",
            "",
          ].join("\n"),
        },
        { path: "py-mathlib-v1.0.0/tests/", type: "dir", mode: 0o755 },
        { path: "py-mathlib-v1.0.0/tests/__init__.py", type: "file", content: "" },
        {
          path: "py-mathlib-v1.0.0/tests/test_calc.py",
          type: "file",
          content: [
            "import os",
            "import unittest",
            "from mathlib.calc import add, fact_and_hash",
            "",
            "class TestMathlib(unittest.TestCase):",
            "    def test_arithmetic(self):",
            "        self.assertEqual(add(20, 22), 42)",
            "",
            "    def test_factorial_and_sha256(self):",
            "        res = fact_and_hash(6, 'elf2wasm')",
            "        self.assertEqual(res['val'], 720)",
            "        self.assertEqual(len(res['hash']), 12)",
            "",
            "    def test_cwd_workspace(self):",
            "        self.assertEqual(os.getcwd(), '/workspace')",
            "",
            "if __name__ == '__main__':",
            "    unittest.main()",
            "",
          ].join("\n"),
        },
      ],
    });

    gitServer.addRepo("acme/js-toolkit", {
      main: [
        { path: "js-toolkit-main/", type: "dir", mode: 0o755 },
        {
          path: "js-toolkit-main/package.json",
          type: "file",
          content: JSON.stringify({ name: "js-toolkit", type: "module" }, null, 2) + "\n",
        },
        { path: "js-toolkit-main/src/", type: "dir", mode: 0o755 },
        {
          path: "js-toolkit-main/src/index.mjs",
          type: "file",
          content: [
            'import crypto from "node:crypto";',
            "export function add(a, b) { return a + b; }",
            'export function sha12(s) { return crypto.createHash("sha256").update(s).digest("hex").slice(0, 12); }',
            "",
          ].join("\n"),
        },
        { path: "js-toolkit-main/test/", type: "dir", mode: 0o755 },
        {
          path: "js-toolkit-main/test/index.test.mjs",
          type: "file",
          content: [
            'import test from "node:test";',
            'import assert from "node:assert/strict";',
            'import { add, sha12 } from "../src/index.mjs";',
            "",
            'test("add(20, 22) === 42", () => { assert.equal(add(20, 22), 42); });',
            'test("sha12 produces 12 hex chars", () => { assert.match(sha12("elf2wasm"), /^[0-9a-f]{12}$/); });',
            'test("cwd is /workspace", () => { assert.equal(process.cwd(), "/workspace"); });',
            "",
          ].join("\n"),
        },
      ],
    });

    const sdkOpts = {
      compilerWasmUrl: `${server.url}/wasm/elf2wasm_compiler_wasm.wasm`,
      runtimeWasmUrl: `${server.url}/wasm/elf2wasm_runtime_wasm.wasm`,
      registryProxyBase: `${server.url}/api/v2`,
      gitProxyBase: `${server.url}/api/git/archive`,
      useWorker: false,
    };

    const docker = await Elf2WasmDocker.create(sdkOpts);
    let pythonImage = null;
    let nodeImage = null;

    async function getPython() {
      if (!pythonImage) {
        const ref = registry.ensureBuiltinFixture("python");
        pythonImage = await docker.pullImage(ref);
      }
      return pythonImage;
    }

    async function getNode() {
      if (!nodeImage) {
        const ref = registry.ensureBuiltinFixture("node");
        nodeImage = await docker.pullImage(ref);
      }
      return nodeImage;
    }

    const suite = new Suite("Tier 3 (Combinations)");

  suite.add("T3.1", "Multi-layer OCI + whiteouts + symlinks + PATH + Env + WorkingDir", async () => {
    const comboImage = await docker.pullImage(registry.imageRef("custom/combo", "v1"));
    const script = [
      "mytool",
      'if test -e /opt/app/stale.txt; then echo STALE_LEAKED; else echo STALE_GONE; fi',
    ].join(" && ");
    const container = await comboImage.createContainer({
      cmd: ["/bin/sh", "-c", script],
      tty: false,
    });
    await container.start();
    const res = await container.wait();
    assert.equal(res.exitCode, 0);
    const out = stripAnsi(res.stdout);
    assertIncludes(out, "TOOL_OK:/opt/app:prod:COMBO_DATA_99");
    assertIncludes(out, "STALE_GONE");
    assertNotIncludes(out, "STALE_LEAKED");
  });

  suite.add("T3.2", "Pipelines + redirections + subshells + #! script + /dev/null in interactive TTY", async () => {
    const alpineImage = await docker.pullImage(registry.imageRef("library/alpine", "latest"));
    const container = await alpineImage.createContainer({ tty: true });
    let liveOut = "";
    const dec = new TextDecoder();
    container.onStdout((chunk) => {
      liveOut += dec.decode(chunk, { stream: true });
    });

    await container.start();
    try {
      container.writeStdin("printf '#!/bin/sh\\ncat\\n' > /tmp/filter.sh && chmod +x /tmp/filter.sh\n");
      container.writeStdin(
        '(cat /etc/passwd; printf "%s_%s\\n" ERR HIDE >&2) 2>/dev/null | /tmp/filter.sh | wc -l > /tmp/count.txt && printf "LINES=%s\\n" "$(cat /tmp/count.txt | tr -d \' \')"\n'
      );
      await waitFor(() => /LINES=[1-9]\d*/.test(stripAnsi(liveOut)), {
        timeoutMs: 30000,
        label: "pipeline LINES=<N> output",
      });

      container.writeStdin("exit\n");
      const res = await container.wait();
      assert.equal(res.exitCode, 0);
      const clean = stripAnsi(res.stdout);
      assertMatch(clean, /LINES=[1-9]\d*/);
      // Verify ERR_HIDE was redirected to /dev/null. Constructing the token with printf avoids
      // BusyBox ash's interactive TTY line-editor echo on fd 2 (stderr) containing the literal
      // "ERR_HIDE" string, while any failure of 2>/dev/null will emit "ERR_HIDE" to stderr.
      assertNotIncludes(stripAnsi(res.stderr), "ERR_HIDE");
      assertNotIncludes(stripAnsi(res.stdout), "ERR_HIDE");
    } finally {
      await container.stop().catch(() => {});
    }
  });

  suite.add("T3.3", "Host VFS bridge (writeFile / readFile) combined with interactive shell", async () => {
    const alpineImage = await docker.pullImage(registry.imageRef("library/alpine", "latest"));
    const container = await alpineImage.createContainer({ tty: false });
    let liveOut = "";
    const dec = new TextDecoder();
    container.onStdout((chunk) => {
      liveOut += dec.decode(chunk, { stream: true });
    });

    await container.writeFile("/tmp/host_in.txt", "from_js_42\n");
    await container.start();
    try {
      container.writeStdin("tr a-z A-Z < /tmp/host_in.txt > /tmp/guest_out.txt && echo VFS_DONE\n");
      await waitFor(() => stripAnsi(liveOut).includes("VFS_DONE"), {
        timeoutMs: 30000,
        label: "VFS_DONE",
      });

      const outBytes = await container.readFile("/tmp/guest_out.txt");
      assert.ok(outBytes instanceof Uint8Array, "readFile should return Uint8Array");
      assert.equal(new TextDecoder().decode(outBytes), "FROM_JS_42\n");

      const missing = await container.readFile("/nonexistent_e2e_file_xyz");
      assert.equal(missing, null, "readFile on missing path should return null");

      container.writeStdin("exit\n");
      const res = await container.wait();
      assert.equal(res.exitCode, 0);
    } finally {
      await container.stop().catch(() => {});
    }
  });

  suite.add("T3.4", "Multi-image switching in same SDK session isolates VFS and configs", async () => {
    // 1. Alpine writes /tmp/marker_a
    const img1 = await docker.pullImage(registry.imageRef("library/alpine", "latest"));
    const c1 = await img1.createContainer({
      cmd: ["/bin/sh", "-c", "echo MARKER_A > /tmp/marker_a && grep -i alpine /etc/os-release"],
      tty: false,
    });
    await c1.start();
    const r1 = await c1.wait();
    assert.equal(r1.exitCode, 0);
    assertMatch(stripAnsi(r1.stdout), /alpine/i);

    // 2. Second image (custom/app:v2) must NOT see /tmp/marker_a, MUST see /etc/second_image_id and WorkingDir=/srv
    const img2 = await docker.pullImage(registry.imageRef("custom/app", "v2"));
    const c2 = await img2.createContainer({
      cmd: [
        "/bin/sh",
        "-c",
        'pwd && cat /etc/second_image_id && echo "ID=$IMAGE_ID" && if test -e /tmp/marker_a; then echo LEAKED; else echo CLEAN_VFS; fi',
      ],
      tty: false,
    });
    await c2.start();
    const r2 = await c2.wait();
    assert.equal(r2.exitCode, 0);
    const out2 = stripAnsi(r2.stdout);
    assertIncludes(out2, "/srv");
    assertIncludes(out2, "SECOND_IMAGE_APP_V2");
    assertIncludes(out2, "ID=app-v2");
    assertIncludes(out2, "CLEAN_VFS");
    assertNotIncludes(out2, "LEAKED");

    // 3. Third image (busybox:musl) with relative Cmd: ["sh"] and omitted WorkingDir
    const img3 = await docker.pullImage(registry.imageRef("library/busybox", "musl"));
    const c3 = await img3.createContainer({
      cmd: ["sh", "-c", 'pwd && echo "BB=$((30+12))" && test ! -e /etc/second_image_id && echo NO_LEAK_2'],
      tty: false,
    });
    await c3.start();
    const r3 = await c3.wait();
    assert.equal(r3.exitCode, 0);
    const out3 = stripAnsi(r3.stdout);
    assertIncludes(out3, "BB=42");
    assertIncludes(out3, "NO_LEAK_2");
  });

  suite.add("T3.5", "Offline loadOciTarball + interactive TTY + resize + SIGINT + closeStdin", async () => {
    const tarBytes = registry.getOciTarball("library/alpine", "latest");
    const offlineImg = await docker.loadOciTarball(tarBytes);
    const container = await offlineImg.createContainer({ tty: true, cols: 80, rows: 24 });
    let liveOut = "";
    const dec = new TextDecoder();
    container.onStdout((chunk) => {
      liveOut += dec.decode(chunk, { stream: true });
    });

    await container.start();
    try {
      container.resize(100, 30);
      container.writeStdin("stty size\n");
      await waitFor(() => stripAnsi(liveOut).includes("30 100"), {
        timeoutMs: 30000,
        label: "offline tarball stty size 30 100",
      });

      container.writeStdin("sleep 30\n");
      await sleep(500);
      container.sendSignal("SIGINT");
      await sleep(300);
      container.writeStdin('printf "%s_%s\\n" OFFLINE SIGINT_OK\n');
      await waitFor(() => stripAnsi(liveOut).includes("OFFLINE_SIGINT_OK"), {
        timeoutMs: 10000,
        label: "OFFLINE_SIGINT_OK",
      });

      container.closeStdin();
      let exitTimer = null;
      const res = await Promise.race([
        container.wait(),
        new Promise((_, reject) => {
          exitTimer = setTimeout(() => {
            reject(new Error("Timed out waiting for offline container exit on closeStdin()"));
          }, 15000);
        }),
      ]).finally(() => {
        if (exitTimer) clearTimeout(exitTimer);
      });
      assert.equal(res.exitCode, 0);
    } finally {
      await container.stop().catch(() => {});
    }
  });

  suite.add("T3.6", "Host VFS bridge (writeFile / readFile) + python:3.12-slim filesystem persistence", async () => {
    const img = await getPython();
    const script = [
      "import json, os",
      "data = json.load(open('/tmp/py_in.json'))",
      "os.makedirs('/tmp/py_work', exist_ok=True)",
      "with open('/tmp/py_work/out.txt', 'w') as f:\n    f.write('SUM=' + str(sum(data['nums'])) + '\\n')",
      "with open('/tmp/py_work/out.txt', 'a') as f:\n    f.write('PERSIST=OK\\n')",
      "content = open('/tmp/py_work/out.txt').read()",
      "print('PY_VFS_OK:' + content.strip().replace('\\n', '|'))",
    ].join("\n");

    const container = await img.createContainer({
      cmd: ["python3", "-c", script],
      tty: false,
    });
    await container.writeFile("/tmp/py_in.json", JSON.stringify({ nums: [10, 20, 12] }));
    await container.start();
    try {
      const res = await waitWithTimeout(container.wait(), 120000, "T3.6 python VFS bridge");
      assert.equal(res.exitCode, 0, `Expected exitCode 0, stderr: ${res.stderr}`);
      assertIncludes(stripAnsi(res.stdout), "PY_VFS_OK:SUM=42|PERSIST=OK");

      const outBytes = await container.readFile("/tmp/py_work/out.txt");
      assert.ok(outBytes instanceof Uint8Array, "readFile must return Uint8Array");
      assert.equal(new TextDecoder().decode(outBytes), "SUM=42\nPERSIST=OK\n");

      const missing = await container.readFile("/tmp/py_work/nonexistent");
      assert.equal(missing, null, "readFile on missing path must return null");
    } finally {
      await container.stop().catch(() => {});
    }
  });

  suite.add("T3.7", "Host VFS bridge (writeFile / readFile) + node:22-slim filesystem persistence", async () => {
    const img = await getNode();
    const script = [
      "const fs = require('fs');",
      "const data = JSON.parse(fs.readFileSync('/tmp/node_in.json', 'utf8'));",
      "const prod = data.factors.reduce((a, b) => a * b, 1);",
      "fs.mkdirSync('/tmp/node_work', { recursive: true });",
      "fs.writeFileSync('/tmp/node_work/out.txt', 'PROD=' + prod + '\\n');",
      "fs.appendFileSync('/tmp/node_work/out.txt', 'NODE_PERSIST=OK\\n');",
      "console.log('NODE_VFS_OK:' + fs.readdirSync('/tmp/node_work').join(','));",
    ].join("\n");

    const container = await img.createContainer({
      cmd: ["node", "-e", script],
      tty: false,
    });
    await container.writeFile("/tmp/node_in.json", JSON.stringify({ factors: [6, 7] }));
    await container.start();
    try {
      const res = await waitWithTimeout(container.wait(), 180000, "T3.7 node VFS bridge");
      assert.equal(res.exitCode, 0, `Expected exitCode 0, stderr: ${res.stderr}`);
      assertIncludes(stripAnsi(res.stdout), "NODE_VFS_OK:out.txt");

      const outBytes = await container.readFile("/tmp/node_work/out.txt");
      assert.ok(outBytes instanceof Uint8Array, "readFile must return Uint8Array");
      assert.equal(new TextDecoder().decode(outBytes), "PROD=42\nNODE_PERSIST=OK\n");

      const missing = await container.readFile("/tmp/node_work/missing");
      assert.equal(missing, null, "readFile on missing path must return null");
    } finally {
      await container.stop().catch(() => {});
    }
  });

  suite.add("T3.8", "Stdin-to-stdout live streaming + Python subprocess.run + /bin/sh | node POSIX pipe", async () => {
    const pyImg = await getPython();
    const nodeImg = await getNode();

    // Part A.1: Python live stdin -> stdout streaming before closeStdin()
    const pyStream = await pyImg.createContainer({
      cmd: [
        "python3",
        "-u",
        "-c",
        "import sys\nfor line in sys.stdin:\n    print('PSTREAM:' + line.strip().upper(), flush=True)",
      ],
      tty: false,
    });
    let pyLiveOut = "";
    const pyDec = new TextDecoder();
    pyStream.onStdout((chunk) => {
      pyLiveOut += pyDec.decode(chunk, { stream: true });
    });
    await pyStream.start();
    try {
      pyStream.writeStdin("one_1\n");
      await waitFor(() => stripAnsi(pyLiveOut).includes("PSTREAM:ONE_1"), {
        timeoutMs: 60000,
        intervalMs: 150,
        label: "PSTREAM:ONE_1",
      });
      pyStream.writeStdin("two_2\n");
      await waitFor(() => stripAnsi(pyLiveOut).includes("PSTREAM:TWO_2"), {
        timeoutMs: 30000,
        intervalMs: 150,
        label: "PSTREAM:TWO_2",
      });
      pyStream.closeStdin();
      const resA1 = await waitWithTimeout(pyStream.wait(), 30000, "T3.8 Part A.1 python stream exit");
      assert.equal(resA1.exitCode, 0);
    } finally {
      await pyStream.stop().catch(() => {});
    }

    // Part A.2: Python subprocess.run piping to /bin/sh
    const pySub = await pyImg.createContainer({
      cmd: [
        "python3",
        "-c",
        "import subprocess; p = subprocess.run(['/bin/sh', '-c', 'tr a-z A-Z'], input='sub_pipe_42\\n', text=True, capture_output=True, check=True); print('PYSUB=' + p.stdout.strip())",
      ],
      tty: false,
    });
    await pySub.start();
    try {
      const resA2 = await waitWithTimeout(pySub.wait(), 60000, "T3.8 Part A.2 python subprocess.run");
      assert.equal(resA2.exitCode, 0, `Expected exitCode 0, stderr: ${resA2.stderr}`);
      assertIncludes(stripAnsi(resA2.stdout), "PYSUB=SUB_PIPE_42");
    } finally {
      await pySub.stop().catch(() => {});
    }

    // Part B.1: Node live stdin -> stdout streaming before closeStdin()
    const nodeStream = await nodeImg.createContainer({
      cmd: [
        "node",
        "-e",
        "process.stdin.setEncoding('utf8'); process.stdin.on('data', d => { for (const l of d.split(/\\r?\\n/).filter(Boolean)) console.log('NSTREAM:' + l.toUpperCase()); });",
      ],
      tty: false,
    });
    let nodeLiveOut = "";
    const nodeDec = new TextDecoder();
    nodeStream.onStdout((chunk) => {
      nodeLiveOut += nodeDec.decode(chunk, { stream: true });
    });
    await nodeStream.start();
    try {
      nodeStream.writeStdin("alpha\n");
      await waitFor(() => stripAnsi(nodeLiveOut).includes("NSTREAM:ALPHA"), {
        timeoutMs: 60000,
        intervalMs: 150,
        label: "NSTREAM:ALPHA",
      });
      nodeStream.writeStdin("beta\n");
      await waitFor(() => stripAnsi(nodeLiveOut).includes("NSTREAM:BETA"), {
        timeoutMs: 30000,
        intervalMs: 150,
        label: "NSTREAM:BETA",
      });
      nodeStream.closeStdin();
      const resB1 = await waitWithTimeout(nodeStream.wait(), 30000, "T3.8 Part B.1 node stream exit");
      assert.equal(resB1.exitCode, 0);
    } finally {
      await nodeStream.stop().catch(() => {});
    }

    // Part B.2: /bin/sh piping into node over POSIX pipe
    const nodePipe = await nodeImg.createContainer({
      entrypoint: ["/bin/sh", "-c"],
      cmd: [
        "printf 'from_sh_21\\n' | node -e \"const s=require('fs').readFileSync(0,'utf8').trim(); console.log('NODEPIPE:' + s.toUpperCase());\"",
      ],
      tty: false,
    });
    await nodePipe.start();
    try {
      const resB2 = await waitWithTimeout(nodePipe.wait(), 60000, "T3.8 Part B.2 /bin/sh | node");
      assert.equal(resB2.exitCode, 0, `Expected exitCode 0, stderr: ${resB2.stderr}`);
      assertIncludes(stripAnsi(resB2.stdout), "NODEPIPE:FROM_SH_21");
    } finally {
      await nodePipe.stop().catch(() => {});
    }
  });

  suite.add("T3.9", "Clean multi-image switching (alpine -> python -> node -> alpine) with zero VFS or env bleed", async () => {
    const alpineImg = await docker.pullImage(registry.imageRef("library/alpine", "latest"));
    const pyImg = await getPython();
    const nodeImg = await getNode();

    // 1. Alpine writes /tmp/sw_alpine
    const c1 = await alpineImg.createContainer({
      cmd: ["/bin/sh", "-c", "echo ALP > /tmp/sw_alpine && grep -i alpine /etc/os-release"],
      tty: false,
    });
    await c1.start();
    try {
      const r1 = await waitWithTimeout(c1.wait(), 45000, "T3.9 step 1 alpine");
      assert.equal(r1.exitCode, 0);
      assertMatch(stripAnsi(r1.stdout), /alpine/i);
    } finally {
      await c1.stop().catch(() => {});
    }

    // 2. Python must NOT see /tmp/sw_alpine; writes /tmp/sw_py
    const c2 = await pyImg.createContainer({
      cmd: [
        "python3",
        "-c",
        "import os; assert not os.path.exists('/tmp/sw_alpine'); open('/tmp/sw_py','w').write('PY'); print('CLEAN_PY SW_PY_OK')",
      ],
      tty: false,
    });
    await c2.start();
    try {
      const r2 = await waitWithTimeout(c2.wait(), 45000, "T3.9 step 2 python");
      assert.equal(r2.exitCode, 0, `Expected exitCode 0, stderr: ${r2.stderr}`);
      const out2 = stripAnsi(r2.stdout);
      assertIncludes(out2, "CLEAN_PY");
      assertIncludes(out2, "SW_PY_OK");
    } finally {
      await c2.stop().catch(() => {});
    }

    // 3. Node must NOT see /tmp/sw_alpine or /tmp/sw_py; writes /tmp/sw_node
    const c3 = await nodeImg.createContainer({
      cmd: [
        "node",
        "-e",
        "const fs=require('fs'); if (fs.existsSync('/tmp/sw_alpine') || fs.existsSync('/tmp/sw_py')) process.exit(2); fs.writeFileSync('/tmp/sw_node','ND'); console.log('CLEAN_NODE SW_NODE_OK');",
      ],
      tty: false,
    });
    await c3.start();
    try {
      const r3 = await waitWithTimeout(c3.wait(), 45000, "T3.9 step 3 node");
      assert.equal(r3.exitCode, 0, `Expected exitCode 0, stderr: ${r3.stderr}`);
      const out3 = stripAnsi(r3.stdout);
      assertIncludes(out3, "CLEAN_NODE");
      assertIncludes(out3, "SW_NODE_OK");
    } finally {
      await c3.stop().catch(() => {});
    }

    // 4. Back to Alpine: zero VFS or env bleed (no /tmp/sw_*, no NODE_OPTIONS, no PYTHON_VERSION)
    const c4 = await alpineImg.createContainer({
      cmd: [
        "/bin/sh",
        "-c",
        'test ! -e /tmp/sw_alpine && test ! -e /tmp/sw_py && test ! -e /tmp/sw_node && test -z "$NODE_OPTIONS" && test -z "$PYTHON_VERSION" && echo SW_BACK_ALPINE_OK',
      ],
      tty: false,
    });
    await c4.start();
    try {
      const r4 = await waitWithTimeout(c4.wait(), 45000, "T3.9 step 4 alpine");
      assert.equal(r4.exitCode, 0, `Expected exitCode 0, stderr: ${r4.stderr}`);
      assertIncludes(stripAnsi(r4.stdout), "SW_BACK_ALPINE_OK");
    } finally {
      await c4.stop().catch(() => {});
    }
  });

  // -------------------------------------------------------------------------
  // Git Repo Overlay Combinations (Features F25-F28, Contracts §7-§9)
  // -------------------------------------------------------------------------

  suite.add("T3.10", "Alpine + git repo overlay (branch main vs pinned 40-char commit SHA) running shell test script in /workspace", async () => {
    const alpineImg = await docker.pullImage(registry.imageRef("library/alpine", "latest"));

    // Part A: branch main
    const cMain = await alpineImg.createContainer({
      gitRepo: { repo: gitServer.repoUrl("acme/shell-proj"), ref: "main" },
      cmd: ["/bin/sh", "-c", "pwd && test ! -d /workspace/shell-proj-main && ./bin/check.sh"],
      tty: false,
    });
    await cMain.start();
    try {
      const resMain = await waitWithTimeout(cMain.wait(), 90000, "T3.10 branch main");
      assert.equal(resMain.exitCode, 0, `Branch main failed (stderr: ${resMain.stderr})`);
      const outMain = stripAnsi(resMain.stdout);
      assertIncludes(outMain, "/workspace");
      assertIncludes(outMain, "SHELL_TEST_PASS:main:42");
      assertIncludes(outMain, "branch-main-v2");
      assertNotIncludes(outMain, "pinned-sha-v1");
    } finally {
      await cMain.stop().catch(() => {});
    }

    // Part B: pinned 40-char commit SHA
    const cSha = await alpineImg.createContainer({
      gitRepo: { repo: gitServer.repoUrl("acme/shell-proj"), ref: T3_PINNED_SHA },
      cmd: ["/bin/sh", "-c", "pwd && test ! -d /workspace/shell-proj-a1b2c3d4 && ./bin/check.sh"],
      tty: false,
    });
    await cSha.start();
    try {
      const resSha = await waitWithTimeout(cSha.wait(), 90000, "T3.10 pinned SHA");
      assert.equal(resSha.exitCode, 0, `Pinned SHA failed (stderr: ${resSha.stderr})`);
      const outSha = stripAnsi(resSha.stdout);
      assertIncludes(outSha, "/workspace");
      assertIncludes(outSha, "SHELL_TEST_PASS:sha:99");
      assertIncludes(outSha, "pinned-sha-v1");
      assertNotIncludes(outSha, "branch-main-v2");
    } finally {
      await cSha.stop().catch(() => {});
    }
  });

  suite.add("T3.11", "python:3.12-slim + synthetic Python project git repo overlay running unittest discover in /workspace", async () => {
    const pyImg = await getPython();
    const container = await pyImg.createContainer({
      gitRepo: { repo: gitServer.repoUrl("acme/py-mathlib"), ref: "v1.0.0" },
      cmd: ["python3", "-m", "unittest", "discover", "-s", "tests", "-v"],
      tty: false,
    });
    await container.start();
    try {
      const res = await waitWithTimeout(container.wait(), 120000, "T3.11 python unittest discover");
      assert.equal(res.exitCode, 0, `Python unittest failed (stdout: ${res.stdout}\nstderr: ${res.stderr})`);
      const combined = stripAnsi(`${res.stdout}\n${res.stderr}`);
      assertMatch(combined, /Ran 3 tests in/);
      assertMatch(combined, /(?:^|\n)OK(?:\n|$)/);
      assertIncludes(combined, "test_cwd_workspace");
    } finally {
      await container.stop().catch(() => {});
    }
  });

  suite.add("T3.12", "node:22-slim + synthetic JavaScript project git repo overlay running node --test in /workspace", async () => {
    const nodeImg = await getNode();
    const container = await nodeImg.createContainer({
      gitRepo: { repo: gitServer.repoUrl("acme/js-toolkit"), ref: "main" },
      cmd: ["node", "--test", "--experimental-test-isolation=none", "test/index.test.mjs"],
      tty: false,
    });
    await container.start();
    try {
      const res = await waitWithTimeout(container.wait(), 180000, "T3.12 node --test");
      assert.equal(res.exitCode, 0, `Node test failed (stdout: ${res.stdout}\nstderr: ${res.stderr})`);
      const combined = stripAnsi(`${res.stdout}\n${res.stderr}`);
      assertMatch(combined, /tests 3/);
      assertMatch(combined, /pass 3/);
      assertMatch(combined, /fail 0/);
    } finally {
      await container.stop().catch(() => {});
    }
  });

  suite.add("T3.13", "Git repo overlay + custom mountPath + env/cmd overrides + host readFile/writeFile + zero /workspace bleed", async () => {
    const alpineImg = await docker.pullImage(registry.imageRef("library/alpine", "latest"));

    // Part A: Overlaid container with custom mountPath, env, and host writeFile/readFile
    const c1 = await alpineImg.createContainer({
      gitRepo: {
        repo: gitServer.repoUrl("acme/shell-proj"),
        ref: "main",
        mountPath: "/opt/myrepo",
      },
      env: ["CUSTOM_TAG=OVERLAY_77"],
      cmd: [
        "/bin/sh",
        "-c",
        'printf "PWD=%s\\nENV=%s\\nVER=%s\\nHOST=%s\\n" "$PWD" "$CUSTOM_TAG" "$(cat version.txt)" "$(cat /opt/myrepo/host_in.txt)" > /opt/myrepo/result.out && cat /opt/myrepo/result.out',
      ],
      tty: false,
    });
    await c1.writeFile("/opt/myrepo/host_in.txt", "FROM_HOST_99");
    await c1.start();
    try {
      const r1 = await waitWithTimeout(c1.wait(), 90000, "T3.13 Part A overlaid container");
      assert.equal(r1.exitCode, 0, `Part A failed (stderr: ${r1.stderr})`);
      const out1 = stripAnsi(r1.stdout);
      assertIncludes(out1, "PWD=/opt/myrepo");
      assertIncludes(out1, "ENV=OVERLAY_77");
      assertIncludes(out1, "VER=branch-main-v2");
      assertIncludes(out1, "HOST=FROM_HOST_99");

      const verBytes = await c1.readFile("/opt/myrepo/version.txt");
      assert.ok(verBytes instanceof Uint8Array);
      assert.equal(new TextDecoder().decode(verBytes), "branch-main-v2\n");

      const resBytes = await c1.readFile("/opt/myrepo/result.out");
      assert.ok(resBytes instanceof Uint8Array);
      assertIncludes(new TextDecoder().decode(resBytes), "HOST=FROM_HOST_99");
    } finally {
      await c1.stop().catch(() => {});
    }

    // Part B: Plain container on same alpineImg with NO gitRepo must have zero VFS/env bleed
    const c2 = await alpineImg.createContainer({
      cmd: [
        "/bin/sh",
        "-c",
        'test ! -e /workspace && test ! -e /opt/myrepo && test -z "$CUSTOM_TAG" && echo ISOLATION_CLEAN',
      ],
      tty: false,
    });
    await c2.start();
    try {
      const r2 = await waitWithTimeout(c2.wait(), 90000, "T3.13 Part B plain container isolation");
      assert.equal(r2.exitCode, 0, `Part B isolation failed (stderr: ${r2.stderr})`);
      assertIncludes(stripAnsi(r2.stdout), "ISOLATION_CLEAN");
      assert.equal(await c2.readFile("/opt/myrepo/version.txt"), null);
      assert.equal(await c2.readFile("/workspace/version.txt"), null);
    } finally {
      await c2.stop().catch(() => {});
    }
  });

    return await suite.run(opts);
  } finally {
    if (server) await server.close();
    if (gitServer) await gitServer.close();
    if (registry) await registry.close();
  }
}
