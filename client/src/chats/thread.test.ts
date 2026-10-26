import { encode } from "@msgpack/msgpack";
import { describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChunkRequest } from "../protocol/generated/protocol";
import type { ChatKeys, Request } from "./list";
import { startChat, Thread } from "./thread";

const CHAT = "00000000-0000-7000-8000-000000000001";

const keys: ChatKeys = {
  createChat: async () => ({ publicKey: new Uint8Array([7]), wrappedPrivateKey: new Uint8Array([8]) }),
  sealChat: async (_chat, _kind, plaintext) => new Uint8Array([1, 0xaa, ...plaintext]),
  openChat: async (_chat, _kind, record) => {
    if (record[1] !== 0xaa) throw new Error("decryption failed");
    return { plaintext: record.slice(2), origin: "server" };
  },
};

function record(text: string, extra: Record<string, unknown> = {}): Uint8Array {
  return new Uint8Array([1, 0xaa, ...encode({ text, ...extra })]);
}

function message(id: number, text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    author: id % 2 ? "assistant" : "user",
    created_at: id,
    state: "complete",
    rev: id + 1,
    record: record(text),
    ...extra,
  };
}

async function settled(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
}

function text(thread: Thread, id: number): string | undefined {
  const content = thread.message(id)?.content;
  return content?.kind === "text" ? content.text : content?.kind;
}

/** A server with the chat's messages; records every request. */
function server(messages: ChatMessage[]) {
  const sent: [string, unknown][] = [];
  const request = vi.fn(async (type: string, payload: unknown, options?: { onPart?: (p: unknown) => void }) => {
    sent.push([type, payload]);
    if (type !== "message.chunks") return { message_id: 0, turn_id: "t" };
    const { chunks } = payload as { chunks: ChunkRequest[] };
    const reply = chunks.map(({ chunk, rev }) => {
      const all = messages.filter((m) => m.id >> 6 === chunk);
      return {
        chunk,
        rev: Math.max(0, ...all.map((m) => m.rev)),
        messages: all.filter((m) => rev === undefined || m.rev > rev),
      };
    });
    // The first chunk comes as a part, the rest with the final response.
    options?.onPart?.({ chat_id: CHAT, chunks: reply.slice(0, 1) });
    return { chat_id: CHAT, chunks: reply.slice(1) };
  });
  return { request: request as unknown as Request, sent };
}

