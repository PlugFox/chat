/**
 * What a `register.value` record holds (docs/crypto.md, "Record contents"):
 * a number in the metric's unit, the UTC offset where it was recorded, which
 * names its day, and an optional comment. Fields this client does not know
 * are kept and written back.
 */

import { Decoder, Encoder } from "@msgpack/msgpack";
import type { Unreadable } from "../chats/records";
import { cut } from "../notes/records";

const encoder = new Encoder({ ignoreUndefined: true });
const decoder = new Decoder();
const utf8 = new TextEncoder();

/** Bytes of UTF-8 a comment holds at most. */
export const COMMENT_MAX = 500;
/** Matches the server's `VALUE_MAX`. */
export const VALUE_RECORD_MAX = 1024;
/** UTC offsets reach ±14 hours. */
const TZ_MAX = 840;

type Fields = Record<string, unknown>;

export interface EntryValue {
  value: number;
  /** Minutes east of UTC where the entry was recorded. */
  tz: number;
  comment: string;
}

export type ReadValue = ({ ok: true; raw: Fields } & EntryValue) | { ok: false; reason: Unreadable };

export function decodeValue(plaintext: Uint8Array): ReadValue {
  let raw: unknown;
  try {
    raw = decoder.decode(plaintext);
  } catch {
    return { ok: false, reason: "parse" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "parse" };
  const fields = raw as Fields;
  const { value, tz } = fields;
  const comment = fields["comment"] ?? "";
  if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, reason: "parse" };
  if (typeof tz !== "number" || !Number.isInteger(tz) || Math.abs(tz) > TZ_MAX) return { ok: false, reason: "parse" };
  if (typeof comment !== "string") return { ok: false, reason: "parse" };
  if (utf8.encode(comment).length > COMMENT_MAX) return { ok: false, reason: "size" };
  return { ok: true, value, tz, comment, raw: fields };
}

export function encodeValue(entry: EntryValue, raw: Fields = {}): Uint8Array {
  const comment = cut(entry.comment.trim(), COMMENT_MAX);
  return encoder.encode({ ...raw, value: entry.value, tz: entry.tz, comment: comment === "" ? undefined : comment });
}
