import { describe, expect, it, vi } from "vitest";
import { readTools } from "../chats/records";
import type { Metric, PermissionRequest, RegisterEntry } from "../protocol/generated/protocol";
import type { OpenedEntry } from "../registers/registers";
import { TransportError } from "../transport/socket";
import {
  AnswerFailed,
  daySpan,
  FILES_PER_TURN,
  localTime,
  Permissions,
  proposedMoment,
  RESULT_MAX,
  type RegisterSource,
  readProposal,
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

function setup(
  options: {
    notFound?: boolean;
    offline?: boolean;
    history?: () => Promise<string | null>;
    fileKey?: (chat: string, file: string) => Promise<string | null>;
    reason?: string;
    create?: RegisterSource["create"];
  } = {},
) {
  const read = vi.fn(async () => ({ entries: [entry(MARCH + 3600, 72.5, 60, "after run")], more: false }));
  const source: RegisterSource = {
    metric: (key) => (key === WEIGHT.key ? WEIGHT : undefined),
    register: (key) => (key === WEIGHT.key ? { metric: key, scope_id: SCOPE, entries: 1 } : undefined),
    read,
    create: options.create ?? vi.fn(async () => entry(MARCH, 0)),
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
      return options.reason ?? `reason of ${id}`;
    },
    registers: async () => source,
    history: vi.fn(options.history ?? (async () => '{"messages":[]}')),
    // This tab started the turn "turn" in the chat "chat".
    turnChat: async (turnId) => (turnId === "turn" ? "chat" : undefined),
    runCode: vi.fn(async () => '{"output":""}'),
    fileKey: vi.fn(options.fileKey ?? (async (_chat: string, file: string) => (file === "known" ? "a2V5" : null))),
  });
  return { permissions, sent, pending, read, source };
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

describe("history reads", () => {
  const HISTORY: PermissionRequest["grant"] = { tool: "read_history", before: 61, count: 20 };

  it("answers without showing anything, once for the event and the pending list", async () => {
    const { permissions, sent, pending } = setup();
    pending.push(request("h", HISTORY));
    await Promise.all([permissions.receive(request("h", HISTORY)), permissions.load()]);
    expect(permissions.list).toEqual([]);
    expect(sent).toEqual([{ request_id: "h", decision: "answer", result: '{"messages":[]}' }]);
  });

  it("refuses a chat that does not open, and leaves a failed fetch to time out", async () => {
    const closed = setup({ history: async () => null });
    await closed.permissions.receive(request("h", HISTORY));
    expect(closed.sent).toEqual([{ request_id: "h", decision: "refuse" }]);
    const offline = setup({
      history: async () => {
        throw new TransportError("unavailable", "offline", true);
      },
    });
    await offline.permissions.receive(request("h", HISTORY));
    expect(offline.sent).toEqual([]);
    expect(offline.permissions.list).toEqual([]);
    const gone = setup({
      history: async () => {
        throw new TransportError("chat.not_found", "gone", false);
      },
    });
    await gone.permissions.receive(request("h", HISTORY));
    expect(gone.sent).toEqual([{ request_id: "h", decision: "refuse" }]);
  });

  it("answers only a turn this tab started, in its own chat, within the limits", async () => {
    const { permissions, sent } = setup({ history: async () => `{"messages":[],"pad":"${"x".repeat(40_000)}"}` });
    await permissions.receive({ ...request("other-turn", HISTORY), turn_id: "elsewhere" });
    await permissions.receive({ ...request("other-chat", HISTORY), chat_id: "another" });
    expect(sent).toEqual([]);
    await permissions.receive(request("many", { tool: "read_history", before: 61, count: 500 }));
    // 40 KB each: three fit in 128 KiB, the fourth is refused.
    await Promise.all(["a", "b", "c", "d"].map((id) => permissions.receive(request(id, HISTORY))));
    expect(sent.map((p) => [p["request_id"], p["decision"]])).toEqual([
      ["many", "refuse"],
      ["a", "answer"],
      ["b", "answer"],
      ["c", "answer"],
      ["d", "refuse"],
    ]);
  });
});

