# Project: elf2wasm — Developer-Tool Dockerfile UX, Repo Cleanup & Remote Cloudflare Worker Evaluation

## Architecture
`elf2wasm` runs unmodified Linux x86-64 OCI container images and GitHub repositories deterministically via WebAssembly, both locally in the browser and remotely on a Cloudflare Worker:

- **Rust WASM Core (`crates/`)**:
  - `crates/elf2wasm-core`: x86-64 ELF64 loader, decoder, lifter, WASM emitter (with standard 256 MiB and compact Worker-friendly memory layout configs).
  - `crates/elf2wasm-runtime-core`: Deterministic Linux syscall/VFS/scheduler/virtual-time/PRNG/delay-injection runtime + CoW VFS snapshots + `VirtualFs::export_tar` diff/archive export with OCI whiteouts.
  - `crates/elf2wasm-compiler-wasm`: `cdylib` (`wasm32-unknown-unknown`) lifting ELF64 bundles to guest `.wasm`.
  - `crates/elf2wasm-runtime-wasm`: `cdylib` (`wasm32-unknown-unknown`) bridging browser/Node V8 guest instances + VFS diff export.
  - `crates/elf2wasm-worker-wasm` *(new in M2)*: `cdylib` (`wasm32-unknown-unknown`) bundling `elf2wasm-core` + `elf2wasm-runtime-core` + `wasmi` (SIMD + fuel metering) to evaluate guest `.wasm` modules inside Cloudflare Workers without dynamic `WebAssembly.compile()`, producing deterministic outputs identical to browser execution.
- **Browser & Shared JS SDK (`js/`)**:
  - `js/elf2wasm_shim.mjs`, `js/docker_sdk.mjs`, `js/container_worker.mjs`, `js/oci_client.mjs`, `js/git_client.mjs` (plus `js/cli.mjs` kept for interactive CLI testing).
  - Supports multi-layer `Layer[]` execution (`from`, `git`, `workdir`, `env`, `run`, `sweep`), per-layer `local` vs `remote` execution with `.tar.gz` VFS diff handoff, per-layer build-output archive downloads, and generalized `SWEEP` fan-out across all downstream layers.
- **Cloudflare Worker & Local Dev Server (`worker/`, `server/`)**:
  - `worker/src/index.mjs` serves static assets (`worker/dist/`) and `/api/health`, `/api/v2/*` (edge-cached OCI proxy), `/api/git/archive` (edge-cached Git proxy), and `POST /api/eval` *(new in M3)* for remote WASM-interpreter layer evaluation & downloadable `.tar.gz` outputs.
  - `server/server.mjs` mirrors all `/api/*` routes (including `POST /api/eval`) for local interactive development and offline E2E testing.
- **Web UI (`web/`)**:
  - Zero-build vanilla ESM + CSS (`index.html`, `styles.css`, `app.mjs`, `dockerfile.mjs`, `url_state.mjs`, `terminal.mjs`).
  - System-default Light/Dark theme (`prefers-color-scheme` + explicit System/Light/Dark switcher) with a polished, GitHub-familiar developer-tool aesthetic.
  - Dual-mode **Dockerfile Text** ↔ **Visual Layer Builder**, configurable **Sweep** layer (delay, seed, or env var), per-layer **Local/Remote** + global **Run All Locally / Run All Remotely**, per-layer **Download outputs (.tar.gz)**, and well-known project presets (Express.js, Flask, etc.).

## Feature Inventory
Every user requirement and Survey finding is assigned to a milestone (none unassigned):

| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| F1 | Repo Cleanup | Remove 42 unused legacy native-CLI / Phase 1–2 files (`src/`, `tests/`, `e2e/`, `e2e_v2/`, `js/test_m1_preemption.mjs`, stale `TEST_READY.md`/`TEST_INFRA.md`); convert root `Cargo.toml` to virtual workspace; keep web UI & interactive testing tools (`server/`, `e2e_docker_web/`, `js/cli.mjs`) | M1 | ORIGINAL_REQUEST #3, survey_1 |
| F2 | Toolchain Bootstrap | Ensure `wasm32-unknown-unknown` target and `worker/node_modules` are installed and baseline Rust/JS/Worker tests pass | M1 | survey_1 |
| F3 | VFS Diff & Tar Export | `VirtualFs::export_tar(base_snapshot_id, path_prefix)` with `Arc::ptr_eq` diffing, OCI `.wh.<name>` whiteouts, and modified-file manifest in `elf2wasm-runtime-core`, `elf2wasm-runtime-wasm`, and `js/elf2wasm_shim.mjs` | M2 | ORIGINAL_REQUEST #4, survey_2, survey_3 |
| F4 | Compact Memory & WASM Interpreter Crate | Compact guest memory layout in `elf2wasm-core` + `crates/elf2wasm-worker-wasm` (`wasmi` + SIMD + fuel metering) sharing `elf2wasm-core` & `elf2wasm-runtime-core` for deterministic Cloudflare Worker execution with zero dynamic `WebAssembly.compile()` | M2 | ORIGINAL_REQUEST #4, survey_3 |
| F5 | Remote Layer Evaluation API (`POST /api/eval`) | Cloudflare Worker `POST /api/eval` endpoint using statically-imported `elf2wasm_worker_wasm.wasm`, internal edge-cached OCI/Git fetching, JSON + direct `.tar.gz` download support, CORS `POST`, and graceful memory/CPU limit errors | M3 | ORIGINAL_REQUEST #4, survey_3 |
| F6 | Local Dev Server Parity for `/api/eval` | Mirror `POST /api/eval` in `server/server.mjs` and update `worker/scripts/build_assets.mjs`, `worker/wrangler.jsonc`, and `.github/workflows/deploy-worker.yml` | M3 | ORIGINAL_REQUEST #4, survey_1, survey_3 |
| F7 | Dockerfile Parser & Serializer | Bidirectional `web/dockerfile.mjs` converting between Dockerfile text (`FROM`, `GIT`/`ADD`/`RUN git clone`, `WORKDIR`, `ENV`, `RUN`, `SWEEP`) and structured `Layer[]` | M4 | ORIGINAL_REQUEST #1, survey_2 |
| F8 | Multi-Layer & Local/Remote SDK Execution | `js/docker_sdk.mjs` & `js/container_worker.mjs` executing ordered `Layer[]` stacks with per-layer `local` vs `remote` target, VFS `.tar.gz` diff handoff between layers, and downloadable build outputs | M4 | ORIGINAL_REQUEST #1 & #4, survey_2, survey_3 |
| F9 | Generalized Sweep Across Downstream Layers | Sweep layer snapshots VFS at sweep boundary and fans out ALL subsequent layers across user-selected variable: delay stddev, random seed, or arbitrary environment variable (range or value list) | M4 | ORIGINAL_REQUEST #1, survey_2 |
| F10 | URL State Persistence | `web/url_state.mjs` serializing/restoring layer stack / Dockerfile, sweep config, and execution targets cleanly | M4 | survey_2 |
| F11 | System Light/Dark Theme & Dev-Tool Polish | Default to system `prefers-color-scheme` (Light/Dark + manual toggle), tokenize all hardcoded dark colors/favicon, light/dark legible terminal, GitHub-familiar developer-tool UI | M5 | ORIGINAL_REQUEST (intro), survey_2 |
| F12 | Visual Layer Builder & Dockerfile Editor UI | Build layers via UI (`FROM` image, GitHub `git clone`, `RUN` command, `ENV`, `WORKDIR`, `SWEEP`) OR paste/edit a complete Dockerfile as text | M5 | ORIGINAL_REQUEST #1, survey_2 |
| F13 | Per-Layer & Global Local/Remote + Download UI | Per-layer Local/Remote selector, top-level "Run All Locally" / "Run All Remotely" control, and per-layer "Download outputs (.tar.gz)" button | M5 | ORIGINAL_REQUEST #4, survey_2 |
| F14 | Well-Known Presets | Replace Bottle, Nano ID, Nushell with recognizable projects (e.g., Express.js, Flask, plus well-known Go/Python/Node presets) verified to execute cleanly without guest internet | M5 | ORIGINAL_REQUEST #2, survey_2 |
| F15 | Updated Docs | Update `README.md` for cleaned repo, Dockerfile UX, presets, and `/api/eval` | M5 | survey_1 |
| F16 | Comprehensive 4-Tier E2E Suite | Requirement-driven opaque-box E2E suite covering F1–F14 (Tiers 1–4) published via `TEST_INFRA.md` and `TEST_READY.md` | E2E Track | Project Pattern |
| F17 | Final E2E Pass, Tier 5 Adversarial Hardening & Push | Pass 100% of Tiers 1–4 E2E tests, complete Tier 5 white-box adversarial hardening, verify small clean git commits, push to `origin/main` | M6 | ORIGINAL_REQUEST, Project Pattern |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Repo Cleanup & Toolchain Bootstrap | F1, F2: Remove 42 unused files, virtual workspace `Cargo.toml`, bootstrap `wasm32-unknown-unknown` & `worker/npm ci`, verify baseline tests, commit | none | DONE (`57f42b3`) |
| M2 | VFS Export & Worker WASM Interpreter | F3, F4: `VirtualFs::export_tar`, `elf2wasm-runtime-wasm` + `js/elf2wasm_shim.mjs` export APIs, compact memory layout, `crates/elf2wasm-worker-wasm` (`wasmi`), parity tests, commit | M1 | DONE (`13d816c`) |
| M3 | Remote Layer Evaluation API | F5, F6: `POST /api/eval` in `worker/src/index.mjs` & `server/server.mjs`, asset/wrangler/CI updates, unit/parity tests, `wrangler deploy --dry-run`, commit | M2 | DONE (`0b840ef`) |
| M4 | Multi-Layer Dockerfile, Sweep & SDK | F7, F8, F9, F10: `web/dockerfile.mjs`, multi-layer local/remote SDK & generalized sweep in `js/docker_sdk.mjs` & `js/container_worker.mjs`, `web/url_state.mjs`, unit tests, commit | M2 | DONE (`55130d1`) |
| M5 | Dev-Tool UI, Light/Dark Theme & Presets | F11, F12, F13, F14, F15: System light/dark GitHub-familiar UI, Dockerfile + Layer Builder, configurable Sweep UI, Local/Remote & Download UI, well-known presets (Express.js, Flask, etc.), `README.md`, commit | M3, M4 | DONE (`4b01dad`) |
| E2E | E2E Testing Track (Parallel) | F16: Opaque-box 4-tier E2E test suite (`e2e_docker_web/`), `TEST_INFRA.md`, `TEST_READY.md` | M1 | DONE (`833a35f`) |
| M6 | Final Milestone: E2E Pass, Tier 5 & Push | F17: Pass 100% Tiers 1–4, Tier 5 adversarial hardening, verify small clean commits, `git push origin main` | M5, E2E | DONE (`cab1afa`) |

