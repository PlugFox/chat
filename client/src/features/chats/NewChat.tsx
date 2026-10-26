/** A chat that does not exist yet: the composer, whose first message creates it. */
import { useNavigate } from "@solidjs/router";
import { createSignal, type JSX } from "solid-js";
import { useToasts } from "../../app/toasts";
import { useChats } from "../../chats/context";
import { Composer, EmptyState, IconButton, Pane } from "../../design-system/components";
import { useI18n } from "../../i18n/i18n";
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
  const send = () => {
    if (sending()) return;
    setSending(true);
    chats
      .start(draft())
      .then(
        (chatId) => {
          setDraft("");
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
      back={<IconButton icon="arrow_back" mirrorInRtl label={t("chats.back")} onClick={() => navigate("/")} />}
      scroll
      footer={
        <Composer
          label={t("chat.composer.label")}
          placeholder={t("chat.composer.placeholder")}
          value={draft()}
          onInput={setDraft}
          onSend={send}
          disabled={sending() || agentHint() !== undefined}
          hint={(() => {
            const hint = agentHint();
            return hint ? t(hint) : undefined;
          })()}
          sendLabel={t("chat.send")}
          stopLabel={t("chat.stop")}
        />
      }
    >
      <EmptyState icon="chat">{t("chat.newIntro")}</EmptyState>
    </Pane>
  );
}
