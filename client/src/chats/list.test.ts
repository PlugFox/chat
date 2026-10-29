import { describe, expect, it, vi } from "vitest";
import type { ChatInfo } from "../protocol/generated/protocol";
import { TransportError } from "../transport/socket";
import { type ChatKeys, ChatList, type Request } from "./list";

const utf8 = new TextEncoder();

/** "Sealing" is a version byte, a marker and the plaintext; the fake opens only its own records. */
const keys: ChatKeys = {
  createChat: async () => ({ publicKey: new Uint8Array(32), wrappedPrivateKey: new Uint8Array(8) }),
  sealChat: async (_chat, _kind, plaintext) => new Uint8Array([1, 0xaa, ...plaintext]),
  openChat: async (_chat, _kind, record) => {
    if (record[1] !== 0xaa) throw new Error("decryption failed");
    return { plaintext: record.slice(2), origin: "client" };
  },
  encryptFile: async () => ({ object: new Uint8Array(1), keyRecord: new Uint8Array(1) }),
  decryptFile: async (_chat, _file, _key, object) => object,
  fileKey: async () => new Uint8Array(32),
};

function title(text: string): Uint8Array {
  return new Uint8Array([1, 0xaa, ...utf8.encode(text)]);
}

function chat(n: number, extra: Partial<ChatInfo> = {}): ChatInfo {
  return {
    chat_id: `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`,
    title: title(`Chat ${n}`),
    created_at: n,
    updated_at: n * 10,
    last_message_id: 1,
    rev: 1,
    turn: false,
    settings: {},
    title_auto: true,
    ...extra,
  };
}

async function settled(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
}

describe("ChatList", () => {
  it("pages the list, pinned chats first, and the archive on its own", async () => {
    const request = vi.fn(async (type: string, payload: { archived?: boolean; before?: unknown }) => {
      expect(type).toBe("chat.list");
      if (payload.archived) return { chats: [chat(9, { archived_at: 5 })] };
      if (!payload.before) {
        return { chats: [chat(1, { pin: 1 }), chat(2, { pin: 0 }), chat(5), chat(4)], next: { updated_at: 40 } };
      }
      return { chats: [chat(3)] };
    });
    const list = new ChatList(request as unknown as Request, keys);
    await list.load();
    await settled();
    expect(list.state.kind).toBe("ready");
    expect(list.pinned.map((e) => e.info.created_at)).toEqual([2, 1]);
    expect(list.recent.map((e) => e.info.created_at)).toEqual([5, 4]);
    expect(list.hasMore(false)).toBe(true);
    await list.more(false);
    expect(list.recent.map((e) => e.info.created_at)).toEqual([5, 4, 3]);
    expect(list.hasMore(false)).toBe(false);
    expect(list.archived).toEqual([]);
    await list.all(true);
    expect(list.archived.map((e) => e.info.created_at)).toEqual([9]);
    expect(list.get(chat(5).chat_id)?.title).toEqual({ kind: "text", text: "Chat 5" });
  });

  it("keeps the higher rev, moves a chat with its update and drops a deleted one", async () => {
    const request = vi.fn(async () => ({ chats: [chat(1), chat(2)] }));
    const list = new ChatList(request as unknown as Request, keys);
    await list.load();
    list.put(chat(1, { rev: 3, updated_at: 100, title: title("Renamed") }));
    list.put(chat(1, { rev: 2, updated_at: 1, title: title("Older") }));
    await settled();
    expect(list.recent.map((e) => e.info.created_at)).toEqual([1, 2]);
    expect(list.get(chat(1).chat_id)?.title).toEqual({ kind: "text", text: "Renamed" });
    list.remove(chat(2).chat_id);
    expect(list.recent).toHaveLength(1);
    // A chat first heard of in an event joins the list.
    list.put(chat(7, { updated_at: 1000 }));
    expect(list.recent[0]?.info.created_at).toBe(7);
  });

  it("shows a title it cannot open as unreadable, with the reason", async () => {
    const request = vi.fn(async () => ({
      chats: [
        chat(1, { title: new Uint8Array([1, 0xbb, 1]) }),
        chat(2, { title: new Uint8Array([2, 0xaa]) }),
        chat(3, { title: new Uint8Array([1, 0xaa, 0xff]) }),
        (() => {
          const { title: _, ...untitled } = chat(4);
          return untitled;
        })(),
      ],
    }));
    const list = new ChatList(request as unknown as Request, keys);
    await list.load();
    await settled();
    const titles = list.recent.map((e) => e.title);
    expect(titles).toEqual([
      { kind: "none" },
      { kind: "unreadable", reason: "parse" },
      { kind: "unreadable", reason: "version" },
      { kind: "unreadable", reason: "decrypt" },
    ]);
  });

  it("starts over on a reload, so chats deleted meanwhile go", async () => {
    let chats = [chat(1), chat(2)];
    const request = vi.fn(async () => ({ chats }));
    const list = new ChatList(request as unknown as Request, keys);
    await list.load();
    chats = [chat(2)];
    await list.load();
    expect(list.recent.map((e) => e.info.created_at)).toEqual([2]);
  });

  it("seals renames and takes a resent delete that finds the chat gone as done", async () => {
    const sent: unknown[] = [];
    const request = vi.fn(async (type: string, payload: unknown) => {
      sent.push([type, payload]);
      if (type === "chat.delete") throw new TransportError("chat.not_found", "gone");
      return {};
    });
    const list = new ChatList(request as unknown as Request, keys);
    const id = chat(1).chat_id;
    await list.rename(id, "New");
    await list.pin(id, 0);
    await list.pin(id);
    await expect(list.delete(id)).resolves.toBeUndefined();
    expect(sent).toEqual([
      ["chat.rename", { chat_id: id, title: title("New") }],
      ["chat.pin", { chat_id: id, position: 0 }],
      ["chat.pin", { chat_id: id }],
      ["chat.delete", { chat_id: id }],
    ]);
  });
});
