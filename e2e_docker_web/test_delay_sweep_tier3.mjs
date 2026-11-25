// Tier 3: Opaque-Box Cross-Feature Pairwise Combinations for F41
// Combines Build/Run Split, CoW VFS Snapshot Isolation, Simulated-Time Delay Injection,
// Git Repo Overlay, Sweep Mode, URL Deep-Linking, and Chrome CDP Web UI.
// 5 comprehensive offline combination tests (T3-DS-1..T3-DS-5).

import {
  Suite,
  assert,
  assertIncludes,
  assertNotIncludes,
  stripAnsi,
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
  readDelaySweepDomState,
  setCheckboxValue,
  readSweepRows,
  waitForSweepFinished,
  waitForSingleRunFinished,
} from "./delay_sweep_helpers.mjs";

export const TIER3_TEST_COUNT = 5;

export async function runDelaySweepTier3(opts = {}) {
  const suite = new Suite("Tier 3: Delay/Sweep Cross-Feature Combinations");

  let registry = null;
  let gitServer = null;
  let server = null;
  let browser = null;
  let imageRef = null;
  let gitRepoUrl = null;
  let sdk = null;
  let docker = null;

  async function ensureEnv() {
    if (server && registry && gitServer && sdk && docker) return;
    registry = await startMockOciRegistry();
    imageRef = registerDelaySweepOciImage(registry, "delay-sweep/tcp-race", "v1");
    gitServer = await startMockGitServer();
    gitRepoUrl = registerDelaySweepGitRepo(gitServer, "acme/sweep-proj");
    server = await startServer({ allowLocalRegistries: true });
    sdk = await importDockerSdk();
    docker = await createSdkClient(server.url);
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

  suite.add(
    "T3-DS-1",
    "Build/Run Split + Sweep Mode + Snapshot Isolation + Standalone Deterministic Reproduction",
    async () => {
      await ensureEnv();
      const buildCmd = [
        "/bin/sh",
        "-c",
        "echo BUILT >> /tmp/build.log && cp /opt/tcp_race_probe /workspace/probe && chmod +x /workspace/probe",
      ];
      const runCmd = ["./probe", "--mode=race", "--conns=6"];
      const env = [
        "REQUIRE_BUILD_LOG=/tmp/build.log",
        "DIRTY_MARKER=/tmp/run_dirty.marker",
        "SLEEP_MS=50",
      ];

      const res = await waitWithTimeout(
        sdk.runSweep(
          imageRef,
          sweepOpts({
            buildCmd,
            runCmd,
            cwd: "/workspace",
            env,
            runs: 10,
            stddevStart: 0,
            stddevStep: 1,
            seedStart: 1,
            stopOnFailure: true,
          })
        ),
        120000,
        "T3-DS-1 runSweep"
      );

      assert.equal(res.build.exitCode, 0, `Build failed: ${res.build.stderr}`);
      assert.equal(res.build.skipped, false);
      assert.equal(res.runs[0].exitCode, 0, `Baseline stddev=0 run must pass: ${res.runs[0].stderr}`);
      assertIncludes(res.runs[0].stdout, "BUILD_LINES=1");
      assertIncludes(res.runs[0].stdout, "ORDER=1,2,3,4,5,6");
      assertNotIncludes(res.runs[0].stderr, "SNAPSHOT_LEAK");

      assert.equal(res.passed, false, "Sweep must detect multi-connection TCP reordering race");
      assert.ok(res.failedRun !== null);
      assert.ok(res.runs.length >= 2, `Expected failure on run >=2, got runs.length=${res.runs.length}`);
      assert.deepEqual(res.runs[res.runs.length - 1], res.failedRun, "Sweep must stop immediately on first failure");
      assert.equal(res.failedRun.exitCode, 1);
      assertIncludes(res.failedRun.stderr, "INVARIANT_VIOLATION");
      assertIncludes(res.failedRun.stdout, "BUILD_LINES=1");
      for (const r of res.runs) {
        assertNotIncludes(r.stderr, "SNAPSHOT_LEAK");
      }

      // Standalone reproduction on a fresh container with the exact failing (stddevMs, seed)
      const img = await docker.pullImage(imageRef);
      const container = await img.createContainer({ cwd: "/workspace", env, tty: false });
      try {
        const b = await waitWithTimeout(
          container.exec({ cmd: buildCmd, cwd: "/workspace", env, delayStddevMs: 0, delaySeed: 0 }),
          60000,
          "repro build"
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
          "repro exec"
        );
        assert.equal(repro.exitCode, res.failedRun.exitCode);
        assert.equal(
          parseProbeMetric(repro.stdout, "ORDER"),
          parseProbeMetric(res.failedRun.stdout, "ORDER"),
          "Standalone repro must produce identical packet arrival ORDER"
        );
        assert.equal(repro.stdout, res.failedRun.stdout);
        assert.equal(repro.stderr, res.failedRun.stderr);
      } finally {
        await container.stop();
      }
    }
  );

  suite.add(
    "T3-DS-2",
    "Git Repo Overlay + Build/Run Split + Relative cwd + Sweep Mode + Failed-Build Abort",
    async () => {
      await ensureEnv();
      const beforeReqs = gitServer.getRequests().length;

      const res = await waitWithTimeout(
        sdk.runSweep(
          imageRef,
          sweepOpts({
            gitRepo: { repo: gitRepoUrl, ref: "main", mountPath: "/workspace" },
            cwd: "/workspace/subapp",
            buildCmd: ["/bin/sh", "build.sh"],
            runCmd: ["./app", "--mode=race", "--conns=6"],
            env: [
              "REQUIRE_BUILD_LOG=/workspace/subapp/.build_count",
              "DIRTY_MARKER=/tmp/dirty_git_sweep",
            ],
            runs: 10,
            stddevStart: 0,
            stddevStep: 1,
            seedStart: 10,
            stopOnFailure: true,
          })
        ),
        120000,
        "T3-DS-2 git overlay sweep"
      );

      const newGitReqs = gitServer
        .getRequests()
        .slice(beforeReqs)
        .filter((r) => r.server === "forge");
      assert.equal(newGitReqs.length, 1, `Git archive must be fetched once, got ${newGitReqs.length}`);
      assert.equal(gitServer.leakedAuthCount(), 0);
      assert.equal(res.build.exitCode, 0, `Git build.sh failed: ${res.build.stderr}`);
      assertIncludes(res.build.stdout, "BUILT_APP_READY");
      assert.equal(res.runs[0].exitCode, 0);
      assertIncludes(res.runs[0].stdout, "BUILD_LINES=1");
      assert.equal(res.passed, false);
      assert.ok(res.failedRun !== null);
      assert.ok(res.runs.length >= 2);
      assertIncludes(res.failedRun.stderr, "INVARIANT_VIOLATION");

      // Failed-build abort on the same git repo
      const failBuildRes = await waitWithTimeout(
        sdk.runSweep(
          imageRef,
          sweepOpts({
            gitRepo: { repo: gitRepoUrl, ref: "main", mountPath: "/workspace" },
            cwd: "/workspace/subapp",
            buildCmd: ["/bin/sh", "-c", "echo COMPILE_FAILED >&2; exit 2"],
            runCmd: ["./app", "--mode=race"],
            runs: 5,
          })
        ),
        60000,
        "T3-DS-2 failed build abort"
      );

      assert.equal(failBuildRes.build.exitCode, 2);
      assert.equal(failBuildRes.passed, false);
      assert.equal(failBuildRes.runs.length, 0);
      assert.equal(failBuildRes.failedRun, null);
      assertIncludes(failBuildRes.build.stderr, "COMPILE_FAILED");
    }
  );

  suite.add(
    "T3-DS-3",
    "Chrome CDP: Sweep URL -> #sweep-panel Execution -> selectedRun Row Click -> a.run-link Standalone Repro",
    async () => {
      const b = await ensureBrowser();
      b.clearLogs();

      const buildStr = "cp /opt/tcp_race_probe /tmp/probe && chmod +x /tmp/probe";
      const runStr = "/tmp/probe --mode=race --conns=6";
      const q = new URLSearchParams({
        image: imageRef,
        build: buildStr,
        cmd: runStr,
        sweep: "1",
        runs: "10",
        stddevStart: "0",
        stddevStep: "1",
        seed: "1",
      });

      await b.navigate(`${server.url}/?${q.toString()}`);
      await b.waitForSelector("#sweep-mode-toggle");

      const hydrated = await readDelaySweepDomState(b);
      assert.equal(hydrated.build, buildStr);
      assert.equal(hydrated.cmd, runStr);
      assert.equal(hydrated.sweep, true);
      assert.equal(hydrated.runs, "10");
      assert.equal(hydrated.stddevStart, "0");
      assert.equal(hydrated.stddevStep, "1");
      assert.equal(hydrated.seed, "1");
      assert.equal(hydrated.statusState, "idle", "Must not auto-boot");
      const preReqs = b.networkRequests.filter((r) => r.url.includes("/api/v2/"));
      assert.equal(preReqs.length, 0);

      // Start sweep
      await b.click("#start-btn");
      const { rows } = await waitForSweepFinished(b, 150000);

      assert.ok(rows.length >= 2, `Expected >=2 sweep rows (PASS then FAIL), got ${rows.length}`);
      assert.ok(rows.length < 10, `Sweep should stop on first failure, got ${rows.length} rows`);

      // Click Row 1 (baseline PASS)
      await b.click("#sweep-results-body tr:nth-child(1)");
      const afterRow1 = await readDelaySweepDomState(b);
      assertIncludes(stripAnsi(afterRow1.terminalText), "ORDER=1,2,3,4,5,6");
      assert.equal(new URLSearchParams(afterRow1.search).get("selectedRun"), "1");

      // Click last row (failing run k)
      const k = rows.length;
      await b.click(`#sweep-results-body tr:nth-child(${k})`);
      const afterRowK = await readDelaySweepDomState(b);
      const failTermText = stripAnsi(afterRowK.terminalText);
      assertIncludes(failTermText, "INVARIANT_VIOLATION");
      assert.equal(new URLSearchParams(afterRowK.search).get("selectedRun"), String(k));
      const failingOrder = parseProbeMetric(failTermText, "ORDER");
      assert.ok(failingOrder, `Expected ORDER= in failing row terminal output:\n${failTermText}`);

      // Inspect a.run-link on failing row
      const failRow = rows[k - 1];
      assert.ok(failRow.runLinkHref, "Failing row must contain a.run-link href");
      const linkUrl = new URL(failRow.runLinkFullHref);
      assert.equal(linkUrl.searchParams.get("image"), imageRef);
      assert.equal(linkUrl.searchParams.get("build"), buildStr);
      assert.equal(linkUrl.searchParams.get("cmd"), runStr);
      assert.ok(linkUrl.searchParams.has("stddev"), "run-link must include stddev");
      assert.ok(linkUrl.searchParams.has("seed"), "run-link must include seed");
      for (const forbidden of ["sweep", "runs", "stddevStart", "stddevStep", "selectedRun"]) {
        assert.equal(linkUrl.searchParams.has(forbidden), false, `run-link must omit ${forbidden}`);
      }

      // Navigate to a.run-link and reproduce standalone
      b.clearLogs();
      await b.navigate(failRow.runLinkFullHref);
      await b.waitForSelector("#delay-stddev-input");
      const reproHydrated = await readDelaySweepDomState(b);
      assert.equal(reproHydrated.sweep, false);
      assert.equal(reproHydrated.stddev, linkUrl.searchParams.get("stddev"));
      assert.equal(reproHydrated.seed, linkUrl.searchParams.get("seed"));
      assert.equal(reproHydrated.statusState, "idle");

      await b.click("#start-btn");
      const reproDone = await waitForSingleRunFinished(b, 120000);
      const reproTerm = stripAnsi(reproDone.terminalText);
      assertIncludes(reproTerm, "INVARIANT_VIOLATION");
      assert.equal(
        parseProbeMetric(reproTerm, "ORDER"),
        failingOrder,
        "Standalone reproducer link must reproduce the exact same ORDER permutation"
      );
      assert.equal(b.exceptions.length, 0, `Unexpected browser exceptions: ${JSON.stringify(b.exceptions)}`);
    }
  );

  suite.add(
    "T3-DS-4",
    "Chrome CDP: go-raft-nodice Project Preset -> Reload Hydration -> Plain .preset-chip Reset",
    async () => {
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
      assert.equal(after.historyLength, before.historyLength + 1);

      // Reload generated URL and verify identical hydration without auto-boot
      const generatedUrl = `${server.url}/${after.search}`;
      b.clearLogs();
      await b.navigate(generatedUrl);
      await b.waitForSelector("#build-cmd-input");
      const reloaded = await readDelaySweepDomState(b);
      assert.equal(reloaded.image, "ghcr.io/fatlotus/golang-with-cache:1.27-alpine");
      assert.equal(reloaded.repo, "fatlotus/nodice");
      assert.equal(reloaded.cwd, "/workspace/example");
      assert.equal(reloaded.build, "go build");
      assert.equal(reloaded.cmd, "./raft");
      assert.equal(reloaded.statusState, "idle");

      // Click plain image preset chip -> must reset all fields
      await b.click('button.preset-chip[data-image="alpine:latest"]');
      const reset = await readDelaySweepDomState(b);
      assert.equal(reset.image, "alpine:latest");
      assert.equal(reset.build, "");
      assert.equal(reset.cmd, "");
      assert.equal(reset.repo, "");
      assert.equal(reset.cwd, "");
      assert.equal(reset.sweep, false);
      assert.ok(reset.stddev === "" || reset.stddev === "0");
      assert.equal(reset.search, "");
      assert.equal(reset.activeElementId, "image-input");
    }
  );

  suite.add(
    "T3-DS-5",
    "Chrome CDP: Backward-Compatible ?cmd=/?run=, #copy-sweep-link-btn, and popstate Sweep <-> Single-Run",
    async () => {
      const b = await ensureBrowser();
      b.clearLogs();

      // 1. Legacy ?cmd= URL
      await b.navigate(
        `${server.url}/?image=ghcr.io%2Ffatlotus%2Fgolang-with-cache%3A1.27-alpine&cmd=%2Fbin%2Fsh+-c+%22go+build+%26%26+.%2Fraft%22&repo=fatlotus%2Fnodice&cwd=%2Fworkspace%2Fexample`
      );
      await b.waitForSelector("#cmd-input");
      let st = await readDelaySweepDomState(b);
      assert.equal(st.cmd, '/bin/sh -c "go build && ./raft"');
      assert.equal(st.build, "");
      assert.equal(st.sweep, false);

      // 2. ?run= alias canonicalizes to cmd= on live edit
      await b.navigate(`${server.url}/?image=alpine%3Alatest&build=go+build&run=.%2Fraft&stddev=5&seed=42`);
      await b.waitForSelector("#delay-seed-input");
      st = await readDelaySweepDomState(b);
      assert.equal(st.cmd, "./raft");
      assert.equal(st.build, "go build");
      assert.equal(st.stddev, "5");
      assert.equal(st.seed, "42");
      await b.setInputValue("#delay-seed-input", "43");
      st = await readDelaySweepDomState(b);
      const editedParams = new URLSearchParams(st.search);
      assert.equal(editedParams.get("cmd"), "./raft");
      assert.equal(editedParams.has("run"), false, "Editing must serialize canonical cmd, not run");

      // 3. Toggle sweep mode + test #copy-sweep-link-btn
      await setCheckboxValue(b, "#sweep-mode-toggle", true);
      await b.setInputValue("#sweep-runs-input", "12");
      await b.setInputValue("#sweep-stddev-start-input", "2");
      await b.setInputValue("#sweep-stddev-step-input", "2");

      const copiedUrl = await b.evaluate(
        `(async () => {
          let captured = null;
          const orig = navigator.clipboard?.writeText?.bind(navigator.clipboard);
          Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: {
              writeText: async (text) => { captured = text; },
            },
          });
          const btn = document.getElementById("copy-sweep-link-btn");
          if (!btn) return null;
          btn.click();
          await new Promise((r) => setTimeout(r, 50));
          if (orig) {
            Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: orig } });
          }
          return captured;
        })()`,
        { awaitPromise: true }
      );
      assert.ok(typeof copiedUrl === "string" && copiedUrl.length > 0, "#copy-sweep-link-btn must copy a URL");
      const copiedParams = new URL(copiedUrl).searchParams;
      assert.equal(copiedParams.get("sweep"), "1");
      assert.equal(copiedParams.get("runs"), "12");
      assert.equal(copiedParams.get("stddevStart"), "2");
      assert.equal(copiedParams.get("stddevStep"), "2");

      // 4. popstate Sweep <-> Single-Run transition
      await b.evaluate(
        `(() => {
          window.history.pushState(null, "", "/?image=alpine%3Alatest&build=make&cmd=.%2Ftest&stddev=8&seed=99");
          window.dispatchEvent(new PopStateEvent("popstate"));
        })()`,
        { awaitPromise: false }
      );
      const singleSt = await readDelaySweepDomState(b);
      assert.equal(singleSt.sweep, false);
      assert.equal(singleSt.stddev, "8");
      assert.equal(singleSt.seed, "99");
      assert.equal(singleSt.build, "make");

      await b.evaluate(
        `(() => {
          window.history.pushState(null, "", "/?image=alpine%3Alatest&build=make&cmd=.%2Ftest&sweep=1&runs=15&stddevStart=0.5&stddevStep=1.5&seed=3");
          window.dispatchEvent(new PopStateEvent("popstate"));
        })()`,
        { awaitPromise: false }
      );
      const sweepSt = await readDelaySweepDomState(b);
      assert.equal(sweepSt.sweep, true);
      assert.equal(sweepSt.runs, "15");
      assert.equal(sweepSt.stddevStart, "0.5");
      assert.equal(sweepSt.stddevStep, "1.5");
      assert.equal(sweepSt.seed, "3");
      assert.equal(b.exceptions.length, 0);
    }
  );

  try {
    return await suite.run({ verbose: opts.verbose });
  } finally {
    if (browser) await browser.close();
    if (server) await server.close();
    if (gitServer) await gitServer.close();
    if (registry) await registry.close();
  }
}
