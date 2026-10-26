//! Vault Chat server: configuration, HTTP routes and (later) the WebSocket
//! transport and the agent loop. `main.rs` only wires the process.

pub mod app;
pub mod auth;
pub mod build_info;
pub mod config;
pub mod keys;
pub mod link;
mod middleware;
pub mod providers;
pub mod telemetry;
pub mod ws;

mod routes;
