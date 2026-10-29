//! File contents: STREAM over XChaCha20-Poly1305 in 64 KiB chunks
//! (docs/crypto.md, "Files").
//!
//! ```text
//! object  = header || chunk_0 || … || chunk_n
//! header  = v=1 || file_id (16) || chunk_size (u32) || nonce_prefix (19)
//! chunk_i = XChaCha20-Poly1305(content_key, nonce_prefix || i || last, padded_i, aad = "vc/v1/file" || user_id || header)
//! ```

use aead_stream::{NewStream, StreamBE32, StreamPrimitive, aead::Payload};
use chacha20poly1305::{KeyInit, XChaCha20Poly1305};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use crate::{
    CryptoRng, Error,
    encoding::{Reader, Writer, version},
    ids::{FileId, UserId},
    kdf::label,
    padding,
};

const VERSION: u8 = 1;
/// Plaintext bytes of every chunk but the last.
pub const CHUNK: usize = 64 * 1024;
const PREFIX_LEN: usize = 19;
const TAG_LEN: usize = 16;
/// `v || file_id || chunk_size || nonce_prefix`.
pub const HEADER_LEN: usize = 1 + 16 + 4 + PREFIX_LEN;

/// A file's random content key, stored as a `file.key` record.
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct ContentKey([u8; 32]);

impl core::fmt::Debug for ContentKey {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("ContentKey(..)")
    }
}

