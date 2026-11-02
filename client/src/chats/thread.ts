/**
 * The messages of one open chat (docs/protocol.md, "Chats and messages"):
 * chunks fetched as they scroll into view and trusted only for the current
 * socket, kept current by message events, reconciled per message by `rev`;
 * a streaming reply shows its last snapshot followed by the deltas after it.
 * Records are opened in the worker; one the client cannot show stays in its
 * place as unreadable (D-089). Framework-free so it can be tested without a
 * DOM.
 */

import { type Attachment, forget, uploadAll } from "../files/attach";
import type { ChatFiles } from "../files/chat-files";
import type {
  Block,
  ChatMessage,
  ChatSettings,
  ChunkList,
  FileRef,
  History,
  MessageDeleted,
  MessageDelta,
  SentFile,
  ToolUse,
  TurnContext,
} from "../protocol/generated/protocol";
import type { ChatKind } from "../vault/keys";
import type { ChatKeys, Request } from "./list";
import {
  type ContextCandidate,
  compactContext,
  decodeMessage,
  encodeMessage,
  encodeTitle,
  type HistoryChoice,
  pickContext,
  planFold,
  precheck,
  readFiles,
  readTools,
  resolveHistory,
  type SummaryBase,
  splitTitle,
  titleFrom,
  tokens,
  type Unreadable,
} from "./records";

export const CHUNK_SHIFT = 6;
/** The reply to a chat's first message, after which it gets its title. */
const FIRST_REPLY = 1;
/** At most this many chunks per `message.chunks`. */
const CHUNKS_PER_REQUEST = 8;

const resend = { retry: "resend" } as const;
/** Compactions before one send at most: a long stretch folds in steps. */
const FOLDS_PER_SEND = 4;
/** How long a summary is waited for: a turn's limit and some (D-088). */
const SUMMARY_WAIT_MS = 11 * 60 * 1000;
/** How much of each message of the first exchange a title is asked from. */
const TITLE_CONTEXT_CHARS = 4000;

export type Content =
  | { kind: "loading" }
  /** `doc` as `Readable` has it; only while no deltas follow the record. */
  | { kind: "text"; text: string; doc?: Block[] | null }
  | { kind: "unreadable"; reason: Unreadable }
  | { kind: "deleted" };

/** A message as the chat view shows it. */
export interface Shown {
  message: ChatMessage;
  /** The record's text with the deltas after it while streaming. */
  content: Content;
  /** A reply's tool calls, as its record lists them (D-099). */
  tools: ToolUse[];
  /** A user message's files, as its record lists them (D-101). */
  files: FileRef[];
}

interface Entry {
  message: ChatMessage;
  /** The opened record, the `seq` it includes, and the fields it held. */
  opened: Content;
  openedSeq: number;
  /** The `rev` of the copy `opened` came from: an older copy shows until a newer one opens. */
  openedRev: number;
  raw: Record<string, unknown>;
  /** Deltas after `openedSeq`, by `seq`. */
  deltas: Map<number, string>;
}

export function chunkOf(id: number): number {
  return id >> CHUNK_SHIFT;
}

function kind(message: Pick<ChatMessage, "id" | "author">): ChatKind {
  return { kind: "chat.message", messageId: message.id, author: message.author };
}

/** The reply's text so far: the opened record, then the deltas that follow it without a gap. */
function written(entry: Entry): Content {
  if (entry.opened.kind !== "text" || entry.deltas.size === 0) return entry.opened;
  let text = entry.opened.text;
  for (let seq = entry.openedSeq + 1; entry.deltas.has(seq); seq += 1) text += entry.deltas.get(seq);
  // A record with deltas after it is a snapshot, which has no document.
  return { kind: "text", text };
}

/** What the chat shows and sends of a message: a summary without its title line. */
function shown(entry: Entry): Content {
  return shownContent(entry.message.author, written(entry));
}

