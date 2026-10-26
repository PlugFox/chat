import { encode } from "@msgpack/msgpack";
import { describe, expect, it } from "vitest";
import {
  type ContextCandidate,
  decodeMessage,
  decodeTitle,
  encodeTitle,
  pickContext,
  precheck,
  titleFrom,
} from "./records";

function m(id: number, text: string | null, extra: Partial<ContextCandidate> = {}): ContextCandidate {
  return { id, author: id % 2 ? "assistant" : "user", state: "complete", deleted: false, text, ...extra };
}

describe("records", () => {
  it("reads a message map and keeps the fields it does not know", () => {
    const read = decodeMessage(encode({ text: "hi", later: [1] }));
    expect(read).toEqual({ ok: true, text: "hi", raw: { text: "hi", later: [1] } });
  });

  it("names why a record cannot be shown", () => {
    expect(decodeMessage(new Uint8Array([0xc1]))).toEqual({ ok: false, reason: "parse" });
    expect(decodeMessage(encode({ body: "hi" }))).toEqual({ ok: false, reason: "parse" });
    expect(decodeMessage(encode(["hi"]))).toEqual({ ok: false, reason: "parse" });
    expect(decodeMessage(encode({ text: "x".repeat(200 * 1024 + 1) }))).toEqual({ ok: false, reason: "size" });
    expect(precheck(new Uint8Array([2, 1]))).toBe("version");
    expect(precheck(new Uint8Array(256 * 1024 + 1).fill(1))).toBe("size");
    expect(precheck(new Uint8Array([1, 1]))).toBeNull();
    expect(decodeTitle(new Uint8Array([0xff]))).toEqual({ ok: false, reason: "parse" });
  });

  it("titles a chat by its first line and keeps titles within 1 KiB", () => {
    expect(titleFrom("\n  Plan the trip  \nwith details")).toBe("Plan the trip");
    expect([...titleFrom("y".repeat(100))]).toHaveLength(60);
    const long = encodeTitle("ж".repeat(600));
    expect(long.length).toBe(1024);
    expect(decodeTitle(long)).toEqual({ ok: true, text: "ж".repeat(512) });
  });

  it("sends the latest readable messages, at most 50 and 64 KiB", () => {
    const many = Array.from({ length: 80 }, (_, i) => m(i, `t${i}`));
    const picked = pickContext(many).messages;
    expect(picked.map((p) => p.id)).toEqual(Array.from({ length: 50 }, (_, i) => i + 30));
    expect(picked[0]).toEqual({ id: 30, role: "user", text: "t30" });

    const skipped = pickContext([
      m(0, "asked"),
      m(1, "", { state: "cancelled" }),
      m(2, "again"),
      m(3, "half", { state: "failed" }),
      m(4, null),
      m(5, "gone", { deleted: true }),
      m(6, "summary", { author: "summary" }),
      m(7, "partial", { state: "cancelled" }),
    ]).messages;
    expect(skipped.map((p) => p.id)).toEqual([0, 2, 7]);

    const big = pickContext([m(0, "a".repeat(40 * 1024)), m(1, "b".repeat(30 * 1024)), m(2, "c")]).messages;
    expect(big.map((p) => p.id)).toEqual([1, 2]);
  });
});
