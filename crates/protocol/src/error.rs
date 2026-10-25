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
    #[serde(rename = "rate_limited")]
    RateLimited,
    #[serde(rename = "internal")]
    Internal,
}

impl ErrorCode {
    /// Whether the same request may simply be sent again.
    pub fn retry(self) -> bool {
        matches!(self, Self::RateLimited | Self::Internal)
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
