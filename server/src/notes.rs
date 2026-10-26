//! Notes in PostgreSQL (docs/protocol.md, "Notes"): the account's one notes
//! scope (D-096) and its notes. The server stores `note.title` and
//! `note.body` records as they came; it checks only their size and key
//! version and never opens one.

use chat_crypto::record;
use chat_protocol::{
    Bytes,
    error::ErrorCode,
    notes::{
        NOTE_BODY_MAX, NOTE_TITLE_MAX, NOTES_MAX, NOTES_PAGE, NoteCreate, NoteCursor, NoteDeleted, NoteInfo,
        NoteOpened, NotePage, NoteUpdate, NoteUpdated, NotesScope, NotesSetup,
    },
};
use sqlx::{PgConnection, PgPool};
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

type NoteRow = (Uuid, Vec<u8>, i64, i64, i64);
/// A [`NoteRow`] with the body.
type OpenedRow = (Uuid, Vec<u8>, i64, i64, i64, Vec<u8>);

macro_rules! note_columns {
    () => {
        "id, title, created_at, updated_at, rev"
    };
}

fn note_info((note_id, title, created_at, updated_at, rev): NoteRow) -> NoteInfo {
    NoteInfo { note_id, title: Bytes(title), created_at, updated_at, rev }
}

/// The account's notes scope and its current key version.
async fn notes_scope(conn: &mut PgConnection, user_id: Uuid) -> Result<Option<(Uuid, u32)>> {
    let row: Option<(Uuid, i32)> = sqlx::query_as(
        "SELECT s.id, max(k.key_version) FROM scopes s JOIN scope_keys k ON k.scope_id = s.id
         WHERE s.user_id = $1 AND s.kind = 'notes' GROUP BY s.id",
    )
    .bind(user_id)
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

/// Both records sealed to `version` and within their limits.
fn check_records(title: &[u8], body: &[u8], version: u32) -> Result<()> {
    let sealed = |record: &[u8], max: usize| {
        !record.is_empty() && record.len() <= max && record::key_version(record).ok() == Some(version)
    };
    if !sealed(title, NOTE_TITLE_MAX) || !sealed(body, NOTE_BODY_MAX) {
        return Err(Refused(ErrorCode::Malformed));
    }
    Ok(())
}

/// The notes scope that exists, or a new one from these keys.
pub async fn setup(db: &PgPool, principal: &Principal, setup: &NotesSetup) -> Result<NotesScope> {
    let wrapped = &setup.wrapped_private_key.0;
    if setup.public_key.0.len() != KEY_LEN || wrapped.is_empty() || wrapped.len() > WRAPPED_KEY_MAX {
        return Err(Refused(ErrorCode::Malformed));
    }
    let mut tx = db.begin().await?;
    lock_account(&mut tx, principal).await?;
    if let Some((scope_id, _)) = notes_scope(&mut tx, principal.user_id).await? {
        return Ok(NotesScope { scope_id });
    }
    let inserted =
        sqlx::query("INSERT INTO scopes (id, user_id, kind) VALUES ($1, $2, 'notes') ON CONFLICT DO NOTHING")
            .bind(setup.scope_id)
            .bind(principal.user_id)
            .execute(&mut *tx)
            .await?
            .rows_affected();
    // The id of a scope that is not this account's notes scope.
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
    tx.commit().await?;
    Ok(NotesScope { scope_id: setup.scope_id })
}

/// A page of notes, newest first.
pub async fn list(db: &PgPool, principal: &Principal, before: Option<NoteCursor>) -> Result<NotePage> {
    let mut conn = db.acquire().await?;
    let Some((scope_id, _)) = notes_scope(&mut conn, principal.user_id).await? else {
        return Ok(NotePage { scope_id: None, notes: Vec::new(), next: None });
    };
    let rows: Vec<NoteRow> = sqlx::query_as(concat!(
        "SELECT ",
        note_columns!(),
        " FROM notes WHERE user_id = $1 AND ($2::bigint IS NULL OR (updated_at, id) < ($2, $3))
         ORDER BY updated_at DESC, id DESC LIMIT $4"
    ))
    .bind(principal.user_id)
    .bind(before.map(|b| b.updated_at))
    .bind(before.map(|b| b.note_id))
    .bind(i64::try_from(NOTES_PAGE + 1).unwrap_or(i64::MAX))
    .fetch_all(&mut *conn)
    .await?;
    let more = rows.len() > NOTES_PAGE;
    let notes: Vec<NoteInfo> = rows.into_iter().take(NOTES_PAGE).map(note_info).collect();
    let next = more
        .then(|| notes.last())
        .flatten()
        .map(|last| NoteCursor { updated_at: last.updated_at, note_id: last.note_id });
    Ok(NotePage { scope_id: Some(scope_id), notes, next })
}

pub async fn get(db: &PgPool, principal: &Principal, note_id: Uuid) -> Result<NoteOpened> {
    let row: Option<OpenedRow> =
        sqlx::query_as(concat!("SELECT ", note_columns!(), ", body FROM notes WHERE id = $1 AND user_id = $2"))
            .bind(note_id)
            .bind(principal.user_id)
            .fetch_optional(db)
            .await?;
    let (id, title, created_at, updated_at, rev, body) = row.ok_or(Refused(ErrorCode::NoteNotFound))?;
    Ok(NoteOpened { note: note_info((id, title, created_at, updated_at, rev)), body: Bytes(body) })
}

pub async fn create(state: &AppState, principal: &Principal, create: &NoteCreate) -> Result<NoteInfo> {
    let mut tx = state.db.begin().await?;
    // Serializes the count against the limit.
    lock_account(&mut tx, principal).await?;
    let (scope_id, version) =
        notes_scope(&mut tx, principal.user_id).await?.ok_or(Refused(ErrorCode::NotesNotSetUp))?;
    check_records(&create.title.0, &create.body.0, version)?;
    // Another account's note under this id answers like one of ours with other
    // records, so the id tells nothing about it.
    let stored: Option<(Uuid, Vec<u8>, Vec<u8>)> =
        sqlx::query_as("SELECT user_id, title, body FROM notes WHERE id = $1")
            .bind(create.note_id)
            .fetch_optional(&mut *tx)
            .await?;
    if let Some((owner, title, body)) = stored {
        if owner == principal.user_id && title == create.title.0 && body == create.body.0 {
            return Ok(load(&mut tx, create.note_id).await?);
        }
        return Err(Refused(ErrorCode::NoteExists));
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM notes WHERE user_id = $1")
        .bind(principal.user_id)
        .fetch_one(&mut *tx)
        .await?;
    if count >= NOTES_MAX {
        return Err(Refused(ErrorCode::NoteLimit));
    }
    // Another account may take the id between the check and here.
    let row: Option<NoteRow> = sqlx::query_as(concat!(
        "INSERT INTO notes (id, user_id, scope_id, title, body, rev, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 1, (extract(epoch FROM now()) * 1000)::bigint,
                 (extract(epoch FROM now()) * 1000)::bigint)
         ON CONFLICT (id) DO NOTHING RETURNING ",
        note_columns!()
    ))
    .bind(create.note_id)
    .bind(principal.user_id)
    .bind(scope_id)
    .bind(&create.title.0)
    .bind(&create.body.0)
    .fetch_optional(&mut *tx)
    .await?;
    let note = note_info(row.ok_or(Refused(ErrorCode::NoteExists))?);
    tx.commit().await?;
    publish(state, principal.user_id, &NoteUpdated { note: note.clone() }).await;
    Ok(note)
}

pub async fn update(state: &AppState, principal: &Principal, update: &NoteUpdate) -> Result<NoteInfo> {
    let mut tx = state.db.begin().await?;
    let (_, version) = notes_scope(&mut tx, principal.user_id).await?.ok_or(Refused(ErrorCode::NotesNotSetUp))?;
    check_records(&update.title.0, &update.body.0, version)?;
    let stored: Option<(Vec<u8>, Vec<u8>, i64)> =
        sqlx::query_as("SELECT title, body, rev FROM notes WHERE id = $1 AND user_id = $2 FOR UPDATE")
            .bind(update.note_id)
            .bind(principal.user_id)
            .fetch_optional(&mut *tx)
            .await?;
    let (title, body, rev) = stored.ok_or(Refused(ErrorCode::NoteNotFound))?;
    // A resend of an update that went through.
    if title == update.title.0 && body == update.body.0 {
        return Ok(load(&mut tx, update.note_id).await?);
    }
    if rev != update.rev {
        return Err(Refused(ErrorCode::NoteConflict));
    }
    let row: NoteRow = sqlx::query_as(concat!(
        "UPDATE notes SET title = $2, body = $3, rev = rev + 1,
             updated_at = greatest((extract(epoch FROM now()) * 1000)::bigint, updated_at + 1)
         WHERE id = $1 RETURNING ",
        note_columns!()
    ))
    .bind(update.note_id)
    .bind(&update.title.0)
    .bind(&update.body.0)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    let note = note_info(row);
    publish(state, principal.user_id, &NoteUpdated { note: note.clone() }).await;
    Ok(note)
}

/// Removes the note; one that is gone succeeds and sends nothing.
pub async fn delete(state: &AppState, principal: &Principal, note_id: Uuid) -> Result<()> {
    let removed = sqlx::query("DELETE FROM notes WHERE id = $1 AND user_id = $2")
        .bind(note_id)
        .bind(principal.user_id)
        .execute(&state.db)
        .await?
        .rows_affected();
    if removed > 0 {
        publish(state, principal.user_id, &NoteDeleted { note_id }).await;
    }
    Ok(())
}

async fn load(conn: &mut PgConnection, note_id: Uuid) -> sqlx::Result<NoteInfo> {
    let row: NoteRow = sqlx::query_as(concat!("SELECT ", note_columns!(), " FROM notes WHERE id = $1"))
        .bind(note_id)
        .fetch_one(conn)
        .await?;
    Ok(note_info(row))
}

async fn publish<E: chat_protocol::Event + serde::Serialize>(state: &AppState, user_id: Uuid, event: &E) {
    state.bus.publish(BusNote::event(Target::User(user_id), event)).await;
}
