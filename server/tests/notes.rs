//! Notes over a real socket (docs/protocol.md, "Notes"): the one notes scope,
//! pages, resends, revisions and conflicts, limits, ownership and events.

#![allow(clippy::unwrap_used, clippy::expect_used, reason = "tests fail loudly")]

mod support;

use chat_crypto::{
    ids::{NoteId, ScopeId},
    os_rng,
    record::{self, Kind, Place},
    scope::ScopeKeyPair,
};
use chat_protocol::{
    Bytes, Empty,
    error::ErrorCode,
    keys::{ScopeKeyList, ScopeKeys},
    notes::{
        NOTE_BODY_MAX, NOTE_TITLE_MAX, NOTES_MAX, NOTES_PAGE, NoteCreate, NoteCursor, NoteDelete, NoteDeleted, NoteGet,
        NoteInfo, NoteList, NoteOpened, NotePage, NoteStored, NoteUpdate, NoteUpdated, NotesScope, NotesSetup,
    },
};
use sqlx::PgPool;
use support::socket::{Client, User, session, start, user};
use uuid::Uuid;

/// The notes scope as a client makes it, with its key pair.
struct Notebook {
    scope_id: Uuid,
    keys: ScopeKeyPair,
}

impl Notebook {
    fn new(version: u32) -> Self {
        Self { scope_id: Uuid::now_v7(), keys: ScopeKeyPair::generate(version, &mut os_rng()) }
    }

    fn setup(&self) -> NotesSetup {
        NotesSetup {
            scope_id: self.scope_id,
            public_key: Bytes(self.keys.public().key.as_bytes().to_vec()),
            wrapped_private_key: Bytes(vec![5; 73]),
        }
    }

    fn seal(&self, user: &User, kind: Kind<'_>, value: &[u8]) -> Bytes {
        let place = Place { user: user.id(), scope: ScopeId::from_bytes(*self.scope_id.as_bytes()), kind };
        Bytes(
            record::seal_as_client(&place, &self.keys.public(), &user.ark.writer_key(&user.id()), value, &mut os_rng())
                .unwrap(),
        )
    }

    /// `note.title` and `note.body` records of one note.
    fn records(&self, user: &User, note_id: Uuid, title: &[u8], body: &[u8]) -> (Bytes, Bytes) {
        let id = NoteId::from_bytes(*note_id.as_bytes());
        (self.seal(user, Kind::NoteTitle { note_id: id }, title), self.seal(user, Kind::NoteBody { note_id: id }, body))
    }

    fn create(&self, user: &User, note_id: Uuid, text: &[u8]) -> NoteCreate {
        let (title, body) = self.records(user, note_id, text, text);
        NoteCreate { note_id, title, body }
    }

    fn update(&self, user: &User, note_id: Uuid, rev: i64, text: &[u8]) -> NoteUpdate {
        let (title, body) = self.records(user, note_id, text, text);
        NoteUpdate { note_id, rev, title, body }
    }
}

/// A connected user with the notes scope set up.
async fn with_notebook(env: &support::socket::Env, user: &User) -> (Client, Notebook) {
    let (mut socket, _) = Client::connect(env, &user.principal, None).await;
    let notebook = Notebook::new(1);
    let scope: NotesScope = socket.ok("notes.setup", &notebook.setup()).await;
    assert_eq!(scope.scope_id, notebook.scope_id);
    (socket, notebook)
}

#[sqlx::test]
async fn setup_creates_one_scope_per_account(db: PgPool) {
    let env = start(db).await;
    let alice = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &alice.principal, None).await;
    let page: NotePage = a.ok("note.list", &NoteList::default()).await;
    assert!(page.scope_id.is_none() && page.notes.is_empty() && page.next.is_none());

    let first = Notebook::new(1);
    let second = Notebook::new(1);
    let scope: NotesScope = a.ok("notes.setup", &first.setup()).await;
    assert_eq!(scope.scope_id, first.scope_id);
    // Another device came second, and a resend of the first.
    for notebook in [&second, &first] {
        let scope: NotesScope = a.ok("notes.setup", &notebook.setup()).await;
        assert_eq!(scope.scope_id, first.scope_id);
    }
    let scopes: i64 =
        sqlx::query_scalar("SELECT count(*) FROM scopes WHERE kind = 'notes'").fetch_one(&env.db).await.unwrap();
    assert_eq!(scopes, 1);
    let page: NotePage = a.ok("note.list", &NoteList::default()).await;
    assert_eq!(page.scope_id, Some(first.scope_id));

    let keys: ScopeKeyList = a.ok("scope.keys", &ScopeKeys { scope_ids: vec![first.scope_id] }).await;
    assert_eq!(keys.keys.len(), 1);
    assert_eq!((keys.keys[0].key_version, &keys.keys[0].public_key.0), (1, &first.setup().public_key.0));
}

