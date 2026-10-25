//! The WebSocket endpoint (docs/protocol.md, "Connection lifecycle").

mod connection;
mod rate;

use std::time::Duration;

use axum::{
    Router,
    extract::{State, WebSocketUpgrade},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};

use crate::app::AppState;

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
}

impl Default for WsSettings {
    fn default() -> Self {
        Self {
            auth_timeout: Duration::from_secs(5),
            heartbeat: Duration::from_secs(20),
            max_frame_bytes: 1 << 20,
            rate_burst: 50,
            rate_per_second: 10,
        }
    }
}

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/ws", get(upgrade))
}

async fn upgrade(State(state): State<AppState>, headers: HeaderMap, ws: WebSocketUpgrade) -> Response {
    // The token travels in the first frame, so a cross-site page cannot ride on
    // cookies; the Origin check still keeps other sites from opening sockets.
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok());
    if !origin.is_some_and(|o| state.config.allowed_origins.iter().any(|allowed| allowed == o)) {
        tracing::debug!(origin = origin.unwrap_or("-"), "websocket origin refused");
        return (StatusCode::FORBIDDEN, "origin not allowed").into_response();
    }
    let max = state.ws.max_frame_bytes;
    ws.max_message_size(max)
        .max_frame_size(max)
        .on_failed_upgrade(|e| tracing::debug!(error = %e, "websocket upgrade failed"))
        .on_upgrade(move |socket| connection::run(socket, state))
}
