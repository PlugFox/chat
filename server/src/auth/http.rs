//! The `/auth` routes (docs/auth.md, "HTTP routes").

use std::time::Duration;

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware,
    response::{IntoResponse, Redirect, Response},
    routing::{delete, get, post, put},
};
use chat_protocol::{
    auth::{
        AccessGrant, AuditPage, EmailStart, EmailStarted, EmailVerify, Identities, Providers, SessionUpdate, Sessions,
    },
    error::ErrorCode,
    redact::Secret,
};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use super::{
    Authenticated,
    accounts::{self, LinkError, NewIdentity, PlaceError, RefreshError, Refreshed, RevokeReason, UnlinkError},
    audit::{self, Event, Kind},
    client::ClientInfo,
    email::{self, CodeError, StartError},
    extract::{ApiError, bearer, require_origin},
    google::{Finished, GoogleError},
    tokens::{Grant, RefreshToken},
};
use crate::app::AppState;

const WINDOW: Duration = Duration::from_secs(15 * 60);
const OIDC_COOKIE_SECONDS: u32 = 600;

pub(crate) fn router(state: AppState) -> Router<AppState> {
    Router::new()
        .route("/auth/providers", get(providers))
        .route("/auth/email/start", post(email_start))
        .route("/auth/email/verify", post(email_verify))
        .route("/auth/google/start", get(google_start))
        .route("/auth/google/callback", get(google_callback))
        .route("/auth/refresh", post(refresh))
        .route("/auth/sign-out", post(sign_out))
        .route("/auth/session", put(update_session))
        .route("/auth/sessions", get(list_sessions))
        .route("/auth/sessions/{id}", delete(revoke_session))
        .route("/auth/identities", get(list_identities))
        .route("/auth/identities/{id}", delete(unlink))
        .route("/auth/link/email/start", post(link_email_start))
        .route("/auth/link/email/verify", post(link_email_verify))
        .route("/auth/audit", get(audit_page))
        .route("/auth/account", delete(delete_account))
        .layer(middleware::from_fn_with_state(state, require_origin))
}

// --- cookies ---

struct Cookie {
    name: &'static str,
    same_site: &'static str,
}

const REFRESH: Cookie = Cookie { name: "chat_refresh", same_site: "Strict" };
const OIDC: Cookie = Cookie { name: "chat_oidc", same_site: "Lax" };

impl Cookie {
    /// `__Host-` needs `Secure`, which browsers refuse on plain http (local development).
    fn name(&self, state: &AppState) -> String {
        if state.config.secure_cookies() { format!("__Host-{}", self.name) } else { self.name.to_owned() }
    }

    fn set(&self, state: &AppState, value: &str, max_age: u64) -> HeaderValue {
        let secure = if state.config.secure_cookies() { "; Secure" } else { "" };
        let cookie = format!(
            "{}={value}; HttpOnly{secure}; SameSite={}; Path=/; Max-Age={max_age}",
            self.name(state),
            self.same_site
        );
        #[expect(clippy::expect_used, reason = "base64url values and fixed attributes are valid header text")]
        HeaderValue::from_str(&cookie).expect("cookie header")
    }

    fn clear(&self, state: &AppState) -> HeaderValue {
        self.set(state, "", 0)
    }

    fn read<'a>(&self, state: &AppState, headers: &'a HeaderMap) -> Option<&'a str> {
        let name = self.name(state);
        headers
            .get_all(header::COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .flat_map(|v| v.split(';'))
            .filter_map(|pair| pair.trim().split_once('='))
            .find(|(n, _)| *n == name)
            .map(|(_, v)| v)
            .filter(|v| !v.is_empty())
    }
}

fn refresh_cookie(state: &AppState, token: &RefreshToken) -> HeaderValue {
    REFRESH.set(state, token.as_str(), state.auth.idle.as_secs())
}

fn no_store(mut response: Response) -> Response {
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// The JSON answer to a sign-in or refresh, with the cookie when it changed.
fn granted(state: &AppState, grant: Grant, cookie: Option<HeaderValue>) -> Response {
    let token = state.auth.keys.jwt.issue(grant, time::OffsetDateTime::now_utc());
    let body = AccessGrant {
        access_token: Secret(token.token),
        expires_at: audit::millis(token.expires_at),
        user_id: grant.user_id,
        session_id: grant.session_id,
    };
    let mut response = no_store(Json(body).into_response());
    if let Some(cookie) = cookie {
        response.headers_mut().append(header::SET_COOKIE, cookie);
    }
    response
}

async fn limit(state: &AppState, route: &str, client: &ClientInfo, max: u32) -> Result<(), ApiError> {
    let ip = client.ip.map_or_else(|| "unknown".to_owned(), |ip| ip.to_string());
    if state.auth.store.hit(&format!("{route}:{ip}"), WINDOW, max).await? {
        Ok(())
    } else {
        Err(ApiError::rate_limited(WINDOW.as_secs()))
    }
}

fn disabled() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, ErrorCode::ProviderDisabled, "sign-in method not configured")
}

