import { describe, expect, it } from "vitest";
import { clock } from "./format";

describe("clock", () => {
  it("writes seconds as a stopwatch does", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(90)).toBe("1:30");
    expect(clock(3725)).toBe("1:02:05");
    expect(clock(-30)).toBe("-0:30");
  });
});
