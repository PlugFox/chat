/**
 * The main thread's handle on the media worker (D-101): images go to it one
 * at a time, as a decoded photo takes up to 4 bytes a pixel.
 */
import type { MediaRequest, MediaResponse, Prepared } from "./media-worker";

/** A counting semaphore: at most `permits` holders at once, the rest wait in order. */
export class Semaphore {
  private readonly waiting: (() => void)[] = [];

  constructor(private permits: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.permits > 0) this.permits -= 1;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.permits += 1;
    }
  }
}

export interface MediaLike {
  prepare(image: Blob, type: string): Promise<Prepared>;
}

export class MediaClient implements MediaLike {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: Prepared) => void; reject: (e: Error) => void }>();
  private readonly gate = new Semaphore(1);

  /** Started at the first image, so a session that sends none loads no worker. */
  private start(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./media-worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<MediaResponse>) => {
      const r = event.data;
      const p = this.pending.get(r.id);
      if (!p) return;
      this.pending.delete(r.id);
      if (r.ok) p.resolve(r.value);
      else p.reject(new Error(r.error));
    };
    this.worker = worker;
    return worker;
  }

  prepare(image: Blob, type: string): Promise<Prepared> {
    return this.gate.run(
      () =>
        new Promise<Prepared>((resolve, reject) => {
          const id = this.nextId++;
          this.pending.set(id, { resolve, reject });
          const request: MediaRequest = { id, image, type };
          this.start().postMessage(request);
        }),
    );
  }
}