#[sqlx::test]
async fn racing_setups_get_one_scope(db: PgPool) {
    let env = start(db).await;
    let alice = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &alice.principal, None).await;
    let (mut a2, _) = Client::connect(&env, &alice.principal, None).await;
    let (mine, theirs) = (Notebook::new(1).setup(), Notebook::new(1).setup());
    let (x, y) = tokio::join!(a.call("notes.setup", &mine), a2.call("notes.setup", &theirs));
    let x: NotesScope = support::socket::payload(x.last().unwrap());
    let y: NotesScope = support::socket::payload(y.last().unwrap());
    assert_eq!(x.scope_id, y.scope_id);
}

#[sqlx::test]
async fn setup_checks_keys_and_the_account(db: PgPool) {
    let env = start(db).await;
    let id = Uuid::now_v7();
    sqlx::query("INSERT INTO users (id) VALUES ($1)").bind(id).execute(&env.db).await.unwrap();
    let principal = session(&env.db, id).await;
    let (mut nobody, _) = Client::connect(&env, &principal, None).await;
    assert_eq!(nobody.refused("notes.setup", &Notebook::new(1).setup()).await, ErrorCode::KeysNotSetUp);

    let alice = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &alice.principal, None).await;
    let mut short = Notebook::new(1).setup();
    short.public_key.0.pop();
    let mut unwrapped = Notebook::new(1).setup();
    unwrapped.wrapped_private_key = Bytes(vec![]);
    let mut long = Notebook::new(1).setup();
    long.wrapped_private_key = Bytes(vec![5; 257]);
    // The id of a scope the account already has for something else.
    let taken: Uuid = sqlx::query_scalar("SELECT id FROM scopes WHERE user_id = $1 AND kind = 'settings'")
        .bind(alice.principal.user_id)
        .fetch_one(&env.db)
        .await
        .unwrap();
    let mut clash = Notebook::new(1).setup();
    clash.scope_id = taken;
    for setup in [short, unwrapped, long, clash] {
        assert_eq!(a.refused("notes.setup", &setup).await, ErrorCode::Malformed);
    }
    let page: NotePage = a.ok("note.list", &NoteList::default()).await;
    assert!(page.scope_id.is_none());
}

#[sqlx::test]
async fn notes_need_the_scope(db: PgPool) {
    let env = start(db).await;
    let alice = user(&env.db).await;
    let (mut a, _) = Client::connect(&env, &alice.principal, None).await;
    let notebook = Notebook::new(1);
    let note_id = Uuid::now_v7();
    assert_eq!(a.refused("note.create", &notebook.create(&alice, note_id, b"x")).await, ErrorCode::NotesNotSetUp);
    assert_eq!(a.refused("note.update", &notebook.update(&alice, note_id, 1, b"x")).await, ErrorCode::NotesNotSetUp);
    assert_eq!(a.refused("note.get", &NoteGet { note_id }).await, ErrorCode::NoteNotFound);
    let _: Empty = a.ok("note.delete", &NoteDelete { note_id }).await;
}

