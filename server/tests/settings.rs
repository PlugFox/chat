//! Settings over a real socket (docs/protocol.md, "Settings"): revisions,
//! conflicts, resends, limits and events.

#![allow(clippy::unwrap_used, clippy::expect_used, reason = "tests fail loudly")]

mod support;

use chat_crypto::{
    ids::ScopeId,
    os_rng,
    record::{self, Kind, Place},
    scope::ScopeKeyPair,
};
use chat_protocol::{
    Bytes,
    error::ErrorCode,
    settings::{SETTING_MAX, SettingState, SettingStored, SettingsGet, SettingsPut, SettingsUpdated},
};
use sqlx::PgPool;
use support::socket::{Client, User, start, user};
use uuid::Uuid;

/// A `settings.value` record sealed the way a client seals it, to a scope key of `version`.
fn sealed(user: &User, version: u32, key: &str, value: &[u8]) -> Bytes {
    let place = Place {
        user: user.id(),
        scope: ScopeId::from_bytes(*Uuid::now_v7().as_bytes()),
        kind: Kind::SettingsValue { key },
    };
    let keys = ScopeKeyPair::generate(version, &mut os_rng());
    Bytes(
        record::seal_as_client(&place, &keys.public(), &user.ark.writer_key(&user.id()), value, &mut os_rng()).unwrap(),
    )
}

fn put(key: &str, record: &Bytes, rev: Option<i64>) -> SettingsPut {
    SettingsPut { key: key.into(), record: record.clone(), rev }
}

fn get(key: &str) -> SettingsGet {
    SettingsGet { key: key.into() }
}

#[sqlx::test]
async fn puts_reach_every_socket_of_the_user_only(db: PgPool) {
    let env = start(db).await;
    let alice = user(&env.db).await;
    let bob = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &alice.principal, None).await;
    let (mut a2, _) = Client::connect(&env, &alice.principal, None).await;
    let (mut b, _) = Client::connect(&env, &bob.principal, None).await;

    let none: SettingState = a.ok("settings.get", &get("providers")).await;
    assert!(none.value.is_none());
    let first = sealed(&alice, 1, "providers", b"one");
    let stored: SettingStored = a.ok("settings.put", &put("providers", &first, None)).await;
    assert_eq!(stored.rev, 1);
    for socket in [&mut a, &mut a2] {
        let event: SettingsUpdated = socket.event("settings.updated").await;
        assert_eq!((event.key.as_str(), event.record.0.as_slice(), event.rev), ("providers", first.0.as_slice(), 1));
    }
    let got: SettingState = a2.ok("settings.get", &get("providers")).await;
    let value = got.value.unwrap();
    assert_eq!((value.record.0, value.rev), (first.0.clone(), 1));

    // Bob's own put comes after Alice's on the bus: had hers reached him, it would be first.
    let theirs: SettingState = b.ok("settings.get", &get("providers")).await;
    assert!(theirs.value.is_none());
    let bobs = sealed(&bob, 1, "providers", b"b");
    let _: SettingStored = b.ok("settings.put", &put("providers", &bobs, None)).await;
    let event: SettingsUpdated = b.event("settings.updated").await;
    assert_eq!(event.record.0, bobs.0);
    assert!(b.events.is_empty());
    let ours: SettingState = a.ok("settings.get", &get("providers")).await;
    assert_eq!(ours.value.unwrap().record.0, first.0);
}

#[sqlx::test]
async fn a_put_based_on_another_revision_conflicts(db: PgPool) {
    let env = start(db).await;
    let alice = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &alice.principal, None).await;
    let one = sealed(&alice, 1, "providers", b"one");
    let two = sealed(&alice, 1, "providers", b"two");
    let three = sealed(&alice, 1, "providers", b"three");

    let _: SettingStored = a.ok("settings.put", &put("providers", &one, None)).await;
    // A second device that never saw `one` creates the key too.
    assert_eq!(a.refused("settings.put", &put("providers", &two, None)).await, ErrorCode::SettingsConflict);
    let stored: SettingStored = a.ok("settings.put", &put("providers", &two, Some(1))).await;
    assert_eq!(stored.rev, 2);
    // A device still on revision 1.
    assert_eq!(a.refused("settings.put", &put("providers", &three, Some(1))).await, ErrorCode::SettingsConflict);
    assert_eq!(a.refused("settings.put", &put("providers", &three, Some(3))).await, ErrorCode::SettingsConflict);
    // A resend of the put that made revision 2 answers with it and changes nothing.
    let again: SettingStored = a.ok("settings.put", &put("providers", &two, Some(1))).await;
    assert_eq!(again.rev, 2);
    let got: SettingState = a.ok("settings.get", &get("providers")).await;
    assert_eq!(got.value.unwrap().record.0, two.0);
    // A put of a new key with a revision names a value that is not there.
    assert_eq!(
        a.refused("settings.put", &put("other", &sealed(&alice, 1, "other", b"x"), Some(1))).await,
        ErrorCode::SettingsConflict
    );
}

