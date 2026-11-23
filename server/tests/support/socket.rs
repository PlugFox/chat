//! A server on a real socket and a client for it: requests with their
//! response frames, events kept in order.

use std::{collections::VecDeque, net::SocketAddr, sync::Arc, time::Duration};

use chat_crypto::{ark::Ark, ids::UserId, os_rng};
use chat_protocol::{
    Bytes, InFrame,
    agent::AgentRetire,
    error::{ErrorCode, ErrorPayload},
    keys::{AccountScopeKind, KeysSetup, NewAccountScope},
};
use chat_server::{
    app::{self, AppState},
    auth::{Principal, Provider, client::ClientInfo},
    config::Config,
    keys,
    ws::WsSettings,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::json;
use sqlx::PgPool;
use time::OffsetDateTime;
use tokio::net::TcpStream;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream,
    tungstenite::{Message, client::IntoClientRequest},
};
use uuid::Uuid;

use super::fake_llm::FakeLlm;

pub const CLIENT: ClientInfo = ClientInfo { ip: None, country: None, user_agent: None };

pub struct Env {
    pub db: PgPool,
    pub state: AppState,
    pub addr: SocketAddr,
    pub llm: FakeLlm,
}

pub async fn start(db: PgPool) -> Env {
    start_with(db, WsSettings::default()).await
}

/// A server with files kept in memory, under this quota of bytes.
pub async fn start_files(db: PgPool, quota: Option<i64>) -> Env {
    serve(db, WsSettings::default(), Some(chat_server::files::FileStore::memory(quota))).await
}

/// A server with files in a store of the test's own.
pub async fn start_store(db: PgPool, store: chat_server::files::FileStore) -> Env {
    serve(db, WsSettings::default(), Some(store)).await
}

pub async fn start_with(db: PgPool, ws: WsSettings) -> Env {
    serve(db, ws, None).await
}

async fn serve(db: PgPool, ws: WsSettings, files: Option<chat_server::files::FileStore>) -> Env {
    let config = Config::from_lookup(|name| match name {
        "CHAT_DATABASE_URL" => Some("postgres://unused".to_owned()),
        // The fake listens on loopback, which only an operator allowlist admits.
        "CHAT_PROVIDER_ALLOWED_NETWORKS" => Some("127.0.0.0/8".to_owned()),
        _ => None,
    })
    .unwrap();
    let (stop, stopped) = tokio::sync::watch::channel(());
    std::mem::forget(stop);
    let mut state = AppState::new(config, db.clone(), Arc::new(super::auth().0), stopped).with_ws_settings(ws);
    // Never the real service from a test.
    state.weather = Some(chat_server::chats::weather::WeatherApi {
        geocoding: "https://weather.invalid/search".into(),
        forecast: "https://weather.invalid/forecast".into(),
    });
    if let Some(files) = files {
        state = state.with_files(files);
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let router = app::router(state.clone());
    tokio::spawn(async move {
        axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>()).await.unwrap();
    });
    Env { db, state, addr, llm: FakeLlm::start().await }
}

pub struct User {
    pub principal: Principal,
    pub ark: Ark,
}

impl User {
    pub fn id(&self) -> UserId {
        UserId::from_bytes(*self.principal.user_id.as_bytes())
    }
}

pub async fn session(db: &PgPool, user: Uuid) -> Principal {
    let session = Uuid::now_v7();
    sqlx::query("INSERT INTO sessions (id, user_id, provider, refresh_hash) VALUES ($1, $2, 'email', $3)")
        .bind(session)
        .bind(user)
        .bind(vec![0u8; 32])
        .execute(db)
        .await
        .unwrap();
    Principal {
        user_id: user,
        session_id: session,
        identity_id: Uuid::nil(),
        provider: Provider::Email,
        expires_at: OffsetDateTime::now_utc(),
    }
}

/// A user with keys set up; the scope keys of the account scopes are dummies.
pub async fn user(db: &PgPool) -> User {
    let id = Uuid::now_v7();
    sqlx::query("INSERT INTO users (id) VALUES ($1)").bind(id).execute(db).await.unwrap();
    let user = User { principal: session(db, id).await, ark: Ark::generate(&mut os_rng()) };
    let recovery = chat_crypto::wrap::ArkWrap::seal(
        &user.ark,
        &user.id(),
        chat_crypto::ids::WrapId::from_bytes(*Uuid::now_v7().as_bytes()),
        chat_crypto::wrap::WrapMethod::Recovery,
        &chat_crypto::wrap::UnlockSecret::Recovery(&chat_crypto::recovery::RecoveryKey::generate(&mut os_rng())),
        &mut os_rng(),
    )
    .unwrap();
    let setup = KeysSetup {
        commitment: Bytes(user.ark.commitment(&user.id()).0.to_vec()),
        writer_public_key: Bytes(user.ark.writer_key(&user.id()).public().as_bytes().to_vec()),
        wraps: vec![Bytes(recovery.encode().unwrap())],
        scopes: AccountScopeKind::ALL
            .into_iter()
            .map(|kind| NewAccountScope {
                scope_id: Uuid::now_v7(),
                kind,
                public_key: Bytes(vec![4; 32]),
                wrapped_private_key: Bytes(vec![5; 73]),
            })
            .collect(),
    };
    keys::setup(db, &user.principal, &CLIENT, &setup).await.unwrap();
    user
}

/// One socket: requests with their response frames, events kept in order.
pub struct Client {
    pub ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
    pub next_id: u32,
    pub events: VecDeque<(String, Vec<u8>)>,
}

pub fn payload<T: DeserializeOwned>(frame: &[u8]) -> T {
    InFrame::parse(frame).unwrap().payload().unwrap()
}

