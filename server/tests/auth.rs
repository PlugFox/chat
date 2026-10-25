//! `/auth` against a real database (docs/auth.md): email codes, Google with a
//! fake provider, refresh rotation and reuse, sessions and devices, linking,
//! the audit log, deletion and retention.

#![allow(clippy::unwrap_used, clippy::expect_used, reason = "tests fail loudly")]

mod support;

use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    Router,
    body::Body,
    http::{HeaderMap, Method, Request, StatusCode, header},
};
use chat_server::{
    app::{self, AppState},
    auth::{AuthService, email::Mail, google::Google, retention, signup::SignupPolicy},
    config::{Config, GoogleConfig},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::PgPool;
use support::{
    ORIGIN,
    fake_google::{self, FakeGoogle},
};
use tower::ServiceExt;
use uuid::Uuid;

struct App {
    router: Router,
    state: AppState,
    mail: Arc<Mutex<Vec<Mail>>>,
    db: PgPool,
}

struct Resp {
    status: StatusCode,
    headers: HeaderMap,
    body: Value,
}

impl Resp {
    fn code(&self) -> &str {
        self.body["code"].as_str().unwrap_or_default()
    }

    /// The value the response sets for a cookie: `Some("")` when it clears it.
    fn cookie(&self, name: &str) -> Option<String> {
        self.headers.get_all(header::SET_COOKIE).iter().find_map(|v| {
            let v = v.to_str().unwrap();
            let (pair, _) = v.split_once(';').unwrap_or((v, ""));
            pair.strip_prefix(&format!("{name}=")).map(str::to_owned)
        })
    }

    fn location(&self) -> &str {
        self.headers.get(header::LOCATION).unwrap().to_str().unwrap()
    }
}

/// A signed-in client: the access token and the refresh cookie.
#[derive(Clone)]
struct Client {
    token: String,
    cookie: String,
    user: Uuid,
    session: Uuid,
}

impl App {
    async fn new(db: PgPool, adjust: impl FnOnce(&mut AuthService, &mut Config)) -> Self {
        let mut config = support::config();
        let (mut auth, mail) = support::auth();
        adjust(&mut auth, &mut config);
        let (_, shutdown) = tokio::sync::watch::channel(());
        let state = AppState::new(config, db.clone(), Arc::new(auth), shutdown);
        Self { router: app::router(state.clone()), state, mail, db }
    }

    async fn with_google(db: PgPool) -> (Self, FakeGoogle) {
        let fake = FakeGoogle::start().await;
        let endpoints = fake.endpoints();
        let app = Self::new(db, |auth, config| {
            let google = GoogleConfig { client_id: fake_google::CLIENT_ID.into(), client_secret: "secret".into() };
            auth.google = Some(Google::new(&google, &config.public_url, endpoints));
        })
        .await;
        (app, fake)
    }

    async fn call(&self, method: Method, path: &str, body: Option<Value>, headers: &[(&str, &str)]) -> Resp {
        let mut request = Request::builder().method(method.clone()).uri(path);
        if method != Method::GET {
            request = request.header(header::ORIGIN, ORIGIN);
        }
        for (k, v) in headers {
            request = request.header(*k, *v);
        }
        let body = match body {
            Some(json) => {
                request = request.header(header::CONTENT_TYPE, "application/json");
                Body::from(json.to_string())
            }
            None => Body::empty(),
        };
        let response = self.router.clone().oneshot(request.body(body).unwrap()).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        Resp { status, headers, body }
    }

    async fn post(&self, path: &str, body: Value) -> Resp {
        self.call(Method::POST, path, Some(body), &[]).await
    }

    async fn authed(&self, method: Method, path: &str, body: Option<Value>, client: &Client) -> Resp {
        let bearer = format!("Bearer {}", client.token);
        self.call(method, path, body, &[("authorization", &bearer)]).await
    }

    async fn refresh(&self, cookie: &str) -> Resp {
        let cookie = format!("chat_refresh={cookie}");
        self.call(Method::POST, "/auth/refresh", None, &[("cookie", &cookie)]).await
    }

    fn last_code(&self) -> String {
        let mail = self.mail.lock().unwrap();
        let subject = &mail.last().expect("a mail was sent").subject;
        subject.chars().take_while(char::is_ascii_digit).collect()
    }

    fn mails(&self) -> usize {
        self.mail.lock().unwrap().len()
    }

    async fn start_code(&self, email: &str) -> Resp {
        self.post("/auth/email/start", json!({ "email": email, "locale": "en" })).await
    }

    async fn sign_in(&self, email: &str) -> Client {
        let started = self.start_code(email).await;
        assert_eq!(started.status, StatusCode::ACCEPTED, "{}", started.body);
        // Mail goes out from a background task.
        tokio::time::sleep(Duration::from_millis(20)).await;
        let pending = started.body["pending_id"].as_str().unwrap().to_owned();
        let code = self.last_code();
        let resp =
            self.post("/auth/email/verify", json!({ "pending_id": pending, "email": email, "code": code })).await;
        assert_eq!(resp.status, StatusCode::OK, "{}", resp.body);
        client(&resp)
    }

    async fn audit_kinds(&self, user: Uuid) -> Vec<String> {
        sqlx::query_scalar("SELECT kind FROM audit_events WHERE user_id = $1 ORDER BY id")
            .bind(user)
            .fetch_all(&self.db)
            .await
            .unwrap()
    }

    async fn revoked_reason(&self, session: Uuid) -> Option<String> {
        sqlx::query_scalar("SELECT revoked_reason FROM sessions WHERE id = $1")
            .bind(session)
            .fetch_one(&self.db)
            .await
            .unwrap()
    }
}

fn client(resp: &Resp) -> Client {
    Client {
        token: resp.body["access_token"].as_str().unwrap().to_owned(),
        cookie: resp.cookie("chat_refresh").expect("refresh cookie"),
        user: resp.body["user_id"].as_str().unwrap().parse().unwrap(),
        session: resp.body["session_id"].as_str().unwrap().parse().unwrap(),
    }
}

// --- email codes ---

#[sqlx::test]
async fn email_sign_in(db: PgPool) {
    let app = App::new(db, |_, _| {}).await;
    let providers = app.call(Method::GET, "/auth/providers", None, &[]).await;
    assert_eq!(providers.body, json!({ "google": false, "email": true }));

    let c = app.sign_in("  Ann@Example.com ").await;
    let cookie_header = app.refresh(&c.cookie).await;
    assert_eq!(cookie_header.status, StatusCode::OK);
    let set = cookie_header.headers.get(header::SET_COOKIE).unwrap().to_str().unwrap();
    assert!(set.contains("HttpOnly") && set.contains("SameSite=Strict") && set.contains("Path=/"), "{set}");

    let mail = app.mail.lock().unwrap()[0].clone();
    assert_eq!(mail.to, "ann@example.com");
    assert!(!mail.body.contains("http"));

    let sessions = app.authed(Method::GET, "/auth/sessions", None, &c).await;
    assert_eq!(sessions.status, StatusCode::OK);
    assert_eq!(sessions.body["sessions"][0]["provider"], "email");
    // The first code was for an address without an account, so it is not attributed.
    assert_eq!(app.audit_kinds(c.user).await, ["account.created", "auth.signed_in"]);

    // The same address signs in to the same user.
    let again = app.sign_in("ann@example.com").await;
    assert_eq!(again.user, c.user);
    assert_ne!(again.session, c.session);
}

#[sqlx::test]
async fn every_address_gets_the_same_answer(db: PgPool) {
    let app = App::new(db, |auth, _| auth.signup = SignupPolicy::parse("*@example.com").unwrap()).await;
    let allowed = app.start_code("ann@example.com").await;
    let refused = app.start_code("bob@elsewhere.example").await;
    assert_eq!((allowed.status, refused.status), (StatusCode::ACCEPTED, StatusCode::ACCEPTED));
    assert!(refused.body["pending_id"].is_string());
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(app.mails(), 1, "no mail for an address that may not sign up");
}

#[sqlx::test]
async fn codes_are_limited(db: PgPool) {
    let app = App::new(db, |_, _| {}).await;
    let started = app.start_code("ann@example.com").await;
    let pending = started.body["pending_id"].as_str().unwrap().to_owned();
    assert_eq!(app.start_code("ann@example.com").await.status, StatusCode::TOO_MANY_REQUESTS, "resend cooldown");
    assert_eq!(app.start_code("not an address").await.code(), "auth.invalid_email");

    let verify = |code: &'static str| {
        let pending = pending.clone();
        let app = &app;
        async move {
            app.post("/auth/email/verify", json!({ "pending_id": pending, "email": "ann@example.com", "code": code }))
                .await
        }
    };
    for _ in 0..5 {
        assert_eq!(verify("00000000").await.code(), "auth.code_invalid");
    }
    assert_eq!(verify("00000000").await.code(), "auth.code_expired", "attempts used up");
    // A different pending id or address is simply unknown.
    let other = app
        .post(
            "/auth/email/verify",
            json!({ "pending_id": Uuid::now_v7(), "email": "ann@example.com", "code": "12345678" }),
        )
        .await;
    assert_eq!(other.code(), "auth.code_invalid");
}

