//! The HTTP middleware every route shares, outermost first:
//!
//! 1. request id: `X-Request-ID` is kept or generated, and echoed back;
//! 2. access log: one line per request (method, route template, status,
//!    duration, client IP) inside a span carrying the request id. Paths
//!    only: query strings carry OAuth codes and states;
//! 3. response headers for API answers that set none: `nosniff`, no framing,
//!    no referrer, `default-src 'none'`, `Cache-Control: no-store`;
//! 4. error bodies: every 4xx/5xx is an [`ErrorPayload`], including axum's
//!    bare 404/405/413 and extractor rejections, so the client reads one shape;
//! 5. panic guard: a panicking handler answers 500 and the process carries on
//!    (the release profile must not set `panic = "abort"`);
//! 6. load shedding: past [`MAX_IN_FLIGHT`] requests, 503 at once instead of
//!    queueing; health checks always pass;
//! 7. deadline: the response head within [`DEADLINE`]. A WebSocket upgrade
//!    answers its head at once, so open sockets are not cut; a file upload,
//!    which answers after its body, keeps limits of its own (`files::http`).

use std::{
    net::SocketAddr,
    sync::Arc,
    time::{Duration, Instant},
};

use axum::{
    Json, Router,
    extract::{ConnectInfo, MatchedPath, Request, State},
    http::{HeaderValue, StatusCode, header},
    middleware::{Next, from_fn, from_fn_with_state},
    response::{IntoResponse, Response},
};
use chat_protocol::error::{ErrorCode, ErrorPayload};
use tokio::sync::Semaphore;
use tower::ServiceBuilder;
use tower_http::{
    catch_panic::CatchPanicLayer,
    request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer},
    set_header::SetResponseHeaderLayer,
};
use tracing::Instrument as _;

use crate::{app::AppState, auth::client::client_ip};

/// Requests handled at once; beyond it the server answers 503 right away.
const MAX_IN_FLIGHT: usize = 512;
/// Time to the response head. The slowest route is the Google callback
/// (code exchange plus key fetch, each with a 15 s timeout).
const DEADLINE: Duration = Duration::from_secs(30);
/// Largest bare error body read when reshaping it.
const ERROR_BODY_LIMIT: usize = 16 * 1024;

fn quiet(path: &str) -> bool {
    matches!(path, "/health" | "/ready")
}

pub(crate) fn stack(router: Router<AppState>, state: &AppState) -> Router<AppState> {
    let capacity = Arc::new(Semaphore::new(MAX_IN_FLIGHT));
    let header = |name, value| SetResponseHeaderLayer::if_not_present(name, HeaderValue::from_static(value));
    router.layer(
        ServiceBuilder::new()
            .layer(SetRequestIdLayer::x_request_id(MakeRequestUuid))
            .layer(PropagateRequestIdLayer::x_request_id())
            .layer(from_fn_with_state(state.clone(), access_log))
            .layer(header(header::X_CONTENT_TYPE_OPTIONS, "nosniff"))
            .layer(header(header::X_FRAME_OPTIONS, "DENY"))
            .layer(header(header::REFERRER_POLICY, "no-referrer"))
            // API answers are data, never documents that load anything.
            .layer(header(header::CONTENT_SECURITY_POLICY, "default-src 'none'; frame-ancestors 'none'"))
            .layer(header(header::CACHE_CONTROL, "no-store"))
            .layer(from_fn(reshape_errors))
            .layer(CatchPanicLayer::custom(panic_response))
            .layer(from_fn_with_state(capacity, shed_load))
            .layer(from_fn(deadline)),
    )
}

/// Logs every request once its response head is ready.
async fn access_log(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let started = Instant::now();
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    // The template, not the raw path: ids stay out of the log fields.
    let route = request.extensions().get::<MatchedPath>().map_or("unmatched", MatchedPath::as_str).to_owned();
    let id = request.headers().get("x-request-id").and_then(|v| v.to_str().ok()).unwrap_or("-").to_owned();
    let peer = request.extensions().get::<ConnectInfo<SocketAddr>>().map(|ConnectInfo(addr)| addr.ip());
    let ip = peer.map_or_else(
        || "-".to_owned(),
        |peer| client_ip(peer, request.headers(), &state.config.trusted_proxies).to_string(),
    );

    let span = tracing::info_span!("request", id = %id);
    let response = next.run(request).instrument(span.clone()).await;
    let status = response.status().as_u16();
    let ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    let _enter = span.enter();
    macro_rules! log {
        ($level:ident) => {
            tracing::$level!(%method, %route, status, ms, %ip, "request")
        };
    }
    match status {
        500.. => log!(error),
        400.. => log!(warn),
        _ if quiet(&path) => log!(debug),
        _ => log!(info),
    }
    response
}

fn error_response(status: StatusCode, code: ErrorCode, message: &str) -> Response {
    (status, Json(ErrorPayload::new(code, message))).into_response()
}

