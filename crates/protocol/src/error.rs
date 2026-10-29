//! The `error` response (docs/protocol.md, "Envelope").

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Stable error codes; the client localizes by code.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum ErrorCode {
    /// The frame is not a valid envelope or payload (or, over HTTP, body).
    #[serde(rename = "protocol.malformed")]
    Malformed,
    /// No handler for this `type`.
    #[serde(rename = "protocol.unknown_type")]
    UnknownType,
    /// A request with id 0, which is reserved for events.
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
    /// A keys request before key setup.
    #[serde(rename = "keys.not_set_up")]
    KeysNotSetUp,
    /// Key setup when the account already has keys (another device won the race).
    #[serde(rename = "keys.exists")]
    KeysExists,
    /// A wrap or key that does not decode, or breaks a rule of the request.
    #[serde(rename = "keys.invalid")]
    KeysInvalid,
    /// Too many passkey wraps.
    #[serde(rename = "keys.limit")]
    KeysLimit,
    /// A device wrap for another device than the session's.
    #[serde(rename = "keys.device_mismatch")]
    KeysDeviceMismatch,
    /// The recovery wrap is rotated, never removed.
    #[serde(rename = "keys.recovery_required")]
    KeysRecoveryRequired,
    /// An unknown or expired link session, or one of another account.
    #[serde(rename = "link.not_found")]
    LinkNotFound,
    /// The link session already holds another message.
    #[serde(rename = "link.used")]
    LinkUsed,
    /// The agent session needs a provider config the server accepts.
    #[serde(rename = "agent.invalid_provider")]
    AgentInvalidProvider,
    /// A turn needs an agent session on this socket.
    #[serde(rename = "agent.not_started")]
    AgentNotStarted,
    /// A setting put based on another revision than the stored one.
    #[serde(rename = "settings.conflict")]
    SettingsConflict,
    /// Too many setting keys.
    #[serde(rename = "settings.limit")]
    SettingsLimit,
    /// An unknown chat, or one of another account.
    #[serde(rename = "chat.not_found")]
    ChatNotFound,
    /// `new_chat` with the id of an existing chat.
    #[serde(rename = "chat.exists")]
    ChatExists,
    /// An archived chat cannot be pinned.
    #[serde(rename = "chat.archived")]
    ChatArchived,
    /// Only an archived chat can be deleted.
    #[serde(rename = "chat.not_archived")]
    ChatNotArchived,
    #[serde(rename = "message.not_found")]
    MessageNotFound,
    /// Only the user's own messages can be edited.
    #[serde(rename = "message.not_editable")]
    MessageNotEditable,
    /// Only a failed reply that is the chat's last message can be retried.
    #[serde(rename = "message.not_retryable")]
    MessageNotRetryable,
    /// A streaming message cannot be deleted.
    #[serde(rename = "message.streaming")]
    MessageStreaming,
    #[serde(rename = "message.too_large")]
    MessageTooLarge,
    /// The chat has a running turn.
    #[serde(rename = "turn.busy")]
    TurnBusy,
    /// The account runs as many turns as it may at once, in other chats.
    #[serde(rename = "turn.limit")]
    TurnLimit,
    /// Too many saved messages.
    #[serde(rename = "saved.limit")]
    SavedLimit,
    /// The account has no notes scope yet.
    #[serde(rename = "notes.not_set_up")]
    NotesNotSetUp,
    #[serde(rename = "note.not_found")]
    NoteNotFound,
    /// `note.create` with the id of a note holding other records.
    #[serde(rename = "note.exists")]
    NoteExists,
    /// The note changed since the revision an update was based on.
    #[serde(rename = "note.conflict")]
    NoteConflict,
    /// Too many notes.
    #[serde(rename = "note.limit")]
    NoteLimit,
    /// No metric of the catalog has this key.
    #[serde(rename = "metric.not_found")]
    MetricNotFound,
    /// The account has no scope for the metric's register yet.
    #[serde(rename = "register.not_set_up")]
    RegisterNotSetUp,
    /// No such entry.
    #[serde(rename = "register.not_found")]
    RegisterNotFound,
    /// `register.create` with the id of an entry holding other fields.
    #[serde(rename = "register.exists")]
    RegisterExists,
    /// The entry changed since the revision an update was based on.
    #[serde(rename = "register.conflict")]
    RegisterConflict,
    /// Too many entries.
    #[serde(rename = "register.limit")]
    RegisterLimit,
    /// No waiting permission request of this auth session has this id: answered, expired or another's.
    #[serde(rename = "permission.not_found")]
    PermissionNotFound,
    /// The server has no file store.
    #[serde(rename = "files.disabled")]
    FilesDisabled,
    /// The account's files would pass its quota.
    #[serde(rename = "files.quota")]
    FilesQuota,
    /// A file past the size limit.
    #[serde(rename = "file.too_large")]
    FileTooLarge,
    /// Too many files not yet attached to a message.
    #[serde(rename = "file.limit")]
    FileLimit,
    /// An unknown file, another account's, one not uploaded, or (for a send) not of this chat or attached already.
    #[serde(rename = "file.not_found")]
    FileNotFound,
    /// The file's object is stored already, or its upload is in progress.
    #[serde(rename = "file.exists")]
    FileExists,
    #[serde(rename = "not_found")]
    NotFound,
    #[serde(rename = "rate_limited")]
    RateLimited,
    /// The server is at capacity or the request ran out of time; retry shortly.
    #[serde(rename = "unavailable")]
    Unavailable,
    #[serde(rename = "internal")]
    Internal,
}

impl ErrorCode {
    /// Whether the same request may simply be sent again.
    pub fn retry(self) -> bool {
        matches!(self, Self::RateLimited | Self::Internal | Self::AuthUnavailable | Self::Unavailable)
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