#[sqlx::test]
async fn changes_reach_every_socket_of_the_user_only(db: PgPool) {
    let env = start(db).await;
    let alice = user(&env.db).await;
    let bob = user(&env.db).await;
    let (mut a, notebook) = with_notebook(&env, &alice).await;
    let (mut a2, _) = Client::connect(&env, &alice.principal, None).await;
    let (mut b, bobs) = with_notebook(&env, &bob).await;

    let note_id = Uuid::now_v7();
    let create = notebook.create(&alice, note_id, b"first");
    let stored: NoteStored = a.ok("note.create", &create).await;
    assert_eq!((stored.note.note_id, stored.note.rev), (note_id, 1));
    assert_eq!(stored.note.title, create.title);
    assert_eq!(stored.note.created_at, stored.note.updated_at);
    for socket in [&mut a, &mut a2] {
        let event: NoteUpdated = socket.event("note.updated").await;
        assert_eq!(event.note, stored.note);
    }
    let opened: NoteOpened = a2.ok("note.get", &NoteGet { note_id }).await;
    assert_eq!((opened.note, opened.body), (stored.note.clone(), create.body.clone()));

    let updated: NoteStored = a2.ok("note.update", &notebook.update(&alice, note_id, 1, b"second")).await;
    assert_eq!(updated.note.rev, 2);
    assert!(updated.note.updated_at > stored.note.updated_at);
    assert_eq!(updated.note.created_at, stored.note.created_at);
    for socket in [&mut a, &mut a2] {
        let event: NoteUpdated = socket.event("note.updated").await;
        assert_eq!(event.note, updated.note);
    }

    let _: Empty = a.ok("note.delete", &NoteDelete { note_id }).await;
    for socket in [&mut a, &mut a2] {
        let event: NoteDeleted = socket.event("note.deleted").await;
        assert_eq!(event.note_id, note_id);
    }
    // Deleting it again succeeds and sends nothing.
    let _: Empty = a.ok("note.delete", &NoteDelete { note_id }).await;
    assert_eq!(a.refused("note.get", &NoteGet { note_id }).await, ErrorCode::NoteNotFound);

    // Bob's own change comes after Alice's on the bus: had hers reached him, it would be first.
    let _: NoteStored = b.ok("note.create", &bobs.create(&bob, Uuid::now_v7(), b"b")).await;
    let _: NoteUpdated = b.event("note.updated").await;
    assert!(b.events.is_empty());
    assert!(a.events.is_empty() && a2.events.is_empty());
}

#[sqlx::test]
async fn a_create_is_idempotent_by_id(db: PgPool) {
    let env = start(db).await;
    let alice = user(&env.db).await;
    let bob = user(&env.db).await;
    let (mut a, notebook) = with_notebook(&env, &alice).await;
    let (mut b, bobs) = with_notebook(&env, &bob).await;
    let note_id = Uuid::now_v7();
    let create = notebook.create(&alice, note_id, b"one");
    let stored: NoteStored = a.ok("note.create", &create).await;
    let _: NoteUpdated = a.event("note.updated").await;

    // A resend answers with the stored note and sends nothing.
    let again: NoteStored = a.ok("note.create", &create).await;
    assert_eq!(again.note, stored.note);
    assert!(a.events.is_empty());
    assert_eq!(a.refused("note.create", &notebook.create(&alice, note_id, b"two")).await, ErrorCode::NoteExists);

    // Bob gets the same answer for Alice's id, even with her very records, and her note stays hers.
    assert_eq!(b.refused("note.create", &bobs.create(&bob, note_id, b"one")).await, ErrorCode::NoteExists);
    assert_eq!(b.refused("note.create", &create).await, ErrorCode::NoteExists);
    assert_eq!(b.refused("note.get", &NoteGet { note_id }).await, ErrorCode::NoteNotFound);
    let opened: NoteOpened = a.ok("note.get", &NoteGet { note_id }).await;
    assert_eq!((opened.note, opened.body), (stored.note, create.body));
}

#[sqlx::test]
async fn an_update_based_on_another_revision_conflicts(db: PgPool) {
    let env = start(db).await;
    let alice = user(&env.db).await;
    let bob = user(&env.db).await;
    let (mut a, notebook) = with_notebook(&env, &alice).await;
    let (mut b, bobs) = with_notebook(&env, &bob).await;
    let note_id = Uuid::now_v7();
    let _: NoteStored = a.ok("note.create", &notebook.create(&alice, note_id, b"one")).await;
    let two = notebook.update(&alice, note_id, 1, b"two");
    let stored: NoteStored = a.ok("note.update", &two).await;
    assert_eq!(stored.note.rev, 2);

    // A device still on revision 1, and one ahead of the server.
    for rev in [1, 3] {
        assert_eq!(
            a.refused("note.update", &notebook.update(&alice, note_id, rev, b"three")).await,
            ErrorCode::NoteConflict
        );
    }
    // A resend of the update that made revision 2 answers with it and changes nothing.
    let again: NoteStored = a.ok("note.update", &two).await;
    assert_eq!(again.note, stored.note);
    let opened: NoteOpened = a.ok("note.get", &NoteGet { note_id }).await;
    assert_eq!(opened.body, two.body);

    assert_eq!(
        a.refused("note.update", &notebook.update(&alice, Uuid::now_v7(), 1, b"x")).await,
        ErrorCode::NoteNotFound
    );
    // Bob can neither change nor remove Alice's note.
    assert_eq!(b.refused("note.update", &bobs.update(&bob, note_id, 2, b"x")).await, ErrorCode::NoteNotFound);
    let _: Empty = b.ok("note.delete", &NoteDelete { note_id }).await;
    let opened: NoteOpened = a.ok("note.get", &NoteGet { note_id }).await;
    assert_eq!(opened.note.rev, 2);
}

