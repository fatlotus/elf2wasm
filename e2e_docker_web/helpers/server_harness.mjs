// Server harness and prerequisite checks for e2e_docker_web.
// Spawns server/server.mjs on an ephemeral free port on 127.0.0.1 and polls /api/health.
// Zero external dependencies (Node.js 22 built-ins only).

import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sleep } from "./test_runner.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "../..");

export const REQUIRED_ARTIFACTS = {
  compilerWasm: path.join(REPO_ROOT, "target/wasm32-unknown-unknown/release/elf2wasm_compiler_wasm.wasm"),
  runtimeWasm: path.join(REPO_ROOT, "target/wasm32-unknown-unknown/release/elf2wasm_runtime_wasm.wasm"),
  workerWasm: path.join(REPO_ROOT, "target/wasm32-unknown-unknown/release/elf2wasm_worker_wasm.wasm"),
  serverEntry: path.join(REPO_ROOT, "server/server.mjs"),
  dockerSdk: path.join(REPO_ROOT, "js/docker_sdk.mjs"),
  dockerfileModule: path.join(REPO_ROOT, "web/dockerfile.mjs"),
  webIndex: path.join(REPO_ROOT, "web/index.html"),
};

/**
 * Discover a usable Chrome/Chromium binary on this machine.
 * @returns {string | null}
 */
export function findChromeBinary() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.CHROME_BIN,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Verify required built artifacts (and Chrome if required) exist.
 * @param {{ requireChrome?: boolean, requireWorkerWasm?: boolean, requireDockerfile?: boolean }} [opts]
 * @returns {{ ok: boolean, missing: string[], chromePath: string | null, paths: typeof REQUIRED_ARTIFACTS }}
 */
export function checkPrerequisites(opts = {}) {
  const {
    requireChrome = false,
    requireWorkerWasm = false,
    requireDockerfile = false,
  } = opts;
  const missing = [];

  const keysToCheck = [
    "compilerWasm",
    "runtimeWasm",
    "serverEntry",
    "dockerSdk",
    "webIndex",
  ];
  if (requireWorkerWasm) keysToCheck.push("workerWasm");
  if (requireDockerfile) keysToCheck.push("dockerfileModule");

  for (const key of keysToCheck) {
    const filePath = REQUIRED_ARTIFACTS[key];
    if (!fs.existsSync(filePath)) {
      missing.push(`${key}: ${path.relative(REPO_ROOT, filePath)}`);
    }
  }

  const chromePath = findChromeBinary();
  if (requireChrome && !chromePath) {
    missing.push("chrome: no Chrome/Chromium binary found (checked CHROME_PATH, CHROME_BIN, /usr/bin/google-chrome, /usr/bin/chromium)");
  }

  return {
    ok: missing.length === 0,
    missing,
    chromePath,
    paths: REQUIRED_ARTIFACTS,
  };
}

/**
 * Allocate an ephemeral free TCP port on 127.0.0.1.
 * @returns {Promise<number>}
 */
export async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

/**
 * Start `server/server.mjs` on an ephemeral port and wait until `/api/health` returns 200 OK.
 * @param {{ allowLocalRegistries?: boolean, env?: Record<string, string>, host?: string, port?: number, timeoutMs?: number }} [opts]
 */
export async function startServer(opts = {}) {
  const {
    allowLocalRegistries = false,
    env = {},
    host = "127.0.0.1",
    port = 0,
    timeoutMs = 15000,
  } = opts;

  if (!fs.existsSync(REQUIRED_ARTIFACTS.serverEntry)) {
    throw new Error(`Missing server entrypoint: ${REQUIRED_ARTIFACTS.serverEntry}`);
  }

  const chosenPort = port === 0 ? await getFreePort() : port;
  const args = [
    REQUIRED_ARTIFACTS.serverEntry,
    "--host",
    host,
    "--port",
    String(chosenPort),
  ];
  if (allowLocalRegistries) {
    args.push("--allow-local-registries");
  }

  const childEnv = { ...process.env, ...env };
  if (!allowLocalRegistries) {
    delete childEnv.ALLOW_LOCAL_REGISTRIES;
  }

  const proc = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdoutLines = [];
  const stderrLines = [];
  let exited = false;
  let exitInfo = null;

  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");

  proc.stdout.on("data", (chunk) => {
    for (const line of chunk.split(/\r?\n/)) {
      if (line.length > 0) stdoutLines.push(line);
    }
  });

  proc.stderr.on("data", (chunk) => {
    for (const line of chunk.split(/\r?\n/)) {
      if (line.length > 0) stderrLines.push(line);
    }
  });

  const exitPromise = new Promise((resolve) => {
    proc.once("exit", (code, signal) => {
      exited = true;
      exitInfo = { code, signal };
      resolve(exitInfo);
    });
  });

  const url = `http://${host}:${chosenPort}`;
  const healthUrl = `${url}/api/health`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(
        `server/server.mjs exited prematurely (${JSON.stringify(exitInfo)})\n` +
        `stdout:\n${stdoutLines.join("\n")}\nstderr:\n${stderrLines.join("\n")}`
      );
    }
    try {
      const resp = await fetch(healthUrl, { signal: AbortSignal.timeout(1000) });
      if (resp.status === 200) {
        return {
          url,
          host,
          port: chosenPort,
          allowLocalRegistries,
          proc,
          stdoutLines,
          stderrLines,
          getLogs() {
            return [...stdoutLines, ...stderrLines].join("\n");
          },
          async close() {
            if (exited) return;
            try {
              proc.kill("SIGTERM");
            } catch {
              // ignore
            }
            const timedOut = await Promise.race([
              exitPromise.then(() => false),
              sleep(3000).then(() => true),
            ]);
            if (timedOut && !exited) {
              try {
                proc.kill("SIGKILL");
              } catch {
                // ignore
              }
              await Promise.race([exitPromise, sleep(1000)]);
            }
          },
        };
      }
    } catch {
      // retry until ready
    }
    await sleep(100);
  }

  try {
    proc.kill("SIGKILL");
  } catch {
    // ignore
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${healthUrl}\n` +
    `stdout:\n${stdoutLines.join("\n")}\nstderr:\n${stderrLines.join("\n")}`
  );
}
