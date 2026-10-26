//! Settings in PostgreSQL (docs/protocol.md, "Settings"). The server stores
//! each record as it came; it checks only the size and the key version.

use chat_crypto::record;
use chat_protocol::{
    error::ErrorCode,
    settings::{
        SETTING_MAX, SETTINGS_MAX, SettingState, SettingStored, SettingValue, SettingsPut, SettingsUpdated, valid_key,
    },
};
use sqlx::{PgConnection, PgPool};

use crate::{
    app::AppState,
    auth::Principal,
    bus::{Note, Target},
    keys::KeysError::{self, Refused},
};

type Result<T> = std::result::Result<T, KeysError>;

pub async fn get(db: &PgPool, principal: &Principal, key: &str) -> Result<SettingState> {
    if !valid_key(key) {
        return Err(Refused(ErrorCode::Malformed));
    }
    let row: Option<(Vec<u8>, i64)> =
        sqlx::query_as("SELECT record, rev FROM settings WHERE user_id = $1 AND key = $2")
            .bind(principal.user_id)
            .bind(key)
            .fetch_optional(db)
            .await?;
    Ok(SettingState { value: row.map(|(record, rev)| SettingValue { record: chat_protocol::Bytes(record), rev }) })
}

/// The current key version of the account's `settings` scope; locks the
/// account, so puts of one account run one at a time.
async fn lock_settings(conn: &mut PgConnection, principal: &Principal) -> Result<u32> {
    let locked: Option<i32> = sqlx::query_scalar("SELECT 1 FROM account_keys WHERE user_id = $1 FOR UPDATE")
        .bind(principal.user_id)
        .fetch_optional(&mut *conn)
        .await?;
    locked.ok_or(Refused(ErrorCode::KeysNotSetUp))?;
    let version: i32 = sqlx::query_scalar(concat!(
        "SELECT max(k.key_version) FROM scopes s JOIN scope_keys k ON k.scope_id = s.id ",
        "WHERE s.user_id = $1 AND s.kind = 'settings'",
    ))
    .bind(principal.user_id)
    .fetch_one(&mut *conn)
    .await?;
    u32::try_from(version).map_err(|_| Refused(ErrorCode::Internal))
}

pub async fn put(state: &AppState, principal: &Principal, put: &SettingsPut) -> Result<SettingStored> {
    let record = &put.record.0;
    if !valid_key(&put.key) || record.is_empty() || record.len() > SETTING_MAX {
        return Err(Refused(ErrorCode::Malformed));
    }
    let mut tx = state.db.begin().await?;
    let version = lock_settings(&mut tx, principal).await?;
    if record::key_version(record).ok() != Some(version) {
        return Err(Refused(ErrorCode::Malformed));
    }
    let stored: Option<(Vec<u8>, i64)> =
        sqlx::query_as("SELECT record, rev FROM settings WHERE user_id = $1 AND key = $2")
            .bind(principal.user_id)
            .bind(&put.key)
            .fetch_optional(&mut *tx)
            .await?;
    let rev = match (stored, put.rev) {
        // A resend of a put that went through.
        (Some((bytes, rev)), _) if bytes == *record => return Ok(SettingStored { rev }),
        (Some((_, rev)), Some(base)) if rev == base => rev + 1,
        (None, None) => {
            let count: i64 = sqlx::query_scalar("SELECT count(*) FROM settings WHERE user_id = $1")
                .bind(principal.user_id)
                .fetch_one(&mut *tx)
                .await?;
            if count >= SETTINGS_MAX {
                return Err(Refused(ErrorCode::SettingsLimit));
            }
            1
        }
        _ => return Err(Refused(ErrorCode::SettingsConflict)),
    };
    sqlx::query(concat!(
        "INSERT INTO settings (user_id, key, record, rev) VALUES ($1, $2, $3, $4) ",
        "ON CONFLICT (user_id, key) DO UPDATE SET record = $3, rev = $4, updated_at = now()",
    ))
    .bind(principal.user_id)
    .bind(&put.key)
    .bind(record)
    .bind(rev)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    let event = SettingsUpdated { key: put.key.clone(), record: put.record.clone(), rev };
    state.bus.publish(Note::event(Target::User(principal.user_id), &event)).await;
    Ok(SettingStored { rev })
}
