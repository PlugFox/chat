//! Files in chats (docs/protocol.md, "Files"; D-101): rows in PostgreSQL,
//! encrypted objects in the file store. The server never opens an object
//! but for a turn, with the content key the client gave that turn.

pub mod http;
pub mod store;

use std::{
    collections::HashSet,
    time::{Duration, SystemTime},
};

use chat_crypto::{
    file::{self, ContentKey},
    ids::{FileId, UserId},
};
use chat_protocol::{
    Bytes, Empty,
    error::ErrorCode,
    files::{
        FILE_MAX, FORGET_MAX, FileCreate, FileRecord, FileRecordList, FileUsed, KEY_RECORD_MAX, PREVIEW_RECORD_MAX,
        RECORDS_MAX, SentFile, UNATTACHED_MAX,
    },
};
use futures_util::StreamExt as _;
use sqlx::{PgConnection, PgPool};
use tokio::sync::watch;
use uuid::Uuid;

pub use self::store::FileStore;
use crate::{
    app::AppState,
    auth::Principal,
    keys::KeysError::{self, Refused},
};

type Result<T> = std::result::Result<T, KeysError>;

/// The largest object: the encryption of a [`FILE_MAX`] plaintext.
pub fn object_max() -> u32 {
    let max = usize::try_from(FILE_MAX).ok().and_then(|n| file::encrypted_len(n).ok());
    max.and_then(|n| u32::try_from(n).ok()).unwrap_or(u32::MAX)
}

/// The object length of a plaintext, if one that long can be a file.
pub fn object_len(plaintext: u32) -> Option<u32> {
    let len = file::encrypted_len(usize::try_from(plaintext).ok()?).ok()?;
    u32::try_from(len).ok()
}

fn store(state: &AppState) -> Result<&FileStore> {
    state.files.as_ref().ok_or(Refused(ErrorCode::FilesDisabled))
}

fn sealed_to(record: &[u8], max: usize, key_version: u32) -> Result<()> {
    if record.is_empty() || record.len() > max || chat_crypto::record::key_version(record).ok() != Some(key_version) {
        return Err(Refused(ErrorCode::Malformed));
    }
    Ok(())
}

/// Registers a file before its upload (`file.create`).
pub async fn create(state: &AppState, principal: &Principal, request: &FileCreate) -> Result<Empty> {
    let store = store(state)?;
    let min = object_len(0).unwrap_or(0);
    if request.size < min {
        return Err(Refused(ErrorCode::Malformed));
    }
    if request.size > object_max() {
        return Err(Refused(ErrorCode::FileTooLarge));
    }
    let mut tx = state.db.begin().await?;
    // Serializes the account's creates, so the quota and the limit hold.
    let keys: Option<i32> = sqlx::query_scalar("SELECT 1 FROM account_keys WHERE user_id = $1 FOR UPDATE")
        .bind(principal.user_id)
        .fetch_optional(&mut *tx)
        .await?;
    keys.ok_or(Refused(ErrorCode::KeysNotSetUp))?;
    let existing: Option<(Uuid, Uuid, i32)> = sqlx::query_as("SELECT user_id, chat_id, size FROM files WHERE id = $1")
        .bind(request.file_id)
        .fetch_optional(&mut *tx)
        .await?;
    if let Some((user_id, chat_id, size)) = existing {
        // A resend after a reconnect; anything else reuses an id it may not.
        let same = user_id == principal.user_id
            && chat_id == request.chat_id
            && size == i32::try_from(request.size).unwrap_or(-1);
        return if same { Ok(Empty {}) } else { Err(Refused(ErrorCode::Malformed)) };
    }
    let scope: Option<(String, Uuid)> = sqlx::query_as("SELECT kind, user_id FROM scopes WHERE id = $1")
        .bind(request.chat_id)
        .fetch_optional(&mut *tx)
        .await?;
    let key_version = match scope {
        // A new chat: its first message creates it with key version 1.
        None => 1,
        Some((kind, user_id)) if kind == "chat" && user_id == principal.user_id => {
            let version: i32 = sqlx::query_scalar("SELECT max(key_version) FROM scope_keys WHERE scope_id = $1")
                .bind(request.chat_id)
                .fetch_one(&mut *tx)
                .await?;
            u32::try_from(version).map_err(|_| Refused(ErrorCode::Internal))?
        }
        Some(_) => return Err(Refused(ErrorCode::ChatNotFound)),
    };
    sealed_to(&request.key.0, KEY_RECORD_MAX, key_version)?;
    // A preview is a copy of the image: only a kept file has one (D-107).
    if request.preview.is_some() && request.keep != Some(true) {
        return Err(Refused(ErrorCode::Malformed));
    }
    if let Some(preview) = &request.preview {
        sealed_to(&preview.0, PREVIEW_RECORD_MAX, key_version)?;
    }
    let (unattached, used): (i64, i64) = sqlx::query_as(
        "SELECT count(*) FILTER (WHERE message_id IS NULL), coalesce(sum(size) FILTER (WHERE object_gone_at IS NULL), 0)::bigint
         FROM files WHERE user_id = $1",
    )
    .bind(principal.user_id)
    .fetch_one(&mut *tx)
    .await?;
    if unattached >= UNATTACHED_MAX {
        return Err(Refused(ErrorCode::FileLimit));
    }
    if store.quota.is_some_and(|quota| used + i64::from(request.size) > quota) {
        return Err(Refused(ErrorCode::FilesQuota));
    }
    sqlx::query(
        "INSERT INTO files (id, user_id, chat_id, size, key, preview, ephemeral) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(request.file_id)
    .bind(principal.user_id)
    .bind(request.chat_id)
    .bind(i32::try_from(request.size).map_err(|_| Refused(ErrorCode::FileTooLarge))?)
    .bind(&request.key.0)
    .bind(request.preview.as_ref().map(|p| &p.0))
    .bind(request.keep != Some(true))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Empty {})
}

