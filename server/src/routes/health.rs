//! `GET /health` (process is up) and `GET /ready` (database reachable), for
//! the container health check and the reverse proxy (docs/protocol.md, HTTP).

use axum::{Router, extract::State, http::StatusCode, routing::get};
use sqlx::Connection;

use crate::app::AppState;

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/health", get(health)).route("/ready", get(ready))
}

async fn health() -> &'static str {
    "ok"
}

async fn ready(State(state): State<AppState>) -> (StatusCode, &'static str) {
    let ping = async { state.db.acquire().await?.ping().await };
    match ping.await {
        Ok(()) => (StatusCode::OK, "ready"),
        Err(e) => {
            tracing::warn!(error = %e, "readiness check failed");
            (StatusCode::SERVICE_UNAVAILABLE, "database unavailable")
        }
    }
}
