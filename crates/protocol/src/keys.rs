//! Keys messages: setup, unlock material and unlock methods (docs/protocol.md,
//! "Keys"). Every binary value is in a format of docs/crypto.md; the server
//! checks wraps with `chat-crypto` and stores them as they came.

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use crate::{Bytes, Empty, Request};

/// The scopes created at key setup, one of each per account.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
pub enum AccountScopeKind {
    #[serde(rename = "settings")]
    Settings,
    #[serde(rename = "audit")]
    Audit,
    #[serde(rename = "profile:basics")]
    ProfileBasics,
    #[serde(rename = "profile:medical")]
    ProfileMedical,
    #[serde(rename = "profile:lifestyle")]
    ProfileLifestyle,
}

impl AccountScopeKind {
    pub const ALL: [Self; 5] =
        [Self::Settings, Self::Audit, Self::ProfileBasics, Self::ProfileMedical, Self::ProfileLifestyle];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Settings => "settings",
            Self::Audit => "audit",
            Self::ProfileBasics => "profile:basics",
            Self::ProfileMedical => "profile:medical",
            Self::ProfileLifestyle => "profile:lifestyle",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|k| k.as_str() == s)
    }
}

#[derive(Debug, Default, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct KeysGet {}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct KeysState {
    /// Absent before key setup.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub keys: Option<AccountKeys>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct AccountKeys {
    pub commitment: Bytes,
    pub writer_public_key: Bytes,
    /// Passkey and recovery wraps, and this session's device wrap if any.
    pub wraps: Vec<StoredWrap>,
    pub scopes: Vec<AccountScope>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct StoredWrap {
    pub wrap: Bytes,
    /// Milliseconds since the Unix epoch.
    pub created_at: i64,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct AccountScope {
    pub scope_id: Uuid,
    pub kind: AccountScopeKind,
}

impl Request for KeysGet {
    const TYPE: &'static str = "keys.get";
    type Response = KeysState;
}

/// First key setup: everything in one transaction (docs/crypto.md, "First key setup").
#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct KeysSetup {
    pub commitment: Bytes,
    pub writer_public_key: Bytes,
    /// One recovery wrap and any passkey wraps.
    pub wraps: Vec<Bytes>,
    pub scopes: Vec<NewAccountScope>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct NewAccountScope {
    pub scope_id: Uuid,
    pub kind: AccountScopeKind,
    pub public_key: Bytes,
    pub wrapped_private_key: Bytes,
}

impl Request for KeysSetup {
    const TYPE: &'static str = "keys.setup";
    type Response = Empty;
}

/// A passkey wrap, or the wrap of the session's own device.
#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct KeysWrapAdd {
    pub wrap: Bytes,
}

impl Request for KeysWrapAdd {
    const TYPE: &'static str = "keys.wrap_add";
    type Response = Empty;
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct KeysWrapRemove {
    pub wrap_id: Uuid,
}

impl Request for KeysWrapRemove {
    const TYPE: &'static str = "keys.wrap_remove";
    type Response = Empty;
}

/// Replaces the recovery wrap, after the user confirmed the new words.
#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct KeysRecoveryRotate {
    pub wrap: Bytes,
}

impl Request for KeysRecoveryRotate {
    const TYPE: &'static str = "keys.recovery_rotate";
    type Response = Empty;
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ScopeKeys {
    pub scope_ids: Vec<Uuid>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ScopeKeyList {
    /// Every key version of the requested scopes the user owns; unknown ids are left out.
    pub keys: Vec<ScopeKey>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ScopeKey {
    pub scope_id: Uuid,
    pub key_version: u32,
    pub public_key: Bytes,
    pub wrapped_private_key: Bytes,
}

impl Request for ScopeKeys {
    const TYPE: &'static str = "scope.keys";
    type Response = ScopeKeyList;
}

/// The most scope ids one `scope.keys` may name.
pub const SCOPE_KEYS_MAX: usize = 64;
/// The most passkey wraps an account may hold.
pub const PASSKEYS_MAX: usize = 20;
