//! Chats and messages in PostgreSQL (docs/protocol.md, "Chats and messages").
//! The server seals messages to the chat's scope key (D-016) and stores
//! records as they came; it never opens one. Every change is published on
//! the bus after its transaction commits.

pub mod turn;

use std::collections::HashMap;

use chat_crypto::{
    PublicKey,
    ids::{ScopeId, UserId},
    os_rng,
    record::{self, Kind, Place},
    scope::ScopePublicKey,
};
use chat_protocol::{
    Bytes,
    chat::{
        Author, CHATS_PAGE, CHUNK_SHIFT, CHUNKS_MAX, CONTEXT_MAX, ChatCursor, ChatDeleted, ChatInfo, ChatMessage,
        ChatPage, ChatUpdated, Chunk, ChunkList, ChunkRequest, MessageContent, MessageCreated, MessageDeleted,
        MessageSend, MessageSent, MessageState, MessageUpdated, PINS_MAX, RECORD_MAX, TEXT_MAX, TITLE_RECORD_MAX,
    },
    error::ErrorCode,
};
use serde_json::json;
use sqlx::PgConnection;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::{
    agent::Agent,
    app::AppState,
    auth::{
        Principal,
        audit::{self, Event, Kind as AuditKind, millis},
        client::ClientInfo,
    },
    bus::{Note, Target},
    keys::KeysError::{self, Refused},
};

type Result<T> = std::result::Result<T, KeysError>;

const KEY_LEN: usize = 32;
/// Matches the `scope_keys` column check.
const WRAPPED_KEY_MAX: usize = 256;

/// The columns of a [`ChatInfo`], for `chat_info`.
macro_rules! chat_columns {
    () => {
        "c.id, c.title, c.created_at, c.updated_at, c.next_message_id, c.rev,
         (c.turn_id IS NOT NULL AND c.turn_expires_at > now()), c.pin, c.archived_at"
    };
}

/// The columns of a [`ChatMessage`], for `chat_message`.
macro_rules! message_columns {
    () => {
        "m.id, m.author, m.state, m.rev, m.record, m.seq, m.created_at, m.edited_at, m.deleted_at"
    };
}

type ChatRow = (Uuid, Option<Vec<u8>>, OffsetDateTime, i64, i64, i64, bool, Option<i16>, Option<OffsetDateTime>);
type MessageRow =
    (i64, i16, i16, i64, Option<Vec<u8>>, Option<i32>, OffsetDateTime, Option<OffsetDateTime>, Option<OffsetDateTime>);

fn chat_info(row: ChatRow) -> ChatInfo {
    let (chat_id, title, created_at, updated_at, next, rev, turn, pin, archived_at) = row;
    ChatInfo {
        chat_id,
        title: title.map(Bytes),
        created_at: millis(created_at),
        updated_at,
        // A chat is created with its first message, so `next` is at least 1.
        last_message_id: u32::try_from(next - 1).unwrap_or(0),
        rev,
        turn,
        pin: pin.and_then(|p| u8::try_from(p).ok()),
        archived_at: archived_at.map(millis),
    }
}

pub(crate) fn author_code(author: Author) -> i16 {
    match author {
        Author::User => 1,
        Author::Assistant => 2,
        Author::Tool => 3,
        Author::Summary => 4,
    }
}

fn author_of(code: i16) -> Author {
    match code {
        1 => Author::User,
        2 => Author::Assistant,
        3 => Author::Tool,
        _ => Author::Summary,
    }
}

pub(crate) fn state_code(state: MessageState) -> i16 {
    match state {
        MessageState::Complete => 1,
        MessageState::Streaming => 2,
        MessageState::Cancelled => 3,
        MessageState::Failed => 4,
    }
}

fn state_of(code: i16) -> MessageState {
    match code {
        1 => MessageState::Complete,
        2 => MessageState::Streaming,
        3 => MessageState::Cancelled,
        _ => MessageState::Failed,
    }
}

fn chat_message(row: MessageRow) -> ChatMessage {
    let (id, author, state, rev, record, seq, created_at, edited_at, deleted_at) = row;
    ChatMessage {
        id: u32::try_from(id).unwrap_or(u32::MAX),
        author: author_of(author),
        created_at: millis(created_at),
        edited_at: edited_at.map(millis),
        deleted_at: deleted_at.map(millis),
        state: state_of(state),
        rev,
        record: record.map(Bytes),
        seq: seq.and_then(|s| u32::try_from(s).ok()),
    }
}

