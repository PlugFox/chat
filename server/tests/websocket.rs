//! The WebSocket transport over a real TCP socket (docs/protocol.md,
//! "Connection lifecycle"): auth, heartbeat, renewal, revocation, limits.

#![allow(clippy::unwrap_used, clippy::expect_used, reason = "tests fail loudly")]

mod support;

use std::{net::SocketAddr, sync::Arc, time::Duration};

use chat_server::{
    app::{self, AppState},
    ws::WsSettings,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use support::ORIGIN;
use tokio::{net::TcpStream, sync::watch};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream,
    tungstenite::{Message, client::IntoClientRequest},
};
use uuid::Uuid;

const USER: Uuid = Uuid::from_u128(1);

struct Server {
    addr: SocketAddr,
    state: AppState,
    stop: watch::Sender<()>,
}

impl Server {
    fn token(&self, session: Uuid, seconds: u64) -> String {
        support::token(&self.state.auth, USER, session, seconds)
    }
}

async fn start() -> Server {
    let config = support::config();
    // Never connects: only the background last-seen update would, and it just logs.
    let db = sqlx::postgres::PgPoolOptions::new()
        .acquire_timeout(Duration::from_millis(100))
        .connect_lazy("postgres://unused@127.0.0.1:1/x")
        .unwrap();
    let (stop, stopped) = watch::channel(());
    let settings = WsSettings {
        auth_timeout: Duration::from_millis(300),
        heartbeat: Duration::from_millis(400),
        max_frame_bytes: 4096,
        rate_burst: 5,
        rate_per_second: 1,
        unauthenticated_per_ip: 2,
        sockets_per_account: 3,
        ..WsSettings::default()
    };
    let state = AppState::new(config, db, Arc::new(support::auth().0), stopped).with_ws_settings(settings);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let router = app::router(state.clone());
    let mut shutdown = state.shutdown.clone();
    tokio::spawn(async move {
        axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>())
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

/// Sends `{ type, id?, payload? }` as a MessagePack frame (id 0 and `{}` when absent).
async fn send(ws: &mut Ws, frame: Value) {
    let id = u32::try_from(frame["id"].as_u64().unwrap_or(0)).unwrap();
    let payload = frame.get("payload").cloned().unwrap_or_else(|| json!({}));
    let bytes = chat_protocol::encode(frame["type"].as_str().unwrap(), id, &payload);
    ws.send(Message::binary(bytes)).await.unwrap();
}

/// The next frame as `{ type, id, payload }`, or the close code.
async fn recv(ws: &mut Ws) -> Result<Value, Option<u16>> {
    loop {
        match tokio::time::timeout(Duration::from_secs(3), ws.next()).await.expect("no frame within 3 s") {
            Some(Ok(Message::Binary(bytes))) => {
                let frame = chat_protocol::InFrame::parse(&bytes).unwrap();
                let payload: Value = frame.payload().unwrap();
                return Ok(json!({ "type": frame.kind, "id": frame.id, "payload": payload }));
            }
            Some(Ok(Message::Close(frame))) => return Err(frame.map(|f| u16::from(f.code))),
            Some(Ok(_)) => {}
            None | Some(Err(_)) => return Err(None),
        }
    }
}

async fn authed(server: &Server, session: Uuid, seconds: u64) -> Ws {
    let mut ws = connect(server).await;
    let token = server.token(session, seconds);
    send(&mut ws, json!({ "id": 1, "type": "auth", "payload": { "v": 1, "access_token": token } })).await;
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
    let mut ws = authed(&server, Uuid::now_v7(), 60).await;
    send(&mut ws, json!({ "id": 2, "type": "ping" })).await;
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
    send(&mut ws, json!({ "id": 1, "type": "ping" })).await;
    assert_eq!(recv(&mut ws).await, Err(Some(4001)));

    let mut ws = connect(&server).await;
    send(&mut ws, json!({ "id": 1, "type": "auth", "payload": { "v": 1, "access_token": "garbage" } })).await;
    assert_eq!(recv(&mut ws).await, Err(Some(4001)));
}

#[tokio::test]
async fn unsupported_versions_close_4005() {
    let server = start().await;
    let mut ws = connect(&server).await;
    send(&mut ws, json!({ "id": 1, "type": "auth", "payload": { "v": 99, "access_token": "x" } })).await;
    assert_eq!(recv(&mut ws).await, Err(Some(4005)));
}

#[tokio::test]
async fn revoked_sessions_close_4003_and_cannot_reconnect() {
    let server = start().await;
    let session = Uuid::now_v7();
    let mut ws = authed(&server, session, 60).await;
    let mut other = authed(&server, Uuid::now_v7(), 60).await;
    server.state.auth.store.revoke(session, Duration::from_secs(60)).await.unwrap();
    assert_eq!(recv(&mut ws).await, Err(Some(4003)));

    let mut again = connect(&server).await;
    let token = server.token(session, 60);
    send(&mut again, json!({ "id": 1, "type": "auth", "payload": { "v": 1, "access_token": token } })).await;
    assert_eq!(recv(&mut again).await, Err(Some(4001)));

    // Other sessions are untouched.
    send(&mut other, json!({ "id": 2, "type": "ping" })).await;
    assert_eq!(recv(&mut other).await.unwrap()["type"], "ok");
}

#[tokio::test]
async fn expiry_closes_4004_unless_renewed() {
    let server = start().await;
    let session = Uuid::now_v7();
    // JWT expiry has one-second resolution; the heartbeat is shorter, so keep pinging.
    let mut ws = authed(&server, session, 2).await;
    let token = server.token(session, 60);
    send(&mut ws, json!({ "id": 2, "type": "auth.renew", "payload": { "access_token": token } })).await;
    assert_eq!(recv(&mut ws).await.unwrap()["type"], "ok");
    // Past the first token's expiry, within the heartbeat and the request rate.
    for id in 3..6 {
        tokio::time::sleep(Duration::from_millis(900)).await;
        send(&mut ws, json!({ "id": id, "type": "ping" })).await;
        assert_eq!(recv(&mut ws).await.unwrap()["type"], "ok", "renewed token keeps the socket");
    }

    let mut short = authed(&server, Uuid::now_v7(), 1).await;
    assert_eq!(recv(&mut short).await, Err(Some(4004)));
}

#[tokio::test]
async fn renewal_needs_the_same_session() {
    let server = start().await;
    let mut ws = authed(&server, Uuid::now_v7(), 60).await;
    send(
        &mut ws,
        json!({ "id": 2, "type": "auth.renew", "payload": { "access_token": server.token(Uuid::now_v7(), 60) } }),
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
    let mut ws = authed(&server, Uuid::now_v7(), 60).await;
    let cases = [
        (json!({ "id": 2, "type": "nope" }), Some(2u64), "protocol.unknown_type"),
        (json!({ "type": "ping" }), Some(0), "protocol.missing_id"),
        (json!({ "id": 3, "type": "ping", "payload": { "x": 1 } }), Some(3), "protocol.malformed"),
        (
            json!({ "id": 4, "type": "auth", "payload": { "v": 1, "access_token": "x" } }),
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
    ws.send(Message::binary(vec![0xc1])).await.unwrap();
    let reply = recv(&mut ws).await.unwrap();
    assert_eq!((reply["id"].as_u64(), reply["payload"]["code"].as_str()), (Some(0), Some("protocol.malformed")));
    send(&mut ws, json!({ "id": 9, "type": "ping" })).await;
    assert_eq!(recv(&mut ws).await.unwrap()["type"], "ok");
}

#[tokio::test]
async fn text_and_oversized_frames_are_refused() {
    let server = start().await;
    let mut ws = authed(&server, Uuid::now_v7(), 60).await;
    ws.send(Message::text(r#"{"type":"ping"}"#)).await.unwrap();
    assert_eq!(recv(&mut ws).await, Err(Some(4008)));

    let mut ws = authed(&server, Uuid::now_v7(), 60).await;
    let _ = ws.send(Message::binary(vec![0; 10_000])).await;
    assert_eq!(recv(&mut ws).await, Err(Some(4008)));
}

#[tokio::test]
async fn requests_are_rate_limited() {
    let server = start().await;
    let mut ws = authed(&server, Uuid::now_v7(), 60).await;
    let mut limited = 0;
    for id in 2..12 {
        send(&mut ws, json!({ "id": id, "type": "ping" })).await;
        if recv(&mut ws).await.unwrap()["payload"]["code"] == "rate_limited" {
            limited += 1;
        }
    }
    assert!(limited >= 4, "burst of 5 then refusals, got {limited} refusals");
}

#[tokio::test]
async fn silent_sockets_are_closed() {
    let server = start().await;
    let mut ws = authed(&server, Uuid::now_v7(), 60).await;
    // Three heartbeats (1.2 s) without a frame.
    assert_eq!(recv(&mut ws).await, Err(Some(1000)));
}

#[tokio::test]
async fn shutdown_closes_1001() {
    let server = start().await;
    let mut ws = authed(&server, Uuid::now_v7(), 60).await;
    server.stop.send(()).unwrap();
    assert_eq!(recv(&mut ws).await, Err(Some(1001)));
}

#[tokio::test]
async fn tokens_of_another_server_key_are_refused() {
    let server = start().await;
    let mut ws = connect(&server).await;
    let other = chat_server::auth::tokens::ServerKeys::derive(&[1; 32]);
    let grant = chat_server::auth::tokens::Grant {
        user_id: USER,
        session_id: Uuid::now_v7(),
        identity_id: Uuid::nil(),
        provider: chat_server::auth::Provider::Email,
    };
    let token = other.jwt.issue(grant, time::OffsetDateTime::now_utc()).token;
    send(&mut ws, json!({ "id": 1, "type": "auth", "payload": { "v": 1, "access_token": token } })).await;
    assert_eq!(recv(&mut ws).await, Err(Some(4001)));
}

#[tokio::test]
async fn unauthenticated_sockets_are_limited_per_ip() {
    let server = start().await;
    let _a = connect(&server).await;
    let _b = connect(&server).await;
    let third = connect_with_origin(&server, ORIGIN).await;
    assert!(third.err().is_some_and(|e| e.to_string().contains("429")), "third waiting socket");
    // Authenticating frees the slot.
    drop(_a);
    let _authed = authed(&server, Uuid::now_v7(), 60).await;
    let _c = connect(&server).await;
}

#[tokio::test]
async fn an_account_holds_a_limited_number_of_sockets() {
    let server = start().await;
    let first = authed(&server, Uuid::now_v7(), 60).await;
    let _second = authed(&server, Uuid::now_v7(), 60).await;
    let _third = authed(&server, Uuid::now_v7(), 60).await;
    let mut fourth = connect(&server).await;
    let token = server.token(Uuid::now_v7(), 60);
    send(&mut fourth, json!({ "id": 1, "type": "auth", "payload": { "v": 1, "access_token": token } })).await;
    assert_eq!(recv(&mut fourth).await, Err(Some(4008)));
    // A closed socket gives its place back.
    drop(first);
    tokio::time::sleep(Duration::from_millis(100)).await;
    let _again = authed(&server, Uuid::now_v7(), 60).await;
}
