import type { JSX } from "solid-js";
import { EmptyState, Page } from "../../design-system/components";
import { useI18n } from "../../i18n/i18n";

export default function SavedPage(): JSX.Element {
  const { t } = useI18n();
  return (
    <Page title={t("saved.title")}>
      <EmptyState icon="bookmark">{t("saved.empty")}</EmptyState>
    </Page>
  );
}
