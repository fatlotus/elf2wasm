// Tier 4: Opaque-Box Real-World Application Scenarios for F41
// - T4-DS-1 (Offline): Multi-connection TCP loopback concurrency race sweep + simulated time + repro
// - T4-DS-2 (Offline): Full Chrome CDP sweep-to-reproducer user journey with Git repo overlay
// - T4-DS-3 (Live, skipped only via --skip-live): Real fatlotus/nodice Raft bug discovery
//           (INVARIANT VIOLATION: Committed Log Truncation Race) + standalone reproduction.

import {
  Suite,
  assert,
  assertIncludes,
  assertNotIncludes,
  stripAnsi,
  skip,
  waitWithTimeout,
} from "./helpers/test_runner.mjs";
import { startServer } from "./helpers/server_harness.mjs";
import { startMockOciRegistry } from "./helpers/mock_oci_registry.mjs";
import { startMockGitServer } from "./helpers/mock_git_server.mjs";
import { launchCdpBrowser } from "./helpers/cdp_browser.mjs";
import {
  registerDelaySweepOciImage,
  registerDelaySweepGitRepo,
  importDockerSdk,
  createSdkClient,
  parseProbeMetric,
  parseProbeBigInt,
  readDelaySweepDomState,
  waitForSweepFinished,
  waitForSingleRunFinished,
} from "./delay_sweep_helpers.mjs";

export const TIER4_TEST_COUNT = 3;

