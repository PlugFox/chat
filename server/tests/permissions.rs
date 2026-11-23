//! Agent tools and permission requests over a real socket against the fake
//! LLM (docs/protocol.md, "Permissions and the access log", "Agent tools").

#![allow(clippy::unwrap_used, clippy::expect_used, reason = "tests fail loudly")]

mod support;

use std::time::Duration;

use chat_crypto::{
    ids::{LogEntryId, ScopeId},
    os_rng,
    record::{self, Kind, Place},
    scope::ScopeKeyPair,
};
use chat_protocol::{
    Bytes, Empty,
    chat::{MessageContent, MessageSend, MessageSent, MessageUpdated, ToolUse, TurnContext, TurnDone},
    error::ErrorCode,
    permissions::{
        AccessLogList, AccessLogPage, Decision, Grant, HISTORY_MAX, Outcome, PermissionList, PermissionPending,
        PermissionRequest, PermissionResolved, PermissionRespond,
    },
    redact::Secret,
    registers::RegisterSetup,
};
use chat_server::ws::WsSettings;
use serde_json::{Value, json};
use sqlx::PgPool;
use support::{
    fake_llm::Reply,
    socket::{Client, Env, PROVIDER, User, session, start, start_with, user},
};
use uuid::Uuid;

const WEIGHT: &str = "body.weight";

struct Chat {
    id: Uuid,
    keys: ScopeKeyPair,
}

impl Chat {
    fn new() -> Self {
        Self { id: Uuid::now_v7(), keys: ScopeKeyPair::generate(1, &mut os_rng()) }
    }

    fn send(&self, user: &User, new: bool, text: &str) -> MessageSend {
        let scope = ScopeId::from_bytes(*self.id.as_bytes());
        MessageSend {
            idempotency_key: Uuid::now_v7(),
            chat_id: self.id,
            new_chat: new.then(|| chat_protocol::chat::NewChat {
                public_key: Bytes(self.keys.public().key.as_bytes().to_vec()),
                wrapped_private_key: Bytes(self.keys.wrap(&user.ark, &user.id(), &scope, &mut os_rng())),
                title: None,
                settings: None,
                temporary: None,
            }),
            text: Secret(text.into()),
            context: TurnContext::default(),
            files: Vec::new(),
        }
    }

    fn content(&self, user: &User, id: u32, sealed: &Bytes) -> MessageContent {
        let place = Place {
            user: user.id(),
            scope: ScopeId::from_bytes(*self.id.as_bytes()),
            kind: Kind::ChatMessage { message_id: id, author: record::Author::Assistant },
        };
        let writer = user.ark.writer_key(&user.id()).public();
        let (plain, _) = record::open(&place, &self.keys, &writer, &sealed.0).unwrap();
        MessageContent::decode(&plain).unwrap()
    }
}

/// Replaces the dummy key of the user's `audit` scope with a real one, so reasons open.
async fn audit_keys(db: &PgPool, user: &User) -> (Uuid, ScopeKeyPair) {
    let keys = ScopeKeyPair::generate(1, &mut os_rng());
    let scope: Uuid = sqlx::query_scalar("SELECT id FROM scopes WHERE user_id = $1 AND kind = 'audit'")
        .bind(user.principal.user_id)
        .fetch_one(db)
        .await
        .unwrap();
    sqlx::query("UPDATE scope_keys SET public_key = $2 WHERE scope_id = $1")
        .bind(scope)
        .bind(keys.public().key.as_bytes().to_vec())
        .execute(db)
        .await
        .unwrap();
    (scope, keys)
}

fn reason(user: &User, audit: &(Uuid, ScopeKeyPair), request: &PermissionRequest) -> String {
    let place = Place {
        user: user.id(),
        scope: ScopeId::from_bytes(*audit.0.as_bytes()),
        kind: Kind::AuditReason { log_entry_id: LogEntryId::from_bytes(*request.request_id.as_bytes()) },
    };
    let writer = user.ark.writer_key(&user.id()).public();
    let (plain, origin) = record::open(&place, &audit.1, &writer, &request.reason.0).unwrap();
    assert_eq!(origin, record::Origin::Server);
    String::from_utf8(plain.to_vec()).unwrap()
}

/// The weight register with entries on 2026-03-01 and 2026-03-10 (UTC noon).
async fn weight(db: &PgPool, socket: &mut Client, user: &User) -> Uuid {
    let scope_id = Uuid::now_v7();
    let setup = RegisterSetup {
        metric: WEIGHT.into(),
        scope_id,
        public_key: Bytes(ScopeKeyPair::generate(1, &mut os_rng()).public().key.as_bytes().to_vec()),
        wrapped_private_key: Bytes(vec![5; 73]),
    };
    let _: chat_protocol::registers::RegisterScope = socket.ok("register.setup", &setup).await;
    for at in [1_772_366_400_i64, 1_773_144_000] {
        sqlx::query(
            "INSERT INTO register_entries (id, user_id, scope_id, occurred_at, value, rev, updated_at)
             VALUES (gen_random_uuid(), $1, $2, $3, '\\x01', 1, 0)",
        )
        .bind(user.principal.user_id)
        .bind(scope_id)
        .bind(at)
        .execute(db)
        .await
        .unwrap();
    }
    scope_id
}

fn read(metric: &str, from: &str, to: &str) -> String {
    json!({ "metric": metric, "from": from, "to": to, "reason": "To see your trend" }).to_string()
}

/// The tool messages of the provider request `index`, in order.
fn tool_results(env: &Env, index: usize) -> Vec<String> {
    let body = &env.llm.requests()[index].body;
    body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["role"] == "tool")
        .map(|m| m["content"].as_str().unwrap().to_owned())
        .collect()
}

async fn reply_tools(client: &mut Client, chat: &Chat, user: &User, sent: &MessageSent) -> Vec<ToolUse> {
    reply_content(client, chat, user, sent).await.tools
}

async fn reply_content(
    client: &mut Client,
    chat: &Chat,
    user: &User,
    sent: &MessageSent,
) -> chat_protocol::chat::MessageContent {
    loop {
        let updated: MessageUpdated = client.event("message.updated").await;
        if updated.message.id == sent.message_id + 1
            && updated.message.state != chat_protocol::chat::MessageState::Streaming
        {
            return chat.content(user, updated.message.id, updated.message.record.as_ref().unwrap());
        }
    }
}

