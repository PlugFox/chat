//! Saved messages (docs/protocol.md, "Saved messages"): references to a
//! chat's messages. The chat's owner is checked on every call; a page comes
//! with the chats and the message records, which the server never opens.

use chat_protocol::{
    error::ErrorCode,
    saved::{SAVED_MAX, SAVED_PAGE, SavedCursor, SavedItem, SavedPage, SavedUpdated},
};
use sqlx::PgConnection;
use uuid::Uuid;

use super::{ChatRow, MessageRow, Result, chat_info, chat_message, lock_account, owns};
use crate::{
    app::AppState,
    auth::Principal,
    bus::{Note, Target},
    keys::KeysError::Refused,
};

/// Saves a message, or returns when it was saved.
pub async fn add(state: &AppState, principal: &Principal, chat_id: Uuid, message_id: u32) -> Result<i64> {
    let mut tx = state.db.begin().await?;
    // Serializes the count against the limit.
    lock_account(&mut tx, principal).await?;
    owns(&mut tx, principal, chat_id).await?;
    let live: Option<bool> =
        sqlx::query_scalar("SELECT deleted_at IS NULL FROM messages WHERE chat_id = $1 AND id = $2")
            .bind(chat_id)
            .bind(i64::from(message_id))
            .fetch_optional(&mut *tx)
            .await?;
    if live != Some(true) {
        return Err(Refused(ErrorCode::MessageNotFound));
    }
    if let Some(saved_at) = saved_at(&mut tx, principal.user_id, chat_id, message_id).await? {
        return Ok(saved_at);
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM saved_messages WHERE user_id = $1")
        .bind(principal.user_id)
        .fetch_one(&mut *tx)
        .await?;
    if count >= SAVED_MAX {
        return Err(Refused(ErrorCode::SavedLimit));
    }
    let saved_at: i64 = sqlx::query_scalar(
        "INSERT INTO saved_messages (user_id, chat_id, message_id, saved_at)
         VALUES ($1, $2, $3, (extract(epoch FROM now()) * 1000)::bigint) RETURNING saved_at",
    )
    .bind(principal.user_id)
    .bind(chat_id)
    .bind(i64::from(message_id))
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    publish(state, principal.user_id, SavedUpdated { chat_id, message_id, saved_at: Some(saved_at) }).await;
    Ok(saved_at)
}

pub async fn remove(state: &AppState, principal: &Principal, chat_id: Uuid, message_id: u32) -> Result<()> {
    let mut conn = state.db.acquire().await?;
    owns(&mut conn, principal, chat_id).await?;
    let removed = sqlx::query("DELETE FROM saved_messages WHERE user_id = $1 AND chat_id = $2 AND message_id = $3")
        .bind(principal.user_id)
        .bind(chat_id)
        .bind(i64::from(message_id))
        .execute(&mut *conn)
        .await?
        .rows_affected();
    if removed > 0 {
        publish(state, principal.user_id, SavedUpdated { chat_id, message_id, saved_at: None }).await;
    }
    Ok(())
}

/// A page of saved messages, newest first, with their chats and messages.
pub async fn list(state: &AppState, principal: &Principal, before: Option<SavedCursor>) -> Result<SavedPage> {
    let mut conn = state.db.acquire().await?;
    let refs: Vec<(Uuid, i64, i64)> = sqlx::query_as(
        "SELECT chat_id, message_id, saved_at FROM saved_messages
         WHERE user_id = $1 AND ($2::bigint IS NULL OR (saved_at, chat_id, message_id) < ($2, $3, $4))
         ORDER BY saved_at DESC, chat_id DESC, message_id DESC LIMIT $5",
    )
    .bind(principal.user_id)
    .bind(before.map(|b| b.saved_at))
    .bind(before.map(|b| b.chat_id))
    .bind(before.map(|b| i64::from(b.message_id)))
    .bind(i64::try_from(SAVED_PAGE + 1).unwrap_or(i64::MAX))
    .fetch_all(&mut *conn)
    .await?;
    let more = refs.len() > SAVED_PAGE;
    let mut items = Vec::with_capacity(SAVED_PAGE);
    for (chat_id, message_id, saved_at) in refs.into_iter().take(SAVED_PAGE) {
        let chat: ChatRow =
            sqlx::query_as(concat!("SELECT ", chat_columns!(), " FROM chats c WHERE c.id = $1 AND c.user_id = $2"))
                .bind(chat_id)
                .bind(principal.user_id)
                .fetch_one(&mut *conn)
                .await?;
        let message: MessageRow = sqlx::query_as(concat!(
            "SELECT ",
            message_columns!(),
            " FROM messages m WHERE m.chat_id = $1 AND m.id = $2"
        ))
        .bind(chat_id)
        .bind(message_id)
        .fetch_one(&mut *conn)
        .await?;
        items.push(SavedItem { saved_at, chat: chat_info(chat), message: chat_message(message) });
    }
    let next = more.then(|| items.last()).flatten().map(|last: &SavedItem| SavedCursor {
        saved_at: last.saved_at,
        chat_id: last.chat.chat_id,
        message_id: last.message.id,
    });
    Ok(SavedPage { items, next })
}

/// Frames for `saved.list`: parts split between items, `next` on the last.
pub fn page_frames(id: u32, page: SavedPage) -> Vec<Vec<u8>> {
    let SavedPage { items, next } = page;
    let count = items.len();
    let sent = std::cell::Cell::new(0);
    chat_protocol::encode_parts(id, items, chat_protocol::PART_BYTES, |run: Vec<SavedItem>| {
        sent.set(sent.get() + run.len());
        SavedPage { items: run, next: if sent.get() == count { next } else { None } }
    })
}

/// The saved message ids of one chat, in order.
pub async fn of_chat(state: &AppState, principal: &Principal, chat_id: Uuid) -> Result<Vec<u32>> {
    let mut conn = state.db.acquire().await?;
    owns(&mut conn, principal, chat_id).await?;
    let ids: Vec<i64> = sqlx::query_scalar(
        "SELECT message_id FROM saved_messages WHERE user_id = $1 AND chat_id = $2 ORDER BY message_id",
    )
    .bind(principal.user_id)
    .bind(chat_id)
    .fetch_all(&mut *conn)
    .await?;
    Ok(ids.into_iter().filter_map(|id| u32::try_from(id).ok()).collect())
}

/// A message turned into a tombstone leaves the saved messages; the client
/// drops it on `message.deleted`, so no event of its own.
pub(super) async fn forget(conn: &mut PgConnection, chat_id: Uuid, message_id: u32) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM saved_messages WHERE chat_id = $1 AND message_id = $2")
        .bind(chat_id)
        .bind(i64::from(message_id))
        .execute(conn)
        .await?;
    Ok(())
}

async fn saved_at(conn: &mut PgConnection, user_id: Uuid, chat_id: Uuid, message_id: u32) -> sqlx::Result<Option<i64>> {
    sqlx::query_scalar("SELECT saved_at FROM saved_messages WHERE user_id = $1 AND chat_id = $2 AND message_id = $3")
        .bind(user_id)
        .bind(chat_id)
        .bind(i64::from(message_id))
        .fetch_optional(conn)
        .await
}

async fn publish(state: &AppState, user_id: Uuid, event: SavedUpdated) {
    state.bus.publish(Note::event(Target::User(user_id), &event)).await;
}
