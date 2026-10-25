//! The audit log (docs/auth.md, "Audit log"): append-only, written in the
//! transaction of the action it records. `details` carries ids, provider kinds
//! and reasons only: never content, codes, tokens or addresses.

use chat_protocol::auth::AuditEntry;
use serde_json::{Value, json};
use sqlx::{PgConnection, PgPool};
use time::OffsetDateTime;
use uuid::Uuid;

use super::client::ClientInfo;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    AccountCreated,
    SignedIn,
    SignInFailed,
    CodeSent,
    SessionRevoked,
    IdentityLinked,
    IdentityUnlinked,
    KeysSetup,
    KeysWrapAdded,
    KeysWrapRemoved,
    KeysRecoveryRotated,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Self::AccountCreated => "account.created",
            Self::SignedIn => "auth.signed_in",
            Self::SignInFailed => "auth.sign_in_failed",
            Self::CodeSent => "auth.code_sent",
            Self::SessionRevoked => "session.revoked",
            Self::IdentityLinked => "identity.linked",
            Self::IdentityUnlinked => "identity.unlinked",
            Self::KeysSetup => "keys.setup",
            Self::KeysWrapAdded => "keys.wrap_added",
            Self::KeysWrapRemoved => "keys.wrap_removed",
            Self::KeysRecoveryRotated => "keys.recovery_rotated",
        }
    }
}

#[derive(Debug)]
pub struct Event {
    pub kind: Kind,
    pub user_id: Option<Uuid>,
    pub session_id: Option<Uuid>,
    pub details: Value,
}

impl Event {
    pub fn new(kind: Kind, user_id: impl Into<Option<Uuid>>) -> Self {
        Self { kind, user_id: user_id.into(), session_id: None, details: json!({}) }
    }

    pub fn session(mut self, session_id: Uuid) -> Self {
        self.session_id = Some(session_id);
        self
    }

    pub fn details(mut self, details: Value) -> Self {
        self.details = details;
        self
    }
}

pub async fn record(conn: &mut PgConnection, client: &ClientInfo, event: Event) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO audit_events (user_id, session_id, kind, ip, country, user_agent, details)
         VALUES ($1, $2, $3, $4::inet, $5, $6, $7)",
    )
    .bind(event.user_id)
    .bind(event.session_id)
    .bind(event.kind.as_str())
    .bind(client.ip.map(|ip| ip.to_string()))
    .bind(&client.country)
    .bind(&client.user_agent)
    .bind(event.details)
    .execute(conn)
    .await?;
    Ok(())
}

pub(crate) fn millis(t: OffsetDateTime) -> i64 {
    i64::try_from(t.unix_timestamp_nanos() / 1_000_000).unwrap_or(i64::MAX)
}

/// The user's own log, newest first.
pub async fn page(db: &PgPool, user_id: Uuid, before: Option<i64>, limit: i64) -> sqlx::Result<Vec<AuditEntry>> {
    type Row = (i64, String, Option<Uuid>, Option<String>, Option<String>, Option<String>, Value, OffsetDateTime);
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT id, kind, session_id, host(ip), country, user_agent, details, created_at
         FROM audit_events
         WHERE user_id = $1 AND ($2::bigint IS NULL OR id < $2)
         ORDER BY id DESC LIMIT $3",
    )
    .bind(user_id)
    .bind(before)
    .bind(limit)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, kind, session_id, ip, country, user_agent, details, created_at)| AuditEntry {
            id,
            kind,
            session_id,
            ip,
            country,
            user_agent,
            details,
            created_at: millis(created_at),
        })
        .collect())
}
