//! Chats over a real socket against the fake LLM (docs/protocol.md, "Chats
//! and messages"): sending, streaming, chunks, edits, pins, archive, turns.

#![allow(clippy::unwrap_used, clippy::expect_used, reason = "tests fail loudly")]

mod support;

use std::{collections::VecDeque, net::SocketAddr, sync::Arc, time::Duration};

use chat_crypto::{
    ark::Ark,
    ids::{ScopeId, UserId},
    os_rng,
    record::{self, Kind, Place},
    scope::ScopeKeyPair,
};
use chat_protocol::{
    Bytes, InFrame,
    chat::{
        Author, ChatInfo, ChatPage, ChunkList, ContextMessage, MessageContent, MessageCreated, MessageDeleted,
        MessageEdit, MessageSend, MessageSent, MessageState, MessageUpdated, Revision, Role, TurnContext, TurnDone,
        TurnError, TurnErrorCode,
    },
    error::{ErrorCode, ErrorPayload},
    keys::{AccountScopeKind, KeysSetup, NewAccountScope},
    redact::Secret,
};
use chat_server::{
    app::{self, AppState},
    auth::{Principal, Provider, client::ClientInfo},
    config::Config,
    keys,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::json;
use sqlx::PgPool;
use support::fake_llm::{FakeLlm, Reply};
use time::OffsetDateTime;
use tokio::net::TcpStream;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream,
    tungstenite::{Message, client::IntoClientRequest},
};
use uuid::Uuid;

const CLIENT: ClientInfo = ClientInfo { ip: None, country: None, user_agent: None };

struct Env {
    db: PgPool,
    state: AppState,
    addr: SocketAddr,
    llm: FakeLlm,
}

async fn start(db: PgPool) -> Env {
    let config = Config::from_lookup(|name| match name {
        "CHAT_DATABASE_URL" => Some("postgres://unused".to_owned()),
        // The fake listens on loopback, which only an operator allowlist admits.
        "CHAT_PROVIDER_ALLOWED_NETWORKS" => Some("127.0.0.0/8".to_owned()),
        _ => None,
    })
    .unwrap();
    let (stop, stopped) = tokio::sync::watch::channel(());
    std::mem::forget(stop);
    let state = AppState::new(config, db.clone(), Arc::new(support::auth().0), stopped);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let router = app::router(state.clone());
    tokio::spawn(async move {
        axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>()).await.unwrap();
    });
    Env { db, state, addr, llm: FakeLlm::start().await }
}

struct User {
    principal: Principal,
    ark: Ark,
}

impl User {
    fn id(&self) -> UserId {
        UserId::from_bytes(*self.principal.user_id.as_bytes())
    }
}

