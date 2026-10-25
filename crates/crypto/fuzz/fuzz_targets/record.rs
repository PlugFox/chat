//! Record header decoding and opening, plus wrapped scope keys: errors, never panics.
#![no_main]

use chat_crypto::{
    ark::Ark,
    ids::{ScopeId, UserId},
    record::{self, Kind, Place},
    scope::ScopeKeyPair,
};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let mut rng = chat_crypto::os_rng();
    let user = UserId::from_bytes([1; 16]);
    let scope = ScopeId::from_bytes([2; 16]);
    let ark = Ark::generate(&mut rng);
    let keys = ScopeKeyPair::generate(1, &mut rng);
    let place = Place { user, scope, kind: Kind::ChatTitle };
    let _ = record::key_version(data);
    let _ = record::open(&place, &keys, &ark.writer_key(&user).public(), data);
    let _ = ScopeKeyPair::unwrap(&ark, &user, &scope, 1, data);
});
