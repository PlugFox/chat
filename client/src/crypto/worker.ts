/// <reference lib="webworker" />
/**
 * The crypto worker: the only place the ARK and scope private keys live in the
 * browser. It runs chat-crypto compiled to WASM and answers `WorkerRequest`s.
 * It also owns the remembered device's secret, which it decrypts with
 * WebCrypto and hands to WASM only.
 */

import { createSecret, forgetDevice, openSecret, rememberedDevice } from "./device";
import type { WorkerRequest, WorkerResponse } from "./protocol";
import init, { describeWrap, recoveryCompletions, Vault } from "./wasm/chat_crypto";

declare const self: DedicatedWorkerGlobalScope;

const ready = init();
let vault: Vault | null = null;
let userId: Uint8Array | null = null;
/** Enough to pick from on a phone; four letters already name one word. */
const COMPLETIONS = 4;
const WORKER_ONLY = new Set<string>(["deviceWrap", "unlockWithDeviceSecret", "encryptFileStart"]);
/** Plaintext read at once when a file is encrypted. */
const PIECE = 1 << 20;
/** Encrypted bytes gathered before they join the object's blob, which the browser may keep on disk. */
const GATHER = 8 << 20;

/**
 * A file's object, encrypted a piece at a time so neither the plaintext nor
 * the object is held whole (docs/crypto.md, "Client worker API").
 */
async function encryptFile(request: Extract<WorkerRequest, { op: "encryptFile" }>): Promise<unknown> {
  const { plaintext } = request;
  const encryptor = opened().vault.encryptFileStart(
    request.scopeId,
    request.keyVersion,
    request.fileId,
    plaintext.size,
    request.original,
  );
  try {
    let object = new Blob([]);
    let parts: Uint8Array<ArrayBuffer>[] = [];
    let gathered = 0;
    const gather = (part: Uint8Array<ArrayBuffer>) => {
      parts.push(part);
      gathered += part.length;
      if (gathered < GATHER) return;
      object = new Blob([object, ...parts]);
      parts = [];
      gathered = 0;
    };
    for (let at = 0; at < plaintext.size; at += PIECE) {
      const piece = new Uint8Array(await plaintext.slice(at, at + PIECE).arrayBuffer());
      gather(encryptor.push(piece) as Uint8Array<ArrayBuffer>);
      piece.fill(0);
    }
    gather(encryptor.finish() as Uint8Array<ArrayBuffer>);
    return { object: new Blob([object, ...parts]), keyRecord: encryptor.keyRecord };
  } finally {
    encryptor.free();
  }
}

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
    case "encryptFile":
      return encryptFile(request);
    case "complete": {
      const words = recoveryCompletions(request.prefix, COMPLETIONS);
      return words ? words.split(" ") : [];
    }
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
