// Tier 1 (v2): Offline Smoke, Repo Cleanliness (F1), Theme (F11), Presets (F14),
// Visual Layer Builder <-> Dockerfile Sync (F7/F12), Global & Per-Layer Controls (F13),
// and POST /api/eval Happy Paths (F5/F6).
// Zero external dependencies (Node.js 22 built-ins + e2e_docker_web/helpers/*).

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  Suite,
  assert,
  assertIncludes,
  assertNotIncludes,
  waitFor,
} from "./helpers/test_runner.mjs";
import {
  REPO_ROOT,
  REQUIRED_ARTIFACTS,
  findChromeBinary,
  startServer,
} from "./helpers/server_harness.mjs";
import { startMockOciRegistry } from "./helpers/mock_oci_registry.mjs";
import { launchCdpBrowser } from "./helpers/cdp_browser.mjs";
import {
  postEvalJson,
  postEvalTarGz,
  decodeTarGzBase64,
} from "./helpers/eval_client.mjs";
import {
  getEffectiveColors,
  selectThemeMode,
  setEditorMode,
  setDockerfileText,
  getDockerfileText,
  getAllPresets,
  clickPresetMatching,
  clickControlByLabel,
  inspectLayerControls,
} from "./helpers/v2_ui_helpers.mjs";

