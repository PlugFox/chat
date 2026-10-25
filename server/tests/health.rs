//! `/health` and `/ready` against a real database (`#[sqlx::test]` creates
//! one per test from `DATABASE_URL`).

#![allow(clippy::unwrap_used, clippy::expect_used, reason = "tests fail loudly")]

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
mod support;

use std::sync::Arc;

use chat_server::app;
use http_body_util::BodyExt;
use sqlx::PgPool;
use support::config;
use tower::ServiceExt;

fn state(pool: PgPool) -> app::AppState {
    // The receiver stays open after the sender drops; health checks never watch it.
    let (_, shutdown) = tokio::sync::watch::channel(());
    app::AppState::new(config(), pool, Arc::new(support::auth().0), shutdown)
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

#[sqlx::test]
async fn every_answer_carries_the_safety_headers(pool: PgPool) {
    let router = app::router(state(pool));
    let response = router.oneshot(Request::get("/nowhere").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let h = response.headers();
    assert_eq!(h["x-content-type-options"], "nosniff");
    assert_eq!(h["x-frame-options"], "DENY");
    assert_eq!(h["referrer-policy"], "no-referrer");
    assert_eq!(h["content-security-policy"], "default-src 'none'; frame-ancestors 'none'");
    assert_eq!(h["cache-control"], "no-store");
    assert!(h.contains_key("x-request-id"));
    assert!(h["content-type"].to_str().unwrap().starts_with("application/json"));
}
