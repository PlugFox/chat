/**
 * An open chat: its messages, virtualized and fetched by chunk as they come
 * into view, and the composer. A failed reply shows its error in place with
 * a retry where one can help; a record the client cannot read says why
 * (D-089). What the server refuses is a toast and adds nothing.
 */
import { useNavigate } from "@solidjs/router";
import { createEffect, createMemo, createSignal, type JSX, Match, on, onCleanup, Show, Switch } from "solid-js";
import { useAgent } from "../../agent/context";
import { useToasts } from "../../app/toasts";
import { useChats } from "../../chats/context";
import { resolveHistory, THRESHOLD_DEFAULT } from "../../chats/records";
import { chunkOf, type Shown } from "../../chats/thread";
import {
  Banner,
  Button,
  Composer,
  Dialog,
  IconButton,
  Message,
  MessageList,
  Pane,
  RichText,
  type RichTextLabels,
  Stack,
  Text,
  TextArea,
} from "../../design-system/components";
import { tableCsv } from "../../document/csv";
import { createDocument } from "../../document/preview";
import { useI18n } from "../../i18n/i18n";
import type { MessageKey } from "../../i18n/messages/en";
import type { Span } from "../../protocol/generated/protocol";
import { ChatSettingsDialog, useSettingsSummary } from "./ChatSettings";
import { requestError, retryHelps, turnError, unreadable } from "./errors";

/** The composer's hint while no turn can run (D-086). */
export function useAgentHint(): () => MessageKey | undefined {
  const { agent } = useAgent();
  return () => {
    switch (agent().kind) {
      case "none":
        return "chat.agent.none";
      case "starting":
      case "idle":
        return "chat.agent.starting";
      case "refused":
        return "chat.agent.refused";
      case "failed":
        return "chat.agent.failed";
      case "ready":
        return undefined;
    }
  };
}

