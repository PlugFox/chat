//! Configuration from environment variables (docs/configuration.md). The
//! server needs only `CHAT_DATABASE_URL`; optional features are off unless
//! their variables are set.

use std::{fmt, net::SocketAddr};

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("{0} is required")]
    Missing(&'static str),
    #[error("{name} is invalid: {reason}")]
    Invalid { name: &'static str, reason: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LogFormat {
    Pretty,
    Json,
}

#[derive(Clone)]
pub struct Config {
    pub listen: SocketAddr,
    /// Never logged: it may contain a password.
    pub database_url: String,
    pub database_max_connections: u32,
    pub log_format: LogFormat,
    /// Origins allowed to open WebSockets (the client's origin), exact match.
    pub allowed_origins: Vec<String>,
}

impl fmt::Debug for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Config")
            .field("listen", &self.listen)
            .field("database_url", &"<redacted>")
            .field("database_max_connections", &self.database_max_connections)
            .field("log_format", &self.log_format)
            .field("allowed_origins", &self.allowed_origins)
            .finish()
    }
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    /// Parses from any variable source; tests pass a map.
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let get = |name: &str| get(name).filter(|v| !v.trim().is_empty());
        let parse = |name: &'static str, default: &str| -> Result<String, ConfigError> {
            Ok(get(name).unwrap_or_else(|| default.to_owned()))
        };
        let invalid = |name: &'static str, reason: String| ConfigError::Invalid { name, reason };

        let listen = parse("CHAT_LISTEN", "0.0.0.0:8080")?;
        let listen = listen.parse().map_err(|e| invalid("CHAT_LISTEN", format!("{e}")))?;
        let database_url = get("CHAT_DATABASE_URL").ok_or(ConfigError::Missing("CHAT_DATABASE_URL"))?;
        let max = parse("CHAT_DATABASE_MAX_CONNECTIONS", "10")?;
        let database_max_connections = max
            .parse::<u32>()
            .ok()
            .filter(|n| *n > 0)
            .ok_or_else(|| invalid("CHAT_DATABASE_MAX_CONNECTIONS", "a positive integer".into()))?;
        let log_format = match parse("CHAT_LOG_FORMAT", "pretty")?.as_str() {
            "pretty" => LogFormat::Pretty,
            "json" => LogFormat::Json,
            other => return Err(invalid("CHAT_LOG_FORMAT", format!("`{other}`: expected `pretty` or `json`"))),
        };
        let allowed_origins: Vec<String> = parse("CHAT_ALLOWED_ORIGINS", "http://localhost:3000")?
            .split(',')
            .map(|o| o.trim().trim_end_matches('/').to_owned())
            .filter(|o| !o.is_empty())
            .collect();
        if let Some(bad) = allowed_origins.iter().find(|o| !(o.starts_with("https://") || o.starts_with("http://"))) {
            return Err(invalid("CHAT_ALLOWED_ORIGINS", format!("`{bad}` is not an http(s) origin")));
        }
        Ok(Self { listen, database_url, database_max_connections, log_format, allowed_origins })
    }

    /// Which optional features are on, for the startup log line.
    pub fn features(&self) -> String {
        // Redis, SMTP and S3 join here as they are implemented.
        "postgres".to_owned()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn config(vars: &[(&str, &str)]) -> Result<Config, ConfigError> {
        let vars: HashMap<String, String> = vars.iter().map(|(k, v)| ((*k).into(), (*v).into())).collect();
        Config::from_lookup(|name| vars.get(name).cloned())
    }

    #[test]
    fn only_the_database_is_required() {
        let c = config(&[("CHAT_DATABASE_URL", "postgres://localhost/chat")]).unwrap();
        assert_eq!(c.listen.to_string(), "0.0.0.0:8080");
        assert_eq!(c.database_max_connections, 10);
        assert_eq!(c.log_format, LogFormat::Pretty);
        assert_eq!(c.allowed_origins, ["http://localhost:3000"]);
        assert!(matches!(config(&[]), Err(ConfigError::Missing("CHAT_DATABASE_URL"))));
        assert!(matches!(config(&[("CHAT_DATABASE_URL", "  ")]), Err(ConfigError::Missing(_))));
    }

    #[test]
    fn invalid_values_name_the_variable() {
        let db = ("CHAT_DATABASE_URL", "postgres://x");
        for (name, value) in [
            ("CHAT_LISTEN", "nope"),
            ("CHAT_DATABASE_MAX_CONNECTIONS", "0"),
            ("CHAT_LOG_FORMAT", "xml"),
            ("CHAT_ALLOWED_ORIGINS", "chat.example"),
        ] {
            match config(&[db, (name, value)]) {
                Err(ConfigError::Invalid { name: n, .. }) => assert_eq!(n, name),
                other => panic!("{name}: {other:?}"),
            }
        }
    }

    #[test]
    fn origins_are_a_trimmed_list() {
        let c = config(&[
            ("CHAT_DATABASE_URL", "postgres://x"),
            ("CHAT_ALLOWED_ORIGINS", "https://chat.example/, http://localhost:3000"),
        ])
        .unwrap();
        assert_eq!(c.allowed_origins, ["https://chat.example", "http://localhost:3000"]);
    }

    #[test]
    fn debug_hides_the_database_url() {
        let c = config(&[("CHAT_DATABASE_URL", "postgres://user:secret@db/chat")]).unwrap();
        assert!(!format!("{c:?}").contains("secret"));
    }
}
