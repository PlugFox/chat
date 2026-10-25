//! XChaCha20-Poly1305 key wrapping: `nonce (24) || ciphertext`.

use chacha20poly1305::{
    KeyInit, XChaCha20Poly1305, XNonce,
    aead::{Aead, Payload},
};
use zeroize::Zeroizing;

use crate::{CryptoRng, Error};

pub(crate) const NONCE_LEN: usize = 24;
pub(crate) const TAG_LEN: usize = 16;

pub(crate) fn seal(key: &[u8; 32], aad: &[u8], plaintext: &[u8], rng: &mut impl CryptoRng) -> Vec<u8> {
    let mut nonce = [0; NONCE_LEN];
    rng.fill_bytes(&mut nonce);
    let cipher = XChaCha20Poly1305::new(&(*key).into());
    #[expect(clippy::expect_used, reason = "encryption fails only for inputs beyond 256 GiB")]
    let ct = cipher.encrypt(&XNonce::from(nonce), Payload { msg: plaintext, aad }).expect("XChaCha20-Poly1305 seal");
    let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    out
}

pub(crate) fn open(key: &[u8; 32], aad: &[u8], data: &[u8]) -> Result<Zeroizing<Vec<u8>>, Error> {
    if data.len() < NONCE_LEN + TAG_LEN {
        return Err(Error::Malformed);
    }
    let (nonce, ct) = data.split_at(NONCE_LEN);
    let nonce: [u8; NONCE_LEN] = nonce.try_into().map_err(|_| Error::Malformed)?;
    let cipher = XChaCha20Poly1305::new(&(*key).into());
    cipher.decrypt(&XNonce::from(nonce), Payload { msg: ct, aad }).map(Zeroizing::new).map_err(|_| Error::Decrypt)
}
