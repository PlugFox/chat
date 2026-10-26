/**
 * One note in the editor, saved as it is typed (D-096). A new note gets its
 * id from its first save, and a note changed on another device in the
 * meantime leaves this version as a copy; either way the address follows
 * without the editor starting over. Another device's version replaces what
 * is shown when nothing here is unsaved. A note no reader can show stays
 * read-only.
 */
import { useNavigate } from "@solidjs/router";
import { createEffect, createSignal, type JSX, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
import { useToasts } from "../../app/toasts";
import {
  Banner,
  Button,
  Dialog,
  IconButton,
  Pane,
  RichEditor,
  Stack,
  Text,
  TextField,
} from "../../design-system/components";
import { toDocument } from "../../document/preview";
import { useI18n } from "../../i18n/i18n";
import { NoteDraft } from "../../notes/draft";
import type { NoteContent, NoteEntry } from "../../notes/notebook";
import type { NoteInfo } from "../../protocol/generated/protocol";
import { requestError } from "../chats/errors";
import { useEditorLabels } from "./labels";
import { noteTitle } from "./NoteListPane";
import type { NotebookContext } from "./notebook";

/** A note being edited: `"new"` until its first save gives it an id. */
export interface NoteSession {
  param: string;
  /** The id this view gave the note (created, or a conflict's copy); the address follows it. */
  adopted: string | null;
}

type Loaded =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "ready"; doc: unknown; readable: boolean; entry: NoteEntry | null };

const EMPTY = { v: 1, blocks: [] };

