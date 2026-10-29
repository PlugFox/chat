//! Files in chats over a real socket and HTTP, against the fake LLM
//! (docs/protocol.md, "Files"; D-101).

#![allow(clippy::unwrap_used, clippy::expect_used, reason = "tests fail loudly")]

mod support;

use base64::Engine as _;
use chat_crypto::{
    file::{self, ContentKey},
    ids::{FileId, ScopeId},
    os_rng,
    record::{self, Kind, Place},
    scope::ScopeKeyPair,
};
use chat_protocol::{
    Bytes, Empty,
    chat::{
        ContextMessage, MessageContent, MessageDelete, MessageSend, MessageSent, NewChat, Revision, Role, TurnContext,
        TurnDone,
    },
    error::ErrorCode,
    files::{
        ContextFile, FileCreate, FileDescribed, FileRecordList, FileRecords, FileUsage, FileUsed, SentFile,
        UNATTACHED_MAX,
    },
    permissions::{AccessLogList, AccessLogPage, Decision, Grant, Outcome, PermissionRequest, PermissionRespond},
    redact::Secret,
};
use chat_server::files;
use serde_json::{Value, json};
use sqlx::PgPool;
use support::{
    ORIGIN,
    fake_llm::Reply,
    socket::{Client, Env, User, payload, start, start_files, user},
};
use uuid::Uuid;

/// A JPEG as far as its first bytes tell.
fn photo() -> Vec<u8> {
    let mut data = vec![0xff, 0xd8, 0xff, 0xe0];
    data.extend((0..70_000u32).map(|i| (i % 251) as u8));
    data
}

struct Chat {
    id: Uuid,
    keys: ScopeKeyPair,
}

/// A file encrypted for a chat: its object, key and records.
struct Sealed {
    id: Uuid,
    plaintext: Vec<u8>,
    key: ContentKey,
    object: Vec<u8>,
    key_record: Vec<u8>,
}

impl Chat {
    fn new() -> Self {
        Self { id: Uuid::now_v7(), keys: ScopeKeyPair::generate(1, &mut os_rng()) }
    }

    fn place(&self, user: &User, kind: Kind<'static>) -> Place<'static> {
        Place { user: user.id(), scope: ScopeId::from_bytes(*self.id.as_bytes()), kind }
    }

    fn seal(&self, user: &User, plaintext: Vec<u8>) -> Sealed {
        let id = Uuid::now_v7();
        let file_id = FileId::from_bytes(*id.as_bytes());
        let key = ContentKey::generate(&mut os_rng());
        let object = file::encrypt(&key, user.id(), file_id, &plaintext, &mut os_rng()).unwrap();
        let writer = user.ark.writer_key(&user.id());
        let key_record = record::seal_as_client(
            &self.place(user, Kind::FileKey { file_id }),
            &self.keys.public(),
            &writer,
            key.as_bytes(),
            &mut os_rng(),
        )
        .unwrap();
        Sealed { id, plaintext, key, object, key_record }
    }

    fn create(&self, file: &Sealed) -> FileCreate {
        FileCreate {
            file_id: file.id,
            chat_id: self.id,
            size: u32::try_from(file.object.len()).unwrap(),
            key: Bytes(file.key_record.clone()),
            preview: None,
        }
    }

    fn send(&self, user: &User, new: bool, text: &str, files: Vec<SentFile>) -> MessageSend {
        let scope = ScopeId::from_bytes(*self.id.as_bytes());
        MessageSend {
            idempotency_key: Uuid::now_v7(),
            chat_id: self.id,
            new_chat: new.then(|| NewChat {
                public_key: Bytes(self.keys.public().key.as_bytes().to_vec()),
                wrapped_private_key: Bytes(self.keys.wrap(&user.ark, &user.id(), &scope, &mut os_rng())),
                title: None,
                settings: None,
            }),
            text: Secret(text.into()),
            context: TurnContext::default(),
            files,
        }
    }

    fn open(&self, user: &User, kind: Kind<'static>, sealed: &[u8]) -> (Vec<u8>, record::Origin) {
        let writer = user.ark.writer_key(&user.id()).public();
        let (plain, origin) = record::open(&self.place(user, kind), &self.keys, &writer, sealed).unwrap();
        (plain.to_vec(), origin)
    }
}

fn sent(file: &Sealed, name: &str) -> SentFile {
    SentFile {
        file_id: file.id,
        key: Bytes(file.key.as_bytes().to_vec()),
        name: Secret(name.into()),
        media_type: "image/jpeg".into(),
        size: u32::try_from(file.plaintext.len()).unwrap(),
        w: Some(2000),
        h: Some(1500),
        hash: Some(Bytes(vec![9; 25])),
        original: None,
    }
}

fn url(env: &Env, id: Uuid) -> String {
    format!("http://{}/files/{id}", env.addr)
}

fn bearer(env: &Env, user: &User) -> String {
    support::token(&env.state.auth, user.principal.user_id, user.principal.session_id, 600)
}

async fn put(env: &Env, user: &User, id: Uuid, body: Vec<u8>) -> (u16, Value) {
    let response = reqwest::Client::new()
        .put(url(env, id))
        .bearer_auth(bearer(env, user))
        .header("origin", ORIGIN)
        .body(body)
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or_default())
}

