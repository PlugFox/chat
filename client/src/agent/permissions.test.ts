import { describe, expect, it, vi } from "vitest";
import { readTools } from "../chats/records";
import type { Metric, PermissionRequest, RegisterEntry } from "../protocol/generated/protocol";
import type { OpenedEntry } from "../registers/registers";
import { TransportError } from "../transport/socket";
import {
  AnswerFailed,
  daySpan,
  localTime,
  Permissions,
  RESULT_MAX,
  type RegisterSource,
  registerResult,
} from "./permissions";

const WEIGHT: Metric = {
  key: "body.weight",
  category: "body",
  register: "measurements",
  names: { en: "Weight" },
  unit: "kg",
  quantity: "mass",
  value_type: "decimal",
  precision: 1,
  min: 1,
  max: 500,
  aggregate: "avg",
};
const SCOPE = "0190d2c4-8b7e-7000-8000-0000000000a1";
/** 2026-03-01T00:00:00Z. */
const MARCH = 1_772_323_200;

function entry(occurredAt: number, value: number, tz = 0, comment = ""): OpenedEntry {
  const info: RegisterEntry = {
    entry_id: `e-${occurredAt}`,
    metric: WEIGHT.key,
    occurred_at: occurredAt,
    value: new Uint8Array(),
    updated_at: 0,
    rev: 1,
  };
  return { info, value: { kind: "value", value, tz, comment, raw: {} } };
}

function request(id: string, grant: PermissionRequest["grant"]): PermissionRequest {
  return {
    request_id: id,
    chat_id: "chat",
    turn_id: "turn",
    provider_id: "provider",
    grant,
    reason: new Uint8Array([1]),
    expires_at: 0,
  };
}

const READ: PermissionRequest["grant"] = {
  tool: "read_register",
  metric: WEIGHT.key,
  scope_id: SCOPE,
  from: "2026-03-01",
  to: "2026-03-01",
};

function setup(options: { notFound?: boolean; offline?: boolean } = {}) {
  const read = vi.fn(async () => ({ entries: [entry(MARCH + 3600, 72.5, 60, "after run")], more: false }));
  const source: RegisterSource = {
    metric: (key) => (key === WEIGHT.key ? WEIGHT : undefined),
    register: (key) => (key === WEIGHT.key ? { metric: key, scope_id: SCOPE, entries: 1 } : undefined),
    read,
  };
  const sent: Record<string, unknown>[] = [];
  const pending: PermissionRequest[] = [];
  const requestFn = vi.fn(async (type: string, payload: Record<string, unknown>) => {
    if (type === "permission.pending") return { requests: pending };
    if (options.offline) throw new TransportError("unavailable", "offline", true);
    if (options.notFound) throw new TransportError("permission.not_found", "gone", false);
    sent.push(payload);
    return {};
  });
  const permissions = new Permissions({
    request: requestFn as never,
    openReason: async (id) => {
      if (id === "unreadable") throw new Error("no");
      return `reason of ${id}`;
    },
    registers: async () => source,
  });
  return { permissions, sent, pending, read };
}

describe("grant results", () => {
  it("covers every offset of the days asked for", () => {
    expect(daySpan("2026-03-01", "2026-03-01")).toEqual({ from: MARCH - 14 * 3600, to: MARCH + 86_400 + 14 * 3600 });
    expect(daySpan()).toEqual({});
    expect(localTime(MARCH, 90)).toBe("2026-03-01T01:30:00+01:30");
    expect(localTime(MARCH, -300)).toBe("2026-02-28T19:00:00-05:00");
  });

  it("keeps the entries of those days by their own offset, newest first", () => {
    const entries = [
      entry(MARCH + 7200, 72, 0, "morning"),
      // 23:00 UTC on 28 February, but 1 March where it was recorded.
      entry(MARCH - 3600, 73, 120),
      // 1 March 01:00 UTC, but 28 February where it was recorded.
      entry(MARCH + 3600, 74, -180),
    ];
    const result = JSON.parse(registerResult(WEIGHT, { entries, more: false }, "2026-03-01", "2026-03-01"));
    expect(result).toEqual({
      metric: "body.weight",
      unit: "kg",
      aggregate: "avg",
      entries: [
        { at: "2026-03-01T02:00:00+00:00", value: 72, comment: "morning" },
        { at: "2026-03-01T01:00:00+02:00", value: 73 },
      ],
    });
  });

  it("drops the oldest to fit, and says so", () => {
    const comment = "x".repeat(400);
    const entries = Array.from({ length: 1000 }, (_, i) => entry(MARCH - i * 60, 70, 0, comment));
    const text = registerResult(WEIGHT, { entries, more: false });
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(RESULT_MAX);
    const result = JSON.parse(text);
    expect(result.truncated).toBe(true);
    expect(result.entries.length).toBeGreaterThan(100);
    expect(result.entries[0].at).toBe("2026-03-01T00:00:00+00:00");
    // A full page is truncated even when it fits.
    expect(JSON.parse(registerResult(WEIGHT, { entries: entries.slice(0, 2), more: true })).truncated).toBe(true);
  });
});

