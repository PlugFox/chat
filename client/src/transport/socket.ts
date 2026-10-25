/**
 * The WebSocket client (docs/protocol.md, "Envelope", "Connection lifecycle"
 * and "Reconnect and resume"): MessagePack frames, authenticates with the
 * first frame, delivers response parts as they arrive, pings, renews
 * the access token before it expires, reconnects with capped exponential
 * backoff and full jitter, and never drops a request silently — every request
 * is either resent after a reconnect or rejected with a `TransportError`.
 */

import {
  type AuthOk,
  CloseCode,
  type ErrorPayload,
  type Events,
  PROTOCOL_VERSION,
  type Requests,
} from "../protocol/generated/protocol";
import { decodeFrame, encodeFrame } from "./codec";

export type RequestType = Exclude<keyof Requests, "auth">;
export type EventType = keyof Events;

export interface AccessToken {
  token: string;
  /** Milliseconds since the Unix epoch. */
  expiresAt: number;
}

export interface SocketOptions {
  url: string;
  /** A valid access token; refreshes over HTTP when the current one is close to expiry or `force` is set. */
  accessToken: (force: boolean) => Promise<AccessToken>;
  onState?: (state: SocketState) => void;
  onEvent?: <T extends EventType>(type: T, payload: Events[T]) => void;
  /** Injected for tests. */
  webSocket?: (url: string) => WebSocketLike;
  random?: () => number;
  now?: () => number;
}

/** What the client needs from a WebSocket; the browser's satisfies it. */
export interface WebSocketLike {
  readyState: number;
  binaryType: string;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: Uint8Array<ArrayBuffer>): void;
  close(code?: number, reason?: string): void;
}

export type ClosedReason = "revoked" | "signed_out" | "unsupported_version" | "superseded" | "stopped";

export type SocketState =
  | { kind: "connecting"; attempt: number }
  | { kind: "open"; sessionId: string }
  | { kind: "waiting"; attempt: number; retryInMs: number }
  | { kind: "closed"; reason: ClosedReason };

export type Retry = "resend" | "fail";

export interface RequestOptions<T extends RequestType> {
  /** `"resend"` keeps the request across reconnects: only for requests that are safe to repeat. */
  retry?: Retry;
  /**
   * Called with each `more` part of a large response before the final `ok`
   * resolves the promise. A resent request delivers its parts again, so the
   * handler must tolerate repeats (chunks reconcile by `rev`).
   */
  onPart?: (part: Requests[T]["response"]) => void;
}