pub(crate) async fn load_chat(conn: &mut PgConnection, chat_id: Uuid) -> sqlx::Result<ChatInfo> {
    let row: ChatRow = sqlx::query_as(concat!("SELECT ", chat_columns!(), " FROM chats c WHERE c.id = $1"))
        .bind(chat_id)
        .fetch_one(conn)
        .await?;
    Ok(chat_info(row))
}

pub(crate) async fn load_message(conn: &mut PgConnection, chat_id: Uuid, id: u32) -> sqlx::Result<ChatMessage> {
    let row: MessageRow =
        sqlx::query_as(concat!("SELECT ", message_columns!(), " FROM messages m WHERE m.chat_id = $1 AND m.id = $2"))
            .bind(chat_id)
            .bind(i64::from(id))
            .fetch_one(conn)
            .await?;
    Ok(chat_message(row))
}

/// The next chat revision, for a change to one of its messages (D-029).
pub(crate) async fn bump(conn: &mut PgConnection, chat_id: Uuid) -> sqlx::Result<i64> {
    sqlx::query_scalar("UPDATE chats SET rev = rev + 1 WHERE id = $1 RETURNING rev").bind(chat_id).fetch_one(conn).await
}

/// The newest public key of the chat's scope, which new records are sealed to.
async fn scope_key(conn: &mut PgConnection, chat_id: Uuid) -> Result<ScopePublicKey> {
    let (version, key): (i32, Vec<u8>) = sqlx::query_as(
        "SELECT key_version, public_key FROM scope_keys WHERE scope_id = $1 ORDER BY key_version DESC LIMIT 1",
    )
    .bind(chat_id)
    .fetch_one(conn)
    .await?;
    let key = PublicKey::from_slice(&key).map_err(|_| Refused(ErrorCode::Internal))?;
    Ok(ScopePublicKey { key_version: u32::try_from(version).map_err(|_| Refused(ErrorCode::Internal))?, key })
}

/// A message record sealed by the server (base mode, D-016).
pub(crate) fn seal(
    user_id: Uuid,
    chat_id: Uuid,
    message_id: u32,
    author: record::Author,
    key: &ScopePublicKey,
    text: &str,
) -> Result<Vec<u8>> {
    let place = Place {
        user: UserId::from_bytes(*user_id.as_bytes()),
        scope: ScopeId::from_bytes(*chat_id.as_bytes()),
        kind: Kind::ChatMessage { message_id, author },
    };
    let content = MessageContent { text: text.to_owned() }.encode();
    record::seal_as_server(&place, key, &content, &mut os_rng()).map_err(|_| Refused(ErrorCode::Internal))
}

/// A record sealed to the given key version, as far as its header tells.
fn sealed_to(record: &[u8], max: usize, key_version: u32) -> Result<()> {
    if record.is_empty() || record.len() > max || record::key_version(record).ok() != Some(key_version) {
        return Err(Refused(ErrorCode::Malformed));
    }
    Ok(())
}

async fn publish_chat(state: &AppState, user_id: Uuid, chat: ChatInfo) {
    state.bus.publish(Note::event(Target::User(user_id), &ChatUpdated { chat })).await;
}

/// The chat row of this user, locked; `chat.not_found` otherwise.
async fn lock_chat(conn: &mut PgConnection, principal: &Principal, chat_id: Uuid) -> Result<(Option<i16>, bool)> {
    let row: Option<(Option<i16>, bool)> =
        sqlx::query_as("SELECT pin, archived_at IS NOT NULL FROM chats WHERE id = $1 AND user_id = $2 FOR UPDATE")
            .bind(chat_id)
            .bind(principal.user_id)
            .fetch_optional(conn)
            .await?;
    row.ok_or(Refused(ErrorCode::ChatNotFound))
}

