// Shared opaque-box E2E helpers, deterministic static C probe fixture,
// mock OCI/Git fixture builders, Chrome CDP DOM helpers, and self-test suite
// for F41 (Delay Injection, Build/Run Split, Sweep Mode & Linkable Runs).
// Zero external dependencies (Node.js 22 built-ins + existing e2e_docker_web/helpers/*).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  Suite,
  assert,
  assertIncludes,
  stripAnsi,
  waitFor,
  waitWithTimeout,
} from "./helpers/test_runner.mjs";
import { createTarGz } from "./helpers/tar_builder.mjs";
import {
  loadDockerBaseImage,
  buildOciImage,
  startMockOciRegistry,
} from "./helpers/mock_oci_registry.mjs";
import {
  startMockGitServer,
  buildGitRepoArchive,
} from "./helpers/mock_git_server.mjs";
import {
  REPO_ROOT,
  startServer,
  findChromeBinary,
} from "./helpers/server_harness.mjs";
import { launchCdpBrowser } from "./helpers/cdp_browser.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROBE_CACHE_DIR = "/tmp/elf2wasm-e2e-cache/delay-sweep";
export const JS_CLI_PATH = path.join(REPO_ROOT, "js", "cli.mjs");

// Compact static x86-64 C probe exercising real non-blocking IPv4 TCP loopback,
// epoll_pwait, CLOCK_MONOTONIC, nanosleep, and /dev/urandom.
const TCP_DELAY_PROBE_C = String.raw`
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static uint64_t mono_ns(void) {
    struct timespec ts;
    if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) {
        return 0;
    }
    return (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;
}

static void sleep_ms(long ms) {
    if (ms <= 0) return;
    struct timespec req;
    req.tv_sec = ms / 1000;
    req.tv_nsec = (ms % 1000) * 1000000L;
    while (nanosleep(&req, &req) == -1 && errno == EINTR) {
    }
}

static int set_nonblock(int fd) {
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags < 0) return -1;
    return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

static void read_rand_hex(char out[17]) {
    unsigned char buf[8];
    memset(buf, 0, sizeof(buf));
    int fd = open("/dev/urandom", O_RDONLY);
    if (fd >= 0) {
        ssize_t n = read(fd, buf, sizeof(buf));
        (void)n;
        close(fd);
    }
    static const char hex[] = "0123456789abcdef";
    for (int i = 0; i < 8; i++) {
        out[i * 2] = hex[(buf[i] >> 4) & 0xF];
        out[i * 2 + 1] = hex[buf[i] & 0xF];
    }
    out[16] = '\0';
}

static int open_loopback_listener(uint16_t *out_port) {
    int lfd = socket(AF_INET, SOCK_STREAM | SOCK_NONBLOCK, 0);
    if (lfd < 0) {
        perror("socket");
        return -1;
    }
    int one = 1;
    setsockopt(lfd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = 0;

    if (bind(lfd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        perror("bind");
        close(lfd);
        return -1;
    }
    if (listen(lfd, 64) != 0) {
        perror("listen");
        close(lfd);
        return -1;
    }

    socklen_t alen = sizeof(addr);
    if (getsockname(lfd, (struct sockaddr *)&addr, &alen) != 0) {
        perror("getsockname");
        close(lfd);
        return -1;
    }
    *out_port = ntohs(addr.sin_port);
    return lfd;
}

static int connect_loopback(uint16_t port) {
    int cfd = socket(AF_INET, SOCK_STREAM | SOCK_NONBLOCK, 0);
    if (cfd < 0) return -1;
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = htons(port);

    int rc = connect(cfd, (struct sockaddr *)&addr, sizeof(addr));
    if (rc < 0 && errno != EINPROGRESS) {
        close(cfd);
        return -1;
    }
    return cfd;
}

static int wait_readable(int epfd, int fd) {
    struct epoll_event ev;
    memset(&ev, 0, sizeof(ev));
    ev.events = EPOLLIN;
    ev.data.fd = fd;
    if (epoll_ctl(epfd, EPOLL_CTL_ADD, fd, &ev) != 0) {
        return -1;
    }
    struct epoll_event out[4];
    int n = 0;
    for (;;) {
        n = epoll_pwait(epfd, out, 4, -1, NULL);
        if (n < 0 && errno == EINTR) continue;
        break;
    }
    epoll_ctl(epfd, EPOLL_CTL_DEL, fd, NULL);
    return n > 0 ? 0 : -1;
}

static int read_exact_nb(int epfd, int fd, char *buf, size_t len) {
    size_t got = 0;
    while (got < len) {
        ssize_t n = read(fd, buf + got, len - got);
        if (n > 0) {
            got += (size_t)n;
            continue;
        }
        if (n == 0) {
            return -1;
        }
        if (errno == EAGAIN || errno == EWOULDBLOCK) {
            if (wait_readable(epfd, fd) != 0) return -1;
            continue;
        }
        if (errno == EINTR) continue;
        return -1;
    }
    return 0;
}

static int check_env_guards(void) {
    const char *dirty = getenv("DIRTY_MARKER");
    if (dirty && dirty[0] != '\0') {
        struct stat st;
        if (stat(dirty, &st) == 0) {
            fprintf(stderr, "SNAPSHOT_LEAK: dirty marker already exists: %s\n", dirty);
            return 2;
        }
        int fd = open(dirty, O_CREAT | O_WRONLY | O_TRUNC, 0644);
        if (fd >= 0) {
            const char *msg = "dirty\n";
            (void)write(fd, msg, 6);
            close(fd);
        }
    }

    const char *build_log = getenv("REQUIRE_BUILD_LOG");
    if (build_log && build_log[0] != '\0') {
        FILE *fp = fopen(build_log, "r");
        if (!fp) {
            fprintf(stderr, "MISSING_BUILD_LOG: %s\n", build_log);
            return 3;
        }
        int lines = 0;
        int ch;
        while ((ch = fgetc(fp)) != EOF) {
            if (ch == '\n') lines++;
        }
        fclose(fp);
        printf("BUILD_LINES=%d\n", lines);
        if (lines != 1) {
            fprintf(stderr, "BUILD_COUNT_ERROR: expected 1 line, got %d\n", lines);
            return 3;
        }
    }

    const char *sleep_env = getenv("SLEEP_MS");
    if (sleep_env && sleep_env[0] != '\0') {
        long ms = strtol(sleep_env, NULL, 10);
        if (ms > 0) sleep_ms(ms);
    }
    return 0;
}

static int run_timing_exchange(int iters, uint64_t *out_elapsed_ns) {
    uint16_t port = 0;
    int lfd = open_loopback_listener(&port);
    if (lfd < 0) return 1;

    int epfd = epoll_create1(0);
    if (epfd < 0) {
        close(lfd);
        return 1;
    }

    int cfd = connect_loopback(port);
    if (cfd < 0) {
        close(epfd);
        close(lfd);
        return 1;
    }

    int sfd = -1;
    for (int tries = 0; tries < 200 && sfd < 0; tries++) {
        sfd = accept4(lfd, NULL, NULL, SOCK_NONBLOCK);
        if (sfd < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            if (wait_readable(epfd, lfd) != 0) break;
        }
    }
    if (sfd < 0) {
        close(cfd);
        close(epfd);
        close(lfd);
        return 1;
    }

    uint64_t t0 = mono_ns();
    for (int i = 0; i < iters; i++) {
        char ping[8] = "PING00\n";
        ping[4] = (char)('0' + (i % 10));
        char buf[8];
        if (write(cfd, ping, 7) != 7) {
            close(sfd); close(cfd); close(epfd); close(lfd);
            return 1;
        }
        if (read_exact_nb(epfd, sfd, buf, 7) != 0) {
            close(sfd); close(cfd); close(epfd); close(lfd);
            return 1;
        }
        if (write(sfd, buf, 7) != 7) {
            close(sfd); close(cfd); close(epfd); close(lfd);
            return 1;
        }
        if (read_exact_nb(epfd, cfd, buf, 7) != 0) {
            close(sfd); close(cfd); close(epfd); close(lfd);
            return 1;
        }
    }
    uint64_t t1 = mono_ns();
    *out_elapsed_ns = (t1 >= t0) ? (t1 - t0) : 0;

    close(sfd);
    close(cfd);
    close(epfd);
    close(lfd);
    return 0;
}

static int run_multi_conn(int conns, int check_race) {
    if (conns < 2) conns = 2;
    if (conns > 16) conns = 16;

    uint64_t t0 = mono_ns();
    int guard_rc = check_env_guards();
    if (guard_rc != 0) return guard_rc;

    uint16_t port = 0;
    int lfd = open_loopback_listener(&port);
    if (lfd < 0) return 1;

    int epfd = epoll_create1(0);
    if (epfd < 0) {
        close(lfd);
        return 1;
    }

    int cfds[16];
    int sfds[16];
    int received[16];
    int order[16];
    int order_len = 0;

    for (int i = 0; i < conns; i++) {
        cfds[i] = -1;
        sfds[i] = -1;
        received[i] = 0;
        order[i] = 0;
    }

    for (int i = 0; i < conns; i++) {
        cfds[i] = connect_loopback(port);
        if (cfds[i] < 0) {
            fprintf(stderr, "connect failed at %d\n", i);
            return 1;
        }
        for (int tries = 0; tries < 200 && sfds[i] < 0; tries++) {
            sfds[i] = accept4(lfd, NULL, NULL, SOCK_NONBLOCK);
            if (sfds[i] < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
                if (wait_readable(epfd, lfd) != 0) break;
            }
        }
        if (sfds[i] < 0) {
            fprintf(stderr, "accept failed at %d\n", i);
            return 1;
        }
        set_nonblock(sfds[i]);
        struct epoll_event ev;
        memset(&ev, 0, sizeof(ev));
        ev.events = EPOLLIN;
        ev.data.u32 = (uint32_t)i;
        if (epoll_ctl(epfd, EPOLL_CTL_ADD, sfds[i], &ev) != 0) {
            perror("epoll_ctl ADD");
            return 1;
        }
    }

    // Send tagged messages sequentially across independent client connections.
    for (int i = 0; i < conns; i++) {
        char msg[8];
        int len = snprintf(msg, sizeof(msg), "%d\n", i + 1);
        if (write(cfds[i], msg, (size_t)len) != len) {
            perror("write");
            return 1;
        }
        shutdown(cfds[i], SHUT_WR);
    }

    // Collect arrivals via epoll_pwait.
    struct epoll_event events[16];
    while (order_len < conns) {
        int n = epoll_pwait(epfd, events, 16, -1, NULL);
        if (n < 0) {
            if (errno == EINTR) continue;
            perror("epoll_pwait");
            return 1;
        }
        if (n == 0) {
            fprintf(stderr, "epoll_pwait timeout (got %d/%d)\n", order_len, conns);
            return 1;
        }
        for (int j = 0; j < n; j++) {
            int idx = (int)events[j].data.u32;
            if (idx < 0 || idx >= conns || received[idx]) continue;
            char buf[16];
            ssize_t r = read(sfds[idx], buf, sizeof(buf) - 1);
            if (r > 0) {
                buf[r] = '\0';
                int tag = atoi(buf);
                received[idx] = 1;
                order[order_len++] = tag > 0 ? tag : (idx + 1);
                epoll_ctl(epfd, EPOLL_CTL_DEL, sfds[idx], NULL);
            }
        }
    }

    for (int i = 0; i < conns; i++) {
        if (sfds[i] >= 0) close(sfds[i]);
        if (cfds[i] >= 0) close(cfds[i]);
    }
    close(epfd);
    close(lfd);

    uint64_t t1 = mono_ns();
    uint64_t elapsed_ns = (t1 >= t0) ? (t1 - t0) : 0;
    char rand_hex[17];
    read_rand_hex(rand_hex);

    char order_str[128];
    size_t pos = 0;
    for (int i = 0; i < order_len; i++) {
        pos += (size_t)snprintf(
            order_str + pos,
            sizeof(order_str) - pos,
            "%s%d",
            i == 0 ? "" : ",",
            order[i]
        );
    }

    printf("ORDER=%s\n", order_str);
    printf("ELAPSED_NS=%llu\n", (unsigned long long)elapsed_ns);
    printf("VIRTUAL_MS=%llu\n", (unsigned long long)(elapsed_ns / 1000000ULL));
    printf("RAND_HEX=%s\n", rand_hex);
    fflush(stdout);

    if (check_race) {
        int in_order = 1;
        for (int i = 0; i < order_len; i++) {
            if (order[i] != i + 1) {
                in_order = 0;
                break;
            }
        }
        if (!in_order) {
            fprintf(stderr, "INVARIANT_VIOLATION: out-of-order delivery (%s)\n", order_str);
            fflush(stderr);
            return 1;
        }
        printf("PASS: in-order delivery\n");
        fflush(stdout);
    }
    return 0;
}

int main(int argc, char **argv) {
    const char *mode = "race";
    int iters = 6;
    int conns = 6;
    long threshold_ms = 10;
    long sleep_val_ms = 50;

    for (int i = 1; i < argc; i++) {
        if (strncmp(argv[i], "--mode=", 7) == 0) {
            mode = argv[i] + 7;
        } else if (strcmp(argv[i], "--mode") == 0 && i + 1 < argc) {
            mode = argv[++i];
        } else if (strncmp(argv[i], "--iters=", 8) == 0) {
            iters = atoi(argv[i] + 8);
        } else if (strcmp(argv[i], "--iters") == 0 && i + 1 < argc) {
            iters = atoi(argv[++i]);
        } else if (strncmp(argv[i], "--conns=", 8) == 0) {
            conns = atoi(argv[i] + 8);
        } else if (strcmp(argv[i], "--conns") == 0 && i + 1 < argc) {
            conns = atoi(argv[++i]);
        } else if (strncmp(argv[i], "--threshold-ms=", 15) == 0) {
            threshold_ms = strtol(argv[i] + 15, NULL, 10);
        } else if (strcmp(argv[i], "--threshold-ms") == 0 && i + 1 < argc) {
            threshold_ms = strtol(argv[++i], NULL, 10);
        } else if (strncmp(argv[i], "--ms=", 5) == 0) {
            sleep_val_ms = strtol(argv[i] + 5, NULL, 10);
        } else if (strcmp(argv[i], "--ms") == 0 && i + 1 < argc) {
            sleep_val_ms = strtol(argv[++i], NULL, 10);
        }
    }

    if (strcmp(mode, "timing") == 0) {
        int guard_rc = check_env_guards();
        if (guard_rc != 0) return guard_rc;
        uint64_t elapsed_ns = 0;
        if (run_timing_exchange(iters, &elapsed_ns) != 0) {
            fprintf(stderr, "timing exchange failed\n");
            return 1;
        }
        char rand_hex[17];
        read_rand_hex(rand_hex);
        printf("ELAPSED_NS=%llu\n", (unsigned long long)elapsed_ns);
        printf("RAND_HEX=%s\n", rand_hex);
        return 0;
    }

    if (strcmp(mode, "fail-above") == 0) {
        int guard_rc = check_env_guards();
        if (guard_rc != 0) return guard_rc;
        uint64_t elapsed_ns = 0;
        if (run_timing_exchange(iters, &elapsed_ns) != 0) {
            fprintf(stderr, "timing exchange failed\n");
            return 1;
        }
        uint64_t threshold_ns = (threshold_ms > 0) ? ((uint64_t)threshold_ms * 1000000ULL) : 0ULL;
        if (elapsed_ns >= threshold_ns) {
            fprintf(stderr, "THRESHOLD_EXCEEDED ELAPSED_NS=%llu\n", (unsigned long long)elapsed_ns);
            return 1;
        }
        printf("OK ELAPSED_NS=%llu\n", (unsigned long long)elapsed_ns);
        return 0;
    }

    if (strcmp(mode, "reorder") == 0) {
        return run_multi_conn(conns, 0);
    }

    if (strcmp(mode, "race") == 0) {
        return run_multi_conn(conns, 1);
    }

    if (strcmp(mode, "sleep") == 0) {
        uint64_t t0 = mono_ns();
        sleep_ms(sleep_val_ms);
        uint64_t t1 = mono_ns();
        uint64_t elapsed_ns = (t1 >= t0) ? (t1 - t0) : 0;
        printf("SLEPT_NS=%llu\n", (unsigned long long)elapsed_ns);
        return 0;
    }

    if (strcmp(mode, "hang") == 0) {
        // Long-running loop for timeoutMs / AbortSignal tests (120 simulated seconds).
        for (int i = 0; i < 2400; i++) {
            sleep_ms(50);
        }
        printf("HANG_DONE\n");
        return 0;
    }

    fprintf(stderr, "unknown mode: %s\n", mode);
    return 2;
}
`;

