//! File objects: the header check and opening error on any input and never
//! panic, any input round-trips as a plaintext, and opening in pieces agrees
//! with opening whole.
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
    let whole = file::decrypt(&key, user, id, data);
    let split = usize::from(data.first().copied().unwrap_or(1)).max(1);
    let pieces = file::Decryptor::new(&key, user, id, data.len()).and_then(|mut d| {
        let mut out = Vec::new();
        for part in data.chunks(split) {
            out.extend_from_slice(&d.push(part)?);
        }
        d.finish().map(|()| out)
    });
    assert_eq!(whole.is_ok(), pieces.is_ok());
    if let (Ok(a), Ok(b)) = (&whole, &pieces) {
        assert_eq!(a.as_slice(), b.as_slice());
    }
    let object = file::encrypt(&key, user, id, data, &mut chat_crypto::os_rng()).unwrap_or_else(|_| unreachable!());
    assert_eq!(file::decrypt(&key, user, id, &object).as_deref().map(Vec::as_slice), Ok(data));
});
