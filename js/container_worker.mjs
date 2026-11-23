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
        let boundContainerId = 0;
        const res = await engine.createContainer(
          payload.imageId,
          {
            ...(payload.options || {}),
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
