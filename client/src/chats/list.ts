/**
 * The chat list (docs/protocol.md, "Chats and messages"): pages of
 * `chat.list`, kept current by `chat.updated` and `chat.deleted`, titles
 * opened in the worker. Pinned chats come whole on the first page; the
 * archive is paged on its own. Framework-free so it can be tested without a
 * DOM.
 */

import type { ChatCursor, ChatInfo, ChatPage, Requests } from "../protocol/generated/protocol";
import { type RequestOptions, type RequestType, TransportError } from "../transport/socket";
import { equalBytes } from "../vault/bytes";
import type { ChatKind, Opened } from "../vault/keys";
import { decodeTitle, encodeTitle, precheck, type Unreadable } from "./records";

export type Request = <T extends RequestType>(
  type: T,
  payload: Requests[T]["request"],
  options?: RequestOptions<T>,
) => Promise<Requests[T]["response"]>;

/** What the chat store needs of the keys (`KeyVault`). */
export interface ChatKeys {
  createChat(chatId: string): Promise<{ publicKey: Uint8Array; wrappedPrivateKey: Uint8Array }>;
  sealChat(chatId: string, kind: ChatKind, plaintext: Uint8Array): Promise<Uint8Array>;
  openChat(chatId: string, kind: ChatKind, record: Uint8Array): Promise<Opened>;
}

export type Title =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "text"; text: string }
  | { kind: "unreadable"; reason: Unreadable };

export interface ChatEntry {
  info: ChatInfo;
  title: Title;
}

export type ListState = { kind: "loading" } | { kind: "failed" } | { kind: "ready" };

const resend = { retry: "resend" } as const;
const TITLE: ChatKind = { kind: "chat.title" };

/** Newest first, as `chat.list` pages them. */
function byRecent(a: ChatEntry, b: ChatEntry): number {
  return b.info.updated_at - a.info.updated_at || (b.info.chat_id < a.info.chat_id ? -1 : 1);
}

interface Pages {
  /** The cursor of the next page; `null` once the last one is in. */
  next: ChatCursor | null;
  loaded: boolean;
}

export class ChatList {
  private readonly entries = new Map<string, ChatEntry>();
  private readonly listeners = new Set<() => void>();
  private status: ListState = { kind: "loading" };
  private readonly recentPages: Pages = { next: null, loaded: false };
  private readonly archivePages: Pages = { next: null, loaded: false };
  /** Bumped by every reload, so a page of an older load is dropped. */
  private generation = 0;

  constructor(
    private readonly request: Request,
    private readonly keys: ChatKeys,
  ) {}

