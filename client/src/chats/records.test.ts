import { decode, encode } from "@msgpack/msgpack";
import { describe, expect, it } from "vitest";
import {
  autoTitle,
  type ContextCandidate,
  decodeMessage,
  decodeTitle,
  encodeMessage,
  encodeTitle,
  pickContext,
  planFold,
  precheck,
  resolveHistory,
  splitTitle,
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

  it("reads a document beside the text, and an edit drops it", () => {
    const doc = { v: 1, blocks: [{ t: "p", s: ["hi"] }] };
    expect(decodeMessage(encode({ text: "hi", doc }))).toMatchObject({ ok: true, doc: [{ t: "p", s: ["hi"] }] });
    // One this client cannot read is null: the message shows its text as written.
    expect(decodeMessage(encode({ text: "hi", doc: { v: 2 } }))).toMatchObject({ ok: true, doc: null });
    expect(decodeMessage(encode({ text: "hi" }))).not.toHaveProperty("doc");
    expect(decode(encodeMessage("new", { text: "old", doc, later: 1 }))).toEqual({ text: "new", later: 1 });
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

  it("takes history from the chat, then the account, then compacts at 64k", () => {
    expect(resolveHistory(undefined, undefined)).toEqual({ mode: "compact", auto: true, threshold: 64_000 });
    expect(resolveHistory({ mode: "recent", messages: 7 }, { mode: "compact" })).toEqual({
      mode: "recent",
      messages: 7,
    });
    expect(resolveHistory(undefined, { mode: "recent", messages: 9 })).toEqual({ mode: "recent", messages: 9 });
    // A chat that chose only `compact` takes the account's threshold and auto.
    expect(resolveHistory({ mode: "compact" }, { mode: "compact", auto: false, threshold: 8000 })).toEqual({
      mode: "compact",
      auto: false,
      threshold: 8000,
    });
    expect(resolveHistory({ mode: "compact", threshold: 16_000 }, undefined)).toEqual({
      mode: "compact",
      auto: true,
      threshold: 16_000,
    });
  });

  it("starts a compact context at the summary's cut", () => {
    const many = Array.from({ length: 10 }, (_, i) => m(i, `t${i}`));
    const context = pickContext(many, Number.POSITIVE_INFINITY, { id: 99, through: 6, text: "sum" });
    expect(context).toEqual({
      summary: "sum",
      messages: [
        { id: 7, role: "assistant", text: "t7" },
        { id: 8, role: "user", text: "t8" },
        { id: 9, role: "assistant", text: "t9" },
      ],
    });
  });

  it("folds what lies past the threshold and keeps the latest quarter whole", () => {
    // Ten messages of 4000 bytes: 1000 tokens each.
    const many = Array.from({ length: 10 }, (_, i) => m(i, "x".repeat(4000)));
    expect(planFold(many, undefined, { threshold: 10_000 })).toBeNull();
    const fold = planFold(many, undefined, { threshold: 10_000, pending: 4 });
    // A quarter of the threshold keeps the last two whole.
    expect(fold?.through).toBe(7);
    expect(fold?.context.messages.map((x) => x.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(fold?.context.summary).toBeUndefined();

    // From a summary on, its text counts and goes along.
    const summary = { id: 10, through: 3, text: "y".repeat(40_000) };
    const next = planFold(many, summary, { threshold: 10_000 });
    expect(next?.through).toBe(7);
    expect(next?.context).toMatchObject({ summary: summary.text });
    expect(next?.context.messages.map((x) => x.id)).toEqual([4, 5, 6, 7]);

    // "Compact now" folds every message; nothing after the cut folds nothing.
    expect(planFold(many, undefined, { threshold: 10_000, all: true })?.through).toBe(9);
    expect(planFold(many, { id: 10, through: 9, text: "s" }, { threshold: 4000, all: true })).toBeNull();
    // One message past a quarter by itself folds with the rest.
    expect(planFold([m(0, "a"), m(1, "z".repeat(50_000))], undefined, { threshold: 10_000 })?.through).toBe(1);
  });

  it("folds at most a context's limit from the oldest on", () => {
    const many = Array.from({ length: 6 }, (_, i) => m(i, "x".repeat(150 * 1024)));
    const fold = planFold(many, undefined, { threshold: 4000 });
    expect(fold?.context.messages.map((x) => x.id)).toEqual([0, 1, 2]);
  });

  it("sends the latest readable messages, as many as chosen and what the server takes", () => {
    const many = Array.from({ length: 80 }, (_, i) => m(i, `t${i}`));
    const picked = pickContext(many, 50).messages;
    expect(picked.map((p) => p.id)).toEqual(Array.from({ length: 50 }, (_, i) => i + 30));
    expect(picked[0]).toEqual({ id: 30, role: "user", text: "t30" });

    const skipped = pickContext(
      [
        m(0, "asked"),
        m(1, "", { state: "cancelled" }),
        m(2, "again"),
        m(3, "half", { state: "failed" }),
        m(4, null),
        m(5, "gone", { deleted: true }),
        m(6, "summary", { author: "summary" }),
        m(7, "partial", { state: "cancelled" }),
      ],
      50,
    ).messages;
    expect(skipped.map((p) => p.id)).toEqual([0, 2, 7]);

    expect(pickContext(many, 10).messages.map((p) => p.id)).toEqual(Array.from({ length: 10 }, (_, i) => i + 70));
    const big = pickContext([m(0, "a".repeat(300 * 1024)), m(1, "b".repeat(300 * 1024)), m(2, "c")], 50).messages;
    expect(big.map((p) => p.id)).toEqual([1, 2]);
  });
});

describe("titles", () => {
  it("takes a summary's title line off its text, hiding it while it streams", () => {
    expect(splitTitle("<title>Trip</title>\nThe summary")).toEqual({ title: "Trip", body: "The summary" });
    expect(splitTitle("<title>Trip</title> The summary")).toEqual({ title: "Trip", body: "The summary" });
    expect(splitTitle("<tit")).toEqual({ body: "" });
    expect(splitTitle("<title>Tr")).toEqual({ body: "" });
    // A tag left open ends with its line.
    expect(splitTitle("<title>Trip\nThe summary")).toEqual({ title: "Trip", body: "The summary" });
    expect(splitTitle("No title here")).toEqual({ body: "No title here" });
    expect(splitTitle("")).toEqual({ body: "" });
  });

  it("keeps one unwrapped line of a model's title", () => {
    expect(autoTitle('  "Paris trip."  \nmore')).toBe("Paris trip");
    expect(autoTitle("**«План поездки»**")).toBe("План поездки");
    expect(autoTitle("# A  spaced   title")).toBe("A spaced title");
    expect(autoTitle("<title>Tagged</title>")).toBe("Tagged");
    expect(autoTitle(' " ')).toBe("");
    expect([...autoTitle("w".repeat(100))].length).toBeLessThanOrEqual(60);
  });
});
