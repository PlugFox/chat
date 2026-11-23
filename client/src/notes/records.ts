/**
 * What note records hold (docs/crypto.md, "Record contents"): a title with
 * the start of the text, and a body that is a document. Fields this client
 * does not know are kept and written back.
 */

import { Decoder, Encoder } from "@msgpack/msgpack";
import type { Unreadable } from "../chats/records";

const encoder = new Encoder({ ignoreUndefined: true });
const decoder = new Decoder();
const utf8 = new TextEncoder();

/** Bytes of UTF-8 a title and an excerpt hold at most. */
export const TITLE_MAX = 512;
export const EXCERPT_MAX = 512;
/** Matches the server's `NOTE_TITLE_MAX` and `NOTE_BODY_MAX`. */
export const TITLE_RECORD_MAX = 2048;
export const BODY_RECORD_MAX = 256 * 1024;
const RECORD_VERSION = 1;

type Fields = Record<string, unknown>;

export type NoteTitle = { ok: true; title: string; excerpt: string; raw: Fields } | { ok: false; reason: Unreadable };

export type NoteBody = { ok: true; doc: unknown; raw: Fields } | { ok: false; reason: Unreadable };

/** Checks what the header and length tell before the worker opens the record. */
export function precheck(record: Uint8Array, max: number): Unreadable | null {
  if (record.length > max) return "size";
  if (record[0] !== RECORD_VERSION) return "version";
  return null;
}

function map(plaintext: Uint8Array): Fields | null {
  try {
    const decoded = decoder.decode(plaintext);
    return decoded && typeof decoded === "object" && !Array.isArray(decoded) ? (decoded as Fields) : null;
  } catch {
    return null;
  }
}

/** At most `max` bytes of UTF-8, cut at a character boundary. */
export function cut(text: string, max: number): string {
  if (utf8.encode(text).length <= max) return text;
  let kept = "";
  let size = 0;
  for (const char of text) {
    size += utf8.encode(char).length;
    if (size > max) break;
    kept += char;
  }
  return kept;
}

export function decodeTitle(plaintext: Uint8Array): NoteTitle {
  const raw = map(plaintext);
  if (!raw) return { ok: false, reason: "parse" };
  const title = raw["title"];
  const excerpt = raw["excerpt"] ?? "";
  if (typeof title !== "string" || typeof excerpt !== "string") return { ok: false, reason: "parse" };
  if (utf8.encode(title).length > TITLE_MAX || utf8.encode(excerpt).length > EXCERPT_MAX) {
    return { ok: false, reason: "size" };
  }
  return { ok: true, title, excerpt, raw };
}

export function encodeTitle(title: string, excerpt: string, raw: Fields = {}): Uint8Array {
  const short = cut(excerpt, EXCERPT_MAX);
  return encoder.encode({ ...raw, title: cut(title, TITLE_MAX), excerpt: short === "" ? undefined : short });
}

export function decodeBody(plaintext: Uint8Array): NoteBody {
  const raw = map(plaintext);
  if (!raw || raw["doc"] === undefined) return { ok: false, reason: "parse" };
  return { ok: true, doc: raw["doc"], raw };
}

export function encodeBody(doc: unknown, raw: Fields = {}): Uint8Array {
  return encoder.encode({ ...raw, doc });
}