type RecordRow = (Uuid, i32, Vec<u8>, Option<Vec<u8>>, Option<Vec<u8>>);

/// The chat's files asked for (`file.records`); others are left out.
pub async fn records(state: &AppState, principal: &Principal, chat_id: Uuid, ids: &[Uuid]) -> Result<FileRecordList> {
    store(state)?;
    if ids.is_empty() || ids.len() > RECORDS_MAX {
        return Err(Refused(ErrorCode::Malformed));
    }
    let rows: Vec<RecordRow> = sqlx::query_as(
        "SELECT id, size, key, preview, description FROM files
         WHERE id = ANY($1) AND user_id = $2 AND chat_id = $3 ORDER BY id",
    )
    .bind(ids)
    .bind(principal.user_id)
    .bind(chat_id)
    .fetch_all(&state.db)
    .await?;
    let files = rows
        .into_iter()
        .map(|(file_id, size, key, preview, description)| FileRecord {
            file_id,
            size: u32::try_from(size).unwrap_or(0),
            key: Bytes(key),
            preview: preview.map(Bytes),
            description: description.map(Bytes),
        })
        .collect();
    Ok(FileRecordList { files })
}

/// The account's use of its quota (`file.usage`).
pub async fn usage(state: &AppState, principal: &Principal) -> Result<FileUsed> {
    let store = store(state)?;
    let used: i64 = sqlx::query_scalar(
        "SELECT coalesce(sum(size), 0)::bigint FROM files WHERE user_id = $1 AND object_gone_at IS NULL",
    )
    .bind(principal.user_id)
    .fetch_one(&state.db)
    .await?;
    Ok(FileUsed { used, quota: store.quota })
}

/// Checks a send's files before its transaction: their shape, their number
/// and what the model would read.
pub fn check_sent(state: &AppState, files: &[SentFile]) -> Result<()> {
    if files.is_empty() {
        return Ok(());
    }
    store(state)?;
    if files.len() > chat_protocol::files::FILES_PER_MESSAGE || !files.iter().all(SentFile::valid) {
        return Err(Refused(ErrorCode::Malformed));
    }
    let mut ids = HashSet::new();
    for file in files {
        if !ids.insert(file.file_id) || file.original.as_ref().is_some_and(|o| !ids.insert(o.file_id)) {
            return Err(Refused(ErrorCode::Malformed));
        }
    }
    let total: u64 = files.iter().map(|f| u64::from(f.size)).sum();
    if total > u64::from(FILE_MAX) {
        return Err(Refused(ErrorCode::FileTooLarge));
    }
    Ok(())
}

/// One file a message takes, as the send says it is.
struct Taking {
    id: Uuid,
    /// Bytes of plaintext; the object must be as long as such a plaintext's.
    size: u32,
    original: bool,
    /// An image sent with its original is kept, as the original is.
    has_original: bool,
}

