//! The WebSocket endpoint (docs/protocol.md, "Connection lifecycle").

mod connection;
mod rate;

use std::{
    collections::HashMap,
    hash::Hash,
    net::IpAddr,
    sync::{Arc, Mutex, PoisonError},
    time::Duration,
};

use axum::{
    Router,
    extract::{State, WebSocketUpgrade},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};

use uuid::Uuid;

use crate::{app::AppState, auth::client::ClientInfo};

/// Open sockets per key on this replica; every replica counts its own
/// (docs/protocol.md, "Limits").
#[derive(Debug)]
pub struct Counter<K>(Arc<Mutex<HashMap<K, u32>>>);

impl<K> Default for Counter<K> {
    fn default() -> Self {
        Self(Arc::default())
    }
}

impl<K> Clone for Counter<K> {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}

/// Sockets per client IP that have not authenticated yet.
pub type Unauthenticated = Counter<IpAddr>;
/// Authenticated sockets per account.
pub type Sockets = Counter<Uuid>;

/// Holds one place of a [`Counter`] until the socket lets go of it, either way.
#[derive(Debug)]
pub(crate) struct Slot<K: Copy + Eq + Hash> {
    counter: Counter<K>,
    key: K,
}

impl<K: Copy + Eq + Hash> Counter<K> {
    fn take(&self, key: K, max: u32) -> Option<Slot<K>> {
        let mut map = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        let count = map.entry(key).or_insert(0);
        if *count >= max {
            return None;
        }
        *count += 1;
        Some(Slot { counter: self.clone(), key })
    }
}

impl<K: Copy + Eq + Hash> Drop for Slot<K> {
    fn drop(&mut self) {
        let mut map = self.counter.0.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(count) = map.get_mut(&self.key) {
            *count -= 1;
            if *count == 0 {
                map.remove(&self.key);
            }
        }
    }
}

/// Timings and limits of the transport; tests shorten them.
#[derive(Clone, Debug)]
pub struct WsSettings {
    /// The first frame must be `auth` within this time.
    pub auth_timeout: Duration,
    /// How often clients ping; sockets silent for three intervals are closed.
    pub heartbeat: Duration,
    pub max_frame_bytes: usize,
    /// Token bucket per socket.
    pub rate_burst: u32,
    pub rate_per_second: u32,
    /// Sockets per client IP that may wait for their `auth` frame at once.
    pub unauthenticated_per_ip: u32,
    /// Authenticated sockets per account: tabs, devices and agents together.
    pub sockets_per_account: u32,
    /// How long an agent session waits for its socket to come back.
    pub agent_grace: Duration,
    /// How long a turn may run, its socket gone or not (D-088).
    pub turn_limit: Duration,
}

impl Default for WsSettings {
    fn default() -> Self {
        Self {
            auth_timeout: Duration::from_secs(5),
            heartbeat: Duration::from_secs(20),
            max_frame_bytes: 1 << 20,
            rate_burst: 50,
            rate_per_second: 10,
            unauthenticated_per_ip: 10,
            sockets_per_account: 20,
            agent_grace: Duration::from_secs(120),
            turn_limit: Duration::from_secs(600),
        }
    }
}

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/ws", get(upgrade))
}

async fn upgrade(
    State(state): State<AppState>,
    client: ClientInfo,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    // The token travels in the first frame, so a cross-site page cannot ride on
    // cookies; the Origin check still keeps other sites from opening sockets.
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok());
    if !origin.is_some_and(|o| state.config.allowed_origins.iter().any(|allowed| allowed == o)) {
        tracing::debug!(origin = origin.unwrap_or("-"), "websocket origin refused");
        return (StatusCode::FORBIDDEN, "origin not allowed").into_response();
    }
    let slot = match client.ip {
        Some(ip) => match state.unauthenticated.take(ip, state.ws.unauthenticated_per_ip) {
            Some(slot) => Some(slot),
            None => return (StatusCode::TOO_MANY_REQUESTS, "too many sockets waiting to authenticate").into_response(),
        },
        None => None,
    };
    let max = state.ws.max_frame_bytes;
    ws.max_message_size(max)
        .max_frame_size(max)
        .on_failed_upgrade(|e| tracing::debug!(error = %e, "websocket upgrade failed"))
        .on_upgrade(move |socket| connection::run(socket, state, client, slot))
}
