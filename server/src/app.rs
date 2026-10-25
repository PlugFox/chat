//! Application state and the router.

use std::{sync::Arc, time::Duration};

use axum::Router;
use sqlx::{PgPool, postgres::PgPoolOptions};
use tokio::sync::watch;

use crate::{
    auth::{self, SharedAuth},
    config::Config,
    middleware,
    providers::ProviderHttp,
    routes,
    ws::{self, WsSettings},
};

/// Everything a handler needs; cheap to clone.
#[derive(Clone, Debug)]
pub struct AppState {
    pub config: Arc<Config>,
    pub db: PgPool,
    pub auth: SharedAuth,
    pub ws: Arc<WsSettings>,
    /// Sockets per client IP that have not authenticated yet.
    pub unauthenticated: ws::Unauthenticated,
    /// HTTP clients for provider calls, behind the address policy.
    pub providers: ProviderHttp,
    /// Changes (or closes) when the server shuts down; open sockets close with 1001.
    pub shutdown: watch::Receiver<()>,
}

impl AppState {
    pub fn new(config: Config, db: PgPool, auth: SharedAuth, shutdown: watch::Receiver<()>) -> Self {
        let providers = ProviderHttp::new(config.provider_networks.clone());
        Self {
            providers,
            config: Arc::new(config),
            db,
            auth,
            ws: Arc::new(WsSettings::default()),
            unauthenticated: ws::Unauthenticated::default(),
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
    let routes =
        Router::new().merge(routes::health::router()).merge(auth::http::router(state.clone())).merge(ws::router());
    middleware::stack(routes, &state).with_state(state)
}