/// Takes one file for the message: uploaded, of this chat and account, not
/// attached, and of the plaintext size its object has. The turn checks the
/// size again once it opens the object: padding leaves room for a little more.
async fn take(
    conn: &mut PgConnection,
    principal: &Principal,
    chat_id: Uuid,
    message_id: u32,
    file: Taking,
) -> Result<()> {
    let object = object_len(file.size).and_then(|n| i32::try_from(n).ok()).ok_or(Refused(ErrorCode::Malformed))?;
    let size = i32::try_from(file.size).map_err(|_| Refused(ErrorCode::FileTooLarge))?;
    let taken = sqlx::query(
        "UPDATE files SET message_id = $4, original = $6, plain_size = $7, attached_at = now()
         WHERE id = $1 AND user_id = $2 AND chat_id = $3 AND message_id IS NULL AND uploaded_at IS NOT NULL
             AND size = $5 AND NOT (ephemeral AND ($6 OR $8))",
    )
    .bind(file.id)
    .bind(principal.user_id)
    .bind(chat_id)
    .bind(i64::from(message_id))
    .bind(object)
    .bind(file.original)
    .bind(size)
    .bind(file.has_original)
    .execute(conn)
    .await?
    .rows_affected();
    if taken == 1 { Ok(()) } else { Err(Refused(ErrorCode::FileNotFound)) }
}

/// Attaches a send's files (and originals) to its user message, in the
/// send's transaction, after the message is inserted.
pub async fn attach(
    conn: &mut PgConnection,
    principal: &Principal,
    chat_id: Uuid,
    message_id: u32,
    files: &[SentFile],
) -> Result<()> {
    for file in files {
        let main = Taking { id: file.file_id, size: file.size, original: false, has_original: file.original.is_some() };
        take(conn, principal, chat_id, message_id, main).await?;
        if let Some(original) = &file.original {
            let taking = Taking { id: original.file_id, size: original.size, original: true, has_original: false };
            take(conn, principal, chat_id, message_id, taking).await?;
        }
    }
    Ok(())
}

/// Whether a retry gives exactly the files the model reads of the message it
/// answers, at the sizes the send gave: never an original.
pub async fn attached(conn: &mut PgConnection, chat_id: Uuid, message_id: u32, files: &[SentFile]) -> Result<()> {
    let rows: Vec<(Uuid, i32)> = sqlx::query_as(
        "SELECT id, plain_size FROM files
         WHERE chat_id = $1 AND message_id = $2 AND NOT original AND object_gone_at IS NULL ORDER BY id",
    )
    .bind(chat_id)
    .bind(i64::from(message_id))
    .fetch_all(conn)
    .await?;
    let mut given: Vec<(Uuid, i32)> = files.iter().map(|f| (f.file_id, i32::try_from(f.size).unwrap_or(-1))).collect();
    given.sort_unstable();
    if given == rows { Ok(()) } else { Err(Refused(ErrorCode::FileNotFound)) }
}

/// Deletes a message's files, as it turns into a tombstone; their objects follow.
pub async fn forget_message(conn: &mut PgConnection, chat_id: Uuid, message_id: u32) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM files WHERE chat_id = $1 AND message_id = $2")
        .bind(chat_id)
        .bind(i64::from(message_id))
        .execute(conn)
        .await?;
    Ok(())
}

/// Deletes a deleted chat's files that no message took.
pub async fn forget_chat(conn: &mut PgConnection, chat_id: Uuid) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM files WHERE chat_id = $1").bind(chat_id).execute(conn).await?;
    Ok(())
}

/// Whether the chat has attached files other than `except`: `read_file` is offered then.
pub async fn others_in_chat(db: &PgPool, chat_id: Uuid, except: &[Uuid]) -> sqlx::Result<bool> {
    sqlx::query_scalar(
        "SELECT EXISTS (
             SELECT 1 FROM files WHERE chat_id = $1 AND message_id IS NOT NULL AND NOT original AND object_gone_at IS NULL
                 AND id <> ALL($2)
         )",
    )
    .bind(chat_id)
    .bind(except)
    .fetch_one(db)
    .await
}

