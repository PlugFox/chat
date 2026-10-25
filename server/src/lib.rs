//! Vault Chat server: configuration, HTTP routes and (later) the WebSocket
//! transport and the agent loop. `main.rs` only wires the process.

pub mod app;
pub mod config;
pub mod telemetry;

mod routes;
