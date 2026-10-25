//! Server keys, access tokens (JWT, Ed25519) and refresh tokens
//! (docs/auth.md, "Tokens").

use std::{fmt, time::Duration};

use aws_lc_rs::signature::{Ed25519KeyPair, KeyPair};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hkdf::Hkdf;
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use uuid::Uuid;
use zeroize::Zeroizing;

use super::{AuthError, Principal, Provider};

pub const ACCESS_TTL: Duration = Duration::from_secs(60 * 60);
/// Accepted clock skew on `exp` and `iat`.
pub const LEEWAY: Duration = Duration::from_secs(30);

const LABEL_JWT: &[u8] = b"chat/server/v1/jwt-ed25519";
const LABEL_EMAIL_CODE: &[u8] = b"chat/server/v1/email-code";

fn hkdf32(secret: &[u8], label: &[u8]) -> Zeroizing<[u8; 32]> {
    let mut out = Zeroizing::new([0; 32]);
    #[expect(clippy::expect_used, reason = "32 bytes is far below HKDF-SHA256's 8160-byte limit")]
    Hkdf::<Sha256>::new(None, secret).expand(label, out.as_mut()).expect("valid HKDF output length");
    out
}

pub(crate) fn random<const N: usize>() -> [u8; N] {
    let mut out = [0; N];
    #[expect(clippy::expect_used, reason = "the OS RNG failing leaves nothing safe to do")]
    getrandom::fill(&mut out).expect("OS random number generator");
    out
}

/// Every key the server derives from `CHAT_SERVER_SECRET`.
pub struct ServerKeys {
    pub jwt: Jwt,
    pub email_code: Zeroizing<[u8; 32]>,
}

impl fmt::Debug for ServerKeys {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ServerKeys").field("jwt", &self.jwt).finish_non_exhaustive()
    }
}

impl ServerKeys {
    pub fn derive(secret: &[u8]) -> Self {
        Self { jwt: Jwt::from_seed(&hkdf32(secret, LABEL_JWT)), email_code: hkdf32(secret, LABEL_EMAIL_CODE) }
    }

    /// A fresh secret: fine for one instance, which costs each client one
    /// silent refresh per restart (docs/auth.md).
    pub fn generate() -> Self {
        Self::derive(Zeroizing::new(random::<32>()).as_slice())
    }
}

#[derive(Serialize, Deserialize)]
struct Claims {
    sub: Uuid,
    sid: Uuid,
    iid: Uuid,
    prv: Provider,
    iat: i64,
    exp: i64,
}

/// What an access token is issued for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Grant {
    pub user_id: Uuid,
    pub session_id: Uuid,
    pub identity_id: Uuid,
    pub provider: Provider,
}

#[derive(Clone)]
pub struct AccessToken {
    pub token: String,
    pub expires_at: OffsetDateTime,
}

impl fmt::Debug for AccessToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AccessToken").field("token", &"<redacted>").field("expires_at", &self.expires_at).finish()
    }
}

pub struct Jwt {
    encoding: EncodingKey,
    decoding: DecodingKey,
    kid: String,
    validation: Validation,
}

impl fmt::Debug for Jwt {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Jwt").field("kid", &self.kid).finish_non_exhaustive()
    }
}

impl Jwt {
    fn from_seed(seed: &[u8; 32]) -> Self {
        #[expect(clippy::expect_used, reason = "any 32 bytes are a valid Ed25519 seed")]
        let pair = Ed25519KeyPair::from_seed_unchecked(seed).expect("Ed25519 seed");
        #[expect(clippy::expect_used, reason = "serializing a valid key pair cannot fail")]
        let pkcs8 = pair.to_pkcs8v1().expect("PKCS#8 encoding");
        let public = pair.public_key().as_ref();
        let kid: String = Sha256::digest(public)[..8].iter().map(|b| format!("{b:02x}")).collect();
        let mut validation = Validation::new(Algorithm::EdDSA);
        validation.leeway = LEEWAY.as_secs();
        validation.set_required_spec_claims(&["exp", "iat", "sub"]);
        Self {
            encoding: EncodingKey::from_ed_der(pkcs8.as_ref()),
            decoding: DecodingKey::from_ed_der(public),
            kid,
            validation,
        }
    }

