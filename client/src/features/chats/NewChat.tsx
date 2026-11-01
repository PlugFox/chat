/** A chat that does not exist yet: the composer, whose first message creates it. */
import { useNavigate } from "@solidjs/router";
import { createSignal, type JSX } from "solid-js";
import { useToasts } from "../../app/toasts";
import { useChats } from "../../chats/context";
import { Composer, EmptyState, IconButton, Pane } from "../../design-system/components";
import { useI18n } from "../../i18n/i18n";
import type { ChatSettings } from "../../protocol/generated/protocol";
import { useComposerFiles } from "./attachments";
import { ChatSettingsDialog, useSettingsSummary } from "./ChatSettings";
import { useAgentHint } from "./ChatView";
import { requestError } from "./errors";

export function NewChat(): JSX.Element {
  const { t } = useI18n();
  const chats = useChats();
  const toasts = useToasts();
  const navigate = useNavigate();
  const agentHint = useAgentHint();
  const [draft, setDraft] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [settings, setSettings] = createSignal<ChatSettings>({});
  const [configuring, setConfiguring] = createSignal(false);
  const summary = useSettingsSummary();
  const composerFiles = useComposerFiles(chats.filesOn, sending);
  const send = () => {
    if (sending() || composerFiles.busy()) return;
    setSending(true);
    chats
      .start(draft(), settings(), composerFiles.ready())
      .then(
        (chatId) => {
          setDraft("");
          composerFiles.clear();
          navigate(`/chats/${chatId}`);
        },
        (e: unknown) => toasts.show(t(requestError(e)), "danger"),
      )
      .finally(() => setSending(false));
  };
  return (
    <Pane
      level={2}
      title={t("chats.new")}
      bar
      back={<IconButton icon="arrow_back" mirrorInRtl label={t("chats.back")} onClick={() => navigate("/")} />}
      scroll
      footer={
        <Composer
          label={t("chat.composer.label")}
          placeholder={t("chat.composer.placeholder")}
          value={draft()}
          onInput={setDraft}
          onSend={send}
          disabled={sending() || composerFiles.busy() || agentHint() !== undefined}
          attach={composerFiles.attach()}
          attachments={composerFiles.tray()}
          hasAttachments={composerFiles.has()}
          hint={(() => {
            const hint = agentHint();
            return hint ? t(hint) : undefined;
          })()}
          options={{
            label: t("chat.settings.title"),
            summary: summary(settings()),
            onOpen: () => setConfiguring(true),
          }}
          sendLabel={t("chat.send")}
          stopLabel={t("chat.stop")}
        />
      }
    >
      <EmptyState icon="chat">{t("chat.newIntro")}</EmptyState>
      {composerFiles.dialog()}
      <ChatSettingsDialog
        open={configuring()}
        settings={settings()}
        onChange={setSettings}
        onClose={() => setConfiguring(false)}
      />
    </Pane>
  );
}