async fn session(db: &PgPool, user: Uuid) -> Principal {
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
async fn user(db: &PgPool) -> User {
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

/// A chat's scope keys, made the way a client makes them.
struct NewChat {
    id: Uuid,
    keys: ScopeKeyPair,
}

impl NewChat {
    fn new() -> Self {
        Self { id: Uuid::now_v7(), keys: ScopeKeyPair::generate(1, &mut os_rng()) }
    }

    fn place(&self, user: &User, kind: Kind<'static>) -> Place<'static> {
        Place { user: user.id(), scope: ScopeId::from_bytes(*self.id.as_bytes()), kind }
    }

    fn payload(&self, user: &User) -> chat_protocol::chat::NewChat {
        let scope = ScopeId::from_bytes(*self.id.as_bytes());
        let title = record::seal_as_client(
            &self.place(user, Kind::ChatTitle),
            &self.keys.public(),
            &user.ark.writer_key(&user.id()),
            b"A title",
            &mut os_rng(),
        )
        .unwrap();
        chat_protocol::chat::NewChat {
            public_key: Bytes(self.keys.public().key.as_bytes().to_vec()),
            wrapped_private_key: Bytes(self.keys.wrap(&user.ark, &user.id(), &scope, &mut os_rng())),
            title: Some(Bytes(title)),
        }
    }

    /// The text of a message record, and whether a client sealed it.
    fn open(&self, user: &User, id: u32, author: record::Author, sealed: &Bytes) -> (String, record::Origin) {
        let writer = user.ark.writer_key(&user.id()).public();
        let place = self.place(user, Kind::ChatMessage { message_id: id, author });
        let (plain, origin) = record::open(&place, &self.keys, &writer, &sealed.0).unwrap();
        (MessageContent::decode(&plain).unwrap().text, origin)
    }

    fn edit(&self, user: &User, id: u32, text: &str) -> Vec<u8> {
        let place = self.place(user, Kind::ChatMessage { message_id: id, author: record::Author::User });
        let content = MessageContent { text: text.into() }.encode();
        record::seal_as_client(&place, &self.keys.public(), &user.ark.writer_key(&user.id()), &content, &mut os_rng())
            .unwrap()
    }
}

/// One socket: requests with their response frames, events kept in order.
struct Client {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
    next_id: u32,
    events: VecDeque<(String, Vec<u8>)>,
}

fn payload<T: DeserializeOwned>(frame: &[u8]) -> T {
    InFrame::parse(frame).unwrap().payload().unwrap()
}

fn kind(frame: &[u8]) -> String {
    InFrame::parse(frame).unwrap().kind.to_owned()
}

impl Client {
    async fn connect(env: &Env, principal: &Principal, resume: Option<Uuid>) -> (Self, Vec<u8>) {
        let mut request = format!("ws://{}/ws", env.addr).into_client_request().unwrap();
        request.headers_mut().insert("origin", support::ORIGIN.parse().unwrap());
        let (ws, _) = tokio_tungstenite::connect_async(request).await.unwrap();
        let mut client = Self { ws, next_id: 1, events: VecDeque::new() };
        let token = support::token(&env.state.auth, principal.user_id, principal.session_id, 600);
        let mut auth = json!({ "v": 1, "access_token": token });
        if let Some(id) = resume {
            auth["resume"] = json!({ "agent_session_id": id });
        }
        let ok = client.call("auth", &auth).await.pop().unwrap();
        assert_eq!(kind(&ok), "ok");
        (client, ok)
    }

    async fn frame(&mut self) -> Result<Vec<u8>, Option<u16>> {
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
    async fn call<T: Serialize>(&mut self, kind_: &str, payload: &T) -> Vec<Vec<u8>> {
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

    async fn ok<T: Serialize, R: DeserializeOwned>(&mut self, kind_: &str, payload: &T) -> R {
        let frame = self.call(kind_, payload).await.pop().unwrap();
        assert_eq!(kind(&frame), "ok", "{kind_}: {:?}", payload_error(&frame));
        self::payload(&frame)
    }

    async fn refused<T: Serialize>(&mut self, kind_: &str, payload: &T) -> ErrorCode {
        let frame = self.call(kind_, payload).await.pop().unwrap();
        assert_eq!(kind(&frame), "error", "{kind_} succeeded");
        self::payload::<ErrorPayload>(&frame).code
    }

    /// The next event of this type; events before it stay queued.
    async fn event<T: DeserializeOwned>(&mut self, kind_: &str) -> T {
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
    async fn until_turn_end(&mut self) -> Vec<(String, Vec<u8>)> {
        let mut seen: Vec<(String, Vec<u8>)> = self.events.drain(..).collect();
        while !seen.iter().any(|(k, _)| k == "turn.done" || k == "turn.error") {
            let frame = self.frame().await.expect("socket closed");
            seen.push((kind(&frame), frame));
        }
        seen
    }

    async fn start_agent(&mut self, llm: &FakeLlm) -> Uuid {
        let provider =
            json!({ "kind": "openai_compatible", "base_url": llm.openai_url(), "api_key": "", "model": "m" });
        let started: chat_protocol::agent::AgentStarted =
            self.ok("agent.start", &json!({ "provider": provider })).await;
        started.agent_session_id
    }
}

fn payload_error(frame: &[u8]) -> Option<ErrorCode> {
    InFrame::parse(frame).unwrap().payload::<ErrorPayload>().ok().map(|e| e.code)
}

fn send(chat: &NewChat, user: &User, new: bool, text: &str, key: Uuid) -> MessageSend {
    MessageSend {
        idempotency_key: key,
        chat_id: chat.id,
        new_chat: new.then(|| chat.payload(user)),
        text: Secret(text.into()),
        context: TurnContext {
            summary: Some(Secret("Earlier talk".into())),
            messages: vec![ContextMessage { id: 0, role: Role::Assistant, text: Secret("Before".into()) }],
        },
    }
}

fn edit(chat: Uuid, message_id: u32, record: Vec<u8>) -> MessageEdit {
    MessageEdit { chat_id: chat, message_id, record: Bytes(record) }
}

async fn audit_kinds(db: &PgPool, user: Uuid) -> Vec<String> {
    sqlx::query_scalar("SELECT kind FROM audit_events WHERE user_id = $1 AND kind LIKE 'chat.%' ORDER BY id")
        .bind(user)
        .fetch_all(db)
        .await
        .unwrap()
}

#[sqlx::test]
async fn a_first_message_creates_the_chat_and_streams_the_reply(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    let other_session = session(&env.db, user.principal.user_id).await;
    let (mut b, _) = Client::connect(&env, &other_session, None).await;
    let stranger = self::user(&env.db).await;
    let (mut c, _) = Client::connect(&env, &stranger.principal, None).await;
    a.start_agent(&env.llm).await;
    env.llm.push(Reply::text(&["Good ", "morning", "!"]));

    let chat = NewChat::new();
    let sent: MessageSent = a.ok("message.send", &send(&chat, &user, true, "Hello", Uuid::now_v7())).await;
    assert_eq!(sent.message_id, 0);
    let events = a.until_turn_end().await;
    let kinds: Vec<&str> = events.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(kinds.first(), Some(&"message.created"));
    assert_eq!(kinds.last(), Some(&"turn.done"));

    // The user's message and the reply are sealed to the chat, by the server.
    let created: Vec<MessageCreated> =
        events.iter().filter(|(k, _)| k == "message.created").map(|(_, f)| payload(f)).collect();
    assert_eq!(created.len(), 2);
    let (text, origin) = chat.open(&user, 0, record::Author::User, created[0].message.record.as_ref().unwrap());
    assert_eq!((text.as_str(), origin), ("Hello", record::Origin::Server));
    assert_eq!((created[1].message.id, created[1].message.author), (1, Author::Assistant));
    let deltas: String = events
        .iter()
        .filter(|(k, _)| k == "message.delta")
        .map(|(_, f)| payload::<chat_protocol::chat::MessageDelta>(f).text.0)
        .collect();
    let first = chat.open(&user, 1, record::Author::Assistant, created[1].message.record.as_ref().unwrap()).0;
    assert_eq!(format!("{first}{deltas}"), "Good morning!");
    let last: MessageUpdated =
        events.iter().rev().find(|(k, _)| k == "message.updated").map(|(_, f)| payload(f)).unwrap();
    assert_eq!(last.message.state, MessageState::Complete);
    let text = chat.open(&user, 1, record::Author::Assistant, last.message.record.as_ref().unwrap()).0;
    assert_eq!(text, "Good morning!");
    let done: TurnDone = payload(&events.last().unwrap().1);
    assert_eq!((done.chat_id, done.turn_id), (chat.id, sent.turn_id));

    // The provider got the summary, the context and the message.
    let body = &env.llm.requests()[0].body;
    let messages = body["messages"].as_array().unwrap();
    assert!(messages[0]["content"].as_str().unwrap().contains("Earlier talk"));
    assert_eq!(messages[1]["content"], "Before");
    assert_eq!(messages[2]["content"], "Hello");

    // Another session of the account follows along; another account hears nothing.
    let done_b: TurnDone = b.event("turn.done").await;
    assert_eq!(done_b.turn_id, sent.turn_id);
    c.ok::<_, serde_json::Value>("ping", &json!({})).await;
    assert!(c.events.is_empty(), "another account got {:?}", c.events.iter().map(|(k, _)| k).collect::<Vec<_>>());

    let page: ChatPage = a.ok("chat.list", &json!({})).await;
    assert_eq!(page.chats.len(), 1);
    let info: &ChatInfo = &page.chats[0];
    assert_eq!((info.chat_id, info.last_message_id, info.turn), (chat.id, 1, false));
    assert!(info.title.is_some());
    assert_eq!(audit_kinds(&env.db, user.principal.user_id).await, ["chat.created"]);
    // The chat's scope stays out of the account scopes.
    let state = keys::get(&env.db, &user.principal).await.unwrap();
    assert_eq!(state.keys.unwrap().scopes.len(), AccountScopeKind::ALL.len());
}

#[sqlx::test]
async fn a_resend_returns_the_first_result_and_runs_no_second_turn(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    let chat = NewChat::new();
    let key = Uuid::now_v7();
    // Without an agent session nothing is stored.
    assert_eq!(a.refused("message.send", &send(&chat, &user, true, "Hi", key)).await, ErrorCode::AgentNotStarted);
    a.start_agent(&env.llm).await;
    let first: MessageSent = a.ok("message.send", &send(&chat, &user, true, "Hi", key)).await;
    a.until_turn_end().await;
    let again: MessageSent = a.ok("message.send", &send(&chat, &user, true, "Hi", key)).await;
    assert_eq!((again.message_id, again.turn_id), (first.message_id, first.turn_id));
    // A second turn would have called the provider by now.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(env.llm.requests().len(), 1);
    // A new chat with the id of an existing one is refused.
    assert_eq!(a.refused("message.send", &send(&chat, &user, true, "Hi", Uuid::now_v7())).await, ErrorCode::ChatExists);
    let big = "x".repeat(chat_protocol::chat::TEXT_MAX + 1);
    let too_big = send(&chat, &user, false, &big, Uuid::now_v7());
    assert_eq!(a.refused("message.send", &too_big).await, ErrorCode::MessageTooLarge);
}

#[sqlx::test]
async fn chunks_edits_and_tombstones_follow_revisions(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    a.start_agent(&env.llm).await;
    let chat = NewChat::new();
    a.ok::<_, MessageSent>("message.send", &send(&chat, &user, true, "One", Uuid::now_v7())).await;
    a.until_turn_end().await;

    let all: ChunkList =
        a.ok("message.chunks", &json!({ "chat_id": chat.id, "chunks": [{ "chunk": 0 }, { "chunk": 1 }] })).await;
    let (zero, one) = (&all.chunks[0], &all.chunks[1]);
    assert_eq!((zero.chunk, zero.messages.len()), (0, 2));
    assert_eq!((one.chunk, one.messages.len(), one.rev), (1, 0, 0));
    let rev = zero.rev;
    let none: ChunkList =
        a.ok("message.chunks", &json!({ "chat_id": chat.id, "chunks": [{ "chunk": 0, "rev": rev }] })).await;
    assert!(none.chunks[0].messages.is_empty());

    // The user edits their message: the client's record, sealed in auth mode.
    let record = chat.edit(&user, 0, "Uno");
    let edited: Revision = a.ok("message.edit", &edit(chat.id, 0, record.clone())).await;
    assert!(edited.rev > rev);
    let updated: MessageUpdated = a.event("message.updated").await;
    assert!(updated.message.edited_at.is_some());
    let (text, origin) = chat.open(&user, 0, record::Author::User, updated.message.record.as_ref().unwrap());
    assert_eq!((text.as_str(), origin), ("Uno", record::Origin::Client));
    let changed: ChunkList =
        a.ok("message.chunks", &json!({ "chat_id": chat.id, "chunks": [{ "chunk": 0, "rev": rev }] })).await;
    assert_eq!(changed.chunks[0].messages.iter().map(|m| m.id).collect::<Vec<_>>(), [0]);

    let reply_edit = edit(chat.id, 1, record.clone());
    assert_eq!(a.refused("message.edit", &reply_edit).await, ErrorCode::MessageNotEditable);
    // A record of another key version is refused.
    let mut wrong = chat.edit(&user, 0, "x");
    wrong[2..6].copy_from_slice(&2u32.to_be_bytes());
    let wrong = edit(chat.id, 0, wrong);
    assert_eq!(a.refused("message.edit", &wrong).await, ErrorCode::Malformed);

    let deleted: Revision = a.ok("message.delete", &json!({ "chat_id": chat.id, "message_id": 1 })).await;
    let event: MessageDeleted = a.event("message.deleted").await;
    assert_eq!((event.message_id, event.rev), (1, deleted.rev));
    let again: Revision = a.ok("message.delete", &json!({ "chat_id": chat.id, "message_id": 1 })).await;
    assert_eq!(again.rev, deleted.rev);
    let tomb: ChunkList = a.ok("message.chunks", &json!({ "chat_id": chat.id, "chunks": [{ "chunk": 0 }] })).await;
    let tombstone = &tomb.chunks[0].messages[1];
    assert!(tombstone.record.is_none() && tombstone.deleted_at.is_some());
    let edit_tomb = edit(chat.id, 1, record);
    assert_eq!(a.refused("message.edit", &edit_tomb).await, ErrorCode::MessageNotFound);

    // Another account sees none of it.
    let stranger = self::user(&env.db).await;
    let (mut c, _) = Client::connect(&env, &stranger.principal, None).await;
    let theirs = json!({ "chat_id": chat.id, "chunks": [{ "chunk": 0 }] });
    assert_eq!(c.refused("message.chunks", &theirs).await, ErrorCode::ChatNotFound);
    assert_eq!(
        c.refused("message.delete", &json!({ "chat_id": chat.id, "message_id": 0 })).await,
        ErrorCode::ChatNotFound
    );
}

#[sqlx::test]
async fn cancel_ends_a_streaming_reply_and_frees_the_chat(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    a.start_agent(&env.llm).await;
    env.llm.push(Reply::endless(&["Thinking", " more"]));
    let chat = NewChat::new();
    let sent: MessageSent = a.ok("message.send", &send(&chat, &user, true, "Go", Uuid::now_v7())).await;
    let reply: MessageCreated = loop {
        let created: MessageCreated = a.event("message.created").await;
        if created.message.author == Author::Assistant {
            break created;
        }
    };
    assert_eq!(reply.message.state, MessageState::Streaming);
    assert_eq!(
        a.refused("message.send", &send(&chat, &user, false, "Again", Uuid::now_v7())).await,
        ErrorCode::TurnBusy
    );
    assert_eq!(
        a.refused("message.delete", &json!({ "chat_id": chat.id, "message_id": 1 })).await,
        ErrorCode::MessageStreaming
    );

    // A snapshot stores the text so far while the reply streams.
    let snapshot: MessageUpdated = a.event("message.updated").await;
    assert_eq!((snapshot.message.state, snapshot.message.seq), (MessageState::Streaming, Some(2)));
    a.ok::<_, serde_json::Value>("turn.cancel", &json!({ "chat_id": chat.id })).await;
    let events = a.until_turn_end().await;
    let done: TurnDone = payload(&events.last().unwrap().1);
    assert_eq!(done.turn_id, sent.turn_id);
    let last: MessageUpdated =
        events.iter().rev().find(|(k, _)| k == "message.updated").map(|(_, f)| payload(f)).unwrap();
    assert_eq!(last.message.state, MessageState::Cancelled);
    assert_eq!(
        chat.open(&user, 1, record::Author::Assistant, last.message.record.as_ref().unwrap()).0,
        "Thinking more"
    );
    a.ok::<_, MessageSent>("message.send", &send(&chat, &user, false, "Again", Uuid::now_v7())).await;
    a.until_turn_end().await;
}

#[sqlx::test]
async fn a_provider_error_ends_the_turn_without_a_reply(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    a.start_agent(&env.llm).await;
    env.llm.push(Reply { error: Some((401, r#"{"error":{"message":"bad key"}}"#.into())), ..Reply::default() });
    let chat = NewChat::new();
    a.ok::<_, MessageSent>("message.send", &send(&chat, &user, true, "Hi", Uuid::now_v7())).await;
    let events = a.until_turn_end().await;
    let error: TurnError = payload(&events.last().unwrap().1);
    assert_eq!(error.code, TurnErrorCode::ProviderRefused);
    assert!(!events.iter().any(|(k, f)| k == "message.created" && payload::<MessageCreated>(f).message.id == 1));
    let page: ChatPage = a.ok("chat.list", &json!({})).await;
    assert!(!page.chats[0].turn);
}

#[sqlx::test]
async fn a_stale_turn_is_failed_by_the_next_send(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    a.start_agent(&env.llm).await;
    let chat = NewChat::new();
    a.ok::<_, MessageSent>("message.send", &send(&chat, &user, true, "Hi", Uuid::now_v7())).await;
    a.until_turn_end().await;
    // As if the replica running a turn died mid-reply: its lease ran out.
    sqlx::query("UPDATE chats SET turn_id = $2, turn_expires_at = now() - interval '1 second' WHERE id = $1")
        .bind(chat.id)
        .bind(Uuid::now_v7())
        .execute(&env.db)
        .await
        .unwrap();
    sqlx::query("UPDATE messages SET state = 2 WHERE chat_id = $1 AND id = 1")
        .bind(chat.id)
        .execute(&env.db)
        .await
        .unwrap();
    a.ok::<_, MessageSent>("message.send", &send(&chat, &user, false, "Again", Uuid::now_v7())).await;
    let failed: MessageUpdated = a.event("message.updated").await;
    assert_eq!((failed.message.id, failed.message.state), (1, MessageState::Failed));
    a.until_turn_end().await;
}

#[sqlx::test]
async fn an_agent_session_moves_to_the_socket_that_resumes_it(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    let id = a.start_agent(&env.llm).await;
    let (mut b, ok) = Client::connect(&env, &user.principal, Some(id)).await;
    assert_eq!(payload::<chat_protocol::connection::AuthOk>(&ok).agent_session_id, Some(id));
    assert_eq!(a.frame().await.err(), Some(Some(4009)));
    let chat = NewChat::new();
    b.ok::<_, MessageSent>("message.send", &send(&chat, &user, true, "Hi", Uuid::now_v7())).await;
    b.until_turn_end().await;
    // Another session cannot pick it up.
    let other = session(&env.db, user.principal.user_id).await;
    let (_, ok) = Client::connect(&env, &other, Some(id)).await;
    assert_eq!(payload::<chat_protocol::connection::AuthOk>(&ok).agent_session_id, None);
    // A provider the server refuses is not started.
    let bad = json!({ "provider": { "kind": "anthropic", "base_url": "not a url", "api_key": "", "model": "m" } });
    assert_eq!(b.refused("agent.start", &bad).await, ErrorCode::AgentInvalidProvider);
}

/// Inserts a chat with one message directly, at the given activity time.
async fn bare_chat(db: &PgPool, user: Uuid, updated_at: i64) -> Uuid {
    let id = Uuid::now_v7();
    sqlx::query("INSERT INTO scopes (id, user_id, kind) VALUES ($1, $2, 'chat')")
        .bind(id)
        .bind(user)
        .execute(db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO chats (id, user_id, next_message_id, updated_at) VALUES ($1, $2, 1, $3)")
        .bind(id)
        .bind(user)
        .bind(updated_at)
        .execute(db)
        .await
        .unwrap();
    id
}

#[sqlx::test]
async fn the_list_pages_pins_and_archives(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let uid = user.principal.user_id;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    // Ties on `updated_at` still page without gaps or repeats.
    let mut ids = Vec::new();
    for i in 0..140 {
        ids.push(bare_chat(&env.db, uid, 1_000 + i / 3).await);
    }
    let first: ChatPage = a.ok("chat.list", &json!({})).await;
    assert_eq!(first.chats.len(), 100);
    let second: ChatPage = a.ok("chat.list", &json!({ "before": first.next.clone().unwrap() })).await;
    assert_eq!((second.chats.len(), second.next.is_none()), (40, true));
    let mut seen: Vec<Uuid> = first.chats.iter().chain(&second.chats).map(|c| c.chat_id).collect();
    seen.sort();
    seen.dedup();
    assert_eq!(seen.len(), 140);

    // Pinning at a position shifts the rest; the 33rd pinned falls off the end.
    for (i, id) in ids.iter().take(32).enumerate() {
        a.ok::<_, serde_json::Value>("chat.pin", &json!({ "chat_id": id, "position": i })).await;
    }
    a.ok::<_, serde_json::Value>("chat.pin", &json!({ "chat_id": ids[100], "position": 1 })).await;
    let page: ChatPage = a.ok("chat.list", &json!({})).await;
    let pinned: Vec<(Uuid, Option<u8>)> = page.chats.iter().take(33).map(|c| (c.chat_id, c.pin)).collect();
    assert_eq!(pinned[0], (ids[0], Some(0)));
    assert_eq!(pinned[1], (ids[100], Some(1)));
    assert_eq!(pinned[2], (ids[1], Some(2)));
    assert_eq!(pinned[31], (ids[30], Some(31)));
    assert_eq!(pinned[32].1, None, "only 32 stay pinned");
    let pin: Option<i16> =
        sqlx::query_scalar("SELECT pin FROM chats WHERE id = $1").bind(ids[31]).fetch_one(&env.db).await.unwrap();
    assert_eq!(pin, None, "the last pinned chat was pushed out");
    assert_eq!(page.chats.len(), 32 + 100);

    // Archiving unpins and closes the gap; an archived chat cannot be pinned.
    a.ok::<_, serde_json::Value>("chat.archive", &json!({ "chat_id": ids[100], "archived": true })).await;
    let page: ChatPage = a.ok("chat.list", &json!({})).await;
    assert_eq!((page.chats[1].chat_id, page.chats[1].pin), (ids[1], Some(1)));
    assert!(!page.chats.iter().any(|c| c.chat_id == ids[100]));
    assert_eq!(a.refused("chat.pin", &json!({ "chat_id": ids[100], "position": 0 })).await, ErrorCode::ChatArchived);
    let archive: ChatPage = a.ok("chat.list", &json!({ "archived": true })).await;
    assert_eq!(archive.chats.iter().map(|c| c.chat_id).collect::<Vec<_>>(), [ids[100]]);

    // Only an archived chat is deleted, with everything in it.
    assert_eq!(a.refused("chat.delete", &json!({ "chat_id": ids[1] })).await, ErrorCode::ChatNotArchived);
    a.ok::<_, serde_json::Value>("chat.delete", &json!({ "chat_id": ids[100] })).await;
    let deleted: chat_protocol::chat::ChatDeleted = a.event("chat.deleted").await;
    assert_eq!(deleted.chat_id, ids[100]);
    let scopes: i64 = sqlx::query_scalar("SELECT count(*) FROM scopes WHERE id = $1")
        .bind(ids[100])
        .fetch_one(&env.db)
        .await
        .unwrap();
    assert_eq!(scopes, 0);
    assert_eq!(audit_kinds(&env.db, uid).await, ["chat.archived", "chat.deleted"]);

    // Unpinning closes the gap too.
    a.ok::<_, serde_json::Value>("chat.pin", &json!({ "chat_id": ids[0] })).await;
    let page: ChatPage = a.ok("chat.list", &json!({})).await;
    assert_eq!((page.chats[0].chat_id, page.chats[0].pin), (ids[1], Some(0)));
}

#[sqlx::test]
async fn a_message_brings_a_chat_back_from_the_archive(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    a.start_agent(&env.llm).await;
    let chat = NewChat::new();
    a.ok::<_, MessageSent>("message.send", &send(&chat, &user, true, "Hi", Uuid::now_v7())).await;
    a.until_turn_end().await;
    a.ok::<_, serde_json::Value>("chat.archive", &json!({ "chat_id": chat.id, "archived": true })).await;
    a.ok::<_, MessageSent>("message.send", &send(&chat, &user, false, "Back", Uuid::now_v7())).await;
    a.until_turn_end().await;
    let page: ChatPage = a.ok("chat.list", &json!({})).await;
    assert_eq!(page.chats[0].chat_id, chat.id);
    assert!(page.chats[0].archived_at.is_none());
    let kinds = audit_kinds(&env.db, user.principal.user_id).await;
    assert_eq!(kinds, ["chat.created", "chat.archived", "chat.unarchived"]);
}

#[sqlx::test]
async fn copies_of_one_send_racing_get_one_result(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let other = session(&env.db, user.principal.user_id).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    let (mut b, _) = Client::connect(&env, &other, None).await;
    a.start_agent(&env.llm).await;
    b.start_agent(&env.llm).await;
    let chat = NewChat::new();
    let key = Uuid::now_v7();
    let (first, second) = (send(&chat, &user, true, "Hi", key), send(&chat, &user, true, "Hi", key));
    let (x, y): (MessageSent, MessageSent) = tokio::join!(a.ok("message.send", &first), b.ok("message.send", &second));
    assert_eq!((x.message_id, x.turn_id), (y.message_id, y.turn_id));
}

#[sqlx::test]
async fn renames_and_unarchiving_reach_the_list_with_a_higher_rev(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    a.start_agent(&env.llm).await;
    let chat = NewChat::new();
    a.ok::<_, MessageSent>("message.send", &send(&chat, &user, true, "Hi", Uuid::now_v7())).await;
    a.until_turn_end().await;
    let before: ChatPage = a.ok("chat.list", &json!({})).await;
    let title = record::seal_as_client(
        &chat.place(&user, Kind::ChatTitle),
        &chat.keys.public(),
        &user.ark.writer_key(&user.id()),
        b"Renamed",
        &mut os_rng(),
    )
    .unwrap();
    let rename = chat_protocol::chat::ChatRename { chat_id: chat.id, title: Bytes(title.clone()) };
    a.ok::<_, serde_json::Value>("chat.rename", &rename).await;
    let updated: chat_protocol::chat::ChatUpdated = a.event("chat.updated").await;
    assert_eq!(updated.chat.title, Some(Bytes(title)));
    assert!(updated.chat.rev > before.chats[0].rev);
    let bad = chat_protocol::chat::ChatRename { chat_id: chat.id, title: Bytes(vec![1; 10]) };
    assert_eq!(a.refused("chat.rename", &bad).await, ErrorCode::Malformed);

    a.ok::<_, serde_json::Value>("chat.archive", &json!({ "chat_id": chat.id, "archived": true })).await;
    a.ok::<_, serde_json::Value>("chat.archive", &json!({ "chat_id": chat.id, "archived": false })).await;
    let page: ChatPage = a.ok("chat.list", &json!({})).await;
    assert_eq!((page.chats[0].chat_id, page.chats[0].archived_at), (chat.id, None));
    assert!(page.chats[0].rev > updated.chat.rev);
}

#[sqlx::test]
async fn an_account_without_keys_has_no_chats_to_change(db: PgPool) {
    let env = start(db).await;
    let id = Uuid::now_v7();
    sqlx::query("INSERT INTO users (id) VALUES ($1)").bind(id).execute(&env.db).await.unwrap();
    let principal = session(&env.db, id).await;
    let (mut a, _) = Client::connect(&env, &principal, None).await;
    let chat = Uuid::now_v7();
    assert_eq!(a.refused("chat.pin", &json!({ "chat_id": chat, "position": 0 })).await, ErrorCode::KeysNotSetUp);
    let page: ChatPage = a.ok("chat.list", &json!({})).await;
    assert!(page.chats.is_empty());
}

#[sqlx::test]
async fn deleting_a_chat_mid_turn_stops_the_turn(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    a.start_agent(&env.llm).await;
    env.llm.push(Reply::endless(&["Long"]));
    let chat = NewChat::new();
    a.ok::<_, MessageSent>("message.send", &send(&chat, &user, true, "Go", Uuid::now_v7())).await;
    loop {
        let created: MessageCreated = a.event("message.created").await;
        if created.message.author == Author::Assistant {
            break;
        }
    }
    a.ok::<_, serde_json::Value>("chat.archive", &json!({ "chat_id": chat.id, "archived": true })).await;
    a.ok::<_, serde_json::Value>("chat.delete", &json!({ "chat_id": chat.id })).await;
    let deleted: chat_protocol::chat::ChatDeleted = a.event("chat.deleted").await;
    assert_eq!(deleted.chat_id, chat.id);
    // The turn ends without writing anything back.
    tokio::time::sleep(Duration::from_millis(2500)).await;
    for table in ["chats", "messages"] {
        let n: i64 = sqlx::query_scalar(if table == "chats" {
            "SELECT count(*) FROM chats WHERE id = $1"
        } else {
            "SELECT count(*) FROM messages WHERE chat_id = $1"
        })
        .bind(chat.id)
        .fetch_one(&env.db)
        .await
        .unwrap();
        assert_eq!(n, 0, "{table}");
    }
    assert_eq!(
        a.refused("message.send", &send(&chat, &user, false, "Hi", Uuid::now_v7())).await,
        ErrorCode::ChatNotFound
    );
}

#[sqlx::test]
async fn revoking_the_session_interrupts_its_turn(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    let watcher = session(&env.db, user.principal.user_id).await;
    let (mut b, _) = Client::connect(&env, &watcher, None).await;
    a.start_agent(&env.llm).await;
    env.llm.push(Reply::endless(&["Long"]));
    let chat = NewChat::new();
    let sent: MessageSent = a.ok("message.send", &send(&chat, &user, true, "Go", Uuid::now_v7())).await;
    env.state.auth.store.revoke(user.principal.session_id, Duration::from_secs(60)).await.unwrap();
    let error: TurnError = b.event("turn.error").await;
    assert_eq!((error.turn_id, error.code), (sent.turn_id, TurnErrorCode::Interrupted));
}

#[sqlx::test]
async fn a_reply_past_the_limit_fails(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    a.start_agent(&env.llm).await;
    let part = "y".repeat(70 * 1024);
    env.llm.push(Reply::text(&[&part, &part, &part]));
    let chat = NewChat::new();
    a.ok::<_, MessageSent>("message.send", &send(&chat, &user, true, "Go", Uuid::now_v7())).await;
    let events = a.until_turn_end().await;
    let error: TurnError = payload(&events.last().unwrap().1);
    assert_eq!(error.code, TurnErrorCode::TooLong);
    let last: MessageUpdated =
        events.iter().rev().find(|(k, _)| k == "message.updated").map(|(_, f)| payload(f)).unwrap();
    assert_eq!(last.message.state, MessageState::Failed);
    let text = chat.open(&user, 1, record::Author::Assistant, last.message.record.as_ref().unwrap()).0;
    assert_eq!(text.len(), 140 * 1024);
}

#[sqlx::test]
async fn a_reset_on_the_bus_reaches_the_sockets(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    env.state.bus.publish(chat_server::bus::Note::Reset).await;
    let _: chat_protocol::chat::SyncReset = a.event("sync.reset").await;
}

#[sqlx::test]
async fn a_database_hiccup_mid_turn_does_not_lose_the_turn(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    a.start_agent(&env.llm).await;
    env.llm.push(Reply::endless(&["Long", " reply"]));
    let chat = NewChat::new();
    let sent: MessageSent = a.ok("message.send", &send(&chat, &user, true, "Go", Uuid::now_v7())).await;
    loop {
        let created: MessageCreated = a.event("message.created").await;
        if created.message.author == Author::Assistant {
            break;
        }
    }
    // Snapshots fail while every message write is refused, then the turn carries on.
    sqlx::query("ALTER TABLE messages ADD CONSTRAINT hiccup CHECK (false) NOT VALID").execute(&env.db).await.unwrap();
    tokio::time::sleep(Duration::from_millis(2500)).await;
    sqlx::query("ALTER TABLE messages DROP CONSTRAINT hiccup").execute(&env.db).await.unwrap();
    a.ok::<_, serde_json::Value>("turn.cancel", &json!({ "chat_id": chat.id })).await;
    let events = a.until_turn_end().await;
    let done: TurnDone = payload(&events.last().unwrap().1);
    assert_eq!(done.turn_id, sent.turn_id);
    let last: MessageUpdated =
        events.iter().rev().find(|(k, _)| k == "message.updated").map(|(_, f)| payload(f)).unwrap();
    assert_eq!(last.message.state, MessageState::Cancelled);
}
