//! File objects: the header check and opening error on any input and never
//! panic, and any input round-trips as a plaintext.
#![no_main]

use chat_crypto::{
    file::{self, ContentKey},
    ids::{FileId, UserId},
};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let user = UserId::from_bytes([1; 16]);
    let id = FileId::from_bytes(data.get(1..17).and_then(|b| b.try_into().ok()).unwrap_or([0; 16]));
    let key = ContentKey::from_bytes(&[7; 32]).unwrap_or_else(|_| unreachable!());
    let _ = file::check(data, id, data.len());
    let _ = file::decrypt(&key, user, id, data);
    let object = file::encrypt(&key, user, id, data, &mut chat_crypto::os_rng()).unwrap_or_else(|_| unreachable!());
    assert_eq!(file::decrypt(&key, user, id, &object).as_deref().map(Vec::as_slice), Ok(data));
});
