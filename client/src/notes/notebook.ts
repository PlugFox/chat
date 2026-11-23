/**
 * The notebook (docs/protocol.md, "Notes"): pages of `note.list` with their
 * titles opened in the worker, kept current by `note.updated` and
 * `note.deleted`; a note's body opened on demand; saving with the notes
 * scope created first when the account has none. Framework-free so it can
 * be tested without a DOM.
 */

import type { Unreadable } from "../chats/records";
import type { NoteCursor, NoteInfo, Requests } from "../protocol/generated/protocol";
import type { RequestOptions, RequestType } from "../transport/socket";
import { uuidBytes } from "../vault/bytes";
import type { NoteKind } from "../vault/keys";
import {
  BODY_RECORD_MAX,
  decodeBody,
  decodeTitle,
  encodeBody,
  encodeTitle,
  type NoteBody,
  precheck,
  TITLE_RECORD_MAX,
} from "./records";

export type Request = <T extends RequestType>(
  type: T,
  payload: Requests[T]["request"],
  options?: RequestOptions<T>,
) => Promise<Requests[T]["response"]>;

/** What the notebook needs of the keys (`KeyVault`). */
export interface NoteKeys {
  createNotes(scopeId: string): Promise<{ publicKey: Uint8Array; wrappedPrivateKey: Uint8Array }>;
  sealNote(scopeId: string, kind: NoteKind, plaintext: Uint8Array): Promise<Uint8Array>;
  openNote(scopeId: string, kind: NoteKind, record: Uint8Array): Promise<Uint8Array>;
}

export type Title =
  | { kind: "loading" }
  | { kind: "text"; title: string; excerpt: string; raw: Record<string, unknown> }
  | { kind: "unreadable"; reason: Unreadable };

export interface NoteEntry {
  info: NoteInfo;
  title: Title;
}

export interface OpenedNote {
  entry: NoteEntry;
  body: NoteBody;
}

/** A note's content to store; `raw` keeps the fields of its records this client does not know. */
export interface NoteContent {
  title: string;
  excerpt: string;
  doc: unknown;
  titleRaw?: Record<string, unknown>;
  bodyRaw?: Record<string, unknown>;
}

export type NotebookState = { kind: "loading" } | { kind: "failed" } | { kind: "ready" };

/** A body too large for its record: saving it cannot succeed until it shrinks. */
export class TooLarge extends Error {}

const resend = { retry: "resend" } as const;

function newestFirst(a: NoteEntry, b: NoteEntry): number {
  return b.info.updated_at - a.info.updated_at || (b.info.note_id < a.info.note_id ? -1 : 1);
}

export class Notebook {
  private readonly entries = new Map<string, NoteEntry>();
  private readonly listeners = new Set<() => void>();
  private status: NotebookState = { kind: "loading" };
  private next: NoteCursor | null = null;
  private scopeId: string | null = null;
  private loading: Promise<void> | null = null;
  private settingUp: Promise<string> | null = null;
  /** Bumped by every reload, so a page of an older load is dropped. */
  private generation = 0;

  constructor(
    private readonly request: Request,
    private readonly keys: NoteKeys,
  ) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  get state(): NotebookState {
    return this.status;
  }

  /** The loaded notes, newest first. */
  get list(): NoteEntry[] {
    return [...this.entries.values()].sort(newestFirst);
  }

  get hasMore(): boolean {
    return this.next !== null;
  }

  get(noteId: string): NoteEntry | undefined {
    return this.entries.get(noteId);
  }

  /** The first page, starting over (a connect, `sync.reset`). */
  load(): Promise<void> {
    this.generation += 1;
    const generation = this.generation;
    this.status = { kind: "loading" };
    this.changed();
    const loading = this.page(undefined, generation).then(
      () => {
        if (generation !== this.generation) return;
        this.status = { kind: "ready" };
        this.changed();
      },
      (e: unknown) => {
        if (generation !== this.generation) return;
        this.status = { kind: "failed" };
        this.changed();
        throw e;
      },
    );
    this.loading = loading.catch(() => undefined);
    return loading;
  }

  async more(): Promise<void> {
    if (this.next === null) return;
    await this.page(this.next, this.generation);
    this.changed();
  }

  /** Every page: titles are encrypted, so a search reads them all. */
  async all(): Promise<void> {
    while (this.next !== null) await this.more();
  }

  private async page(before: NoteCursor | undefined, generation: number): Promise<void> {
    const page = await this.request("note.list", before ? { before } : {}, resend);
    if (generation !== this.generation) return;
    if (before === undefined) {
      this.entries.clear();
      this.scopeId = page.scope_id ?? null;
    }
    for (const info of page.notes) this.put(info);
    this.next = page.next ?? null;
  }

