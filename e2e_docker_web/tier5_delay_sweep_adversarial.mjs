#!/usr/bin/env node
/**
 * Tier 5 White-Box Adversarial Regression Suite for Delay Injection,
 * Build/Run Split, Sweep Mode, and Web UI / URL Deep-Linking.
 *
 * Standalone executable:
 *   node e2e_docker_web/tier5_delay_sweep_adversarial.mjs
 *
 * Exit codes:
 *   0 = all tests passed
 *   1 = one or more tests failed
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { Suite, assert, assertIncludes, stripAnsi, waitFor } from "./helpers/test_runner.mjs";
import { startMockOciRegistry, buildOciImage } from "./helpers/mock_oci_registry.mjs";
import { createTarGz } from "./helpers/tar_builder.mjs";
import { REPO_ROOT, startServer, findChromeBinary } from "./helpers/server_harness.mjs";
import { launchCdpBrowser } from "./helpers/cdp_browser.mjs";
import {
  PROBE_CACHE_DIR,
  JS_CLI_PATH,
  registerDelaySweepOciImage,
  importDockerSdk,
  createSdkClient,
  runProcess,
  readDelaySweepDomState,
  readSweepRows,
  waitForSweepFinished,
  waitForSingleRunFinished,
} from "./delay_sweep_helpers.mjs";
import { pullImage as ociPullImage } from "../js/oci_client.mjs";

const RAND_PROBE_C = String.raw`
#define _GNU_SOURCE
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/auxv.h>
#include <unistd.h>

static void print_hex(const char *label, const unsigned char *buf, size_t len) {
    static const char hex[] = "0123456789abcdef";
    printf("%s=", label);
    for (size_t i = 0; i < len; i++) {
        putchar(hex[(buf[i] >> 4) & 0xF]);
        putchar(hex[buf[i] & 0xF]);
    }
    putchar('\n');
}

int main(void) {
    unsigned char urand[16];
    memset(urand, 0, sizeof(urand));
    int fd = open("/dev/urandom", O_RDONLY);
    if (fd >= 0) {
        ssize_t n = read(fd, urand, sizeof(urand));
        (void)n;
        close(fd);
    }
    print_hex("URANDOM", urand, sizeof(urand));

    const unsigned char *at_rand = (const unsigned char *)getauxval(AT_RANDOM);
    unsigned char aux[16];
    memset(aux, 0, sizeof(aux));
    if (at_rand != NULL) {
        memcpy(aux, at_rand, sizeof(aux));
    }
    print_hex("AT_RANDOM", aux, sizeof(aux));
    return 0;
}
`;

const EPOLL_SHUFFLE_PROBE_C = String.raw`
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <netinet/in.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#define NCONN 6

int main(void) {
    int lfd = socket(AF_INET, SOCK_STREAM, 0);
    if (lfd < 0) return 2;
    int opt = 1;
    setsockopt(lfd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = 0;
    if (bind(lfd, (struct sockaddr *)&addr, sizeof(addr)) != 0) return 3;
    if (listen(lfd, 16) != 0) return 4;

    socklen_t alen = sizeof(addr);
    if (getsockname(lfd, (struct sockaddr *)&addr, &alen) != 0) return 5;

    int epfd = epoll_create1(0);
    if (epfd < 0) return 6;

    int cfds[NCONN], sfds[NCONN];
    for (int i = 0; i < NCONN; i++) {
        cfds[i] = socket(AF_INET, SOCK_STREAM, 0);
        if (cfds[i] < 0) return 10 + i;
        if (connect(cfds[i], (struct sockaddr *)&addr, sizeof(addr)) != 0) return 20 + i;
        sfds[i] = accept(lfd, NULL, NULL);
        if (sfds[i] < 0) return 30 + i;

        struct epoll_event ev;
        memset(&ev, 0, sizeof(ev));
        ev.events = EPOLLIN;
        ev.data.u32 = (uint32_t)(i + 1);
        if (epoll_ctl(epfd, EPOLL_CTL_ADD, sfds[i], &ev) != 0) return 40 + i;
    }

    for (int i = 0; i < NCONN; i++) {
        char b = (char)('A' + i);
        if (write(cfds[i], &b, 1) != 1) return 50 + i;
    }

    struct timespec ts = { 1, 0 };
    nanosleep(&ts, NULL);

    struct epoll_event out[NCONN];
    int n = epoll_wait(epfd, out, NCONN, 1000);
    if (n != NCONN) {
        fprintf(stderr, "epoll_wait returned %d\n", n);
        return 60;
    }

    printf("READY=%d ORDER=", n);
    for (int i = 0; i < n; i++) {
        if (i > 0) putchar(',');
        printf("%u", out[i].data.u32);
    }
    putchar('\n');

    for (int i = 0; i < NCONN; i++) {
        close(cfds[i]);
        close(sfds[i]);
    }
    close(epfd);
    close(lfd);
    return 0;
}
`;

const PTHREAD_SCHED_PROBE_C = String.raw`
#define _GNU_SOURCE
#include <pthread.h>
#include <sched.h>
#include <stdatomic.h>
#include <stdio.h>

#define NTHREADS 5
#define NITERS 3

static atomic_int ready_count = 0;
static atomic_int log_idx = 0;
static int log_buf[NTHREADS * NITERS];

static void *worker(void *arg) {
    int id = (int)(long)arg;
    atomic_fetch_add(&ready_count, 1);
    while (atomic_load(&ready_count) < NTHREADS) {
        sched_yield();
    }
    for (int k = 0; k < NITERS; k++) {
        int pos = atomic_fetch_add(&log_idx, 1);
        if (pos < NTHREADS * NITERS) {
            log_buf[pos] = id;
        }
        sched_yield();
    }
    return NULL;
}

int main(void) {
    pthread_t th[NTHREADS];
    for (int i = 0; i < NTHREADS; i++) {
        if (pthread_create(&th[i], NULL, worker, (void *)(long)(i + 1)) != 0) {
            return 2 + i;
        }
    }
    for (int i = 0; i < NTHREADS; i++) {
        pthread_join(th[i], NULL);
    }
    int total = atomic_load(&log_idx);
    printf("SCHED=");
    for (int i = 0; i < total; i++) {
        if (i > 0) putchar(',');
        printf("%d", log_buf[i]);
    }
    putchar('\n');
    return 0;
}
`;

const KILL_PARENT_PROBE_C = `#include <signal.h>
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>

int main(void) {
    pid_t ppid = getpid();
    pid_t pid = fork();
    if (pid < 0) return 2;
    if (pid == 0) {
        kill(ppid, SIGKILL);
        _exit(0);
    }
    int status = 0;
    waitpid(pid, &status, 0);
    printf("SURVIVED\\n");
    return 0;
}
`;

function ensureRandProbe() {
  fs.mkdirSync(PROBE_CACHE_DIR, { recursive: true });
  const cPath = path.join(PROBE_CACHE_DIR, "t5_rand_probe.c");
  const elfPath = path.join(PROBE_CACHE_DIR, "t5_rand_probe");
  if (!fs.existsSync(cPath) || fs.readFileSync(cPath, "utf8") !== RAND_PROBE_C) {
    fs.writeFileSync(cPath, RAND_PROBE_C, "utf8");
    if (fs.existsSync(elfPath)) fs.unlinkSync(elfPath);
  }
  if (!fs.existsSync(elfPath)) {
    execFileSync("gcc", ["-O2", "-static", "-o", elfPath, cPath], { stdio: "pipe" });
  }
  return { elfPath };
}

async function setInputValue(browser, selector, value) {
  const ok = await browser.evaluate(
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.value = ${JSON.stringify(String(value))};
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`,
    { awaitPromise: false }
  );
  assert(ok, `Input element not found: ${selector}`);
}

async function runSuite() {
  const suite = new Suite("Tier 5 Adversarial Hardening — Delay Injection & Sweep Mode");
  const { Elf2WasmDocker, runSweep } = await importDockerSdk();

  let registry = null;
  let server = null;
  let mockImageRef = null;
  let chromeBinary = null;

  try {
    registry = await startMockOciRegistry({ requireAuth: false });
    mockImageRef = registerDelaySweepOciImage(registry);
    server = await startServer({ allowLocalRegistries: true });
    chromeBinary = findChromeBinary();

    // -----------------------------------------------------------------------
    // T5-A1: JS CLI determinism parity matrix (BUG-A1)
    // -----------------------------------------------------------------------
    suite.add("T5-A1: JS CLI determinism matrix & overflow rejection (BUG-A1)", async () => {
      const { elfPath } = ensureRandProbe();
      const matrix = [
        { stddev: "0", seed: "0", label: "zero-zero baseline" },
        { stddev: "0", seed: "1", label: "zero-stddev seed=1" },
        { stddev: "1", seed: "0", label: "stddev=1 seed=0" },
        { stddev: "1", seed: "18446744073709551615", label: "u64::MAX seed" },
        { stddev: "1e-3", seed: "42", label: "fractional 1e-3" },
        { stddev: "-0", seed: "0", label: "negative-zero stddev" },
      ];

      for (const tc of matrix) {
        const args = [
          JS_CLI_PATH,
          "run",
          "--elf",
          elfPath,
          `--delay-stddev-ms=${tc.stddev}`,
          `--delay-seed=${tc.seed}`,
        ];
        const run1 = await runProcess(process.execPath, args);
        const run2 = await runProcess(process.execPath, args);
        assert(
          run1.exitCode === 0 && run2.exitCode === 0,
          `${tc.label}: expected exit 0 (run1=${run1.exitCode}, run2=${run2.exitCode})`
        );
        assert(
          run1.stdout.trim() === run2.stdout.trim(),
          `${tc.label}: JS CLI determinism mismatch!\nRun1:\n${run1.stdout}\nRun2:\n${run2.stdout}`
        );
        assertIncludes(run1.stdout, "URANDOM=", `${tc.label}: URANDOM present`);
        assertIncludes(run1.stdout, "AT_RANDOM=", `${tc.label}: AT_RANDOM present`);
      }

      // Overflow rejections must fail non-zero on JS CLI
      const invalidCases = [
        ["--delay-stddev-ms", "1844674407371", "--delay-seed", "0"],
        ["--delay-stddev-ms", "1", "--delay-seed", "18446744073709551616"],
      ];
      for (const flags of invalidCases) {
        const jsBad = await runProcess(process.execPath, [
          JS_CLI_PATH,
          "run",
          "--elf",
          elfPath,
          ...flags,
        ]);
        assert(jsBad.exitCode !== 0, `JS CLI should reject ${flags.join(" ")}`);
      }
    });

    // -----------------------------------------------------------------------
    // T5-A2: runSweep() MAX_SAFE_INTEGER overflow, BigInt seeds & eager pre-pull validation (BUG-A2)
    // -----------------------------------------------------------------------
    suite.add(
      "T5-A2: runSweep() safe-int overflow rejection, BigInt seeds & eager pre-pull validation (BUG-A2)",
      async () => {
        const docker = await createSdkClient(server.url);
        try {
          const invalidSweepOpts = [
            {
              label: "MAX_SAFE_INTEGER + runs=3 overflow",
              opts: { runs: 3, stddevStart: 0, stddevStep: 0, seedStart: Number.MAX_SAFE_INTEGER },
            },
            {
              label: "seedStart=1e20",
              opts: { runs: 1, stddevStart: 0, stddevStep: 0, seedStart: 1e20 },
            },
            {
              label: "stddevStart=2e12",
              opts: { runs: 1, stddevStart: 2e12, stddevStep: 0, seedStart: 1 },
            },
            {
              label: "final stddev exceeds limit",
              opts: { runs: 3, stddevStart: 0, stddevStep: 1e12, seedStart: 1 },
            },
            {
              label: "BigInt u64 overflow",
              opts: { runs: 2, stddevStart: 0, stddevStep: 0, seedStart: 0xffff_ffff_ffff_ffffn },
            },
          ];

          for (const tc of invalidSweepOpts) {
            const stages = [];
            let err = null;
            try {
              await runSweep(mockImageRef, {
                docker,
                runCmd: ["/bin/true"],
                ...tc.opts,
                onProgress: (ev) => stages.push(ev.stage),
              });
            } catch (e) {
              err = e;
            }
            assert(err instanceof RangeError, `${tc.label}: expected RangeError, got ${err}`);
            assert(
              stages.length === 0,
              `${tc.label}: expected 0 pull/progress stages before validation error, got [${stages.join(", ")}]`
            );
          }

          // BigInt seedStart near MAX_SAFE_INTEGER should succeed with 3 distinct seeds
          const seenSeeds = [];
          const res = await runSweep(mockImageRef, {
            docker,
            runCmd: ["/bin/sh", "-c", "od -An -tx1 -N8 /dev/urandom"],
            runs: 3,
            stddevStart: 0,
            stddevStep: 0,
            seedStart: BigInt(Number.MAX_SAFE_INTEGER),
            onRunStart: ({ seed }) => seenSeeds.push(seed),
          });
          assert(res.passed, "BigInt seedStart sweep should pass");
          assert(res.runs.length === 3, `expected 3 runs, got ${res.runs.length}`);
          assert(
            seenSeeds[0] === 9007199254740991n &&
              seenSeeds[1] === 9007199254740992n &&
              seenSeeds[2] === 9007199254740993n,
            `unexpected BigInt seeds: ${seenSeeds.map(String).join(", ")}`
          );
          assert(
            res.runs[1].stdout !== res.runs[2].stdout,
            "runs 2 and 3 with distinct BigInt seeds must produce distinct /dev/urandom output"
          );
        } finally {
          await docker.dispose();
        }
      }
    );

    // -----------------------------------------------------------------------
    // T5-A3: WorkerBackend vs DirectBackend Error subclass parity (BUG-A3)
    // -----------------------------------------------------------------------
    suite.add(
      "T5-A3: WorkerBackend vs DirectBackend RangeError/TypeError subclass parity (BUG-A3)",
      async () => {
        // DirectBackend in Node
        const docker = await createSdkClient(server.url);
        try {
          const image = await docker.pullImage(mockImageRef);
          let err = null;
          try {
            await image.createContainer({ delayStddevMs: -5 });
          } catch (e) {
            err = e;
          }
          assert(err instanceof RangeError, `DirectBackend createContainer expected RangeError, got ${err}`);

          const c = await image.createContainer({ cmd: ["/bin/true"], tty: false, stdin: "" });
          try {
            let e1 = null;
            try {
              await c.exec({ cmd: ["/bin/true"], delayStddevMs: -5 });
            } catch (e) {
              e1 = e;
            }
            assert(e1 instanceof RangeError, `DirectBackend exec(-5) expected RangeError, got ${e1}`);

            let e2 = null;
            try {
              await c.exec({ cmd: "" });
            } catch (e) {
              e2 = e;
            }
            assert(e2 instanceof TypeError, `DirectBackend exec("") expected TypeError, got ${e2}`);

            let e3 = null;
            try {
              await c.restoreVfs(0);
            } catch (e) {
              e3 = e;
            }
            assert(e3 instanceof RangeError, `DirectBackend restoreVfs(0) expected RangeError, got ${e3}`);
          } finally {
            await c.stop();
            await image.dispose();
          }
        } finally {
          await docker.dispose();
        }

        // Real Web Worker (WorkerBackend) in Headless Chrome CDP
        assert(chromeBinary, "Chrome binary required for WorkerBackend test");
        const browser = await launchCdpBrowser({ chromePath: chromeBinary });
        try {
          await browser.navigate(`${server.url}/`);
          const workerRes = await browser.evaluate(
            `(async () => {
              const docker = await window.Elf2WasmDocker.create({ useWorker: true });
              try {
                const img = await docker.pullImage(${JSON.stringify(mockImageRef)});
                const checks = {};
                try {
                  await img.createContainer({ delayStddevMs: -5 });
                  checks.createRange = false;
                } catch (e) {
                  checks.createRange = e instanceof RangeError && e.name === "RangeError";
                }
                const c = await img.createContainer({ cmd: ["/bin/true"], tty: false, stdin: "" });
                try {
                  try {
                    await c.exec({ cmd: ["/bin/true"], delayStddevMs: -5 });
                    checks.execRange = false;
                  } catch (e) {
                    checks.execRange = e instanceof RangeError && e.name === "RangeError";
                  }
                  try {
                    await c.exec({ cmd: "" });
                    checks.execType = false;
                  } catch (e) {
                    checks.execType = e instanceof TypeError && e.name === "TypeError";
                  }
                  try {
                    await c.restoreVfs(0);
                    checks.restoreRange = false;
                  } catch (e) {
                    checks.restoreRange = e instanceof RangeError && e.name === "RangeError";
                  }
                  try {
                    await c.dropVfsSnapshot(0);
                    checks.dropRange = false;
                  } catch (e) {
                    checks.dropRange = e instanceof RangeError && e.name === "RangeError";
                  }
                } finally {
                  await c.stop();
                  await img.dispose();
                }
                return checks;
              } finally {
                await docker.dispose();
              }
            })()`,
            { awaitPromise: true }
          );
          assert(workerRes.createRange, "WorkerBackend createContainer(-5) must be instanceof RangeError");
          assert(workerRes.execRange, "WorkerBackend exec(-5) must be instanceof RangeError");
          assert(workerRes.execType, 'WorkerBackend exec("") must be instanceof TypeError');
          assert(workerRes.restoreRange, "WorkerBackend restoreVfs(0) must be instanceof RangeError");
          assert(workerRes.dropRange, "WorkerBackend dropVfsSnapshot(0) must be instanceof RangeError");
        } finally {
          await browser.close();
        }
      }
    );

    // -----------------------------------------------------------------------
    // T5-A4: oci_client.mjs transient socket-closure retry & non-retry rules (BUG-A4)
    // -----------------------------------------------------------------------
    suite.add(
      "T5-A4: oci_client.mjs fetchJson & fetchStreamedBlob transient socket retry (BUG-A4)",
      async () => {
        const layerTarGz = createTarGz([
          { path: "hello.txt", type: "file", mode: 0o644, content: "ok\n" },
        ]);
        const synthetic = buildOciImage({
          config: { Cmd: ["/bin/sh"], Env: ["PATH=/bin"] },
          layers: [layerTarGz],
        });
        registry.registerImage("t5/retry-test", "v1", synthetic);
        const retryRef = registry.imageRef("t5/retry-test", "v1");
        const proxyBase = `${server.url}/api/v2`;

        // 1. Transient UND_ERR_SOCKET on manifest fetchJson + ECONNRESET on blob fetchStreamedBlob
        let manifestAttempts = 0;
        let blobAttempts = 0;
        const flakyFetch = async (url, init) => {
          if (String(url).endsWith("/manifests/v1")) {
            manifestAttempts++;
            if (manifestAttempts === 1) {
              const err = new TypeError("fetch failed");
              err.cause = { code: "UND_ERR_SOCKET" };
              throw err;
            }
          } else if (String(url).includes("/blobs/") && !String(url).includes(synthetic.configDigest)) {
            blobAttempts++;
            if (blobAttempts === 1) {
              const err = new TypeError("fetch failed");
              err.cause = { code: "ECONNRESET" };
              throw err;
            }
          }
          return globalThis.fetch(url, init);
        };

        const pulled = await ociPullImage(retryRef, {
          registryProxyBase: proxyBase,
          fetchImpl: flakyFetch,
        });
        assert(manifestAttempts === 2, `expected 2 manifest attempts, got ${manifestAttempts}`);
        assert(blobAttempts === 2, `expected 2 layer blob attempts, got ${blobAttempts}`);
        assert(pulled.layers.length === 1, "expected 1 decompressed layer");

        // 2. Must NOT retry on AbortError
        let abortAttempts = 0;
        let abortErr = null;
        try {
          await ociPullImage(retryRef, {
            registryProxyBase: proxyBase,
            fetchImpl: async () => {
              abortAttempts++;
              const err = new Error("Aborted");
              err.name = "AbortError";
              throw err;
            },
          });
        } catch (e) {
          abortErr = e;
        }
        assert(abortErr && abortErr.name === "AbortError", `expected AbortError, got ${abortErr}`);
        assert(abortAttempts === 1, `must not retry on AbortError (attempts=${abortAttempts})`);

        // 3. Must NOT retry on HTTP 404 or 500
        for (const status of [404, 500]) {
          let httpAttempts = 0;
          let httpErr = null;
          try {
            await ociPullImage(retryRef, {
              registryProxyBase: proxyBase,
              fetchImpl: async () => {
                httpAttempts++;
                return new Response(JSON.stringify({ error: "fail" }), {
                  status,
                  statusText: status === 404 ? "Not Found" : "Internal Server Error",
                  headers: { "content-type": "application/json" },
                });
              },
            });
          } catch (e) {
            httpErr = e;
          }
          assert(httpErr instanceof Error, `expected error on HTTP ${status}`);
          assert(httpAttempts === 1, `must not retry on HTTP ${status} (attempts=${httpAttempts})`);
        }
      }
    );

    // -----------------------------------------------------------------------
    // T5-A5: createContainer() eager delay validation before VFS allocation (BUG-A5)
    // -----------------------------------------------------------------------
    suite.add(
      "T5-A5: createContainer() eager delay validation before VFS/overlay allocation (BUG-A5)",
      async () => {
        const docker = await createSdkClient(server.url);
        try {
          const image = await docker.pullImage(mockImageRef);
          try {
            for (const badOpts of [
              { delayStddevMs: -5 },
              { delaySeed: 1.5 },
              { delayStddevMs: Number.NaN },
              { delaySeed: -1 },
            ]) {
              const stages = [];
              let err = null;
              try {
                await image.createContainer({
                  ...badOpts,
                  onProgress: (ev) => stages.push(ev.stage),
                });
              } catch (e) {
                err = e;
              }
              assert(
                err instanceof RangeError,
                `createContainer(${JSON.stringify(badOpts)}) expected RangeError, got ${err}`
              );
              assert(
                stages.length === 0,
                `createContainer(${JSON.stringify(badOpts)}) should not extract VFS layers (stages=${stages})`
              );
            }
          } finally {
            await image.dispose();
          }
        } finally {
          await docker.dispose();
        }
      }
    );

    // -----------------------------------------------------------------------
    // T5-A6: Relative cwd / '..' / symlink executable resolution
    // -----------------------------------------------------------------------
    suite.add(
      "T5-A6: Relative cwd, '..' traversal, and relative symlink executable resolution",
      async () => {
        const docker = await createSdkClient(server.url);
        try {
          const image = await docker.pullImage(mockImageRef);
          const c = await image.createContainer({
            cmd: ["/bin/true"],
            tty: false,
            stdin: "",
          });
          try {
            const setup = await c.exec({
              cmd: [
                "/bin/sh",
                "-c",
                "mkdir -p /work/sub && cp /usr/local/bin/tcp_delay_probe /work/sub/probe && ln -sf sub/probe /work/link_probe",
              ],
              tty: false,
              stdin: "",
            });
            assert(setup.exitCode === 0, `setup failed: ${setup.stderr}`);

            for (const cwd of ["/work", "/work/"]) {
              for (const cmd of [["./sub/../sub/probe"], ["./link_probe"]]) {
                const res = await c.exec({
                  cmd,
                  cwd,
                  env: ["PATH=/usr/local/bin:/usr/bin:/bin", "PROBE_MODE=order", "SLEEP_MS=0"],
                  tty: false,
                  stdin: "",
                });
                assert(
                  res.exitCode === 0,
                  `exec(${cmd[0]}, cwd=${cwd}) failed with exit=${res.exitCode}: ${res.stderr}`
                );
                assertIncludes(res.stdout, "ORDER=", `exec(${cmd[0]}, cwd=${cwd}) stdout`);
              }
            }
          } finally {
            await c.stop();
            await image.dispose();
          }
        } finally {
          await docker.dispose();
        }
      }
    );

    // -----------------------------------------------------------------------
    // T5-A7: Immediate exec() after start() + wait() releases rec.busy before onExit
    // -----------------------------------------------------------------------
    suite.add(
      "T5-A7: Immediate exec() after start() + wait() has zero rec.busy microtask race",
      async () => {
        const docker = await createSdkClient(server.url);
        try {
          const image = await docker.pullImage(mockImageRef);
          try {
            for (let iter = 1; iter <= 5; iter++) {
              const c = await image.createContainer({
                cmd: ["/bin/sh", "-c", `echo START_${iter}`],
                tty: false,
                stdin: "",
              });
              try {
                await c.start();
                const waitRes = await c.wait();
                // Zero-delay immediate exec() on the very next microtask after wait() resolves
                const execRes = await c.exec({
                  cmd: ["/bin/sh", "-c", `echo EXEC_${iter}`],
                  tty: false,
                  stdin: "",
                });
                assert(
                  waitRes.exitCode === 0,
                  `iter ${iter}: start/wait expected exit 0, got ${waitRes.exitCode}`
                );
                assertIncludes(waitRes.stdout, `START_${iter}`, `iter ${iter}: wait stdout`);
                assert(
                  execRes.exitCode === 0,
                  `iter ${iter}: immediate exec() expected exit 0, got ${execRes.exitCode} (${execRes.stderr})`
                );
                assertIncludes(execRes.stdout, `EXEC_${iter}`, `iter ${iter}: exec stdout`);
              } finally {
                await c.stop();
              }
            }

            // FAIL-2 regression: verify startContainer()'s trailing .finally() does NOT clobber
            // rec.busy when an active exec() is launched immediately after await c.wait().
            const cLock = await image.createContainer({
              cmd: ["/bin/sh", "-c", "echo START_LOCK"],
              tty: false,
              stdin: "",
            });
            try {
              await cLock.start();
              const startRes = await cLock.wait();
              assert(
                startRes.exitCode === 0,
                `lock check: start/wait expected exit 0, got ${startRes.exitCode}`
              );

              // Launch an interactive exec() immediately after wait() resolves; it prints READY
              // and blocks on stdin until we feed it a line.
              let resolveReady;
              const readySeen = new Promise((resolve) => {
                resolveReady = resolve;
              });
              const decoder = new TextDecoder();
              let seenOut = "";
              const activeExecPromise = cLock.exec({
                cmd: ["/bin/sh", "-c", "echo READY; read line; echo EXEC_LOCK_OK_$line"],
                tty: true,
                onStdout: (chunk) => {
                  seenOut += decoder.decode(chunk, { stream: true });
                  if (seenOut.includes("READY")) resolveReady();
                },
              });

              // Flush several microtasks so startContainer()'s trailing .finally() runs while
              // activeExecPromise is still in flight.
              await Promise.resolve();
              await Promise.resolve();
              await Promise.resolve();

              // Both snapshotVfs() and a concurrent exec() MUST reject while first exec() is active.
              let snapRejected = false;
              let snapErrMsg = "";
              try {
                await cLock.snapshotVfs();
              } catch (err) {
                snapErrMsg = String(err?.message || err);
                snapRejected = /execution is active|active execution/i.test(snapErrMsg);
              }
              assert(
                snapRejected,
                `snapshotVfs() must reject while immediate post-wait exec() is still active (got: ${snapErrMsg || "resolved"})`
              );

              let concurrentExecRejected = false;
              let concurrentErrMsg = "";
              try {
                await cLock.exec({
                  cmd: ["/bin/sh", "-c", "echo CONCURRENT_SHOULD_FAIL"],
                  tty: false,
                  stdin: "",
                });
              } catch (err) {
                concurrentErrMsg = String(err?.message || err);
                concurrentExecRejected = /active execution|execution is active/i.test(concurrentErrMsg);
              }
              assert(
                concurrentExecRejected,
                `concurrent exec() must reject while immediate post-wait exec() is still active (got: ${concurrentErrMsg || "resolved"})`
              );

              // Wait until the first exec() has printed READY and is waiting on stdin, then unblock it.
              await Promise.race([
                readySeen,
                new Promise((_, rej) =>
                  setTimeout(() => rej(new Error("Timed out waiting for READY from active exec()")), 15000)
                ),
              ]);
              cLock.writeStdin("DONE\n");
              const activeRes = await activeExecPromise;
              assert(
                activeRes.exitCode === 0,
                `active exec() expected exit 0, got ${activeRes.exitCode} (${activeRes.stderr})`
              );
              assertIncludes(activeRes.stdout, "EXEC_LOCK_OK_DONE", "active exec() stdout");
            } finally {
              await cLock.stop();
            }
          } finally {
            await image.dispose();
          }
        } finally {
          await docker.dispose();
        }
      }
    );

    // -----------------------------------------------------------------------
    // Chrome CDP Tests for Challenger B Bugs (T5-B1 through T5-B6)
    // -----------------------------------------------------------------------
    assert(chromeBinary, "Chrome binary required for Tier 5 Web UI tests");

    // T5-B1: Clicking .preset-chip and .project-preset-chip after sweep resets & hides #sweep-panel
    suite.add(
      "T5-B1: Preset chips clear & hide #sweep-panel after completed sweep (BUG-B1)",
      async () => {
        const browser = await launchCdpBrowser({ chromePath: chromeBinary });
        try {
          const sweepUrl = `${server.url}/?image=${encodeURIComponent(mockImageRef)}&cmd=${encodeURIComponent('/bin/sh -c "echo OK_B1"')}&sweep=1&runs=2`;
          await browser.navigate(sweepUrl);
          await browser.click("#start-btn");
          const done = await waitForSweepFinished(browser, 90000);
          assert(done.rows.length === 2, `expected 2 sweep rows, got ${done.rows.length}`);
          assert(done.state.sweepPanelVisible, "#sweep-panel should be visible after sweep");

          // Click plain .preset-chip
          await browser.click('button.preset-chip[data-image="alpine:latest"]');
          const afterPlain = await browser.evaluate(
            `(() => ({
              panelHidden: Boolean(document.getElementById("sweep-panel")?.hidden),
              rowCount: document.querySelectorAll("#sweep-results-body tr").length,
              badgeOutcome: document.getElementById("sweep-outcome-badge")?.dataset?.outcome ?? "",
              badgeText: document.getElementById("sweep-outcome-badge")?.textContent?.trim() ?? "",
              buildStatus: document.getElementById("sweep-build-status")?.textContent?.trim() ?? "",
              sweepChecked: Boolean(document.getElementById("sweep-mode-toggle")?.checked),
            }))()`,
            { awaitPromise: false }
          );
          assert(afterPlain.panelHidden === true, `expected panel hidden after .preset-chip, got ${JSON.stringify(afterPlain)}`);
          assert(afterPlain.rowCount === 0, `expected 0 rows after .preset-chip, got ${afterPlain.rowCount}`);
          assert(afterPlain.badgeOutcome === "idle" && afterPlain.badgeText === "Idle", `expected idle/Idle badge, got ${JSON.stringify(afterPlain)}`);
          assert(afterPlain.buildStatus === "Build: —", `expected Build: —, got ${afterPlain.buildStatus}`);

          // Run again and click .project-preset-chip
          await browser.navigate(sweepUrl);
          await browser.click("#start-btn");
          await waitForSweepFinished(browser, 90000);
          await browser.click('button.project-preset-chip[data-preset="go-raft-nodice"]');
          const afterProject = await browser.evaluate(
            `(() => ({
              panelHidden: Boolean(document.getElementById("sweep-panel")?.hidden),
              rowCount: document.querySelectorAll("#sweep-results-body tr").length,
              badgeText: document.getElementById("sweep-outcome-badge")?.textContent?.trim() ?? "",
            }))()`,
            { awaitPromise: false }
          );
          assert(afterProject.panelHidden === true, "expected panel hidden after .project-preset-chip");
          assert(afterProject.rowCount === 0, "expected 0 rows after .project-preset-chip");
          assert(afterProject.badgeText === "Idle", `expected Idle badge, got ${afterProject.badgeText}`);
        } finally {
          await browser.close();
        }
      }
    );

    // T5-B2: Deep-linked selectedRun > actualRuns updates URL on early failure & build failure
    suite.add(
      "T5-B2: Deep-linked selectedRun > actualRuns syncs URL on early failure & build failure (BUG-B2)",
      async () => {
        const browser = await launchCdpBrowser({ chromePath: chromeBinary });
        try {
          // 1. Early failure on run #1 while deep-linked selectedRun=5
          const failRunUrl = `${server.url}/?image=${encodeURIComponent(mockImageRef)}&cmd=${encodeURIComponent('/bin/sh -c "echo FAIL_B2 && exit 1"')}&sweep=1&runs=5&selectedRun=5`;
          await browser.navigate(failRunUrl);
          await browser.click("#start-btn");
          const done = await waitForSweepFinished(browser, 90000);
          assert(done.rows.length === 1, `expected 1 row on run #1 failure, got ${done.rows.length}`);
          const paramsAfterFail = new URLSearchParams(done.state.search);
          assert(
            paramsAfterFail.get("selectedRun") === "1",
            `expected URL selectedRun=1 after early fail, got search=${done.state.search}`
          );

          // 2. Build failure (0 runs executed) while deep-linked selectedRun=5
          const failBuildUrl = `${server.url}/?image=${encodeURIComponent(mockImageRef)}&build=${encodeURIComponent('/bin/sh -c "exit 42"')}&cmd=${encodeURIComponent('/bin/sh -c "echo NEVER"')}&sweep=1&runs=5&selectedRun=5`;
          await browser.navigate(failBuildUrl);
          await browser.click("#start-btn");
          await waitFor(
            async () => {
              const st = await readDelaySweepDomState(browser);
              return st.stopDisabled && st.statusText.includes("Build failed") ? st : null;
            },
            { timeoutMs: 90000, intervalMs: 200, label: "build failure in sweep" }
          );
          const buildFailState = await readDelaySweepDomState(browser);
          const paramsAfterBuildFail = new URLSearchParams(buildFailState.search);
          assert(
            !paramsAfterBuildFail.has("selectedRun"),
            `expected selectedRun removed on build failure, got search=${buildFailState.search}`
          );
        } finally {
          await browser.close();
        }
      }
    );

    // T5-B3: Clicking #stop-btn mid-sweep transitions running row pill to stopped
    suite.add(
      "T5-B3: Clicking #stop-btn mid-sweep cleans up running row status (BUG-B3)",
      async () => {
        const browser = await launchCdpBrowser({ chromePath: chromeBinary });
        try {
          const slowCmd = '/bin/sh -c "i=0; while [ $i -lt 4000 ]; do i=$((i+1)); done; echo DONE"';
          const url = `${server.url}/?image=${encodeURIComponent(mockImageRef)}&cmd=${encodeURIComponent(slowCmd)}&sweep=1&runs=10`;
          await browser.navigate(url);
          await browser.click("#start-btn");

          // Wait until a row with data-status="running" appears
          await waitFor(
            async () => {
              const hasRunning = await browser.evaluate(
                `Boolean(document.querySelector('#sweep-results-body .run-status-pill[data-status="running"]'))`,
                { awaitPromise: false }
              );
              return hasRunning || null;
            },
            { timeoutMs: 90000, intervalMs: 50, label: "running sweep row" }
          );

          await browser.click("#stop-btn");
          await waitFor(
            async () => {
              const st = await readDelaySweepDomState(browser);
              return st.stopDisabled && !st.startDisabled ? st : null;
            },
            { timeoutMs: 15000, intervalMs: 100, label: "stop button completion" }
          );

          const postStop = await browser.evaluate(
            `(() => ({
              badge: document.getElementById("sweep-outcome-badge")?.textContent?.trim() ?? "",
              runningCount: document.querySelectorAll('#sweep-results-body .run-status-pill[data-status="running"]').length,
              stoppedCount: document.querySelectorAll('#sweep-results-body .run-status-pill[data-status="stopped"]').length,
              rows: Array.from(document.querySelectorAll("#sweep-results-body tr")).map((tr) => ({
                status: tr.querySelector(".run-status-pill")?.dataset?.status ?? "",
                exit: tr.querySelectorAll("td")[4]?.textContent?.trim() ?? "",
                time: tr.querySelectorAll("td")[5]?.textContent?.trim() ?? "",
              })),
            }))()`,
            { awaitPromise: false }
          );
          assert(postStop.badge === "Stopped", `expected Stopped badge, got ${postStop.badge}`);
          assert(
            postStop.runningCount === 0,
            `expected 0 rows stuck in running state, got ${JSON.stringify(postStop)}`
          );
          assert(
            postStop.stoppedCount >= 1,
            `expected >=1 row transitioned to stopped, got ${JSON.stringify(postStop)}`
          );
          for (const r of postStop.rows) {
            if (r.status === "stopped") {
              assert(r.exit === "—", `expected stopped row exit="—", got "${r.exit}"`);
              assert(r.time === "—", `expected stopped row time="—", got "${r.time}"`);
            }
          }
        } finally {
          await browser.close();
        }
      }
    );

    // T5-B4: Clicking currently-running row mid-sweep renders output immediately on completion
    suite.add(
      "T5-B4: Clicking currently-running row mid-sweep renders output immediately when it finishes (BUG-B4)",
      async () => {
        const browser = await launchCdpBrowser({ chromePath: chromeBinary });
        try {
          const markerCmd =
            '/bin/sh -c "echo START_MARKER_B4; i=0; while [ $i -lt 1500 ]; do i=$((i+1)); done; echo END_MARKER_B4"';
          const url = `${server.url}/?image=${encodeURIComponent(mockImageRef)}&cmd=${encodeURIComponent(markerCmd)}&sweep=1&runs=4`;
          await browser.navigate(url);
          await browser.click("#start-btn");

          // Wait for row #1 to appear in running state and click it immediately
          await waitFor(
            async () => {
              const row1Running = await browser.evaluate(
                `(() => {
                  const tr = document.querySelector('#sweep-results-body tr[data-run-index="1"]');
                  const pill = tr?.querySelector(".run-status-pill");
                  return pill?.dataset?.status === "running";
                })()`,
                { awaitPromise: false }
              );
              return row1Running || null;
            },
            { timeoutMs: 90000, intervalMs: 50, label: "row #1 running" }
          );

          await browser.click('#sweep-results-body tr[data-run-index="1"]');

          // Wait until row #1 finishes (while sweep may still be on run #2..4) and check terminal immediately
          const termAtRow1Finish = await waitFor(
            async () => {
              const info = await browser.evaluate(
                `(() => {
                  const tr = document.querySelector('#sweep-results-body tr[data-run-index="1"]');
                  const status = tr?.querySelector(".run-status-pill")?.dataset?.status ?? "";
                  const term = document.getElementById("terminal")?.innerText || document.getElementById("terminal")?.textContent || "";
                  return { status, term };
                })()`,
                { awaitPromise: false }
              );
              return info.status === "pass" ? info : null;
            },
            { timeoutMs: 90000, intervalMs: 50, label: "row #1 pass" }
          );

          const clean = stripAnsi(termAtRow1Finish.term);
          assertIncludes(clean, "START_MARKER_B4", "row #1 START_MARKER must render immediately");
          assertIncludes(clean, "END_MARKER_B4", "row #1 END_MARKER must render immediately");
          assertIncludes(clean, "[sweep run #1]", "row #1 header must render immediately");

          // Stop remaining runs cleanly
          await browser.click("#stop-btn");
        } finally {
          await browser.close();
        }
      }
    );

    // T5-B5: Out-of-bounds typed runs=5000 & seed=99999999999999999999 clamped & executable
    suite.add(
      "T5-B5: Out-of-bounds typed runs=5000 and seed=99999999999999999999 clamped & executable (BUG-B5)",
      async () => {
        const browser = await launchCdpBrowser({ chromePath: chromeBinary });
        try {
          const url = `${server.url}/?image=${encodeURIComponent(mockImageRef)}&cmd=${encodeURIComponent('/bin/sh -c "echo CLAMP_RUN && exit 1"')}&sweep=1`;
          await browser.navigate(url);
          await setInputValue(browser, "#sweep-runs-input", "5000");
          await setInputValue(browser, "#delay-seed-input", "99999999999999999999");

          const preRun = await browser.evaluate(
            `(() => ({
              search: window.location.search,
              progress: document.getElementById("sweep-progress-text")?.textContent?.trim() ?? "",
            }))()`,
            { awaitPromise: false }
          );
          const preParams = new URLSearchParams(preRun.search);
          assert(preParams.get("runs") === "1000", `expected URL runs=1000, got ${preRun.search}`);
          assert(
            preParams.get("seed") === String(Number.MAX_SAFE_INTEGER),
            `expected URL seed=MAX_SAFE_INTEGER, got ${preRun.search}`
          );
          assert(
            preRun.progress === "0 / 1000 runs",
            `expected progress "0 / 1000 runs", got "${preRun.progress}"`
          );

          await browser.click("#start-btn");
          const done = await waitForSweepFinished(browser, 90000);
          const badge = await browser.evaluate(
            `document.getElementById("sweep-outcome-badge")?.textContent?.trim() ?? ""`,
            { awaitPromise: false }
          );
          assert(
            badge === "Failed (#1)",
            `expected clean sweep failure on run #1 (no Invalid delaySeed crash), got badge="${badge}", status="${done.state.statusText}"`
          );
          assert(
            !done.state.statusText.includes("Invalid delaySeed"),
            `must not throw Invalid delaySeed: ${done.state.statusText}`
          );
        } finally {
          await browser.close();
        }
      }
    );

    // T5-B6: Single-run Build + Run mode (pass & fail)
    suite.add(
      "T5-B6: Single-run Build + Run mode (pass executes run, build fail aborts before run)",
      async () => {
        const browser = await launchCdpBrowser({ chromePath: chromeBinary });
        try {
          // 1. Passing build + run
          const passUrl = `${server.url}/?image=${encodeURIComponent(mockImageRef)}&build=${encodeURIComponent('/bin/sh -c "echo BUILT_SINGLE_OK > /tmp/built_t5.txt"')}&cmd=${encodeURIComponent('/bin/sh -c "cat /tmp/built_t5.txt"')}&stddev=1&seed=7`;
          await browser.navigate(passUrl);
          await browser.click("#start-btn");
          const passState = await waitForSingleRunFinished(browser, 90000);
          assertIncludes(
            stripAnsi(passState.terminalText),
            "BUILT_SINGLE_OK",
            "single-run build artifact must be visible to run command"
          );

          // 2. Failing build aborts before run command
          const failUrl = `${server.url}/?image=${encodeURIComponent(mockImageRef)}&build=${encodeURIComponent('/bin/sh -c "echo BUILD_ERR_T5 && exit 42"')}&cmd=${encodeURIComponent('/bin/sh -c "echo SHOULD_NOT_EXECUTE_T5"')}`;
          await browser.navigate(failUrl);
          await browser.click("#start-btn");
          const failState = await waitFor(
            async () => {
              const st = await readDelaySweepDomState(browser);
              return st.stopDisabled && st.statusText.includes("Build failed") ? st : null;
            },
            { timeoutMs: 90000, intervalMs: 200, label: "single-run build failure" }
          );
          assertIncludes(failState.statusText, "42", "expected exit 42 in build failure status");
          assert(
            !stripAnsi(failState.terminalText).includes("SHOULD_NOT_EXECUTE_T5"),
            "run command must NOT execute after build failure"
          );
        } finally {
          await browser.close();
        }
      }
    );

    // T5-B7: Silent buildCmd (/bin/true) transitions #sweep-build-status to "Build: passed (exit 0)" during run #1 & after stop
    suite.add(
      "T5-B7: Silent buildCmd transitions #sweep-build-status to passed during run #1 and preserves it after stop (BUG-4B-1)",
      async () => {
        const browser = await launchCdpBrowser({ chromePath: chromeBinary });
        try {
          const slowCmd = '/bin/sh -c "i=0; while [ $i -lt 4000 ]; do i=$((i+1)); done; echo DONE_B7"';
          const url = `${server.url}/?image=${encodeURIComponent(mockImageRef)}&build=${encodeURIComponent("/bin/true")}&cmd=${encodeURIComponent(slowCmd)}&sweep=1&runs=5`;
          await browser.navigate(url);
          await browser.click("#start-btn");

          // Wait until run #1 is actively running
          await waitFor(
            async () => {
              const hasRunning = await browser.evaluate(
                `Boolean(document.querySelector('#sweep-results-body .run-status-pill[data-status="running"]'))`,
                { awaitPromise: false }
              );
              return hasRunning || null;
            },
            { timeoutMs: 90000, intervalMs: 50, label: "running row #1 after silent build" }
          );

          const buildStatusDuringRun = await browser.evaluate(
            `document.getElementById("sweep-build-status")?.textContent?.trim() ?? ""`,
            { awaitPromise: false }
          );
          assert(
            buildStatusDuringRun === "Build: passed (exit 0)",
            `expected #sweep-build-status to be "Build: passed (exit 0)" during run #1, got "${buildStatusDuringRun}"`
          );

          await browser.click("#stop-btn");
          await waitFor(
            async () => {
              const st = await readDelaySweepDomState(browser);
              return st.stopDisabled && !st.startDisabled ? st : null;
            },
            { timeoutMs: 15000, intervalMs: 100, label: "stop after silent build" }
          );

          const buildStatusAfterStop = await browser.evaluate(
            `document.getElementById("sweep-build-status")?.textContent?.trim() ?? ""`,
            { awaitPromise: false }
          );
          assert(
            buildStatusAfterStop === "Build: passed (exit 0)",
            `expected #sweep-build-status to remain "Build: passed (exit 0)" after stop, got "${buildStatusAfterStop}"`
          );
        } finally {
          await browser.close();
        }
      }
    );

    // T5-B8: Stale #sweep-panel stays cleared/hidden after single-run bootImage() + typing AND after popstate to /
    suite.add(
      "T5-B8: Stale #sweep-panel stays cleared after single-run + input edit and after popstate to non-sweep URL (BUG-4B-2)",
      async () => {
        const browser = await launchCdpBrowser({ chromePath: chromeBinary });
        try {
          // Part A: Sweep -> uncheck -> single-run bootImage() -> type in #cmd-input
          const sweepUrl = `${server.url}/?image=${encodeURIComponent(mockImageRef)}&cmd=${encodeURIComponent('/bin/sh -c "echo OK_B8"')}&sweep=1&runs=2`;
          await browser.navigate(sweepUrl);
          await browser.click("#start-btn");
          const doneA = await waitForSweepFinished(browser, 90000);
          assert(doneA.rows.length === 2, `Part A: expected 2 sweep rows, got ${doneA.rows.length}`);

          await browser.click("#sweep-mode-toggle");
          await browser.click("#start-btn");
          await waitForSingleRunFinished(browser, 90000);

          await setInputValue(browser, "#cmd-input", '/bin/sh -c "echo TYPED_B8"');
          const afterTyping = await browser.evaluate(
            `(() => ({
              panelHidden: Boolean(document.getElementById("sweep-panel")?.hidden),
              rowCount: document.querySelectorAll("#sweep-results-body tr").length,
              badgeOutcome: document.getElementById("sweep-outcome-badge")?.dataset?.outcome ?? "",
              badgeText: document.getElementById("sweep-outcome-badge")?.textContent?.trim() ?? "",
              buildStatus: document.getElementById("sweep-build-status")?.textContent?.trim() ?? "",
            }))()`,
            { awaitPromise: false }
          );
          assert(
            afterTyping.panelHidden === true,
            `Part A: expected #sweep-panel hidden after typing, got ${JSON.stringify(afterTyping)}`
          );
          assert(
            afterTyping.rowCount === 0,
            `Part A: expected 0 sweep rows after single-run, got ${afterTyping.rowCount}`
          );
          assert(
            afterTyping.badgeOutcome === "idle" && afterTyping.badgeText === "Idle",
            `Part A: expected idle/Idle badge, got ${JSON.stringify(afterTyping)}`
          );
          assert(
            afterTyping.buildStatus === "Build: —",
            `Part A: expected Build: —, got ${afterTyping.buildStatus}`
          );

          // Part B: Root / -> pushState preset -> run sweep -> history.back() (popstate) to /
          await browser.navigate(`${server.url}/`);
          await browser.click('button.project-preset-chip[data-preset="go-raft-nodice"]');
          await setInputValue(browser, "#image-input", mockImageRef);
          await setInputValue(browser, "#repo-input", "");
          await setInputValue(browser, "#build-cmd-input", "");
          await setInputValue(browser, "#cmd-input", '/bin/sh -c "echo OK_B8_BACK"');
          await setInputValue(browser, "#cwd-input", "");
          await browser.click("#sweep-mode-toggle");
          await setInputValue(browser, "#sweep-runs-input", "2");
          await browser.click("#start-btn");
          const doneB = await waitForSweepFinished(browser, 90000);
          assert(doneB.rows.length === 2, `Part B: expected 2 sweep rows, got ${doneB.rows.length}`);

          await browser.evaluate(`window.history.back()`, { awaitPromise: false });
          const afterBack = await waitFor(
            async () => {
              const st = await browser.evaluate(
                `(() => ({
                  search: window.location.search,
                  sweepChecked: Boolean(document.getElementById("sweep-mode-toggle")?.checked),
                  panelHidden: Boolean(document.getElementById("sweep-panel")?.hidden),
                  rowCount: document.querySelectorAll("#sweep-results-body tr").length,
                  badgeOutcome: document.getElementById("sweep-outcome-badge")?.dataset?.outcome ?? "",
                  badgeText: document.getElementById("sweep-outcome-badge")?.textContent?.trim() ?? "",
                  buildStatus: document.getElementById("sweep-build-status")?.textContent?.trim() ?? "",
                }))()`,
                { awaitPromise: false }
              );
              return st.search === "" ? st : null;
            },
            { timeoutMs: 10000, intervalMs: 100, label: "popstate back to /" }
          );
          assert(afterBack.sweepChecked === false, `Part B: expected sweep unchecked, got ${JSON.stringify(afterBack)}`);
          assert(afterBack.panelHidden === true, `Part B: expected #sweep-panel hidden after back(), got ${JSON.stringify(afterBack)}`);
          assert(afterBack.rowCount === 0, `Part B: expected 0 rows after back(), got ${afterBack.rowCount}`);
          assert(
            afterBack.badgeOutcome === "idle" && afterBack.badgeText === "Idle",
            `Part B: expected idle/Idle badge after back(), got ${JSON.stringify(afterBack)}`
          );
          assert(
            afterBack.buildStatus === "Build: —",
            `Part B: expected Build: — after back(), got ${afterBack.buildStatus}`
          );
        } finally {
          await browser.close();
        }
      }
    );

    // T5-B9: Sweep with seed=Number.MAX_SAFE_INTEGER and runs=2 produces unique seeds <= MAX_SEED matching run-link query param
    suite.add(
      "T5-B9: Sweep with seed=MAX_SAFE_INTEGER and runs=2 executes unique seeds <= MAX_SEED matching run-link href (BUG-4B-3)",
      async () => {
        const browser = await launchCdpBrowser({ chromePath: chromeBinary });
        try {
          const maxSeed = Number.MAX_SAFE_INTEGER;
          const url = `${server.url}/?image=${encodeURIComponent(mockImageRef)}&cmd=${encodeURIComponent('/bin/sh -c "echo OK_B9"')}&sweep=1&runs=2&seed=${maxSeed}`;
          await browser.navigate(url);
          await browser.click("#start-btn");
          const done = await waitForSweepFinished(browser, 90000);
          assert(done.rows.length === 2, `expected 2 sweep rows, got ${done.rows.length}`);

          const rowDetails = await browser.evaluate(
            `Array.from(document.querySelectorAll("#sweep-results-body tr")).map((tr) => {
              const cells = tr.querySelectorAll("td");
              return {
                index: cells[0]?.textContent?.trim() ?? "",
                seedCell: cells[2]?.textContent?.trim() ?? "",
                status: tr.querySelector(".run-status-pill")?.dataset?.status ?? "",
                href: tr.querySelector("a.run-link")?.getAttribute("href") ?? "",
              };
            })`,
            { awaitPromise: false }
          );

          assert(rowDetails.length === 2, `expected 2 row details, got ${rowDetails.length}`);
          const seenSeeds = new Set();
          for (let i = 0; i < rowDetails.length; i++) {
            const row = rowDetails[i];
            assert(row.status === "pass", `row #${i + 1}: expected pass, got ${row.status}`);
            const expectedSeed = String(maxSeed - 1 + i);
            assert(
              row.seedCell === expectedSeed,
              `row #${i + 1}: expected seedCell=${expectedSeed}, got ${row.seedCell}`
            );
            const seedNum = Number(row.seedCell);
            assert(
              Number.isSafeInteger(seedNum) && seedNum <= maxSeed,
              `row #${i + 1}: seedCell must be safe integer <= MAX_SEED, got ${row.seedCell}`
            );
            seenSeeds.add(row.seedCell);

            const linkParams = new URL(row.href, server.url).searchParams;
            assert(
              linkParams.get("seed") === row.seedCell,
              `row #${i + 1}: run-link seed=${linkParams.get("seed")} does not match seedCell=${row.seedCell} (href=${row.href})`
            );
          }
          assert(
            seenSeeds.size === 2,
            `expected 2 unique seeds, got ${Array.from(seenSeeds).join(", ")}`
          );
        } finally {
          await browser.close();
        }
      }
    );

    // T5-A8: WASM32 JS CLI determinism on epoll_wait shuffle & pthread run_queue jitter
    suite.add(
      "T5-A8: WASM32 JS CLI determinism on 6-conn epoll_wait shuffle & 5-thread pthread jitter",
      async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "elf2wasm_t5_a8_"));
        try {
          const epollC = path.join(tmpDir, "epoll_shuffle_probe.c");
          const epollElf = path.join(tmpDir, "epoll_shuffle_probe");
          fs.writeFileSync(epollC, EPOLL_SHUFFLE_PROBE_C, "utf8");
          execFileSync("gcc", ["-O2", "-static", "-o", epollElf, epollC], { stdio: "pipe" });

          const schedC = path.join(tmpDir, "pthread_sched_probe.c");
          const schedElf = path.join(tmpDir, "pthread_sched_probe");
          fs.writeFileSync(schedC, PTHREAD_SCHED_PROBE_C, "utf8");
          execFileSync("gcc", ["-O2", "-static", "-pthread", "-o", schedElf, schedC], { stdio: "pipe" });

          const seeds = ["1", "2", "3", "4", "5"];

          // Probe 1: 6-connection TCP epoll_wait ready-event shuffle
          const epollOrders = new Set();
          for (const seed of seeds) {
            const args = [
              JS_CLI_PATH,
              "run",
              "--elf",
              epollElf,
              "--delay-stddev-ms=1",
              `--delay-seed=${seed}`,
            ];
            const run1 = await runProcess(process.execPath, args);
            const run2 = await runProcess(process.execPath, args);
            assert(
              run1.exitCode === 0 && run2.exitCode === 0,
              `epoll probe seed=${seed}: expected exit 0 (run1=${run1.exitCode}, run2=${run2.exitCode}, err1=${run1.stderr}, err2=${run2.stderr})`
            );
            const out1 = run1.stdout.trim();
            const out2 = run2.stdout.trim();
            assert(
              out1 === out2,
              `epoll probe seed=${seed}: WASM32 JS CLI determinism mismatch!\nRun1: ${out1}\nRun2: ${out2}`
            );
            assert(
              /^READY=6 ORDER=[1-6](,[1-6]){5}$/.test(out1),
              `epoll probe seed=${seed}: unexpected output format: ${out1}`
            );
            epollOrders.add(out1);
          }
          assert(
            epollOrders.size >= 2,
            `epoll probe: expected distinct orderings across seeds 1..5, got only ${epollOrders.size}: ${Array.from(epollOrders).join(" | ")}`
          );

          // Probe 2: 5-thread pthread + sched_yield execution order
          const schedOrders = new Set();
          for (const seed of seeds) {
            const args = [
              JS_CLI_PATH,
              "run",
              "--elf",
              schedElf,
              "--delay-stddev-ms=1",
              `--delay-seed=${seed}`,
            ];
            const run1 = await runProcess(process.execPath, args);
            const run2 = await runProcess(process.execPath, args);
            assert(
              run1.exitCode === 0 && run2.exitCode === 0,
              `pthread probe seed=${seed}: expected exit 0 (run1=${run1.exitCode}, run2=${run2.exitCode}, err1=${run1.stderr}, err2=${run2.stderr})`
            );
            const out1 = run1.stdout.trim();
            const out2 = run2.stdout.trim();
            assert(
              out1 === out2,
              `pthread probe seed=${seed}: WASM32 JS CLI determinism mismatch!\nRun1: ${out1}\nRun2: ${out2}`
            );
            assert(
              /^SCHED=[1-5](,[1-5]){14}$/.test(out1),
              `pthread probe seed=${seed}: unexpected output format: ${out1}`
            );
            schedOrders.add(out1);
          }
          assert(
            schedOrders.size >= 2,
            `pthread probe: expected distinct schedules across seeds 1..5, got only ${schedOrders.size}: ${Array.from(schedOrders).join(" | ")}`
          );
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      }
    );

    // T5-A9: Child SIGKILL terminating MAIN_PID returns exitCode 137 (NOT 0) in JS/WASM CLI (BUG-6A-1)
    suite.add(
      "T5-A9: Child SIGKILL to MAIN_PID returns exit code 137 in JS/WASM CLI (BUG-6A-1)",
      async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "elf2wasm_t5_a9_"));
        try {
          const cPath = path.join(tmpDir, "kill_parent.c");
          const elfPath = path.join(tmpDir, "kill_parent");
          fs.writeFileSync(cPath, KILL_PARENT_PROBE_C, "utf8");
          execFileSync("gcc", ["-O2", "-static", "-o", elfPath, cPath], { stdio: "pipe" });

          const jsRes = await runProcess(process.execPath, [JS_CLI_PATH, "run", "--elf", elfPath]);
          assert(
            jsRes.exitCode === 137,
            `JS/WASM CLI: expected exit code 137 on child SIGKILL to MAIN_PID, got ${jsRes.exitCode} (stdout=${JSON.stringify(jsRes.stdout)}, stderr=${JSON.stringify(jsRes.stderr)})`
          );
          assert(
            !jsRes.stdout.includes("SURVIVED"),
            `JS/WASM CLI: parent should not print SURVIVED after SIGKILL, got ${JSON.stringify(jsRes.stdout)}`
          );
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      }
    );

    // T5-B10: popstate between two sweep=1 URLs clears #sweep-panel rows/badge/links so zero SWEEP_B rows leak onto SWEEP_A (BUG-6B-1)
    suite.add(
      "T5-B10: popstate between two sweep=1 URLs clears #sweep-panel rows/badge/links (BUG-6B-1)",
      async () => {
        const browser = await launchCdpBrowser({ chromePath: chromeBinary });
        try {
          const urlA = `${server.url}/?image=${encodeURIComponent(mockImageRef)}&cmd=${encodeURIComponent('/bin/sh -c "echo SWEEP_A"')}&sweep=1&runs=2`;
          await browser.navigate(urlA);

          // Create a distinct history entry via preset click (pushState), then configure SWEEP_B with sweep=1
          await browser.click('button.preset-chip[data-image="alpine:latest"]');
          await setInputValue(browser, "#image-input", mockImageRef);
          await setInputValue(browser, "#cmd-input", '/bin/sh -c "echo SWEEP_B"');
          await browser.click("#sweep-mode-toggle");
          await setInputValue(browser, "#sweep-runs-input", "2");
          await browser.click("#start-btn");

          const doneB = await waitForSweepFinished(browser, 90000);
          assert(doneB.rows.length === 2, `expected 2 rows for SWEEP_B, got ${doneB.rows.length}`);

          await browser.evaluate(`window.history.back()`, { awaitPromise: false });
          const afterBack = await waitFor(
            async () => {
              const st = await browser.evaluate(
                `(() => ({
                  search: window.location.search,
                  cmd: document.getElementById("cmd-input")?.value ?? "",
                  sweepChecked: Boolean(document.getElementById("sweep-mode-toggle")?.checked),
                  rowCount: document.querySelectorAll("#sweep-results-body tr").length,
                  linkCount: document.querySelectorAll("#sweep-results-body a.run-link").length,
                  badgeOutcome: document.getElementById("sweep-outcome-badge")?.dataset?.outcome ?? "",
                  badgeText: document.getElementById("sweep-outcome-badge")?.textContent?.trim() ?? "",
                  buildStatus: document.getElementById("sweep-build-status")?.textContent?.trim() ?? "",
                }))()`,
                { awaitPromise: false }
              );
              return st.search.includes("SWEEP_A") ? st : null;
            },
            { timeoutMs: 10000, intervalMs: 100, label: "popstate back to SWEEP_A" }
          );

          assert(afterBack.cmd.includes("SWEEP_A"), `expected cmd to hydrate to SWEEP_A, got ${afterBack.cmd}`);
          assert(afterBack.sweepChecked === true, `expected sweepChecked=true on SWEEP_A, got ${JSON.stringify(afterBack)}`);
          assert(afterBack.rowCount === 0, `expected 0 rows after popstate to SWEEP_A, got ${afterBack.rowCount}`);
          assert(afterBack.linkCount === 0, `expected 0 run-links after popstate to SWEEP_A, got ${afterBack.linkCount}`);
          assert(
            afterBack.badgeOutcome === "idle" && afterBack.badgeText === "Idle",
            `expected idle/Idle badge after popstate to SWEEP_A, got ${JSON.stringify(afterBack)}`
          );
          assert(
            afterBack.buildStatus === "Build: —",
            `expected Build: — after popstate to SWEEP_A, got ${afterBack.buildStatus}`
          );
        } finally {
          await browser.close();
        }
      }
    );

    // T5-B11: Clicking .preset-chip mid-sweep cleanly cancels the in-flight sweep and never appends orphaned/corrupted rows (BUG-6B-2)
    suite.add(
      "T5-B11: Clicking .preset-chip mid-sweep cleanly cancels sweep and prevents orphaned/corrupted rows (BUG-6B-2)",
      async () => {
        const browser = await launchCdpBrowser({ chromePath: chromeBinary });
        try {
          const slowCmd = '/bin/sh -c "i=0; while [ $i -lt 4000 ]; do i=$((i+1)); done; echo RUN_B11"';
          const url = `${server.url}/?image=${encodeURIComponent(mockImageRef)}&cmd=${encodeURIComponent(slowCmd)}&sweep=1&runs=4`;
          await browser.navigate(url);
          await browser.click("#start-btn");

          // Wait until run #1 is actively running
          await waitFor(
            async () => {
              const hasRunning = await browser.evaluate(
                `Boolean(document.querySelector('#sweep-results-body .run-status-pill[data-status="running"]'))`,
                { awaitPromise: false }
              );
              return hasRunning || null;
            },
            { timeoutMs: 90000, intervalMs: 50, label: "running row #1 for T5-B11" }
          );

          // Click preset chip mid-sweep without clicking Stop
          await browser.click('button.preset-chip[data-image="alpine:latest"]');

          const immediate = await browser.evaluate(
            `(() => ({
              image: document.getElementById("image-input")?.value ?? "",
              panelHidden: Boolean(document.getElementById("sweep-panel")?.hidden),
              rowCount: document.querySelectorAll("#sweep-results-body tr").length,
              stopDisabled: Boolean(document.getElementById("stop-btn")?.disabled),
              startDisabled: Boolean(document.getElementById("start-btn")?.disabled),
            }))()`,
            { awaitPromise: false }
          );
          assert(immediate.image === "alpine:latest", `expected alpine:latest, got ${JSON.stringify(immediate)}`);
          assert(immediate.panelHidden === true, `expected #sweep-panel hidden, got ${JSON.stringify(immediate)}`);
          assert(immediate.rowCount === 0, `expected 0 rows immediately after preset click, got ${JSON.stringify(immediate)}`);
          assert(immediate.stopDisabled === true && immediate.startDisabled === false, `expected idle buttons, got ${JSON.stringify(immediate)}`);

          // Wait to verify the cancelled sweep does not append any orphaned or corrupted rows
          await new Promise((r) => setTimeout(r, 2000));
          const settled = await browser.evaluate(
            `(() => ({
              panelHidden: Boolean(document.getElementById("sweep-panel")?.hidden),
              rowCount: document.querySelectorAll("#sweep-results-body tr").length,
              linkHrefs: Array.from(document.querySelectorAll("#sweep-results-body a.run-link")).map((a) => a.getAttribute("href")),
              stopDisabled: Boolean(document.getElementById("stop-btn")?.disabled),
              startDisabled: Boolean(document.getElementById("start-btn")?.disabled),
            }))()`,
            { awaitPromise: false }
          );
          assert(settled.panelHidden === true, `expected #sweep-panel to stay hidden, got ${JSON.stringify(settled)}`);
          assert(settled.rowCount === 0, `expected 0 rows after waiting, got ${JSON.stringify(settled)}`);
          assert(settled.linkHrefs.length === 0, `expected 0 run-links after waiting, got ${JSON.stringify(settled)}`);
        } finally {
          await browser.close();
        }
      }
    );

    // T5-B12: Clicking #stop-btn during a slow buildCmd transitions #sweep-build-status to "Build: stopped" (BUG-6B-3)
    suite.add(
      "T5-B12: Clicking #stop-btn during slow buildCmd transitions #sweep-build-status to Build: stopped (BUG-6B-3)",
      async () => {
        const browser = await launchCdpBrowser({ chromePath: chromeBinary });
        try {
          const slowBuild = '/bin/sh -c "echo BUILDING_B12; i=0; while [ $i -lt 8000 ]; do i=$((i+1)); done; echo BUILD_DONE_B12"';
          const url = `${server.url}/?image=${encodeURIComponent(mockImageRef)}&build=${encodeURIComponent(slowBuild)}&cmd=${encodeURIComponent('/bin/sh -c "echo RUN_B12"')}&sweep=1&runs=3`;
          await browser.navigate(url);
          await browser.click("#start-btn");

          // Wait until build is actively running
          await waitFor(
            async () => {
              const status = await browser.evaluate(
                `document.getElementById("sweep-build-status")?.textContent?.trim() ?? ""`,
                { awaitPromise: false }
              );
              return status === "Build: running..." ? status : null;
            },
            { timeoutMs: 90000, intervalMs: 50, label: "Build: running... for T5-B12" }
          );

          await browser.click("#stop-btn");
          await waitFor(
            async () => {
              const st = await readDelaySweepDomState(browser);
              return st.stopDisabled && !st.startDisabled ? st : null;
            },
            { timeoutMs: 15000, intervalMs: 100, label: "stop during slow buildCmd" }
          );

          const afterStop = await browser.evaluate(
            `(() => ({
              buildStatus: document.getElementById("sweep-build-status")?.textContent?.trim() ?? "",
              badgeText: document.getElementById("sweep-outcome-badge")?.textContent?.trim() ?? "",
              badgeOutcome: document.getElementById("sweep-outcome-badge")?.dataset?.outcome ?? "",
            }))()`,
            { awaitPromise: false }
          );
          assert(
            afterStop.buildStatus === "Build: stopped",
            `expected #sweep-build-status to be "Build: stopped", got ${JSON.stringify(afterStop)}`
          );
          assert(
            afterStop.badgeText === "Stopped" && afterStop.badgeOutcome === "idle",
            `expected Stopped/idle badge after stop, got ${JSON.stringify(afterStop)}`
          );
        } finally {
          await browser.close();
        }
      }
    );

    const summary = await suite.run({ verbose: true });
    console.log(
      `\nSummary: ${summary.passed}/${summary.total} passed, ${summary.failed} failed, ${summary.skipped} skipped (${(summary.durationMs / 1000).toFixed(1)}s)`
    );
    return summary.failed === 0 ? 0 : 1;
  } finally {
    if (server) await server.close();
    if (registry) await registry.close();
  }
}

runSuite()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("Fatal error in Tier 5 adversarial suite:", err);
    process.exit(1);
  });
