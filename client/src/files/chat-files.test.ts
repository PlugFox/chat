import { Encoder } from "@msgpack/msgpack";
import { describe, expect, it, vi } from "vitest";
import type { ChatKeys } from "../chats/list";
import { ChatFiles, readPreview } from "./chat-files";

const encoder = new Encoder();
const ID = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;

function setup(origin: "client" | "server" = "client", describedBy: "client" | "server" = "server") {
  const request = vi.fn(async (_type: string, payload: { file_ids: string[] }) => ({
    files: payload.file_ids
      .filter((id) => id !== ID(9))
      .map((file_id) => ({
        file_id,
        size: 3,
        key: new Uint8Array([1]),
        preview: new Uint8Array([2]),
        description: new Uint8Array([3]),
      })),
  }));
  const keys = {
    openChat: async (_chat: string, kind: { kind: string }) =>
      kind.kind === "file.preview"
        ? { plaintext: encoder.encode({ type: "image/jpeg", data: new Uint8Array([0xff, 0xd8]) }), origin }
        : { plaintext: new TextEncoder().encode("A cat."), origin: describedBy },
    decryptFile: async () => new Uint8Array([4, 5]),
    fileKey: async () => new Uint8Array(32),
  } as unknown as ChatKeys;
  const get = vi.fn(async () => new Uint8Array([9]));
  const urls: Blob[] = [];
  const files = new ChatFiles(
    "chat",
    request as never,
    keys,
    { put: async () => {}, get },
    {
      create: (blob) => {
        urls.push(blob);
        return `blob:${urls.length}`;
      },
      revoke: () => {},
    },
  );
  return { files, request, get, urls };
}

describe("a chat's files", () => {
  it("asks for the records of the files shown together in one request", async () => {
    const { files, request } = setup();
    const [a, b, missing] = await Promise.all([files.record(ID(1)), files.record(ID(2)), files.record(ID(9))]);
    expect([a?.file_id, b?.file_id, missing]).toEqual([ID(1), ID(2), undefined]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[1]).toEqual({ chat_id: "chat", file_ids: [ID(1), ID(2), ID(9)] });
    await files.record(ID(1));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("opens previews a client sealed and descriptions the server sealed", async () => {
    const { files, urls } = setup();
    expect(await files.preview(ID(1))).toBe("blob:1");
    expect(urls[0]?.type).toBe("image/jpeg");
    expect(await files.description(ID(1))).toBe("A cat.");
    expect(await setup("server").files.preview(ID(1))).toBeNull();
    // A description is the model's, relayed by the server: one a client sealed is not it.
    expect(await setup("client", "client").files.description(ID(1))).toBeNull();
    expect(readPreview(encoder.encode({ type: "image/png", data: new Uint8Array(1) }))).toBeNull();
  });

  it("keeps a description that came later, and an opened file once", async () => {
    const { files, get } = setup();
    await files.record(ID(1));
    const changed = vi.fn();
    files.subscribe(changed);
    files.described(ID(1), new Uint8Array([8]));
    expect(changed).toHaveBeenCalled();
    expect((await files.record(ID(1)))?.description).toEqual(new Uint8Array([8]));
    const blob = await files.open(ID(1), "image/jpeg");
    await files.open(ID(1), "image/jpeg");
    expect(get).toHaveBeenCalledTimes(1);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([4, 5]));
  });
});
