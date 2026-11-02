import { describe, expect, it } from "vitest";
import { fullTime, msToMidnight, shortTime } from "./when";

const NOW = new Date(2026, 10, 2, 12, 0).getTime();
const at = (month: number, day: number, year = 2026) => new Date(year, month, day, 9, 30).getTime();

describe("a message's time", () => {
  it("names today by the time, yesterday in words, the week by its day, the rest by a date", () => {
    expect(shortTime("en-GB", at(10, 2), NOW)).toBe("09:30");
    expect(shortTime("ru", at(10, 1), NOW)).toBe("вчера");
    expect(shortTime("en-GB", at(10, 1), NOW)).toBe("yesterday");
    expect(shortTime("en-GB", at(9, 31), NOW)).toBe("Saturday");
    expect(shortTime("en-GB", at(9, 27), NOW)).toBe("Tuesday");
    expect(shortTime("en-GB", at(9, 26), NOW)).toBe("26 Oct");
    expect(shortTime("en-GB", at(9, 26, 2025), NOW)).toBe("26 Oct 2025");
  });

  it("shows a message ahead of the device's clock by its time", () => {
    expect(shortTime("en-GB", at(10, 3), NOW)).toBe("09:30");
  });

  it("counts calendar days, not 24 hours", () => {
    const late = new Date(2026, 10, 1, 23, 59).getTime();
    expect(shortTime("en-GB", late, new Date(2026, 10, 2, 0, 1).getTime())).toBe("yesterday");
  });

  it("writes out the whole date and time", () => {
    expect(fullTime("en-GB", at(9, 26))).toContain("26 October 2026");
    expect(fullTime("en-GB", at(9, 26))).toContain("09:30");
  });

  it("finds the next midnight", () => {
    expect(msToMidnight(new Date(2026, 10, 2, 23, 0))).toBe(3_600_000);
  });
});
