//! Key hierarchy, records, wraps and device linking for Vault Chat.
//!
//! The specification is `docs/crypto.md`; this crate implements it for the
//! server (native) and the client Web Worker (`wasm32-unknown-unknown`). Every
//! function that needs randomness takes the RNG explicitly: production code
//! passes [`os_rng`], tests pass a seeded RNG to reproduce the vectors.

mod encoding;
mod error;
mod kdf;
mod keys;
mod padding;
mod symmetric;

pub mod ark;
pub mod ids;
pub mod link;
pub mod record;
pub mod recovery;
pub mod scope;
pub mod wrap;

#[cfg(all(test, not(target_arch = "wasm32")))]
mod properties;
#[cfg(test)]
mod vectors;

pub use error::Error;
pub use keys::PublicKey;
pub use rand_core::CryptoRng;

/// The operating system RNG (`crypto.getRandomValues` in the browser).
pub fn os_rng() -> impl CryptoRng {
    rand_core::UnwrapErr(getrandom::SysRng)
}