fn bad_request(code: ErrorCode, message: &str) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, code, message)
}

// --- providers and email codes ---

async fn providers(State(state): State<AppState>) -> Json<Providers> {
    Json(Providers { google: state.auth.google.is_some(), email: state.auth.mailer.is_some() })
}

/// Shared by sign-in and linking: every address gets the same answer, and
/// the mail goes out in the background so timing does not tell either.
async fn start_code(
    state: &AppState,
    client: &ClientInfo,
    body: &EmailStart,
    link_user: Option<Uuid>,
) -> Result<Response, ApiError> {
    let mailer = state.auth.mailer.clone().ok_or_else(disabled)?;
    limit(state, "email_start", client, 10).await?;
    let started = email::start(&state.db, &state.auth.keys.email_code, &body.email.0, &body.locale, link_user)
        .await
        .map_err(|e| match e {
            StartError::InvalidEmail => bad_request(ErrorCode::InvalidEmail, "not an email address"),
            StartError::TooSoon => ApiError::rate_limited(60),
            StartError::Db(e) => e.into(),
        })?;
    let owner = email::owner_of(&state.db, &started.email).await?;
    let send = link_user.is_some() || owner.is_some() || state.auth.signup.allows(&started.email);
    if send {
        tokio::spawn(async move {
            if let Err(e) = mailer.send(started.mail).await {
                tracing::warn!(error = %e, "sign-in code not sent");
            }
        });
    }
    let mut conn = state.db.acquire().await?;
    let details = json!({ "linking": link_user.is_some() });
    audit::record(&mut conn, client, Event::new(Kind::CodeSent, link_user.or(owner)).details(details)).await?;
    let response = (StatusCode::ACCEPTED, Json(EmailStarted { pending_id: started.pending_id })).into_response();
    Ok(no_store(response))
}

async fn check_code(
    state: &AppState,
    client: &ClientInfo,
    body: &EmailVerify,
    link_user: Option<Uuid>,
) -> Result<String, ApiError> {
    if state.auth.mailer.is_none() {
        return Err(disabled());
    }
    limit(state, "email_verify", client, 30).await?;
    let key = &state.auth.keys.email_code;
    match email::verify(&state.db, key, body.pending_id, &body.email.0, &body.code.0, link_user).await {
        Ok(email) => Ok(email),
        Err(CodeError::Db(e)) => Err(e.into()),
        Err(e) => {
            let (code, reason) = match e {
                CodeError::Expired => (ErrorCode::CodeExpired, "expired"),
                _ => (ErrorCode::CodeInvalid, "wrong_code"),
            };
            let owner = match email::normalize_email(&body.email.0) {
                Some(address) => email::owner_of(&state.db, &address).await?,
                None => None,
            };
            let mut conn = state.db.acquire().await?;
            let details = json!({ "provider": "email", "reason": reason });
            audit::record(&mut conn, client, Event::new(Kind::SignInFailed, link_user.or(owner)).details(details))
                .await?;
            Err(bad_request(code, "the code does not match"))
        }
    }
}

async fn email_start(
    State(state): State<AppState>,
    client: ClientInfo,
    Json(body): Json<EmailStart>,
) -> Result<Response, ApiError> {
    start_code(&state, &client, &body, None).await
}

fn place_error(e: PlaceError) -> ApiError {
    match e {
        PlaceError::SignupClosed => {
            ApiError::new(StatusCode::FORBIDDEN, ErrorCode::SignupClosed, "this address cannot create an account")
        }
        PlaceError::EmailUnverified => ApiError::new(
            StatusCode::FORBIDDEN,
            ErrorCode::EmailUnverified,
            "an unverified address that belongs to an account",
        ),
        PlaceError::Db(e) => e.into(),
    }
}

