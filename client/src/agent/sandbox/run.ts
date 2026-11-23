/**
 * One `run_code` in QuickJS (docs/protocol.md, "Agent tools (v1)"; D-115). The
 * guest gets the language, `console.log` and its inputs and nothing else: QuickJS
 * has no network, files or timers of its own and only what is passed in here is
 * reachable. Framework-free so it can be tested without a browser.
 */
import type { QuickJSWASMModule } from "quickjs-emscripten-core";

/** Bytes of output the model gets, within what `permission.respond` takes of it. */
const OUTPUT_MAX = 30 * 1024;
const MEMORY_MAX = 64 * 1024 * 1024;
const STACK_MAX = 512 * 1024;
/** When the interpreter stops itself; the worker's end comes later, for what ignores this. */
const RUN_MS = 3000;

export interface RunInputs {
  files: Record<string, string>;
  registers: Record<string, unknown>;
}

export interface RunResult {
  output: string;
  value?: unknown;
  truncated?: true;
  error?: string;
}

/** Wraps the bridge, then removes it, so the guest holds only the closure. */
const PRELUDE = `(() => {
  const print = globalThis.__print;
  const text = (v) => (typeof v === "string" ? v : JSON.stringify(v));
  const log = (...args) => print(args.map(text).join(" "));
  globalThis.console = { log, info: log, warn: log, error: log };
  globalThis.inputs = JSON.parse(globalThis.__inputs);
  delete globalThis.__print;
  delete globalThis.__inputs;
  // Nothing shares it, as the guest has one thread; left out so nothing assumes otherwise.
  delete globalThis.SharedArrayBuffer;
})();`;

/** The error with its place in the script: the model reads this to correct the code. */
function message(dumped: unknown): string {
  if (dumped && typeof dumped === "object") {
    const { name, message: text, stack } = dumped as { name?: unknown; message?: unknown; stack?: unknown };
    if (typeof text === "string") {
      const head = typeof name === "string" ? `${name}: ${text}` : text;
      return typeof stack === "string" && stack.trim() !== "" ? `${head}\n${stack.trim()}` : head;
    }
  }
  return String(dumped);
}

export function runCode(module: QuickJSWASMModule, code: string, inputs: RunInputs, ms: number = RUN_MS): RunResult {
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(MEMORY_MAX);
  runtime.setMaxStackSize(STACK_MAX);
  const deadline = Date.now() + ms;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const vm = runtime.newContext();
  const utf8 = new TextEncoder();
  let output = "";
  let size = 0;
  let truncated = false;
  try {
    const print = vm.newFunction("print", (line) => {
      const text = `${vm.getString(line)}\n`;
      const length = utf8.encode(text).length;
      if (truncated || size + length > OUTPUT_MAX) truncated = true;
      else {
        output += text;
        size += length;
      }
    });
    vm.setProp(vm.global, "__print", print);
    print.dispose();
    const data = vm.newString(JSON.stringify(inputs));
    vm.setProp(vm.global, "__inputs", data);
    data.dispose();
    vm.unwrapResult(vm.evalCode(PRELUDE)).dispose();

    const result: RunResult = { output };
    const evaluated = vm.evalCode(code);
    if (evaluated.error) {
      result.error = message(vm.dump(evaluated.error));
      evaluated.error.dispose();
    } else {
      let value: unknown;
      try {
        value = vm.dump(evaluated.value);
      } catch {
        // A promise cannot be read this way: what it prints is the result.
      }
      if (evaluated.value.alive) evaluated.value.dispose();
      // A value JSON cannot carry says nothing the model could read.
      if (value !== undefined && JSON.stringify(value) !== undefined) result.value = value;
    }
    // Promise callbacks: the model may write `.then`. Their failures stay the guest's.
    const jobs = runtime.executePendingJobs();
    if (jobs.error) {
      result.error ??= message(vm.dump(jobs.error));
      jobs.error.dispose();
    }
    result.output = output;
    if (truncated) result.truncated = true;
    return result;
  } catch (e) {
    return { output, error: e instanceof Error ? e.message : "the code could not run" };
  } finally {
    // Code stopped at the memory limit can leave QuickJS unable to free itself:
    // its result stands, and the worker ends with the run anyway.
    try {
      vm.dispose();
      runtime.dispose();
    } catch {
      // Nothing to do.
    }
  }
}

/** The result as the tool's answer: the value is dropped first when it would not fit. */
export function resultText(result: RunResult): string {
  const text = JSON.stringify(result);
  if (new TextEncoder().encode(text).length <= 32 * 1024) return text;
  const { value: _, ...rest } = result;
  return JSON.stringify({ ...rest, truncated: true });
}