    pub fn kid(&self) -> &str {
        &self.kid
    }

    pub fn issue(&self, grant: Grant, now: OffsetDateTime) -> AccessToken {
        let expires_at = now + ACCESS_TTL;
        let claims = Claims {
            sub: grant.user_id,
            sid: grant.session_id,
            iid: grant.identity_id,
            prv: grant.provider,
            iat: now.unix_timestamp(),
            exp: expires_at.unix_timestamp(),
        };
        let mut header = Header::new(Algorithm::EdDSA);
        header.kid = Some(self.kid.clone());
        #[expect(clippy::expect_used, reason = "signing our own claims with a valid key cannot fail")]
        let token = jsonwebtoken::encode(&header, &claims, &self.encoding).expect("JWT signing");
        AccessToken { token, expires_at }
    }

    /// Signature, algorithm, `kid`, `exp` and `iat` with 30 s of skew.
    /// Revocation is checked separately against the store.
    pub fn verify(&self, token: &str) -> Result<Principal, AuthError> {
        let header = jsonwebtoken::decode_header(token).map_err(|_| AuthError::Invalid)?;
        if header.kid.as_deref() != Some(self.kid.as_str()) {
            return Err(AuthError::Invalid);
        }
        let data =
            jsonwebtoken::decode::<Claims>(token, &self.decoding, &self.validation).map_err(|e| match e.kind() {
                jsonwebtoken::errors::ErrorKind::ExpiredSignature => AuthError::Expired,
                _ => AuthError::Invalid,
            })?;
        let c = data.claims;
        let now = OffsetDateTime::now_utc().unix_timestamp();
        let leeway = i64::try_from(LEEWAY.as_secs()).unwrap_or(i64::MAX);
        if c.iat > now + leeway {
            return Err(AuthError::Invalid);
        }
        let expires_at = OffsetDateTime::from_unix_timestamp(c.exp).map_err(|_| AuthError::Invalid)?;
        Ok(Principal { user_id: c.sub, session_id: c.sid, identity_id: c.iid, provider: c.prv, expires_at })
    }
}

/// An opaque refresh token: `base64url(session_id ‖ generation u32 BE ‖ 32
/// random bytes)`. Only its SHA-256 is stored.
#[derive(Clone, PartialEq, Eq)]
pub struct RefreshToken(String);

impl fmt::Debug for RefreshToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("RefreshToken(<redacted>)")
    }
}

const REFRESH_LEN: usize = 16 + 4 + 32;

/// What a presented refresh token claims to be; `hash` is what is compared.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RefreshClaim {
    pub session_id: Uuid,
    pub generation: u32,
    pub hash: [u8; 32],
}

impl RefreshToken {
    pub fn new(session_id: Uuid, generation: u32) -> (Self, [u8; 32]) {
        let mut raw = Zeroizing::new([0; REFRESH_LEN]);
        raw[..16].copy_from_slice(session_id.as_bytes());
        raw[16..20].copy_from_slice(&generation.to_be_bytes());
        raw[20..].copy_from_slice(&random::<32>());
        let hash = Sha256::digest(raw.as_slice()).into();
        (Self(URL_SAFE_NO_PAD.encode(raw.as_slice())), hash)
    }

