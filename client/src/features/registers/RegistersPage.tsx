/**
 * The data screen (`/registers`, `/registers/:metric`, D-097): the metrics
 * of the catalog by category beside the open one on large screens, one of
 * them on smaller ones.
 */
import { useParams } from "@solidjs/router";
import { type JSX, Show } from "solid-js";
import { ChatLayout, EmptyState } from "../../design-system/components";
import { useI18n } from "../../i18n/i18n";
import { MetricListPane } from "./MetricListPane";
import { MetricView } from "./MetricView";
import { createRegisters } from "./registers";

export default function RegistersPage(): JSX.Element {
  const { t } = useI18n();
  const params = useParams<{ metric?: string }>();
  const registers = createRegisters();
  return (
    <ChatLayout
      title={t("registers.title")}
      showing={params.metric ? "detail" : "list"}
      list={<MetricListPane registers={registers} current={params.metric} />}
      detail={
        <Show
          when={registers.registers() && params.metric}
          keyed
          fallback={<EmptyState icon="monitoring">{t("registers.pick")}</EmptyState>}
        >
          {(metric) => <MetricView metric={metric} registers={registers} />}
        </Show>
      }
    />
  );
}
