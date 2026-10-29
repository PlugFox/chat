//! Permission requests and the access log in PostgreSQL (docs/protocol.md,
//! "Permissions and the access log"; D-099). A turn writes a request and
//! waits; the auth session it went to answers on any replica, and the answer
//! reaches the turn over the bus. A row stays as the log entry.

use chat_crypto::{
    PublicKey,
    ids::{LogEntryId, ScopeId, UserId},
    os_rng,
    record::{self, Kind, Place},
    scope::ScopePublicKey,
};
use chat_protocol::{
    Bytes,
    error::ErrorCode,
    permissions::{
        ACCESS_PAGE, AccessEntry, AccessLogPage, Decision, Grant, HISTORY_MAX, Outcome, PermissionList,
        PermissionRequest, PermissionResolved, PermissionRespond, RESULT_MAX,
    },
    redact::Secret,
};
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

use crate::{
    app::AppState,
    auth::Principal,
    bus::{Bus, Note, Target},
    keys::KeysError::{self, Refused},
};

type Result<T> = std::result::Result<T, KeysError>;

/// A request a turn makes: who it goes to and what it asks.
pub struct Ask<'a> {
    pub user_id: Uuid,
    pub session_id: Uuid,
    pub chat_id: Uuid,
    pub turn_id: Uuid,
    pub provider_id: Uuid,
    pub grant: &'a Grant,
    pub reason: &'a str,
    /// How long the request waits for an answer.
    pub wait: std::time::Duration,
}

/// Ids only: the reason is the model's text.
impl std::fmt::Debug for Ask<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Ask").field("chat_id", &self.chat_id).field("turn_id", &self.turn_id).finish_non_exhaustive()
    }
}

/// The newest public key of the account's `audit` scope.
async fn audit_key(conn: &mut PgConnection, user_id: Uuid) -> Result<ScopePublicKey> {
    let row: Option<(Uuid, i32, Vec<u8>)> = sqlx::query_as(
        "SELECT s.id, k.key_version, k.public_key FROM scopes s JOIN scope_keys k ON k.scope_id = s.id
         WHERE s.user_id = $1 AND s.kind = 'audit' ORDER BY k.key_version DESC LIMIT 1",
    )
    .bind(user_id)
    .fetch_optional(conn)
    .await?;
    let (_, version, key) = row.ok_or(Refused(ErrorCode::KeysNotSetUp))?;
    let key = PublicKey::from_slice(&key).map_err(|_| Refused(ErrorCode::Internal))?;
    Ok(ScopePublicKey { key_version: u32::try_from(version).map_err(|_| Refused(ErrorCode::Internal))?, key })
}

async fn audit_scope(conn: &mut PgConnection, user_id: Uuid) -> Result<Uuid> {
    let id: Option<Uuid> = sqlx::query_scalar("SELECT id FROM scopes WHERE user_id = $1 AND kind = 'audit'")
        .bind(user_id)
        .fetch_optional(conn)
        .await?;
    id.ok_or(Refused(ErrorCode::KeysNotSetUp))
}

/// A grant as the columns of its row.
#[derive(Default)]
struct Columns {
    metric: Option<String>,
    scope_id: Option<Uuid>,
    from: Option<String>,
    to: Option<String>,
    before: Option<i32>,
    count: Option<i32>,
}

fn grant_columns(grant: &Grant) -> (&'static str, Columns) {
    match grant {
        Grant::ReadRegister { metric, scope_id, from, to } => (
            "read_register",
            Columns {
                metric: Some(metric.clone()),
                scope_id: Some(*scope_id),
                from: from.clone(),
                to: to.clone(),
                ..Columns::default()
            },
        ),
        Grant::SessionContext {} => ("session_context", Columns::default()),
        Grant::ReadHistory { before, count } => (
            "read_history",
            Columns { before: i32::try_from(*before).ok(), count: i32::try_from(*count).ok(), ..Columns::default() },
        ),
    }
}

fn grant_of(tool: &str, c: Columns) -> Grant {
    let id = |n: Option<i32>| n.and_then(|n| u32::try_from(n).ok());
    match (tool, c.metric, c.scope_id) {
        ("read_register", Some(metric), Some(scope_id)) => {
            Grant::ReadRegister { metric, scope_id, from: c.from, to: c.to }
        }
        ("read_history", ..) => {
            Grant::ReadHistory { before: id(c.before).unwrap_or(1), count: id(c.count).unwrap_or(1) }
        }
        // The schema allows nothing else.
        _ => Grant::SessionContext {},
    }
}

