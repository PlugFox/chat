//! Device linking (docs/crypto.md, "Device linking"). The QR code carries a
//! secret `k` the server never sees; it authenticates the exchange in both
//! directions.
//!
//! ```text
//! link = v=1 || enc (32) || HPKE.Seal(mode = psk, pkR = pk_N, psk = k, psk_id = sid,
//!                                     info = "vc/v1/link", aad = "vc/v1/link" || user_id || sid, pt = ARK)
//! tag  = HMAC-SHA256(k, "vc/v1/link-request" || sid || pk_N)
//! ```

use hmac::{Hmac, KeyInit, Mac};
use hpke::{Deserializable, OpModeR, OpModeS, PskBundle, Serializable};
use sha2::Sha256;
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::{
    CryptoRng, Error, PublicKey,
    ark::{Ark, Commitment},
    encoding::{Reader, Writer, version},
    ids::{LinkSessionId, UserId},
    kdf::label,
    keys::{Aead, ENC_LEN, EncappedKey, Kdf, Kem, KeyPair},
};

const VERSION: u8 = 1;
pub const SECRET_LEN: usize = 32;
pub const TAG_LEN: usize = 32;

/// The one-time secret shown in the QR code. Not `Debug` with content.
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct LinkSecret([u8; SECRET_LEN]);

impl std::fmt::Debug for LinkSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("LinkSecret(..)")
    }
}

impl LinkSecret {
    pub fn generate(rng: &mut impl CryptoRng) -> Self {
        let mut k = [0; SECRET_LEN];
        rng.fill_bytes(&mut k);
        Self(k)
    }

    pub fn from_bytes(bytes: [u8; SECRET_LEN]) -> Self {
        Self(bytes)
    }

    /// For encoding into the QR code only.
    pub fn as_bytes(&self) -> &[u8; SECRET_LEN] {
        &self.0
    }
}

/// The new device's ephemeral key pair.
#[derive(Debug)]
pub struct LinkKeyPair(KeyPair);

impl LinkKeyPair {
    pub fn generate(rng: &mut impl CryptoRng) -> Self {
        Self(KeyPair::generate(rng))
    }

    pub fn public(&self) -> PublicKey {
        self.0.public()
    }

    #[cfg(test)]
    pub(crate) fn private_bytes(&self) -> zeroize::Zeroizing<Vec<u8>> {
        self.0.private_bytes()
    }

    #[cfg(test)]
    pub(crate) fn from_private_bytes(bytes: &[u8]) -> Result<Self, Error> {
        KeyPair::from_private_bytes(bytes).map(Self)
    }
}

fn aad(user: &UserId, sid: &LinkSessionId) -> Vec<u8> {
    Writer::with_label(label::LINK).bytes(user.as_bytes()).bytes(sid.as_bytes()).finish()
}

fn psk<'a>(secret: &'a LinkSecret, sid: &'a LinkSessionId) -> Result<PskBundle<'a>, Error> {
    PskBundle::new(&secret.0, sid.as_bytes()).map_err(|_| Error::Malformed)
}

/// On the unlocked device: seals the ARK to the new device's key.
pub fn seal_ark(
    ark: &Ark,
    user: &UserId,
    sid: &LinkSessionId,
    recipient: &PublicKey,
    secret: &LinkSecret,
    rng: &mut impl CryptoRng,
) -> Result<Vec<u8>, Error> {
    let (enc, ct) = hpke::single_shot_seal_with_rng::<Aead, Kdf, Kem>(
        &OpModeS::Psk(psk(secret, sid)?),
        &recipient.to_hpke()?,
        label::LINK,
        ark.as_bytes(),
        &aad(user, sid),
        rng,
    )
    .map_err(|_| Error::Malformed)?;
    Ok(Writer::new().u8(VERSION).bytes(&enc.to_bytes()).bytes(&ct).finish())
}

/// On the new device: opens the link message and checks the ARK against the commitment.
pub fn open_ark(
    message: &[u8],
    user: &UserId,
    sid: &LinkSessionId,
    keys: &LinkKeyPair,
    secret: &LinkSecret,
    commitment: &Commitment,
) -> Result<Ark, Error> {
    let mut r = Reader::new(message);
    version(&mut r, VERSION)?;
    let enc = EncappedKey::from_bytes(r.take(ENC_LEN)?).map_err(|_| Error::Malformed)?;
    let ct = r.rest(1)?;
    let pt = zeroize::Zeroizing::new(
        hpke::single_shot_open::<Aead, Kdf, Kem>(
            &OpModeR::Psk(psk(secret, sid)?),
            &keys.0.sk,
            &enc,
            label::LINK,
            ct,
            &aad(user, sid),
        )
        .map_err(|_| Error::Decrypt)?,
    );
    let ark = Ark::from_bytes(&pt).map_err(|_| Error::Decrypt)?;
    ark.verify(user, commitment)?;
    Ok(ark)
}

fn mac(secret: &LinkSecret, sid: &LinkSessionId, pk: &PublicKey) -> Hmac<Sha256> {
    #[expect(clippy::expect_used, reason = "HMAC accepts keys of any length")]
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(&secret.0).expect("HMAC key");
    mac.update(label::LINK_REQUEST);
    mac.update(sid.as_bytes());
    mac.update(pk.as_bytes());
    mac
}

/// Direction B: the new device proves it saw the QR code.
pub fn request_tag(secret: &LinkSecret, sid: &LinkSessionId, pk: &PublicKey) -> [u8; TAG_LEN] {
    mac(secret, sid, pk).finalize().into_bytes().into()
}

/// Direction B: the unlocked device checks the new device's key (constant time).
pub fn verify_request_tag(secret: &LinkSecret, sid: &LinkSessionId, pk: &PublicKey, tag: &[u8]) -> Result<(), Error> {
    mac(secret, sid, pk).verify_slice(tag).map_err(|_| Error::Decrypt)
}
