/**
 * Every metric of the catalog, by category, each with its latest day: the
 * day's average or total, as the metric adds up.
 */
import { For, type JSX, Match, Switch } from "solid-js";
import { Banner, Button, ChatRow, ChatRows, Pane, Section, Stack, Text } from "../../design-system/components";
import { useI18n } from "../../i18n/i18n";
import type { Metric } from "../../protocol/generated/protocol";
import { localName } from "../../registers/catalog";
import { dayLabel, metricName, withUnit } from "./format";
import type { RegistersContext } from "./registers";

export function MetricListPane(props: { registers: RegistersContext; current: string | undefined }): JSX.Element {
  const { t, locale } = useI18n();
  const registers = () => {
    props.registers.version();
    return props.registers.registers();
  };
  const state = () => registers()?.state.kind ?? "loading";
  const groups = () => {
    const r = registers();
    if (!r) return [];
    return r.categories
      .map((category) => ({ category, metrics: r.metrics.filter((m) => m.category === category.key) }))
      .filter((g) => g.metrics.length > 0);
  };
  const detail = (metric: Metric) => {
    const latest = registers()?.latest(metric.key);
    if (!latest || latest.kind === "loading") return t("registers.loading");
    if (!latest.day) return t("registers.noEntries");
    return t("registers.latest", {
      value: withUnit(metric, latest.day.value, locale(), t),
      day: dayLabel(latest.day.day, locale()),
    });
  };

  return (
    <Pane level={1} bar title={t("registers.title")} scroll>
      <Switch>
        <Match when={state() === "failed"}>
          <Banner tone="danger">{t("registers.loadFailed")}</Banner>
          <Stack direction="row">
            <Button
              onClick={() =>
                void registers()
                  ?.load()
                  .catch(() => undefined)
              }
            >
              {t("common.retry")}
            </Button>
          </Stack>
        </Match>
        <Match when={state() === "loading" && groups().length === 0}>
          <Text tone="muted">{t("registers.loading")}</Text>
        </Match>
        <Match when={true}>
          <Stack gap="lg">
            <Text tone="muted">{t("registers.empty")}</Text>
            <For each={groups()}>
              {(group) => {
                const name = () => localName(group.category.names, locale(), group.category.key);
                return (
                  <Section title={name()} flat>
                    <ChatRows items={group.metrics} key={(m) => m.key} label={name()}>
                      {(metric) => (
                        <ChatRow
                          href={`/registers/${metric.key}`}
                          title={metricName(metric, locale())}
                          detail={detail(metric)}
                          current={props.current === metric.key}
                        />
                      )}
                    </ChatRows>
                  </Section>
                );
              }}
            </For>
          </Stack>
        </Match>
      </Switch>
    </Pane>
  );
}
