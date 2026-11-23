/**
 * Goals of metrics, the `goals` setting (docs/crypto.md, "Record contents";
 * D-124, D-126): the value to reach, the day the path to it starts from (its
 * value is the user's own measurement then) and, if wanted, the day to reach
 * it by. Sealed like every setting, so the server sees that the setting
 * exists and not what it says. Framework-free so it can be tested without a DOM.
 */

import { Decoder, Encoder } from "@msgpack/msgpack";

export const GOALS_KEY = "goals";

const encoder = new Encoder({ ignoreUndefined: true });
const decoder = new Decoder();
const DAY_MS = 86_400_000;
/** The average month: a pace of D-124 is a slope, not a calendar. */
const MONTH_DAYS = 30.436875;
/** A pace of D-124 that takes longer than this has no end day. */
const REACH_MAX_DAYS = 3660;

type Raw = Record<string, unknown>;

export interface Goal {
  target: number;
  /** `YYYY-MM-DD`: the path starts at the first value from this day. */
  since: string;
  /** `YYYY-MM-DD`, after `since`: the day to reach the target by; without it there is no path. */
  until?: string;
  /** A goal stored before D-126: the wished change per month, which gives `until` once the start is known. */
  delta?: number;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function readGoal(v: unknown): Goal | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const { target, delta, since, until } = v as Raw;
  // A goal of D-124 with only a pace has nothing to reach: it is not shown, and kept.
  if (typeof since !== "string" || !DAY.test(since) || !finite(target)) return null;
  if (typeof until === "string" && DAY.test(until) && until > since) return { target, since, until };
  return { target, since, ...(finite(delta) && delta !== 0 ? { delta } : {}) };
}

export function decodeGoals(plaintext: Uint8Array): { goals: Map<string, Goal>; raw: Raw } {
  const decoded: unknown = decoder.decode(plaintext);
  const raw: Raw = decoded && typeof decoded === "object" && !Array.isArray(decoded) ? (decoded as Raw) : {};
  const goals = new Map<string, Goal>();
  const stored = raw["goals"];
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    for (const [metric, value] of Object.entries(stored)) {
      const goal = readGoal(value);
      if (goal) goals.set(metric, goal);
    }
  }
  return { goals, raw };
}

/** The plaintext with this metric's goal changed; everything this client does not know survives. */
export function encodeGoal(raw: Raw, metric: string, goal: Goal | null): Uint8Array {
  const stored = raw["goals"];
  const goals: Raw = stored && typeof stored === "object" && !Array.isArray(stored) ? { ...(stored as Raw) } : {};
  if (goal) {
    const { target, since, until } = goal;
    goals[metric] = { target, since, ...(until === undefined ? {} : { until }) };
  } else delete goals[metric];
  return encoder.encode({ ...raw, goals });
}

const time = (day: string) => Date.parse(`${day}T00:00:00Z`);

export function addDays(day: string, days: number): string {
  return new Date(time(day) + Math.round(days) * DAY_MS).toISOString().slice(0, 10);
}

export interface Point {
  day: string;
  value: number;
}

/** Where the pace starts: the first value from its day, else the last before it, counted from that day. */
export function anchor(goal: Goal, points: Point[]): Point | null {
  const sorted = [...points].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const from = sorted.find((p) => p.day >= goal.since);
  if (from) return from;
  const before = sorted.at(-1);
  return before ? { day: goal.since, value: before.value } : null;
}

/** The day a goal is to be reached by: its own, or for a goal of D-124, where its pace gets to the target. */
export function deadline(goal: Goal, start: Point): string | null {
  if (goal.until !== undefined) return goal.until;
  if (goal.delta === undefined) return null;
  const days = ((goal.target - start.value) / goal.delta) * MONTH_DAYS;
  return days > 0 && days <= REACH_MAX_DAYS ? addDays(start.day, Math.ceil(days)) : null;
}

/**
 * The value the path expects on a day: a straight line from the start to the
 * target on its day, the target after it; `null` before the start or with no
 * day to reach it by.
 */
export function expected(goal: Goal, start: Point, day: string): number | null {
  const end = deadline(goal, start);
  if (end === null || day < start.day) return null;
  if (day >= end || end <= start.day) return goal.target;
  return start.value + ((goal.target - start.value) * (time(day) - time(start.day))) / (time(end) - time(start.day));
}

/** Every day from `from` to `to`, both included. */
export function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  return days;
}
