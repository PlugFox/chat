//! Authentication and sessions (docs/auth.md): sign-in with an email code or
//! Google, access and refresh tokens, revocation, devices, identities, the
//! audit log and account deletion.

pub mod accounts;
pub mod audit;
pub mod client;
pub mod email;
pub(crate) mod extract;
pub mod google;
pub(crate) mod http;
pub mod retention;
pub mod signup;
pub mod store;
pub mod tokens;

use std::{sync::Arc, time::Duration};

use anyhow::Context;
pub use chat_protocol::auth::Provider;
pub use extract::Authenticated;
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

use self::{
    client::Geo,
    email::Mailer,
    google::{Endpoints, Google},
    signup::SignupPolicy,
    store::Store,
    tokens::ServerKeys,
};
use crate::config::Config;

/// Revoked ids outlive the longest access token by a margin.
pub const REVOCATION_TTL: Duration = Duration::from_secs(tokens::ACCESS_TTL.as_secs() + 60);

/// Who a valid access token belongs to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Principal {
    pub user_id: Uuid,
    pub session_id: Uuid,
    pub identity_id: Uuid,
    pub provider: Provider,
    pub expires_at: OffsetDateTime,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum AuthError {
    #[error("invalid access token")]
    Invalid,
    #[error("access token expired")]
    Expired,
}

/// Why a token did not authenticate, after revocation was checked too.
#[derive(Debug, thiserror::Error)]
pub enum VerifyError {
    #[error(transparent)]
    Token(#[from] AuthError),
    #[error("session revoked")]
    Revoked,
    #[error(transparent)]
    Unavailable(#[from] store::StoreError),
}

/// Everything sign-in needs, shared by HTTP and the WebSocket.
#[derive(Debug)]
pub struct AuthService {
    pub keys: ServerKeys,
    pub store: Store,
    pub geo: Geo,
    pub mailer: Option<Mailer>,
    pub google: Option<Google>,
    pub signup: SignupPolicy,
    pub idle: Duration,
}

impl AuthService {
    /// Builds everything from the configuration; fails when a configured
    /// dependency (Redis, the country database, SMTP settings) is unusable.
    pub async fn from_config(config: &Config) -> anyhow::Result<Self> {
        let keys = match &config.server_secret {
            Some(secret) => ServerKeys::derive(secret),
            None => {
                tracing::warn!(
                    "CHAT_SERVER_SECRET is not set: using a random key, so a restart signs clients in again \
                     silently and replicas cannot share tokens"
                );
                ServerKeys::generate()
            }
        };
        let store = match &config.redis_url {
            Some(url) => Store::redis(url).await.context("CHAT_REDIS_URL")?,
            None => Store::memory(),
        };
        let geo = match &config.geoip_db {
            Some(path) => Geo::open(path).with_context(|| format!("CHAT_GEOIP_DB {}", path.display()))?,
            None => Geo::default(),
        };
        let geo = match &config.geoip_city_db {
            Some(path) => geo.with_cities(path).with_context(|| format!("CHAT_GEOIP_CITY_DB {}", path.display()))?,
            None => geo,
        };
        let mailer = config.smtp.as_ref().map(Mailer::smtp).transpose().map_err(anyhow::Error::msg)?;
        let google = config.google.as_ref().map(|g| Google::new(g, &config.public_url, Endpoints::google()));
        Ok(Self {
            keys,
            store,
            geo,
            mailer,
            google,
            signup: config.signup.clone(),
            idle: Duration::from_secs(u64::from(config.session_idle_days) * 24 * 60 * 60),
        })
    }

    /// JWT signature and claims, then the revocation store.
    pub async fn verify(&self, token: &str) -> Result<Principal, VerifyError> {
        let principal = self.keys.jwt.verify(token)?;
        if self.store.is_revoked(principal.session_id).await? {
            return Err(VerifyError::Revoked);
        }
        Ok(principal)
    }

    /// Puts sessions into the revocation store; their sockets close.
    pub async fn forget(&self, sessions: &[Uuid]) -> Result<(), store::StoreError> {
        for id in sessions {
            self.store.revoke(*id, REVOCATION_TTL).await?;
        }
        Ok(())
    }

    /// Loads sessions revoked within the last TTL into the store, so a
    /// restart (with the in-memory store) does not revive their access tokens.
    pub async fn preload_revocations(&self, db: &PgPool) -> anyhow::Result<usize> {
        let ttl = time::Duration::try_from(REVOCATION_TTL)?;
        let rows: Vec<(Uuid, OffsetDateTime)> =
            sqlx::query_as("SELECT id, revoked_at FROM sessions WHERE revoked_at > now() - $1::interval")
                .bind(format!("{} seconds", REVOCATION_TTL.as_secs()))
                .fetch_all(db)
                .await?;
        let now = OffsetDateTime::now_utc();
        for (id, revoked_at) in &rows {
            let left = (*revoked_at + ttl - now).max(time::Duration::SECOND);
            self.store.revoke(*id, Duration::try_from(left).unwrap_or(Duration::from_secs(1))).await?;
        }
        Ok(rows.len())
    }
}

pub type SharedAuth = Arc<AuthService>;
