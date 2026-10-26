//! Configuration from environment variables (docs/configuration.md). The
//! server needs only `CHAT_DATABASE_URL`; optional features are off unless
//! their variables are set.

use std::{fmt, net::SocketAddr, path::PathBuf};

use base64::Engine;
use ipnet::IpNet;
use zeroize::Zeroizing;

use crate::{auth::signup::SignupPolicy, providers::AddressPolicy};

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
pub struct GoogleConfig {
    pub client_id: String,
    /// Never logged.
    pub client_secret: String,
}

#[derive(Clone)]
pub struct SmtpConfig {
    /// Never logged: it may contain a password.
    pub url: String,
    pub from: String,
}

impl fmt::Debug for GoogleConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GoogleConfig").field("client_id", &self.client_id).finish_non_exhaustive()
    }
}

impl fmt::Debug for SmtpConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SmtpConfig").field("from", &self.from).finish_non_exhaustive()
    }
}

#[derive(Clone)]
pub struct Config {
    pub listen: SocketAddr,
    /// Never logged: it may contain a password.
    pub database_url: String,
    pub database_max_connections: u32,
    pub log_format: LogFormat,
    /// Where users open the client, without a trailing slash.
    pub public_url: String,
    /// Origins allowed to open WebSockets and call `/auth` (the client's origin), exact match.
    pub allowed_origins: Vec<String>,
    /// Private networks provider calls may reach (Ollama on the host or LAN).
    pub provider_networks: AddressPolicy,
    /// Root of the server's keys (docs/auth.md); random per start when unset. Never logged.
    pub server_secret: Option<Zeroizing<Vec<u8>>>,
    pub session_idle_days: u32,
    pub signup: SignupPolicy,
    pub google: Option<GoogleConfig>,
    pub smtp: Option<SmtpConfig>,
    /// Never logged: it may contain a password.
    pub redis_url: Option<String>,
    pub trusted_proxies: Vec<IpNet>,
    pub geoip_db: Option<PathBuf>,
    pub audit_retention_days: u32,
}

impl fmt::Debug for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let set = |on: bool| if on { "<set>" } else { "<unset>" };
        f.debug_struct("Config")
            .field("listen", &self.listen)
            .field("database_url", &"<redacted>")
            .field("database_max_connections", &self.database_max_connections)
            .field("log_format", &self.log_format)
            .field("public_url", &self.public_url)
            .field("allowed_origins", &self.allowed_origins)
            .field("provider_networks", &self.provider_networks)
            .field("server_secret", &set(self.server_secret.is_some()))
            .field("session_idle_days", &self.session_idle_days)
            .field("signup", &self.signup)
            .field("google_client_id", &self.google.as_ref().map(|g| &g.client_id))
            .field("smtp_from", &self.smtp.as_ref().map(|s| &s.from))
            .field("redis_url", &set(self.redis_url.is_some()))
            .field("trusted_proxies", &self.trusted_proxies)
            .field("geoip_db", &self.geoip_db)
            .field("audit_retention_days", &self.audit_retention_days)
            .finish()
    }
}