/// The chat's turn, if one holds it, and whether its lease still runs.
async fn running_turn(conn: &mut PgConnection, chat_id: Uuid) -> sqlx::Result<Option<(Uuid, bool)>> {
    let row: Option<(Option<Uuid>, bool)> =
        sqlx::query_as("SELECT turn_id, coalesce(turn_expires_at > now(), false) FROM chats WHERE id = $1")
            .bind(chat_id)
            .fetch_optional(conn)
            .await?;
    Ok(row.and_then(|(turn, live)| turn.map(|t| (t, live))))
}

async fn owns(conn: &mut PgConnection, principal: &Principal, chat_id: Uuid) -> Result<()> {
    let row: Option<i32> = sqlx::query_scalar("SELECT 1 FROM chats WHERE id = $1 AND user_id = $2")
        .bind(chat_id)
        .bind(principal.user_id)
        .fetch_optional(conn)
        .await?;
    row.map(|_| ()).ok_or(Refused(ErrorCode::ChatNotFound))
}

/// Serializes the pin and archive changes of one user.
async fn lock_account(conn: &mut PgConnection, principal: &Principal) -> Result<()> {
    let row: Option<i32> = sqlx::query_scalar("SELECT 1 FROM account_keys WHERE user_id = $1 FOR UPDATE")
        .bind(principal.user_id)
        .fetch_optional(conn)
        .await?;
    row.map(|_| ()).ok_or(Refused(ErrorCode::KeysNotSetUp))
}

/// A page of chats: the pinned ones first on the first page outside the archive.
pub async fn list(
    state: &AppState,
    principal: &Principal,
    archived: bool,
    before: Option<ChatCursor>,
) -> Result<ChatPage> {
    let mut conn = state.db.acquire().await?;
    let mut chats = Vec::new();
    if !archived && before.is_none() {
        let pinned: Vec<ChatRow> = sqlx::query_as(concat!(
            "SELECT ",
            chat_columns!(),
            " FROM chats c WHERE c.user_id = $1 AND c.pin IS NOT NULL ORDER BY c.pin"
        ))
        .bind(principal.user_id)
        .fetch_all(&mut *conn)
        .await?;
        chats.extend(pinned.into_iter().map(chat_info));
    }
    let limit = i64::try_from(CHATS_PAGE + 1).unwrap_or(i64::MAX);
    let page: Vec<ChatRow> = sqlx::query_as(concat!(
        "SELECT ",
        chat_columns!(),
        " FROM chats c
         WHERE c.user_id = $1 AND c.pin IS NULL AND (c.archived_at IS NOT NULL) = $2
           AND ($3::bigint IS NULL OR (c.updated_at, c.id) < ($3, $4))
         ORDER BY c.updated_at DESC, c.id DESC LIMIT $5"
    ))
    .bind(principal.user_id)
    .bind(archived)
    .bind(before.as_ref().map(|b| b.updated_at))
    .bind(before.as_ref().map(|b| b.chat_id))
    .bind(limit)
    .fetch_all(&mut *conn)
    .await?;
    let more = page.len() > CHATS_PAGE;
    let page: Vec<ChatInfo> = page.into_iter().take(CHATS_PAGE).map(chat_info).collect();
    let next =
        if more { page.last().map(|c| ChatCursor { updated_at: c.updated_at, chat_id: c.chat_id }) } else { None };
    chats.extend(page);
    Ok(ChatPage { chats, next })
}

pub async fn rename(state: &AppState, principal: &Principal, chat_id: Uuid, title: &Bytes) -> Result<()> {
    let mut tx = state.db.begin().await?;
    lock_chat(&mut tx, principal, chat_id).await?;
    sealed_to(&title.0, TITLE_RECORD_MAX, scope_key(&mut tx, chat_id).await?.key_version)?;
    sqlx::query("UPDATE chats SET title = $2, rev = rev + 1 WHERE id = $1")
        .bind(chat_id)
        .bind(&title.0)
        .execute(&mut *tx)
        .await?;
    let chat = load_chat(&mut tx, chat_id).await?;
    tx.commit().await?;
    publish_chat(state, principal.user_id, chat).await;
    Ok(())
}

/// The pinned list with `chat_id` moved to `position`, or removed without
/// one; whatever falls past [`PINS_MAX`] is unpinned (D-080).
fn repin(pinned: &[Uuid], chat_id: Uuid, position: Option<u8>) -> Vec<Uuid> {
    let mut next: Vec<Uuid> = pinned.iter().copied().filter(|id| *id != chat_id).collect();
    if let Some(position) = position {
        next.insert(usize::from(position).min(next.len()), chat_id);
        next.truncate(PINS_MAX);
    }
    next
}

