import type { JSX } from "solid-js";
import { EmptyState, Page } from "../../design-system/components";
import { useI18n } from "../../i18n/i18n";

export default function NotesPage(): JSX.Element {
  const { t } = useI18n();
  return (
    <Page title={t("notes.title")}>
      <EmptyState icon="description">{t("notes.empty")}</EmptyState>
    </Page>
  );
}
