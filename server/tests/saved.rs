//! Saved messages over a real socket (docs/protocol.md, "Saved messages"):
//! references, pages in parts, events, tombstones, ownership and the limit.
//! Chats and messages are made in SQL: the server never opens their records.

#![allow(clippy::unwrap_used, clippy::expect_used, reason = "tests fail loudly")]

mod support;

use chat_protocol::{
    error::ErrorCode,
    saved::{SAVED_MAX, SAVED_PAGE, SavedAt, SavedIds, SavedPage, SavedUpdated},
};
use serde_json::{Value, json};
use sqlx::PgPool;
use support::socket::{Client, kind, payload, start, user};
use uuid::Uuid;

/// A chat of `user` with messages `0..count`, each record `size` bytes.
async fn chat(db: &PgPool, user: Uuid, count: i64, size: usize) -> Uuid {
    let id = Uuid::now_v7();
    sqlx::query("INSERT INTO scopes (id, user_id, kind) VALUES ($1, $2, 'chat')")
        .bind(id)
        .bind(user)
        .execute(db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO chats (id, user_id, next_message_id, updated_at) VALUES ($1, $2, $3, 1)")
        .bind(id)
        .bind(user)
        .bind(count)
        .execute(db)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO messages (chat_id, id, author, state, rev, record)
         SELECT $1, n, 1 + n % 2, 1, n + 1, $3 FROM generate_series(0, $2 - 1) n",
    )
    .bind(id)
    .bind(count)
    .bind(vec![7u8; size])
    .execute(db)
    .await
    .unwrap();
    id
}

fn at(chat_id: Uuid, message_id: u32) -> Value {
    json!({ "chat_id": chat_id, "message_id": message_id })
}

async fn saved_ids(a: &mut Client, chat_id: Uuid) -> Vec<u32> {
    a.ok::<_, SavedIds>("saved.chat", &json!({ "chat_id": chat_id })).await.message_ids
}

#[sqlx::test]
async fn a_saved_message_is_a_reference_every_socket_hears_of(db: PgPool) {
    let env = start(db).await;
    let ann = user(&env.db).await;
    let bo = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &ann.principal, None).await;
    let (mut b, _) = Client::connect(&env, &ann.principal, None).await;
    let (mut c, _) = Client::connect(&env, &bo.principal, None).await;
    let chat = chat(&env.db, ann.principal.user_id, 3, 16).await;

    let first: SavedAt = a.ok("saved.add", &at(chat, 1)).await;
    let heard: SavedUpdated = b.event("saved.updated").await;
    assert_eq!((heard.chat_id, heard.message_id, heard.saved_at), (chat, 1, Some(first.saved_at)));
    // A resend returns the first time and changes nothing.
    let again: SavedAt = a.ok("saved.add", &at(chat, 1)).await;
    assert_eq!(again.saved_at, first.saved_at);
    a.ok::<_, SavedAt>("saved.add", &at(chat, 0)).await;
    assert_eq!(saved_ids(&mut a, chat).await, [0, 1]);

    a.ok::<_, Value>("saved.remove", &at(chat, 1)).await;
    a.ok::<_, Value>("saved.remove", &at(chat, 1)).await;
    // Every event of the calls above is in by the answer to a later call.
    b.ok::<_, Value>("ping", &json!({})).await;
    let updates: Vec<(u32, bool)> = b
        .events
        .drain(..)
        .filter(|(k, _)| k == "saved.updated")
        .map(|(_, f)| payload::<SavedUpdated>(&f))
        .map(|u| (u.message_id, u.saved_at.is_some()))
        .collect();
    assert_eq!(updates, [(0, true), (1, false)], "one event per change");
    assert_eq!(saved_ids(&mut a, chat).await, [0]);

    // Another account sees none of it and cannot touch it.
    c.ok::<_, Value>("ping", &json!({})).await;
    assert!(c.events.is_empty());
    for kind in ["saved.add", "saved.remove"] {
        assert_eq!(c.refused(kind, &at(chat, 0)).await, ErrorCode::ChatNotFound);
    }
    assert_eq!(c.refused("saved.chat", &json!({ "chat_id": chat })).await, ErrorCode::ChatNotFound);
    let page: SavedPage = c.ok("saved.list", &json!({})).await;
    assert!(page.items.is_empty());

    // Unknown messages and tombstones cannot be saved.
    assert_eq!(a.refused("saved.add", &at(chat, 9)).await, ErrorCode::MessageNotFound);
    a.ok::<_, Value>("message.delete", &at(chat, 2)).await;
    assert_eq!(a.refused("saved.add", &at(chat, 2)).await, ErrorCode::MessageNotFound);
}

