//! The Redis revocation store against a real Redis or Valkey at
//! `CHAT_TEST_REDIS_URL` (`mise run db:up`, a CI service). Missing the
//! variable fails the leg: a skipped store test would look like a passing one.

#![allow(clippy::unwrap_used, clippy::expect_used, reason = "tests fail loudly")]

use std::time::Duration;

use chat_server::auth::store::Store;
use uuid::Uuid;

async fn store() -> Store {
    let url = std::env::var("CHAT_TEST_REDIS_URL").expect("CHAT_TEST_REDIS_URL (mise run db:up)");
    Store::redis(&url).await.unwrap()
}

#[tokio::test]
async fn revocations_expire() {
    let store = store().await;
    let id = Uuid::now_v7();
    assert!(!store.is_revoked(id).await.unwrap());
    store.revoke(id, Duration::from_secs(1)).await.unwrap();
    assert!(store.is_revoked(id).await.unwrap());
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert!(!store.is_revoked(id).await.unwrap());
}

#[tokio::test]
async fn revocations_reach_every_replica() {
    let (a, b) = (store().await, store().await);
    let mut on_b = b.subscribe();
    // Let b's subscription settle before publishing.
    tokio::time::sleep(Duration::from_millis(200)).await;
    let id = Uuid::now_v7();
    a.revoke(id, Duration::from_secs(60)).await.unwrap();
    let heard = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if on_b.recv().await.unwrap() == id {
                return;
            }
        }
    })
    .await;
    assert!(heard.is_ok(), "replica b did not hear the revocation");
    assert!(b.is_revoked(id).await.unwrap());
}

#[tokio::test]
async fn counters_are_shared_and_limited() {
    let (a, b) = (store().await, store().await);
    let key = format!("test:{}", Uuid::now_v7());
    let window = Duration::from_secs(60);
    assert!(a.hit(&key, window, 3).await.unwrap());
    assert!(b.hit(&key, window, 3).await.unwrap());
    assert!(a.hit(&key, window, 3).await.unwrap());
    assert!(!b.hit(&key, window, 3).await.unwrap(), "the fourth hit across replicas is refused");
}

#[tokio::test]
async fn an_unreachable_redis_fails_to_start() {
    assert!(Store::redis("redis://127.0.0.1:1").await.is_err());
}