#[sqlx::test]
async fn a_code_is_redeemed_once(db: PgPool) {
    let app = App::new(db, |_, _| {}).await;
    let started = app.start_code("ann@example.com").await;
    tokio::time::sleep(Duration::from_millis(20)).await;
    let body = json!({ "pending_id": started.body["pending_id"], "email": "ann@example.com", "code": app.last_code() });
    let (a, b) = tokio::join!(app.post("/auth/email/verify", body.clone()), app.post("/auth/email/verify", body));
    let ok = [&a, &b].iter().filter(|r| r.status == StatusCode::OK).count();
    assert_eq!(ok, 1, "{} / {}", a.body, b.body);
    let sessions: i64 = sqlx::query_scalar("SELECT count(*) FROM sessions").fetch_one(&app.db).await.unwrap();
    assert_eq!(sessions, 1);
}

#[sqlx::test]
async fn closed_sign_up_still_lets_existing_users_in(db: PgPool) {
    let open = App::new(db.clone(), |_, _| {}).await;
    open.sign_in("ann@example.com").await;
    let closed = App::new(db, |auth, _| auth.signup = SignupPolicy::parse("nobody@example.org").unwrap()).await;
    closed.sign_in("ann@example.com").await;
    let started = closed.start_code("bob@example.com").await;
    let resp = closed
        .post(
            "/auth/email/verify",
            json!({ "pending_id": started.body["pending_id"], "email": "bob@example.com", "code": "12345678" }),
        )
        .await;
    assert_eq!(resp.code(), "auth.code_invalid", "no code was mailed, so none can match");
}