async fn log(client: &mut Client) -> AccessLogPage {
    client.ok("access_log.list", &AccessLogList::default()).await
}

#[sqlx::test]
async fn an_approved_read_reaches_the_model_and_the_reply_keeps_only_the_call(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let audit = audit_keys(&env.db, &user).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    let other = session(&env.db, user.principal.user_id).await;
    let (mut b, _) = Client::connect(&env, &other, None).await;
    let scope_id = weight(&env.db, &mut a, &user).await;
    a.start_agent(&env.llm).await;
    env.llm.push(Reply::tool("c1", "read_register", &read(WEIGHT, "2026-03-01", "2026-03-31")));
    env.llm.push(Reply::text(&["You lost ", "a kilo."]));

    let chat = Chat::new();
    let sent: MessageSent = a.ok("message.send", &chat.send(&user, true, "How is my weight?")).await;
    let request: PermissionRequest = a.event("permission.request").await;
    assert_eq!((request.chat_id, request.turn_id, request.provider_id), (chat.id, sent.turn_id, PROVIDER));
    assert_eq!(
        request.grant,
        Grant::ReadRegister {
            metric: WEIGHT.into(),
            scope_id,
            from: Some("2026-03-01".into()),
            to: Some("2026-03-31".into())
        }
    );
    assert_eq!(reason(&user, &audit, &request), "To see your trend");
    // Waiting shows in the reply, and in the log without an outcome.
    let page = log(&mut a).await;
    assert_eq!((page.entries.len(), page.entries[0].outcome), (1, None));
    // Another auth session is neither asked nor able to answer.
    let pending: PermissionList = b.ok("permission.pending", &PermissionPending {}).await;
    assert!(pending.requests.is_empty());
    let approve = PermissionRespond {
        request_id: request.request_id,
        decision: Decision::Approve,
        result: Some(Secret(r#"{"entries":[72.5]}"#.into())),
    };
    assert_eq!(b.refused("permission.respond", &approve).await, ErrorCode::PermissionNotFound);
    // An approval of a register read carries its result, and only it does.
    let bare = PermissionRespond { result: None, ..approve };
    assert_eq!(a.refused("permission.respond", &bare).await, ErrorCode::Malformed);
    let deny = PermissionRespond {
        request_id: request.request_id,
        decision: Decision::Deny,
        result: Some(Secret("x".into())),
    };
    assert_eq!(a.refused("permission.respond", &deny).await, ErrorCode::Malformed);
    let empty = PermissionRespond {
        request_id: request.request_id,
        decision: Decision::Approve,
        result: Some(Secret(String::new())),
    };
    assert_eq!(a.refused("permission.respond", &empty).await, ErrorCode::Malformed);
    let large = PermissionRespond {
        request_id: request.request_id,
        decision: Decision::Approve,
        result: Some(Secret("x".repeat(64 * 1024 + 1))),
    };
    assert_eq!(a.refused("permission.respond", &large).await, ErrorCode::Malformed);
    let approve = PermissionRespond {
        request_id: request.request_id,
        decision: Decision::Approve,
        result: Some(Secret(r#"{"entries":[72.5]}"#.into())),
    };
    let _: Empty = a.ok("permission.respond", &approve).await;
    let resolved: PermissionResolved = a.event("permission.resolved").await;
    assert_eq!((resolved.request_id, resolved.outcome), (request.request_id, Outcome::Approved));
    // Answered once.
    assert_eq!(a.refused("permission.respond", &approve).await, ErrorCode::PermissionNotFound);

    let tools = reply_tools(&mut a, &chat, &user, &sent).await;
    assert_eq!(
        tools,
        [ToolUse {
            tool: "read_register".into(),
            metric: Some(WEIGHT.into()),
            from: Some("2026-03-01".into()),
            to: Some("2026-03-31".into()),
            count: None,
            host: None,
            outcome: Some(Outcome::Approved),
        }]
    );
    let _: TurnDone = a.event("turn.done").await;
    let requests = env.llm.requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].body["tools"].as_array().unwrap().len(), 9);
    assert_eq!(tool_results(&env, 1), [r#"{"entries":[72.5]}"#]);
    let assistant = &requests[1].body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["role"] == "assistant")
        .unwrap()["tool_calls"][0];
    assert_eq!(assistant["id"], "c1");
    let page = log(&mut a).await;
    assert_eq!(page.entries[0].outcome, Some(Outcome::Approved));
    assert!(page.entries[0].decided_at.is_some());
    let pending: PermissionList = a.ok("permission.pending", &PermissionPending {}).await;
    assert!(pending.requests.is_empty());
}

#[sqlx::test]
async fn a_denied_grant_asked_again_in_the_turn_is_denied_without_a_dialog(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    weight(&env.db, &mut a, &user).await;
    a.start_agent(&env.llm).await;
    env.llm.push(Reply::tool("c1", "read_register", &read(WEIGHT, "2026-03-01", "2026-03-31")));
    env.llm.push(Reply::tool("c2", "read_register", &read(WEIGHT, "2026-03-05", "2026-03-06")));
    env.llm.push(Reply::text(&["Fine."]));
    let chat = Chat::new();
    let sent: MessageSent = a.ok("message.send", &chat.send(&user, true, "Weight?")).await;
    let request: PermissionRequest = a.event("permission.request").await;
    let deny = PermissionRespond { request_id: request.request_id, decision: Decision::Deny, result: None };
    let _: Empty = a.ok("permission.respond", &deny).await;
    let tools = reply_tools(&mut a, &chat, &user, &sent).await;
    let outcomes: Vec<Option<Outcome>> = tools.iter().map(|t| t.outcome).collect();
    assert_eq!(outcomes, [Some(Outcome::Denied), Some(Outcome::Denied)]);
    assert!(tool_results(&env, 2).iter().all(|r| r.contains("denied")));
    assert_eq!(log(&mut a).await.entries.len(), 1);
    assert!(!a.events.iter().any(|(k, _)| k == "permission.request"));
}

#[sqlx::test]
async fn the_server_answers_what_needs_no_dialog(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    weight(&env.db, &mut a, &user).await;
    a.start_agent(&env.llm).await;
    let calls = Reply {
        tool_calls: vec![
            ("c1".into(), "list_metrics".into(), "{}".into()),
            ("c2".into(), "read_register".into(), read("body.mood", "2026-03-01", "2026-03-31")),
            ("c3".into(), "read_register".into(), read("activity.steps", "2026-03-01", "2026-03-31")),
            // Weight has entries, but none of these days.
            ("c4".into(), "read_register".into(), read(WEIGHT, "2025-01-01", "2025-01-31")),
            ("c5".into(), "read_register".into(), read(WEIGHT, "March", "2026-03-31")),
            ("c6".into(), "list_scopes".into(), "{}".into()),
        ],
        ..Reply::default()
    };
    env.llm.push(calls);
    env.llm.push(Reply::text(&["Done."]));
    let chat = Chat::new();
    let sent: MessageSent = a.ok("message.send", &chat.send(&user, true, "What do I track?")).await;
    let tools = reply_tools(&mut a, &chat, &user, &sent).await;
    assert!(tools.iter().all(|t| t.outcome == Some(Outcome::Answered)), "{tools:?}");
    assert_eq!(tools.len(), 6);
    let results = tool_results(&env, 1);
    let metrics: Value = serde_json::from_str(&results[0]).unwrap();
    let weight = metrics["metrics"].as_array().unwrap().iter().find(|m| m["key"] == WEIGHT).unwrap();
    assert_eq!((weight["entries"].as_i64(), weight["unit"].as_str()), (Some(2), Some("kg")));
    assert_eq!(weight["newest"], "2026-03-10T12:00:00Z");
    assert!(results[1].contains("no such metric"));
    assert_eq!(results[2], json!({ "metric": "activity.steps", "entries": [] }).to_string());
    assert_eq!(results[3], json!({ "metric": WEIGHT, "entries": [] }).to_string());
    assert!(results[4].contains("YYYY-MM-DD"));
    assert!(results[5].contains("no tool list_scopes"));
    assert!(log(&mut a).await.entries.is_empty());
}

#[sqlx::test]
async fn a_turn_makes_at_most_eight_tool_calls_and_then_gets_no_tools(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    a.start_agent(&env.llm).await;
    let calls = |range: std::ops::Range<i32>| Reply {
        tool_calls: range.map(|i| (format!("c{i}"), "list_metrics".to_owned(), "{}".to_owned())).collect(),
        ..Reply::default()
    };
    env.llm.push(calls(0..5));
    env.llm.push(calls(5..9));
    env.llm.push(Reply::text(&["Done."]));
    let chat = Chat::new();
    let _: MessageSent = a.ok("message.send", &chat.send(&user, true, "Go")).await;
    let _: TurnDone = a.event("turn.done").await;
    let requests = env.llm.requests();
    assert_eq!(requests.len(), 3);
    assert!(requests[1].body.get("tools").is_some());
    // Past the limit the model cannot call again, so it has to reply.
    assert!(requests[2].body.get("tools").is_none());
    let results = tool_results(&env, 2);
    assert_eq!(results.len(), 9);
    assert!(results[..8].iter().all(|r| r.contains("metrics")));
    assert!(results[8].contains("too many tool calls"));
}

#[sqlx::test]
async fn session_context_is_filled_by_the_server_and_a_reload_asks_again(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    sqlx::query("UPDATE sessions SET timezone = 'Europe/Berlin', country = 'DE', locale = 'de' WHERE id = $1")
        .bind(user.principal.session_id)
        .execute(&env.db)
        .await
        .unwrap();
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    a.start_agent(&env.llm).await;
    env.llm.push(Reply::tool("c1", "session_context", r#"{"reason":"To know your time"}"#));
    env.llm.push(Reply::text(&["It is evening."]));
    let chat = Chat::new();
    let _: MessageSent = a.ok("message.send", &chat.send(&user, true, "What time is it?")).await;
    let request: PermissionRequest = a.event("permission.request").await;
    assert_eq!(request.grant, Grant::SessionContext {});
    // A reload: another socket of the same auth session finds it waiting.
    let (mut again, _) = Client::connect(&env, &user.principal, None).await;
    let pending: PermissionList = again.ok("permission.pending", &PermissionPending {}).await;
    assert_eq!(pending.requests, std::slice::from_ref(&request));
    let with_result = PermissionRespond {
        request_id: request.request_id,
        decision: Decision::Approve,
        result: Some(Secret("{}".into())),
    };
    assert_eq!(again.refused("permission.respond", &with_result).await, ErrorCode::Malformed);
    let approve = PermissionRespond { result: None, ..with_result };
    let _: Empty = again.ok("permission.respond", &approve).await;
    // Every socket of the auth session hears that it ended.
    let resolved: PermissionResolved = a.event("permission.resolved").await;
    assert_eq!(resolved.outcome, Outcome::Approved);
    let _: TurnDone = a.event("turn.done").await;
    let context: Value = serde_json::from_str(&tool_results(&env, 1)[0]).unwrap();
    assert_eq!((context["timezone"].as_str(), context["country"].as_str()), (Some("Europe/Berlin"), Some("DE")));
    assert_eq!(context["locale"], "de");
    assert!(context["utc_time"].as_str().unwrap().ends_with('Z'));
    assert!(context.get("ip").is_none());
}

#[sqlx::test]
async fn cancelling_the_turn_cancels_its_request(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    a.start_agent(&env.llm).await;
    env.llm.push(Reply::tool("c1", "session_context", r#"{"reason":"Time"}"#));
    let chat = Chat::new();
    let sent: MessageSent = a.ok("message.send", &chat.send(&user, true, "Time?")).await;
    let request: PermissionRequest = a.event("permission.request").await;
    let _: Empty = a.ok("turn.cancel", &json!({ "chat_id": chat.id })).await;
    let resolved: PermissionResolved = a.event("permission.resolved").await;
    assert_eq!((resolved.request_id, resolved.outcome), (request.request_id, Outcome::Cancelled));
    let tools = reply_tools(&mut a, &chat, &user, &sent).await;
    assert_eq!(tools[0].outcome, Some(Outcome::Cancelled));
    assert_eq!(log(&mut a).await.entries[0].outcome, Some(Outcome::Cancelled));
    let answer = PermissionRespond { request_id: request.request_id, decision: Decision::Deny, result: None };
    assert_eq!(a.refused("permission.respond", &answer).await, ErrorCode::PermissionNotFound);
}

#[sqlx::test]
async fn an_unanswered_request_times_out_and_the_model_replies(db: PgPool) {
    // 31 s of turn leave a request 1 s: the rest is for the reply.
    let ws = WsSettings { turn_limit: Duration::from_secs(31), ..WsSettings::default() };
    let env = start_with(db, ws).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    a.start_agent(&env.llm).await;
    env.llm.push(Reply::tool("c1", "session_context", r#"{"reason":"Time"}"#));
    env.llm.push(Reply::text(&["I could not tell."]));
    let chat = Chat::new();
    let _: MessageSent = a.ok("message.send", &chat.send(&user, true, "Time?")).await;
    let request: PermissionRequest = a.event("permission.request").await;
    let resolved: PermissionResolved = a.event("permission.resolved").await;
    assert_eq!((resolved.request_id, resolved.outcome), (request.request_id, Outcome::Timeout));
    let _: TurnDone = a.event("turn.done").await;
    assert!(tool_results(&env, 1)[0].contains("did not answer"));
}

#[sqlx::test]
async fn the_access_log_pages_newest_first(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let stranger = self::user(&env.db).await;
    for _ in 0..51 {
        sqlx::query(
            "INSERT INTO access_log (id, user_id, session_id, chat_id, turn_id, provider_id, tool, reason, expires_at,
                 outcome, decided_at)
             VALUES ($1, $2, $3, $4, $4, $4, 'session_context', '\\x01', now(), 'denied', now())",
        )
        .bind(Uuid::now_v7())
        .bind(user.principal.user_id)
        .bind(user.principal.session_id)
        .bind(Uuid::now_v7())
        .execute(&env.db)
        .await
        .unwrap();
    }
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    let first = log(&mut a).await;
    assert_eq!(first.entries.len(), 50);
    assert!(first.entries.windows(2).all(|w| w[0].id > w[1].id));
    let next: AccessLogPage = a.ok("access_log.list", &AccessLogList { before: first.next }).await;
    assert_eq!((next.entries.len(), next.next), (1, None));
    let (mut s, _) = Client::connect(&env, &stranger.principal, None).await;
    assert!(log(&mut s).await.entries.is_empty());
}

#[sqlx::test]
async fn a_request_left_without_an_outcome_reads_as_timed_out_and_old_ones_are_swept(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let insert = |requested: &'static str, expires: &'static str| {
        let db = env.db.clone();
        let (user_id, session_id) = (user.principal.user_id, user.principal.session_id);
        async move {
            let sql = match (requested, expires) {
                ("now", "past") => {
                    "INSERT INTO access_log (id, user_id, session_id, chat_id, turn_id, provider_id, tool, reason,
                         expires_at)
                     VALUES ($1, $2, $3, $1, $1, $1, 'session_context', '\\x01', now() - interval '2 minutes')"
                }
                ("now", _) => {
                    "INSERT INTO access_log (id, user_id, session_id, chat_id, turn_id, provider_id, tool, reason,
                         expires_at)
                     VALUES ($1, $2, $3, $1, $1, $1, 'session_context', '\\x01', now() + interval '2 minutes')"
                }
                _ => {
                    "INSERT INTO access_log (id, user_id, session_id, chat_id, turn_id, provider_id, tool, reason,
                         requested_at, expires_at)
                     VALUES ($1, $2, $3, $1, $1, $1, 'session_context', '\\x01', now() - interval '400 days',
                         now() - interval '400 days')"
                }
            };
            let id = Uuid::now_v7();
            sqlx::query(sql).bind(id).bind(user_id).bind(session_id).execute(&db).await.unwrap();
            id
        }
    };
    let old = insert("old", "past").await;
    let dead = insert("now", "past").await;
    let waiting = insert("now", "future").await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    let page = log(&mut a).await;
    let outcome = |id: Uuid| page.entries.iter().find(|e| e.id == id).and_then(|e| e.outcome);
    assert_eq!((outcome(dead), outcome(waiting)), (Some(Outcome::Timeout), None));
    let swept = chat_server::auth::retention::sweep(&env.db, 365, Duration::from_secs(3600)).await.unwrap();
    assert_eq!(swept.access_log, 1);
    let page = log(&mut a).await;
    assert!(page.entries.iter().all(|e| e.id != old));
    assert_eq!(page.entries.len(), 2);
}

/// A chat whose first exchange (messages 0 and 1) is done, so the next turn has history before it.
async fn chat_with_history(env: &Env, a: &mut Client, user: &User) -> Chat {
    env.llm.push(Reply::text(&["Hello."]));
    let chat = Chat::new();
    let _: MessageSent = a.ok("message.send", &chat.send(user, true, "Hi")).await;
    let _: TurnDone = a.event("turn.done").await;
    chat
}

fn history(count: u32) -> String {
    json!({ "count": count, "reason": "To recall the plan" }).to_string()
}

fn answer(request: &PermissionRequest, result: &str) -> PermissionRespond {
    PermissionRespond {
        request_id: request.request_id,
        decision: Decision::Answer,
        result: Some(Secret(result.into())),
    }
}

#[sqlx::test]
async fn history_is_answered_by_the_client_and_the_reply_counts_it(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let audit = audit_keys(&env.db, &user).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    a.start_agent(&env.llm).await;
    let chat = chat_with_history(&env, &mut a, &user).await;
    // Nothing was before the first message.
    assert_eq!(env.llm.requests()[0].body["tools"].as_array().unwrap().len(), 9);
    env.llm.push(Reply::tool("c1", "read_history", &history(10)));
    // Past the context's start it reads from there.
    env.llm.push(Reply::tool("c2", "read_history", &json!({ "before": 1000, "count": 3 }).to_string()));
    env.llm.push(Reply::text(&["We planned a trip."]));
    let sent: MessageSent = a.ok("message.send", &chat.send(&user, false, "What did we plan?")).await;
    let request: PermissionRequest = a.event("permission.request").await;
    // Before the user's message, as the context is empty.
    assert_eq!(request.grant, Grant::ReadHistory { before: 2, count: 10 });
    assert_eq!(reason(&user, &audit, &request), "To recall the plan");
    let now = time::OffsetDateTime::now_utc().unix_timestamp() * 1000;
    assert!(request.expires_at - now <= 31_000, "a history read waits 30 seconds");
    let pending: PermissionList = a.ok("permission.pending", &PermissionPending {}).await;
    assert_eq!(pending.requests[0].grant, request.grant);
    // Answered or refused, never decided; at most 32 KiB.
    for decision in [Decision::Approve, Decision::Deny] {
        let respond = PermissionRespond { decision, ..answer(&request, "{}") };
        assert_eq!(a.refused("permission.respond", &respond).await, ErrorCode::Malformed);
    }
    let bare = PermissionRespond { result: None, ..answer(&request, "") };
    assert_eq!(a.refused("permission.respond", &bare).await, ErrorCode::Malformed);
    let large = answer(&request, &"x".repeat(HISTORY_MAX + 1));
    assert_eq!(a.refused("permission.respond", &large).await, ErrorCode::Malformed);
    let result = r#"{"messages":[{"id":0,"role":"user","text":"Hi"},{"id":1,"role":"assistant","text":"Hello."}]}"#;
    let _: Empty = a.ok("permission.respond", &answer(&request, result)).await;
    let resolved: PermissionResolved = a.event("permission.resolved").await;
    assert_eq!(resolved.outcome, Outcome::Answered);
    let second: PermissionRequest = a.event("permission.request").await;
    assert_eq!(second.grant, Grant::ReadHistory { before: 2, count: 3 });
    let refuse = PermissionRespond { request_id: second.request_id, decision: Decision::Refuse, result: None };
    let _: Empty = a.ok("permission.respond", &refuse).await;

    let tools = reply_tools(&mut a, &chat, &user, &sent).await;
    let history_use = |count, outcome| ToolUse {
        tool: "read_history".into(),
        metric: None,
        from: None,
        to: None,
        count,
        host: None,
        outcome: Some(outcome),
    };
    assert_eq!(tools, [history_use(Some(2), Outcome::Answered), history_use(Some(3), Outcome::Refused)]);
    let _: TurnDone = a.event("turn.done").await;
    let asked = &env.llm.requests()[1].body;
    assert!(asked["tools"].as_array().unwrap().iter().any(|t| t.to_string().contains("read_history")));
    assert!(asked.to_string().contains("start at message 2"));
    assert_eq!(tool_results(&env, 3)[0], result);
    let page = log(&mut a).await;
    assert_eq!(page.entries[1].grant, Grant::ReadHistory { before: 2, count: 10 });
    assert_eq!(page.entries[1].outcome, Some(Outcome::Answered));
}

#[sqlx::test]
async fn failed_code_goes_back_to_the_model_and_can_be_run_again(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let audit = audit_keys(&env.db, &user).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    a.start_agent(&env.llm).await;
    let args = |code: &str| json!({ "code": code, "reason": "Adds it up" }).to_string();
    env.llm.push(Reply::tool("c1", "run_code", &args("sum(")));
    env.llm.push(Reply::tool("c2", "run_code", &args("1 + 1")));
    env.llm.push(Reply::tool("c3", "run_code", &args("2 + 2")));
    env.llm.push(Reply::text(&["Four."]));
    let chat = Chat::new();
    let _: MessageSent = a.ok("message.send", &chat.send(&user, true, "Add it up")).await;

    // The sandbox's error is an answer; the code and reason stay sealed in the log.
    let first: PermissionRequest = a.event("permission.request").await;
    assert_eq!(first.grant, Grant::RunCode {});
    assert!(reason(&user, &audit, &first).contains("sum("));
    let _: Empty = a.ok("permission.respond", &answer(&first, r#"{"output":"","error":"SyntaxError"}"#)).await;
    // A refusal does not close the tool for the corrected code.
    let second: PermissionRequest = a.event("permission.request").await;
    let refuse = PermissionRespond { request_id: second.request_id, decision: Decision::Refuse, result: None };
    let _: Empty = a.ok("permission.respond", &refuse).await;
    let third: PermissionRequest = a.event("permission.request").await;
    let _: Empty = a.ok("permission.respond", &answer(&third, r#"{"output":"","value":4}"#)).await;
    let _: TurnDone = a.event("turn.done").await;

    let sent = env.llm.requests().last().unwrap().body.to_string();
    assert!(sent.contains("SyntaxError") && sent.contains("did not run this code") && sent.contains("value"));
}

#[sqlx::test]
async fn a_site_is_approved_once_per_turn_and_a_denied_one_stays_denied(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let audit = audit_keys(&env.db, &user).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    a.start_agent(&env.llm).await;
    let args = |url: &str| json!({ "url": url, "reason": "For the forecast" }).to_string();
    // Resolves to no public address here, so each read fails the same way without leaving the machine.
    env.llm.push(Reply::tool("c1", "web_fetch", &args("https://localhost/one")));
    env.llm.push(Reply::tool("c2", "web_fetch", &args("https://localhost/two?secret=1")));
    env.llm.push(Reply::tool("c3", "web_fetch", &args("https://other.invalid/")));
    env.llm.push(Reply::tool("c4", "web_fetch", &args("https://other.invalid/again")));
    env.llm.push(Reply::tool("c5", "web_fetch", &args("http://localhost/plain")));
    env.llm.push(Reply::text(&["No forecast."]));
    let chat = Chat::new();
    let sent: MessageSent = a.ok("message.send", &chat.send(&user, true, "The weather?")).await;

    let first: PermissionRequest = a.event("permission.request").await;
    assert_eq!(first.grant, Grant::WebFetch {});
    assert!(reason(&user, &audit, &first).contains("https://localhost/one"));
    let approve = PermissionRespond { request_id: first.request_id, decision: Decision::Approve, result: None };
    let _: Empty = a.ok("permission.respond", &approve).await;
    // The same site again asks no one; the next one does, once.
    let other: PermissionRequest = a.event("permission.request").await;
    assert!(reason(&user, &audit, &other).contains("other.invalid"));
    let deny = PermissionRespond { request_id: other.request_id, decision: Decision::Deny, result: None };
    let _: Empty = a.ok("permission.respond", &deny).await;
    let _: TurnDone = a.event("turn.done").await;

    let tools = reply_tools(&mut a, &chat, &user, &sent).await;
    let seen: Vec<_> = tools.iter().map(|t| (t.host.as_deref(), t.outcome)).collect();
    assert_eq!(
        seen,
        [
            (Some("localhost"), Some(Outcome::Approved)),
            (Some("localhost"), Some(Outcome::Answered)),
            (Some("other.invalid"), Some(Outcome::Denied)),
            (Some("other.invalid"), Some(Outcome::Denied)),
            (None, Some(Outcome::Answered)),
        ]
    );
    let asked = env.llm.requests().last().unwrap().body.to_string();
    assert!(asked.contains("is not public") || asked.contains("not public"));
    assert!(asked.contains("only https"));
    // Nothing in the log's clear columns names the site.
    let page: AccessLogPage = a.ok("access_log.list", &json!({})).await;
    assert!(page.entries.iter().all(|e| e.grant == Grant::WebFetch {}));
}

#[sqlx::test]
async fn weather_asks_only_for_the_place_by_ip_and_never_tells_the_ip(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let audit = audit_keys(&env.db, &user).await;
    sqlx::query("UPDATE sessions SET ip = '8.8.4.4' WHERE id = $1")
        .bind(user.principal.session_id)
        .execute(&env.db)
        .await
        .unwrap();
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    a.start_agent(&env.llm).await;
    let args = |v: Value| v.to_string();
    // Named: no dialog. A field holding more than a place never leaves.
    env.llm.push(Reply::tool("c1", "get_weather", &args(json!({ "place": "Bergen", "reason": "x" }))));
    env.llm.push(Reply::tool("c2", "get_weather", &args(json!({ "place": "weight=81", "reason": "x" }))));
    // Unnamed: asked, with the city found; denied, it is not asked again.
    env.llm.push(Reply::tool("c3", "get_weather", &args(json!({ "reason": "For today" }))));
    env.llm.push(Reply::tool("c4", "get_weather", &args(json!({ "reason": "For today" }))));
    env.llm.push(Reply::text(&["Which city?"]));
    let chat = Chat::new();
    let _: MessageSent = a.ok("message.send", &chat.send(&user, true, "The weather?")).await;
    let asked: PermissionRequest = a.event("permission.request").await;
    assert_eq!(asked.grant, Grant::GetWeather {});
    let sealed = reason(&user, &audit, &asked);
    assert!(sealed.contains("Oslo") && sealed.contains("For today"), "{sealed}");
    assert!(!sealed.contains("8.8.4.4"));
    let deny = PermissionRespond { request_id: asked.request_id, decision: Decision::Deny, result: None };
    let _: Empty = a.ok("permission.respond", &deny).await;
    let _: TurnDone = a.event("turn.done").await;
    let sent = env.llm.requests().last().unwrap().body.to_string();
    assert!(sent.contains("could not be reached") || sent.contains("took too long"));
    assert!(sent.contains("only a city"));
    assert!(sent.contains("did not allow their place"));
    assert!(!sent.contains("8.8.4.4"));
}

#[sqlx::test]
async fn weather_without_a_known_place_tells_the_model_to_ask(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    // This session has no public address.
    sqlx::query("UPDATE sessions SET ip = '10.0.0.1' WHERE id = $1")
        .bind(user.principal.session_id)
        .execute(&env.db)
        .await
        .unwrap();
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    a.start_agent(&env.llm).await;
    env.llm.push(Reply::tool("c1", "get_weather", &json!({ "reason": "x" }).to_string()));
    env.llm.push(Reply::text(&["Which city?"]));
    let chat = Chat::new();
    let _: MessageSent = a.ok("message.send", &chat.send(&user, true, "The weather?")).await;
    let _: TurnDone = a.event("turn.done").await;
    assert!(env.llm.requests().last().unwrap().body.to_string().contains("ask them for their city"));
}

#[sqlx::test]
async fn a_chat_without_history_offers_no_way_back(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    a.start_agent(&env.llm).await;
    let chat = chat_with_history(&env, &mut a, &user).await;
    let settings = json!({ "chat_id": chat.id, "settings": { "history": { "mode": "recent", "messages": 0 } } });
    let _: serde_json::Value = a.ok("chat.configure", &settings).await;
    let before = env.llm.requests().len();
    env.llm.push(Reply::text(&["Sunny."]));
    let _: MessageSent = a.ok("message.send", &chat.send(&user, false, "The weather?")).await;
    let _: TurnDone = a.event("turn.done").await;
    let asked = &env.llm.requests()[before].body;
    let tools = asked["tools"].as_array().unwrap();
    assert!(!tools.iter().any(|t| t.to_string().contains("read_history")));
    assert!(!tools.iter().any(|t| t.to_string().contains("read_file")));
    assert!(!asked.to_string().contains("read_history reads"));
}

#[sqlx::test]
async fn the_model_rewrites_a_chats_memory_and_the_user_clears_it(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    let (mut other, _) = Client::connect(&env, &self::user(&env.db).await.principal, None).await;
    a.start_agent(&env.llm).await;
    let chat = chat_with_history(&env, &mut a, &user).await;
    let stored = async |a: &mut Client| {
        let got: chat_protocol::chat::ChatMemory = a.ok("chat.memory", &json!({ "chat_id": chat.id })).await;
        got.memory.is_some()
    };
    assert!(!stored(&mut a).await);

    // Too long is the model's to correct: nothing is stored, and no dialog is asked.
    let long = "x".repeat(8 * 1024 + 1);
    env.llm.push(Reply::tool("c1", "write_memory", &json!({ "content": long }).to_string()));
    env.llm.push(Reply::tool("c2", "write_memory", &json!({ "content": "Likes tea" }).to_string()));
    env.llm.push(Reply::text(&["Noted."]));
    let _: MessageSent = a.ok("message.send", &chat.send(&user, false, "Remember: tea")).await;
    let _: TurnDone = a.event("turn.done").await;
    let requests = env.llm.requests();
    assert!(requests[requests.len() - 2].body.to_string().contains("nothing was saved"));
    assert!(requests.last().unwrap().body.to_string().contains(r#"\"ok\":true"#));
    assert!(stored(&mut a).await);
    assert_eq!(other.refused("chat.memory", &json!({ "chat_id": chat.id })).await, ErrorCode::ChatNotFound);
    assert_eq!(other.refused("chat.memory.clear", &json!({ "chat_id": chat.id })).await, ErrorCode::ChatNotFound);
    assert!(stored(&mut a).await);

    // Sealed at rest, as the kind the client opens, under the chat's key.
    let record: Vec<u8> =
        sqlx::query_scalar("SELECT memory FROM chats WHERE id = $1").bind(chat.id).fetch_one(&env.db).await.unwrap();
    let place = Place { user: user.id(), scope: ScopeId::from_bytes(*chat.id.as_bytes()), kind: Kind::ChatMemory };
    let writer = user.ark.writer_key(&user.id()).public();
    let (plain, origin) = record::open(&place, &chat.keys, &writer, &record).unwrap();
    assert_eq!(plain.as_slice(), b"Likes tea");
    assert_eq!(origin, record::Origin::Server);

    // What the client sends reaches the system prompt.
    let mut send = chat.send(&user, false, "What do I like?");
    send.context.memory = Some(Secret("Likes tea".into()));
    env.llm.push(Reply::text(&["Tea."]));
    let _: MessageSent = a.ok("message.send", &send).await;
    let _: TurnDone = a.event("turn.done").await;
    assert!(env.llm.requests().last().unwrap().body.to_string().contains("Your memory of this chat"));

    // The model empties it; so can the user.
    env.llm.push(Reply::tool("c3", "write_memory", &json!({ "content": "" }).to_string()));
    env.llm.push(Reply::text(&["Forgotten."]));
    let _: MessageSent = a.ok("message.send", &chat.send(&user, false, "Forget it")).await;
    let _: TurnDone = a.event("turn.done").await;
    assert!(!stored(&mut a).await);
    let _: Empty = a.ok("chat.memory.clear", &json!({ "chat_id": chat.id })).await;
    assert!(!stored(&mut a).await);
}

#[sqlx::test]
async fn a_turn_reads_at_most_128_kib_of_history_and_a_refusal_is_not_asked_again(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    a.start_agent(&env.llm).await;
    let chat = chat_with_history(&env, &mut a, &user).await;
    for i in 0..5 {
        env.llm.push(Reply::tool(&format!("c{i}"), "read_history", &history(1)));
    }
    env.llm.push(Reply::text(&["Enough."]));
    let sent: MessageSent = a.ok("message.send", &chat.send(&user, false, "Everything?")).await;
    // A full result each time: four fit in 128 KiB.
    let pad = r#"{"messages":[],"pad":""}"#.len();
    let full = format!(r#"{{"messages":[],"pad":"{}"}}"#, "x".repeat(HISTORY_MAX - pad));
    for _ in 0..4 {
        let request: PermissionRequest = a.event("permission.request").await;
        let _: Empty = a.ok("permission.respond", &answer(&request, &full)).await;
    }
    let tools = reply_tools(&mut a, &chat, &user, &sent).await;
    assert_eq!(tools.len(), 5);
    assert_eq!(tools[0].count, Some(0));
    // Answered by the server with an error: nothing was read, so no count.
    assert_eq!((tools[4].outcome, tools[4].count), (Some(Outcome::Answered), None));
    let _: TurnDone = a.event("turn.done").await;
    assert!(tool_results(&env, 6)[4].contains("as much history as it may"));
    assert_eq!(log(&mut a).await.entries.len(), 4);

    env.llm.push(Reply::tool("r1", "read_history", &history(5)));
    env.llm.push(Reply::tool("r2", "read_history", &history(5)));
    env.llm.push(Reply::text(&["Cannot."]));
    let sent: MessageSent = a.ok("message.send", &chat.send(&user, false, "Again?")).await;
    let request: PermissionRequest = a.event("permission.request").await;
    let refuse = PermissionRespond { request_id: request.request_id, decision: Decision::Refuse, result: None };
    let _: Empty = a.ok("permission.respond", &refuse).await;
    let tools = reply_tools(&mut a, &chat, &user, &sent).await;
    let outcomes: Vec<Option<Outcome>> = tools.iter().map(|t| t.outcome).collect();
    assert_eq!(outcomes, [Some(Outcome::Refused), Some(Outcome::Refused)]);
    assert_eq!(tools[1].count, Some(5));
    let _: TurnDone = a.event("turn.done").await;
    let results = tool_results(&env, 9);
    assert!(results[1].contains("could not read this data earlier"), "{results:?}");
}

#[sqlx::test]
async fn an_entry_the_agent_proposes_stays_sealed_and_the_client_answers_with_what_it_stored(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let audit = audit_keys(&env.db, &user).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    a.start_agent(&env.llm).await;
    let args =
        json!({ "metric": WEIGHT, "value": 115.5, "day": "2026-03-01", "comment": "Morning", "reason": "You asked" });
    env.llm.push(Reply::tool("c1", "add_measurement", &args.to_string()));
    env.llm.push(Reply::text(&["Recorded."]));

    let chat = Chat::new();
    let sent: MessageSent = a.ok("message.send", &chat.send(&user, true, "I weigh 115.5")).await;
    let request: PermissionRequest = a.event("permission.request").await;
    // The grant names the metric alone: it works without a register yet.
    assert_eq!(request.grant, Grant::AddMeasurement { metric: WEIGHT.into() });
    let opened: Value = serde_json::from_str(&reason(&user, &audit, &request)).unwrap();
    assert_eq!(opened, json!({ "reason": "You asked", "value": 115.5, "day": "2026-03-01", "comment": "Morning" }));
    // Nothing of the entry is readable in the row.
    let row: (Option<String>, Option<String>, Vec<u8>) =
        sqlx::query_as("SELECT day_from, day_to, reason FROM access_log WHERE id = $1")
            .bind(request.request_id)
            .fetch_one(&env.db)
            .await
            .unwrap();
    assert_eq!((row.0, row.1), (None, None));
    assert!(!String::from_utf8_lossy(&row.2).contains("115.5"));
    // A reload asks again from the same record.
    let pending: PermissionList = a.ok("permission.pending", &PermissionPending {}).await;
    assert_eq!(pending.requests[0].grant, request.grant);
    // Approving carries what the client stored.
    let bare = PermissionRespond { request_id: request.request_id, decision: Decision::Approve, result: None };
    assert_eq!(a.refused("permission.respond", &bare).await, ErrorCode::Malformed);
    let stored = r#"{"recorded":true,"metric":"body.weight","unit":"kg","value":115.5,"day":"2026-03-01"}"#;
    let approve = PermissionRespond { result: Some(Secret(stored.into())), ..bare };
    let _: Empty = a.ok("permission.respond", &approve).await;
    let tools = reply_tools(&mut a, &chat, &user, &sent).await;
    assert_eq!(tool_results(&env, 1), vec![stored.to_owned()]);
    assert_eq!(tools[0].tool, "add_measurement");
    assert_eq!((tools[0].metric.as_deref(), tools[0].outcome), (Some(WEIGHT), Some(Outcome::Approved)));
    let page = log(&mut a).await;
    assert_eq!(page.entries[0].grant, Grant::AddMeasurement { metric: WEIGHT.into() });
}

#[sqlx::test]
async fn an_impossible_entry_is_answered_without_a_dialog_and_a_denied_one_is_not_asked_again(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let _audit = audit_keys(&env.db, &user).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    a.start_agent(&env.llm).await;
    let add = |metric: &str, value: f64| json!({ "metric": metric, "value": value, "reason": "x" }).to_string();
    env.llm.push(Reply::tool("c1", "add_measurement", &add("no.such", 1.0)));
    env.llm.push(Reply::tool("c2", "add_measurement", &add(WEIGHT, 99_999.0)));
    env.llm.push(Reply::tool("c3", "add_measurement", &add(WEIGHT, 80.0)));
    env.llm.push(Reply::tool("c4", "add_measurement", &add(WEIGHT, 81.0)));
    env.llm.push(Reply::text(&["Not recorded."]));

    let chat = Chat::new();
    let sent: MessageSent = a.ok("message.send", &chat.send(&user, true, "I weigh 80")).await;
    let request: PermissionRequest = a.event("permission.request").await;
    let deny = PermissionRespond { request_id: request.request_id, decision: Decision::Deny, result: None };
    let _: Empty = a.ok("permission.respond", &deny).await;
    let _ = reply_tools(&mut a, &chat, &user, &sent).await;
    let results = tool_results(&env, 4);
    assert!(results[0].contains("no such metric"), "{results:?}");
    assert!(results[1].contains("takes values"), "{results:?}");
    assert!(results[2].contains("nothing was recorded"), "{results:?}");
    assert!(results[3].contains("earlier in this turn"), "{results:?}");
    assert_eq!(log(&mut a).await.entries.len(), 1);
}

#[sqlx::test]
async fn a_goal_the_agent_proposes_stays_sealed_and_a_goal_the_metric_cannot_hold_asks_no_one(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let audit = audit_keys(&env.db, &user).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    a.start_agent(&env.llm).await;
    env.llm.push(Reply::tool(
        "c1",
        "set_goal",
        &json!({ "metric": WEIGHT, "target": 99_999, "reason": "x" }).to_string(),
    ));
    let args = json!({ "metric": WEIGHT, "target": 75.5, "until": "2027-03-01", "reason": "You asked" });
    env.llm.push(Reply::tool("c2", "set_goal", &args.to_string()));
    env.llm.push(Reply::text(&["Set."]));

    let chat = Chat::new();
    let sent: MessageSent = a.ok("message.send", &chat.send(&user, true, "A goal")).await;
    let request: PermissionRequest = a.event("permission.request").await;
    assert_eq!(request.grant, Grant::SetGoal { metric: WEIGHT.into() });
    let opened: Value = serde_json::from_str(&reason(&user, &audit, &request)).unwrap();
    assert_eq!(opened, json!({ "reason": "You asked", "target": 75.5, "until": "2027-03-01" }));
    let bare = PermissionRespond { request_id: request.request_id, decision: Decision::Approve, result: None };
    assert_eq!(a.refused("permission.respond", &bare).await, ErrorCode::Malformed);
    let stored = r#"{"stored":true}"#;
    let approve = PermissionRespond { result: Some(Secret(stored.into())), ..bare };
    let _: Empty = a.ok("permission.respond", &approve).await;
    let tools = reply_tools(&mut a, &chat, &user, &sent).await;
    let results = tool_results(&env, 2);
    assert!(results[0].contains("takes values"), "{results:?}");
    assert_eq!(results[1], stored);
    assert_eq!(tools[1].tool, "set_goal");
    assert_eq!((tools[1].metric.as_deref(), tools[1].outcome), (Some(WEIGHT), Some(Outcome::Approved)));
    let page = log(&mut a).await;
    assert_eq!(page.entries[0].grant, Grant::SetGoal { metric: WEIGHT.into() });
}

#[sqlx::test]
async fn a_reply_keeps_the_last_prompt_and_all_it_wrote_of_a_turn_of_several_requests(db: PgPool) {
    let env = start(db).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    a.start_agent(&env.llm).await;
    env.llm.push(Reply { usage: Some((100, 5)), ..Reply::tool("c1", "list_metrics", "{}") });
    env.llm.push(Reply { usage: Some((150, 7)), ..Reply::text(&["Done."]) });
    let chat = Chat::new();
    let sent: MessageSent = a.ok("message.send", &chat.send(&user, true, "What do I track?")).await;
    let content = reply_content(&mut a, &chat, &user, &sent).await;
    assert_eq!(content.usage, Some(chat_protocol::chat::TokenUsage { input: 150, output: 12 }));
}
