//! Revoked sessions and rate-limit counters (docs/auth.md, "Revocation"):
//! Redis when `CHAT_REDIS_URL` is set, otherwise process memory (one
//! instance only). Every failure is an error the caller turns into a refusal;
//! nothing here answers "not revoked" when it does not know.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, PoisonError},
    time::{Duration, Instant},
};

use futures_util::StreamExt;
use redis::aio::{ConnectionManager, ConnectionManagerConfig};
use tokio::sync::broadcast;
use uuid::Uuid;

const REVOKED_CHANNEL: &str = "chat:revoked";

#[derive(Debug, thiserror::Error)]
#[error("revocation store unavailable: {0}")]
pub struct StoreError(String);

impl From<redis::RedisError> for StoreError {
    fn from(e: redis::RedisError) -> Self {
        // The kind and category only: a Redis error can echo the command.
        Self(format!("{:?}", e.kind()))
    }
}

#[derive(Clone, Debug)]
pub enum Store {
    Memory(MemoryStore),
    Redis(RedisStore),
}

impl Store {
    pub fn memory() -> Self {
        Self::Memory(MemoryStore::default())
    }

    pub async fn redis(url: &str) -> Result<Self, StoreError> {
        RedisStore::connect(url).await.map(Self::Redis)
    }

    /// Marks a session revoked for `ttl` and tells every socket of it to close.
    pub async fn revoke(&self, session_id: Uuid, ttl: Duration) -> Result<(), StoreError> {
        match self {
            Self::Memory(m) => {
                m.revoke(session_id, ttl);
                Ok(())
            }
            Self::Redis(r) => r.revoke(session_id, ttl).await,
        }
    }

    pub async fn is_revoked(&self, session_id: Uuid) -> Result<bool, StoreError> {
        match self {
            Self::Memory(m) => Ok(m.is_revoked(session_id)),
            Self::Redis(r) => r.is_revoked(session_id).await,
        }
    }

    /// Session ids as they are revoked, on this replica and (with Redis) every other.
    pub fn subscribe(&self) -> broadcast::Receiver<Uuid> {
        match self {
            Self::Memory(m) => m.tx.subscribe(),
            Self::Redis(r) => r.tx.subscribe(),
        }
    }

    /// Counts one hit on `key` in a fixed window; `false` once `limit` is exceeded.
    pub async fn hit(&self, key: &str, window: Duration, limit: u32) -> Result<bool, StoreError> {
        match self {
            Self::Memory(m) => Ok(m.hit(key, window, limit)),
            Self::Redis(r) => r.hit(key, window, limit).await,
        }
    }
}

#[derive(Default, Debug)]
struct Memory {
    revoked: HashMap<Uuid, Instant>,
    counters: HashMap<String, (Instant, u32)>,
}

#[derive(Clone, Debug)]
pub struct MemoryStore {
    inner: Arc<Mutex<Memory>>,
    tx: broadcast::Sender<Uuid>,
}

impl Default for MemoryStore {
    fn default() -> Self {
        let (tx, _) = broadcast::channel(256);
        Self { inner: Arc::default(), tx }
    }
}

impl MemoryStore {
    fn lock(&self) -> std::sync::MutexGuard<'_, Memory> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn revoke(&self, session_id: Uuid, ttl: Duration) {
        let now = Instant::now();
        {
            let mut m = self.lock();
            m.revoked.retain(|_, until| *until > now);
            m.revoked.insert(session_id, now + ttl);
        }
        // No receivers is fine: no socket of that session is open.
        let _ = self.tx.send(session_id);
    }

    fn is_revoked(&self, session_id: Uuid) -> bool {
        self.lock().revoked.get(&session_id).is_some_and(|until| *until > Instant::now())
    }

    fn hit(&self, key: &str, window: Duration, limit: u32) -> bool {
        let now = Instant::now();
        let mut m = self.lock();
        if m.counters.len() > 10_000 {
            m.counters.retain(|_, (start, _)| now.duration_since(*start) < window);
        }
        let entry = m.counters.entry(key.to_owned()).or_insert((now, 0));
        if now.duration_since(entry.0) >= window {
            *entry = (now, 0);
        }
        entry.1 = entry.1.saturating_add(1);
        entry.1 <= limit
    }
}

#[derive(Clone)]
pub struct RedisStore {
    conn: ConnectionManager,
    tx: broadcast::Sender<Uuid>,
}

