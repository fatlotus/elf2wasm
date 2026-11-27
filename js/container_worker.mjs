/**
 * Dedicated ES Module Web Worker host for client-side Docker-on-WASM execution.
 *
 * Loads compiler.wasm + runtime.wasm, pulls/decompresses OCI layers, compiles
 * ELFs with cross-container caching, and runs containers completely off the
 * browser main thread.
 */

import { ContainerEngine } from "./docker_sdk.mjs";

const engine = new ContainerEngine();
const activeAborts = new Map();

function postReply(id, ok, resultOrError, transfer = []) {
  if (!id) return;
  if (ok) {
    self.postMessage({ id, ok: true, result: resultOrError }, transfer);
  } else {
    const err = resultOrError;
    self.postMessage({
      id,
      ok: false,
      error: {
        message: err && err.message ? String(err.message) : String(err),
        name: err && err.name ? String(err.name) : "Error",
        code: err && err.code ? String(err.code) : undefined,
      },
    });
  }
}

function collectPipelineTransferables(res) {
  if (!res || typeof res !== "object") return [];
  const seen = new Set();
  const collectLayer = (lr) => {
    if (!lr || !(lr.outputDiffTarGz instanceof Uint8Array)) return;
    const u8 = lr.outputDiffTarGz;
    if (u8.byteOffset !== 0 || u8.byteLength !== u8.buffer.byteLength || seen.has(u8.buffer)) {
      lr.outputDiffTarGz = u8.slice();
    }
    seen.add(lr.outputDiffTarGz.buffer);
  };
  if (Array.isArray(res.layers)) {
    for (const lr of res.layers) collectLayer(lr);
  }
  if (res.sweep && Array.isArray(res.sweep.variations)) {
    for (const v of res.sweep.variations) {
      if (Array.isArray(v.layers)) {
        for (const lr of v.layers) collectLayer(lr);
      }
    }
  }
  return Array.from(seen);
}

