//! Registers in PostgreSQL (docs/protocol.md, "Registers"; D-097): the metric
//! catalog the migrations seed, each account's registers (a `register` scope
//! per metric it uses) and their entries. The server stores `register.value`
//! records as they came; it checks only their size and key version and never
//! opens one.

use std::collections::BTreeMap;

use chat_crypto::record;
use chat_protocol::{
    Bytes,
    error::ErrorCode,
    registers::{
        ENTRIES_MAX, ENTRIES_PAGE, Metric, MetricCatalog, MetricCategory, OCCURRED_MAX, OCCURRED_MIN, RegisterCreate,
        RegisterCursor, RegisterDeleted, RegisterEntries, RegisterEntry, RegisterInfo, RegisterPage, RegisterScope,
        RegisterSetup, RegisterUpdate, RegisterUpdated, VALUE_MAX,
    },
};
use sqlx::{PgConnection, PgPool, types::Json};
use uuid::Uuid;

use crate::{
    app::AppState,
    auth::Principal,
    bus::{Note as BusNote, Target},
    keys::{
        KEY_LEN,
        KeysError::{self, Refused},
        WRAPPED_KEY_MAX,
    },
};

type Result<T> = std::result::Result<T, KeysError>;

type EntryRow = (Uuid, String, i64, Vec<u8>, i64, i64);

macro_rules! entry_columns {
    () => {
        "e.id, r.metric, e.occurred_at, e.value, e.updated_at, e.rev"
    };
}

fn entry((entry_id, metric, occurred_at, value, updated_at, rev): EntryRow) -> RegisterEntry {
    RegisterEntry { entry_id, metric, occurred_at, value: Bytes(value), updated_at, rev }
}

type MetricRow =
    (String, String, String, Json<BTreeMap<String, String>>, String, String, String, i16, f64, f64, String, bool);

/// The catalog and the account's registers.
pub async fn catalog(db: &PgPool, principal: &Principal) -> Result<MetricCatalog> {
    Ok(catalog_of(db, principal.user_id).await?)
}

/// The catalog and the registers of `user_id`, as a request or a turn's `list_metrics` sees them.
pub async fn catalog_of(db: &PgPool, user_id: Uuid) -> sqlx::Result<MetricCatalog> {
    let mut conn = db.acquire().await?;
    let categories: Vec<(String, Json<BTreeMap<String, String>>)> =
        sqlx::query_as("SELECT key, names FROM metric_categories ORDER BY position").fetch_all(&mut *conn).await?;
    let metrics: Vec<MetricRow> = sqlx::query_as(
        "SELECT key, category, register, names, unit, quantity, value_type, precision, min, max, aggregate, sets
         FROM metrics ORDER BY position",
    )
    .fetch_all(&mut *conn)
    .await?;
    let registers: Vec<(String, Uuid, i64, Option<i64>)> = sqlx::query_as(
        "SELECT r.metric, r.scope_id, count(e.id), max(e.occurred_at)
         FROM registers r LEFT JOIN register_entries e ON e.scope_id = r.scope_id
         WHERE r.user_id = $1 GROUP BY r.scope_id, r.metric ORDER BY r.metric",
    )
    .bind(user_id)
    .fetch_all(&mut *conn)
    .await?;
    Ok(MetricCatalog {
        categories: categories.into_iter().map(|(key, names)| MetricCategory { key, names: names.0 }).collect(),
        metrics: metrics
            .into_iter()
            .map(
                |(key, category, register, names, unit, quantity, value_type, precision, min, max, aggregate, sets)| {
                    Metric {
                        key,
                        category,
                        register,
                        names: names.0,
                        unit,
                        quantity,
                        value_type,
                        precision: u8::try_from(precision).unwrap_or(0),
                        min,
                        max,
                        aggregate,
                        sets,
                    }
                },
            )
            .collect(),
        registers: registers
            .into_iter()
            .map(|(metric, scope_id, entries, latest_at)| RegisterInfo { metric, scope_id, entries, latest_at })
            .collect(),
    })
}

