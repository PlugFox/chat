//! Registers over a real socket (docs/protocol.md, "Registers"): the seeded
//! catalog, one scope per metric, pages and ranges, resends, revisions and
//! conflicts, limits, ownership and events.

#![allow(clippy::unwrap_used, clippy::expect_used, reason = "tests fail loudly")]

mod support;

use chat_crypto::{
    ids::{EntryId, ScopeId},
    os_rng,
    record::{self, Granularity, Kind, Place},
    scope::ScopeKeyPair,
};
use chat_protocol::{
    Bytes, Empty,
    error::ErrorCode,
    registers::{
        ENTRIES_MAX, ENTRIES_PAGE, MetricCatalog, MetricList, OCCURRED_MAX, OCCURRED_MIN, RegisterCreate,
        RegisterCursor, RegisterDelete, RegisterDeleted, RegisterEntries, RegisterEntry, RegisterPage, RegisterScope,
        RegisterSetup, RegisterStored, RegisterUpdate, RegisterUpdated, VALUE_MAX,
    },
};
use sqlx::PgPool;
use support::socket::{Client, User, kind, payload, session, start, user};
use uuid::Uuid;

const WEIGHT: &str = "body.weight";
const STEPS: &str = "activity.steps";

/// A metric's register scope as a client makes it, with its key pair.
struct Register {
    metric: &'static str,
    scope_id: Uuid,
    keys: ScopeKeyPair,
}

impl Register {
    fn new(metric: &'static str, version: u32) -> Self {
        Self { metric, scope_id: Uuid::now_v7(), keys: ScopeKeyPair::generate(version, &mut os_rng()) }
    }

    fn setup(&self) -> RegisterSetup {
        RegisterSetup {
            metric: self.metric.into(),
            scope_id: self.scope_id,
            public_key: Bytes(self.keys.public().key.as_bytes().to_vec()),
            wrapped_private_key: Bytes(vec![5; 73]),
        }
    }

    fn seal(&self, user: &User, entry_id: Uuid, occurred_at: i64, value: &[u8]) -> Bytes {
        let kind = Kind::RegisterValue {
            entry_id: EntryId::from_bytes(*entry_id.as_bytes()),
            period_start: occurred_at,
            granularity: Granularity::Instant,
        };
        let place = Place { user: user.id(), scope: ScopeId::from_bytes(*self.scope_id.as_bytes()), kind };
        Bytes(
            record::seal_as_client(&place, &self.keys.public(), &user.ark.writer_key(&user.id()), value, &mut os_rng())
                .unwrap(),
        )
    }

    fn create(&self, user: &User, entry_id: Uuid, occurred_at: i64, value: &[u8]) -> RegisterCreate {
        RegisterCreate {
            entry_id,
            metric: self.metric.into(),
            occurred_at,
            value: self.seal(user, entry_id, occurred_at, value),
        }
    }

    fn update(&self, user: &User, entry_id: Uuid, rev: i64, occurred_at: i64, value: &[u8]) -> RegisterUpdate {
        RegisterUpdate { entry_id, rev, occurred_at, value: self.seal(user, entry_id, occurred_at, value) }
    }
}

fn entries(metric: &str) -> RegisterEntries {
    RegisterEntries { metric: metric.into(), from: None, to: None, before: None, limit: None }
}

/// A connected user with the register of `metric` set up.
async fn with_register(env: &support::socket::Env, user: &User, metric: &'static str) -> (Client, Register) {
    let (mut socket, _) = Client::connect(env, &user.principal, None).await;
    let register = Register::new(metric, 1);
    let scope: RegisterScope = socket.ok("register.setup", &register.setup()).await;
    assert_eq!(scope.scope_id, register.scope_id);
    (socket, register)
}

/// Rows straight into the table, `value` one byte: for pages and limits.
async fn insert_many(db: &PgPool, user: &User, register: &Register, count: i64, occurred_at: &'static str) {
    let sql = match occurred_at {
        "n" => {
            "INSERT INTO register_entries (id, user_id, scope_id, occurred_at, value, rev, updated_at)
             SELECT gen_random_uuid(), $1, $2, n, '\\x01', 1, 0 FROM generate_series(1, $3) n"
        }
        _ => {
            "INSERT INTO register_entries (id, user_id, scope_id, occurred_at, value, rev, updated_at)
             SELECT gen_random_uuid(), $1, $2, n / 2, '\\x01', 1, 0 FROM generate_series(1, $3) n"
        }
    };
    sqlx::query(sql).bind(user.principal.user_id).bind(register.scope_id).bind(count).execute(db).await.unwrap();
}

