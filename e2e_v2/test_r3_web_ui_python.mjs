#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
};

function buildPythonOverlayTarGz(tmpDir) {
  const rootfs = path.join(tmpDir, "rootfs");
  const tarGzPath = path.join(tmpDir, "python3_overlay.tar.gz");

  fs.mkdirSync(path.join(rootfs, "usr/bin"), { recursive: true });
  fs.mkdirSync(path.join(rootfs, "lib/x86_64-linux-gnu"), { recursive: true });
  fs.mkdirSync(path.join(rootfs, "lib64"), { recursive: true });
  fs.mkdirSync(path.join(rootfs, "usr/lib/python3.11/encodings"), { recursive: true });

  // Copy real binaries/shared libs (dereferencing host symlinks via fs.copyFileSync)
  fs.copyFileSync("/usr/bin/python3.11", path.join(rootfs, "usr/bin/python3.11"));
  fs.chmodSync(path.join(rootfs, "usr/bin/python3.11"), 0o755);

  const libs = [
    "libc.so.6",
    "libm.so.6",
    "libexpat.so.1",
    "libz.so.1",
    "ld-linux-x86-64.so.2",
  ];
  for (const lib of libs) {
    const src = path.join("/lib/x86_64-linux-gnu", lib);
    const dst = path.join(rootfs, "lib/x86_64-linux-gnu", lib);
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, 0o755);
  }

  // Symlinks
  fs.symlinkSync("python3.11", path.join(rootfs, "usr/bin/python3"));
  fs.symlinkSync(
    "/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2",
    path.join(rootfs, "lib64/ld-linux-x86-64.so.2")
  );

  // Minimal /usr/lib/python3.11 stdlib
  const pyFiles = [
    "os.py",
    "io.py",
    "abc.py",
    "codecs.py",
    "stat.py",
    "posixpath.py",
    "genericpath.py",
    "site.py",
    "_collections_abc.py",
    "_sitebuiltins.py",
    "types.py",
    "functools.py",
    "operator.py",
    "keyword.py",
    "reprlib.py",
    "warnings.py",
    "linecache.py",
    "tokenize.py",
    "token.py",
    "re/__init__.py",
    "re/_compiler.py",
    "re/_constants.py",
    "re/_parser.py",
    "re/_casefix.py",
    "enum.py",
    "copyreg.py",
    "sre_compile.py",
    "sre_constants.py",
    "sre_parse.py",
  ];
  for (const rel of pyFiles) {
    const src = path.join("/usr/lib/python3.11", rel);
    if (fs.existsSync(src)) {
      const dst = path.join(rootfs, "usr/lib/python3.11", rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
  }
  const encSrcDir = "/usr/lib/python3.11/encodings";
  const encDstDir = path.join(rootfs, "usr/lib/python3.11/encodings");
  for (const entry of fs.readdirSync(encSrcDir)) {
    if (entry.endsWith(".py")) {
      fs.copyFileSync(path.join(encSrcDir, entry), path.join(encDstDir, entry));
    }
  }

  execFileSync("tar", ["-czf", tarGzPath, "-C", rootfs, "."], { timeout: 30_000 });
  return tarGzPath;
}

function startStaticServer(rootDir) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      const safeRel = path.normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, "");
      let filePath = path.join(rootDir, safeRel === "/" ? "web/index.html" : safeRel);
      if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, "index.html");
      }
      if (!filePath.startsWith(rootDir) || !fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const ext = path.extname(filePath);
      res.writeHead(200, {
        "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      });
      fs.createReadStream(filePath).pipe(res);
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: addr.port });
    });
  });
}

class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.openPromise = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const entry = this.pending.get(msg.id);
        if (entry) {
          this.pending.delete(msg.id);
          if (msg.error) entry.reject(new Error(`CDP ${entry.method}: ${msg.error.message}`));
          else entry.resolve(msg.result);
        }
      } else {
        this.events.push(msg);
      }
    });
  }

  async connect() {
    await this.openPromise;
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.ws.close();
  }
}

