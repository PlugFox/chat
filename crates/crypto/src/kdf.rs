//! HKDF-SHA256 with the `vc/v1/…` labels from docs/crypto.md.

use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::Zeroizing;

pub(crate) mod label {
    pub(crate) const SCOPE_WRAP: &[u8] = b"vc/v1/scope-wrap";
    pub(crate) const COMMITMENT: &[u8] = b"vc/v1/commitment";
    pub(crate) const WRITER: &[u8] = b"vc/v1/writer";
    pub(crate) const KEK: &[u8] = b"vc/v1/kek/";
    pub(crate) const ARK_WRAP: &[u8] = b"vc/v1/ark-wrap";
    pub(crate) const SCOPE_KEY: &[u8] = b"vc/v1/scope-key";
    pub(crate) const RECORD: &[u8] = b"vc/v1/record";
    pub(crate) const RECORD_INFO: &[u8] = b"vc/v1/record/";
    pub(crate) const LINK: &[u8] = b"vc/v1/link";
    pub(crate) const LINK_REQUEST: &[u8] = b"vc/v1/link-request";
}

pub(crate) fn hkdf32(ikm: &[u8], salt: &[u8], info: &[u8]) -> Zeroizing<[u8; 32]> {
    let mut out = Zeroizing::new([0; 32]);
    // An empty salt is HKDF's default salt (RFC 5869 §2.2), as the spec writes `salt = ""`.
    let salt = if salt.is_empty() { None } else { Some(salt) };
    #[expect(clippy::expect_used, reason = "32 bytes is far below HKDF-SHA256's 8160-byte limit")]
    Hkdf::<Sha256>::new(salt, ikm).expand(info, out.as_mut()).expect("valid HKDF output length");
    out
}
