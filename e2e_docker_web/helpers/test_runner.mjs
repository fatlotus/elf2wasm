// Shared opaque-box E2E test runner, assertions, ANSI stripper, and polling waiter.
// Zero external dependencies (Node.js 22 built-ins only).

import assert from "node:assert/strict";

export { assert };

/**
 * Strip ANSI CSI, OSC, and simple ESC sequences and normalize CRLF -> LF.
 * @param {string} str
 * @returns {string}
 */
export function stripAnsi(str) {
  if (typeof str !== "string") return "";
  return str
    // OSC sequences: ESC ] ... BEL or ESC \
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // DCS sequences: ESC P ... ESC \ or BEL
    .replace(/\x1bP[\s\S]*?(?:\x1b\\|\x07)/g, "")
    // ECMA-48 CSI sequences: ESC [ <param 0x30-0x3F>* <intermediate 0x20-0x2F>* <final 0x40-0x7E>
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    // Character set selection & simple 2-byte ESC sequences
    .replace(/\x1b[()][0-9A-Za-z]/g, "")
    .replace(/\x1b[=>c78DMENOH]/g, "")
    // Normalize CRLF -> LF
    .replace(/\r\n/g, "\n");
}

/**
 * Promise-based delay.
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll `fn()` until it returns a truthy value or `timeoutMs` elapses.
 * @template T
 * @param {() => T | Promise<T>} fn
 * @param {{ timeoutMs?: number, intervalMs?: number, label?: string }} [opts]
 * @returns {Promise<NonNullable<T>>}
 */
export async function waitFor(fn, opts = {}) {
  const {
    timeoutMs = 15000,
    intervalMs = 200,
    label = "condition",
  } = opts;

  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  let lastVal = undefined;

  while (true) {
    try {
      const val = await fn();
      lastVal = val;
      if (val) return val;
      lastErr = null;
    } catch (err) {
      lastErr = err;
    }

    if (Date.now() >= deadline) {
      const detail = lastErr
        ? ` (last error: ${lastErr.message || String(lastErr)})`
        : ` (last value: ${JSON.stringify(lastVal)})`;
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}${detail}`);
    }

    await sleep(intervalMs);
  }
}

/**
 * Race `promise` against a timeout of `ms` milliseconds and clear the timer in `.finally(...)`.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} [label]
 * @returns {Promise<T>}
 */
export function waitWithTimeout(promise, ms, label = "operation") {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timed out after ${ms}ms waiting for ${label}`));
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  });
}

export class SkipError extends Error {
  constructor(reason) {
    super(reason || "skipped");
    this.name = "SkipError";
  }
}

/**
 * Mark the current test as skipped.
 * @param {string} reason
 */
export function skip(reason) {
  throw new SkipError(reason);
}

/**
 * Assert that `haystack` includes `needle`.
 * @param {string} haystack
 * @param {string} needle
 * @param {string} [message]
 */
export function assertIncludes(haystack, needle, message) {
  const actual = String(haystack ?? "");
  if (!actual.includes(needle)) {
    const snippet = actual.length > 600
      ? `${actual.slice(0, 300)} ... [truncated ${actual.length - 600} chars] ... ${actual.slice(-300)}`
      : actual;
    assert.fail(
      `${message ? `${message}: ` : ""}expected string to include ${JSON.stringify(needle)}, got:\n${snippet}`
    );
  }
}

/**
 * Assert that `haystack` does NOT include `needle`.
 * @param {string} haystack
 * @param {string} needle
 * @param {string} [message]
 */
export function assertNotIncludes(haystack, needle, message) {
  const actual = String(haystack ?? "");
  if (actual.includes(needle)) {
    assert.fail(
      `${message ? `${message}: ` : ""}expected string NOT to include ${JSON.stringify(needle)}`
    );
  }
}

/**
 * Assert that `str` matches `regex`.
 * @param {string} str
 * @param {RegExp} regex
 * @param {string} [message]
 */
export function assertMatch(str, regex, message) {
  const actual = String(str ?? "");
  if (!regex.test(actual)) {
    const snippet = actual.length > 600 ? actual.slice(0, 600) + "..." : actual;
    assert.fail(
      `${message ? `${message}: ` : ""}expected string to match ${regex}, got:\n${snippet}`
    );
  }
}

/**
 * Format duration in seconds with 1 decimal place.
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Run a structured suite of tests sequentially.
 * @param {string} name
 * @param {Array<{ id?: string, name: string, fn: () => Promise<void> | void }>} tests
 * @param {{ verbose?: boolean, log?: (msg: string) => void }} [opts]
 */
export async function runSuite(name, tests, opts = {}) {
  const verbose = Boolean(opts.verbose);
  const log = opts.log || ((msg) => console.log(msg));

  const suiteStart = Date.now();
  const results = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  log(`\n--- ${name} (${tests.length} tests) ---`);

  for (const test of tests) {
    const label = test.id ? `[${test.id}] ${test.name}` : test.name;
    const t0 = Date.now();
    if (verbose) {
      log(`  RUN  ${label}`);
    }
    try {
      await test.fn();
      const durationMs = Date.now() - t0;
      passed += 1;
      results.push({
        id: test.id || null,
        name: test.name,
        status: "pass",
        durationMs,
        error: null,
        skipReason: null,
      });
      log(`  PASS ${label} (${durationMs}ms)`);
    } catch (err) {
      const durationMs = Date.now() - t0;
      if (err instanceof SkipError) {
        skipped += 1;
        results.push({
          id: test.id || null,
          name: test.name,
          status: "skip",
          durationMs,
          error: null,
          skipReason: err.message,
        });
        log(`  SKIP ${label}: ${err.message}`);
      } else {
        failed += 1;
        const errMsg = err && err.stack ? err.stack : String(err);
        results.push({
          id: test.id || null,
          name: test.name,
          status: "fail",
          durationMs,
          error: err && err.message ? err.message : String(err),
          stack: errMsg,
          skipReason: null,
        });
        log(`  FAIL ${label} (${durationMs}ms)`);
        log(`       ${err && err.message ? err.message : String(err)}`);
        if (verbose && err && err.stack) {
          for (const line of err.stack.split("\n").slice(1, 8)) {
            log(`       ${line}`);
          }
        }
      }
    }
  }

  const durationMs = Date.now() - suiteStart;
  return {
    name,
    passed,
    failed,
    skipped,
    total: tests.length,
    durationMs,
    results,
  };
}

/**
 * Helper class for incrementally building a suite of tests.
 */
export class Suite {
  constructor(name) {
    this.name = name;
    this.tests = [];
  }

  add(id, name, fn) {
    if (typeof name === "function") {
      this.tests.push({ id: null, name: id, fn: name });
    } else {
      this.tests.push({ id, name, fn });
    }
    return this;
  }

  async run(opts = {}) {
    return runSuite(this.name, this.tests, opts);
  }
}
