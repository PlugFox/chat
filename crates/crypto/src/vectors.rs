//! Test vectors, checked natively and in WASM by the same tests
//! (docs/crypto.md, "Testing"):
//!
//! - `vectors/rfc9180.json`: RFC 9180 vectors for our HPKE suite, all four modes.
//! - `vectors/v1.json`: every v1 format, produced from a seeded RNG. The test
//!   regenerates them and compares byte for byte, then opens every stored
//!   value from the file alone. `CHAT_CRYPTO_REGEN=1 cargo test -p chat-crypto vectors`
//!   rewrites the file; a diff in it is a format change and needs review.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test helpers fail loudly")]

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

use hpke::{Deserializable, OpModeR, PskBundle};
use rand_chacha::{ChaCha20Rng, rand_core::SeedableRng};
use serde_json::{Value, json};

use crate::{
    PublicKey,
    ark::{Ark, Commitment},
    ids::*,
    keys::{Aead, EncappedKey, HpkePrivateKey, HpkePublicKey, Kdf, Kem, KeyPair},
    link::{self, LinkKeyPair, LinkSecret},
    record::{self, Author, Granularity, Kind, Origin, Place},
    recovery::RecoveryKey,
    scope::{ScopeKeyPair, ScopePublicKey},
    wrap::{ArkWrap, UnlockSecret, WrapMethod},
};

const RFC9180: &str = include_str!("../vectors/rfc9180.json");
const V1: &str = include_str!("../vectors/v1.json");

fn unhex(v: &Value) -> Vec<u8> {
    hex::decode(v.as_str().unwrap()).unwrap()
}

fn arr<const N: usize>(v: &Value) -> [u8; N] {
    unhex(v).try_into().unwrap()
}

#[test]
fn rfc9180_vectors_open() {
    let file: Value = serde_json::from_str(RFC9180).unwrap();
    for case in file["cases"].as_array().unwrap() {
        let receiver = KeyPair::derive(&unhex(&case["ikmR"]));
        assert_eq!(receiver.public().as_bytes().as_slice(), unhex(&case["pkRm"]), "DeriveKeyPair(ikmR)");
        let sk = HpkePrivateKey::from_bytes(&unhex(&case["skRm"])).unwrap();
        let enc = EncappedKey::from_bytes(&unhex(&case["enc"])).unwrap();
        let (psk, psk_id) = (unhex(&case["psk"]), unhex(&case["psk_id"]));
        let pk_s = || HpkePublicKey::from_bytes(&unhex(&case["pkSm"])).unwrap();
        let bundle = || PskBundle::new(&psk, &psk_id).unwrap();
        let mode = match case["mode"].as_u64().unwrap() {
            0 => OpModeR::Base,
            1 => OpModeR::Psk(bundle()),
            2 => OpModeR::Auth(pk_s()),
            3 => OpModeR::AuthPsk(pk_s(), bundle()),
            m => panic!("mode {m}"),
        };
        let pt = hpke::single_shot_open::<Aead, Kdf, Kem>(
            &mode,
            &sk,
            &enc,
            &unhex(&case["info"]),
            &unhex(&case["ct"]),
            &unhex(&case["aad"]),
        )
        .unwrap();
        assert_eq!(pt, unhex(&case["pt"]), "mode {}", case["mode"]);
    }
}

const USER: UserId = UserId::from_bytes([0x11; 16]);
const SCOPE: ScopeId = ScopeId::from_bytes([0x22; 16]);
const WRAP_RECOVERY: WrapId = WrapId::from_bytes([0x31; 16]);
const WRAP_PASSKEY: WrapId = WrapId::from_bytes([0x32; 16]);
const PRF_OUTPUT: [u8; 32] = [0x33; 32];
const PRF_SALT: [u8; 32] = [0x34; 32];
const CREDENTIAL_ID: &[u8] = b"credential-0001";
const LINK_SID: LinkSessionId = LinkSessionId::from_bytes([0x44; 16]);
const WRAP_DEVICE: WrapId = WrapId::from_bytes([0x35; 16]);
const DEVICE: DeviceId = DeviceId::from_bytes([0x36; 16]);
const DEVICE_SECRET: [u8; 32] = [0x37; 32];

