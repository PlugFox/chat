//! Access-token verification and session revocation as the WebSocket and
//! HTTP layers see them. Issuing tokens (Google OIDC, email OTP, refresh)
//! follows the session-management reference and lands with it; until then
//! the server runs with [`NotConfigured`], which rejects every token.

use std::{
    collections::HashMap,
    fmt,
    sync::{Arc, Mutex, PoisonError},
    time::{Duration, Instant},
};

use time::OffsetDateTime;
use tokio::sync::broadcast;
use uuid::Uuid;

/// Who a valid access token belongs to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Principal {
    pub user_id: Uuid,
    pub session_id: Uuid,
    pub expires_at: OffsetDateTime,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum AuthError {
    #[error("invalid access token")]
    Invalid,
    #[error("access token expired")]
    Expired,
}

/// Verifies an access token (JWT signature, expiry). Revocation is checked
/// separately against [`Revocations`].
pub trait TokenVerifier: Send + Sync + fmt::Debug {
    fn verify(&self, token: &str) -> Result<Principal, AuthError>;
}

/// The verifier until authentication is implemented: nobody gets in.
#[derive(Debug)]
pub struct NotConfigured;

impl TokenVerifier for NotConfigured {
    fn verify(&self, _token: &str) -> Result<Principal, AuthError> {
        Err(AuthError::Invalid)
    }
}

/// Revoked session ids, kept a little longer than an access token lives, with
/// a broadcast so open sockets of a revoked session close at once. In memory;
/// Redis joins when configured (docs/brief.md §7).
#[derive(Clone, Debug)]
pub struct Revocations {
    inner: Arc<Mutex<HashMap<Uuid, Instant>>>,
    ttl: Duration,
    tx: broadcast::Sender<Uuid>,
}

impl Revocations {
    pub fn new(ttl: Duration) -> Self {
        let (tx, _) = broadcast::channel(256);
        Self { inner: Arc::default(), ttl, tx }
    }

    pub fn revoke(&self, session_id: Uuid) {
        let now = Instant::now();
        let mut set = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        set.retain(|_, until| *until > now);
        set.insert(session_id, now + self.ttl);
        // No receivers is fine: no socket of that session is open.
        let _ = self.tx.send(session_id);
    }

    pub fn is_revoked(&self, session_id: Uuid) -> bool {
        let set = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        set.get(&session_id).is_some_and(|until| *until > Instant::now())
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Uuid> {
        self.tx.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revocations_expire() {
        let r = Revocations::new(Duration::from_millis(20));
        let id = Uuid::now_v7();
        let mut rx = r.subscribe();
        r.revoke(id);
        assert!(r.is_revoked(id));
        assert_eq!(rx.try_recv().ok(), Some(id));
        std::thread::sleep(Duration::from_millis(30));
        assert!(!r.is_revoked(id));
    }
}
