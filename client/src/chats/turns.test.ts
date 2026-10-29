import { describe, expect, it, vi } from "vitest";
import { OwnTurns } from "./turns";

describe("own turns", () => {
  it("knows a turn once its answer named it, even when asked first", async () => {
    vi.useFakeTimers();
    const turns = new OwnTurns();
    const early = turns.chatOf("t1", 1000);
    turns.started("t1", "chat");
    await expect(early).resolves.toBe("chat");
    await expect(turns.chatOf("t1", 0)).resolves.toBe("chat");
    const never = turns.chatOf("t2", 1000);
    vi.advanceTimersByTime(1000);
    await expect(never).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it("forgets the oldest past 64", async () => {
    const turns = new OwnTurns();
    for (let i = 0; i < 65; i += 1) turns.started(`t${i}`, "chat");
    vi.useFakeTimers();
    const first = turns.chatOf("t0", 10);
    vi.advanceTimersByTime(10);
    await expect(first).resolves.toBeUndefined();
    await expect(turns.chatOf("t64", 10)).resolves.toBe("chat");
    vi.useRealTimers();
  });
});
