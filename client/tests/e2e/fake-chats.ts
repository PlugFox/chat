/**
 * Chats as the test build sees them (docs/protocol.md, "Chats and
 * messages"), answered from memory for `FakeKeys`. Messages are sealed as the
 * server seals them, with chat-crypto's own `sealAsServer`, to the chat key
 * the client created, so the client opens them with its real worker. A turn
 * replies with the next of `replies` (by default it echoes), streaming its
 * parts as deltas; `hold` keeps it running until cancelled. A compaction is
 * a turn too, writing a summary message. A reply's last record carries its
 * document, converted with crates/document's WASM build as the server does.
 * A reply with `ask` first sends a permission request, its reason sealed to
 * the account's `audit` scope, and waits for the answer (D-099); the record
 * then lists the call and its outcome.
 */
import { readFileSync } from "node:fs";
import { decode, encode } from "@msgpack/msgpack";
import { sealAsServer } from "../../src/crypto/wasm/chat_crypto.js";
import { initSync, markdown } from "../../src/document/wasm/chat_document.js";
import type {
  AccessEntry,
  AccountKeys,
  ChatInfo,
  ChatMessage,
  Grant,
  Outcome,
  PermissionRequest,
  Requests,
  ScopeKey,
  SentFile,
  ToolUse,
  TurnContext,
  TurnErrorCode,
} from "../../src/protocol/generated/protocol";

initSync({ module: readFileSync(new URL("../../src/document/wasm/chat_document_bg.wasm", import.meta.url)) });

export interface FakeReply {
  parts?: string[];
  error?: TurnErrorCode;
  /** Keep streaming until `turn.cancel`. */
  hold?: boolean;
  /** Ask for this grant first; a register's `scope_id` is filled in when empty. */
  ask?: Grant;
  /** The model's reason for `ask`. */
  reason?: string;
}

/** A request waiting for its answer. */
interface Waiting {
  request: PermissionRequest;
  answer: (outcome: Outcome, result?: string) => void;
}

interface FakeChat {
  info: ChatInfo;
  publicKey: Uint8Array;
  messages: Map<number, ChatMessage>;
  /** Set while a turn runs; `turn.cancel` ends it. */
  cancel?: () => void;
}

/** A refusal, answered as `error { code }`. */
export class Refused extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const PINS_MAX = 32;
const TEXT_MAX = 200 * 1024;
const STEP_MS = 40;