fn records() -> Vec<(&'static str, Kind<'static>, Origin, Vec<u8>)> {
    let note = NoteId::from_bytes([0x55; 16]);
    let long = "Note body that is long enough to cross a Padmé step. ".repeat(20);
    vec![
        ("chat.title", Kind::ChatTitle, Origin::Client, "Weekly plan".into()),
        (
            "chat.message user",
            Kind::ChatMessage { message_id: 1, author: Author::User },
            Origin::Client,
            "Привет! How many steps did I walk this week?".into(),
        ),
        (
            "chat.message assistant",
            Kind::ChatMessage { message_id: 2, author: Author::Assistant },
            Origin::Server,
            "I need access to your steps register to answer.".into(),
        ),
        (
            "chat.message tool",
            Kind::ChatMessage { message_id: 3, author: Author::Tool },
            Origin::Server,
            r#"{"steps":[8123,10450]}"#.into(),
        ),
        (
            "chat.message summary",
            Kind::ChatMessage { message_id: 4, author: Author::Summary },
            Origin::Server,
            "User asked about weekly steps.".into(),
        ),
        (
            "notebook.name",
            Kind::NotebookName { notebook_id: NotebookId::from_bytes([0x56; 16]) },
            Origin::Client,
            "Health".into(),
        ),
        ("note.title", Kind::NoteTitle { note_id: note }, Origin::Client, "Allergies".into()),
        ("note.body", Kind::NoteBody { note_id: note }, Origin::Client, long.into_bytes()),
        (
            "register.value",
            Kind::RegisterValue {
                entry_id: EntryId::from_bytes([0x57; 16]),
                period_start: 1_761_350_400,
                granularity: Granularity::Day,
            },
            Origin::Client,
            "72.4".into(),
        ),
        ("profile.value", Kind::ProfileValue { attribute: "height" }, Origin::Client, "178".into()),
        ("settings.value", Kind::SettingsValue { key: "provider" }, Origin::Client, Vec::new()),
        (
            "audit.reason",
            Kind::AuditReason { log_entry_id: LogEntryId::from_bytes([0x58; 16]) },
            Origin::Server,
            "To count your steps for this week.".into(),
        ),
        ("file.key client", Kind::FileKey { file_id: FileId::from_bytes([0x59; 16]) }, Origin::Client, vec![0x5a; 32]),
        ("file.key server", Kind::FileKey { file_id: FileId::from_bytes([0x59; 16]) }, Origin::Server, vec![0x5b; 32]),
    ]
}

/// Every v1 format from a seeded RNG, in a fixed order.
fn generate() -> Value {
    let mut rng = ChaCha20Rng::from_seed([0x01; 32]);
    let ark = Ark::generate(&mut rng);
    let commitment = ark.commitment(&USER);
    let writer = ark.writer_key(&USER);
    let recovery = RecoveryKey::generate(&mut rng);
    let wrap_recovery =
        ArkWrap::seal(&ark, &USER, WRAP_RECOVERY, WrapMethod::Recovery, &UnlockSecret::Recovery(&recovery), &mut rng)
            .unwrap();
    let passkey = WrapMethod::Passkey { credential_id: CREDENTIAL_ID.to_vec(), prf_salt: PRF_SALT };
    let wrap_passkey =
        ArkWrap::seal(&ark, &USER, WRAP_PASSKEY, passkey, &UnlockSecret::Prf(&PRF_OUTPUT), &mut rng).unwrap();
    let scope = ScopeKeyPair::generate(1, &mut rng);
    let scope_wrapped = scope.wrap(&ark, &USER, &SCOPE, &mut rng);
    let to = scope.public();

    let records: Vec<Value> = records()
        .into_iter()
        .map(|(name, kind, origin, plaintext)| {
            let place = Place { user: USER, scope: SCOPE, kind };
            let sealed = match origin {
                Origin::Client => record::seal_as_client(&place, &to, &writer, &plaintext, &mut rng),
                Origin::Server => record::seal_as_server(&place, &to, &plaintext, &mut rng),
            }
            .unwrap();
            json!({ "name": name, "plaintext": hex::encode(&plaintext), "record": hex::encode(sealed) })
        })
        .collect();

    let link_secret = LinkSecret::generate(&mut rng);
    let link_keys = LinkKeyPair::generate(&mut rng);
    let link_message = link::seal_ark(&ark, &USER, &LINK_SID, &link_keys.public(), &link_secret, &mut rng).unwrap();
    let link_tag = link::request_tag(&link_secret, &LINK_SID, &link_keys.public());
    // Added after the first freeze: last, so the values above keep their bytes.
    let device = WrapMethod::Device { device_id: DEVICE };
    let wrap_device =
        ArkWrap::seal(&ark, &USER, WRAP_DEVICE, device, &UnlockSecret::Device(&DEVICE_SECRET), &mut rng).unwrap();

    json!({
        "comment": "Generated by crates/crypto/src/vectors.rs from ChaCha20Rng seed 0x01 * 32. Do not edit.",
        "user_id": hex::encode(USER.as_bytes()),
        "scope_id": hex::encode(SCOPE.as_bytes()),
        "ark": hex::encode(ark.as_bytes()),
        "commitment": hex::encode(commitment.0),
        "writer_public_key": hex::encode(writer.public().as_bytes()),
        "recovery_words": recovery.to_words().as_str(),
        "wrap_recovery": hex::encode(wrap_recovery.encode().unwrap()),
        "prf_output": hex::encode(PRF_OUTPUT),
        "wrap_passkey": hex::encode(wrap_passkey.encode().unwrap()),
        "scope_key_version": 1,
        "scope_public_key": hex::encode(to.key.as_bytes()),
        "scope_private_key_wrapped": hex::encode(scope_wrapped),
        "records": records,
        "link_session_id": hex::encode(LINK_SID.as_bytes()),
        "link_secret": hex::encode(link_secret.as_bytes()),
        "link_private_key": hex::encode(link_keys.private_bytes()),
        "link_public_key": hex::encode(link_keys.public().as_bytes()),
        "link_message": hex::encode(link_message),
        "link_request_tag": hex::encode(link_tag),
        "device_secret": hex::encode(DEVICE_SECRET),
        "wrap_device": hex::encode(wrap_device.encode().unwrap()),
    })
}

