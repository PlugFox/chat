/**
 * The answer to the agent's `read_history` (docs/protocol.md, "Agent tools
 * (v1)"; D-100): the chat's messages of the ids asked for, fetched and opened
 * here, as JSON within 32 KiB. No one is asked. Framework-free so it can be
 * tested without a DOM.
 */

import type { ChatKeys, Request } from "../chats/list";
import { chunkOf, openMessage } from "../chats/thread";
import type { ChatMessage } from "../protocol/generated/protocol";
import { localTime } from "./permissions";

/** Matches the server's `HISTORY_MAX`. */
export const HISTORY_MAX = 32 * 1024;
const utf8 = new TextEncoder();

interface Item {
  id: number;
  role: "user" | "assistant";
  at: string;
  text: string;
  truncated?: true;
}

function size(value: unknown): number {
  return utf8.encode(JSON.stringify(value)).length;
}

/** A message's time on this device's clock, with its offset. */
function at(ms: number): string {
  return localTime(Math.floor(ms / 1000), -new Date(ms).getTimezoneOffset());
}

/** The item with its text cut until it takes at most `room` bytes. */
function cut(item: Item, room: number): Item {
  const chars = [...item.text];
  let keep = chars.length;
  let cutItem: Item = { ...item, truncated: true };
  do {
    keep = Math.floor(keep * 0.9);
    cutItem = { ...item, text: chars.slice(0, keep).join(""), truncated: true };
  } while (keep > 0 && size(cutItem) + 1 > room);
  return cutItem;
}

/**
 * The result of messages `before − count` to `before − 1` (whichever the
 * chat holds), newest kept first when they do not all fit. `null` when the
 * chat does not open here, so the request is refused.
 */
export function historyResult(
  messages: { message: ChatMessage; text: string | null }[],
  before: number,
  count: number,
): string | null {
  const lo = Math.max(0, before - count);
  const items: Item[] = [];
  let sealed = 0;
  let failed = 0;
  for (const { message, text } of [...messages].sort((a, b) => a.message.id - b.message.id)) {
    if (message.id < lo || message.id >= before || !message.record) continue;
    if (message.author !== "user" && message.author !== "assistant") continue;
    sealed += 1;
    if (text === null) failed += 1;
    if (text === null || text === "") continue;
    items.push({ id: message.id, role: message.author, at: at(message.created_at), text });
  }
  // Every record failed to open: the chat's key is not here.
  if (sealed > 0 && failed === sealed) return null;
  let room = HISTORY_MAX - size({ messages: [], before: 0xffff_ffff });
  const kept: Item[] = [];
  let dropped = false;
  for (const item of items.reverse()) {
    const need = size(item) + 1;
    if (need <= room) {
      kept.push(item);
      room -= need;
    } else {
      // One message alone too long is cut rather than lost.
      if (kept.length === 0) kept.push(cut(item, room));
      dropped = kept.length < items.length;
      break;
    }
  }
  kept.reverse();
  const oldest = kept[0]?.id;
  const next = dropped ? oldest : lo > 0 ? lo : undefined;
  return JSON.stringify(next === undefined ? { messages: kept } : { messages: kept, before: next });
}

/** Fetches and opens the chat's messages `before − count` to `before − 1`. */
export async function readHistory(
  request: Request,
  keys: ChatKeys,
  chatId: string,
  before: number,
  count: number,
): Promise<string | null> {
  const lo = Math.max(0, before - count);
  const chunks: number[] = [];
  for (let c = chunkOf(lo); c <= chunkOf(before - 1); c += 1) chunks.push(c);
  const messages: ChatMessage[] = [];
  const done = await request(
    "message.chunks",
    { chat_id: chatId, chunks: chunks.map((chunk) => ({ chunk })) },
    { retry: "resend", onPart: (part) => messages.push(...part.chunks.flatMap((c) => c.messages)) },
  );
  messages.push(...done.chunks.flatMap((c) => c.messages));
  const wanted = messages.filter((m) => m.id >= lo && m.id < before);
  const opened = await Promise.all(
    wanted.map(async (message) => {
      const { content } = await openMessage(keys, chatId, message);
      return { message, text: content.kind === "text" ? content.text : content.kind === "deleted" ? "" : null };
    }),
  );
  return historyResult(opened, before, count);
}
