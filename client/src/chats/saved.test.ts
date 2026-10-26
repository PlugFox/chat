import { describe, expect, it, vi } from "vitest";
import type { ChatInfo, ChatMessage, SavedItem } from "../protocol/generated/protocol";
import type { ChatKeys, Request } from "./list";
import { encodeMessage, encodeTitle } from "./records";
import { SavedMessages } from "./saved";

/** "Sealing" is a version byte, a marker and the plaintext; the fake opens only its own records. */
const keys: ChatKeys = {
  createChat: async () => ({ publicKey: new Uint8Array(32), wrappedPrivateKey: new Uint8Array(8) }),
  sealChat: async (_chat, _kind, plaintext) => new Uint8Array([1, 0xaa, ...plaintext]),
  openChat: async (_chat, _kind, record) => {
    if (record[1] !== 0xaa) throw new Error("decryption failed");
    return { plaintext: record.slice(2), origin: "client" };
  },
};

const sealed = (plaintext: Uint8Array) => new Uint8Array([1, 0xaa, ...plaintext]);
const CHAT = "00000000-0000-7000-8000-000000000001";

function chat(extra: Partial<ChatInfo> = {}): ChatInfo {
  return {
    chat_id: CHAT,
    title: sealed(encodeTitle("Trip")),
    created_at: 1,
    updated_at: 1,
    last_message_id: 9,
    rev: 1,
    turn: false,
    settings: {},
    title_auto: false,
    ...extra,
  };
}

function message(id: number, text: string, rev = 1): ChatMessage {
  return { id, author: "assistant", state: "complete", rev, created_at: id, record: sealed(encodeMessage(text)) };
}

function item(id: number, savedAt: number): SavedItem {
  return { saved_at: savedAt, chat: chat(), message: message(id, `Message ${id}`) };
}

async function settled(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
}

const texts = (saved: SavedMessages) =>
  saved.list.map((e) => (e.content.kind === "text" ? e.content.text : e.content.kind));

describe("SavedMessages", () => {
  it("pages newest first from parts, opening messages and titles", async () => {
    const request = vi.fn(
      async (type: string, payload: { before?: unknown }, options?: { onPart?: (p: unknown) => void }) => {
        expect(type).toBe("saved.list");
        if (payload.before) return { items: [item(1, 10)] };
        // A resent request delivers its parts again; the store keeps one copy.
        options?.onPart?.({ items: [item(3, 30)] });
        options?.onPart?.({ items: [item(3, 30)] });
        return { items: [item(2, 20)], next: { saved_at: 20, chat_id: CHAT, message_id: 2 } };
      },
    );
    const saved = new SavedMessages(request as unknown as Request, keys);
    await saved.load();
    await settled();
    expect(texts(saved)).toEqual(["Message 3", "Message 2"]);
    expect(saved.list[0]?.title).toEqual({ kind: "text", text: "Trip" });
    expect(saved.hasMore).toBe(true);
    await saved.more();
    await settled();
    expect(texts(saved)).toEqual(["Message 3", "Message 2", "Message 1"]);
    expect(saved.hasMore).toBe(false);
  });

  it("follows saves, edits, renames and deletions", async () => {
    let first = [item(2, 20)];
    const request = vi.fn(async (type: string) => {
      if (type === "saved.chat") return { message_ids: [2] };
      if (type === "saved.list") return { items: first };
      return { saved_at: 50 };
    });
    const saved = new SavedMessages(request as unknown as Request, keys);
    expect(saved.isSaved(CHAT, 2)).toBeUndefined();
    await saved.ofChat(CHAT);
    expect(saved.isSaved(CHAT, 2)).toBe(true);
    await saved.load();
    await settled();

    // Saved on another device: the first page comes again with it.
    first = [item(5, 50), item(2, 20)];
    saved.updated({ chat_id: CHAT, message_id: 5, saved_at: 50 });
    await settled();
    expect(saved.isSaved(CHAT, 5)).toBe(true);
    expect(texts(saved)).toEqual(["Message 5", "Message 2"]);

    saved.messageChanged(CHAT, message(2, "Edited", 3));
    saved.messageChanged(CHAT, message(2, "Older", 2));
    saved.chatChanged(chat({ rev: 4, title: sealed(encodeTitle("Renamed")) }));
    await settled();
    expect(texts(saved)).toEqual(["Message 5", "Edited"]);
    expect(saved.list.map((e) => e.title)).toEqual([
      { kind: "text", text: "Renamed" },
      { kind: "text", text: "Renamed" },
    ]);

    saved.messageDeleted(CHAT, 5);
    expect(saved.isSaved(CHAT, 5)).toBe(false);
    expect(texts(saved)).toEqual(["Edited"]);
    await saved.save(CHAT, 2, false);
    expect(request).toHaveBeenLastCalledWith("saved.remove", { chat_id: CHAT, message_id: 2 }, { retry: "resend" });
    expect(saved.list).toEqual([]);
    expect(saved.isSaved(CHAT, 2)).toBe(false);
    saved.chatDeleted(CHAT);
    expect(saved.isSaved(CHAT, 2)).toBeUndefined();
  });
});
