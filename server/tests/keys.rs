//! Keys storage (docs/protocol.md, "Keys"): setup, wraps, rotation, scope
//! keys, and the device wrap that ends with its session.

#![allow(clippy::unwrap_used, clippy::expect_used, reason = "tests fail loudly")]

mod support;

use chat_crypto::{
    ark::Ark,
    ids::{DeviceId, UserId, WrapId},
    os_rng,
    recovery::RecoveryKey,
    wrap::{ArkWrap, UnlockSecret, WrapMethod},
};
use chat_protocol::{
    Bytes,
    error::ErrorCode,
    keys::{AccountScopeKind, KeysSetup, NewAccountScope},
};
use chat_server::{
    auth::{Principal, Provider, client::ClientInfo},
    keys::{self, KeysError},
};
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

struct Account {
    principal: Principal,
    ark: Ark,
}

async fn session(db: &PgPool, user: Uuid, device: Option<Uuid>) -> Principal {
    let session = Uuid::now_v7();
    if let Some(device) = device {
        sqlx::query("INSERT INTO devices (user_id, id) VALUES ($1, $2) ON CONFLICT DO NOTHING")
            .bind(user)
            .bind(device)
            .execute(db)
            .await
            .unwrap();
    }
    sqlx::query(
        "INSERT INTO sessions (id, user_id, provider, device_id, refresh_hash) VALUES ($1, $2, 'email', $3, $4)",
    )
    .bind(session)
    .bind(user)
    .bind(device)
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

async fn account(db: &PgPool, device: Option<Uuid>) -> Account {
    let user = Uuid::now_v7();
    sqlx::query("INSERT INTO users (id) VALUES ($1)").bind(user).execute(db).await.unwrap();
    Account { principal: session(db, user, device).await, ark: Ark::generate(&mut os_rng()) }
}

fn user_id(principal: &Principal) -> UserId {
    UserId::from_bytes(*principal.user_id.as_bytes())
}

fn wrap(a: &Account, method: WrapMethod, secret: &UnlockSecret<'_>) -> Bytes {
    let id = WrapId::from_bytes(*Uuid::now_v7().as_bytes());
    Bytes(ArkWrap::seal(&a.ark, &user_id(&a.principal), id, method, secret, &mut os_rng()).unwrap().encode().unwrap())
}

fn recovery_wrap(a: &Account) -> Bytes {
    wrap(a, WrapMethod::Recovery, &UnlockSecret::Recovery(&RecoveryKey::generate(&mut os_rng())))
}

fn passkey_wrap(a: &Account) -> Bytes {
    let method = WrapMethod::Passkey { credential_id: Uuid::now_v7().as_bytes().to_vec(), prf_salt: [1; 32] };
    wrap(a, method, &UnlockSecret::Prf(&[2; 32]))
}

fn device_wrap(a: &Account, device: Uuid) -> Bytes {
    let method = WrapMethod::Device { device_id: DeviceId::from_bytes(*device.as_bytes()) };
    wrap(a, method, &UnlockSecret::Device(&[3; 32]))
}

fn bundle(a: &Account, wraps: Vec<Bytes>) -> KeysSetup {
    KeysSetup {
        commitment: Bytes(a.ark.commitment(&user_id(&a.principal)).0.to_vec()),
        writer_public_key: Bytes(vec![7; 32]),
        wraps,
        scopes: AccountScopeKind::ALL
            .into_iter()
            .map(|kind| NewAccountScope {
                scope_id: Uuid::now_v7(),
                kind,
                public_key: Bytes(vec![4; 32]),
                wrapped_private_key: Bytes(vec![5; 73]),
            })
            .collect(),
    }
}

fn refused<T: std::fmt::Debug>(result: Result<T, KeysError>) -> ErrorCode {
    match result {
        Err(KeysError::Refused(code)) => code,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

async fn audit_kinds(db: &PgPool, user: Uuid) -> Vec<String> {
    sqlx::query_scalar("SELECT kind FROM audit_events WHERE user_id = $1 ORDER BY id")
        .bind(user)
        .fetch_all(db)
        .await
        .unwrap()
}

const CLIENT: ClientInfo = ClientInfo { ip: None, country: None, user_agent: None };

#[sqlx::test]
async fn setup_stores_everything_once(db: PgPool) {
    let a = account(&db, None).await;
    let p = &a.principal;
    assert!(keys::get(&db, p).await.unwrap().keys.is_none());
    assert_eq!(refused(keys::add_wrap(&db, p, &CLIENT, &passkey_wrap(&a)).await), ErrorCode::KeysNotSetUp);

    let setup = bundle(&a, vec![recovery_wrap(&a), passkey_wrap(&a)]);
    keys::setup(&db, p, &CLIENT, &setup).await.unwrap();
    // A resend of the same bundle after a reconnect succeeds without a second write.
    keys::setup(&db, p, &CLIENT, &setup).await.unwrap();
    // Another device that set up at the same time loses.
    let other = bundle(&a, vec![recovery_wrap(&a)]);
    assert_eq!(refused(keys::setup(&db, p, &CLIENT, &other).await), ErrorCode::KeysExists);

    let stored = keys::get(&db, p).await.unwrap().keys.unwrap();
    assert_eq!(stored.commitment, setup.commitment);
    assert_eq!(stored.wraps.iter().map(|w| &w.wrap).collect::<Vec<_>>(), setup.wraps.iter().collect::<Vec<_>>());
    assert_eq!(stored.scopes.len(), AccountScopeKind::ALL.len());

    let ids: Vec<Uuid> = setup.scopes.iter().map(|s| s.scope_id).collect();
    let scope_keys = keys::scope_keys(&db, p, &ids).await.unwrap();
    assert_eq!(scope_keys.len(), ids.len());
    assert!(scope_keys.iter().all(|k| k.key_version == 1 && k.wrapped_private_key.0.len() == 73));
    assert_eq!(audit_kinds(&db, p.user_id).await, ["keys.setup"]);
}

#[sqlx::test]
async fn setup_refuses_bundles_that_break_the_rules(db: PgPool) {
    let a = account(&db, None).await;
    let p = &a.principal;
    let invalid = |setup: KeysSetup| {
        let db = db.clone();
        let p = p.clone();
        async move { refused(keys::setup(&db, &p, &CLIENT, &setup).await) }
    };
    assert_eq!(invalid(bundle(&a, vec![passkey_wrap(&a)])).await, ErrorCode::KeysInvalid);
    assert_eq!(invalid(bundle(&a, vec![recovery_wrap(&a), recovery_wrap(&a)])).await, ErrorCode::KeysInvalid);
    assert_eq!(
        invalid(bundle(&a, vec![recovery_wrap(&a), device_wrap(&a, Uuid::now_v7())])).await,
        ErrorCode::KeysInvalid
    );
    assert_eq!(invalid(bundle(&a, vec![Bytes(vec![1, 2, 3])])).await, ErrorCode::KeysInvalid);
    let mut missing_scope = bundle(&a, vec![recovery_wrap(&a)]);
    missing_scope.scopes.pop();
    assert_eq!(invalid(missing_scope).await, ErrorCode::KeysInvalid);
    let mut twice = bundle(&a, vec![recovery_wrap(&a)]);
    twice.scopes[1].kind = twice.scopes[0].kind;
    assert_eq!(invalid(twice).await, ErrorCode::KeysInvalid);
    let mut short_key = bundle(&a, vec![recovery_wrap(&a)]);
    short_key.commitment = Bytes(vec![0; 31]);
    assert_eq!(invalid(short_key).await, ErrorCode::KeysInvalid);
    let many = std::iter::once(recovery_wrap(&a)).chain((0..21).map(|_| passkey_wrap(&a))).collect();
    assert_eq!(invalid(bundle(&a, many)).await, ErrorCode::KeysLimit);

    // A scope id another account already uses rolls the whole setup back.
    let b = account(&db, None).await;
    let theirs = bundle(&b, vec![recovery_wrap(&b)]);
    keys::setup(&db, &b.principal, &CLIENT, &theirs).await.unwrap();
    let mut clash = bundle(&a, vec![recovery_wrap(&a)]);
    clash.scopes[0].scope_id = theirs.scopes[0].scope_id;
    assert_eq!(invalid(clash).await, ErrorCode::KeysInvalid);
    assert!(keys::get(&db, p).await.unwrap().keys.is_none());
}

#[sqlx::test]
async fn passkeys_are_added_and_removed_but_recovery_stays(db: PgPool) {
    let a = account(&db, None).await;
    let p = &a.principal;
    let recovery = recovery_wrap(&a);
    keys::setup(&db, p, &CLIENT, &bundle(&a, vec![recovery.clone()])).await.unwrap();

    let passkey = passkey_wrap(&a);
    keys::add_wrap(&db, p, &CLIENT, &passkey).await.unwrap();
    keys::add_wrap(&db, p, &CLIENT, &passkey).await.unwrap();
    assert_eq!(keys::get(&db, p).await.unwrap().keys.unwrap().wraps.len(), 2);
    assert_eq!(refused(keys::add_wrap(&db, p, &CLIENT, &recovery_wrap(&a)).await), ErrorCode::KeysInvalid);

    let id = |w: &Bytes| Uuid::from_bytes(*ArkWrap::decode(&w.0).unwrap().wrap_id.as_bytes());
    keys::remove_wrap(&db, p, &CLIENT, id(&passkey)).await.unwrap();
    keys::remove_wrap(&db, p, &CLIENT, id(&passkey)).await.unwrap();
    assert_eq!(refused(keys::remove_wrap(&db, p, &CLIENT, id(&recovery)).await), ErrorCode::KeysRecoveryRequired);

    // Another user's wrap id is not ours to remove.
    let b = account(&db, None).await;
    let theirs = passkey_wrap(&b);
    keys::setup(&db, &b.principal, &CLIENT, &bundle(&b, vec![recovery_wrap(&b), theirs.clone()])).await.unwrap();
    keys::remove_wrap(&db, p, &CLIENT, id(&theirs)).await.unwrap();
    assert_eq!(keys::get(&db, &b.principal).await.unwrap().keys.unwrap().wraps.len(), 2);

    for _ in 0..20 {
        keys::add_wrap(&db, p, &CLIENT, &passkey_wrap(&a)).await.unwrap();
    }
    assert_eq!(refused(keys::add_wrap(&db, p, &CLIENT, &passkey_wrap(&a)).await), ErrorCode::KeysLimit);
    let kinds = audit_kinds(&db, p.user_id).await;
    assert_eq!(&kinds[..3], ["keys.setup", "keys.wrap_added", "keys.wrap_removed"]);
}

#[sqlx::test]
async fn rotation_replaces_the_recovery_wrap(db: PgPool) {
    let a = account(&db, None).await;
    let p = &a.principal;
    assert_eq!(refused(keys::rotate_recovery(&db, p, &CLIENT, &recovery_wrap(&a)).await), ErrorCode::KeysNotSetUp);
    keys::setup(&db, p, &CLIENT, &bundle(&a, vec![recovery_wrap(&a)])).await.unwrap();
    let fresh = recovery_wrap(&a);
    keys::rotate_recovery(&db, p, &CLIENT, &fresh).await.unwrap();
    keys::rotate_recovery(&db, p, &CLIENT, &fresh).await.unwrap();
    let wraps = keys::get(&db, p).await.unwrap().keys.unwrap().wraps;
    assert_eq!(wraps.iter().map(|w| &w.wrap).collect::<Vec<_>>(), [&fresh]);
    assert_eq!(refused(keys::rotate_recovery(&db, p, &CLIENT, &passkey_wrap(&a)).await), ErrorCode::KeysInvalid);
    assert_eq!(audit_kinds(&db, p.user_id).await, ["keys.setup", "keys.recovery_rotated"]);
}

#[sqlx::test]
async fn a_device_wrap_reaches_only_its_session_and_ends_with_it(db: PgPool) {
    let device = Uuid::now_v7();
    let a = account(&db, Some(device)).await;
    let p = &a.principal;
    keys::setup(&db, p, &CLIENT, &bundle(&a, vec![recovery_wrap(&a)])).await.unwrap();

    assert_eq!(
        refused(keys::add_wrap(&db, p, &CLIENT, &device_wrap(&a, Uuid::now_v7())).await),
        ErrorCode::KeysDeviceMismatch
    );
    let first = device_wrap(&a, device);
    keys::add_wrap(&db, p, &CLIENT, &first).await.unwrap();
    // A second "remember" replaces the first.
    let second = device_wrap(&a, device);
    keys::add_wrap(&db, p, &CLIENT, &second).await.unwrap();
    let wraps: Vec<Bytes> = keys::get(&db, p).await.unwrap().keys.unwrap().wraps.into_iter().map(|w| w.wrap).collect();
    assert_eq!(wraps.len(), 2);
    assert!(wraps.contains(&second) && !wraps.contains(&first));

    // Another session of the same user never sees it.
    let laptop = session(&db, p.user_id, Some(Uuid::now_v7())).await;
    assert_eq!(keys::get(&db, &laptop).await.unwrap().keys.unwrap().wraps.len(), 1);
    // A session without a reported device cannot remember one.
    let bare = session(&db, p.user_id, None).await;
    assert_eq!(
        refused(keys::add_wrap(&db, &bare, &CLIENT, &device_wrap(&a, device)).await),
        ErrorCode::KeysDeviceMismatch
    );

    // Ending the session, by any path, deletes the wrap.
    sqlx::query("UPDATE sessions SET revoked_at = now(), revoked_reason = 'sign_out' WHERE id = $1")
        .bind(p.session_id)
        .execute(&db)
        .await
        .unwrap();
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM ark_wraps WHERE method = 4").fetch_one(&db).await.unwrap();
    assert_eq!(left, 0);
    assert_eq!(refused(keys::add_wrap(&db, p, &CLIENT, &device_wrap(&a, device)).await), ErrorCode::KeysDeviceMismatch);
}

#[sqlx::test]
async fn a_session_that_reports_another_device_loses_its_wrap(db: PgPool) {
    let device = Uuid::now_v7();
    let a = account(&db, Some(device)).await;
    let p = &a.principal;
    keys::setup(&db, p, &CLIENT, &bundle(&a, vec![recovery_wrap(&a)])).await.unwrap();
    keys::add_wrap(&db, p, &CLIENT, &device_wrap(&a, device)).await.unwrap();
    let other = Uuid::now_v7();
    sqlx::query("INSERT INTO devices (user_id, id) VALUES ($1, $2)")
        .bind(p.user_id)
        .bind(other)
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("UPDATE sessions SET device_id = $2 WHERE id = $1")
        .bind(p.session_id)
        .bind(other)
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(keys::get(&db, p).await.unwrap().keys.unwrap().wraps.len(), 1);
}

#[sqlx::test]
async fn scope_keys_are_the_owners_only(db: PgPool) {
    let a = account(&db, None).await;
    let b = account(&db, None).await;
    let setup = bundle(&a, vec![recovery_wrap(&a)]);
    keys::setup(&db, &a.principal, &CLIENT, &setup).await.unwrap();
    let ids: Vec<Uuid> = setup.scopes.iter().map(|s| s.scope_id).collect();
    assert!(keys::scope_keys(&db, &b.principal, &ids).await.unwrap().is_empty());
    assert!(keys::scope_keys(&db, &a.principal, &[Uuid::now_v7()]).await.unwrap().is_empty());
    let too_many: Vec<Uuid> = (0..65).map(|_| Uuid::now_v7()).collect();
    assert_eq!(refused(keys::scope_keys(&db, &a.principal, &too_many).await), ErrorCode::KeysInvalid);
}

#[sqlx::test]
async fn deleting_the_user_deletes_the_keys(db: PgPool) {
    let a = account(&db, None).await;
    keys::setup(&db, &a.principal, &CLIENT, &bundle(&a, vec![recovery_wrap(&a)])).await.unwrap();
    sqlx::query("DELETE FROM users WHERE id = $1").bind(a.principal.user_id).execute(&db).await.unwrap();
    for table in
        ["SELECT count(*) FROM account_keys", "SELECT count(*) FROM ark_wraps", "SELECT count(*) FROM scope_keys"]
    {
        let n: i64 = sqlx::query_scalar(table).fetch_one(&db).await.unwrap();
        assert_eq!(n, 0, "{table}");
    }
}

/// The socket routes keys requests and answers refusals with their codes.
#[sqlx::test]
async fn keys_requests_travel_over_the_socket(db: PgPool) {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};

    let a = account(&db, None).await;
    let auth = std::sync::Arc::new(support::auth().0);
    let token = support::token(&auth, a.principal.user_id, a.principal.session_id, 60);
    let (_stop, stopped) = tokio::sync::watch::channel(());
    let state = chat_server::app::AppState::new(support::config(), db.clone(), auth, stopped);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let router = chat_server::app::router(state);
    tokio::spawn(async move {
        axum::serve(listener, router.into_make_service_with_connect_info::<std::net::SocketAddr>()).await.unwrap();
    });
    let mut request = format!("ws://{addr}/ws").into_client_request().unwrap();
    request.headers_mut().insert("origin", support::ORIGIN.parse().unwrap());
    let (mut ws, _) = tokio_tungstenite::connect_async(request).await.unwrap();

    let mut call = async |kind: &str, id: u32, payload: &dyn erased::Payload| {
        ws.send(Message::binary(payload.frame(kind, id))).await.unwrap();
        loop {
            if let Some(Ok(Message::Binary(bytes))) = ws.next().await {
                return bytes.to_vec();
            }
        }
    };
    let auth = serde_json::json!({ "v": 1, "access_token": token });
    let ok = |bytes: &[u8]| chat_protocol::InFrame::parse(bytes).unwrap().kind == "ok";
    assert!(ok(&call("auth", 1, &auth).await));

    let bytes = call("keys.get", 2, &serde_json::json!({})).await;
    let state: chat_protocol::keys::KeysState = chat_protocol::InFrame::parse(&bytes).unwrap().payload().unwrap();
    assert!(ok(&bytes) && state.keys.is_none());

    keys::setup(&db, &a.principal, &CLIENT, &bundle(&a, vec![recovery_wrap(&a)])).await.unwrap();
    let bytes = call("keys.get", 3, &serde_json::json!({})).await;
    let state: chat_protocol::keys::KeysState = chat_protocol::InFrame::parse(&bytes).unwrap().payload().unwrap();
    assert!(ok(&bytes));
    assert_eq!(state.keys.unwrap().wraps.len(), 1);

    let rotate = chat_protocol::keys::KeysRecoveryRotate { wrap: passkey_wrap(&a) };
    let bytes = call("keys.recovery_rotate", 4, &rotate).await;
    let frame = chat_protocol::InFrame::parse(&bytes).unwrap();
    assert_eq!(frame.kind, "error");
    let error: chat_protocol::error::ErrorPayload = frame.payload().unwrap();
    assert_eq!(error.code, ErrorCode::KeysInvalid);
}

/// Encodes JSON and typed payloads alike.
mod erased {
    pub trait Payload {
        fn frame(&self, kind: &str, id: u32) -> Vec<u8>;
    }

    impl<T: serde::Serialize> Payload for T {
        fn frame(&self, kind: &str, id: u32) -> Vec<u8> {
            chat_protocol::encode(kind, id, self)
        }
    }
}