/// The plaintext size of a file of the chat the model may open with
/// `read_file`: attached and not an original.
pub async fn attached_size(db: &PgPool, chat_id: Uuid, file_id: Uuid) -> sqlx::Result<Option<u32>> {
    let size: Option<i32> = sqlx::query_scalar(
        "SELECT plain_size FROM files
         WHERE id = $1 AND chat_id = $2 AND message_id IS NOT NULL AND NOT original AND object_gone_at IS NULL",
    )
    .bind(file_id)
    .bind(chat_id)
    .fetch_optional(db)
    .await?;
    Ok(size.and_then(|s| u32::try_from(s).ok()))
}

/// Removes the objects of files not kept that a finished reply read (D-107),
/// keeping their rows for the descriptions. A file whose description failed
/// and has tries left waits for the sweep: a later turn can still describe it.
/// A store that fails is tried again by the sweep.
pub async fn drop_ephemeral(db: &PgPool, store: &FileStore, chat_id: Uuid, ids: &[Uuid]) -> sqlx::Result<()> {
    let dropped = sqlx::query(
        "WITH dropped AS (
             UPDATE files SET object_gone_at = now()
             WHERE id = ANY($1) AND chat_id = $2 AND ephemeral AND object_gone_at IS NULL
                 AND (description IS NOT NULL OR describe_attempts >= $3)
             RETURNING id
         )
         INSERT INTO file_objects_gone (id) SELECT id FROM dropped ON CONFLICT DO NOTHING",
    )
    .bind(ids)
    .bind(chat_id)
    .bind(DESCRIBE_TRIES)
    .execute(db)
    .await?
    .rows_affected();
    if dropped > 0 {
        delete_gone(db, store).await?;
    }
    Ok(())
}

/// Tries the model gets at describing a file, across turns and restarts.
pub const DESCRIBE_TRIES: i16 = 3;

/// Takes a try at describing a file that has no description: the try is
/// counted before it runs, so a server that dies in it has spent it.
/// Resolves to the try's number, or `None` when the file needs none or
/// has had all its tries.
pub async fn try_describe(db: &PgPool, file_id: Uuid) -> sqlx::Result<Option<i16>> {
    sqlx::query_scalar(
        "UPDATE files SET describe_attempts = describe_attempts + 1
         WHERE id = $1 AND description IS NULL AND describe_attempts < $2
         RETURNING describe_attempts",
    )
    .bind(file_id)
    .bind(DESCRIBE_TRIES)
    .fetch_optional(db)
    .await
}

/// Takes back files of the account that no message took (`file.forget`);
/// their objects go with the sweep, an upload still running included.
pub async fn forget(state: &AppState, principal: &Principal, ids: &[Uuid]) -> Result<Empty> {
    store(state)?;
    if ids.len() > FORGET_MAX {
        return Err(Refused(ErrorCode::Malformed));
    }
    sqlx::query("DELETE FROM files WHERE id = ANY($1) AND user_id = $2 AND message_id IS NULL")
        .bind(ids)
        .bind(principal.user_id)
        .execute(&state.db)
        .await?;
    Ok(Empty {})
}

/// Stores a description unless the file has one; false when it had or is gone.
pub async fn describe(db: &PgPool, file_id: Uuid, record: &[u8]) -> sqlx::Result<bool> {
    let stored = sqlx::query("UPDATE files SET description = $2 WHERE id = $1 AND description IS NULL")
        .bind(file_id)
        .bind(record)
        .execute(db)
        .await?
        .rows_affected();
    Ok(stored == 1)
}

/// Why a file a turn reads did not open.
#[derive(Debug)]
pub enum OpenError {
    /// The object is not in the store, or the store failed.
    Store,
    /// The key does not open it.
    Decrypt,
}

