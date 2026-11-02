/**
 * Every component and variant on one page, for review and for the e2e suite
 * (axe and touch targets in every theme). Development and test builds only.
 * Adding a component or a variant means adding it here.
 */
import { createSignal, type JSX, Match, Switch } from "solid-js";
import { thumbHashToDataURL } from "thumbhash";
import { useToasts } from "../app/toasts";
import { cryptoSelfTest } from "../crypto/self-test";
import {
  Attachments,
  Banner,
  Button,
  ChatRow,
  ChatRows,
  Checkbox,
  Composer,
  Dialog,
  FileIcon,
  Heading,
  IconButton,
  IconLink,
  ImageViewer,
  List,
  ListItem,
  Message,
  MessageFiles,
  Page,
  QrCode,
  Quote,
  RecoveryWords,
  RichEditor,
  RichText,
  type RichTextLabels,
  Section,
  Select,
  Stack,
  Text,
  TextArea,
  TextField,
} from "../design-system/components";
import { useEditorLabels } from "../features/notes/labels";
import { useI18n } from "../i18n/i18n";
import type { MessageKey } from "../i18n/messages/en";
import type { Block } from "../protocol/generated/protocol";

/** BIP-39 words for the look only; not anyone's key. */
const SAMPLE_WORDS = "abandon ability able about above absent absorb abstract absurd abuse access accident".split(" ");