pub fn kind(frame: &[u8]) -> String {
    InFrame::parse(frame).unwrap().kind.to_owned()
}

impl Client {
    pub async fn connect(env: &Env, principal: &Principal, resume: Option<Uuid>) -> (Self, Vec<u8>) {
        let mut request = format!("ws://{}/ws", env.addr).into_client_request().unwrap();
        request.headers_mut().insert("origin", super::ORIGIN.parse().unwrap());
        let (ws, _) = tokio_tungstenite::connect_async(request).await.unwrap();
        let mut client = Self { ws, next_id: 1, events: VecDeque::new() };
        let token = super::token(&env.state.auth, principal.user_id, principal.session_id, 600);
        let mut auth = json!({ "v": 1, "access_token": token });
        if let Some(id) = resume {
            auth["resume"] = json!({ "agent_session_id": id });
        }
        let ok = client.call("auth", &auth).await.pop().unwrap();
        assert_eq!(kind(&ok), "ok");
        (client, ok)
    }

    pub async fn frame(&mut self) -> Result<Vec<u8>, Option<u16>> {
        loop {
            match tokio::time::timeout(Duration::from_secs(5), self.ws.next()).await.expect("no frame within 5 s") {
                Some(Ok(Message::Binary(bytes))) => return Ok(bytes.to_vec()),
                Some(Ok(Message::Close(frame))) => return Err(frame.map(|f| u16::from(f.code))),
                Some(Ok(_)) => {}
                None | Some(Err(_)) => return Err(None),
            }
        }
    }

    /// Every response frame of one request: `more` parts, then `ok` or `error`.
    pub async fn call<T: Serialize>(&mut self, kind_: &str, payload: &T) -> Vec<Vec<u8>> {
        let id = self.next_id;
        self.next_id += 1;
        self.ws.send(Message::binary(chat_protocol::encode(kind_, id, payload))).await.unwrap();
        let mut frames = Vec::new();
        loop {
            let frame = self.frame().await.expect("socket closed");
            let parsed = InFrame::parse(&frame).unwrap();
            if parsed.id == chat_protocol::EVENT_ID {
                self.events.push_back((parsed.kind.to_owned(), frame));
                continue;
            }
            assert_eq!(parsed.id, id);
            let last = parsed.kind != "more";
            frames.push(frame);
            if last {
                return frames;
            }
        }
    }

    pub async fn ok<T: Serialize, R: DeserializeOwned>(&mut self, kind_: &str, payload: &T) -> R {
        let frame = self.call(kind_, payload).await.pop().unwrap();
        assert_eq!(kind(&frame), "ok", "{kind_}: {:?}", payload_error(&frame));
        self::payload(&frame)
    }

    pub async fn refused<T: Serialize>(&mut self, kind_: &str, payload: &T) -> ErrorCode {
        let frame = self.call(kind_, payload).await.pop().unwrap();
        assert_eq!(kind(&frame), "error", "{kind_} succeeded");
        self::payload::<ErrorPayload>(&frame).code
    }

    /// The next event of this type; events before it stay queued.
    pub async fn event<T: DeserializeOwned>(&mut self, kind_: &str) -> T {
        if let Some(i) = self.events.iter().position(|(k, _)| k == kind_) {
            let (_, frame) = self.events.remove(i).unwrap();
            return payload(&frame);
        }
        loop {
            let frame = self.frame().await.expect("socket closed");
            let k = kind(&frame);
            if k == kind_ {
                return payload(&frame);
            }
            self.events.push_back((k, frame));
        }
    }

    /// Events up to and including the end of the turn, in order.
    pub async fn until_turn_end(&mut self) -> Vec<(String, Vec<u8>)> {
        let mut seen: Vec<(String, Vec<u8>)> = self.events.drain(..).collect();
        while !seen.iter().any(|(k, _)| k == "turn.done" || k == "turn.error") {
            let frame = self.frame().await.expect("socket closed");
            seen.push((kind(&frame), frame));
        }
        seen
    }

    pub async fn start_agent(&mut self, llm: &FakeLlm) -> Uuid {
        self.start_agents(&[(PROVIDER, agent_provider(llm))], PROVIDER).await
    }

    /// Starts a session holding these provider configs by id.
    pub async fn start_agents(&mut self, providers: &[(Uuid, serde_json::Value)], active: Uuid) -> Uuid {
        let providers: Vec<serde_json::Value> = providers
            .iter()
            .map(|(id, p)| {
                let mut entry = p.clone();
                entry["id"] = json!(id);
                entry
            })
            .collect();
        let started: chat_protocol::agent::AgentStarted =
            self.ok("agent.start", &json!({ "providers": providers, "active": active })).await;
        started.agent_session_id
    }
}

/// The id of the provider [`Client::start_agent`] starts with.
pub const PROVIDER: Uuid = Uuid::from_u128(0x0190_0000_0000_7000_8000_0000_0000_0001);

/// The provider config [`Client::start_agent`] starts with.
pub fn agent_provider(llm: &FakeLlm) -> serde_json::Value {
    json!({ "kind": "openai_compatible", "base_url": llm.openai_url(), "api_key": "", "model": "m" })
}

/// The `agent.retire` payload for these provider configs of the user.
pub fn retire(user: &Principal, providers: &[serde_json::Value]) -> AgentRetire {
    let fingerprint = |p: &serde_json::Value| {
        chat_server::agent::fingerprint(user.user_id, &serde_json::from_value(p.clone()).unwrap())
    };
    AgentRetire { fingerprints: providers.iter().map(|p| Bytes(fingerprint(p).to_vec())).collect() }
}

pub fn payload_error(frame: &[u8]) -> Option<ErrorCode> {
    InFrame::parse(frame).unwrap().payload::<ErrorPayload>().ok().map(|e| e.code)
}
