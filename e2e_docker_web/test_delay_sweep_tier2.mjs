// Tier 2: Opaque-Box Boundary & Corner Cases for F41
// (Deterministic Delay Injection Boundaries, Build/Run Split Boundaries,
//  Sweep Mode Boundaries, and URL Linking Boundaries & Sanitization).
// 26 tests total (6-7 per requirement area).

import {
  Suite,
  assert,
  assertIncludes,
  waitWithTimeout,
} from "./helpers/test_runner.mjs";
import { startServer } from "./helpers/server_harness.mjs";
import { startMockOciRegistry } from "./helpers/mock_oci_registry.mjs";
import { launchCdpBrowser } from "./helpers/cdp_browser.mjs";
import {
  JS_CLI_PATH,
  ensureDelaySweepProbe,
  registerDelaySweepOciImage,
  importDockerSdk,
  importUrlState,
  createSdkClient,
  parseProbeMetric,
  parseProbeBigInt,
  runProcess,
  readDelaySweepDomState,
  setCheckboxValue,
} from "./delay_sweep_helpers.mjs";

export const TIER2_TEST_COUNT = 26;

export async function runDelaySweepTier2(opts = {}) {
  const suite = new Suite("Tier 2: Delay/Sweep Boundary & Corner Cases");

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
  // Area 1: Deterministic Delay Injection Boundaries (7 Tests)
  // =========================================================================

  suite.add("DS-T2.1.1", "stddev=0 with explicit non-zero seed injects zero delay and stays deterministic", async () => {
    await ensureEnv();
    const container = await pulledImage.createContainer({ tty: false });
    try {
      const r1 = await waitWithTimeout(
        container.exec({
          cmd: ["/usr/local/bin/tcp_delay_probe", "--mode=timing", "--iters=6"],
          delayStddevMs: 0,
          delaySeed: 12345,
        }),
        60000,
        "stddev=0 seed=12345 #1"
      );
      const r2 = await waitWithTimeout(
        container.exec({
          cmd: ["/usr/local/bin/tcp_delay_probe", "--mode=timing", "--iters=6"],
          delayStddevMs: 0,
          delaySeed: 12345,
        }),
        60000,
        "stddev=0 seed=12345 #2"
      );
      const r3 = await waitWithTimeout(
        container.exec({
          cmd: ["/usr/local/bin/tcp_delay_probe", "--mode=timing", "--iters=6"],
          delayStddevMs: 0,
          delaySeed: 99999,
        }),
        60000,
        "stddev=0 seed=99999"
      );

      assert.equal(r1.exitCode, 0);
      assert.equal(r2.exitCode, 0);
      assert.equal(r3.exitCode, 0);
      assert.equal(r1.stdout, r2.stdout, "Same seed at stddev=0 must be bit-for-bit identical");
      assert.ok(parseProbeBigInt(r1.stdout, "ELAPSED_NS") < 50_000_000n, "Zero delay expected at stddev=0");
      assert.ok(parseProbeBigInt(r3.stdout, "ELAPSED_NS") < 50_000_000n, "Zero delay expected at stddev=0");
    } finally {
      await container.stop();
    }
  });

  suite.add("DS-T2.1.2", "Sub-millisecond fractional stddev (0.001ms vs 0.5ms) scales accurately and stays deterministic", async () => {
    await ensureEnv();
    const container = await pulledImage.createContainer({ tty: false });
    try {
      const rSmall1 = await waitWithTimeout(
        container.exec({
          cmd: ["/usr/local/bin/tcp_delay_probe", "--mode=timing", "--iters=6"],
          delayStddevMs: 0.001,
          delaySeed: 7,
        }),
        60000,
        "0.001ms #1"
      );
      const rSmall2 = await waitWithTimeout(
        container.exec({
          cmd: ["/usr/local/bin/tcp_delay_probe", "--mode=timing", "--iters=6"],
          delayStddevMs: 0.001,
          delaySeed: 7,
        }),
        60000,
        "0.001ms #2"
      );
      const rHalf = await waitWithTimeout(
        container.exec({
          cmd: ["/usr/local/bin/tcp_delay_probe", "--mode=timing", "--iters=6"],
          delayStddevMs: 0.5,
          delaySeed: 7,
        }),
        60000,
        "0.5ms"
      );

      assert.equal(rSmall1.exitCode, 0);
      assert.equal(rSmall2.exitCode, 0);
      assert.equal(rHalf.exitCode, 0);
      assert.equal(rSmall1.stdout, rSmall2.stdout, "0.001ms must be deterministic");
      const nsSmall = parseProbeBigInt(rSmall1.stdout, "ELAPSED_NS");
      const nsHalf = parseProbeBigInt(rHalf.stdout, "ELAPSED_NS");
      assert.ok(nsSmall > 0n, `0.001ms (1000ns) must not round down to 0, got ${nsSmall}`);
      assert.ok(nsHalf > nsSmall, `0.5ms (${nsHalf}) must exceed 0.001ms (${nsSmall})`);
    } finally {
      await container.stop();
    }
  });

  suite.add("DS-T2.1.3", "Very large stddev (60000ms = 1 simulated minute) avoids 64-bit overflow and wall-clock stall", async () => {
    await ensureEnv();
    const container = await pulledImage.createContainer({ tty: false });
    try {
      // Warm compile first
      const warm = await waitWithTimeout(
        container.exec({
          cmd: ["/usr/local/bin/tcp_delay_probe", "--mode=timing", "--iters=1"],
          delayStddevMs: 0,
          delaySeed: 1,
        }),
        90000,
        "warm"
      );
      assert.equal(warm.exitCode, 0);

      const t0 = performance.now();
      const r = await waitWithTimeout(
        container.exec({
          cmd: ["/usr/local/bin/tcp_delay_probe", "--mode=timing", "--iters=4"],
          delayStddevMs: 60000,
          delaySeed: 11,
        }),
        30000,
        "60000ms stddev"
      );
      const wallMs = performance.now() - t0;

      assert.equal(r.exitCode, 0, `60000ms failed: ${r.stderr}`);
      const ns = parseProbeBigInt(r.stdout, "ELAPSED_NS");
      assert.ok(ns >= 10_000_000_000n, `Expected >= 10s simulated time, got ${ns}`);
      assert.ok(r.virtualTimeNs >= 10_000_000_000, `Expected virtualTimeNs >= 10e9, got ${r.virtualTimeNs}`);
      assert.ok(wallMs < 5000, `60000ms simulated delay took too long wall-clock: ${wallMs.toFixed(0)}ms`);
    } finally {
      await container.stop();
    }
  });

  suite.add("DS-T2.1.4", "seed=0 with stddev > 0 is valid and deterministic", async () => {
    await ensureEnv();
    const container = await pulledImage.createContainer({ tty: false });
    try {
      const r1 = await waitWithTimeout(
        container.exec({
          cmd: ["/usr/local/bin/tcp_delay_probe", "--mode=timing", "--iters=6"],
          delayStddevMs: 5,
          delaySeed: 0,
        }),
        60000,
        "seed=0 #1"
      );
      const r2 = await waitWithTimeout(
        container.exec({
          cmd: ["/usr/local/bin/tcp_delay_probe", "--mode=timing", "--iters=6"],
          delayStddevMs: 5,
          delaySeed: 0,
        }),
        60000,
        "seed=0 #2"
      );

      assert.equal(r1.exitCode, 0);
      assert.equal(r2.exitCode, 0);
      assert.equal(r1.stdout, r2.stdout);
      assert.ok(parseProbeBigInt(r1.stdout, "ELAPSED_NS") > 0n);
    } finally {
      await container.stop();
    }
  });

  suite.add("DS-T2.1.5", "Max safe integer seed (Number.MAX_SAFE_INTEGER) converts cleanly to u64", async () => {
    await ensureEnv();
    const container = await pulledImage.createContainer({ tty: false });
    try {
      const r1 = await waitWithTimeout(
        container.exec({
          cmd: ["/usr/local/bin/tcp_delay_probe", "--mode=timing", "--iters=4"],
          delayStddevMs: 5,
          delaySeed: Number.MAX_SAFE_INTEGER,
        }),
        60000,
        "MAX_SAFE_INTEGER #1"
      );
      const r2 = await waitWithTimeout(
        container.exec({
          cmd: ["/usr/local/bin/tcp_delay_probe", "--mode=timing", "--iters=4"],
          delayStddevMs: 5,
          delaySeed: Number.MAX_SAFE_INTEGER,
        }),
        60000,
        "MAX_SAFE_INTEGER #2"
      );
      const rZero = await waitWithTimeout(
        container.exec({
          cmd: ["/usr/local/bin/tcp_delay_probe", "--mode=timing", "--iters=4"],
          delayStddevMs: 5,
          delaySeed: 0,
        }),
        60000,
        "seed=0 comparison"
      );

      assert.equal(r1.exitCode, 0);
      assert.equal(r2.exitCode, 0);
      assert.equal(r1.stdout, r2.stdout);
      assert.notEqual(
        parseProbeMetric(r1.stdout, "RAND_HEX"),
        parseProbeMetric(rZero.stdout, "RAND_HEX"),
        "MAX_SAFE_INTEGER seed must differ from seed=0"
      );
    } finally {
      await container.stop();
    }
  });

  suite.add("DS-T2.1.6", "Negative / NaN / Infinity delayStddevMs and delaySeed are safely validated or clamped", async () => {
    await ensureEnv();
    const container = await pulledImage.createContainer({ tty: false });
    try {
      const badCases = [
        { delayStddevMs: -5, delaySeed: 1 },
        { delayStddevMs: Number.NaN, delaySeed: Number.NaN },
        { delayStddevMs: Number.POSITIVE_INFINITY, delaySeed: -1 },
      ];

      for (const bad of badCases) {
        let threwValidation = false;
        let res = null;
        try {
          res = await waitWithTimeout(
            container.exec({
              cmd: ["/usr/local/bin/tcp_delay_probe", "--mode=timing", "--iters=2"],
              ...bad,
            }),
            30000,
            `bad delay ${JSON.stringify(bad)}`
          );
        } catch (err) {
          assert.ok(err instanceof Error && err.message.length > 0, "Validation error must have message");
          assert.notEqual(err.name, "RuntimeError", "Must not crash WASM with RuntimeError");
          assert.notEqual(err.name, "TypeError", `Unexpected internal TypeError: ${err.message}`);
          assert.notEqual(err.name, "ReferenceError", `Unexpected internal ReferenceError: ${err.message}`);
          assert.ok(!/timed out/i.test(err.message), `Must not mask timeout as validation error: ${err.message}`);
          threwValidation = true;
        }
        if (!threwValidation) {
          assert.equal(res.exitCode, 0, `Clamped execution should succeed cleanly, got: ${res.stderr}`);
        }
      }

      // Container must remain healthy for a subsequent valid exec.
      const ok = await waitWithTimeout(
        container.exec({
          cmd: ["/usr/local/bin/tcp_delay_probe", "--mode=timing", "--iters=2"],
          delayStddevMs: 2,
          delaySeed: 3,
        }),
        30000,
        "recovery exec"
      );
      assert.equal(ok.exitCode, 0);
    } finally {
      await container.stop();
    }
  });

  suite.add("DS-T2.1.7", "CLI (js/cli.mjs) rejects invalid --delay-stddev-ms and --delay-seed cleanly", async () => {
    await ensureEnv();
    const invalidInvocations = [
      [JS_CLI_PATH, "run", "--elf", probePath, "--delay-stddev-ms", "-1"],
      [JS_CLI_PATH, "run", "--elf", probePath, "--delay-stddev-ms", "abc"],
      [JS_CLI_PATH, "run", "--elf", probePath, "--delay-seed", "-5"],
    ];

    for (const args of invalidInvocations) {
      const r = await runProcess(process.execPath, args, { timeoutMs: 20000 });
      assert.notEqual(r.exitCode, 0, `Expected non-zero exit for invalid CLI args: ${args.join(" ")}`);
      assert.ok(
        (r.stderr + r.stdout).trim().length > 0,
        `Expected error message for invalid CLI args: ${args.join(" ")}`
      );
    }
  });

  // =========================================================================
  // Area 2: Build vs Run Command Split Boundaries (6 Tests)
  // =========================================================================

  suite.add("DS-T2.2.1", "Omitted or empty buildCmd (undefined and []) skips build cleanly", async () => {
    await ensureEnv();
    for (const buildCmd of [undefined, []]) {
      const res = await waitWithTimeout(
        sdk.runSweep(
          imageRef,
          sweepOpts({
            buildCmd,
            runCmd: ["/bin/sh", "-c", "echo DIRECT_RUN"],
            runs: 2,
            stddevStart: 0,
            stddevStep: 1,
            seedStart: 1,
          })
        ),
        60000,
        `empty buildCmd (${JSON.stringify(buildCmd)})`
      );
      assert.equal(res.passed, true);
      assert.equal(res.build.skipped, true);
      assert.equal(res.build.exitCode, 0);
      assert.equal(res.runs.length, 2);
      for (const r of res.runs) {
        assertIncludes(r.stdout, "DIRECT_RUN");
      }
    }
  });

  suite.add("DS-T2.2.2", "Custom env and cwd propagate consistently across both buildCmd and runCmd", async () => {
    await ensureEnv();
    const res = await waitWithTimeout(
      sdk.runSweep(
        imageRef,
        sweepOpts({
          cwd: "/workspace/sub",
          env: ["BUILD_TAG=v99", "SHARED_VAR=hello"],
          buildCmd: [
            "/bin/sh",
            "-c",
            "mkdir -p /workspace/sub && printf '%s' \"$BUILD_TAG\" > /workspace/sub/tag.txt",
          ],
          runCmd: [
            "/bin/sh",
            "-c",
            "printf '%s:%s:%s\\n' \"$(pwd)\" \"$(cat tag.txt)\" \"$SHARED_VAR\"",
          ],
          runs: 2,
          stddevStart: 0,
          stddevStep: 1,
          seedStart: 1,
        })
      ),
      60000,
      "env/cwd inheritance"
    );

    assert.equal(res.passed, true);
    assert.equal(res.runs.length, 2);
    for (const r of res.runs) {
      assert.equal(r.exitCode, 0);
      assert.equal(r.stdout.trim(), "/workspace/sub:v99:hello");
    }
  });

  suite.add("DS-T2.2.3", "Deeply nested directories and symlinks created by buildCmd survive snapshot/restore", async () => {
    await ensureEnv();
    const res = await waitWithTimeout(
      sdk.runSweep(
        imageRef,
        sweepOpts({
          buildCmd: [
            "/bin/sh",
            "-c",
            "mkdir -p /workspace/a/b/c && echo DEEP > /workspace/a/b/c/file.txt && ln -s /workspace/a/b/c/file.txt /workspace/link.txt",
          ],
          runCmd: ["/bin/sh", "-c", "cat /workspace/link.txt && rm -rf /workspace/a /workspace/link.txt"],
          runs: 3,
          stddevStart: 0,
          stddevStep: 1,
          seedStart: 1,
        })
      ),
      60000,
      "nested dirs & symlinks snapshot"
    );

    assert.equal(res.passed, true);
    assert.equal(res.runs.length, 3);
    for (const r of res.runs) {
      assert.equal(r.exitCode, 0);
      assert.equal(r.stdout.trim(), "DEEP");
    }
  });

  suite.add("DS-T2.2.4", "Self-destructive run deleting its own executable does not break subsequent runs", async () => {
    await ensureEnv();
    const res = await waitWithTimeout(
      sdk.runSweep(
        imageRef,
        sweepOpts({
          buildCmd: [
            "/bin/sh",
            "-c",
            "printf '#!/bin/sh\\necho ALIVE\\nrm -f /workspace/self_del\\n' > /workspace/self_del && chmod +x /workspace/self_del",
          ],
          runCmd: ["/workspace/self_del"],
          runs: 3,
          stddevStart: 0,
          stddevStep: 1,
          seedStart: 1,
        })
      ),
      60000,
      "self-destructive run isolation"
    );

    assert.equal(res.passed, true);
    assert.equal(res.runs.length, 3);
    for (const r of res.runs) {
      assert.equal(r.exitCode, 0);
      assert.equal(r.stdout.trim(), "ALIVE");
    }
  });

  suite.add("DS-T2.2.5", "Non-existent buildCmd binary fails build cleanly without starting sweep", async () => {
    await ensureEnv();
    const res = await waitWithTimeout(
      sdk.runSweep(
        imageRef,
        sweepOpts({
          buildCmd: ["/nonexistent/build_tool"],
          runCmd: ["/bin/sh", "-c", "echo NOPE"],
          runs: 3,
        })
      ),
      60000,
      "missing build binary"
    );

    assert.equal(res.passed, false);
    assert.equal(res.build.skipped, false);
    assert.notEqual(res.build.exitCode, 0);
    assert.equal(res.runs.length, 0);
    assert.equal(res.failedRun, null);
  });

  suite.add("DS-T2.2.6", "Invalid or double-dropped snapshotId rejects cleanly without corrupting container", async () => {
    await ensureEnv();
    const container = await pulledImage.createContainer({ tty: false });
    try {
      await assert.rejects(
        () => container.restoreVfs(999999),
        /snapshot|invalid|unknown|not found/i,
        "restoreVfs(999999) must reject"
      );
      await assert.rejects(
        () => container.dropVfsSnapshot(999999),
        /snapshot|invalid|unknown|not found/i,
        "dropVfsSnapshot(999999) must reject"
      );

      const snapId = await container.snapshotVfs();
      await container.dropVfsSnapshot(snapId);
      await assert.rejects(
        () => container.dropVfsSnapshot(snapId),
        /snapshot|invalid|unknown|not found/i,
        "Double dropVfsSnapshot must reject"
      );
    } finally {
      await container.stop();
    }
  });

  // =========================================================================
  // Area 3: Sweep Mode Boundaries (6 Tests)
  // =========================================================================

  suite.add("DS-T2.3.1", "Single-iteration sweep (runs=1) executes once with exact (stddevStart, seedStart)", async () => {
    await ensureEnv();
    const res = await waitWithTimeout(
      sdk.runSweep(
        imageRef,
        sweepOpts({
          runCmd: ["/usr/local/bin/tcp_delay_probe", "--mode=timing", "--iters=2"],
          runs: 1,
          stddevStart: 2.5,
          stddevStep: 10,
          seedStart: 77,
        })
      ),
      60000,
      "runs=1 sweep"
    );

    assert.equal(res.passed, true);
    assert.equal(res.runs.length, 1);
    assert.equal(res.runs[0].stddevMs, 2.5);
    assert.equal(res.runs[0].seed, 77);
    assert.equal(res.failedRun, null);
  });

  suite.add("DS-T2.3.2", "Zero-delay multi-seed sweep (stddevStart=0, stddevStep=0) keeps stddev=0 and increments seed", async () => {
    await ensureEnv();
    const res = await waitWithTimeout(
      sdk.runSweep(
        imageRef,
        sweepOpts({
          runCmd: ["/usr/local/bin/tcp_delay_probe", "--mode=timing", "--iters=2"],
          runs: 3,
          stddevStart: 0,
          stddevStep: 0,
          seedStart: 1,
        })
      ),
      60000,
      "zero-delay multi-seed sweep"
    );

    assert.equal(res.passed, true);
    assert.equal(res.runs.length, 3);
    assert.deepEqual(res.runs.map((r) => r.stddevMs), [0, 0, 0]);
    assert.deepEqual(res.runs.map((r) => r.seed), [1, 2, 3]);
    for (const r of res.runs) {
      assert.ok(parseProbeBigInt(r.stdout, "ELAPSED_NS") < 50_000_000n);
    }
  });

  suite.add("DS-T2.3.3", "Immediate failure on Run 1 stops after 1 iteration", async () => {
    await ensureEnv();
    const res = await waitWithTimeout(
      sdk.runSweep(
        imageRef,
        sweepOpts({
          runCmd: ["/bin/sh", "-c", "echo FIRST_FAIL >&2; exit 7"],
          runs: 5,
          stddevStart: 0,
          stddevStep: 1,
          seedStart: 1,
        })
      ),
      60000,
      "immediate failure on run 1"
    );

    assert.equal(res.passed, false);
    assert.equal(res.runs.length, 1);
    assert.deepEqual(res.failedRun, res.runs[0]);
    assert.equal(res.failedRun.exitCode, 7);
    assertIncludes(res.failedRun.stderr, "FIRST_FAIL");
  });

  suite.add("DS-T2.3.4", "Failure occurring on the final iteration (run N) is reported accurately", async () => {
    await ensureEnv();
    // Run 0: stddev=0 (<15ms pass), Run 1: stddev=0.5 (<15ms pass), Run 2: stddev=50 (>15ms fail)
    // Use stddevStart=0, stddevStep=50 with runs=2 OR a threshold tuned to fail on final run.
    // Using runs=2, stddevStart=0, stddevStep=50 with threshold=15ms guarantees:
    //   run 0 (stddev=0ms) -> ~0ms < 15ms (PASS)
    //   run 1 (stddev=50ms, 6 round-trips = 12 writes) -> >> 15ms (FAIL on final run!)
    const res = await waitWithTimeout(
      sdk.runSweep(
        imageRef,
        sweepOpts({
          runCmd: [
            "/usr/local/bin/tcp_delay_probe",
            "--mode=fail-above",
            "--threshold-ms=15",
            "--iters=6",
          ],
          runs: 2,
          stddevStart: 0,
          stddevStep: 50,
          seedStart: 1,
        })
      ),
      60000,
      "failure on final run"
    );

    assert.equal(res.passed, false);
    assert.equal(res.runs.length, 2);
    assert.equal(res.runs[0].exitCode, 0);
    assert.equal(res.runs[1].exitCode, 1);
    assert.deepEqual(res.failedRun, res.runs[1]);
  });

  suite.add("DS-T2.3.5", "stopOnFailure: false runs all N iterations despite failures", async () => {
    await ensureEnv();
    const res = await waitWithTimeout(
      sdk.runSweep(
        imageRef,
        sweepOpts({
          runCmd: ["/bin/sh", "-c", "exit 3"],
          runs: 4,
          stddevStart: 0,
          stddevStep: 1,
          seedStart: 1,
          stopOnFailure: false,
        })
      ),
      60000,
      "stopOnFailure false"
    );

    assert.equal(res.passed, false);
    assert.equal(res.runs.length, 4);
    for (const r of res.runs) {
      assert.equal(r.exitCode, 3);
    }
    assert.ok(res.failedRun !== null);
  });

  suite.add("DS-T2.3.6", "AbortSignal cancellation stops sweep early and timeoutMs terminates hung run", async () => {
    await ensureEnv();
    // (a) AbortSignal after first run completes
    const ac = new AbortController();
    let abortedOrPartial = false;
    let partialCount = 0;
    try {
      const res = await waitWithTimeout(
        sdk.runSweep(
          imageRef,
          sweepOpts({
            runCmd: ["/bin/sh", "-c", "echo STEP"],
            runs: 10,
            stddevStart: 0,
            stddevStep: 1,
            seedStart: 1,
            signal: ac.signal,
            onRunComplete: () => {
              ac.abort();
            },
          })
        ),
        30000,
        "AbortSignal sweep"
      );
      partialCount = res.runs.length;
      abortedOrPartial = partialCount < 10;
    } catch (err) {
      abortedOrPartial = err.name === "AbortError" || /abort|cancel/i.test(err.message);
    }
    assert.ok(abortedOrPartial, `AbortSignal must stop sweep before 10 runs (ran ${partialCount})`);

    // (b) Per-run timeoutMs on a long-running command
    const t0 = performance.now();
    const hangRes = await waitWithTimeout(
      sdk.runSweep(
        imageRef,
        sweepOpts({
          runCmd: ["/bin/sh", "-c", "while true; do :; done"],
          runs: 3,
          stddevStart: 0,
          stddevStep: 1,
          seedStart: 1,
          timeoutMs: 1200,
        })
      ),
      20000,
      "timeoutMs enforcement"
    );
    const wallMs = performance.now() - t0;

    assert.equal(hangRes.passed, false);
    assert.ok(hangRes.failedRun !== null, "Timed-out run must set failedRun");
    assert.equal(hangRes.runs.length, 1, "Sweep must stop after timed-out run");
    assert.ok(
      hangRes.failedRun.status === "timeout" ||
        hangRes.failedRun.timedOut === true ||
        hangRes.failedRun.exitCode !== 0,
      `Expected timeout failure status, got: ${JSON.stringify(hangRes.failedRun)}`
    );
    assert.ok(wallMs < 15000, `Timeout enforcement took too long: ${wallMs.toFixed(0)}ms`);
  });

  // =========================================================================
  // Area 4: URL Linking Boundaries & Sanitization (7 Tests)
  // =========================================================================

  suite.add("DS-T2.4.1", "?run= read alias maps to cmd and canonicalizes to cmd on serialize", async () => {
    const urlState = await importUrlState();

    const { state: p1 } = urlState.parseStateFromSearch("?build=go+build&run=.%2Fraft");
    assert.equal(p1.build, "go build");
    assert.equal(p1.cmd, "./raft");
    const s1 = urlState.serializeStateToSearch(p1);
    const params1 = new URLSearchParams(s1);
    assert.equal(params1.get("cmd"), "./raft");
    assert.equal(params1.has("run"), false, "Canonical serialization must emit cmd, not run");

    const { state: p2 } = urlState.parseStateFromSearch("?cmd=preferred&run=ignored");
    assert.equal(p2.cmd, "preferred", "Explicit cmd must take precedence over run alias");
  });

  suite.add("DS-T2.4.2", "Default omission rules keep serialized URLs clean and minimal", async () => {
    const urlState = await importUrlState();

    assert.equal(urlState.serializeStateToSearch({ ...urlState.DEFAULT_UI_STATE }), "");

    const sZero = urlState.serializeStateToSearch({
      ...urlState.DEFAULT_UI_STATE,
      stddev: 0,
      seed: 0,
      sweep: false,
    });
    const pZero = new URLSearchParams(sZero);
    assert.equal(pZero.has("stddev"), false);
    assert.equal(pZero.has("seed"), false);
    assert.equal(pZero.has("sweep"), false);

    const sDefaultSweep = urlState.serializeStateToSearch({
      ...urlState.DEFAULT_UI_STATE,
      sweep: true,
    });
    const pSweep = new URLSearchParams(sDefaultSweep);
    assert.equal(pSweep.get("sweep"), "1");
    assert.equal(pSweep.has("selectedRun"), false);
  });

  suite.add("DS-T2.4.3", "Unknown query params and #hash fragment are preserved across sweep edits", async () => {
    const urlState = await importUrlState();
    const out = urlState.serializeStateToSearch(
      {
        ...urlState.DEFAULT_UI_STATE,
        sweep: true,
        runs: 5,
        build: "go build",
        cmd: "./raft",
      },
      { existingSearch: "?utm_source=ci&foo=bar&sweep=0" }
    );
    const p = new URLSearchParams(out);
    assert.equal(p.get("utm_source"), "ci");
    assert.equal(p.get("foo"), "bar");
    assert.equal(p.get("sweep"), "1");
    assert.equal(p.get("runs"), "5");

    const b = await ensureBrowser();
    await b.navigate(`${server.url}/?utm_source=ci#log`);
    await b.waitForSelector("#build-cmd-input");
    await b.setInputValue("#build-cmd-input", "make");
    await setCheckboxValue(b, "#sweep-mode-toggle", true);
    const st = await readDelaySweepDomState(b);
    assert.equal(st.hash, "#log", "Hash fragment must be preserved");
    assert.equal(new URLSearchParams(st.search).get("utm_source"), "ci");
  });

  suite.add("DS-T2.4.4", "Invalid, negative, NaN, and non-numeric sweep/delay query params sanitize safely", async () => {
    const urlState = await importUrlState();
    const { state: p } = urlState.parseStateFromSearch(
      "?stddev=-5&seed=-10&runs=0&stddevStart=NaN&stddevStep=abc&selectedRun=-3&sweep=maybe"
    );

    assert.equal(typeof p.stddev, "number");
    assert.ok(Number.isFinite(p.stddev) && p.stddev >= 0, `Expected sanitized stddev >= 0, got ${p.stddev}`);
    assert.equal(typeof p.seed, "number");
    assert.ok(Number.isFinite(p.seed) && p.seed >= 0, `Expected sanitized seed >= 0, got ${p.seed}`);
    assert.equal(typeof p.runs, "number");
    assert.ok(Number.isInteger(p.runs) && p.runs >= 1, `Expected sanitized runs >= 1, got ${p.runs}`);
    assert.ok(Number.isFinite(p.stddevStart) && p.stddevStart >= 0);
    assert.ok(Number.isFinite(p.stddevStep) && p.stddevStep >= 0);
    assert.equal(p.sweep, false, "sweep='maybe' must parse as false");
    assert.ok(p.selectedRun === null || p.selectedRun === undefined || p.selectedRun >= 1);
  });

  suite.add("DS-T2.4.5", "selectedRun out-of-range (0, >runs, float, or without sweep=1) is safely handled", async () => {
    const urlState = await importUrlState();

    const { state: pZero } = urlState.parseStateFromSearch("?sweep=1&runs=5&selectedRun=0");
    assert.ok(pZero.selectedRun === null || pZero.selectedRun === undefined);

    const { state: pHigh } = urlState.parseStateFromSearch("?sweep=1&runs=5&selectedRun=99");
    assert.ok(
      pHigh.selectedRun === null ||
        pHigh.selectedRun === undefined ||
        (pHigh.selectedRun >= 1 && pHigh.selectedRun <= 5),
      `Out-of-range selectedRun=99 must be null or clamped <=5, got ${pHigh.selectedRun}`
    );

    const { state: pValid } = urlState.parseStateFromSearch("?sweep=1&runs=5&selectedRun=3");
    assert.equal(pValid.selectedRun, 3);

    const sNoSweep = urlState.serializeStateToSearch({
      ...urlState.DEFAULT_UI_STATE,
      sweep: false,
      selectedRun: 3,
    });
    assert.equal(
      new URLSearchParams(sNoSweep).has("selectedRun"),
      false,
      "selectedRun must be omitted when sweep=false"
    );
  });

  suite.add("DS-T2.4.6", "Chrome CDP: XSS payloads in build, run, stddev, seed, runs, selectedRun never execute", async () => {
    const b = await ensureBrowser();
    b.clearLogs();
    const xss1 = '"><script>window.__xss=1</script>';
    const xss2 = '<img src=x onerror="window.__xss=2">';
    const xss3 = '"><svg onload="window.__xss=3">';
    const xss4 = '1"><script>window.__xss=4</script>';

    const q = new URLSearchParams({
      build: xss1,
      run: xss2,
      stddev: xss3,
      seed: xss4,
      runs: xss4,
      sweep: "1",
      selectedRun: xss4,
    });
    await b.navigate(`${server.url}/?${q.toString()}`);
    await b.waitForSelector("#build-cmd-input");

    const st = await readDelaySweepDomState(b);
    assert.equal(st.xssFlag, undefined, "XSS payload must never execute");
    assert.equal(st.build, xss1, "build input must hold literal text via .value");
    assert.equal(st.cmd, xss2, "cmd input must hold literal text via .value");
    assert.equal(b.exceptions.length, 0, `Unexpected exceptions: ${JSON.stringify(b.exceptions)}`);
  });

  suite.add("DS-T2.4.7", "Chrome CDP: Clicking plain .preset-chip resets build, delay, and sweep controls", async () => {
    const b = await ensureBrowser();
    b.clearLogs();
    await b.navigate(
      `${server.url}/?image=node%3A22-slim&build=make&cmd=.%2Fapp&sweep=1&runs=10&stddevStart=2&stddevStep=3&seed=9`
    );
    await b.waitForSelector('button.preset-chip[data-image="alpine:latest"]');

    await b.click('button.preset-chip[data-image="alpine:latest"]');
    const st = await readDelaySweepDomState(b);

    assert.equal(st.image, "alpine:latest");
    assert.equal(st.build, "");
    assert.equal(st.cmd, "");
    assert.equal(st.sweep, false);
    assert.ok(st.stddev === "" || st.stddev === "0");
    assert.ok(st.seed === "" || st.seed === "0");
    assert.equal(st.search, "", "Resetting to default alpine:latest must clear query string");
    assert.equal(st.activeElementId, "image-input", "Plain preset chip must focus #image-input");
  });

  try {
    return await suite.run({ verbose: opts.verbose });
  } finally {
    if (browser) await browser.close();
    if (server) await server.close();
    if (registry) await registry.close();
  }
}
