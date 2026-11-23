/**
 * The saved messages (D-095), newest first: each whole, with its chat and
 * when it was saved, a link that opens the chat at it and a button that
 * removes it. The page loads its first page when it opens.
 */
import { createEffect, createSignal, For, type JSX, Match, on, Show, Switch } from "solid-js";
import { useToasts } from "../../app/toasts";
import { useChats } from "../../chats/context";
import type { SavedEntry } from "../../chats/saved";
import {
  Banner,
  Button,
  EmptyState,
  IconButton,
  IconLink,
  Message,
  Page,
  Stack,
  Text,
} from "../../design-system/components";
import { useI18n } from "../../i18n/i18n";
import { requestError, unreadable } from "../chats/errors";
import { createRichContent, type RichTools, useRichTools } from "../chats/rich";

export default function SavedPage(): JSX.Element {
  const { t } = useI18n();
  const chats = useChats();
  const tools = useRichTools();
  const [loadingMore, setLoadingMore] = createSignal(false);
  const saved = () => {
    chats.version();
    return chats.saved();
  };
  createEffect(
    on(chats.saved, (store) => {
      if (store && store.state.kind === "idle") void store.load();
    }),
  );
  const more = () => {
    const store = chats.saved();
    if (!store || loadingMore()) return;
    setLoadingMore(true);
    store
      .more()
      .catch(() => undefined)
      .finally(() => setLoadingMore(false));
  };
  return (
    <Page title={t("saved.title")}>
      <Switch>
        <Match when={saved()?.state.kind === "failed"}>
          <Banner tone="danger">{t("saved.loadFailed")}</Banner>
          <Stack direction="row">
            <Button onClick={() => void chats.saved()?.load()}>{t("common.retry")}</Button>
          </Stack>
        </Match>
        <Match when={!saved() || saved()?.state.kind !== "ready"}>
          <Text tone="muted">{t("saved.loading")}</Text>
        </Match>
        <Match when={saved()?.list.length === 0}>
          <EmptyState icon="bookmark">{t("saved.empty")}</EmptyState>
        </Match>
        <Match when={true}>
          <Stack gap="md">
            <For each={saved()?.list ?? []}>{(entry) => <SavedRow entry={entry} tools={tools} />}</For>
          </Stack>
          <Show when={saved()?.hasMore}>
            <Stack direction="row">
              <Button onClick={more} disabled={loadingMore()}>
                {t("saved.more")}
              </Button>
            </Stack>
          </Show>
        </Match>
      </Switch>
    </Page>
  );
}

function SavedRow(props: { entry: SavedEntry; tools: RichTools }): JSX.Element {
  const { t, locale } = useI18n();
  const chats = useChats();
  const toasts = useToasts();
  // The store opens content and titles in place: the version says when.
  const entry = () => {
    chats.version();
    return props.entry;
  };
  const rich = createRichContent(
    props.tools,
    () => entry().message.author,
    () => entry().content,
  );
  const chatTitle = () => {
    const title = entry().title;
    if (title.kind === "text" && title.text !== "") return title.text;
    return t(title.kind === "unreadable" ? "chats.unreadableTitle" : "chats.untitled");
  };
  const when = () =>
    new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(entry().savedAt));
  const author = () => {
    switch (entry().message.author) {
      case "user":
        return t("chat.author.user");
      case "summary":
        return t("chat.author.summary");
      case "tool":
        return t("chat.author.tool");
      default:
        return t("chat.author.assistant");
    }
  };
  const remove = () => {
    chats
      .saved()
      ?.save(entry().chat.chat_id, entry().message.id, false)
      .then(
        () => toasts.show(t("chat.saved.removed")),
        (e: unknown) => toasts.show(t(requestError(e)), "danger"),
      );
  };
  return (
    <Message
      author={entry().message.author === "user" ? "user" : entry().message.author === "summary" ? "summary" : "other"}
      authorLabel={author()}
      label={entry().message.author === "summary" ? t("chat.summary.label") : undefined}
      content={rich.content()}
      text={rich.text()}
      status={(() => {
        const content = entry().content;
        return content.kind === "unreadable" ? (
          <Banner tone="warning">{t(unreadable[content.reason])}</Banner>
        ) : undefined;
      })()}
      meta={`${chatTitle()} · ${when()}`}
      actions={
        <>
          <IconLink
            icon="open_in_new"
            label={t("saved.open")}
            href={`/chats/${entry().chat.chat_id}?message=${entry().message.id}`}
          />
          <IconButton icon="bookmark_remove" label={t("saved.remove")} onClick={remove} />
        </>
      }
    />
  );
}
