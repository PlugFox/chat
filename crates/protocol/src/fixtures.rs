//! Frames each implementation encodes and the other decodes
//! (docs/protocol.md, "Encoding rules"). `fixtures/rust.json` is written here,
//! `fixtures/ts.json` by `client/tests/unit/protocol-fixtures.test.ts`; the same samples
//! are listed on both sides. `CHAT_PROTOCOL_REGEN=1` rewrites the file of the
//! side that runs.

#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test code fails loudly")]

use std::{collections::BTreeMap, path::PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    Bytes, InFrame,
    connection::{Auth, AuthOk, Resume},
    encode,
    error::{ErrorCode, ErrorPayload},
    keys::{AccountScopeKind, KeysSetup, NewAccountScope},
    redact::Secret,
};

/// The value kinds no real message carries yet.
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Sample {
    data: Bytes,
    empty: Bytes,
    list: Vec<Bytes>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    absent: Option<u32>,
    negative: i64,
    large: i64,
    text: String,
}

fn path(file: &str) -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures")).join(file)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

/// A sample: its name, the Rust encoding of the expected value, and a function
/// that decodes a frame as the sample's Rust type and encodes it again (equal
/// to the second field when both sides agree).
type Case = (&'static str, Vec<u8>, fn(&[u8]) -> Vec<u8>);

fn samples() -> Vec<Case> {
    fn again<T: Serialize + serde::de::DeserializeOwned>(bytes: &[u8]) -> Vec<u8> {
        let frame = InFrame::parse(bytes).unwrap();
        encode(frame.kind, frame.id, &frame.payload::<T>().unwrap())
    }
    let session = Uuid::from_u128(0x0192_0000_0000_7000_8000_0000_0000_0001);
    vec![
        ("auth", encode("auth", 1, &Auth { v: 1, access_token: Secret("t".into()), resume: None }), again::<Auth>),
        (
            "auth.resume",
            encode(
                "auth",
                2,
                &Auth { v: 1, access_token: Secret("t".into()), resume: Some(Resume { agent_session_id: session }) },
            ),
            again::<Auth>,
        ),
        (
            "auth.ok",
            encode(
                "ok",
                3,
                &AuthOk {
                    session_id: session,
                    heartbeat_ms: 20_000,
                    server_time: 1_793_000_000_000,
                    agent_session_id: None,
                    files: true,
                },
            ),
            again::<AuthOk>,
        ),
        ("error", encode("error", 4, &ErrorPayload::new(ErrorCode::RateLimited, "slow down")), again::<ErrorPayload>),
        (
            "keys.setup",
            encode(
                "keys.setup",
                5,
                &KeysSetup {
                    commitment: Bytes(vec![1; 32]),
                    writer_public_key: Bytes(vec![2; 32]),
                    wraps: vec![Bytes(vec![3; 66])],
                    scopes: vec![NewAccountScope {
                        scope_id: session,
                        kind: AccountScopeKind::ProfileBasics,
                        public_key: Bytes(vec![4; 32]),
                        wrapped_private_key: Bytes(vec![5; 73]),
                    }],
                },
            ),
            again::<KeysSetup>,
        ),
        (
            "sample",
            encode(
                "sample",
                0,
                &Sample {
                    data: Bytes(vec![0, 1, 255]),
                    empty: Bytes(vec![]),
                    list: vec![Bytes(vec![7]), Bytes(vec![8; 300])],
                    absent: None,
                    negative: -5,
                    large: (1 << 53) - 1,
                    text: "привет 🙂".into(),
                },
            ),
            again::<Sample>,
        ),
    ]
}

#[test]
fn rust_fixtures_are_fresh() {
    let generated: BTreeMap<&str, String> = samples().iter().map(|(name, bytes, _)| (*name, hex(bytes))).collect();
    let json = serde_json::to_string_pretty(&generated).unwrap() + "\n";
    if std::env::var_os("CHAT_PROTOCOL_REGEN").is_some() {
        std::fs::write(path("rust.json"), &json).unwrap();
        return;
    }
    let stored = std::fs::read_to_string(path("rust.json")).unwrap_or_default();
    assert!(
        stored == json,
        "fixtures/rust.json is stale: run CHAT_PROTOCOL_REGEN=1 cargo test -p chat-protocol fixtures"
    );
}

#[test]
fn typescript_frames_decode_to_the_same_values() {
    let stored: BTreeMap<String, String> =
        serde_json::from_str(&std::fs::read_to_string(path("ts.json")).expect("fixtures/ts.json")).unwrap();
    for (name, expected, again) in samples() {
        let bytes = unhex(stored.get(name).unwrap_or_else(|| panic!("ts.json lacks {name}")));
        assert_eq!(again(&bytes), expected, "{name}: the TypeScript frame decodes to another value");
    }
}
