//! Settings (docs/protocol.md, "Settings"): `settings.value` records in the
//! account's `settings` scope, one per plaintext key, which the server stores
//! without reading.

use std::fmt;

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use crate::{Bytes, Event, Request, agent::ProviderKind, redact::Secret};

/// The longest record a setting holds.
pub const SETTING_MAX: usize = 64 * 1024;
/// Keys an account holds at most.
pub const SETTINGS_MAX: i64 = 32;
/// The key of the provider list ([`ProvidersValue`]).
pub const PROVIDERS_KEY: &str = "providers";

/// Whether `key` is a valid setting key: 1 to 64 of `a-z`, `0-9`, `.`, `_`, `-`.
pub fn valid_key(key: &str) -> bool {
    (1..=64).contains(&key.len())
        && key.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct SettingsGet {
    pub key: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct SettingValue {
    pub record: Bytes,
    pub rev: i64,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct SettingState {
    /// Absent for a key never put.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub value: Option<SettingValue>,
}

impl Request for SettingsGet {
    const TYPE: &'static str = "settings.get";
    type Response = SettingState;
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct SettingsPut {
    pub key: String,
    pub record: Bytes,
    /// The revision this change was based on; absent for a new key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub rev: Option<i64>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct SettingStored {
    pub rev: i64,
}

impl Request for SettingsPut {
    const TYPE: &'static str = "settings.put";
    type Response = SettingStored;
}

/// Event to every socket of the user: a setting was put.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct SettingsUpdated {
    pub key: String,
    pub record: Bytes,
    pub rev: i64,
}

impl Event for SettingsUpdated {
    const TYPE: &'static str = "settings.updated";
}

/// The plaintext of the `providers` setting (docs/crypto.md, "Record
/// contents"): a MessagePack map, written and read by the client only.
/// Unknown fields are ignored on reading.
#[derive(Deserialize, Serialize, TS)]
pub struct ProvidersValue {
    pub providers: Vec<StoredProvider>,
    /// The provider turns use.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub active: Option<Uuid>,
}

impl fmt::Debug for ProvidersValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ProvidersValue(<redacted>)")
    }
}

#[derive(Debug, Deserialize, Serialize, TS)]
pub struct StoredProvider {
    pub id: Uuid,
    pub name: String,
    pub kind: ProviderKind,
    pub base_url: String,
    /// Empty for servers that need none (Ollama).
    pub api_key: Secret,
    pub model: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_checked() {
        for key in ["providers", "a", "ui.theme-2_x", &"k".repeat(64)] {
            assert!(valid_key(key), "{key}");
        }
        for key in ["", "Providers", "a b", "ключ", "a/b", &"k".repeat(65)] {
            assert!(!valid_key(key), "{key}");
        }
    }
}