/// Writes a new pinned order; returns the chats whose position changed.
async fn write_pins(conn: &mut PgConnection, user_id: Uuid, before: &[Uuid], after: &[Uuid]) -> Result<Vec<Uuid>> {
    let old: HashMap<Uuid, usize> = before.iter().enumerate().map(|(i, id)| (*id, i)).collect();
    let new: HashMap<Uuid, usize> = after.iter().enumerate().map(|(i, id)| (*id, i)).collect();
    let mut changed = Vec::new();
    for id in before.iter().chain(after.iter().filter(|id| !old.contains_key(id))) {
        let position = new.get(id).copied();
        if old.get(id).copied() == position {
            continue;
        }
        let pin = position.map(|p| i16::try_from(p).unwrap_or(i16::MAX));
        sqlx::query("UPDATE chats SET pin = $3, rev = rev + 1 WHERE id = $1 AND user_id = $2")
            .bind(id)
            .bind(user_id)
            .bind(pin)
            .execute(&mut *conn)
            .await?;
        changed.push(*id);
    }
    Ok(changed)
}

async fn pinned(conn: &mut PgConnection, user_id: Uuid) -> sqlx::Result<Vec<Uuid>> {
    sqlx::query_scalar("SELECT id FROM chats WHERE user_id = $1 AND pin IS NOT NULL ORDER BY pin")
        .bind(user_id)
        .fetch_all(conn)
        .await
}

async fn publish_changed(state: &AppState, user_id: Uuid, chats: Vec<ChatInfo>) {
    for chat in chats {
        publish_chat(state, user_id, chat).await;
    }
}

pub async fn pin(state: &AppState, principal: &Principal, chat_id: Uuid, position: Option<u8>) -> Result<()> {
    let mut tx = state.db.begin().await?;
    lock_account(&mut tx, principal).await?;
    let (_, archived) = lock_chat(&mut tx, principal, chat_id).await?;
    if archived && position.is_some() {
        return Err(Refused(ErrorCode::ChatArchived));
    }
    let before = pinned(&mut tx, principal.user_id).await?;
    let after = repin(&before, chat_id, position);
    let mut chats = Vec::new();
    for id in write_pins(&mut tx, principal.user_id, &before, &after).await? {
        chats.push(load_chat(&mut tx, id).await?);
    }
    tx.commit().await?;
    publish_changed(state, principal.user_id, chats).await;
    Ok(())
}

pub async fn archive(
    state: &AppState,
    principal: &Principal,
    client: &ClientInfo,
    chat_id: Uuid,
    archived: bool,
) -> Result<()> {
    let mut tx = state.db.begin().await?;
    lock_account(&mut tx, principal).await?;
    let (_, was) = lock_chat(&mut tx, principal, chat_id).await?;
    if was == archived {
        return Ok(());
    }
    let mut changed = Vec::new();
    if archived {
        let before = pinned(&mut tx, principal.user_id).await?;
        let after = repin(&before, chat_id, None);
        changed = write_pins(&mut tx, principal.user_id, &before, &after).await?;
    }
    sqlx::query("UPDATE chats SET archived_at = CASE WHEN $2 THEN now() END, rev = rev + 1 WHERE id = $1")
        .bind(chat_id)
        .bind(archived)
        .execute(&mut *tx)
        .await?;
    let kind = if archived { AuditKind::ChatArchived } else { AuditKind::ChatUnarchived };
    let event =
        Event::new(kind, principal.user_id).session(principal.session_id).details(json!({ "chat_id": chat_id }));
    audit::record(&mut tx, client, event).await?;
    if !changed.contains(&chat_id) {
        changed.push(chat_id);
    }
    let mut chats = Vec::new();
    for id in changed {
        chats.push(load_chat(&mut tx, id).await?);
    }
    tx.commit().await?;
    publish_changed(state, principal.user_id, chats).await;
    Ok(())
}

