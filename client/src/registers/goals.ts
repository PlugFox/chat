/**
 * Goals of metrics, the `goals` setting (docs/crypto.md, "Record contents";
 * D-124): a target, a wished change per month, or both, and the day the pace
 * counts from. Sealed like every setting, so the server sees that the setting
 * exists and not what it says. Framework-free so it can be tested without a DOM.
 */

import { Decoder, Encoder } from "@msgpack/msgpack";

export const GOALS_KEY = "goals";

const encoder = new Encoder({ ignoreUndefined: true });
const decoder = new Decoder();
const DAY_MS = 86_400_000;
/** The average month: a pace is a slope, not a calendar. */
const MONTH_DAYS = 30.436875;
/** A pace that takes longer than this is not drawn as reaching the target. */
const REACH_MAX_DAYS = 3660;

type Raw = Record<string, unknown>;

export interface Goal {
  target?: number;
  /** The wished change per month, in the metric's unit. */
  delta?: number;
  /** `YYYY-MM-DD`: the pace starts at the first value from this day. */
  since: string;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function readGoal(v: unknown): Goal | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const { target, delta, since } = v as Raw;
  if (typeof since !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(since)) return null;
  if (!finite(target) && !finite(delta)) return null;
  return { since, ...(finite(target) ? { target } : {}), ...(finite(delta) ? { delta } : {}) };
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
  if (goal) goals[metric] = goal;
  else delete goals[metric];
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

/** The value the pace expects on a day, stopping at the target once it gets there; `null` before it starts. */
export function expected(goal: Goal, start: Point, day: string): number | null {
  if (goal.delta === undefined || day < start.day) return null;
  const value = start.value + (goal.delta * (time(day) - time(start.day))) / DAY_MS / MONTH_DAYS;
  const { target } = goal;
  if (target === undefined) return value;
  const towards = (target - start.value) * goal.delta > 0;
  return towards && (value - target) * goal.delta > 0 ? target : value;
}

/** The day the pace reaches the target, or `null` when it does not within ten years. */
export function reaches(goal: Goal, start: Point): string | null {
  const { target, delta } = goal;
  if (target === undefined || delta === undefined || delta === 0) return null;
  const days = ((target - start.value) / delta) * MONTH_DAYS;
  return days >= 0 && days <= REACH_MAX_DAYS ? addDays(start.day, Math.ceil(days)) : null;
}
