//! Files in chats (docs/protocol.md, "Files"; D-101). Objects travel over
//! HTTP (`PUT`/`GET /files/{file_id}`); these are the WebSocket messages
//! around them and the attachment lists of a message.

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use crate::{Bytes, Empty, Event, Request, redact::Secret};

/// The largest plaintext of a file, and of a turn's files together: the
/// smallest limit of the supported APIs (OpenAI's 50 MB for PDFs, D-101).
pub const FILE_MAX: u32 = 50_000_000;
/// Files a message carries at most.
pub const FILES_PER_MESSAGE: usize = 10;
/// Images one turn gives the model at most (Anthropic's limit per request).
pub const TURN_IMAGES_MAX: usize = 100;
/// The longest text file, in bytes of UTF-8.
pub const TEXT_FILE_MAX: usize = 200 * 1024;
/// The largest `file.preview` record.
pub const PREVIEW_RECORD_MAX: usize = 64 * 1024;
/// The longest description the model's text is cut to, in bytes of UTF-8.
pub const DESCRIPTION_MAX: usize = 4096;
/// The largest `file.key` record: 32 bytes of key in a padded record.
pub const KEY_RECORD_MAX: usize = 1024;
/// Ids one `file.records` names at most.
pub const RECORDS_MAX: usize = 64;
/// Files an account holds not yet attached to a message.
pub const UNATTACHED_MAX: i64 = 100;
/// The longest file name and MIME type kept, in bytes.
pub const NAME_MAX: usize = 255;
pub const TYPE_MAX: usize = 127;
/// The longest ThumbHash.
pub const HASH_MAX: usize = 32;

/// Registers a file before its object is uploaded.
#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct FileCreate {
    pub file_id: Uuid,
    /// The chat the records are sealed to; a new chat's may not exist yet.
    pub chat_id: Uuid,
    /// Bytes of the object.
    pub size: u32,
    /// A `file.key` record.
    pub key: Bytes,
    /// A `file.preview` record.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub preview: Option<Bytes>,
}

impl Request for FileCreate {
    const TYPE: &'static str = "file.create";
    type Response = Empty;
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct FileRecords {
    pub chat_id: Uuid,
    pub file_ids: Vec<Uuid>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct FileRecord {
    pub file_id: Uuid,
    /// Bytes of the object.
    pub size: u32,
    /// A `file.key` record.
    pub key: Bytes,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub preview: Option<Bytes>,
    /// A `file.description` record.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub description: Option<Bytes>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct FileRecordList {
    pub files: Vec<FileRecord>,
}

impl Request for FileRecords {
    const TYPE: &'static str = "file.records";
    type Response = FileRecordList;
}

#[derive(Debug, Default, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct FileUsage {}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct FileUsed {
    /// Bytes of the account's objects, stored and pending.
    pub used: i64,
    /// Absent without a quota.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub quota: Option<i64>,
}

impl Request for FileUsage {
    const TYPE: &'static str = "file.usage";
    type Response = FileUsed;
}

/// The model described a file; to every socket of the user.
#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct FileDescribed {
    pub chat_id: Uuid,
    pub file_id: Uuid,
    /// A `file.description` record.
    pub description: Bytes,
}

impl Event for FileDescribed {
    const TYPE: &'static str = "file.described";
}

/// An image's original, sent as it is beside its compressed copy.
#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct SentOriginal {
    pub file_id: Uuid,
    #[serde(rename = "type")]
    pub media_type: String,
    pub size: u32,
}

/// A file of a `message.send` or `turn.retry`. The key opens the object for
/// this turn only and is never stored or logged.
#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct SentFile {
    pub file_id: Uuid,
    /// The content key, 32 bytes.
    pub key: Bytes,
    pub name: Secret,
    #[serde(rename = "type")]
    pub media_type: String,
    /// Bytes of plaintext.
    pub size: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub w: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub h: Option<u32>,
    /// An image's ThumbHash.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub hash: Option<Bytes>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub original: Option<SentOriginal>,
}

