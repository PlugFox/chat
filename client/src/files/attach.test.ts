import { describe, expect, it, vi } from "vitest";
import type { ChatKeys } from "../chats/list";
import { type Attachment, check, copyName, prepare, uploadAll } from "./attach";
import type { FileHttp } from "./chat-files";
import { FileHttpError } from "./http";
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
        object: new Blob([new Uint8Array([9, 9, 9])]),
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
      data: new Blob([new Uint8Array(10)]),
      w: 2000,
      h: 1500,
      preview: new Uint8Array([1]),
      hash: new Uint8Array([2]),
      original: { name: "cat.heic", type: "image/heic", data: new Blob([new Uint8Array(40)]) },
    };
    const sent = await uploadAll(
      { request: request as never, keys, http: { put, get: async () => new Uint8Array() } },
      "chat",
      [{ ...photo, keep: true }],
    );
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({ keep: true });
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

describe("uploading when things fail", () => {
  const keys = {
    encryptFile: async () => ({ object: new Blob([new Uint8Array([9, 9])]), keyRecord: new Uint8Array([1]) }),
    sealChat: async () => new Uint8Array([7]),
    fileKey: async () => new Uint8Array(32),
  } as unknown as ChatKeys;
  const file = (name: string): Attachment => ({
    id: name,
    name,
    kind: "text",
    type: "text/plain",
    data: new Blob(["hello"]),
  });
  const deps = (put: FileHttp["put"], request: (type: string, payload: unknown) => Promise<unknown>) => ({
    request: request as never,
    keys,
    http: { put, get: async () => new Uint8Array() },
    sleep: async () => {},
  });

  it("tries a PUT three times when the network or the server fails, then gives up", async () => {
    const put = vi.fn<FileHttp["put"]>(async () => {
      throw new FileHttpError(503, "unavailable");
    });
    const requests: [string, unknown][] = [];
    const request = async (type: string, payload: unknown) => {
      requests.push([type, payload]);
      return {};
    };
    await expect(uploadAll(deps(put, request), "chat", [file("a.txt")])).rejects.toBeInstanceOf(FileHttpError);
    expect(put).toHaveBeenCalledTimes(3);
    // What the send registered is taken back.
    const created = requests
      .filter(([type]) => type === "file.create")
      .map(([, p]) => (p as { file_id: string }).file_id);
    expect(requests.at(-1)).toEqual(["file.forget", { file_ids: created }]);
  });

  it("does not try again what the server refused, and counts a stored object as stored", async () => {
    const refused = vi.fn<FileHttp["put"]>(async () => {
      throw new FileHttpError(413, "file.too_large");
    });
    await expect(
      uploadAll(
        deps(refused, async () => ({})),
        "chat",
        [file("a.txt")],
      ),
    ).rejects.toMatchObject({
      code: "file.too_large",
    });
    expect(refused).toHaveBeenCalledTimes(1);
    // Each first PUT stores its object and loses the answer; the next finds it stored.
    const tried = new Set<string>();
    const lostAnswer = vi.fn<FileHttp["put"]>(async (fileId) => {
      const first = !tried.has(fileId);
      tried.add(fileId);
      throw first ? new FileHttpError(0, "network") : new FileHttpError(409, "file.exists");
    });
    const sent = await uploadAll(
      deps(lostAnswer, async () => ({})),
      "chat",
      [file("a.txt"), file("b.txt")],
    );
    expect(sent.map((f) => f.name)).toEqual(["a.txt", "b.txt"]);
  });

  it("sends a file not kept without its preview or original", async () => {
    const created: Record<string, unknown>[] = [];
    const keys = {
      encryptFile: async (_chat: string, fileId: string) => ({
        object: new Blob([new Uint8Array([9])]),
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
      name: "meal.jpg",
      kind: "image",
      type: "image/jpeg",
      data: new Blob([new Uint8Array(10)]),
      preview: new Uint8Array([1]),
      hash: new Uint8Array([2]),
      original: { name: "meal.heic", type: "image/heic", data: new Blob([new Uint8Array(40)]) },
    };
    const sent = await uploadAll(
      { request: request as never, keys, http: { put: async () => {}, get: async () => new Uint8Array() } },
      "chat",
      [photo],
    );
    expect(created).toHaveLength(1);
    expect(created[0]).not.toHaveProperty("preview");
    expect(created[0]).not.toHaveProperty("keep");
    expect(sent[0]).not.toHaveProperty("original");
    expect(sent[0]).toMatchObject({ hash: new Uint8Array([2]) });
  });
});