/** A message's record opened in the worker, and the fields it held. */
export async function openMessage(
  keys: ChatKeys,
  chatId: string,
  message: ChatMessage,
): Promise<{ content: Content; raw: Record<string, unknown> }> {
  if (!message.record) return { content: { kind: "deleted" }, raw: {} };
  const early = precheck(message.record);
  if (early) return { content: { kind: "unreadable", reason: early }, raw: {} };
  try {
    const read = decodeMessage((await keys.openChat(chatId, kind(message), message.record)).plaintext);
    if (!read.ok) return { content: { kind: "unreadable", reason: read.reason }, raw: {} };
    const content: Content =
      read.doc === undefined ? { kind: "text", text: read.text } : { kind: "text", text: read.text, doc: read.doc };
    return { content, raw: read.raw };
  } catch {
    return { content: { kind: "unreadable", reason: "decrypt" }, raw: {} };
  }
}

/** What a message shows of its content: a summary without its title line. */
export function shownContent(author: ChatMessage["author"], content: Content): Content {
  if (author !== "summary" || content.kind !== "text") return content;
  return { ...content, text: splitTitle(content.text).body };
}

/**
 * Starts a chat with its first message and its files, uploaded once the
 * chat's keys exist; resolves to the new chat's id.
 */
export async function startChat(
  request: Request,
  keys: ChatKeys,
  text: string,
  settings: ChatSettings = {},
  attachments: Attachment[] = [],
  files?: (chatId: string) => ChatFiles | null,
  temporary = false,
): Promise<string> {
  const chatId = crypto.randomUUID();
  const created = await keys.createChat(chatId);
  const title = await keys.sealChat(
    chatId,
    { kind: "chat.title" },
    encodeTitle(titleFrom(text || attachments[0]?.name || "")),
  );
  const chatFiles = files?.(chatId) ?? null;
  const sent = await sendFiles(request, keys, chatId, attachments, chatFiles);
  await unlessSent(request, sent, () =>
    request(
      "message.send",
      {
        idempotency_key: crypto.randomUUID(),
        chat_id: chatId,
        new_chat: {
          public_key: created.publicKey,
          wrapped_private_key: created.wrappedPrivateKey,
          title,
          settings,
          ...(temporary ? { temporary } : {}),
        },
        text,
        context: { messages: [] },
        ...(sent.length > 0 ? { files: sent } : {}),
      },
      resend,
    ),
  );
  return chatId;
}

async function sendFiles(
  request: Request,
  keys: ChatKeys,
  chatId: string,
  attachments: Attachment[],
  files: ChatFiles | null,
): Promise<SentFile[]> {
  if (attachments.length === 0) return [];
  if (!files) throw new Error("files are off");
  return uploadAll({ request, keys, http: files.http }, chatId, attachments, files);
}

/**
 * Runs a send of uploaded files; a send that fails takes them back. The
 * server forgets only files no message took, so a send that went through
 * with its answer lost keeps them.
 */
async function unlessSent(request: Request, files: SentFile[], send: () => Promise<unknown>): Promise<void> {
  try {
    await send();
  } catch (e) {
    await forget(
      { request },
      files.flatMap((f) => [f.file_id, ...(f.original ? [f.original.file_id] : [])]),
    );
    throw e;
  }
}

export class Thread {
  private readonly entries = new Map<number, Entry>();
  /** Deltas of replies not known yet, by message id. */
  private readonly early = new Map<number, Map<number, string>>();
  private readonly listeners = new Set<() => void>();
  /** Chunks fetched over the current socket (D-028), and those being fetched. */
  private readonly fetched = new Set<number>();
  private readonly fetching = new Set<number>();
  /**
   * The revision each chunk was complete at: from a whole fetch, then kept
   * by the events of the socket it came over. An event for a chunk never
   * fetched says nothing about the rest of it, so it does not count.
   */
  private readonly revs = new Map<number, number>();
  /** The chunks the view last asked for, fetched again after a reset. */
  private wanted: number[] = [];
  private last: number;
  /** The chat's current summary as the list last named it. */
  private summaryHint: number | undefined;