impl SentFile {
    /// The shape a send checks before anything else.
    pub fn valid(&self) -> bool {
        let text = |s: &str, max: usize| !s.is_empty() && s.len() <= max;
        self.key.0.len() == 32
            && text(&self.name.0, NAME_MAX)
            && text(&self.media_type, TYPE_MAX)
            && (1..=FILE_MAX).contains(&self.size)
            && self.hash.as_ref().is_none_or(|h| h.0.len() <= HASH_MAX)
            && self.original.as_ref().is_none_or(|o| {
                text(&o.media_type, TYPE_MAX) && (1..=FILE_MAX).contains(&o.size) && o.file_id != self.file_id
            })
    }
}

/// A file of a context message: what the model is told about it instead of
/// the file (docs/protocol.md, "Files").
#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ContextFile {
    pub file_id: Uuid,
    pub name: Secret,
    #[serde(rename = "type")]
    pub media_type: String,
    pub size: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub w: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub h: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub description: Option<Secret>,
}

impl ContextFile {
    /// Bytes it adds to the context.
    pub fn bytes(&self) -> usize {
        self.name.0.len() + self.media_type.len() + self.description.as_ref().map_or(0, |d| d.0.len())
    }
}

/// An image's original in a message record.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
pub struct OriginalRef {
    /// The file id as a UUID string.
    pub id: String,
    #[serde(rename = "type")]
    pub media_type: String,
    pub size: u32,
}

/// An attachment as a message record lists it (docs/crypto.md, "Record contents").
#[derive(Clone, PartialEq, Eq, Deserialize, Serialize, TS)]
pub struct FileRef {
    /// The file id as a UUID string.
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub media_type: String,
    pub size: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub w: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub h: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub hash: Option<Bytes>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub original: Option<OriginalRef>,
}

/// The name is the user's.
impl std::fmt::Debug for FileRef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FileRef").field("id", &self.id).finish_non_exhaustive()
    }
}

impl From<&SentFile> for FileRef {
    fn from(file: &SentFile) -> Self {
        Self {
            id: file.file_id.to_string(),
            name: file.name.0.clone(),
            media_type: file.media_type.clone(),
            size: file.size,
            w: file.w,
            h: file.h,
            hash: file.hash.clone(),
            original: file.original.as_ref().map(|o| OriginalRef {
                id: o.file_id.to_string(),
                media_type: o.media_type.clone(),
                size: o.size,
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sent() -> SentFile {
        SentFile {
            file_id: Uuid::from_u128(1),
            key: Bytes(vec![7; 32]),
            name: Secret("photo.jpg".into()),
            media_type: "image/jpeg".into(),
            size: 1000,
            w: Some(2000),
            h: Some(1500),
            hash: Some(Bytes(vec![1; 25])),
            original: Some(SentOriginal { file_id: Uuid::from_u128(2), media_type: "image/heic".into(), size: 9000 }),
        }
    }

    #[test]
    fn a_sent_file_is_checked_and_its_key_never_prints_or_stays() {
        assert!(sent().valid());
        let bad = [
            SentFile { key: Bytes(vec![7; 31]), ..sent() },
            SentFile { name: Secret(String::new()), ..sent() },
            SentFile { size: FILE_MAX + 1, ..sent() },
            SentFile { hash: Some(Bytes(vec![1; 33])), ..sent() },
            SentFile {
                original: Some(SentOriginal { file_id: Uuid::from_u128(1), media_type: "image/png".into(), size: 1 }),
                ..sent()
            },
        ];
        for file in bad {
            assert!(!file.valid(), "{file:?}");
        }
        let debug = format!("{:?}", sent());
        assert!(!debug.contains("photo") && !debug.contains("7, 7"), "{debug}");
        // Without the ThumbHash, whose bytes a JSON value cannot hold.
        let kept = FileRef { hash: None, ..FileRef::from(&sent()) };
        let packed = rmp_serde::to_vec_named(&kept).unwrap();
        // The key is not in the record, and the ids are strings for the client.
        assert!(!packed.windows(32).any(|w| w == [7; 32]));
        let value: serde_json::Value = rmp_serde::from_slice(&packed).unwrap();
        assert_eq!(value["id"], "00000000-0000-0000-0000-000000000001");
        assert_eq!(value["type"], "image/jpeg");
        assert_eq!(value["original"]["id"], "00000000-0000-0000-0000-000000000002");
    }
}
