//! Application state and the router.

use std::{sync::Arc, time::Duration};

use axum::Router;
use sqlx::{PgPool, postgres::PgPoolOptions};
use tokio::sync::watch;

use crate::{
    agent::Agents,
    auth::{self, SharedAuth},
    bus::Bus,
    chats::turn::Turns,
    config::Config,
    files::{self, FileStore},
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
    /// Authenticated sockets per account.
    pub sockets: ws::Sockets,
    /// HTTP clients for provider calls, behind the address policy.
    pub providers: ProviderHttp,
    /// `web_fetch`'s client (D-114): no operator exception to public addresses.
    pub web: ProviderHttp,
    /// Where `get_weather` asks; `None` turns the tool off (D-116).
    pub weather: Option<crate::chats::weather::WeatherApi>,
    /// Events for sockets on every replica (docs/protocol.md, "Event delivery").
    pub bus: Bus,
    /// Agent sessions of this replica's sockets.
    pub agents: Agents,
    /// Turns running on this replica.
    pub turns: Turns,
    /// Changes (or closes) when the server shuts down; open sockets close with 1001.
    pub shutdown: watch::Receiver<()>,
    /// Where file objects live; `None` turns files off (D-101).
    pub files: Option<FileStore>,
}

impl AppState {
    pub fn new(config: Config, db: PgPool, auth: SharedAuth, shutdown: watch::Receiver<()>) -> Self {
        let providers = ProviderHttp::new(config.provider_networks.clone());
        let web = ProviderHttp::new(crate::providers::AddressPolicy::default());
        let weather = config.weather.then(crate::chats::weather::WeatherApi::open_meteo);
        Self {
            providers,
            web,
            weather,
            config: Arc::new(config),
            db,
            auth,
            ws: Arc::new(WsSettings::default()),
            unauthenticated: ws::Unauthenticated::default(),
            sockets: ws::Sockets::default(),
            bus: Bus::memory(),
            agents: Agents::default(),
            turns: Turns::default(),
            shutdown,
            files: None,
        }
    }

    pub fn with_files(mut self, files: FileStore) -> Self {
        self.files = Some(files);
        self
    }

    pub fn with_bus(mut self, bus: Bus) -> Self {
        self.bus = bus;
        self
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
    state.agents.watch(state.bus.subscribe());
    let routes = Router::new()
        .merge(routes::health::router())
        .merge(auth::http::router(state.clone()))
        .merge(files::http::router(state.clone()))
        .merge(ws::router());
    middleware::stack(routes, &state).with_state(state)
}
