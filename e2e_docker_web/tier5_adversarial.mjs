#!/usr/bin/env node
// Tier 5: Adversarial Hardening E2E Suite
// Covers Round 1 (T5.1-T5.10) and Round 2 M7/M8 (T5.11-T5.14) adversarial gaps end-to-end.
// Standalone executable: `node e2e_docker_web/tier5_adversarial.mjs` (exits 0 on pass, 1 on fail).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assert,
  assertIncludes,
  stripAnsi,
  sleep,
  waitFor,
  Suite,
} from "./helpers/test_runner.mjs";
import { startMockOciRegistry } from "./helpers/mock_oci_registry.mjs";
import { REQUIRED_ARTIFACTS, startServer } from "./helpers/server_harness.mjs";
import { launchCdpBrowser } from "./helpers/cdp_browser.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function makeElfHeader({ elfClass = 2, data = 1, version = 1, eType = 2, eMachine = 62, len = 64 } = {}) {
  const b = new Uint8Array(len);
  b[0] = 0x7f;
  b[1] = 0x45;
  b[2] = 0x4c;
  b[3] = 0x46;
  if (len >= 64) {
    b[4] = elfClass;
    b[5] = data;
    b[6] = version;
    b[16] = eType & 0xff;
    b[17] = (eType >> 8) & 0xff;
    b[18] = eMachine & 0xff;
    b[19] = (eMachine >> 8) & 0xff;
  }
  return b;
}