#[sqlx::test]
async fn the_catalog_is_seeded_and_lists_the_accounts_registers(db: PgPool) {
    let env = start(db).await;
    let alice = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &alice.principal, None).await;
    let catalog: MetricCatalog = a.ok("metric.list", &MetricList {}).await;
    let categories: Vec<&str> = catalog.categories.iter().map(|c| c.key.as_str()).collect();
    assert_eq!(categories, ["body", "activity", "exercise", "nutrition"]);
    let metrics: Vec<&str> = catalog.metrics.iter().map(|m| m.key.as_str()).collect();
    assert_eq!(
        metrics,
        [
            "body.weight",
            "body.height",
            "activity.steps",
            "activity.active_energy",
            "exercise.squats",
            "exercise.push_ups",
            "nutrition.energy_intake"
        ]
    );
    let weight = &catalog.metrics[0];
    assert_eq!(
        (weight.unit.as_str(), weight.aggregate.as_str(), weight.value_type.as_str(), weight.precision),
        ("kg", "avg", "decimal", 1)
    );
    assert_eq!(weight.names.get("ru").map(String::as_str), Some("Вес"));
    assert!(catalog.metrics.iter().all(|m| m.names.contains_key("en") && m.names.contains_key("ru")));
    assert!(catalog.metrics.iter().all(|m| m.register == "measurements" && m.max > m.min));
    assert_eq!(catalog.metrics[2].aggregate, "sum");
    assert!(catalog.registers.is_empty());

    let weight = Register::new(WEIGHT, 1);
    let _: RegisterScope = a.ok("register.setup", &weight.setup()).await;
    let steps = Register::new(STEPS, 1);
    let _: RegisterScope = a.ok("register.setup", &steps.setup()).await;
    for at in [100, 300, 200] {
        let _: RegisterStored = a.ok("register.create", &weight.create(&alice, Uuid::now_v7(), at, b"80")).await;
    }
    let catalog: MetricCatalog = a.ok("metric.list", &MetricList {}).await;
    let registers: Vec<(&str, Uuid, i64, Option<i64>)> =
        catalog.registers.iter().map(|r| (r.metric.as_str(), r.scope_id, r.entries, r.latest_at)).collect();
    assert_eq!(registers, [(STEPS, steps.scope_id, 0, None), (WEIGHT, weight.scope_id, 3, Some(300))]);

    // Bob sees the same catalog and none of Alice's registers.
    let bob = user(&env.db).await;
    let (mut b, _) = Client::connect(&env, &bob.principal, None).await;
    let theirs: MetricCatalog = b.ok("metric.list", &MetricList {}).await;
    assert_eq!(theirs.metrics, catalog.metrics);
    assert!(theirs.registers.is_empty());
}

#[sqlx::test]
async fn setup_creates_one_scope_per_metric(db: PgPool) {
    let env = start(db).await;
    let alice = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &alice.principal, None).await;
    let (mut a2, _) = Client::connect(&env, &alice.principal, None).await;
    let first = Register::new(WEIGHT, 1);
    let scope: RegisterScope = a.ok("register.setup", &first.setup()).await;
    assert_eq!(scope.scope_id, first.scope_id);
    // Another device came second, and a resend of the first.
    for register in [&Register::new(WEIGHT, 1), &first] {
        let scope: RegisterScope = a.ok("register.setup", &register.setup()).await;
        assert_eq!(scope.scope_id, first.scope_id);
    }
    // Two devices at once for another metric.
    let (mine, theirs) = (Register::new(STEPS, 1).setup(), Register::new(STEPS, 1).setup());
    let (x, y) = tokio::join!(a.call("register.setup", &mine), a2.call("register.setup", &theirs));
    let x: RegisterScope = payload(x.last().unwrap());
    let y: RegisterScope = payload(y.last().unwrap());
    assert_eq!(x.scope_id, y.scope_id);
    assert_ne!(x.scope_id, first.scope_id);
    let scopes: i64 =
        sqlx::query_scalar("SELECT count(*) FROM scopes WHERE kind = 'register'").fetch_one(&env.db).await.unwrap();
    assert_eq!(scopes, 2);
}

