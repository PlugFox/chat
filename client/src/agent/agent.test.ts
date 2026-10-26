import { encode } from "@msgpack/msgpack";
import { describe, expect, it, vi } from "vitest";
import type { ProvidersValue, StoredProvider } from "../protocol/generated/protocol";
import { type SocketState, TransportError } from "../transport/socket";
import { Agent, type AgentDeps, decodeProviders, encodeProviders, fingerprint } from "./agent";

const OPEN: SocketState = { kind: "open", sessionId: "s1" };
const USER = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

function provider(id: string, model = "m"): StoredProvider {
  return { id, name: id, kind: "openai_compatible", base_url: "https://api.example/v1", api_key: "k", model };
}

/** A server holding one setting; "sealing" is the identity, with a marker byte the fake opens. */
function fixture(options: { refuse?: boolean } = {}) {
  let stored: { record: Uint8Array; rev: number } | undefined;
  const starts: unknown[] = [];
  /** What the socket holds on the server, as agent.start and agent.stop leave it. */
  const server: { session: string | null; model: string | null; stops: number } = {
    session: null,
    model: null,
    stops: 0,
  };
  /** While set, agent.start waits for it. */
  let gate: Promise<void> | null = null;
  const puts: (number | undefined)[] = [];
  const retired: Uint8Array[][] = [];
  /** Lets a test store a value "from another device" before the next put. */
  let before: (() => void) | undefined;
  const request = vi.fn(async (type: string, payload: unknown): Promise<unknown> => {
    switch (type) {
      case "settings.get":
        return stored ? { value: stored } : {};
      case "settings.put": {
        before?.();
        before = undefined;
        const p = payload as { record: Uint8Array; rev?: number };
        puts.push(p.rev);
        if (p.rev !== stored?.rev) throw new TransportError("settings.conflict", "conflict");
        stored = { record: p.record, rev: (stored?.rev ?? 0) + 1 };
        return { rev: stored.rev };
      }
      case "agent.start": {
        const provider = (payload as { provider: { model: string } }).provider;
        starts.push(provider);
        const n = starts.length;
        if (gate) await gate;
        if (options.refuse || provider.model === "refused")
          throw new TransportError("agent.invalid_provider", "refused");
        server.session = `a${n}`;
        server.model = provider.model;
        return { agent_session_id: `a${n}` };
      }
      case "agent.retire":
        retired.push((payload as { fingerprints: Uint8Array[] }).fingerprints);
        return {};
      case "agent.stop":
        server.session = null;
        server.model = null;
        server.stops += 1;
        return {};
      default:
        throw new Error(type);
    }
  });
  const deps: AgentDeps = {
    request: request as unknown as AgentDeps["request"],
    userId: USER,
    seal: async (plaintext) => new Uint8Array([1, ...plaintext]),
    open: async (record) => {
      if (record[0] !== 1) throw new Error("decryption failed");
      return record.slice(1);
    },
  };
  const store = (value: ProvidersValue) => {
    stored = { record: new Uint8Array([1, ...encodeProviders(value)]), rev: (stored?.rev ?? 0) + 1 };
    return stored;
  };
  return {
    agent: new Agent(deps),
    starts,
    puts,
    retired,
    server,
    store,
    stored: () => stored,
    hold: () => {
      let open = () => {};
      gate = new Promise((resolve) => {
        open = resolve;
      });
      return () => {
        gate = null;
        open();
      };
    },
    beforeNextPut: (f: () => void) => {
      before = f;
    },
  };
}

describe("decodeProviders", () => {
  it("leaves out entries it cannot use, and keeps an active id that names a stored entry", () => {
    const { value } = decodeProviders(
      encodeProviders({
        providers: [
          provider("a"),
          { ...provider("b"), kind: "gemini" as never },
          { ...provider("a"), name: "duplicate" },
          { id: "c" } as never,
        ],
        active: "b",
      }),
    );
    expect(value).toEqual({ providers: [provider("a")], active: "b" });
    const dangling = decodeProviders(encodeProviders({ providers: [provider("a")], active: "zz" }));
    expect(dangling.value).toEqual({ providers: [provider("a")] });
  });

  it("writes back what it could not read", () => {
    const later = {
      providers: [
        { ...provider("a"), headers: { x: 1 } },
        { ...provider("g"), kind: "gemini" },
      ],
      active: "g",
      per_chat: { c1: "a" },
    };
    const base = decodeProviders(encode(later));
    expect(base.value).toEqual({ providers: [provider("a")], active: "g" });
    const next = {
      ...base.value,
      providers: [{ ...provider("a"), name: "Renamed" }, provider("new")],
    };
    const written = decodeProviders(encodeProviders(next, base)).raw;
    expect(written).toEqual({
      providers: [
        { ...provider("a"), name: "Renamed", headers: { x: 1 } },
        { ...provider("g"), kind: "gemini" },
        provider("new"),
      ],
      active: "g",
      per_chat: { c1: "a" },
    });
    // Removing an entry it can read drops it; the one it cannot read stays.
    const removed = decodeProviders(encodeProviders({ providers: [], active: "g" }, base)).raw;
    expect(removed["providers"]).toEqual([{ ...provider("g"), kind: "gemini" }]);
  });
});

