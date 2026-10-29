//! The file store: a directory, S3 or an S3-compatible service such as
//! Backblaze B2, behind `object_store` (docs/configuration.md). Objects are
//! named `files/<file id>` and are encrypted before they arrive.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use bytes::Bytes;
use object_store::{
    GetResult, ObjectStore, ObjectStoreExt, PutPayload, WriteMultipart, aws::AmazonS3Builder, local::LocalFileSystem,
    memory::InMemory, path::Path,
};
use uuid::Uuid;

use crate::config::FilesConfig;

/// Bytes an upload buffers before it sends a part (S3 takes 5 MiB at least).
pub const PART: usize = 8 << 20;

/// Uploads running on this replica at most, and per account: an upload
/// holds its request for up to 15 minutes, outside the server's in-flight
/// limit, so a few slow ones must not stand in for every other request.
const UPLOADS: usize = 32;
const UPLOADS_PER_ACCOUNT: usize = 2;

#[derive(Clone, Debug)]
pub struct FileStore {
    objects: Arc<dyn ObjectStore>,
    /// Each account's objects at most, in bytes; `None` for no quota.
    pub quota: Option<i64>,
    uploads: Arc<Mutex<HashMap<Uuid, usize>>>,
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
    pub fn from_config(config: &FilesConfig, quota: Option<i64>) -> anyhow::Result<Self> {
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
        Ok(Self { objects, quota, uploads: Arc::default() })
    }

    /// A store in memory, for tests.
    pub fn memory(quota: Option<i64>) -> Self {
        Self { objects: Arc::new(InMemory::new()), quota, uploads: Arc::default() }
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

    /// Deletes the object; one already gone counts as deleted.
    pub async fn delete(&self, id: Uuid) -> object_store::Result<()> {
        match self.objects.delete(&Self::path(id)).await {
            Ok(()) | Err(object_store::Error::NotFound { .. }) => Ok(()),
            Err(e) => Err(e),
        }
    }
}