let _cachedProbePath = null;

/**
 * Compile and cache the static x86-64 C delay/race probe binary.
 * @returns {string} Absolute path to compiled static ELF64 binary.
 */
export function ensureDelaySweepProbe() {
  if (_cachedProbePath && fs.existsSync(_cachedProbePath)) {
    return _cachedProbePath;
  }

  fs.mkdirSync(PROBE_CACHE_DIR, { recursive: true });
  const hash = crypto
    .createHash("sha256")
    .update(TCP_DELAY_PROBE_C)
    .digest("hex")
    .slice(0, 12);
  const binPath = path.join(PROBE_CACHE_DIR, `tcp_delay_probe_${hash}`);
  if (fs.existsSync(binPath)) {
    _cachedProbePath = binPath;
    return binPath;
  }

  const srcPath = path.join(PROBE_CACHE_DIR, `tcp_delay_probe_${hash}.c`);
  const tmpBinPath = `${binPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(srcPath, TCP_DELAY_PROBE_C, "utf8");

  try {
    execFileSync("gcc", ["-O2", "-static", "-Wall", "-Wextra", "-o", tmpBinPath, srcPath], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    });
    fs.chmodSync(tmpBinPath, 0o755);
    fs.renameSync(tmpBinPath, binPath);
  } catch (err) {
    try {
      fs.rmSync(tmpBinPath, { force: true });
    } catch {
      // ignore
    }
    const stderr = err && err.stderr ? err.stderr.toString("utf8") : "";
    throw new Error(`Failed to compile static C probe with gcc -O2 -static: ${err.message}\n${stderr}`);
  }

  _cachedProbePath = binPath;
  return binPath;
}

/**
 * Round to 3 decimal places (matching PROJECT.md Contract 12 & 13).
 * @param {number} x
 * @returns {number}
 */
export function round3(x) {
  return Math.round(x * 1000) / 1000;
}

/**
 * Extract `KEY=VALUE` from stdout/stderr text.
 * @param {string} output
 * @param {string} key
 * @returns {string | null}
 */
export function parseProbeMetric(output, key) {
  const re = new RegExp(`(?:^|\\s)${key}=([^\\s]+)`);
  const m = String(output ?? "").match(re);
  return m ? m[1] : null;
}

/**
 * Extract integer metric `KEY=<digits>` as BigInt.
 * @param {string} output
 * @param {string} key
 * @returns {bigint}
 */
export function parseProbeBigInt(output, key) {
  const raw = parseProbeMetric(output, key);
  if (raw === null || !/^\d+$/.test(raw)) {
    throw new Error(`Expected integer metric ${key}=<digits> in output, got:\n${output}`);
  }
  return BigInt(raw);
}

/**
 * Build and register an offline mock OCI image based on `alpine:latest`
 * containing `/usr/local/bin/tcp_delay_probe` and `/opt/tcp_race_probe`.
 * @param {object} registry Mock OCI registry from `startMockOciRegistry()`
 * @param {string} [repo]
 * @param {string} [tag]
 * @returns {string} Full image reference registered on the mock registry
 */
export function registerDelaySweepOciImage(
  registry,
  repo = "delay-sweep/probe-alpine",
  tag = "v1"
) {
  const probeBinPath = ensureDelaySweepProbe();
  const probeBytes = new Uint8Array(fs.readFileSync(probeBinPath));
  const base = loadDockerBaseImage("alpine:latest");

  const probeLayer = createTarGz([
    { path: "usr/", type: "dir", mode: 0o755 },
    { path: "usr/local/", type: "dir", mode: 0o755 },
    { path: "usr/local/bin/", type: "dir", mode: 0o755 },
    {
      path: "usr/local/bin/tcp_delay_probe",
      type: "file",
      mode: 0o755,
      content: probeBytes,
    },
    { path: "opt/", type: "dir", mode: 0o755 },
    {
      path: "opt/tcp_race_probe",
      type: "file",
      mode: 0o755,
      content: probeBytes,
    },
    { path: "workspace/", type: "dir", mode: 0o755 },
  ]);

  const baseInner = base.configJson?.config || {};
  const ociImage = buildOciImage({
    config: {
      ...baseInner,
      Cmd: ["/bin/sh"],
      WorkingDir: "/workspace",
      Env: ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],
    },
    layers: [...base.layers, probeLayer],
  });

  registry.registerImage(repo, tag, ociImage);
  return registry.imageRef(repo, tag);
}

/**
 * Register a deterministic offline mock git repository with a build/run split
 * (`subapp/build.sh` copies `/usr/local/bin/tcp_delay_probe` to `./app` and
 * records build invocations in `.build_count`).
 * @param {object} gitServer Mock git server from `startMockGitServer()`
 * @param {string} [repoPath]
 * @returns {string} Local mock git repo URL
 */
export function registerDelaySweepGitRepo(gitServer, repoPath = "acme/sweep-proj") {
  const archive = buildGitRepoArchive("sweep-proj-main", [
    { path: "README.md", type: "file", content: "Offline delay-sweep test project\n" },
    { path: "subapp/", type: "dir", mode: 0o755 },
    { path: "subapp/VERSION", type: "file", content: "1.0.0-sweep\n" },
    {
      path: "subapp/build.sh",
      type: "file",
      mode: 0o755,
      content: [
        "#!/bin/sh",
        "set -eu",
        'echo "BUILD_OK" >> .build_count',
        "cp /usr/local/bin/tcp_delay_probe ./app",
        "chmod +x ./app",
        'echo "BUILT_APP_READY"',
        "",
      ].join("\n"),
    },
  ]);

  gitServer.addRepo(repoPath, {
    HEAD: archive,
    main: archive,
  });
  return gitServer.repoUrl(repoPath);
}

/**
 * Dynamically import `js/docker_sdk.mjs` (public SDK entry point).
 */
export async function importDockerSdk() {
  return import("../js/docker_sdk.mjs");
}

/**
 * Dynamically import `web/url_state.mjs` (public URL state module).
 */
export async function importUrlState() {
  return import("../web/url_state.mjs");
}

/**
 * Create a public `Elf2WasmDocker` client pointed at a local server URL.
 * @param {string} serverUrl
 * @param {object} [extraOpts]
 */
export async function createSdkClient(serverUrl, extraOpts = {}) {
  const { Elf2WasmDocker } = await importDockerSdk();
  return Elf2WasmDocker.create({
    registryProxyBase: `${serverUrl}/api/v2`,
    gitProxyBase: `${serverUrl}/api/git/archive`,
    compilerWasmUrl: `${serverUrl}/wasm/elf2wasm_compiler_wasm.wasm`,
    runtimeWasmUrl: `${serverUrl}/wasm/elf2wasm_runtime_wasm.wasm`,
    useWorker: false,
    ...extraOpts,
  });
}

/**
 * Spawn a CLI process and collect exitCode, stdout, stderr with a timeout.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, timeoutMs?: number, env?: object }} [opts]
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string, durationMs: number }>}
 */
export function runProcess(cmd, args, opts = {}) {
  const { cwd = REPO_ROOT, timeoutMs = 60000, env = process.env } = opts;
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const proc = spawn(cmd, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out = [];
    const err = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          proc.kill("SIGKILL");
        } catch {
          // ignore
        }
        reject(new Error(`Process timed out after ${timeoutMs}ms: ${cmd} ${args.join(" ")}`));
      }
    }, timeoutMs);

    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (d) => out.push(d));
    proc.stderr.on("data", (d) => err.push(d));
    proc.on("error", (e) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(e);
      }
    });
    proc.on("exit", (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          exitCode: code !== null ? code : 128,
          signal,
          stdout: out.join(""),
          stderr: err.join(""),
          durationMs: Date.now() - t0,
        });
      }
    });
  });
}

/**
 * Read all legacy + F40/Contract 13 DOM values from the Web UI in Chrome CDP.
 * @param {object} browser
 */
export async function readDelaySweepDomState(browser) {
  return browser.evaluate(
    `(() => {
      const val = (id) => document.getElementById(id)?.value ?? "";
      const checked = (id) => Boolean(document.getElementById(id)?.checked);
      const sweepPanel = document.getElementById("sweep-panel");
      const sweepPanelVisible = Boolean(
        sweepPanel &&
        !sweepPanel.hidden &&
        window.getComputedStyle(sweepPanel).display !== "none"
      );
      return {
        search: window.location.search,
        pathname: window.location.pathname,
        hash: window.location.hash,
        historyLength: window.history.length,
        image: val("image-input"),
        build: val("build-cmd-input"),
        cmd: val("cmd-input"),
        repo: val("repo-input"),
        ref: val("repo-ref-input"),
        mount: val("repo-mount-input"),
        cwd: val("cwd-input"),
        env: val("env-input"),
        stddev: val("delay-stddev-input"),
        seed: val("delay-seed-input"),
        sweep: checked("sweep-mode-toggle"),
        runs: val("sweep-runs-input"),
        stddevStart: val("sweep-stddev-start-input"),
        stddevStep: val("sweep-stddev-step-input"),
        sweepPanelExists: Boolean(sweepPanel),
        sweepPanelVisible,
        copySweepBtnExists: Boolean(document.getElementById("copy-sweep-link-btn")),
        sweepResultsBodyExists: Boolean(document.getElementById("sweep-results-body")),
        advancedOpen: Boolean(document.getElementById("advanced-options")?.open),
        statusText: document.getElementById("status-text")?.textContent ?? "",
        statusState: document.getElementById("status-pill")?.dataset?.state ?? "",
        terminalTitle: document.getElementById("terminal-title")?.textContent ?? "",
        terminalText:
          document.getElementById("terminal")?.innerText ||
          document.getElementById("terminal")?.textContent ||
          "",
        stopDisabled: Boolean(document.getElementById("stop-btn")?.disabled),
        startDisabled: Boolean(document.getElementById("start-btn")?.disabled),
        activeElementId: document.activeElement?.id ?? "",
        xssFlag: window.__xss,
      };
    })()`,
    { awaitPromise: false }
  );
}

/**
 * Set a checkbox value in Chrome CDP and fire `input` + `change` events.
 * @param {object} browser
 * @param {string} selector
 * @param {boolean} isChecked
 */
export async function setCheckboxValue(browser, selector, isChecked) {
  const ok = await browser.evaluate(
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.checked = ${JSON.stringify(Boolean(isChecked))};
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`,
    { awaitPromise: false }
  );
  if (!ok) {
    throw new Error(`Checkbox element not found: ${selector}`);
  }
}