describe("fingerprint", () => {
  // The same vector is in server/src/agent.rs.
  it("matches the spec", async () => {
    const hash = await fingerprint("0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", {
      kind: "openai_compatible",
      base_url: "https://api.example.com/v1",
      api_key: "sk-test",
      model: "gpt-test",
    });
    expect(Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("")).toBe(
      "ec60e285e14c619ec61d3e36b6604ea66fbee3df211a61d41e49c45ad1f8b2b4",
    );
  });
});

describe("Agent", () => {
  it("starts the agent session with the active provider once loaded and connected", async () => {
    const t = fixture();
    t.store({ providers: [provider("a"), provider("b", "other")], active: "b" });
    await t.agent.load();
    expect(t.agent.state).toEqual({ kind: "idle" });
    t.agent.connected(OPEN);
    await vi.waitFor(() => expect(t.agent.state).toEqual({ kind: "ready" }));
    expect(t.starts).toEqual([
      { kind: "openai_compatible", base_url: "https://api.example/v1", api_key: "k", model: "other" },
    ]);
    expect(t.agent.sessionId).toBe("a1");
  });

  it("keeps a resumed session and starts again after a reconnect that did not resume", async () => {
    const t = fixture();
    t.store({ providers: [provider("a")], active: "a" });
    await t.agent.load();
    t.agent.connected(OPEN);
    await vi.waitFor(() => expect(t.agent.state).toEqual({ kind: "ready" }));
    t.agent.connected({ kind: "open", sessionId: "s1", agentSessionId: "a1" });
    await vi.waitFor(() => expect(t.agent.state).toEqual({ kind: "ready" }));
    expect(t.starts).toHaveLength(1);
    t.agent.connected(OPEN);
    await vi.waitFor(() => expect(t.starts).toHaveLength(2));
    expect(t.agent.sessionId).toBe("a2");
  });

  it("says when there is no provider and when the server refuses one", async () => {
    const none = fixture();
    await none.agent.load();
    none.agent.connected(OPEN);
    await vi.waitFor(() => expect(none.agent.state).toEqual({ kind: "none" }));
    const refused = fixture({ refuse: true });
    refused.store({ providers: [provider("a")], active: "a" });
    await refused.agent.load();
    refused.agent.connected(OPEN);
    await vi.waitFor(() => expect(refused.agent.state).toEqual({ kind: "refused" }));
    expect(refused.agent.sessionId).toBeUndefined();
  });

  it("stores a change and restarts the session when the active provider changes", async () => {
    const t = fixture();
    await t.agent.load();
    t.agent.connected(OPEN);
    await t.agent.update((v) => ({ providers: [...v.providers, provider("a")], active: "a" }));
    await vi.waitFor(() => expect(t.agent.state).toEqual({ kind: "ready" }));
    expect(t.puts).toEqual([undefined]);
    // Renaming is not a change the agent session cares about.
    await t.agent.update((v) => ({ ...v, providers: v.providers.map((p) => ({ ...p, name: "Renamed" })) }));
    await t.agent.update((v) => ({ ...v, providers: v.providers.map((p) => ({ ...p, model: "new" })) }));
    await vi.waitFor(() => expect(t.starts).toHaveLength(2));
    expect(t.agent.providers).toMatchObject({ kind: "ready", rev: 3 });
  });

  it("applies a change again on top of what another device stored first", async () => {
    const t = fixture();
    t.store({ providers: [provider("a")] });
    await t.agent.load();
    t.beforeNextPut(() => t.store({ providers: [provider("a"), provider("theirs")] }));
    await t.agent.update((v) => ({ providers: [...v.providers, provider("mine")] }));
    expect(t.puts).toEqual([1, 2]);
    const state = t.agent.providers;
    expect(state.kind === "ready" && state.value.providers.map((p) => p.id)).toEqual(["a", "theirs", "mine"]);
  });

  it("takes newer values from events and ignores older ones", async () => {
    const t = fixture();
    t.store({ providers: [provider("a")] });
    const two = t.store({ providers: [provider("a"), provider("b")] });
    await t.agent.load();
    const old = { key: "providers", record: new Uint8Array([1, ...encodeProviders({ providers: [] })]), rev: 1 };
    await t.agent.receive(old);
    await t.agent.receive({ key: "other", ...two, rev: 9 });
    expect(t.agent.providers).toMatchObject({ kind: "ready", rev: 2 });
    const three = { key: "providers", record: new Uint8Array([1, ...encodeProviders({ providers: [] })]), rev: 3 };
    await t.agent.receive(three);
    expect(t.agent.providers).toEqual({ kind: "ready", value: { providers: [] }, rev: 3 });
  });

  it("ends with the server holding what the latest change asked for", async () => {
    const t = fixture();
    t.store({ providers: [provider("a")], active: "a" });
    await t.agent.load();
    t.agent.connected(OPEN);
    await vi.waitFor(() => expect(t.agent.state).toEqual({ kind: "ready" }));
    const release = t.hold();
    const model = (m: string) =>
      t.agent.update((v) => ({ ...v, providers: v.providers.map((p) => ({ ...p, model: m })) }));
    await model("q");
    await model("m");
    release();
    await vi.waitFor(() => expect(t.server.model).toBe("m"));
    await vi.waitFor(() => expect(t.agent.state).toEqual({ kind: "ready" }));
    expect(t.agent.sessionId).toBe(t.server.session);
  });

  it("stops the session when no provider is active any more", async () => {
    const t = fixture();
    t.store({ providers: [provider("a")], active: "a" });
    await t.agent.load();
    t.agent.connected(OPEN);
    await vi.waitFor(() => expect(t.server.session).toBe("a1"));
    await t.agent.update(() => ({ providers: [] }));
    await vi.waitFor(() => expect(t.server.session).toBeNull());
    expect(t.agent.state).toEqual({ kind: "none" });
    expect(t.agent.sessionId).toBeUndefined();
  });

  it("retires the configs a change removes or replaces, and no others", async () => {
    const t = fixture();
    t.store({ providers: [provider("a"), provider("b", "other")], active: "a" });
    await t.agent.load();
    // Adding, renaming and switching keep every config.
    await t.agent.update((v) => ({ ...v, providers: [...v.providers, provider("c", "third")] }));
    await t.agent.update((v) => ({ ...v, providers: v.providers.map((p) => ({ ...p, name: "Renamed" })) }));
    await t.agent.update((v) => ({ ...v, active: "b" }));
    expect(t.retired).toEqual([]);
    await t.agent.update((v) => ({
      ...v,
      providers: v.providers.map((p) => (p.id === "a" ? { ...p, api_key: "new" } : p)),
    }));
    await t.agent.update((v) => ({ ...v, providers: v.providers.filter((p) => p.id !== "b" && p.id !== "c") }));
    expect(t.retired).toEqual([
      [await fingerprint(USER, provider("a"))],
      [await fingerprint(USER, provider("b", "other")), await fingerprint(USER, provider("c", "third"))],
    ]);
  });

  it("ends its session when closed, also one still starting", async () => {
    const t = fixture();
    t.store({ providers: [provider("a")], active: "a" });
    await t.agent.load();
    const release = t.hold();
    t.agent.connected(OPEN);
    await vi.waitFor(() => expect(t.starts).toHaveLength(1));
    t.agent.close();
    release();
    await vi.waitFor(() => expect(t.server.stops).toBe(1));
    expect(t.server.session).toBeNull();
    expect(t.agent.sessionId).toBeUndefined();
    // Nothing starts it again.
    t.agent.connected({ ...OPEN });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(t.starts).toHaveLength(1);
  });

  it("stops the previous session when the server refuses the new provider", async () => {
    const t = fixture();
    t.store({ providers: [provider("a")], active: "a" });
    await t.agent.load();
    t.agent.connected(OPEN);
    await vi.waitFor(() => expect(t.server.session).toBe("a1"));
    await t.agent.update((v) => ({ ...v, providers: v.providers.map((p) => ({ ...p, model: "refused" })) }));
    await vi.waitFor(() => expect(t.agent.state).toEqual({ kind: "refused" }));
    await vi.waitFor(() => expect(t.server.session).toBeNull());
  });

  it("starts once when a connect reloads the setting", async () => {
    const t = fixture();
    t.store({ providers: [provider("a")], active: "a" });
    await t.agent.load();
    const open = { kind: "open", sessionId: "s2" } as const;
    t.agent.connected(open);
    await t.agent.load();
    await vi.waitFor(() => expect(t.agent.state).toEqual({ kind: "ready" }));
    expect(t.starts).toHaveLength(1);
  });

  it("refuses a record that does not open", async () => {
    const t = fixture();
    await t.agent.load();
    await t.agent.receive({ key: "providers", record: new Uint8Array([0, 1]), rev: 1 });
    expect(t.agent.providers).toEqual({ kind: "failed" });
  });
});
