//! Chats over a real socket against the fake LLM (docs/protocol.md, "Chats
//! and messages"): sending, streaming, chunks, edits, pins, archive, turns.

#![allow(clippy::unwrap_used, clippy::expect_used, reason = "tests fail loudly")]

mod support;

use std::time::Duration;

use chat_crypto::{
    ids::ScopeId,
    os_rng,
    record::{self, Kind, Place},
    scope::ScopeKeyPair,
};
use chat_protocol::{
    Bytes,
    agent::AgentRetire,
    chat::{
        Author, ChatInfo, ChatPage, ChatSettings, ChunkList, ContextMessage, Effort, History, MessageContent,
        MessageCreated, MessageDeleted, MessageEdit, MessageSend, MessageSent, MessageState, MessageUpdated, Revision,
        Role, TurnContext, TurnDone, TurnError, TurnErrorCode, TurnRetry, TurnStarted,
    },
    error::ErrorCode,
    keys::AccountScopeKind,
    redact::Secret,
};
use chat_server::{keys, ws::WsSettings};
use serde_json::json;
use sqlx::PgPool;
use support::{
    fake_llm::Reply,
    socket::{Client, PROVIDER, User, agent_provider, payload, retire, session, start, start_with, user},
};
use uuid::Uuid;

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
            settings: None,
        }
    }

    /// The text of a message record, and whether a client sealed it.
    fn open(&self, user: &User, id: u32, author: record::Author, sealed: &Bytes) -> (String, record::Origin) {
        let (content, origin) = self.open_content(user, id, author, sealed);
        (content.text, origin)
    }

    fn open_content(
        &self,
        user: &User,
        id: u32,
        author: record::Author,
        sealed: &Bytes,
    ) -> (MessageContent, record::Origin) {
        let writer = user.ark.writer_key(&user.id()).public();
        let place = self.place(user, Kind::ChatMessage { message_id: id, author });
        let (plain, origin) = record::open(&place, &self.keys, &writer, &sealed.0).unwrap();
        (MessageContent::decode(&plain).unwrap(), origin)
    }

    fn edit(&self, user: &User, id: u32, text: &str) -> Vec<u8> {
        let place = self.place(user, Kind::ChatMessage { message_id: id, author: record::Author::User });
        let content = MessageContent { text: text.into(), doc: None }.encode();
        record::seal_as_client(&place, &self.keys.public(), &user.ark.writer_key(&user.id()), &content, &mut os_rng())
            .unwrap()
    }
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
    let (content, origin) =
        chat.open_content(&user, 0, record::Author::User, created[0].message.record.as_ref().unwrap());
    assert_eq!((content.text.as_str(), content.doc, origin), ("Hello", None, record::Origin::Server));
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
    // The last record holds the reply as a document too; the streaming ones the text only.
    let content = chat.open_content(&user, 1, record::Author::Assistant, last.message.record.as_ref().unwrap()).0;
    assert_eq!(content.text, "Good morning!");
    assert_eq!(content.doc, Some(chat_document::from_markdown("Good morning!")));
    let created = chat.open_content(&user, 1, record::Author::Assistant, created[1].message.record.as_ref().unwrap());
    assert_eq!(created.0.doc, None);
    let done: TurnDone = payload(&events.last().unwrap().1);
    assert_eq!((done.chat_id, done.turn_id), (chat.id, sent.turn_id));

    // The provider got the summary, the context and the message.
    let body = &env.llm.requests()[0].body;
    let messages = body["messages"].as_array().unwrap();
    let system = messages[0]["content"].as_str().unwrap();
    assert!(system.contains("language chart") && system.contains("Earlier talk"));
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

fn retry(chat: &NewChat, message_id: u32, text: &str) -> TurnRetry {
    TurnRetry { chat_id: chat.id, message_id, text: Secret(text.into()), context: TurnContext::default() }
}

/// The last `message.updated` of these events.
fn last_update(events: &[(String, Vec<u8>)]) -> MessageUpdated {
    events.iter().rev().find(|(k, _)| k == "message.updated").map(|(_, f)| payload(f)).unwrap()
}

