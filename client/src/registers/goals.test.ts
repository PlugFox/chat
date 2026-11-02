import { describe, expect, it } from "vitest";
import { addDays, anchor, decodeGoals, encodeGoal, expected, reaches } from "./goals";

describe("goals", () => {
  it("keeps what it does not know and drops a goal it cannot read", () => {
    const first = encodeGoal({ later: 1, goals: { "a.b": { since: "bad" }, "c.d": { future: true } } }, "e.f", {
      since: "2026-01-01",
      target: 5,
    });
    const { goals, raw } = decodeGoals(first);
    expect(raw["later"]).toBe(1);
    expect([...goals.keys()]).toEqual(["e.f"]);
    expect(decodeGoals(encodeGoal(raw, "e.f", null)).goals.size).toBe(0);
  });

  it("starts the pace at the first value from its day, or the last one before it", () => {
    const goal = { since: "2026-02-01", delta: -2 };
    const old = { day: "2026-01-01", value: 90 };
    const later = { day: "2026-02-10", value: 88 };
    expect(anchor(goal, [old, later])).toEqual(later);
    expect(anchor(goal, [old])).toEqual({ day: "2026-02-01", value: 90 });
    expect(anchor(goal, [])).toBeNull();
  });

  it("follows the pace, draws nothing before it and stops at the target", () => {
    const goal = { since: "2026-01-01", delta: -2, target: 88 };
    const start = { day: "2026-01-01", value: 90 };
    expect(expected(goal, start, "2025-12-31")).toBeNull();
    expect(expected(goal, start, "2026-01-01")).toBe(90);
    expect(expected(goal, start, addDays("2026-01-01", 15))).toBeCloseTo(89.01, 1);
    expect(expected(goal, start, "2027-01-01")).toBe(88);
    expect(reaches(goal, start)).toBe("2026-02-01");
  });

  it("says nothing of reaching a target the pace walks away from", () => {
    const goal = { since: "2026-01-01", delta: 2, target: 80 };
    const start = { day: "2026-01-01", value: 90 };
    expect(reaches(goal, start)).toBeNull();
    expect(expected(goal, start, "2026-07-01")).toBeGreaterThan(90);
  });
});