async fn get(env: &Env, user: &User, id: Uuid) -> (u16, Vec<u8>) {
    let response = reqwest::Client::new().get(url(env, id)).bearer_auth(bearer(env, user)).send().await.unwrap();
    let status = response.status().as_u16();
    (status, response.bytes().await.unwrap().to_vec())
}

/// Registers and uploads a file.
async fn upload(env: &Env, client: &mut Client, user: &User, chat: &Chat, file: &Sealed) {
    let _: Empty = client.ok("file.create", &chat.create(file)).await;
    assert_eq!(put(env, user, file.id, file.object.clone()).await.0, 201);
}

#[sqlx::test]
async fn a_file_is_uploaded_sent_given_to_the_model_and_described(db: PgPool) {
    let env = start_files(db, Some(1_000_000_000)).await;
    let user = user(&env.db).await;
    let (mut a, ok) = Client::connect(&env, &user.principal, None).await;
    assert_eq!(payload::<Value>(&ok)["files"], true);
    a.start_agent(&env.llm).await;
    let chat = Chat::new();
    let file = chat.seal(&user, photo());

    // The chat does not exist yet: its first message creates it.
    let _: Empty = a.ok("file.create", &chat.create(&file)).await;
    let _: Empty = a.ok("file.create", &chat.create(&file)).await;
    let changed = FileCreate { size: chat.create(&file).size + 16, ..chat.create(&file) };
    assert_eq!(a.refused("file.create", &changed).await, ErrorCode::Malformed);
    // Not uploaded: no object, and a send cannot take it.
    assert_eq!(get(&env, &user, file.id).await.0, 404);
    let early = chat.send(&user, true, "Look", vec![sent(&file, "cat.jpg")]);
    assert_eq!(a.refused("message.send", &early).await, ErrorCode::FileNotFound);
    // The body must be the object it was created as.
    let (status, body) = put(&env, &user, file.id, file.object[..file.object.len() - 1].to_vec()).await;
    assert_eq!((status, body["code"].as_str()), (400, Some("protocol.malformed")));
    let mut other = file.object.clone();
    other[1] ^= 1;
    assert_eq!(put(&env, &user, file.id, other).await.0, 400);
    assert_eq!(put(&env, &user, file.id, file.object.clone()).await.0, 201);
    let (status, body) = put(&env, &user, file.id, file.object.clone()).await;
    assert_eq!((status, body["code"].as_str()), (409, Some("file.exists")));
    assert_eq!(get(&env, &user, file.id).await, (200, file.object.clone()));
    let stranger = support::socket::user(&env.db).await;
    assert_eq!(get(&env, &stranger, file.id).await.0, 404);
    assert_eq!(put(&env, &stranger, file.id, file.object.clone()).await.0, 404);

    env.llm.describe(Reply::text(&["A cat on ", "a sofa."]));
    env.llm.push(Reply::text(&["What a cat."]));
    // A size that is not the object's is refused.
    let lying = SentFile { size: 10, ..sent(&file, "cat.jpg") };
    let request = chat.send(&user, true, "Look", vec![lying]);
    assert_eq!(a.refused("message.send", &request).await, ErrorCode::FileNotFound);
    let sent_message: MessageSent =
        a.ok("message.send", &chat.send(&user, true, "Look at him", vec![sent(&file, "cat.jpg")])).await;
    let _: TurnDone = a.event("turn.done").await;
    let described: FileDescribed = a.event("file.described").await;
    assert_eq!(described.file_id, file.id);
    let (text, origin) = chat.open(
        &user,
        Kind::FileDescription { file_id: FileId::from_bytes(*file.id.as_bytes()) },
        &described.description.0,
    );
    assert_eq!((String::from_utf8(text).unwrap(), origin), ("A cat on a sofa.".to_owned(), record::Origin::Server));

    // The user's record lists the file, without its key.
    let chunks: chat_protocol::chat::ChunkList =
        a.ok("message.chunks", &json!({ "chat_id": chat.id, "chunks": [{ "chunk": 0 }] })).await;
    let message = &chunks.chunks[0].messages[usize::try_from(sent_message.message_id).unwrap()];
    let (plain, _) = chat.open(
        &user,
        Kind::ChatMessage { message_id: sent_message.message_id, author: record::Author::User },
        &message.record.as_ref().unwrap().0,
    );
    assert!(!plain.windows(32).any(|w| w == file.key.as_bytes()));
    let content = MessageContent::decode(&plain).unwrap();
    assert_eq!((content.text.as_str(), content.files.len()), ("Look at him", 1));
    assert_eq!((content.files[0].id.clone(), content.files[0].name.as_str()), (file.id.to_string(), "cat.jpg"));

    // The model got the image before the text, as the content says it is.
    let turn = &env.llm.turn_requests()[0].body;
    let messages = turn["messages"].as_array().unwrap();
    let parts = messages[messages.len() - 2]["content"].as_array().unwrap();
    assert!(parts[0]["text"].as_str().unwrap().contains(&format!("[file {}: \"cat.jpg\", image/jpeg]", file.id)));
    let data = parts[1]["image_url"]["url"].as_str().unwrap().strip_prefix("data:image/jpeg;base64,").unwrap();
    assert_eq!(base64::engine::general_purpose::STANDARD.decode(data).unwrap(), file.plaintext);
    assert_eq!(messages[messages.len() - 1]["content"], "Look at him");
    // No other file in the chat: no read_file.
    assert!(!turn["tools"].as_array().unwrap().iter().any(|t| t["function"]["name"] == "read_file"));
    assert_eq!(env.llm.description_requests().len(), 1);

    let records: FileRecordList =
        a.ok("file.records", &FileRecords { chat_id: chat.id, file_ids: vec![file.id] }).await;
    assert_eq!(records.files.len(), 1);
    assert_eq!(records.files[0].key.0, file.key_record);
    assert_eq!(records.files[0].description, Some(described.description));
    let elsewhere: FileRecordList =
        a.ok("file.records", &FileRecords { chat_id: Uuid::now_v7(), file_ids: vec![file.id] }).await;
    assert!(elsewhere.files.is_empty());
    let used: FileUsed = a.ok("file.usage", &FileUsage {}).await;
    assert_eq!((used.used, used.quota), (i64::try_from(file.object.len()).unwrap(), Some(1_000_000_000)));
    // Attached once: another send cannot take it.
    let again = chat.send(&user, false, "Again", vec![sent(&file, "cat.jpg")]);
    assert_eq!(a.refused("message.send", &again).await, ErrorCode::FileNotFound);
}

