//! Agent sessions (docs/protocol.md, "Agent sessions"): the provider config a
//! socket runs its turns with, held in server memory only.

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use crate::{Bytes, Empty, Request, redact::Secret};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    OpenaiCompatible,
    Anthropic,
}

/// A provider config as the client decrypted it from the `settings` scope.
#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ProviderSettings {
    pub kind: ProviderKind,
    pub base_url: String,
    /// Empty for servers that need none (Ollama).
    pub api_key: Secret,
    pub model: String,
}

/// One entry of the `providers` setting, with its id.
#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct AgentProvider {
    pub id: Uuid,
    pub kind: ProviderKind,
    pub base_url: String,
    pub api_key: Secret,
    pub model: String,
}

impl AgentProvider {
    pub fn into_settings(self) -> (Uuid, ProviderSettings) {
        let Self { id, kind, base_url, api_key, model } = self;
        (id, ProviderSettings { kind, base_url, api_key, model })
    }
}

/// Providers one agent session may hold.
pub const PROVIDERS_MAX: usize = 32;

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct AgentStart {
    pub providers: Vec<AgentProvider>,
    /// The id of the provider a chat that names none runs with.
    pub active: Uuid,
}

impl AgentStart {
    /// At most [`PROVIDERS_MAX`] entries with distinct ids, `active` among them.
    pub fn valid(&self) -> bool {
        let mut ids: Vec<Uuid> = self.providers.iter().map(|p| p.id).collect();
        ids.sort_unstable();
        ids.dedup();
        self.providers.len() <= PROVIDERS_MAX && ids.len() == self.providers.len() && ids.contains(&self.active)
    }
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct AgentStarted {
    pub agent_session_id: Uuid,
}

impl Request for AgentStart {
    const TYPE: &'static str = "agent.start";
    type Response = AgentStarted;
}

#[derive(Debug, Default, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct AgentStop {}

impl Request for AgentStop {
    const TYPE: &'static str = "agent.stop";
    type Response = Empty;
}

/// Fingerprints one `agent.retire` may carry.
pub const RETIRE_MAX: usize = 64;

/// Ends the user's agent sessions started with these provider configs and
/// interrupts their turns, on every device (docs/protocol.md, "Agent
/// sessions"). Each fingerprint is 32 bytes.
#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct AgentRetire {
    pub fingerprints: Vec<Bytes>,
}

impl Request for AgentRetire {
    const TYPE: &'static str = "agent.retire";
    type Response = Empty;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_keys_never_print() {
        let start = AgentStart {
            providers: vec![AgentProvider {
                id: Uuid::nil(),
                kind: ProviderKind::Anthropic,
                base_url: "https://api.anthropic.com".into(),
                api_key: Secret("sk-ant-secret".into()),
                model: "m".into(),
            }],
            active: Uuid::nil(),
        };
        assert!(!format!("{start:?}").contains("secret"));
    }

    fn entry(id: u128) -> AgentProvider {
        AgentProvider {
            id: Uuid::from_u128(id),
            kind: ProviderKind::OpenaiCompatible,
            base_url: "https://api.example.com".into(),
            api_key: Secret(String::new()),
            model: "m".into(),
        }
    }

    #[test]
    fn a_start_names_distinct_providers_and_an_active_one_among_them() {
        let start = |ids: &[u128], active: u128| AgentStart {
            providers: ids.iter().map(|&i| entry(i)).collect(),
            active: Uuid::from_u128(active),
        };
        assert!(start(&[1, 2], 2).valid());
        assert!(!start(&[1, 2], 3).valid());
        assert!(!start(&[1, 1], 1).valid());
        assert!(!start(&[], 1).valid());
        let many: Vec<u128> = (0..=32).collect();
        assert!(!start(&many, 0).valid());
        assert!(start(&many[..32], 0).valid());
    }
}
