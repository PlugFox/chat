//! Shared test support. Each integration test file includes what it needs.
#![allow(dead_code, reason = "each test file uses a different part")]

pub mod fake_google;
pub mod fake_llm;
pub mod socket;

use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use chat_server::{
    auth::{
        AuthService, Provider,
        client::Geo,
        email::{Mail, Mailer},
        signup::SignupPolicy,
        store::Store,
        tokens::{ACCESS_TTL, Grant, ServerKeys},
    },
    config::Config,
};
use time::OffsetDateTime;
use uuid::Uuid;

pub const ORIGIN: &str = "http://localhost:3000";

pub fn config() -> Config {
    Config::from_lookup(|name| (name == "CHAT_DATABASE_URL").then(|| "postgres://unused".to_owned())).unwrap()
}

/// Fixed keys, memory store, captured mail, open sign-up, no Google.
pub fn auth() -> (AuthService, Arc<Mutex<Vec<Mail>>>) {
    let (mailer, sent) = Mailer::capture();
    let service = AuthService {
        keys: ServerKeys::derive(&[42; 32]),
        store: Store::memory(),
        geo: Geo::default(),
        mailer: Some(mailer),
        google: None,
        signup: SignupPolicy::default(),
        idle: Duration::from_secs(30 * 24 * 60 * 60),
    };
    (service, sent)
}

/// An access token for `session` that expires in `seconds` (whole seconds).
pub fn token(auth: &AuthService, user: Uuid, session: Uuid, seconds: u64) -> String {
    let grant = Grant { user_id: user, session_id: session, identity_id: Uuid::nil(), provider: Provider::Email };
    let issued = OffsetDateTime::now_utc() - ACCESS_TTL + Duration::from_secs(seconds);
    auth.keys.jwt.issue(grant, issued).token
}
