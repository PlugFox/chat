//! Binary values in payloads (docs/protocol.md, "Encoding rules").

use std::fmt;

/// Ciphertext, keys, wraps: MessagePack `bin` on the wire, `Uint8Array` in
/// TypeScript. A plain `Vec<u8>` would encode as an array of numbers.
#[derive(Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct Bytes(#[serde(with = "serde_bytes")] pub Vec<u8>);

/// Only the length: the bytes may be key material or ciphertext.
impl fmt::Debug for Bytes {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Bytes({})", self.0.len())
    }
}

impl ts_rs::TS for Bytes {
    type WithoutGenerics = Self;
    type OptionInnerType = Self;

    fn name(_: &ts_rs::Config) -> String {
        "Uint8Array".to_owned()
    }

    fn inline(_: &ts_rs::Config) -> String {
        "Uint8Array".to_owned()
    }
}
