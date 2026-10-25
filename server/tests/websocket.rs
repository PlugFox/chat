//! The WebSocket transport over a real TCP socket (docs/protocol.md,
//! "Connection lifecycle"): auth, heartbeat, renewal, revocation, limits.

#![allow(clippy::unwrap_used, clippy::expect_used, reason = "tests fail loudly")]

use std::{net::SocketAddr, sync::Arc, time::Duration};

use chat_server::{
    app::{self, AppState},
    auth::{AuthError, Principal, TokenVerifier},
    config::Config,
    ws::WsSettings,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use time::OffsetDateTime;
use tokio::{net::TcpStream, sync::watch};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream,
    tungstenite::{Message, client::IntoClientRequest},
};
use uuid::Uuid;

const ORIGIN: &str = "http://localhost:3000";
const USER: Uuid = Uuid::from_u128(1);

/// Tokens are `<session uuid>:<seconds until expiry>`; anything else is invalid.
#[derive(Debug)]
struct FakeVerifier;

impl TokenVerifier for FakeVerifier {
    fn verify(&self, token: &str) -> Result<Principal, AuthError> {
        let (session, seconds) = token.split_once(':').ok_or(AuthError::Invalid)?;
        let session_id = session.parse().map_err(|_| AuthError::Invalid)?;
        let seconds: f64 = seconds.parse().map_err(|_| AuthError::Invalid)?;
        let expires_at = OffsetDateTime::now_utc() + Duration::from_secs_f64(seconds);
        Ok(Principal { user_id: USER, session_id, expires_at })
    }
}

fn token(session: Uuid, seconds: f64) -> String {
    format!("{session}:{seconds}")
}

struct Server {
    addr: SocketAddr,
    state: AppState,
    stop: watch::Sender<()>,
}

async fn start() -> Server {
    let mut config = Config::from_lookup(|n| (n == "CHAT_DATABASE_URL").then(|| "postgres://unused".into())).unwrap();
    config.allowed_origins = vec![ORIGIN.into()];
    // Never connects: the transport does not touch the database.
    let db = sqlx::postgres::PgPoolOptions::new().connect_lazy("postgres://unused@127.0.0.1:1/x").unwrap();
    let (stop, stopped) = watch::channel(());
    let settings = WsSettings {
        auth_timeout: Duration::from_millis(300),
        heartbeat: Duration::from_millis(400),
        max_frame_bytes: 4096,
        rate_burst: 5,
        rate_per_second: 1,
    };
    let state = AppState::new(config, db, Arc::new(FakeVerifier), stopped).with_ws_settings(settings);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let router = app::router(state.clone());
    let mut shutdown = state.shutdown.clone();
    tokio::spawn(async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = shutdown.changed().await;
            })
            .await
            .unwrap();
    });
    Server { addr, state, stop }
}

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn connect_with_origin(server: &Server, origin: &str) -> Result<Ws, tokio_tungstenite::tungstenite::Error> {
    let mut request = format!("ws://{}/ws", server.addr).into_client_request().unwrap();
    request.headers_mut().insert("origin", origin.parse().unwrap());
    tokio_tungstenite::connect_async(request).await.map(|(ws, _)| ws)
}

async fn connect(server: &Server) -> Ws {
    connect_with_origin(server, ORIGIN).await.unwrap()
}

async fn send(ws: &mut Ws, frame: Value) {
    ws.send(Message::text(frame.to_string())).await.unwrap();
}

/// The next text frame as JSON, or the close code.
async fn recv(ws: &mut Ws) -> Result<Value, Option<u16>> {
    loop {
        match tokio::time::timeout(Duration::from_secs(3), ws.next()).await.expect("no frame within 3 s") {
            Some(Ok(Message::Text(t))) => return Ok(serde_json::from_str(&t).unwrap()),
            Some(Ok(Message::Close(frame))) => return Err(frame.map(|f| u16::from(f.code))),
            Some(Ok(_)) => {}
            None | Some(Err(_)) => return Err(None),
        }
    }
}