#[test]
fn v1_vectors_regenerate_identically() {
    let generated = generate();
    #[cfg(not(target_arch = "wasm32"))]
    if std::env::var_os("CHAT_CRYPTO_REGEN").is_some() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/vectors/v1.json");
        std::fs::write(path, serde_json::to_string_pretty(&generated).unwrap() + "\n").unwrap();
        return;
    }
    let stored: Value = serde_json::from_str(V1).unwrap();
    assert_eq!(generated, stored, "vectors/v1.json is stale: the formats changed (see the module docs)");
}

#[test]
fn v1_vectors_open_from_the_file_alone() {
    let v: Value = serde_json::from_str(V1).unwrap();
    let commitment = Commitment(arr(&v["commitment"]));
    let writer = PublicKey::from_bytes(arr(&v["writer_public_key"]));

    let recovery = RecoveryKey::from_words(v["recovery_words"].as_str().unwrap()).unwrap();
    let wrap = ArkWrap::decode(&unhex(&v["wrap_recovery"])).unwrap();
    let ark = wrap.open(&USER, &UnlockSecret::Recovery(&recovery), &commitment).unwrap();
    assert_eq!(hex::encode(ark.as_bytes()), v["ark"].as_str().unwrap());
    let wrap = ArkWrap::decode(&unhex(&v["wrap_passkey"])).unwrap();
    let prf: [u8; 32] = arr(&v["prf_output"]);
    let from_passkey = wrap.open(&USER, &UnlockSecret::Prf(&prf), &commitment).unwrap();
    assert_eq!(from_passkey.as_bytes(), ark.as_bytes());
    let wrap = ArkWrap::decode(&unhex(&v["wrap_device"])).unwrap();
    assert_eq!(wrap.method, WrapMethod::Device { device_id: DEVICE });
    let secret: [u8; 32] = arr(&v["device_secret"]);
    let from_device = wrap.open(&USER, &UnlockSecret::Device(&secret), &commitment).unwrap();
    assert_eq!(from_device.as_bytes(), ark.as_bytes());
    assert_eq!(ark.writer_key(&USER).public(), writer);

    let scope = ScopeKeyPair::unwrap(&ark, &USER, &SCOPE, 1, &unhex(&v["scope_private_key_wrapped"])).unwrap();
    assert_eq!(
        scope.public(),
        ScopePublicKey { key_version: 1, key: PublicKey::from_bytes(arr(&v["scope_public_key"])) }
    );

    let stored = v["records"].as_array().unwrap();
    for ((name, kind, origin, plaintext), stored) in records().into_iter().zip(stored) {
        assert_eq!(stored["name"], name);
        let place = Place { user: USER, scope: SCOPE, kind };
        let (opened, opened_origin) = record::open(&place, &scope, &writer, &unhex(&stored["record"])).unwrap();
        assert_eq!(opened.as_slice(), plaintext.as_slice(), "{name}");
        assert_eq!(opened_origin, origin, "{name}");
    }

    let keys = LinkKeyPair::from_private_bytes(&unhex(&v["link_private_key"])).unwrap();
    let secret = LinkSecret::from_bytes(arr(&v["link_secret"]));
    let linked = link::open_ark(&unhex(&v["link_message"]), &USER, &LINK_SID, &keys, &secret, &commitment).unwrap();
    assert_eq!(linked.as_bytes(), ark.as_bytes());
    link::verify_request_tag(&secret, &LINK_SID, &keys.public(), &unhex(&v["link_request_tag"])).unwrap();
}