#[sqlx::test]
async fn creating_a_file_keeps_to_the_quota_the_limit_and_the_chat(db: PgPool) {
    let env = start_files(db, Some(200_000)).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    let chat = Chat::new();
    let first = chat.seal(&user, photo());
    let _: Empty = a.ok("file.create", &chat.create(&first)).await;
    let second = chat.seal(&user, photo());
    let mut big = chat.create(&second);
    big.size = 150_000;
    assert_eq!(a.refused("file.create", &big).await, ErrorCode::FilesQuota);
    big.size = files::object_max() + 1;
    assert_eq!(a.refused("file.create", &big).await, ErrorCode::FileTooLarge);
    big.size = 10;
    assert_eq!(a.refused("file.create", &big).await, ErrorCode::Malformed);
    // A record sealed to another key version than a new chat's first.
    let mut wrong = chat.create(&second);
    wrong.key.0[2..6].copy_from_slice(&2u32.to_be_bytes());
    assert_eq!(a.refused("file.create", &wrong).await, ErrorCode::Malformed);
    // A scope that is not a chat of this account.
    let audit: Uuid = sqlx::query_scalar("SELECT id FROM scopes WHERE user_id = $1 AND kind = 'audit'")
        .bind(user.principal.user_id)
        .fetch_one(&env.db)
        .await
        .unwrap();
    let not_chat = FileCreate { chat_id: audit, ..chat.create(&second) };
    assert_eq!(a.refused("file.create", &not_chat).await, ErrorCode::ChatNotFound);
    sqlx::query(
        "INSERT INTO files (id, user_id, chat_id, size, key)
         SELECT gen_random_uuid(), $1, $2, 1, '\\x01' FROM generate_series(2, $3)",
    )
    .bind(user.principal.user_id)
    .bind(chat.id)
    .bind(UNATTACHED_MAX)
    .execute(&env.db)
    .await
    .unwrap();
    let small = chat.seal(&user, vec![1]);
    assert_eq!(a.refused("file.create", &chat.create(&small)).await, ErrorCode::FileLimit);

    // Without a store, files are off.
    let off = start(env.db.clone()).await;
    let (mut b, ok) = Client::connect(&off, &user.principal, None).await;
    assert_eq!(payload::<Value>(&ok)["files"], false);
    assert_eq!(b.refused("file.create", &chat.create(&small)).await, ErrorCode::FilesDisabled);
    assert_eq!(b.refused("file.usage", &FileUsage {}).await, ErrorCode::FilesDisabled);
}

