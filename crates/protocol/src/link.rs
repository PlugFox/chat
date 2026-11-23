//! Device linking messages (docs/protocol.md, "Keys"; docs/crypto.md, "Device
//! linking"). The server relays one sealed message and never sees the QR's key
//! or secret.

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use crate::{Bytes, Empty, Event, Request};

/// The longest link message the server stores; a sealed ARK is 81 bytes.
pub const LINK_MESSAGE_MAX: usize = 256;

#[derive(Debug, Default, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct LinkCreate {}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct LinkCreated {
    pub sid: Uuid,
    /// How long the link lives, from now: a duration, so a client with a wrong
    /// clock still renews its code in time.
    pub expires_in_ms: u32,
}

impl Request for LinkCreate {
    const TYPE: &'static str = "link.create";
    type Response = LinkCreated;
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct LinkInfo {
    pub sid: Uuid,
}

/// The session that created the link, as the server recorded it.
#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct LinkRequester {
    /// When the link was created, in milliseconds.
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub user_agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub country: Option<String>,
}

impl Request for LinkInfo {
    const TYPE: &'static str = "link.info";
    type Response = LinkRequester;
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct LinkPost {
    pub sid: Uuid,
    pub message: Bytes,
}

impl Request for LinkPost {
    const TYPE: &'static str = "link.post";
    type Response = Empty;
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct LinkGet {
    pub sid: Uuid,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct LinkState {
    /// Absent until the unlocked device posted it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub message: Option<Bytes>,
}

impl Request for LinkGet {
    const TYPE: &'static str = "link.get";
    type Response = LinkState;
}

/// Event to the creating session: the unlocked device posted its message.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct LinkMessage {
    pub sid: Uuid,
    pub message: Bytes,
}

impl Event for LinkMessage {
    const TYPE: &'static str = "link.message";
}