impl std::fmt::Debug for RedisStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RedisStore")
    }
}

impl RedisStore {
    async fn connect(url: &str) -> Result<Self, StoreError> {
        let client = redis::Client::open(url)?;
        // Short timeouts: an unreachable store fails requests fast (they are
        // refused, docs/auth.md) instead of holding them.
        let config = ConnectionManagerConfig::new()
            .set_connection_timeout(Some(Duration::from_secs(2)))
            .set_response_timeout(Some(Duration::from_secs(2)))
            .set_number_of_retries(2);
        let conn = ConnectionManager::new_with_config(client.clone(), config).await?;
        let (tx, _) = broadcast::channel(256);
        tokio::spawn(listen(client, tx.clone()));
        Ok(Self { conn, tx })
    }

    async fn revoke(&self, session_id: Uuid, ttl: Duration) -> Result<(), StoreError> {
        let mut conn = self.conn.clone();
        let id = session_id.to_string();
        redis::pipe()
            .atomic()
            .cmd("SET")
            .arg(format!("chat:revoked:{id}"))
            .arg(1)
            .arg("EX")
            .arg(ttl.as_secs().max(1))
            .ignore()
            .cmd("PUBLISH")
            .arg(REVOKED_CHANNEL)
            .arg(&id)
            .ignore()
            .query_async::<()>(&mut conn)
            .await?;
        // Local sockets close without waiting for the round trip through Redis.
        let _ = self.tx.send(session_id);
        Ok(())
    }

    async fn is_revoked(&self, session_id: Uuid) -> Result<bool, StoreError> {
        let mut conn = self.conn.clone();
        let exists: bool =
            redis::cmd("EXISTS").arg(format!("chat:revoked:{session_id}")).query_async(&mut conn).await?;
        Ok(exists)
    }

    async fn hit(&self, key: &str, window: Duration, limit: u32) -> Result<bool, StoreError> {
        let mut conn = self.conn.clone();
        let secs = window.as_secs().max(1);
        let slot = time::OffsetDateTime::now_utc().unix_timestamp().unsigned_abs() / secs;
        let key = format!("chat:rl:{key}:{slot}");
        let (count,): (u64,) = redis::pipe()
            .atomic()
            .cmd("INCR")
            .arg(&key)
            .cmd("EXPIRE")
            .arg(&key)
            .arg(secs)
            .ignore()
            .query_async(&mut conn)
            .await?;
        Ok(count <= u64::from(limit))
    }
}

/// Forwards revocations published by any replica to the local sockets,
/// reconnecting with a capped backoff. While disconnected, open sockets learn
/// of revocations only when their token is renewed or expires (docs/auth.md).
async fn listen(client: redis::Client, tx: broadcast::Sender<Uuid>) {
    let mut backoff = Duration::from_millis(500);
    loop {
        match client.get_async_pubsub().await {
            Ok(mut pubsub) => {
                if pubsub.subscribe(REVOKED_CHANNEL).await.is_ok() {
                    backoff = Duration::from_millis(500);
                    let mut messages = pubsub.on_message();
                    while let Some(message) = messages.next().await {
                        if let Some(id) = message.get_payload::<String>().ok().and_then(|s| s.parse().ok()) {
                            let _ = tx.send(id);
                        }
                    }
                }
                tracing::warn!("revocation subscription lost; reconnecting");
            }
            Err(e) => tracing::warn!(kind = ?e.kind(), "cannot subscribe to revocations"),
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn memory_revocations_expire_and_broadcast() {
        let store = Store::memory();
        let id = Uuid::now_v7();
        let mut rx = store.subscribe();
        store.revoke(id, Duration::from_millis(20)).await.unwrap();
        assert!(store.is_revoked(id).await.unwrap());
        assert_eq!(rx.try_recv().ok(), Some(id));
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(!store.is_revoked(id).await.unwrap());
    }

    #[tokio::test]
    async fn memory_counters_reset_per_window() {
        let store = Store::memory();
        let window = Duration::from_millis(30);
        for _ in 0..3 {
            assert!(store.hit("k", window, 3).await.unwrap());
        }
        assert!(!store.hit("k", window, 3).await.unwrap());
        assert!(store.hit("other", window, 3).await.unwrap());
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert!(store.hit("k", window, 3).await.unwrap());
    }
}
