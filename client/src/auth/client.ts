/**
 * Sign-in state and tokens in the browser (docs/auth.md, "Client"). The
 * refresh token lives in an HttpOnly cookie this code never sees; the access
 * token lives in memory only. Refreshes run under a Web Lock so tabs do not
 * race, and new tokens and sign-outs are shared with every tab over a
 * BroadcastChannel. Framework-free so it can be tested without a DOM.
 */

import type { AccessGrant, EmailStarted, ErrorCode, ErrorPayload, SessionUpdate } from "../protocol/generated/protocol";
import type { AccessToken } from "../transport/socket";

export type AuthState =
  | { kind: "loading" }
  | { kind: "signed_out" }
  | { kind: "signed_in"; userId: string; sessionId: string };

/** An `/auth` call that failed: a protocol error code, or `network` when the server was not reached. */
export class AuthHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | "network",
    message: string,
  ) {
    super(message);
    this.name = "AuthHttpError";
  }
}

type Message = { type: "grant"; grant: AccessGrant } | { type: "signed_out" };

/** What the client needs from a BroadcastChannel. */
export interface ChannelLike {
  postMessage(message: Message): void;
  onmessage: ((event: { data: Message }) => void) | null;
}

export interface LocksLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

export interface AuthDeps {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  /** Absent in old browsers: refreshes then only single-flight within the tab. */
  locks?: LocksLike | undefined;
  channel?: ChannelLike | undefined;
  now: () => number;
  setTimer: (callback: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** What `PUT /auth/session` reports. */
  device: () => Omit<SessionUpdate, "locale">;
}

const LOCK = "chat.auth.refresh";
/** Refresh this long before the access token expires. */
const REFRESH_BEFORE_MS = 60_000;
/** Spread the scheduled refresh of several tabs; the lock makes all but one cheap. */
const JITTER_MS = 10_000;

export class AuthClient {
  private grant: AccessGrant | null = null;
  /** Counts accepted grants, to tell whether another tab refreshed while this one waited. */
  private grants = 0;
  private inflight: Promise<AccessGrant | null> | null = null;
  private timer: unknown = null;
  private state: AuthState = { kind: "loading" };
  private readonly listeners = new Set<(state: AuthState) => void>();

  constructor(private readonly deps: AuthDeps) {
    if (deps.channel) {
      deps.channel.onmessage = ({ data }) => {
        if (data.type === "grant") this.accept(data.grant, false);
        else this.signedOut(false);
      };
    }
  }

  get current(): AuthState {
    return this.state;
  }