// --- refresh ---

#[sqlx::test]
async fn refresh_rotates_and_detects_reuse(db: PgPool) {
    let app = App::new(db, |_, _| {}).await;
    let c = app.sign_in("ann@example.com").await;

    let first = app.refresh(&c.cookie).await;
    assert_eq!(first.status, StatusCode::OK);
    let rotated = first.cookie("chat_refresh").unwrap();
    assert_ne!(rotated, c.cookie);

    // A second tab with the old cookie, at the same moment: a token, no new cookie.
    let racing = app.refresh(&c.cookie).await;
    assert_eq!(racing.status, StatusCode::OK);
    assert_eq!(racing.cookie("chat_refresh"), None);

    // Later, the old cookie is a stolen copy: the session dies.
    sqlx::query("UPDATE sessions SET rotated_at = now() - interval '1 minute'").execute(&app.db).await.unwrap();
    let stolen = app.refresh(&c.cookie).await;
    assert_eq!((stolen.status, stolen.code()), (StatusCode::UNAUTHORIZED, "auth.signed_out"));
    assert_eq!(stolen.cookie("chat_refresh").as_deref(), Some(""), "cookie cleared");
    assert_eq!(app.revoked_reason(c.session).await.as_deref(), Some("refresh_reused"));
    assert_eq!(app.refresh(&rotated).await.status, StatusCode::UNAUTHORIZED, "the rightful cookie dies too");
    assert_eq!(app.authed(Method::GET, "/auth/sessions", None, &c).await.status, StatusCode::UNAUTHORIZED);
}

