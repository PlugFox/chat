//! Saved messages (docs/protocol.md, "Saved messages"): references to
//! `(chat, message)`; the records travel as `message.chunks` returns them.

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use crate::{
    Empty, Event, Request,
    chat::{ChatInfo, ChatMessage},
};

/// Saved messages per `saved.list` page.
pub const SAVED_PAGE: usize = 32;
/// Saved messages an account holds at most.
pub const SAVED_MAX: i64 = 10_000;

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct SavedAt {
    /// Milliseconds.
    pub saved_at: i64,
}

/// Saves a message; saving a saved one returns when it was saved.
#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct SavedAdd {
    pub chat_id: Uuid,
    pub message_id: u32,
}

impl Request for SavedAdd {
    const TYPE: &'static str = "saved.add";
    type Response = SavedAt;
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct SavedRemove {
    pub chat_id: Uuid,
    pub message_id: u32,
}

impl Request for SavedRemove {
    const TYPE: &'static str = "saved.remove";
    type Response = Empty;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct SavedCursor {
    pub saved_at: i64,
    pub chat_id: Uuid,
    pub message_id: u32,
}

#[derive(Debug, Default, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct SavedList {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub before: Option<SavedCursor>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct SavedItem {
    pub saved_at: i64,
    pub chat: ChatInfo,
    pub message: ChatMessage,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct SavedPage {
    /// Newest first; a page may span several parts.
    pub items: Vec<SavedItem>,
    /// The `before` of the next page; absent on the last. Only the last part has it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub next: Option<SavedCursor>,
}

impl Request for SavedList {
    const TYPE: &'static str = "saved.list";
    type Response = SavedPage;
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct SavedChat {
    pub chat_id: Uuid,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct SavedIds {
    pub message_ids: Vec<u32>,
}

impl Request for SavedChat {
    const TYPE: &'static str = "saved.chat";
    type Response = SavedIds;
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct SavedUpdated {
    pub chat_id: Uuid,
    pub message_id: u32,
    /// Absent: no longer saved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub saved_at: Option<i64>,
}

impl Event for SavedUpdated {
    const TYPE: &'static str = "saved.updated";
}
