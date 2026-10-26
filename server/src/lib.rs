//! Vault Chat server: configuration, HTTP routes, the WebSocket transport,
//! chats and the agent loop. `main.rs` only wires the process.

pub mod agent;
pub mod app;
pub mod auth;
pub mod build_info;
pub mod bus;
pub mod chats;
pub mod config;
pub mod keys;
pub mod link;
mod middleware;
pub mod providers;
pub mod settings;
pub mod telemetry;
pub mod ws;

mod routes;