impl ContentKey {
    pub fn generate(rng: &mut impl CryptoRng) -> Self {
        let mut key = [0; 32];
        rng.fill_bytes(&mut key);
        Self(key)
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, Error> {
        Ok(Self(bytes.try_into().map_err(|_| Error::Malformed)?))
    }

    /// The key's bytes: the plaintext of its `file.key` record, and what a
    /// client hands the server for a turn that reads the file (D-101).
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

/// The object length of a plaintext of `len` bytes.
pub fn encrypted_len(len: usize) -> Result<usize, Error> {
    let padded = padding::padded_len(len)?;
    Ok(HEADER_LEN + padded + padded.div_ceil(CHUNK) * TAG_LEN)
}

fn stream(key: &ContentKey, prefix: &[u8; PREFIX_LEN]) -> StreamBE32<XChaCha20Poly1305> {
    StreamBE32::from_aead(XChaCha20Poly1305::new(&key.0.into()), &(*prefix).into())
}

fn aad(user: UserId, header: &[u8]) -> Vec<u8> {
    Writer::with_label(label::FILE).bytes(user.as_bytes()).bytes(header).finish()
}

/// Encrypts a file's plaintext into its object.
pub fn encrypt(
    key: &ContentKey,
    user: UserId,
    file: FileId,
    plaintext: &[u8],
    rng: &mut impl CryptoRng,
) -> Result<Vec<u8>, Error> {
    let mut prefix = [0; PREFIX_LEN];
    rng.fill_bytes(&mut prefix);
    let chunk_size = u32::try_from(CHUNK).map_err(|_| Error::TooLarge)?;
    let header = Writer::new().u8(VERSION).bytes(file.as_bytes()).u32(chunk_size).bytes(&prefix).finish();
    let aad = aad(user, &header);
    let padded = padding::pad(plaintext)?;
    let stream = stream(key, &prefix);
    let mut out = Vec::with_capacity(encrypted_len(plaintext.len())?);
    out.extend_from_slice(&header);
    let count = padded.len().div_ceil(CHUNK);
    for (i, chunk) in padded.chunks(CHUNK).enumerate() {
        let position = u32::try_from(i).map_err(|_| Error::TooLarge)?;
        let ct =
            stream.encrypt(position, i + 1 == count, Payload { msg: chunk, aad: &aad }).map_err(|_| Error::TooLarge)?;
        out.extend_from_slice(&ct);
    }
    Ok(out)
}

/// The header's fields, checked: the version, the file id and the chunk size.
fn header(object: &[u8], file: FileId) -> Result<[u8; PREFIX_LEN], Error> {
    let mut r = Reader::new(object);
    version(&mut r, VERSION)?;
    let id: [u8; 16] = r.array()?;
    let chunk_size = r.u32()?;
    if FileId::from_bytes(id) != file || usize::try_from(chunk_size).ok() != Some(CHUNK) {
        return Err(Error::Malformed);
    }
    r.array()
}

/// Checks what an object's header and length tell without its key: the
/// server's check of an upload.
pub fn check(object: &[u8], file: FileId, len: usize) -> Result<(), Error> {
    header(object, file)?;
    if len < encrypted_len(0)? || chunks(len).is_none() {
        return Err(Error::Malformed);
    }
    Ok(())
}

/// The number of chunks of an object of `len` bytes, if a valid object has it.
fn chunks(len: usize) -> Option<usize> {
    let body = len.checked_sub(HEADER_LEN)?;
    let count = body.div_ceil(CHUNK + TAG_LEN);
    let last = body.checked_sub((count.checked_sub(1)?) * (CHUNK + TAG_LEN))?;
    (last > TAG_LEN).then_some(count)
}

/// Opens a file's object; every failure past the header is [`Error::Decrypt`].
pub fn decrypt(key: &ContentKey, user: UserId, file: FileId, object: &[u8]) -> Result<Zeroizing<Vec<u8>>, Error> {
    let prefix = header(object, file)?;
    let count = chunks(object.len()).ok_or(Error::Decrypt)?;
    let aad = aad(user, &object[..HEADER_LEN]);
    let stream = stream(key, &prefix);
    let mut padded = Zeroizing::new(Vec::with_capacity(object.len() - HEADER_LEN));
    for (i, chunk) in object[HEADER_LEN..].chunks(CHUNK + TAG_LEN).enumerate() {
        let position = u32::try_from(i).map_err(|_| Error::Decrypt)?;
        let pt = Zeroizing::new(
            stream.decrypt(position, i + 1 == count, Payload { msg: chunk, aad: &aad }).map_err(|_| Error::Decrypt)?,
        );
        padded.extend_from_slice(&pt);
    }
    Ok(Zeroizing::new(padding::unpad(&padded)?.to_vec()))
}

#[cfg(test)]
mod tests {
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    use rand_chacha::ChaCha20Rng;
    use rand_core::SeedableRng;

    use super::*;

    const USER: UserId = UserId::from_bytes([1; 16]);
    const FILE: FileId = FileId::from_bytes([2; 16]);

    fn rng() -> ChaCha20Rng {
        ChaCha20Rng::seed_from_u64(7)
    }

    #[test]
    fn round_trips_across_chunk_boundaries() {
        let key = ContentKey::generate(&mut rng());
        // Padded lengths land below, on and above chunk multiples.
        for len in [0, 1, 59, 60, 1000, CHUNK - 4, CHUNK, CHUNK + 1, 3 * CHUNK - 4, 3 * CHUNK + 17, 500_000] {
            let pt: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();
            let object = encrypt(&key, USER, FILE, &pt, &mut rng()).unwrap();
            assert_eq!(object.len(), encrypted_len(len).unwrap(), "{len}");
            check(&object, FILE, object.len()).unwrap();
            assert_eq!(decrypt(&key, USER, FILE, &object).unwrap().as_slice(), pt.as_slice(), "{len}");
        }
    }

    #[test]
    fn refuses_another_place_key_or_truncation() {
        let key = ContentKey::generate(&mut rng());
        let pt = vec![9u8; 3 * CHUNK];
        let object = encrypt(&key, USER, FILE, &pt, &mut rng()).unwrap();
        let other = ContentKey::from_bytes(&[3; 32]).unwrap();
        assert_eq!(decrypt(&other, USER, FILE, &object), Err(Error::Decrypt));
        assert_eq!(decrypt(&key, UserId::from_bytes([9; 16]), FILE, &object), Err(Error::Decrypt));
        assert_eq!(decrypt(&key, USER, FileId::from_bytes([9; 16]), &object), Err(Error::Malformed));
        // Dropping the last chunk leaves a stream whose new last chunk was not sealed as last.
        let cut = object.len() - (object.len() - HEADER_LEN) % (CHUNK + TAG_LEN);
        assert_eq!(decrypt(&key, USER, FILE, &object[..cut]), Err(Error::Decrypt));
        // Swapping the first two chunks breaks the counter.
        let mut swapped = object.clone();
        let (a, b) = (HEADER_LEN, HEADER_LEN + CHUNK + TAG_LEN);
        let first = object[a..b].to_vec();
        swapped[a..b].copy_from_slice(&object[b..b + CHUNK + TAG_LEN]);
        swapped[b..b + CHUNK + TAG_LEN].copy_from_slice(&first);
        assert_eq!(decrypt(&key, USER, FILE, &swapped), Err(Error::Decrypt));
        let mut v2 = object.clone();
        v2[0] = 2;
        assert_eq!(decrypt(&key, USER, FILE, &v2), Err(Error::UnsupportedVersion(2)));
    }

    #[test]
    fn every_flipped_bit_fails() {
        let key = ContentKey::generate(&mut rng());
        let object = encrypt(&key, USER, FILE, b"a short file", &mut rng()).unwrap();
        for i in 0..object.len() * 8 {
            let mut bad = object.clone();
            bad[i / 8] ^= 1 << (i % 8);
            assert!(decrypt(&key, USER, FILE, &bad).is_err(), "bit {i}");
        }
    }

    #[test]
    fn check_refuses_impossible_lengths() {
        let key = ContentKey::generate(&mut rng());
        let object = encrypt(&key, USER, FILE, &[1; 10], &mut rng()).unwrap();
        assert!(check(&object, FILE, object.len()).is_ok());
        assert!(check(&object, FILE, HEADER_LEN + TAG_LEN).is_err());
        assert!(check(&object, FILE, HEADER_LEN + CHUNK + TAG_LEN + TAG_LEN).is_err());
        assert!(check(&object[..10], FILE, object.len()).is_err());
    }
}
