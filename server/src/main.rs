use std::sync::Arc;

use anyhow::Context;
use chat_server::{app, auth, config::Config, telemetry};
use tokio::{net::TcpListener, sync::watch};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = Config::from_env().context("configuration")?;
    telemetry::init(config.log_format);
    tracing::info!(listen = %config.listen, features = %config.features(), "starting");

    let db = app::connect(&config).await.context("database")?;
    sqlx::migrate!("./migrations").run(&db).await.context("migrations")?;

    // Sign-in is not implemented yet (docs/roadmap.md): every socket is refused.
    tracing::warn!("authentication is not configured; WebSocket clients cannot sign in");
    let verifier = Arc::new(auth::NotConfigured);
    let (stop, stopped) = watch::channel(());
    let state = app::AppState::new(config.clone(), db, verifier, stopped);

    let listener = TcpListener::bind(config.listen).await.with_context(|| format!("bind {}", config.listen))?;
    axum::serve(listener, app::router(state))
        .with_graceful_shutdown(async move {
            shutdown().await;
            // Tells open sockets to close (1001) so the graceful shutdown can finish.
            let _ = stop.send(());
        })
        .await
        .context("server")?;
    tracing::info!("stopped");
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