/// Reads a file's object and opens it with the key a turn was given, a
/// piece at a time as the store sends it, so the object is never held
/// whole beside its plaintext; it must hold exactly `size` bytes, as the
/// send said. The caller holds room for `size` in the memory budget.
pub async fn open(
    store: &FileStore,
    user_id: Uuid,
    file_id: Uuid,
    key: &[u8],
    size: u32,
) -> std::result::Result<Vec<u8>, OpenError> {
    let key = ContentKey::from_bytes(key).map_err(|_| OpenError::Decrypt)?;
    let failed = |e: object_store::Error| {
        tracing::warn!(error = %e, "cannot read a file object for a turn");
        OpenError::Store
    };
    let object = store.get(file_id).await.map_err(failed)?;
    let len = usize::try_from(object.meta.size).map_err(|_| OpenError::Decrypt)?;
    let (user, file) = (UserId::from_bytes(*user_id.as_bytes()), FileId::from_bytes(*file_id.as_bytes()));
    let mut decryptor = file::Decryptor::new(&key, user, file, len).map_err(|_| OpenError::Decrypt)?;
    let size = usize::try_from(size).map_err(|_| OpenError::Decrypt)?;
    let mut plaintext = Vec::with_capacity(size);
    let mut pieces = object.into_stream();
    while let Some(piece) = pieces.next().await {
        let opened = decryptor.push(&piece.map_err(failed)?).map_err(|_| OpenError::Decrypt)?;
        if plaintext.len() + opened.len() > size {
            return Err(OpenError::Decrypt);
        }
        plaintext.extend_from_slice(&opened);
    }
    decryptor.finish().map_err(|_| OpenError::Decrypt)?;
    if plaintext.len() != size {
        return Err(OpenError::Decrypt);
    }
    Ok(plaintext)
}

/// Files a sweep handles at once.
const SWEEP_BATCH: i64 = 100;
/// How long a file waits for a message to take it.
const UNATTACHED_HOURS: i32 = 24;
/// How long a row waits for its upload to finish: past the 15 minutes an
/// upload may take, from a client that retries.
const NOT_UPLOADED_MINUTES: i32 = 60;
/// How old a staging file of a local store is before it counts as left
/// over: past the 15 minutes an upload may take.
const LEFTOVER_AFTER: Duration = Duration::from_secs(20 * 60);
/// How old an object without a row is before it counts as an orphan: an
/// upload writes its object only after its row exists, so any is.
const ORPHAN_AFTER: Duration = Duration::from_secs(60 * 60);
const SWEEP_EVERY: Duration = Duration::from_secs(5 * 60);
/// How often the store is listed for objects without a row.
const ORPHANS_EVERY: Duration = Duration::from_secs(24 * 60 * 60);

/// What one sweep removed.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Swept {
    pub unattached: u64,
    pub not_uploaded: u64,
    pub leftovers: u64,
    pub orphans: u64,
    pub objects: u64,
    /// Files not kept whose reply never completed.
    pub expired: u64,
}

/// How long an attached file not kept may wait for its reply to complete.
const EPHEMERAL_HOURS: i32 = 1;

/// Deletes files no message took in time and rows whose upload never
/// finished, removes the staging files of uploads a dead server left, and
/// then deletes the objects whose rows are gone.
pub async fn sweep(db: &PgPool, store: &FileStore) -> sqlx::Result<Swept> {
    let unattached = sqlx::query(
        "DELETE FROM files WHERE id IN (
             SELECT id FROM files WHERE message_id IS NULL AND created_at < now() - make_interval(hours => $1) LIMIT $2)
         AND message_id IS NULL",
    )
    .bind(UNATTACHED_HOURS)
    .bind(SWEEP_BATCH)
    .execute(db)
    .await?
    .rows_affected();
    // An upload running now keeps its row: its claim is younger than any upload may take.
    let not_uploaded = sqlx::query(
        "DELETE FROM files WHERE id IN (
             SELECT id FROM files WHERE uploaded_at IS NULL AND created_at < now() - make_interval(mins => $1) LIMIT $2)
         AND uploaded_at IS NULL
         AND (upload_started_at IS NULL OR upload_started_at < now() - make_interval(mins => $1))",
    )
    .bind(NOT_UPLOADED_MINUTES)
    .bind(SWEEP_BATCH)
    .execute(db)
    .await?
    .rows_affected();
    // A reply that failed can be retried for a while; the file is not kept past that.
    let expired = sqlx::query(
        "WITH dropped AS (
             UPDATE files SET object_gone_at = now() WHERE id IN (
                 SELECT id FROM files WHERE ephemeral AND object_gone_at IS NULL AND attached_at < now() - make_interval(hours => $1) LIMIT $2)
             RETURNING id
         )
         INSERT INTO file_objects_gone (id) SELECT id FROM dropped ON CONFLICT DO NOTHING",
    )
    .bind(EPHEMERAL_HOURS)
    .bind(SWEEP_BATCH)
    .execute(db)
    .await?
    .rows_affected();
    let leftovers = store.remove_leftovers(SystemTime::now() - LEFTOVER_AFTER).await.unwrap_or_else(|e| {
        tracing::warn!(error = %e, "cannot remove the leftovers of failed uploads");
        0
    });
    let objects = delete_gone(db, store).await?;
    Ok(Swept { unattached, not_uploaded, leftovers, orphans: 0, objects, expired })
}