describe("Thread", () => {
  it("fetches a chunk once per socket, and again after a reset with the rev it holds", async () => {
    const s = server([message(0, "Hi"), message(1, "Hello")]);
    const thread = new Thread(CHAT, 1, s.request, keys);
    await thread.ensure([0]);
    await thread.ensure([0]);
    await settled();
    expect([text(thread, 0), text(thread, 1)]).toEqual(["Hi", "Hello"]);
    expect(s.sent).toEqual([["message.chunks", { chat_id: CHAT, chunks: [{ chunk: 0 }] }]]);
    thread.reset();
    await settled();
    expect(s.sent[1]).toEqual(["message.chunks", { chat_id: CHAT, chunks: [{ chunk: 0, rev: 2 }] }]);
    expect(thread.has(0)).toBe(true);
  });

  it("trusts a chunk's rev only from a whole fetch, not from an event for one of its messages", async () => {
    const messages = Array.from({ length: 100 }, (_, i) => message(i, `m${i}`));
    const s = server(messages);
    const thread = new Thread(CHAT, 99, s.request, keys);
    await thread.ensure([1]);
    // Another device edits a message of a chunk this tab never fetched.
    thread.receive(message(10, "edited", { rev: 200 }));
    await thread.ensure([0, 1]);
    await settled();
    expect(s.sent.at(-1)).toEqual(["message.chunks", { chat_id: CHAT, chunks: [{ chunk: 0 }] }]);
    expect(text(thread, 3)).toBe("m3");
    expect(text(thread, 10)).toBe("edited");
    // An event on a fetched chunk keeps its rev current for the next fetch.
    thread.receive(message(70, "later", { rev: 300 }));
    thread.reset();
    await settled();
    expect(s.sent.at(-1)?.[1]).toEqual({
      chat_id: CHAT,
      chunks: [
        { chunk: 0, rev: 64 },
        { chunk: 1, rev: 300 },
      ],
    });
  });

  it("shows a streaming reply as its snapshot and the deltas after it", async () => {
    const thread = new Thread(CHAT, 1, server([]).request, keys);
    // Deltas may come before the reply itself is known.
    thread.delta({ chat_id: CHAT, message_id: 1, seq: 1, text: "Go" });
    thread.receive(message(1, "", { state: "streaming", seq: 0 }));
    thread.delta({ chat_id: CHAT, message_id: 1, seq: 2, text: "od" });
    // A gap waits for the snapshot that fills it.
    thread.delta({ chat_id: CHAT, message_id: 1, seq: 4, text: "!" });
    await settled();
    expect(text(thread, 1)).toBe("Good");
    thread.receive(message(1, "Good morning", { state: "streaming", seq: 3, rev: 5 }));
    await settled();
    expect(text(thread, 1)).toBe("Good morning!");
    thread.delta({ chat_id: CHAT, message_id: 1, seq: 3, text: "stale" });
    expect(text(thread, 1)).toBe("Good morning!");
    thread.receive(message(1, "Good morning!", { state: "failed", seq: 4, rev: 6, error: "provider.unreachable" }));
    await settled();
    expect(thread.message(1)?.message.error).toBe("provider.unreachable");
    // A finished reply takes no more deltas.
    thread.delta({ chat_id: CHAT, message_id: 1, seq: 5, text: " late" });
    expect(text(thread, 1)).toBe("Good morning!");

    // A retry starts over: the deltas of the failed run do not come back.
    thread.receive(message(1, "", { state: "streaming", seq: 0, rev: 7 }));
    thread.delta({ chat_id: CHAT, message_id: 1, seq: 1, text: "New" });
    await settled();
    expect(text(thread, 1)).toBe("New");
  });

  it("keeps the higher rev and keeps an unreadable record in its place", async () => {
    const thread = new Thread(CHAT, 4, server([]).request, keys);
    thread.receive(message(0, "Second", { rev: 9 }));
    thread.receive(message(0, "First", { rev: 3 }));
    thread.receive(message(1, "x", { record: new Uint8Array([1, 0xbb]) }));
    thread.receive(message(2, "x", { record: new Uint8Array([2, 0xaa]) }));
    thread.receive(message(3, "x", { record: new Uint8Array([1, 0xaa, 0xc1]) }));
    thread.receive(message(4, "Bye"));
    thread.deleted({ chat_id: CHAT, message_id: 4, rev: 20 });
    await settled();
    expect([0, 1, 2, 3, 4].map((id) => thread.message(id)?.content)).toEqual([
      { kind: "text", text: "Second" },
      { kind: "unreadable", reason: "decrypt" },
      { kind: "unreadable", reason: "version" },
      { kind: "unreadable", reason: "parse" },
      { kind: "deleted" },
    ]);
  });

  it("sends with the latest messages as context, fetched first", async () => {
    const messages = Array.from({ length: 70 }, (_, i) => message(i, `m${i}`));
    const s = server(messages);
    const thread = new Thread(CHAT, 69, s.request, keys);
    await thread.send("Next");
    const [type, payload] = s.sent.at(-1) as [string, { text: string; context: { messages: { id: number }[] } }];
    expect(type).toBe("message.send");
    expect(payload.text).toBe("Next");
    expect(payload.context.messages.map((m) => m.id)).toEqual(Array.from({ length: 50 }, (_, i) => i + 20));
  });

  it("retries the last failed reply with the message it answers, and nothing else", async () => {
    const messages = [message(0, "Hi"), message(1, "Hello"), message(2, "Again"), message(3, "", { state: "failed" })];
    const s = server(messages);
    const thread = new Thread(CHAT, 3, s.request, keys);
    await thread.ensure([0]);
    await settled();
    expect(thread.retryable(3)).toBe(true);
    expect(thread.retryable(1)).toBe(false);
    const done = new Thread(CHAT, 1, server([message(0, "Hi"), message(1, "Hello")]).request, keys);
    await done.ensure([0]);
    expect(done.retryable(1)).toBe(false);
    await thread.retry(3);
    expect(s.sent.at(-1)).toEqual([
      "turn.retry",
      {
        chat_id: CHAT,
        message_id: 3,
        text: "Again",
        context: {
          messages: [
            { id: 0, role: "user", text: "Hi" },
            { id: 1, role: "assistant", text: "Hello" },
          ],
        },
      },
    ]);
  });

  it("edits keep the fields the record held", async () => {
    const s = server([message(0, "Hi", { record: record("Hi", { later: 1 }) })]);
    const thread = new Thread(CHAT, 0, s.request, keys);
    await thread.ensure([0]);
    await settled();
    await thread.edit(0, "Hey");
    expect(s.sent.at(-1)).toEqual([
      "message.edit",
      { chat_id: CHAT, message_id: 0, record: record("Hi", { later: 1, text: "Hey" }) },
    ]);
  });

  it("starts a chat with its keys and a title from the first line", async () => {
    const s = server([]);
    const id = await startChat(s.request, keys, "Plan a trip\nto the sea");
    const [type, payload] = s.sent[0] as [string, Record<string, unknown>];
    expect(type).toBe("message.send");
    expect(payload).toMatchObject({
      chat_id: id,
      text: "Plan a trip\nto the sea",
      context: { messages: [] },
      new_chat: {
        public_key: new Uint8Array([7]),
        wrapped_private_key: new Uint8Array([8]),
        title: new Uint8Array([1, 0xaa, ...new TextEncoder().encode("Plan a trip")]),
      },
    });
  });
});
