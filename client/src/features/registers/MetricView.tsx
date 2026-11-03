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
  type ChartLine,
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
import { addDays, anchor, daysBetween, deadline, expected } from "../../registers/goals";
import type { OpenedEntry } from "../../registers/registers";
import { requestError } from "../chats/errors";
import { EntryDialog } from "./EntryDialog";
import { axisDay, axisMoment, dayLabel, goalLines, metricName, momentLabel, unitLabel, withUnit } from "./format";
import { GoalDialog } from "./GoalDialog";
import type { RegistersContext } from "./registers";

type View = "days" | "entries";

function dayOfEntry(occurredAt: number, tz: number): string {
  return new Date((occurredAt + tz * 60) * 1000).toISOString().slice(0, 10);
}

/** The dialog open: a new entry, or a change to one. */
type Editing = { entry: OpenedEntry | null } | null;

export function MetricView(props: { metric: string; registers: RegistersContext }): JSX.Element {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const toasts = useToasts();
  const [view, setView] = createSignal<View>("days");
  const [editing, setEditing] = createSignal<Editing>(null);
  const [deleting, setDeleting] = createSignal<OpenedEntry | null>(null);
  const [goalOpen, setGoalOpen] = createSignal(false);

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

  const goal = () => {
    props.registers.version();
    return registers()?.goal(props.metric);
  };
  const today = () => {
    const now = new Date();
    return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  };
  const start = () => {
    const g = goal();
    return g ? anchor(g, days()) : null;
  };
  /** The day to reach the target by: the goal's own, or where a pace of D-124 gets there. */
  const end = (): string | null => {
    const g = goal();
    const s = start();
    return g && s ? deadline(g, s) : null;
  };

  /**
   * The days view's axis, a time scale: every day from the first entry to
   * the last, then on through today and a little past it while a path is
   * still on its way, so its direction shows without stretching the axis to
   * its end day.
   */
  const axisDays = (): string[] => {
    const shown = days();
    const first = shown[0]?.day;
    const last = shown.at(-1)?.day;
    if (!first || !last) return [];
    const until = end();
    const s = start();
    if (!until || !s || until <= last) return daysBetween(first, last);
    // Days as YYYY-MM-DD sort as text.
    const now = [last, today(), s.day].sort().at(-1) ?? last;
    const span = daysBetween(first, now).length;
    const ahead = addDays(now, Math.max(7, Math.round(span / 4)));
    return daysBetween(first, [ahead, until].sort()[0] ?? until);
  };

  const points = () => {
    if (view() === "days") {
      const byDate = new Map(days().map((d) => [d.day, d]));
      return axisDays().map((day) => ({
        day,
        label: axisDay(day, locale()),
        value: byDate.get(day)?.value ?? null,
        best: byDate.get(day)?.best ?? null,
      }));
    }
    return [...entries()].reverse().flatMap((e) =>
      e.value.kind === "value"
        ? [
            {
              day: dayOfEntry(e.info.occurred_at, e.value.tz),
              label: axisMoment(e.info.occurred_at, e.value.tz, locale()),
              value: e.value.value as number | null,
              best: null,
            },
          ]
        : [],
    );
  };

  const chart = (m: Metric): ChartData => {
    const unit = unitLabel(m.unit, t);
    const shown = points();
    return {
      kind: "line",
      ...(unit === "" ? {} : { y: unit }),
      labels: shown.map((p) => p.label),
      series: [
        { name: metricName(m, locale()), values: shown.map((p) => p.value) },
        // A day's sets add up to the total; the best of them shows strength apart from volume.
        ...(m.sets && view() === "days" ? [{ name: t("registers.bestSet"), values: shown.map((p) => p.best) }] : []),
      ],
    };
  };

  const lines = (): ChartLine[] => {
    const g = goal();
    if (!g) return [];
    const axis = points().map((p) => p.day);
    const s = start();
    const path = s ? axis.map((day) => expected(g, s, day)) : [];
    return [
      { name: t("registers.goal.line"), values: axis.map(() => g.target) },
      ...(path.some((v) => v !== null) ? [{ name: t("registers.goal.path"), values: path }] : []),
    ];
  };

  /** What the lines say, for those who do not read the chart. */
  const goalText = (m: Metric): string[] => {
    const g = goal();
    if (!g) return [];
    const s = start();
    const until = end();
    const now = s && until && today() <= until ? expected(g, s, today()) : null;
    return [
      ...goalLines(m, { target: g.target, since: g.since, until }, locale(), t, s),
      ...(now === null ? [] : [t("registers.goal.expected", { value: withUnit(m, now, locale(), t) })]),
      ...(until && until < today() ? [t("registers.goal.overdue")] : []),
    ];
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
            <>
              <IconButton icon="flag" label={t("registers.goal.open")} onClick={() => setGoalOpen(true)} />
              <IconButton
                icon="add"
                label={t("registers.add")}
                variant="primary"
                onClick={() => setEditing({ entry: null })}
              />
            </>
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
                    lines={lines()}
                    joinGaps={view() === "days"}
                  />
                </Show>
                <Show when={goal()}>
                  <Text tone="muted" variant="body-sm">
                    {goalText(m()).join(" · ")}
                  </Text>
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
                              ...(m().sets
                                ? [
                                    t("registers.sets", { count: d.entries }),
                                    t("registers.best", { value: withUnit(m(), d.best, locale(), t) }),
                                  ]
                                : [t("registers.dayEntries", { count: d.entries })]),
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

          <Show when={goalOpen() && registers()}>
            {(r) => (
              <GoalDialog
                registers={r()}
                metric={m()}
                until={end()}
                today={today()}
                onClose={() => setGoalOpen(false)}
              />
            )}
          </Show>
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
