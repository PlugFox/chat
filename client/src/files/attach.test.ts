import { describe, expect, it, vi } from "vitest";
import type { ChatKeys } from "../chats/list";
import { type Attachment, check, copyName, prepare, uploadAll } from "./attach";
import type { FileHttp } from "./chat-files";
import type { MediaLike } from "./media";

const png = (w: number, h: number) => {
  const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52];
  const size = new Uint8Array(8);
  new DataView(size.buffer).setUint32(0, w);
  new DataView(size.buffer).setUint32(4, h);
  return new Uint8Array([...head, ...size, 0, 0, 0, 0]);
};

describe("picking files", () => {
  it("refuses what no agent reads, and offers to compress big images", async () => {
    expect(await check(new File(["x"], "clip.mp4", { type: "video/mp4" }))).toMatchObject({ reason: "unsupported" });
    expect(await check(new File([new Uint8Array([0xc3, 0x28])], "a.txt"))).toMatchObject({ reason: "not_text" });
    expect(await check(new File([png(10_000, 6_000)], "huge.png"))).toMatchObject({ reason: "too_many_pixels" });
    const pages = "%PDF-1.7 ".concat("/Type /Page ".repeat(101));
    expect(await check(new File([pages], "long.pdf"))).toMatchObject({ reason: "too_many_pages" });
    expect(await check(new File([png(800, 600)], "small.png"))).toMatchObject({ ok: true, big: false, w: 800 });
    expect(await check(new File([png(4000, 3000)], "wide.png"))).toMatchObject({ ok: true, big: true });
    expect(await check(new File(["# notes"], "notes.md"))).toMatchObject({ ok: true, kind: "text" });
    expect(copyName("IMG_1.HEIC", "image/jpeg")).toBe("IMG_1.jpg");
  });

  it("keeps an image's original only when a big one goes as it is", async () => {
    const media: MediaLike = {
      prepare: async () => ({
        copy: new Uint8Array([1, 2]),
        copyType: "image/jpeg",
        w: 2000,
        h: 1500,
        sourceW: 4000,
        sourceH: 3000,
        preview: new Uint8Array([3]),
        hash: new Uint8Array([4]),
      }),
    };
    const big = await check(new File([png(4000, 3000)], "IMG.png"));
    if (!big.ok) throw new Error("not taken");
    const asIs = await prepare(big, true, media);
    expect(asIs).toMatchObject({ name: "IMG.jpg", type: "image/jpeg", w: 2000, original: { name: "IMG.png" } });
    expect((await prepare(big, false, media)).original).toBeUndefined();
  });
});

describe("uploading", () => {
  it("encrypts, registers and puts each file, and sends its key with the message", async () => {
    const created: Record<string, unknown>[] = [];
    const put = vi.fn<FileHttp["put"]>(async () => {});
    const keys = {
      encryptFile: async (_chat: string, fileId: string) => ({
        object: new Uint8Array([9, 9, 9]),
        keyRecord: new TextEncoder().encode(`key ${fileId}`),
      }),
      sealChat: async () => new Uint8Array([7]),
      fileKey: async () => new Uint8Array(32).fill(5),
    } as unknown as ChatKeys;
    const request = vi.fn(async (type: string, payload: Record<string, unknown>) => {
      if (type === "file.create") created.push(payload);
      return {};
    });
    const photo: Attachment = {
      id: "local",
      name: "cat.jpg",
      kind: "image",
      type: "image/jpeg",
      bytes: new Uint8Array(10),
      w: 2000,
      h: 1500,
      preview: new Uint8Array([1]),
      hash: new Uint8Array([2]),
      original: { name: "cat.heic", type: "image/heic", bytes: new Uint8Array(40) },
    };
    const sent = await uploadAll(
      { request: request as never, keys, http: { put, get: async () => new Uint8Array() } },
      "chat",
      [photo],
    );
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({ chat_id: "chat", size: 3, preview: new Uint8Array([7]) });
    expect(created[1]).not.toHaveProperty("preview");
    expect(put).toHaveBeenCalledTimes(2);
    expect(sent).toEqual([
      {
        file_id: created[0]?.["file_id"],
        key: new Uint8Array(32).fill(5),
        name: "cat.jpg",
        type: "image/jpeg",
        size: 10,
        w: 2000,
        h: 1500,
        hash: new Uint8Array([2]),
        original: { file_id: created[1]?.["file_id"], type: "image/heic", size: 40 },
      },
    ]);
  });
});