export function ChatView(props: { chatId: string }): JSX.Element {
  const { t, locale } = useI18n();
  const chats = useChats();
  const toasts = useToasts();
  const navigate = useNavigate();
  const agentHint = useAgentHint();
  const chatId = props.chatId;
  const thread = createMemo(() => chats.thread(chatId));
  const [draft, setDraft] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [acting, setActing] = createSignal<Shown | null>(null);
  const [editing, setEditing] = createSignal<{ id: number; text: string } | null>(null);
  const [deleting, setDeleting] = createSignal<number | null>(null);
  const [searched, setSearched] = createSignal(false);
  const [configuring, setConfiguring] = createSignal(false);
  const summary = useSettingsSummary();

  const entry = () => {
    chats.version();
    return chats.list()?.get(chatId);
  };
  /**
   * Whether the chat as known is as new as the message: chat and message
   * changes share one revision counter (D-029), so an older copy of the chat
   * (or none, while the list reloads) says nothing about the reply's turn.
   */
  const current = (m: Shown) => {
    const e = entry();
    return e !== undefined && e.info.rev >= m.message.rev;
  };
  /** A streaming reply whose turn lost its lease (D-083): its chat says no turn runs. */
  const stale = (m: Shown) => m.message.state === "streaming" && current(m) && !entry()?.info.turn;
  const live = (m: Shown) => m.message.state === "streaming" && !stale(m);
  /** A reply is being written: the chat says so, or its last reply streams and is not stale. */
  const running = () => {
    if (entry()?.info.turn) return true;
    chats.version();
    const open = thread();
    const last = open?.message(open.lastId);
    return last !== undefined && live(last);
  };
  createEffect(() => {
    const known = entry()?.info.last_message_id;
    if (known !== undefined) thread()?.grow(known);
  });
  /** Ids are dense from 0 (D-028): one row per id up to the last. */
  const count = () => {
    chats.version();
    const open = thread();
    return open && (entry() || open.lastId > 0) ? open.lastId + 1 : 0;
  };

  // A chat not on the loaded pages (an old one, opened by its link) is looked
  // for in all of them, again after every reload of the list (a reconnect).
  const listState = createMemo(() => {
    chats.version();
    return chats.list()?.state.kind;
  });
  createEffect(
    on(
      () => [chats.list(), listState()] as const,
      ([list, state]) => {
        setSearched(false);
        if (!list || state !== "ready" || list.get(chatId)) return;
        void (async () => {
          await list.all(false);
          if (!list.get(chatId)) await list.all(true);
        })()
          .catch(() => undefined)
          .finally(() => {
            if (list === chats.list() && list.state.kind === "ready") setSearched(true);
          });
      },
    ),
  );

  const run = (action: () => Promise<void>) => {
    action().catch((e: unknown) => toasts.show(t(requestError(e)), "danger"));
  };

  const title = () => {
    const e = entry();
    if (!e) return t("chats.untitled");
    if (e.title.kind === "text" && e.title.text !== "") return e.title.text;
    return t(e.title.kind === "unreadable" ? "chats.unreadableTitle" : "chats.untitled");
  };

  const send = () => {
    const open = thread();
    const text = draft();
    if (!open || sending()) return;
    setSending(true);
    open
      .send(text, entry()?.info.settings, chats.defaults().history)
      .then(
        () => setDraft(""),
        (e: unknown) => toasts.show(t(requestError(e)), "danger"),
      )
      .finally(() => setSending(false));
  };

  /** Folds every message into a summary, at the chat's threshold for what it keeps. */
  const compactNow = () => {
    const open = thread();
    if (!open) return;
    setConfiguring(false);
    const history = resolveHistory(entry()?.info.settings.history, chats.defaults().history);
    const threshold = history.mode === "compact" ? history.threshold : THRESHOLD_DEFAULT;
    run(async () => {
      await open.compact({ threshold, all: true });
    });
  };

  const time = () => new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short" });
  const authorLabel = (author: string) =>
    t(
      author === "user"
        ? "chat.author.user"
        : author === "tool"
          ? "chat.author.tool"
          : author === "summary"
            ? "chat.author.summary"
            : "chat.author.assistant",
    );

  const failedCode = (m: Shown) =>
    m.message.state === "failed" ? m.message.error : stale(m) ? "turn.interrupted" : null;

  const status = (m: Shown) => {
    const code = failedCode(m);
    const content = m.content;
    return (
      <>
        <Show when={content.kind === "unreadable" ? content.reason : undefined}>
          {(reason) => <Banner tone="warning">{t(unreadable[reason()])}</Banner>}
        </Show>
        <Show when={code !== null}>
          {(() => {
            const error = turnError(code ?? undefined);
            const canRetry = () =>
              retryHelps(code ?? undefined) && !running() && (thread()?.retryable(m.message.id) ?? false);
            return (
              <Stack gap="xs">
                <Banner tone="danger">{t(error.key, error.code ? { code: error.code } : undefined)}</Banner>
                <Show when={canRetry()}>
                  <Stack direction="row">
                    <Button
                      icon="refresh"
                      onClick={() =>
                        run(
                          () =>
                            thread()?.retry(m.message.id, entry()?.info.settings, chats.defaults().history) ??
                            Promise.resolve(),
                        )
                      }
                    >
                      {t("common.retry")}
                    </Button>
                  </Stack>
                </Show>
              </Stack>
            );
          })()}
        </Show>
      </>
    );
  };

  const meta = (m: Shown) => {
    const parts = [time().format(new Date(m.message.created_at))];
    if (m.message.edited_at !== undefined) parts.push(t("chat.edited"));
    if (m.message.state === "cancelled") parts.push(t("chat.cancelled"));
    return parts.join(" · ");
  };

  const richLabels = createMemo(
    (): RichTextLabels => ({
      callout: {
        note: t("chat.rich.note"),
        tip: t("chat.rich.tip"),
        important: t("chat.rich.important"),
        warning: t("chat.rich.warning"),
        caution: t("chat.rich.caution"),
      },
      copyTable: t("chat.rich.copyTable"),
      taskDone: t("chat.rich.taskDone"),
      taskOpen: t("chat.rich.taskOpen"),
    }),
  );
  const copyTable = (table: { head: Span[][]; rows: Span[][][] }) => {
    navigator.clipboard.writeText(tableCsv(table.head, table.rows)).then(
      () => toasts.show(t("chat.rich.tableCopied")),
      () => toasts.show(t("chat.rich.copyFailed"), "danger"),
    );
  };

  /** One row of the list, following its message as it changes. */
  const Row = (rowProps: { index: number }) => {
    const shown = createMemo(() => {
      chats.version();
      return thread()?.message(rowProps.index);
    });
    return (
      <Show when={shown()} fallback={<Message author="other" authorLabel={t("chat.author.assistant")} placeholder />}>
        {(m) => {
          const summary = () => m().message.author === "summary";
          const deleted = () => m().content.kind === "deleted";
          // A reply shows as a document: the stored one, else its text converted
          // (streaming, or stored without one); the user's text stays as written.
          const rich = createDocument(
            () => {
              const c = m().content;
              return c.kind === "text" && c.doc ? c.doc : undefined;
            },
            () => {
              const c = m().content;
              return m().message.author !== "user" && c.kind === "text" && c.doc === undefined ? c.text : undefined;
            },
          );
          return (
            <Message
              content={(() => {
                const blocks = rich.blocks();
                return blocks && <RichText blocks={blocks} labels={richLabels()} onCopyTable={copyTable} />;
              })()}
              author={m().message.author === "user" ? "user" : summary() ? "summary" : "other"}
              authorLabel={authorLabel(m().message.author)}
              label={summary() && !deleted() ? t(live(m()) ? "chat.summary.writing" : "chat.summary.label") : undefined}
              text={m().content.kind === "text" && !rich.pending() ? (m().content as { text: string }).text : undefined}
              note={deleted() ? t(summary() ? "chat.summary.deleted" : "chat.deleted") : undefined}
              streaming={live(m())}
              streamingLabel={t("chat.streaming")}
              status={status(m())}
              meta={m().content.kind === "deleted" ? undefined : meta(m())}
              actions={
                m().content.kind !== "deleted" && !live(m()) ? (
                  <IconButton icon="more_vert" label={t("chat.message.actions")} onClick={() => setActing(m())} />
                ) : undefined
              }
            />
          );
        }}
      </Show>
    );
  };

  const onRange = (first: number, last: number) => {
    const open = thread();
    if (!open) return;
    const chunks: number[] = [];
    for (let c = chunkOf(first); c <= chunkOf(last); c += 1) chunks.push(c);
    void open.ensure(chunks).catch(() => undefined);
  };

  const closeActions = () => setActing(null);
  onCleanup(() => setActing(null));

  return (
    <Switch
      fallback={
        <Pane
          level={2}
          title={title()}
          back={<IconButton icon="arrow_back" mirrorInRtl label={t("chats.back")} onClick={() => navigate("/")} />}
          footer={
            <Composer
              label={t("chat.composer.label")}
              placeholder={t("chat.composer.placeholder")}
              value={draft()}
              onInput={setDraft}
              onSend={send}
              onStop={() => run(() => thread()?.cancel() ?? Promise.resolve())}
              running={running()}
              disabled={sending() || agentHint() !== undefined}
              hint={(() => {
                const hint = agentHint();
                return hint ? t(hint) : undefined;
              })()}
              options={{
                label: t("chat.settings.title"),
                summary: summary(entry()?.info.settings ?? {}),
                onOpen: () => setConfiguring(true),
              }}
              sendLabel={t("chat.send")}
              stopLabel={t("chat.stop")}
            />
          }
        >
          <ChatSettingsDialog
            open={configuring()}
            settings={entry()?.info.settings ?? {}}
            onChange={(settings) => run(() => chats.list()?.configure(chatId, settings) ?? Promise.resolve())}
            onClose={() => setConfiguring(false)}
            onCompact={entry() && !running() && agentHint() === undefined ? compactNow : undefined}
          />
          <MessageList count={count()} label={t("chat.messages")} revision={chats.version()} onRange={onRange}>
            {(index) => <Row index={index} />}
          </MessageList>

          <Dialog
            open={acting() !== null}
            title={t("chat.message.actions")}
            closeLabel={t("common.close")}
            onClose={closeActions}
          >
            <Show when={acting()}>
              {(m) => (
                <Stack gap="xs">
                  <Show when={m().message.author === "user" && m().content.kind === "text"}>
                    <Button
                      icon="edit"
                      onClick={() => {
                        // Read before closing: the accessor goes stale with the dialog.
                        const { message, content } = m();
                        closeActions();
                        setEditing({ id: message.id, text: content.kind === "text" ? content.text : "" });
                      }}
                    >
                      {t("chat.message.edit")}
                    </Button>
                  </Show>
                  <Button
                    variant="danger"
                    icon="delete"
                    onClick={() => {
                      const id = m().message.id;
                      closeActions();
                      setDeleting(id);
                    }}
                  >
                    {t("common.delete")}
                  </Button>
                </Stack>
              )}
            </Show>
          </Dialog>

          <Dialog
            open={editing() !== null}
            title={t("chat.edit.title")}
            closeLabel={t("common.close")}
            onClose={() => setEditing(null)}
            actions={
              <>
                <Button onClick={() => setEditing(null)}>{t("common.cancel")}</Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    const e = editing();
                    setEditing(null);
                    if (e) run(() => thread()?.edit(e.id, e.text) ?? Promise.resolve());
                  }}
                >
                  {t("common.save")}
                </Button>
              </>
            }
          >
            <Stack gap="sm">
              <TextArea
                label={t("chat.edit.label")}
                value={editing()?.text ?? ""}
                onInput={(e) => {
                  const current = editing();
                  if (current) setEditing({ ...current, text: e.currentTarget.value });
                }}
              />
              <Text tone="muted" variant="body-sm">
                {t("chat.edit.note")}
              </Text>
            </Stack>
          </Dialog>

          <Dialog
            open={deleting() !== null}
            title={t("chat.delete.title")}
            closeLabel={t("common.close")}
            onClose={() => setDeleting(null)}
            actions={
              <>
                <Button onClick={() => setDeleting(null)}>{t("common.cancel")}</Button>
                <Button
                  variant="danger"
                  onClick={() => {
                    const id = deleting();
                    setDeleting(null);
                    if (id !== null) run(() => thread()?.delete(id) ?? Promise.resolve());
                  }}
                >
                  {t("common.delete")}
                </Button>
              </>
            }
          >
            <Text>{t("chat.delete.text")}</Text>
          </Dialog>
        </Pane>
      }
    >
      <Match when={!entry() && searched()}>
        <Pane
          level={2}
          title={t("chats.untitled")}
          back={<IconButton icon="arrow_back" mirrorInRtl label={t("chats.back")} onClick={() => navigate("/")} />}
          scroll
        >
          <Banner tone="warning">{t("chat.notFound")}</Banner>
        </Pane>
      </Match>
    </Switch>
  );
}