#[sqlx::test]
async fn setup_checks_the_metric_keys_and_the_account(db: PgPool) {
    let env = start(db).await;
    let id = Uuid::now_v7();
    sqlx::query("INSERT INTO users (id) VALUES ($1)").bind(id).execute(&env.db).await.unwrap();
    let principal = session(&env.db, id).await;
    let (mut nobody, _) = Client::connect(&env, &principal, None).await;
    assert_eq!(nobody.refused("register.setup", &Register::new(WEIGHT, 1).setup()).await, ErrorCode::KeysNotSetUp);

    let alice = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &alice.principal, None).await;
    assert_eq!(
        a.refused("register.setup", &Register::new("body.wingspan", 1).setup()).await,
        ErrorCode::MetricNotFound
    );
    let mut short = Register::new(WEIGHT, 1).setup();
    short.public_key.0.pop();
    let mut unwrapped = Register::new(WEIGHT, 1).setup();
    unwrapped.wrapped_private_key = Bytes(vec![]);
    let mut long = Register::new(WEIGHT, 1).setup();
    long.wrapped_private_key = Bytes(vec![5; 257]);
    let taken: Uuid = sqlx::query_scalar("SELECT id FROM scopes WHERE user_id = $1 AND kind = 'settings'")
        .bind(alice.principal.user_id)
        .fetch_one(&env.db)
        .await
        .unwrap();
    let mut clash = Register::new(WEIGHT, 1).setup();
    clash.scope_id = taken;
    for setup in [short, unwrapped, long, clash] {
        assert_eq!(a.refused("register.setup", &setup).await, ErrorCode::Malformed);
    }
    let catalog: MetricCatalog = a.ok("metric.list", &MetricList {}).await;
    assert!(catalog.registers.is_empty());
}

#[sqlx::test]
async fn entries_need_a_known_metric_and_its_register(db: PgPool) {
    let env = start(db).await;
    let alice = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &alice.principal, None).await;
    let register = Register::new(WEIGHT, 1);
    let entry_id = Uuid::now_v7();
    assert_eq!(
        a.refused("register.create", &register.create(&alice, entry_id, 10, b"1")).await,
        ErrorCode::RegisterNotSetUp
    );
    let mut unknown = register.create(&alice, entry_id, 10, b"1");
    unknown.metric = "body.wingspan".into();
    assert_eq!(a.refused("register.create", &unknown).await, ErrorCode::MetricNotFound);
    assert_eq!(a.refused("register.entries", &entries("body.wingspan")).await, ErrorCode::MetricNotFound);
    let page: RegisterPage = a.ok("register.entries", &entries(WEIGHT)).await;
    assert!(page.entries.is_empty() && page.next.is_none());
    assert_eq!(
        a.refused("register.update", &register.update(&alice, entry_id, 1, 10, b"1")).await,
        ErrorCode::RegisterNotFound
    );
    let _: Empty = a.ok("register.delete", &RegisterDelete { entry_id }).await;
}