#[sqlx::test]
async fn reuse_is_caught_generations_later(db: PgPool) {
    let app = App::new(db, |_, _| {}).await;
    let c = app.sign_in("ann@example.com").await;
    let mut cookie = c.cookie.clone();
    for _ in 0..3 {
        cookie = app.refresh(&cookie).await.cookie("chat_refresh").unwrap();
    }
    assert_eq!(app.refresh(&c.cookie).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(app.revoked_reason(c.session).await.as_deref(), Some("refresh_reused"));
}

#[sqlx::test]
async fn junk_cookies_revoke_nothing(db: PgPool) {
    let app = App::new(db, |_, _| {}).await;
    let c = app.sign_in("ann@example.com").await;
    for junk in ["", "abc", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"] {
        assert_eq!(app.refresh(junk).await.status, StatusCode::UNAUTHORIZED);
    }
    assert_eq!(app.revoked_reason(c.session).await, None);
    assert_eq!(app.call(Method::POST, "/auth/refresh", None, &[]).await.code(), "auth.signed_out");
}

#[sqlx::test]
async fn refresh_needs_an_allowed_origin(db: PgPool) {
    let app = App::new(db, |_, _| {}).await;
    let c = app.sign_in("ann@example.com").await;
    let cookie = format!("chat_refresh={}", c.cookie);
    for origin in ["https://evil.example", "null"] {
        let request = Request::post("/auth/refresh")
            .header(header::ORIGIN, origin)
            .header(header::COOKIE, &cookie)
            .body(Body::empty())
            .unwrap();
        let response = app.router.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{origin}");
    }
    let request = Request::post("/auth/refresh").header(header::COOKIE, &cookie).body(Body::empty()).unwrap();
    assert_eq!(app.router.clone().oneshot(request).await.unwrap().status(), StatusCode::FORBIDDEN, "no Origin");
}

#[sqlx::test]
async fn idle_sessions_expire(db: PgPool) {
    let app = App::new(db, |_, _| {}).await;
    let c = app.sign_in("ann@example.com").await;
    sqlx::query("UPDATE sessions SET last_seen_at = now() - interval '31 days'").execute(&app.db).await.unwrap();
    assert_eq!(app.refresh(&c.cookie).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(app.revoked_reason(c.session).await.as_deref(), Some("idle"));
}

// --- sessions and devices ---

#[sqlx::test]
async fn sign_out_revokes_at_once(db: PgPool) {
    let app = App::new(db, |_, _| {}).await;
    let c = app.sign_in("ann@example.com").await;
    let cookie = format!("chat_refresh={}", c.cookie);
    let out = app.call(Method::POST, "/auth/sign-out", None, &[("cookie", &cookie)]).await;
    assert_eq!(out.status, StatusCode::NO_CONTENT);
    assert_eq!(out.cookie("chat_refresh").as_deref(), Some(""));
    assert_eq!(app.revoked_reason(c.session).await.as_deref(), Some("sign_out"));
    assert_eq!(app.authed(Method::GET, "/auth/sessions", None, &c).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(app.refresh(&c.cookie).await.status, StatusCode::UNAUTHORIZED);
    assert!(app.audit_kinds(c.user).await.contains(&"session.revoked".to_owned()));
}

#[sqlx::test]
async fn one_live_session_per_device(db: PgPool) {
    let app = App::new(db, |_, _| {}).await;
    let device = Uuid::now_v7();
    let update = json!({ "device_id": device, "timezone": "Europe/Berlin", "locale": "ru", "client_version": "1.2.3" });
    let first = app.sign_in("ann@example.com").await;
    let resp = app.authed(Method::PUT, "/auth/session", Some(update.clone()), &first).await;
    assert_eq!(resp.status, StatusCode::NO_CONTENT, "{}", resp.body);

    let sessions = app.authed(Method::GET, "/auth/sessions", None, &first).await.body;
    let s = &sessions["sessions"][0];
    assert_eq!(
        (s["device_id"].as_str(), s["timezone"].as_str(), s["current"].as_bool()),
        (Some(&*device.to_string()), Some("Europe/Berlin"), Some(true))
    );

    // Another user on the same browser profile is not affected.
    let bob = app.sign_in("bob@example.com").await;
    app.authed(Method::PUT, "/auth/session", Some(update.clone()), &bob).await;
    assert_eq!(app.revoked_reason(first.session).await, None);

    let second = app.sign_in("ann@example.com").await;
    app.authed(Method::PUT, "/auth/session", Some(update), &second).await;
    assert_eq!(app.revoked_reason(first.session).await.as_deref(), Some("device_replaced"));
    assert_eq!(app.revoked_reason(second.session).await, None);
    assert_eq!(app.authed(Method::GET, "/auth/sessions", None, &first).await.status, StatusCode::UNAUTHORIZED);
}

#[sqlx::test]
async fn unknown_timezones_are_dropped(db: PgPool) {
    let app = App::new(db, |_, _| {}).await;
    let c = app.sign_in("ann@example.com").await;
    let update = json!({ "device_id": Uuid::now_v7(), "timezone": "Mars/Olympus", "locale": "<script>" });
    assert_eq!(app.authed(Method::PUT, "/auth/session", Some(update), &c).await.status, StatusCode::NO_CONTENT);
    let s = &app.authed(Method::GET, "/auth/sessions", None, &c).await.body["sessions"][0];
    assert_eq!((s["timezone"].clone(), s["locale"].clone()), (Value::Null, Value::Null));
}

#[sqlx::test]
async fn users_revoke_only_their_own_sessions(db: PgPool) {
    let app = App::new(db, |_, _| {}).await;
    let ann = app.sign_in("ann@example.com").await;
    let ann2 = app.sign_in("ann@example.com").await;
    let bob = app.sign_in("bob@example.com").await;
    let path = format!("/auth/sessions/{}", bob.session);
    assert_eq!(app.authed(Method::DELETE, &path, None, &ann).await.status, StatusCode::NOT_FOUND);
    let path = format!("/auth/sessions/{}", ann2.session);
    assert_eq!(app.authed(Method::DELETE, &path, None, &ann).await.status, StatusCode::NO_CONTENT);
    assert_eq!(app.revoked_reason(ann2.session).await.as_deref(), Some("revoked_by_user"));
    assert!(app.state.auth.store.is_revoked(ann2.session).await.unwrap());
}

// --- identities and linking ---

#[sqlx::test]
async fn link_and_unlink_email(db: PgPool) {
    let app = App::new(db, |_, _| {}).await;
    let c = app.sign_in("ann@example.com").await;
    app.sign_in("bob@example.com").await;

    let start = app
        .authed(
            Method::POST,
            "/auth/link/email/start",
            Some(json!({ "email": "ann@work.example", "locale": "en" })),
            &c,
        )
        .await;
    assert_eq!(start.status, StatusCode::ACCEPTED);
    tokio::time::sleep(Duration::from_millis(20)).await;
    let body = json!({ "pending_id": start.body["pending_id"], "email": "ann@work.example", "code": app.last_code() });
    // A link code cannot sign in.
    assert_eq!(app.post("/auth/email/verify", body.clone()).await.code(), "auth.code_invalid");
    assert_eq!(
        app.authed(Method::POST, "/auth/link/email/verify", Some(body), &c).await.status,
        StatusCode::NO_CONTENT
    );

    let identities = app.authed(Method::GET, "/auth/identities", None, &c).await.body["identities"].clone();
    assert_eq!(identities.as_array().unwrap().len(), 2);
    let work = app.sign_in("ann@work.example").await;
    assert_eq!(work.user, c.user, "the linked address signs in to the same account");

    // Bob's address belongs to another account.
    let start = app
        .authed(Method::POST, "/auth/link/email/start", Some(json!({ "email": "bob@example.com", "locale": "en" })), &c)
        .await;
    tokio::time::sleep(Duration::from_millis(20)).await;
    let body = json!({ "pending_id": start.body["pending_id"], "email": "bob@example.com", "code": app.last_code() });
    assert_eq!(app.authed(Method::POST, "/auth/link/email/verify", Some(body), &c).await.code(), "identity.in_use");

    // Unlinking the work address ends the session that used it.
    let work_id = identities[1]["id"].as_str().unwrap();
    let resp = app.authed(Method::DELETE, &format!("/auth/identities/{work_id}"), None, &c).await;
    assert_eq!(resp.status, StatusCode::NO_CONTENT);
    assert_eq!(app.revoked_reason(work.session).await.as_deref(), Some("identity_unlinked"));
    let last = identities[0]["id"].as_str().unwrap();
    let resp = app.authed(Method::DELETE, &format!("/auth/identities/{last}"), None, &c).await;
    assert_eq!(resp.code(), "identity.last");
    assert!(app.audit_kinds(c.user).await.contains(&"identity.unlinked".to_owned()));
}

// --- Google ---

/// Follows `/auth/google/start`: the flow cookie and Google's query parameters.
async fn google_start(app: &App, headers: &[(&str, &str)]) -> (String, url::Url) {
    let resp = app.call(Method::GET, "/auth/google/start", None, headers).await;
    assert_eq!(resp.status, StatusCode::SEE_OTHER, "{}", resp.body);
    let flow = resp.cookie("chat_oidc").unwrap();
    (flow, url::Url::parse(resp.location()).unwrap())
}

fn param(url: &url::Url, name: &str) -> String {
    url.query_pairs().find(|(k, _)| k == name).unwrap().1.into_owned()
}

async fn google_callback(app: &App, flow: &str, state: &str, code: &str) -> Resp {
    let path = format!("/auth/google/callback?code={code}&state={state}");
    app.call(Method::GET, &path, None, &[("cookie", &format!("chat_oidc={flow}"))]).await
}

#[sqlx::test]
async fn google_sign_in(db: PgPool) {
    let (app, fake) = App::with_google(db).await;
    let (flow, url) = google_start(&app, &[]).await;
    assert_eq!(param(&url, "client_id"), fake_google::CLIENT_ID);
    assert_eq!(param(&url, "redirect_uri"), "http://localhost:3000/auth/google/callback");
    assert_eq!(param(&url, "code_challenge_method"), "S256");
    assert_eq!(param(&url, "scope"), "openid email profile");
    let (state, nonce) = (param(&url, "state"), param(&url, "nonce"));

    fake.script("code-1", FakeGoogle::claims(&nonce, "g-1", "Ann@Example.com", true));
    let resp = google_callback(&app, &flow, &state, "code-1").await;
    assert_eq!((resp.status, resp.location()), (StatusCode::SEE_OTHER, "/"));
    let cookie = resp.cookie("chat_refresh").unwrap();
    assert_eq!(resp.cookie("chat_oidc").as_deref(), Some(""));

    // PKCE: the verifier sent to Google hashes to the challenge.
    let exchange = &fake.exchanges()[0];
    let verifier = &exchange["code_verifier"];
    use base64::Engine;
    use sha2::Digest;
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sha2::Sha256::digest(verifier.as_bytes()));
    assert_eq!(challenge, param(&url, "code_challenge"));
    assert_eq!(exchange["client_secret"], "secret");

    let grant = app.refresh(&cookie).await;
    assert_eq!(grant.status, StatusCode::OK);
    let identities: Vec<(String, Option<String>, bool)> =
        sqlx::query_as("SELECT kind, email, email_verified FROM identities").fetch_all(&app.db).await.unwrap();
    assert_eq!(identities, [("google".into(), Some("ann@example.com".into()), true)]);

    // The flow is single-use.
    let replay = google_callback(&app, &flow, &state, "code-1").await;
    assert_eq!(replay.location(), "/sign-in?error=failed");
}

#[sqlx::test]
async fn google_tokens_are_verified(db: PgPool) {
    let (app, fake) = App::with_google(db).await;
    type Break = fn(&mut Value);
    let cases: [(&str, Break); 6] = [
        ("wrong nonce", |c| c["nonce"] = json!("other")),
        ("no nonce", |c| {
            c.as_object_mut().unwrap().remove("nonce");
        }),
        ("wrong audience", |c| c["aud"] = json!("someone-else")),
        ("wrong issuer", |c| c["iss"] = json!("https://evil.example")),
        ("expired", |c| c["exp"] = json!(time::OffsetDateTime::now_utc().unix_timestamp() - 120)),
        ("issued in the future", |c| c["iat"] = json!(time::OffsetDateTime::now_utc().unix_timestamp() + 600)),
    ];
    for (i, (name, break_it)) in cases.into_iter().enumerate() {
        let (flow, url) = google_start(&app, &[]).await;
        let mut claims = FakeGoogle::claims(&param(&url, "nonce"), "g-1", "ann@example.com", true);
        break_it(&mut claims);
        let code = format!("code-{i}");
        fake.script(&code, claims);
        let resp = google_callback(&app, &flow, &param(&url, "state"), &code).await;
        assert_eq!(resp.location(), "/sign-in?error=failed", "{name}");
    }
    // A state from another flow, and Google refusing the code.
    let (flow, _) = google_start(&app, &[]).await;
    assert_eq!(google_callback(&app, &flow, "forged", "x").await.location(), "/sign-in?error=failed");
    let (flow, url) = google_start(&app, &[]).await;
    assert_eq!(
        google_callback(&app, &flow, &param(&url, "state"), "unknown").await.location(),
        "/sign-in?error=failed"
    );
    let users: i64 = sqlx::query_scalar("SELECT count(*) FROM users").fetch_one(&app.db).await.unwrap();
    assert_eq!(users, 0);
    let cancelled = app.call(Method::GET, "/auth/google/callback?error=access_denied", None, &[]).await;
    assert_eq!(cancelled.location(), "/sign-in?error=cancelled");
}

#[sqlx::test]
async fn google_links_by_verified_address_only(db: PgPool) {
    let (app, fake) = App::with_google(db).await;
    let ann = app.sign_in("ann@example.com").await;

    let (flow, url) = google_start(&app, &[]).await;
    fake.script("unverified", FakeGoogle::claims(&param(&url, "nonce"), "g-evil", "ann@example.com", false));
    let resp = google_callback(&app, &flow, &param(&url, "state"), "unverified").await;
    assert_eq!(resp.location(), "/sign-in?error=email_unverified");

    let (flow, url) = google_start(&app, &[]).await;
    fake.script("verified", FakeGoogle::claims(&param(&url, "nonce"), "g-ann", "ann@example.com", true));
    let resp = google_callback(&app, &flow, &param(&url, "state"), "verified").await;
    let grant = app.refresh(&resp.cookie("chat_refresh").unwrap()).await;
    assert_eq!(grant.body["user_id"], ann.user.to_string(), "auto-linked to the existing account");
    let kinds = app.audit_kinds(ann.user).await;
    assert!(kinds.contains(&"identity.linked".to_owned()), "{kinds:?}");
}

#[sqlx::test]
async fn google_linking_needs_the_signed_in_browser(db: PgPool) {
    let (app, fake) = App::with_google(db).await;
    let ann = app.sign_in("ann@example.com").await;
    app.sign_in("bob@example.com").await;

    // Without the refresh cookie (another site started the navigation): no link flow.
    let resp = app.call(Method::GET, "/auth/google/start?link=true", None, &[]).await;
    assert_eq!(resp.location(), "/sign-in");

    let cookie = format!("chat_refresh={}", ann.cookie);
    let (flow, url) = google_start_link(&app, &cookie).await;
    fake.script("work", FakeGoogle::claims(&param(&url, "nonce"), "g-work", "ann@work.example", true));
    let resp = google_callback(&app, &flow, &param(&url, "state"), "work").await;
    assert_eq!(resp.location(), "/settings?linked=google");
    assert_eq!(resp.cookie("chat_refresh"), None, "linking does not create a session");

    // A Google account whose address belongs to Bob cannot join Ann's account.
    let (flow, url) = google_start_link(&app, &cookie).await;
    fake.script("bob", FakeGoogle::claims(&param(&url, "nonce"), "g-bob", "bob@example.com", true));
    let resp = google_callback(&app, &flow, &param(&url, "state"), "bob").await;
    assert_eq!(resp.location(), "/settings?linked=in_use");
    let identities = app.authed(Method::GET, "/auth/identities", None, &ann).await.body["identities"].clone();
    assert_eq!(identities.as_array().unwrap().len(), 2);
}

async fn google_start_link(app: &App, cookie: &str) -> (String, url::Url) {
    let resp = app.call(Method::GET, "/auth/google/start?link=true", None, &[("cookie", cookie)]).await;
    let flow = resp.cookie("chat_oidc").unwrap();
    (flow, url::Url::parse(resp.location()).unwrap())
}

// --- audit, deletion, retention ---

#[sqlx::test]
async fn the_audit_log_pages(db: PgPool) {
    let app = App::new(db, |_, _| {}).await;
    let c = app.sign_in("ann@example.com").await;
    for _ in 0..3 {
        app.refresh(&c.cookie).await;
        let cookie = format!("chat_refresh={}", app.sign_in("ann@example.com").await.cookie);
        app.call(Method::POST, "/auth/sign-out", None, &[("cookie", &cookie)]).await;
    }
    let page = app.authed(Method::GET, "/auth/audit?limit=4", None, &c).await.body;
    assert_eq!(page["events"].as_array().unwrap().len(), 4);
    let before = page["next_before"].as_i64().unwrap();
    let rest = app.authed(Method::GET, &format!("/auth/audit?limit=100&before={before}"), None, &c).await.body;
    assert!(rest["events"].as_array().unwrap().iter().all(|e| e["id"].as_i64().unwrap() < before));
    assert!(rest["next_before"].is_null());
    let text = rest.to_string() + &page.to_string();
    assert!(!text.contains("ann@example.com"), "no addresses in the log");
}

#[sqlx::test]
async fn deleting_an_account_removes_everything(db: PgPool) {
    let app = App::new(db, |_, _| {}).await;
    let ann = app.sign_in("ann@example.com").await;
    let other = app.sign_in("ann@example.com").await;
    let bob = app.sign_in("bob@example.com").await;
    let update = json!({ "device_id": Uuid::now_v7() });
    assert_eq!(app.authed(Method::PUT, "/auth/session", Some(update), &ann).await.status, StatusCode::NO_CONTENT);

    sqlx::query("UPDATE sessions SET created_at = now() - interval '11 minutes' WHERE id = $1")
        .bind(ann.session)
        .execute(&app.db)
        .await
        .unwrap();
    let stale = app.authed(Method::DELETE, "/auth/account", None, &ann).await;
    assert_eq!(stale.code(), "auth.reauth_required");

    let resp = app.authed(Method::DELETE, "/auth/account", None, &other).await;
    assert_eq!(resp.status, StatusCode::NO_CONTENT);
    assert_eq!(resp.cookie("chat_refresh").as_deref(), Some(""));
    for (table, sql) in [
        ("users", "SELECT count(*) FROM users WHERE id = $1"),
        ("identities", "SELECT count(*) FROM identities WHERE user_id = $1"),
        ("sessions", "SELECT count(*) FROM sessions WHERE user_id = $1"),
        ("devices", "SELECT count(*) FROM devices WHERE user_id = $1"),
        ("audit_events", "SELECT count(*) FROM audit_events WHERE user_id = $1"),
    ] {
        let left: i64 = sqlx::query_scalar(sql).bind(ann.user).fetch_one(&app.db).await.unwrap();
        assert_eq!(left, 0, "{table}");
    }
    for c in [&ann, &other] {
        assert_eq!(app.authed(Method::GET, "/auth/sessions", None, c).await.status, StatusCode::UNAUTHORIZED);
    }
    assert_eq!(app.authed(Method::GET, "/auth/sessions", None, &bob).await.status, StatusCode::OK);
    // The same address starts over with a new, empty account.
    assert_ne!(app.sign_in("ann@example.com").await.user, ann.user);
}

#[sqlx::test]
async fn retention_sweeps_old_rows(db: PgPool) {
    let app = App::new(db, |_, _| {}).await;
    let c = app.sign_in("ann@example.com").await;
    sqlx::query("UPDATE audit_events SET created_at = now() - interval '400 days'").execute(&app.db).await.unwrap();
    sqlx::query("UPDATE email_codes SET expires_at = now() - interval '1 minute'").execute(&app.db).await.unwrap();
    app.start_code("bob@example.com").await;
    sqlx::query("UPDATE email_codes SET expires_at = now() - interval '1 minute'").execute(&app.db).await.unwrap();
    let idle = app.sign_in("carol@example.com").await;
    sqlx::query("UPDATE sessions SET last_seen_at = now() - interval '40 days' WHERE id = $1")
        .bind(idle.session)
        .execute(&app.db)
        .await
        .unwrap();

    let swept = retention::sweep(&app.db, 365, app.state.auth.idle).await.unwrap();
    assert_eq!((swept.email_codes, swept.idle_sessions), (1, 1));
    assert!(swept.audit_events >= 3, "{swept:?}");
    assert_eq!(app.revoked_reason(idle.session).await.as_deref(), Some("idle"));
    assert_eq!(app.revoked_reason(c.session).await, None);

    sqlx::query("UPDATE sessions SET revoked_at = now() - interval '31 days' WHERE id = $1")
        .bind(idle.session)
        .execute(&app.db)
        .await
        .unwrap();
    assert_eq!(retention::sweep(&app.db, 365, app.state.auth.idle).await.unwrap().old_sessions, 1);
}

#[sqlx::test]
async fn revocations_survive_a_restart(db: PgPool) {
    let app = App::new(db.clone(), |_, _| {}).await;
    let c = app.sign_in("ann@example.com").await;
    let cookie = format!("chat_refresh={}", c.cookie);
    app.call(Method::POST, "/auth/sign-out", None, &[("cookie", &cookie)]).await;

    // A fresh process: empty memory store, same keys.
    let restarted = App::new(db, |_, _| {}).await;
    assert_eq!(
        restarted.authed(Method::GET, "/auth/sessions", None, &c).await.status,
        StatusCode::OK,
        "before preload"
    );
    assert_eq!(restarted.state.auth.preload_revocations(&restarted.db).await.unwrap(), 1);
    assert_eq!(restarted.authed(Method::GET, "/auth/sessions", None, &c).await.status, StatusCode::UNAUTHORIZED);
}
