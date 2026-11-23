/**
 * The main thread's handle on the crypto worker. Every call is a message; the
 * worker holds the keys and returns only results (records, plaintext, public
 * values). See docs/crypto.md, "Client worker API".
 */
import type { VaultArgs, VaultMethod, VaultResult, WorkerRequest, WorkerResponse, WrapInfo } from "./protocol";

/** A request before it gets its id (distributes over the union). */
type Unnumbered<T> = T extends unknown ? Omit<T, "id"> : never;

export class VaultClient {
  private readonly worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor() {
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const r = event.data;
      const p = this.pending.get(r.id);
      if (!p) return;
      this.pending.delete(r.id);
      if (r.ok) p.resolve(r.value);
      else p.reject(new Error(r.error));
    };
  }

  private send(request: Unnumbered<WorkerRequest>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...request, id });
    });
  }

  /** Starts a vault for a signed-in user (locked until setup, unlock or link). */
  async open(userId: Uint8Array): Promise<void> {
    await this.send({ op: "open", userId });
  }

  call<M extends VaultMethod>(method: M, ...args: VaultArgs<M>): Promise<VaultResult<M>> {
    return this.send({ op: "call", method, args }) as Promise<VaultResult<M>>;
  }

  /** A file's object, encrypted in the worker a piece at a time, and its `file.key` record. */
  encryptFile(
    scopeId: Uint8Array,
    keyVersion: number,
    fileId: Uint8Array,
    plaintext: Blob,
    original: boolean,
  ): Promise<{ object: Blob; keyRecord: Uint8Array }> {
    return this.send({ op: "encryptFile", scopeId, keyVersion, fileId, plaintext, original }) as Promise<{
      object: Blob;
      keyRecord: Uint8Array;
    }>;
  }

  /** The public parameters of an encoded wrap. */
  describe(wrap: Uint8Array): Promise<WrapInfo> {
    return this.send({ op: "describe", wrap }) as Promise<WrapInfo>;
  }

  /** Recovery list words that start with `prefix` (the list is public; this is input completion). */
  complete(prefix: string): Promise<string[]> {
    return this.send({ op: "complete", prefix }) as Promise<string[]>;
  }

  /** Remembers this device: stores a new device secret and returns the ARK wrap for the server. */
  remember(wrapId: Uint8Array, deviceId: Uint8Array): Promise<Uint8Array> {
    return this.send({ op: "remember", wrapId, deviceId }) as Promise<Uint8Array>;
  }

  unlockWithDevice(wrap: Uint8Array, commitment: Uint8Array): Promise<void> {
    return this.send({ op: "unlockWithDevice", wrap, commitment }) as Promise<void>;
  }

  /** The device id this browser remembers for the open user, if any. */
  remembered(): Promise<Uint8Array | null> {
    return this.send({ op: "remembered" }) as Promise<Uint8Array | null>;
  }

  async forget(): Promise<void> {
    await this.send({ op: "forget" });
  }

  /** Wipes the keys and ends the worker. */
  async close(): Promise<void> {
    await this.send({ op: "close" });
    this.worker.terminate();
  }
}