fn origin_of(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    let origin = parsed.origin();
    (origin.is_tuple() && matches!(parsed.scheme(), "http" | "https")).then(|| origin.ascii_serialization())
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    /// Parses from any variable source; tests pass a map.
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let get = |name: &str| get(name).filter(|v| !v.trim().is_empty());
        let parse = |name: &'static str, default: &str| -> String { get(name).unwrap_or_else(|| default.to_owned()) };
        let invalid = |name: &'static str, reason: String| ConfigError::Invalid { name, reason };
        let positive = |name: &'static str, default: &str| -> Result<u32, ConfigError> {
            parse(name, default)
                .trim()
                .parse::<u32>()
                .ok()
                .filter(|n| *n > 0)
                .ok_or_else(|| invalid(name, "a positive integer".into()))
        };

        let listen = parse("CHAT_LISTEN", "0.0.0.0:8080");
        let listen = listen.parse().map_err(|e| invalid("CHAT_LISTEN", format!("{e}")))?;
        let database_url = get("CHAT_DATABASE_URL").ok_or(ConfigError::Missing("CHAT_DATABASE_URL"))?;
        let database_max_connections = positive("CHAT_DATABASE_MAX_CONNECTIONS", "10")?;
        let log_format = match parse("CHAT_LOG_FORMAT", "pretty").as_str() {
            "pretty" => LogFormat::Pretty,
            "json" => LogFormat::Json,
            other => return Err(invalid("CHAT_LOG_FORMAT", format!("`{other}`: expected `pretty` or `json`"))),
        };
        let public_url = parse("CHAT_PUBLIC_URL", "http://localhost:3000").trim().trim_end_matches('/').to_owned();
        let public_origin = origin_of(&public_url)
            .ok_or_else(|| invalid("CHAT_PUBLIC_URL", format!("`{public_url}` is not an http(s) URL")))?;
        let allowed_origins: Vec<String> = parse("CHAT_ALLOWED_ORIGINS", &public_origin)
            .split(',')
            .map(|o| o.trim().trim_end_matches('/').to_owned())
            .filter(|o| !o.is_empty())
            .collect();
        if let Some(bad) = allowed_origins.iter().find(|o| origin_of(o).as_deref() != Some(o.as_str())) {
            return Err(invalid("CHAT_ALLOWED_ORIGINS", format!("`{bad}` is not an http(s) origin")));
        }
        let provider_networks = AddressPolicy::parse(&parse("CHAT_PROVIDER_ALLOWED_NETWORKS", ""))
            .map_err(|e| invalid("CHAT_PROVIDER_ALLOWED_NETWORKS", e))?;

        let server_secret = get("CHAT_SERVER_SECRET")
            .map(|v| {
                let v = v.trim();
                let decoded = base64::engine::general_purpose::STANDARD
                    .decode(v)
                    .or_else(|_| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(v.trim_end_matches('=')))
                    .map_err(|_| invalid("CHAT_SERVER_SECRET", "not base64".into()))?;
                if decoded.len() < 32 {
                    return Err(invalid("CHAT_SERVER_SECRET", "at least 32 bytes (openssl rand -base64 32)".into()));
                }
                Ok(Zeroizing::new(decoded))
            })
            .transpose()?;
        let session_idle_days = positive("CHAT_SESSION_IDLE_DAYS", "30")?;
        let signup =
            SignupPolicy::parse(&parse("CHAT_SIGNUP_ALLOW", "")).map_err(|e| invalid("CHAT_SIGNUP_ALLOW", e))?;

        let google = match (get("CHAT_GOOGLE_CLIENT_ID"), get("CHAT_GOOGLE_CLIENT_SECRET")) {
            (Some(client_id), Some(client_secret)) => Some(GoogleConfig { client_id, client_secret }),
            (None, None) => None,
            (Some(_), None) => return Err(ConfigError::Missing("CHAT_GOOGLE_CLIENT_SECRET")),
            (None, Some(_)) => return Err(ConfigError::Missing("CHAT_GOOGLE_CLIENT_ID")),
        };
        let smtp = match get("CHAT_SMTP_URL") {
            None => None,
            Some(url) => {
                if !(url.starts_with("smtp://") || url.starts_with("smtps://")) {
                    return Err(invalid("CHAT_SMTP_URL", "expected smtp:// or smtps://".into()));
                }
                let from = get("CHAT_SMTP_FROM").ok_or(ConfigError::Missing("CHAT_SMTP_FROM"))?;
                Some(SmtpConfig { url, from })
            }
        };
        let redis_url = get("CHAT_REDIS_URL");
        if let Some(url) = &redis_url
            && !(url.starts_with("redis://") || url.starts_with("rediss://"))
        {
            return Err(invalid("CHAT_REDIS_URL", "expected redis:// or rediss://".into()));
        }
        let trusted_proxies = parse("CHAT_TRUSTED_PROXIES", "")
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| {
                s.parse::<IpNet>()
                    .or_else(|_| s.parse::<std::net::IpAddr>().map(IpNet::from))
                    .map_err(|_| invalid("CHAT_TRUSTED_PROXIES", format!("`{s}` is not an IP address or CIDR network")))
            })
            .collect::<Result<_, _>>()?;
        let geoip_db = get("CHAT_GEOIP_DB").map(PathBuf::from);
        let audit_retention_days = positive("CHAT_AUDIT_RETENTION_DAYS", "365")?;

        Ok(Self {
            listen,
            database_url,
            database_max_connections,
            log_format,
            public_url,
            allowed_origins,
            provider_networks,
            server_secret,
            session_idle_days,
            signup,
            google,
            smtp,
            redis_url,
            trusted_proxies,
            geoip_db,
            audit_retention_days,
        })
    }

    /// Which optional features are on, for the startup log line.
    pub fn features(&self) -> String {
        let mut on = vec!["postgres"];
        on.extend(self.redis_url.as_ref().map(|_| "redis"));
        on.extend(self.google.as_ref().map(|_| "google"));
        on.extend(self.smtp.as_ref().map(|_| "email"));
        on.extend(self.geoip_db.as_ref().map(|_| "geoip"));
        on.join(",")
    }

    /// `Secure` cookies (and the `__Host-` prefix) need https; plain http is local development.
    pub fn secure_cookies(&self) -> bool {
        self.public_url.starts_with("https://")
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

    const DB: (&str, &str) = ("CHAT_DATABASE_URL", "postgres://x");

    #[test]
    fn only_the_database_is_required() {
        let c = config(&[("CHAT_DATABASE_URL", "postgres://localhost/chat")]).unwrap();
        assert_eq!(c.listen.to_string(), "0.0.0.0:8080");
        assert_eq!(c.database_max_connections, 10);
        assert_eq!(c.log_format, LogFormat::Pretty);
        assert_eq!(c.public_url, "http://localhost:3000");
        assert_eq!(c.allowed_origins, ["http://localhost:3000"]);
        assert!(c.server_secret.is_none() && c.google.is_none() && c.smtp.is_none() && c.redis_url.is_none());
        assert_eq!((c.session_idle_days, c.audit_retention_days), (30, 365));
        assert_eq!(c.features(), "postgres");
        assert!(!c.secure_cookies());
        assert!(matches!(config(&[]), Err(ConfigError::Missing("CHAT_DATABASE_URL"))));
        assert!(matches!(config(&[("CHAT_DATABASE_URL", "  ")]), Err(ConfigError::Missing(_))));
    }

    #[test]
    fn invalid_values_name_the_variable() {
        for (name, value) in [
            ("CHAT_LISTEN", "nope"),
            ("CHAT_DATABASE_MAX_CONNECTIONS", "0"),
            ("CHAT_LOG_FORMAT", "xml"),
            ("CHAT_PUBLIC_URL", "chat.example"),
            ("CHAT_ALLOWED_ORIGINS", "chat.example"),
            ("CHAT_ALLOWED_ORIGINS", "https://chat.example/path"),
            ("CHAT_PROVIDER_ALLOWED_NETWORKS", "lan"),
            ("CHAT_SERVER_SECRET", "c2hvcnQ="),
            ("CHAT_SERVER_SECRET", "not base64!"),
            ("CHAT_SESSION_IDLE_DAYS", "-1"),
            ("CHAT_SMTP_URL", "http://mail"),
            ("CHAT_REDIS_URL", "http://cache"),
            ("CHAT_TRUSTED_PROXIES", "proxy"),
            ("CHAT_AUDIT_RETENTION_DAYS", "0"),
        ] {
            match config(&[DB, (name, value)]) {
                Err(ConfigError::Invalid { name: n, .. }) => assert_eq!(n, name),
                other => panic!("{name}={value}: {other:?}"),
            }
        }
    }

    #[test]
    fn origins_default_to_the_public_url() {
        let c = config(&[DB, ("CHAT_PUBLIC_URL", "https://chat.example/")]).unwrap();
        assert_eq!(c.public_url, "https://chat.example");
        assert_eq!(c.allowed_origins, ["https://chat.example"]);
        assert!(c.secure_cookies());
        let c = config(&[DB, ("CHAT_ALLOWED_ORIGINS", "https://chat.example/, http://localhost:3000")]).unwrap();
        assert_eq!(c.allowed_origins, ["https://chat.example", "http://localhost:3000"]);
    }

    #[test]
    fn optional_features_come_in_pairs() {
        assert!(matches!(
            config(&[DB, ("CHAT_GOOGLE_CLIENT_ID", "id")]),
            Err(ConfigError::Missing("CHAT_GOOGLE_CLIENT_SECRET"))
        ));
        assert!(matches!(config(&[DB, ("CHAT_SMTP_URL", "smtp://mail")]), Err(ConfigError::Missing("CHAT_SMTP_FROM"))));
        let c = config(&[
            DB,
            ("CHAT_GOOGLE_CLIENT_ID", "id"),
            ("CHAT_GOOGLE_CLIENT_SECRET", "s"),
            ("CHAT_SMTP_URL", "smtp://mail:1025"),
            ("CHAT_SMTP_FROM", "Chat <chat@example.org>"),
            ("CHAT_REDIS_URL", "redis://cache"),
            ("CHAT_TRUSTED_PROXIES", "10.0.0.0/8, 192.168.1.1"),
            ("CHAT_SERVER_SECRET", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),
        ])
        .unwrap();
        assert_eq!(c.features(), "postgres,redis,google,email");
        assert_eq!(c.trusted_proxies.len(), 2);
        assert_eq!(c.server_secret.unwrap().len(), 32);
        assert!(config(&[DB, ("CHAT_REDIS_URL", "rediss://cache")]).is_ok());
    }

    #[test]
    fn debug_hides_secrets() {
        let c = config(&[
            ("CHAT_DATABASE_URL", "postgres://user:dbsecret@db/chat"),
            ("CHAT_SERVER_SECRET", "c2VydmVyc2VjcmV0c2VydmVyc2VjcmV0c2VydmVyc2VjcmV0"),
            ("CHAT_GOOGLE_CLIENT_ID", "id"),
            ("CHAT_GOOGLE_CLIENT_SECRET", "googlesecret"),
            ("CHAT_SMTP_URL", "smtps://u:smtpsecret@mail:465"),
            ("CHAT_SMTP_FROM", "chat@example.org"),
            ("CHAT_REDIS_URL", "redis://:redissecret@cache"),
        ])
        .unwrap();
        let debug = format!("{c:?}");
        for secret in ["dbsecret", "c2VydmVy", "googlesecret", "smtpsecret", "redissecret"] {
            assert!(!debug.contains(secret), "{secret} leaked");
        }
    }
}
