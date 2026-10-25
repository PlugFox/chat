/// <reference lib="webworker" />
/**
 * The crypto worker: the only place the ARK and scope private keys live in the
 * browser. It runs chat-crypto compiled to WASM and answers `WorkerRequest`s.
 * It also owns the remembered device's secret, which it decrypts with
 * WebCrypto and hands to WASM only.
 */

import { createSecret, forgetDevice, openSecret, rememberedDevice } from "./device";
import type { WorkerRequest, WorkerResponse } from "./protocol";
import init, { describeWrap, Vault } from "./wasm/chat_crypto";

declare const self: DedicatedWorkerGlobalScope;

const ready = init();
let vault: Vault | null = null;
let userId: Uint8Array | null = null;
const WORKER_ONLY = new Set<string>(["deviceWrap", "unlockWithDeviceSecret"]);

function reply(response: WorkerResponse): void {
  self.postMessage(response);
}

function opened(): { vault: Vault; userId: Uint8Array } {
  if (!vault || !userId) throw new Error("no vault open");
  return { vault, userId };
}

async function handle(request: WorkerRequest): Promise<unknown> {
  await ready;
  switch (request.op) {
    case "open":
      vault?.free();
      vault = new Vault(request.userId);
      userId = request.userId;
      return null;
    case "close":
      vault?.lock();
      vault?.free();
      vault = null;
      userId = null;
      return null;
    case "call": {
      // The device-secret methods belong to the operations below; refusing them
      // here keeps the main thread from driving them with a secret of its own.
      if (WORKER_ONLY.has(String(request.method))) throw new Error(`${String(request.method)} is not callable`);
      const v = opened().vault;
      const method = v[request.method] as (...args: unknown[]) => unknown;
      return method.apply(v, request.args);
    }
    case "describe":
      return describeWrap(request.wrap);
    case "remember": {
      const o = opened();
      const deviceId = new Uint8Array(request.deviceId);
      const secret = await createSecret(o.userId, deviceId);
      try {
        return o.vault.deviceWrap(request.wrapId, deviceId, secret);
      } finally {
        secret.fill(0);
      }
    }
    case "unlockWithDevice": {
      const o = opened();
      const secret = await openSecret(o.userId);
      try {
        o.vault.unlockWithDeviceSecret(secret, request.wrap, request.commitment);
        return null;
      } finally {
        secret.fill(0);
      }
    }
    case "remembered":
      return rememberedDevice(opened().userId);
    case "forget":
      await forgetDevice(opened().userId);
      return null;
  }
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    reply({ id: request.id, ok: true, value: await handle(request) });
  } catch (e) {
    reply({ id: request.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
};