## Interface Contracts

### 1. VFS Diff/Export (`crates/elf2wasm-runtime-core` ↔ `elf2wasm-runtime-wasm` ↔ `js/elf2wasm_shim.mjs`)
- **Rust (`VirtualFs`)**:
  - `pub fn export_tar(&self, base_snapshot_id: Option<u32>, path_prefix: Option<&str>) -> Vec<u8>`
    - Emits standard USTAR/PAX `.tar` bytes containing regular files, directories, symlinks, and OCI whiteouts (`.wh.<name>`) for entries present in `base_snapshot_id` but deleted in current overlay.
    - Skips unchanged files in O(1) via `Arc::ptr_eq` + mode/mtime check when `base_snapshot_id` is `Some(id)`.
  - `pub fn list_diff(&self, base_snapshot_id: Option<u32>, path_prefix: Option<&str>) -> Vec<VfsDiffEntry>`
    - `VfsDiffEntry { path: String, kind: "file"|"dir"|"symlink"|"deleted", size: u64 }`.
- **WASM ABI (`elf2wasm-runtime-wasm`)**:
  - `runtime_export_vfs_tar(base_snap_id: u32, use_base: u32, prefix_ptr: u32, prefix_len: u32, out_len_ptr: u32) -> u32` (returns allocated buffer pointer; caller frees via `runtime_dealloc`).
  - `runtime_list_vfs_diff(base_snap_id: u32, use_base: u32, prefix_ptr: u32, prefix_len: u32, out_len_ptr: u32) -> u32` (returns UTF-8 JSON array of `VfsDiffEntry`).
- **JS (`Elf2WasmSystem`)**:
  - `exportVfsDiffTar({ baseSnapshotId?: number, pathPrefix?: string }) -> Uint8Array`
  - `listVfsDiff({ baseSnapshotId?: number, pathPrefix?: string }) -> Array<{ path, kind, size }>`

### 2. Remote Layer Evaluation API (`worker/src/index.mjs` & `server/server.mjs` ↔ `js/docker_sdk.mjs` & `web/app.mjs`)
- **Endpoint**: `POST /api/eval`
- **Request (`application/json`)**:
  ```json
  {
    "baseImage": "alpine:latest",
    "gitRepo": { "repo": "owner/repo", "ref": "main", "mountPath": "/workspace" },
    "inputLayerDiffs": ["<base64 gzip-compressed tar>"],
    "cmd": ["sh", "-c", "echo hello > /workspace/out.txt"],
    "env": ["KEY=VALUE"],
    "cwd": "/workspace",
    "user": "",
    "stdin": "",
    "delayStddevMs": 0,
    "delaySeed": 0,
    "timeoutMs": 30000,
    "returnOutputDiff": true,
    "downloadPath": ""
  }
  ```
- **Response (default `application/json`)**:
  ```json
  {
    "ok": true,
    "executor": "remote-wasmi",
    "exitCode": 0,
    "stdout": "hello\n",
    "stderr": "",
    "virtualTimeNs": "123456",
    "timedOut": false,
    "error": null,
    "outputDiffTarGzBase64": "<base64 gzip-compressed tar>",
    "modifiedFiles": [{ "path": "/workspace/out.txt", "kind": "file", "size": 6 }]
  }
  ```
