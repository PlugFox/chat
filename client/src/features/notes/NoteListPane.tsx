/**
 * The notes, newest first, with the start of each one's text; a search of
 * the titles and that text pages through every note first, as both are
 * encrypted.
 */
import { useNavigate } from "@solidjs/router";
import { createEffect, createSignal, type JSX, Match, on, Show, Switch } from "solid-js";
import {
  Banner,
  Button,
  ChatRow,
  ChatRows,
  EmptyState,
  IconButton,
  Pane,
  Stack,
  Text,
  TextField,
} from "../../design-system/components";
import { useI18n } from "../../i18n/i18n";
import type { NoteEntry } from "../../notes/notebook";
import type { NotebookContext } from "./notebook";

export function noteTitle(entry: NoteEntry, t: ReturnType<typeof useI18n>["t"]): string {
  if (entry.title.kind === "text" && entry.title.title.trim() !== "") return entry.title.title;
  return t(entry.title.kind === "unreadable" ? "notes.unreadableTitle" : "notes.untitled");
}

export function NoteListPane(props: { notebook: NotebookContext; current: string | undefined }): JSX.Element {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const [query, setQuery] = createSignal("");

  const notes = () => {
    props.notebook.version();
    return props.notebook.book()?.list ?? [];
  };
  const state = () => {
    props.notebook.version();
    return props.notebook.book()?.state.kind ?? "loading";
  };
  const hasMore = () => {
    props.notebook.version();
    return props.notebook.book()?.hasMore ?? false;
  };

  const day = () => new Intl.DateTimeFormat(locale(), { dateStyle: "medium" });
  const time = () => new Intl.DateTimeFormat(locale(), { timeStyle: "short" });
  const when = (millis: number) => {
    const date = new Date(millis);
    return date.toDateString() === new Date().toDateString() ? time().format(date) : day().format(date);
  };

  createEffect(
    on([query, props.notebook.book], ([q, book]) => {
      if (q.trim() !== "" && book) void book.all().catch(() => undefined);
    }),
  );
  const shown = () => {
    const q = query().trim().toLocaleLowerCase(locale());
    if (q === "") return notes();
    return notes().filter(
      (e) => e.title.kind === "text" && `${e.title.title}\n${e.title.excerpt}`.toLocaleLowerCase(locale()).includes(q),
    );
  };
  const detail = (entry: NoteEntry) => {
    const excerpt = entry.title.kind === "text" ? entry.title.excerpt : "";
    return excerpt === "" ? when(entry.info.updated_at) : `${when(entry.info.updated_at)} · ${excerpt}`;
  };

  return (
    <Pane
      level={1}
      title={t("notes.title")}
      scroll
      actions={
        <IconButton icon="note_add" label={t("notes.new")} variant="primary" onClick={() => navigate("/notes/new")} />
      }
    >
      <TextField
        type="search"
        label={t("notes.search")}
        value={query()}
        autocomplete="off"
        onInput={(e) => setQuery(e.currentTarget.value)}
      />
      <Switch>
        <Match when={state() === "failed"}>
          <Banner tone="danger">{t("notes.loadFailed")}</Banner>
          <Stack direction="row">
            <Button
              onClick={() =>
                void props.notebook
                  .book()
                  ?.load()
                  .catch(() => undefined)
              }
            >
              {t("common.retry")}
            </Button>
          </Stack>
        </Match>
        <Match when={state() === "loading" && notes().length === 0}>
          <Text tone="muted">{t("notes.loading")}</Text>
        </Match>
        <Match when={shown().length === 0 && query().trim() !== ""}>
          <Text tone="muted">{t("notes.searchEmpty")}</Text>
        </Match>
        <Match when={shown().length === 0}>
          <EmptyState icon="description">{t("notes.empty")}</EmptyState>
        </Match>
        <Match when={true}>
          <ChatRows items={shown()} key={(e) => e.info.note_id} label={t("notes.title")}>
            {(entry) => (
              <ChatRow
                href={`/notes/${entry.info.note_id}`}
                title={noteTitle(entry, t)}
                placeholder={entry.title.kind !== "text" || entry.title.title.trim() === ""}
                detail={detail(entry)}
                current={props.current === entry.info.note_id}
              />
            )}
          </ChatRows>
        </Match>
      </Switch>
      <Show when={state() === "ready" && hasMore() && query().trim() === ""}>
        <Stack direction="row">
          <Button
            onClick={() =>
              void props.notebook
                .book()
                ?.more()
                .catch(() => undefined)
            }
          >
            {t("notes.more")}
          </Button>
        </Stack>
      </Show>
    </Pane>
  );
}
