import { newQuickJSWASMModuleFromVariant, newVariant } from "quickjs-emscripten-core";
import { beforeEach, describe, expect, it } from "vitest";
import { resultText, runCode } from "./run";

let module: Awaited<ReturnType<typeof newQuickJSWASMModuleFromVariant>>;
const none = { files: {}, registers: {} };

// As a worker has: a module of its own for each run.
beforeEach(async () => {
  const variant = (await import("@jitl/quickjs-wasmfile-release-sync")).default;
  // A test has no server to load it from, as the worker does; the client's types know no Node.
  const fs = (await import("node:fs" as string)) as { readFileSync(path: string): Uint8Array };
  const file = fs.readFileSync("node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm");
  const wasmBinary = new Uint8Array(file).buffer;
  module = await newQuickJSWASMModuleFromVariant(newVariant(variant, { wasmBinary }));
});

describe("the sandbox", () => {
  it("calculates, prints and returns the last value", () => {
    const result = runCode(module, "console.log('sum', [1, 2, 3].reduce((a, b) => a + b)); 6 * 7", none);
    expect(result).toEqual({ output: "sum 6\n", value: 42 });
  });

  it("reads what it was given", () => {
    const inputs = { files: { a: "x,y\n1,2" }, registers: { weight: { entries: [{ value: 80 }] } } };
    expect(
      runCode(module, "inputs.files.a.split('\\n').length + inputs.registers.weight.entries[0].value", inputs).value,
    ).toBe(82);
  });

  it("has nothing of the host to reach", () => {
    const names = [
      "fetch",
      "XMLHttpRequest",
      "WebSocket",
      "Worker",
      "SharedArrayBuffer",
      "Atomics",
      "importScripts",
      "postMessage",
      "self",
      "window",
      "navigator",
      "process",
      "require",
      "setTimeout",
      "__print",
      "__inputs",
    ];
    const code = `JSON.stringify(${JSON.stringify(names)}.filter((n) => typeof globalThis[n] !== "undefined"))`;
    expect(runCode(module, code, none).value).toBe("[]");
    // A function's constructor stays inside the guest.
    expect(runCode(module, "new Function('return typeof fetch')()", none).value).toBe("undefined");
    expect(runCode(module, "console.log.constructor('return typeof process')()", none).value).toBe("undefined");
    // No module loader: QuickJS's own `os` and `std` stay out of reach.
    const imported = "import('os').then(() => console.log('loaded'), () => console.log('refused'))";
    expect(runCode(module, imported, none).output).toBe("refused\n");
  });

  it("stops a loop that does not end", () => {
    const started = Date.now();
    expect(runCode(module, "while (true) {}", none, 100).error).toMatch(/interrupted/i);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("stops at its memory and stack limits", () => {
    expect(runCode(module, "const a = []; while (true) a.push(new Array(1e5).fill(1));", none).error).toBeDefined();
    expect(runCode(module, "const f = () => f(); f()", none).error).toMatch(/stack|memory|Internal/i);
  });

  it("runs promise callbacks to the end", () => {
    expect(runCode(module, "Promise.resolve(2).then((v) => console.log(v * 2))", none).output).toBe("4\n");
    expect(runCode(module, "(async () => { console.log(await 1); })()", none).output).toBe("1\n");
  });

  it("cuts long output", () => {
    const result = runCode(module, "for (let i = 0; i < 1e5; i++) console.log('x'.repeat(100));", none);
    expect(result.truncated).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(30 * 1024);
  });

  it("reports a thrown error and a broken script", () => {
    expect(runCode(module, "throw new TypeError('bad')", none).error).toMatch(/^TypeError: bad/);
    // The place, so the model can correct it.
    expect(runCode(module, "const a = 1;\nnull.x;", none).error).toMatch(/TypeError[\s\S]*:2/);
    // What was printed before the failure stays.
    expect(runCode(module, "console.log('so far'); throw 1", none).output).toBe("so far\n");
    expect(runCode(module, "(", none).error).toMatch(/SyntaxError/);
  });

  it("keeps its answer within the tool's limit", () => {
    const value = "x".repeat(64 * 1024);
    expect(new TextEncoder().encode(resultText({ output: "a", value })).length).toBeLessThan(1024);
  });
});
