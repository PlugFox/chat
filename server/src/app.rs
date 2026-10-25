//! Application state and the router.

use std::{sync::Arc, time::Duration};

use axum::Router;
use sqlx::{PgPool, postgres::PgPoolOptions};
use tower_http::{
    request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer},
    trace::TraceLayer,
};

use crate::{config::Config, routes};

/// Everything a handler needs; cheap to clone.
#[derive(Clone, Debug)]
pub struct AppState {
    pub config: Arc<Config>,
    pub db: PgPool,
}

impl AppState {
    pub fn new(config: Config, db: PgPool) -> Self {
        Self { config: Arc::new(config), db }
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
        .layer(PropagateRequestIdLayer::x_request_id())
        .layer(TraceLayer::new_for_http())
        .layer(SetRequestIdLayer::x_request_id(MakeRequestUuid))
        .with_state(state)
}
