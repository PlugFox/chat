//! Chats and messages (docs/protocol.md, "Chats and messages"). Titles and
//! messages travel as records (docs/crypto.md); the plaintext fields here are
//! turn content, which the server uses for the turn and never stores.

use std::fmt;

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use crate::{Bytes, Empty, Event, Request, redact::Secret};

/// Messages per chunk: `chunk = id >> CHUNK_SHIFT`.
pub const CHUNK_SHIFT: u32 = 6;
/// The most chunks one `message.chunks` may name.
pub const CHUNKS_MAX: usize = 8;
/// Chats per `chat.list` page.
pub const CHATS_PAGE: usize = 100;
pub const PINS_MAX: usize = 32;
/// The longest message text, the user's or a reply, in bytes.
pub const TEXT_MAX: usize = 200 * 1024;
/// The longest turn context (summary and messages), in bytes.
pub const CONTEXT_MAX: usize = 512 * 1024;
/// The largest record (docs/protocol.md, "Limits").
pub const RECORD_MAX: usize = 256 * 1024;
/// The largest title record: a title is at most 1 KiB of text.
pub const TITLE_RECORD_MAX: usize = 2048;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum Author {
    User,
    Assistant,
    Tool,
    Summary,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum MessageState {
    Complete,
    Streaming,
    Cancelled,
    Failed,
}

/// How hard the model thinks, sent to the provider as its reasoning effort.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum Effort {
    Low,
    Medium,
    High,
}

/// The most recent messages a chat may choose to send.
pub const HISTORY_MESSAGES_MAX: u16 = 500;

/// How much history a turn carries (D-091); the client builds the context.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum History {
    /// The latest `messages` messages.
    Recent { messages: u16 },
    /// The current summary and the messages after its cut; with `auto` the
    /// client compacts past `threshold` tokens.
    Compact {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        auto: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        threshold: Option<u32>,
    },
}

/// The auto-compaction thresholds a chat may choose, in estimated tokens
/// (UTF-8 bytes / 4): the top is about what a context of `CONTEXT_MAX` holds.
pub const COMPACT_THRESHOLD_MIN: u32 = 4_000;
pub const COMPACT_THRESHOLD_MAX: u32 = 128_000;

/// A chat's settings (docs/protocol.md, "Chat settings"): plaintext, as the
/// server sees them during a turn anyway (D-093). An absent field takes the
/// account's default.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ChatSettings {
    /// The id of an entry of the `providers` setting.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub provider: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub effort: Option<Effort>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub history: Option<History>,
}