/// Deletes an archived chat with its scope, keys and messages (D-081).
pub async fn delete(state: &AppState, principal: &Principal, client: &ClientInfo, chat_id: Uuid) -> Result<()> {
    let mut tx = state.db.begin().await?;
    let (_, archived) = lock_chat(&mut tx, principal, chat_id).await?;
    if !archived {
        return Err(Refused(ErrorCode::ChatNotArchived));
    }
    let turn = running_turn(&mut tx, chat_id).await?;
    sqlx::query("DELETE FROM scopes WHERE id = $1 AND user_id = $2")
        .bind(chat_id)
        .bind(principal.user_id)
        .execute(&mut *tx)
        .await?;
    let event = Event::new(AuditKind::ChatDeleted, principal.user_id)
        .session(principal.session_id)
        .details(json!({ "chat_id": chat_id }));
    audit::record(&mut tx, client, event).await?;
    tx.commit().await?;
    // A running turn finds its chat gone at its next write; the cancel stops it sooner.
    if let Some((turn_id, _)) = turn {
        state.bus.publish(Note::Cancel { chat_id, turn_id }).await;
    }
    state.bus.publish(Note::event(Target::User(principal.user_id), &ChatDeleted { chat_id })).await;
    Ok(())
}

fn check_send(request: &MessageSend) -> Result<()> {
    if request.text.0.len() > TEXT_MAX || request.context.bytes() > CONTEXT_MAX {
        return Err(Refused(ErrorCode::MessageTooLarge));
    }
    if let Some(new) = &request.new_chat {
        let key_ok = new.public_key.0.len() == KEY_LEN;
        let wrapped_ok = !new.wrapped_private_key.0.is_empty() && new.wrapped_private_key.0.len() <= WRAPPED_KEY_MAX;
        if !key_ok || !wrapped_ok {
            return Err(Refused(ErrorCode::Malformed));
        }
        if let Some(title) = &new.title {
            sealed_to(&title.0, TITLE_RECORD_MAX, 1)?;
        }
    }
    Ok(())
}

/// The result of the first copy of a resent request.
async fn resent(conn: &mut PgConnection, principal: &Principal, request: &MessageSend) -> Result<Option<MessageSent>> {
    let row: Option<(i64, Option<Uuid>)> = sqlx::query_as(
        "SELECT m.id, m.turn_id FROM messages m JOIN chats c ON c.id = m.chat_id
         WHERE m.chat_id = $1 AND c.user_id = $2 AND m.idempotency_key = $3",
    )
    .bind(request.chat_id)
    .bind(principal.user_id)
    .bind(request.idempotency_key)
    .fetch_optional(conn)
    .await?;
    let Some((id, turn)) = row else { return Ok(None) };
    let message_id = u32::try_from(id).map_err(|_| Refused(ErrorCode::Internal))?;
    Ok(Some(MessageSent { message_id, turn_id: turn.unwrap_or_default() }))
}

