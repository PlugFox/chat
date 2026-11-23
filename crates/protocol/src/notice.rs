//! Notices: what the server tells every socket of the user about work that
//! ended on its own, for a toast (docs/protocol.md, "Notices").

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use crate::Event;

/// What happened; the client localizes by code.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum NoticeCode {
    /// The model could not describe a file in its last try; later turns
    /// name the file without a description.
    #[serde(rename = "file.undescribed")]
    FileUndescribed,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct Notice {
    pub code: NoticeCode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub chat_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub file_id: Option<Uuid>,
}

impl Event for Notice {
    const TYPE: &'static str = "notice";
}
