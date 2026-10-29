/**
 * Files as the test build sees them (docs/protocol.md, "Files"; D-101):
 * `file.*` answered from memory for `FakeKeys`, objects kept by `PUT` and
 * returned by `GET /files/{id}` through `page.route`. A file a turn reads
 * gets the description `describe` gives, sealed as the server seals one,
 * so the client opens it with its real worker.
 */

import type { Page, Route } from "@playwright/test";
import { sealAsServer } from "../../src/crypto/wasm/chat_crypto.js";
import type { FileRecord, Requests, SentFile } from "../../src/protocol/generated/protocol";
import { Refused } from "./fake-chats";

interface Stored extends FileRecord {
  chat_id: string;
  object?: Uint8Array;
}

function uuidBytes(uuid: string): Uint8Array {
  return new Uint8Array(
    uuid
      .replace(/-/g, "")
      .match(/../g)
      ?.map((b) => Number.parseInt(b, 16)) ?? [],
  );
}

export class FakeFiles {
  readonly files = new Map<string, Stored>();
  /** The description each file a turn reads gets; none while unset. */
  description: string | undefined;
  /** Every `PUT` in order, by file id. */
  readonly puts: string[] = [];

  constructor(
    private readonly userId: string,
    private readonly chatKey: (chatId: string) => Uint8Array | undefined,
    private readonly broadcast: (type: string, payload: unknown) => void,
  ) {}

  async install(page: Page): Promise<void> {
    await page.route("**/files/*", (route) => this.route(route));
  }

  private async route(route: Route): Promise<void> {
    const request = route.request();
    const id = new URL(request.url()).pathname.split("/").pop() ?? "";
    const file = this.files.get(id);
    const json = (status: number, code: string) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify({ code, message: code, retry: false }),
      });
    if (!request.headers()["authorization"]?.startsWith("Bearer ")) return json(401, "auth.invalid_token");
    if (!file) return json(404, "file.not_found");
    if (request.method() === "PUT") {
      if (file.object) return json(409, "file.exists");
      const body = request.postDataBuffer();
      if (!body || body.length !== file.size) return json(400, "protocol.malformed");
      file.object = new Uint8Array(body);
      this.puts.push(id);
      return route.fulfill({ status: 201, body: "" });
    }
    if (!file.object) return json(404, "file.not_found");
    return route.fulfill({ status: 200, contentType: "application/octet-stream", body: Buffer.from(file.object) });
  }

  handle(type: string, payload: unknown): Promise<unknown> | undefined {
    switch (type) {
      case "file.create": {
        const p = payload as Requests["file.create"]["request"];
        const known = this.files.get(p.file_id);
        if (known) return Promise.resolve({});
        this.files.set(p.file_id, {
          file_id: p.file_id,
          chat_id: p.chat_id,
          size: p.size,
          key: p.key,
          ...(p.preview ? { preview: p.preview } : {}),
        });
        return Promise.resolve({});
      }
      case "file.records": {
        const p = payload as Requests["file.records"]["request"];
        const files = p.file_ids.flatMap((id) => {
          const file = this.files.get(id);
          if (!file || file.chat_id !== p.chat_id) return [];
          const { chat_id: _chat, object: _object, ...record } = file;
          return [record];
        });
        return Promise.resolve({ files });
      }
      case "file.usage":
        return Promise.resolve({
          used: [...this.files.values()].reduce((n, f) => n + f.size, 0),
          quota: 1_000_000_000,
        });
      default:
        return undefined;
    }
  }

  /** The files of a send: uploaded and of its chat, or the send is refused. */
  take(chatId: string, files: SentFile[]): void {
    for (const sent of files) {
      for (const id of [sent.file_id, ...(sent.original ? [sent.original.file_id] : [])]) {
        const file = this.files.get(id);
        if (!file?.object || file.chat_id !== chatId) throw new Refused("file.not_found");
      }
    }
  }

  /** Describes the files a turn read, as the server does beside the reply. */
  described(chatId: string, files: SentFile[]): void {
    const text = this.description;
    const key = this.chatKey(chatId);
    if (text === undefined || !key) return;
    for (const sent of files) {
      const file = this.files.get(sent.file_id);
      if (!file || file.description) continue;
      file.description = sealAsServer(
        uuidBytes(this.userId),
        uuidBytes(chatId),
        1,
        key,
        { kind: "file.description", fileId: uuidBytes(sent.file_id) },
        new TextEncoder().encode(text),
      );
      this.broadcast("file.described", { chat_id: chatId, file_id: sent.file_id, description: file.description });
    }
  }
}
