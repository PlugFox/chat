/**
 * The notebook screen (`/notes`, `/notes/new`, `/notes/:id`): the notes
 * beside the open one on large screens, one of them on smaller ones. The
 * editor of a new note keeps going when its first save gives it an address.
 */
import { useParams } from "@solidjs/router";
import { createMemo, type JSX, Show } from "solid-js";
import { ChatLayout, EmptyState } from "../../design-system/components";
import { useI18n } from "../../i18n/i18n";
import { NoteListPane } from "./NoteListPane";
import { type NoteSession, NoteView } from "./NoteView";
import { createNotebook } from "./notebook";

export default function NotesPage(): JSX.Element {
  const { t } = useI18n();
  const params = useParams<{ id?: string }>();
  const notebook = createNotebook();
  // The same session while the address moves to the id its view gave the note.
  const session = createMemo<NoteSession | undefined>((prev) => {
    const id = params.id;
    if (!id) return undefined;
    if (prev && (prev.param === id || prev.adopted === id)) return prev;
    return { param: id, adopted: null };
  });
  return (
    <ChatLayout
      title={t("notes.title")}
      showing={params.id ? "detail" : "list"}
      list={<NoteListPane notebook={notebook} current={session()?.adopted ?? params.id} />}
      detail={
        <Show
          when={notebook.book() && session()}
          keyed
          fallback={<EmptyState icon="description">{t("notes.pick")}</EmptyState>}
        >
          {(s) => <NoteView session={s} notebook={notebook} />}
        </Show>
      }
    />
  );
}
