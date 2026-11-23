//! Notes (docs/protocol.md, "Notes"): the account's one notebook in v1, its
//! `note.title` and `note.body` records sealed by the client to the notes
//! scope, which the server stores without reading.

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use crate::{Bytes, Empty, Event, Request};

/// Notes per `note.list` page.
pub const NOTES_PAGE: usize = 100;
/// Notes an account holds at most.
pub const NOTES_MAX: i64 = 10_000;
/// The longest `note.title` record.
pub const NOTE_TITLE_MAX: usize = 2048;
/// The longest `note.body` record.
pub const NOTE_BODY_MAX: usize = 256 * 1024;

/// Creates the notes scope, unless the account has one.
#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct NotesSetup {
    pub scope_id: Uuid,
    pub public_key: Bytes,
    pub wrapped_private_key: Bytes,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct NotesScope {
    /// The account's notes scope: the one sent, or the one another request created first.
    pub scope_id: Uuid,
}

impl Request for NotesSetup {
    const TYPE: &'static str = "notes.setup";
    type Response = NotesScope;
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct NoteInfo {
    pub note_id: Uuid,
    /// A `note.title` record: the title and the start of the text.
    pub title: Bytes,
    /// Milliseconds.
    pub created_at: i64,
    /// Milliseconds; grows with every change.
    pub updated_at: i64,
    pub rev: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct NoteCursor {
    pub updated_at: i64,
    pub note_id: Uuid,
}

#[derive(Debug, Default, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct NoteList {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub before: Option<NoteCursor>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct NotePage {
    /// Absent until the notes scope exists.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub scope_id: Option<Uuid>,
    /// Newest first.
    pub notes: Vec<NoteInfo>,
    /// The `before` of the next page; absent on the last.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub next: Option<NoteCursor>,
}

impl Request for NoteList {
    const TYPE: &'static str = "note.list";
    type Response = NotePage;
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct NoteGet {
    pub note_id: Uuid,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct NoteOpened {
    pub note: NoteInfo,
    /// A `note.body` record.
    pub body: Bytes,
}

impl Request for NoteGet {
    const TYPE: &'static str = "note.get";
    type Response = NoteOpened;
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct NoteCreate {
    /// Chosen by the client.
    pub note_id: Uuid,
    pub title: Bytes,
    pub body: Bytes,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct NoteStored {
    pub note: NoteInfo,
}

impl Request for NoteCreate {
    const TYPE: &'static str = "note.create";
    type Response = NoteStored;
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct NoteUpdate {
    pub note_id: Uuid,
    /// The revision this change was based on.
    pub rev: i64,
    pub title: Bytes,
    pub body: Bytes,
}

impl Request for NoteUpdate {
    const TYPE: &'static str = "note.update";
    type Response = NoteStored;
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct NoteDelete {
    pub note_id: Uuid,
}

impl Request for NoteDelete {
    const TYPE: &'static str = "note.delete";
    type Response = Empty;
}

/// Event to every socket of the user: a note was created or changed.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct NoteUpdated {
    pub note: NoteInfo,
}

impl Event for NoteUpdated {
    const TYPE: &'static str = "note.updated";
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct NoteDeleted {
    pub note_id: Uuid,
}

impl Event for NoteDeleted {
    const TYPE: &'static str = "note.deleted";
}
