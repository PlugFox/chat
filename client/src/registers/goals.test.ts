import { describe, expect, it } from "vitest";
import { anchor, daysBetween, deadline, decodeGoals, encodeGoal, expected } from "./goals";

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

  it("starts the path at the first value from its day, or the last one before it", () => {
    const goal = { since: "2026-02-01", target: 80 };
    const old = { day: "2026-01-01", value: 90 };
    const later = { day: "2026-02-10", value: 88 };
    expect(anchor(goal, [old, later])).toEqual(later);
    expect(anchor(goal, [old])).toEqual({ day: "2026-02-01", value: 90 });
    expect(anchor(goal, [])).toBeNull();
  });

  it("draws a straight path to the target by its day, and the target after it", () => {
    const goal = { since: "2026-01-01", until: "2026-01-11", target: 80 };
    const start = { day: "2026-01-01", value: 90 };
    expect(expected(goal, start, "2025-12-31")).toBeNull();
    expect(expected(goal, start, "2026-01-01")).toBe(90);
    expect(expected(goal, start, "2026-01-06")).toBeCloseTo(85);
    expect(expected(goal, start, "2026-02-01")).toBe(80);
    expect(expected({ since: "2026-01-01", target: 80 }, start, "2026-01-06")).toBeNull();
  });

  it("reads a goal of a target and a pace as one with a day to reach it by", () => {
    const raw = {
      goals: { "a.b": { since: "2026-01-01", target: 88, delta: -2 }, "c.d": { since: "2026-01-01", delta: 1 } },
    };
    // Stored as D-124 wrote it: the other goal is copied as it is.
    const legacy = decodeGoals(encodeGoal(raw, "x.y", null)).goals;
    const goal = legacy.get("a.b");
    expect(legacy.has("c.d")).toBe(false);
    expect(goal && deadline(goal, { day: "2026-01-01", value: 90 })).toBe("2026-02-01");
    // A pace walking away from the target never reaches it.
    expect(goal && deadline({ ...goal, delta: 2 }, { day: "2026-01-01", value: 90 })).toBeNull();
  });

  it("stores the start, the target and the day, and drops a pace", () => {
    const stored = decodeGoals(
      encodeGoal({}, "a.b", { since: "2026-01-01", target: 5, delta: 1, until: "2026-02-01" }),
    );
    expect(stored.raw["goals"]).toEqual({ "a.b": { since: "2026-01-01", target: 5, until: "2026-02-01" } });
  });

  it("lists every day of a range", () => {
    expect(daysBetween("2026-02-27", "2026-03-02")).toEqual(["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
    expect(daysBetween("2026-03-02", "2026-03-01")).toEqual([]);
  });
});
