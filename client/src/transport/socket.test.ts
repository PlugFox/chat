import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloseCode } from "../protocol/generated/protocol";
import { decodeFrame, encodeFrame } from "./codec";
import { type AccessToken, Socket, type SocketState, TransportError, type WebSocketLike } from "./socket";

interface Sent {
  id: number;
  type: string;
  payload: Record<string, unknown>;
}

function bytes(data: Uint8Array): ArrayBuffer {
  return data.slice().buffer;
}

class FakeWebSocket implements WebSocketLike {
  readyState = 0;
  binaryType = "blob";
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  sent: Sent[] = [];
  closedWith: number | undefined;

  send(data: Uint8Array<ArrayBuffer>): void {
    const frame = decodeFrame(data);
    if (!frame) throw new Error("the client sent a malformed frame");
    const [type, id, payload] = frame;
    this.sent.push({ type, id, payload: payload as Record<string, unknown> });
  }

  close(code?: number): void {
    this.closedWith = code;
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  receive(frame: Sent): void {
    this.onmessage?.(new MessageEvent("message", { data: bytes(encodeFrame(frame.type, frame.id, frame.payload)) }));
  }

  serverClose(code: number): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close", { code }));
  }

  last(): Sent {
    const frame = this.sent.at(-1);
    if (!frame) throw new Error("nothing sent");
    return frame;
  }
}

const HOUR = 3_600_000;

