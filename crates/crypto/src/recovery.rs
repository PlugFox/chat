//! The recovery key: 128 random bits shown as 12 words of the BIP-39 English
//! list with its 4-bit checksum (docs/crypto.md, "ARK wraps"). Only the
//! encoding is BIP-39; the 16 bytes of entropy are the KEK input directly.

use sha2::{Digest, Sha256};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use crate::{CryptoRng, Error};

pub const ENTROPY_LEN: usize = 16;
pub const WORD_COUNT: usize = 12;
const WORDLIST: &str = include_str!("recovery/english.txt");

fn words() -> impl Iterator<Item = &'static str> {
    WORDLIST.lines()
}

/// A recovery key. Not `Debug` with content: the words are the secret.
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct RecoveryKey([u8; ENTROPY_LEN]);

impl std::fmt::Debug for RecoveryKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RecoveryKey(..)")
    }
}

impl RecoveryKey {
    pub fn generate(rng: &mut impl CryptoRng) -> Self {
        let mut entropy = [0; ENTROPY_LEN];
        rng.fill_bytes(&mut entropy);
        Self(entropy)
    }

    pub(crate) fn entropy(&self) -> &[u8; ENTROPY_LEN] {
        &self.0
    }

    /// 132 bits = entropy || first 4 bits of SHA-256(entropy), as 12 × 11-bit indexes.
    fn indexes(entropy: &[u8; ENTROPY_LEN]) -> [usize; WORD_COUNT] {
        let checksum = Sha256::digest(entropy)[0] >> 4;
        let bits = (u128::from_be_bytes(*entropy), u128::from(checksum));
        let mut out = [0; WORD_COUNT];
        for (i, slot) in out.iter_mut().enumerate() {
            // Bit offset of word i within the 132-bit string, counted from the most significant bit.
            let offset = i * 11;
            let mut index = 0usize;
            for bit in offset..offset + 11 {
                let value = if bit < 128 { (bits.0 >> (127 - bit)) & 1 } else { (bits.1 >> (131 - bit)) & 1 };
                index = (index << 1) | usize::from(value == 1);
            }
            *slot = index;
        }
        out
    }

    /// The 12 words, space-separated, lowercase.
    pub fn to_words(&self) -> Zeroizing<String> {
        let list: Vec<&str> = words().collect();
        let words: Vec<&str> = Self::indexes(&self.0).iter().map(|&i| list[i]).collect();
        Zeroizing::new(words.join(" "))
    }

    /// Parses 12 words: case-insensitive, any whitespace between words.
    pub fn from_words(input: &str) -> Result<Self, Error> {
        let list: Vec<&str> = words().collect();
        let given: Zeroizing<Vec<String>> = Zeroizing::new(input.split_whitespace().map(str::to_lowercase).collect());
        if given.len() != WORD_COUNT {
            return Err(Error::RecoveryLength);
        }
        let mut bits: u128 = 0;
        let mut checksum: u8 = 0;
        let mut position = 0usize;
        for (i, word) in given.iter().enumerate() {
            // The English list is sorted, so a binary search finds the index.
            let index = list.binary_search(&word.as_str()).map_err(|_| Error::RecoveryWord(i))?;
            for shift in (0..11).rev() {
                let bit = (index >> shift) & 1;
                if position < 128 {
                    bits = (bits << 1) | bit as u128;
                } else {
                    checksum = (checksum << 1) | bit as u8;
                }
                position += 1;
            }
        }
        let key = Self(bits.to_be_bytes());
        bits.zeroize();
        if Sha256::digest(key.0)[0] >> 4 != checksum {
            return Err(Error::RecoveryChecksum);
        }
        Ok(key)
    }

    /// Whether `word` is in the list (for input completion and early errors).
    pub fn is_word(word: &str) -> bool {
        words().any(|w| w == word)
    }
}

#[cfg(test)]
mod tests {
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    use super::*;

    #[test]
    fn word_list_is_the_bip39_english_list() {
        let list: Vec<&str> = words().collect();
        assert_eq!(list.len(), 2048);
        assert!(list.windows(2).all(|w| w[0] < w[1]), "sorted, no duplicates");
        assert_eq!(
            hex::encode(Sha256::digest(WORDLIST.as_bytes())),
            "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda"
        );
    }

    /// The 128-bit vectors from the BIP-39 reference (trezor/python-mnemonic vectors.json).
    #[test]
    fn bip39_reference_vectors() {
        let cases = [
            (
                "00000000000000000000000000000000",
                "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
            ),
            (
                "7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f",
                "legal winner thank year wave sausage worth useful legal winner thank yellow",
            ),
            (
                "80808080808080808080808080808080",
                "letter advice cage absurd amount doctor acoustic avoid letter advice cage above",
            ),
            ("ffffffffffffffffffffffffffffffff", "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong"),
        ];
        for (entropy, phrase) in cases {
            let entropy: [u8; 16] = hex::decode(entropy).unwrap().try_into().unwrap();
            assert_eq!(RecoveryKey(entropy).to_words().as_str(), phrase);
            assert_eq!(RecoveryKey::from_words(phrase).unwrap().0, entropy);
        }
    }

    #[test]
    fn parsing_is_lenient_about_case_and_spacing_only() {
        let phrase = "Legal  WINNER thank\tyear wave sausage worth useful legal winner thank yellow\n";
        assert!(RecoveryKey::from_words(phrase).is_ok());
        let wrong_checksum = "legal winner thank year wave sausage worth useful legal winner thank zoo";
        assert_eq!(RecoveryKey::from_words(wrong_checksum).unwrap_err(), Error::RecoveryChecksum);
        assert_eq!(RecoveryKey::from_words("legal winner").unwrap_err(), Error::RecoveryLength);
        let unknown = "legal winner thank year wave sausage worth useful legal winner thank notaword";
        assert_eq!(RecoveryKey::from_words(unknown).unwrap_err(), Error::RecoveryWord(11));
    }
}