/// Places the identity, creates the session and audits it, in one transaction.
async fn sign_in(
    state: &AppState,
    client: &ClientInfo,
    identity: &NewIdentity,
) -> Result<accounts::NewSession, ApiError> {
    let mut tx = state.db.begin().await?;
    let placed = accounts::place(&mut tx, &state.auth.signup, identity).await.map_err(place_error)?;
    let session = accounts::create_session(&mut tx, placed, identity.provider, client).await?;
    accounts::audit_sign_in(&mut tx, client, placed, &session).await?;
    tx.commit().await?;
    Ok(session)
}

async fn email_verify(
    State(state): State<AppState>,
    client: ClientInfo,
    Json(body): Json<EmailVerify>,
) -> Result<Response, ApiError> {
    let address = check_code(&state, &client, &body, None).await?;
    let session = sign_in(&state, &client, &NewIdentity::email(&address)).await?;
    let cookie = refresh_cookie(&state, &session.refresh);
    Ok(granted(&state, session.grant, Some(cookie)))
}

// --- Google ---

#[derive(Deserialize)]
struct StartQuery {
    #[serde(default)]
    link: bool,
}

/// Redirects to Google. `?link=true` links to the signed-in user: the
/// refresh cookie (`SameSite=Strict`) proves it, and is not sent when another
/// site starts this navigation, so nobody can link their Google account into
/// someone else's.
async fn google_start(
    State(state): State<AppState>,
    client: ClientInfo,
    headers: HeaderMap,
    Query(query): Query<StartQuery>,
) -> Result<Response, ApiError> {
    let google = state.auth.google.as_ref().ok_or_else(disabled)?;
    limit(&state, "google_start", &client, 20).await?;
    let link_user = if query.link {
        let cookie = REFRESH.read(&state, &headers).map(RefreshToken::from_cookie);
        let session = match cookie {
            Some(token) => accounts::session_of(&state.db, &token).await?,
            None => None,
        };
        match session {
            Some((_, user_id)) => Some(user_id),
            None => return Ok(Redirect::to("/sign-in").into_response()),
        }
    } else {
        None
    };
    let (flow_id, url) = google.start(&state.db, link_user).await?;
    let mut response = no_store(Redirect::to(&url).into_response());
    response
        .headers_mut()
        .append(header::SET_COOKIE, OIDC.set(&state, &flow_id.to_string(), OIDC_COOKIE_SECONDS.into()));
    Ok(response)
}

#[derive(Deserialize)]
struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

fn redirect_with(path: &str, key: &str, value: &str, clear_oidc: HeaderValue) -> Response {
    let mut response = no_store(Redirect::to(&format!("{path}?{key}={value}")).into_response());
    response.headers_mut().append(header::SET_COOKIE, clear_oidc);
    response
}

async fn google_callback(
    State(state): State<AppState>,
    client: ClientInfo,
    headers: HeaderMap,
    Query(query): Query<CallbackQuery>,
) -> Result<Response, ApiError> {
    let google = state.auth.google.as_ref().ok_or_else(disabled)?;
    let clear = OIDC.clear(&state);
    let flow_id = OIDC.read(&state, &headers).and_then(|v| v.parse::<Uuid>().ok());
    let (Some(flow_id), Some(code), Some(flow_state)) = (flow_id, query.code, query.state) else {
        let reason = if query.error.as_deref() == Some("access_denied") { "cancelled" } else { "failed" };
        return Ok(redirect_with("/sign-in", "error", reason, clear));
    };
    let finished = match google.finish(&state.db, flow_id, &flow_state, &code).await {
        Ok(finished) => finished,
        Err(GoogleError::Db(e)) => return Err(e.into()),
        Err(e) => {
            tracing::info!(error = %e, "Google sign-in failed");
            let mut conn = state.db.acquire().await?;
            let details = json!({ "provider": "google", "reason": format!("{e:?}").to_lowercase() });
            audit::record(&mut conn, &client, Event::new(Kind::SignInFailed, None).details(details)).await?;
            let reason = if matches!(e, GoogleError::Unavailable) { "unavailable" } else { "failed" };
            return Ok(redirect_with("/sign-in", "error", reason, clear));
        }
    };
    match finished {
        Finished { identity, link_user: Some(user_id) } => {
            let outcome = link_identity(&state, &client, user_id, &identity).await?;
            Ok(redirect_with("/settings/account", "linked", outcome, clear))
        }
        Finished { identity, link_user: None } => match sign_in(&state, &client, &identity).await {
            Ok(session) => {
                let mut response = no_store(Redirect::to("/").into_response());
                response.headers_mut().append(header::SET_COOKIE, clear);
                response.headers_mut().append(header::SET_COOKIE, refresh_cookie(&state, &session.refresh));
                Ok(response)
            }
            Err(e) if matches!(e.code(), ErrorCode::SignupClosed | ErrorCode::EmailUnverified) => {
                let reason = if e.code() == ErrorCode::SignupClosed { "signup_closed" } else { "email_unverified" };
                Ok(redirect_with("/sign-in", "error", reason, clear))
            }
            Err(e) => Err(e),
        },
    }
}