async function launchChromium(userDataDir) {
  const proc = spawn(
    "/usr/bin/chromium",
    [
      "--headless",
      "--disable-gpu",
      "--no-sandbox",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  const wsUrl = await new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for Chromium DevTools URL. stderr:\n${stderr}`));
    }, 45_000);
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Chromium exited early with code ${code}. stderr:\n${stderr}`));
    });
  });

  return { proc, wsUrl };
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "elf2wasm_r3_"));
  let server = null;
  let chromeProc = null;
  let cdp = null;

  try {
    const tarGzPath = buildPythonOverlayTarGz(tmpDir);
    const tarGzBytes = new Uint8Array(fs.readFileSync(tarGzPath));

    const compilerWasmPath = path.join(
      REPO_ROOT,
      "target/wasm32-unknown-unknown/release/elf2wasm_compiler_wasm.wasm"
    );
    const runtimeWasmPath = path.join(
      REPO_ROOT,
      "target/wasm32-unknown-unknown/release/elf2wasm_runtime_wasm.wasm"
    );
    assert.ok(fs.existsSync(compilerWasmPath), `Missing ${compilerWasmPath}`);
    assert.ok(fs.existsSync(runtimeWasmPath), `Missing ${runtimeWasmPath}`);

    // 1. Test js/elf2wasm_shim.mjs extractTarGzToVfs & runFromVfs directly
    const shim = await import(path.join(REPO_ROOT, "js/elf2wasm_shim.mjs"));
    assert.equal(
      typeof shim.extractTarGzToVfs,
      "function",
      "js/elf2wasm_shim.mjs must export extractTarGzToVfs"
    );
    assert.equal(
      typeof shim.runFromVfs,
      "function",
      "js/elf2wasm_shim.mjs must export runFromVfs"
    );

    const vfs = await shim.extractTarGzToVfs(tarGzBytes);
    const compilerWasm = new Uint8Array(fs.readFileSync(compilerWasmPath));
    const runtimeWasm = new Uint8Array(fs.readFileSync(runtimeWasmPath));
    const shimRes = await shim.runFromVfs({
      compilerWasm,
      runtimeWasm,
      vfs,
      command: "/usr/bin/python3",
      args: ["-S", "-c", "print(6 * 7)"],
    });
    const shimStdout = new TextDecoder().decode(shimRes.stdout);
    assert.equal(shimRes.exitCode, 0, `runFromVfs python3 exited with ${shimRes.exitCode}`);
    assert.ok(
      shimStdout.includes("42"),
      `Expected runFromVfs python3 stdout to contain '42', got: ${shimStdout}`
    );
    console.log("[R3] js/elf2wasm_shim.mjs extractTarGzToVfs + runFromVfs + symlinks passed.");

    // 2. Test web/index.html in headless Chromium via CDP
    const webIndex = path.join(REPO_ROOT, "web/index.html");
    assert.ok(fs.existsSync(webIndex), `Missing ${webIndex}`);

    const srv = await startStaticServer(REPO_ROOT);
    server = srv.server;
    const baseUrl = `http://127.0.0.1:${srv.port}`;

    const chromeDataDir = path.join(tmpDir, "chrome_profile");
    fs.mkdirSync(chromeDataDir, { recursive: true });
    const chrome = await launchChromium(chromeDataDir);
    chromeProc = chrome.proc;

    // Open a page target via HTTP /json/list or /json/new
    const listRes = await fetch(
      chrome.wsUrl.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/.*$/, "/json/list")
    );
    const targets = await listRes.json();
    const pageTarget = targets.find((t) => t.type === "page");
    assert.ok(pageTarget, "No page target found in headless Chromium");

    cdp = new CdpClient(pageTarget.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("DOM.enable");

    await cdp.send("Page.navigate", { url: `${baseUrl}/web/index.html` });
    // Wait for document readyState === 'complete'
    for (let i = 0; i < 40; i++) {
      const res = await cdp.send("Runtime.evaluate", {
        expression: "document.readyState",
        returnByValue: true,
      });
      if (res.result?.value === "complete") break;
      await new Promise((r) => setTimeout(r, 150));
    }

    // Check for uncaught exceptions during page load
    const loadErrors = cdp.events.filter((e) => e.method === "Runtime.exceptionThrown");
    assert.equal(
      loadErrors.length,
      0,
      `Uncaught page error on load: ${JSON.stringify(loadErrors)}`
    );

    // Upload .tar.gz via DOM.setFileInputFiles
    const doc = await cdp.send("DOM.getDocument", { depth: -1 });
    const fileInput = await cdp.send("DOM.querySelector", {
      nodeId: doc.root.nodeId,
      selector: 'input[type="file"]',
    });
    assert.ok(fileInput.nodeId > 0, 'No <input type="file"> found on web/index.html');
    await cdp.send("DOM.setFileInputFiles", {
      nodeId: fileInput.nodeId,
      files: [tarGzPath],
    });

    // Wait briefly for file upload handler to process tar.gz
    await new Promise((r) => setTimeout(r, 500));

    // Fill command & args and click Run button
    const fillResult = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const cmdEl = document.querySelector('#command, input[name="command"], input[placeholder*="python"], input[type="text"]');
        const argsEl = document.querySelector('#args, input[name="args"], input[placeholder*="args"], input[placeholder*="-c"]');
        const runBtn = Array.from(document.querySelectorAll('button')).find(b => /run/i.test(b.textContent || ''));
        if (!cmdEl || !runBtn) {
          return { ok: false, reason: 'Missing command input or Run button' };
        }
        const setVal = (el, val) => {
          el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        setVal(cmdEl, '/usr/bin/python3');
        if (argsEl) setVal(argsEl, '-S -c "print(6 * 7)"');
        runBtn.click();
        return { ok: true };
      })()`,
      returnByValue: true,
    });
    assert.ok(
      fillResult.result?.value?.ok,
      `Failed to interact with web UI: ${JSON.stringify(fillResult.result?.value)}`
    );

    // Wait up to 45s for '42' to appear in output
    let found42 = false;
    let lastText = "";
    for (let i = 0; i < 90; i++) {
      const pageErrors = cdp.events.filter((e) => e.method === "Runtime.exceptionThrown");
      assert.equal(
        pageErrors.length,
        0,
        `Uncaught page error during execution: ${JSON.stringify(pageErrors)}`
      );
      const outRes = await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const out = document.querySelector('#output, #stdout, pre, textarea[readonly]');
          return out ? (out.textContent || out.value || '') : document.body.innerText;
        })()`,
        returnByValue: true,
      });
      lastText = outRes.result?.value || "";
      if (/\b42\b/.test(lastText)) {
        found42 = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(found42, `Expected Web UI output to contain '42', last output:\n${lastText}`);
    console.log("[R3] Headless Chromium Web UI python3 execution passed (output contains 42).");
    console.log("PASS: R3 VFS Symlinks, .tar.gz Overlay & HTML Web UI");
  } finally {
    if (cdp) {
      try { cdp.close(); } catch {}
    }
    if (chromeProc) {
      try { chromeProc.kill("SIGKILL"); } catch {}
    }
    if (server) {
      try { server.close(); } catch {}
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("FAIL: R3 VFS Symlinks, .tar.gz Overlay & HTML Web UI");
  console.error(err?.stack || err);
  process.exit(1);
});
