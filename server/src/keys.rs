//! Account keys, ARK wraps and scope keys in PostgreSQL (docs/protocol.md,
//! "Keys"). The server never opens anything here: it decodes wraps with
//! `chat-crypto` only to check their shape and read their id and method.

use std::collections::HashSet;

use chat_crypto::wrap::{ArkWrap, WrapMethod};
use chat_protocol::{
    Bytes,
    error::ErrorCode,
    keys::{
        AccountKeys, AccountScope, AccountScopeKind, KeysSetup, KeysState, PASSKEYS_MAX, SCOPE_KEYS_MAX, ScopeKey,
        StoredWrap,
    },
};
use serde_json::json;
use sqlx::{PgConnection, PgPool};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::auth::{
    Principal,
    audit::{self, Event, Kind, millis},
    client::ClientInfo,
};

const KEY_LEN: usize = 32;
/// Matches the column check; a v1 wrapped scope key is 73 bytes.
const WRAPPED_KEY_MAX: usize = 256;

#[derive(Debug, thiserror::Error)]
pub enum KeysError {
    #[error("{0:?}")]
    Refused(ErrorCode),
    #[error(transparent)]
    Db(#[from] sqlx::Error),
}

use KeysError::Refused;

type Result<T> = std::result::Result<T, KeysError>;

const METHOD_PASSKEY: i16 = 1;
const METHOD_RECOVERY: i16 = 2;
const METHOD_DEVICE: i16 = 4;

/// A wrap as it came, with what the server reads from it.
struct Wrap<'a> {
    id: Uuid,
    method: i16,
    device: Option<Uuid>,
    bytes: &'a [u8],
}

fn decode(bytes: &Bytes) -> Result<Wrap<'_>> {
    let wrap = ArkWrap::decode(&bytes.0).map_err(|_| Refused(ErrorCode::KeysInvalid))?;
    let (method, device) = match wrap.method {
        WrapMethod::Passkey { .. } => (METHOD_PASSKEY, None),
        WrapMethod::Recovery => (METHOD_RECOVERY, None),
        WrapMethod::Device { device_id } => (METHOD_DEVICE, Some(Uuid::from_bytes(*device_id.as_bytes()))),
    };
    Ok(Wrap { id: Uuid::from_bytes(*wrap.wrap_id.as_bytes()), method, device, bytes: &bytes.0 })
}

fn method_name(method: i16) -> &'static str {
    match method {
        METHOD_PASSKEY => "passkey",
        METHOD_RECOVERY => "recovery",
        _ => "device",
    }
}

fn check(ok: bool) -> Result<()> {
    if ok { Ok(()) } else { Err(Refused(ErrorCode::KeysInvalid)) }
}

/// The account keys this session may see: never another device's wrap.
pub async fn get(db: &PgPool, principal: &Principal) -> Result<KeysState> {
    let row: Option<(Vec<u8>, Vec<u8>)> =
        sqlx::query_as("SELECT commitment, writer_public_key FROM account_keys WHERE user_id = $1")
            .bind(principal.user_id)
            .fetch_optional(db)
            .await?;
    let Some((commitment, writer_public_key)) = row else { return Ok(KeysState { keys: None }) };
    let wraps: Vec<(Vec<u8>, OffsetDateTime)> = sqlx::query_as(
        "SELECT wrap, created_at FROM ark_wraps
         WHERE user_id = $1 AND (session_id IS NULL OR session_id = $2)
         ORDER BY created_at, id",
    )
    .bind(principal.user_id)
    .bind(principal.session_id)
    .fetch_all(db)
    .await?;
    let scopes: Vec<(Uuid, String)> = sqlx::query_as("SELECT id, kind FROM scopes WHERE user_id = $1 ORDER BY kind")
        .bind(principal.user_id)
        .fetch_all(db)
        .await?;
    Ok(KeysState {
        keys: Some(AccountKeys {
            commitment: Bytes(commitment),
            writer_public_key: Bytes(writer_public_key),
            wraps: wraps
                .into_iter()
                .map(|(wrap, created_at)| StoredWrap { wrap: Bytes(wrap), created_at: millis(created_at) })
                .collect(),
            scopes: scopes
                .into_iter()
                .filter_map(|(scope_id, kind)| {
                    AccountScopeKind::parse(&kind).map(|kind| AccountScope { scope_id, kind })
                })
                .collect(),
        }),
    })
}

/// The stored wrap with this id, if any.
async fn stored_wrap(conn: &mut PgConnection, user_id: Uuid, id: Uuid) -> sqlx::Result<Option<Vec<u8>>> {
    sqlx::query_scalar("SELECT wrap FROM ark_wraps WHERE user_id = $1 AND id = $2")
        .bind(user_id)
        .bind(id)
        .fetch_optional(conn)
        .await
}

async fn insert_wrap(conn: &mut PgConnection, user_id: Uuid, wrap: &Wrap<'_>, session: Option<Uuid>) -> Result<()> {
    let inserted = sqlx::query(
        "INSERT INTO ark_wraps (user_id, id, method, wrap, session_id) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, id) DO NOTHING",
    )
    .bind(user_id)
    .bind(wrap.id)
    .bind(wrap.method)
    .bind(wrap.bytes)
    .bind(session)
    .execute(conn)
    .await?
    .rows_affected();
    check(inserted == 1)
}

