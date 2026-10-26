/**
 * The note being edited, saved a moment after typing stops (D-096). One save
 * runs at a time; a change during it is saved after. A note changed on
 * another device in the meantime (`note.conflict`) is never overwritten:
 * this version becomes a new note named with the date and time, and the
 * draft follows it. A new note is created by its first save that has
 * something in it. Framework-free so it can be tested without a DOM.
 */

import type { NoteInfo } from "../protocol/generated/protocol";
import { TransportError } from "../transport/socket";
import { type Notebook, type NoteContent, TooLarge } from "./notebook";

export type DraftStatus = "saved" | "pending" | "saving" | "failed" | "tooLarge";

export interface DraftOptions {
  /** How long after the last change a save starts. */
  delay?: number;
  /** The title of the copy a conflict leaves, from this version's title. */
  copyTitle: (title: string) => string;
  /** The draft became a copy under `title`: its id is new. */
  onCopied?: (info: NoteInfo, title: string) => void;
  /** A new note was created. */
  onCreated?: (info: NoteInfo) => void;
}

const DELAY = 1000;

function empty(content: NoteContent): boolean {
  return content.title.trim() === "" && content.excerpt === "";
}

export class NoteDraft {
  private readonly listeners = new Set<() => void>();
  private state: DraftStatus = "saved";
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** What to save; read when the save starts, so a burst of changes costs one. */
  private latest: (() => NoteContent) | null = null;
  private saving: Promise<void> | null = null;

  constructor(
    private readonly notebook: Notebook,
    private current: NoteInfo | null,
    private readonly options: DraftOptions,
  ) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(state: DraftStatus): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  get status(): DraftStatus {
    return this.state;
  }

  /** The note as last stored; `null` before a new note's first save. */
  get info(): NoteInfo | null {
    return this.current;
  }

  /** Whether there is something not stored yet. */
  get dirty(): boolean {
    return this.latest !== null || this.saving !== null;
  }

  change(content: () => NoteContent): void {
    this.latest = content;
    this.set("pending");
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.save(), this.options.delay ?? DELAY);
  }

  /** Saves now what is pending, and waits for it. */
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.save();
  }

  /** Stops saving (the view closes): what is pending is saved first. */
  close(): Promise<void> {
    return this.flush();
  }

  /** Another device's version arrived: whether to show it, which only a draft with nothing unsaved does. */
  newer(info: NoteInfo): boolean {
    if (!this.current || info.note_id !== this.current.note_id || info.rev <= this.current.rev) return false;
    if (this.dirty) return false;
    this.current = info;
    return true;
  }

  private async save(): Promise<void> {
    if (this.saving) {
      await this.saving;
      if (this.latest) await this.save();
      return;
    }
    const read = this.latest;
    if (!read) return;
    this.latest = null;
    const content = read();
    if (!this.current && empty(content)) {
      this.set("saved");
      return;
    }
    this.set("saving");
    this.saving = this.store(content).finally(() => {
      this.saving = null;
    });
    try {
      await this.saving;
      if (!this.latest) this.set("saved");
    } catch (e) {
      // Kept to be tried again with the next change or flush.
      this.latest ??= read;
      this.set(e instanceof TooLarge ? "tooLarge" : "failed");
    }
  }

  private async store(content: NoteContent): Promise<void> {
    const current = this.current;
    if (!current) {
      this.current = await this.notebook.create(content);
      this.options.onCreated?.(this.current);
      return;
    }
    try {
      this.current = await this.notebook.update(current.note_id, current.rev, content);
    } catch (e) {
      if (!(e instanceof TransportError && e.code === "note.conflict")) throw e;
      const title = this.options.copyTitle(content.title);
      this.current = await this.notebook.create({ ...content, title });
      this.options.onCopied?.(this.current, title);
    }
  }
}
