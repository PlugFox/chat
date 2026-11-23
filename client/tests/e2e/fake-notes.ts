/**
 * The notebook as the test build sees it (docs/protocol.md, "Notes"),
 * answered from memory for `FakeKeys`. Records are stored as the client
 * sealed them; `conflictNext` makes the next update fail as if another
 * device had changed the note first.
 */
import type { NoteInfo, Requests, ScopeKey } from "../../src/protocol/generated/protocol";
import { Refused } from "./fake-chats";

interface FakeNote {
  info: NoteInfo;
  body: Uint8Array;
}

const same = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

export class FakeNotes {
  scopeId: string | undefined;
  readonly notes = new Map<string, FakeNote>();
  conflictNext = false;
  private clock = Date.now();

  constructor(
    private readonly keys: { scopeKeys: ScopeKey[] },
    private readonly broadcast: (type: string, payload: unknown) => void,
  ) {}

  private now(): number {
    this.clock = Math.max(this.clock + 1, Date.now());
    return this.clock;
  }

  handle(type: string, payload: unknown): Promise<unknown> | undefined {
    switch (type) {
      case "notes.setup": {
        const p = payload as Requests["notes.setup"]["request"];
        if (!this.scopeId) {
          this.scopeId = p.scope_id;
          this.keys.scopeKeys.push({
            scope_id: p.scope_id,
            key_version: 1,
            public_key: p.public_key,
            wrapped_private_key: p.wrapped_private_key,
          });
        }
        return Promise.resolve({ scope_id: this.scopeId });
      }
      case "note.list": {
        const notes = [...this.notes.values()]
          .map((n) => n.info)
          .sort((a, b) => b.updated_at - a.updated_at || (b.note_id < a.note_id ? -1 : 1));
        return Promise.resolve({ ...(this.scopeId ? { scope_id: this.scopeId } : {}), notes });
      }
      case "note.get": {
        const note = this.notes.get((payload as Requests["note.get"]["request"]).note_id);
        if (!note) return Promise.reject(new Refused("note.not_found"));
        return Promise.resolve({ note: note.info, body: note.body });
      }
      case "note.create": {
        const p = payload as Requests["note.create"]["request"];
        if (!this.scopeId) return Promise.reject(new Refused("notes.not_set_up"));
        const known = this.notes.get(p.note_id);
        if (known) {
          if (same(known.info.title, p.title) && same(known.body, p.body)) return Promise.resolve({ note: known.info });
          return Promise.reject(new Refused("note.exists"));
        }
        const at = this.now();
        const info = { note_id: p.note_id, title: p.title, created_at: at, updated_at: at, rev: 1 };
        this.notes.set(p.note_id, { info, body: p.body });
        this.broadcast("note.updated", { note: info });
        return Promise.resolve({ note: info });
      }
      case "note.update": {
        const p = payload as Requests["note.update"]["request"];
        const known = this.notes.get(p.note_id);
        if (!known) return Promise.reject(new Refused("note.not_found"));
        if (same(known.info.title, p.title) && same(known.body, p.body)) return Promise.resolve({ note: known.info });
        if (this.conflictNext || known.info.rev !== p.rev) {
          this.conflictNext = false;
          return Promise.reject(new Refused("note.conflict"));
        }
        const info = { ...known.info, title: p.title, rev: known.info.rev + 1, updated_at: this.now() };
        this.notes.set(p.note_id, { info, body: p.body });
        this.broadcast("note.updated", { note: info });
        return Promise.resolve({ note: info });
      }
      case "note.delete": {
        const { note_id } = payload as Requests["note.delete"]["request"];
        if (this.notes.delete(note_id)) this.broadcast("note.deleted", { note_id });
        return Promise.resolve({});
      }
      default:
        return undefined;
    }
  }
}
