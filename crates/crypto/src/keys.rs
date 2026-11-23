//! X25519 key types for the HPKE suite of docs/crypto.md.

use hpke::{Deserializable, Kem as _, Serializable};
use zeroize::Zeroizing;

use crate::{CryptoRng, Error};

pub(crate) type Kem = hpke::kem::X25519HkdfSha256;
pub(crate) type Aead = hpke::aead::ChaCha20Poly1305;
pub(crate) type Kdf = hpke::kdf::HkdfSha256;
pub(crate) type HpkePrivateKey = <Kem as hpke::Kem>::PrivateKey;
pub(crate) type HpkePublicKey = <Kem as hpke::Kem>::PublicKey;
pub(crate) type EncappedKey = <Kem as hpke::Kem>::EncappedKey;

pub(crate) const PUBLIC_KEY_LEN: usize = 32;
pub(crate) const ENC_LEN: usize = 32;
pub(crate) const PRIVATE_KEY_LEN: usize = 32;

/// An X25519 public key (scope, writer or link key).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct PublicKey([u8; PUBLIC_KEY_LEN]);

impl PublicKey {
    pub fn from_bytes(bytes: [u8; PUBLIC_KEY_LEN]) -> Self {
        Self(bytes)
    }

    pub fn from_slice(bytes: &[u8]) -> Result<Self, Error> {
        Ok(Self(bytes.try_into().map_err(|_| Error::Malformed)?))
    }

    pub fn as_bytes(&self) -> &[u8; PUBLIC_KEY_LEN] {
        &self.0
    }

    pub(crate) fn to_hpke(&self) -> Result<HpkePublicKey, Error> {
        HpkePublicKey::from_bytes(&self.0).map_err(|_| Error::Malformed)
    }

    fn from_hpke(pk: &HpkePublicKey) -> Self {
        let mut out = [0; PUBLIC_KEY_LEN];
        out.copy_from_slice(&pk.to_bytes());
        Self(out)
    }
}

/// An X25519 key pair. `Debug` shows the public key only.
pub(crate) struct KeyPair {
    pub(crate) sk: HpkePrivateKey,
    pub(crate) pk: HpkePublicKey,
}

impl std::fmt::Debug for KeyPair {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KeyPair").field("public", &self.public()).finish_non_exhaustive()
    }
}

impl KeyPair {
    pub(crate) fn generate(rng: &mut impl CryptoRng) -> Self {
        let (sk, pk) = Kem::gen_keypair_with_rng(rng);
        Self { sk, pk }
    }

    /// RFC 9180 §7.1.3 DeriveKeyPair.
    pub(crate) fn derive(ikm: &[u8]) -> Self {
        let (sk, pk) = Kem::derive_keypair(ikm);
        Self { sk, pk }
    }

    pub(crate) fn from_private_bytes(bytes: &[u8]) -> Result<Self, Error> {
        let sk = HpkePrivateKey::from_bytes(bytes).map_err(|_| Error::Malformed)?;
        let pk = Kem::sk_to_pk(&sk);
        Ok(Self { sk, pk })
    }

    pub(crate) fn private_bytes(&self) -> Zeroizing<Vec<u8>> {
        Zeroizing::new(self.sk.to_bytes().to_vec())
    }

    pub(crate) fn public(&self) -> PublicKey {
        PublicKey::from_hpke(&self.pk)
    }

    pub(crate) fn hpke_pair(&self) -> (HpkePrivateKey, HpkePublicKey) {
        (self.sk.clone(), self.pk.clone())
    }
}
