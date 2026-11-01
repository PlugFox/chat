//! `PUT` and `GET /files/{file_id}` (docs/protocol.md, "Files"): a file's
//! encrypted object, streamed to and from the store. Bodies are not held
//! whole: an upload is written in parts as it arrives.

use std::time::Duration;

use axum::{
    Router,
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::from_fn_with_state,
    response::{IntoResponse, Response},
    routing::put,
};
use chat_crypto::{file, ids::FileId};
use chat_protocol::error::ErrorCode;
use futures_util::{StreamExt, TryStreamExt};
use time::OffsetDateTime;
use uuid::Uuid;

use super::FileStore;
use crate::{
    app::AppState,
    auth::extract::{ApiError, Authenticated, require_origin},
};

/// How long an upload may wait for its next bytes.
const IDLE: Duration = Duration::from_secs(30);
/// How long a whole upload may take: 50 MB at about 60 KB/s.
const UPLOAD_LIMIT: Duration = Duration::from_secs(15 * 60);

pub fn router(state: AppState) -> Router<AppState> {
    Router::new()
        .route("/files/{file_id}", put(upload).get(download))
        .route_layer(from_fn_with_state(state, require_origin))
}

fn store(state: &AppState) -> Result<&FileStore, ApiError> {
    state.files.as_ref().ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, ErrorCode::FilesDisabled, "no file store"))
}

fn not_found() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, ErrorCode::FileNotFound, "no such file")
}

fn malformed(message: &str) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, ErrorCode::Malformed, message)
}

fn store_error(e: &object_store::Error) -> ApiError {
    tracing::error!(error = %e, "file store error");
    ApiError::new(StatusCode::SERVICE_UNAVAILABLE, ErrorCode::Unavailable, "file store unavailable")
}

