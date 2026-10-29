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
use subtle::ConstantTimeEq;
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

impl core::fmt::Debug for Encryptor {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("Encryptor(..)")
    }
}

impl core::fmt::Debug for Decryptor {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("Decryptor(..)")
    }
}

/// Encrypts a file of a known length piece by piece, so no copy of it is
/// held whole: the header, then what `push` and `finish` return, is the
/// object `encrypt` makes.
pub struct Encryptor {
    stream: StreamBE32<XChaCha20Poly1305>,
    aad: Vec<u8>,
    len: usize,
    seen: usize,
    padded: usize,
    count: usize,
    position: usize,
    /// Padded plaintext not sealed yet: under a chunk after every `push`.
    pending: Zeroizing<Vec<u8>>,
}

impl Encryptor {
    /// Starts the object of a plaintext of `len` bytes; returns its header.
    pub fn new(
        key: &ContentKey,
        user: UserId,
        file: FileId,
        len: usize,
        rng: &mut impl CryptoRng,
    ) -> Result<(Self, Vec<u8>), Error> {
        let declared = u32::try_from(len).map_err(|_| Error::TooLarge)?;
        let padded = padding::padded_len(len)?;
        let mut prefix = [0; PREFIX_LEN];
        rng.fill_bytes(&mut prefix);
        let chunk_size = u32::try_from(CHUNK).map_err(|_| Error::TooLarge)?;
        let header = Writer::new().u8(VERSION).bytes(file.as_bytes()).u32(chunk_size).bytes(&prefix).finish();
        let mut pending = Zeroizing::new(Vec::with_capacity(CHUNK));
        // The padding's length prefix (docs/crypto.md, "Padding").
        pending.extend_from_slice(&declared.to_be_bytes());
        let encryptor = Self {
            stream: stream(key, &prefix),
            aad: aad(user, &header),
            len,
            seen: 0,
            padded,
            count: padded.div_ceil(CHUNK),
            position: 0,
            pending,
        };
        Ok((encryptor, header))
    }

    fn seal(&mut self, chunk: &[u8]) -> Result<Vec<u8>, Error> {
        let position = u32::try_from(self.position).map_err(|_| Error::TooLarge)?;
        let last = self.position + 1 == self.count;
        self.position += 1;
        self.stream.encrypt(position, last, Payload { msg: chunk, aad: &self.aad }).map_err(|_| Error::TooLarge)
    }

    /// Takes the next plaintext; returns the chunks it completed.
    pub fn push(&mut self, mut plaintext: &[u8]) -> Result<Vec<u8>, Error> {
        self.seen = self.seen.checked_add(plaintext.len()).filter(|&n| n <= self.len).ok_or(Error::Malformed)?;
        let mut out = Vec::new();
        // The last chunk waits for `finish`, which pads it.
        while self.position + 1 < self.count {
            if self.pending.is_empty() && plaintext.len() >= CHUNK {
                let (chunk, rest) = plaintext.split_at(CHUNK);
                out.extend_from_slice(&self.seal(chunk)?);
                plaintext = rest;
                continue;
            }
            let take = (CHUNK - self.pending.len()).min(plaintext.len());
            self.pending.extend_from_slice(&plaintext[..take]);
            plaintext = &plaintext[take..];
            if self.pending.len() < CHUNK {
                break;
            }
            let chunk = core::mem::replace(&mut self.pending, Zeroizing::new(Vec::with_capacity(CHUNK)));
            out.extend_from_slice(&self.seal(&chunk)?);
        }
        self.pending.extend_from_slice(plaintext);
        Ok(out)
    }

    /// Pads and seals what is left; the plaintext must have been `len` bytes.
    pub fn finish(mut self) -> Result<Vec<u8>, Error> {
        if self.seen != self.len {
            return Err(Error::Malformed);
        }
        let mut rest = core::mem::take(&mut self.pending);
        rest.resize(self.padded - self.position * CHUNK, 0);
        let mut out = Vec::with_capacity(rest.len() + rest.len().div_ceil(CHUNK) * TAG_LEN);
        for chunk in rest.chunks(CHUNK) {
            out.extend_from_slice(&self.seal(chunk)?);
        }
        Ok(out)
    }
}