/// Entries of a register between two moments in seconds (`to` excluded), for
/// a turn that need not ask about days without any (D-099).
pub async fn count_between(db: &PgPool, scope_id: Uuid, from: Option<i64>, to: Option<i64>) -> sqlx::Result<i64> {
    sqlx::query_scalar(
        "SELECT count(*) FROM register_entries
         WHERE scope_id = $1 AND ($2::bigint IS NULL OR occurred_at >= $2) AND ($3::bigint IS NULL OR occurred_at < $3)",
    )
    .bind(scope_id)
    .bind(from)
    .bind(to)
    .fetch_one(db)
    .await
}

async fn metric_exists(conn: &mut PgConnection, metric: &str) -> Result<()> {
    let found: Option<i32> =
        sqlx::query_scalar("SELECT 1 FROM metrics WHERE key = $1").bind(metric).fetch_optional(conn).await?;
    found.map(|_| ()).ok_or(Refused(ErrorCode::MetricNotFound))
}

/// The scope of the account's register of `metric` and its current key version.
async fn register_scope(conn: &mut PgConnection, user_id: Uuid, metric: &str) -> Result<Option<(Uuid, u32)>> {
    let row: Option<(Uuid, i32)> = sqlx::query_as(
        "SELECT r.scope_id, max(k.key_version) FROM registers r JOIN scope_keys k ON k.scope_id = r.scope_id
         WHERE r.user_id = $1 AND r.metric = $2 GROUP BY r.scope_id",
    )
    .bind(user_id)
    .bind(metric)
    .fetch_optional(conn)
    .await?;
    row.map(|(id, version)| u32::try_from(version).map(|v| (id, v)).map_err(|_| Refused(ErrorCode::Internal)))
        .transpose()
}

/// Locks the account, so setups and creates of one account run one at a time.
async fn lock_account(conn: &mut PgConnection, principal: &Principal) -> Result<()> {
    let row: Option<i32> = sqlx::query_scalar("SELECT 1 FROM account_keys WHERE user_id = $1 FOR UPDATE")
        .bind(principal.user_id)
        .fetch_optional(conn)
        .await?;
    row.map(|_| ()).ok_or(Refused(ErrorCode::KeysNotSetUp))
}

/// The value sealed to `version` and within its limit, at a moment in range.
fn check_entry(value: &[u8], occurred_at: i64, version: u32) -> Result<()> {
    let sealed = !value.is_empty() && value.len() <= VALUE_MAX && record::key_version(value).ok() == Some(version);
    if !sealed || !(OCCURRED_MIN..OCCURRED_MAX).contains(&occurred_at) {
        return Err(Refused(ErrorCode::Malformed));
    }
    Ok(())
}

/// The scope of the metric's register that exists, or a new one from these keys.
pub async fn setup(db: &PgPool, principal: &Principal, setup: &RegisterSetup) -> Result<RegisterScope> {
    let wrapped = &setup.wrapped_private_key.0;
    if setup.public_key.0.len() != KEY_LEN || wrapped.is_empty() || wrapped.len() > WRAPPED_KEY_MAX {
        return Err(Refused(ErrorCode::Malformed));
    }
    let mut tx = db.begin().await?;
    lock_account(&mut tx, principal).await?;
    metric_exists(&mut tx, &setup.metric).await?;
    if let Some((scope_id, _)) = register_scope(&mut tx, principal.user_id, &setup.metric).await? {
        return Ok(RegisterScope { scope_id });
    }
    let inserted =
        sqlx::query("INSERT INTO scopes (id, user_id, kind) VALUES ($1, $2, 'register') ON CONFLICT DO NOTHING")
            .bind(setup.scope_id)
            .bind(principal.user_id)
            .execute(&mut *tx)
            .await?
            .rows_affected();
    // The id of a scope that exists already.
    if inserted != 1 {
        return Err(Refused(ErrorCode::Malformed));
    }
    sqlx::query(
        "INSERT INTO scope_keys (scope_id, key_version, public_key, wrapped_private_key) VALUES ($1, 1, $2, $3)",
    )
    .bind(setup.scope_id)
    .bind(&setup.public_key.0)
    .bind(wrapped)
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO registers (scope_id, user_id, metric) VALUES ($1, $2, $3)")
        .bind(setup.scope_id)
        .bind(principal.user_id)
        .bind(&setup.metric)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(RegisterScope { scope_id: setup.scope_id })
}

