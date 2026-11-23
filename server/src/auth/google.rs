//! Google sign-in: authorization code flow with PKCE and a nonce; the
//! `id_token` is verified against Google's keys (docs/auth.md, "Google").

use std::{
    collections::HashSet,
    fmt,
    time::{Duration, Instant},
};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, jwk::JwkSet};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use subtle::ConstantTimeEq;
use tokio::sync::Mutex;
use uuid::Uuid;

use super::{Provider, accounts::NewIdentity, email::normalize_email, email::random_id, tokens::random};
use crate::config::GoogleConfig;

const ISSUER: &str = "https://accounts.google.com";
const FLOW_TTL_MINUTES: i32 = 10;
const JWKS_TTL: Duration = Duration::from_secs(60 * 60);
/// An unknown `kid` refetches the keys at most this often.
const JWKS_REFETCH: Duration = Duration::from_secs(60);
const LEEWAY_SECS: u64 = 30;

/// Where the provider lives; tests point it at a fake.
#[derive(Clone, Debug)]
pub struct Endpoints {
    pub issuers: Vec<String>,
    pub authorize: String,
    pub token: String,
    pub jwks: String,
}

impl Endpoints {
    pub fn google() -> Self {
        Self {
            issuers: vec![ISSUER.to_owned(), "accounts.google.com".to_owned()],
            authorize: "https://accounts.google.com/o/oauth2/v2/auth".to_owned(),
            token: "https://oauth2.googleapis.com/token".to_owned(),
            jwks: "https://www.googleapis.com/oauth2/v3/certs".to_owned(),
        }
    }
}

struct Keys {
    set: JwkSet,
    fetched: Instant,
}

pub struct Google {
    client_id: String,
    client_secret: String,
    redirect_uri: String,
    endpoints: Endpoints,
    http: reqwest::Client,
    keys: Mutex<Option<Keys>>,
}

impl fmt::Debug for Google {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Google").field("client_id", &self.client_id).finish_non_exhaustive()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum GoogleError {
    /// Unknown, expired or already used flow, or a state that does not match.
    #[error("invalid or expired sign-in flow")]
    Flow,
    #[error("Google refused the code")]
    Exchange,
    #[error("invalid id_token")]
    Token,
    #[error("Google is unreachable")]
    Unavailable,
    #[error(transparent)]
    Db(#[from] sqlx::Error),
}

#[derive(Deserialize)]
struct TokenResponse {
    id_token: String,
}

#[derive(Deserialize)]
struct IdClaims {
    sub: String,
    iat: i64,
    nonce: Option<String>,
    email: Option<String>,
    #[serde(default)]
    email_verified: bool,
}

/// What the callback learns: the identity, and the user it links to (if a link flow).
#[derive(Debug)]
pub struct Finished {
    pub identity: NewIdentity,
    pub link_user: Option<Uuid>,
}

fn secret() -> String {
    URL_SAFE_NO_PAD.encode(random::<32>())
}

impl Google {
    pub fn new(config: &GoogleConfig, public_url: &str, endpoints: Endpoints) -> Self {
        #[expect(clippy::expect_used, reason = "a client with static settings always builds")]
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(15))
            .build()
            .expect("HTTP client");
        Self {
            client_id: config.client_id.clone(),
            client_secret: config.client_secret.clone(),
            redirect_uri: format!("{public_url}/auth/google/callback"),
            endpoints,
            http,
            keys: Mutex::new(None),
        }
    }

