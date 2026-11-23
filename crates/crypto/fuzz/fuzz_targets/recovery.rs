//! Recovery key parsing of arbitrary text: errors, never panics.
#![no_main]

use chat_crypto::recovery::RecoveryKey;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    if let Ok(text) = std::str::from_utf8(data) {
        if let Ok(key) = RecoveryKey::from_words(text) {
            assert!(RecoveryKey::from_words(&key.to_words()).is_ok());
        }
    }
});
