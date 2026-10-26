// Generated from crates/protocol by its `typescript` test. Do not edit.

export const PROTOCOL_VERSION = 1;

export type Empty = Record<symbol, never>;
export type ErrorCode = "protocol.malformed" | "protocol.unknown_type" | "protocol.missing_id" | "auth.already_authenticated" | "auth.invalid_token" | "auth.session_mismatch" | "auth.unavailable" | "auth.origin" | "auth.signed_out" | "auth.reauth_required" | "auth.provider_disabled" | "auth.invalid_email" | "auth.code_invalid" | "auth.code_expired" | "auth.signup_closed" | "auth.email_unverified" | "identity.in_use" | "identity.last" | "keys.not_set_up" | "keys.exists" | "keys.invalid" | "keys.limit" | "keys.device_mismatch" | "keys.recovery_required" | "link.not_found" | "link.used" | "not_found" | "rate_limited" | "unavailable" | "internal";
export type ErrorPayload = { code: ErrorCode, 
/**
 * For logs and developers; never shown to users and never contains user content.
 */
message: string, retry: boolean, };
export type Auth = { 
/**
 * The protocol version the client speaks.
 */
v: number, access_token: string, resume?: Resume, };
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

// Keys (docs/protocol.md, "Keys")
export type AccountScopeKind = "settings" | "audit" | "profile:basics" | "profile:medical" | "profile:lifestyle";
export type KeysGet = Record<symbol, never>;
export type KeysState = { 
/**
 * Absent before key setup.
 */
keys?: AccountKeys, };
export type AccountKeys = { commitment: Uint8Array, writer_public_key: Uint8Array, 
/**
 * Passkey and recovery wraps, and this session's device wrap if any.
 */
wraps: Array<StoredWrap>, scopes: Array<AccountScope>, };
export type StoredWrap = { wrap: Uint8Array, 
/**
 * Milliseconds since the Unix epoch.
 */
created_at: number, };
export type AccountScope = { scope_id: string, kind: AccountScopeKind, };
export type KeysSetup = { commitment: Uint8Array, writer_public_key: Uint8Array, 
/**
 * One recovery wrap and any passkey wraps.
 */
wraps: Array<Uint8Array>, scopes: Array<NewAccountScope>, };
export type NewAccountScope = { scope_id: string, kind: AccountScopeKind, public_key: Uint8Array, wrapped_private_key: Uint8Array, };
export type KeysWrapAdd = { wrap: Uint8Array, };
export type KeysWrapRemove = { wrap_id: string, };
export type KeysRecoveryRotate = { wrap: Uint8Array, };
export type ScopeKeys = { scope_ids: Array<string>, };
export type ScopeKeyList = { 
/**
 * Every key version of the requested scopes the user owns; unknown ids are left out.
 */
keys: Array<ScopeKey>, };
export type ScopeKey = { scope_id: string, key_version: number, public_key: Uint8Array, wrapped_private_key: Uint8Array, };

// Device linking (docs/protocol.md, "Keys")
export type LinkCreate = Record<symbol, never>;
export type LinkCreated = { sid: string, 
/**
 * How long the link lives, from now: a duration, so a client with a wrong
 * clock still renews its code in time.
 */
expires_in_ms: number, };
export type LinkInfo = { sid: string, };
export type LinkRequester = { 
/**
 * When the link was created, in milliseconds.
 */
created_at: number, user_agent?: string, country?: string, };
export type LinkPost = { sid: string, message: Uint8Array, };
export type LinkGet = { sid: string, };
export type LinkState = { 
/**
 * Absent until the unlocked device posted it.
 */
message?: Uint8Array, };
export type LinkMessage = { sid: string, message: Uint8Array, };

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
  "keys.get": { request: KeysGet; response: KeysState };
  "keys.setup": { request: KeysSetup; response: Empty };
  "keys.wrap_add": { request: KeysWrapAdd; response: Empty };
  "keys.wrap_remove": { request: KeysWrapRemove; response: Empty };
  "keys.recovery_rotate": { request: KeysRecoveryRotate; response: Empty };
  "scope.keys": { request: ScopeKeys; response: ScopeKeyList };
  "link.create": { request: LinkCreate; response: LinkCreated };
  "link.info": { request: LinkInfo; response: LinkRequester };
  "link.post": { request: LinkPost; response: Empty };
  "link.get": { request: LinkGet; response: LinkState };
};

/** Every server event `type` with its payload. */
export type Events = {
  "link.message": LinkMessage;
};
