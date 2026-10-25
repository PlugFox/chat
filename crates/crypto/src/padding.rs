//! Padmé padding (Nikitin et al., PETS 2019) of record plaintexts
//! (docs/crypto.md, "Padding"): `len (u32 BE) || plaintext || zeros`.

use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

use crate::Error;

const MIN: u64 = 64;
const HEADER: usize = 4;

/// Padmé length for `l`: keeps the top `floor(log2 E) + 1` bits of the
/// exponent's mantissa, rounding up.
fn padme(l: u64) -> u64 {
    let l = l.max(MIN);
    let e = 63 - u64::from(l.leading_zeros()); // floor(log2 l), >= 6
    let s = 64 - u64::from(e.leading_zeros()); // floor(log2 e) + 1
    let mask = (1u64 << (e - s)) - 1;
    (l + mask) & !mask
}

fn padded_len(plaintext_len: usize) -> Result<usize, Error> {
    let len = u64::try_from(plaintext_len).map_err(|_| Error::TooLarge)? + HEADER as u64;
    usize::try_from(padme(len)).map_err(|_| Error::TooLarge)
}

pub(crate) fn pad(plaintext: &[u8]) -> Result<Zeroizing<Vec<u8>>, Error> {
    let len = u32::try_from(plaintext.len()).map_err(|_| Error::TooLarge)?;
    let mut out = Zeroizing::new(Vec::with_capacity(padded_len(plaintext.len())?));
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(plaintext);
    out.resize(padded_len(plaintext.len())?, 0);
    Ok(out)
}

/// The plaintext inside a padded buffer; one valid encoding per plaintext.
pub(crate) fn unpad(padded: &[u8]) -> Result<&[u8], Error> {
    let header: [u8; HEADER] = padded.get(..HEADER).and_then(|h| h.try_into().ok()).ok_or(Error::Decrypt)?;
    let len = usize::try_from(u32::from_be_bytes(header)).map_err(|_| Error::Decrypt)?;
    if padded.len() != padded_len(len).map_err(|_| Error::Decrypt)? {
        return Err(Error::Decrypt);
    }
    let (body, zeros) = padded[HEADER..].split_at(len);
    let nonzero = zeros.iter().fold(0u8, |acc, b| acc | b);
    if bool::from(nonzero.ct_eq(&0)) { Ok(body) } else { Err(Error::Decrypt) }
}

#[cfg(test)]
mod tests {
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    use super::*;

    #[test]
    fn padme_matches_the_paper() {
        // Table values: Padmé keeps overhead under 12% and leaves small sizes alone.
        assert_eq!(padme(1), 64);
        assert_eq!(padme(64), 64);
        assert_eq!(padme(65), 72);
        assert_eq!(padme(100), 104);
        assert_eq!(padme(1000), 1024);
        assert_eq!(padme(1025), 1088);
        for l in 64..100_000u64 {
            let p = padme(l);
            assert!(p >= l && (p - l) * 100 <= l * 12, "{l} -> {p}");
        }
    }

    #[test]
    fn round_trip_and_strictness() {
        for n in [0, 1, 59, 60, 61, 500, 4096] {
            let pt = vec![7u8; n];
            let padded = pad(&pt).unwrap();
            assert_eq!(unpad(&padded).unwrap(), pt.as_slice());
            let mut extra = padded.to_vec();
            extra.push(0);
            assert_eq!(unpad(&extra), Err(Error::Decrypt));
            let mut dirty = padded.to_vec();
            if let Some(last) = dirty.last_mut().filter(|_| padded.len() > n + HEADER) {
                *last = 1;
                assert_eq!(unpad(&dirty), Err(Error::Decrypt));
            }
        }
    }
}