  subscribe(listener: (state: AuthState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The cookie decides whether the user is signed in. */
  async start(): Promise<void> {
    try {
      await this.refresh(false);
    } catch {
      // Offline at start: nothing is known yet; signed out until the server answers.
      if (this.state.kind === "loading") this.setState({ kind: "signed_out" });
    }
  }

  /** For the WebSocket: a token with time left, refreshed when `force` or close to expiry. */
  async accessToken(force: boolean): Promise<AccessToken> {
    const grant = !force && this.fresh() ? this.grant : await this.refresh(force);
    if (!grant) throw new AuthHttpError(401, "auth.signed_out", "signed out");
    return { token: grant.access_token, expiresAt: grant.expires_at };
  }

  /**
   * One refresh per tab at a time, one per browser under the lock. A tab
   * that waited for the lock takes the token another tab just obtained
   * instead of presenting the (rotated) cookie again. `null` means signed out.
   */
  refresh(force: boolean): Promise<AccessGrant | null> {
    if (this.inflight) return this.inflight;
    const asked = this.grants;
    const run = async (): Promise<AccessGrant | null> => {
      // A tab that refreshed while this one waited has shared its token. If its
      // message is still on the way, the server's grace window answers the
      // rotated cookie (docs/auth.md, "Refresh token").
      if (this.grants > asked && this.fresh()) return this.grant;
      if (!force && this.fresh()) return this.grant;
      const response = await this.send("POST", "/auth/refresh");
      if (response.status === 401) {
        this.signedOut(true);
        return null;
      }
      const grant = (await this.parse(response)) as AccessGrant;
      this.accept(grant, true);
      return grant;
    };
    const locked = this.deps.locks ? this.deps.locks.request(LOCK, run) : run();
    this.inflight = locked.finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** An authenticated `/auth` call; one refresh and retry on 401. */
  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let token = (await this.accessToken(false)).token;
    let response = await this.send(method, path, body, token);
    if (response.status === 401) {
      token = (await this.accessToken(true)).token;
      response = await this.send(method, path, body, token);
      if (response.status === 401) {
        this.signedOut(true);
        throw new AuthHttpError(401, "auth.signed_out", "signed out");
      }
    }
    return (await this.parse(response)) as T;
  }

  async emailStart(email: string, locale: string, link = false): Promise<string> {
    const path = link ? "/auth/link/email/start" : "/auth/email/start";
    const body = { email, locale };
    const started = link
      ? await this.call<EmailStarted>("POST", path, body)
      : ((await this.parse(await this.send("POST", path, body))) as EmailStarted);
    return started.pending_id;
  }

  async emailVerify(pendingId: string, email: string, code: string, locale: string): Promise<void> {
    const body = { pending_id: pendingId, email, code };
    const grant = (await this.parse(await this.send("POST", "/auth/email/verify", body))) as AccessGrant;
    this.accept(grant, true);
    await this.reportSession(locale);
  }

  async linkEmailVerify(pendingId: string, email: string, code: string): Promise<void> {
    await this.call("POST", "/auth/link/email/verify", { pending_id: pendingId, email, code });
  }

  /** `PUT /auth/session` after sign-in and on every start (docs/auth.md). */
  async reportSession(locale: string): Promise<void> {
    await this.call("PUT", "/auth/session", { ...this.deps.device(), locale });
  }

  async signOut(): Promise<void> {
    const token = this.grant?.access_token;
    try {
      await this.send("POST", "/auth/sign-out", undefined, token);
    } finally {
      this.signedOut(true);
    }
  }

  /** After the account is deleted or the session revoked elsewhere. */
  forget(): void {
    this.signedOut(true);
  }

  private fresh(): boolean {
    return this.grant !== null && this.grant.expires_at - this.deps.now() > REFRESH_BEFORE_MS;
  }

  private accept(grant: AccessGrant, broadcast: boolean): void {
    this.grant = grant;
    this.grants += 1;
    if (broadcast) this.deps.channel?.postMessage({ type: "grant", grant });
    this.schedule();
    this.setState({ kind: "signed_in", userId: grant.user_id, sessionId: grant.session_id });
  }

  private signedOut(broadcast: boolean): void {
    this.grant = null;
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    if (broadcast) this.deps.channel?.postMessage({ type: "signed_out" });
    this.setState({ kind: "signed_out" });
  }

  private schedule(): void {
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    if (!this.grant) return;
    const due = this.grant.expires_at - REFRESH_BEFORE_MS - Math.random() * JITTER_MS - this.deps.now();
    this.timer = this.deps.setTimer(
      () => {
        this.timer = null;
        // A failed scheduled refresh is retried by the next call that needs a token.
        this.refresh(true).catch(() => undefined);
      },
      Math.max(0, due),
    );
  }

  private setState(state: AuthState): void {
    const same =
      state.kind === this.state.kind &&
      (state.kind !== "signed_in" || (this.state.kind === "signed_in" && this.state.sessionId === state.sessionId));
    this.state = state;
    if (!same) for (const listener of this.listeners) listener(state);
  }

  private async send(method: string, path: string, body?: unknown, token?: string): Promise<Response> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (token) headers["authorization"] = `Bearer ${token}`;
    const init: RequestInit = { method, headers, credentials: "same-origin" };
    if (body !== undefined) init.body = JSON.stringify(body);
    try {
      return await this.deps.fetch(path, init);
    } catch {
      throw new AuthHttpError(0, "network", "server not reachable");
    }
  }

  private async parse(response: Response): Promise<unknown> {
    if (response.ok) return response.status === 204 ? undefined : response.json();
    let payload: Partial<ErrorPayload> = {};
    try {
      payload = (await response.json()) as ErrorPayload;
    } catch {
      // Not our JSON (a proxy error page): keep the status only.
    }
    throw new AuthHttpError(response.status, payload.code ?? "internal", payload.message ?? response.statusText);
  }
}
