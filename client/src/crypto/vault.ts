/**
 * The main thread's handle on the crypto worker. Every call is a message; the
 * worker holds the keys and returns only results (records, plaintext, public
 * values). See docs/crypto.md, "Client worker API".
 */
import type { VaultArgs, VaultMethod, VaultResult, WorkerRequest, WorkerResponse } from "./protocol";

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

  /** Wipes the keys and ends the worker. */
  async close(): Promise<void> {
    await this.send({ op: "close" });
    this.worker.terminate();
  }
}