async fn authed(server: &Server, session: Uuid, seconds: f64) -> Ws {
    let mut ws = connect(server).await;
    send(&mut ws, json!({ "v": 1, "id": 1, "type": "auth", "payload": { "access_token": token(session, seconds) } }))
        .await;
    let ok = recv(&mut ws).await.unwrap();
    assert_eq!(ok["type"], "ok", "{ok}");
    assert_eq!(ok["id"], 1);
    assert_eq!(ok["payload"]["session_id"], session.to_string());
    assert_eq!(ok["payload"]["heartbeat_ms"], 400);
    ws
}

#[tokio::test]
async fn auth_then_ping() {
    let server = start().await;
    let mut ws = authed(&server, Uuid::now_v7(), 60.0).await;
    send(&mut ws, json!({ "v": 1, "id": 2, "type": "ping" })).await;
    let pong = recv(&mut ws).await.unwrap();
    assert_eq!((pong["id"].as_u64(), pong["type"].as_str()), (Some(2), Some("ok")));
    assert!(pong["payload"]["server_time"].as_i64().unwrap() > 1_700_000_000_000);
}

#[tokio::test]
async fn foreign_origins_are_refused() {
    let server = start().await;
    assert!(connect_with_origin(&server, "https://evil.example").await.is_err());
}

#[tokio::test]
async fn auth_must_come_first_and_in_time() {
    let server = start().await;
    let mut ws = connect(&server).await;
    assert_eq!(recv(&mut ws).await, Err(Some(4002)));

    let mut ws = connect(&server).await;
    send(&mut ws, json!({ "v": 1, "id": 1, "type": "ping" })).await;
    assert_eq!(recv(&mut ws).await, Err(Some(4001)));

    let mut ws = connect(&server).await;
    send(&mut ws, json!({ "v": 1, "id": 1, "type": "auth", "payload": { "access_token": "garbage" } })).await;
    assert_eq!(recv(&mut ws).await, Err(Some(4001)));
}

#[tokio::test]
async fn unsupported_versions_close_4005() {
    let server = start().await;
    let mut ws = connect(&server).await;
    send(&mut ws, json!({ "v": 99, "id": 1, "type": "auth", "payload": {} })).await;
    assert_eq!(recv(&mut ws).await, Err(Some(4005)));
}

#[tokio::test]
async fn revoked_sessions_close_4003_and_cannot_reconnect() {
    let server = start().await;
    let session = Uuid::now_v7();
    let mut ws = authed(&server, session, 60.0).await;
    let mut other = authed(&server, Uuid::now_v7(), 60.0).await;
    server.state.revocations.revoke(session);
    assert_eq!(recv(&mut ws).await, Err(Some(4003)));

    let mut again = connect(&server).await;
    send(&mut again, json!({ "v": 1, "id": 1, "type": "auth", "payload": { "access_token": token(session, 60.0) } }))
        .await;
    assert_eq!(recv(&mut again).await, Err(Some(4001)));

    // Other sessions are untouched.
    send(&mut other, json!({ "v": 1, "id": 2, "type": "ping" })).await;
    assert_eq!(recv(&mut other).await.unwrap()["type"], "ok");
}

#[tokio::test]
async fn expiry_closes_4004_unless_renewed() {
    let server = start().await;
    let session = Uuid::now_v7();
    let mut ws = authed(&server, session, 0.3).await;
    send(
        &mut ws,
        json!({ "v": 1, "id": 2, "type": "auth.renew", "payload": { "access_token": token(session, 60.0) } }),
    )
    .await;
    assert_eq!(recv(&mut ws).await.unwrap()["type"], "ok");
    tokio::time::sleep(Duration::from_millis(350)).await;
    send(&mut ws, json!({ "v": 1, "id": 3, "type": "ping" })).await;
    assert_eq!(recv(&mut ws).await.unwrap()["type"], "ok", "renewed token keeps the socket");

    let mut short = authed(&server, Uuid::now_v7(), 0.2).await;
    assert_eq!(recv(&mut short).await, Err(Some(4004)));
}