export async function runTier5(opts = {}) {
  const sdk = await import(pathToFileURL(REQUIRED_ARTIFACTS.dockerSdk).href);
  const { Elf2WasmDocker, runDockerImage } = sdk;

  const registry = await startMockOciRegistry({ requireAuth: true, redirectBlobs: true });
  const hardenedServer = await startServer({ allowLocalRegistries: false });
  const localServer = await startServer({ allowLocalRegistries: true });

  const sdkOpts = {
    compilerWasmUrl: `${localServer.url}/wasm/elf2wasm_compiler_wasm.wasm`,
    runtimeWasmUrl: `${localServer.url}/wasm/elf2wasm_runtime_wasm.wasm`,
    registryProxyBase: `${localServer.url}/api/v2`,
    useWorker: false,
  };

  const docker = await Elf2WasmDocker.create(sdkOpts);
  let alpineImage = null;

  async function getAlpine() {
    if (!alpineImage) {
      alpineImage = await docker.pullImage(registry.imageRef("library/alpine", "latest"));
    }
    return alpineImage;
  }

  const suite = new Suite("Tier 5 (Adversarial Hardening)");

  // -------------------------------------------------------------------------
  // T5.1 (C1-Gap1 / R2-C1-Gap1): Truncated / 32-bit / ARM64 / bad-phdr ELFs return -ENOEXEC without crashing shell
  // -------------------------------------------------------------------------
  suite.add(
    "T5.1",
    "C1-Gap1: Truncated, 32-bit, ARM64, and bad-phdr ELF binaries return -ENOEXEC without crashing container",
    async () => {
      const img = await getAlpine();
      const payloads = [
        { name: "/tmp/trunc_elf", bytes: makeElfHeader({ len: 4 }) },
        { name: "/tmp/elf32", bytes: makeElfHeader({ elfClass: 1 }) },
        { name: "/tmp/arm64_elf", bytes: makeElfHeader({ eMachine: 183 }) },
        { name: "/tmp/bigend_elf", bytes: makeElfHeader({ data: 2 }) },
        { name: "/tmp/reloc_elf", bytes: makeElfHeader({ eType: 1 }) },
        { name: "/tmp/zero_phnum_elf", bytes: makeElfHeader({ len: 64 }) },
      ];

      const container = await img.createContainer({
        cmd: [
          "/bin/sh",
          "-c",
          payloads.map((p) => `${p.name} 2>/dev/null; echo "RC:${p.name}:$?"`).join("; ") +
            "; head -c 100 /bin/busybox > /tmp/trunc100 && chmod +x /tmp/trunc100 && /tmp/trunc100 2>/dev/null; echo SURVIVED_TRUNC100:$?" +
            "; echo SHELL_SURVIVED",
        ],
        tty: false,
      });
      for (const p of payloads) {
        await container.writeFile(p.name, p.bytes, 0o755);
      }
      await container.start();
      const res = await container.wait();
      assert.equal(res.exitCode, 0, `Shell must survive bad ELF execve, stderr=${res.stderr}`);
      assertIncludes(res.stdout, "SHELL_SURVIVED");
      assert.match(
        res.stdout,
        /SURVIVED_TRUNC100:(1|2|126|127)/,
        `Expected non-zero exec error for /tmp/trunc100, got:\n${res.stdout}`
      );
      for (const p of payloads) {
        assert.match(
          res.stdout,
          new RegExp(`RC:${p.name}:(126|127|2)`),
          `Expected non-zero exec error for ${p.name}, got:\n${res.stdout}`
        );
      }
      await container.stop();
    }
  );

  // -------------------------------------------------------------------------
  // T5.2 (C1-Gap2): Repeated foreground /bin/cat + SIGINT leaves activeProcesses === 1
  // -------------------------------------------------------------------------
  suite.add(
    "T5.2",
    "C1-Gap2: Repeated foreground /bin/cat + SIGINT reaps child WASM instances (activeProcesses === 1)",
    async () => {
      const img = await getAlpine();
      const container = await img.createContainer({
        cmd: ["/bin/sh"],
        tty: true,
        cols: 80,
        rows: 24,
      });
      let out = "";
      container.onStdout((c) => {
        out += new TextDecoder().decode(c);
      });
      container.onStderr((c) => {
        out += new TextDecoder().decode(c);
      });
      await container.start();

      // Wait for initial shell prompt using a computed value (cannot false-match TTY echo)
      container.writeStdin("echo $((100+23))\n");
      await waitFor(() => stripAnsi(out).includes("123"), {
        timeoutMs: 15000,
        label: "initial shell prompt",
      });

      for (let round = 1; round <= 3; round++) {
        container.writeStdin("/bin/cat\n");
        await waitFor(
          () => {
            const st = container._getStats();
            return st && st.activeProcesses >= 2;
          },
          { timeoutMs: 10000, intervalMs: 50, label: `round ${round} cat spawn` }
        );
        // Verify /bin/cat is actively reading stdin before sending SIGINT
        const ping = `CATPING_${round}`;
        container.writeStdin(`${ping}\n`);
        await waitFor(
          () => stripAnsi(out).includes(ping),
          { timeoutMs: 10000, intervalMs: 50, label: `round ${round} cat echo` }
        );

        container.sendSignal("SIGINT");
        const a = 400 + round;
        const b = 17;
        const expected = String(a + b);
        container.writeStdin(`echo $((${a}+${b}))\n`);
        await waitFor(() => stripAnsi(out).includes(expected), {
          timeoutMs: 10000,
          intervalMs: 50,
          label: `round ${round} shell recovery after SIGINT (${expected})`,
        });

        const st = container._getStats();
        assert.equal(
          st.activeProcesses,
          1,
          `Round ${round}: expected activeProcesses === 1 after SIGINT, got ${st.activeProcesses}`
        );
      }

      container.writeStdin("exit 0\n");
      const res = await container.wait();
      assert.equal(res.exitCode, 0);
      await container.stop();
    }
  );

  async function instantiateRawRuntime(guestMemPages = 3072) {
    const rtBytes = fs.readFileSync(REQUIRED_ARTIFACTS.runtimeWasm);
    const guestMem = new WebAssembly.Memory({ initial: guestMemPages, maximum: 4096 });
    const globals = new BigInt64Array(16);
    let inst = null;
    const res = await WebAssembly.instantiate(rtBytes, {
      env: {
        host_mem_size: () => guestMem.buffer.byteLength >>> 0,
        host_read_guest: (guestAddr, rtPtr, len) => {
          const g = new Uint8Array(guestMem.buffer, guestAddr >>> 0, len >>> 0);
          new Uint8Array(inst.exports.memory.buffer, rtPtr >>> 0, len >>> 0).set(g);
          return 0;
        },
        host_write_guest: (guestAddr, rtPtr, len) => {
          const r = new Uint8Array(inst.exports.memory.buffer, rtPtr >>> 0, len >>> 0);
          new Uint8Array(guestMem.buffer, guestAddr >>> 0, len >>> 0).set(r);
          return 0;
        },
        host_zero_guest: (guestAddr, len) => {
          new Uint8Array(guestMem.buffer, guestAddr >>> 0, len >>> 0).fill(0);
          return 0;
        },
        host_get_global: (id) => globals[id] || 0n,
        host_set_global: (id, val) => {
          globals[id] = BigInt(val);
        },
        host_save_ctx: () => {},
        host_load_ctx: () => {},
        host_vfs_is_ro_mount: () => 0,
        host_vfs_stat_ro: () => 0,
        host_vfs_read_ro: () => 0,
        host_vfs_list_dir_ro: () => 0,
        host_vfs_is_virtual_parent: () => 0,
      },
    });
    inst = res.instance;
    return { r: inst.exports, guestMem, globals };
  }

  // -------------------------------------------------------------------------
  // T5.3 (C1-Gap3): runtime_resume_active returns 0 for exited child after send_sigint
  // -------------------------------------------------------------------------
  suite.add(
    "T5.3",
    "C1-Gap3: runtime_resume_active does not re-enter exited child after SIGINT wakeup",
    async () => {
      const { r } = await instantiateRawRuntime(3072);
      r.runtime_new();
      r.runtime_set_tty_mode(1);

      // Parent forks child 1001
      const childPid = Number(r.runtime_handle_syscall(57n, 0n, 0n, 0n, 0n, 0n, 0n));
      assert.equal(childPid, 1001);
      assert.equal(r.runtime_on_yield(), 3); // NeedFork
      assert.equal(r.runtime_ack_fork(childPid), 0);
      assert.equal(r.runtime_resume_active(), 1);

      // Child blocks on read(0, 0x2000, 16) -> NeedStdin (5)
      r.runtime_handle_syscall(0n, 0n, 0x2000n, 16n, 0n, 0n, 0n);
      const y = r.runtime_on_yield();
      if (y === 2) {
        assert.equal(r.runtime_get_active_pid(), 1000);
        assert.equal(r.runtime_resume_active(), 1);
        r.runtime_handle_syscall(61n, -1n, 0x3000n, 0n, 0n, 0n, 0n);
        assert.equal(r.runtime_on_yield(), 5);
      } else {
        assert.equal(y, 5);
      }
      assert.equal(r.runtime_get_active_pid(), 1001);

      // SIGINT terminates foreground child 1001 while active_pid is 1001
      r.runtime_send_sigint();
      assert.equal(
        r.runtime_resume_active(),
        0,
        "runtime_resume_active MUST return 0 for exited child 1001"
      );
      assert.equal(r.runtime_on_yield(), 2, "runtime_on_yield must switch back to parent");
      assert.equal(r.runtime_get_active_pid(), 1000);
    }
  );

  // -------------------------------------------------------------------------
  // T5.4 (C1-Gap4): MAP_FIXED preserves gap & anonymous mmap zeroes full 4 KiB page tail
  // -------------------------------------------------------------------------
  suite.add(
    "T5.4",
    "C1-Gap4: MAP_FIXED preserves arena gap and anonymous mmap reuse zeroes full 4 KiB page tail",
    async () => {
      const { r, guestMem } = await instantiateRawRuntime(3072); // 192 MiB (> 0x0B000000)
      r.runtime_new();

      // 1. Anonymous mmap reuse must zero full 4096-byte page tail
      const p1 = Number(r.runtime_handle_syscall(9n, 0n, 4096n, 3n, 0x22n, -1n, 0n));
      assert.ok(p1 >= 0x08000000);
      new Uint8Array(guestMem.buffer, p1, 4096).fill(0xaa);
      assert.equal(Number(r.runtime_handle_syscall(11n, BigInt(p1), 4096n, 0n, 0n, 0n, 0n)), 0);

      const p2 = Number(r.runtime_handle_syscall(9n, 0n, 100n, 3n, 0x22n, -1n, 0n));
      assert.equal(p2, p1, "expected page reuse");
      const pageView = new Uint8Array(guestMem.buffer, p2, 4096);
      assert.equal(pageView[100], 0, "byte[100] must be zeroed");
      assert.equal(pageView[4095], 0, "byte[4095] must be zeroed");
      assert.equal(Number(r.runtime_handle_syscall(11n, BigInt(p2), 4096n, 0n, 0n, 0n, 0n)), 0);

      // 2. MAP_FIXED near top of arena must preserve gap below it
      const fixedAddr = 0x0afe0000n;
      const f = r.runtime_handle_syscall(9n, fixedAddr, 4096n, 3n, 0x32n, -1n, 0n);
      assert.equal(f, fixedAddr);
      const big = Number(r.runtime_handle_syscall(9n, 0n, BigInt(1024 * 1024), 3n, 0x22n, -1n, 0n));
      assert.ok(
        big >= 0x08000000 && big < Number(fixedAddr),
        `expected 1 MiB anonymous mmap in preserved gap, got ${big}`
      );
    }
  );

  // -------------------------------------------------------------------------
  // T5.5 (C2-Gap1): Hardened server blocks all newly covered IPv6 SSRF ranges with 403
  // -------------------------------------------------------------------------
  suite.add(
    "T5.5",
    "C2-Gap1: Hardened server returns 403 Forbidden for RFC 4291 / 6to4 / Teredo / NAT64 / site-local IPv6 SSRF",
    async () => {
      const hosts = [
        "[::127.0.0.1]",
        "[::7f00:1]",
        "[::10.0.0.1]",
        "[::169.254.169.254]",
        "[::ffff:0:127.0.0.1]",
        "[64:ff9b:1::7f00:1]",
        "[100::1]",
        "[2001:0::1]",
        "[2001:2::1]",
        "[2002:7f00:1::]",
        "[fec0::1]",
      ];
      for (const host of hosts) {
        const res = await fetch(
          `${hardenedServer.url}/api/v2/${host}/library/alpine/manifests/latest`
        );
        assert.equal(res.status, 403, `Expected 403 for ${host}, got ${res.status}`);
        const body = await res.json();
        assert.equal(typeof body.error, "string");
      }
    }
  );

  // -------------------------------------------------------------------------
  // T5.6 (C2-Gap2): Bearer auth 302 redirect success, SSRF-blocked redirect (403), and loop (502)
  // -------------------------------------------------------------------------
  suite.add(
    "T5.6",
    "C2-Gap2: Proxy follows Bearer auth 302 redirect and enforces SSRF & loop protection per hop",
    async () => {
      let mode = "ok";
      const mockAuthSrv = http.createServer((req, res) => {
        const u = new URL(req.url, "http://127.0.0.1");
        const { port } = mockAuthSrv.address();
        if (u.pathname.startsWith("/v2/")) {
          if (req.headers.authorization === "Bearer t5-redir-tok") {
            res.writeHead(200, { "Content-Type": "application/vnd.oci.image.manifest.v1+json" });
            res.end(JSON.stringify({ schemaVersion: 2, layers: [] }));
            return;
          }
          res.writeHead(401, {
            "WWW-Authenticate": `Bearer realm="http://127.0.0.1:${port}/auth-hop",service="t5",scope="repository:t5/${mode}:pull"`,
          });
          res.end();
          return;
        }
        if (u.pathname === "/auth-hop") {
          if (mode === "ok") {
            res.writeHead(302, { Location: `http://127.0.0.1:${port}/auth-token` });
          } else if (mode === "ssrf") {
            res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data" });
          } else {
            res.writeHead(302, { Location: `http://127.0.0.1:${port}/auth-hop` });
          }
          res.end();
          return;
        }
        if (u.pathname === "/auth-token") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ token: "t5-redir-tok", expires_in: 60 }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
      await new Promise((resolve) => mockAuthSrv.listen(0, "127.0.0.1", resolve));
      const { port } = mockAuthSrv.address();

      try {
        mode = "ok";
        const r1 = await fetch(`${localServer.url}/api/v2/127.0.0.1:${port}/t5/ok/manifests/latest`);
        assert.equal(r1.status, 200);

        mode = "ssrf";
        const r2 = await fetch(`${localServer.url}/api/v2/127.0.0.1:${port}/t5/ssrf/manifests/latest`);
        assert.equal(r2.status, 403);

        mode = "loop";
        const r3 = await fetch(`${localServer.url}/api/v2/127.0.0.1:${port}/t5/loop/manifests/latest`);
        assert.equal(r3.status, 502);
      } finally {
        await new Promise((resolve) => mockAuthSrv.close(resolve));
      }
    }
  );

  // -------------------------------------------------------------------------
  // T5.7 (C2-Gap3): Bounded LRU image cache, image.dispose(), and runDockerImage cleanup
  // -------------------------------------------------------------------------
  suite.add(
    "T5.7",
    "C2-Gap3: Bounded LRU image cache eviction, image.dispose(), and runDockerImage cleanup on reused docker",
    async () => {
      const bounded = await Elf2WasmDocker.create({ ...sdkOpts, maxCachedImages: 2 });
      try {
        const engine = bounded._backend.engine;
        const ref = registry.imageRef("library/alpine", "latest");
        const i1 = await bounded.pullImage(ref);
        const i2 = await bounded.pullImage(ref);
        const i3 = await bounded.pullImage(ref);
        assert.equal(engine.images.size, 2, "image cache must stay bounded at 2");
        await assert.rejects(() => i1.createContainer(), /Unknown imageId/);

        await i3.dispose();
        assert.equal(engine.images.size, 1);
        await i2.release();
        assert.equal(engine.images.size, 0);

        const res = await runDockerImage(ref, {
          docker: bounded,
          cmd: ["/bin/sh", "-c", "echo T57_CLEAN"],
        });
        assert.equal(res.exitCode, 0);
        assertIncludes(res.stdout, "T57_CLEAN");
        assert.equal(engine.images.size, 0, "runDockerImage must dispose image on reused docker");
        assert.equal(engine.containers.size, 0, "runDockerImage must stop/delete container on reused docker");
      } finally {
        await bounded.dispose();
      }
    }
  );

  // -------------------------------------------------------------------------
  // T5.8 + T5.9 + T5.10 (Browser CDP tests for C2-Gap4, C2-Gap5, C2-Gap6)
  // -------------------------------------------------------------------------
  suite.add(
    "T5.8",
    "C2-Gap4: WorkerBackend post-init crash rejects promptly and web UI recovers cleanly after natural exit",
    async () => {
      // Part A: SDK WorkerBackend post-init crash test (no hang)
      const origWorker = globalThis.Worker;
      let fakeWorkerInst = null;
      class FakeWorker {
        constructor() {
          this._listeners = new Map();
          fakeWorkerInst = this;
        }
        addEventListener(type, fn) {
          if (!this._listeners.has(type)) this._listeners.set(type, new Set());
          this._listeners.get(type).add(fn);
        }
        postMessage(msg) {
          if (msg.type === "init") {
            queueMicrotask(() => {
              for (const fn of this._listeners.get("message") || []) {
                fn({ data: { id: msg.id, ok: true, result: { ok: true } } });
              }
            });
          }
        }
        crash(message) {
          for (const fn of this._listeners.get("error") || []) {
            fn({ message });
          }
        }
        terminate() {}
      }
      globalThis.Worker = FakeWorker;
      let wd = null;
      try {
        wd = await Elf2WasmDocker.create({ ...sdkOpts, useWorker: true });
        assert.equal(wd.isAlive, true);
        let crashedFired = false;
        wd.onCrash(() => {
          crashedFired = true;
        });
        fakeWorkerInst.crash("Worker OOM crash");
        assert.equal(wd.isAlive, false);
        assert.equal(crashedFired, true);
        await assert.rejects(
          () =>
            Promise.race([
              wd.pullImage(registry.imageRef("library/alpine", "latest")),
              new Promise((_, reject) => setTimeout(() => reject(new Error("HUNG")), 400)),
            ]),
          /Worker OOM crash/
        );
      } finally {
        if (wd) await wd.dispose().catch(() => {});
        if (origWorker === undefined) delete globalThis.Worker;
        else globalThis.Worker = origWorker;
      }

      // Part B: Real Chrome web/app.mjs natural exit cleanup + restart
      const browser = await launchCdpBrowser();
      try {
        await browser.navigate(`${localServer.url}/`);
        await browser.setInputValue("#image-input", registry.imageRef("library/alpine", "latest"));
        await browser.setInputValue("#cmd-input", "/bin/sh -c 'echo NATURAL_EXIT_OK'");
        await browser.click("#start-btn");

        await waitFor(
          async () => {
            const status = await browser.getText("#status-text");
            const term = stripAnsi(await browser.getText("#terminal"));
            return status.includes("Exited (code 0)") && term.includes("NATURAL_EXIT_OK");
          },
          { timeoutMs: 60000, intervalMs: 250, label: "natural exit in web UI" }
        );

        // Starting a second command immediately after natural exit must succeed cleanly
        await browser.setInputValue("#cmd-input", "/bin/sh -c 'echo SECOND_RUN_OK'");
        await browser.click("#start-btn");
        await waitFor(
          async () => {
            const status = await browser.getText("#status-text");
            const term = stripAnsi(await browser.getText("#terminal"));
            return status.includes("Exited (code 0)") && term.includes("SECOND_RUN_OK");
          },
          { timeoutMs: 30000, intervalMs: 250, label: "second run after natural exit" }
        );
      } finally {
        await browser.close();
      }
    }
  );

  suite.add(
    "T5.9",
    "C2-Gap5: VT100Terminal clamps huge CSI count parameters without RangeError or freeze",
    async () => {
      const browser = await launchCdpBrowser();
      try {
        await browser.navigate(`${localServer.url}/`);
        const res = await browser.evaluate(`(async () => {
          const { VT100Terminal } = await import("/web/terminal.mjs");
          const host = document.createElement("div");
          host.style.width = "640px";
          host.style.height = "360px";
          document.body.appendChild(host);
          const term = new VT100Terminal(host, { cols: 80, rows: 24 });
          const t0 = performance.now();
          term.write("BEFORE\\r\\n");
          term.write("\\x1b[200000@");
          term.write("\\x1b[99999999L");
          term.write("\\x1b[99999999M");
          term.write("\\x1b[99999999P");
          term.write("\\x1b[99999999X");
          term.write("AFTER_HUGE_CSI\\r\\n");
          const elapsedMs = performance.now() - t0;
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          const text = host.textContent || "";
          host.remove();
          return { elapsedMs, hasAfter: text.includes("AFTER_HUGE_CSI") };
        })()`);
        assert.equal(res.hasAfter, true, "Terminal must continue rendering after huge CSI counts");
        assert.ok(res.elapsedMs < 2000, `Huge CSI sequences took too long: ${res.elapsedMs}ms`);
      } finally {
        await browser.close();
      }
    }
  );

  suite.add(
    "T5.10",
    "C2-Gap6: Manual tarball upload sanitizes uppercase/space/punctuated filenames to valid OCI repo names",
    async () => {
      const tarRes = await fetch(
        `${localServer.url}/api/v2/${registry.host}/library/alpine/blobs/${
          (await getAlpine()).layers[0].digest
        }`
      );
      assert.equal(tarRes.status, 200);
      const tarBuf = Buffer.from(await tarRes.arrayBuffer());
      const tarB64 = tarBuf.toString("base64");

      const browser = await launchCdpBrowser();
      try {
        await browser.navigate(`${localServer.url}/`);

        // Open manual drawer, stage a tarball with uppercase/spaces/parentheses/underscores, and click Run
        await browser.evaluate(`(() => {
          const drawer = document.getElementById("manual-upload-drawer");
          if (drawer) drawer.open = true;
          const cmd = document.getElementById("manual-cmd-input");
          if (cmd) cmd.value = "/bin/sh -c 'echo TARBALL_UPLOAD_OK'";
          const b64 = ${JSON.stringify(tarB64)};
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const file = new File([bytes], "Alpine-3.20 (Test)_.tar.gz", { type: "application/gzip" });
          const dt = new DataTransfer();
          dt.items.add(file);
          const input = document.getElementById("manual-file-input");
          input.files = dt.files;
          input.dispatchEvent(new Event("change", { bubbles: true }));
        })()`);

        await waitFor(
          async () => (await browser.getText("#manual-vfs-summary")).includes("Alpine-3.20"),
          { timeoutMs: 10000, intervalMs: 100, label: "staged tarball summary" }
        );
        await browser.click("#manual-run-btn");

        await waitFor(
          async () => {
            const term = stripAnsi(await browser.getText("#terminal"));
            const status = await browser.getText("#status-text");
            return term.includes("TARBALL_UPLOAD_OK") && status.includes("Exited (code 0)");
          },
          { timeoutMs: 60000, intervalMs: 250, label: "tarball upload execution" }
        );
      } finally {
        await browser.close();
      }
    }
  );

  // -------------------------------------------------------------------------
  // T5.11 (R2-C2-Gap1): stopContainer() during startContainer() precompileFromVfs() prevents zombie boot
  // -------------------------------------------------------------------------
  suite.add(
    "T5.11",
    "R2-C2-Gap1: stopContainer() during precompileFromVfs() prevents unstoppable zombie container boot",
    async () => {
      const img = await getAlpine();
      const engine = docker._backend.engine;
      assert.ok(engine, "DirectBackend engine must be available");

      const stdoutChunks = [];
      const exitCodes = [];
      const { containerId } = await engine.createContainer(
        img._imageId,
        {
          cmd: ["/usr/local/bin/docker-entrypoint.sh", "/bin/sh", "-c", "echo ZOMBIE_BOOTED; /bin/cat"],
          tty: false,
        },
        {
          onStdout: (c) => stdoutChunks.push(new TextDecoder().decode(c)),
          onExit: (code) => exitCodes.push(code),
        }
      );
      engine.writeFile(
        containerId,
        "/usr/local/bin/docker-entrypoint.sh",
        "#!/bin/sh\nexec \"$@\"\n",
        0o755
      );

      const rec = engine.containers.get(containerId);
      assert.ok(rec, "Container record should exist before start");

      let precompileEntered;
      const precompileEnteredPromise = new Promise((r) => {
        precompileEntered = r;
      });
      let releasePrecompile;
      const precompileGate = new Promise((r) => {
        releasePrecompile = r;
      });

      const origPrecompile = rec.sys.precompileFromVfs.bind(rec.sys);
      rec.sys.precompileFromVfs = async (...args) => {
        precompileEntered();
        await precompileGate;
        return await origPrecompile(...args);
      };

      const startPromise = engine.startContainer(containerId);
      await precompileEnteredPromise;

      await engine.stopContainer(containerId);
      assert.equal(engine.containers.has(containerId), false);
      assert.deepEqual(exitCodes, [137]);

      releasePrecompile();
      await startPromise;
      await sleep(50);

      assert.equal(stdoutChunks.join(""), "", "Stopped container must emit zero stdout");
      assert.equal(rec.sys.getActiveProcessCount(), 0, "Stopped container must have 0 active processes");
      assert.deepEqual(exitCodes, [137], "onExit must fire exactly once with 137");
    }
  );

  // -------------------------------------------------------------------------
  // T5.12 (R2-C2-Gap2): _compileCached() drops bloated/failed compilerInst on error and re-instantiates
  // -------------------------------------------------------------------------
  suite.add(
    "T5.12",
    "R2-C2-Gap2: _compileCached() drops bloated/failed compilerInst on compile error and re-instantiates cleanly",
    async () => {
      const shim = await import(pathToFileURL(path.join(REPO_ROOT, "js", "elf2wasm_shim.mjs")).href);
      const { Elf2WasmSystem } = shim;

      const img = await getAlpine();
      const probe = await img.createContainer({ cmd: ["/bin/sh", "-c", "true"], tty: false });
      const busyboxBytes = await probe.readFile("/bin/busybox");
      const muslBytes = await probe.readFile("/lib/ld-musl-x86_64.so.1");
      await probe.stop();
      assert.ok(busyboxBytes && busyboxBytes.length > 0, "Expected /bin/busybox bytes from alpine");
      assert.ok(muslBytes && muslBytes.length > 0, "Expected /lib/ld-musl-x86_64.so.1 from alpine");

      const compilerMod = await WebAssembly.compile(fs.readFileSync(REQUIRED_ARTIFACTS.compilerWasm));
      const compilerInst = await WebAssembly.instantiate(compilerMod, {});
      const changes = [];
      const sys = await Elf2WasmSystem.create({
        compilerInst,
        compilerMod,
        onCompilerInstChange: (inst) => changes.push(inst === null ? "null" : "inst"),
        runtimeWasm: fs.readFileSync(REQUIRED_ARTIFACTS.runtimeWasm),
      });

      const mem = sys.compilerInst.exports.memory;
      const curPages = mem.buffer.byteLength >>> 16;
      if (curPages < 2050) {
        mem.grow(2050 - curPages);
      }
      assert.ok(mem.buffer.byteLength > 128 * 1024 * 1024);

      let threw = false;
      try {
        await sys._compileCached(makeElfHeader({ len: 8 }), [], "/corrupt_t5");
      } catch {
        threw = true;
      }
      assert.equal(threw, true, "Corrupt ELF compilation must throw");
      assert.equal(sys.compilerInst, null, "Bloated/failed compilerInst must be dropped on error");
      assert.deepEqual(changes, ["null"]);

      const compiled = await sys._compileCached(
        busyboxBytes,
        [{ path: "/lib/ld-musl-x86_64.so.1", name: "ld-musl-x86_64.so.1", bytes: muslBytes }],
        "/bin/busybox"
      );
      assert.ok(compiled.mod instanceof WebAssembly.Module);
      assert.ok(sys.compilerInst !== null, "compilerInst must re-instantiate cleanly on next compile");
      assert.deepEqual(changes, ["null", "inst"]);
    }
  );

  // -------------------------------------------------------------------------
  // T5.13 (R2-C2-Gap3): web/app.mjs disposes DockerImage on cancel right after pullImage & recovers from error via preset chip
  // -------------------------------------------------------------------------
  suite.add(
    "T5.13",
    "R2-C2-Gap3: web/app.mjs disposes DockerImage on cancel after pullImage and recovers from error state via preset chip",
    async () => {
      const browser = await launchCdpBrowser();
      try {
        await browser.navigate(`${localServer.url}/`);

        // Part A: Intercept pullImage to click Stop right as pullImage resolves (line 410 cancel path)
        await browser.evaluate(`(async () => {
          const { Elf2WasmDocker } = await import("/js/docker_sdk.mjs");
          window.__t5_state = { docker: null, pullResolved: false, origPull: Elf2WasmDocker.prototype.pullImage };
          const origCreate = Elf2WasmDocker.create;
          Elf2WasmDocker.create = async (opts) => {
            const d = await origCreate.call(Elf2WasmDocker, { ...opts, useWorker: false });
            window.__t5_state.docker = d;
            return d;
          };
          Elf2WasmDocker.prototype.pullImage = async function (...args) {
            const img = await window.__t5_state.origPull.apply(this, args);
            document.getElementById("stop-btn").click();
            window.__t5_state.pullResolved = true;
            return img;
          };
        })()`);

        await browser.setInputValue("#image-input", registry.imageRef("library/alpine", "latest"));
        await browser.click("#start-btn");

        await waitFor(
          async () =>
            Boolean(await browser.evaluate(`Boolean(window.__t5_state && window.__t5_state.pullResolved)`)),
          { timeoutMs: 30000, intervalMs: 100, label: "pullImage resolve before stop" }
        );

        await waitFor(
          async () =>
            (await browser.evaluate(
              `window.__t5_state.docker ? window.__t5_state.docker._backend.engine.images.size : -1`
            )) === 0,
          { timeoutMs: 5000, intervalMs: 50, label: "engine.images disposal after cancel" }
        );

        const leakedImages = await browser.evaluate(
          `window.__t5_state.docker._backend.engine.images.size`
        );
        assert.equal(leakedImages, 0, `Expected 0 leaked images in engine.images, got ${leakedImages}`);

        // Restore pullImage for Part B
        await browser.evaluate(`(async () => {
          const { Elf2WasmDocker } = await import("/js/docker_sdk.mjs");
          Elf2WasmDocker.prototype.pullImage = window.__t5_state.origPull;
        })()`);

        // Part B: Trigger error state, recover via preset chip click, then run valid local image
        await browser.setInputValue("#image-input", "INVALID_UPPER/repo");
        await browser.click("#start-btn");
        await waitFor(
          async () =>
            (await browser.evaluate(`document.getElementById("status-pill")?.dataset?.state`)) ===
            "error",
          { timeoutMs: 10000, intervalMs: 100, label: "error state on invalid image ref" }
        );

        // Click a preset chip and verify it updates #image-input
        await browser.click('.preset-chip[data-image="python:3.12-slim"]');
        const chipVal = await browser.evaluate(`document.getElementById("image-input").value`);
        assert.equal(chipVal, "python:3.12-slim", "Preset chip click must populate #image-input");

        // Now run valid local alpine image and verify clean recovery from error state
        await browser.setInputValue("#image-input", registry.imageRef("library/alpine", "latest"));
        await browser.setInputValue("#cmd-input", "/bin/sh -c 'echo ERROR_RECOVERED_OK'");
        await browser.click("#start-btn");

        await waitFor(
          async () => {
            const state = await browser.evaluate(
              `document.getElementById("status-pill")?.dataset?.state`
            );
            const status = await browser.getText("#status-text");
            const term = stripAnsi(await browser.getText("#terminal"));
            return (
              state === "idle" &&
              status.includes("Exited (code 0)") &&
              term.includes("ERROR_RECOVERED_OK")
            );
          },
          { timeoutMs: 60000, intervalMs: 250, label: "recovery from error state" }
        );
      } finally {
        await browser.close();
      }
    }
  );

  // -------------------------------------------------------------------------
  // T5.14 (R2-C2-Gap4): MessageChannel yield fallback & clean Node.js process exit
  // -------------------------------------------------------------------------
  suite.add(
    "T5.14",
    "R2-C2-Gap4: MessageChannel yield exits cleanly in Node.js and falls back to setTimeout(0) when unavailable",
    async () => {
      const img = await getAlpine();
      const probe = await img.createContainer({ cmd: ["/bin/sh", "-c", "true"], tty: false });
      const busyboxBytes = await probe.readFile("/bin/busybox");
      const muslBytes = await probe.readFile("/lib/ld-musl-x86_64.so.1");
      await probe.stop();

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "elf2wasm-t5-mc-"));
      const elfFile = path.join(tmpDir, "busybox");
      const muslFile = path.join(tmpDir, "ld-musl-x86_64.so.1");
      fs.writeFileSync(elfFile, busyboxBytes);
      fs.writeFileSync(muslFile, muslBytes);

      try {
        const runChild = (disableMessageChannel) => {
          const script = `
            ${disableMessageChannel ? "globalThis.MessageChannel = undefined;" : ""}
            import fs from "node:fs";
            import { Elf2WasmSystem } from "./js/elf2wasm_shim.mjs";
            const elf = fs.readFileSync(${JSON.stringify(elfFile)});
            const musl = fs.readFileSync(${JSON.stringify(muslFile)});
            const sys = await Elf2WasmSystem.create({
              compilerWasm: fs.readFileSync(${JSON.stringify(REQUIRED_ARTIFACTS.compilerWasm)}),
              runtimeWasm: fs.readFileSync(${JSON.stringify(REQUIRED_ARTIFACTS.runtimeWasm)}),
            });
            const res = await sys.runElf(
              elf,
              [{ path: "/lib/ld-musl-x86_64.so.1", name: "ld-musl-x86_64.so.1", bytes: musl }],
              ["echo", "YIELD_E2E_OK"],
              {
                elfPath: "/bin/busybox",
                preserveArgv0: true,
                yieldEvery: 1,
              }
            );
            const out = new TextDecoder().decode(res.stdout).trim();
            if (res.exitCode !== 0 || out !== "YIELD_E2E_OK") {
              console.error("Unexpected result:", res.exitCode, out);
              process.exit(2);
            }
            console.log("CHILD_OK:" + out);
            // Do NOT call process.exit() — verify unref'd MessagePorts allow natural exit
          `;
          return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
            cwd: REPO_ROOT,
            encoding: "utf8",
            timeout: 30000,
          });
        };

        const withMc = runChild(false);
        assert.equal(withMc.status, 0, `MessageChannel child failed: ${withMc.stderr}`);
        assertIncludes(withMc.stdout, "CHILD_OK:YIELD_E2E_OK");

        const withoutMc = runChild(true);
        assert.equal(withoutMc.status, 0, `Fallback setTimeout(0) child failed: ${withoutMc.stderr}`);
        assertIncludes(withoutMc.stdout, "CHILD_OK:YIELD_E2E_OK");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  );

  try {
    return await suite.run(opts);
  } finally {
    await docker.dispose();
    await localServer.close();
    await hardenedServer.close();
    await registry.close();
  }
}

// Standalone CLI execution
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const verbose = process.argv.includes("--verbose") || process.argv.includes("-v");
  const summary = await runTier5({ verbose });
  console.log(
    `\nTier 5 Summary: ${summary.passed}/${summary.total} passed, ${summary.failed} failed, ${summary.skipped} skipped (${(summary.durationMs / 1000).toFixed(1)}s)`
  );
  process.exit(summary.failed > 0 ? 1 : 0);
}
