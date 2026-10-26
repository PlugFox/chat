use std::{net::SocketAddr, sync::Arc};

use anyhow::Context;
use chat_server::{app, auth, build_info, config::Config, telemetry};
use tokio::{net::TcpListener, sync::watch};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    match std::env::args().nth(1).as_deref() {
        Some("healthcheck") => return healthcheck().await,
        Some("--version" | "-V") => {
            #[expect(clippy::print_stdout, reason = "the answer to --version")]
            {
                println!("{}", build_info::VERSION_LINE);
            }
            return Ok(());
        }
        _ => {}
    }
    let config = Config::from_env().context("configuration")?;
    telemetry::init(config.log_format);
    tracing::info!(
        version = build_info::VERSION,
        commit = build_info::GIT_COMMIT,
        listen = %config.listen,
        features = %config.features(),
        "starting"
    );

    let db = app::connect(&config).await.context("database")?;
    sqlx::migrate!("./migrations").run(&db).await.context("migrations")?;

    let auth = Arc::new(auth::AuthService::from_config(&config).await.context("authentication")?);
    let preloaded = auth.preload_revocations(&db).await.context("revoked sessions")?;
    tracing::debug!(preloaded, "revoked sessions loaded");
    let (stop, stopped) = watch::channel(());
    tokio::spawn(auth::retention::run(db.clone(), config.audit_retention_days, auth.idle, stopped.clone()));
    let state = app::AppState::new(config.clone(), db.clone(), auth, stopped.clone());
    tokio::spawn(chat_server::link::listen(db.clone(), state.links.clone(), stopped));

    let listener = TcpListener::bind(config.listen).await.with_context(|| format!("bind {}", config.listen))?;
    // Connect info gives the TCP peer, from which the client IP is derived (docs/auth.md).
    axum::serve(listener, app::router(state).into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(async move {
            shutdown().await;
            // Tells open sockets to close (1001) so the graceful shutdown can finish.
            let _ = stop.send(());
        })
        .await
        .context("server")?;
    db.close().await;
    tracing::info!("stopped");
    Ok(())
}

/// `chat-server healthcheck`: exits 0 when `/ready` answers 200 on the local
/// listener. For container health checks in images without curl.
async fn healthcheck() -> anyhow::Result<()> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listen: std::net::SocketAddr =
        std::env::var("CHAT_LISTEN").unwrap_or_else(|_| "0.0.0.0:8080".into()).parse().context("CHAT_LISTEN")?;
    let addr = std::net::SocketAddr::new(std::net::Ipv4Addr::LOCALHOST.into(), listen.port());
    let mut stream = tokio::net::TcpStream::connect(addr).await.context("connect")?;
    stream.write_all(b"GET /ready HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").await?;
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await?;
    anyhow::ensure!(response.starts_with(b"HTTP/1.1 200"), "not ready");
    Ok(())
}

/// Resolves on SIGINT or SIGTERM (docker stop).
async fn shutdown() {
    let interrupt = async {
        if let Err(e) = tokio::signal::ctrl_c().await {
            tracing::error!(error = %e, "cannot listen for Ctrl-C");
        }
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(e) => tracing::error!(error = %e, "cannot listen for SIGTERM"),
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = interrupt => {}
        () = terminate => {}
    }
    tracing::info!("shutting down");
}
