// Generated from crates/protocol by its `typescript` test. Do not edit.

export const PROTOCOL_VERSION = 1;

export type Empty = Record<symbol, never>;
export type ErrorCode = "protocol.malformed" | "protocol.unknown_type" | "protocol.missing_id" | "auth.already_authenticated" | "auth.invalid_token" | "auth.session_mismatch" | "auth.unavailable" | "auth.origin" | "auth.signed_out" | "auth.reauth_required" | "auth.provider_disabled" | "auth.invalid_email" | "auth.code_invalid" | "auth.code_expired" | "auth.signup_closed" | "auth.email_unverified" | "identity.in_use" | "identity.last" | "not_found" | "rate_limited" | "internal";
export type ErrorPayload = { code: ErrorCode, 
/**
 * For logs and developers; never shown to users and never contains user content.
 */
message: string, retry: boolean, };
export type Auth = { access_token: string, resume?: Resume, };
export type Resume = { agent_session_id: string, };
export type AuthOk = { session_id: string, 
/**
 * How often the client sends `ping`.
 */
heartbeat_ms: number, 
/**
 * Server clock, milliseconds since the Unix epoch.
 */
server_time: number, };
export type AuthRenew = { access_token: string, };
export type Ping = Record<symbol, never>;
export type Pong = { 
/**
 * Server clock, milliseconds since the Unix epoch.
 */
server_time: number, };

// HTTP /auth (docs/auth.md)
export type Provider = "google" | "email";
export type Providers = { google: boolean, email: boolean, };
export type EmailStart = { email: string, 
/**
 * UI language for the mail; unknown values fall back to English.
 */
locale: string, };
export type EmailStarted = { pending_id: string, };
export type EmailVerify = { pending_id: string, email: string, code: string, };
export type AccessGrant = { access_token: string, expires_at: number, user_id: string, session_id: string, };
export type SessionUpdate = { device_id: string, 
/**
 * IANA name from `Intl`; dropped when the server does not know it.
 */
timezone?: string, locale?: string, client_version?: string, };
export type SessionInfo = { id: string, 
/**
 * The session making this request.
 */
current: boolean, provider: Provider, device_id: string | null, user_agent: string | null, ip: string | null, country: string | null, timezone: string | null, locale: string | null, client_version: string | null, created_at: number, last_seen_at: number, };
export type Sessions = { sessions: Array<SessionInfo>, };
export type IdentityInfo = { id: string, provider: Provider, email: string | null, email_verified: boolean, created_at: number, last_used_at: number, };
export type Identities = { identities: Array<IdentityInfo>, };
export type AuditEntry = { id: number, 
/**
 * `area.verb`, e.g. `auth.signed_in`.
 */
kind: string, session_id: string | null, ip: string | null, country: string | null, user_agent: string | null, 
/**
 * Ids, provider kinds and reasons; never content or addresses.
 */
details: Record<string, unknown>, created_at: number, };
export type AuditPage = { events: Array<AuditEntry>, 
/**
 * Pass as `before` for the next page; absent on the last page.
 */
next_before: number | null, };

export const CloseCode = {
  Normal: 1000,
  GoingAway: 1001,
  ServerError: 1011,
  AuthFailed: 4001,
  AuthTimeout: 4002,
  SessionRevoked: 4003,
  TokenExpired: 4004,
  UnsupportedVersion: 4005,
  PolicyViolation: 4008,
  Superseded: 4009,
} as const;

/** Every request `type` with its payload and the payload of its `ok` response. */
export type Requests = {
  "auth": { request: Auth; response: AuthOk };
  "auth.renew": { request: AuthRenew; response: Empty };
  "ping": { request: Ping; response: Pong };
};

/** Every server event `type` with its payload. */
export type Events = Record<never, never>;
