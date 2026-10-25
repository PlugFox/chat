//! Link message opening and request tags: errors, never panics.
#![no_main]

use chat_crypto::{
    ark::Ark,
    ids::{LinkSessionId, UserId},
    link::{self, LinkKeyPair, LinkSecret},
};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let mut rng = chat_crypto::os_rng();
    let user = UserId::from_bytes([1; 16]);
    let sid = LinkSessionId::from_bytes([2; 16]);
    let keys = LinkKeyPair::generate(&mut rng);
    let secret = LinkSecret::generate(&mut rng);
    let commitment = Ark::generate(&mut rng).commitment(&user);
    let _ = link::open_ark(data, &user, &sid, &keys, &secret, &commitment);
    let _ = link::verify_request_tag(&secret, &sid, &keys.public(), data);
});