/// Stores the user's message and starts its turn (docs/protocol.md, "Sending").
pub async fn send(
    state: &AppState,
    principal: &Principal,
    client: &ClientInfo,
    agent: Option<Agent>,
    request: MessageSend,
) -> Result<MessageSent> {
    check_send(&request)?;
    let chat_id = request.chat_id;
    let mut tx = state.db.begin().await?;
    if let Some(sent) = resent(&mut tx, principal, &request).await? {
        return Ok(sent);
    }
    let agent = agent.ok_or(Refused(ErrorCode::AgentNotStarted))?;
    lock_account(&mut tx, principal).await?;
    // A resend may have waited for the lock behind its first copy.
    if let Some(sent) = resent(&mut tx, principal, &request).await? {
        return Ok(sent);
    }
    if let Some(new) = &request.new_chat {
        let inserted =
            sqlx::query("INSERT INTO scopes (id, user_id, kind) VALUES ($1, $2, 'chat') ON CONFLICT DO NOTHING")
                .bind(chat_id)
                .bind(principal.user_id)
                .execute(&mut *tx)
                .await?
                .rows_affected();
        if inserted != 1 {
            return Err(Refused(ErrorCode::ChatExists));
        }
        sqlx::query(
            "INSERT INTO scope_keys (scope_id, key_version, public_key, wrapped_private_key) VALUES ($1, 1, $2, $3)",
        )
        .bind(chat_id)
        .bind(&new.public_key.0)
        .bind(&new.wrapped_private_key.0)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO chats (id, user_id, title, updated_at)
             VALUES ($1, $2, $3, (extract(epoch FROM now()) * 1000)::bigint)",
        )
        .bind(chat_id)
        .bind(principal.user_id)
        .bind(new.title.as_ref().map(|t| &t.0))
        .execute(&mut *tx)
        .await?;
        let event = Event::new(AuditKind::ChatCreated, principal.user_id)
            .session(principal.session_id)
            .details(json!({ "chat_id": chat_id }));
        audit::record(&mut tx, client, event).await?;
    }
    let row: Option<(bool, Option<Uuid>, bool, i64)> = sqlx::query_as(
        "SELECT archived_at IS NOT NULL, turn_id, coalesce(turn_expires_at > now(), false), next_message_id
         FROM chats WHERE id = $1 AND user_id = $2 FOR UPDATE",
    )
    .bind(chat_id)
    .bind(principal.user_id)
    .fetch_optional(&mut *tx)
    .await?;
    let (archived, running, live, next) = row.ok_or(Refused(ErrorCode::ChatNotFound))?;
    if running.is_some() && live {
        return Err(Refused(ErrorCode::TurnBusy));
    }
    // A turn whose replica died left its reply streaming (D-083).
    let mut stale = Vec::new();
    if running.is_some() {
        let ids: Vec<i64> = sqlx::query_scalar("SELECT id FROM messages WHERE chat_id = $1 AND state = 2")
            .bind(chat_id)
            .fetch_all(&mut *tx)
            .await?;
        for id in ids {
            let rev = bump(&mut tx, chat_id).await?;
            sqlx::query("UPDATE messages SET state = $3, rev = $4 WHERE chat_id = $1 AND id = $2")
                .bind(chat_id)
                .bind(id)
                .bind(state_code(MessageState::Failed))
                .bind(rev)
                .execute(&mut *tx)
                .await?;
            stale.push(load_message(&mut tx, chat_id, u32::try_from(id).unwrap_or(u32::MAX)).await?);
        }
    }
    let message_id = u32::try_from(next).map_err(|_| Refused(ErrorCode::Internal))?;
    let key = scope_key(&mut tx, chat_id).await?;
    let record = seal(principal.user_id, chat_id, message_id, record::Author::User, &key, &request.text.0)?;
    let rev = bump(&mut tx, chat_id).await?;
    let turn_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO messages (chat_id, id, author, state, rev, record, idempotency_key, turn_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(chat_id)
    .bind(i64::from(message_id))
    .bind(author_code(Author::User))
    .bind(state_code(MessageState::Complete))
    .bind(rev)
    .bind(&record)
    .bind(request.idempotency_key)
    .bind(turn_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE chats SET next_message_id = next_message_id + 1,
             updated_at = (extract(epoch FROM now()) * 1000)::bigint,
             turn_id = $2, turn_expires_at = now() + interval '30 seconds', archived_at = NULL
         WHERE id = $1",
    )
    .bind(chat_id)
    .bind(turn_id)
    .execute(&mut *tx)
    .await?;
    if archived {
        let event = Event::new(AuditKind::ChatUnarchived, principal.user_id)
            .session(principal.session_id)
            .details(json!({ "chat_id": chat_id }));
        audit::record(&mut tx, client, event).await?;
    }
    let message = load_message(&mut tx, chat_id, message_id).await?;
    let chat = load_chat(&mut tx, chat_id).await?;
    tx.commit().await?;

    let target = Target::User(principal.user_id);
    for message in stale {
        state.bus.publish(Note::event(target, &MessageUpdated { chat_id, message })).await;
    }
    state.bus.publish(Note::event(target, &MessageCreated { chat_id, message })).await;
    publish_chat(state, principal.user_id, chat).await;
    turn::spawn(
        state,
        turn::Plan {
            user_id: principal.user_id,
            session_id: principal.session_id,
            chat_id,
            turn_id,
            key,
            agent,
            request: turn::request(request),
        },
    );
    Ok(MessageSent { message_id, turn_id })
}

