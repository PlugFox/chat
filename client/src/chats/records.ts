/**
 * What chat records hold (docs/crypto.md, "Record contents") and what a turn
 * sends with it. A record the client cannot show becomes an `Unreadable`
 * reason, rendered in its place (D-089).
 */

import { Decoder, Encoder } from "@msgpack/msgpack";
import type { ContextMessage, TurnContext } from "../protocol/generated/protocol";

const encoder = new Encoder({ ignoreUndefined: true });
const decoder = new Decoder();
const utf8 = new TextEncoder();
const strict = new TextDecoder("utf-8", { fatal: true });

/** The record format this client reads (docs/crypto.md, "Records"). */
const RECORD_VERSION = 1;
/** Matches the server's `TEXT_MAX` and `RECORD_MAX`. */
export const TEXT_MAX = 200 * 1024;
const RECORD_MAX = 256 * 1024;
const TITLE_MAX = 1024;
/** Characters of the first line that name a new chat. */
const TITLE_CHARS = 60;

/** Why a record is not shown. */
export type Unreadable = "decrypt" | "parse" | "version" | "size";

/** A record's text, or why it cannot be shown. */
export type Readable = { ok: true; text: string; raw: Record<string, unknown> } | { ok: false; reason: Unreadable };

/** Checks what the header and length tell before the worker opens the record. */
export function precheck(record: Uint8Array): Unreadable | null {
  if (record.length > RECORD_MAX) return "size";
  if (record[0] !== RECORD_VERSION) return "version";
  return null;
}

/** The text of a `chat.message` plaintext; fields this client does not know are kept in `raw`. */
export function decodeMessage(plaintext: Uint8Array): Readable {
  let decoded: unknown;
  try {
    decoded = decoder.decode(plaintext);
  } catch {
    return { ok: false, reason: "parse" };
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return { ok: false, reason: "parse" };
  const raw = decoded as Record<string, unknown>;
  const text = raw["text"];
  if (typeof text !== "string") return { ok: false, reason: "parse" };
  if (utf8.encode(text).length > TEXT_MAX) return { ok: false, reason: "size" };
  return { ok: true, text, raw };
}

/** The plaintext of an edited message: the new text, and whatever else the record held. */
export function encodeMessage(text: string, raw: Record<string, unknown> = {}): Uint8Array {
  return encoder.encode({ ...raw, text });
}

export function decodeTitle(plaintext: Uint8Array): { ok: true; text: string } | { ok: false; reason: Unreadable } {
  if (plaintext.length > TITLE_MAX) return { ok: false, reason: "size" };
  try {
    return { ok: true, text: strict.decode(plaintext) };
  } catch {
    return { ok: false, reason: "parse" };
  }
}

/** At most 1 KiB of UTF-8, cut at a character boundary. */
export function encodeTitle(title: string): Uint8Array {
  let kept = "";
  for (const char of title) {
    if (utf8.encode(kept + char).length > TITLE_MAX) break;
    kept += char;
  }
  return utf8.encode(kept);
}

/** A new chat's title: the first non-empty line of its first message, shortened. */
export function titleFrom(text: string): string {
  const line =
    text
      .split("\n")
      .find((l) => l.trim() !== "")
      ?.trim() ?? "";
  const chars = [...line];
  return chars.length > TITLE_CHARS ? `${chars.slice(0, TITLE_CHARS - 1).join("")}…` : line;
}

/** How much history a turn carries until chats choose it themselves (D-091). */
const CONTEXT_MESSAGES = 50;
const CONTEXT_BYTES = 64 * 1024;

/** A message as the context picks from it: only readable, finished, non-empty user and assistant text counts. */
export interface ContextCandidate {
  id: number;
  author: string;
  state: string;
  deleted: boolean;
  text: string | null;
}

/**
 * The latest messages before a turn, oldest first: at most 50 and 64 KiB of
 * text. Failed replies, tombstones and unreadable records are left out; a
 * cancelled reply counts with the text it got.
 */
export function pickContext(before: ContextCandidate[]): TurnContext {
  const picked: ContextMessage[] = [];
  let bytes = 0;
  for (const m of [...before].sort((a, b) => b.id - a.id)) {
    if (picked.length === CONTEXT_MESSAGES) break;
    if (m.deleted || m.text === null || m.text === "" || m.state === "failed" || m.state === "streaming") continue;
    if (m.author !== "user" && m.author !== "assistant") continue;
    const size = utf8.encode(m.text).length;
    if (bytes + size > CONTEXT_BYTES) break;
    bytes += size;
    picked.push({ id: m.id, role: m.author, text: m.text });
  }
  return { messages: picked.reverse() };
}
