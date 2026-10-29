//! The file store: a directory, S3 or an S3-compatible service such as
//! Backblaze B2, behind `object_store` (docs/configuration.md). Objects are
//! named `files/<file id>` and are encrypted before they arrive.

use std::sync::Arc;

use bytes::Bytes;
use object_store::{
    GetResult, ObjectStore, ObjectStoreExt, PutPayload, WriteMultipart, aws::AmazonS3Builder, local::LocalFileSystem,
    memory::InMemory, path::Path,
};
use uuid::Uuid;

use crate::config::FilesConfig;

/// Bytes an upload buffers before it sends a part (S3 takes 5 MiB at least).
pub const PART: usize = 8 << 20;

#[derive(Clone, Debug)]
pub struct FileStore {
    objects: Arc<dyn ObjectStore>,
    /// Each account's objects at most, in bytes; `None` for no quota.
    pub quota: Option<i64>,
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
        Ok(Self { objects, quota })
    }

    /// A store in memory, for tests.
    pub fn memory(quota: Option<i64>) -> Self {
        Self { objects: Arc::new(InMemory::new()), quota }
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