function uuidBytes(uuid: string): Uint8Array {
  return new Uint8Array(
    uuid
      .replace(/-/g, "")
      .match(/../g)
      ?.map((b) => Number.parseInt(b, 16)) ?? [],
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class FakeChats {
  readonly chats = new Map<string, FakeChat>();
  /** Chats outside the pins per `chat.list` page (the server's is 100). */
  pageSize = 100;
  /** What the next turns reply, in order. */
  readonly replies: FakeReply[] = [];
  /** The result of each `message.send`, by idempotency key, for resends. */
  private readonly sent = new Map<string, { message_id: number; turn_id: string }>();
  /** What every turn got from the client. */
  readonly turns: { chat_id: string; text: string; context: TurnContext; files?: SentFile[] }[] = [];
  /** The files of sends, when `FakeKeys` has a file store. */
  files: {
    take: (chatId: string, files: SentFile[]) => void;
    described: (chatId: string, files: SentFile[]) => void;
  } | null = null;
  /** What every compaction folded. */
  readonly compactions: { chat_id: string; through: number; context: TurnContext }[] = [];
  /** The model's answer to `chat.title`; none comes while unset, so chats keep their first line. */
  modelTitle: string | undefined;
  /** What every `chat.title` asked from. */
  readonly titles: { chat_id: string; context: TurnContext }[] = [];
  /** The access log, oldest first. */
  readonly accessLog: AccessEntry[] = [];
  /** Every answer a client sent, with its result. */
  readonly answers: { request_id: string; decision: string; result?: string }[] = [];
  private readonly waiting = new Map<string, Waiting>();
  /** The provider id of the last `agent.start`, which turns name. */
  providerId = "";
  /** A provider id requests name instead, as after the provider was removed elsewhere. */
  requestProvider: string | undefined;
  /** A metric's register scope, for a grant that names none. */
  scopeOf: (metric: string) => string | undefined = () => undefined;
  /** Saved messages by `chat_id/message_id`, with when they were saved. */
  readonly saved = new Map<string, { chat_id: string; message_id: number; saved_at: number }>();

  constructor(
    private readonly userId: string,
    private readonly keys: { scopeKeys: ScopeKey[]; account: AccountKeys | null },
    private readonly broadcast: (type: string, payload: unknown) => void,
  ) {}

  /** The answer to a chat request, or `undefined` for any other type. */
  handle(type: string, payload: unknown): Promise<unknown> | undefined {
    switch (type) {
      case "chat.list":
        return Promise.resolve(this.list(payload as Requests["chat.list"]["request"]));
      case "chat.rename": {
        const p = payload as Requests["chat.rename"]["request"];
        // A name the user gave stays (docs/protocol.md, "Titles").
        if (p.auto && !this.chat(p.chat_id).info.title_auto) return Promise.resolve({});
        return this.change(payload, (chat) => {
          chat.info.title = p.title;
          chat.info.title_auto = p.auto === true;
        });
      }
      case "chat.title":
        return Promise.resolve(this.title(payload as Requests["chat.title"]["request"]));
      case "chat.pin":
        return Promise.resolve(this.pin(payload as Requests["chat.pin"]["request"]));
      case "chat.archive":
        return this.change(payload, (chat, p: Requests["chat.archive"]["request"]) => {
          if (p.archived) {
            const pins = this.pinned().filter((id) => id !== chat.info.chat_id);
            this.repin(pins);
            delete chat.info.pin;
            chat.info.archived_at = Date.now();
          } else {
            delete chat.info.archived_at;
          }
        });
      case "chat.configure":
        return this.change(payload, (chat, p: Requests["chat.configure"]["request"]) => {
          chat.info.settings = p.settings;
        });
      case "chat.delete":
        return Promise.resolve(this.deleteChat(payload as Requests["chat.delete"]["request"]));
      case "message.send":
        return this.send(payload as Requests["message.send"]["request"]);
      case "chat.compact":
        return this.compact(payload as Requests["chat.compact"]["request"]);
      case "message.chunks":
        return Promise.resolve(this.chunks(payload as Requests["message.chunks"]["request"]));
      case "message.edit":
        return Promise.resolve(this.edit(payload as Requests["message.edit"]["request"]));
      case "message.delete":
        return Promise.resolve(this.deleteMessage(payload as Requests["message.delete"]["request"]));
      case "turn.cancel": {
        this.chat((payload as Requests["turn.cancel"]["request"]).chat_id).cancel?.();
        return Promise.resolve({});
      }
      case "turn.retry":
        return this.retry(payload as Requests["turn.retry"]["request"]);
      case "permission.pending":
        return Promise.resolve({ requests: [...this.waiting.values()].map((w) => w.request) });
      case "permission.respond":
        return Promise.resolve(this.respond(payload as Requests["permission.respond"]["request"]));
      case "access_log.list": {
        const before = (payload as Requests["access_log.list"]["request"]).before;
        const newest = [...this.accessLog].reverse();
        const start = before ? newest.findIndex((e) => e.id === before) + 1 : 0;
        const entries = newest.slice(start, start + 50);
        const last = entries.at(-1);
        return Promise.resolve({
          entries,
          ...(start + 50 < newest.length && last ? { next: last.id } : {}),
        });
      }
      case "saved.add":
        return Promise.resolve(this.save(payload as Requests["saved.add"]["request"]));
      case "saved.remove":
        return Promise.resolve(this.unsave(payload as Requests["saved.remove"]["request"]));
      case "saved.list":
        return Promise.resolve(this.savedList(payload as Requests["saved.list"]["request"]));
      case "saved.chat": {
        const chatId = (payload as Requests["saved.chat"]["request"]).chat_id;
        this.chat(chatId);
        const ids = [...this.saved.values()].filter((s) => s.chat_id === chatId).map((s) => s.message_id);
        return Promise.resolve({ message_ids: ids.sort((a, b) => a - b) });
      }
      default:
        return undefined;
    }
  }

  /** Answers at once and sends `modelTitle` a little later, as the server sends the model's. */
  private title(p: Requests["chat.title"]["request"]) {
    this.chat(p.chat_id);
    this.titles.push(p);
    const title = this.modelTitle;
    if (title !== undefined) setTimeout(() => this.broadcast("chat.titled", { chat_id: p.chat_id, title }), STEP_MS);
    return {};
  }

  private chat(chatId: string): FakeChat {
    const chat = this.chats.get(chatId);
    if (!chat) throw new Refused("chat.not_found");
    return chat;
  }

  /** Appends complete replies to a chat without telling the clients, as history from elsewhere. */
  fill(chatId: string, texts: string[]): void {
    const chat = this.chat(chatId);
    for (const text of texts) {
      const id = chat.messages.size;
      const record = this.seal(chat, id, "assistant", text);
      chat.messages.set(id, {
        id,
        author: "assistant",
        created_at: Date.now(),
        state: "complete",
        rev: this.bump(chat),
        record,
      });
      chat.info.last_message_id = id;
    }
  }

  private bump(chat: FakeChat): number {
    chat.info.rev += 1;
    return chat.info.rev;
  }

  private updated(chat: FakeChat): void {
    this.broadcast("chat.updated", { chat: { ...chat.info } });
  }

  /** `doc`: the Markdown of a reply's last record, made into its document. */
  private seal(
    chat: FakeChat,
    id: number,
    author: "user" | "assistant" | "summary",
    text: string,
    doc?: string,
    tools: ToolUse[] = [],
    files: SentFile[] = [],
  ): Uint8Array {
    const content: Record<string, unknown> = doc?.trim() ? { text, doc: decode(markdown(doc)) } : { text };
    if (tools.length > 0) content["tools"] = tools;
    // As the server lists them: every field but the key, ids as strings.
    if (files.length > 0) {
      content["files"] = files.map(({ file_id, key: _key, original, ...rest }) => ({
        id: file_id,
        ...rest,
        ...(original ? { original: { id: original.file_id, type: original.type, size: original.size } } : {}),
      }));
    }
    return sealAsServer(
      uuidBytes(this.userId),
      uuidBytes(chat.info.chat_id),
      1,
      chat.publicKey,
      { kind: "chat.message", messageId: id, author },
      encode(content),
    );
  }

  /** Writes the request, sends it, and waits for its answer or the turn's cancel. */
  private ask(
    chat: FakeChat,
    turnId: string,
    grant: Grant,
    reason: string,
  ): Promise<{ outcome: Outcome; result?: string }> {
    const audit = this.keys.account?.scopes.find((s) => s.kind === "audit");
    const key = this.keys.scopeKeys.find((k) => k.scope_id === audit?.scope_id);
    if (!audit || !key) throw new Error("no audit scope");
    if (grant.tool === "read_register" && grant.scope_id === "") {
      grant = { ...grant, scope_id: this.scopeOf(grant.metric) ?? "" };
    }
    const id = crypto.randomUUID();
    const sealed = sealAsServer(
      uuidBytes(this.userId),
      uuidBytes(audit.scope_id),
      1,
      key.public_key,
      { kind: "audit.reason", logEntryId: uuidBytes(id) },
      new TextEncoder().encode(reason),
    );
    const request: PermissionRequest = {
      request_id: id,
      chat_id: chat.info.chat_id,
      turn_id: turnId,
      provider_id: this.requestProvider ?? this.providerId,
      grant,
      reason: sealed,
      expires_at: Date.now() + 300_000,
    };
    const entry: AccessEntry = { id, chat_id: chat.info.chat_id, grant, reason: sealed, requested_at: Date.now() };
    this.accessLog.push(entry);
    return new Promise((resolve) => {
      const answer = (outcome: Outcome, result?: string) => {
        this.waiting.delete(id);
        entry.outcome = outcome;
        entry.decided_at = Date.now();
        this.broadcast("permission.resolved", { request_id: id, chat_id: chat.info.chat_id, outcome });
        resolve(result === undefined ? { outcome } : { outcome, result });
      };
      this.waiting.set(id, { request, answer });
      chat.cancel = () => answer("cancelled");
      this.broadcast("permission.request", request);
    });
  }

  private respond(p: Requests["permission.respond"]["request"]) {
    const waiting = this.waiting.get(p.request_id);
    if (!waiting) throw new Refused("permission.not_found");
    const tool = waiting.request.grant.tool;
    const history = tool === "read_history" || tool === "read_file";
    const allowed = p.decision === "refuse" || (p.decision === "answer") === history;
    const needs = (p.decision === "approve" && tool === "read_register") || p.decision === "answer";
    if (!allowed || (p.result !== undefined) !== needs) throw new Refused("protocol.malformed");
    this.answers.push({ request_id: p.request_id, decision: p.decision, ...(p.result ? { result: p.result } : {}) });
    const outcomes = { approve: "approved", deny: "denied", refuse: "refused", answer: "answered" } as const;
    waiting.answer(outcomes[p.decision], p.result);
    return {};
  }

  private list(p: Requests["chat.list"]["request"]) {
    const all = [...this.chats.values()].map((c) => c.info);
    // Newest first by `(updated_at, chat_id)`, as the server pages them.
    const recent = (a: ChatInfo, b: ChatInfo) => b.updated_at - a.updated_at || (b.chat_id < a.chat_id ? -1 : 1);
    const before = p.before;
    const after = (c: ChatInfo) =>
      !before || c.updated_at < before.updated_at || (c.updated_at === before.updated_at && c.chat_id < before.chat_id);
    const rest = all
      .filter((c) => c.pin === undefined && (c.archived_at !== undefined) === (p.archived ?? false))
      .sort(recent)
      .filter(after);
    const page = rest.slice(0, this.pageSize);
    const last = page.at(-1);
    const next =
      rest.length > this.pageSize && last ? { next: { updated_at: last.updated_at, chat_id: last.chat_id } } : {};
    const pinned =
      p.archived || before ? [] : all.filter((c) => c.pin !== undefined).sort((a, b) => (a.pin ?? 0) - (b.pin ?? 0));
    return { chats: [...pinned, ...page], ...next };
  }

  private change<P extends { chat_id: string }>(payload: unknown, apply: (chat: FakeChat, p: P) => void) {
    return (async () => {
      const p = payload as P;
      const chat = this.chat(p.chat_id);
      apply(chat, p);
      this.bump(chat);
      this.updated(chat);
      return {};
    })();
  }

  private pinned(): string[] {
    return [...this.chats.values()]
      .filter((c) => c.info.pin !== undefined)
      .sort((a, b) => (a.info.pin ?? 0) - (b.info.pin ?? 0))
      .map((c) => c.info.chat_id);
  }

  /** Writes a pinned order; every chat whose position changed gets `chat.updated`. */
  private repin(order: string[]): void {
    const kept = order.slice(0, PINS_MAX);
    for (const chat of this.chats.values()) {
      const at = kept.indexOf(chat.info.chat_id);
      const pin = at >= 0 ? at : undefined;
      if (chat.info.pin === pin) continue;
      if (pin === undefined) delete chat.info.pin;
      else chat.info.pin = pin;
      this.bump(chat);
      this.updated(chat);
    }
  }

  private pin(p: Requests["chat.pin"]["request"]) {
    const chat = this.chat(p.chat_id);
    if (chat.info.archived_at !== undefined && p.position !== undefined) throw new Refused("chat.archived");
    const order = this.pinned().filter((id) => id !== p.chat_id);
    if (p.position !== undefined) order.splice(Math.min(p.position, order.length), 0, p.chat_id);
    this.repin(order);
    return {};
  }

  private deleteChat(p: Requests["chat.delete"]["request"]) {
    const chat = this.chat(p.chat_id);
    if (chat.info.archived_at === undefined) throw new Refused("chat.not_archived");
    chat.cancel?.();
    this.chats.delete(p.chat_id);
    for (const [key, saved] of this.saved) if (saved.chat_id === p.chat_id) this.saved.delete(key);
    this.broadcast("chat.deleted", { chat_id: p.chat_id });
    return {};
  }

  private put(chat: FakeChat, message: ChatMessage, created: boolean): void {
    chat.messages.set(message.id, message);
    this.broadcast(created ? "message.created" : "message.updated", { chat_id: chat.info.chat_id, message });
  }

  private async send(p: Requests["message.send"]["request"]) {
    if (new TextEncoder().encode(p.text).length > TEXT_MAX) throw new Refused("message.too_large");
    const first = this.sent.get(p.idempotency_key);
    if (first) return first;
    let chat = this.chats.get(p.chat_id);
    if (p.new_chat) {
      if (chat) throw new Refused("chat.exists");
      chat = {
        info: {
          chat_id: p.chat_id,
          ...(p.new_chat.title ? { title: p.new_chat.title } : {}),
          created_at: Date.now(),
          updated_at: Date.now(),
          last_message_id: 0,
          rev: 0,
          turn: false,
          settings: p.new_chat.settings ?? {},
          title_auto: true,
        },
        publicKey: p.new_chat.public_key,
        messages: new Map(),
      };
      this.chats.set(p.chat_id, chat);
      this.keys.scopeKeys.push({
        scope_id: p.chat_id,
        key_version: 1,
        public_key: p.new_chat.public_key,
        wrapped_private_key: p.new_chat.wrapped_private_key,
      });
    }
    if (!chat) throw new Refused("chat.not_found");
    if (chat.info.turn) throw new Refused("turn.busy");
    const sentFiles = p.files ?? [];
    if (sentFiles.length > 0) {
      if (!this.files) throw new Refused("files.disabled");
      this.files.take(chat.info.chat_id, sentFiles);
    }
    const id = chat.messages.size;
    const now = Date.now();
    this.put(
      chat,
      {
        id,
        author: "user",
        created_at: now,
        state: "complete",
        rev: this.bump(chat),
        record: this.seal(chat, id, "user", p.text, undefined, [], sentFiles),
      },
      true,
    );
    this.put(chat, this.empty(chat, id + 1, now), true);
    Object.assign(chat.info, { last_message_id: id + 1, updated_at: now, turn: true });
    delete chat.info.archived_at;
    this.bump(chat);
    this.updated(chat);
    const turnId = crypto.randomUUID();
    void this.run(chat, id + 1, turnId, p.text, p.context, sentFiles);
    if (sentFiles.length > 0) {
      const files = this.files;
      setTimeout(() => files?.described(chat.info.chat_id, sentFiles), STEP_MS);
    }
    const result = { message_id: id, turn_id: turnId };
    this.sent.set(p.idempotency_key, result);
    return result;
  }

  private empty(chat: FakeChat, id: number, createdAt: number, through?: number): ChatMessage {
    const author = through === undefined ? "assistant" : "summary";
    return {
      id,
      author,
      created_at: createdAt,
      state: "streaming",
      rev: this.bump(chat),
      record: this.seal(chat, id, author, ""),
      seq: 0,
      ...(through === undefined ? {} : { through }),
    };
  }

  /** The chat's current summary: the complete one with the largest cut. */
  private resummarize(chat: FakeChat): void {
    let best: ChatMessage | undefined;
    for (const m of chat.messages.values()) {
      if (m.author !== "summary" || m.state !== "complete" || m.deleted_at !== undefined) continue;
      if (!best || (m.through ?? 0) > (best.through ?? 0) || (m.through === best.through && m.id > best.id)) best = m;
    }
    if (best) chat.info.summary_id = best.id;
    else delete chat.info.summary_id;
  }

  private async compact(p: Requests["chat.compact"]["request"]) {
    const chat = this.chat(p.chat_id);
    if (chat.info.turn) throw new Refused("turn.busy");
    const id = chat.messages.size;
    if (p.through >= id) throw new Refused("protocol.malformed");
    const now = Date.now();
    this.put(chat, this.empty(chat, id, now, p.through), true);
    Object.assign(chat.info, { last_message_id: id, updated_at: now, turn: true });
    this.bump(chat);
    this.updated(chat);
    const turnId = crypto.randomUUID();
    this.compactions.push({ chat_id: p.chat_id, through: p.through, context: p.context });
    void this.run(chat, id, turnId, "", p.context);
    return { message_id: id, turn_id: turnId };
  }

  private async run(
    chat: FakeChat,
    replyId: number,
    turnId: string,
    text: string,
    context: TurnContext,
    files: SentFile[] = [],
  ) {
    const through = chat.messages.get(replyId)?.through;
    if (through === undefined) {
      this.turns.push({ chat_id: chat.info.chat_id, text, context, ...(files.length > 0 ? { files } : {}) });
    }
    const reply =
      this.replies.shift() ??
      (through === undefined
        ? { parts: ["You said: ", text] }
        : { parts: [`<title>Summed up ${through + 1}</title>\n`, `Summary of ${through + 1} messages`] });
    const tools: ToolUse[] = [];
    let cancelled = false;
    if (reply.ask) {
      const { outcome, result } = await this.ask(chat, turnId, reply.ask, reply.reason ?? "To answer your question");
      const grant = reply.ask;
      if (grant.tool === "read_register") {
        tools.push({
          tool: grant.tool,
          metric: grant.metric,
          ...(grant.from ? { from: grant.from } : {}),
          ...(grant.to ? { to: grant.to } : {}),
          outcome,
        });
      } else if (grant.tool === "read_history") {
        const read = result === undefined ? grant.count : JSON.parse(result).messages.length;
        tools.push({ tool: grant.tool, count: read, outcome });
      } else {
        tools.push({ tool: grant.tool, outcome });
      }
      cancelled = outcome === "cancelled";
    }
    chat.cancel = () => {
      cancelled = true;
    };
    let so = "";
    let seq = 0;
    const parts = [...(reply.parts ?? [])];
    while (!cancelled && (parts.length > 0 || reply.hold)) {
      await sleep(STEP_MS);
      const part = parts.shift() ?? (reply.hold ? "." : "");
      if (cancelled || part === "") continue;
      so += part;
      seq += 1;
      this.broadcast("message.delta", { chat_id: chat.info.chat_id, message_id: replyId, seq, text: part });
    }
    await sleep(STEP_MS);
    delete chat.cancel;
    if (!this.chats.has(chat.info.chat_id)) return;
    const previous = chat.messages.get(replyId);
    const state = cancelled ? "cancelled" : reply.error ? "failed" : "complete";
    const author = through === undefined ? "assistant" : "summary";
    const message: ChatMessage = {
      id: replyId,
      author,
      created_at: previous?.created_at ?? Date.now(),
      state,
      rev: this.bump(chat),
      record: this.seal(chat, replyId, author, so, author === "summary" ? so.replace(/^<title>.*\n/, "") : so, tools),
      seq,
      ...(reply.error && !cancelled ? { error: reply.error } : {}),
      ...(through === undefined ? {} : { through }),
    };
    this.put(chat, message, false);
    chat.info.turn = false;
    this.resummarize(chat);
    this.bump(chat);
    this.updated(chat);
    const chatId = chat.info.chat_id;
    if (reply.error && !cancelled)
      this.broadcast("turn.error", { chat_id: chatId, turn_id: turnId, code: reply.error });
    else this.broadcast("turn.done", { chat_id: chatId, turn_id: turnId });
  }

  private async retry(p: Requests["turn.retry"]["request"]) {
    const chat = this.chat(p.chat_id);
    if (chat.info.turn) throw new Refused("turn.busy");
    const reply = chat.messages.get(p.message_id);
    const retryable =
      (reply?.author === "assistant" || reply?.author === "summary") &&
      reply.state === "failed" &&
      reply.deleted_at === undefined;
    if (p.message_id !== chat.info.last_message_id || !retryable) {
      throw new Refused("message.not_retryable");
    }
    this.put(chat, this.empty(chat, p.message_id, reply.created_at, reply.through), false);
    chat.info.turn = true;
    this.bump(chat);
    this.updated(chat);
    const turnId = crypto.randomUUID();
    if (reply.through !== undefined)
      this.compactions.push({ chat_id: p.chat_id, through: reply.through, context: p.context });
    void this.run(chat, p.message_id, turnId, p.text, p.context);
    return { turn_id: turnId };
  }

  private chunks(p: Requests["message.chunks"]["request"]) {
    const chat = this.chat(p.chat_id);
    return {
      chat_id: p.chat_id,
      chunks: p.chunks.map(({ chunk, rev }) => {
        const messages = [...chat.messages.values()].filter((m) => m.id >> 6 === chunk).sort((a, b) => a.id - b.id);
        return {
          chunk,
          rev: Math.max(0, ...messages.map((m) => m.rev)),
          messages: messages.filter((m) => rev === undefined || m.rev > rev),
        };
      }),
    };
  }

  private edit(p: Requests["message.edit"]["request"]) {
    const chat = this.chat(p.chat_id);
    const message = chat.messages.get(p.message_id);
    if (!message || message.deleted_at !== undefined) throw new Refused("message.not_found");
    if (message.author !== "user") throw new Refused("message.not_editable");
    this.uncover(chat, p.message_id);
    const rev = this.bump(chat);
    this.put(chat, { ...message, record: p.record, rev, edited_at: Date.now() }, false);
    this.resummarize(chat);
    this.updated(chat);
    return { rev };
  }

  private deleteMessage(p: Requests["message.delete"]["request"]) {
    const chat = this.chat(p.chat_id);
    const message = chat.messages.get(p.message_id);
    if (!message) throw new Refused("message.not_found");
    if (message.deleted_at !== undefined) return { rev: message.rev };
    if (message.state === "streaming" && chat.info.turn) throw new Refused("message.streaming");
    if (message.author !== "summary") this.uncover(chat, p.message_id);
    const rev = this.tombstone(chat, message);
    this.resummarize(chat);
    this.updated(chat);
    return { rev };
  }

  private tombstone(chat: FakeChat, message: ChatMessage): number {
    this.saved.delete(`${chat.info.chat_id}/${message.id}`);
    const rev = this.bump(chat);
    const { id, author, created_at, state, through } = message;
    chat.messages.set(id, {
      id,
      author,
      created_at,
      state,
      rev,
      deleted_at: Date.now(),
      ...(through === undefined ? {} : { through }),
    });
    this.broadcast("message.deleted", { chat_id: chat.info.chat_id, message_id: id, rev });
    return rev;
  }

  private save(p: Requests["saved.add"]["request"]) {
    const message = this.chat(p.chat_id).messages.get(p.message_id);
    if (!message || message.deleted_at !== undefined) throw new Refused("message.not_found");
    const key = `${p.chat_id}/${p.message_id}`;
    const known = this.saved.get(key);
    if (known) return { saved_at: known.saved_at };
    // Distinct times, so the order is the order of saving.
    const last = Math.max(0, ...[...this.saved.values()].map((s) => s.saved_at));
    const saved = { ...p, saved_at: Math.max(Date.now(), last + 1) };
    this.saved.set(key, saved);
    this.broadcast("saved.updated", saved);
    return { saved_at: saved.saved_at };
  }

  private unsave(p: Requests["saved.remove"]["request"]) {
    this.chat(p.chat_id);
    if (this.saved.delete(`${p.chat_id}/${p.message_id}`)) this.broadcast("saved.updated", p);
    return {};
  }

  private savedList(p: Requests["saved.list"]["request"]) {
    const before = p.before;
    const all = [...this.saved.values()]
      .sort((a, b) => b.saved_at - a.saved_at)
      .filter((s) => !before || s.saved_at < before.saved_at);
    const page = all.slice(0, 32);
    const items = page.map((s) => {
      const chat = this.chat(s.chat_id);
      return { saved_at: s.saved_at, chat: chat.info, message: chat.messages.get(s.message_id) };
    });
    const last = page.at(-1);
    return all.length > page.length && last ? { items, next: last } : { items };
  }

  /** Deletes the summaries covering a message about to change. */
  private uncover(chat: FakeChat, id: number): void {
    for (const m of [...chat.messages.values()]) {
      if (m.author !== "summary" || m.deleted_at !== undefined || (m.through ?? -1) < id) continue;
      if (m.state === "streaming" && chat.info.turn) throw new Refused("turn.busy");
      this.tombstone(chat, m);
    }
  }
}
