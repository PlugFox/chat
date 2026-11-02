//! Temporary chats (docs/protocol.md, "Temporary chats", D-121): each has an
//! expiry that the user's activity renews; a sweep deletes those past it, so a
//! restart at the wrong moment only delays a deletion by one interval.

use std::time::Duration;

use chat_protocol::chat::ChatDeleted;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    app::AppState,
    auth::{
        audit::{self, Event, Kind as AuditKind},
        client::ClientInfo,
    },
    bus::{Note, Target},
    files,
};

/// How long the user may be away before their temporary chats go.
pub const AWAY: Duration = Duration::from_secs(30 * 60);
const SWEEP_EVERY: Duration = Duration::from_secs(5 * 60);

/// The user is here: renews their temporary chats not yet past their expiry.
pub async fn touch(db: &PgPool, user_id: Uuid) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE chats SET expires_at = now() + make_interval(secs => $2)
         WHERE user_id = $1 AND expires_at IS NOT NULL AND expires_at > now()",
    )
    .bind(user_id)
    .bind(AWAY.as_secs_f64())
    .execute(db)
    .await?;
    Ok(())
}

/// Deletes one chat past its expiry; `None` when no more are due. A running
/// turn holds its chat until its lease ends; replicas skip each other's rows.
async fn delete_one(state: &AppState) -> sqlx::Result<Option<(Uuid, Uuid)>> {
    let mut tx = state.db.begin().await?;
    let row: Option<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT id, user_id FROM chats
         WHERE expires_at < now() AND (turn_id IS NULL OR turn_expires_at IS NULL OR turn_expires_at <= now())
         LIMIT 1 FOR UPDATE SKIP LOCKED",
    )
    .fetch_optional(&mut *tx)
    .await?;
    let Some((chat_id, user_id)) = row else { return Ok(None) };
    files::forget_chat(&mut tx, chat_id).await?;
    sqlx::query("DELETE FROM scopes WHERE id = $1").bind(chat_id).execute(&mut *tx).await?;
    let event = Event::new(AuditKind::ChatDeleted, user_id).details(json!({ "chat_id": chat_id, "expired": true }));
    audit::record(&mut tx, &ClientInfo::default(), event).await?;
    tx.commit().await?;
    Ok(Some((chat_id, user_id)))
}

/// Deletes every chat that is due; returns how many.
pub async fn sweep(state: &AppState) -> sqlx::Result<u64> {
    let mut deleted = 0;
    while let Some((chat_id, user_id)) = delete_one(state).await? {
        state.bus.publish(Note::event(Target::User(user_id), &ChatDeleted { chat_id })).await;
        deleted += 1;
    }
    Ok(deleted)
}

/// Sweeps at start, for what expired while the server was down, then every few minutes.
pub async fn run(state: AppState, mut shutdown: tokio::sync::watch::Receiver<()>) {
    loop {
        match sweep(&state).await {
            Ok(0) => {}
            Ok(deleted) => tracing::info!(deleted, "temporary chats deleted"),
            Err(e) => tracing::error!(error = %e, "temporary chat sweep failed"),
        }
        tokio::select! {
            () = tokio::time::sleep(SWEEP_EVERY) => {}
            _ = shutdown.changed() => return,
        }
    }
}
