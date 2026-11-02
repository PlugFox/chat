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
  const unit = unitLabel(metric.unit, t);
  const number = formatValue(metric, value, locale);
  return unit === "" ? number : `${number} ${unit}`;
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

/** A goal in words: its target and its pace, whichever it has. */
export function goalLines(metric: Metric, goal: { target?: number; delta?: number }, locale: string, t: T): string[] {
  const { target, delta } = goal;
  return [
    ...(target === undefined ? [] : [t("registers.goal.target", { value: withUnit(metric, target, locale, t) })]),
    ...(delta === undefined
      ? []
      : [t("registers.goal.delta", { value: `${delta > 0 ? "+" : ""}${withUnit(metric, delta, locale, t)}` })]),
  ];
}