/// Links and audits; returns `google`, `exists` or `in_use` for the redirect.
async fn link_identity(
    state: &AppState,
    client: &ClientInfo,
    user_id: Uuid,
    identity: &NewIdentity,
) -> Result<&'static str, ApiError> {
    let mut tx = state.db.begin().await?;
    let outcome = match accounts::link(&mut tx, user_id, identity).await {
        Ok(Some(identity_id)) => {
            let details = json!({ "identity_id": identity_id, "provider": identity.provider.as_str(), "auto": false });
            audit::record(&mut tx, client, Event::new(Kind::IdentityLinked, user_id).details(details)).await?;
            identity.provider.as_str()
        }
        Ok(None) => "exists",
        Err(LinkError::InUse) => "in_use",
        Err(LinkError::Db(e)) => return Err(e.into()),
    };
    tx.commit().await?;
    Ok(outcome)
}

// --- refresh and sessions ---

async fn refresh(State(state): State<AppState>, client: ClientInfo, headers: HeaderMap) -> Result<Response, ApiError> {
    limit(&state, "refresh", &client, 120).await?;
    let signed_out = || {
        let mut response = ApiError::new(StatusCode::UNAUTHORIZED, ErrorCode::SignedOut, "signed out").into_response();
        response.headers_mut().append(header::SET_COOKIE, REFRESH.clear(&state));
        response
    };
    let Some(cookie) = REFRESH.read(&state, &headers).map(RefreshToken::from_cookie) else {
        return Ok(signed_out());
    };
    match accounts::refresh(&state.db, &cookie, &client, state.auth.idle).await {
        Ok(Refreshed::Rotated { grant, refresh }) => Ok(granted(&state, grant, Some(refresh_cookie(&state, &refresh)))),
        Ok(Refreshed::Grace { grant }) => Ok(granted(&state, grant, None)),
        Err(RefreshError::Reused { session_id, .. }) => {
            tracing::warn!(session = %session_id, "refresh token reused; session revoked");
            state.auth.forget(&[session_id]).await?;
            Ok(signed_out())
        }
        Err(RefreshError::Invalid) => Ok(signed_out()),
        Err(RefreshError::Db(e)) => Err(e.into()),
    }
}

/// Revokes the current session: the one of the refresh cookie, or of the
/// bearer token when the cookie is gone.
async fn sign_out(State(state): State<AppState>, client: ClientInfo, headers: HeaderMap) -> Result<Response, ApiError> {
    let from_cookie = match REFRESH.read(&state, &headers).map(RefreshToken::from_cookie) {
        Some(token) => accounts::session_of(&state.db, &token).await?,
        None => None,
    };
    let session = match (from_cookie, bearer(&headers)) {
        (Some(session), _) => Some(session),
        (None, Some(token)) => state.auth.verify(token).await.ok().map(|p| (p.session_id, p.user_id)),
        (None, None) => None,
    };
    if let Some((session_id, user_id)) = session {
        let mut tx = state.db.begin().await?;
        let revoked =
            accounts::revoke_in(&mut tx, user_id, Some(&[session_id]), RevokeReason::SignOut, &client).await?;
        tx.commit().await?;
        state.auth.forget(&revoked).await?;
    }
    let mut response = no_store(StatusCode::NO_CONTENT.into_response());
    response.headers_mut().append(header::SET_COOKIE, REFRESH.clear(&state));
    Ok(response)
}