#[sqlx::test]
async fn changes_reach_every_socket_of_the_user_only(db: PgPool) {
    let env = start(db).await;
    let alice = user(&env.db).await;
    let bob = user(&env.db).await;
    let (mut a, weight) = with_register(&env, &alice, WEIGHT).await;
    let (mut a2, _) = Client::connect(&env, &alice.principal, None).await;
    let (mut b, bobs) = with_register(&env, &bob, WEIGHT).await;

    let entry_id = Uuid::now_v7();
    let create = weight.create(&alice, entry_id, 1_700_000_000, b"80.5");
    let stored: RegisterStored = a.ok("register.create", &create).await;
    assert_eq!(
        (stored.entry.entry_id, stored.entry.metric.as_str(), stored.entry.occurred_at, stored.entry.rev),
        (entry_id, WEIGHT, 1_700_000_000, 1)
    );
    assert_eq!(stored.entry.value, create.value);
    for socket in [&mut a, &mut a2] {
        let event: RegisterUpdated = socket.event("register.updated").await;
        assert_eq!(event.entry, stored.entry);
    }

    // A new moment comes with a new seal.
    let update = weight.update(&alice, entry_id, 1, 1_700_003_600, b"80.1");
    let updated: RegisterStored = a2.ok("register.update", &update).await;
    assert_eq!((updated.entry.rev, updated.entry.occurred_at), (2, 1_700_003_600));
    assert!(updated.entry.updated_at > stored.entry.updated_at);
    for socket in [&mut a, &mut a2] {
        let event: RegisterUpdated = socket.event("register.updated").await;
        assert_eq!(event.entry, updated.entry);
    }
    let page: RegisterPage = a.ok("register.entries", &entries(WEIGHT)).await;
    assert_eq!(page.entries, std::slice::from_ref(&updated.entry));

    let _: Empty = a.ok("register.delete", &RegisterDelete { entry_id }).await;
    for socket in [&mut a, &mut a2] {
        let event: RegisterDeleted = socket.event("register.deleted").await;
        assert_eq!((event.entry_id, event.metric.as_str()), (entry_id, WEIGHT));
    }
    // Deleting it again succeeds and sends nothing.
    let _: Empty = a.ok("register.delete", &RegisterDelete { entry_id }).await;
    let page: RegisterPage = a.ok("register.entries", &entries(WEIGHT)).await;
    assert!(page.entries.is_empty());

    // Bob's own change comes after Alice's on the bus: had hers reached him, it would be first.
    let _: RegisterStored = b.ok("register.create", &bobs.create(&bob, Uuid::now_v7(), 5, b"b")).await;
    let _: RegisterUpdated = b.event("register.updated").await;
    assert!(b.events.is_empty());
    assert!(a.events.is_empty() && a2.events.is_empty());
}

#[sqlx::test]
async fn a_create_is_idempotent_by_id(db: PgPool) {
    let env = start(db).await;
    let alice = user(&env.db).await;
    let bob = user(&env.db).await;
    let (mut a, weight) = with_register(&env, &alice, WEIGHT).await;
    let (mut b, bobs) = with_register(&env, &bob, WEIGHT).await;
    let entry_id = Uuid::now_v7();
    let create = weight.create(&alice, entry_id, 10, b"one");
    let stored: RegisterStored = a.ok("register.create", &create).await;
    let _: RegisterUpdated = a.event("register.updated").await;

    // A resend answers with the stored entry and sends nothing.
    let again: RegisterStored = a.ok("register.create", &create).await;
    assert_eq!(again.entry, stored.entry);
    assert!(a.events.is_empty());
    assert_eq!(
        a.refused("register.create", &weight.create(&alice, entry_id, 10, b"two")).await,
        ErrorCode::RegisterExists
    );
    assert_eq!(
        a.refused("register.create", &weight.create(&alice, entry_id, 11, b"one")).await,
        ErrorCode::RegisterExists
    );
    // The same id under another metric of hers.
    let (_, steps) = with_register(&env, &alice, STEPS).await;
    let mut moved = steps.create(&alice, entry_id, 10, b"one");
    moved.value = create.value.clone();
    assert_eq!(a.refused("register.create", &moved).await, ErrorCode::RegisterExists);

    // Bob gets the same answer for Alice's id, even with her very record, and her entry stays hers.
    assert_eq!(b.refused("register.create", &bobs.create(&bob, entry_id, 10, b"one")).await, ErrorCode::RegisterExists);
    let mut hers = create;
    hers.metric = WEIGHT.into();
    assert_eq!(b.refused("register.create", &hers).await, ErrorCode::RegisterExists);
    let page: RegisterPage = a.ok("register.entries", &entries(WEIGHT)).await;
    assert_eq!(page.entries, [stored.entry]);
    let theirs: RegisterPage = b.ok("register.entries", &entries(WEIGHT)).await;
    assert!(theirs.entries.is_empty());
}

