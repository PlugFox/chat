/**
 * The files of one chat as this tab knows them (docs/protocol.md, "Files";
 * D-101): their records fetched in batches, previews and descriptions
 * opened in the crypto worker, whole files fetched and opened when shown.
 * Framework-free so it can be tested without a DOM.
 */

import { Decoder } from "@msgpack/msgpack";
import type { ChatKeys, Request } from "../chats/list";
import type { FileRecord } from "../protocol/generated/protocol";
import { uuidBytes } from "../vault/bytes";

/** How objects travel: `PUT` and `GET /files/{id}` with the access token. */
export interface FileHttp {
  put(fileId: string, object: Uint8Array): Promise<void>;
  get(fileId: string): Promise<Uint8Array>;
}

/** Ids per `file.records`. */
const BATCH = 64;
/** Whole files kept opened in memory at once. */
const KEPT = 6;
const decoder = new Decoder();
const strict = new TextDecoder("utf-8", { fatal: true });

/** The bytes of a `file.preview` record's image, if its plaintext is one. */
export function readPreview(plaintext: Uint8Array): { type: string; data: Uint8Array } | null {
  try {
    const value = decoder.decode(plaintext) as Record<string, unknown>;
    const { type, data } = value;
    if (type === "image/jpeg" && data instanceof Uint8Array) return { type, data };
  } catch {
    // Not a preview this client reads.
  }
  return null;
}

export class ChatFiles {
  private readonly records = new Map<string, FileRecord>();
  private readonly asked = new Map<string, Promise<FileRecord | undefined>>();
  private readonly previews = new Map<string, Promise<string | null>>();
  private readonly descriptions = new Map<string, Promise<string | null>>();
  private readonly opened = new Map<string, Promise<Blob>>();
  private readonly listeners = new Set<() => void>();
  private queue: { id: string; resolve: (r: FileRecord | undefined) => void; reject: (e: unknown) => void }[] = [];
  private flushing = false;

  constructor(
    readonly chatId: string,
    private readonly request: Request,
    private readonly keys: ChatKeys,
    readonly http: FileHttp,
    private readonly url: { create: (blob: Blob) => string; revoke: (url: string) => void } = {
      create: (blob) => URL.createObjectURL(blob),
      revoke: (url) => URL.revokeObjectURL(url),
    },
  ) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  /** A file's record; ids asked together go in one request. */
  record(id: string): Promise<FileRecord | undefined> {
    const known = this.records.get(id);
    if (known) return Promise.resolve(known);
    let asked = this.asked.get(id);
    if (!asked) {
      asked = new Promise((resolve, reject) => this.queue.push({ id, resolve, reject }));
      // A failure is asked again next time.
      asked.catch(() => this.asked.delete(id));
      this.asked.set(id, asked);
      if (!this.flushing) {
        this.flushing = true;
        queueMicrotask(() => void this.flush());
      }
    }
    return asked;
  }

  private async flush(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, BATCH);
      try {
        const { files } = await this.request("file.records", {
          chat_id: this.chatId,
          file_ids: batch.map((b) => b.id),
        });
        for (const file of files) this.records.set(file.file_id, file);
        for (const b of batch) {
          // A file not answered for is not this chat's (or not yet known): asked again later.
          if (!this.records.has(b.id)) this.asked.delete(b.id);
          b.resolve(this.records.get(b.id));
        }
      } catch (e) {
        for (const b of batch) b.reject(e);
      }
    }
    this.flushing = false;
  }

  /** A record this client just made, known without asking. */
  remember(record: FileRecord): void {
    this.records.set(record.file_id, record);
  }

  /** A description arrived (`file.described`). */
  described(fileId: string, description: Uint8Array): void {
    const known = this.records.get(fileId);
    if (!known) return;
    this.records.set(fileId, { ...known, description });
    this.descriptions.delete(fileId);
    this.changed();
  }

  /** A blob URL of an image's square preview, or `null` when it has none that opens. */
  preview(id: string): Promise<string | null> {
    let preview = this.previews.get(id);
    if (!preview) {
      preview = (async () => {
        const record = (await this.record(id))?.preview;
        if (!record) return null;
        const opened = await this.keys.openChat(this.chatId, { kind: "file.preview", fileId: uuidBytes(id) }, record);
        if (opened.origin !== "client") return null;
        const image = readPreview(opened.plaintext);
        return image ? this.url.create(new Blob([new Uint8Array(image.data)], { type: image.type })) : null;
      })().catch(() => null);
      this.previews.set(id, preview);
    }
    return preview;
  }

  /** What the model wrote about the file, or `null` before it has (or when it does not open). */
  description(id: string): Promise<string | null> {
    let description = this.descriptions.get(id);
    if (!description) {
      description = (async () => {
        const record = (await this.record(id))?.description;
        if (!record) return null;
        const opened = await this.keys.openChat(
          this.chatId,
          { kind: "file.description", fileId: uuidBytes(id) },
          record,
        );
        if (opened.origin !== "server") return null;
        return strict.decode(opened.plaintext);
      })().catch(() => null);
      // Not cached while missing: the description may come later.
      void description.then((d) => {
        if (d === null) this.descriptions.delete(id);
      });
      this.descriptions.set(id, description);
    }
    return description;
  }

  /** The file's content key, for a turn (D-101). */
  async key(id: string): Promise<Uint8Array> {
    const record = await this.record(id);
    if (!record) throw new Error("no such file");
    return this.keys.fileKey(this.chatId, id, record.key);
  }

  /** The whole file, fetched and opened; the last few stay in memory. */
  open(id: string, type: string): Promise<Blob> {
    let opened = this.opened.get(id);
    if (!opened) {
      opened = (async () => {
        const record = await this.record(id);
        if (!record) throw new Error("no such file");
        const object = await this.http.get(id);
        const plaintext = await this.keys.decryptFile(this.chatId, id, record.key, object);
        return new Blob([new Uint8Array(plaintext)], { type });
      })();
      opened.catch(() => this.opened.delete(id));
      this.opened.set(id, opened);
      for (const old of this.opened.keys()) {
        if (this.opened.size <= KEPT) break;
        this.opened.delete(old);
      }
    }
    return opened;
  }

  /** Frees the previews' URLs. */
  close(): void {
    for (const preview of this.previews.values()) {
      void preview.then((url) => {
        if (url) this.url.revoke(url);
      });
    }
    this.previews.clear();
    this.opened.clear();
  }
}
