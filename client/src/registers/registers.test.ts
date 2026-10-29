import { encode } from "@msgpack/msgpack";
import { describe, expect, it, vi } from "vitest";
import type { Metric, RegisterEntry, RegisterInfo } from "../protocol/generated/protocol";
import { TransportError } from "../transport/socket";
import { byDay, checkValue, dayOf, formatValue, localName, parseValue } from "./catalog";
import { decodeValue, encodeValue } from "./records";
import { Conflict, type RegisterKeys, Registers, type Request } from "./registers";

/** "Sealing" is a version byte, a marker and the plaintext; the fake opens only its own records. */
const keys: RegisterKeys = {
  createRegister: async () => ({ publicKey: new Uint8Array(32), wrappedPrivateKey: new Uint8Array(8) }),
  sealRegister: async (_scope, _kind, plaintext) => new Uint8Array([1, 0xaa, ...plaintext]),
  openRegister: async (_scope, kind, record) => {
    if (record[1] !== 0xaa) throw new Error("decryption failed");
    expect(kind.granularity).toBe("instant");
    return record.slice(2);
  },
};
const sealed = (value: number, tz = 0) => new Uint8Array([1, 0xaa, ...encodeValue({ value, tz, comment: "" })]);

const metric = (key: string, aggregate: string, extra: Partial<Metric> = {}): Metric => ({
  key,
  category: "body",
  register: "measurements",
  names: { en: key, ru: `ru ${key}` },
  unit: "kg",
  quantity: "mass",
  value_type: "decimal",
  precision: 1,
  min: 1,
  max: 500,
  aggregate,
  ...extra,
});
const WEIGHT = metric("body.weight", "avg");
const STEPS = metric("activity.steps", "sum", { value_type: "integer", precision: 0, min: 0, max: 200000 });
const DAY = 1_700_000_000 - (1_700_000_000 % 86400);

