/**
 * The account's chat defaults (D-091): how much history a chat carries when
 * it chose none, and its auto-compaction. Changing them needs this tab unlocked.
 */
import { createSignal, type JSX, Show } from "solid-js";
import { useChats } from "../../chats/context";
import { Banner, Section, Stack, Text } from "../../design-system/components";
import { useI18n } from "../../i18n/i18n";
import { HistoryFields } from "../chats/ChatSettings";

export function ChatsSection(): JSX.Element {
  const { t } = useI18n();
  const chats = useChats();
  const [failed, setFailed] = createSignal(false);
  return (
    <Section title={t("settings.chats")} flat>
      <Show when={chats.list()} fallback={<Text tone="muted">{t("settings.chats.locked")}</Text>}>
        <Stack gap="md">
          <Text measure>{t("settings.chats.note")}</Text>
          <Show when={failed()}>
            <Banner tone="danger">{t("settings.chats.saveFailed")}</Banner>
          </Show>
          <HistoryFields
            history={chats.defaults().history}
            inherited={undefined}
            onChange={(history) => {
              setFailed(false);
              chats.setDefaults(history ? { history } : {}).catch(() => setFailed(true));
            }}
          />
        </Stack>
      </Show>
    </Section>
  );
}