#[sqlx::test]
async fn updated_at_grows_with_every_change(db: PgPool) {
    let env = start(db).await;
    let alice = user(&env.db).await;
    let (mut a, notebook) = with_notebook(&env, &alice).await;
    let note_id = Uuid::now_v7();
    let _: NoteStored = a.ok("note.create", &notebook.create(&alice, note_id, b"0")).await;
    // A time ahead of the clock, as after a clock step back.
    let ahead: i64 = sqlx::query_scalar(
        "UPDATE notes SET updated_at = (extract(epoch FROM now()) * 1000)::bigint + 60000 WHERE id = $1
         RETURNING updated_at",
    )
    .bind(note_id)
    .fetch_one(&env.db)
    .await
    .unwrap();
    let stored: NoteStored = a.ok("note.update", &notebook.update(&alice, note_id, 1, b"1")).await;
    assert_eq!(stored.note.updated_at, ahead + 1);
}

#[sqlx::test]
async fn records_are_checked(db: PgPool) {
    let env = start(db).await;
    let alice = user(&env.db).await;
    let (mut a, notebook) = with_notebook(&env, &alice).await;
    let note_id = Uuid::now_v7();
    let stale = Notebook { scope_id: notebook.scope_id, keys: ScopeKeyPair::generate(2, &mut os_rng()) };
    let (title, body) = notebook.records(&alice, note_id, b"t", b"b");
    let (title2, body2) = stale.records(&alice, note_id, b"t", b"b");
    let big_title = notebook.seal(
        &alice,
        Kind::NoteTitle { note_id: NoteId::from_bytes(*note_id.as_bytes()) },
        &vec![7; NOTE_TITLE_MAX],
    );
    let big_body = notebook.seal(
        &alice,
        Kind::NoteBody { note_id: NoteId::from_bytes(*note_id.as_bytes()) },
        &vec![7; NOTE_BODY_MAX],
    );
    assert!(big_title.0.len() > NOTE_TITLE_MAX && big_body.0.len() > NOTE_BODY_MAX);
    let malformed = [
        (title2, body.clone()),
        (title.clone(), body2),
        (Bytes(vec![]), body.clone()),
        (title.clone(), Bytes(vec![])),
        (Bytes(vec![1; 10]), body.clone()),
        (big_title, body.clone()),
        (title.clone(), big_body),
    ];
    for (i, (title, body)) in malformed.into_iter().enumerate() {
        let create = NoteCreate { note_id, title: title.clone(), body: body.clone() };
        assert_eq!(a.refused("note.create", &create).await, ErrorCode::Malformed, "create {i}");
    }
    let _: NoteStored = a.ok("note.create", &NoteCreate { note_id, title: title.clone(), body: body.clone() }).await;

    // After a rotation records follow the latest key version.
    sqlx::query(
        "INSERT INTO scope_keys (scope_id, key_version, public_key, wrapped_private_key) VALUES ($1, 2, $2, $3)",
    )
    .bind(notebook.scope_id)
    .bind(vec![4u8; 32])
    .bind(vec![5u8; 73])
    .execute(&env.db)
    .await
    .unwrap();
    assert_eq!(a.refused("note.update", &notebook.update(&alice, note_id, 1, b"x")).await, ErrorCode::Malformed);
    let stored: NoteStored = a.ok("note.update", &stale.update(&alice, note_id, 1, b"x")).await;
    assert_eq!(stored.note.rev, 2);
    assert_eq!(a.refused("note.create", &notebook.create(&alice, Uuid::now_v7(), b"x")).await, ErrorCode::Malformed);
}

