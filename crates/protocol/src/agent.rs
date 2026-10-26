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

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct AgentStart {
    pub provider: ProviderSettings,
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
            provider: ProviderSettings {
                kind: ProviderKind::Anthropic,
                base_url: "https://api.anthropic.com".into(),
                api_key: Secret("sk-ant-secret".into()),
                model: "m".into(),
            },
        };
        assert!(!format!("{start:?}").contains("secret"));
    }
}
