/**
 * Saved messages (docs/protocol.md, "Saved messages"): the pages of
 * `saved.list` with their messages and chat titles opened in the worker, and
 * the saved ids of each chat a view asked for. `saved.updated` keeps both
 * current; a message or chat deleted takes its references along without an
 * event of their own. Framework-free so it can be tested without a DOM.
 */

import type { ChatInfo, ChatMessage, SavedCursor, SavedItem, SavedUpdated } from "../protocol/generated/protocol";
import type { ChatKeys, Request, Title } from "./list";
import { decodeTitle, precheck } from "./records";
import { type Content, openMessage, shownContent } from "./thread";

export interface SavedEntry {
  savedAt: number;
  chat: ChatInfo;
  title: Title;
  message: ChatMessage;
  content: Content;
}

export type SavedState = { kind: "idle" } | { kind: "loading" } | { kind: "failed" } | { kind: "ready" };

const resend = { retry: "resend" } as const;

function key(chatId: string, messageId: number): string {
  return `${chatId}/${messageId}`;
}

function newestFirst(a: SavedEntry, b: SavedEntry): number {
  return (
    b.savedAt - a.savedAt ||
    (b.chat.chat_id < a.chat.chat_id ? -1 : b.chat.chat_id > a.chat.chat_id ? 1 : 0) ||
    b.message.id - a.message.id
  );
}

export class SavedMessages {
  private readonly listeners = new Set<() => void>();
  /** The saved ids of the chats asked for over this socket. */
  private readonly byChat = new Map<string, Set<number>>();
  private readonly asking = new Map<string, Promise<void>>();
  private readonly entries = new Map<string, SavedEntry>();
  private next: SavedCursor | null = null;
  private status: SavedState = { kind: "idle" };
  /** Bumped by every reload, so a page of an older load is dropped. */
  private generation = 0;

  constructor(
    private readonly request: Request,
    private readonly keys: ChatKeys,
  ) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  get state(): SavedState {
    return this.status;
  }

  /** The loaded saved messages, newest first. */
  get list(): SavedEntry[] {
    return [...this.entries.values()].sort(newestFirst);
  }

  get hasMore(): boolean {
    return this.next !== null;
  }

  /** Whether a message is saved; `undefined` until its chat's ids came in. */
  isSaved(chatId: string, messageId: number): boolean | undefined {
    return this.byChat.get(chatId)?.has(messageId);
  }

  /** Asks for a chat's saved ids once per socket. */
  ofChat(chatId: string): Promise<void> {
    if (this.byChat.has(chatId)) return Promise.resolve();
    let asking = this.asking.get(chatId);
    if (!asking) {
      asking = this.request("saved.chat", { chat_id: chatId }, resend)
        .then((r) => {
          this.byChat.set(chatId, new Set(r.message_ids));
          this.changed();
        })
        .finally(() => this.asking.delete(chatId));
      this.asking.set(chatId, asking);
    }
    return asking;
  }

  async save(chatId: string, messageId: number, saved: boolean): Promise<void> {
    if (saved) {
      await this.request("saved.add", { chat_id: chatId, message_id: messageId }, resend);
    } else {
      await this.request("saved.remove", { chat_id: chatId, message_id: messageId }, resend);
    }
    // The event follows; the answer already says it.
    this.byChat.get(chatId)?.[saved ? "add" : "delete"](messageId);
    if (!saved) this.entries.delete(key(chatId, messageId));
    this.changed();
  }

  /** The first page, starting over. */
  async load(): Promise<void> {
    this.generation += 1;
    this.entries.clear();
    this.next = null;
    this.status = { kind: "loading" };
    this.changed();
    try {
      await this.page(undefined);
      this.status = { kind: "ready" };
    } catch {
      this.status = { kind: "failed" };
    }
    this.changed();
  }

  async more(): Promise<void> {
    if (this.next === null) return;
    await this.page(this.next);
    this.changed();
  }