async fn audit_wrap(
    conn: &mut PgConnection,
    principal: &Principal,
    client: &ClientInfo,
    kind: Kind,
    wrap: (Uuid, i16),
) -> Result<()> {
    let event = Event::new(kind, principal.user_id)
        .session(principal.session_id)
        .details(json!({ "method": method_name(wrap.1), "wrap_id": wrap.0 }));
    audit::record(conn, client, event).await?;
    Ok(())
}

/// First key setup, in one transaction. A repeat of the same bundle succeeds.
pub async fn setup(db: &PgPool, principal: &Principal, client: &ClientInfo, setup: &KeysSetup) -> Result<()> {
    check(setup.commitment.0.len() == KEY_LEN && setup.writer_public_key.0.len() == KEY_LEN)?;
    let wraps = setup.wraps.iter().map(decode).collect::<Result<Vec<_>>>()?;
    let recovery: Vec<&Wrap<'_>> = wraps.iter().filter(|w| w.method == METHOD_RECOVERY).collect();
    let passkeys = wraps.iter().filter(|w| w.method == METHOD_PASSKEY).count();
    check(recovery.len() == 1 && recovery.len() + passkeys == wraps.len())?;
    if passkeys > PASSKEYS_MAX {
        return Err(Refused(ErrorCode::KeysLimit));
    }
    check(wraps.iter().map(|w| w.id).collect::<HashSet<_>>().len() == wraps.len())?;
    let kinds: HashSet<AccountScopeKind> = setup.scopes.iter().map(|s| s.kind).collect();
    let ids: HashSet<Uuid> = setup.scopes.iter().map(|s| s.scope_id).collect();
    let all = AccountScopeKind::ALL.len();
    check(setup.scopes.len() == all && kinds.len() == all && ids.len() == all)?;
    check(setup.scopes.iter().all(|s| {
        s.public_key.0.len() == KEY_LEN
            && !s.wrapped_private_key.0.is_empty()
            && s.wrapped_private_key.0.len() <= WRAPPED_KEY_MAX
    }))?;

    let mut tx = db.begin().await?;
    let created = sqlx::query(
        "INSERT INTO account_keys (user_id, commitment, writer_public_key) VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO NOTHING",
    )
    .bind(principal.user_id)
    .bind(&setup.commitment.0)
    .bind(&setup.writer_public_key.0)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if created == 0 {
        // Another setup won, unless it was this very bundle sent again after a reconnect.
        let ours = stored_wrap(&mut tx, principal.user_id, recovery[0].id).await?;
        return if ours.as_deref() == Some(recovery[0].bytes) { Ok(()) } else { Err(Refused(ErrorCode::KeysExists)) };
    }
    for wrap in &wraps {
        insert_wrap(&mut tx, principal.user_id, wrap, None).await?;
    }
    for scope in &setup.scopes {
        let inserted = sqlx::query("INSERT INTO scopes (id, user_id, kind) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING")
            .bind(scope.scope_id)
            .bind(principal.user_id)
            .bind(scope.kind.as_str())
            .execute(&mut *tx)
            .await?
            .rows_affected();
        check(inserted == 1)?;
        sqlx::query(
            "INSERT INTO scope_keys (scope_id, key_version, public_key, wrapped_private_key) VALUES ($1, 1, $2, $3)",
        )
        .bind(scope.scope_id)
        .bind(&scope.public_key.0)
        .bind(&scope.wrapped_private_key.0)
        .execute(&mut *tx)
        .await?;
    }
    let event = Event::new(Kind::KeysSetup, principal.user_id)
        .session(principal.session_id)
        .details(json!({ "passkeys": passkeys }));
    audit::record(&mut tx, client, event).await?;
    tx.commit().await?;
    Ok(())
}

/// Locks the account's keys row, so changes to its wraps run one at a time
/// (the passkey limit is counted, not constrained).
async fn lock_keys(conn: &mut PgConnection, user_id: Uuid) -> Result<()> {
    let found: Option<i32> = sqlx::query_scalar("SELECT 1 FROM account_keys WHERE user_id = $1 FOR UPDATE")
        .bind(user_id)
        .fetch_optional(conn)
        .await?;
    if found.is_some() { Ok(()) } else { Err(Refused(ErrorCode::KeysNotSetUp)) }
}

