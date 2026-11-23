/** How the data screen writes metrics, values and moments in the locale. */
import type { useI18n } from "../../i18n/i18n";
import type { MessageKey } from "../../i18n/messages/en";
import type { Metric } from "../../protocol/generated/protocol";
import { formatValue, localName, wallClock } from "../../registers/catalog";

type T = ReturnType<typeof useI18n>["t"];

const UNITS: Partial<Record<string, MessageKey>> = {
  kg: "registers.unit.kg",
  cm: "registers.unit.cm",
  kcal: "registers.unit.kcal",
  s: "registers.unit.s",
};

export function metricName(metric: Metric, locale: string): string {
  return localName(metric.names, locale, metric.key);
}

/** The unit's short name; a count has none. */
export function unitLabel(unit: string, t: T): string {
  if (unit === "count") return "";
  const key = UNITS[unit];
  return key ? t(key) : unit;
}

export function withUnit(metric: Metric, value: number, locale: string, t: T): string {
  if (metric.unit === "s") return clock(value);
  const unit = unitLabel(metric.unit, t);
  const number = formatValue(metric, value, locale);
  return unit === "" ? number : `${number} ${unit}`;
}

/** Seconds as a stopwatch shows them: `1:30`, `1:02:05`. */
export function clock(seconds: number): string {
  const total = Math.round(Math.abs(seconds));
  const [h, m, s] = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60];
  const pad = (n: number) => String(n).padStart(2, "0");
  const text = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  return seconds < 0 ? `-${text}` : text;
}

/** A `YYYY-MM-DD` day. */
export function dayLabel(day: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${day}T00:00Z`));
}

/** An entry's moment on the clock where it was recorded. */
export function momentLabel(occurredAt: number, tz: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(
    wallClock(occurredAt, tz),
  );
}

/** A day along a chart's axis: short, without the year. */
export function axisDay(day: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone: "UTC" }).format(
    new Date(`${day}T00:00Z`),
  );
}

/** An entry's moment along a chart's axis. */
export function axisMoment(occurredAt: number, tz: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(wallClock(occurredAt, tz));
}

/** A goal in words: its target, where its path starts and the day to reach it by, whichever are known. */
export function goalLines(
  metric: Metric,
  goal: { target: number; since?: string | undefined; until?: string | null | undefined },
  locale: string,
  t: T,
  start?: { day: string; value: number } | null,
): string[] {
  const { target, since, until } = goal;
  return [
    t("registers.goal.target", { value: withUnit(metric, target, locale, t) }),
    ...(until ? [t("registers.goal.by", { day: dayLabel(until, locale) })] : []),
    ...(start
      ? [
          t("registers.goal.from", {
            value: withUnit(metric, start.value, locale, t),
            day: dayLabel(start.day, locale),
          }),
        ]
      : since
        ? [t("registers.goal.fromDay", { day: dayLabel(since, locale) })]
        : []),
  ];
}
