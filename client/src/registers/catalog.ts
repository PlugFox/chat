/**
 * The metric catalog as the screen needs it (docs/protocol.md, "Registers";
 * D-097): names in the locale, values checked against a metric and written
 * in it, and entries made into one value a day by the metric's aggregate.
 */

import type { Metric } from "../protocol/generated/protocol";

/** The register kinds this client shows. */
export const KNOWN_REGISTERS = new Set(["measurements"]);

/** A name in `locale`, else its language, else English, else `key`. */
export function localName(names: Record<string, string>, locale: string, key: string): string {
  return names[locale] ?? names[locale.split("-")[0] ?? ""] ?? names["en"] ?? key;
}

/** Text typed in a value field as a number: a comma is a decimal point too. */
export function parseValue(text: string): number | null {
  const normalized = text.trim().replace(/\s/g, "").replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

export type ValueProblem = "integer" | "precision" | "range";

/** Why `value` cannot be an entry of `metric`, or `null`. */
export function checkValue(metric: Metric, value: number): ValueProblem | null {
  if (metric.value_type === "integer" && !Number.isInteger(value)) return "integer";
  const scale = 10 ** metric.precision;
  if (Math.abs(Math.round(value * scale) - value * scale) > 1e-6) return "precision";
  if (value < metric.min || value > metric.max) return "range";
  return null;
}

export function formatValue(metric: Metric, value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: metric.precision }).format(value);
}

/** Minutes east of UTC at `date` on this device, as the record stores it. */
export function deviceOffset(date: Date): number {
  return -date.getTimezoneOffset();
}

/** The entry's day, `YYYY-MM-DD`, at the offset it was recorded with. */
export function dayOf(occurredAt: number, tz: number): string {
  return new Date((occurredAt + tz * 60) * 1000).toISOString().slice(0, 10);
}

/** The entry's wall clock time where it was recorded, as a `Date` to format in UTC. */
export function wallClock(occurredAt: number, tz: number): Date {
  return new Date((occurredAt + tz * 60) * 1000);
}

export interface Day {
  day: string;
  value: number;
  entries: number;
  /** The day's largest entry: the best set of an exercise (D-128). */
  best: number;
}

/** One value a day, oldest first: the average or the sum of the day's entries. */
export function byDay(entries: Iterable<{ occurredAt: number; tz: number; value: number }>, aggregate: string): Day[] {
  const days = new Map<string, { sum: number; entries: number; best: number }>();
  for (const e of entries) {
    const day = dayOf(e.occurredAt, e.tz);
    const known = days.get(day) ?? { sum: 0, entries: 0, best: e.value };
    known.sum += e.value;
    known.entries += 1;
    known.best = Math.max(known.best, e.value);
    days.set(day, known);
  }
  return [...days]
    .map(([day, d]) => ({
      day,
      value: aggregate === "sum" ? d.sum : d.sum / d.entries,
      entries: d.entries,
      best: d.best,
    }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}
