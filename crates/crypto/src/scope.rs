//! Scope key pairs and their wrapped private keys (docs/crypto.md, "Scope keys").
//!
//! ```text
//! wrapped = v=1 || nonce (24) || XChaCha20-Poly1305(k_scope_wrap, nonce, sk, aad)
//! aad     = "vc/v1/scope-key" || user_id || scope_id || key_version
//! ```

use crate::{
    CryptoRng, Error, PublicKey,
    ark::Ark,
    encoding::{Reader, Writer, version},
    ids::{ScopeId, UserId},
    kdf::label,
    keys::{KeyPair, PRIVATE_KEY_LEN},
    symmetric,
};

const VERSION: u8 = 1;

/// A scope public key with its version: what writers seal to.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ScopePublicKey {
    pub key_version: u32,
    pub key: PublicKey,
}

/// A scope key pair of one version.
#[derive(Debug)]
pub struct ScopeKeyPair {
    pub(crate) key_version: u32,
    pub(crate) pair: KeyPair,
}

fn aad(user: &UserId, scope: &ScopeId, key_version: u32) -> Vec<u8> {
    Writer::with_label(label::SCOPE_KEY).bytes(user.as_bytes()).bytes(scope.as_bytes()).u32(key_version).finish()
}

impl ScopeKeyPair {
    pub fn generate(key_version: u32, rng: &mut impl CryptoRng) -> Self {
        Self { key_version, pair: KeyPair::generate(rng) }
    }

    pub fn public(&self) -> ScopePublicKey {
        ScopePublicKey { key_version: self.key_version, key: self.pair.public() }
    }

    pub fn key_version(&self) -> u32 {
        self.key_version
    }

    /// The private key wrapped under the ARK, for storage on the server.
    pub fn wrap(&self, ark: &Ark, user: &UserId, scope: &ScopeId, rng: &mut impl CryptoRng) -> Vec<u8> {
        let sealed = symmetric::seal(
            &ark.scope_wrap_key(user),
            &aad(user, scope, self.key_version),
            &self.pair.private_bytes(),
            rng,
        );
        Writer::new().u8(VERSION).bytes(&sealed).finish()
    }

    pub fn unwrap(ark: &Ark, user: &UserId, scope: &ScopeId, key_version: u32, wrapped: &[u8]) -> Result<Self, Error> {
        let mut r = Reader::new(wrapped);
        version(&mut r, VERSION)?;
        let sealed = r.take(symmetric::NONCE_LEN + PRIVATE_KEY_LEN + symmetric::TAG_LEN)?;
        r.finish()?;
        let sk = symmetric::open(&ark.scope_wrap_key(user), &aad(user, scope, key_version), sealed)?;
        Ok(Self { key_version, pair: KeyPair::from_private_bytes(&sk)? })
    }
}