  private async page(before: SavedCursor | undefined): Promise<void> {
    const generation = this.generation;
    const items: SavedItem[] = [];
    const done = await this.request("saved.list", before ? { before } : {}, {
      ...resend,
      onPart: (part) => items.push(...part.items),
    });
    items.push(...done.items);
    if (generation !== this.generation) return;
    for (const item of items) this.put(item);
    this.next = done.next ?? null;
  }

  private put(item: SavedItem): void {
    const id = key(item.chat.chat_id, item.message.id);
    const entry: SavedEntry = {
      savedAt: item.saved_at,
      chat: item.chat,
      title: item.chat.title ? { kind: "loading" } : { kind: "none" },
      message: item.message,
      content: { kind: "loading" },
    };
    this.entries.set(id, entry);
    void this.openContent(id, entry);
    void this.openTitle(entry, item.chat);
  }

  private async openContent(id: string, entry: SavedEntry): Promise<void> {
    const { content } = await openMessage(this.keys, entry.chat.chat_id, entry.message);
    if (this.entries.get(id) !== entry) return;
    entry.content = shownContent(entry.message.author, content);
    this.changed();
  }

  private async openTitle(entry: SavedEntry, chat: ChatInfo): Promise<void> {
    const record = chat.title;
    if (!record) return;
    let title: Title;
    const early = precheck(record);
    if (early) {
      title = { kind: "unreadable", reason: early };
    } else {
      try {
        const read = decodeTitle((await this.keys.openChat(chat.chat_id, { kind: "chat.title" }, record)).plaintext);
        title = read.ok ? { kind: "text", text: read.text } : { kind: "unreadable", reason: read.reason };
      } catch {
        title = { kind: "unreadable", reason: "decrypt" };
      }
    }
    if (entry.chat !== chat) return;
    entry.title = title;
    this.changed();
  }

  /** `saved.updated`: a message saved or no longer saved, here or on another device. */
  updated(event: SavedUpdated): void {
    const saved = event.saved_at !== undefined;
    this.byChat.get(event.chat_id)?.[saved ? "add" : "delete"](event.message_id);
    const id = key(event.chat_id, event.message_id);
    if (!saved) {
      this.entries.delete(id);
    } else if (this.status.kind !== "idle" && !this.entries.has(id)) {
      // The new one comes first: the first page has it.
      void this.load();
    }
    this.changed();
  }

  /** `message.updated`: an edit shows in the saved copy too. */
  messageChanged(chatId: string, message: ChatMessage): void {
    const id = key(chatId, message.id);
    const known = this.entries.get(id);
    if (!known || known.message.rev >= message.rev || message.state === "streaming") return;
    const entry: SavedEntry = { ...known, message, content: { kind: "loading" } };
    this.entries.set(id, entry);
    void this.openContent(id, entry);
    this.changed();
  }

  /** `chat.updated`: a renamed chat shows its new title. */
  chatChanged(chat: ChatInfo): void {
    // In place: a message of the entry may be opening.
    for (const entry of this.entries.values()) {
      if (entry.chat.chat_id !== chat.chat_id || entry.chat.rev > chat.rev) continue;
      entry.chat = chat;
      if (!chat.title) entry.title = { kind: "none" };
      void this.openTitle(entry, chat);
    }
    this.changed();
  }

  /** `message.deleted`: a tombstone is saved no more. */
  messageDeleted(chatId: string, messageId: number): void {
    this.byChat.get(chatId)?.delete(messageId);
    this.entries.delete(key(chatId, messageId));
    this.changed();
  }

  chatDeleted(chatId: string): void {
    this.byChat.delete(chatId);
    for (const [id, entry] of this.entries) if (entry.chat.chat_id === chatId) this.entries.delete(id);
    this.changed();
  }

  /** After a connect or `sync.reset`: ids are trusted for one socket only. */
  reset(): void {
    const asked = [...this.byChat.keys()];
    this.byChat.clear();
    for (const chatId of asked) void this.ofChat(chatId).catch(() => undefined);
    if (this.status.kind !== "idle") void this.load();
    this.changed();
  }
}