#[sqlx::test]
async fn racing_puts_on_one_revision_get_one_winner(db: PgPool) {
    let env = start(db).await;
    let alice = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &alice.principal, None).await;
    let (mut a2, _) = Client::connect(&env, &alice.principal, None).await;
    for base in [None, Some(1)] {
        let mine = put("providers", &sealed(&alice, 1, "providers", b"mine"), base);
        let theirs = put("providers", &sealed(&alice, 1, "providers", b"theirs"), base);
        let (x, y) = tokio::join!(a.call("settings.put", &mine), a2.call("settings.put", &theirs));
        let mut kinds = [support::socket::kind(x.last().unwrap()), support::socket::kind(y.last().unwrap())];
        kinds.sort();
        assert_eq!(kinds, ["error", "ok"], "base {base:?}");
    }
    let got: SettingState = a.ok("settings.get", &get("providers")).await;
    assert_eq!(got.value.unwrap().rev, 2);
}

#[sqlx::test]
async fn records_follow_the_latest_key_version(db: PgPool) {
    let env = start(db).await;
    let alice = user(&env.db).await;
    sqlx::query(concat!(
        "INSERT INTO scope_keys (scope_id, key_version, public_key, wrapped_private_key) ",
        "SELECT id, 2, $2, $3 FROM scopes WHERE user_id = $1 AND kind = 'settings'",
    ))
    .bind(alice.principal.user_id)
    .bind(vec![4u8; 32])
    .bind(vec![5u8; 73])
    .execute(&env.db)
    .await
    .unwrap();
    let (mut a, _) = Client::connect(&env, &alice.principal, None).await;
    assert_eq!(
        a.refused("settings.put", &put("providers", &sealed(&alice, 1, "providers", b"x"), None)).await,
        ErrorCode::Malformed
    );
    let _: SettingStored = a.ok("settings.put", &put("providers", &sealed(&alice, 2, "providers", b"x"), None)).await;
}

#[sqlx::test]
async fn deleting_the_user_deletes_the_settings(db: PgPool) {
    let env = start(db).await;
    let alice = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &alice.principal, None).await;
    let _: SettingStored = a.ok("settings.put", &put("providers", &sealed(&alice, 1, "providers", b"x"), None)).await;
    sqlx::query("DELETE FROM users WHERE id = $1").bind(alice.principal.user_id).execute(&env.db).await.unwrap();
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM settings").fetch_one(&env.db).await.unwrap();
    assert_eq!(n, 0);
}

#[sqlx::test]
async fn records_and_keys_are_checked(db: PgPool) {
    let env = start(db).await;
    let alice = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &alice.principal, None).await;
    let malformed = [
        put("providers", &sealed(&alice, 2, "providers", b"x"), None),
        put("providers", &Bytes(vec![]), None),
        put("providers", &Bytes(vec![1; 10]), None),
        put("Providers", &sealed(&alice, 1, "Providers", b"x"), None),
        put("", &sealed(&alice, 1, "", b"x"), None),
    ];
    for request in &malformed {
        assert_eq!(a.refused("settings.put", request).await, ErrorCode::Malformed, "{}", request.key);
    }
    let mut large = sealed(&alice, 1, "providers", &vec![7; SETTING_MAX]);
    assert!(large.0.len() > SETTING_MAX);
    assert_eq!(a.refused("settings.put", &put("providers", &large, None)).await, ErrorCode::Malformed);
    large.0.truncate(SETTING_MAX);
    // The server checks the header only; the reader rejects the rest.
    let _: SettingStored = a.ok("settings.put", &put("providers", &large, None)).await;
    assert_eq!(a.refused("settings.get", &get("a b")).await, ErrorCode::Malformed);
}

#[sqlx::test]
async fn an_account_holds_a_limited_number_of_keys(db: PgPool) {
    let env = start(db).await;
    let alice = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &alice.principal, None).await;
    for i in 0..32 {
        let key = format!("k{i}");
        let _: SettingStored = a.ok("settings.put", &put(&key, &sealed(&alice, 1, &key, b"x"), None)).await;
    }
    assert_eq!(
        a.refused("settings.put", &put("k32", &sealed(&alice, 1, "k32", b"x"), None)).await,
        ErrorCode::SettingsLimit
    );
    // Changing a key that exists is not adding one.
    let stored: SettingStored = a.ok("settings.put", &put("k0", &sealed(&alice, 1, "k0", b"y"), Some(1))).await;
    assert_eq!(stored.rev, 2);
}

#[sqlx::test]
async fn settings_need_keys(db: PgPool) {
    let env = start(db).await;
    let alice = user(&env.db).await;
    sqlx::query("DELETE FROM account_keys WHERE user_id = $1")
        .bind(alice.principal.user_id)
        .execute(&env.db)
        .await
        .unwrap();
    let (mut a, _) = Client::connect(&env, &alice.principal, None).await;
    assert_eq!(
        a.refused("settings.put", &put("providers", &sealed(&alice, 1, "providers", b"x"), None)).await,
        ErrorCode::KeysNotSetUp
    );
}