  /** The notes scope, created when the account has none. */
  private async scope(): Promise<string> {
    if (this.scopeId === null && this.loading) await this.loading;
    if (this.scopeId !== null) return this.scopeId;
    this.settingUp ??= (async () => {
      const mine = crypto.randomUUID();
      const keys = await this.keys.createNotes(mine);
      const { scope_id } = await this.request(
        "notes.setup",
        { scope_id: mine, public_key: keys.publicKey, wrapped_private_key: keys.wrappedPrivateKey },
        resend,
      );
      // Another device may have been first: its scope is the notebook.
      this.scopeId = scope_id;
      return scope_id;
    })().finally(() => {
      this.settingUp = null;
    });
    return this.settingUp;
  }

  /** `note.updated`, or a stored note: a newer revision replaces the entry. */
  put(info: NoteInfo): NoteEntry {
    const known = this.entries.get(info.note_id);
    if (known && known.info.rev >= info.rev) return known;
    const entry: NoteEntry = { info, title: { kind: "loading" } };
    this.entries.set(info.note_id, entry);
    void this.openTitle(entry);
    this.changed();
    return entry;
  }

  /** `note.deleted`. */
  remove(noteId: string): void {
    if (this.entries.delete(noteId)) this.changed();
  }

  /** Replaces the entry once its title is open: views render entries by identity. */
  private async openTitle(entry: NoteEntry): Promise<void> {
    const title = await this.readTitle(entry.info);
    if (this.entries.get(entry.info.note_id) !== entry) return;
    this.entries.set(entry.info.note_id, { info: entry.info, title });
    this.changed();
  }

  private async readTitle(info: NoteInfo): Promise<Title> {
    const early = precheck(info.title, TITLE_RECORD_MAX);
    if (early) return { kind: "unreadable", reason: early };
    try {
      const scopeId = await this.scope();
      const plaintext = await this.keys.openNote(
        scopeId,
        { kind: "note.title", noteId: uuidBytes(info.note_id) },
        info.title,
      );
      const read = decodeTitle(plaintext);
      return read.ok
        ? { kind: "text", title: read.title, excerpt: read.excerpt, raw: read.raw }
        : { kind: "unreadable", reason: read.reason };
    } catch {
      return { kind: "unreadable", reason: "decrypt" };
    }
  }

  /** A note with its body, as the server holds it now. */
  async open(noteId: string): Promise<OpenedNote> {
    const { note, body } = await this.request("note.get", { note_id: noteId }, resend);
    this.put(note);
    const opened: NoteEntry = { info: note, title: await this.readTitle(note) };
    const early = precheck(body, BODY_RECORD_MAX);
    if (early) return { entry: opened, body: { ok: false, reason: early } };
    try {
      const scopeId = await this.scope();
      const plaintext = await this.keys.openNote(scopeId, { kind: "note.body", noteId: uuidBytes(noteId) }, body);
      return { entry: opened, body: decodeBody(plaintext) };
    } catch {
      return { entry: opened, body: { ok: false, reason: "decrypt" } };
    }
  }

  private async seal(noteId: string, content: NoteContent): Promise<{ title: Uint8Array; body: Uint8Array }> {
    const scopeId = await this.scope();
    const id = uuidBytes(noteId);
    const body = await this.keys.sealNote(
      scopeId,
      { kind: "note.body", noteId: id },
      encodeBody(content.doc, content.bodyRaw),
    );
    if (body.length > BODY_RECORD_MAX) throw new TooLarge("note too large");
    const title = await this.keys.sealNote(
      scopeId,
      { kind: "note.title", noteId: id },
      encodeTitle(content.title, content.excerpt, content.titleRaw),
    );
    return { title, body };
  }

  /** Stores a new note under a fresh id; resolves to it as stored. */
  async create(content: NoteContent, noteId: string = crypto.randomUUID()): Promise<NoteInfo> {
    const records = await this.seal(noteId, content);
    const { note } = await this.request("note.create", { note_id: noteId, ...records }, resend);
    this.put(note);
    return note;
  }

  /** Replaces a note based on revision `rev`; a change made since fails with `note.conflict`. */
  async update(noteId: string, rev: number, content: NoteContent): Promise<NoteInfo> {
    const records = await this.seal(noteId, content);
    const { note } = await this.request("note.update", { note_id: noteId, rev, ...records }, resend);
    this.put(note);
    return note;
  }

  async delete(noteId: string): Promise<void> {
    await this.request("note.delete", { note_id: noteId }, resend);
    this.remove(noteId);
  }
}