/// A page of one metric's entries, newest first.
pub async fn entries(db: &PgPool, principal: &Principal, request: &RegisterEntries) -> Result<RegisterPage> {
    let limit = request.limit.unwrap_or(ENTRIES_PAGE);
    if !(1..=ENTRIES_PAGE).contains(&limit) {
        return Err(Refused(ErrorCode::Malformed));
    }
    let mut conn = db.acquire().await?;
    metric_exists(&mut conn, &request.metric).await?;
    let rows: Vec<EntryRow> = sqlx::query_as(concat!(
        "SELECT ",
        entry_columns!(),
        " FROM register_entries e JOIN registers r ON r.scope_id = e.scope_id
         WHERE r.user_id = $1 AND r.metric = $2
           AND ($3::bigint IS NULL OR e.occurred_at >= $3)
           AND ($4::bigint IS NULL OR e.occurred_at < $4)
           AND ($5::bigint IS NULL OR (e.occurred_at, e.id) < ($5, $6))
         ORDER BY e.occurred_at DESC, e.id DESC LIMIT $7"
    ))
    .bind(principal.user_id)
    .bind(&request.metric)
    .bind(request.from)
    .bind(request.to)
    .bind(request.before.map(|b| b.occurred_at))
    .bind(request.before.map(|b| b.entry_id))
    .bind(i64::from(limit) + 1)
    .fetch_all(&mut *conn)
    .await?;
    let page = usize::try_from(limit).unwrap_or(usize::MAX);
    let more = rows.len() > page;
    let entries: Vec<RegisterEntry> = rows.into_iter().take(page).map(entry).collect();
    let next = more
        .then(|| entries.last())
        .flatten()
        .map(|last| RegisterCursor { occurred_at: last.occurred_at, entry_id: last.entry_id });
    Ok(RegisterPage { entries, next })
}

/// Frames for `register.entries`: parts split between entries, `next` on the last.
pub fn page_frames(id: u32, page: RegisterPage) -> Vec<Vec<u8>> {
    let RegisterPage { entries, next } = page;
    let count = entries.len();
    let sent = std::cell::Cell::new(0);
    chat_protocol::encode_parts(id, entries, chat_protocol::PART_BYTES, |run: Vec<RegisterEntry>| {
        sent.set(sent.get() + run.len());
        RegisterPage { entries: run, next: if sent.get() == count { next } else { None } }
    })
}

