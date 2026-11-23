import { describe, expect, it, vi } from "vitest";
import type { ChatKeys } from "../chats/list";
import { encodeMessage } from "../chats/records";
import type { ChatMessage } from "../protocol/generated/protocol";
import { HISTORY_MAX, historyResult, readHistory } from "./history";

function message(id: number, author: ChatMessage["author"] = id % 2 === 0 ? "user" : "assistant"): ChatMessage {
  return {
    id,
    author,
    created_at: Date.UTC(2026, 2, 1, 12, 0, id),
    state: "complete",
    rev: 1,
    record: new Uint8Array([1, id]),
  };
}

const opened = (id: number, text: string | null = `m${id}`) => ({ message: message(id), text });

describe("a history result", () => {
  it("holds the ids asked for, oldest first, and where to read on", () => {
    const messages = [opened(9), opened(10), opened(11), opened(12), opened(13)];
    const result = JSON.parse(historyResult(messages, 13, 3) ?? "");
    expect(result.messages.map((m: { id: number; role: string; text: string }) => [m.id, m.role, m.text])).toEqual([
      [10, "user", "m10"],
      [11, "assistant", "m11"],
      [12, "user", "m12"],
    ]);
    expect(result.before).toBe(10);
    expect(result.messages[0].at).toMatch(/^2026-03-01T\d\d:\d\d:10[+-]\d\d:\d\d$/);
    // The chat's start has nothing before it.
    expect(JSON.parse(historyResult([opened(0), opened(1)], 2, 50) ?? "").before).toBeUndefined();
  });

  it("leaves out tombstones, summaries, empty and unreadable messages", () => {
    const { record: _gone, ...deleted } = message(1);
    const tombstone = { message: deleted, text: "" };
    const summary = { message: message(2, "summary"), text: "folded" };
    const messages = [opened(0), tombstone, summary, opened(3, ""), opened(4, null)];
    expect(JSON.parse(historyResult(messages, 5, 5) ?? "").messages.map((m: { id: number }) => m.id)).toEqual([0]);
  });

  it("is refused when no record opens", () => {
    expect(historyResult([opened(0, null), opened(1, null)], 2, 2)).toBeNull();
    expect(historyResult([], 2, 2)).toBe('{"messages":[]}');
  });

  it("keeps the newest that fit in 32 KiB, and cuts one that alone does not", () => {
    const long = "й".repeat(6000);
    const messages = Array.from({ length: 10 }, (_, i) => opened(i + 1, long));
    const text = historyResult(messages, 11, 10) ?? "";
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(HISTORY_MAX);
    const result = JSON.parse(text);
    expect(result.messages.at(-1).id).toBe(10);
    expect(result.before).toBe(result.messages[0].id);
    const huge = JSON.parse(historyResult([opened(5, "x".repeat(40_000))], 6, 1) ?? "");
    expect(huge.messages[0].truncated).toBe(true);
    expect(huge.before).toBe(5);
    expect(new TextEncoder().encode(JSON.stringify(huge)).length).toBeLessThanOrEqual(HISTORY_MAX);
  });
});

describe("reading history", () => {
  it("fetches only the chunks of the ids asked for and opens their records", async () => {
    const request = vi.fn(async (_type: string, payload: { chunks: { chunk: number }[] }) => ({
      chat_id: "chat",
      chunks: payload.chunks.map(({ chunk }) => ({
        chunk,
        rev: 1,
        messages: [message(chunk * 64 + 62), message(chunk * 64 + 63)],
      })),
    }));
    const keys = {
      openChat: async (_chat: string, _kind: unknown, record: Uint8Array) => ({
        plaintext: encodeMessage(`text ${record[1]}`),
      }),
    } as unknown as ChatKeys;
    const result = JSON.parse((await readHistory(request as never, keys, "chat", 64, 3)) ?? "");
    expect(request.mock.calls[0]?.[1].chunks).toEqual([{ chunk: 0 }]);
    expect(result.messages.map((m: { text: string }) => m.text)).toEqual(["text 62", "text 63"]);
    expect(result.before).toBe(61);
  });
});