describe("file reads", () => {
  const FILE = (file_id: string): PermissionRequest["grant"] => ({ tool: "read_file", file_id });

  it("answers with the key of a file of the turn's chat, unseen, and refuses one that does not open", async () => {
    const { permissions, sent, pending } = setup();
    pending.push(request("f", FILE("known")));
    await Promise.all([permissions.receive(request("f", FILE("known"))), permissions.load()]);
    await permissions.receive(request("g", FILE("elsewhere")));
    expect(permissions.list).toEqual([]);
    expect(sent).toEqual([
      { request_id: "f", decision: "answer", result: "a2V5" },
      { request_id: "g", decision: "refuse" },
    ]);
  });

  it("answers only a turn this tab started, in its chat, and a few files a turn", async () => {
    const { permissions, sent } = setup();
    await permissions.receive({ ...request("other-turn", FILE("known")), turn_id: "elsewhere" });
    await permissions.receive({ ...request("other-chat", FILE("known")), chat_id: "another" });
    expect(sent).toEqual([]);
    // Received together, as a server that floods asks: the limit holds all the same.
    await Promise.all(
      Array.from({ length: FILES_PER_TURN + 3 }, (_, i) => permissions.receive(request(`f${i}`, FILE("known")))),
    );
    expect(sent.filter((p) => p["decision"] === "answer")).toHaveLength(FILES_PER_TURN);
    expect(sent.filter((p) => p["decision"] === "refuse")).toHaveLength(3);
  });

  it("leaves a fetch that failed to time out", async () => {
    const offline = setup({
      fileKey: async () => {
        throw new TransportError("unavailable", "offline", true);
      },
    });
    await offline.permissions.receive(request("f", FILE("known")));
    expect(offline.sent).toEqual([]);
  });
});

describe("a reply's tool calls", () => {
  it("reads what it knows and leaves out the rest", () => {
    expect(
      readTools([
        { tool: "read_register", metric: "body.weight", from: "2026-03-01", outcome: "approved", extra: 1 },
        { tool: "session_context" },
        { tool: "list_metrics", outcome: "maybe" },
        { tool: "read_history", count: 12, outcome: "answered" },
        { tool: "read_history", count: -1 },
        { metric: "x" },
        "text",
      ]),
    ).toEqual([
      { tool: "read_register", metric: "body.weight", from: "2026-03-01", outcome: "approved" },
      { tool: "session_context" },
      { tool: "list_metrics" },
      { tool: "read_history", count: 12, outcome: "answered" },
      { tool: "read_history" },
    ]);
    expect(readTools(undefined)).toEqual([]);
  });
});