#[sqlx::test]
async fn a_provider_error_fails_the_reply_with_its_code_and_a_retry_runs_it_again(db: PgPool) {
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
    // The reply stays, failed with the code and none of the provider's text.
    let failed = last_update(&events).message;
    assert_eq!(
        (failed.id, failed.state, failed.error),
        (1, MessageState::Failed, Some(TurnErrorCode::ProviderRefused))
    );
    assert_eq!(chat.open(&user, 1, record::Author::Assistant, failed.record.as_ref().unwrap()).0, "");
    let stored: ChunkList = a.ok("message.chunks", &json!({ "chat_id": chat.id, "chunks": [{ "chunk": 0 }] })).await;
    assert_eq!(stored.chunks[0].messages[1].error, Some(TurnErrorCode::ProviderRefused));
    let page: ChatPage = a.ok("chat.list", &json!({})).await;
    assert!(!page.chats[0].turn);

    // A retry from the archive brings the chat back, like a send.
    a.ok::<_, serde_json::Value>("chat.archive", &json!({ "chat_id": chat.id, "archived": true })).await;
    env.llm.push(Reply::text(&["Hello ", "again"]));
    let started: TurnStarted = a.ok("turn.retry", &retry(&chat, 1, "Hi")).await;
    let events = a.until_turn_end().await;
    let reset: MessageUpdated = events.iter().find(|(k, _)| k == "message.updated").map(|(_, f)| payload(f)).unwrap();
    assert_eq!((reset.message.id, reset.message.state, reset.message.error), (1, MessageState::Streaming, None));
    let done: TurnDone = payload(&events.last().unwrap().1);
    assert_eq!(done.turn_id, started.turn_id);
    let complete = last_update(&events).message;
    assert_eq!((complete.id, complete.state, complete.error), (1, MessageState::Complete, None));
    assert_eq!(chat.open(&user, 1, record::Author::Assistant, complete.record.as_ref().unwrap()).0, "Hello again");
    // The system prompt (the reply format) first, then the user's message.
    let messages = &env.llm.requests()[1].body["messages"];
    assert_eq!((&messages[0]["role"], &messages[1]["content"]), (&json!("system"), &json!("Hi")));
    assert_eq!(
        audit_kinds(&env.db, user.principal.user_id).await,
        ["chat.created", "chat.archived", "chat.unarchived"]
    );
    let page: ChatPage = a.ok("chat.list", &json!({})).await;
    assert_eq!((page.chats.len(), page.chats[0].last_message_id), (1, 1));
}

#[sqlx::test]
async fn only_the_last_failed_reply_can_be_retried(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    let chat = NewChat::new();
    assert_eq!(a.refused("turn.retry", &retry(&chat, 1, "Hi")).await, ErrorCode::AgentNotStarted);
    a.start_agent(&env.llm).await;
    assert_eq!(a.refused("turn.retry", &retry(&chat, 1, "Hi")).await, ErrorCode::ChatNotFound);
    env.llm.push(Reply { error: Some((500, String::new())), ..Reply::default() });
    a.ok::<_, MessageSent>("message.send", &send(&chat, &user, true, "Hi", Uuid::now_v7())).await;
    a.until_turn_end().await;

    let big = "x".repeat(chat_protocol::chat::TEXT_MAX + 1);
    assert_eq!(a.refused("turn.retry", &retry(&chat, 1, &big)).await, ErrorCode::MessageTooLarge);
    // The user's message, an id past the end, another account's chat.
    for id in [0, 2] {
        assert_eq!(a.refused("turn.retry", &retry(&chat, id, "Hi")).await, ErrorCode::MessageNotRetryable);
    }
    let stranger = self::user(&env.db).await;
    let (mut c, _) = Client::connect(&env, &stranger.principal, None).await;
    c.start_agent(&env.llm).await;
    assert_eq!(c.refused("turn.retry", &retry(&chat, 1, "Hi")).await, ErrorCode::ChatNotFound);

    // A running turn; then a failed reply that is no longer the last message.
    env.llm.push(Reply::endless(&["Thinking"]));
    a.ok::<_, MessageSent>("message.send", &send(&chat, &user, false, "Again", Uuid::now_v7())).await;
    assert_eq!(a.refused("turn.retry", &retry(&chat, 1, "Hi")).await, ErrorCode::TurnBusy);
    a.ok::<_, serde_json::Value>("turn.cancel", &json!({ "chat_id": chat.id })).await;
    a.until_turn_end().await;
    assert_eq!(a.refused("turn.retry", &retry(&chat, 1, "Hi")).await, ErrorCode::MessageNotRetryable);
    // A cancelled reply is not failed; a deleted one is not either.
    assert_eq!(a.refused("turn.retry", &retry(&chat, 3, "Again")).await, ErrorCode::MessageNotRetryable);
    env.llm.push(Reply { error: Some((500, String::new())), ..Reply::default() });
    a.ok::<_, MessageSent>("message.send", &send(&chat, &user, false, "Third", Uuid::now_v7())).await;
    a.until_turn_end().await;
    a.ok::<_, Revision>("message.delete", &json!({ "chat_id": chat.id, "message_id": 5 })).await;
    assert_eq!(a.refused("turn.retry", &retry(&chat, 5, "Third")).await, ErrorCode::MessageNotRetryable);
    assert_eq!(env.llm.requests().len(), 3);
}

#[sqlx::test]
async fn a_turn_cancelled_before_any_text_leaves_an_empty_cancelled_reply(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    a.start_agent(&env.llm).await;
    env.llm.push(Reply::endless(&[]));
    let chat = NewChat::new();
    a.ok::<_, MessageSent>("message.send", &send(&chat, &user, true, "Hi", Uuid::now_v7())).await;
    a.ok::<_, serde_json::Value>("turn.cancel", &json!({ "chat_id": chat.id })).await;
    let reply = last_update(&a.until_turn_end().await).message;
    assert_eq!((reply.id, reply.state, reply.error), (1, MessageState::Cancelled, None));
    assert_eq!(chat.open(&user, 1, record::Author::Assistant, reply.record.as_ref().unwrap()).0, "");
}

