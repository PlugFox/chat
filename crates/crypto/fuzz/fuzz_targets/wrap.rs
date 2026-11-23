//! ARK wrap decoding and opening: errors, never panics.
#![no_main]

use chat_crypto::{
    ark::Ark,
    ids::UserId,
    wrap::{ArkWrap, UnlockSecret},
};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let user = UserId::from_bytes([1; 16]);
    let commitment = Ark::generate(&mut chat_crypto::os_rng()).commitment(&user);
    if let Ok(wrap) = ArkWrap::decode(data) {
        let _ = wrap.encode();
        let _ = wrap.open(&user, &UnlockSecret::Prf(&[0; 32]), &commitment);
    }
});
