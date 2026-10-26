/**
 * Chats as the test build sees them (docs/protocol.md, "Chats and
 * messages"), answered from memory for `FakeKeys`. Messages are sealed as the
 * server seals them, with chat-crypto's own `sealAsServer`, to the chat key
 * the client created, so the client opens them with its real worker. A turn
 * replies with the next of `replies` (by default it echoes), streaming its
 * parts as deltas; `hold` keeps it running until cancelled. A compaction is
 * a turn too, writing a summary message.
 */
import { encode } from "@msgpack/msgpack";
import { sealAsServer } from "../../src/crypto/wasm/chat_crypto.js";
import type {
  ChatInfo,
  ChatMessage,
  Requests,
  ScopeKey,
  TurnContext,
  TurnErrorCode,
} from "../../src/protocol/generated/protocol";

export interface FakeReply {
  parts?: string[];
  error?: TurnErrorCode;
  /** Keep streaming until `turn.cancel`. */
  hold?: boolean;
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
  readonly turns: { chat_id: string; text: string; context: TurnContext }[] = [];
  /** What every compaction folded. */
  readonly compactions: { chat_id: string; through: number; context: TurnContext }[] = [];

  constructor(
    private readonly userId: string,
    private readonly keys: { scopeKeys: ScopeKey[] },
    private readonly broadcast: (type: string, payload: unknown) => void,
  ) {}

  /** The answer to a chat request, or `undefined` for any other type. */
  handle(type: string, payload: unknown): Promise<unknown> | undefined {
    switch (type) {
      case "chat.list":
        return Promise.resolve(this.list(payload as Requests["chat.list"]["request"]));
      case "chat.rename":
        return this.change(payload, (chat, p: Requests["chat.rename"]["request"]) => {
          chat.info.title = p.title;
        });
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
      default:
        return undefined;
    }
  }

  private chat(chatId: string): FakeChat {
    const chat = this.chats.get(chatId);
    if (!chat) throw new Refused("chat.not_found");
    return chat;
  }

  private bump(chat: FakeChat): number {
    chat.info.rev += 1;
    return chat.info.rev;
  }

  private updated(chat: FakeChat): void {
    this.broadcast("chat.updated", { chat: { ...chat.info } });
  }

  private seal(chat: FakeChat, id: number, author: "user" | "assistant" | "summary", text: string): Uint8Array {
    return sealAsServer(
      uuidBytes(this.userId),
      uuidBytes(chat.info.chat_id),
      1,
      chat.publicKey,
      { kind: "chat.message", messageId: id, author },
      encode({ text }),
    );
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
        record: this.seal(chat, id, "user", p.text),
      },
      true,
    );
    this.put(chat, this.empty(chat, id + 1, now), true);
    Object.assign(chat.info, { last_message_id: id + 1, updated_at: now, turn: true });
    delete chat.info.archived_at;
    this.bump(chat);
    this.updated(chat);
    const turnId = crypto.randomUUID();
    void this.run(chat, id + 1, turnId, p.text, p.context);
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

  private async run(chat: FakeChat, replyId: number, turnId: string, text: string, context: TurnContext) {
    const through = chat.messages.get(replyId)?.through;
    if (through === undefined) this.turns.push({ chat_id: chat.info.chat_id, text, context });
    const reply =
      this.replies.shift() ??
      (through === undefined ? { parts: ["You said: ", text] } : { parts: [`Summary of ${through + 1} messages`] });
    let cancelled = false;
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
      record: this.seal(chat, replyId, author, so),
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

  /** Deletes the summaries covering a message about to change. */
  private uncover(chat: FakeChat, id: number): void {
    for (const m of [...chat.messages.values()]) {
      if (m.author !== "summary" || m.deleted_at !== undefined || (m.through ?? -1) < id) continue;
      if (m.state === "streaming" && chat.info.turn) throw new Refused("turn.busy");
      this.tombstone(chat, m);
    }
  }
}