#[sqlx::test]
async fn deleting_a_message_or_its_chat_takes_it_out_of_the_saved_ones(db: PgPool) {
    let env = start(db).await;
    let ann = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &ann.principal, None).await;
    let chat = chat(&env.db, ann.principal.user_id, 3, 16).await;
    for id in 0..3 {
        a.ok::<_, SavedAt>("saved.add", &at(chat, id)).await;
    }
    a.ok::<_, Value>("message.delete", &at(chat, 1)).await;
    assert_eq!(saved_ids(&mut a, chat).await, [0, 2]);

    a.ok::<_, Value>("chat.archive", &json!({ "chat_id": chat, "archived": true })).await;
    // An archived chat's saved messages stay listed.
    let page: SavedPage = a.ok("saved.list", &json!({})).await;
    assert_eq!(page.items.len(), 2);
    a.ok::<_, Value>("chat.delete", &json!({ "chat_id": chat })).await;
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM saved_messages").fetch_one(&env.db).await.unwrap();
    assert_eq!(left, 0);
}

#[sqlx::test]
async fn the_list_pages_newest_first_in_parts_with_chats_and_records(db: PgPool) {
    let env = start(db).await;
    let ann = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &ann.principal, None).await;
    let count = i64::try_from(SAVED_PAGE).unwrap() + 1;
    // Records large enough that a page needs several parts.
    let chat = chat(&env.db, ann.principal.user_id, count, 64 * 1024).await;
    sqlx::query("INSERT INTO saved_messages (user_id, chat_id, message_id, saved_at) SELECT $1, $2, n, 1000 + n FROM generate_series(0, $3 - 1) n")
        .bind(ann.principal.user_id)
        .bind(chat)
        .bind(count)
        .execute(&env.db)
        .await
        .unwrap();

    let frames = a.call("saved.list", &json!({})).await;
    assert!(frames.len() > 1);
    let mut items = Vec::new();
    let mut next = None;
    for (i, frame) in frames.iter().enumerate() {
        let last = i + 1 == frames.len();
        assert_eq!(kind(frame), if last { "ok" } else { "more" });
        let part: SavedPage = payload(frame);
        assert!(last || part.next.is_none(), "only the last part has the cursor");
        items.extend(part.items);
        next = part.next;
    }
    let ids: Vec<u32> = items.iter().map(|i| i.message.id).collect();
    assert_eq!(ids, (1..=u32::try_from(SAVED_PAGE).unwrap()).rev().collect::<Vec<_>>());
    let first = &items[0];
    assert_eq!((first.saved_at, first.chat.chat_id), (1000 + i64::from(first.message.id), chat));
    assert_eq!(first.message.record.as_ref().unwrap().0.len(), 64 * 1024);

    let next = next.expect("a second page");
    let rest: SavedPage = a.ok("saved.list", &json!({ "before": next })).await;
    assert_eq!(rest.items.iter().map(|i| i.message.id).collect::<Vec<_>>(), [0]);
    assert!(rest.next.is_none());
}

#[sqlx::test]
async fn an_account_saves_at_most_the_limit(db: PgPool) {
    let env = start(db).await;
    let ann = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &ann.principal, None).await;
    let chat = chat(&env.db, ann.principal.user_id, SAVED_MAX + 1, 1).await;
    sqlx::query("INSERT INTO saved_messages (user_id, chat_id, message_id, saved_at) SELECT $1, $2, n, n FROM generate_series(0, $3 - 1) n")
        .bind(ann.principal.user_id)
        .bind(chat)
        .bind(SAVED_MAX)
        .execute(&env.db)
        .await
        .unwrap();
    let last = u32::try_from(SAVED_MAX).unwrap();
    assert_eq!(a.refused("saved.add", &at(chat, last)).await, ErrorCode::SavedLimit);
    // One already saved still answers.
    a.ok::<_, SavedAt>("saved.add", &at(chat, 0)).await;
    a.ok::<_, Value>("saved.remove", &at(chat, 0)).await;
    a.ok::<_, SavedAt>("saved.add", &at(chat, last)).await;
}
