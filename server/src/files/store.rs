//! The file store: a directory, S3 or an S3-compatible service such as
//! Backblaze B2, behind `object_store` (docs/configuration.md). Objects are
//! named `files/<file id>` and are encrypted before they arrive.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};

use bytes::Bytes;
use futures_util::{StreamExt as _, TryStreamExt as _, stream::BoxStream};
use object_store::{
    GetResult, ObjectStore, ObjectStoreExt, PutPayload, WriteMultipart, aws::AmazonS3Builder, local::LocalFileSystem,
    memory::InMemory, path::Path,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use uuid::Uuid;

use crate::config::FilesConfig;

/// Bytes an upload buffers before it sends a part (S3 takes 5 MiB at least).
pub const PART: usize = 8 << 20;

/// Uploads running on this replica at most, and per account: an upload
/// holds its request for up to 15 minutes, outside the server's in-flight
/// limit, so a few slow ones must not stand in for every other request.
const UPLOADS: usize = 32;
const UPLOADS_PER_ACCOUNT: usize = 2;

/// How long a turn waits for room for a file before it gives up.
const ROOM_WAIT: Duration = Duration::from_secs(30);
/// What the memory budget counts: a permit is a KiB of plaintext.
const ROOM_UNIT: u32 = 1024;
/// The budget of a test store.
const TEST_MEMORY_MB: u32 = 256;

#[derive(Clone, Debug)]
pub struct FileStore {
    objects: Arc<dyn ObjectStore>,
    /// Each account's objects at most, in bytes; `None` for no quota.
    pub quota: Option<i64>,
    uploads: Arc<Mutex<HashMap<Uuid, usize>>>,
    /// The plaintext turns on this replica hold opened at once, in KiB;
    /// a turn that finds no room waits.
    room: Arc<Semaphore>,
    capacity: u32,
    room_wait: Duration,
    /// The directory of a local store, whose leftovers the sweep removes.
    dir: Option<PathBuf>,
}

/// Room for one opened file in the memory budget, given back when its last
/// holder (the turn, a description still running) lets go.
pub type Room = Arc<OwnedSemaphorePermit>;

/// The budget in its units.
fn units(memory_mb: u32) -> u32 {
    memory_mb.saturating_mul(1_000_000 / ROOM_UNIT)
}

/// A running upload's place, given back when it ends.
#[derive(Debug)]
pub struct Upload {
    uploads: Arc<Mutex<HashMap<Uuid, usize>>>,
    user_id: Uuid,
}

impl Drop for Upload {
    fn drop(&mut self) {
        let mut uploads = self.uploads.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(count) = uploads.get_mut(&self.user_id) {
            *count -= 1;
            if *count == 0 {
                uploads.remove(&self.user_id);
            }
        }
    }
}

impl FileStore {
    pub fn from_config(config: &FilesConfig, quota: Option<i64>, memory_mb: u32) -> anyhow::Result<Self> {
        let objects: Arc<dyn ObjectStore> = match config {
            FilesConfig::Directory(dir) => {
                std::fs::create_dir_all(dir)?;
                Arc::new(LocalFileSystem::new_with_prefix(dir)?.with_automatic_cleanup(true))
            }
            FilesConfig::S3 { bucket, endpoint, region, access_key_id, secret_access_key } => {
                let mut builder = AmazonS3Builder::new()
                    .with_bucket_name(bucket)
                    .with_region(region)
                    .with_access_key_id(access_key_id)
                    .with_secret_access_key(secret_access_key);
                if let Some(endpoint) = endpoint {
                    // MinIO on a private network speaks http; B2 and AWS https.
                    builder = builder.with_endpoint(endpoint).with_allow_http(endpoint.starts_with("http://"));
                }
                Arc::new(builder.build()?)
            }
        };
        let dir = match config {
            FilesConfig::Directory(dir) => Some(dir.clone()),
            FilesConfig::S3 { .. } => None,
        };
        Ok(Self::new(objects, quota, memory_mb, dir))
    }

    fn new(objects: Arc<dyn ObjectStore>, quota: Option<i64>, memory_mb: u32, dir: Option<PathBuf>) -> Self {
        let capacity = units(memory_mb);
        let room = Arc::new(Semaphore::new(usize::try_from(capacity).unwrap_or(Semaphore::MAX_PERMITS)));
        Self { objects, quota, uploads: Arc::default(), room, capacity, room_wait: ROOM_WAIT, dir }
    }

    /// The same store with a shorter wait for room, for tests.
    #[must_use]
    pub fn with_room_wait(mut self, wait: Duration) -> Self {
        self.room_wait = wait;
        self
    }

    /// A store in memory, for tests.
    pub fn memory(quota: Option<i64>) -> Self {
        Self::memory_with_room(quota, TEST_MEMORY_MB)
    }

    /// A store in memory with a memory budget of `memory_mb`, for tests.
    pub fn memory_with_room(quota: Option<i64>, memory_mb: u32) -> Self {
        Self::new(Arc::new(InMemory::new()), quota, memory_mb, None)
    }

    /// A store in a directory with the default budget, for tests of its sweep.
    pub fn directory(dir: PathBuf) -> anyhow::Result<Self> {
        Self::from_config(&FilesConfig::Directory(dir), None, TEST_MEMORY_MB)
    }

    /// Room for a file of `bytes` of plaintext in the memory budget; `None`
    /// when none frees up within a while, which the caller reports.
    pub async fn room(&self, bytes: u32) -> Option<Room> {
        // A file larger than the whole budget still goes, alone.
        let wanted = bytes.div_ceil(ROOM_UNIT).clamp(1, self.capacity.max(1));
        let permit = tokio::time::timeout(self.room_wait, self.room.clone().acquire_many_owned(wanted)).await;
        permit.ok()?.ok().map(Arc::new)
    }

    /// A place for an upload of the account, if one is free.
    pub fn upload(&self, user_id: Uuid) -> Option<Upload> {
        let mut uploads = self.uploads.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let running: usize = uploads.values().sum();
        let mine = uploads.get(&user_id).copied().unwrap_or(0);
        if running >= UPLOADS || mine >= UPLOADS_PER_ACCOUNT {
            return None;
        }
        uploads.insert(user_id, mine + 1);
        Some(Upload { uploads: self.uploads.clone(), user_id })
    }

    fn path(id: Uuid) -> Path {
        Path::from(format!("files/{}", id.as_simple()))
    }

    /// A multipart upload of the object, written as the body arrives.
    pub async fn writer(&self, id: Uuid) -> object_store::Result<WriteMultipart> {
        let upload = self.objects.put_multipart(&Self::path(id)).await?;
        Ok(WriteMultipart::new_with_chunk_size(upload, PART))
    }

    pub async fn put(&self, id: Uuid, bytes: Bytes) -> object_store::Result<()> {
        self.objects.put(&Self::path(id), PutPayload::from_bytes(bytes)).await.map(|_| ())
    }

    pub async fn get(&self, id: Uuid) -> object_store::Result<GetResult> {
        self.objects.get(&Self::path(id)).await
    }

    pub async fn read(&self, id: Uuid) -> object_store::Result<Bytes> {
        self.get(id).await?.bytes().await
    }

    /// Every object of the store with when it was last written, in no
    /// order: what the sweep checks for objects without a row.
    pub fn objects(&self) -> BoxStream<'static, object_store::Result<(Uuid, SystemTime)>> {
        self.objects
            .list(Some(&Path::from("files")))
            .try_filter_map(|meta| async move {
                let id = meta.location.filename().and_then(|name| Uuid::try_parse(name).ok());
                Ok(id.map(|id| (id, SystemTime::from(meta.last_modified))))
            })
            .boxed()
    }

    /// Removes what uploads that died with the server left in a local
    /// store's directory: `object_store` writes each upload to a staging
    /// file beside its object, which only a finished or aborted upload
    /// removes. Resolves to how many it removed.
    pub async fn remove_leftovers(&self, before: SystemTime) -> std::io::Result<u64> {
        let Some(dir) = self.dir.clone() else { return Ok(0) };
        tokio::task::spawn_blocking(move || {
            let mut removed = 0;
            let entries = match std::fs::read_dir(dir.join("files")) {
                Ok(entries) => entries,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
                Err(e) => return Err(e),
            };
            for entry in entries {
                let entry = entry?;
                let staged = entry.file_name().to_str().is_some_and(|name| name.contains('#'));
                if staged && entry.metadata()?.modified()? < before {
                    std::fs::remove_file(entry.path())?;
                    removed += 1;
                }
            }
            Ok(removed)
        })
        .await
        .map_err(std::io::Error::other)?
    }

    /// Deletes the object; one already gone counts as deleted.
    pub async fn delete(&self, id: Uuid) -> object_store::Result<()> {
        match self.objects.delete(&Self::path(id)).await {
            Ok(()) | Err(object_store::Error::NotFound { .. }) => Ok(()),
            Err(e) => Err(e),
        }
    }
}