  constructor(
    readonly chatId: string,
    lastMessageId: number,
    private readonly request: Request,
    private readonly keys: ChatKeys,
    /** Takes the model's title for the chat (docs/protocol.md, "Titles"). */
    private readonly retitle: (title: string) => void = () => {},
    /** The chat's files; `null` when the server has no file store (or is not connected). */
    private readonly chatFiles: () => ChatFiles | null = () => null,
  ) {
    this.last = lastMessageId;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  /** The highest message id known. */
  get lastId(): number {
    return this.last;
  }

  /** Follows the chat's `last_message_id` and `summary_id` from the list. */
  grow(lastMessageId: number, summaryId?: number): void {
    this.summaryHint = summaryId;
    if (lastMessageId <= this.last) return;
    this.last = lastMessageId;
    this.changed();
  }

  message(id: number): Shown | undefined {
    const entry = this.entries.get(id);
    return (
      entry && {
        message: entry.message,
        content: shown(entry),
        tools: readTools(entry.raw["tools"]),
        files: readFiles(entry.raw["files"]),
      }
    );
  }

  /** Whether a chunk came over the current socket. */
  has(chunk: number): boolean {
    return this.fetched.has(chunk);
  }

  /** Fetches the chunks not fetched over this socket yet; changes since the held `rev` only. */
  async ensure(chunks: number[]): Promise<void> {
    this.wanted = chunks;
    const missing = chunks.filter((c) => c >= 0 && !this.fetched.has(c) && !this.fetching.has(c));
    const batches: number[][] = [];
    for (let i = 0; i < missing.length; i += CHUNKS_PER_REQUEST) batches.push(missing.slice(i, i + CHUNKS_PER_REQUEST));
    await Promise.all(batches.map((batch) => this.fetch(batch)));
  }

  private async fetch(batch: number[]): Promise<void> {
    for (const c of batch) this.fetching.add(c);
    const revs = new Map<number, number>();
    const apply = (part: ChunkList) => {
      for (const chunk of part.chunks) {
        revs.set(chunk.chunk, Math.max(revs.get(chunk.chunk) ?? 0, chunk.rev));
        for (const message of chunk.messages) this.put(message);
      }
    };
    try {
      const done = await this.request(
        "message.chunks",
        { chat_id: this.chatId, chunks: batch.map((chunk) => ({ chunk, ...this.held(chunk) })) },
        { retry: "resend", onPart: apply },
      );
      apply(done);
      for (const c of batch) {
        this.fetched.add(c);
        this.revs.set(c, Math.max(this.revs.get(c) ?? 0, revs.get(c) ?? 0));
      }
    } finally {
      for (const c of batch) this.fetching.delete(c);
    }
    this.changed();
  }

  /** The revision a chunk was last complete at, if it ever was. */
  private held(chunk: number): { rev?: number } {
    const rev = this.revs.get(chunk);
    return rev === undefined ? {} : { rev };
  }

  /** An event on this socket keeps a fetched chunk's revision current. */
  private follow(id: number, rev: number): void {
    const chunk = chunkOf(id);
    if (this.fetched.has(chunk)) this.revs.set(chunk, Math.max(this.revs.get(chunk) ?? 0, rev));
  }

  /** The socket reconnected or the server reset it: nothing fetched is trusted any more. */
  reset(): void {
    this.fetched.clear();
    void this.ensure(this.wanted).catch(() => undefined);
  }

  /** A message from an event (`message.created`, `message.updated`). */
  receive(message: ChatMessage): void {
    this.put(message);
    this.follow(message.id, message.rev);
  }

  /** A message from a chunk or an event; of two copies the higher `rev` wins. */
  private put(message: ChatMessage): void {
    const known = this.entries.get(message.id);
    if (known && known.message.rev >= message.rev) return;
    const seq = message.seq ?? 0;
    // A retry starts the reply over: the deltas of its earlier run are void.
    const restarted =
      known !== undefined &&
      message.state === "streaming" &&
      (known.message.state !== "streaming" || seq < (known.message.seq ?? 0));
    const deltas = restarted ? new Map<number, string>() : (known?.deltas ?? this.early.get(message.id) ?? new Map());
    this.early.delete(message.id);
    const entry: Entry = {
      message,
      opened: known && !restarted ? known.opened : { kind: "loading" },
      openedSeq: known && !restarted ? known.openedSeq : 0,
      openedRev: known && !restarted ? known.openedRev : -1,
      raw: known?.raw ?? {},
      deltas,
    };
    this.entries.set(message.id, entry);
    this.last = Math.max(this.last, message.id);
    void this.open(entry);
    this.changed();
  }

  private async open(entry: Entry): Promise<void> {
    const { message } = entry;
    const { content: opened, raw } = await openMessage(this.keys, this.chatId, message);
    // A newer copy may have arrived while this one was opening.
    if (this.entries.get(message.id) !== entry) return;
    entry.opened = opened;
    entry.raw = raw;
    entry.openedSeq = message.seq ?? 0;
    entry.openedRev = message.rev;
    for (const seq of entry.deltas.keys()) if (seq <= entry.openedSeq) entry.deltas.delete(seq);
    this.changed();
  }

  delta(delta: MessageDelta): void {
    const entry = this.entries.get(delta.message_id);
    if (!entry) {
      const early = this.early.get(delta.message_id) ?? new Map<number, string>();
      early.set(delta.seq, delta.text);
      this.early.set(delta.message_id, early);
      return;
    }
    // A finished reply takes no more text; its record is final.
    if (entry.message.state !== "streaming" || delta.seq <= entry.openedSeq) return;
    entry.deltas.set(delta.seq, delta.text);
    this.changed();
  }

  deleted(event: MessageDeleted): void {
    const known = this.entries.get(event.message_id);
    if (!known || known.message.rev >= event.rev) {
      this.follow(event.message_id, event.rev);
      return;
    }
    const { id, author, created_at, state } = known.message;
    this.put({ id, author, created_at, state, rev: event.rev, deleted_at: Date.now() });
    this.follow(id, event.rev);
  }

  /** What the context may pick from: the known messages before `id`. */
  private before(id: number): ContextCandidate[] {
    const candidates: ContextCandidate[] = [];
    for (const [mid, entry] of this.entries) {
      if (mid >= id) continue;
      const content = shown(entry);
      const files = readFiles(entry.raw["files"]);
      candidates.push({
        id: mid,
        author: entry.message.author,
        state: entry.message.state,
        deleted: entry.message.deleted_at !== undefined,
        text: content.kind === "text" ? content.text : null,
        ...(files.length > 0 ? { files } : {}),
      });
    }
    return candidates;
  }

  /** Fetches these chunks too, keeping what the view asked for. */
  private async fetchAlso(chunks: number[]): Promise<void> {
    await this.ensure([...new Set([...this.wanted, ...chunks])]);
  }

  /**
   * The summary a context before `id` starts from: the complete one with the
   * largest cut (docs/protocol.md, "Compaction"), its chunk fetched first.
   */
  private async summaryBefore(id: number): Promise<SummaryBase | undefined> {
    if (this.summaryHint !== undefined && this.summaryHint < id) await this.fetchAlso([chunkOf(this.summaryHint)]);
    let best: SummaryBase | undefined;
    for (const [mid, entry] of this.entries) {
      const { author, state, deleted_at, through } = entry.message;
      if (mid >= id || author !== "summary" || state !== "complete" || deleted_at !== undefined) continue;
      if (through === undefined) continue;
      if (best && (through < best.through || (through === best.through && mid < best.id))) continue;
      const content = shown(entry);
      if (content.kind === "text") best = { id: mid, through, text: content.text };
    }
    return best;
  }

  /** Fetches every chunk from the one after the summary's cut up to the message before `id`. */
  private async fetchSince(summary: SummaryBase | undefined, id: number): Promise<void> {
    const chunks: number[] = [];
    for (let c = chunkOf(id - 1); c >= chunkOf((summary?.through ?? -1) + 1) && c >= 0; c -= 1) chunks.push(c);
    await this.fetchAlso(chunks);
  }

  /**
   * The context of a turn answering the message `id`, with the chunks it
   * picks from fetched first. `recent` fetches one chunk more than the count
   * fills, as failed replies and tombstones are skipped; `compact` fetches
   * everything after the summary's cut.
   */
  private async context(id: number, history: HistoryChoice): Promise<TurnContext> {
    if (history.mode === "compact") {
      const summary = await this.summaryBefore(id);
      await this.fetchSince(summary, id);
      return this.described(compactContext(this.before(id), summary));
    }
    if (history.messages === 0) return { messages: [] };
    const span = Math.ceil(history.messages / (1 << CHUNK_SHIFT)) + 1;
    const chunks: number[] = [];
    for (let c = chunkOf(id - 1); c >= 0 && chunks.length < span; c -= 1) chunks.push(c);
    await this.fetchAlso(chunks);
    return this.described(pickContext(this.before(id), history.messages));
  }

  /**
   * About how many tokens the next turn's context takes, by the estimate
   * compaction goes by: text only, without the file descriptions' share and
   * the memory (docs/protocol.md, "Chat settings").
   */
  async contextTokens(history: HistoryChoice): Promise<number> {
    const context = await this.context(this.last + 1, history);
    const text = [context.summary ?? "", ...context.messages.map((m) => m.text)].join("");
    return tokens(new TextEncoder().encode(text).length);
  }

  /** The chat's memory as the model last wrote it, or `null` while it has none (D-117). */
  async memory(): Promise<string | null> {
    const { memory } = await this.request("chat.memory", { chat_id: this.chatId });
    if (!memory) return null;
    const { plaintext } = await this.keys.openChat(this.chatId, { kind: "chat.memory" }, memory);
    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  }

  async clearMemory(): Promise<void> {
    await this.request("chat.memory.clear", { chat_id: this.chatId });
  }

  /**
   * The context with the memory, read anew for each turn so that another
   * device's turn counts. A memory that cannot be read stops the send: the
   * model, not knowing it, would overwrite it.
   */
  private async withMemory(context: TurnContext): Promise<TurnContext> {
    const memory = await this.memory();
    return memory === null ? context : { ...context, memory };
  }

  /**
   * The context with each file's description, so the model gets a few
   * hundred tokens in place of the file (docs/protocol.md, "Files").
   */
  private async described(context: TurnContext): Promise<TurnContext> {
    const files = this.chatFiles();
    if (!files) return context;
    for (const message of context.messages) {
      if (!message.files) continue;
      await Promise.all(
        message.files.map(async (file) => {
          const description = await files.description(file.file_id);
          if (description) file.description = description;
        }),
      );
    }
    return context;
  }

  /** Resolves once the message is known, no longer streaming and opened, or after a turn's limit. */
  private settled(id: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        const entry = this.entries.get(id);
        if (!entry || entry.message.state === "streaming" || entry.openedRev !== entry.message.rev) return false;
        stop();
        clearTimeout(timer);
        resolve();
        return true;
      };
      const stop = this.subscribe(() => void done());
      const timer = setTimeout(() => {
        stop();
        resolve();
      }, SUMMARY_WAIT_MS);
      done();
    });
  }

  /**
   * Compacts the chat (docs/protocol.md, "Compaction") while its context,
   * with `pending` bytes still to come, passes the threshold, or folds every
   * message with `all`; waits for each summary. Resolves to whether a
   * summary was written.
   */
  async compact(options: { threshold: number; pending?: number; all?: boolean }): Promise<boolean> {
    let written = false;
    for (let round = 0; round < FOLDS_PER_SEND; round += 1) {
      const id = this.last + 1;
      const summary = await this.summaryBefore(id);
      await this.fetchSince(summary, id);
      const fold = planFold(this.before(id), summary, options);
      if (!fold) break;
      const sent = await this.request("chat.compact", { chat_id: this.chatId, ...fold });
      await this.settled(sent.message_id);
      if (this.entries.get(sent.message_id)?.message.state !== "complete") break;
      this.renewTitle(sent.message_id);
      written = true;
      // "Compact now" folds once: what is left after the cut is newer than the press.
      if (options.all) break;
    }
    return written;
  }

  /**
   * Sends a message; a refusal (`turn.busy`, `message.too_large`…) rejects and
   * adds nothing (D-089). A chat that compacts compacts first when the
   * context would pass its threshold; a compaction that fails leaves the
   * send to go with the context there is.
   */
  async send(text: string, settings?: ChatSettings, account?: History, attachments: Attachment[] = []): Promise<void> {
    const history = resolveHistory(settings?.history, account);
    if (history.mode === "compact" && history.auto) {
      const pending = new TextEncoder().encode(text).length;
      await this.compact({ threshold: history.threshold, pending }).catch(() => false);
    }
    const context = await this.withMemory(await this.context(this.last + 1, history));
    const files = await sendFiles(this.request, this.keys, this.chatId, attachments, this.chatFiles());
    await unlessSent(this.request, files, () =>
      this.request(
        "message.send",
        {
          idempotency_key: crypto.randomUUID(),
          chat_id: this.chatId,
          text,
          context,
          ...(files.length > 0 ? { files } : {}),
        },
        resend,
      ),
    );
  }

  /** The files a retry gives again, with their keys: those the model reads, never an original. */
  private async resent(id: number): Promise<SentFile[]> {
    const entry = this.entries.get(id);
    const listed = entry ? readFiles(entry.raw["files"]) : [];
    const files = this.chatFiles();
    if (listed.length === 0 || !files) return [];
    return Promise.all(
      listed.map(async (f) => {
        const file: SentFile = { file_id: f.id, key: await files.key(f.id), name: f.name, type: f.type, size: f.size };
        if (f.w !== undefined && f.h !== undefined) {
          file.w = f.w;
          file.h = f.h;
        }
        if (f.hash) file.hash = f.hash;
        return file;
      }),
    );
  }

  /**
   * The user message a failed reply answers, if it can be retried: the
   * reply is the chat's last message and the message before it is the
   * user's, readable.
   */
  retryable(replyId: number): boolean {
    const reply = this.entries.get(replyId);
    const asked = this.entries.get(replyId - 1);
    // A summary answers no message: it folds what it covers again.
    if (reply?.message.author === "summary") {
      return replyId === this.last && (reply.message.state === "failed" || reply.message.state === "streaming");
    }
    return (
      replyId === this.last &&
      reply?.message.author === "assistant" &&
      (reply.message.state === "failed" || reply.message.state === "streaming") &&
      asked?.message.author === "user" &&
      shown(asked).kind === "text"
    );
  }

  /** Runs a failed reply again in place (docs/protocol.md, "Retry"); not resent after a reconnect. */
  async retry(replyId: number, settings?: ChatSettings, account?: History): Promise<void> {
    const reply = this.entries.get(replyId);
    const through = reply?.message.through;
    if (reply?.message.author === "summary" && through !== undefined) {
      const summary = await this.summaryBefore(through + 1);
      await this.fetchSince(summary, through + 1);
      const context = compactContext(this.before(through + 1), summary);
      await this.request("turn.retry", { chat_id: this.chatId, message_id: replyId, text: "", context });
      void this.settled(replyId).then(() => this.renewTitle(replyId));
      return;
    }
    const asked = this.entries.get(replyId - 1);
    const content = asked && shown(asked);
    if (content?.kind !== "text") throw new Error("nothing to retry");
    const context = await this.withMemory(await this.context(replyId - 1, resolveHistory(settings?.history, account)));
    const files = await this.resent(replyId - 1);
    await this.request("turn.retry", {
      chat_id: this.chatId,
      message_id: replyId,
      text: content.text,
      context,
      ...(files.length > 0 ? { files } : {}),
    });
    if (replyId === FIRST_REPLY) void this.title().catch(() => {});
  }

  /** A complete summary renews the chat's title from its title line. */
  private renewTitle(id: number): void {
    const entry = this.entries.get(id);
    if (entry?.message.author !== "summary" || entry.message.state !== "complete") return;
    const content = written(entry);
    const title = content.kind === "text" ? splitTitle(content.text).title : undefined;
    if (title) this.retitle(title);
  }

  /**
   * Asks for the chat's title from its first exchange once the first reply
   * completes; the title comes as `chat.titled` (docs/protocol.md, "Titles").
   */
  async title(): Promise<void> {
    await this.fetchAlso([chunkOf(FIRST_REPLY)]);
    await this.settled(FIRST_REPLY);
    if (this.entries.get(FIRST_REPLY)?.message.state !== "complete") return;
    const context = pickContext(this.before(FIRST_REPLY + 1), FIRST_REPLY + 1);
    const messages = context.messages.map((m) => ({ ...m, text: [...m.text].slice(0, TITLE_CONTEXT_CHARS).join("") }));
    await this.request("chat.title", { chat_id: this.chatId, context: { messages } });
  }

  async cancel(): Promise<void> {
    await this.request("turn.cancel", { chat_id: this.chatId }, resend);
  }

  /** Replaces the user's own message with a new text, sealed by this client. */
  async edit(id: number, text: string): Promise<void> {
    const entry = this.entries.get(id);
    if (entry?.message.author !== "user") throw new Error("not editable");
    const record = await this.keys.sealChat(this.chatId, kind(entry.message), encodeMessage(text, entry.raw));
    await this.request("message.edit", { chat_id: this.chatId, message_id: id, record }, resend);
  }

  async delete(id: number): Promise<void> {
    await this.request("message.delete", { chat_id: this.chatId, message_id: id }, resend);
  }
}