describe("entries the agent proposes", () => {
  const ADD: PermissionRequest["grant"] = { tool: "add_measurement", metric: WEIGHT.key };
  const NOW = new Date(2026, 2, 10, 9, 0);

  it("reads only a well-formed proposal", () => {
    expect(readProposal('{"reason":"r","value":115.5,"day":"2026-03-01","comment":"c","next":1}')).toEqual({
      reason: "r",
      value: 115.5,
      day: "2026-03-01",
      comment: "c",
    });
    expect(readProposal('{"value":1}')).toEqual({ reason: "", value: 1, comment: "" });
    for (const bad of [
      "not json",
      "[]",
      "{}",
      '{"value":"1"}',
      '{"value":1,"day":"2026-02-30"}',
      '{"value":1,"comment":5}',
    ]) {
      expect(readProposal(bad), bad).toBeNull();
    }
  });

  it("takes the present moment today, noon before it, and refuses days to come", () => {
    const now = Math.floor(NOW.getTime() / 1000);
    expect(proposedMoment(undefined, NOW)?.occurredAt).toBe(now);
    expect(proposedMoment("2026-03-10", NOW)?.occurredAt).toBe(now);
    expect(proposedMoment("2026-03-01", NOW)?.occurredAt).toBe(Math.floor(new Date(2026, 2, 1, 12).getTime() / 1000));
    expect(proposedMoment("2026-03-11", NOW)).toBeNull();
  });

  it("stores the entry under the request's id on approval and answers with it", async () => {
    const create = vi.fn(async () => entry(MARCH, 0));
    const { permissions, sent } = setup({ reason: '{"reason":"You said","value":115,"comment":"Morning"}', create });
    await permissions.receive(request("add-1", ADD));
    const asked = permissions.list[0];
    expect(asked?.reason).toBe("You said");
    expect(asked?.proposal).toMatchObject({ value: 115, comment: "Morning" });
    expect(create).not.toHaveBeenCalled();
    await permissions.approve("add-1");
    expect(create).toHaveBeenCalledWith(
      WEIGHT.key,
      expect.any(Number),
      expect.objectContaining({ value: 115 }),
      "add-1",
    );
    expect(sent[0]).toMatchObject({ request_id: "add-1", decision: "approve" });
    expect(JSON.parse(String(sent[0]?.["result"]))).toMatchObject({ recorded: true, unit: "kg", value: 115 });
    expect(permissions.list).toEqual([]);
  });

  it("stores nothing when denied", async () => {
    const create = vi.fn(async () => entry(MARCH, 0));
    const { permissions, sent } = setup({ reason: '{"value":115}', create });
    await permissions.receive(request("add-2", ADD));
    await permissions.deny("add-2");
    expect(create).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({ decision: "deny" });
  });

  it("refuses what it would not store, without a dialog", async () => {
    for (const reason of ["not json", '{"value":99999}', '{"value":70.55}', '{"value":70,"day":"2999-01-01"}']) {
      const { permissions, sent } = setup({ reason });
      await permissions.receive(request("add-3", ADD));
      expect(permissions.list, reason).toEqual([]);
      expect(sent[0], reason).toMatchObject({ decision: "refuse" });
    }
    const { permissions, sent } = setup({ reason: '{"value":70}' });
    await permissions.receive(request("add-4", { tool: "add_measurement", metric: "no.such" }));
    expect(permissions.list).toEqual([]);
    expect(sent[0]).toMatchObject({ decision: "refuse" });
  });

  it("counts the day's entries, and an entry already stored is not an error", async () => {
    const create = vi.fn(async () => {
      throw new TransportError("register.exists", "exists", false);
    });
    const { permissions, sent, read } = setup({ reason: '{"value":72,"day":"2026-03-01"}', create });
    await permissions.receive(request("add-5", ADD));
    expect(read).toHaveBeenCalled();
    expect(permissions.list[0]?.proposal?.sameDay).toBe(1);
    await permissions.approve("add-5");
    expect(sent[0]).toMatchObject({ decision: "approve" });
    expect(JSON.parse(String(sent[0]?.["result"]))).toEqual({
      recorded: true,
      metric: WEIGHT.key,
      unit: "kg",
      value: 72,
      day: "2026-03-01",
    });
    expect(permissions.unstored).toBeNull();
  });

  it("writes nothing when the request already ended", async () => {
    const create = vi.fn(async () => entry(MARCH, 0));
    const { permissions } = setup({ reason: '{"value":72}', create, notFound: true });
    await permissions.receive(request("add-6", ADD));
    await permissions.approve("add-6");
    expect(create).not.toHaveBeenCalled();
    expect(permissions.list).toEqual([]);
  });

  it("drops what stopped waiting while away, so it cannot be approved", async () => {
    const create = vi.fn(async () => entry(MARCH, 0));
    const { permissions } = setup({ reason: '{"value":72}', create });
    await permissions.receive(request("add-7", ADD));
    await permissions.load();
    expect(permissions.list).toEqual([]);
    await permissions.approve("add-7");
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps the dialog when the approval is not sent, and writes nothing yet", async () => {
    const create = vi.fn(async () => entry(MARCH, 0));
    const { permissions } = setup({ reason: '{"value":72}', create, offline: true });
    await permissions.receive(request("add-8", ADD));
    await expect(permissions.approve("add-8")).rejects.toBeInstanceOf(AnswerFailed);
    expect(create).not.toHaveBeenCalled();
    expect(permissions.list).toHaveLength(1);
  });

  it("offers another try when saving fails after the approval", async () => {
    const create = vi.fn(async () => {
      if (create.mock.calls.length === 1) throw new TransportError("unavailable", "offline", true);
      return entry(MARCH, 0);
    });
    const { permissions } = setup({ reason: '{"value":72}', create });
    await permissions.receive(request("add-9", ADD));
    await permissions.approve("add-9");
    expect(permissions.unstored?.entryId).toBe("add-9");
    await permissions.retryStore();
    expect(create).toHaveBeenCalledTimes(2);
    expect(permissions.unstored).toBeNull();
  });

  it("shows a proposal when the day's count cannot be read, and allows multibyte comments", async () => {
    const { permissions, read } = setup({ reason: JSON.stringify({ value: 72, comment: "й".repeat(250) }) });
    read.mockRejectedValue(new Error("offline"));
    await permissions.receive(request("add-10", ADD));
    expect(permissions.list[0]?.proposal?.sameDay).toBe(0);
    expect(readProposal('{"value":1,"day":"0050-03-01"}')).toBeNull();
  });
});