async fn upload(
    State(state): State<AppState>,
    Authenticated(principal): Authenticated,
    Path(file_id): Path<Uuid>,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, ApiError> {
    let store = store(&state)?.clone();
    let _place = store.upload(principal.user_id).ok_or_else(|| {
        ApiError::new(StatusCode::SERVICE_UNAVAILABLE, ErrorCode::Unavailable, "too many uploads at once")
    })?;
    // Holds the row for this upload; an upload past its time limit has let go of it.
    let claimed: Option<(i32, OffsetDateTime)> = sqlx::query_as(
        "UPDATE files SET upload_started_at = clock_timestamp()
         WHERE id = $1 AND user_id = $2 AND uploaded_at IS NULL
             AND (upload_started_at IS NULL OR upload_started_at < now() - interval '20 minutes')
         RETURNING size, upload_started_at",
    )
    .bind(file_id)
    .bind(principal.user_id)
    .fetch_optional(&state.db)
    .await?;
    let Some((size, started)) = claimed else {
        let exists: Option<i32> = sqlx::query_scalar("SELECT 1 FROM files WHERE id = $1 AND user_id = $2")
            .bind(file_id)
            .bind(principal.user_id)
            .fetch_optional(&state.db)
            .await?;
        return Err(match exists {
            Some(_) => ApiError::new(StatusCode::CONFLICT, ErrorCode::FileExists, "already uploaded or uploading"),
            None => not_found(),
        });
    };
    let mut claim = Claim { db: state.db.clone(), file_id, started, held: true };
    let size = usize::try_from(size).map_err(|_| malformed("size"))?;
    let written = tokio::time::timeout(UPLOAD_LIMIT, write(&store, file_id, size, &headers, body)).await;
    if let Err(e) = written.unwrap_or_else(|_| Err(malformed("the upload took too long"))) {
        claim.release().await;
        return Err(e);
    }
    let stored = sqlx::query(
        "UPDATE files SET uploaded_at = now() WHERE id = $1 AND uploaded_at IS NULL AND upload_started_at = $2",
    )
    .bind(file_id)
    .bind(started)
    .execute(&state.db)
    .await?
    .rows_affected();
    claim.held = false;
    if stored == 0 {
        let exists: Option<i32> =
            sqlx::query_scalar("SELECT 1 FROM files WHERE id = $1").bind(file_id).fetch_optional(&state.db).await?;
        // Another upload took the row over and stored the object: it stays.
        if exists.is_some() {
            return Err(ApiError::new(StatusCode::CONFLICT, ErrorCode::FileExists, "uploaded by another request"));
        }
        // The row went while the body arrived (a sweep, a deleted account): the
        // object goes too, by the sweep, which may have looked for it too early.
        sqlx::query("INSERT INTO file_objects_gone (id) VALUES ($1) ON CONFLICT DO NOTHING")
            .bind(file_id)
            .execute(&state.db)
            .await?;
        return Err(not_found());
    }
    Ok(StatusCode::CREATED.into_response())
}

/// An upload's hold on its row, let go of when the upload fails, however it
/// fails: a client that goes away drops the handler before it can clean up.
struct Claim {
    db: sqlx::PgPool,
    file_id: Uuid,
    started: OffsetDateTime,
    held: bool,
}

impl Claim {
    const RELEASE: &str =
        "UPDATE files SET upload_started_at = NULL WHERE id = $1 AND upload_started_at = $2 AND uploaded_at IS NULL";

    /// Lets go now, so the client's next try finds the row free.
    async fn release(&mut self) {
        self.held = false;
        let released = sqlx::query(Self::RELEASE).bind(self.file_id).bind(self.started).execute(&self.db).await;
        if let Err(e) = released {
            tracing::warn!(error = %e, "cannot release a failed upload; it expires by itself");
        }
    }
}

impl Drop for Claim {
    fn drop(&mut self) {
        if !self.held {
            return;
        }
        let (db, file_id, started) = (self.db.clone(), self.file_id, self.started);
        tokio::spawn(async move {
            let released = sqlx::query(Claim::RELEASE).bind(file_id).bind(started).execute(&db).await;
            if let Err(e) = released {
                tracing::warn!(error = %e, "cannot release a failed upload; it expires by itself");
            }
        });
    }
}

/// Streams the body into the store: exactly `size` bytes, the header checked first.
async fn write(store: &FileStore, file_id: Uuid, size: usize, headers: &HeaderMap, body: Body) -> Result<(), ApiError> {
    let declared = headers.get(header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()?.parse::<usize>().ok());
    if declared.is_some_and(|n| n != size) {
        return Err(malformed("the body is not the size the file was created with"));
    }
    let mut writer = store.writer(file_id).await.map_err(|e| store_error(&e))?;
    let mut stream = body.into_data_stream();
    let mut head = Vec::with_capacity(file::HEADER_LEN);
    let mut received = 0usize;
    let failed = loop {
        let next = match tokio::time::timeout(IDLE, stream.next()).await {
            Err(_) => break Some(malformed("the upload stalled")),
            Ok(None) => break None,
            Ok(Some(Err(_))) => break Some(malformed("the upload was cut off")),
            Ok(Some(Ok(bytes))) => bytes,
        };
        received += next.len();
        if received > size {
            break Some(malformed("the body is longer than the file"));
        }
        if head.len() < file::HEADER_LEN {
            let take = (file::HEADER_LEN - head.len()).min(next.len());
            head.extend_from_slice(&next[..take]);
            if head.len() == file::HEADER_LEN
                && file::check(&head, FileId::from_bytes(*file_id.as_bytes()), size).is_err()
            {
                break Some(malformed("not an object of this file"));
            }
        }
        if let Err(e) = writer.wait_for_capacity(2).await {
            break Some(store_error(&e));
        }
        writer.write(&next);
    };
    let failed = failed.or_else(|| (received != size).then(|| malformed("the body is shorter than the file")));
    if let Some(e) = failed {
        if let Err(abort) = writer.abort().await {
            tracing::warn!(error = %abort, "cannot abort a file upload");
        }
        return Err(e);
    }
    writer.finish().await.map_err(|e| store_error(&e))?;
    Ok(())
}

async fn download(
    State(state): State<AppState>,
    Authenticated(principal): Authenticated,
    Path(file_id): Path<Uuid>,
) -> Result<Response, ApiError> {
    let store = store(&state)?;
    let size: Option<i32> = sqlx::query_scalar(
        "SELECT size FROM files WHERE id = $1 AND user_id = $2 AND uploaded_at IS NOT NULL AND object_gone_at IS NULL",
    )
    .bind(file_id)
    .bind(principal.user_id)
    .fetch_optional(&state.db)
    .await?;
    let size = size.ok_or_else(not_found)?;
    let object = match store.get(file_id).await {
        Ok(object) => object,
        Err(object_store::Error::NotFound { .. }) => return Err(not_found()),
        Err(e) => return Err(store_error(&e)),
    };
    let stream = object.into_stream().map_err(std::io::Error::other);
    let mut response = Body::from_stream(stream).into_response();
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"));
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(size));
    // An object never changes; it is ciphertext, so a private cache may keep it.
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=31536000, immutable"));
    Ok(response)
}