/// The requested chunks, each with the messages changed after its given `rev`.
pub async fn chunks(
    state: &AppState,
    principal: &Principal,
    chat_id: Uuid,
    requests: &[ChunkRequest],
) -> Result<Vec<Chunk>> {
    if requests.is_empty() || requests.len() > CHUNKS_MAX {
        return Err(Refused(ErrorCode::Malformed));
    }
    let mut conn = state.db.acquire().await?;
    owns(&mut conn, principal, chat_id).await?;
    let mut chunks = Vec::with_capacity(requests.len());
    for request in requests {
        let first = i64::from(request.chunk) << CHUNK_SHIFT;
        let last = first + (1 << CHUNK_SHIFT) - 1;
        let rev: i64 = sqlx::query_scalar(
            "SELECT coalesce(max(rev), 0) FROM messages WHERE chat_id = $1 AND id BETWEEN $2 AND $3",
        )
        .bind(chat_id)
        .bind(first)
        .bind(last)
        .fetch_one(&mut *conn)
        .await?;
        let rows: Vec<MessageRow> = sqlx::query_as(concat!(
            "SELECT ",
            message_columns!(),
            " FROM messages m WHERE m.chat_id = $1 AND m.id BETWEEN $2 AND $3
               AND ($4::bigint IS NULL OR m.rev > $4) ORDER BY m.id"
        ))
        .bind(chat_id)
        .bind(first)
        .bind(last)
        .bind(request.rev)
        .fetch_all(&mut *conn)
        .await?;
        chunks.push(Chunk { chunk: request.chunk, rev, messages: rows.into_iter().map(chat_message).collect() });
    }
    Ok(chunks)
}

/// Frames for `message.chunks`: parts split between messages, so one large
/// chunk may span several parts, each naming it (D-027).
pub fn chunk_frames(id: u32, chat_id: Uuid, chunks: Vec<Chunk>) -> Vec<Vec<u8>> {
    let mut items: Vec<(u32, i64, Option<ChatMessage>)> = Vec::new();
    for chunk in chunks {
        if chunk.messages.is_empty() {
            items.push((chunk.chunk, chunk.rev, None));
        }
        items.extend(chunk.messages.into_iter().map(|m| (chunk.chunk, chunk.rev, Some(m))));
    }
    chat_protocol::encode_parts(id, items, chat_protocol::PART_BYTES, |run| {
        let mut chunks: Vec<Chunk> = Vec::new();
        for (number, rev, message) in run {
            if chunks.last().is_none_or(|c| c.chunk != number) {
                chunks.push(Chunk { chunk: number, rev, messages: Vec::new() });
            }
            if let (Some(chunk), Some(message)) = (chunks.last_mut(), message) {
                chunk.messages.push(message);
            }
        }
        ChunkList { chat_id, chunks }
    })
}

/// Replaces the user's own message with the client's re-sealed record.
pub async fn edit(
    state: &AppState,
    principal: &Principal,
    chat_id: Uuid,
    message_id: u32,
    record: &Bytes,
) -> Result<i64> {
    let mut tx = state.db.begin().await?;
    lock_chat(&mut tx, principal, chat_id).await?;
    let row: Option<(i16, bool)> =
        sqlx::query_as("SELECT author, deleted_at IS NOT NULL FROM messages WHERE chat_id = $1 AND id = $2")
            .bind(chat_id)
            .bind(i64::from(message_id))
            .fetch_optional(&mut *tx)
            .await?;
    let (author, deleted) = row.ok_or(Refused(ErrorCode::MessageNotFound))?;
    if deleted {
        return Err(Refused(ErrorCode::MessageNotFound));
    }
    if author != author_code(Author::User) {
        return Err(Refused(ErrorCode::MessageNotEditable));
    }
    sealed_to(&record.0, RECORD_MAX, scope_key(&mut tx, chat_id).await?.key_version)?;
    let rev = bump(&mut tx, chat_id).await?;
    sqlx::query("UPDATE messages SET record = $3, rev = $4, edited_at = now() WHERE chat_id = $1 AND id = $2")
        .bind(chat_id)
        .bind(i64::from(message_id))
        .bind(&record.0)
        .bind(rev)
        .execute(&mut *tx)
        .await?;
    let message = load_message(&mut tx, chat_id, message_id).await?;
    tx.commit().await?;
    state.bus.publish(Note::event(Target::User(principal.user_id), &MessageUpdated { chat_id, message })).await;
    Ok(rev)
}