/// Bare error responses (axum's empty 404/405, its plain-text 413 and
/// extractor rejections) become an [`ErrorPayload`]; JSON ones pass as they are.
async fn reshape_errors(request: Request, next: Next) -> Response {
    let response = next.run(request).await;
    let status = response.status();
    if !(status.is_client_error() || status.is_server_error()) {
        return response;
    }
    let is_json = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("application/json"));
    if is_json {
        return response;
    }
    let (parts, body) = response.into_parts();
    let text = axum::body::to_bytes(body, ERROR_BODY_LIMIT).await.unwrap_or_default();
    let text = String::from_utf8_lossy(&text).trim().to_owned();
    let code = match status {
        StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED => ErrorCode::NotFound,
        StatusCode::FORBIDDEN => ErrorCode::Origin,
        StatusCode::TOO_MANY_REQUESTS => ErrorCode::RateLimited,
        StatusCode::SERVICE_UNAVAILABLE | StatusCode::REQUEST_TIMEOUT => ErrorCode::Unavailable,
        s if s.is_server_error() => ErrorCode::Internal,
        _ => ErrorCode::Malformed,
    };
    let message = if text.is_empty() { status.canonical_reason().unwrap_or("error").to_lowercase() } else { text };
    let mut reshaped = error_response(status, code, &message);
    // Keep what the inner layers set (Retry-After, Set-Cookie, the request id).
    for (name, value) in &parts.headers {
        if name != header::CONTENT_TYPE && name != header::CONTENT_LENGTH {
            reshaped.headers_mut().append(name, value.clone());
        }
    }
    reshaped
}

/// The 500 of a panicking handler; the message goes to the log only.
fn panic_response(panic: Box<dyn std::any::Any + Send + 'static>) -> Response {
    let message = panic
        .downcast_ref::<&str>()
        .map(|m| (*m).to_owned())
        .or_else(|| panic.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown panic payload".to_owned());
    tracing::error!(panic = %message, "request handler panicked");
    error_response(StatusCode::INTERNAL_SERVER_ERROR, ErrorCode::Internal, "internal error")
}

async fn shed_load(State(capacity): State<Arc<Semaphore>>, request: Request, next: Next) -> Response {
    if quiet(request.uri().path()) {
        return next.run(request).await;
    }
    match capacity.try_acquire_owned() {
        Ok(_permit) => next.run(request).await,
        Err(_) => {
            tracing::warn!("in-flight limit reached; shedding request");
            let mut response = error_response(StatusCode::SERVICE_UNAVAILABLE, ErrorCode::Unavailable, "server busy");
            response.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from_static("1"));
            response
        }
    }
}

async fn deadline(request: Request, next: Next) -> Response {
    if request.uri().path().starts_with("/files/") {
        return next.run(request).await;
    }
    match tokio::time::timeout(DEADLINE, next.run(request)).await {
        Ok(response) => response,
        Err(_) => {
            tracing::warn!(secs = DEADLINE.as_secs(), "request deadline elapsed");
            error_response(StatusCode::SERVICE_UNAVAILABLE, ErrorCode::Unavailable, "request took too long")
        }
    }
}

#[cfg(test)]
mod tests {
    use axum::{body::Body, routing::get};
    use http_body_util::BodyExt as _;
    use tower::ServiceExt as _;

    use super::*;

    async fn call(router: Router, path: &str) -> (StatusCode, serde_json::Value) {
        let response = router.oneshot(Request::get(path).body(Body::empty()).unwrap()).await.unwrap();
        let status = response.status();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&body).unwrap_or_default())
    }

    #[tokio::test]
    async fn bare_errors_and_panics_become_payloads() {
        #[allow(clippy::panic, reason = "the case under test")]
        async fn boom() -> &'static str {
            panic!("boom")
        }
        let router = Router::new()
            .route("/boom", get(boom))
            .route("/text", get(|| async { (StatusCode::BAD_REQUEST, "missing field `email`") }))
            .layer(ServiceBuilder::new().layer(from_fn(reshape_errors)).layer(CatchPanicLayer::custom(panic_response)));
        let (status, body) = call(router.clone(), "/boom").await;
        assert_eq!((status, body["code"].as_str()), (StatusCode::INTERNAL_SERVER_ERROR, Some("internal")));
        assert!(!body.to_string().contains("boom"), "panic messages stay in the log");
        let (status, body) = call(router.clone(), "/text").await;
        assert_eq!((status, body["code"].as_str()), (StatusCode::BAD_REQUEST, Some("protocol.malformed")));
        assert_eq!(body["message"], "missing field `email`");
        let (status, body) = call(router, "/nowhere").await;
        assert_eq!(
            (status, body["code"].as_str(), body["retry"].as_bool()),
            (StatusCode::NOT_FOUND, Some("not_found"), Some(false))
        );
    }

    #[tokio::test(start_paused = true)]
    async fn the_deadline_answers_503() {
        let router = Router::new()
            .route("/slow", get(|| async { std::future::pending::<&str>().await }))
            .layer(from_fn(deadline));
        let call = tokio::spawn(call(router, "/slow"));
        tokio::time::advance(DEADLINE + Duration::from_secs(1)).await;
        let (status, body) = call.await.unwrap();
        assert_eq!(
            (status, body["code"].as_str(), body["retry"].as_bool()),
            (StatusCode::SERVICE_UNAVAILABLE, Some("unavailable"), Some(true))
        );
    }

    #[tokio::test]
    async fn past_capacity_requests_are_shed() {
        let capacity = Arc::new(Semaphore::new(0));
        let router = Router::new()
            .route("/work", get(|| async { "done" }))
            .route("/health", get(|| async { "ok" }))
            .layer(from_fn_with_state(capacity, shed_load));
        assert_eq!(call(router.clone(), "/work").await.0, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(call(router, "/health").await.0, StatusCode::OK, "health always passes");
    }
}