#[sqlx::test]
async fn an_account_holds_a_limited_number_of_notes(db: PgPool) {
    let env = start(db).await;
    let alice = user(&env.db).await;
    let (mut a, notebook) = with_notebook(&env, &alice).await;
    sqlx::query(
        "INSERT INTO notes (id, user_id, scope_id, title, body, rev, created_at, updated_at)
         SELECT gen_random_uuid(), $1, $2, '\\x01', '\\x01', 1, n, n FROM generate_series(1, $3 - 1) n",
    )
    .bind(alice.principal.user_id)
    .bind(notebook.scope_id)
    .bind(NOTES_MAX)
    .execute(&env.db)
    .await
    .unwrap();
    let last = Uuid::now_v7();
    let _: NoteStored = a.ok("note.create", &notebook.create(&alice, last, b"last")).await;
    assert_eq!(a.refused("note.create", &notebook.create(&alice, Uuid::now_v7(), b"x")).await, ErrorCode::NoteLimit);
    // Changing a note is not adding one.
    let _: NoteStored = a.ok("note.update", &notebook.update(&alice, last, 1, b"y")).await;
}

#[sqlx::test]
async fn notes_page_newest_first(db: PgPool) {
    let env = start(db).await;
    let alice = user(&env.db).await;
    let bob = user(&env.db).await;
    let (mut a, notebook) = with_notebook(&env, &alice).await;
    let (_, bobs) = with_notebook(&env, &bob).await;
    // Pairs share an `updated_at`, so the id breaks the tie.
    let total = NOTES_PAGE + 5;
    let count = i64::try_from(total).unwrap();
    sqlx::query(
        "INSERT INTO notes (id, user_id, scope_id, title, body, rev, created_at, updated_at)
         SELECT gen_random_uuid(), $1, $2, '\\x01', '\\x02', 1, n / 2, n / 2 FROM generate_series(1, $3) n",
    )
    .bind(alice.principal.user_id)
    .bind(notebook.scope_id)
    .bind(count)
    .execute(&env.db)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO notes (id, user_id, scope_id, title, body, rev, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, '\\x01', '\\x02', 1, 1, 1)",
    )
    .bind(bob.principal.user_id)
    .bind(bobs.scope_id)
    .execute(&env.db)
    .await
    .unwrap();

    let first: NotePage = a.ok("note.list", &NoteList::default()).await;
    assert_eq!(first.scope_id, Some(notebook.scope_id));
    assert_eq!(first.notes.len(), NOTES_PAGE);
    let next = first.next.unwrap();
    let last = first.notes.last().unwrap();
    assert_eq!(next, NoteCursor { updated_at: last.updated_at, note_id: last.note_id });
    let second: NotePage = a.ok("note.list", &NoteList { before: Some(next) }).await;
    assert_eq!(second.notes.len(), total - NOTES_PAGE);
    assert!(second.next.is_none());

    let all: Vec<&NoteInfo> = first.notes.iter().chain(&second.notes).collect();
    let keys: Vec<(i64, Uuid)> = all.iter().map(|n| (n.updated_at, n.note_id)).collect();
    let mut sorted = keys.clone();
    sorted.sort_by(|x, y| y.cmp(x));
    sorted.dedup();
    assert_eq!(keys, sorted);
    assert!(all.iter().all(|n| n.title.0 == [1]));
}

#[sqlx::test]
async fn deleting_the_user_deletes_the_notes(db: PgPool) {
    let env = start(db).await;
    let alice = user(&env.db).await;
    let (mut a, notebook) = with_notebook(&env, &alice).await;
    let _: NoteStored = a.ok("note.create", &notebook.create(&alice, Uuid::now_v7(), b"x")).await;
    sqlx::query("DELETE FROM users WHERE id = $1").bind(alice.principal.user_id).execute(&env.db).await.unwrap();
    let notes: i64 = sqlx::query_scalar("SELECT count(*) FROM notes").fetch_one(&env.db).await.unwrap();
    let scopes: i64 =
        sqlx::query_scalar("SELECT count(*) FROM scopes WHERE kind = 'notes'").fetch_one(&env.db).await.unwrap();
    assert_eq!((notes, scopes), (0, 0));
}