/** A fake server holding one account's registers. */
function server(options: { parts?: boolean; conflict?: boolean } = {}) {
  const registers = new Map<string, RegisterInfo>();
  const entries = new Map<string, RegisterEntry>();
  const calls: string[] = [];
  const request = vi.fn(async (type: string, p: Record<string, unknown>, o?: { onPart?: (x: unknown) => void }) => {
    calls.push(type);
    switch (type) {
      case "metric.list":
        return {
          categories: [{ key: "body", names: { en: "Body" } }],
          metrics: [WEIGHT, STEPS, metric("sleep.phases", "sum", { register: "intervals" })],
          registers: [...registers.values()].map((r) => {
            const mine = [...entries.values()].filter((e) => e.metric === r.metric);
            const latest = Math.max(...mine.map((e) => e.occurred_at));
            return { ...r, entries: mine.length, ...(mine.length > 0 ? { latest_at: latest } : {}) };
          }),
        };
      case "register.setup": {
        const m = p["metric"] as string;
        if (!registers.has(m)) registers.set(m, { metric: m, scope_id: p["scope_id"] as string, entries: 0 });
        return { scope_id: registers.get(m)?.scope_id };
      }
      case "register.entries": {
        const from = (p["from"] as number | undefined) ?? Number.NEGATIVE_INFINITY;
        const list = [...entries.values()]
          .filter((e) => e.metric === p["metric"] && e.occurred_at >= from)
          .sort((a, b) => b.occurred_at - a.occurred_at);
        if (options.parts && list.length > 1) {
          o?.onPart?.({ entries: list.slice(0, 1) });
          // A resend delivers its parts again.
          o?.onPart?.({ entries: list.slice(0, 1) });
          return { entries: list.slice(1) };
        }
        return { entries: list };
      }
      case "register.create": {
        const entry: RegisterEntry = {
          entry_id: p["entry_id"] as string,
          metric: p["metric"] as string,
          occurred_at: p["occurred_at"] as number,
          value: p["value"] as Uint8Array,
          updated_at: 1,
          rev: 1,
        };
        entries.set(entry.entry_id, entry);
        return { entry };
      }
      case "register.update": {
        const known = entries.get(p["entry_id"] as string);
        if (!known) throw new TransportError("register.not_found", "gone");
        if (options.conflict || known.rev !== p["rev"]) throw new TransportError("register.conflict", "conflict");
        const entry = {
          ...known,
          occurred_at: p["occurred_at"] as number,
          value: p["value"] as Uint8Array,
          rev: known.rev + 1,
        };
        entries.set(entry.entry_id, entry);
        return { entry };
      }
      case "register.delete":
        entries.delete(p["entry_id"] as string);
        return {};
      default:
        throw new Error(type);
    }
  });
  return { request: request as unknown as Request, registers, entries, calls };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("register records", () => {
  it("keep fields they do not know, drop an empty comment and refuse what is not a value", () => {
    const read = decodeValue(encodeValue({ value: 80.5, tz: 180, comment: " fasting " }, { source: "scale" }));
    expect(read).toMatchObject({ ok: true, value: 80.5, tz: 180, comment: "fasting", raw: { source: "scale" } });
    expect(decodeValue(encodeValue({ value: 1, tz: 0, comment: "  " }))).toMatchObject({ ok: true, comment: "" });
    const long = decodeValue(encodeValue({ value: 1, tz: 0, comment: "ж".repeat(400) }));
    expect(long.ok && new TextEncoder().encode(long.comment).length).toBe(500);
    for (const bad of [{ value: "80", tz: 0 }, { value: 80, tz: 900 }, { value: 80 }, { value: 80, tz: 0.5 }]) {
      expect(decodeValue(encode(bad))).toEqual({ ok: false, reason: "parse" });
    }
    expect(decodeValue(encode({ value: 1, tz: 0, comment: "ж".repeat(251) }))).toEqual({ ok: false, reason: "size" });
    expect(decodeValue(new Uint8Array([0xc1]))).toEqual({ ok: false, reason: "parse" });
  });
});

describe("the catalog", () => {
  it("names a metric in the locale, its language, English or by key", () => {
    expect(localName({ en: "Weight", ru: "Вес" }, "ru-RU", "body.weight")).toBe("Вес");
    expect(localName({ en: "Weight" }, "de", "body.weight")).toBe("Weight");
    expect(localName({}, "de", "body.weight")).toBe("body.weight");
  });

  it("reads typed values and checks them against the metric", () => {
    expect(parseValue("80,5")).toBe(80.5);
    expect(parseValue(" 10 000 ")).toBe(10000);
    expect(parseValue("8e1")).toBeNull();
    expect(parseValue("")).toBeNull();
    expect(checkValue(WEIGHT, 80.5)).toBeNull();
    expect(checkValue(WEIGHT, 80.55)).toBe("precision");
    expect(checkValue(WEIGHT, 0.5)).toBe("range");
    expect(checkValue(STEPS, 10.5)).toBe("integer");
    expect(checkValue(STEPS, 200001)).toBe("range");
    expect(formatValue(WEIGHT, 80.15000001, "en")).toBe("80.2");
  });

  it("makes one value a day at the offset each entry was recorded with", () => {
    // 23:30 UTC is the next day three hours east.
    expect(dayOf(DAY + 23.5 * 3600, 0)).not.toBe(dayOf(DAY + 23.5 * 3600, 180));
    const entries = [
      { occurredAt: DAY + 3600, tz: 0, value: 80 },
      { occurredAt: DAY + 7200, tz: 0, value: 81 },
      { occurredAt: DAY - 3600, tz: 0, value: 79 },
    ];
    expect(byDay(entries, "avg").map((d) => [d.value, d.entries])).toEqual([
      [79, 1],
      [80.5, 2],
    ]);
    expect(byDay(entries, "sum").map((d) => d.value)).toEqual([79, 161]);
  });
});

describe("Registers", () => {
  it("creates a metric's scope with its first entry and pages entries in parts", async () => {
    const s = server({ parts: true });
    const registers = new Registers(s.request, keys);
    await registers.load();
    expect(registers.metrics.map((m) => m.key)).toEqual(["body.weight", "activity.steps"]);
    expect(registers.latest("body.weight")).toEqual({ kind: "ready", day: null });

    await registers.create("body.weight", DAY + 3600, { value: 80, tz: 0, comment: "" });
    await registers.create("body.weight", DAY + 7200, { value: 81, tz: 0, comment: "" });
    expect(s.calls.filter((c) => c === "register.setup")).toHaveLength(1);
    await registers.load();
    expect(registers.register("body.weight")?.entries).toBe(2);

    const history = registers.history("body.weight");
    await settle();
    await settle();
    expect(history.state.kind).toBe("ready");
    expect(history.list.map((e) => (e.value.kind === "value" ? e.value.value : null))).toEqual([81, 80]);

    expect(registers.latest("body.weight").kind).toBe("loading");
    await settle();
    await settle();
    expect(registers.latest("body.weight")).toMatchObject({ kind: "ready", day: { value: 80.5, entries: 2 } });
  });

  it("shows an entry it cannot open as unreadable", async () => {
    const s = server();
    const registers = new Registers(s.request, keys);
    await registers.load();
    await registers.create("activity.steps", DAY, { value: 100, tz: 0, comment: "" });
    const [stored] = s.entries.values();
    if (stored) stored.value = new Uint8Array([1, 0xbb, 0]);
    s.entries.set("x", { ...(stored as RegisterEntry), entry_id: "x", value: new Uint8Array([2, 0xaa]) });
    await registers.load();
    const page = await registers.page("activity.steps", undefined);
    expect(page.entries.map((e) => e.value)).toEqual(
      expect.arrayContaining([
        { kind: "unreadable", reason: "decrypt" },
        { kind: "unreadable", reason: "version" },
      ]),
    );
  });

  it("keeps the stored entry when another device changed it first", async () => {
    const s = server({ conflict: true });
    const registers = new Registers(s.request, keys);
    await registers.load();
    const entry = await registers.create("body.weight", DAY, { value: 80, tz: 0, comment: "" });
    await expect(registers.update(entry, DAY, { value: 82, tz: 0, comment: "" })).rejects.toBeInstanceOf(Conflict);
    const [stored] = s.entries.values();
    expect(stored?.rev).toBe(1);
  });

  it("follows events of other devices", async () => {
    const s = server();
    const registers = new Registers(s.request, keys);
    await registers.load();
    await registers.create("body.weight", DAY, { value: 80, tz: 0, comment: "" });
    const history = registers.history("body.weight");
    await settle();
    await settle();
    const other: RegisterEntry = {
      entry_id: "00000000-0000-7000-8000-000000000002",
      metric: "body.weight",
      occurred_at: DAY + 60,
      value: sealed(79, 60),
      updated_at: 2,
      rev: 1,
    };
    registers.updated(other);
    await settle();
    expect(history.list.map((e) => e.info.entry_id)[0]).toBe(other.entry_id);
    registers.deleted(other.entry_id, "body.weight");
    expect(history.list).toHaveLength(1);
  });
});