    /// Stores a flow and returns its id (for the cookie) and Google's URL.
    pub async fn start(&self, db: &PgPool, link_user: Option<Uuid>) -> sqlx::Result<(Uuid, String)> {
        let (id, state, nonce, verifier) = (random_id(), secret(), secret(), secret());
        sqlx::query(
            "INSERT INTO oidc_flows (id, state, nonce, pkce_verifier, link_user_id, expires_at)
             VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6))",
        )
        .bind(id)
        .bind(&state)
        .bind(&nonce)
        .bind(&verifier)
        .bind(link_user)
        .bind(FLOW_TTL_MINUTES)
        .execute(db)
        .await?;
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let mut url = url::Url::parse(&self.endpoints.authorize).map_err(|e| sqlx::Error::Protocol(e.to_string()))?;
        url.query_pairs_mut()
            .append_pair("response_type", "code")
            .append_pair("client_id", &self.client_id)
            .append_pair("redirect_uri", &self.redirect_uri)
            .append_pair("scope", "openid email profile")
            .append_pair("state", &state)
            .append_pair("nonce", &nonce)
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("prompt", "select_account");
        Ok((id, url.into()))
    }

    /// Redeems the flow (once), exchanges the code and verifies the id_token.
    pub async fn finish(&self, db: &PgPool, flow_id: Uuid, state: &str, code: &str) -> Result<Finished, GoogleError> {
        let flow: Option<(String, String, Option<Uuid>)> = sqlx::query_as(
            "DELETE FROM oidc_flows WHERE id = $1 AND state = $2 AND expires_at > now()
             RETURNING nonce, pkce_verifier, link_user_id",
        )
        .bind(flow_id)
        .bind(state)
        .fetch_optional(db)
        .await?;
        let (nonce, verifier, link_user) = flow.ok_or(GoogleError::Flow)?;

        let body = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("grant_type", "authorization_code")
            .append_pair("code", code)
            .append_pair("client_id", &self.client_id)
            .append_pair("client_secret", &self.client_secret)
            .append_pair("redirect_uri", &self.redirect_uri)
            .append_pair("code_verifier", &verifier)
            .finish();
        let response = self
            .http
            .post(&self.endpoints.token)
            .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(body)
            .send()
            .await
            .map_err(|_| GoogleError::Unavailable)?;
        if !response.status().is_success() {
            return Err(GoogleError::Exchange);
        }
        let tokens: TokenResponse = response.json().await.map_err(|_| GoogleError::Exchange)?;
        let claims = self.verify(&tokens.id_token, &nonce).await?;
        let email = claims.email.as_deref().and_then(normalize_email);
        let email_verified = email.is_some() && claims.email_verified;
        Ok(Finished {
            identity: NewIdentity {
                provider: Provider::Google,
                issuer: ISSUER.to_owned(),
                subject: claims.sub,
                email,
                email_verified,
            },
            link_user,
        })
    }

    async fn verify(&self, id_token: &str, nonce: &str) -> Result<IdClaims, GoogleError> {
        let header = jsonwebtoken::decode_header(id_token).map_err(|_| GoogleError::Token)?;
        if header.alg != Algorithm::RS256 {
            return Err(GoogleError::Token);
        }
        let kid = header.kid.ok_or(GoogleError::Token)?;
        let key = self.key(&kid).await?;
        let mut validation = Validation::new(Algorithm::RS256);
        validation.leeway = LEEWAY_SECS;
        validation.set_audience(&[&self.client_id]);
        validation.iss = Some(self.endpoints.issuers.iter().cloned().collect::<HashSet<_>>());
        validation.set_required_spec_claims(&["exp", "iat", "iss", "aud", "sub"]);
        let claims =
            jsonwebtoken::decode::<IdClaims>(id_token, &key, &validation).map_err(|_| GoogleError::Token)?.claims;
        let now = time::OffsetDateTime::now_utc().unix_timestamp();
        if claims.iat > now + i64::try_from(LEEWAY_SECS).unwrap_or(0) {
            return Err(GoogleError::Token);
        }
        let matches = claims.nonce.as_deref().is_some_and(|n| bool::from(n.as_bytes().ct_eq(nonce.as_bytes())));
        if !matches {
            return Err(GoogleError::Token);
        }
        Ok(claims)
    }

    /// The key for `kid`, from a cached key set that is refetched when it is
    /// an hour old or (at most once a minute) when the kid is unknown.
    async fn key(&self, kid: &str) -> Result<DecodingKey, GoogleError> {
        let mut keys = self.keys.lock().await;
        let stale = keys.as_ref().is_none_or(|k| k.fetched.elapsed() > JWKS_TTL);
        let unknown = keys.as_ref().is_some_and(|k| k.set.find(kid).is_none() && k.fetched.elapsed() > JWKS_REFETCH);
        if stale || unknown {
            let set: JwkSet = self
                .http
                .get(&self.endpoints.jwks)
                .send()
                .await
                .and_then(reqwest::Response::error_for_status)
                .map_err(|_| GoogleError::Unavailable)?
                .json()
                .await
                .map_err(|_| GoogleError::Unavailable)?;
            *keys = Some(Keys { set, fetched: Instant::now() });
        }
        let jwk = keys.as_ref().and_then(|k| k.set.find(kid)).ok_or(GoogleError::Token)?;
        DecodingKey::from_jwk(jwk).map_err(|_| GoogleError::Token)
    }
}
