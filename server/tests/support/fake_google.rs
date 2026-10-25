//! A fake Google for sign-in tests: a token endpoint that answers scripted
//! id_tokens (RS256, signed with a test-only key) and a JWKS endpoint.

use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{Arc, Mutex},
};

use axum::{
    Form, Json, Router,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chat_server::auth::google::Endpoints;
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use serde_json::{Value, json};

/// PKCS#1 DER of a 2048-bit RSA key made for these tests only.
const KEY_DER: &[u8] = include_bytes!("google_test_key.der");
const KEY_N: &str = include_str!("google_test_key.n");
pub const KID: &str = "test-key";
pub const CLIENT_ID: &str = "client.apps.example";
pub const ISSUER: &str = "https://accounts.google.com";

#[derive(Default)]
struct Script {
    /// Authorization code → id_token claims.
    codes: HashMap<String, Value>,
    /// Form bodies the token endpoint received.
    exchanges: Vec<HashMap<String, String>>,
}

#[derive(Clone)]
pub struct FakeGoogle {
    pub addr: SocketAddr,
    script: Arc<Mutex<Script>>,
}

impl FakeGoogle {
    pub async fn start() -> Self {
        let script = Arc::new(Mutex::new(Script::default()));
        let app = Router::new().route("/token", post(token)).route("/jwks", get(jwks)).with_state(Arc::clone(&script));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self { addr, script }
    }

    pub fn endpoints(&self) -> Endpoints {
        Endpoints {
            issuers: vec![ISSUER.to_owned()],
            authorize: "https://accounts.example/authorize".to_owned(),
            token: format!("http://{}/token", self.addr),
            jwks: format!("http://{}/jwks", self.addr),
        }
    }

    /// Claims of a valid id_token; tests override fields to break it.
    pub fn claims(nonce: &str, sub: &str, email: &str, verified: bool) -> Value {
        let now = time::OffsetDateTime::now_utc().unix_timestamp();
        json!({
            "iss": ISSUER, "aud": CLIENT_ID, "sub": sub, "iat": now, "exp": now + 3600,
            "nonce": nonce, "email": email, "email_verified": verified,
        })
    }

    /// The token endpoint answers `code` with an id_token of these claims.
    pub fn script(&self, code: &str, claims: Value) {
        self.script.lock().unwrap().codes.insert(code.to_owned(), claims);
    }

    pub fn exchanges(&self) -> Vec<HashMap<String, String>> {
        self.script.lock().unwrap().exchanges.clone()
    }

    pub fn sign(claims: &Value) -> String {
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some(KID.to_owned());
        jsonwebtoken::encode(&header, claims, &EncodingKey::from_rsa_der(KEY_DER)).unwrap()
    }
}

async fn token(State(script): State<Arc<Mutex<Script>>>, Form(form): Form<HashMap<String, String>>) -> Response {
    let mut script = script.lock().unwrap();
    script.exchanges.push(form.clone());
    match form.get("code").and_then(|code| script.codes.get(code)) {
        Some(claims) => Json(json!({ "id_token": FakeGoogle::sign(claims), "access_token": "unused" })).into_response(),
        None => (StatusCode::BAD_REQUEST, Json(json!({ "error": "invalid_grant" }))).into_response(),
    }
}

async fn jwks() -> Json<Value> {
    Json(
        json!({ "keys": [{ "kty": "RSA", "kid": KID, "use": "sig", "alg": "RS256", "n": KEY_N.trim(), "e": "AQAB" }] }),
    )
}
