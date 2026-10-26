//! Device linking (docs/protocol.md, "Keys"; docs/crypto.md, "Device
//! linking"): the server keeps short-lived link sessions of the creating
//! session and relays the single message the unlocked device posts. That message is
//! sealed to a key that reached the unlocked device through the camera; the
//! server only stores and forwards it.

use std::time::Duration;

use chat_protocol::{
    Bytes,
    error::ErrorCode,
    link::{LINK_MESSAGE_MAX, LinkCreated, LinkMessage, LinkRequester},
};
use serde_json::json;
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::{
    auth::{
        Principal,
        audit::{self, Event, Kind, millis},
        client::ClientInfo,
    },
    bus::{Bus, Note, Target},
    keys::KeysError::{self, Refused},
};

type Result<T> = std::result::Result<T, KeysError>;

/// How long a QR stays usable (docs/crypto.md, "Device linking").
const TTL: Duration = Duration::from_secs(120);
/// Live links per session: a tab renews its code before it expires, so a
/// couple of tabs stay well below this.
const LIVE_PER_SESSION: i64 = 8;

/// A new link session for this session. Earlier ones live on until they
/// expire: each tab showing a code has its own.
pub async fn create(db: &PgPool, principal: &Principal) -> Result<LinkCreated> {
    let mut tx = db.begin().await?;
    let keys: Option<(i32,)> = sqlx::query_as("SELECT 1 FROM account_keys WHERE user_id = $1")
        .bind(principal.user_id)
        .fetch_optional(&mut *tx)
        .await?;
    if keys.is_none() {
        return Err(Refused(ErrorCode::KeysNotSetUp));
    }
    // Expired links of every account go here; there is no other sweep.
    sqlx::query("DELETE FROM link_sessions WHERE expires_at < now()").execute(&mut *tx).await?;
    let live: i64 = sqlx::query_scalar("SELECT count(*) FROM link_sessions WHERE session_id = $1")
        .bind(principal.session_id)
        .fetch_one(&mut *tx)
        .await?;
    if live >= LIVE_PER_SESSION {
        return Err(Refused(ErrorCode::RateLimited));
    }
    let sid = Uuid::now_v7();
    let expires_at = OffsetDateTime::now_utc() + TTL;
    sqlx::query("INSERT INTO link_sessions (id, user_id, session_id, expires_at) VALUES ($1, $2, $3, $4)")
        .bind(sid)
        .bind(principal.user_id)
        .bind(principal.session_id)
        .bind(expires_at)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(LinkCreated { sid, expires_in_ms: u32::try_from(TTL.as_millis()).unwrap_or(u32::MAX) })
}

/// The session that created a live link of this account, as the server recorded it.
pub async fn info(db: &PgPool, principal: &Principal, sid: Uuid) -> Result<LinkRequester> {
    let row: Option<(OffsetDateTime, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT l.created_at, s.user_agent, s.country
         FROM link_sessions l JOIN sessions s ON s.id = l.session_id
         WHERE l.id = $1 AND l.user_id = $2 AND l.expires_at > now() AND s.revoked_at IS NULL",
    )
    .bind(sid)
    .bind(principal.user_id)
    .fetch_optional(db)
    .await?;
    let (created_at, user_agent, country) = row.ok_or(Refused(ErrorCode::LinkNotFound))?;
    Ok(LinkRequester { created_at: millis(created_at), user_agent, country })
}

/// Stores the message once and sends it to the creating session on every replica.
pub async fn post(
    db: &PgPool,
    bus: &Bus,
    principal: &Principal,
    client: &ClientInfo,
    sid: Uuid,
    message: &Bytes,
) -> Result<()> {
    if message.0.is_empty() || message.0.len() > LINK_MESSAGE_MAX {
        return Err(Refused(ErrorCode::Malformed));
    }
    let mut tx = db.begin().await?;
    let row: Option<(Uuid, Option<Vec<u8>>)> = sqlx::query_as(
        "SELECT l.session_id, l.message FROM link_sessions l JOIN sessions s ON s.id = l.session_id
         WHERE l.id = $1 AND l.user_id = $2 AND l.expires_at > now() AND s.revoked_at IS NULL
         FOR UPDATE OF l",
    )
    .bind(sid)
    .bind(principal.user_id)
    .fetch_optional(&mut *tx)
    .await?;
    let (creator, stored) = row.ok_or(Refused(ErrorCode::LinkNotFound))?;
    match stored {
        Some(stored) if stored == message.0 => {}
        Some(_) => return Err(Refused(ErrorCode::LinkUsed)),
        None => {
            sqlx::query("UPDATE link_sessions SET message = $2 WHERE id = $1")
                .bind(sid)
                .bind(&message.0)
                .execute(&mut *tx)
                .await?;
            let event = Event::new(Kind::LinkCompleted, principal.user_id)
                .session(principal.session_id)
                .details(json!({ "session_id": creator }));
            audit::record(&mut tx, client, event).await?;
        }
    }
    tx.commit().await?;
    // A resend publishes again, in case the first event was missed.
    let event = LinkMessage { sid, message: message.clone() };
    bus.publish(Note::event(Target::Session(creator), &event)).await;
    Ok(())
}

/// The message of this session's link, once posted.
pub async fn get(db: &PgPool, principal: &Principal, sid: Uuid) -> Result<Option<Bytes>> {
    let row: Option<(Option<Vec<u8>>,)> =
        sqlx::query_as("SELECT message FROM link_sessions WHERE id = $1 AND session_id = $2 AND expires_at > now()")
            .bind(sid)
            .bind(principal.session_id)
            .fetch_optional(db)
            .await?;
    let (message,) = row.ok_or(Refused(ErrorCode::LinkNotFound))?;
    Ok(message.map(Bytes))
}