async fn update_session(
    State(state): State<AppState>,
    Authenticated(principal): Authenticated,
    client: ClientInfo,
    Json(update): Json<SessionUpdate>,
) -> Result<StatusCode, ApiError> {
    if !accounts::is_live(&state.db, principal.user_id, principal.session_id).await? {
        return Err(ApiError::unauthorized());
    }
    let mut tx = state.db.begin().await?;
    let replaced = accounts::update_session(&mut tx, &principal, &update, &client).await?;
    tx.commit().await?;
    state.auth.forget(&replaced).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_sessions(
    State(state): State<AppState>,
    Authenticated(principal): Authenticated,
) -> Result<Response, ApiError> {
    let sessions = accounts::sessions(&state.db, &principal).await?;
    Ok(no_store(Json(Sessions { sessions }).into_response()))
}

async fn revoke_session(
    State(state): State<AppState>,
    Authenticated(principal): Authenticated,
    client: ClientInfo,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    let mut tx = state.db.begin().await?;
    let revoked =
        accounts::revoke_in(&mut tx, principal.user_id, Some(&[id]), RevokeReason::RevokedByUser, &client).await?;
    tx.commit().await?;
    if revoked.is_empty() {
        return Err(ApiError::new(StatusCode::NOT_FOUND, ErrorCode::NotFound, "no such session"));
    }
    state.auth.forget(&revoked).await?;
    Ok(StatusCode::NO_CONTENT)
}

// --- identities ---

async fn list_identities(
    State(state): State<AppState>,
    Authenticated(principal): Authenticated,
) -> Result<Response, ApiError> {
    let identities = accounts::identities(&state.db, principal.user_id).await?;
    Ok(no_store(Json(Identities { identities }).into_response()))
}

async fn unlink(
    State(state): State<AppState>,
    Authenticated(principal): Authenticated,
    client: ClientInfo,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    let mut tx = state.db.begin().await?;
    let revoked = accounts::unlink(&mut tx, principal.user_id, id, &client).await.map_err(|e| match e {
        UnlinkError::NotFound => ApiError::new(StatusCode::NOT_FOUND, ErrorCode::NotFound, "no such identity"),
        UnlinkError::Last => {
            ApiError::new(StatusCode::CONFLICT, ErrorCode::IdentityLast, "the last identity cannot be unlinked")
        }
        UnlinkError::Db(e) => e.into(),
    })?;
    tx.commit().await?;
    state.auth.forget(&revoked).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn link_email_start(
    State(state): State<AppState>,
    Authenticated(principal): Authenticated,
    client: ClientInfo,
    Json(body): Json<EmailStart>,
) -> Result<Response, ApiError> {
    start_code(&state, &client, &body, Some(principal.user_id)).await
}

async fn link_email_verify(
    State(state): State<AppState>,
    Authenticated(principal): Authenticated,
    client: ClientInfo,
    Json(body): Json<EmailVerify>,
) -> Result<StatusCode, ApiError> {
    let address = check_code(&state, &client, &body, Some(principal.user_id)).await?;
    match link_identity(&state, &client, principal.user_id, &NewIdentity::email(&address)).await? {
        "in_use" => {
            Err(ApiError::new(StatusCode::CONFLICT, ErrorCode::IdentityInUse, "the address belongs to another account"))
        }
        _ => Ok(StatusCode::NO_CONTENT),
    }
}

// --- audit and deletion ---

#[derive(Deserialize)]
struct AuditQuery {
    before: Option<i64>,
    limit: Option<i64>,
}

async fn audit_page(
    State(state): State<AppState>,
    Authenticated(principal): Authenticated,
    Query(query): Query<AuditQuery>,
) -> Result<Response, ApiError> {
    let limit = query.limit.unwrap_or(50).clamp(1, 100);
    let events = audit::page(&state.db, principal.user_id, query.before, limit + 1).await?;
    let more = i64::try_from(events.len()).unwrap_or(i64::MAX) > limit;
    let events: Vec<_> = events.into_iter().take(usize::try_from(limit).unwrap_or(100)).collect();
    let next_before = if more { events.last().map(|e| e.id) } else { None };
    Ok(no_store(Json(AuditPage { events, next_before }).into_response()))
}

/// Revokes every session first (nothing is deleted if that fails), then
/// deletes the user; `ON DELETE CASCADE` removes everything else.
async fn delete_account(
    State(state): State<AppState>,
    Authenticated(principal): Authenticated,
) -> Result<Response, ApiError> {
    if !accounts::recently_signed_in(&state.db, principal.session_id).await? {
        return Err(ApiError::new(StatusCode::FORBIDDEN, ErrorCode::ReauthRequired, "sign in again first"));
    }
    let sessions = accounts::live_sessions(&state.db, principal.user_id).await?;
    state.auth.forget(&sessions).await?;
    accounts::delete_user(&state.db, principal.user_id).await?;
    tracing::info!("account deleted");
    let mut response = no_store(StatusCode::NO_CONTENT.into_response());
    response.headers_mut().append(header::SET_COOKIE, REFRESH.clear(&state));
    Ok(response)
}