/// Writes the request with its sealed reason; the caller sends the event.
pub async fn ask(db: &PgPool, ask: Ask<'_>) -> Result<PermissionRequest> {
    let mut conn = db.acquire().await?;
    let id = Uuid::now_v7();
    let key = audit_key(&mut conn, ask.user_id).await?;
    let scope = audit_scope(&mut conn, ask.user_id).await?;
    let place = Place {
        user: UserId::from_bytes(*ask.user_id.as_bytes()),
        scope: ScopeId::from_bytes(*scope.as_bytes()),
        kind: Kind::AuditReason { log_entry_id: LogEntryId::from_bytes(*id.as_bytes()) },
    };
    let reason = record::seal_as_server(&place, &key, ask.reason.as_bytes(), &mut os_rng())
        .map_err(|_| Refused(ErrorCode::Internal))?;
    let (tool, c) = grant_columns(ask.grant);
    let expires_at: i64 = sqlx::query_scalar(
        "INSERT INTO access_log (id, user_id, session_id, chat_id, turn_id, provider_id, tool, metric, scope_id,
             day_from, day_to, message_before, message_count, reason, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now() + make_interval(secs => $15))
         RETURNING (extract(epoch FROM expires_at) * 1000)::bigint",
    )
    .bind(id)
    .bind(ask.user_id)
    .bind(ask.session_id)
    .bind(ask.chat_id)
    .bind(ask.turn_id)
    .bind(ask.provider_id)
    .bind(tool)
    .bind(c.metric)
    .bind(c.scope_id)
    .bind(c.from)
    .bind(c.to)
    .bind(c.before)
    .bind(c.count)
    .bind(&reason)
    .bind(ask.wait.as_secs_f64())
    .fetch_one(&mut *conn)
    .await?;
    Ok(PermissionRequest {
        request_id: id,
        chat_id: ask.chat_id,
        turn_id: ask.turn_id,
        provider_id: ask.provider_id,
        grant: ask.grant.clone(),
        reason: Bytes(reason),
        expires_at,
    })
}

/// Ids, the reason and the expiry, then the grant's columns from its tool on.
type RequestRow = (
    Uuid,
    Uuid,
    Uuid,
    Uuid,
    Vec<u8>,
    i64,
    String,
    Option<String>,
    Option<Uuid>,
    Option<String>,
    Option<String>,
    Option<i32>,
    Option<i32>,
);

/// The auth session's requests still waiting, oldest first.
pub async fn pending(db: &PgPool, principal: &Principal) -> Result<PermissionList> {
    let rows: Vec<RequestRow> = sqlx::query_as(
        "SELECT id, chat_id, turn_id, provider_id, reason, (extract(epoch FROM expires_at) * 1000)::bigint,
             tool, metric, scope_id, day_from, day_to, message_before, message_count
         FROM access_log
         WHERE session_id = $1 AND user_id = $2 AND outcome IS NULL AND expires_at > now()
         ORDER BY id",
    )
    .bind(principal.session_id)
    .bind(principal.user_id)
    .fetch_all(db)
    .await?;
    let requests = rows
        .into_iter()
        .map(
            |(
                request_id,
                chat_id,
                turn_id,
                provider_id,
                reason,
                expires_at,
                tool,
                metric,
                scope_id,
                from,
                to,
                before,
                count,
            )| {
                PermissionRequest {
                    request_id,
                    chat_id,
                    turn_id,
                    provider_id,
                    grant: grant_of(&tool, Columns { metric, scope_id, from, to, before, count }),
                    reason: Bytes(reason),
                    expires_at,
                }
            },
        )
        .collect();
    Ok(PermissionList { requests })
}

/// An answer on its way to the turn that asked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Answer {
    pub request_id: Uuid,
    pub outcome: Outcome,
    /// The tool result of an approved `read_register` or an answered `read_history`.
    pub result: Option<Secret>,
}

/// Stores the auth session's answer once and hands it to the turn.
pub async fn respond(state: &AppState, principal: &Principal, respond: PermissionRespond) -> Result<()> {
    let mut tx = state.db.begin().await?;
    let tool: Option<String> = sqlx::query_scalar(
        "SELECT tool FROM access_log
         WHERE id = $1 AND user_id = $2 AND session_id = $3 AND outcome IS NULL AND expires_at > now()
         FOR UPDATE",
    )
    .bind(respond.request_id)
    .bind(principal.user_id)
    .bind(principal.session_id)
    .fetch_optional(&mut *tx)
    .await?;
    let tool = tool.ok_or(Refused(ErrorCode::PermissionNotFound))?;
    // History is answered or refused, and asks no one; the rest the user decides.
    let history = tool == "read_history";
    let (allowed, needs_result, max) = match respond.decision {
        Decision::Answer => (history, true, HISTORY_MAX),
        Decision::Approve => (!history, tool == "read_register", RESULT_MAX),
        Decision::Deny => (!history, false, 0),
        Decision::Refuse => (true, false, 0),
    };
    if !allowed {
        return Err(Refused(ErrorCode::Malformed));
    }
    match &respond.result {
        Some(r) if !needs_result || r.0.is_empty() || r.0.len() > max => {
            return Err(Refused(ErrorCode::Malformed));
        }
        None if needs_result => return Err(Refused(ErrorCode::Malformed)),
        _ => {}
    }
    let outcome = respond.decision.outcome();
    let chat_id: Uuid =
        sqlx::query_scalar("UPDATE access_log SET outcome = $2, decided_at = now() WHERE id = $1 RETURNING chat_id")
            .bind(respond.request_id)
            .bind(outcome.name())
            .fetch_one(&mut *tx)
            .await?;
    tx.commit().await?;
    let answer = Answer { request_id: respond.request_id, outcome, result: respond.result };
    state.bus.publish(Note::Answer(answer)).await;
    resolved(&state.bus, principal.session_id, respond.request_id, chat_id, outcome).await;
    Ok(())
}