describe("permission requests", () => {
  it("shows a request once with its reason and sends the result it approves", async () => {
    const { permissions, sent, read } = setup();
    await permissions.receive(request("a", READ));
    await permissions.receive(request("a", READ));
    expect(permissions.list.map((a) => [a.request.request_id, a.reason])).toEqual([["a", "reason of a"]]);
    await permissions.approve("a");
    expect(read).toHaveBeenCalledWith(WEIGHT.key, MARCH - 14 * 3600, MARCH + 86_400 + 14 * 3600);
    expect(sent[0]?.["decision"]).toBe("approve");
    expect(JSON.parse(sent[0]?.["result"] as string).entries).toEqual([
      { at: "2026-03-01T02:00:00+01:00", value: 72.5, comment: "after run" },
    ]);
    expect(permissions.list).toEqual([]);
  });

  it("refuses a register it does not know without showing it", async () => {
    const { permissions, sent } = setup();
    await permissions.receive(request("a", { ...READ, scope_id: "0190d2c4-8b7e-7000-8000-0000000000ff" }));
    await permissions.receive(request("b", { ...READ, metric: "body.mood" }));
    expect(permissions.list).toEqual([]);
    expect(sent.map((p) => [p["request_id"], p["decision"]])).toEqual([
      ["a", "refuse"],
      ["b", "refuse"],
    ]);
  });

  it("denies without a result, and a session request needs none", async () => {
    const { permissions, sent } = setup();
    await permissions.receive(request("a", { tool: "session_context" }));
    await permissions.receive(request("unreadable", { tool: "session_context" }));
    expect(permissions.list.map((a) => a.reason)).toEqual(["reason of a", null]);
    await permissions.deny("a");
    await permissions.approve("unreadable");
    expect(sent).toEqual([
      { request_id: "a", decision: "deny" },
      { request_id: "unreadable", decision: "approve" },
    ]);
  });

  it("forgets a request that ended, even one it hears of late", async () => {
    const { permissions, pending } = setup();
    permissions.resolved("late");
    await permissions.receive(request("late", { tool: "session_context" }));
    pending.push(request("waiting", { tool: "session_context" }));
    await permissions.load();
    expect(permissions.list.map((a) => a.request.request_id)).toEqual(["waiting"]);
    permissions.resolved("waiting");
    expect(permissions.list).toEqual([]);
  });

  it("drops an answer the server no longer waits for, and keeps one that did not go out", async () => {
    const gone = setup({ notFound: true });
    await gone.permissions.receive(request("a", { tool: "session_context" }));
    await gone.permissions.deny("a");
    expect(gone.permissions.list).toEqual([]);
    const offline = setup({ offline: true });
    await offline.permissions.receive(request("a", { tool: "session_context" }));
    await expect(offline.permissions.deny("a")).rejects.toBeInstanceOf(AnswerFailed);
    expect(offline.permissions.list.length).toBe(1);
  });
});

describe("a reply's tool calls", () => {
  it("reads what it knows and leaves out the rest", () => {
    expect(
      readTools([
        { tool: "read_register", metric: "body.weight", from: "2026-03-01", outcome: "approved", extra: 1 },
        { tool: "session_context" },
        { tool: "list_metrics", outcome: "maybe" },
        { metric: "x" },
        "text",
      ]),
    ).toEqual([
      { tool: "read_register", metric: "body.weight", from: "2026-03-01", outcome: "approved" },
      { tool: "session_context" },
      { tool: "list_metrics" },
    ]);
    expect(readTools(undefined)).toEqual([]);
  });
});