/// As if the replica running the chat's turn died mid-reply: its lease ran out.
async fn die_mid_turn(env: &support::socket::Env, chat: &NewChat) {
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
    die_mid_turn(&env, &chat).await;
    a.ok::<_, MessageSent>("message.send", &send(&chat, &user, false, "Again", Uuid::now_v7())).await;
    let failed: MessageUpdated = a.event("message.updated").await;
    assert_eq!(
        (failed.message.id, failed.message.state, failed.message.error),
        (1, MessageState::Failed, Some(TurnErrorCode::Interrupted))
    );
    a.until_turn_end().await;
}

#[sqlx::test]
async fn a_stale_reply_can_be_retried(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    a.start_agent(&env.llm).await;
    let chat = NewChat::new();
    a.ok::<_, MessageSent>("message.send", &send(&chat, &user, true, "Hi", Uuid::now_v7())).await;
    a.until_turn_end().await;
    die_mid_turn(&env, &chat).await;
    a.ok::<_, TurnStarted>("turn.retry", &retry(&chat, 1, "Hi")).await;
    let events = a.until_turn_end().await;
    let states: Vec<MessageState> = events
        .iter()
        .filter(|(k, _)| k == "message.updated")
        .map(|(_, f)| payload::<MessageUpdated>(f).message.state)
        .collect();
    assert_eq!(states.first(), Some(&MessageState::Failed));
    assert_eq!(states.get(1), Some(&MessageState::Streaming));
    assert_eq!(last_update(&events).message.state, MessageState::Complete);
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
    let bad = json!({ "kind": "anthropic", "base_url": "not a url", "api_key": "", "model": "m" });
    let good = agent_provider(&env.llm);
    let (one, two) = (Uuid::from_u128(1), Uuid::from_u128(2));
    let entries = |list: &[(Uuid, &serde_json::Value)]| -> Vec<serde_json::Value> {
        list.iter()
            .map(|(id, p)| {
                let mut entry = (*p).clone();
                entry["id"] = json!(id);
                entry
            })
            .collect()
    };
    let start = |list: Vec<serde_json::Value>, active: Uuid| json!({ "providers": list, "active": active });
    assert_eq!(
        b.refused("agent.start", &start(entries(&[(one, &good), (two, &bad)]), two)).await,
        ErrorCode::AgentInvalidProvider
    );
    // A refused entry other than the active one is left out.
    let _: chat_protocol::agent::AgentStarted =
        b.ok("agent.start", &start(entries(&[(one, &good), (two, &bad)]), one)).await;
    // Distinct ids, the active one among them.
    assert_eq!(b.refused("agent.start", &start(entries(&[(one, &good)]), two)).await, ErrorCode::Malformed);
    assert_eq!(
        b.refused("agent.start", &start(entries(&[(one, &good), (one, &good)]), one)).await,
        ErrorCode::Malformed
    );
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
    let rename = chat_protocol::chat::ChatRename { chat_id: chat.id, title: Bytes(title.clone()), auto: None };
    a.ok::<_, serde_json::Value>("chat.rename", &rename).await;
    let updated: chat_protocol::chat::ChatUpdated = a.event("chat.updated").await;
    assert_eq!(updated.chat.title, Some(Bytes(title)));
    assert!(updated.chat.rev > before.chats[0].rev);
    let bad = chat_protocol::chat::ChatRename { chat_id: chat.id, title: Bytes(vec![1; 10]), auto: None };
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

/// Short enough to wait out; the time limit ends the endless fake reply.
fn quick() -> WsSettings {
    WsSettings { agent_grace: Duration::from_millis(200), turn_limit: Duration::from_secs(2), ..WsSettings::default() }
}

/// Waits until the reply of a turn streams.
async fn streaming(client: &mut Client) {
    loop {
        let created: MessageCreated = client.event("message.created").await;
        if created.message.author == Author::Assistant {
            return;
        }
    }
}

#[sqlx::test]
async fn revoking_the_session_interrupts_a_turn_that_outlived_its_agent_session(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    let watcher = session(&env.db, user.principal.user_id).await;
    let (mut b, _) = Client::connect(&env, &watcher, None).await;
    a.start_agent(&env.llm).await;
    env.llm.push(Reply::endless(&["Long"]));
    let sent: MessageSent = a.ok("message.send", &send(&NewChat::new(), &user, true, "Go", Uuid::now_v7())).await;
    streaming(&mut a).await;
    let _: chat_protocol::Empty = a.ok("agent.stop", &json!({})).await;
    env.state.auth.store.revoke(user.principal.session_id, Duration::from_secs(60)).await.unwrap();
    let error: TurnError = b.event("turn.error").await;
    assert_eq!((error.turn_id, error.code), (sent.turn_id, TurnErrorCode::Interrupted));
}

#[sqlx::test]
async fn stopping_the_agent_lets_its_turn_run_and_needs_a_new_start(db: PgPool) {
    let env = start_with(db, quick()).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    let id = a.start_agent(&env.llm).await;
    env.llm.push(Reply::endless(&["Long"]));
    let sent: MessageSent = a.ok("message.send", &send(&NewChat::new(), &user, true, "Go", Uuid::now_v7())).await;
    streaming(&mut a).await;
    let _: chat_protocol::Empty = a.ok("agent.stop", &json!({})).await;
    assert_eq!(
        a.refused("message.send", &send(&NewChat::new(), &user, true, "Again", Uuid::now_v7())).await,
        ErrorCode::AgentNotStarted
    );
    // Gone for a resume too.
    let (_, ok) = Client::connect(&env, &user.principal, Some(id)).await;
    assert!(payload::<chat_protocol::connection::AuthOk>(&ok).agent_session_id.is_none());
    // Stopping without a session is fine.
    let _: chat_protocol::Empty = a.ok("agent.stop", &json!({})).await;
    // The turn ran on until its time limit.
    let error: TurnError = a.event("turn.error").await;
    assert_eq!((error.turn_id, error.code), (sent.turn_id, TurnErrorCode::TimedOut));
}

#[sqlx::test]
async fn a_turn_outlives_its_socket_and_the_grace_period(db: PgPool) {
    let env = start_with(db, quick()).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    let watcher = session(&env.db, user.principal.user_id).await;
    let (mut b, _) = Client::connect(&env, &watcher, None).await;
    let id = a.start_agent(&env.llm).await;
    env.llm.push(Reply::endless(&["Long"]));
    let sent: MessageSent = a.ok("message.send", &send(&NewChat::new(), &user, true, "Go", Uuid::now_v7())).await;
    streaming(&mut a).await;
    drop(a);
    tokio::time::sleep(Duration::from_millis(600)).await;
    let (_, ok) = Client::connect(&env, &user.principal, Some(id)).await;
    assert!(payload::<chat_protocol::connection::AuthOk>(&ok).agent_session_id.is_none());
    let error: TurnError = b.event("turn.error").await;
    assert_eq!((error.turn_id, error.code), (sent.turn_id, TurnErrorCode::TimedOut));
}

#[sqlx::test]
async fn retiring_a_provider_interrupts_its_turns_and_only_those(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    let other_device = session(&env.db, user.principal.user_id).await;
    let (mut b, _) = Client::connect(&env, &other_device, None).await;
    a.start_agent(&env.llm).await;
    env.llm.push(Reply::endless(&["Long"]));
    let chat = NewChat::new();
    let sent: MessageSent = a.ok("message.send", &send(&chat, &user, true, "Go", Uuid::now_v7())).await;
    streaming(&mut a).await;

    // Another provider, or another user retiring this one, leaves the turn alone.
    let another = json!({ "kind": "anthropic", "base_url": env.llm.anthropic_url(), "api_key": "k", "model": "m" });
    let _: chat_protocol::Empty = b.ok("agent.retire", &retire(&user.principal, &[another])).await;
    let stranger = support::socket::user(&env.db).await;
    let (mut s, _) = Client::connect(&env, &stranger.principal, None).await;
    let _: chat_protocol::Empty = s.ok("agent.retire", &retire(&user.principal, &[agent_provider(&env.llm)])).await;
    a.ok::<_, serde_json::Value>("turn.cancel", &json!({ "chat_id": chat.id })).await;
    let done: TurnDone = payload(&a.until_turn_end().await.last().unwrap().1);
    assert_eq!(done.turn_id, sent.turn_id);

    env.llm.push(Reply::endless(&["Long"]));
    let sent: MessageSent = a.ok("message.send", &send(&chat, &user, false, "Again", Uuid::now_v7())).await;
    streaming(&mut a).await;
    let _: chat_protocol::Empty = b.ok("agent.retire", &retire(&user.principal, &[agent_provider(&env.llm)])).await;
    let error: TurnError = a.event("turn.error").await;
    assert_eq!((error.turn_id, error.code), (sent.turn_id, TurnErrorCode::Interrupted));
    assert_eq!(
        a.refused("message.send", &send(&NewChat::new(), &user, true, "More", Uuid::now_v7())).await,
        ErrorCode::AgentNotStarted
    );
}

#[sqlx::test]
async fn retiring_reaches_stopped_and_detached_sessions(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    // A turn whose session was stopped.
    a.start_agent(&env.llm).await;
    env.llm.push(Reply::endless(&["Long"]));
    let sent: MessageSent = a.ok("message.send", &send(&NewChat::new(), &user, true, "Go", Uuid::now_v7())).await;
    streaming(&mut a).await;
    let _: chat_protocol::Empty = a.ok("agent.stop", &json!({})).await;
    // A session whose socket is gone, well within its grace period.
    let other_device = session(&env.db, user.principal.user_id).await;
    let (mut c, _) = Client::connect(&env, &other_device, None).await;
    let detached = c.start_agent(&env.llm).await;
    drop(c);

    let _: chat_protocol::Empty = a.ok("agent.retire", &retire(&user.principal, &[agent_provider(&env.llm)])).await;
    let error: TurnError = a.event("turn.error").await;
    assert_eq!((error.turn_id, error.code), (sent.turn_id, TurnErrorCode::Interrupted));
    let (_, ok) = Client::connect(&env, &other_device, Some(detached)).await;
    assert!(payload::<chat_protocol::connection::AuthOk>(&ok).agent_session_id.is_none());

    // Fingerprints are 32 bytes, at most 64 of them.
    let short = json!({ "fingerprints": [Bytes(vec![1; 31])] });
    assert_eq!(a.refused("agent.retire", &short).await, ErrorCode::Malformed);
    let many = AgentRetire { fingerprints: vec![Bytes(vec![1; 32]); 65] };
    assert_eq!(a.refused("agent.retire", &many).await, ErrorCode::Malformed);
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
    // Text and document would not fit one record: the text alone is kept.
    let content = chat.open_content(&user, 1, record::Author::Assistant, last.message.record.as_ref().unwrap()).0;
    assert_eq!((content.text.len(), content.doc), (140 * 1024, None));
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

#[sqlx::test]
async fn a_chat_keeps_its_settings_and_every_device_hears_of_a_change(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    let other_device = session(&env.db, user.principal.user_id).await;
    let (mut b, _) = Client::connect(&env, &other_device, None).await;
    a.start_agent(&env.llm).await;
    env.llm.push(Reply::text(&["Hi"]));
    let chat = NewChat::new();
    let mut first = send(&chat, &user, true, "Hi", Uuid::now_v7());
    let chosen = ChatSettings { effort: Some(Effort::Low), ..ChatSettings::default() };
    first.new_chat.as_mut().unwrap().settings = Some(chosen.clone());
    a.ok::<_, MessageSent>("message.send", &first).await;
    a.until_turn_end().await;
    let page: ChatPage = a.ok("chat.list", &json!({})).await;
    assert_eq!(page.chats[0].settings, chosen);

    let settings = ChatSettings {
        provider: Some(Uuid::from_u128(9)),
        effort: Some(Effort::High),
        history: Some(History::Recent { messages: 20 }),
    };
    let _: chat_protocol::Empty =
        a.ok("chat.configure", &json!({ "chat_id": chat.id, "settings": settings.clone() })).await;
    loop {
        let updated: chat_protocol::chat::ChatUpdated = b.event("chat.updated").await;
        if updated.chat.settings == settings {
            break;
        }
    }
    let page: ChatPage = a.ok("chat.list", &json!({})).await;
    assert_eq!(page.chats[0].settings, settings);

    // Out of range, unknown fields, another user's chat.
    let zero = json!({ "chat_id": chat.id, "settings": { "history": { "mode": "recent", "messages": 0 } } });
    assert_eq!(a.refused("chat.configure", &zero).await, ErrorCode::Malformed);
    let unknown = json!({ "chat_id": chat.id, "settings": { "temperature": 1 } });
    assert_eq!(a.refused("chat.configure", &unknown).await, ErrorCode::Malformed);
    let stranger = self::user(&env.db).await;
    let (mut s, _) = Client::connect(&env, &stranger.principal, None).await;
    let theirs = json!({ "chat_id": chat.id, "settings": {} });
    assert_eq!(s.refused("chat.configure", &theirs).await, ErrorCode::ChatNotFound);
    let page: ChatPage = a.ok("chat.list", &json!({})).await;
    assert_eq!(page.chats[0].settings, settings);
}

#[sqlx::test]
async fn a_turn_runs_with_its_chats_provider_and_effort_or_the_active_one(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    let second = Uuid::from_u128(2);
    let mut other = agent_provider(&env.llm);
    other["model"] = json!("second");
    a.start_agents(&[(PROVIDER, agent_provider(&env.llm)), (second, other)], PROVIDER).await;
    let chat = NewChat::new();
    env.llm.push(Reply::text(&["One"]));
    a.ok::<_, MessageSent>("message.send", &send(&chat, &user, true, "Hi", Uuid::now_v7())).await;
    a.until_turn_end().await;
    let sent = env.llm.requests();
    assert_eq!(sent.last().unwrap().body["model"], "m");
    assert!(sent.last().unwrap().body.get("reasoning_effort").is_none());

    let chosen = ChatSettings { provider: Some(second), effort: Some(Effort::Medium), history: None };
    let _: chat_protocol::Empty = a.ok("chat.configure", &json!({ "chat_id": chat.id, "settings": chosen })).await;
    env.llm.push(Reply::text(&["Two"]));
    a.ok::<_, MessageSent>("message.send", &send(&chat, &user, false, "Again", Uuid::now_v7())).await;
    a.until_turn_end().await;
    let body = env.llm.requests().last().unwrap().body.clone();
    assert_eq!((body["model"].as_str(), body["reasoning_effort"].as_str()), (Some("second"), Some("medium")));

    // A provider the session does not hold (removed meanwhile) falls back to the active one.
    let gone = ChatSettings { provider: Some(Uuid::from_u128(7)), ..ChatSettings::default() };
    let _: chat_protocol::Empty = a.ok("chat.configure", &json!({ "chat_id": chat.id, "settings": gone })).await;
    env.llm.push(Reply::text(&["Three"]));
    a.ok::<_, MessageSent>("message.send", &send(&chat, &user, false, "More", Uuid::now_v7())).await;
    a.until_turn_end().await;
    assert_eq!(env.llm.requests().last().unwrap().body["model"], "m");
}

#[sqlx::test]
async fn retiring_one_provider_ends_the_session_but_not_a_turn_on_another(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    let second = Uuid::from_u128(2);
    let mut other = agent_provider(&env.llm);
    other["model"] = json!("second");
    a.start_agents(&[(PROVIDER, agent_provider(&env.llm)), (second, other.clone())], PROVIDER).await;
    let chat = NewChat::new();
    let mut first = send(&chat, &user, true, "Go", Uuid::now_v7());
    first.new_chat.as_mut().unwrap().settings =
        Some(ChatSettings { provider: Some(second), ..ChatSettings::default() });
    env.llm.push(Reply::endless(&["Long"]));
    let sent: MessageSent = a.ok("message.send", &first).await;
    streaming(&mut a).await;

    let _: chat_protocol::Empty = a.ok("agent.retire", &retire(&user.principal, &[agent_provider(&env.llm)])).await;
    assert_eq!(
        a.refused("message.send", &send(&NewChat::new(), &user, true, "More", Uuid::now_v7())).await,
        ErrorCode::AgentNotStarted
    );
    // The turn on the other provider runs on until cancelled.
    a.ok::<_, serde_json::Value>("turn.cancel", &json!({ "chat_id": chat.id })).await;
    let done: TurnDone = payload(&a.until_turn_end().await.last().unwrap().1);
    assert_eq!(done.turn_id, sent.turn_id);
}

fn compact(chat: &NewChat, through: u32) -> serde_json::Value {
    json!({
        "chat_id": chat.id,
        "through": through,
        "context": { "summary": "Before all", "messages": [{ "id": 0, "role": "user", "text": "Hi" }] },
    })
}

/// Sends `text` to the chat and waits for the reply.
async fn exchange(a: &mut Client, env: &support::socket::Env, chat: &NewChat, user: &User, new: bool, text: &str) {
    env.llm.push(Reply::text(&["Reply"]));
    a.ok::<_, MessageSent>("message.send", &send(chat, user, new, text, Uuid::now_v7())).await;
    a.until_turn_end().await;
}

/// Compacts the chat up to `through` and waits for the summary.
async fn summarize(a: &mut Client, env: &support::socket::Env, chat: &NewChat, through: u32) -> u32 {
    env.llm.push(Reply::text(&["Sum", "mary"]));
    let sent: MessageSent = a.ok("chat.compact", &compact(chat, through)).await;
    a.until_turn_end().await;
    sent.message_id
}

async fn current_summary(a: &mut Client) -> Option<u32> {
    let page: ChatPage = a.ok("chat.list", &json!({})).await;
    page.chats[0].summary_id
}

#[sqlx::test]
async fn a_compaction_streams_a_summary_that_becomes_the_chats_current_one(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    let chat = NewChat::new();
    assert_eq!(a.refused("chat.compact", &compact(&chat, 0)).await, ErrorCode::AgentNotStarted);
    a.start_agent(&env.llm).await;
    assert_eq!(a.refused("chat.compact", &compact(&chat, 0)).await, ErrorCode::ChatNotFound);
    exchange(&mut a, &env, &chat, &user, true, "Hi").await;
    assert_eq!(current_summary(&mut a).await, None);

    // `through` names a message before the summary's own id.
    assert_eq!(a.refused("chat.compact", &compact(&chat, 2)).await, ErrorCode::Malformed);
    env.llm.push(Reply::text(&["<title>Hi there</title>\n", "**Sum**", "mary"]));
    let sent: MessageSent = a.ok("chat.compact", &compact(&chat, 1)).await;
    assert_eq!(sent.message_id, 2);
    let events = a.until_turn_end().await;
    let created: MessageCreated = events.iter().find(|(k, _)| k == "message.created").map(|(_, f)| payload(f)).unwrap();
    assert_eq!(
        (created.message.author, created.message.state, created.message.through),
        (Author::Summary, MessageState::Streaming, Some(1))
    );
    let summary = last_update(&events).message;
    assert_eq!((summary.id, summary.state), (2, MessageState::Complete));
    // The text keeps the title line for the client to take; the document leaves it out.
    let content = chat.open_content(&user, 2, record::Author::Summary, summary.record.as_ref().unwrap()).0;
    assert_eq!(content.text, "<title>Hi there</title>\n**Sum**mary");
    assert_eq!(content.doc, Some(chat_document::from_markdown("**Sum**mary")));
    assert_eq!(current_summary(&mut a).await, Some(2));

    // The model reads the context as a transcript under an instruction of the server's.
    let body = env.llm.requests().last().unwrap().body.to_string();
    assert!(body.contains("You compact a conversation"));
    assert!(body.contains(r"<summary>\nBefore all\n</summary>"));
    assert!(body.contains(r"<user>\nHi\n</user>"));

    // One turn at a time; a newer summary with a later cut takes over.
    env.llm.push(Reply::endless(&["Long"]));
    a.ok::<_, MessageSent>("message.send", &send(&chat, &user, false, "More", Uuid::now_v7())).await;
    assert_eq!(a.refused("chat.compact", &compact(&chat, 1)).await, ErrorCode::TurnBusy);
    a.ok::<_, serde_json::Value>("turn.cancel", &json!({ "chat_id": chat.id })).await;
    a.until_turn_end().await;
    assert_eq!(summarize(&mut a, &env, &chat, 4).await, 5);
    assert_eq!(current_summary(&mut a).await, Some(5));
    // An older cut made later does not.
    assert_eq!(summarize(&mut a, &env, &chat, 1).await, 6);
    assert_eq!(current_summary(&mut a).await, Some(5));
}

#[sqlx::test]
async fn editing_or_deleting_a_covered_message_deletes_the_summaries_over_it(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    a.start_agent(&env.llm).await;
    let chat = NewChat::new();
    exchange(&mut a, &env, &chat, &user, true, "One").await;
    assert_eq!(summarize(&mut a, &env, &chat, 1).await, 2);
    exchange(&mut a, &env, &chat, &user, false, "Two").await;
    assert_eq!(summarize(&mut a, &env, &chat, 4).await, 5);

    // Message 3 lies under summary 5 only.
    let _: Revision = a.ok("message.edit", &edit(chat.id, 3, chat.edit(&user, 3, "Changed"))).await;
    let deleted: MessageDeleted = a.event("message.deleted").await;
    assert_eq!(deleted.message_id, 5);
    assert_eq!(current_summary(&mut a).await, Some(2));

    // A message after every cut deletes nothing; one under both cuts deletes the rest.
    let _: Revision = a.ok("message.delete", &json!({ "chat_id": chat.id, "message_id": 4 })).await;
    assert_eq!(current_summary(&mut a).await, Some(2));
    let _: Revision = a.ok("message.delete", &json!({ "chat_id": chat.id, "message_id": 0 })).await;
    assert_eq!(current_summary(&mut a).await, None);

    // Deleting a summary deletes only itself.
    let first = summarize(&mut a, &env, &chat, 3).await;
    let second = summarize(&mut a, &env, &chat, first).await;
    let _: Revision = a.ok("message.delete", &json!({ "chat_id": chat.id, "message_id": second })).await;
    assert_eq!(current_summary(&mut a).await, Some(first));

    // A summary still streaming refuses a change under it.
    env.llm.push(Reply::endless(&["Sum"]));
    a.ok::<_, MessageSent>("chat.compact", &compact(&chat, 3)).await;
    a.event::<MessageCreated>("message.created").await;
    assert_eq!(a.refused("message.edit", &edit(chat.id, 3, chat.edit(&user, 3, "Again"))).await, ErrorCode::TurnBusy);
    assert_eq!(a.refused("message.delete", &json!({ "chat_id": chat.id, "message_id": 1 })).await, ErrorCode::TurnBusy);
    a.ok::<_, serde_json::Value>("turn.cancel", &json!({ "chat_id": chat.id })).await;
    a.until_turn_end().await;
}

#[sqlx::test]
async fn a_failed_summary_is_retried_in_place(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    a.start_agent(&env.llm).await;
    let chat = NewChat::new();
    exchange(&mut a, &env, &chat, &user, true, "Hi").await;
    env.llm.push(Reply { error: Some((500, String::new())), ..Reply::default() });
    a.ok::<_, MessageSent>("chat.compact", &compact(&chat, 1)).await;
    let failed = last_update(&a.until_turn_end().await).message;
    assert_eq!((failed.id, failed.state), (2, MessageState::Failed));
    assert_eq!(current_summary(&mut a).await, None);

    // A summary answers no user message.
    assert_eq!(a.refused("turn.retry", &retry(&chat, 2, "Hi")).await, ErrorCode::Malformed);
    env.llm.push(Reply::text(&["Summary"]));
    a.ok::<_, TurnStarted>("turn.retry", &retry(&chat, 2, "")).await;
    let done = last_update(&a.until_turn_end().await).message;
    assert_eq!((done.id, done.state, done.through), (2, MessageState::Complete, Some(1)));
    assert_eq!(chat.open(&user, 2, record::Author::Summary, done.record.as_ref().unwrap()).0, "Summary");
    assert_eq!(current_summary(&mut a).await, Some(2));
    assert!(env.llm.requests().last().unwrap().body.to_string().contains("You compact a conversation"));
}

fn title_of(chat: &NewChat, user: &User, text: &[u8]) -> Bytes {
    Bytes(
        record::seal_as_client(
            &chat.place(user, Kind::ChatTitle),
            &chat.keys.public(),
            &user.ark.writer_key(&user.id()),
            text,
            &mut os_rng(),
        )
        .unwrap(),
    )
}

fn rename(chat: &NewChat, title: Bytes, auto: Option<bool>) -> chat_protocol::chat::ChatRename {
    chat_protocol::chat::ChatRename { chat_id: chat.id, title, auto }
}

fn ask_title(chat: &NewChat) -> serde_json::Value {
    json!({ "chat_id": chat.id, "context": { "messages": [{ "id": 0, "role": "user", "text": "Trip to Paris?" }] } })
}

#[sqlx::test]
async fn a_title_comes_to_the_asking_session_only(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    let other = session(&env.db, user.principal.user_id).await;
    let (mut b, _) = Client::connect(&env, &other, None).await;
    let chat = NewChat::new();
    assert_eq!(a.refused("chat.title", &ask_title(&chat)).await, ErrorCode::AgentNotStarted);
    a.start_agent(&env.llm).await;
    assert_eq!(a.refused("chat.title", &ask_title(&chat)).await, ErrorCode::ChatNotFound);
    exchange(&mut a, &env, &chat, &user, true, "Trip to Paris?").await;

    // The first line of the answer, trimmed; the rest is not waited for.
    env.llm.push(Reply::text(&["\n  Paris ", "trip plans  \n", "Extra"]));
    a.ok::<_, serde_json::Value>("chat.title", &ask_title(&chat)).await;
    let titled: chat_protocol::chat::ChatTitled = a.event("chat.titled").await;
    assert_eq!((titled.chat_id, titled.title.0.as_str()), (chat.id, "Paris trip plans"));
    let body = env.llm.requests().last().unwrap().body.to_string();
    assert!(body.contains("You name conversations"));
    assert!(body.contains(r"<user>\nTrip to Paris?\n</user>"));

    // Another session of the user hears of the rename, not of the title before it.
    let rename = rename(&chat, title_of(&chat, &user, b"Paris"), Some(true));
    a.ok::<_, serde_json::Value>("chat.rename", &rename).await;
    let _: chat_protocol::chat::ChatUpdated = b.event("chat.updated").await;
    assert!(b.events.iter().all(|(k, _)| k != "chat.titled"));

    // A provider that fails gives no title.
    let asked = env.llm.requests().len();
    env.llm.push(Reply { error: Some((500, "{}".into())), ..Reply::default() });
    a.ok::<_, serde_json::Value>("chat.title", &ask_title(&chat)).await;
    while env.llm.requests().len() == asked {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    a.ok::<_, serde_json::Value>("chat.rename", &rename).await;
    let _: chat_protocol::chat::ChatUpdated = a.event("chat.updated").await;
    assert!(a.events.iter().all(|(k, _)| k != "chat.titled"));
}

#[sqlx::test]
async fn an_automatic_title_never_replaces_one_the_user_gave(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    a.start_agent(&env.llm).await;
    let chat = NewChat::new();
    exchange(&mut a, &env, &chat, &user, true, "Hi").await;
    let page: ChatPage = a.ok("chat.list", &json!({})).await;
    assert!(page.chats[0].title_auto);

    let auto = title_of(&chat, &user, b"From the model");
    a.ok::<_, serde_json::Value>("chat.rename", &rename(&chat, auto.clone(), Some(true))).await;
    let updated: chat_protocol::chat::ChatUpdated = a.event("chat.updated").await;
    assert_eq!((updated.chat.title.as_ref(), updated.chat.title_auto), (Some(&auto), true));

    let named = title_of(&chat, &user, b"Mine");
    a.ok::<_, serde_json::Value>("chat.rename", &rename(&chat, named.clone(), None)).await;
    let updated: chat_protocol::chat::ChatUpdated = a.event("chat.updated").await;
    assert_eq!((updated.chat.title.as_ref(), updated.chat.title_auto), (Some(&named), false));

    // Answers ok and changes nothing, not even the revision.
    let late = title_of(&chat, &user, b"Late");
    a.ok::<_, serde_json::Value>("chat.rename", &rename(&chat, late, Some(true))).await;
    let page: ChatPage = a.ok("chat.list", &json!({})).await;
    assert_eq!((page.chats[0].title.as_ref(), page.chats[0].rev), (Some(&named), updated.chat.rev));
    assert!(a.events.iter().all(|(k, _)| k != "chat.updated"));
}
