/**
 * One metric: a chart of its newest entries, by day (the day's average or
 * total, as the metric adds up) or entry by entry, the same values as a
 * list below it, which is also the chart's text, and the entries' changes.
 */
import { useNavigate } from "@solidjs/router";
import { createSignal, For, type JSX, Match, Show, Switch } from "solid-js";
import { useToasts } from "../../app/toasts";
import {
  Banner,
  Button,
  Chart,
  Dialog,
  EmptyState,
  IconButton,
  List,
  ListItem,
  Pane,
  Select,
  Stack,
  Text,
} from "../../design-system/components";
import { useI18n } from "../../i18n/i18n";
import type { Chart as ChartData, Metric } from "../../protocol/generated/protocol";
import { byDay } from "../../registers/catalog";
import type { OpenedEntry } from "../../registers/registers";
import { requestError } from "../chats/errors";
import { EntryDialog } from "./EntryDialog";
import { axisDay, axisMoment, dayLabel, metricName, momentLabel, unitLabel, withUnit } from "./format";
import type { RegistersContext } from "./registers";

type View = "days" | "entries";

/** The dialog open: a new entry, or a change to one. */
type Editing = { entry: OpenedEntry | null } | null;

export function MetricView(props: { metric: string; registers: RegistersContext }): JSX.Element {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const toasts = useToasts();
  const [view, setView] = createSignal<View>("days");
  const [editing, setEditing] = createSignal<Editing>(null);
  const [deleting, setDeleting] = createSignal<OpenedEntry | null>(null);

  const registers = () => {
    props.registers.version();
    return props.registers.registers();
  };
  const metric = () => registers()?.metric(props.metric);
  const history = () => {
    props.registers.version();
    return registers()?.history(props.metric);
  };
  const entries = () => history()?.list ?? [];
  const readable = () =>
    entries().flatMap((e) =>
      e.value.kind === "value" ? [{ occurredAt: e.info.occurred_at, tz: e.value.tz, value: e.value.value }] : [],
    );
  const days = () => {
    const m = metric();
    return m ? byDay(readable(), m.aggregate) : [];
  };

  const chart = (m: Metric): ChartData => {
    const unit = unitLabel(m.unit, t);
    const points =
      view() === "days"
        ? days().map((d) => ({ label: axisDay(d.day, locale()), value: d.value }))
        : [...entries()]
            .reverse()
            .flatMap((e) =>
              e.value.kind === "value"
                ? [{ label: axisMoment(e.info.occurred_at, e.value.tz, locale()), value: e.value.value }]
                : [],
            );
    return {
      kind: m.aggregate === "sum" ? "bar" : "line",
      ...(unit === "" ? {} : { y: unit }),
      labels: points.map((p) => p.label),
      series: [{ name: metricName(m, locale()), values: points.map((p) => p.value) }],
    };
  };

  const remove = async () => {
    const entry = deleting();
    setDeleting(null);
    if (!entry) return;
    try {
      await registers()?.delete(entry);
    } catch (e) {
      toasts.show(t(requestError(e)), "danger");
    }
  };

  return (
    <Show when={metric()} fallback={<EmptyState icon="monitoring">{t("registers.pick")}</EmptyState>}>
      {(m) => (
        <Pane
          level={2}
          title={metricName(m(), locale())}
          leading={
            <IconButton
              icon="arrow_back"
              mirrorInRtl
              label={t("registers.back")}
              onClick={() => navigate("/registers")}
            />
          }
          actions={
            <IconButton
              icon="add"
              label={t("registers.add")}
              variant="primary"
              onClick={() => setEditing({ entry: null })}
            />
          }
          scroll
        >
          <Switch>
            <Match when={history()?.state.kind === "failed"}>
              <Banner tone="danger">{t("registers.entriesFailed")}</Banner>
              <Stack direction="row">
                <Button
                  onClick={() =>
                    void history()
                      ?.load()
                      .catch(() => undefined)
                  }
                >
                  {t("common.retry")}
                </Button>
              </Stack>
            </Match>
            <Match when={history()?.state.kind === "loading" && entries().length === 0}>
              <Text tone="muted">{t("registers.entriesLoading")}</Text>
            </Match>
            <Match when={entries().length === 0}>
              <EmptyState icon="monitoring">{t("registers.entriesEmpty")}</EmptyState>
            </Match>
            <Match when={true}>
              <Stack gap="md">
                <Select
                  label={t("registers.view")}
                  value={view()}
                  options={[
                    { value: "days", label: t("registers.view.days") },
                    { value: "entries", label: t("registers.view.entries") },
                  ]}
                  onChange={setView}
                />
                <Show when={readable().length > 0}>
                  <Chart
                    chart={chart(m())}
                    label={t("registers.chart", { metric: metricName(m(), locale()) })}
                    locale={locale()}
                  />
                </Show>
                <Show when={history()?.hasMore}>
                  <Text tone="muted" variant="body-sm">
                    {t("registers.shown", { count: entries().length })}
                  </Text>
                </Show>
                <Show
                  when={view() === "entries"}
                  fallback={
                    <List label={t(m().aggregate === "sum" ? "registers.aggregate.sum" : "registers.aggregate.avg")}>
                      <For each={[...days()].reverse()}>
                        {(d) => (
                          <ListItem
                            title={dayLabel(d.day, locale())}
                            details={[
                              withUnit(m(), d.value, locale(), t),
                              t("registers.dayEntries", { count: d.entries }),
                            ]}
                          />
                        )}
                      </For>
                    </List>
                  }
                >
                  <List label={t("registers.view.entries")}>
                    <For each={entries()}>
                      {(entry) => (
                        <ListItem
                          title={
                            entry.value.kind === "value"
                              ? withUnit(m(), entry.value.value, locale(), t)
                              : t("registers.unreadable")
                          }
                          details={
                            entry.value.kind === "value"
                              ? [
                                  momentLabel(entry.info.occurred_at, entry.value.tz, locale()),
                                  ...(entry.value.comment === "" ? [] : [entry.value.comment]),
                                ]
                              : []
                          }
                          actions={
                            <>
                              <Show when={entry.value.kind === "value"}>
                                <IconButton
                                  icon="edit"
                                  label={t("registers.edit")}
                                  onClick={() => setEditing({ entry })}
                                />
                              </Show>
                              <IconButton
                                icon="delete"
                                label={t("registers.delete")}
                                onClick={() => setDeleting(entry)}
                              />
                            </>
                          }
                        />
                      )}
                    </For>
                  </List>
                </Show>
                <Show when={history()?.hasMore}>
                  <Stack direction="row">
                    <Button
                      onClick={() =>
                        void history()
                          ?.more()
                          .catch(() => toasts.show(t("registers.entriesFailed"), "danger"))
                      }
                    >
                      {t("registers.more")}
                    </Button>
                  </Stack>
                </Show>
              </Stack>
            </Match>
          </Switch>

          <Show when={editing() && registers()}>
            {(r) => (
              <EntryDialog
                registers={r()}
                metric={m()}
                entry={editing()?.entry ?? null}
                onClose={() => setEditing(null)}
              />
            )}
          </Show>
          <Dialog
            open={deleting() !== null}
            title={t("registers.deleteTitle")}
            closeLabel={t("common.close")}
            onClose={() => setDeleting(null)}
            actions={
              <>
                <Button onClick={() => setDeleting(null)}>{t("common.cancel")}</Button>
                <Button variant="danger" onClick={() => void remove()}>
                  {t("common.delete")}
                </Button>
              </>
            }
          >
            <Text>{t("registers.deleteText")}</Text>
          </Dialog>
        </Pane>
      )}
    </Show>
  );
}