async fn resolved(bus: &Bus, session_id: Uuid, request_id: Uuid, chat_id: Uuid, outcome: Outcome) {
    let event = PermissionResolved { request_id, chat_id, outcome };
    bus.publish(Note::event(Target::Session(session_id), &event)).await;
}

/// Ends a request the turn gives up on (`timeout`, `cancelled`); false when
/// an answer came first.
pub async fn close(db: &PgPool, bus: &Bus, request_id: Uuid, outcome: Outcome) -> sqlx::Result<bool> {
    let row: Option<(Uuid, Uuid)> = sqlx::query_as(
        "UPDATE access_log SET outcome = $2, decided_at = now() WHERE id = $1 AND outcome IS NULL
         RETURNING session_id, chat_id",
    )
    .bind(request_id)
    .bind(outcome.name())
    .fetch_optional(db)
    .await?;
    let Some((session_id, chat_id)) = row else { return Ok(false) };
    resolved(bus, session_id, request_id, chat_id, outcome).await;
    Ok(true)
}

/// How a request ended, if it did.
pub async fn outcome(db: &PgPool, request_id: Uuid) -> sqlx::Result<Option<Outcome>> {
    let name: Option<Option<String>> =
        sqlx::query_scalar("SELECT outcome FROM access_log WHERE id = $1").bind(request_id).fetch_optional(db).await?;
    Ok(name.flatten().as_deref().and_then(Outcome::from_name))
}

/// The entry's own columns, then the grant's from its tool on.
type EntryRow = (
    Uuid,
    Uuid,
    Vec<u8>,
    Option<String>,
    i64,
    Option<i64>,
    String,
    Option<String>,
    Option<Uuid>,
    Option<String>,
    Option<String>,
    Option<i32>,
    Option<i32>,
);

/// A page of the access log, newest first.
pub async fn list(db: &PgPool, principal: &Principal, before: Option<Uuid>) -> Result<AccessLogPage> {
    let limit = i64::try_from(ACCESS_PAGE).unwrap_or(i64::MAX);
    let rows: Vec<EntryRow> = sqlx::query_as(
        // A request whose turn died with its replica has no outcome: past its
        // time (and the turn's last look) it timed out all the same.
        "SELECT id, chat_id, reason,
             COALESCE(outcome, CASE WHEN expires_at < now() - interval '1 minute' THEN 'timeout' END),
             (extract(epoch FROM requested_at) * 1000)::bigint,
             (extract(epoch FROM decided_at) * 1000)::bigint,
             tool, metric, scope_id, day_from, day_to, message_before, message_count
         FROM access_log WHERE user_id = $1 AND ($2::uuid IS NULL OR id < $2)
         ORDER BY id DESC LIMIT $3",
    )
    .bind(principal.user_id)
    .bind(before)
    .bind(limit + 1)
    .fetch_all(db)
    .await?;
    let more = rows.len() > ACCESS_PAGE;
    let entries: Vec<AccessEntry> = rows
        .into_iter()
        .take(ACCESS_PAGE)
        .map(
            |(
                id,
                chat_id,
                reason,
                outcome,
                requested_at,
                decided_at,
                tool,
                metric,
                scope_id,
                from,
                to,
                before,
                count,
            )| AccessEntry {
                id,
                chat_id,
                grant: grant_of(&tool, Columns { metric, scope_id, from, to, before, count }),
                reason: Bytes(reason),
                outcome: outcome.as_deref().and_then(Outcome::from_name),
                requested_at,
                decided_at,
            },
        )
        .collect();
    let next = if more { entries.last().map(|e| e.id) } else { None };
    Ok(AccessLogPage { entries, next })
}

/// What `session_context` tells (docs/auth.md, "Agent access to session data").
pub async fn session_context(db: &PgPool, session_id: Uuid) -> sqlx::Result<serde_json::Value> {
    let row: Option<(Option<String>, Option<String>, Option<String>)> =
        sqlx::query_as("SELECT timezone, country, locale FROM sessions WHERE id = $1")
            .bind(session_id)
            .fetch_optional(db)
            .await?;
    let (timezone, country, locale) = row.unwrap_or_default();
    Ok(serde_json::json!({
        "timezone": timezone,
        "country": country,
        "locale": locale,
        "utc_time": crate::chats::tools::utc(time::OffsetDateTime::now_utc().unix_timestamp()),
    }))
}