export default function UiKit(): JSX.Element {
  const { t, locale } = useI18n();
  const [open, setOpen] = createSignal(false);
  const [choice, setChoice] = createSignal<"a" | "b">("a");
  const [checked, setChecked] = createSignal(false);
  const toasts = useToasts();
  const [chats, setChats] = createSignal<MessageKey[]>(["uiKit.sample.chatTitle", "uiKit.sample.chatTitle2"]);
  const [draft, setDraft] = createSignal("");
  const [viewing, setViewing] = createSignal(false);
  /** A sunset-like ThumbHash: what an image shows until its preview opens. */
  const sunset = thumbHashToDataURL([
    168, 73, 6, 53, 138, 136, 136, 136, 117, 120, 119, 143, 135, 104, 136, 112, 136, 124, 143, 248, 215,
  ]);
  const fileItems = () => [
    {
      id: "photo",
      name: t("uiKit.sample.photo"),
      meta: t("uiKit.sample.photoSize"),
      preview: sunset,
      kind: "image",
      extension: "jpg",
    },
    { id: "report", name: t("uiKit.sample.report"), meta: t("uiKit.sample.reportSize"), kind: "pdf", extension: "pdf" },
    { id: "table", name: t("uiKit.sample.table"), kind: "table", extension: "csv", busy: true },
  ];
  const [selfTest, setSelfTest] = createSignal<"idle" | "running" | "ok" | { error: string }>("idle");
  const runSelfTest = () => {
    setSelfTest("running");
    cryptoSelfTest().then(
      () => setSelfTest("ok"),
      (e: unknown) => setSelfTest({ error: e instanceof Error ? e.message : String(e) }),
    );
  };
  const p = (text: string): Block => ({ t: "p", s: [text] });
  const richSample = (): Block[] => [
    { t: "h", level: 2, s: [t("uiKit.sample.rich.heading")] },
    {
      t: "p",
      s: [
        `${t("uiKit.sample.answer")} `,
        { text: t("uiKit.sample.rich.bold"), f: 1 },
        " ",
        { text: t("uiKit.sample.rich.italic"), f: 2 },
        " ",
        { text: t("uiKit.sample.rich.struck"), f: 4 },
        " ",
        { text: "dogs=yes", f: 8 },
        " ",
        { text: t("uiKit.sample.rich.link"), href: "https://example.org" },
      ],
    },
    {
      t: "list",
      start: 1,
      items: [{ b: [p(t("uiKit.sample.rich.beach1"))] }, { b: [p(t("uiKit.sample.rich.beach2"))] }],
    },
    {
      t: "list",
      items: [
        { b: [p(t("uiKit.sample.rich.task1"))], checked: true },
        { b: [p(t("uiKit.sample.rich.task2"))], checked: false },
      ],
    },
    { t: "quote", b: [p(t("uiKit.sample.rich.quote"))] },
    ...(["note", "tip", "important", "warning", "caution"] as const).map(
      (kind): Block => ({ t: "callout", kind, b: [p(t("uiKit.sample.rich.callout"))] }),
    ),
    { t: "panel", title: [t("uiKit.sample.rich.panel")], b: [p(t("uiKit.sample.rich.quote"))] },
    {
      t: "code",
      lang: "sh",
      text: "curl 'https://example.org/beaches?dogs=yes&month=9' | jq '.[] | .name, .distance_km'",
    },
    {
      t: "table",
      align: ["", "right", "center"],
      head: [[t("uiKit.sample.rich.beach")], [t("uiKit.sample.rich.distance")], [t("uiKit.sample.rich.dogs")]],
      rows: [
        [[t("uiKit.sample.rich.beach1")], ["12"], ["✓"]],
        [[t("uiKit.sample.rich.beach2")], ["30"], ["✓"]],
      ],
    },
    {
      t: "chart",
      kind: "line",
      title: t("uiKit.sample.rich.water"),
      x: t("uiKit.sample.rich.month"),
      labels: months(),
      series: [
        { name: t("uiKit.sample.rich.beach1"), values: [17, 19.5, 22, 23.5, 21] },
        { name: t("uiKit.sample.rich.beach2"), values: [16, 18, null, 22, 20.5] },
      ],
    },
    {
      t: "chart",
      kind: "pie",
      title: t("uiKit.sample.rich.trips"),
      labels: [t("uiKit.sample.rich.beach1"), t("uiKit.sample.rich.beach2"), t("uiKit.sample.rich.other")],
      series: [{ name: t("uiKit.sample.rich.trips"), values: [5, 3, 1] }],
    },
    { t: "rule" },
    p(t("uiKit.sample.answer")),
  ];
  const months = () => {
    const month = new Intl.DateTimeFormat(locale(), { month: "short" });
    return [5, 6, 7, 8, 9].map((m) => month.format(new Date(2026, m)));
  };
  const editorLabels = useEditorLabels();
  const richLabels = (): RichTextLabels => ({
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
  });
  return (
    <Page title={t("uiKit.title")}>
      <Text tone="muted">{t("uiKit.intro")}</Text>

      <Section title={t("uiKit.buttons")}>
        <Stack direction="row" wrap gap="sm" align="center">
          <Button variant="primary" icon="send">
            {t("uiKit.sample.primary")}
          </Button>
          <Button>{t("uiKit.sample.secondary")}</Button>
          <Button variant="danger" icon="delete">
            {t("uiKit.sample.danger")}
          </Button>
          <Button variant="ghost">{t("uiKit.sample.ghost")}</Button>
          <Button variant="primary" disabled>
            {t("uiKit.sample.disabled")}
          </Button>
          <Button variant="primary" size="lg">
            {t("uiKit.sample.primary")}
          </Button>
        </Stack>
        <Stack direction="row" wrap gap="sm" align="center">
          <IconButton icon="edit" label={t("uiKit.sample.ghost")} />
          <IconButton icon="more_vert" label={t("uiKit.sample.secondary")} variant="secondary" />
          <IconButton icon="send" label={t("uiKit.sample.primary")} variant="primary" mirrorInRtl />
          <IconButton icon="format_bold" label={t("notes.editor.bold")} aria-pressed="true" />
          <IconLink icon="open_in_new" label={t("saved.open")} href="/ui-kit" />
        </Stack>
      </Section>

      <Section title={t("uiKit.fields")}>
        <TextField label={t("uiKit.sample.field")} hint={t("uiKit.sample.fieldHint")} autocomplete="off" />
        <TextField label={t("uiKit.sample.field")} error={t("uiKit.sample.fieldError")} autocomplete="off" />
        <TextField
          label={t("uiKit.sample.field")}
          mono
          value="abandon ability ab"
          autocomplete="off"
          suggestions={["abandon", "ability", "able", "about"]}
          suggestionsLabel={t("keys.recovery.suggestions")}
        />
        <Select
          label={t("settings.theme")}
          value={choice()}
          options={[
            { value: "a", label: t("settings.theme.light") },
            { value: "b", label: t("settings.theme.dark") },
          ]}
          onChange={setChoice}
        />
        <Checkbox
          label={t("uiKit.sample.checkbox")}
          hint={t("uiKit.sample.fieldHint")}
          checked={checked()}
          onChange={setChecked}
        />
        <Checkbox label={t("uiKit.sample.disabled")} checked disabled onChange={() => undefined} />
        <TextArea label={t("chat.edit.label")} value={t("uiKit.sample.question")} />
        <RecoveryWords label={t("keys.recovery.label")} words={SAMPLE_WORDS} />
        {/* A sample, not a link anyone can use. */}
        <QrCode value="https://chat.example/ui-kit" label={t("keys.link.qr")} />
      </Section>

      <Section title={t("uiKit.feedback")}>
        <Banner>{t("uiKit.sample.info")}</Banner>
        <Banner tone="success">{t("uiKit.sample.success")}</Banner>
        <Banner tone="warning">{t("uiKit.sample.warning")}</Banner>
        <Banner tone="danger">{t("uiKit.sample.danger.text")}</Banner>
        <Quote label={t("permissions.reason")}>{t("uiKit.sample.reason")}</Quote>
      </Section>

      <Section title={t("uiKit.list")}>
        <List label={t("uiKit.list")}>
          <ListItem
            title={t("uiKit.sample.listTitle")}
            badge={t("settings.session.current")}
            details={[t("uiKit.sample.listDetail"), t("uiKit.sample.listDetail2")]}
          />
          <ListItem
            title={t("uiKit.sample.listTitle")}
            details={[t("uiKit.sample.listDetail")]}
            actions={<Button variant="ghost">{t("settings.session.revoke")}</Button>}
          />
        </List>
      </Section>

      <Section title={t("uiKit.chats")}>
        <ChatRows
          items={chats()}
          key={(k) => k}
          label={t("chats.pinned")}
          reorder={{
            handleLabel: (k) => t("chats.handle", { title: t(k) }),
            onMove: (k, to) => {
              const rest = chats().filter((c) => c !== k);
              rest.splice(to, 0, k);
              setChats(rest);
            },
          }}
        >
          {(k, handle) => (
            <ChatRow
              href="/ui-kit"
              title={t(k)}
              detail={t("uiKit.sample.time")}
              handle={handle}
              current={k === "uiKit.sample.chatTitle"}
              busy={k === "uiKit.sample.chatTitle2"}
              busyLabel={t("chats.running")}
              actions={<IconButton icon="more_vert" label={t("chats.actions", { title: t(k) })} />}
            />
          )}
        </ChatRows>
        <ChatRows items={["x"]} key={(k) => k} label={t("chats.recent")}>
          {() => <ChatRow href="/ui-kit" title={t("chats.untitled")} placeholder detail={t("uiKit.sample.time")} />}
        </ChatRows>
        <Message
          author="user"
          authorLabel={t("chat.author.user")}
          text={t("uiKit.sample.question")}
          meta={t("uiKit.sample.time")}
          actions={<IconButton icon="more_vert" size="sm" label={t("chat.message.actions")} />}
        />
        <Message
          author="other"
          authorLabel={t("chat.author.assistant")}
          text={t("uiKit.sample.answer")}
          meta={t("uiKit.sample.time")}
          saved={t("chat.saved.mark")}
          target
          actions={<IconLink size="sm" icon="open_in_new" label={t("saved.open")} href="/ui-kit" />}
        />
        <Message
          author="other"
          authorLabel={t("chat.author.assistant")}
          tools={[
            { icon: "info", text: t("tools.list_metrics") },
            { icon: "check", text: `${t("uiKit.sample.toolRead")} · ${t("tools.outcome.approved")}` },
            { icon: "hourglass_empty", text: `${t("tools.session_context")} · ${t("tools.outcome.waiting")}` },
          ]}
          toolsLabel={t("tools.label")}
          text={t("uiKit.sample.answer")}
          streaming
          streamingLabel={t("chat.streaming")}
        />
        <Message
          author="other"
          authorLabel={t("chat.author.assistant")}
          text={t("uiKit.sample.answer")}
          content={
            <RichText
              blocks={richSample()}
              labels={richLabels()}
              locale={locale()}
              onCopyTable={() => toasts.show(t("chat.rich.tableCopied"))}
            />
          }
          meta={t("uiKit.sample.time")}
        />
        <Message
          author="other"
          authorLabel={t("chat.author.assistant")}
          status={
            <Stack gap="xs">
              <Banner tone="danger">{t("turn.error.provider.unreachable")}</Banner>
              <Stack direction="row">
                <Button icon="refresh">{t("common.retry")}</Button>
              </Stack>
            </Stack>
          }
          meta={t("uiKit.sample.time")}
        />
        <Message
          author="other"
          authorLabel={t("chat.author.assistant")}
          status={<Banner tone="warning">{t("chat.unreadable.decrypt")}</Banner>}
        />
        <Message
          author="summary"
          authorLabel={t("chat.author.summary")}
          label={t("chat.summary.label")}
          text={t("uiKit.sample.answer")}
          meta={t("uiKit.sample.time")}
        />
        <Message author="user" authorLabel={t("chat.author.user")} note={t("chat.deleted")} />
        <Message author="other" authorLabel={t("chat.author.assistant")} placeholder />
        <Composer
          label={t("chat.composer.label")}
          placeholder={t("chat.composer.placeholder")}
          value={draft()}
          onInput={setDraft}
          onSend={() => setDraft("")}
          options={{
            label: t("chat.settings.title"),
            summary: [
              "anthropic/claude-opus-5-5",
              t("chat.settings.effort.high"),
              t("chat.settings.messages", { count: 20 }),
            ].join(" · "),
            onOpen: () => undefined,
          }}
          sendLabel={t("chat.send")}
          stopLabel={t("chat.stop")}
        />
        <Composer
          label={t("chat.composer.label")}
          value=""
          onInput={() => undefined}
          onSend={() => undefined}
          onStop={() => undefined}
          running
          hint={t("chat.agent.none")}
          sendLabel={t("chat.send")}
          stopLabel={t("chat.stop")}
        />
        <Stack direction="row">
          <Button onClick={() => toasts.show(t("chat.error.busy"), "danger")}>{t("uiKit.sample.toast")}</Button>
        </Stack>
      </Section>

      <Section title={t("uiKit.files")}>
        <Stack direction="row" wrap>
          <FileIcon kind="pdf" extension="pdf" />
          <FileIcon kind="image" extension="heic" />
          <FileIcon kind="table" extension="csv" />
          <FileIcon kind="data" extension="json" />
          <FileIcon kind="code" extension="rs" />
          <FileIcon kind="text" extension="md" />
          <FileIcon kind="file" />
          <FileIcon kind="pdf" extension="pdf" size="lg" />
        </Stack>
        <Message
          author="user"
          authorLabel={t("chat.author.user")}
          files={
            <MessageFiles
              images={[
                {
                  id: "a",
                  src: sunset,
                  label: t("files.open", { name: t("uiKit.sample.photo") }),
                  alt: t("uiKit.sample.photoAbout"),
                },
                { id: "b", placeholder: sunset, label: t("files.open", { name: t("uiKit.sample.photo") }), alt: "" },
              ]}
              files={[
                {
                  id: "c",
                  name: t("uiKit.sample.report"),
                  meta: t("uiKit.sample.reportSize"),
                  kind: "pdf",
                  extension: "pdf",
                  action: t("files.saveAction"),
                },
              ]}
              onOpen={() => setViewing(true)}
            />
          }
          text={t("uiKit.sample.question")}
          meta={t("uiKit.sample.time")}
        />
        <Composer
          label={t("chat.composer.label")}
          placeholder={t("chat.composer.placeholder")}
          value=""
          onInput={() => undefined}
          onSend={() => undefined}
          attach={{ label: t("files.attach"), accept: "image/*", onPick: () => undefined }}
          attachments={
            <Attachments
              label={t("files.attached")}
              items={fileItems()}
              removeLabel={t("files.remove")}
              busyLabel={t("files.preparing")}
              onRemove={() => undefined}
              onOpen={() => undefined}
              openLabel={t("files.settings")}
            />
          }
          hasAttachments
          sendLabel={t("chat.send")}
          stopLabel={t("chat.stop")}
        />
        <ImageViewer
          open={viewing()}
          title={t("uiKit.sample.photo")}
          src={sunset}
          alt={t("uiKit.sample.photoAbout")}
          caption={t("uiKit.sample.photoAbout")}
          loadingLabel={t("files.opening")}
          closeLabel={t("common.close")}
          saveLabel={t("files.saveImage")}
          onSave={() => undefined}
          onClose={() => setViewing(false)}
        />
      </Section>

      <Section title={t("uiKit.notes")}>
        <RichEditor
          doc={{ v: 1, blocks: richSample() }}
          labels={editorLabels()}
          locale={locale()}
          onChange={() => undefined}
          unreadable={<Banner tone="warning">{t("notes.unreadableBody")}</Banner>}
        />
      </Section>

      <Section title={t("uiKit.typography")}>
        <Heading level={3} size="headline-lg">
          {t("uiKit.sample.heading")}
        </Heading>
        <Heading level={3} size="headline-sm">
          {t("uiKit.sample.heading")}
        </Heading>
        <Heading level={3} size="title-md">
          {t("uiKit.sample.heading")}
        </Heading>
        <Text variant="body-lg" measure>
          {t("uiKit.sample.body")}
        </Text>
        <Text measure>{t("uiKit.sample.body")}</Text>
        <Text variant="body-sm" tone="muted" measure>
          {t("uiKit.sample.body")}
        </Text>
      </Section>

      <Section title={t("uiKit.crypto")}>
        <Stack direction="row">
          <Button onClick={runSelfTest} disabled={selfTest() === "running"}>
            {t("uiKit.crypto.run")}
          </Button>
        </Stack>
        <Switch>
          <Match when={selfTest() === "ok"}>
            <Banner tone="success">{t("uiKit.crypto.ok")}</Banner>
          </Match>
          <Match
            when={(() => {
              const s = selfTest();
              return typeof s === "object" ? s : false;
            })()}
          >
            {(s) => <Banner tone="danger">{t("uiKit.crypto.failed", { error: s().error })}</Banner>}
          </Match>
        </Switch>
      </Section>

      <Section title={t("uiKit.dialog")}>
        <Stack direction="row">
          <Button onClick={() => setOpen(true)}>{t("uiKit.sample.openDialog")}</Button>
        </Stack>
        <Dialog
          open={open()}
          title={t("uiKit.sample.dialogTitle")}
          closeLabel={t("common.close")}
          onClose={() => setOpen(false)}
          actions={
            <>
              <Button onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
              <Button variant="primary" onClick={() => setOpen(false)}>
                {t("common.save")}
              </Button>
            </>
          }
        >
          <Text>{t("uiKit.sample.dialogBody")}</Text>
        </Dialog>
      </Section>
    </Page>
  );
}