pub async fn create(state: &AppState, principal: &Principal, create: &RegisterCreate) -> Result<RegisterEntry> {
    let mut tx = state.db.begin().await?;
    // Serializes the count against the limit.
    lock_account(&mut tx, principal).await?;
    metric_exists(&mut tx, &create.metric).await?;
    let (scope_id, version) = register_scope(&mut tx, principal.user_id, &create.metric)
        .await?
        .ok_or(Refused(ErrorCode::RegisterNotSetUp))?;
    check_entry(&create.value.0, create.occurred_at, version)?;
    // Another account's entry under this id answers like one of ours with other
    // fields, so the id tells nothing about it.
    let stored: Option<(Uuid, Uuid, i64, Vec<u8>)> =
        sqlx::query_as("SELECT user_id, scope_id, occurred_at, value FROM register_entries WHERE id = $1")
            .bind(create.entry_id)
            .fetch_optional(&mut *tx)
            .await?;
    if let Some((owner, scope, occurred_at, value)) = stored {
        if owner == principal.user_id
            && scope == scope_id
            && occurred_at == create.occurred_at
            && value == create.value.0
        {
            return Ok(load(&mut tx, create.entry_id).await?);
        }
        return Err(Refused(ErrorCode::RegisterExists));
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM register_entries WHERE user_id = $1")
        .bind(principal.user_id)
        .fetch_one(&mut *tx)
        .await?;
    if count >= ENTRIES_MAX {
        return Err(Refused(ErrorCode::RegisterLimit));
    }
    // Another account may take the id between the check and here.
    let inserted = sqlx::query(
        "INSERT INTO register_entries (id, user_id, scope_id, occurred_at, value, rev, updated_at)
         VALUES ($1, $2, $3, $4, $5, 1, (extract(epoch FROM now()) * 1000)::bigint)
         ON CONFLICT (id) DO NOTHING",
    )
    .bind(create.entry_id)
    .bind(principal.user_id)
    .bind(scope_id)
    .bind(create.occurred_at)
    .bind(&create.value.0)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if inserted != 1 {
        return Err(Refused(ErrorCode::RegisterExists));
    }
    let stored = load(&mut tx, create.entry_id).await?;
    tx.commit().await?;
    publish(state, principal.user_id, &RegisterUpdated { entry: stored.clone() }).await;
    Ok(stored)
}

pub async fn update(state: &AppState, principal: &Principal, update: &RegisterUpdate) -> Result<RegisterEntry> {
    let mut tx = state.db.begin().await?;
    let stored: Option<(i64, Vec<u8>, i64, String)> = sqlx::query_as(
        "SELECT e.occurred_at, e.value, e.rev, r.metric FROM register_entries e
         JOIN registers r ON r.scope_id = e.scope_id
         WHERE e.id = $1 AND e.user_id = $2 FOR UPDATE OF e",
    )
    .bind(update.entry_id)
    .bind(principal.user_id)
    .fetch_optional(&mut *tx)
    .await?;
    let (occurred_at, value, rev, metric) = stored.ok_or(Refused(ErrorCode::RegisterNotFound))?;
    let (_, version) =
        register_scope(&mut tx, principal.user_id, &metric).await?.ok_or(Refused(ErrorCode::RegisterNotSetUp))?;
    check_entry(&update.value.0, update.occurred_at, version)?;
    // A resend of an update that went through.
    if occurred_at == update.occurred_at && value == update.value.0 {
        return Ok(load(&mut tx, update.entry_id).await?);
    }
    if rev != update.rev {
        return Err(Refused(ErrorCode::RegisterConflict));
    }
    sqlx::query(
        "UPDATE register_entries SET occurred_at = $2, value = $3, rev = rev + 1,
             updated_at = greatest((extract(epoch FROM now()) * 1000)::bigint, updated_at + 1)
         WHERE id = $1",
    )
    .bind(update.entry_id)
    .bind(update.occurred_at)
    .bind(&update.value.0)
    .execute(&mut *tx)
    .await?;
    let stored = load(&mut tx, update.entry_id).await?;
    tx.commit().await?;
    publish(state, principal.user_id, &RegisterUpdated { entry: stored.clone() }).await;
    Ok(stored)
}

/// Removes the entry; one that is gone succeeds and sends nothing.
pub async fn delete(state: &AppState, principal: &Principal, entry_id: Uuid) -> Result<()> {
    let removed: Option<String> = sqlx::query_scalar(
        "DELETE FROM register_entries e USING registers r
         WHERE e.id = $1 AND e.user_id = $2 AND r.scope_id = e.scope_id RETURNING r.metric",
    )
    .bind(entry_id)
    .bind(principal.user_id)
    .fetch_optional(&state.db)
    .await?;
    if let Some(metric) = removed {
        publish(state, principal.user_id, &RegisterDeleted { entry_id, metric }).await;
    }
    Ok(())
}

async fn load(conn: &mut PgConnection, entry_id: Uuid) -> sqlx::Result<RegisterEntry> {
    let row: EntryRow = sqlx::query_as(concat!(
        "SELECT ",
        entry_columns!(),
        " FROM register_entries e JOIN registers r ON r.scope_id = e.scope_id WHERE e.id = $1"
    ))
    .bind(entry_id)
    .fetch_one(conn)
    .await?;
    Ok(entry(row))
}

async fn publish<E: chat_protocol::Event + serde::Serialize>(state: &AppState, user_id: Uuid, event: &E) {
    state.bus.publish(BusNote::event(Target::User(user_id), event)).await;
}
