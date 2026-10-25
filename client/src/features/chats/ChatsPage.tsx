import type { JSX } from "solid-js";
import { Button, EmptyState, Page } from "../../design-system/components";
import { useI18n } from "../../i18n/i18n";

export default function ChatsPage(): JSX.Element {
  const { t } = useI18n();
  return (
    <Page title={t("chats.title")}>
      <EmptyState
        icon="chat"
        action={
          <Button variant="primary" icon="add" disabled>
            {t("chats.new")}
          </Button>
        }
      >
        {t("chats.empty")}
      </EmptyState>
    </Page>
  );
}
