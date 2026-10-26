import { afterEach, describe, expect, it, vi } from "vitest";
import type { NoteInfo } from "../protocol/generated/protocol";
import { TransportError } from "../transport/socket";
import { NoteDraft } from "./draft";
import { Notebook, type NoteKeys, type Request } from "./notebook";
import { decodeBody, decodeTitle, encodeBody, encodeTitle } from "./records";

/** "Sealing" is a version byte, a marker and the plaintext; the fake opens only its own records. */
const keys: NoteKeys = {
  createNotes: async () => ({ publicKey: new Uint8Array(32), wrappedPrivateKey: new Uint8Array(8) }),
  sealNote: async (_scope, _kind, plaintext) => new Uint8Array([1, 0xaa, ...plaintext]),
  openNote: async (_scope, _kind, record) => {
    if (record[1] !== 0xaa) throw new Error("decryption failed");
    return record.slice(2);
  },
};
const sealed = (plaintext: Uint8Array) => new Uint8Array([1, 0xaa, ...plaintext]);
const SCOPE = "00000000-0000-7000-8000-00000000000a";
const NOTE = "00000000-0000-7000-8000-000000000001";
const doc = (text: string) => ({ v: 1, blocks: [{ t: "p", s: [text] }] });

function info(rev: number, title = "Plan", id = NOTE): NoteInfo {
  return { note_id: id, title: sealed(encodeTitle(title, "")), created_at: 1, updated_at: rev, rev };
}

/** A fake server holding one account's notes. */
function server(options: { scope?: string; conflict?: boolean } = {}) {
  let scope = options.scope;
  const notes = new Map<string, { info: NoteInfo; body: Uint8Array }>();
  const calls: string[] = [];
  const request = vi.fn(async (type: string, p: Record<string, unknown>) => {
    calls.push(type);
    switch (type) {
      case "note.list":
        return { scope_id: scope, notes: [...notes.values()].map((n) => n.info) };
      case "notes.setup":
        scope ??= p["scope_id"] as string;
        return { scope_id: scope };
      case "note.get": {
        const note = notes.get(p["note_id"] as string);
        if (!note) throw new TransportError("note.not_found", "not found");
        return { note: note.info, body: note.body };
      }
      case "note.create": {
        const id = p["note_id"] as string;
        const note = { note_id: id, title: p["title"] as Uint8Array, created_at: 5, updated_at: 5, rev: 1 };
        notes.set(id, { info: note, body: p["body"] as Uint8Array });
        return { note };
      }
      case "note.update": {
        const id = p["note_id"] as string;
        const known = notes.get(id);
        if (!known) throw new TransportError("note.not_found", "not found");
        if (options.conflict || known.info.rev !== p["rev"]) throw new TransportError("note.conflict", "conflict");
        const note = { ...known.info, title: p["title"] as Uint8Array, rev: known.info.rev + 1, updated_at: 9 };
        notes.set(id, { info: note, body: p["body"] as Uint8Array });
        return { note };
      }
      default:
        throw new Error(type);
    }
  });
  return { request: request as unknown as Request, notes, calls };
}

const content = (title: string, text: string) => ({ title, excerpt: text, doc: doc(text) });

afterEach(() => {
  vi.useRealTimers();
});

describe("note records", () => {
  it("keep fields they do not know and cut what is too long", () => {
    const title = decodeTitle(encodeTitle("x".repeat(600), "start", { color: "blue" }));
    expect(title).toMatchObject({ ok: true, excerpt: "start", raw: { color: "blue" } });
    expect(title.ok && new TextEncoder().encode(title.title).length).toBe(512);
    expect(decodeBody(encodeBody(doc("hi"), { pinned: true }))).toMatchObject({ ok: true, raw: { pinned: true } });
    expect(decodeBody(new Uint8Array([0xc0]))).toEqual({ ok: false, reason: "parse" });
  });
});

