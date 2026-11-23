//! Connection messages: `auth`, `auth.renew`, `ping` (docs/protocol.md,
//! "Connection lifecycle").

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use crate::{Empty, Request, redact::Secret};

/// The first frame on every socket.
#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct Auth {
    /// The protocol version the client speaks.
    pub v: u32,
    pub access_token: Secret,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub resume: Option<Resume>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct Resume {
    pub agent_session_id: Uuid,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct AuthOk {
    pub session_id: Uuid,
    /// How often the client sends `ping`.
    pub heartbeat_ms: u32,
    /// Server clock, milliseconds since the Unix epoch.
    pub server_time: i64,
    /// The agent session `resume` picked up.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub agent_session_id: Option<Uuid>,
    /// The server has a file store (docs/protocol.md, "Files").
    pub files: bool,
}

impl Request for Auth {
    const TYPE: &'static str = "auth";
    type Response = AuthOk;
}

/// A fresh access token for the open socket, sent before the old one expires.
#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct AuthRenew {
    pub access_token: Secret,
}

impl Request for AuthRenew {
    const TYPE: &'static str = "auth.renew";
    type Response = Empty;
}

/// Heartbeat. Browsers cannot send WebSocket-level pings, hence this.
#[derive(Debug, Default, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct Ping {}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct Pong {
    /// Server clock, milliseconds since the Unix epoch.
    pub server_time: i64,
}

impl Request for Ping {
    const TYPE: &'static str = "ping";
    type Response = Pong;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_never_print() {
        let auth: Auth = serde_json::from_str(r#"{"v":1,"access_token":"eyJ.secret.sig"}"#).unwrap();
        assert!(!format!("{auth:?}").contains("secret"));
        assert_eq!(auth.access_token.0, "eyJ.secret.sig");
    }
}
