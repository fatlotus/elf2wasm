/**
 * Thin Cloudflare Worker Wrangler entrypoint.
 *
 * Statically imports the pre-compiled `elf2wasm_worker_wasm.wasm` module
 * (staged by `worker/scripts/build_assets.mjs`) so Cloudflare Workers can
 * instantiate it with zero dynamic `WebAssembly.compile()` calls.
 */

import workerWasmModule from "./elf2wasm_worker_wasm.wasm";
import { createWorkerHandler } from "./handler.mjs";

export { createWorkerHandler };
export default createWorkerHandler({ workerWasmModule });