/**
 * Read all rows from `#sweep-results-body`.
 * @param {object} browser
 * @returns {Promise<Array<{ rowIndex: number, text: string, cells: string[], runLinkHref: string | null }>>}
 */
export async function readSweepRows(browser) {
  return browser.evaluate(
    `(() => {
      const tbody = document.getElementById("sweep-results-body");
      if (!tbody) return [];
      return Array.from(tbody.querySelectorAll("tr")).map((tr, idx) => {
        const link = tr.querySelector("a.run-link");
        return {
          rowIndex: idx,
          text: (tr.textContent || "").trim(),
          cells: Array.from(tr.querySelectorAll("td")).map((td) => (td.textContent || "").trim()),
          runLinkHref: link ? link.getAttribute("href") : null,
          runLinkFullHref: link ? link.href : null,
        };
      });
    })()`,
    { awaitPromise: false }
  );
}

/**
 * Wait for a Web UI sweep to complete (at least one result row and status pill
 * no longer in a busy state, and `#stop-btn` disabled).
 * @param {object} browser
 * @param {number} [timeoutMs]
 */
export async function waitForSweepFinished(browser, timeoutMs = 120000) {
  return waitFor(
    async () => {
      const st = await readDelaySweepDomState(browser);
      const rows = await readSweepRows(browser);
      const busyStates = new Set(["busy", "loading", "pulling", "building", "running", "sweeping"]);
      if (rows.length > 0 && st.stopDisabled && !busyStates.has(st.statusState)) {
        return { state: st, rows };
      }
      return null;
    },
    { timeoutMs, intervalMs: 250, label: "sweep completion in #sweep-panel" }
  );
}