async function handleMessage(ev) {
  const msg = ev.data;
  if (!msg || typeof msg !== "object") return;
  const { id, type, payload = {} } = msg;

  try {
    switch (type) {
      case "init": {
        await engine.init(payload);
        postReply(id, true, { ok: true });
        break;
      }

      case "abort": {
        const ctrl = activeAborts.get(payload.targetId);
        if (ctrl) ctrl.abort();
        break;
      }

      case "pullImage": {
        const ctrl = new AbortController();
        if (id) activeAborts.set(id, ctrl);
        try {
          const meta = await engine.pullImage(payload.imageRef, {
            platform: payload.platform,
            registryProxyBase: payload.registryProxyBase,
            signal: ctrl.signal,
            onProgress: (data) => {
              self.postMessage({ event: "progress", reqId: id, data });
            },
          });
          postReply(id, true, meta);
        } finally {
          if (id) activeAborts.delete(id);
        }
        break;
      }

      case "loadOciTarball": {
        const meta = await engine.loadOciTarball(payload.tarBytes, {
          ...(payload.options || {}),
          onProgress: (data) => {
            self.postMessage({ event: "progress", reqId: id, data });
          },
        });
        postReply(id, true, meta);
        break;
      }

      case "releaseImage": {
        engine.releaseImage(payload.imageId);
        postReply(id, true, { ok: true });
        break;
      }

      case "createContainer": {
        const ctrl = new AbortController();
        if (id) activeAborts.set(id, ctrl);
        try {
          let boundContainerId = 0;
          const opts = payload.options || {};
          const res = await engine.createContainer(
            payload.imageId,
            {
              ...opts,
              signal: ctrl.signal,
              onProgress: (data) => {
                if (boundContainerId !== 0) {
                  self.postMessage({
                    event: "containerProgress",
                    containerId: boundContainerId,
                    data,
                  });
                } else {
                  self.postMessage({ event: "progress", reqId: id, data });
                }
              },
            },
            {
              onStdout: (chunk) => {
                const copy = chunk instanceof Uint8Array ? chunk.slice() : new Uint8Array(chunk);
                self.postMessage(
                  { event: "stdout", containerId: boundContainerId, chunk: copy },
                  [copy.buffer]
                );
              },
              onStderr: (chunk) => {
                const copy = chunk instanceof Uint8Array ? chunk.slice() : new Uint8Array(chunk);
                self.postMessage(
                  { event: "stderr", containerId: boundContainerId, chunk: copy },
                  [copy.buffer]
                );
              },
              onExit: (exitCode) => {
                self.postMessage({ event: "exit", containerId: boundContainerId, exitCode });
              },
            }
          );
          boundContainerId = res.containerId;
          postReply(id, true, res);
        } finally {
          if (payload.options && payload.options.overlayTarBytes) {
            payload.options.overlayTarBytes = null;
          }
          if (id) activeAborts.delete(id);
        }
        break;
      }

      case "start": {
        await engine.startContainer(payload.containerId);
        postReply(id, true, { ok: true });
        break;
      }

      case "writeStdin": {
        engine.writeStdin(payload.containerId, payload.data);
        break;
      }

      case "closeStdin": {
        engine.closeStdin(payload.containerId);
        break;
      }

      case "resize": {
        engine.resize(payload.containerId, payload.cols, payload.rows);
        break;
      }

      case "sendSignal": {
        engine.sendSignal(payload.containerId, payload.signal);
        break;
      }

      case "readFile": {
        const bytes = engine.readFile(payload.containerId, payload.path);
        if (bytes) {
          const copy = bytes.slice();
          postReply(id, true, copy, [copy.buffer]);
        } else {
          postReply(id, true, null);
        }
        break;
      }

      case "writeFile": {
        engine.writeFile(payload.containerId, payload.path, payload.data, payload.mode);
        postReply(id, true, { ok: true });
        break;
      }

      case "snapshotVfs": {
        const snapshotId = engine.snapshotVfs(payload.containerId);
        postReply(id, true, snapshotId);
        break;
      }

      case "restoreVfs": {
        engine.restoreVfs(payload.containerId, payload.snapshotId);
        postReply(id, true, { ok: true });
        break;
      }

      case "dropVfsSnapshot": {
        engine.dropVfsSnapshot(payload.containerId, payload.snapshotId);
        postReply(id, true, { ok: true });
        break;
      }

      case "exportVfsDiffTar": {
        const bytes = engine.exportVfsDiffTar(payload.containerId, payload.options || {});
        const copy = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes || 0);
        postReply(id, true, copy, [copy.buffer]);
        break;
      }

      case "listVfsDiff": {
        const entries = engine.listVfsDiff(payload.containerId, payload.options || {});
        postReply(id, true, entries);
        break;
      }

      case "applyTarOverlay": {
        await engine.applyTarOverlay(payload.containerId, payload.tarBytes, payload.options || {});
        postReply(id, true, { ok: true });
        break;
      }

      case "mountGitRepo": {
        const ctrl = new AbortController();
        if (id) activeAborts.set(id, ctrl);
        try {
          const opts = payload.options || {};
          const res = await engine.mountGitRepo(payload.containerId, {
            ...opts,
            signal: ctrl.signal,
            onProgress: (data) => {
              self.postMessage({ event: "progress", reqId: id, data });
            },
          });
          postReply(id, true, res);
        } finally {
          if (id) activeAborts.delete(id);
        }
        break;
      }

      case "runLayerPipeline": {
        const ctrl = new AbortController();
        if (id) activeAborts.set(id, ctrl);
        try {
          const opts = payload.options || {};
          const res = await engine.runLayerPipeline(payload.layers || [], {
            ...opts,
            signal: ctrl.signal,
            onProgress: (data) => {
              self.postMessage({ event: "progress", reqId: id, data });
            },
            onLayerStart: opts._hasLayerStart
              ? (data) => {
                  self.postMessage({ event: "pipelineEvent", reqId: id, kind: "layerStart", data });
                }
              : undefined,
            onLayerOutput: opts._hasLayerOutput
              ? (data) => {
                  const copy =
                    data.chunk instanceof Uint8Array
                      ? data.chunk.slice()
                      : new Uint8Array(data.chunk || 0);
                  self.postMessage(
                    {
                      event: "pipelineEvent",
                      reqId: id,
                      kind: "layerOutput",
                      data: { ...data, chunk: copy },
                    },
                    [copy.buffer]
                  );
                }
              : undefined,
            onLayerComplete: opts._hasLayerComplete
              ? (data) => {
                  self.postMessage({
                    event: "pipelineEvent",
                    reqId: id,
                    kind: "layerComplete",
                    data,
                  });
                }
              : undefined,
            onVariationStart: opts._hasVariationStart
              ? (data) => {
                  self.postMessage({
                    event: "pipelineEvent",
                    reqId: id,
                    kind: "variationStart",
                    data,
                  });
                }
              : undefined,
            onVariationComplete: opts._hasVariationComplete
              ? (data) => {
                  self.postMessage({
                    event: "pipelineEvent",
                    reqId: id,
                    kind: "variationComplete",
                    data,
                  });
                }
              : undefined,
          });
          const transfer = collectPipelineTransferables(res);
          postReply(id, true, res, transfer);
        } finally {
          if (id) activeAborts.delete(id);
        }
        break;
      }

      case "exec": {
        const ctrl = new AbortController();
        if (id) activeAborts.set(id, ctrl);
        try {
          const opts = payload.options || {};
          const res = await engine.execContainer(payload.containerId, {
            ...opts,
            signal: ctrl.signal,
            onStdout: opts._streamStdout
              ? (chunk) => {
                  const copy =
                    chunk instanceof Uint8Array ? chunk.slice() : new Uint8Array(chunk);
                  self.postMessage(
                    { event: "execStdout", reqId: id, containerId: payload.containerId, chunk: copy },
                    [copy.buffer]
                  );
                }
              : undefined,
            onStderr: opts._streamStderr
              ? (chunk) => {
                  const copy =
                    chunk instanceof Uint8Array ? chunk.slice() : new Uint8Array(chunk);
                  self.postMessage(
                    { event: "execStderr", reqId: id, containerId: payload.containerId, chunk: copy },
                    [copy.buffer]
                  );
                }
              : undefined,
          });
          postReply(id, true, res);
        } finally {
          if (id) activeAborts.delete(id);
        }
        break;
      }

      case "stop": {
        await engine.stopContainer(payload.containerId);
        postReply(id, true, { ok: true });
        break;
      }

      case "dispose": {
        await engine.dispose();
        postReply(id, true, { ok: true });
        break;
      }

      default:
        postReply(id, false, new Error(`Unknown worker message type: ${type}`));
    }
  } catch (err) {
    postReply(id, false, err);
  }
}

if (typeof self !== "undefined" && typeof self.addEventListener === "function") {
  self.addEventListener("message", handleMessage);
}
