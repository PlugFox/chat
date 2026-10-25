//! `/health` and `/ready` against a real database (`#[sqlx::test]` creates
//! one per test from `DATABASE_URL`).

#![allow(clippy::unwrap_used, clippy::expect_used, reason = "tests fail loudly")]

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use std::sync::Arc;

use chat_server::{app, auth::NotConfigured, config::Config};
use http_body_util::BodyExt;
use sqlx::PgPool;
use tower::ServiceExt;

fn config() -> Config {
    Config::from_lookup(|name| (name == "CHAT_DATABASE_URL").then(|| "postgres://unused".to_owned())).unwrap()
}

fn state(pool: PgPool) -> app::AppState {
    // The receiver stays open after the sender drops; health checks never watch it.
    let (_, shutdown) = tokio::sync::watch::channel(());
    app::AppState::new(config(), pool, Arc::new(NotConfigured), shutdown)
}

async fn get(pool: PgPool, path: &str) -> (StatusCode, String) {
    let router = app::router(state(pool));
    let response = router.oneshot(Request::get(path).body(Body::empty()).unwrap()).await.unwrap();
    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (status, String::from_utf8(body.to_vec()).unwrap())
}

#[sqlx::test]
async fn health_and_ready(pool: PgPool) {
    assert_eq!(get(pool.clone(), "/health").await, (StatusCode::OK, "ok".into()));
    assert_eq!(get(pool, "/ready").await, (StatusCode::OK, "ready".into()));
}

#[sqlx::test]
async fn ready_reports_a_closed_pool(pool: PgPool) {
    pool.close().await;
    assert_eq!(get(pool, "/ready").await.0, StatusCode::SERVICE_UNAVAILABLE);
}

#[sqlx::test]
async fn responses_carry_a_request_id(pool: PgPool) {
    let router = app::router(state(pool));
    let response = router.oneshot(Request::get("/health").body(Body::empty()).unwrap()).await.unwrap();
    assert!(response.headers().contains_key("x-request-id"));
}