export class TransportError extends Error {
  constructor(
    readonly code: ErrorPayload["code"] | "disconnected" | "closed" | "timeout",
    message: string,
    readonly retry = false,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

interface Pending {
  type: string;
  payload: unknown;
  retry: Retry;
  onPart: ((part: unknown) => void) | undefined;
  resolve: (value: unknown) => void;
  reject: (error: TransportError) => void;
}

/** The `id` of events and of errors not tied to a request. */
const EVENT_ID = 0;

const OPEN = 1;
const BACKOFF_START_MS = 500;
const BACKOFF_CAP_MS = 30_000;
/** A socket healthy for this long resets the backoff. */
const HEALTHY_MS = 30_000;
/** Renew the access token this long before it expires. */
const RENEW_BEFORE_MS = 60_000;

export class Socket {
  private ws: WebSocketLike | null = null;
  private state: SocketState = { kind: "connecting", attempt: 0 };
  private nextId = 1;
  /** The id of the `auth` request on the current socket. */
  private authId = -1;
  private attempt = 0;
  private authFailures = 0;
  private readonly pending = new Map<number, Pending>();
  /** Requests waiting for the socket to (re)open. */
  private readonly outbox: Pending[] = [];
  private timers: ReturnType<typeof setTimeout>[] = [];
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private lastPong = 0;
  private stopped = false;
  private readonly options: Required<Omit<SocketOptions, "onState" | "onEvent">> &
    Pick<SocketOptions, "onState" | "onEvent">;

  constructor(options: SocketOptions) {
    this.options = {
      webSocket: (url) => new WebSocket(url),
      random: Math.random,
      now: Date.now,
      ...options,
    };
    this.connect();
  }

  get current(): SocketState {
    return this.state;
  }

  /** Sends a request; the promise settles with the final response. */
  request<T extends RequestType>(
    type: T,
    payload: Requests[T]["request"],
    options: RequestOptions<T> = {},
  ): Promise<Requests[T]["response"]> {
    if (this.state.kind === "closed") {
      return Promise.reject(new TransportError("closed", `socket closed: ${this.state.reason}`));
    }
    return new Promise((resolve, reject) => {
      const pending: Pending = {
        type,
        payload,
        retry: options.retry ?? "fail",
        onPart: options.onPart as ((part: unknown) => void) | undefined,
        resolve: resolve as (v: unknown) => void,
        reject,
      };
      if (this.state.kind === "open") this.transmit(pending);
      else this.outbox.push(pending);
    });
  }

  /** Closes for good (sign-out, page teardown). */
  stop(): void {
    this.finish("stopped", CloseCode.Normal);
  }

  private setState(state: SocketState): void {
    this.state = state;
    this.options.onState?.(state);
  }

  private connect(): void {
    this.attempt += 1;
    this.setState({ kind: "connecting", attempt: this.attempt });
    const ws = this.options.webSocket(this.options.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      void this.authenticate(ws);
    };
    ws.onmessage = (event) => {
      if (this.ws === ws) this.receive(event.data);
    };
    ws.onclose = (event) => {
      if (this.ws === ws) this.closed(event.code);
    };
    ws.onerror = () => {
      // A close event always follows; it decides what happens next.
    };
  }

  private async authenticate(ws: WebSocketLike): Promise<void> {
    let token: AccessToken;
    try {
      token = await this.options.accessToken(this.authFailures > 0);
    } catch {
      this.finish("signed_out", CloseCode.Normal);
      return;
    }
    if (this.ws !== ws || ws.readyState !== OPEN) return;
    this.authId = this.nextId++;
    ws.send(encodeFrame("auth", this.authId, { v: PROTOCOL_VERSION, access_token: token.token }));
    this.scheduleRenewal(token.expiresAt);
  }

  private receive(data: unknown): void {
    if (!(data instanceof ArrayBuffer)) return;
    const frame = decodeFrame(data);
    if (!frame) return;
    const [type, id, payload] = frame;
    if (id === this.authId && type === "ok") {
      this.opened(payload as AuthOk);
      return;
    }
    if (id === EVENT_ID) {
      if (type !== "error") this.options.onEvent?.(type as EventType, payload as never);
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) return;
    if (type === "more") {
      pending.onPart?.(payload);
      return;
    }
    this.pending.delete(id);
    if (type === "ok") {
      pending.resolve(payload);
    } else {
      const error = payload as ErrorPayload;
      pending.reject(new TransportError(error.code, error.message, error.retry));
    }
  }

  private opened(ok: AuthOk): void {
    this.authFailures = 0;
    this.setState({ kind: "open", sessionId: ok.session_id });
    this.timers.push(
      setTimeout(() => {
        this.attempt = 0;
      }, HEALTHY_MS),
    );
    this.startHeartbeat(ok.heartbeat_ms);
    for (const pending of this.outbox.splice(0)) this.transmit(pending);
  }

  private transmit(pending: Pending): void {
    const id = this.nextId++;
    this.pending.set(id, pending);
    this.ws?.send(encodeFrame(pending.type, id, pending.payload));
  }

  private startHeartbeat(intervalMs: number): void {
    this.lastPong = this.options.now();
    this.heartbeat = setInterval(() => {
      // No answer for two intervals: the socket is dead even if the browser has not noticed.
      if (this.options.now() - this.lastPong > intervalMs * 2) {
        this.ws?.close(CloseCode.Normal, "heartbeat timeout");
        this.closed(CloseCode.GoingAway);
        return;
      }
      this.request("ping", {}).then(
        () => {
          this.lastPong = this.options.now();
        },
        () => {},
      );
    }, intervalMs);
  }

  private scheduleRenewal(expiresAt: number): void {
    const delay = Math.max(0, expiresAt - RENEW_BEFORE_MS - this.options.now());
    this.timers.push(
      setTimeout(() => {
        void this.renew();
      }, delay),
    );
  }

  private async renew(): Promise<void> {
    try {
      const token = await this.options.accessToken(true);
      await this.request("auth.renew", { access_token: token.token });
      this.scheduleRenewal(token.expiresAt);
    } catch {
      // The server closes with 4004 at expiry; the reconnect fetches a fresh token.
    }
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  /** Sorts in-flight requests after a disconnect: resend later or fail now. */
  private settleInFlight(error: TransportError): void {
    const inFlight = [...this.pending.values()];
    this.pending.clear();
    for (const pending of [...inFlight, ...this.outbox.splice(0)]) {
      if (pending.retry === "resend" && !this.stopped) this.outbox.push(pending);
      else pending.reject(error);
    }
  }

  private closed(code: number): void {
    this.ws = null;
    this.clearTimers();
    switch (code) {
      case CloseCode.SessionRevoked:
        this.finish("revoked");
        return;
      case CloseCode.UnsupportedVersion:
        this.finish("unsupported_version");
        return;
      case CloseCode.Superseded:
        this.finish("superseded");
        return;
      case CloseCode.AuthFailed:
        // One retry with a force-refreshed token; a second failure means signed out.
        this.authFailures += 1;
        if (this.authFailures > 1) {
          this.finish("signed_out");
          return;
        }
        break;
      default:
        break;
    }
    if (this.stopped) return;
    this.settleInFlight(new TransportError("disconnected", "connection lost", true));
    const retryInMs = Math.round(
      this.options.random() * Math.min(BACKOFF_CAP_MS, BACKOFF_START_MS * 2 ** Math.max(0, this.attempt - 1)),
    );
    this.setState({ kind: "waiting", attempt: this.attempt, retryInMs });
    this.timers.push(setTimeout(() => this.connect(), retryInMs));
  }

  private finish(reason: ClosedReason, code?: number): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws && code !== undefined) ws.close(code, reason);
    this.settleInFlight(new TransportError("closed", `socket closed: ${reason}`));
    this.setState({ kind: "closed", reason });
  }
}