    pub fn from_cookie(value: &str) -> Self {
        Self(value.to_owned())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// `None` for anything that is not a well-formed token.
    pub fn claim(&self) -> Option<RefreshClaim> {
        let raw = Zeroizing::new(URL_SAFE_NO_PAD.decode(&self.0).ok()?);
        if raw.len() != REFRESH_LEN {
            return None;
        }
        let session_id = Uuid::from_slice(&raw[..16]).ok()?;
        let generation = u32::from_be_bytes(raw[16..20].try_into().ok()?);
        Some(RefreshClaim { session_id, generation, hash: Sha256::digest(raw.as_slice()).into() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grant() -> Grant {
        Grant {
            user_id: Uuid::now_v7(),
            session_id: Uuid::now_v7(),
            identity_id: Uuid::now_v7(),
            provider: Provider::Email,
        }
    }

    #[test]
    fn access_tokens_round_trip() {
        let keys = ServerKeys::derive(&[7; 32]);
        let g = grant();
        let token = keys.jwt.issue(g, OffsetDateTime::now_utc());
        let p = keys.jwt.verify(&token.token).unwrap();
        assert_eq!(
            (p.user_id, p.session_id, p.identity_id, p.provider),
            (g.user_id, g.session_id, g.identity_id, g.provider)
        );
        assert_eq!(p.expires_at.unix_timestamp(), token.expires_at.unix_timestamp());
        assert!(!format!("{token:?}").contains(&token.token));
    }

    #[test]
    fn the_secret_decides_the_key() {
        let a = ServerKeys::derive(&[1; 32]);
        let b = ServerKeys::derive(&[2; 32]);
        assert_eq!(a.jwt.kid(), ServerKeys::derive(&[1; 32]).jwt.kid());
        assert_ne!(a.jwt.kid(), b.jwt.kid());
        assert_ne!(*a.email_code, *b.email_code);
        let token = a.jwt.issue(grant(), OffsetDateTime::now_utc());
        assert_eq!(b.jwt.verify(&token.token), Err(AuthError::Invalid));
    }

    #[test]
    fn expiry_allows_thirty_seconds_of_skew() {
        let keys = ServerKeys::derive(&[3; 32]);
        let now = OffsetDateTime::now_utc();
        let within = keys.jwt.issue(grant(), now - ACCESS_TTL - Duration::from_secs(20));
        assert!(keys.jwt.verify(&within.token).is_ok());
        let past = keys.jwt.issue(grant(), now - ACCESS_TTL - Duration::from_secs(40));
        assert_eq!(keys.jwt.verify(&past.token), Err(AuthError::Expired));
        let future = keys.jwt.issue(grant(), now + Duration::from_secs(120));
        assert_eq!(keys.jwt.verify(&future.token), Err(AuthError::Invalid));
    }

    #[test]
    fn tampered_or_foreign_tokens_are_invalid() {
        let keys = ServerKeys::derive(&[4; 32]);
        let token = keys.jwt.issue(grant(), OffsetDateTime::now_utc()).token;
        let mut parts: Vec<&str> = token.split('.').collect();
        let other = keys.jwt.issue(grant(), OffsetDateTime::now_utc()).token;
        let other_claims = other.split('.').nth(1).unwrap().to_owned();
        parts[1] = &other_claims;
        parts[2] = "AAAA";
        assert_eq!(keys.jwt.verify(&parts.join(".")), Err(AuthError::Invalid));
        assert_eq!(keys.jwt.verify("not.a.jwt"), Err(AuthError::Invalid));
        // `alg: none` with our kid.
        let header = URL_SAFE_NO_PAD.encode(format!(r#"{{"alg":"none","kid":"{}"}}"#, keys.jwt.kid()));
        let unsigned = format!("{header}.{}.", token.split('.').nth(1).unwrap());
        assert_eq!(keys.jwt.verify(&unsigned), Err(AuthError::Invalid));
    }

    #[test]
    fn refresh_tokens_carry_session_and_generation() {
        let session = Uuid::now_v7();
        let (token, hash) = RefreshToken::new(session, 41);
        let claim = token.claim().unwrap();
        assert_eq!((claim.session_id, claim.generation, claim.hash), (session, 41, hash));
        assert_ne!(RefreshToken::new(session, 41).1, hash, "random part");
        assert!(!format!("{token:?}").contains(token.as_str()));
        for junk in ["", "abc", "!!!!", &URL_SAFE_NO_PAD.encode([0; 51])] {
            assert_eq!(RefreshToken::from_cookie(junk).claim(), None, "{junk}");
        }
    }
}
