/// <reference lib="webworker" />
/**
 * The crypto worker: the only place the ARK and scope private keys live in the
 * browser. It runs chat-crypto compiled to WASM and answers `WorkerRequest`s.
 */

import type { WorkerRequest, WorkerResponse } from "./protocol";
import init, { Vault } from "./wasm/chat_crypto";

declare const self: DedicatedWorkerGlobalScope;

const ready = init();
let vault: Vault | null = null;

function reply(response: WorkerResponse): void {
  self.postMessage(response);
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    await ready;
    switch (request.op) {
      case "open":
        vault?.free();
        vault = new Vault(request.userId);
        reply({ id: request.id, ok: true, value: null });
        break;
      case "close":
        vault?.lock();
        vault?.free();
        vault = null;
        reply({ id: request.id, ok: true, value: null });
        break;
      case "call": {
        if (!vault) throw new Error("no vault open");
        const method = vault[request.method] as (...args: unknown[]) => unknown;
        reply({ id: request.id, ok: true, value: method.apply(vault, request.args) });
        break;
      }
    }
  } catch (e) {
    reply({ id: request.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
};