#[sqlx::test]
async fn read_file_opens_an_earlier_file_with_the_key_the_client_answers(db: PgPool) {
    let env = start_files(db, None).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    a.start_agent(&env.llm).await;
    let chat = Chat::new();
    let file = chat.seal(&user, b"Milk, eggs, bread".to_vec());
    upload(&env, &mut a, &user, &chat, &file).await;
    env.llm.describe(Reply::text(&["A shopping list."]));
    env.llm.push(Reply::text(&["Noted."]));
    let first = SentFile { media_type: "text/plain".into(), w: None, h: None, hash: None, ..sent(&file, "list.txt") };
    let _: MessageSent = a.ok("message.send", &chat.send(&user, true, "My list", vec![first])).await;
    let _: TurnDone = a.event("turn.done").await;
    let _: FileDescribed = a.event("file.described").await;

    let arguments = json!({ "file_id": file.id, "reason": "To read the list" }).to_string();
    env.llm.push(Reply::tool("c1", "read_file", &arguments));
    env.llm.push(Reply::tool("c2", "read_file", &arguments));
    env.llm.push(Reply::text(&["Eggs are on it."]));
    let mut later = chat.send(&user, false, "Is there eggs?", Vec::new());
    later.context.messages.push(ContextMessage {
        id: 0,
        role: Role::User,
        text: Secret("My list".into()),
        files: vec![ContextFile {
            file_id: file.id,
            name: Secret("list.txt".into()),
            media_type: "text/plain".into(),
            size: 17,
            w: None,
            h: None,
            description: Some(Secret("A shopping list.".into())),
        }],
    });
    let _: MessageSent = a.ok("message.send", &later).await;
    let request: PermissionRequest = a.event("permission.request").await;
    assert_eq!(request.grant, Grant::ReadFile { file_id: file.id });
    let answer = |result: &str| PermissionRespond {
        request_id: request.request_id,
        decision: Decision::Answer,
        result: Some(Secret(result.into())),
    };
    // The answer is a key, nothing else.
    assert_eq!(a.refused("permission.respond", &answer("{}")).await, ErrorCode::Malformed);
    let approve = PermissionRespond { decision: Decision::Approve, ..answer("x") };
    assert_eq!(a.refused("permission.respond", &approve).await, ErrorCode::Malformed);
    let key = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(file.key.as_bytes());
    let _: Empty = a.ok("permission.respond", &answer(&key)).await;
    let _: TurnDone = a.event("turn.done").await;

    let turns = env.llm.turn_requests();
    let second = &turns[1].body;
    assert!(second["tools"].as_array().unwrap().iter().any(|t| t["function"]["name"] == "read_file"));
    let context = second["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["content"].as_str().is_some_and(|c| c.starts_with("My list")))
        .unwrap();
    assert!(
        context["content"]
            .as_str()
            .unwrap()
            .contains(&format!("[file {}: \"list.txt\", text/plain, 17 bytes. A shopping list.]", file.id))
    );
    // The file follows the tool's result; asked again, it is already there.
    let third = turns[2].body["messages"].as_array().unwrap().clone();
    let tool = third.iter().position(|m| m["role"] == "tool").unwrap();
    assert_eq!(third[tool]["content"], "The file is attached after these results.");
    let opened = third[tool + 1]["content"][0]["text"].as_str().unwrap();
    assert!(opened.contains("Milk, eggs, bread"), "{opened}");
    let fourth = turns[3].body["messages"].as_array().unwrap().clone();
    assert!(fourth.iter().any(|m| m["content"] == "This file is attached above in this turn."));
    let log: AccessLogPage = a.ok("access_log.list", &AccessLogList::default()).await;
    assert_eq!(log.entries.len(), 1);
    assert_eq!(
        (log.entries[0].grant.clone(), log.entries[0].outcome),
        (Grant::ReadFile { file_id: file.id }, Some(Outcome::Answered))
    );
}

#[sqlx::test]
async fn deleted_messages_and_unattached_files_leave_the_store(db: PgPool) {
    let env = start_files(db, None).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    a.start_agent(&env.llm).await;
    let chat = Chat::new();
    let file = chat.seal(&user, photo());
    upload(&env, &mut a, &user, &chat, &file).await;
    let left = chat.seal(&user, photo());
    upload(&env, &mut a, &user, &chat, &left).await;
    env.llm.describe(Reply::text(&["A cat."]));
    env.llm.push(Reply::text(&["Cat."]));
    let message: MessageSent = a.ok("message.send", &chat.send(&user, true, "Cat", vec![sent(&file, "cat.jpg")])).await;
    let _: TurnDone = a.event("turn.done").await;
    let store = env.state.files.clone().unwrap();

    let _: Revision = a.ok("message.delete", &MessageDelete { chat_id: chat.id, message_id: message.message_id }).await;
    let rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM files WHERE id = $1").bind(file.id).fetch_one(&env.db).await.unwrap();
    assert_eq!(rows, 0);
    assert!(store.read(file.id).await.is_ok(), "the sweep deletes the object");
    // A day later the file no message took goes too.
    sqlx::query("UPDATE files SET created_at = now() - interval '25 hours' WHERE id = $1")
        .bind(left.id)
        .execute(&env.db)
        .await
        .unwrap();
    let swept = files::sweep(&env.db, &store).await.unwrap();
    assert_eq!((swept.unattached, swept.objects), (1, 2));
    assert!(store.read(file.id).await.is_err() && store.read(left.id).await.is_err());
    let gone: i64 = sqlx::query_scalar("SELECT count(*) FROM file_objects_gone").fetch_one(&env.db).await.unwrap();
    assert_eq!(gone, 0);

    // Deleting the account removes its rows, and the sweep the objects.
    let kept = chat.seal(&user, photo());
    upload(&env, &mut a, &user, &chat, &kept).await;
    sqlx::query("DELETE FROM users WHERE id = $1").bind(user.principal.user_id).execute(&env.db).await.unwrap();
    assert_eq!(files::sweep(&env.db, &store).await.unwrap().objects, 1);
    assert!(store.read(kept.id).await.is_err());
}

#[sqlx::test]
async fn a_retry_gives_the_files_the_model_reads_and_never_an_original(db: PgPool) {
    let env = start_files(db, None).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    a.start_agent(&env.llm).await;
    let chat = Chat::new();
    let copy = chat.seal(&user, photo());
    let original = chat.seal(&user, vec![7; 300_000]);
    upload(&env, &mut a, &user, &chat, &copy).await;
    upload(&env, &mut a, &user, &chat, &original).await;
    let with_original = SentFile {
        original: Some(chat_protocol::files::SentOriginal {
            file_id: original.id,
            media_type: "image/heic".into(),
            size: u32::try_from(original.plaintext.len()).unwrap(),
        }),
        ..sent(&copy, "cat.jpg")
    };
    env.llm.describe(Reply::text(&["A cat."]));
    env.llm.push(Reply { error: Some((500, "down".into())), ..Reply::default() });
    let message: MessageSent = a.ok("message.send", &chat.send(&user, true, "Cat", vec![with_original])).await;
    let _: chat_protocol::chat::TurnError = a.event("turn.error").await;
    // The original is the message's own file, but not one the model reads: nothing else to open.
    let first = &env.llm.turn_requests()[0].body;
    assert!(!first["tools"].as_array().unwrap().iter().any(|t| t["function"]["name"] == "read_file"));

    let retry = |files: Vec<SentFile>| chat_protocol::chat::TurnRetry {
        chat_id: chat.id,
        message_id: message.message_id + 1,
        text: Secret("Cat".into()),
        context: TurnContext::default(),
        files,
    };
    let as_original =
        SentFile { file_id: original.id, key: Bytes(original.key.as_bytes().to_vec()), size: 1, ..sent(&copy, "x") };
    assert_eq!(a.refused("turn.retry", &retry(vec![as_original])).await, ErrorCode::FileNotFound);
    let smaller = SentFile { size: 10, ..sent(&copy, "cat.jpg") };
    assert_eq!(a.refused("turn.retry", &retry(vec![smaller])).await, ErrorCode::FileNotFound);
    assert_eq!(a.refused("turn.retry", &retry(Vec::new())).await, ErrorCode::FileNotFound);
    env.llm.push(Reply::text(&["A cat."]));
    let _: chat_protocol::chat::TurnStarted = a.ok("turn.retry", &retry(vec![sent(&copy, "cat.jpg")])).await;
    let _: TurnDone = a.event("turn.done").await;
    let again = &env.llm.turn_requests()[1].body;
    let messages = again["messages"].as_array().unwrap();
    let parts = messages[messages.len() - 2]["content"].as_array().unwrap();
    assert_eq!(parts.len(), 2, "the copy only");
}

#[sqlx::test]
async fn a_file_that_is_not_the_size_it_was_sent_as_does_not_open(db: PgPool) {
    let env = start_files(db, None).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    a.start_agent(&env.llm).await;
    let chat = Chat::new();
    // Padding gives these two plaintext sizes one object size.
    let claimed = 70_000u32;
    let actual = (claimed..claimed + 4096).rev().find(|n| files::object_len(*n) == files::object_len(claimed)).unwrap();
    assert!(actual > claimed);
    let mut data = photo();
    data.resize(usize::try_from(actual).unwrap(), 1);
    let file = chat.seal(&user, data);
    upload(&env, &mut a, &user, &chat, &file).await;
    env.llm.push(Reply::text(&["Hm."]));
    let lying = SentFile { size: claimed, ..sent(&file, "cat.jpg") };
    let _: MessageSent = a.ok("message.send", &chat.send(&user, true, "Cat", vec![lying])).await;
    let _: TurnDone = a.event("turn.done").await;
    let body = &env.llm.turn_requests()[0].body;
    let messages = body["messages"].as_array().unwrap();
    let parts = messages[messages.len() - 2]["content"].as_array().unwrap();
    assert_eq!(parts.len(), 1);
    assert!(parts[0]["text"].as_str().unwrap().ends_with("could not be opened]"));
    assert!(env.llm.description_requests().is_empty());
}

#[sqlx::test]
async fn deleting_a_chat_deletes_its_files_attached_or_not(db: PgPool) {
    let env = start_files(db, None).await;
    let user = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &user.principal, None).await;
    a.start_agent(&env.llm).await;
    let chat = Chat::new();
    let sent_file = chat.seal(&user, photo());
    let left = chat.seal(&user, photo());
    upload(&env, &mut a, &user, &chat, &sent_file).await;
    upload(&env, &mut a, &user, &chat, &left).await;
    env.llm.describe(Reply::text(&["A cat."]));
    env.llm.push(Reply::text(&["Cat."]));
    let _: MessageSent = a.ok("message.send", &chat.send(&user, true, "Cat", vec![sent(&sent_file, "cat.jpg")])).await;
    let _: TurnDone = a.event("turn.done").await;
    let _: Empty = a.ok("chat.archive", &json!({ "chat_id": chat.id, "archived": true })).await;
    let _: Empty = a.ok("chat.delete", &json!({ "chat_id": chat.id })).await;
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM files WHERE chat_id = $1")
        .bind(chat.id)
        .fetch_one(&env.db)
        .await
        .unwrap();
    assert_eq!(rows, 0);
    let store = env.state.files.clone().unwrap();
    assert_eq!(files::sweep(&env.db, &store).await.unwrap().objects, 2);
    assert!(store.read(sent_file.id).await.is_err() && store.read(left.id).await.is_err());
}
