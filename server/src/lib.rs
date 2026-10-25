//! Vault Chat server: configuration, HTTP routes and (later) the WebSocket
//! transport and the agent loop. `main.rs` only wires the process.

pub mod app;
pub mod auth;
pub mod config;
pub mod telemetry;
pub mod ws;

mod routes;
