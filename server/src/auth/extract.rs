//! The bearer-token extractor, the origin check and HTTP errors of `/auth`.

use axum::{
    Json,
    extract::{FromRequestParts, Request},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header, request::Parts},
    middleware::Next,
    response::{IntoResponse, Response},
};
use chat_protocol::error::{ErrorCode, ErrorPayload};

use super::{AuthError, Principal, VerifyError, store::StoreError};
use crate::app::AppState;

/// An error answer: status, the WebSocket error payload, `Cache-Control: no-store`.
#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    payload: ErrorPayload,
    retry_after: Option<u64>,
}

impl ApiError {
    pub fn new(status: StatusCode, code: ErrorCode, message: &str) -> Self {
        Self { status, payload: ErrorPayload::new(code, message), retry_after: None }
    }

    pub fn rate_limited(retry_after: u64) -> Self {
        Self {
            retry_after: Some(retry_after),
            ..Self::new(StatusCode::TOO_MANY_REQUESTS, ErrorCode::RateLimited, "too many requests")
        }
    }

    pub fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, ErrorCode::InvalidToken, "invalid access token")
    }

    pub fn code(&self) -> ErrorCode {
        self.payload.code
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut response = (self.status, Json(self.payload)).into_response();
        response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        if let Some(secs) = self.retry_after {
            response.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from(secs));
        }
        response
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        // The error, not the query parameters: those can be addresses or hashes.
        tracing::error!(error = %e, "database error in /auth");
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, ErrorCode::Internal, "internal error")
    }
}

impl From<StoreError> for ApiError {
    fn from(e: StoreError) -> Self {
        tracing::error!(error = %e, "revocation store error");
        Self::new(StatusCode::SERVICE_UNAVAILABLE, ErrorCode::AuthUnavailable, "try again shortly")
    }
}

impl From<VerifyError> for ApiError {
    fn from(e: VerifyError) -> Self {
        match e {
            VerifyError::Token(AuthError::Invalid | AuthError::Expired) | VerifyError::Revoked => Self::unauthorized(),
            VerifyError::Unavailable(e) => e.into(),
        }
    }
}

/// The bearer token, verified and checked against the revocation store.
#[derive(Clone, Debug)]
pub struct Authenticated(pub Principal);

pub(crate) fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers.get(header::AUTHORIZATION)?.to_str().ok()?.strip_prefix("Bearer ").map(str::trim)
}

impl FromRequestParts<AppState> for Authenticated {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let token = bearer(&parts.headers).ok_or_else(ApiError::unauthorized)?;
        Ok(Self(state.auth.verify(token).await?))
    }
}

/// Requests that change state need an `Origin` from `CHAT_ALLOWED_ORIGINS`:
/// `SameSite=Strict` does not stop a sibling subdomain, which is the same site.
/// Top-level `GET` navigations (the Google redirects) carry no `Origin`.
pub(crate) async fn require_origin(
    axum::extract::State(state): axum::extract::State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    if matches!(*request.method(), Method::GET | Method::HEAD) {
        return next.run(request).await;
    }
    let origin = request.headers().get(header::ORIGIN).and_then(|v| v.to_str().ok());
    if !origin.is_some_and(|o| state.config.allowed_origins.iter().any(|allowed| allowed == o)) {
        return ApiError::new(StatusCode::FORBIDDEN, ErrorCode::Origin, "origin not allowed").into_response();
    }
    next.run(request).await
}