- **Direct Download Response** (when `Accept: application/gzip` or `?format=tar.gz`):
  - `200 OK`, `Content-Type: application/gzip`, `Content-Disposition: attachment; filename="layer-output.tar.gz"`, `X-Eval-Exit-Code: <n>`, `X-Eval-Virtual-Time-Ns: <ns>`, raw `.tar.gz` body.
- **Error Responses**: Structured JSON `{ "ok": false, "error": "...", "code": "MEMORY_LIMIT" | "FUEL_EXHAUSTED" | "INVALID_REQUEST" | "UPSTREAM_ERROR" }` with HTTP `400` / `408` / `413` / `502` / `507`.

### 3. Layer Stack, Dockerfile & Sweep Model (`web/dockerfile.mjs` ↔ `js/docker_sdk.mjs` ↔ `web/app.mjs` ↔ `web/url_state.mjs`)
- **Layer Schema**:
  ```ts
  type ExecutionTarget = "local" | "remote";
  type Layer =
    | { id: string; type: "from"; image: string; executor?: ExecutionTarget }
    | { id: string; type: "git"; repo: string; ref?: string; mountPath: string; executor?: ExecutionTarget }
    | { id: string; type: "workdir"; path: string }
    | { id: string; type: "env"; key: string; value: string }
    | { id: string; type: "run"; cmd: string; executor: ExecutionTarget }
    | { id: string; type: "sweep"; param: "delay" | "seed" | "env"; envKey?: string; mode: "range" | "list"; start?: number; step?: number; count?: number; values?: string[] };
  ```
- **Dockerfile Directives**:
  - Standard: `FROM <image>`, `WORKDIR <path>`, `ENV KEY=VALUE`, `RUN <command>`.
  - Git clone shorthand: `RUN git clone [--branch <ref>] <github-url-or-owner/repo> [<mount>]` or `# elf2wasm:git repo=<r> ref=<ref> mount=<m>` (parsed into `type: "git"` layer).
  - Sweep directive: `# elf2wasm:sweep param=<delay|seed|env> [envKey=<K>] mode=<range|list> ...` (parsed into `type: "sweep"` layer).
- **Execution Semantics**:
  - Layers before a `sweep` layer execute once sequentially (respecting each layer's `executor: "local" | "remote"`).
  - At a `sweep` layer, VFS state is snapshotted (or accumulated diffs frozen), and **all subsequent layers** execute once per generated sweep variation, injecting the varied `delayStddevMs`, `delaySeed`, or `ENV` override into every downstream `run` layer.

## Code Layout & Write Ownership
```text
elf2wasm/
├── Cargo.toml                         # Virtual workspace (M1, M2)
├── crates/
│   ├── elf2wasm-core/                 # M2 (compact memory layout)
│   ├── elf2wasm-compiler-wasm/        # M2
│   ├── elf2wasm-runtime-core/         # M2 (VirtualFs::export_tar)
│   ├── elf2wasm-runtime-wasm/         # M2 (export ABI)
│   └── elf2wasm-worker-wasm/          # M2 (new: wasmi interpreter crate)
├── js/
│   ├── elf2wasm_shim.mjs              # M2 (exportVfsDiffTar/listVfsDiff)
│   ├── docker_sdk.mjs                 # M4 (multi-layer, local/remote, generalized sweep)
│   ├── container_worker.mjs           # M4
│   ├── oci_client.mjs                 # shared
│   ├── git_client.mjs                 # shared
│   ├── cli.mjs                        # kept for interactive testing
│   ├── test_url_state.mjs             # M4
│   └── test_docker_sdk.mjs            # M4
├── worker/
│   ├── src/index.mjs                  # M3 (POST /api/eval)
│   ├── scripts/build_assets.mjs       # M3 (stage worker wasm)
│   ├── wrangler.jsonc                 # M3
│   ├── test/worker.test.mjs           # M3
│   └── package.json                   # M1/M3
├── server/
│   ├── server.mjs                     # M3 (POST /api/eval parity)
│   ├── proxy_core.mjs, git_core.mjs   # shared
│   ├── registry_proxy.mjs, git_proxy.mjs
│   ├── mock_registry.mjs, mock_git_server.mjs
│   └── test_server.mjs                # M3
├── web/
│   ├── dockerfile.mjs                 # M4 (new: Dockerfile <-> Layer[])
│   ├── url_state.mjs                  # M4 (layer stack URL state)
│   ├── index.html                     # M5
│   ├── styles.css                     # M5
│   ├── terminal.mjs                   # M5
│   └── app.mjs                        # M5
├── e2e_docker_web/                    # E2E Track & M6
├── .github/workflows/deploy-worker.yml # M3
├── README.md                          # M5
└── PROJECT.md                         # Project Orchestrator
```