/// Adds a passkey wrap, or replaces the wrap of the session's own device.
pub async fn add_wrap(db: &PgPool, principal: &Principal, client: &ClientInfo, bytes: &Bytes) -> Result<()> {
    let wrap = decode(bytes)?;
    let mut tx = db.begin().await?;
    lock_keys(&mut tx, principal.user_id).await?;
    if stored_wrap(&mut tx, principal.user_id, wrap.id).await?.as_deref() == Some(wrap.bytes) {
        return Ok(());
    }
    match wrap.method {
        METHOD_PASSKEY => {
            let count: i64 = sqlx::query_scalar("SELECT count(*) FROM ark_wraps WHERE user_id = $1 AND method = 1")
                .bind(principal.user_id)
                .fetch_one(&mut *tx)
                .await?;
            if usize::try_from(count).unwrap_or(usize::MAX) >= PASSKEYS_MAX {
                return Err(Refused(ErrorCode::KeysLimit));
            }
            insert_wrap(&mut tx, principal.user_id, &wrap, None).await?;
        }
        METHOD_DEVICE => {
            // Locking the session row orders this against a revocation: either
            // the revocation's trigger sees this wrap, or this sees the revocation.
            let device: Option<Option<Uuid>> =
                sqlx::query_scalar("SELECT device_id FROM sessions WHERE id = $1 AND revoked_at IS NULL FOR UPDATE")
                    .bind(principal.session_id)
                    .fetch_optional(&mut *tx)
                    .await?;
            if device.flatten().is_none_or(|d| Some(d) != wrap.device) {
                return Err(Refused(ErrorCode::KeysDeviceMismatch));
            }
            sqlx::query("DELETE FROM ark_wraps WHERE session_id = $1")
                .bind(principal.session_id)
                .execute(&mut *tx)
                .await?;
            insert_wrap(&mut tx, principal.user_id, &wrap, Some(principal.session_id)).await?;
        }
        _ => return Err(Refused(ErrorCode::KeysInvalid)),
    }
    audit_wrap(&mut tx, principal, client, Kind::KeysWrapAdded, (wrap.id, wrap.method)).await?;
    tx.commit().await?;
    Ok(())
}

/// Removes a passkey or device wrap; one that is already gone is not an error.
pub async fn remove_wrap(db: &PgPool, principal: &Principal, client: &ClientInfo, wrap_id: Uuid) -> Result<()> {
    let mut tx = db.begin().await?;
    let method: Option<i16> = sqlx::query_scalar("SELECT method FROM ark_wraps WHERE user_id = $1 AND id = $2")
        .bind(principal.user_id)
        .bind(wrap_id)
        .fetch_optional(&mut *tx)
        .await?;
    match method {
        None => Ok(()),
        Some(METHOD_RECOVERY) => Err(Refused(ErrorCode::KeysRecoveryRequired)),
        Some(method) => {
            sqlx::query("DELETE FROM ark_wraps WHERE user_id = $1 AND id = $2")
                .bind(principal.user_id)
                .bind(wrap_id)
                .execute(&mut *tx)
                .await?;
            audit_wrap(&mut tx, principal, client, Kind::KeysWrapRemoved, (wrap_id, method)).await?;
            tx.commit().await?;
            Ok(())
        }
    }
}

/// Replaces the recovery wrap. A repeat of the same wrap succeeds.
pub async fn rotate_recovery(db: &PgPool, principal: &Principal, client: &ClientInfo, bytes: &Bytes) -> Result<()> {
    let wrap = decode(bytes)?;
    check(wrap.method == METHOD_RECOVERY)?;
    let mut tx = db.begin().await?;
    let current: Option<(Uuid, Vec<u8>)> =
        sqlx::query_as("SELECT id, wrap FROM ark_wraps WHERE user_id = $1 AND method = 2 FOR UPDATE")
            .bind(principal.user_id)
            .fetch_optional(&mut *tx)
            .await?;
    let Some((current_id, current)) = current else { return Err(Refused(ErrorCode::KeysNotSetUp)) };
    if current == wrap.bytes {
        return Ok(());
    }
    sqlx::query("DELETE FROM ark_wraps WHERE user_id = $1 AND id = $2")
        .bind(principal.user_id)
        .bind(current_id)
        .execute(&mut *tx)
        .await?;
    insert_wrap(&mut tx, principal.user_id, &wrap, None).await?;
    let event = Event::new(Kind::KeysRecoveryRotated, principal.user_id)
        .session(principal.session_id)
        .details(json!({ "wrap_id": wrap.id }));
    audit::record(&mut tx, client, event).await?;
    tx.commit().await?;
    Ok(())
}

/// Every key version of the named scopes the user owns.
pub async fn scope_keys(db: &PgPool, principal: &Principal, scope_ids: &[Uuid]) -> Result<Vec<ScopeKey>> {
    if scope_ids.len() > SCOPE_KEYS_MAX {
        return Err(Refused(ErrorCode::KeysInvalid));
    }
    let rows: Vec<(Uuid, i32, Vec<u8>, Vec<u8>)> = sqlx::query_as(
        "SELECT k.scope_id, k.key_version, k.public_key, k.wrapped_private_key
         FROM scope_keys k JOIN scopes s ON s.id = k.scope_id
         WHERE s.user_id = $1 AND k.scope_id = ANY($2)
         ORDER BY k.scope_id, k.key_version",
    )
    .bind(principal.user_id)
    .bind(scope_ids)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(scope_id, version, public_key, wrapped)| ScopeKey {
            scope_id,
            key_version: u32::try_from(version).unwrap_or(0),
            public_key: Bytes(public_key),
            wrapped_private_key: Bytes(wrapped),
        })
        .collect())
}
