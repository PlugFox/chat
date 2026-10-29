/**
 * What chat records hold (docs/crypto.md, "Record contents") and what a turn
 * sends with it. A record the client cannot show becomes an `Unreadable`
 * reason, rendered in its place (D-089).
 */

import { Decoder, Encoder } from "@msgpack/msgpack";
import { readDocument } from "../document/read";
import type { Block, ContextMessage, History, Outcome, ToolUse, TurnContext } from "../protocol/generated/protocol";

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
    if (metric) use.metric = metric;
    if (from) use.from = from;
    if (to) use.to = to;
    if (typeof outcome === "string" && OUTCOMES.has(outcome)) use.outcome = outcome as Outcome;
    tools.push(use);
  }
  return tools;
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
}

/** The chat's current summary as the context starts from it. */
export interface SummaryBase {
  id: number;
  through: number;
  text: string;
}

function counts(m: ContextCandidate): m is ContextCandidate & { text: string; author: "user" | "assistant" } {
  if (m.deleted || m.text === null || m.text === "" || m.state === "failed" || m.state === "streaming") return false;
  return m.author === "user" || m.author === "assistant";
}

function message(m: ContextCandidate & { text: string; author: "user" | "assistant" }): ContextMessage {
  return { id: m.id, role: m.author, text: m.text };
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
