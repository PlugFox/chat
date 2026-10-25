//! ARK wraps: one per unlock method (docs/crypto.md, "ARK wraps").
//!
//! ```text
//! wrap = v=1 || method || wrap_id (16) || method_params || nonce (24) || ciphertext (32 + 16)
//! aad  = "vc/v1/ark-wrap" || user_id || wrap_id || method
//! KEK  = HKDF(ikm = input, salt = wrap_id, info = "vc/v1/kek/" || method || user_id)
//! ```

use zeroize::Zeroizing;

use crate::{
    CryptoRng, Error,
    ark::{ARK_LEN, Ark, Commitment},
    encoding::{Reader, Writer, version},
    ids::{UserId, WrapId},
    kdf::{hkdf32, label},
    recovery::RecoveryKey,
    symmetric,
};

const VERSION: u8 = 1;
pub const PRF_OUTPUT_LEN: usize = 32;
pub const PRF_SALT_LEN: usize = 32;

/// How the KEK of a wrap is obtained.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum WrapMethod {
    /// WebAuthn PRF output for `prf_salt` from the passkey `credential_id`.
    Passkey { credential_id: Vec<u8>, prf_salt: [u8; PRF_SALT_LEN] },
    /// The recovery key.
    Recovery,
}

impl WrapMethod {
    fn code(&self) -> u8 {
        match self {
            Self::Passkey { .. } => 1,
            Self::Recovery => 2,
        }
    }
}

/// The secret that unlocks a wrap.
pub enum UnlockSecret<'a> {
    Prf(&'a [u8; PRF_OUTPUT_LEN]),
    Recovery(&'a RecoveryKey),
}

impl std::fmt::Debug for UnlockSecret<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Prf(_) => "UnlockSecret::Prf(..)",
            Self::Recovery(_) => "UnlockSecret::Recovery(..)",
        })
    }
}

impl UnlockSecret<'_> {
    fn input(&self) -> &[u8] {
        match self {
            Self::Prf(output) => output.as_slice(),
            Self::Recovery(key) => key.entropy(),
        }
    }

    fn matches(&self, method: &WrapMethod) -> bool {
        matches!((self, method), (Self::Prf(_), WrapMethod::Passkey { .. }) | (Self::Recovery(_), WrapMethod::Recovery))
    }
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ArkWrap {
    pub wrap_id: WrapId,
    pub method: WrapMethod,
    sealed: Vec<u8>,
}

fn kek(secret: &UnlockSecret<'_>, method: &WrapMethod, user: &UserId, wrap_id: &WrapId) -> Zeroizing<[u8; 32]> {
    let info = Writer::with_label(label::KEK).u8(method.code()).bytes(user.as_bytes()).finish();
    hkdf32(secret.input(), wrap_id.as_bytes(), &info)
}

fn aad(user: &UserId, wrap_id: &WrapId, method: &WrapMethod) -> Vec<u8> {
    Writer::with_label(label::ARK_WRAP).bytes(user.as_bytes()).bytes(wrap_id.as_bytes()).u8(method.code()).finish()
}

impl ArkWrap {
    pub fn seal(
        ark: &Ark,
        user: &UserId,
        wrap_id: WrapId,
        method: WrapMethod,
        secret: &UnlockSecret<'_>,
        rng: &mut impl CryptoRng,
    ) -> Result<Self, Error> {
        if !secret.matches(&method) {
            return Err(Error::Malformed);
        }
        let kek = kek(secret, &method, user, &wrap_id);
        let sealed = symmetric::seal(&kek, &aad(user, &wrap_id, &method), ark.as_bytes(), rng);
        Ok(Self { wrap_id, method, sealed })
    }

    /// Unwraps the ARK and checks it against the account commitment.
    pub fn open(&self, user: &UserId, secret: &UnlockSecret<'_>, commitment: &Commitment) -> Result<Ark, Error> {
        if !secret.matches(&self.method) {
            return Err(Error::Decrypt);
        }
        let kek = kek(secret, &self.method, user, &self.wrap_id);
        let ark = Ark::from_bytes(&symmetric::open(&kek, &aad(user, &self.wrap_id, &self.method), &self.sealed)?)?;
        ark.verify(user, commitment)?;
        Ok(ark)
    }

    pub fn encode(&self) -> Result<Vec<u8>, Error> {
        let mut w = Writer::new().u8(VERSION).u8(self.method.code()).bytes(self.wrap_id.as_bytes());
        if let WrapMethod::Passkey { credential_id, prf_salt } = &self.method {
            w = w.lp(credential_id)?.bytes(prf_salt);
        }
        Ok(w.bytes(&self.sealed).finish())
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, Error> {
        let mut r = Reader::new(bytes);
        version(&mut r, VERSION)?;
        let code = r.u8()?;
        let wrap_id = WrapId::from_bytes(r.array()?);
        let method = match code {
            1 => WrapMethod::Passkey { credential_id: r.lp()?.to_vec(), prf_salt: r.array()? },
            2 => WrapMethod::Recovery,
            _ => return Err(Error::Malformed),
        };
        let sealed = r.take(symmetric::NONCE_LEN + ARK_LEN + symmetric::TAG_LEN)?.to_vec();
        r.finish()?;
        Ok(Self { wrap_id, method, sealed })
    }
}