/**
 * Wait for a single-run container in the Web UI to finish (`#stop-btn` disabled
 * and terminal/status updated after `#start-btn` click).
 * @param {object} browser
 * @param {number} [timeoutMs]
 */
export async function waitForSingleRunFinished(browser, timeoutMs = 120000) {
  let sawActiveOrOutput = false;
  return waitFor(
    async () => {
      const st = await readDelaySweepDomState(browser);
      const busyStates = new Set(["busy", "loading", "pulling", "building", "running"]);
      if (busyStates.has(st.statusState) || !st.stopDisabled) {
        sawActiveOrOutput = true;
        return null;
      }
      const cleanTerm = stripAnsi(st.terminalText);
      if (
        sawActiveOrOutput ||
        cleanTerm.includes("ORDER=") ||
        cleanTerm.includes("INVARIANT_VIOLATION") ||
        cleanTerm.includes("Exited") ||
        st.statusState === "exited" ||
        st.statusState === "error"
      ) {
        return st;
      }
      return null;
    },
    { timeoutMs, intervalMs: 250, label: "single-run completion in Web UI" }
  );
}

/**
 * Harness self-test suite (`--self-test`), runnable while M16-M18 are in progress.
 * Verifies:
 *  - DS-ST-1: All 4 tier modules import cleanly and register expected test counts.
 *  - DS-ST-2: Static C probe compiles with `gcc -O2 -static` and passes native timing/reorder/race/sleep checks.
 *  - DS-ST-3: Mock OCI registry builds & serves `delay-sweep/probe-alpine:v1` manifest & blobs.
 *  - DS-ST-4: Mock Git archive server serves `acme/sweep-proj` archive with `subapp/build.sh`.
 *  - DS-ST-5: Local HTTP server (`server/server.mjs`) + Headless Chrome CDP smoke test succeeds.
 *  - DS-ST-6: `web/url_state.mjs` module imports cleanly and exports core functions.
 */
