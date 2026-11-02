/**
 * What chat records hold (docs/crypto.md, "Record contents") and what a turn
 * sends with it. A record the client cannot show becomes an `Unreadable`
 * reason, rendered in its place (D-089).
 */

import { Decoder, Encoder } from "@msgpack/msgpack";
import { readDocument } from "../document/read";
import type {
  Block,
  ContextFile,
  ContextMessage,
  FileRef,
  History,
  Outcome,
  TokenUsage,
  ToolUse,
  TurnContext,
} from "../protocol/generated/protocol";

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

/**
 * A record's text and document, or why it cannot be shown. `doc` is absent
 * when the record has none and `null` when it has one this client cannot
 * read (docs/crypto.md, "Message documents").
 */
export type Readable =
  | { ok: true; text: string; doc?: Block[] | null; raw: Record<string, unknown> }
  | { ok: false; reason: Unreadable };

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
  if (raw["doc"] === undefined) return { ok: true, text, raw };
  return { ok: true, text, doc: readDocument(raw["doc"]), raw };
}

const OUTCOMES = new Set<string>(["approved", "denied", "refused", "timeout", "cancelled", "answered"]);
/** Calls a reply lists at most: a turn makes 8, and a few more would only be noise. */
const TOOLS_MAX = 16;

/**
 * A reply's `tools` (docs/crypto.md, "Record contents"): each call's tool,
 * metric, days and outcome. Entries this client cannot read are left out.
 */
/** A reply's token counts, when its record holds sound ones (D-122). */
export function readUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { input, output } = raw as Record<string, unknown>;
  const sound = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  return sound(input) && sound(output) ? { input, output } : undefined;
}

export function readTools(raw: unknown): ToolUse[] {
  if (!Array.isArray(raw)) return [];
  const text = (v: unknown) => (typeof v === "string" && v.length <= 64 ? v : undefined);
  const tools: ToolUse[] = [];
  for (const item of raw.slice(0, TOOLS_MAX)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const fields = item as Record<string, unknown>;
    const tool = text(fields["tool"]);
    if (!tool) continue;
    const use: ToolUse = { tool };
    const metric = text(fields["metric"]);
    const from = text(fields["from"]);
    const to = text(fields["to"]);
    const outcome = fields["outcome"];
    const count = fields["count"];
    if (metric) use.metric = metric;
    if (typeof count === "number" && Number.isInteger(count) && count >= 0) use.count = count;
    if (from) use.from = from;
    if (to) use.to = to;
    const host = fields["host"];
    if (typeof host === "string" && host.length <= 255) use.host = host;
    if (typeof outcome === "string" && OUTCOMES.has(outcome)) use.outcome = outcome as Outcome;
    tools.push(use);
  }
  return tools;
}

/** Files a message lists at most (docs/protocol.md, "Files"). */
const FILES_MAX = 10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A user message's `files` (docs/crypto.md, "Record contents"): each file's
 * id, name, type, size and an image's pixels, ThumbHash and original.
 * Entries this client cannot read are left out.
 */
export function readFiles(raw: unknown): FileRef[] {
  if (!Array.isArray(raw)) return [];
  const text = (v: unknown, max: number) => (typeof v === "string" && v !== "" && v.length <= max ? v : undefined);
  const count = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);
  const id = (v: unknown) => (typeof v === "string" && UUID.test(v) ? v : undefined);
  const files: FileRef[] = [];
  for (const item of raw.slice(0, FILES_MAX)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const f = item as Record<string, unknown>;
    const fileId = id(f["id"]);
    const name = text(f["name"], 255);
    const type = text(f["type"], 127);
    const size = count(f["size"]);
    if (!fileId || !name || !type || size === undefined) continue;
    const file: FileRef = { id: fileId, name, type, size };
    const w = count(f["w"]);
    const h = count(f["h"]);
    if (w && h) {
      file.w = w;
      file.h = h;
    }
    const hash = f["hash"];
    if (hash instanceof Uint8Array && hash.length <= 32) file.hash = hash;
    const original = f["original"];
    if (original && typeof original === "object" && !Array.isArray(original)) {
      const o = original as Record<string, unknown>;
      const oid = id(o["id"]);
      const otype = text(o["type"], 127);
      const osize = count(o["size"]);
      if (oid && otype && osize !== undefined) file.original = { id: oid, type: otype, size: osize };
    }
    files.push(file);
  }
  return files;
}

