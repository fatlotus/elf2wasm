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
  Suite,
} from "./helpers/test_runner.mjs";
import { startMockOciRegistry } from "./helpers/mock_oci_registry.mjs";
import { REQUIRED_ARTIFACTS, startServer } from "./helpers/server_harness.mjs";

export async function runTier3(opts = {}) {
  const sdk = await import(pathToFileURL(REQUIRED_ARTIFACTS.dockerSdk).href);
  const { Elf2WasmDocker } = sdk;

  let registry = null;
  let server = null;

  try {
    registry = await startMockOciRegistry({ requireAuth: true, redirectBlobs: true });
    server = await startServer({ allowLocalRegistries: true });

    const sdkOpts = {
      compilerWasmUrl: `${server.url}/wasm/elf2wasm_compiler_wasm.wasm`,
      runtimeWasmUrl: `${server.url}/wasm/elf2wasm_runtime_wasm.wasm`,
      registryProxyBase: `${server.url}/api/v2`,
      useWorker: false,
    };

    const docker = await Elf2WasmDocker.create(sdkOpts);
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

    return await suite.run(opts);
  } finally {
    if (server) await server.close();
    if (registry) await registry.close();
  }
}