impl ChatSettings {
    pub fn valid(&self) -> bool {
        match self.history {
            Some(History::Recent { messages }) => (1..=HISTORY_MESSAGES_MAX).contains(&messages),
            Some(History::Compact { threshold, .. }) => {
                threshold.is_none_or(|t| (COMPACT_THRESHOLD_MIN..=COMPACT_THRESHOLD_MAX).contains(&t))
            }
            None => true,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ChatInfo {
    /// The chat's scope id.
    pub chat_id: Uuid,
    /// A `chat.title` record.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub title: Option<Bytes>,
    pub created_at: i64,
    /// When the last message was created, in milliseconds.
    pub updated_at: i64,
    pub last_message_id: u32,
    pub rev: i64,
    /// A turn is running.
    pub turn: bool,
    /// The position among the pinned chats, from 0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub pin: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub archived_at: Option<i64>,
    pub settings: ChatSettings,
    /// The current summary: the complete one with the largest `through`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub summary_id: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ChatMessage {
    pub id: u32,
    pub author: Author,
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub edited_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub deleted_at: Option<i64>,
    pub state: MessageState,
    pub rev: i64,
    /// A `chat.message` record; absent on a tombstone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub record: Option<Bytes>,
    /// The last delta a streaming snapshot includes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub seq: Option<u32>,
    /// Why a `failed` reply failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<TurnErrorCode>,
    /// On a summary, the last message id it covers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub through: Option<u32>,
}

/// The plaintext of a `chat.message` record (docs/crypto.md, "Record
/// contents"): a MessagePack map. Unknown fields are ignored on reading.
#[derive(Clone, PartialEq, Eq, Deserialize, Serialize, TS)]
pub struct MessageContent {
    pub text: String,
}

impl fmt::Debug for MessageContent {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("MessageContent(<redacted>)")
    }
}

impl MessageContent {
    pub fn encode(&self) -> Vec<u8> {
        // A struct of one string always serializes.
        rmp_serde::to_vec_named(self).unwrap_or_default()
    }

    pub fn decode(bytes: &[u8]) -> Option<Self> {
        rmp_serde::from_slice(bytes).ok()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ChatCursor {
    pub updated_at: i64,
    pub chat_id: Uuid,
}

#[derive(Debug, Default, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ChatList {
    /// Page the archive instead of the other chats.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub archived: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub before: Option<ChatCursor>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ChatPage {
    /// On the first page outside the archive: every pinned chat first, in pin order.
    pub chats: Vec<ChatInfo>,
    /// The `before` of the next page; absent on the last.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub next: Option<ChatCursor>,
}

impl Request for ChatList {
    const TYPE: &'static str = "chat.list";
    type Response = ChatPage;
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ChatRename {
    pub chat_id: Uuid,
    pub title: Bytes,
}

impl Request for ChatRename {
    const TYPE: &'static str = "chat.rename";
    type Response = Empty;
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ChatPin {
    pub chat_id: Uuid,
    /// Where to put the chat among the pinned ones; absent unpins it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub position: Option<u8>,
}

impl Request for ChatPin {
    const TYPE: &'static str = "chat.pin";
    type Response = Empty;
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ChatArchive {
    pub chat_id: Uuid,
    pub archived: bool,
}

impl Request for ChatArchive {
    const TYPE: &'static str = "chat.archive";
    type Response = Empty;
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ChatDelete {
    pub chat_id: Uuid,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ChatConfigure {
    pub chat_id: Uuid,
    pub settings: ChatSettings,
}

impl Request for ChatConfigure {
    const TYPE: &'static str = "chat.configure";
    type Response = Empty;
}

impl Request for ChatDelete {
    const TYPE: &'static str = "chat.delete";
    type Response = Empty;
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct NewChat {
    pub public_key: Bytes,
    pub wrapped_private_key: Bytes,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub title: Option<Bytes>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub settings: Option<ChatSettings>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    User,
    Assistant,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ContextMessage {
    pub id: u32,
    pub role: Role,
    pub text: Secret,
}

/// What the client chose to send with the turn; never stored.
#[derive(Debug, Default, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct TurnContext {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub summary: Option<Secret>,
    pub messages: Vec<ContextMessage>,
}

impl TurnContext {
    pub fn bytes(&self) -> usize {
        self.summary.as_ref().map_or(0, |s| s.0.len()) + self.messages.iter().map(|m| m.text.0.len()).sum::<usize>()
    }
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct MessageSend {
    pub idempotency_key: Uuid,
    pub chat_id: Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub new_chat: Option<NewChat>,
    pub text: Secret,
    pub context: TurnContext,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct MessageSent {
    pub message_id: u32,
    pub turn_id: Uuid,
}

impl Request for MessageSend {
    const TYPE: &'static str = "message.send";
    type Response = MessageSent;
}

/// Folds `context` (the previous summary and the messages after its cut, up
/// to `through`) into a new summary message (docs/protocol.md, "Compaction").
#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ChatCompact {
    pub chat_id: Uuid,
    pub through: u32,
    pub context: TurnContext,
}

impl Request for ChatCompact {
    const TYPE: &'static str = "chat.compact";
    type Response = MessageSent;
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ChunkRequest {
    pub chunk: u32,
    /// The chunk revision the client holds: only later changes come back.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub rev: Option<i64>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct MessageChunks {
    pub chat_id: Uuid,
    pub chunks: Vec<ChunkRequest>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ChunkList {
    pub chat_id: Uuid,
    /// A chunk may span several parts, each with some of its messages.
    pub chunks: Vec<Chunk>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct Chunk {
    pub chunk: u32,
    /// The largest `rev` among the chunk's messages; 0 for an empty chunk.
    pub rev: i64,
    pub messages: Vec<ChatMessage>,
}

impl Request for MessageChunks {
    const TYPE: &'static str = "message.chunks";
    type Response = ChunkList;
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct MessageEdit {
    pub chat_id: Uuid,
    pub message_id: u32,
    /// A `chat.message` record sealed by the client in auth mode.
    pub record: Bytes,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct Revision {
    pub rev: i64,
}

impl Request for MessageEdit {
    const TYPE: &'static str = "message.edit";
    type Response = Revision;
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct MessageDelete {
    pub chat_id: Uuid,
    pub message_id: u32,
}

impl Request for MessageDelete {
    const TYPE: &'static str = "message.delete";
    type Response = Revision;
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct TurnCancel {
    pub chat_id: Uuid,
}

impl Request for TurnCancel {
    const TYPE: &'static str = "turn.cancel";
    type Response = Empty;
}

/// Runs the failed reply `message_id` again; `text` is the user message it
/// answers, `context` what came before it.
#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct TurnRetry {
    pub chat_id: Uuid,
    pub message_id: u32,
    pub text: Secret,
    pub context: TurnContext,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct TurnStarted {
    pub turn_id: Uuid,
}

impl Request for TurnRetry {
    const TYPE: &'static str = "turn.retry";
    type Response = TurnStarted;
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ChatUpdated {
    pub chat: ChatInfo,
}

impl Event for ChatUpdated {
    const TYPE: &'static str = "chat.updated";
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ChatDeleted {
    pub chat_id: Uuid,
}

impl Event for ChatDeleted {
    const TYPE: &'static str = "chat.deleted";
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct MessageCreated {
    pub chat_id: Uuid,
    pub message: ChatMessage,
}

impl Event for MessageCreated {
    const TYPE: &'static str = "message.created";
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct MessageUpdated {
    pub chat_id: Uuid,
    pub message: ChatMessage,
}

impl Event for MessageUpdated {
    const TYPE: &'static str = "message.updated";
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct MessageDeleted {
    pub chat_id: Uuid,
    pub message_id: u32,
    pub rev: i64,
}

impl Event for MessageDeleted {
    const TYPE: &'static str = "message.deleted";
}

/// Reply text as it streams; turn content, never stored (docs/protocol.md, "Streaming").
#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct MessageDelta {
    pub chat_id: Uuid,
    pub message_id: u32,
    pub seq: u32,
    pub text: Secret,
}

impl Event for MessageDelta {
    const TYPE: &'static str = "message.delta";
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct TurnDone {
    pub chat_id: Uuid,
    pub turn_id: Uuid,
}

impl Event for TurnDone {
    const TYPE: &'static str = "turn.done";
}

/// Why a turn failed; the client localizes by code.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum TurnErrorCode {
    /// The provider's address is not allowed by the server's network policy.
    #[serde(rename = "provider.blocked")]
    ProviderBlocked,
    #[serde(rename = "provider.unreachable")]
    ProviderUnreachable,
    /// The provider answered with an error status.
    #[serde(rename = "provider.refused")]
    ProviderRefused,
    /// A response the server cannot read.
    #[serde(rename = "provider.invalid")]
    ProviderInvalid,
    /// The reply passed `TEXT_MAX`.
    #[serde(rename = "turn.too_long")]
    TooLong,
    /// The turn ran past its time limit.
    #[serde(rename = "turn.timed_out")]
    TimedOut,
    /// The provider was retired, the auth session revoked or the server stopped.
    #[serde(rename = "turn.interrupted")]
    Interrupted,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct TurnError {
    pub chat_id: Uuid,
    pub turn_id: Uuid,
    pub code: TurnErrorCode,
}

impl Event for TurnError {
    const TYPE: &'static str = "turn.error";
}

/// Events may have been missed: drop the fetched chunks and reload, as after a reconnect.
#[derive(Debug, Default, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct SyncReset {}

impl Event for SyncReset {
    const TYPE: &'static str = "sync.reset";
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::decode;

    #[test]
    fn settings_travel_as_msgpack_and_json_and_refuse_what_they_do_not_know() {
        let settings = ChatSettings {
            provider: Some(Uuid::from_u128(1)),
            effort: Some(Effort::High),
            history: Some(History::Recent { messages: 50 }),
        };
        let packed = rmp_serde::to_vec_named(&settings).unwrap();
        assert_eq!(decode::<ChatSettings>(&packed).unwrap(), settings);
        let json = serde_json::to_value(&settings).unwrap();
        assert_eq!(json["history"], serde_json::json!({ "mode": "recent", "messages": 50 }));
        assert_eq!(serde_json::from_value::<ChatSettings>(json).unwrap(), settings);
        let compact: ChatSettings = serde_json::from_str(r#"{"history":{"mode":"compact"}}"#).unwrap();
        assert_eq!(compact.history, Some(History::Compact { auto: None, threshold: None }));
        let off: ChatSettings = serde_json::from_str(r#"{"history":{"mode":"compact","auto":false}}"#).unwrap();
        assert_eq!(off.history, Some(History::Compact { auto: Some(false), threshold: None }));
        assert!(serde_json::from_str::<ChatSettings>(r#"{"model":"x"}"#).is_err());
        assert!(serde_json::from_str::<ChatSettings>(r#"{"history":{"mode":"compact","messages":3}}"#).is_err());
        assert!(serde_json::from_str::<ChatSettings>(r#"{"history":{"mode":"all"}}"#).is_err());
        let recent = |messages| ChatSettings { history: Some(History::Recent { messages }), ..ChatSettings::default() };
        assert!(recent(1).valid() && recent(HISTORY_MESSAGES_MAX).valid());
        assert!(!recent(0).valid() && !recent(HISTORY_MESSAGES_MAX + 1).valid());
        let at = |threshold| ChatSettings {
            history: Some(History::Compact { auto: None, threshold: Some(threshold) }),
            ..ChatSettings::default()
        };
        assert!(at(COMPACT_THRESHOLD_MIN).valid() && at(COMPACT_THRESHOLD_MAX).valid());
        assert!(!at(COMPACT_THRESHOLD_MIN - 1).valid() && !at(COMPACT_THRESHOLD_MAX + 1).valid());
    }

    #[test]
    fn content_reads_past_unknown_fields() {
        let content = MessageContent { text: "hi".into() };
        assert_eq!(MessageContent::decode(&content.encode()), Some(content.clone()));
        #[derive(Serialize)]
        struct Later<'a> {
            text: &'a str,
            attachments: Vec<u32>,
        }
        let later = rmp_serde::to_vec_named(&Later { text: "hi", attachments: vec![1] }).unwrap();
        assert_eq!(MessageContent::decode(&later), Some(content.clone()));
        assert!(!format!("{content:?}").contains("hi"));
    }

    #[test]
    fn turn_text_never_prints() {
        let delta = MessageDelta { chat_id: Uuid::nil(), message_id: 1, seq: 2, text: Secret("private".into()) };
        assert!(!format!("{delta:?}").contains("private"));
    }
}
