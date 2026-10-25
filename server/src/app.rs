//! Application state and the router.

use std::{sync::Arc, time::Duration};

use axum::Router;
use sqlx::{PgPool, postgres::PgPoolOptions};
use tokio::sync::watch;
use tower_http::{
    request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer},
    trace::TraceLayer,
};

use crate::{
    auth::{Revocations, TokenVerifier},
    config::Config,
    routes,
    ws::{self, WsSettings},
};

/// Revoked session ids outlive the longest access token (1 hour) by a margin.
const REVOCATION_TTL: Duration = Duration::from_secs(65 * 60);

/// Everything a handler needs; cheap to clone.
#[derive(Clone, Debug)]
pub struct AppState {
    pub config: Arc<Config>,
    pub db: PgPool,
    pub verifier: Arc<dyn TokenVerifier>,
    pub revocations: Revocations,
    pub ws: Arc<WsSettings>,
    /// Changes (or closes) when the server shuts down; open sockets close with 1001.
    pub shutdown: watch::Receiver<()>,
}

impl AppState {
    pub fn new(config: Config, db: PgPool, verifier: Arc<dyn TokenVerifier>, shutdown: watch::Receiver<()>) -> Self {
        Self {
            config: Arc::new(config),
            db,
            verifier,
            revocations: Revocations::new(REVOCATION_TTL),
            ws: Arc::new(WsSettings::default()),
            shutdown,
        }
    }

    pub fn with_ws_settings(mut self, ws: WsSettings) -> Self {
        self.ws = Arc::new(ws);
        self
    }
}

pub async fn connect(config: &Config) -> Result<PgPool, sqlx::Error> {
    PgPoolOptions::new()
        .max_connections(config.database_max_connections)
        .acquire_timeout(Duration::from_secs(5))
        .connect(&config.database_url)
        .await
}

pub fn router(state: AppState) -> Router {
    // Traces method, path and status only: no headers, no bodies.
    Router::new()
        .merge(routes::health::router())
        .merge(ws::router())
        .layer(PropagateRequestIdLayer::x_request_id())
        .layer(TraceLayer::new_for_http())
        .layer(SetRequestIdLayer::x_request_id(MakeRequestUuid))
        .with_state(state)
}