export async function runDelaySweepSelfTest(opts = {}) {
  const suite = new Suite("F41 Self-Test: Delay/Sweep Harness");

  suite.add("DS-ST-1", "All 4 delay/sweep tier modules load cleanly with expected exports", async () => {
    const t1 = await import("./test_delay_sweep_tier1.mjs");
    const t2 = await import("./test_delay_sweep_tier2.mjs");
    const t3 = await import("./test_delay_sweep_tier3.mjs");
    const t4 = await import("./test_delay_sweep_tier4.mjs");

    assert.equal(typeof t1.runDelaySweepTier1, "function", "tier1 must export runDelaySweepTier1");
    assert.equal(typeof t2.runDelaySweepTier2, "function", "tier2 must export runDelaySweepTier2");
    assert.equal(typeof t3.runDelaySweepTier3, "function", "tier3 must export runDelaySweepTier3");
    assert.equal(typeof t4.runDelaySweepTier4, "function", "tier4 must export runDelaySweepTier4");

    assert.ok(t1.TIER1_TEST_COUNT >= 20, `tier1 must register >=20 tests (5+/area), got ${t1.TIER1_TEST_COUNT}`);
    assert.ok(t2.TIER2_TEST_COUNT >= 20, `tier2 must register >=20 tests (5+/area), got ${t2.TIER2_TEST_COUNT}`);
    assert.ok(t3.TIER3_TEST_COUNT >= 5, `tier3 must register >=5 tests, got ${t3.TIER3_TEST_COUNT}`);
    assert.ok(t4.TIER4_TEST_COUNT >= 3, `tier4 must register >=3 tests, got ${t4.TIER4_TEST_COUNT}`);
  });

  suite.add("DS-ST-2", "Static C probe compiles (gcc -O2 -static) and passes native self-check", async () => {
    const binPath = ensureDelaySweepProbe();
    assert.ok(fs.existsSync(binPath), "Compiled probe binary must exist");

    // 1. Timing mode
    const timing = await runProcess(binPath, ["--mode=timing", "--iters=3"], { timeoutMs: 10000 });
    assert.equal(timing.exitCode, 0, `timing mode failed: ${timing.stderr}`);
    const elapsedNs = parseProbeBigInt(timing.stdout, "ELAPSED_NS");
    assert.ok(elapsedNs >= 0n, "ELAPSED_NS must be non-negative");
    const randHex = parseProbeMetric(timing.stdout, "RAND_HEX");
    assert.ok(randHex && /^[0-9a-f]{16}$/.test(randHex), `Expected 16-char RAND_HEX, got ${randHex}`);

    // 2. Race mode (native baseline without delay injection should arrive in order or report valid ORDER=)
    const race = await runProcess(binPath, ["--mode=race", "--conns=6"], { timeoutMs: 10000 });
    const order = parseProbeMetric(race.stdout, "ORDER");
    assert.ok(order && order.split(",").length === 6, `Expected 6-element ORDER=, got: ${race.stdout}`);
    assert.ok(race.exitCode === 0 || race.stderr.includes("INVARIANT_VIOLATION"), "race mode must pass or report INVARIANT_VIOLATION");

    // 3. Sleep mode
    const slp = await runProcess(binPath, ["--mode=sleep", "--ms=20"], { timeoutMs: 10000 });
    assert.equal(slp.exitCode, 0, `sleep mode failed: ${slp.stderr}`);
    const sleptNs = parseProbeBigInt(slp.stdout, "SLEPT_NS");
    assert.ok(sleptNs >= 15_000_000n, `Expected SLEPT_NS >= 15ms, got ${sleptNs}`);
  });

  suite.add("DS-ST-3", "Mock OCI registry builds & serves delay-sweep/probe-alpine:v1", async () => {
    const registry = await startMockOciRegistry();
    try {
      const imageRef = registerDelaySweepOciImage(registry);
      assertIncludes(imageRef, "delay-sweep/probe-alpine:v1");
      const acceptHeader =
        "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json";
      const manifestUrl = `${registry.url}/v2/delay-sweep/probe-alpine/manifests/v1`;

      let res = await fetch(manifestUrl, { headers: { Accept: acceptHeader } });
      let authHeaders = {};
      if (res.status === 401) {
        const wwwAuth = res.headers.get("www-authenticate") || "";
        const realmMatch = /realm="([^"]+)"/.exec(wwwAuth);
        const serviceMatch = /service="([^"]+)"/.exec(wwwAuth);
        const scopeMatch = /scope="([^"]+)"/.exec(wwwAuth);
        assert.ok(realmMatch, `Expected Bearer realm in WWW-Authenticate header, got: ${wwwAuth}`);
        const tokenUrl = new URL(realmMatch[1]);
        if (serviceMatch) tokenUrl.searchParams.set("service", serviceMatch[1]);
        if (scopeMatch) tokenUrl.searchParams.set("scope", scopeMatch[1]);
        const tokenRes = await fetch(tokenUrl.toString());
        assert.equal(tokenRes.status, 200, `Token exchange failed with status ${tokenRes.status}`);
        const tokenJson = await tokenRes.json();
        const token = tokenJson.token || tokenJson.access_token;
        assert.ok(token, "Expected Bearer token in token response");
        authHeaders = { Authorization: `Bearer ${token}` };
        res = await fetch(manifestUrl, { headers: { Accept: acceptHeader, ...authHeaders } });
      }
      assert.equal(res.status, 200, `Expected 200 fetching manifest, got ${res.status}`);
      let manifest = await res.json();

      // If an OCI image index / manifest list is returned, resolve linux/amd64
      if (Array.isArray(manifest.manifests)) {
        const amd64 = manifest.manifests.find(
          (m) => m.platform?.os === "linux" && m.platform?.architecture === "amd64"
        );
        assert.ok(amd64 && amd64.digest, "Expected linux/amd64 entry in OCI index");
        const mRes = await fetch(
          `${registry.url}/v2/delay-sweep/probe-alpine/manifests/${amd64.digest}`,
          { headers: { Accept: acceptHeader, ...authHeaders } }
        );
        assert.equal(mRes.status, 200, `Expected 200 fetching linux/amd64 manifest, got ${mRes.status}`);
        manifest = await mRes.json();
      }

      assert.ok(
        Array.isArray(manifest.layers) && manifest.layers.length >= 2,
        `Expected >= 2 layers in OCI manifest, got ${manifest.layers?.length}`
      );
      assert.ok(manifest.config?.digest, "Expected config digest in OCI manifest");

      const cfgRes = await fetch(
        `${registry.url}/v2/delay-sweep/probe-alpine/blobs/${manifest.config.digest}`,
        { headers: authHeaders, redirect: "follow" }
      );
      assert.equal(cfgRes.status, 200, `Expected 200 fetching config blob, got ${cfgRes.status}`);
      const cfg = await cfgRes.json();
      assert.deepEqual(cfg.config?.Cmd, ["/bin/sh"], `Unexpected OCI config.Cmd: ${JSON.stringify(cfg.config?.Cmd)}`);
      assert.equal(cfg.config?.WorkingDir, "/workspace", `Unexpected OCI config.WorkingDir: ${cfg.config?.WorkingDir}`);
    } finally {
      await registry.close();
    }
  });

  suite.add("DS-ST-4", "Mock Git server serves acme/sweep-proj archive with build/run fixture", async () => {
    const gitServer = await startMockGitServer();
    try {
      const repoUrl = registerDelaySweepGitRepo(gitServer);
      assertIncludes(repoUrl, "acme/sweep-proj");
      const res = await fetch(`${repoUrl}/archive/main.tar.gz`, { redirect: "follow" });
      assert.equal(res.status, 200, `Expected 200 from mock git archive, got ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      assert.ok(buf.length > 50, "Expected non-empty gzipped archive");
      assert.equal(buf[0], 0x1f, "Expected gzip magic byte 0");
      assert.equal(buf[1], 0x8b, "Expected gzip magic byte 1");
      assert.equal(gitServer.leakedAuthCount(), 0, "Expected zero leaked auth headers");
    } finally {
      await gitServer.close();
    }
  });

  suite.add("DS-ST-5", "Local server + headless Chrome CDP smoke check succeeds", async () => {
    const chromePath = findChromeBinary();
    assert.ok(chromePath, "Chrome binary must be available for CDP E2E tests");
    const server = await startServer({ allowLocalRegistries: true });
    let browser = null;
    try {
      const health = await fetch(`${server.url}/api/health`);
      assert.equal(health.status, 200);
      browser = await launchCdpBrowser({ chromePath });
      await browser.navigate(`${server.url}/`);
      await browser.waitForSelector("#image-input");
      const st = await readDelaySweepDomState(browser);
      assert.equal(st.image, "alpine:latest");
      assert.equal(browser.exceptions.length, 0, `Unexpected browser exceptions: ${JSON.stringify(browser.exceptions)}`);
    } finally {
      if (browser) await browser.close();
      await server.close();
    }
  });

  suite.add("DS-ST-6", "web/url_state.mjs imports cleanly and exports core URL helpers", async () => {
    const urlState = await importUrlState();
    assert.equal(typeof urlState.parseStateFromSearch, "function");
    assert.equal(typeof urlState.serializeStateToSearch, "function");
    assert.ok(urlState.DEFAULT_UI_STATE && typeof urlState.DEFAULT_UI_STATE === "object");
    const parsed = urlState.parseStateFromSearch("?image=alpine:latest");
    assert.ok(parsed && typeof parsed.state === "object", "parseStateFromSearch must return { state, activePresetId }");
    assert.equal(parsed.state.image, "alpine:latest");
  });

  return suite.run({ verbose: opts.verbose });
}