/// Turns a message into a tombstone; a tombstone answers with its revision.
pub async fn delete_message(state: &AppState, principal: &Principal, chat_id: Uuid, message_id: u32) -> Result<i64> {
    let mut tx = state.db.begin().await?;
    lock_chat(&mut tx, principal, chat_id).await?;
    let row: Option<(i16, bool, i64)> =
        sqlx::query_as("SELECT state, deleted_at IS NOT NULL, rev FROM messages WHERE chat_id = $1 AND id = $2")
            .bind(chat_id)
            .bind(i64::from(message_id))
            .fetch_optional(&mut *tx)
            .await?;
    let (message_state, deleted, rev) = row.ok_or(Refused(ErrorCode::MessageNotFound))?;
    if deleted {
        return Ok(rev);
    }
    // A reply whose turn lost its lease (D-083) is streaming no more.
    let live = running_turn(&mut tx, chat_id).await?.is_some_and(|(_, live)| live);
    if message_state == state_code(MessageState::Streaming) && live {
        return Err(Refused(ErrorCode::MessageStreaming));
    }
    let rev = bump(&mut tx, chat_id).await?;
    sqlx::query(
        "UPDATE messages SET record = NULL, seq = NULL, rev = $3, deleted_at = now() WHERE chat_id = $1 AND id = $2",
    )
    .bind(chat_id)
    .bind(i64::from(message_id))
    .bind(rev)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    let deleted = MessageDeleted { chat_id, message_id, rev };
    state.bus.publish(Note::event(Target::User(principal.user_id), &deleted)).await;
    Ok(rev)
}

/// Asks the replica running the chat's turn to cancel it.
pub async fn cancel(state: &AppState, principal: &Principal, chat_id: Uuid) -> Result<()> {
    let mut conn = state.db.acquire().await?;
    owns(&mut conn, principal, chat_id).await?;
    if let Some((turn_id, _)) = running_turn(&mut conn, chat_id).await? {
        state.bus.publish(Note::Cancel { chat_id, turn_id }).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pins_shift_and_push_out_the_last() {
        let ids: Vec<Uuid> = (0..PINS_MAX).map(|_| Uuid::now_v7()).collect();
        let new = Uuid::now_v7();
        let after = repin(&ids, new, Some(1));
        assert_eq!(after.len(), PINS_MAX);
        assert_eq!((after[0], after[1], after[2]), (ids[0], new, ids[1]));
        assert!(!after.contains(&ids[PINS_MAX - 1]));
        // Moving down keeps the count; a position past the end means the end.
        let moved = repin(&ids, ids[0], Some(200));
        assert_eq!((moved[0], moved[PINS_MAX - 1]), (ids[1], ids[0]));
        let unpinned = repin(&ids, ids[3], None);
        assert_eq!((unpinned.len(), unpinned[3]), (PINS_MAX - 1, ids[4]));
    }

    #[test]
    fn a_large_chunk_spans_parts() {
        let chat_id = Uuid::now_v7();
        let message = |id| ChatMessage {
            id,
            author: Author::Assistant,
            created_at: 0,
            edited_at: None,
            deleted_at: None,
            state: MessageState::Complete,
            rev: i64::from(id),
            record: Some(Bytes(vec![0; 100 * 1024])),
            seq: None,
        };
        let chunks = vec![
            Chunk { chunk: 0, rev: 5, messages: (0..5).map(message).collect() },
            Chunk { chunk: 1, rev: 0, messages: vec![] },
        ];
        let frames = chunk_frames(7, chat_id, chunks);
        assert!(frames.len() > 1);
        let mut seen = Vec::new();
        for frame in &frames {
            let list: ChunkList = chat_protocol::InFrame::parse(frame).unwrap().payload().unwrap();
            for chunk in list.chunks {
                seen.push((chunk.chunk, chunk.messages.len()));
            }
        }
        assert_eq!(seen.iter().filter(|(c, _)| *c == 0).map(|(_, n)| n).sum::<usize>(), 5);
        assert_eq!(seen.last(), Some(&(1, 0)));
    }
}
