//! Bodies of the `/auth` HTTP routes (docs/auth.md, "HTTP routes"). Errors
//! use [`crate::error::ErrorPayload`]. Timestamps are milliseconds since the
//! Unix epoch.

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use crate::redact::Secret;

/// How the identity used to sign in proves itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Google,
    Email,
}

impl Provider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Google => "google",
            Self::Email => "email",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "google" => Some(Self::Google),
            "email" => Some(Self::Email),
            _ => None,
        }
    }
}

/// `GET /auth/providers`: which sign-in methods this server offers.
#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct Providers {
    pub google: bool,
    pub email: bool,
}

/// `POST /auth/email/start` and `/auth/link/email/start`.
#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct EmailStart {
    pub email: Secret,
    /// UI language for the mail; unknown values fall back to English.
    pub locale: String,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct EmailStarted {
    pub pending_id: Uuid,
}

/// `POST /auth/email/verify` and `/auth/link/email/verify`.
#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct EmailVerify {
    pub pending_id: Uuid,
    pub email: Secret,
    pub code: Secret,
}

/// A fresh access token: the answer to a sign-in and to `POST /auth/refresh`.
#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct AccessGrant {
    pub access_token: Secret,
    pub expires_at: i64,
    pub user_id: Uuid,
    pub session_id: Uuid,
}

/// `PUT /auth/session`: what only the client knows about the session.
#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct SessionUpdate {
    pub device_id: Uuid,
    /// IANA name from `Intl`; dropped when the server does not know it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub timezone: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub locale: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub client_version: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct SessionInfo {
    pub id: Uuid,
    /// The session making this request.
    pub current: bool,
    pub provider: Provider,
    pub device_id: Option<Uuid>,
    pub user_agent: Option<String>,
    pub ip: Option<String>,
    pub country: Option<String>,
    pub timezone: Option<String>,
    pub locale: Option<String>,
    pub client_version: Option<String>,
    pub created_at: i64,
    pub last_seen_at: i64,
}

/// `GET /auth/sessions`: live sessions, newest activity first.
#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct Sessions {
    pub sessions: Vec<SessionInfo>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct IdentityInfo {
    pub id: Uuid,
    pub provider: Provider,
    pub email: Option<String>,
    pub email_verified: bool,
    pub created_at: i64,
    pub last_used_at: i64,
}

/// `GET /auth/identities`.
#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct Identities {
    pub identities: Vec<IdentityInfo>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct AuditEntry {
    pub id: i64,
    /// `area.verb`, e.g. `auth.signed_in`.
    pub kind: String,
    pub session_id: Option<Uuid>,
    pub ip: Option<String>,
    pub country: Option<String>,
    pub user_agent: Option<String>,
    /// Ids, provider kinds and reasons; never content or addresses.
    #[ts(type = "Record<string, unknown>")]
    pub details: serde_json::Value,
    pub created_at: i64,
}

/// `GET /auth/audit?before=&limit=`: newest first.
#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct AuditPage {
    pub events: Vec<AuditEntry>,
    /// Pass as `before` for the next page; absent on the last page.
    pub next_before: Option<i64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_never_print() {
        let verify: EmailVerify = serde_json::from_str(
            r#"{"pending_id":"0190d2c4-8b7e-7000-8000-000000000000","email":"ann@example.com","code":"12345678"}"#,
        )
        .unwrap();
        let debug = format!("{verify:?}");
        assert!(!debug.contains("ann@") && !debug.contains("12345678"));
        let grant = AccessGrant {
            access_token: Secret("eyJ.secret.sig".into()),
            expires_at: 0,
            user_id: Uuid::nil(),
            session_id: Uuid::nil(),
        };
        assert!(!format!("{grant:?}").contains("secret"));
    }

    #[test]
    fn providers_are_lowercase() {
        assert_eq!(serde_json::to_string(&Provider::Google).unwrap(), r#""google""#);
        for p in [Provider::Google, Provider::Email] {
            assert_eq!(Provider::parse(p.as_str()), Some(p));
        }
    }
}
