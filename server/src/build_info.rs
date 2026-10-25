//! What is running: the crate version and the git commit (from `build.rs`).

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const GIT_COMMIT: &str = env!("CHAT_GIT_COMMIT");
/// `chat-server --version`: `chat-server 0.1.0 (abc123def456)`.
pub const VERSION_LINE: &str = concat!("chat-server ", env!("CARGO_PKG_VERSION"), " (", env!("CHAT_GIT_COMMIT"), ")");