describe("Notebook", () => {
  it("sets up the notes scope on the first save, then lists, opens and updates", async () => {
    const s = server();
    const book = new Notebook(s.request, keys);
    await book.load();
    expect(book.list).toEqual([]);
    const created = await book.create(content("Plan", "Buy milk"));
    expect(s.calls).toEqual(["note.list", "notes.setup", "note.create"]);
    await vi.waitFor(() => expect(book.get(created.note_id)?.title).toMatchObject({ kind: "text", title: "Plan" }));

    const opened = await book.open(created.note_id);
    expect(opened.body).toMatchObject({ ok: true, doc: doc("Buy milk") });
    const updated = await book.update(created.note_id, 1, content("Plan", "Buy bread"));
    expect(updated.rev).toBe(2);
    expect(book.list.map((e) => e.info.rev)).toEqual([2]);
  });

  it("takes the scope another device set up first", async () => {
    const s = server({ scope: SCOPE });
    const book = new Notebook(s.request, keys);
    await book.load();
    await book.create(content("A", "a"));
    expect(s.calls).toEqual(["note.list", "note.create"]);
  });

  it("follows events: a newer revision replaces, an older one does not, a deletion removes", async () => {
    const book = new Notebook(server({ scope: SCOPE }).request, keys);
    await book.load();
    book.put(info(2, "New"));
    book.put(info(1, "Old"));
    await vi.waitFor(() => expect(book.get(NOTE)?.title).toMatchObject({ title: "New" }));
    book.remove(NOTE);
    expect(book.list).toEqual([]);
  });
});

describe("NoteDraft", () => {
  it("saves once a moment after a burst of changes, and creates nothing for an empty note", async () => {
    vi.useFakeTimers();
    const s = server({ scope: SCOPE });
    const book = new Notebook(s.request, keys);
    await book.load();
    const created = vi.fn();
    const draft = new NoteDraft(book, null, { delay: 1000, copyTitle: (t) => `${t} (copy)`, onCreated: created });
    draft.change(() => content("", ""));
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.calls).toEqual(["note.list"]);

    const read = vi.fn(() => content("Plan", "Buy"));
    draft.change(read);
    draft.change(read);
    expect(draft.status).toBe("pending");
    await vi.advanceTimersByTimeAsync(999);
    expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(draft.status).toBe("saved"));
    expect(read).toHaveBeenCalledTimes(1);
    expect(created).toHaveBeenCalledOnce();
    expect(s.calls).toEqual(["note.list", "note.create"]);

    draft.change(() => content("Plan", "Buy milk"));
    await draft.flush();
    expect(s.calls.at(-1)).toBe("note.update");
    expect(draft.info?.rev).toBe(2);
  });

  it("saves its version as a copy when the note changed elsewhere", async () => {
    const s = server({ scope: SCOPE, conflict: true });
    const book = new Notebook(s.request, keys);
    await book.load();
    const first = await book.create(content("Plan", "mine"));
    const copied = vi.fn();
    const draft = new NoteDraft(book, first, { copyTitle: (t) => `${t} (26.10.2026, 21:00)`, onCopied: copied });
    draft.change(() => content("Plan", "mine, edited"));
    await draft.flush();
    expect(copied).toHaveBeenCalledOnce();
    expect(draft.info?.note_id).not.toBe(first.note_id);
    await vi.waitFor(() =>
      expect(book.list.map((e) => (e.title.kind === "text" ? e.title.title : ""))).toContain(
        "Plan (26.10.2026, 21:00)",
      ),
    );
    expect(s.notes.size).toBe(2);
  });

  it("shows another device's version only when nothing is unsaved", async () => {
    const book = new Notebook(server({ scope: SCOPE }).request, keys);
    const draft = new NoteDraft(book, info(1), { copyTitle: (t) => t });
    expect(draft.newer(info(1))).toBe(false);
    expect(draft.newer(info(2))).toBe(true);
    draft.change(() => content("Plan", "x"));
    expect(draft.newer(info(3))).toBe(false);
  });

  it("does not send a body too large for its record", async () => {
    const s = server({ scope: SCOPE });
    const book = new Notebook(s.request, keys);
    await book.load();
    const draft = new NoteDraft(book, null, { copyTitle: (t) => t });
    draft.change(() => content("Big", "x".repeat(300 * 1024)));
    await draft.flush();
    expect(draft.status).toBe("tooLarge");
    expect(draft.dirty).toBe(true);
    expect(s.calls).toEqual(["note.list"]);
  });
});