/// Deletes the objects whose rows are gone, a batch at a time.
async fn delete_gone(db: &PgPool, store: &FileStore) -> sqlx::Result<u64> {
    let mut objects = 0;
    loop {
        let mut tx = db.begin().await?;
        // Replicas sweeping at once take different rows.
        let gone: Vec<Uuid> =
            sqlx::query_scalar("SELECT id FROM file_objects_gone ORDER BY gone_at LIMIT $1 FOR UPDATE SKIP LOCKED")
                .bind(SWEEP_BATCH)
                .fetch_all(&mut *tx)
                .await?;
        let mut deleted = Vec::with_capacity(gone.len());
        for id in &gone {
            match store.delete(*id).await {
                Ok(()) => deleted.push(*id),
                Err(e) => tracing::warn!(error = %e, "cannot delete a file object; the next sweep tries again"),
            }
        }
        sqlx::query("DELETE FROM file_objects_gone WHERE id = ANY($1)").bind(&deleted).execute(&mut *tx).await?;
        tx.commit().await?;
        objects += u64::try_from(deleted.len()).unwrap_or(0);
        if gone.len() < usize::try_from(SWEEP_BATCH).unwrap_or(0) || deleted.len() < gone.len() {
            return Ok(objects);
        }
    }
}

/// Lists the store for objects no row names, whatever left them (a crash
/// between steps, a restored database), and deletes those written before
/// `before`, which leaves time for an upload on its way to its row.
/// Resolves to how many it deleted.
pub async fn sweep_orphans(db: &PgPool, store: &FileStore, before: SystemTime) -> sqlx::Result<u64> {
    let mut listed = store.objects();
    let mut batch = Vec::new();
    let mut found = 0;
    loop {
        let next = match listed.next().await {
            Some(Ok((id, written))) => Some((id, written)),
            Some(Err(e)) => {
                tracing::warn!(error = %e, "cannot list the file store; the next sweep tries again");
                return Ok(found);
            }
            None => None,
        };
        if let Some((id, _)) = next.filter(|(_, written)| *written < before) {
            batch.push(id);
        }
        if batch.len() >= usize::try_from(SWEEP_BATCH).unwrap_or(100) || (next.is_none() && !batch.is_empty()) {
            // Those no row names go the way of deleted files.
            found += sqlx::query(
                "INSERT INTO file_objects_gone (id)
                 SELECT id FROM unnest($1::uuid[]) AS listed (id)
                 WHERE NOT EXISTS (SELECT 1 FROM files WHERE files.id = listed.id AND files.object_gone_at IS NULL)
                 ON CONFLICT DO NOTHING",
            )
            .bind(std::mem::take(&mut batch))
            .execute(db)
            .await?
            .rows_affected();
        }
        if next.is_none() {
            break;
        }
    }
    delete_gone(db, store).await?;
    Ok(found)
}

/// Sweeps at startup, then every few minutes until shutdown, and lists the
/// store for orphans at startup and once a day.
pub async fn run(db: PgPool, store: FileStore, mut shutdown: watch::Receiver<()>) {
    let mut orphans_at = tokio::time::Instant::now();
    let mut first = true;
    loop {
        if !first {
            tokio::select! {
                () = tokio::time::sleep(SWEEP_EVERY) => {}
                _ = shutdown.changed() => return,
            }
        }
        let mut swept = match sweep(&db, &store).await {
            Ok(swept) => swept,
            Err(e) => {
                tracing::error!(error = %e, "file sweep failed");
                Swept::default()
            }
        };
        if first || orphans_at.elapsed() >= ORPHANS_EVERY {
            orphans_at = tokio::time::Instant::now();
            match sweep_orphans(&db, &store, SystemTime::now() - ORPHAN_AFTER).await {
                Ok(found) => swept.orphans = found,
                Err(e) => tracing::error!(error = %e, "file orphan sweep failed"),
            }
        }
        first = false;
        if swept != Swept::default() {
            tracing::info!(
                unattached = swept.unattached,
                not_uploaded = swept.not_uploaded,
                leftovers = swept.leftovers,
                orphans = swept.orphans,
                objects = swept.objects,
                "files swept"
            );
        }
    }
}