export function NoteView(props: { session: NoteSession; notebook: NotebookContext }): JSX.Element {
  const { t, locale } = useI18n();
  const toasts = useToasts();
  const navigate = useNavigate();
  const session = props.session;
  const [loaded, setLoaded] = createSignal<Loaded>({ kind: "loading" });
  const [title, setTitle] = createSignal("");
  const [status, setStatus] = createSignal<NoteDraft["status"]>("saved");
  const [deleting, setDeleting] = createSignal(false);
  /** The note as last stored, `null` before a new one's first save. */
  const [info, setInfo] = createSignal<NoteInfo | null>(null);
  let draft: NoteDraft | null = null;
  /** The note's content as the editor last gave it. */
  let read: () => { doc: unknown; text: string } = () => ({ doc: EMPTY, text: "" });
  let titleRaw: Record<string, unknown> | undefined;
  let bodyRaw: Record<string, unknown> | undefined;

  const dateTime = () => new Intl.DateTimeFormat(locale(), { dateStyle: "short", timeStyle: "short" });
  const content = (): NoteContent => {
    const current = read();
    return {
      title: title(),
      excerpt: current.text,
      doc: current.doc,
      ...(titleRaw ? { titleRaw } : {}),
      ...(bodyRaw ? { bodyRaw } : {}),
    };
  };
  const follow = (info: NoteInfo) => {
    session.adopted = info.note_id;
    navigate(`/notes/${info.note_id}`, { replace: true });
  };

  const show = (doc: unknown, entry: NoteEntry, readable: boolean) => {
    titleRaw = entry.title.kind === "text" ? entry.title.raw : undefined;
    setTitle(entry.title.kind === "text" ? entry.title.title : "");
    read = () => ({ doc, text: entry.title.kind === "text" ? entry.title.excerpt : "" });
    setLoaded({ kind: "ready", doc, readable, entry });
  };

  const open = async (noteId: string) => {
    const book = props.notebook.book();
    if (!book) return;
    try {
      const opened = await book.open(noteId);
      bodyRaw = opened.body.ok ? opened.body.raw : undefined;
      if (!draft) start(opened.entry.info);
      show(
        opened.body.ok ? opened.body.doc : EMPTY,
        opened.entry,
        opened.body.ok && opened.entry.title.kind === "text",
      );
    } catch {
      setLoaded({ kind: "failed" });
    }
  };

  const start = (info: NoteInfo | null) => {
    const book = props.notebook.book();
    if (!book) return;
    draft = new NoteDraft(book, info, {
      copyTitle: (text) =>
        t("notes.copyTitle", { title: text || t("notes.untitled"), time: dateTime().format(new Date()) }),
      onCreated: follow,
      onCopied: (copy, copyTitle) => {
        // Later saves keep the copy's name unless the user changes it.
        setTitle(copyTitle);
        toasts.show(t("notes.conflict"));
        follow(copy);
      },
    });
    setInfo(info);
    const unsubscribe = draft.subscribe(() => {
      setStatus(draft?.status ?? "saved");
      setInfo(draft?.info ?? null);
    });
    onCleanup(unsubscribe);
  };

  onMount(() => {
    if (session.param === "new") {
      start(null);
      setLoaded({ kind: "ready", doc: EMPTY, readable: true, entry: null });
    } else {
      void open(session.param);
    }
  });

  // Another device's version, or the note deleted there.
  createEffect(
    on(props.notebook.version, () => {
      const book = props.notebook.book();
      const info = draft?.info;
      if (!book || !info || book.state.kind !== "ready") return;
      const entry = book.get(info.note_id);
      if (!entry) {
        if (draft?.dirty) return;
        toasts.show(t("notes.deletedElsewhere"));
        navigate("/notes", { replace: true });
        return;
      }
      if (draft?.newer(entry.info)) void open(info.note_id);
    }),
  );

  const unload = (e: BeforeUnloadEvent) => {
    if (draft?.dirty) e.preventDefault();
  };
  window.addEventListener("beforeunload", unload);
  onCleanup(() => {
    window.removeEventListener("beforeunload", unload);
    void draft?.close().catch(() => undefined);
  });

  const changed = () => draft?.change(content);

  const labels = useEditorLabels();

  const heading = () => {
    const l = loaded();
    if (title().trim() !== "") return title();
    if (l.kind === "ready" && l.entry && l.entry.title.kind !== "text") return noteTitle(l.entry, t);
    return t(info() ? "notes.untitled" : "notes.newTitle");
  };

  const statusText = () => {
    switch (status()) {
      case "pending":
      case "saving":
        return t("notes.status.saving");
      case "failed":
        return t("notes.status.failed");
      case "tooLarge":
        return t("notes.status.tooLarge");
      default:
        return info() ? t("notes.status.saved") : "";
    }
  };

  const remove = async () => {
    setDeleting(false);
    const stored = info();
    const book = props.notebook.book();
    if (!stored || !book) return;
    try {
      await book.delete(stored.note_id);
      navigate("/notes", { replace: true });
    } catch (e) {
      toasts.show(t(requestError(e)), "danger");
    }
  };

  return (
    <Pane
      level={2}
      title={heading()}
      back={<IconButton icon="arrow_back" mirrorInRtl label={t("notes.back")} onClick={() => navigate("/notes")} />}
      actions={
        <Show when={info()}>
          <IconButton icon="delete" label={t("notes.delete")} onClick={() => setDeleting(true)} />
        </Show>
      }
      scroll
      footer={
        <Switch>
          <Match when={status() === "failed" || status() === "tooLarge"}>
            <Stack direction="row" gap="sm" align="center" wrap>
              <Banner tone="danger">{statusText()}</Banner>
              <Show when={status() === "failed"}>
                <Button onClick={() => void draft?.flush()}>{t("common.retry")}</Button>
              </Show>
            </Stack>
          </Match>
          <Match when={statusText()}>
            <Text tone="muted" variant="body-sm">
              {statusText()}
            </Text>
          </Match>
        </Switch>
      }
    >
      <Switch>
        <Match when={loaded().kind === "loading"}>
          <Text tone="muted">{t("notes.opening")}</Text>
        </Match>
        <Match when={loaded().kind === "failed"}>
          <Banner tone="danger">{t("notes.openFailed")}</Banner>
          <Stack direction="row">
            <Button onClick={() => void open(session.param)}>{t("common.retry")}</Button>
          </Stack>
        </Match>
        <Match when={loaded().kind === "ready" && (loaded() as Extract<Loaded, { kind: "ready" }>)}>
          {(ready) => (
            <Stack gap="md">
              <Show when={!ready().readable}>
                <Banner tone="warning">{t("notes.readOnly")}</Banner>
              </Show>
              <TextField
                label={t("notes.titleLabel")}
                value={title()}
                autocomplete="off"
                readOnly={!ready().readable}
                onInput={(e) => {
                  setTitle(e.currentTarget.value);
                  changed();
                }}
              />
              <RichEditor
                doc={ready().doc}
                readOnly={!ready().readable}
                labels={labels()}
                locale={locale()}
                markdown={(text) => toDocument(text) as Promise<Record<string, unknown>[] | null>}
                unreadable={<Banner tone="warning">{t("notes.unreadableBody")}</Banner>}
                onChange={(next) => {
                  read = next;
                  changed();
                }}
              />
            </Stack>
          )}
        </Match>
      </Switch>

      <Dialog
        open={deleting()}
        title={t("notes.deleteTitle")}
        closeLabel={t("common.close")}
        onClose={() => setDeleting(false)}
        actions={
          <>
            <Button onClick={() => setDeleting(false)}>{t("common.cancel")}</Button>
            <Button variant="danger" onClick={() => void remove()}>
              {t("common.delete")}
            </Button>
          </>
        }
      >
        <Text>{t("notes.deleteText")}</Text>
      </Dialog>
    </Pane>
  );
}
