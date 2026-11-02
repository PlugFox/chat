/**
 * The worker a `run_code` runs in, started for it and ended with it (D-115):
 * apart from the crypto worker, so guest code never shares memory with keys.
 */
import variant from "@jitl/quickjs-wasmfile-release-sync";
import wasmLocation from "@jitl/quickjs-wasmfile-release-sync/wasm?url";
import { newQuickJSWASMModuleFromVariant, newVariant } from "quickjs-emscripten-core";
import { type RunInputs, runCode } from "./run";

export interface SandboxRequest {
  code: string;
  inputs: RunInputs;
}

self.onmessage = async (event: MessageEvent<SandboxRequest>) => {
  try {
    const module = await newQuickJSWASMModuleFromVariant(newVariant(variant, { wasmLocation }));
    self.postMessage(runCode(module, event.data.code, event.data.inputs));
  } catch {
    self.postMessage({ output: "", error: "the sandbox could not start" });
  }
};