/// Encrypts a file's plaintext into its object.
pub fn encrypt(
    key: &ContentKey,
    user: UserId,
    file: FileId,
    plaintext: &[u8],
    rng: &mut impl CryptoRng,
) -> Result<Vec<u8>, Error> {
    let (mut encryptor, mut out) = Encryptor::new(key, user, file, plaintext.len(), rng)?;
    out.reserve(encrypted_len(plaintext.len())? - out.len());
    out.extend_from_slice(&encryptor.push(plaintext)?);
    out.extend_from_slice(&encryptor.finish()?);
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

/// Opens an object of a known length piece by piece. Every chunk is
/// authenticated before its plaintext comes out, but a cut-off object or bad
/// padding shows only at `finish`: nothing it returned may be used before.
pub struct Decryptor {
    key: Zeroizing<[u8; 32]>,
    user: UserId,
    file: FileId,
    len: usize,
    count: usize,
    /// The stream once the header is read.
    open: Option<(StreamBE32<XChaCha20Poly1305>, Vec<u8>)>,
    position: usize,
    /// Bytes of the object not opened yet: under a chunk after every `push`.
    pending: Vec<u8>,
    /// Padded plaintext bytes opened so far, and the plaintext length they declare.
    at: usize,
    plain: Option<usize>,
    /// Every padding byte, or-ed: zero in a valid object.
    padding: u8,
}

impl Decryptor {
    /// Starts opening an object of `len` bytes; the length tells the chunks.
    pub fn new(key: &ContentKey, user: UserId, file: FileId, len: usize) -> Result<Self, Error> {
        let count = chunks(len).ok_or(Error::Decrypt)?;
        Ok(Self {
            key: Zeroizing::new(key.0),
            user,
            file,
            len,
            count,
            open: None,
            position: 0,
            pending: Vec::new(),
            at: 0,
            plain: None,
            padding: 0,
        })
    }

    /// The ciphertext length of the next chunk.
    fn next_len(&self) -> usize {
        if self.position + 1 == self.count {
            self.len - HEADER_LEN - self.position * (CHUNK + TAG_LEN)
        } else {
            CHUNK + TAG_LEN
        }
    }

    /// Takes the next bytes of the object; returns the plaintext they completed.
    pub fn push(&mut self, mut bytes: &[u8]) -> Result<Zeroizing<Vec<u8>>, Error> {
        let mut out = Zeroizing::new(Vec::new());
        if self.open.is_none() {
            let take = (HEADER_LEN - self.pending.len()).min(bytes.len());
            self.pending.extend_from_slice(&bytes[..take]);
            bytes = &bytes[take..];
            if self.pending.len() < HEADER_LEN {
                return Ok(out);
            }
            let prefix = header(&self.pending, self.file)?;
            let key = ContentKey(*self.key);
            self.open = Some((stream(&key, &prefix), aad(self.user, &self.pending)));
            self.pending.clear();
        }
        // A chunk an earlier push began, then whole chunks straight from the input.
        if !self.pending.is_empty() {
            let take = (self.next_len() - self.pending.len()).min(bytes.len());
            self.pending.extend_from_slice(&bytes[..take]);
            bytes = &bytes[take..];
            if self.pending.len() < self.next_len() {
                return Ok(out);
            }
            let chunk = core::mem::take(&mut self.pending);
            self.open_chunk(&chunk, &mut out)?;
        }
        while self.position < self.count && bytes.len() >= self.next_len() {
            let (chunk, rest) = bytes.split_at(self.next_len());
            self.open_chunk(chunk, &mut out)?;
            bytes = rest;
        }
        if !bytes.is_empty() {
            if self.position == self.count {
                return Err(Error::Decrypt);
            }
            self.pending.extend_from_slice(bytes);
        }
        Ok(out)
    }

    fn open_chunk(&mut self, chunk: &[u8], out: &mut Vec<u8>) -> Result<(), Error> {
        let position = u32::try_from(self.position).map_err(|_| Error::Decrypt)?;
        let last = self.position + 1 == self.count;
        let Some((stream, aad)) = &self.open else { return Err(Error::Decrypt) };
        let padded =
            Zeroizing::new(stream.decrypt(position, last, Payload { msg: chunk, aad }).map_err(|_| Error::Decrypt)?);
        self.position += 1;
        self.unpad(&padded, out)
    }

    /// Moves the plaintext of opened padded bytes to `out`, checking the padding.
    fn unpad(&mut self, padded: &[u8], out: &mut Vec<u8>) -> Result<(), Error> {
        let mut rest = padded;
        if self.plain.is_none() {
            // The first chunk holds the length prefix: padding leaves at least 64 bytes.
            let (prefix, body) = rest.split_first_chunk::<4>().ok_or(Error::Decrypt)?;
            let len = usize::try_from(u32::from_be_bytes(*prefix)).map_err(|_| Error::Decrypt)?;
            let padded_total = self.len - HEADER_LEN - self.count * TAG_LEN;
            if padding::padded_len(len).map_err(|_| Error::Decrypt)? != padded_total {
                return Err(Error::Decrypt);
            }
            self.plain = Some(len);
            self.at = 4;
            rest = body;
        }
        let end = self.plain.unwrap_or(0) + 4;
        let body = rest.len().min(end.saturating_sub(self.at));
        out.extend_from_slice(&rest[..body]);
        self.padding |= rest[body..].iter().fold(0, |acc, b| acc | b);
        self.at += rest.len();
        Ok(())
    }

    /// Whether the whole object came, ending as sealed, with valid padding.
    pub fn finish(self) -> Result<(), Error> {
        let whole = self.position == self.count && self.pending.is_empty();
        if whole && bool::from(self.padding.ct_eq(&0)) { Ok(()) } else { Err(Error::Decrypt) }
    }
}

/// Opens a file's object; every failure past the header is [`Error::Decrypt`].
pub fn decrypt(key: &ContentKey, user: UserId, file: FileId, object: &[u8]) -> Result<Zeroizing<Vec<u8>>, Error> {
    // A bad header says so before the length does.
    header(object, file)?;
    let mut decryptor = Decryptor::new(key, user, file, object.len())?;
    let plaintext = decryptor.push(object)?;
    decryptor.finish()?;
    Ok(plaintext)
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

    #[test]
    fn pieces_of_any_size_make_and_open_the_same_object() {
        let key = ContentKey::generate(&mut rng());
        for len in [0, 5, CHUNK - 4, CHUNK, 2 * CHUNK + 3, 300_000] {
            let pt: Vec<u8> = (0..len).map(|i| (i % 253) as u8).collect();
            let whole = encrypt(&key, USER, FILE, &pt, &mut rng()).unwrap();
            for piece in [1, 7, 4096, CHUNK - 1, CHUNK + 5, 1 << 20] {
                let (mut encryptor, mut object) = Encryptor::new(&key, USER, FILE, len, &mut rng()).unwrap();
                for part in pt.chunks(piece) {
                    object.extend_from_slice(&encryptor.push(part).unwrap());
                }
                object.extend_from_slice(&encryptor.finish().unwrap());
                assert_eq!(object, whole, "{len} in pieces of {piece}");

                let mut decryptor = Decryptor::new(&key, USER, FILE, object.len()).unwrap();
                let mut opened = Vec::new();
                for part in object.chunks(piece) {
                    opened.extend_from_slice(&decryptor.push(part).unwrap());
                }
                decryptor.finish().unwrap();
                assert_eq!(opened, pt, "{len} opened in pieces of {piece}");
            }
        }
    }

    #[test]
    fn a_stream_keeps_to_its_length() {
        let key = ContentKey::generate(&mut rng());
        let (mut short, _) = Encryptor::new(&key, USER, FILE, 10, &mut rng()).unwrap();
        short.push(&[1; 9]).unwrap();
        assert_eq!(short.finish(), Err(Error::Malformed));
        let (mut long, _) = Encryptor::new(&key, USER, FILE, 10, &mut rng()).unwrap();
        assert_eq!(long.push(&[1; 11]), Err(Error::Malformed));

        let object = encrypt(&key, USER, FILE, &vec![3; 2 * CHUNK], &mut rng()).unwrap();
        // An object cut short opens its first chunks but never finishes.
        let mut cut = Decryptor::new(&key, USER, FILE, object.len()).unwrap();
        assert!(!cut.push(&object[..object.len() - 1]).unwrap().is_empty());
        assert_eq!(cut.finish(), Err(Error::Decrypt));
        // Bytes past the object's length are refused.
        let mut longer = Decryptor::new(&key, USER, FILE, object.len()).unwrap();
        longer.push(&object).unwrap();
        assert_eq!(longer.push(&[0]).map(|_| ()), Err(Error::Decrypt));
    }
}
