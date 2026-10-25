//! WebSocket and HTTP message types shared by the server and the client.
//!
//! The specification is `docs/protocol.md`. TypeScript for the client is
//! generated from these types into `client/src/protocol/generated/protocol.ts`
//! (see [`typescript`]); never edit that file by hand.
//!
//! Frames are parsed in two steps: [`InFrame`] reads the envelope and keeps the
//! payload raw, then the handler for `type` deserializes the payload into its
//! request type, which rejects unknown fields.

pub mod auth;
pub mod close;
pub mod connection;
pub mod error;
mod frame;
pub mod redact;
#[cfg(test)]
mod typescript;

pub use frame::{InFrame, OutFrame, PROTOCOL_VERSION, SUPPORTED_VERSIONS};

/// A client request: its `type` name and the payload of its `ok` response.
pub trait Request: serde::de::DeserializeOwned + ts_rs::TS {
    const TYPE: &'static str;
    type Response: serde::Serialize + ts_rs::TS;
}

/// A server event: its `type` name. Events have no `id`.
pub trait Event: serde::Serialize + ts_rs::TS {
    const TYPE: &'static str;
}

/// The empty payload `{}`.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct Empty {}