#[sqlx::test]
async fn an_update_based_on_another_revision_conflicts(db: PgPool) {
    let env = start(db).await;
    let alice = user(&env.db).await;
    let bob = user(&env.db).await;
    let (mut a, weight) = with_register(&env, &alice, WEIGHT).await;
    let (mut b, bobs) = with_register(&env, &bob, WEIGHT).await;
    let entry_id = Uuid::now_v7();
    let _: RegisterStored = a.ok("register.create", &weight.create(&alice, entry_id, 10, b"one")).await;
    let two = weight.update(&alice, entry_id, 1, 10, b"two");
    let stored: RegisterStored = a.ok("register.update", &two).await;
    assert_eq!(stored.entry.rev, 2);

    // A device still on revision 1, and one ahead of the server.
    for rev in [1, 3] {
        assert_eq!(
            a.refused("register.update", &weight.update(&alice, entry_id, rev, 10, b"three")).await,
            ErrorCode::RegisterConflict
        );
    }
    // A resend of the update that made revision 2 answers with it and changes nothing.
    let again: RegisterStored = a.ok("register.update", &two).await;
    assert_eq!(again.entry, stored.entry);

    // Bob can neither change nor remove Alice's entry.
    assert_eq!(
        b.refused("register.update", &bobs.update(&bob, entry_id, 2, 10, b"x")).await,
        ErrorCode::RegisterNotFound
    );
    let _: Empty = b.ok("register.delete", &RegisterDelete { entry_id }).await;
    let page: RegisterPage = a.ok("register.entries", &entries(WEIGHT)).await;
    assert_eq!(page.entries, [stored.entry]);
}

#[sqlx::test]
async fn values_and_moments_are_checked(db: PgPool) {
    let env = start(db).await;
    let alice = user(&env.db).await;
    let (mut a, weight) = with_register(&env, &alice, WEIGHT).await;
    let entry_id = Uuid::now_v7();
    let stale = Register { metric: WEIGHT, scope_id: weight.scope_id, keys: ScopeKeyPair::generate(2, &mut os_rng()) };
    let big = weight.seal(&alice, entry_id, 10, &vec![7; VALUE_MAX]);
    assert!(big.0.len() > VALUE_MAX);
    let good = weight.create(&alice, entry_id, 10, b"1");
    let malformed = [
        stale.create(&alice, entry_id, 10, b"1"),
        RegisterCreate { value: Bytes(vec![]), ..weight.create(&alice, entry_id, 10, b"1") },
        RegisterCreate { value: Bytes(vec![1; 10]), ..weight.create(&alice, entry_id, 10, b"1") },
        RegisterCreate { value: big, ..weight.create(&alice, entry_id, 10, b"1") },
        weight.create(&alice, entry_id, OCCURRED_MIN - 1, b"1"),
        weight.create(&alice, entry_id, OCCURRED_MAX, b"1"),
    ];
    for (i, create) in malformed.iter().enumerate() {
        assert_eq!(a.refused("register.create", create).await, ErrorCode::Malformed, "create {i}");
    }
    for limit in [0, ENTRIES_PAGE + 1] {
        let request = RegisterEntries { limit: Some(limit), ..entries(WEIGHT) };
        assert_eq!(a.refused("register.entries", &request).await, ErrorCode::Malformed);
    }
    let _: RegisterStored = a.ok("register.create", &good).await;
    let _: RegisterStored = a.ok("register.create", &weight.create(&alice, Uuid::now_v7(), OCCURRED_MIN, b"1")).await;

    // After a rotation values follow the latest key version.
    sqlx::query(
        "INSERT INTO scope_keys (scope_id, key_version, public_key, wrapped_private_key) VALUES ($1, 2, $2, $3)",
    )
    .bind(weight.scope_id)
    .bind(vec![4u8; 32])
    .bind(vec![5u8; 73])
    .execute(&env.db)
    .await
    .unwrap();
    assert_eq!(a.refused("register.update", &weight.update(&alice, entry_id, 1, 10, b"2")).await, ErrorCode::Malformed);
    let stored: RegisterStored = a.ok("register.update", &stale.update(&alice, entry_id, 1, 10, b"2")).await;
    assert_eq!(stored.entry.rev, 2);
}

#[sqlx::test]
async fn an_account_holds_a_limited_number_of_entries(db: PgPool) {
    let env = start(db).await;
    let alice = user(&env.db).await;
    let (mut a, weight) = with_register(&env, &alice, WEIGHT).await;
    let (_, steps) = with_register(&env, &alice, STEPS).await;
    // The limit is the account's, across metrics.
    insert_many(&env.db, &alice, &steps, ENTRIES_MAX - 1, "n").await;
    let last = Uuid::now_v7();
    let _: RegisterStored = a.ok("register.create", &weight.create(&alice, last, 10, b"last")).await;
    assert_eq!(
        a.refused("register.create", &weight.create(&alice, Uuid::now_v7(), 10, b"x")).await,
        ErrorCode::RegisterLimit
    );
    // Changing an entry is not adding one.
    let _: RegisterStored = a.ok("register.update", &weight.update(&alice, last, 1, 10, b"y")).await;
}