/** A message's file as the context tells the model of it; the description comes from its record. */
export function contextFile(file: FileRef, description?: string): ContextFile {
  const out: ContextFile = { file_id: file.id, name: file.name, type: file.type, size: file.size };
  if (file.w !== undefined && file.h !== undefined) {
    out.w = file.w;
    out.h = file.h;
  }
  if (description) out.description = description;
  return out;
}

/** The plaintext of an edited message: the new text, and whatever else the record held but a document of the old text. */
export function encodeMessage(text: string, raw: Record<string, unknown> = {}): Uint8Array {
  const { doc: _old, ...kept } = raw;
  return encoder.encode({ ...kept, text });
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

const TITLE_OPEN = "<title>";
const TITLE_CLOSE = "</title>";

/**
 * A summary's text without its `<title>` line (docs/protocol.md, "Titles"),
 * and the title. While the line is still streaming the body is empty, so the
 * tag never shows; a tag left open ends at the line's end.
 */
export function splitTitle(text: string): { title?: string; body: string } {
  const start = text.trimStart();
  if (!start.startsWith(TITLE_OPEN)) return { body: start !== "" && TITLE_OPEN.startsWith(start) ? "" : text };
  const close = start.indexOf(TITLE_CLOSE);
  const newline = start.indexOf("\n");
  if (close >= 0 && (newline < 0 || close < newline)) {
    return {
      title: start.slice(TITLE_OPEN.length, close),
      body: start.slice(close + TITLE_CLOSE.length).trimStart(),
    };
  }
  if (newline < 0) return { body: "" };
  return { title: start.slice(TITLE_OPEN.length, newline), body: start.slice(newline + 1).trimStart() };
}

/** Quotes and Markdown marks a model wraps a title in. */
const WRAPPING = /^[\s"'«»“”„*#_`]+|[\s"'«»“”„*_`.]+$/gu;

/** A model's title made safe to keep: one line, unwrapped, shortened; empty when nothing is left. */
export function autoTitle(text: string): string {
  const line =
    text
      .replace(/<\/?title>/g, "")
      .split("\n")
      .find((l) => l.trim() !== "") ?? "";
  return titleFrom(line.replace(WRAPPING, "").replace(/\s+/g, " "));
}

/** The server's limit on a turn's context (docs/protocol.md, "Limits"). */
const CONTEXT_BYTES = 512 * 1024;

/** Auto-compaction's threshold when neither the chat nor the account set one (D-091). */
export const THRESHOLD_DEFAULT = 64_000;
/** The thresholds a chat may choose, as the server checks them. */
export const THRESHOLD_MIN = 4_000;
export const THRESHOLD_MAX = 128_000;

/** How much history a turn carries, with every default filled in. */
export type HistoryChoice =
  | { mode: "recent"; messages: number }
  | { mode: "compact"; auto: boolean; threshold: number };

/** The chat's choice, else the account's, else auto-compaction at the default threshold (D-091). */
export function resolveHistory(chat: History | undefined, account: History | undefined): HistoryChoice {
  const history = chat ?? account;
  if (history?.mode === "recent") return { mode: "recent", messages: history.messages };
  // A chat that only chose `compact` takes the account's auto and threshold.
  const fallback = account?.mode === "compact" ? account : undefined;
  return {
    mode: "compact",
    auto: history?.auto ?? fallback?.auto ?? true,
    threshold: history?.threshold ?? fallback?.threshold ?? THRESHOLD_DEFAULT,
  };
}

/** Estimated tokens of a text (docs/protocol.md, "Chat settings"). */
export function tokens(bytes: number): number {
  return Math.ceil(bytes / 4);
}

/** A message as the context picks from it: only readable, finished, non-empty user and assistant text counts. */
export interface ContextCandidate {
  id: number;
  author: string;
  state: string;
  deleted: boolean;
  text: string | null;
  /** A user message's files, as its record lists them. */
  files?: FileRef[];
}

/** The chat's current summary as the context starts from it. */
export interface SummaryBase {
  id: number;
  through: number;
  text: string;
}

function counts(m: ContextCandidate): m is ContextCandidate & { text: string; author: "user" | "assistant" } {
  // A message of files alone has no text and still counts.
  const empty = m.text === "" && !m.files?.length;
  if (m.deleted || m.text === null || empty || m.state === "failed" || m.state === "streaming") return false;
  return m.author === "user" || m.author === "assistant";
}

function message(m: ContextCandidate & { text: string; author: "user" | "assistant" }): ContextMessage {
  const files = m.files?.map((f) => contextFile(f)) ?? [];
  return files.length > 0
    ? { id: m.id, role: m.author, text: m.text, files }
    : { id: m.id, role: m.author, text: m.text };
}

/**
 * The latest messages before a turn, oldest first: at most `count` and what
 * the server takes. Failed replies, tombstones, summaries and unreadable
 * records are left out; a cancelled reply counts with the text it got.
 */
export function pickContext(before: ContextCandidate[], count: number, summary?: SummaryBase): TurnContext {
  const picked: ContextMessage[] = [];
  let bytes = summary ? utf8.encode(summary.text).length : 0;
  for (const m of [...before].sort((a, b) => b.id - a.id)) {
    if (picked.length === count) break;
    if (summary && m.id <= summary.through) break;
    if (!counts(m)) continue;
    const size = utf8.encode(m.text).length;
    if (bytes + size > CONTEXT_BYTES) break;
    bytes += size;
    picked.push(message(m));
  }
  picked.reverse();
  return summary ? { summary: summary.text, messages: picked } : { messages: picked };
}

/** The context of a `compact` turn: the summary and every message after its cut that fits. */
export function compactContext(before: ContextCandidate[], summary: SummaryBase | undefined): TurnContext {
  return pickContext(before, Number.POSITIVE_INFINITY, summary);
}

/** What one `chat.compact` folds. */
export interface Fold {
  through: number;
  context: TurnContext;
}

/**
 * The next compaction of a chat whose context starts at `summary`, or
 * nothing when the context with `pending` bytes still to come stays within
 * `threshold` tokens. The latest messages up to a quarter of the threshold
 * stay whole; `all` folds them too ("Compact now"). What folds is at most a
 * context's limit from the oldest on, so a long stretch compacts in steps.
 */
export function planFold(
  before: ContextCandidate[],
  summary: SummaryBase | undefined,
  options: { threshold: number; pending?: number; all?: boolean },
): Fold | null {
  const after = before
    .filter((m) => (summary === undefined || m.id > summary.through) && counts(m))
    .sort((a, b) => a.id - b.id) as (ContextCandidate & { text: string; author: "user" | "assistant" })[];
  if (after.length === 0) return null;
  const sizes = after.map((m) => utf8.encode(m.text).length);
  const base = summary ? utf8.encode(summary.text).length : 0;
  const total = base + sizes.reduce((n, size) => n + size, 0) + (options.pending ?? 0);
  if (!options.all && tokens(total) <= options.threshold) return null;
  // The kept tail: whole messages from the newest, within a quarter of the threshold.
  let kept = 0;
  if (!options.all) {
    let bytes = 0;
    for (let i = after.length - 1; i >= 0; i -= 1) {
      bytes += sizes[i] ?? 0;
      if (tokens(bytes) > options.threshold / 4) break;
      kept += 1;
    }
    if (kept === after.length) kept = 0;
  }
  const folded: ContextMessage[] = [];
  let bytes = base;
  for (let i = 0; i < after.length - kept; i += 1) {
    const size = sizes[i] ?? 0;
    if (folded.length > 0 && bytes + size > CONTEXT_BYTES) break;
    bytes += size;
    folded.push(message(after[i] as ContextCandidate & { text: string; author: "user" | "assistant" }));
  }
  const through = folded.at(-1)?.id;
  if (through === undefined) return null;
  return { through, context: summary ? { summary: summary.text, messages: folded } : { messages: folded } };
}
