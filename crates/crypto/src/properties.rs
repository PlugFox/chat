//! Property tests (docs/crypto.md, "Testing"): round trips, and any change to
//! a sealed value or to its place must fail. Native only; the vectors cover WASM.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test helpers fail loudly")]

use proptest::prelude::*;
use rand_chacha::{ChaCha20Rng, rand_core::SeedableRng};

use crate::{
    Error,
    ark::Ark,
    ids::*,
    link::{self, LinkKeyPair, LinkSecret},
    record::{self, Author, Granularity, Kind, Origin, Place},
    recovery::RecoveryKey,
    scope::ScopeKeyPair,
    wrap::{ArkWrap, UnlockSecret, WrapMethod},
};

const USER: UserId = UserId::from_bytes([1; 16]);
const SCOPE: ScopeId = ScopeId::from_bytes([2; 16]);

struct Fixture {
    rng: ChaCha20Rng,
    ark: Ark,
    scope: ScopeKeyPair,
}

fn fixture(seed: u64) -> Fixture {
    let mut rng = ChaCha20Rng::seed_from_u64(seed);
    let ark = Ark::generate(&mut rng);
    let scope = ScopeKeyPair::generate(1, &mut rng);
    Fixture { rng, ark, scope }
}

fn kind_strategy() -> impl Strategy<Value = Kind<'static>> {
    let id = any::<[u8; 16]>();
    prop_oneof![
        Just(Kind::ChatTitle),
        (
            any::<u32>(),
            prop_oneof![Just(Author::User), Just(Author::Assistant), Just(Author::Tool), Just(Author::Summary)]
        )
            .prop_map(|(message_id, author)| Kind::ChatMessage { message_id, author }),
        id.prop_map(|b| Kind::NotebookName { notebook_id: NotebookId::from_bytes(b) }),
        id.prop_map(|b| Kind::NoteTitle { note_id: NoteId::from_bytes(b) }),
        id.prop_map(|b| Kind::NoteBody { note_id: NoteId::from_bytes(b) }),
        (id, any::<i64>(), prop_oneof![Just(Granularity::Instant), Just(Granularity::Hour), Just(Granularity::Day)])
            .prop_map(|(b, period_start, granularity)| Kind::RegisterValue {
                entry_id: EntryId::from_bytes(b),
                period_start,
                granularity
            }),
        prop_oneof![Just("height"), Just("allergies")].prop_map(|attribute| Kind::ProfileValue { attribute }),
        prop_oneof![Just("provider"), Just("locale")].prop_map(|key| Kind::SettingsValue { key }),
        id.prop_map(|b| Kind::AuditReason { log_entry_id: LogEntryId::from_bytes(b) }),
        id.prop_map(|b| Kind::FileKey { file_id: FileId::from_bytes(b) }),
    ]
}

