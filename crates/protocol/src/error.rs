//! The `error` response (docs/protocol.md, "Envelope").

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Stable error codes; the client localizes by code.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum ErrorCode {
    /// The frame is not valid JSON or not a valid envelope or payload.
    #[serde(rename = "protocol.malformed")]
    Malformed,
    /// No handler for this `type`.
    #[serde(rename = "protocol.unknown_type")]
    UnknownType,
    /// A request without an `id`.
    #[serde(rename = "protocol.missing_id")]
    MissingId,
    /// `auth` on a socket that is already authenticated.
    #[serde(rename = "auth.already_authenticated")]
    AlreadyAuthenticated,
    /// The access token is invalid, expired or of a revoked session.
    #[serde(rename = "auth.invalid_token")]
    InvalidToken,
    /// `auth.renew` with a token of another session.
    #[serde(rename = "auth.session_mismatch")]
    SessionMismatch,
    /// The revocation store is unreachable; nothing authenticated is served until it is back.
    #[serde(rename = "auth.unavailable")]
    AuthUnavailable,
    /// An `/auth` request from an origin not in `CHAT_ALLOWED_ORIGINS`, or without one.
    #[serde(rename = "auth.origin")]
    Origin,
    /// No valid refresh cookie: the user is signed out.
    #[serde(rename = "auth.signed_out")]
    SignedOut,
    /// Account deletion needs a sign-in from the last 10 minutes.
    #[serde(rename = "auth.reauth_required")]
    ReauthRequired,
    /// The sign-in method is not configured on this server.
    #[serde(rename = "auth.provider_disabled")]
    ProviderDisabled,
    #[serde(rename = "auth.invalid_email")]
    InvalidEmail,
    /// Wrong code, or the code is unknown.
    #[serde(rename = "auth.code_invalid")]
    CodeInvalid,
    /// The code expired or its attempts are used up; request a new one.
    #[serde(rename = "auth.code_expired")]
    CodeExpired,
    /// The address may not create an account on this server.
    #[serde(rename = "auth.signup_closed")]
    SignupClosed,
    /// An unverified Google address that belongs to an existing account.
    #[serde(rename = "auth.email_unverified")]
    EmailUnverified,
    /// The identity already belongs to another account; accounts cannot be merged.
    #[serde(rename = "identity.in_use")]
    IdentityInUse,
    /// The last identity of an account cannot be unlinked.
    #[serde(rename = "identity.last")]
    IdentityLast,
    #[serde(rename = "not_found")]
    NotFound,
    #[serde(rename = "rate_limited")]
    RateLimited,
    #[serde(rename = "internal")]
    Internal,
}

impl ErrorCode {
    /// Whether the same request may simply be sent again.
    pub fn retry(self) -> bool {
        matches!(self, Self::RateLimited | Self::Internal | Self::AuthUnavailable)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ErrorPayload {
    pub code: ErrorCode,
    /// For logs and developers; never shown to users and never contains user content.
    pub message: String,
    pub retry: bool,
}

impl ErrorPayload {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), retry: code.retry() }
    }
}
