/**
 * A message's time in words: the time today, then "yesterday", a weekday
 * within the week, a date past it. Days are the device's calendar days.
 * Framework-free so it can be tested without a DOM.
 */

const DAY_MS = 86_400_000;

function startOfDay(ms: number): number {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Calendar days from `ms` to `now`; rounded, as a day with a clock change is not 24 hours. */
function daysAgo(ms: number, now: number): number {
  return Math.round((startOfDay(now) - startOfDay(ms)) / DAY_MS);
}

export function shortTime(locale: string, ms: number, now: number): string {
  const days = daysAgo(ms, now);
  const date = new Date(ms);
  // A clock behind the server's can put a message ahead of "now".
  if (days <= 0) return new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(date);
  if (days === 1) return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-1, "day");
  if (days < 7) return new Intl.DateTimeFormat(locale, { weekday: "long" }).format(date);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(date);
}

export function fullTime(locale: string, ms: number): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "long", timeStyle: "short" }).format(new Date(ms));
}

/** How long until the next local midnight. */
export function msToMidnight(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime();
}