  get state(): ListState {
    return this.status;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  get(chatId: string): ChatEntry | undefined {
    return this.entries.get(chatId);
  }

  /** Pinned chats in their order. */
  get pinned(): ChatEntry[] {
    return [...this.entries.values()]
      .filter((e) => e.info.pin !== undefined)
      .sort((a, b) => (a.info.pin ?? 0) - (b.info.pin ?? 0));
  }

  /** The other chats outside the archive, newest first. */
  get recent(): ChatEntry[] {
    return [...this.entries.values()]
      .filter((e) => e.info.pin === undefined && e.info.archived_at === undefined)
      .sort(byRecent);
  }

  get archived(): ChatEntry[] {
    return [...this.entries.values()].filter((e) => e.info.archived_at !== undefined).sort(byRecent);
  }

  /** Whether a list's first page came in (a chat may be known from an event before). */
  loaded(archived: boolean): boolean {
    return (archived ? this.archivePages : this.recentPages).loaded;
  }

  /** Whether a list has pages left to load. */
  hasMore(archived: boolean): boolean {
    const pages = archived ? this.archivePages : this.recentPages;
    return !pages.loaded || pages.next !== null;
  }

  /**
   * Starts over from the first page (after a connect or `sync.reset`): what
   * changed while this client was away, deletions included, only shows in a
   * fresh load.
   */
  async load(): Promise<void> {
    this.generation += 1;
    const archive = this.archivePages.loaded;
    this.entries.clear();
    Object.assign(this.recentPages, { next: null, loaded: false });
    Object.assign(this.archivePages, { next: null, loaded: false });
    this.status = { kind: "loading" };
    this.changed();
    try {
      await this.more(false);
      if (archive) await this.more(true);
      this.status = { kind: "ready" };
    } catch {
      this.status = { kind: "failed" };
    }
    this.changed();
  }

  /** The next page of a list. */
  async more(archived: boolean): Promise<void> {
    const pages = archived ? this.archivePages : this.recentPages;
    if (pages.loaded && pages.next === null) return;
    const generation = this.generation;
    const payload = {
      ...(archived ? { archived: true } : {}),
      ...(pages.next ? { before: pages.next } : {}),
    };
    const page: ChatPage = await this.request("chat.list", payload, resend);
    if (generation !== this.generation) return;
    pages.next = page.next ?? null;
    pages.loaded = true;
    for (const info of page.chats) this.put(info);
    this.changed();
  }

  /** Every page of a list, for searching titles (they are encrypted, D-079). */
  async all(archived: boolean): Promise<void> {
    while (this.hasMore(archived)) await this.more(archived);
  }

  /** A chat as the server sent it; of two copies the higher `rev` wins. */
  put(info: ChatInfo): void {
    const known = this.entries.get(info.chat_id);
    if (known && known.info.rev >= info.rev) return;
    const sameTitle = known && equal(known.info.title, info.title);
    const entry: ChatEntry = {
      info,
      title: sameTitle ? known.title : info.title ? { kind: "loading" } : { kind: "none" },
    };
    this.entries.set(info.chat_id, entry);
    if (!sameTitle && info.title) void this.openTitle(info.chat_id, info.title);
    this.changed();
  }

  remove(chatId: string): void {
    if (this.entries.delete(chatId)) this.changed();
  }

  private async openTitle(chatId: string, record: Uint8Array): Promise<void> {
    let title: Title;
    const early = precheck(record);
    if (early) {
      title = { kind: "unreadable", reason: early };
    } else {
      try {
        const read = decodeTitle((await this.keys.openChat(chatId, TITLE, record)).plaintext);
        title = read.ok ? { kind: "text", text: read.text } : { kind: "unreadable", reason: read.reason };
      } catch {
        title = { kind: "unreadable", reason: "decrypt" };
      }
    }
    const entry = this.entries.get(chatId);
    // A newer title may have arrived while this one was opening.
    if (!entry || !equal(entry.info.title, record)) return;
    // A new object, so views keyed by entry see the change.
    this.entries.set(chatId, { ...entry, title });
    this.changed();
  }

  async rename(chatId: string, title: string): Promise<void> {
    const record = await this.keys.sealChat(chatId, TITLE, encodeTitle(title));
    await this.request("chat.rename", { chat_id: chatId, title: record }, resend);
  }

  /** Pins at `position` (moving a pinned chat is the same), or unpins without one (D-080). */
  async pin(chatId: string, position?: number): Promise<void> {
    await this.request(
      "chat.pin",
      position === undefined ? { chat_id: chatId } : { chat_id: chatId, position },
      resend,
    );
  }

  async archive(chatId: string, archived: boolean): Promise<void> {
    await this.request("chat.archive", { chat_id: chatId, archived }, resend);
  }

  /** Deletes an archived chat and everything in it (D-081). */
  async delete(chatId: string): Promise<void> {
    try {
      await this.request("chat.delete", { chat_id: chatId }, resend);
    } catch (e) {
      // A copy resent after a reconnect finds the chat already gone.
      if (!(e instanceof TransportError && e.code === "chat.not_found")) throw e;
    }
  }
}

function equal(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  return a && b ? equalBytes(a, b) : a === b;
}
