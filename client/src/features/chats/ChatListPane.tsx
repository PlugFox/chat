/**
 * The chat list: search, pinned chats in the order the user drags them
 * (D-080), recent chats paged, and the archive, where chats can be deleted
 * (D-081). Each chat's actions open in a dialog.
 */
import { useNavigate } from "@solidjs/router";
import { createEffect, createSignal, type JSX, Match, on, Show, Switch } from "solid-js";
import { useToasts } from "../../app/toasts";
import { useChats } from "../../chats/context";
import type { ChatEntry } from "../../chats/list";
import {
  Banner,
  Button,
  ChatRow,
  ChatRows,
  Dialog,
  EmptyState,
  IconButton,
  Pane,
  Section,
  Stack,
  Text,
  TextField,
} from "../../design-system/components";
import { useI18n } from "../../i18n/i18n";
import { requestError } from "./errors";

export function ChatListPane(props: { current: string | undefined }): JSX.Element {
  const { t, locale } = useI18n();
  const { list, version } = useChats();
  const toasts = useToasts();
  const navigate = useNavigate();
  const [query, setQuery] = createSignal("");
  const [archive, setArchive] = createSignal(false);
  const [acting, setActing] = createSignal<ChatEntry | null>(null);
  const [renaming, setRenaming] = createSignal<{ entry: ChatEntry; title: string } | null>(null);
  const [deleting, setDeleting] = createSignal<ChatEntry | null>(null);

  const chats = () => {
    version();
    return list();
  };
  const title = (entry: ChatEntry) =>
    entry.title.kind === "text" && entry.title.text !== ""
      ? entry.title.text
      : t(entry.title.kind === "unreadable" ? "chats.unreadableTitle" : "chats.untitled");
  const placeholder = (entry: ChatEntry) => entry.title.kind !== "text" || entry.title.text === "";

  const day = () => new Intl.DateTimeFormat(locale(), { dateStyle: "medium" });
  const time = () => new Intl.DateTimeFormat(locale(), { timeStyle: "short" });
  const when = (millis: number) => {
    const date = new Date(millis);
    return date.toDateString() === new Date().toDateString() ? time().format(date) : day().format(date);
  };

  // Titles are encrypted: a search pages through every chat first (D-079).
  createEffect(
    on([query, archive, list], ([q, archived, chats]) => {
      if (q.trim() !== "" && chats) void chats.all(archived).catch(() => undefined);
    }),
  );
  const matches = (entries: ChatEntry[]) => {
    const q = query().trim().toLocaleLowerCase(locale());
    if (q === "") return entries;
    return entries.filter((e) => e.title.kind === "text" && e.title.text.toLocaleLowerCase(locale()).includes(q));
  };

  const run = (action: () => Promise<void>) => {
    action().catch((e: unknown) => toasts.show(t(requestError(e)), "danger"));
  };
  const close = () => setActing(null);
  /** Closes the actions and runs one on the list. */
  const act = (action: () => Promise<void> | undefined) => {
    close();
    run(() => action() ?? Promise.resolve());
  };

  const row = (entry: ChatEntry, handle?: JSX.Element) => (
    <ChatRow
      handle={handle}
      href={`/chats/${entry.info.chat_id}`}
      title={title(entry)}
      placeholder={placeholder(entry)}
      detail={when(entry.info.updated_at)}
      {...(entry.info.temporary ? { icon: "hourglass_empty" } : {})}
      current={props.current === entry.info.chat_id}
      busy={entry.info.turn}
      busyLabel={t("chats.running")}
      actions={
        <IconButton
          icon="more_vert"
          label={t("chats.actions", { title: title(entry) })}
          onClick={() => setActing(entry)}
        />
      }
    />
  );

  const pinned = () => matches(chats()?.pinned ?? []);
  const recent = () => matches(chats()?.recent ?? []);
  const archived = () => matches(chats()?.archived ?? []);
  const shown = () => (archive() ? archived() : [...pinned(), ...recent()]);

  // The archive is paged when opened.
  createEffect(
    on([archive, list], ([open, chats]) => {
      if (open && chats && !chats.loaded(true)) void chats.more(true).catch(() => undefined);
    }),
  );

  const actions = (entry: ChatEntry) => {
    const id = entry.info.chat_id;
    const pins = chats()?.pinned ?? [];
    const at = pins.findIndex((p) => p.info.chat_id === id);
    const isArchived = entry.info.archived_at !== undefined;
    const temporary = entry.info.temporary === true;
    return (
      <Stack gap="xs">
        <Button
          icon="edit"
          onClick={() => {
            close();
            setRenaming({ entry, title: entry.title.kind === "text" ? entry.title.text : "" });
          }}
        >
          {t("chats.action.rename")}
        </Button>
        <Show when={!isArchived && !temporary}>
          <Show
            when={at >= 0}
            fallback={
              <Button icon="keep" onClick={() => act(() => chats()?.pin(id, 0))}>
                {t("chats.action.pin")}
              </Button>
            }
          >
            <Show when={at > 0}>
              <Button icon="arrow_upward" onClick={() => act(() => chats()?.pin(id, at - 1))}>
                {t("chats.action.moveUp")}
              </Button>
            </Show>
            <Show when={at < pins.length - 1}>
              <Button icon="arrow_downward" onClick={() => act(() => chats()?.pin(id, at + 1))}>
                {t("chats.action.moveDown")}
              </Button>
            </Show>
            <Button icon="keep_off" onClick={() => act(() => chats()?.pin(id))}>
              {t("chats.action.unpin")}
            </Button>
          </Show>
        </Show>
        <Show when={!temporary}>
          <Button
            icon={isArchived ? "unarchive" : "archive"}
            onClick={() => {
              close();
              run(async () => {
                await chats()?.archive(id, !isArchived);
                if (!isArchived && props.current === id) navigate("/");
              });
            }}
          >
            {t(isArchived ? "chats.action.unarchive" : "chats.action.archive")}
          </Button>
        </Show>
        <Show when={isArchived || temporary}>
          <Button
            variant="danger"
            icon="delete"
            onClick={() => {
              close();
              setDeleting(entry);
            }}
          >
            {t("common.delete")}
          </Button>
        </Show>
      </Stack>
    );
  };

  return (
    <Pane
      level={1}
      bar
      title={t(archive() ? "chats.archive" : "chats.title")}
      scroll
      actions={
        <>
          <IconButton
            icon={archive() ? "arrow_back" : "archive"}
            mirrorInRtl={archive()}
            label={t(archive() ? "chats.archive.close" : "chats.archive.open")}
            onClick={() => setArchive(!archive())}
          />
          <Show when={!archive()}>
            <IconButton icon="add" label={t("chats.new")} variant="primary" onClick={() => navigate("/chats/new")} />
          </Show>
        </>
      }
    >
      <TextField
        type="search"
        label={t("chats.search")}
        value={query()}
        autocomplete="off"
        onInput={(e) => setQuery(e.currentTarget.value)}
      />
      <Switch>
        <Match when={chats()?.state.kind === "failed"}>
          <Banner tone="danger">{t("chats.loadFailed")}</Banner>
          <Stack direction="row">
            <Button onClick={() => void chats()?.load()}>{t("common.retry")}</Button>
          </Stack>
        </Match>
        <Match when={!chats() || chats()?.state.kind === "loading"}>
          <Text tone="muted">{t("chats.loading")}</Text>
        </Match>
        <Match when={shown().length === 0 && query().trim() !== ""}>
          <Text tone="muted">{t("chats.searchEmpty")}</Text>
        </Match>
        <Match when={shown().length === 0 && !chats()?.hasMore(archive())}>
          <Show when={archive()} fallback={<EmptyState icon="chat">{t("chats.empty")}</EmptyState>}>
            <EmptyState icon="archive">{t("chats.archive.empty")}</EmptyState>
          </Show>
        </Match>
        <Match when={archive()}>
          <ChatRows items={archived()} key={(e) => e.info.chat_id} label={t("chats.archive")}>
            {(entry) => row(entry)}
          </ChatRows>
        </Match>
        <Match when={true}>
          <Show when={pinned().length > 0}>
            <Section title={t("chats.pinned")} flat>
              <ChatRows
                items={pinned()}
                key={(e) => e.info.chat_id}
                label={t("chats.pinned")}
                reorder={
                  query().trim() === ""
                    ? {
                        handleLabel: (e) => t("chats.handle", { title: title(e) }),
                        onMove: (e, to) => run(() => chats()?.pin(e.info.chat_id, to) ?? Promise.resolve()),
                      }
                    : undefined
                }
              >
                {(entry, handle) => row(entry, handle)}
              </ChatRows>
            </Section>
          </Show>
          <Show when={recent().length > 0}>
            <Section title={t("chats.recent")} flat>
              <ChatRows items={recent()} key={(e) => e.info.chat_id} label={t("chats.recent")}>
                {(entry) => row(entry)}
              </ChatRows>
            </Section>
          </Show>
        </Match>
      </Switch>
      <Show when={chats()?.state.kind === "ready" && chats()?.hasMore(archive()) && query().trim() === ""}>
        <Stack direction="row">
          <Button onClick={() => run(() => chats()?.more(archive()) ?? Promise.resolve())}>{t("chats.more")}</Button>
        </Stack>
      </Show>

      <Dialog
        open={acting() !== null}
        title={(() => {
          const entry = acting();
          return entry ? title(entry) : "";
        })()}
        closeLabel={t("common.close")}
        onClose={close}
      >
        <Show when={acting()}>{(entry) => actions(entry())}</Show>
      </Dialog>

      <Dialog
        open={renaming() !== null}
        title={t("chats.rename.title")}
        closeLabel={t("common.close")}
        onClose={() => setRenaming(null)}
        actions={
          <>
            <Button onClick={() => setRenaming(null)}>{t("common.cancel")}</Button>
            <Button
              variant="primary"
              onClick={() => {
                const r = renaming();
                setRenaming(null);
                if (r) run(() => chats()?.rename(r.entry.info.chat_id, r.title.trim()) ?? Promise.resolve());
              }}
            >
              {t("common.save")}
            </Button>
          </>
        }
      >
        <TextField
          label={t("chats.rename.label")}
          value={renaming()?.title ?? ""}
          autocomplete="off"
          onInput={(e) => {
            const r = renaming();
            if (r) setRenaming({ ...r, title: e.currentTarget.value });
          }}
        />
      </Dialog>

      <Dialog
        open={deleting() !== null}
        title={t("chats.delete.title")}
        closeLabel={t("common.close")}
        onClose={() => setDeleting(null)}
        actions={
          <>
            <Button onClick={() => setDeleting(null)}>{t("common.cancel")}</Button>
            <Button
              variant="danger"
              onClick={() => {
                const entry = deleting();
                setDeleting(null);
                if (!entry) return;
                run(async () => {
                  await chats()?.delete(entry.info.chat_id);
                  if (props.current === entry.info.chat_id) navigate("/");
                });
              }}
            >
              {t("common.delete")}
            </Button>
          </>
        }
      >
        <Text>{t("chats.delete.text")}</Text>
      </Dialog>
    </Pane>
  );
}