function findTarEntry(entries, suffix) {
  const norm = suffix.replace(/^\/+/, "");
  return entries.find((e) => e.name.replace(/^\.\//, "").replace(/^\/+/, "") === norm);
}

export async function runV2Tier1(opts = {}) {
  const suite = new Suite("Tier 1 (v2): Core Features, Theme, Builder & /api/eval");
  const chromePath = findChromeBinary();

  let registry = null;
  let server = null;
  let alpineRef = null;

  async function ensureOfflineEnv() {
    if (!registry) {
      registry = await startMockOciRegistry({ requireAuth: false });
      alpineRef = registry.imageRef("library/alpine", "latest");
    }
    if (!server) {
      server = await startServer({ allowLocalRegistries: true });
    }
  }

  suite.add("T1-V2.1", "F1 Repo cleanliness: legacy files absent, virtual workspace Cargo.toml, interactive tools kept", () => {
    const forbiddenPaths = [
      "src",
      "tests",
      "e2e",
      "e2e_v2",
      "js/test_m1_preemption.mjs",
    ];
    for (const rel of forbiddenPaths) {
      const full = path.join(REPO_ROOT, rel);
      assert.equal(
        fs.existsSync(full),
        false,
        `Legacy path must be removed in F1 repo cleanup: ${rel}`
      );
    }

    const cargoTomlPath = path.join(REPO_ROOT, "Cargo.toml");
    assert.ok(fs.existsSync(cargoTomlPath), "Root Cargo.toml must exist");
    const cargoToml = fs.readFileSync(cargoTomlPath, "utf8");
    assertIncludes(cargoToml, "[workspace]", "Root Cargo.toml must declare [workspace]");
    assert.equal(
      /^\s*\[package\]/m.test(cargoToml),
      false,
      "Root Cargo.toml must be a virtual workspace (no [package] section)"
    );

    const requiredKept = [
      "server/server.mjs",
      "js/cli.mjs",
      "e2e_docker_web",
    ];
    for (const rel of requiredKept) {
      assert.ok(
        fs.existsSync(path.join(REPO_ROOT, rel)),
        `Interactive tool path must be retained: ${rel}`
      );
    }
  });

  suite.add("T1-V2.2", "F11 Default system Light mode: WCAG luminance, contrast >= 4.5, legible terminal, zero errors", async () => {
    await ensureOfflineEnv();
    const browser = await launchCdpBrowser({ chromePath, colorScheme: "light" });
    try {
      await browser.navigate(server.url);
      await browser.waitForSelector("body", 10000);

      const bodyColors = await getEffectiveColors(browser, "body");
      assert.ok(bodyColors && bodyColors.bgLuminance !== null && bodyColors.fgLuminance !== null,
        `Could not resolve body computed colors: ${JSON.stringify(bodyColors)}`);
      assert.ok(
        bodyColors.bgLuminance > 0.65,
        `Light mode body background must be light (L > 0.65), got L=${bodyColors.bgLuminance.toFixed(3)} (${bodyColors.backgroundColor})`
      );
      assert.ok(
        bodyColors.fgLuminance < 0.25,
        `Light mode body text must be dark (L < 0.25), got L=${bodyColors.fgLuminance.toFixed(3)} (${bodyColors.color})`
      );
      assert.ok(
        bodyColors.contrast >= 4.5,
        `Light mode body text contrast must be >= 4.5 (WCAG AA), got ${bodyColors.contrast.toFixed(2)}`
      );

      const termColors = await getEffectiveColors(browser, "#terminal, [data-terminal], .terminal-output, .terminal");
      if (termColors && termColors.contrast !== null) {
        assert.ok(
          termColors.contrast >= 4.5,
          `Light mode terminal contrast must be >= 4.5, got ${termColors.contrast.toFixed(2)} (bg=${termColors.backgroundColor}, fg=${termColors.color})`
        );
      }

      assert.deepEqual(browser.exceptions, [], `Uncaught exceptions in Light mode: ${JSON.stringify(browser.exceptions)}`);
      assert.deepEqual(browser.consoleErrors, [], `Console errors in Light mode: ${JSON.stringify(browser.consoleErrors)}`);
    } finally {
      await browser.close();
    }
  });

  suite.add("T1-V2.3", "F11 Default system Dark mode & manual theme switcher persistence across reload", async () => {
    await ensureOfflineEnv();
    const browser = await launchCdpBrowser({ chromePath, colorScheme: "dark" });
    try {
      await browser.navigate(server.url);
      await browser.waitForSelector("body", 10000);

      const darkColors = await getEffectiveColors(browser, "body");
      assert.ok(darkColors && darkColors.bgLuminance !== null && darkColors.fgLuminance !== null,
        `Could not resolve dark mode body colors: ${JSON.stringify(darkColors)}`);
      assert.ok(
        darkColors.bgLuminance < 0.25,
        `Dark mode body background must be dark (L < 0.25), got L=${darkColors.bgLuminance.toFixed(3)} (${darkColors.backgroundColor})`
      );
      assert.ok(
        darkColors.fgLuminance > 0.65,
        `Dark mode body text must be light (L > 0.65), got L=${darkColors.fgLuminance.toFixed(3)} (${darkColors.color})`
      );
      assert.ok(
        darkColors.contrast >= 4.5,
        `Dark mode body text contrast must be >= 4.5, got ${darkColors.contrast.toFixed(2)}`
      );

      // Flip manually to Light mode
      const switched = await selectThemeMode(browser, "light");
      assert.ok(switched.ok, "Theme switcher control (light/dark/system) must be present and clickable");

      await waitFor(
        async () => {
          const c = await getEffectiveColors(browser, "body");
          return c && c.bgLuminance > 0.65;
        },
        { timeoutMs: 5000, intervalMs: 100, label: "manual switch from Dark to Light mode" }
      );

      const lightAfterSwitch = await getEffectiveColors(browser, "body");
      assert.ok(lightAfterSwitch.bgLuminance > 0.65, `Expected light bg after manual switch, got L=${lightAfterSwitch.bgLuminance}`);
      assert.ok(lightAfterSwitch.contrast >= 4.5, `Expected contrast >= 4.5 after manual switch, got ${lightAfterSwitch.contrast}`);

      // Reload while OS media is still dark — explicit user choice must persist
      await browser.navigate(server.url);
      await browser.waitForSelector("body", 10000);
      const afterReload = await getEffectiveColors(browser, "body");
      assert.ok(
        afterReload.bgLuminance > 0.65,
        `Manual Light theme choice must persist across reload even when OS prefers-color-scheme: dark (got L=${afterReload.bgLuminance})`
      );

      assert.deepEqual(browser.exceptions, [], `Uncaught exceptions: ${JSON.stringify(browser.exceptions)}`);
      assert.deepEqual(browser.consoleErrors, [], `Console errors: ${JSON.stringify(browser.consoleErrors)}`);
    } finally {
      await browser.close();
    }
  });

  suite.add("T1-V2.4", "F14 Well-known presets: zero Bottle/Nano ID/Nushell; Express & Flask present and load valid Dockerfile/layers", async () => {
    await ensureOfflineEnv();
    const browser = await launchCdpBrowser({ chromePath, colorScheme: "light" });
    try {
      await browser.navigate(server.url);
      await browser.waitForSelector("body", 10000);

      const pageText = await browser.getText("body");
      assert.equal(/\bbottle\b/i.test(pageText), false, "Legacy 'Bottle' preset must not appear in UI");
      assert.equal(/nano\s*id|\bnanoid\b/i.test(pageText), false, "Legacy 'Nano ID' preset must not appear in UI");
      assert.equal(/\bnushell\b/i.test(pageText), false, "Legacy 'Nushell' preset must not appear in UI");

      const presets = await getAllPresets(browser);
      assert.ok(presets.length >= 2, `Expected at least 2 well-known presets, found ${presets.length}`);
      const allPresetText = presets.map((p) => `${p.id} ${p.text} ${p.title}`).join(" | ");
      assert.ok(/express/i.test(allPresetText), `Expected an Express.js preset, got: ${allPresetText}`);
      assert.ok(/flask/i.test(allPresetText), `Expected a Flask preset, got: ${allPresetText}`);

      // Click Express preset and verify valid Dockerfile populated
      const clickExpress = await clickPresetMatching(browser, /express/i);
      assert.ok(clickExpress.clicked, "Could not click Express preset");
      await setEditorMode(browser, "dockerfile");
      const expressDf = await getDockerfileText(browser);
      assert.ok(/^\s*FROM\s+\S+/im.test(expressDf), `Express preset must populate a valid FROM Dockerfile, got:\n${expressDf}`);

      // Click Flask preset and verify valid Dockerfile populated
      const clickFlask = await clickPresetMatching(browser, /flask/i);
      assert.ok(clickFlask.clicked, "Could not click Flask preset");
      await setEditorMode(browser, "dockerfile");
      const flaskDf = await getDockerfileText(browser);
      assert.ok(/^\s*FROM\s+\S+/im.test(flaskDf), `Flask preset must populate a valid FROM Dockerfile, got:\n${flaskDf}`);
      assert.notEqual(expressDf.trim(), flaskDf.trim(), "Express and Flask presets must produce distinct Dockerfiles");

      assert.deepEqual(browser.exceptions, [], `Uncaught exceptions: ${JSON.stringify(browser.exceptions)}`);
    } finally {
      await browser.close();
    }
  });

  suite.add("T1-V2.5", "F7/F12 Visual Layer Builder <-> Dockerfile bidirectional sync (FROM, GIT, WORKDIR, ENV, RUN, SWEEP)", async () => {
    await ensureOfflineEnv();

    // Part A: Verify web/dockerfile.mjs module contract directly if present
    if (fs.existsSync(REQUIRED_ARTIFACTS.dockerfileModule)) {
      const dfMod = await import(pathToFileURL(REQUIRED_ARTIFACTS.dockerfileModule).href);
      const parseFn = dfMod.parseDockerfile || dfMod.parse;
      const serializeFn = dfMod.serializeDockerfile || dfMod.serialize;
      assert.equal(typeof parseFn, "function", "web/dockerfile.mjs must export parseDockerfile()");
      assert.equal(typeof serializeFn, "function", "web/dockerfile.mjs must export serializeDockerfile()");

      const sampleDf = [
        "FROM alpine:latest",
        "RUN git clone --branch main https://github.com/example/demo /workspace",
        "WORKDIR /workspace",
        "ENV MODE=fast",
        "RUN echo hello",
        "# elf2wasm:sweep param=env envKey=MODE mode=list values=alpha,beta",
        "RUN echo $MODE",
      ].join("\n");
      const parsed = parseFn(sampleDf);
      const layers = Array.isArray(parsed) ? parsed : parsed?.layers;
      assert.ok(Array.isArray(layers) && layers.length >= 6, `Expected >= 6 parsed layers, got ${JSON.stringify(parsed)}`);
      const types = new Set(layers.map((l) => l.type));
      for (const t of ["from", "git", "workdir", "env", "run", "sweep"]) {
        assert.ok(types.has(t), `Parsed layers must include type "${t}", got: ${Array.from(types).join(", ")}`);
      }
      const roundTripped = serializeFn(layers);
      assertIncludes(roundTripped, "FROM alpine:latest");
      assertIncludes(roundTripped, "WORKDIR /workspace");
      assertIncludes(roundTripped, "ENV MODE=fast");
      assertIncludes(roundTripped, "RUN echo $MODE");
    }

    // Part B: Opaque-box browser DOM bidirectional sync
    const browser = await launchCdpBrowser({ chromePath, colorScheme: "light" });
    try {
      await browser.navigate(server.url);
      await browser.waitForSelector("body", 10000);

      const inputDockerfile = [
        `FROM ${alpineRef}`,
        "WORKDIR /workspace",
        "ENV GREETING=hello_sync",
        "RUN echo $GREETING",
      ].join("\n");

      await setDockerfileText(browser, inputDockerfile);

      // Switch to visual layer builder and verify layers rendered
      await setEditorMode(browser, "builder");
      const controls = await inspectLayerControls(browser);
      assert.ok(
        controls.layerCardCount >= 3,
        `Visual layer builder must render layer rows for pasted Dockerfile (found ${controls.layerCardCount})`
      );

      // Add a new RUN layer via builder UI button if available
      const addRes = await clickControlByLabel(browser, /add\s+(run|layer|step)|\+\s*run/i);
      if (addRes.clicked) {
        await setEditorMode(browser, "dockerfile");
        const updatedDf = await getDockerfileText(browser);
        assertIncludes(updatedDf, `FROM ${alpineRef}`);
        assertIncludes(updatedDf, "GREETING=hello_sync");
      }

      assert.deepEqual(browser.exceptions, [], `Uncaught exceptions: ${JSON.stringify(browser.exceptions)}`);
    } finally {
      await browser.close();
    }
  });

  suite.add("T1-V2.6", "F13 Global 'Run All Locally' / 'Run All Remotely' and per-layer Local/Remote controls", async () => {
    await ensureOfflineEnv();
    const browser = await launchCdpBrowser({ chromePath, colorScheme: "light" });
    try {
      await browser.navigate(server.url);
      await browser.waitForSelector("body", 10000);

      const bodyText = await browser.getText("body");
      assert.ok(/run\s+all\s+locally/i.test(bodyText), "UI must expose a top-level 'Run All Locally' control");
      assert.ok(/run\s+all\s+remotely/i.test(bodyText), "UI must expose a top-level 'Run All Remotely' control");

      // Populate a stack with a RUN layer and inspect per-layer executor selectors
      await setDockerfileText(browser, `FROM ${alpineRef}\nRUN echo LAYER_CTRL_CHECK\n`);
      await setEditorMode(browser, "builder");
      const controls = await inspectLayerControls(browser);
      assert.ok(
        controls.executorControlCount >= 1,
        `Expected at least 1 per-layer local/remote executor control, found ${controls.executorControlCount}`
      );

      assert.deepEqual(browser.exceptions, [], `Uncaught exceptions: ${JSON.stringify(browser.exceptions)}`);
    } finally {
      await browser.close();
    }
  });

  suite.add("T1-V2.7", "F5/F6 POST /api/eval JSON happy path: schema, stdout, virtualTimeNs, outputDiffTarGzBase64 & modifiedFiles", async () => {
    await ensureOfflineEnv();
    const res = await postEvalJson(server.url, {
      baseImage: alpineRef,
      cmd: ["/bin/sh", "-c", "echo EVAL_JSON_OK && printf 'ARTIFACT_PAYLOAD_42\\n' > /tmp/out.txt"],
      env: ["TEST_VAR=hello"],
      cwd: "/",
      returnOutputDiff: true,
    });

    assert.equal(res.status, 200, `Expected HTTP 200 from POST /api/eval, got ${res.status}: ${res.text}`);
    assert.ok(res.json && typeof res.json === "object", `Expected JSON object response, got: ${res.text}`);
    assert.equal(res.json.ok, true, `Expected ok=true, got ${JSON.stringify(res.json)}`);
    assert.equal(res.json.executor, "remote-wasmi", `Expected executor='remote-wasmi', got ${res.json.executor}`);
    assert.equal(res.json.exitCode, 0, `Expected exitCode=0, got ${res.json.exitCode} (stderr=${res.json.stderr})`);
    assertIncludes(res.json.stdout, "EVAL_JSON_OK");
    assert.ok(
      res.json.virtualTimeNs !== undefined && /^\d+$/.test(String(res.json.virtualTimeNs)),
      `Expected numeric virtualTimeNs string, got ${JSON.stringify(res.json.virtualTimeNs)}`
    );
    assert.ok(
      typeof res.json.outputDiffTarGzBase64 === "string" && res.json.outputDiffTarGzBase64.length > 0,
      "Expected non-empty outputDiffTarGzBase64"
    );

    const decoded = decodeTarGzBase64(res.json.outputDiffTarGzBase64);
    const outEntry = findTarEntry(decoded.entries, "tmp/out.txt");
    assert.ok(outEntry, `Expected tmp/out.txt in output diff tar; entries=${decoded.entries.map((e) => e.name).join(", ")}`);
    assert.equal(Buffer.from(outEntry.data).toString("utf8"), "ARTIFACT_PAYLOAD_42\n");

    assert.ok(Array.isArray(res.json.modifiedFiles), "modifiedFiles must be an array");
    const mod = res.json.modifiedFiles.find((m) => m.path === "/tmp/out.txt" || m.path === "tmp/out.txt");
    assert.ok(mod, `modifiedFiles must include /tmp/out.txt: ${JSON.stringify(res.json.modifiedFiles)}`);
    assert.equal(mod.kind, "file");
  });

  suite.add("T1-V2.8", "F5/F6 POST /api/eval direct .tar.gz download via Accept: application/gzip AND ?format=tar.gz", async () => {
    await ensureOfflineEnv();
    const payload = {
      baseImage: alpineRef,
      cmd: ["/bin/sh", "-c", "printf 'DOWNLOAD_TAR_OK\\n' > /tmp/build.txt"],
      cwd: "/",
      returnOutputDiff: true,
    };

    for (const useQueryFormat of [false, true]) {
      const modeLabel = useQueryFormat ? "?format=tar.gz" : "Accept: application/gzip";
      const res = await postEvalTarGz(server.url, payload, { useQueryFormat });
      assert.equal(res.status, 200, `${modeLabel}: expected HTTP 200, got ${res.status} (${res.text})`);
      assertIncludes(
        res.headers["content-type"] || "",
        "application/gzip",
        `${modeLabel}: Content-Type must be application/gzip`
      );
      assertIncludes(
        res.headers["content-disposition"] || "",
        ".tar.gz",
        `${modeLabel}: Content-Disposition must suggest a .tar.gz filename`
      );
      assert.equal(
        res.headers["x-eval-exit-code"],
        "0",
        `${modeLabel}: X-Eval-Exit-Code header must be "0"`
      );
      assert.ok(
        /^\d+$/.test(res.headers["x-eval-virtual-time-ns"] || ""),
        `${modeLabel}: X-Eval-Virtual-Time-Ns header must be numeric (got ${res.headers["x-eval-virtual-time-ns"]})`
      );

      const entry = findTarEntry(res.entries, "tmp/build.txt");
      assert.ok(entry, `${modeLabel}: downloaded tar.gz must contain tmp/build.txt`);
      assert.equal(Buffer.from(entry.data).toString("utf8"), "DOWNLOAD_TAR_OK\n");
    }
  });

  try {
    return await suite.run(opts);
  } finally {
    if (server) await server.close();
    if (registry) await registry.close();
  }
}