function setup(
  options: {
    random?: number;
    token?: (force: boolean) => Promise<AccessToken>;
    resume?: () => string | undefined;
  } = {},
) {
  const sockets: FakeWebSocket[] = [];
  const states: SocketState[] = [];
  const tokenCalls: boolean[] = [];
  const socket = new Socket({
    url: "ws://test/ws",
    accessToken:
      options.token ??
      ((force) => {
        tokenCalls.push(force);
        return Promise.resolve({ token: `token-${tokenCalls.length}`, expiresAt: Date.now() + HOUR });
      }),
    webSocket: () => {
      const ws = new FakeWebSocket();
      sockets.push(ws);
      return ws;
    },
    random: () => options.random ?? 1,
    onState: (s) => states.push(s),
    resume: options.resume ?? (() => undefined),
  });
  const ws = (): FakeWebSocket => {
    const last = sockets.at(-1);
    if (!last) throw new Error("no socket");
    return last;
  };
  /** Opens the current socket and answers its auth frame. */
  const open = async (heartbeatMs = 20_000, extra: Record<string, unknown> = {}) => {
    ws().open();
    await vi.waitFor(() => expect(ws().sent.at(0)?.type).toBe("auth"));
    ws().receive({
      id: ws().sent[0]?.id ?? -1,
      type: "ok",
      payload: { session_id: "s1", heartbeat_ms: heartbeatMs, server_time: Date.now(), ...extra },
    });
  };
  return { socket, sockets, states, tokenCalls, ws, open };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Socket", () => {
  it("authenticates with the first frame, then serves requests", async () => {
    const t = setup();
    const pong = t.socket.request("ping", {});
    await t.open();
    expect(t.ws().sent[0]).toEqual({ id: 1, type: "auth", payload: { v: 1, access_token: "token-1" } });
    expect(t.ws().binaryType).toBe("arraybuffer");
    expect(t.socket.current).toEqual({ kind: "open", sessionId: "s1", files: false });
    const ping = t.ws().last();
    expect(ping.type).toBe("ping");
    t.ws().receive({ id: ping.id, type: "ok", payload: { server_time: 1 } });
    await expect(pong).resolves.toEqual({ server_time: 1 });
  });

  it("rejects with the server's error code", async () => {
    const t = setup();
    await t.open();
    const renew = t.socket.request("auth.renew", { access_token: "x" });
    t.ws().receive({
      id: t.ws().last().id,
      type: "error",
      payload: { code: "auth.session_mismatch", message: "m", retry: false },
    });
    await expect(renew).rejects.toEqual(new TransportError("auth.session_mismatch", "m"));
  });

  it("fails or resends in-flight requests after a disconnect, never drops them", async () => {
    const t = setup();
    await t.open();
    const failing = t.socket.request("ping", {}, { retry: "fail" });
    const resending = t.socket.request("ping", {}, { retry: "resend" });
    t.ws().serverClose(1006);
    await expect(failing).rejects.toMatchObject({ code: "disconnected", retry: true });
    expect(t.socket.current).toMatchObject({ kind: "waiting" });

    await vi.advanceTimersByTimeAsync(500);
    await t.open();
    const resent = t.ws().last();
    expect(resent.type).toBe("ping");
    t.ws().receive({ id: resent.id, type: "ok", payload: { server_time: 2 } });
    await expect(resending).resolves.toEqual({ server_time: 2 });
  });

  it("backs off exponentially with full jitter, capped at 30 s", async () => {
    const t = setup({ random: 1 });
    const waits: number[] = [];
    for (let i = 0; i < 8; i++) {
      t.ws().serverClose(1006);
      const state = t.socket.current;
      if (state.kind !== "waiting") throw new Error(state.kind);
      waits.push(state.retryInMs);
      await vi.advanceTimersByTimeAsync(state.retryInMs);
    }
    expect(waits).toEqual([500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]);

    const half = setup({ random: 0.5 });
    half.ws().serverClose(1006);
    expect(half.socket.current).toMatchObject({ retryInMs: 250 });
  });

  it("resets the backoff after a healthy connection", async () => {
    const t = setup();
    t.ws().serverClose(1006);
    await vi.advanceTimersByTimeAsync(500);
    await t.open();
    await vi.advanceTimersByTimeAsync(30_000);
    t.ws().serverClose(1006);
    expect(t.socket.current).toMatchObject({ retryInMs: 500 });
  });

  it("stops on a revoked session and rejects everything", async () => {
    const t = setup();
    await t.open();
    const pending = t.socket.request("ping", {}, { retry: "resend" });
    t.ws().serverClose(CloseCode.SessionRevoked);
    expect(t.socket.current).toEqual({ kind: "closed", reason: "revoked" });
    await expect(pending).rejects.toMatchObject({ code: "closed" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.sockets).toHaveLength(1);
    await expect(t.socket.request("ping", {})).rejects.toMatchObject({ code: "closed" });
  });

  it("asks to resume the agent session and reports whether it did", async () => {
    let agent: string | undefined;
    const t = setup({ resume: () => agent });
    await t.open();
    expect(t.ws().sent[0]?.payload).not.toHaveProperty("resume");
    agent = "a1";
    t.ws().serverClose(CloseCode.GoingAway);
    await vi.runOnlyPendingTimersAsync();
    // The answer also says whether the server stores files (D-101).
    await t.open(20_000, { agent_session_id: "a1", files: true });
    expect(t.ws().sent[0]?.payload["resume"]).toEqual({ agent_session_id: "a1" });
    expect(t.socket.current).toEqual({ kind: "open", sessionId: "s1", agentSessionId: "a1", files: true });
  });

  it("retries auth once with a forced refresh, then signs out", async () => {
    const t = setup();
    t.ws().open();
    await vi.waitFor(() => expect(t.ws().sent).toHaveLength(1));
    t.ws().serverClose(CloseCode.AuthFailed);
    await vi.advanceTimersByTimeAsync(500);
    t.ws().open();
    await vi.waitFor(() => expect(t.tokenCalls).toEqual([false, true]));
    t.ws().serverClose(CloseCode.AuthFailed);
    expect(t.socket.current).toEqual({ kind: "closed", reason: "signed_out" });
  });

  it("closes for good on an unsupported protocol version or when superseded", () => {
    const a = setup();
    a.ws().serverClose(CloseCode.UnsupportedVersion);
    expect(a.socket.current).toEqual({ kind: "closed", reason: "unsupported_version" });
    const b = setup();
    b.ws().serverClose(CloseCode.Superseded);
    expect(b.socket.current).toEqual({ kind: "closed", reason: "superseded" });
  });

  it("signs out when no access token can be had", async () => {
    const t = setup({ token: () => Promise.reject(new Error("refresh failed")) });
    t.ws().open();
    await vi.waitFor(() => expect(t.socket.current).toEqual({ kind: "closed", reason: "signed_out" }));
  });

  it("pings every interval and reconnects when pongs stop", async () => {
    const t = setup();
    await t.open(1000);
    await vi.advanceTimersByTimeAsync(1000);
    const ping = t.ws().last();
    expect(ping.type).toBe("ping");
    t.ws().receive({ id: ping.id, type: "ok", payload: { server_time: 0 } });
    // Two more intervals pass without an answer.
    await vi.advanceTimersByTimeAsync(3000);
    expect(t.socket.current.kind).toBe("waiting");
  });

  it("renews the access token a minute before it expires", async () => {
    const t = setup();
    // A heartbeat longer than the test, so unanswered pings do not reconnect.
    await t.open(2 * HOUR);
    await vi.advanceTimersByTimeAsync(HOUR - 60_000);
    await vi.waitFor(() => expect(t.ws().last().type).toBe("auth.renew"));
    expect(t.ws().last().payload).toEqual({ access_token: "token-2" });
    expect(t.tokenCalls).toEqual([false, true]);
  });

  it("delivers events and ignores garbage", async () => {
    const events: [string, unknown][] = [];
    const sockets: FakeWebSocket[] = [];
    new Socket({
      url: "ws://test/ws",
      accessToken: () => Promise.resolve({ token: "t", expiresAt: Date.now() + HOUR }),
      webSocket: () => {
        const ws = new FakeWebSocket();
        sockets.push(ws);
        return ws;
      },
      onEvent: (type, payload) => events.push([type, payload]),
    });
    const ws = sockets[0];
    if (!ws) throw new Error("no socket");
    ws.onmessage?.(new MessageEvent("message", { data: "a text frame" }));
    ws.onmessage?.(new MessageEvent("message", { data: bytes(new Uint8Array([0xc1])) }));
    ws.onmessage?.(new MessageEvent("message", { data: bytes(encodeFrame("x", -1, {})) }));
    ws.receive({ id: 0, type: "chat.updated", payload: { chat_id: "c" } });
    ws.receive({ id: 0, type: "error", payload: { code: "protocol.malformed", message: "m", retry: false } });
    expect(events).toEqual([["chat.updated", { chat_id: "c" }]]);
  });

  it("delivers response parts before the final ok", async () => {
    const t = setup();
    await t.open();
    const parts: unknown[] = [];
    const done = t.socket.request("ping", {}, { onPart: (part) => parts.push(part) });
    const { id } = t.ws().last();
    t.ws().receive({ id, type: "more", payload: { server_time: 1 } });
    t.ws().receive({ id, type: "more", payload: { server_time: 2 } });
    expect(parts).toEqual([{ server_time: 1 }, { server_time: 2 }]);
    t.ws().receive({ id, type: "ok", payload: { server_time: 3 } });
    await expect(done).resolves.toEqual({ server_time: 3 });
    expect(parts).toHaveLength(2);
  });

  it("stop() closes the socket and rejects pending requests", async () => {
    const t = setup();
    await t.open();
    const pending = t.socket.request("ping", {}, { retry: "resend" });
    t.socket.stop();
    expect(t.ws().closedWith).toBe(CloseCode.Normal);
    expect(t.socket.current).toEqual({ kind: "closed", reason: "stopped" });
    await expect(pending).rejects.toMatchObject({ code: "closed" });
  });
});
