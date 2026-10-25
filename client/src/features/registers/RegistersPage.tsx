import type { JSX } from "solid-js";
import { EmptyState, Page } from "../../design-system/components";
import { useI18n } from "../../i18n/i18n";

export default function RegistersPage(): JSX.Element {
  const { t } = useI18n();
  return (
    <Page title={t("registers.title")}>
      <EmptyState icon="monitoring">{t("registers.empty")}</EmptyState>
    </Page>
  );
}
