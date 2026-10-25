//! The daily cleanup (docs/auth.md, "Audit log"): audit events past
//! retention, expired codes and flows, idle sessions, and sessions revoked
//! more than 30 days ago. Deletes run in batches so no statement holds locks
//! for long.

use std::time::Duration;

use sqlx::PgPool;
use tokio::sync::watch;

const BATCH: i64 = 10_000;
const REVOKED_KEPT_DAYS: i32 = 30;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Swept {
    pub audit_events: u64,
    pub email_codes: u64,
    pub oidc_flows: u64,
    pub idle_sessions: u64,
    pub old_sessions: u64,
}

async fn batched(db: &PgPool, sql: &'static str, days: i32) -> sqlx::Result<u64> {
    let mut total = 0;
    loop {
        let n = sqlx::query(sql).bind(days).bind(BATCH).execute(db).await?.rows_affected();
        total += n;
        if n < u64::try_from(BATCH).unwrap_or(u64::MAX) {
            return Ok(total);
        }
    }
}

pub async fn sweep(db: &PgPool, audit_days: u32, idle: Duration) -> sqlx::Result<Swept> {
    let audit_days = i32::try_from(audit_days).unwrap_or(i32::MAX);
    let audit_events = batched(
        db,
        "DELETE FROM audit_events WHERE id IN (
             SELECT id FROM audit_events WHERE created_at < now() - make_interval(days => $1) LIMIT $2)",
        audit_days,
    )
    .await?;
    let email_codes =
        sqlx::query("DELETE FROM email_codes WHERE expires_at < now()").execute(db).await?.rows_affected();
    let oidc_flows = sqlx::query("DELETE FROM oidc_flows WHERE expires_at < now()").execute(db).await?.rows_affected();
    // Their access tokens expired long ago, so the revocation store need not hear of them.
    let idle_sessions = sqlx::query(
        "UPDATE sessions SET revoked_at = now(), revoked_reason = 'idle'
         WHERE revoked_at IS NULL AND last_seen_at < now() - make_interval(secs => $1)",
    )
    .bind(idle.as_secs_f64())
    .execute(db)
    .await?
    .rows_affected();
    let old_sessions = batched(
        db,
        "DELETE FROM sessions WHERE id IN (
             SELECT id FROM sessions WHERE revoked_at < now() - make_interval(days => $1) LIMIT $2)",
        REVOKED_KEPT_DAYS,
    )
    .await?;
    Ok(Swept { audit_events, email_codes, oidc_flows, idle_sessions, old_sessions })
}

/// Sweeps a minute after start and then daily, until shutdown.
pub async fn run(db: PgPool, audit_days: u32, idle: Duration, mut shutdown: watch::Receiver<()>) {
    let mut next = Duration::from_secs(60);
    loop {
        tokio::select! {
            () = tokio::time::sleep(next) => {}
            _ = shutdown.changed() => return,
        }
        match sweep(&db, audit_days, idle).await {
            Ok(swept) => tracing::info!(?swept, "retention sweep"),
            Err(e) => tracing::error!(error = %e, "retention sweep failed"),
        }
        next = Duration::from_secs(24 * 60 * 60);
    }
}
