//! The Account Root Key and the keys derived from it (docs/crypto.md,
//! "Account Root Key").

use subtle::ConstantTimeEq;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use crate::{
    CryptoRng, Error, PublicKey,
    encoding::Writer,
    ids::UserId,
    kdf::{hkdf32, label},
    keys::KeyPair,
};

pub const ARK_LEN: usize = 32;

/// The Account Root Key. Lives only in the client worker; never serialized
/// except inside a wrap or a link message.
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct Ark([u8; ARK_LEN]);

impl std::fmt::Debug for Ark {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Ark(..)")
    }
}

impl Ark {
    pub fn generate(rng: &mut impl CryptoRng) -> Self {
        let mut key = [0; ARK_LEN];
        rng.fill_bytes(&mut key);
        Self(key)
    }

    pub(crate) fn from_bytes(bytes: &[u8]) -> Result<Self, Error> {
        Ok(Self(bytes.try_into().map_err(|_| Error::Malformed)?))
    }

    pub(crate) fn as_bytes(&self) -> &[u8; ARK_LEN] {
        &self.0
    }

    fn derive(&self, label: &[u8], user: &UserId) -> Zeroizing<[u8; 32]> {
        hkdf32(&self.0, &[], &Writer::with_label(label).bytes(user.as_bytes()).finish())
    }

    /// Public value stored on the server; lets a client recognise the right ARK.
    pub fn commitment(&self, user: &UserId) -> Commitment {
        Commitment(*self.derive(label::COMMITMENT, user))
    }

    /// Fails with [`Error::Commitment`] unless this ARK belongs to `commitment`.
    pub fn verify(&self, user: &UserId, commitment: &Commitment) -> Result<(), Error> {
        if bool::from(self.commitment(user).0.ct_eq(&commitment.0)) { Ok(()) } else { Err(Error::Commitment) }
    }

    pub(crate) fn scope_wrap_key(&self, user: &UserId) -> Zeroizing<[u8; 32]> {
        self.derive(label::SCOPE_WRAP, user)
    }

    /// The writer key pair that authenticates client-written records.
    pub fn writer_key(&self, user: &UserId) -> WriterKey {
        WriterKey(KeyPair::derive(self.derive(label::WRITER, user).as_ref()))
    }
}

/// `HKDF(ARK, "vc/v1/commitment" || user_id)`: public, one-way.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Commitment(pub [u8; 32]);

/// The user's writer key pair (HPKE auth-mode sender key).
#[derive(Debug)]
pub struct WriterKey(pub(crate) KeyPair);

impl WriterKey {
    pub fn public(&self) -> PublicKey {
        self.0.public()
    }
}
