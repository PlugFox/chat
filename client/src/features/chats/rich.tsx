/**
 * A message's content as `Message` shows it, for the chat and the saved
 * messages alike: a reply as a document (the stored one, else its text
 * converted while it streams or when it was stored without one), the user's
 * text as written.
 */
import { type Accessor, createMemo, type JSX } from "solid-js";
import { useToasts } from "../../app/toasts";
import type { Content } from "../../chats/thread";
import { RichText, type RichTextLabels } from "../../design-system/components";
import { tableCsv } from "../../document/csv";
import { createDocument } from "../../document/preview";
import { useI18n } from "../../i18n/i18n";
import type { Author, Span } from "../../protocol/generated/protocol";

export interface RichTools {
  labels: Accessor<RichTextLabels>;
  locale: Accessor<string>;
  copyTable: (table: { head: Span[][]; rows: Span[][][] }) => void;
}

export function useRichTools(): RichTools {
  const { t, locale } = useI18n();
  const toasts = useToasts();
  const labels = createMemo(
    (): RichTextLabels => ({
      callout: {
        note: t("chat.rich.note"),
        tip: t("chat.rich.tip"),
        important: t("chat.rich.important"),
        warning: t("chat.rich.warning"),
        caution: t("chat.rich.caution"),
      },
      copyTable: t("chat.rich.copyTable"),
      chart: t("chat.rich.chart"),
      showData: t("chat.rich.showData"),
      showChart: t("chat.rich.showChart"),
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
  return { labels, locale, copyTable };
}

export interface RichContent {
  /** The document, for `Message`'s `content`. */
  content: Accessor<JSX.Element | undefined>;
  /** The text, for `Message`'s `text`; none while a first conversion is pending. */
  text: Accessor<string | undefined>;
}

export function createRichContent(tools: RichTools, author: Accessor<Author>, content: Accessor<Content>): RichContent {
  const rich = createDocument(
    () => {
      const c = content();
      return c.kind === "text" && c.doc ? c.doc : undefined;
    },
    () => {
      const c = content();
      return author() !== "user" && c.kind === "text" && c.doc === undefined ? c.text : undefined;
    },
  );
  return {
    content: () => {
      const blocks = rich.blocks();
      return (
        blocks && (
          <RichText blocks={blocks} labels={tools.labels()} locale={tools.locale()} onCopyTable={tools.copyTable} />
        )
      );
    },
    text: () => {
      const c = content();
      return c.kind === "text" && !rich.pending() ? c.text : undefined;
    },
  };
}
