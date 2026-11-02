/**
 * Runs code in a worker of its own and ends the worker however it went
 * (D-115): nothing a run leaves in memory reaches the next, and `terminate`
 * stops what the interpreter's own deadline does not.
 */
import type { RunInputs, RunResult } from "./run";
import type { SandboxRequest } from "./worker";

/** Past the interpreter's deadline, and the module's first load. */
const WORKER_MS = 10_000;

export function runInSandbox(code: string, inputs: RunInputs): Promise<RunResult> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    const end = (result: RunResult) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => end({ output: "", error: "the code took too long; make it do less" }), WORKER_MS);
    worker.onmessage = (event: MessageEvent<RunResult>) => end(event.data);
    worker.onerror = () => end({ output: "", error: "the code ran out of memory or stopped the sandbox" });
    const request: SandboxRequest = { code, inputs };
    worker.postMessage(request);
  });
}
