#!/usr/bin/env node
// Unified CLI runner for the F41 Delay Injection, Build/Run Split, Sweep Mode & Linkable Runs
// opaque-box 4-tier E2E test suite.
// Exit codes:
//   0 = all executed tests passed
//   1 = one or more test assertions failed
//   2 = prerequisite / environment / CLI usage error

import fs from "node:fs";
import path from "node:path";
import { formatDuration } from "./helpers/test_runner.mjs";
import { checkPrerequisites } from "./helpers/server_harness.mjs";

function printHelp() {
  console.log(`Usage: node e2e_docker_web/run_delay_sweep_e2e.mjs [options]

Options:
  --tier <1|2|3|4|all>   Run a specific tier or all tiers sequentially (default: all)
  --self-test            Verify F41 harness, static C probe, mock OCI/Git & Chrome CDP only (independent of M16-M18)
  --skip-live            Skip live GHCR + GitHub Tier 4 scenario (T4-DS-3: fatlotus/nodice) for strictly offline runs
  --verbose, -v          Stream detailed test progress and diagnostics
  --json <file>          Write machine-readable JSON results summary to <file>
  --help, -h             Print usage and exit 0

Exit Codes:
  0  All executed tests passed
  1  One or more test assertions failed
  2  Prerequisite, environment, or CLI usage error`);
}

function parseArgs(argv) {
  const opts = {
    tier: "all",
    selfTest: false,
    skipLive: false,
    verbose: false,
    jsonFile: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--self-test") {
      opts.selfTest = true;
    } else if (arg === "--skip-live") {
      opts.skipLive = true;
    } else if (arg === "--verbose" || arg === "-v") {
      opts.verbose = true;
    } else if (arg === "--tier") {
      const next = argv[++i];
      if (!next || !["1", "2", "3", "4", "all"].includes(next)) {
        throw new Error(`Invalid --tier value: ${next || "(missing)"}. Expected 1, 2, 3, 4, or all.`);
      }
      opts.tier = next;
    } else if (arg.startsWith("--tier=")) {
      const val = arg.slice("--tier=".length);
      if (!["1", "2", "3", "4", "all"].includes(val)) {
        throw new Error(`Invalid --tier value: ${val}. Expected 1, 2, 3, 4, or all.`);
      }
      opts.tier = val;
    } else if (arg === "--json") {
      const next = argv[++i];
      if (!next) {
        throw new Error("Missing file path after --json");
      }
      opts.jsonFile = next;
    } else if (arg.startsWith("--json=")) {
      const val = arg.slice("--json=".length);
      if (!val) {
        throw new Error("Missing file path after --json=");
      }
      opts.jsonFile = val;
    } else {
      throw new Error(`Unknown CLI argument: ${arg}`);
    }
  }

  return opts;
}

function printSummary(suites, totalDurationMs) {
  console.log("\n=== elf2wasm Delay Injection & Sweep Mode E2E Summary ===");
  let totalPassed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;

  for (const s of suites) {
    totalPassed += s.passed;
    totalFailed += s.failed;
    totalSkipped += s.skipped;
    const status = s.failed === 0 ? "PASS" : "FAIL";
    const padded = s.name.padEnd(44, " ");
    const skipStr = s.skipped > 0 ? `, ${s.skipped} skipped` : "";
    console.log(`${padded}: ${status} (${s.passed}/${s.total}${skipStr}, ${formatDuration(s.durationMs)})`);
  }

  console.log(
    `${"TOTAL".padEnd(44, " ")}: ${totalPassed} passed, ${totalFailed} failed, ${totalSkipped} skipped (${formatDuration(totalDurationMs)})`
  );
  return { totalPassed, totalFailed, totalSkipped };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`CLI Error: ${err.message}`);
    printHelp();
    process.exit(2);
  }

  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  const startAll = Date.now();
  const suites = [];

  if (opts.selfTest) {
    const { runDelaySweepSelfTest } = await import("./delay_sweep_helpers.mjs");
    suites.push(await runDelaySweepSelfTest({ verbose: opts.verbose }));
  } else {
    const selectedTiers = opts.tier === "all" ? ["1", "2", "3", "4"] : [opts.tier];
    // All 4 tiers include headless Chrome CDP tests for Contract 13 URL/UI linking.
    const prereq = checkPrerequisites({ requireChrome: true });

    if (!prereq.ok) {
      console.error("Prerequisite check failed — cannot run F41 Delay/Sweep E2E tiers:");
      for (const item of prereq.missing) {
        console.error(`  - Missing ${item}`);
      }
      console.error(
        "\nBuild M16-M18 artifacts first, or run `node e2e_docker_web/run_delay_sweep_e2e.mjs --self-test` to verify E2E harness infrastructure."
      );
      process.exit(2);
    }

    for (const tier of selectedTiers) {
      if (tier === "1") {
        const { runDelaySweepTier1 } = await import("./test_delay_sweep_tier1.mjs");
        suites.push(await runDelaySweepTier1({ verbose: opts.verbose, skipLive: opts.skipLive }));
      } else if (tier === "2") {
        const { runDelaySweepTier2 } = await import("./test_delay_sweep_tier2.mjs");
        suites.push(await runDelaySweepTier2({ verbose: opts.verbose, skipLive: opts.skipLive }));
      } else if (tier === "3") {
        const { runDelaySweepTier3 } = await import("./test_delay_sweep_tier3.mjs");
        suites.push(await runDelaySweepTier3({ verbose: opts.verbose, skipLive: opts.skipLive }));
      } else if (tier === "4") {
        const { runDelaySweepTier4 } = await import("./test_delay_sweep_tier4.mjs");
        suites.push(await runDelaySweepTier4({ verbose: opts.verbose, skipLive: opts.skipLive }));
      }
    }
  }

  const totalDurationMs = Date.now() - startAll;
  const totals = printSummary(suites, totalDurationMs);

  if (opts.jsonFile) {
    const outPath = path.resolve(opts.jsonFile);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(
      outPath,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          options: opts,
          durationMs: totalDurationMs,
          ...totals,
          suites,
        },
        null,
        2
      )
    );
  }

  process.exit(totals.totalFailed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`Fatal E2E runner error: ${err && err.stack ? err.stack : err}`);
  process.exit(2);
});