#[sqlx::test]
async fn entries_page_newest_first_within_a_range(db: PgPool) {
    let env = start(db).await;
    let alice = user(&env.db).await;
    let bob = user(&env.db).await;
    let (mut a, weight) = with_register(&env, &alice, WEIGHT).await;
    let (_, steps) = with_register(&env, &alice, STEPS).await;
    let (_, bobs) = with_register(&env, &bob, WEIGHT).await;
    // Pairs share an `occurred_at` (1..=1002), so the id breaks the tie.
    let total = i64::from(ENTRIES_PAGE) * 2 + 5;
    insert_many(&env.db, &alice, &weight, total, "half").await;
    insert_many(&env.db, &alice, &steps, 10, "n").await;
    insert_many(&env.db, &bob, &bobs, 10, "n").await;

    let frames = a.call("register.entries", &entries(WEIGHT)).await;
    assert_eq!(kind(frames.last().unwrap()), "ok");
    let first: Vec<RegisterPage> = frames.iter().map(|f| payload(f)).collect();
    let next = first.last().unwrap().next.unwrap();
    assert!(first[..first.len() - 1].iter().all(|p| p.next.is_none()));
    let first: Vec<RegisterEntry> = first.into_iter().flat_map(|p| p.entries).collect();
    assert_eq!(first.len(), usize::try_from(ENTRIES_PAGE).unwrap());
    let last = first.last().unwrap();
    assert_eq!(next, RegisterCursor { occurred_at: last.occurred_at, entry_id: last.entry_id });
    assert!(first.iter().all(|e| e.metric == WEIGHT && e.value.0 == [1]));

    let second: RegisterPage =
        a.ok("register.entries", &RegisterEntries { before: Some(next), ..entries(WEIGHT) }).await;
    assert_eq!(second.entries.len(), usize::try_from(ENTRIES_PAGE).unwrap());
    let third: RegisterPage =
        a.ok("register.entries", &RegisterEntries { before: second.next, ..entries(WEIGHT) }).await;
    assert_eq!(third.entries.len(), 5);
    assert!(third.next.is_none());
    let all: Vec<(i64, Uuid)> =
        first.iter().chain(&second.entries).chain(&third.entries).map(|e| (e.occurred_at, e.entry_id)).collect();
    let mut sorted = all.clone();
    sorted.sort_by(|x, y| y.cmp(x));
    sorted.dedup();
    assert_eq!(all, sorted);

    // `from` is inclusive, `to` exclusive; `limit` pages within the range.
    let range = RegisterEntries { from: Some(100), to: Some(103), limit: Some(4), ..entries(WEIGHT) };
    let page: RegisterPage = a.ok("register.entries", &range).await;
    let moments: Vec<i64> = page.entries.iter().map(|e| e.occurred_at).collect();
    assert_eq!(moments, [102, 102, 101, 101]);
    let rest: RegisterPage = a.ok("register.entries", &RegisterEntries { before: page.next, ..range }).await;
    let moments: Vec<i64> = rest.entries.iter().map(|e| e.occurred_at).collect();
    assert_eq!(moments, [100, 100]);
    assert!(rest.next.is_none());
}

#[sqlx::test]
async fn deleting_the_user_deletes_the_registers(db: PgPool) {
    let env = start(db).await;
    let alice = user(&env.db).await;
    let (mut a, weight) = with_register(&env, &alice, WEIGHT).await;
    let _: RegisterStored = a.ok("register.create", &weight.create(&alice, Uuid::now_v7(), 10, b"x")).await;
    sqlx::query("DELETE FROM users WHERE id = $1").bind(alice.principal.user_id).execute(&env.db).await.unwrap();
    let counts: (i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM register_entries), (SELECT count(*) FROM registers),
                (SELECT count(*) FROM scopes WHERE kind = 'register')",
    )
    .fetch_one(&env.db)
    .await
    .unwrap();
    assert_eq!(counts, (0, 0, 0));
    // The catalog is no one's and stays.
    let metrics: i64 = sqlx::query_scalar("SELECT count(*) FROM metrics").fetch_one(&env.db).await.unwrap();
    assert_eq!(metrics, 7);
}
