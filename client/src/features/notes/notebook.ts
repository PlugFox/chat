/**
 * The notebook of the notes page: one `Notebook` while the keys are
 * unlocked, loaded on every connect and `sync.reset`, kept current by the
 * note events.
 */
import { type Accessor, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { Notebook } from "../../notes/notebook";
import { useSocket } from "../../transport/context";
import { useVault } from "../../vault/context";

export interface NotebookContext {
  /** `null` while locked. */
  book: Accessor<Notebook | null>;
  /** Changes whenever the notebook does: read it to follow it. */
  version: Accessor<number>;
}

export function createNotebook(): NotebookContext {
  const { socket, state: connection, onEvent } = useSocket();
  const { vault, state: keys } = useVault();
  const [book, setBook] = createSignal<Notebook | null>(null);
  const [version, setVersion] = createSignal(0);
  const unlocked = createMemo(() => keys()?.kind === "unlocked");

  createEffect(
    on(
      () => [socket(), vault(), unlocked()] as const,
      ([s, v, open]) => {
        if (!s || !v || !open) {
          setBook(null);
          return;
        }
        const notes = new Notebook((type, payload, options) => s.request(type, payload, options), v);
        const unsubscribe = notes.subscribe(() => setVersion((n) => n + 1));
        const unlisten = onEvent((type, payload) => {
          switch (type) {
            case "note.updated":
              notes.put(payload.note);
              return;
            case "note.deleted":
              notes.remove(payload.note_id);
              return;
            case "sync.reset":
              void notes.load().catch(() => undefined);
              return;
          }
        });
        setBook(notes);
        onCleanup(() => {
          unlisten();
          unsubscribe();
        });
      },
    ),
  );

  // Every connect: events missed while away come with the first page.
  createEffect(
    on(
      () => [book(), connection()?.kind === "open"] as const,
      ([notes, open]) => {
        if (notes && open) void notes.load().catch(() => undefined);
      },
    ),
  );

  return { book, version };
}