/// Seals with the writer the kind allows (client first).
fn seal_any(f: &mut Fixture, place: &Place<'_>, plaintext: &[u8]) -> (Vec<u8>, Origin) {
    let writer = f.ark.writer_key(&USER);
    let to = f.scope.public();
    match record::seal_as_client(place, &to, &writer, plaintext, &mut f.rng) {
        Ok(r) => (r, Origin::Client),
        Err(Error::WrongWriter) => (record::seal_as_server(place, &to, plaintext, &mut f.rng).unwrap(), Origin::Server),
        Err(e) => panic!("{e}"),
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn record_round_trip(seed: u64, kind in kind_strategy(), plaintext in proptest::collection::vec(any::<u8>(), 0..3000)) {
        let mut f = fixture(seed);
        let place = Place { user: USER, scope: SCOPE, kind };
        let (sealed, origin) = seal_any(&mut f, &place, &plaintext);
        let writer = f.ark.writer_key(&USER).public();
        let (opened, opened_origin) = record::open(&place, &f.scope, &writer, &sealed).unwrap();
        prop_assert_eq!(opened.as_slice(), plaintext.as_slice());
        prop_assert_eq!(opened_origin, origin);
    }

    #[test]
    fn any_flipped_bit_fails(seed: u64, kind in kind_strategy(), plaintext in proptest::collection::vec(any::<u8>(), 0..200), bit: usize) {
        let mut f = fixture(seed);
        let place = Place { user: USER, scope: SCOPE, kind };
        let (mut sealed, _) = seal_any(&mut f, &place, &plaintext);
        let bit = bit % (sealed.len() * 8);
        sealed[bit / 8] ^= 1 << (bit % 8);
        let writer = f.ark.writer_key(&USER).public();
        prop_assert!(record::open(&place, &f.scope, &writer, &sealed).is_err());
    }

    #[test]
    fn another_place_fails(seed: u64, kind in kind_strategy(), other in kind_strategy(), other_user: [u8; 16], other_scope: [u8; 16]) {
        let mut f = fixture(seed);
        let place = Place { user: USER, scope: SCOPE, kind };
        let (sealed, _) = seal_any(&mut f, &place, b"value");
        let writer = f.ark.writer_key(&USER).public();
        let elsewhere = [
            Place { kind: other, ..place },
            Place { user: UserId::from_bytes(other_user), ..place },
            Place { scope: ScopeId::from_bytes(other_scope), ..place },
        ];
        for moved in elsewhere.iter().filter(|p| **p != place) {
            prop_assert!(record::open(moved, &f.scope, &writer, &sealed).is_err());
        }
    }

    #[test]
    fn decoders_never_panic(bytes in proptest::collection::vec(any::<u8>(), 0..300), text in ".{0,200}") {
        let mut f = fixture(0);
        let writer = f.ark.writer_key(&USER).public();
        let place = Place { user: USER, scope: SCOPE, kind: Kind::ChatTitle };
        let _ = record::open(&place, &f.scope, &writer, &bytes);
        let _ = record::key_version(&bytes);
        let _ = ArkWrap::decode(&bytes);
        let _ = ScopeKeyPair::unwrap(&f.ark, &USER, &SCOPE, 1, &bytes);
        let keys = LinkKeyPair::generate(&mut f.rng);
        let secret = LinkSecret::generate(&mut f.rng);
        let sid = LinkSessionId::from_bytes([3; 16]);
        let _ = link::open_ark(&bytes, &USER, &sid, &keys, &secret, &f.ark.commitment(&USER));
        let _ = RecoveryKey::from_words(&text);
    }
}

#[test]
fn server_cannot_downgrade_a_client_kind() {
    let mut f = fixture(7);
    let writer = f.ark.writer_key(&USER);
    for kind in [
        Kind::ChatTitle,
        Kind::ChatMessage { message_id: 1, author: Author::User },
        Kind::NoteBody { note_id: NoteId::from_bytes([4; 16]) },
        Kind::SettingsValue { key: "provider" },
    ] {
        let place = Place { user: USER, scope: SCOPE, kind };
        assert_eq!(record::seal_as_server(&place, &f.scope.public(), b"x", &mut f.rng), Err(Error::WrongWriter));
        // A base-mode record built directly, as a malicious server would.
        let forged = record::seal(&place, &f.scope.public(), None, b"forged", &mut f.rng).unwrap();
        assert_eq!(record::open(&place, &f.scope, &writer.public(), &forged), Err(Error::Decrypt));
    }
    // And a server kind sealed in auth mode is rejected too.
    let place =
        Place { user: USER, scope: SCOPE, kind: Kind::ChatMessage { message_id: 2, author: Author::Assistant } };
    assert_eq!(record::seal_as_client(&place, &f.scope.public(), &writer, b"x", &mut f.rng), Err(Error::WrongWriter));
    let confused = record::seal(&place, &f.scope.public(), Some(&writer), b"x", &mut f.rng).unwrap();
    assert_eq!(record::open(&place, &f.scope, &writer.public(), &confused), Err(Error::Decrypt));
}

#[test]
fn another_writer_key_fails() {
    let mut f = fixture(8);
    let place = Place { user: USER, scope: SCOPE, kind: Kind::ChatTitle };
    let sealed = record::seal_as_client(&place, &f.scope.public(), &f.ark.writer_key(&USER), b"x", &mut f.rng).unwrap();
    let other = Ark::generate(&mut f.rng).writer_key(&USER).public();
    assert_eq!(record::open(&place, &f.scope, &other, &sealed), Err(Error::Decrypt));
}

#[test]
fn key_version_is_checked_and_reported() {
    let mut f = fixture(9);
    let place = Place { user: USER, scope: SCOPE, kind: Kind::ChatTitle };
    let sealed = record::seal_as_client(&place, &f.scope.public(), &f.ark.writer_key(&USER), b"x", &mut f.rng).unwrap();
    assert_eq!(record::key_version(&sealed), Ok(1));
    let v2 = ScopeKeyPair::generate(2, &mut f.rng);
    assert_eq!(record::open(&place, &v2, &f.ark.writer_key(&USER).public(), &sealed), Err(Error::KeyVersion(1)));
}

#[test]
fn wraps_need_the_right_secret_place_and_commitment() {
    let mut f = fixture(10);
    let commitment = f.ark.commitment(&USER);
    let recovery = RecoveryKey::generate(&mut f.rng);
    let wrap_id = WrapId::from_bytes([5; 16]);
    let wrap =
        ArkWrap::seal(&f.ark, &USER, wrap_id, WrapMethod::Recovery, &UnlockSecret::Recovery(&recovery), &mut f.rng)
            .unwrap();
    assert!(wrap.open(&USER, &UnlockSecret::Recovery(&recovery), &commitment).is_ok());

    let wrong = RecoveryKey::generate(&mut f.rng);
    assert_eq!(wrap.open(&USER, &UnlockSecret::Recovery(&wrong), &commitment).unwrap_err(), Error::Decrypt);
    assert_eq!(wrap.open(&USER, &UnlockSecret::Prf(&[0; 32]), &commitment).unwrap_err(), Error::Decrypt);
    let other_user = UserId::from_bytes([6; 16]);
    assert_eq!(wrap.open(&other_user, &UnlockSecret::Recovery(&recovery), &commitment).unwrap_err(), Error::Decrypt);
    let other_commitment = Ark::generate(&mut f.rng).commitment(&USER);
    assert_eq!(wrap.open(&USER, &UnlockSecret::Recovery(&recovery), &other_commitment).unwrap_err(), Error::Commitment);

    let encoded = wrap.encode().unwrap();
    assert_eq!(ArkWrap::decode(&encoded).unwrap(), wrap);
    for bit in 0..encoded.len() * 8 {
        let mut tampered = encoded.clone();
        tampered[bit / 8] ^= 1 << (bit % 8);
        let opened =
            ArkWrap::decode(&tampered).and_then(|w| w.open(&USER, &UnlockSecret::Recovery(&recovery), &commitment));
        assert!(opened.is_err(), "bit {bit}");
    }
}

#[test]
fn scope_keys_are_bound_to_user_scope_and_version() {
    let mut f = fixture(11);
    let wrapped = f.scope.wrap(&f.ark, &USER, &SCOPE, &mut f.rng);
    assert!(ScopeKeyPair::unwrap(&f.ark, &USER, &SCOPE, 1, &wrapped).is_ok());
    assert!(ScopeKeyPair::unwrap(&f.ark, &USER, &SCOPE, 2, &wrapped).is_err());
    assert!(ScopeKeyPair::unwrap(&f.ark, &USER, &ScopeId::from_bytes([9; 16]), 1, &wrapped).is_err());
    assert!(ScopeKeyPair::unwrap(&f.ark, &UserId::from_bytes([9; 16]), &SCOPE, 1, &wrapped).is_err());
    let other = Ark::generate(&mut f.rng);
    assert!(ScopeKeyPair::unwrap(&other, &USER, &SCOPE, 1, &wrapped).is_err());
}

#[test]
fn link_needs_the_qr_secret() {
    let mut f = fixture(12);
    let sid = LinkSessionId::from_bytes([7; 16]);
    let keys = LinkKeyPair::generate(&mut f.rng);
    let secret = LinkSecret::generate(&mut f.rng);
    let commitment = f.ark.commitment(&USER);
    let message = link::seal_ark(&f.ark, &USER, &sid, &keys.public(), &secret, &mut f.rng).unwrap();
    assert!(link::open_ark(&message, &USER, &sid, &keys, &secret, &commitment).is_ok());

    // A server that substitutes the message cannot produce one without k.
    let guessed = LinkSecret::generate(&mut f.rng);
    let forged = link::seal_ark(&f.ark, &USER, &sid, &keys.public(), &guessed, &mut f.rng).unwrap();
    assert_eq!(link::open_ark(&forged, &USER, &sid, &keys, &secret, &commitment).unwrap_err(), Error::Decrypt);
    let other_sid = LinkSessionId::from_bytes([8; 16]);
    assert!(link::open_ark(&message, &USER, &other_sid, &keys, &secret, &commitment).is_err());

    // Direction B: a substituted public key fails the tag.
    let tag = link::request_tag(&secret, &sid, &keys.public());
    assert!(link::verify_request_tag(&secret, &sid, &keys.public(), &tag).is_ok());
    let attacker = LinkKeyPair::generate(&mut f.rng);
    assert_eq!(link::verify_request_tag(&secret, &sid, &attacker.public(), &tag), Err(Error::Decrypt));
}
