// Generated from crates/protocol by its `typescript` test. Do not edit.

export const PROTOCOL_VERSION = 1;

export type Empty = Record<symbol, never>;
export type ErrorCode = "protocol.malformed" | "protocol.unknown_type" | "protocol.missing_id" | "auth.already_authenticated" | "auth.invalid_token" | "auth.session_mismatch" | "rate_limited" | "internal";
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

export const CloseCode = {
  Normal: 1000,
  GoingAway: 1001,
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