export async function runDelaySweepTier4(opts = {}) {
  const skipLive = Boolean(opts.skipLive);
  const suite = new Suite("Tier 4: Delay/Sweep Real-World Scenarios");

  let registry = null;
  let gitServer = null;
  let offlineServer = null;
  let liveServer = null;
  let browser = null;
  let imageRef = null;
  let gitRepoUrl = null;
  let sdk = null;
  let offlineDocker = null;

  async function ensureOfflineEnv() {
    if (offlineServer && registry && gitServer && sdk && offlineDocker) return;
    registry = await startMockOciRegistry();
    imageRef = registerDelaySweepOciImage(registry, "delay-sweep/tcp-race-app", "v1");
    gitServer = await startMockGitServer();
    gitRepoUrl = registerDelaySweepGitRepo(gitServer, "acme/sweep-proj");
    offlineServer = await startServer({ allowLocalRegistries: true });
    sdk = await importDockerSdk();
    offlineDocker = await createSdkClient(offlineServer.url);
  }

  suite.add(
    "T4-DS-1",
    "Offline Realistic Multi-Connection TCP Concurrency Race Sweep (Simulated Time + Reproducer)",
    async () => {
      await ensureOfflineEnv();
      const buildCmd = [
        "/bin/sh",
        "-c",
        "echo BUILT >> /tmp/build.log && cp /opt/tcp_race_probe /workspace/race_app && chmod +x /workspace/race_app",
      ];
      const runCmd = ["./race_app", "--mode=race", "--conns=6"];
      const env = [
        "SLEEP_MS=15000",
        "REQUIRE_BUILD_LOG=/tmp/build.log",
        "DIRTY_MARKER=/tmp/race_dirty.flag",
      ];

      let sweepStartWallMs = 0;
      const res = await waitWithTimeout(
        sdk.runSweep(imageRef, {
          registryProxyBase: `${offlineServer.url}/api/v2`,
          gitProxyBase: `${offlineServer.url}/api/git/archive`,
          compilerWasmUrl: `${offlineServer.url}/wasm/elf2wasm_compiler_wasm.wasm`,
          runtimeWasmUrl: `${offlineServer.url}/wasm/elf2wasm_runtime_wasm.wasm`,
          useWorker: false,
          buildCmd,
          runCmd,
          cwd: "/workspace",
          env,
          runs: 12,
          stddevStart: 0,
          stddevStep: 2,
          seedStart: 1,
          stopOnFailure: true,
          onRunStart: (info) => {
            if (sweepStartWallMs === 0) sweepStartWallMs = performance.now();
            void info;
          },
        }),
        150000,
        "T4-DS-1 offline concurrency race sweep"
      );
      const sweepWallMs = sweepStartWallMs > 0 ? performance.now() - sweepStartWallMs : 0;

      // Build ran once cleanly
      assert.equal(res.build.skipped, false);
      assert.equal(res.build.exitCode, 0, `Build failed: ${res.build.stderr}`);

      // Run 1 (stddev=0) passed and observed >= 15000ms simulated sleep
      assert.equal(res.runs[0].exitCode, 0, `Baseline run failed: ${res.runs[0].stderr}`);
      assertIncludes(res.runs[0].stdout, "ORDER=1,2,3,4,5,6");
      assertIncludes(res.runs[0].stdout, "BUILD_LINES=1");
      assert.ok(
        parseProbeBigInt(res.runs[0].stdout, "ELAPSED_NS") >= 15_000_000_000n,
        `Expected >=15000ms simulated time per run, got:\n${res.runs[0].stdout}`
      );

      // Sweep discovered the concurrency race and stopped immediately
      assert.equal(res.passed, false);
      assert.ok(res.failedRun !== null);
      assert.ok(res.runs.length >= 2);
      assert.deepEqual(res.runs[res.runs.length - 1], res.failedRun);
      assert.equal(res.failedRun.exitCode, 1);
      assertIncludes(res.failedRun.stderr, "INVARIANT_VIOLATION");
      for (const r of res.runs) {
        assertNotIncludes(r.stderr, "SNAPSHOT_LEAK");
      }

      // Simulated time proof: total simulated time across runs is >= 15s * runs.length (>= 30s),
      // while post-build sweep wall-clock time must be strictly faster than real-time waiting.
      const totalSimMs = res.runs.length * 15000;
      assert.ok(
        sweepWallMs < totalSimMs,
        `Expected simulated time to be strictly faster than real time (wall=${sweepWallMs.toFixed(0)}ms, totalSimMs=${totalSimMs}ms for ${res.runs.length} runs)`
      );

      // Standalone deterministic reproduction with failing (stddevMs, seed)
      const img = await offlineDocker.pullImage(imageRef);
      const container = await img.createContainer({ cwd: "/workspace", env, tty: false });
      try {
        const b = await waitWithTimeout(
          container.exec({ cmd: buildCmd, cwd: "/workspace", env, delayStddevMs: 0, delaySeed: 0 }),
          60000,
          "T4-DS-1 repro build"
        );
        assert.equal(b.exitCode, 0);

        const repro = await waitWithTimeout(
          container.exec({
            cmd: runCmd,
            cwd: "/workspace",
            env,
            delayStddevMs: res.failedRun.stddevMs,
            delaySeed: res.failedRun.seed,
          }),
          60000,
          "T4-DS-1 repro exec"
        );
        assert.equal(repro.exitCode, 1);
        assert.equal(
          parseProbeMetric(repro.stdout, "ORDER"),
          parseProbeMetric(res.failedRun.stdout, "ORDER")
        );
        assert.equal(repro.stderr, res.failedRun.stderr);
      } finally {
        await container.stop();
      }
    }
  );

  suite.add(
    "T4-DS-2",
    "Offline Chrome CDP Full Sweep-to-Reproducer User Journey with Git Repo Overlay",
    async () => {
      await ensureOfflineEnv();
      browser = await launchCdpBrowser();
      try {
        browser.clearLogs();
        const beforeGitReqs = gitServer.getRequests().length;

        const q = new URLSearchParams({
          image: imageRef,
          repo: gitRepoUrl,
          ref: "main",
          mount: "/workspace",
          cwd: "/workspace/subapp",
          build: "/bin/sh build.sh",
          cmd: "./app --mode=race --conns=6",
          sweep: "1",
          runs: "10",
          stddevStart: "0",
          stddevStep: "1",
          seed: "1",
        });

        await browser.navigate(`${offlineServer.url}/?${q.toString()}`);
        await browser.waitForSelector("#sweep-mode-toggle");

        // Verify full hydration with zero auto-boot
        const hydrated = await readDelaySweepDomState(browser);
        assert.equal(hydrated.image, imageRef);
        assert.equal(hydrated.repo, gitRepoUrl);
        assert.equal(hydrated.cwd, "/workspace/subapp");
        assert.equal(hydrated.build, "/bin/sh build.sh");
        assert.equal(hydrated.cmd, "./app --mode=race --conns=6");
        assert.equal(hydrated.sweep, true);
        assert.equal(hydrated.statusState, "idle");

        // Start sweep in browser Web Worker
        await browser.click("#start-btn");
        const { rows } = await waitForSweepFinished(browser, 150000);

        assert.ok(browser.workerTargets.length > 0, "Execution must occur client-side in a Dedicated Web Worker");
        const newForgeReqs = gitServer
          .getRequests()
          .slice(beforeGitReqs)
          .filter((r) => r.server === "forge");
        assert.equal(newForgeReqs.length, 1, `Git archive must be fetched once for entire sweep, got ${newForgeReqs.length}`);

        assert.ok(rows.length >= 2, `Expected >=2 sweep rows (PASS + FAIL), got ${rows.length}`);
        assert.ok(rows.length < 10, `Expected early stop on first failure, got ${rows.length} rows`);

        // Click Row 1 -> inspect baseline PASS output + URL selectedRun=1
        await browser.click("#sweep-results-body tr:nth-child(1)");
        const row1St = await readDelaySweepDomState(browser);
        assertIncludes(stripAnsi(row1St.terminalText), "ORDER=1,2,3,4,5,6");
        assert.equal(new URLSearchParams(row1St.search).get("selectedRun"), "1");

        // Click Row k -> inspect FAIL output + URL selectedRun=k
        const k = rows.length;
        await browser.click(`#sweep-results-body tr:nth-child(${k})`);
        const rowKSt = await readDelaySweepDomState(browser);
        const failTerm = stripAnsi(rowKSt.terminalText);
        assertIncludes(failTerm, "INVARIANT_VIOLATION");
        assert.equal(new URLSearchParams(rowKSt.search).get("selectedRun"), String(k));
        const failingOrder = parseProbeMetric(failTerm, "ORDER");
        assert.ok(failingOrder, "Expected ORDER= in failing run output");

        // Follow a.run-link from failing row -> standalone single-run reproduction
        const runLinkFullHref = rows[k - 1].runLinkFullHref;
        assert.ok(runLinkFullHref, "Failing sweep row must expose a.run-link");
        browser.clearLogs();
        await browser.navigate(runLinkFullHref);
        await browser.waitForSelector("#delay-stddev-input");

        const reproHydrated = await readDelaySweepDomState(browser);
        assert.equal(reproHydrated.sweep, false);
        assert.equal(reproHydrated.statusState, "idle");

        await browser.click("#start-btn");
        const reproDone = await waitForSingleRunFinished(browser, 150000);
        const reproTerm = stripAnsi(reproDone.terminalText);
        assertIncludes(reproTerm, "INVARIANT_VIOLATION");
        assert.equal(
          parseProbeMetric(reproTerm, "ORDER"),
          failingOrder,
          "Standalone reproducer URL must reproduce the exact failing ORDER permutation"
        );
        assert.equal(browser.exceptions.length, 0, `Unexpected browser exceptions: ${JSON.stringify(browser.exceptions)}`);
        assert.equal(browser.consoleErrors.length, 0, `Unexpected console errors: ${JSON.stringify(browser.consoleErrors)}`);
      } finally {
        await browser.close();
        browser = null;
      }
    }
  );

  suite.add(
    "T4-DS-3",
    "Live fatlotus/nodice Raft Bug Discovery via Sweep Mode & Standalone Deterministic Reproduction",
    async () => {
      if (skipLive) {
        skip("Skipped via --skip-live (live GHCR + GitHub fatlotus/nodice scenario)");
      }

      if (!sdk) {
        sdk = await importDockerSdk();
      }
      // Hardened server without --allow-local-registries for live GHCR + GitHub proxy
      liveServer = await startServer({ allowLocalRegistries: false });
      try {
        const liveDocker = await createSdkClient(liveServer.url);
        const image = "ghcr.io/fatlotus/golang-with-cache:1.27-alpine";
        const gitRepo = { repo: "fatlotus/nodice", ref: "HEAD", mountPath: "/workspace" };

        let sweepLoopStartMs = 0;
        const res = await waitWithTimeout(
          sdk.runSweep(image, {
            registryProxyBase: `${liveServer.url}/api/v2`,
            gitProxyBase: `${liveServer.url}/api/git/archive`,
            compilerWasmUrl: `${liveServer.url}/wasm/elf2wasm_compiler_wasm.wasm`,
            runtimeWasmUrl: `${liveServer.url}/wasm/elf2wasm_runtime_wasm.wasm`,
            useWorker: false,
            gitRepo,
            cwd: "/workspace/example",
            buildCmd: ["go", "build"],
            runCmd: ["./raft"],
            runs: 25,
            stddevStart: 0,
            stddevStep: 1,
            seedStart: 1,
            stopOnFailure: true,
            timeoutMs: 60000,
            onRunStart: () => {
              if (sweepLoopStartMs === 0) sweepLoopStartMs = performance.now();
            },
          }),
          300000,
          "T4-DS-3 live fatlotus/nodice sweep"
        );
        const sweepLoopWallMs = sweepLoopStartMs > 0 ? performance.now() - sweepLoopStartMs : 0;

        // Build ran once and succeeded
        assert.equal(res.build.skipped, false);
        assert.equal(res.build.exitCode, 0, `go build failed: ${res.build.stderr}`);

        // Run 1 (stddev=0) baseline passed
        assert.equal(res.runs[0].exitCode, 0, `Baseline ./raft run failed: ${res.runs[0].stderr}`);
        assertIncludes(
          res.runs[0].stdout,
          "OK: All 4 proposals replicated, committed, and applied consistently across all 3 nodes."
        );

        // Sweep found the intentional Committed Log Truncation Race bug and stopped immediately
        assert.equal(res.passed, false, "Sweep must discover the intentional Raft bug in fatlotus/nodice");
        assert.ok(res.failedRun !== null);
        assert.deepEqual(
          res.runs[res.runs.length - 1],
          res.failedRun,
          "Sweep must stop immediately on first failure"
        );
        assert.notEqual(res.failedRun.exitCode, 0);
        assert.ok(
          Number(res.failedRun.virtualTimeNs) > 0,
          `Expected positive virtualTimeNs on failing Raft run, got ${res.failedRun.virtualTimeNs}`
        );
        const failCombined = `${res.failedRun.stdout}\n${res.failedRun.stderr}`;
        assertIncludes(
          failCombined,
          "INVARIANT VIOLATION (Committed Log Truncation Race)",
          "Failing run must report the intentional Raft bug"
        );

        // Fast simulated time check (sweep runs shouldn't wait real seconds per Raft timer/delay)
        assert.ok(
          sweepLoopWallMs < 180000,
          `Post-build sweep loop took unexpectedly long: ${sweepLoopWallMs.toFixed(0)}ms`
        );

        // Standalone deterministic reproduction with the exact failing (stddevMs, seed)
        const pulled = await waitWithTimeout(liveDocker.pullImage(image), 180000, "pull golang-with-cache");
        const container = await pulled.createContainer({
          gitRepo,
          cwd: "/workspace/example",
          tty: false,
        });
        try {
          const buildRes = await waitWithTimeout(
            container.exec({
              cmd: ["go", "build"],
              cwd: "/workspace/example",
              delayStddevMs: 0,
              delaySeed: 0,
            }),
            120000,
            "standalone go build"
          );
          assert.equal(buildRes.exitCode, 0, `Standalone go build failed: ${buildRes.stderr}`);

          const repro = await waitWithTimeout(
            container.exec({
              cmd: ["./raft"],
              cwd: "/workspace/example",
              delayStddevMs: res.failedRun.stddevMs,
              delaySeed: res.failedRun.seed,
              timeoutMs: 60000,
            }),
            90000,
            "standalone ./raft repro"
          );
          assert.equal(repro.exitCode, res.failedRun.exitCode);
          assertIncludes(
            `${repro.stdout}\n${repro.stderr}`,
            "INVARIANT VIOLATION (Committed Log Truncation Race)",
            "Standalone run with failing (stddevMs, seed) must deterministically reproduce the Raft bug"
          );
        } finally {
          await container.stop();
        }
      } finally {
        await liveServer.close();
        liveServer = null;
      }
    }
  );

  try {
    return await suite.run({ verbose: opts.verbose });
  } finally {
    if (browser) await browser.close();
    if (liveServer) await liveServer.close();
    if (offlineServer) await offlineServer.close();
    if (gitServer) await gitServer.close();
    if (registry) await registry.close();
  }
}