#[tokio::test]
async fn renewal_needs_the_same_session() {
    let server = start().await;
    let mut ws = authed(&server, Uuid::now_v7(), 60.0).await;
    send(
        &mut ws,
        json!({ "v": 1, "id": 2, "type": "auth.renew", "payload": { "access_token": token(Uuid::now_v7(), 60.0) } }),
    )
    .await;
    let reply = recv(&mut ws).await.unwrap();
    assert_eq!(
        (reply["type"].as_str(), reply["payload"]["code"].as_str()),
        (Some("error"), Some("auth.session_mismatch"))
    );
}

#[tokio::test]
async fn bad_requests_get_errors_and_keep_the_socket() {
    let server = start().await;
    let mut ws = authed(&server, Uuid::now_v7(), 60.0).await;
    let cases = [
        (json!({ "v": 1, "id": 2, "type": "nope" }), Some(2u64), "protocol.unknown_type"),
        (json!({ "v": 1, "type": "ping" }), None, "protocol.missing_id"),
        (json!({ "v": 1, "id": 3, "type": "ping", "payload": { "x": 1 } }), Some(3), "protocol.malformed"),
        (
            json!({ "v": 1, "id": 4, "type": "auth", "payload": { "access_token": "x" } }),
            Some(4),
            "auth.already_authenticated",
        ),
    ];
    for (frame, id, code) in cases {
        send(&mut ws, frame).await;
        let reply = recv(&mut ws).await.unwrap();
        assert_eq!(reply["type"], "error", "{reply}");
        assert_eq!(reply["id"].as_u64(), id, "{reply}");
        assert_eq!(reply["payload"]["code"], code, "{reply}");
    }
    ws.send(Message::text("not json")).await.unwrap();
    assert_eq!(recv(&mut ws).await.unwrap()["payload"]["code"], "protocol.malformed");
    send(&mut ws, json!({ "v": 1, "id": 9, "type": "ping" })).await;
    assert_eq!(recv(&mut ws).await.unwrap()["type"], "ok");
}

#[tokio::test]
async fn binary_and_oversized_frames_are_refused() {
    let server = start().await;
    let mut ws = authed(&server, Uuid::now_v7(), 60.0).await;
    ws.send(Message::binary(vec![1, 2, 3])).await.unwrap();
    assert_eq!(recv(&mut ws).await, Err(Some(4008)));

    let mut ws = authed(&server, Uuid::now_v7(), 60.0).await;
    let _ = ws.send(Message::text("x".repeat(10_000))).await;
    assert_eq!(recv(&mut ws).await, Err(Some(4008)));
}

#[tokio::test]
async fn requests_are_rate_limited() {
    let server = start().await;
    let mut ws = authed(&server, Uuid::now_v7(), 60.0).await;
    let mut limited = 0;
    for id in 2..12 {
        send(&mut ws, json!({ "v": 1, "id": id, "type": "ping" })).await;
        if recv(&mut ws).await.unwrap()["payload"]["code"] == "rate_limited" {
            limited += 1;
        }
    }
    assert!(limited >= 4, "burst of 5 then refusals, got {limited} refusals");
}

#[tokio::test]
async fn silent_sockets_are_closed() {
    let server = start().await;
    let mut ws = authed(&server, Uuid::now_v7(), 60.0).await;
    // Three heartbeats (1.2 s) without a frame.
    assert_eq!(recv(&mut ws).await, Err(Some(1000)));
}

#[tokio::test]
async fn shutdown_closes_1001() {
    let server = start().await;
    let mut ws = authed(&server, Uuid::now_v7(), 60.0).await;
    server.stop.send(()).unwrap();
    assert_eq!(recv(&mut ws).await, Err(Some(1001)));
}
