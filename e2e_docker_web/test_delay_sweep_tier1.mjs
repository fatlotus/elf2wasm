// Tier 1: Opaque-Box Feature Coverage for F41
// (Deterministic Delay Injection & Simulated Time, Build vs Run Split,
//  Sweep Mode, and URL Linking for Sweep & Specific Runs).
// 26 tests total (6-7 per requirement area).

import fs from "node:fs";
import {
  Suite,
  assert,
  assertIncludes,
  assertNotIncludes,
  waitWithTimeout,
} from "./helpers/test_runner.mjs";
import { startServer } from "./helpers/server_harness.mjs";
import { startMockOciRegistry } from "./helpers/mock_oci_registry.mjs";
import { launchCdpBrowser } from "./helpers/cdp_browser.mjs";
import {
  JS_CLI_PATH,
  NATIVE_CLI_BIN,
  ensureDelaySweepProbe,
  registerDelaySweepOciImage,
  importDockerSdk,
  importUrlState,
  createSdkClient,
  parseProbeMetric,
  parseProbeBigInt,
  runProcess,
  readDelaySweepDomState,
} from "./delay_sweep_helpers.mjs";

export const TIER1_TEST_COUNT = 26;

export async function runDelaySweepTier1(opts = {}) {
  const suite = new Suite("Tier 1: Delay/Sweep Feature Coverage");

  let registry = null;
  let server = null;
  let browser = null;
  let imageRef = null;
  let docker = null;
  let pulledImage = null;
  let sdk = null;
  let probePath = null;

  async function ensureEnv() {
    if (server && registry && docker && pulledImage) return;
    probePath = ensureDelaySweepProbe();
    registry = await startMockOciRegistry();
    imageRef = registerDelaySweepOciImage(registry);
    server = await startServer({ allowLocalRegistries: true });
    sdk = await importDockerSdk();
    docker = await createSdkClient(server.url);
    pulledImage = await waitWithTimeout(docker.pullImage(imageRef), 90000, "pull mock probe image");
  }

  async function ensureBrowser() {
    await ensureEnv();
    if (!browser) {
      browser = await launchCdpBrowser();
    }
    return browser;
  }

  function sweepOpts(extra) {
    return {
      registryProxyBase: `${server.url}/api/v2`,
      gitProxyBase: `${server.url}/api/git/archive`,
      compilerWasmUrl: `${server.url}/wasm/elf2wasm_compiler_wasm.wasm`,
      runtimeWasmUrl: `${server.url}/wasm/elf2wasm_runtime_wasm.wasm`,
      useWorker: false,
      ...extra,
    };
  }

  // =========================================================================
  // Area 1: Deterministic Delay Injection (stddev + seed) & Simulated Time
  // =========================================================================

  suite.add("DS-T1.1.1", "Same (stddev, seed) yields bit-for-bit identical output via runDockerImage", async () => {
    await ensureEnv();
    const runOpts = sweepOpts({
      cmd: ["/usr/local/bin/tcp_delay_probe", "--mode=timing", "--iters=6"],
      delayStddevMs: 5,
      delaySeed: 42,
    });
    const r1 = await waitWithTimeout(sdk.runDockerImage(imageRef, runOpts), 90000, "runDockerImage #1");
    const r2 = await waitWithTimeout(sdk.runDockerImage(imageRef, runOpts), 90000, "runDockerImage #2");

    assert.equal(r1.exitCode, 0, `run #1 failed: ${r1.stderr}`);
    assert.equal(r2.exitCode, 0, `run #2 failed: ${r2.stderr}`);
    assert.equal(r1.stdout, r2.stdout, "Identical (stddev, seed) must produce identical stdout");
    assert.equal(r1.stderr, r2.stderr, "Identical (stddev, seed) must produce identical stderr");
    assert.ok(parseProbeBigInt(r1.stdout, "ELAPSED_NS") > 0n, "Expected positive simulated elapsed ns");
    assert.equal(
      parseProbeMetric(r1.stdout, "RAND_HEX"),
      parseProbeMetric(r2.stdout, "RAND_HEX"),
      "Seeded /dev/urandom RAND_HEX must match identically"
    );
    if (r1.virtualTimeNs !== undefined && r2.virtualTimeNs !== undefined) {
      assert.equal(r1.virtualTimeNs, r2.virtualTimeNs, "virtualTimeNs must match identically");
    }
  });

  suite.add("DS-T1.1.2", "Same (stddev, seed) yields identical output across container.exec + snapshot restore", async () => {
    await ensureEnv();
    const container = await pulledImage.createContainer({ tty: false });
    try {
      const snapId = await container.snapshotVfs();
      const execOpts = {
        cmd: ["/usr/local/bin/tcp_delay_probe", "--mode=reorder", "--conns=6"],
        delayStddevMs: 4,
        delaySeed: 1337,
      };
      const r1 = await waitWithTimeout(container.exec(execOpts), 60000, "exec #1");
      await container.restoreVfs(snapId);
      const r2 = await waitWithTimeout(container.exec(execOpts), 60000, "exec #2");

      assert.equal(r1.exitCode, 0, `exec #1 failed: ${r1.stderr}`);
      assert.equal(r2.exitCode, 0, `exec #2 failed: ${r2.stderr}`);
      assert.equal(r1.stdout, r2.stdout, "container.exec stdout must be deterministic");
      assert.equal(r1.stderr, r2.stderr, "container.exec stderr must be deterministic");
      assert.equal(r1.virtualTimeNs, r2.virtualTimeNs, "container.exec virtualTimeNs must match");
      assert.ok(r1.virtualTimeNs > 0, "Expected positive virtualTimeNs");
      await container.dropVfsSnapshot(snapId);
    } finally {
      await container.stop();
    }
  });

  suite.add("DS-T1.1.3", "Different seeds at same stddev > 0 produce observable timing & PRNG perturbation", async () => {
    await ensureEnv();
    const container = await pulledImage.createContainer({ tty: false });
    try {
      const snapId = await container.snapshotVfs();
      const elapsedSet = new Set();
      const randSet = new Set();

      for (const seed of [1, 2, 3, 4, 5]) {
        await container.restoreVfs(snapId);
        const r = await waitWithTimeout(
          container.exec({
            cmd: ["/usr/local/bin/tcp_delay_probe", "--mode=timing", "--iters=8"],
            delayStddevMs: 5,
            delaySeed: seed,
          }),
          60000,
          `exec seed=${seed}`
        );
        assert.equal(r.exitCode, 0, `seed=${seed} failed: ${r.stderr}`);
        elapsedSet.add(parseProbeBigInt(r.stdout, "ELAPSED_NS").toString());
        randSet.add(parseProbeMetric(r.stdout, "RAND_HEX"));
      }

      assert.ok(elapsedSet.size >= 2, `Expected >=2 distinct ELAPSED_NS across 5 seeds, got ${elapsedSet.size}`);
      assert.ok(randSet.size >= 2, `Expected >=2 distinct RAND_HEX across 5 seeds, got ${randSet.size}`);
      await container.dropVfsSnapshot(snapId);
    } finally {
      await container.stop();
    }
  });

  suite.add("DS-T1.1.4", "Increasing stddev at fixed seed scales simulated virtual delay", async () => {
    await ensureEnv();
    const container = await pulledImage.createContainer({ tty: false });
    try {
      const snapId = await container.snapshotVfs();
      const results = [];
      for (const stddevMs of [0, 2, 20]) {
        await container.restoreVfs(snapId);
        const r = await waitWithTimeout(
          container.exec({
            cmd: ["/usr/local/bin/tcp_delay_probe", "--mode=timing", "--iters=8"],
            delayStddevMs: stddevMs,
            delaySeed: 7,
          }),
          60000,
          `exec stddev=${stddevMs}`
        );
        assert.equal(r.exitCode, 0, `stddev=${stddevMs} failed: ${r.stderr}`);
        results.push({
          stddevMs,
          elapsedNs: parseProbeBigInt(r.stdout, "ELAPSED_NS"),
          virtualTimeNs: r.virtualTimeNs,
        });
      }

      assert.ok(
        results[1].elapsedNs > results[0].elapsedNs,
        `Expected elapsed(2ms)=${results[1].elapsedNs} > elapsed(0ms)=${results[0].elapsedNs}`
      );
      assert.ok(
        results[2].elapsedNs > results[1].elapsedNs,
        `Expected elapsed(20ms)=${results[2].elapsedNs} > elapsed(2ms)=${results[1].elapsedNs}`
      );
      await container.dropVfsSnapshot(snapId);
    } finally {
      await container.stop();
    }
  });

  suite.add("DS-T1.1.5", "Large simulated delay (stddev=5000ms) completes without real-time waiting", async () => {
    await ensureEnv();
    const container = await pulledImage.createContainer({ tty: false });
    try {
      // Warm compile once at stddev=0 so wall-clock measurement isolates execution.
      const warm = await waitWithTimeout(
        container.exec({
          cmd: ["/usr/local/bin/tcp_delay_probe", "--mode=timing", "--iters=2"],
          delayStddevMs: 0,
          delaySeed: 1,
        }),
        90000,
        "warm compile"
      );
      assert.equal(warm.exitCode, 0);

      const t0 = performance.now();
      const r = await waitWithTimeout(
        container.exec({
          cmd: ["/usr/local/bin/tcp_delay_probe", "--mode=timing", "--iters=6"],
          delayStddevMs: 5000,
          delaySeed: 99,
        }),
        30000,
        "simulated 5000ms delay"
      );
      const wallMs = performance.now() - t0;

      assert.equal(r.exitCode, 0, `5000ms run failed: ${r.stderr}`);
      const elapsedNs = parseProbeBigInt(r.stdout, "ELAPSED_NS");
      assert.ok(
        elapsedNs >= 1_000_000_000n,
        `Expected >= 1s simulated time, got ELAPSED_NS=${elapsedNs}`
      );
      assert.ok(
        r.virtualTimeNs >= 1_000_000_000,
        `Expected virtualTimeNs >= 1e9, got ${r.virtualTimeNs}`
      );
      assert.ok(
        wallMs < 5000,
        `Simulated 5000ms/packet delay must not sleep in real time (took ${wallMs.toFixed(0)}ms wall-clock)`
      );
    } finally {
      await container.stop();
    }
  });

  suite.add("DS-T1.1.6", "stddev=0 preserves deterministic low-latency baseline behavior", async () => {
    await ensureEnv();
    const container = await pulledImage.createContainer({ tty: false });
    try {
      const rZero = await waitWithTimeout(
        container.exec({
          cmd: ["/usr/local/bin/tcp_delay_probe", "--mode=timing", "--iters=6"],
          delayStddevMs: 0,
          delaySeed: 0,
        }),
        60000,
        "stddev=0 seed=0"
      );
      const rDefault = await waitWithTimeout(
        container.exec({
          cmd: ["/usr/local/bin/tcp_delay_probe", "--mode=timing", "--iters=6"],
        }),
        60000,
        "omitted delay opts"
      );

      assert.equal(rZero.exitCode, 0);
      assert.equal(rDefault.exitCode, 0);
      assert.equal(rZero.stdout, rDefault.stdout, "stddev=0/seed=0 must match omitted defaults");
      assert.ok(
        parseProbeBigInt(rZero.stdout, "ELAPSED_NS") < 50_000_000n,
        `Expected near-zero simulated elapsed at stddev=0, got ${rZero.stdout}`
      );
    } finally {
      await container.stop();
    }
  });

  suite.add("DS-T1.1.7", "CLI (js/cli.mjs and native CLI if present) honors --delay-stddev-ms & --delay-seed", async () => {
    await ensureEnv();
    const args42 = [
      JS_CLI_PATH,
      "run",
      "--elf",
      probePath,
      "--delay-stddev-ms",
      "5000",
      "--delay-seed",
      "42",
      "--",
      "--mode=timing",
      "--iters=6",
    ];
    const args43 = [
      JS_CLI_PATH,
      "run",
      "--elf",
      probePath,
      "--delay-stddev-ms",
      "5000",
      "--delay-seed",
      "43",
      "--",
      "--mode=timing",
      "--iters=6",
    ];

    const c1 = await runProcess(process.execPath, args42, { timeoutMs: 90000 });
    const c2 = await runProcess(process.execPath, args42, { timeoutMs: 90000 });
    const c3 = await runProcess(process.execPath, args43, { timeoutMs: 90000 });

    assert.equal(c1.exitCode, 0, `js/cli.mjs run #1 failed: ${c1.stderr}`);
    assert.equal(c2.exitCode, 0, `js/cli.mjs run #2 failed: ${c2.stderr}`);
    assert.equal(c3.exitCode, 0, `js/cli.mjs run #3 failed: ${c3.stderr}`);
    assert.equal(c1.stdout, c2.stdout, "CLI same (stddev, seed) must produce identical stdout");
    assert.ok(parseProbeBigInt(c1.stdout, "ELAPSED_NS") >= 1_000_000_000n, "CLI must inject simulated delay");
    assert.notEqual(
      parseProbeBigInt(c1.stdout, "ELAPSED_NS"),
      parseProbeBigInt(c3.stdout, "ELAPSED_NS"),
      "CLI different seeds must perturb ELAPSED_NS"
    );

    if (fs.existsSync(NATIVE_CLI_BIN)) {
      const probeWasmPath = `${probePath}.wasm`;
      const tr = await runProcess(
        NATIVE_CLI_BIN,
        ["translate", probePath, "-o", probeWasmPath],
        { timeoutMs: 90000 }
      );
      assert.equal(tr.exitCode, 0, `native CLI translate failed: ${tr.stderr}`);
      const n1 = await runProcess(
        NATIVE_CLI_BIN,
        ["run", probeWasmPath, "--delay-stddev-ms", "5000", "--delay-seed", "42", "--", "--mode=timing", "--iters=6"],
        { timeoutMs: 90000 }
      );
      const n2 = await runProcess(
        NATIVE_CLI_BIN,
        ["run", probeWasmPath, "--delay-stddev-ms", "5000", "--delay-seed", "42", "--", "--mode=timing", "--iters=6"],
        { timeoutMs: 90000 }
      );
      assert.equal(n1.exitCode, 0, `native CLI failed: ${n1.stderr}`);
      assert.equal(n1.stdout, n2.stdout, "Native CLI must be deterministic");
      assert.ok(parseProbeBigInt(n1.stdout, "ELAPSED_NS") >= 1_000_000_000n);
    }
  });

  // =========================================================================
  // Area 2: Build vs Run Command Split
  // =========================================================================

  suite.add("DS-T1.2.1", "Build runs ONCE before sweep; sweep runs ONLY runCmd", async () => {
    await ensureEnv();
    const res = await waitWithTimeout(
      sdk.runSweep(
        imageRef,
        sweepOpts({
          buildCmd: [
            "/bin/sh",
            "-c",
            "echo BUILD_MARKER >> /tmp/build_log && printf '#!/bin/sh\\necho RUN_OK\\n' > /workspace/run_me && chmod +x /workspace/run_me",
          ],
          runCmd: ["/bin/sh", "-c", "printf 'LINES=%s\\n' \"$(wc -l < /tmp/build_log | tr -d ' ')\" && /workspace/run_me"],
          runs: 4,
          stddevStart: 0,
          stddevStep: 1,
          seedStart: 1,
        })
      ),
      90000,
      "runSweep build-once"
    );

    assert.equal(res.passed, true);
    assert.equal(res.build.skipped, false);
    assert.equal(res.build.exitCode, 0);
    assert.equal(res.runs.length, 4);
    for (const run of res.runs) {
      assert.equal(run.exitCode, 0);
      assertIncludes(run.stdout, "LINES=1", "Build log must have exactly 1 line in every sweep run");
      assertIncludes(run.stdout, "RUN_OK");
    }
  });

  suite.add("DS-T1.2.2", "Post-build VFS snapshot preserves built binaries and config files for runCmd", async () => {
    await ensureEnv();
    const res = await waitWithTimeout(
      sdk.runSweep(
        imageRef,
        sweepOpts({
          buildCmd: [
            "/bin/sh",
            "-c",
            "cp /usr/local/bin/tcp_delay_probe /workspace/app_bin && chmod +x /workspace/app_bin && echo BUILD_TOKEN=abc123 > /workspace/config.txt",
          ],
          runCmd: ["/bin/sh", "-c", "cat /workspace/config.txt && /workspace/app_bin --mode=timing --iters=2"],
          runs: 2,
          stddevStart: 0,
          stddevStep: 1,
          seedStart: 1,
        })
      ),
      90000,
      "runSweep build artifacts"
    );

    assert.equal(res.passed, true);
    assert.equal(res.runs.length, 2);
    for (const run of res.runs) {
      assert.equal(run.exitCode, 0);
      assertIncludes(run.stdout, "BUILD_TOKEN=abc123");
      assertIncludes(run.stdout, "ELAPSED_NS=");
    }
  });

  suite.add("DS-T1.2.3", "Clean VFS snapshot isolation prevents mutations leaking between sweep runs", async () => {
    await ensureEnv();
    const res = await waitWithTimeout(
      sdk.runSweep(
        imageRef,
        sweepOpts({
          buildCmd: ["/bin/sh", "-c", "echo INIT > /workspace/state.txt"],
          runCmd: [
            "/bin/sh",
            "-c",
            "cat /workspace/state.txt; if [ -f /workspace/dirty.flag ]; then echo LEAKED; exit 1; fi; echo MUTATED >> /workspace/state.txt; touch /workspace/dirty.flag",
          ],
          runs: 5,
          stddevStart: 0,
          stddevStep: 1,
          seedStart: 1,
        })
      ),
      90000,
      "runSweep snapshot isolation"
    );

    assert.equal(res.passed, true);
    assert.equal(res.runs.length, 5);
    for (const run of res.runs) {
      assert.equal(run.exitCode, 0);
      assert.equal(run.stdout.trim(), "INIT");
      assertNotIncludes(run.stdout, "MUTATED");
      assertNotIncludes(run.stdout, "LEAKED");
    }
  });

  suite.add("DS-T1.2.4", "Failed build (non-zero exit) aborts cleanly before any sweep run starts", async () => {
    await ensureEnv();
    let runStartCalls = 0;
    const res = await waitWithTimeout(
      sdk.runSweep(
        imageRef,
        sweepOpts({
          buildCmd: ["/bin/sh", "-c", "echo BUILD_ERR >&2; exit 42"],
          runCmd: ["/bin/sh", "-c", "echo SHOULD_NOT_RUN"],
          runs: 5,
          onRunStart: () => {
            runStartCalls += 1;
          },
        })
      ),
      60000,
      "runSweep failed build"
    );

    assert.equal(res.passed, false);
    assert.equal(res.build.skipped, false);
    assert.equal(res.build.exitCode, 42);
    assertIncludes(res.build.stderr, "BUILD_ERR");
    assert.equal(res.runs.length, 0);
    assert.equal(res.failedRun, null);
    assert.equal(runStartCalls, 0, "onRunStart must not be called when build fails");
  });

  suite.add("DS-T1.2.5", "Relative ./prog in cwd executes directly as runCmd without /bin/sh wrapper", async () => {
    await ensureEnv();
    const res = await waitWithTimeout(
      sdk.runSweep(
        imageRef,
        sweepOpts({
          cwd: "/workspace",
          buildCmd: [
            "/bin/sh",
            "-c",
            "cp /usr/local/bin/tcp_delay_probe /workspace/myprog && chmod +x /workspace/myprog",
          ],
          runCmd: ["./myprog", "--mode=timing", "--iters=2"],
          runs: 2,
          stddevStart: 0,
          stddevStep: 1,
          seedStart: 1,
        })
      ),
      90000,
      "runSweep relative ./myprog"
    );

    assert.equal(res.passed, true);
    assert.equal(res.runs.length, 2);
    for (const run of res.runs) {
      assert.equal(run.exitCode, 0, `relative ./myprog failed: ${run.stderr}`);
      assertIncludes(run.stdout, "ELAPSED_NS=");
    }
  });

  suite.add("DS-T1.2.6", "Manual snapshotVfs / restoreVfs / dropVfsSnapshot lifecycle on DockerContainer", async () => {
    await ensureEnv();
    const container = await pulledImage.createContainer({ tty: false });
    try {
      const b = await container.exec({
        cmd: ["/bin/sh", "-c", "echo BASE_DATA > /workspace/base.txt"],
      });
      assert.equal(b.exitCode, 0);

      const snapId = await container.snapshotVfs();
      assert.ok(typeof snapId === "number" && snapId > 0, `Expected positive snapshotId, got ${snapId}`);

      const m = await container.exec({
        cmd: ["/bin/sh", "-c", "echo OVERWRITTEN > /workspace/base.txt && echo TMP > /workspace/temp.txt"],
      });
      assert.equal(m.exitCode, 0);

      await container.restoreVfs(snapId);

      const v = await container.exec({
        cmd: [
          "/bin/sh",
          "-c",
          "cat /workspace/base.txt && test ! -e /workspace/temp.txt && echo RESTORED_OK",
        ],
      });
      assert.equal(v.exitCode, 0, `Restore check failed: ${v.stderr}`);
      assertIncludes(v.stdout, "BASE_DATA");
      assertIncludes(v.stdout, "RESTORED_OK");

      await container.dropVfsSnapshot(snapId);
    } finally {
      await container.stop();
    }
  });

  // =========================================================================
  // Area 3: Sweep Mode
  // =========================================================================

  suite.add("DS-T1.3.1", "Sweep passes when all N runs succeed with linear stddev & seed progression", async () => {
    await ensureEnv();
    const res = await waitWithTimeout(
      sdk.runSweep(
        imageRef,
        sweepOpts({
          runCmd: ["/usr/local/bin/tcp_delay_probe", "--mode=timing", "--iters=3"],
          runs: 4,
          stddevStart: 0.5,
          stddevStep: 1.5,
          seedStart: 10,
        })
      ),
      90000,
      "runSweep linear progression"
    );

    assert.equal(res.passed, true);
    assert.equal(res.failedRun, null);
    assert.equal(res.runs.length, 4);
    assert.deepEqual(
      res.runs.map((r) => r.stddevMs),
      [0.5, 2, 3.5, 5]
    );
    assert.deepEqual(
      res.runs.map((r) => r.seed),
      [10, 11, 12, 13]
    );
    for (const run of res.runs) {
      assert.equal(run.exitCode, 0);
    }
  });

  suite.add("DS-T1.3.2", "Sweep stops immediately on first failure (stopOnFailure default true)", async () => {
    await ensureEnv();
    const res = await waitWithTimeout(
      sdk.runSweep(
        imageRef,
        sweepOpts({
          runCmd: [
            "/usr/local/bin/tcp_delay_probe",
            "--mode=fail-above",
            "--threshold-ms=10",
            "--iters=6",
          ],
          runs: 10,
          stddevStart: 0,
          stddevStep: 5,
          seedStart: 1,
        })
      ),
      90000,
      "runSweep stop on first failure"
    );

    assert.equal(res.passed, false);
    assert.ok(res.failedRun !== null, "Expected non-null failedRun");
    assert.equal(res.failedRun.exitCode, 1);
    assert.ok(res.runs.length < 10, `Expected early stop (< 10 runs), got ${res.runs.length}`);
    assert.equal(res.runs[0].exitCode, 0, "Run 0 at stddev=0 must pass");
    assert.deepEqual(
      res.runs[res.runs.length - 1],
      res.failedRun,
      "Last executed run must be failedRun (no runs after failure)"
    );
  });

  suite.add("DS-T1.3.3", "Sweep callbacks (onBuildOutput, onRunStart, onRunComplete) fire in exact order", async () => {
    await ensureEnv();
    const events = [];
    let buildOut = "";

    const res = await waitWithTimeout(
      sdk.runSweep(
        imageRef,
        sweepOpts({
          buildCmd: ["/bin/sh", "-c", "echo B_OUT"],
          runCmd: ["/bin/sh", "-c", "echo R_OUT"],
          runs: 3,
          stddevStart: 1,
          stddevStep: 2,
          seedStart: 5,
          onBuildOutput: (payload) => {
            const raw =
              payload &&
              typeof payload === "object" &&
              !(payload instanceof Uint8Array) &&
              "chunk" in payload
                ? payload.chunk
                : payload;
            buildOut += typeof raw === "string" ? raw : new TextDecoder().decode(raw);
            if (!events.includes("buildOutput")) events.push("buildOutput");
          },
          onRunStart: (info) => {
            events.push(`start:${info.stddevMs}:${info.seed}`);
          },
          onRunComplete: (run) => {
            events.push(`complete:${run.stddevMs}:${run.seed}:${run.exitCode}`);
          },
        })
      ),
      90000,
      "runSweep callbacks"
    );

    assert.equal(res.passed, true);
    assertIncludes(buildOut, "B_OUT");
    assert.deepEqual(events, [
      "buildOutput",
      "start:1:5",
      "complete:1:5:0",
      "start:3:6",
      "complete:3:6:0",
      "start:5:7",
      "complete:5:7:0",
    ]);
  });

  suite.add("DS-T1.3.4", "Failing sweep run is bit-for-bit reproducible via standalone container.exec", async () => {
    await ensureEnv();
    const cmd = [
      "/usr/local/bin/tcp_delay_probe",
      "--mode=fail-above",
      "--threshold-ms=10",
      "--iters=6",
    ];
    const sweepRes = await waitWithTimeout(
      sdk.runSweep(
        imageRef,
        sweepOpts({
          runCmd: cmd,
          runs: 10,
          stddevStart: 0,
          stddevStep: 5,
          seedStart: 1,
        })
      ),
      90000,
      "sweep for repro"
    );

    assert.equal(sweepRes.passed, false);
    const f = sweepRes.failedRun;
    assert.ok(f !== null);

    const container = await pulledImage.createContainer({ tty: false });
    try {
      const repro = await waitWithTimeout(
        container.exec({
          cmd,
          delayStddevMs: f.stddevMs,
          delaySeed: f.seed,
        }),
        60000,
        "standalone repro"
      );
      assert.equal(repro.exitCode, f.exitCode);
      assert.equal(repro.stdout, f.stdout);
      assert.equal(repro.stderr, f.stderr);
      assert.equal(repro.virtualTimeNs, f.virtualTimeNs);
    } finally {
      await container.stop();
    }
  });

  suite.add("DS-T1.3.5", "buildCmd always runs with stddev=0 even when sweep stddevStart is huge", async () => {
    await ensureEnv();
    const res = await waitWithTimeout(
      sdk.runSweep(
        imageRef,
        sweepOpts({
          buildCmd: ["/usr/local/bin/tcp_delay_probe", "--mode=timing", "--iters=4"],
          runCmd: ["/bin/sh", "-c", "echo OK"],
          runs: 2,
          stddevStart: 5000,
          stddevStep: 1000,
          seedStart: 1,
        })
      ),
      90000,
      "buildCmd stddev=0 check"
    );

    assert.equal(res.passed, true);
    assert.equal(res.build.exitCode, 0);
    const buildElapsed = parseProbeBigInt(res.build.stdout, "ELAPSED_NS");
    assert.ok(
      buildElapsed < 50_000_000n,
      `Expected buildCmd to execute with stddev=0 (<50ms), got ELAPSED_NS=${buildElapsed}`
    );
  });

  suite.add("DS-T1.3.6", "onRunOutput streams stdout and stderr for each sweep iteration", async () => {
    await ensureEnv();
    const perRunOut = new Map();
    const res = await waitWithTimeout(
      sdk.runSweep(
        imageRef,
        sweepOpts({
          runCmd: ["/bin/sh", "-c", "echo OUT_LINE; echo ERR_LINE >&2"],
          runs: 2,
          stddevStart: 0,
          stddevStep: 1,
          seedStart: 1,
          onRunOutput: (info, stream, chunk) => {
            const key = typeof info === "number" ? info : info.index;
            const raw =
              chunk !== undefined
                ? chunk
                : info && typeof info === "object" && "chunk" in info
                ? info.chunk
                : typeof stream === "string" || stream instanceof Uint8Array
                ? stream
                : "";
            const text =
              typeof raw === "string"
                ? raw
                : raw instanceof Uint8Array
                ? new TextDecoder().decode(raw)
                : "";
            perRunOut.set(key, (perRunOut.get(key) || "") + text);
          },
        })
      ),
      60000,
      "onRunOutput streaming"
    );

    assert.equal(res.passed, true);
    assert.equal(res.runs.length, 2);
    assert.ok(perRunOut.size >= 2, `Expected onRunOutput for 2 runs, got ${perRunOut.size} entries`);
    for (const combined of perRunOut.values()) {
      assertIncludes(combined, "OUT_LINE");
      assertIncludes(combined, "ERR_LINE");
    }
  });

  // =========================================================================
  // Area 4: URL Linking for Sweep Mode AND Specific Runs Inside the Sweep
  // =========================================================================

  suite.add("DS-T1.4.1", "parseStateFromSearch + serializeStateToSearch round-trip full Sweep Mode URL", async () => {
    const urlState = await importUrlState();
    const input =
      "?image=ghcr.io%2Ffatlotus%2Fgolang-with-cache%3A1.27-alpine&build=go+build&cmd=.%2Fraft&repo=fatlotus%2Fnodice&cwd=%2Fworkspace%2Fexample&sweep=1&runs=15&stddevStart=0.5&stddevStep=1.5&seed=7&selectedRun=3";

    const { state: parsed } = urlState.parseStateFromSearch(input);
    assert.equal(parsed.image, "ghcr.io/fatlotus/golang-with-cache:1.27-alpine");
    assert.equal(parsed.build, "go build");
    assert.equal(parsed.cmd, "./raft");
    assert.equal(parsed.repo, "fatlotus/nodice");
    assert.equal(parsed.cwd, "/workspace/example");
    assert.equal(parsed.sweep, true);
    assert.equal(parsed.runs, 15);
    assert.equal(parsed.stddevStart, 0.5);
    assert.equal(parsed.stddevStep, 1.5);
    assert.equal(parsed.seed, 7);
    assert.equal(parsed.selectedRun, 3);

    const serialized = urlState.serializeStateToSearch(parsed);
    const { state: reparsed } = urlState.parseStateFromSearch(serialized);
    assert.deepEqual(reparsed, parsed);
  });

  suite.add("DS-T1.4.2", "computeSweepRunParams computes exact 1-based (index, stddev, seed) with round3", async () => {
    const urlState = await importUrlState();
    assert.equal(typeof urlState.computeSweepRunParams, "function");

    const base = { stddevStart: 0.1, stddevStep: 0.2, seed: 10 };
    assert.deepEqual(urlState.computeSweepRunParams(base, 1), { index: 1, stddev: 0.1, seed: 10 });
    assert.deepEqual(urlState.computeSweepRunParams(base, 2), { index: 2, stddev: 0.3, seed: 11 });
    assert.deepEqual(urlState.computeSweepRunParams(base, 3), { index: 3, stddev: 0.5, seed: 12 });
    assert.deepEqual(urlState.computeSweepRunParams(base, 4), { index: 4, stddev: 0.7, seed: 13 });
  });

  suite.add("DS-T1.4.3", "buildRunSearch generates standalone per-run reproducer URL omitting sweep params", async () => {
    const urlState = await importUrlState();
    assert.equal(typeof urlState.buildRunSearch, "function");

    const sweepState = {
      image: "ghcr.io/fatlotus/golang-with-cache:1.27-alpine",
      build: "go build",
      cmd: "./raft",
      repo: "fatlotus/nodice",
      ref: "main",
      mount: "/workspace",
      cwd: "/workspace/example",
      env: "FOO=1",
      sweep: true,
      runs: 20,
      stddevStart: 1,
      stddevStep: 2,
      seed: 1,
      selectedRun: 4,
    };

    const runSearch = urlState.buildRunSearch(sweepState, { stddev: 7, seed: 4 });
    const params = new URLSearchParams(runSearch);

    assert.equal(params.get("image"), sweepState.image);
    assert.equal(params.get("build"), "go build");
    assert.equal(params.get("cmd"), "./raft");
    assert.equal(params.get("repo"), "fatlotus/nodice");
    assert.equal(params.get("cwd"), "/workspace/example");
    assert.equal(params.get("stddev"), "7");
    assert.equal(params.get("seed"), "4");
    for (const forbidden of ["sweep", "runs", "stddevStart", "stddevStep", "selectedRun"]) {
      assert.equal(params.has(forbidden), false, `Standalone run URL must omit ${forbidden}`);
    }

    const { state: reparsed } = urlState.parseStateFromSearch(runSearch);
    assert.equal(reparsed.sweep, false);
    assert.equal(reparsed.stddev, 7);
    assert.equal(reparsed.seed, 4);
  });

  suite.add("DS-T1.4.4", "Chrome CDP: Sweep URL hydrates all DOM controls WITHOUT auto-booting", async () => {
    const b = await ensureBrowser();
    b.clearLogs();
    const url =
      `${server.url}/?image=ghcr.io%2Ffatlotus%2Fgolang-with-cache%3A1.27-alpine&build=go+build&cmd=.%2Fraft&repo=fatlotus%2Fnodice&cwd=%2Fworkspace%2Fexample&sweep=1&runs=12&stddevStart=0.5&stddevStep=2&seed=5&selectedRun=4`;
    await b.navigate(url);
    await b.waitForSelector("#image-input");

    const st = await readDelaySweepDomState(b);
    assert.equal(st.image, "ghcr.io/fatlotus/golang-with-cache:1.27-alpine");
    assert.equal(st.build, "go build");
    assert.equal(st.cmd, "./raft");
    assert.equal(st.repo, "fatlotus/nodice");
    assert.equal(st.cwd, "/workspace/example");
    assert.equal(st.sweep, true);
    assert.equal(st.runs, "12");
    assert.equal(st.stddevStart, "0.5");
    assert.equal(st.stddevStep, "2");
    assert.equal(st.seed, "5");
    assert.equal(st.statusState, "idle", "Must NOT auto-boot on Sweep URL load");
    assert.equal(st.stopDisabled, true);
    assert.equal(b.exceptions.length, 0, `Unexpected exceptions: ${JSON.stringify(b.exceptions)}`);
    const apiReqs = b.networkRequests.filter((r) => r.url.includes("/api/v2/") || r.url.includes("/api/git/"));
    assert.equal(apiReqs.length, 0, `Unexpected auto-boot requests: ${JSON.stringify(apiReqs)}`);
  });

  suite.add("DS-T1.4.5", "Chrome CDP: Standalone per-run reproducer URL hydrates single-run delay mode", async () => {
    const b = await ensureBrowser();
    b.clearLogs();
    await b.navigate(`${server.url}/?image=alpine%3Alatest&build=echo+build&cmd=echo+run&stddev=12.5&seed=42`);
    await b.waitForSelector("#image-input");

    const st = await readDelaySweepDomState(b);
    assert.equal(st.image, "alpine:latest");
    assert.equal(st.build, "echo build");
    assert.equal(st.cmd, "echo run");
    assert.equal(st.stddev, "12.5");
    assert.equal(st.seed, "42");
    assert.equal(st.sweep, false);
    assert.equal(st.statusState, "idle");
    const apiReqs = b.networkRequests.filter((r) => r.url.includes("/api/v2/") || r.url.includes("/api/git/"));
    assert.equal(apiReqs.length, 0);
  });

  suite.add("DS-T1.4.6", "Backward compatibility with existing ?cmd= URL from ORIGINAL_REQUEST.md", async () => {
    const b = await ensureBrowser();
    b.clearLogs();
    const legacyUrl =
      `${server.url}/?image=ghcr.io%2Ffatlotus%2Fgolang-with-cache%3A1.27-alpine&cmd=%2Fbin%2Fsh+-c+%22go+build+%26%26+.%2Fraft%22&repo=fatlotus%2Fnodice&cwd=%2Fworkspace%2Fexample`;
    await b.navigate(legacyUrl);
    await b.waitForSelector("#image-input");

    const st = await readDelaySweepDomState(b);
    assert.equal(st.image, "ghcr.io/fatlotus/golang-with-cache:1.27-alpine");
    assert.equal(st.build, "");
    assert.equal(st.cmd, '/bin/sh -c "go build && ./raft"');
    assert.equal(st.repo, "fatlotus/nodice");
    assert.equal(st.cwd, "/workspace/example");
    assert.equal(st.sweep, false);
    assert.ok(st.stddev === "" || st.stddev === "0", `Expected default stddev 0 or empty, got ${st.stddev}`);
    assert.equal(st.statusState, "idle");
  });

  suite.add("DS-T1.4.7", "Chrome CDP: go-raft-nodice project preset chip populates build/run split & syncs URL", async () => {
    const b = await ensureBrowser();
    b.clearLogs();
    await b.navigate(`${server.url}/`);
    await b.waitForSelector('button.project-preset-chip[data-preset="go-raft-nodice"]');

    const before = await readDelaySweepDomState(b);
    await b.click('button.project-preset-chip[data-preset="go-raft-nodice"]');
    const after = await readDelaySweepDomState(b);

    assert.equal(after.image, "ghcr.io/fatlotus/golang-with-cache:1.27-alpine");
    assert.equal(after.repo, "fatlotus/nodice");
    assert.equal(after.cwd, "/workspace/example");
    assert.equal(after.build, "go build");
    assert.equal(after.cmd, "./raft");
    assert.equal(after.historyLength, before.historyLength + 1, "Preset click must use pushState");
    const params = new URLSearchParams(after.search);
    assert.equal(params.get("build"), "go build");
    assert.equal(params.get("cmd"), "./raft");
    assert.equal(params.get("repo"), "fatlotus/nodice");
  });

  try {
    return await suite.run({ verbose: opts.verbose });
  } finally {
    if (browser) await browser.close();
    if (server) await server.close();
    if (registry) await registry.close();
  }
}
