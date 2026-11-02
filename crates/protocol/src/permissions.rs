//! Permission requests and the access log (docs/protocol.md, "Permissions and
//! the access log"; D-099): a data tool asks the auth session that sent the
//! turn's message, which answers with the tool result it decrypted.

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use crate::{Bytes, Empty, Event, Request, redact::Secret};

/// The longest tool result a client may send, in bytes of UTF-8.
pub const RESULT_MAX: usize = 64 * 1024;
/// The longest `read_history` result, in bytes of UTF-8 (D-100).
pub const HISTORY_MAX: usize = 32 * 1024;
/// History one turn reads at most, in bytes.
pub const HISTORY_TURN_MAX: usize = 128 * 1024;
/// Message ids one `read_history` covers at most.
pub const HISTORY_COUNT: u32 = 50;
/// The longest reason kept, in characters.
pub const REASON_MAX: usize = 500;
/// Entries per `access_log.list` page.
pub const ACCESS_PAGE: usize = 50;

/// What a request asks for. Days are `YYYY-MM-DD`, both included.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(tag = "tool", rename_all = "snake_case", deny_unknown_fields)]
pub enum Grant {
    ReadRegister {
        metric: String,
        scope_id: Uuid,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        from: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        to: Option<String>,
    },
    SessionContext {},
    /// The `count` message ids before `before` of the request's chat; the client answers it itself.
    ReadHistory {
        before: u32,
        count: u32,
    },
    /// A file of the request's chat; the client answers with its content key (D-101).
    ReadFile {
        file_id: Uuid,
    },
    /// One new entry of a metric, written by the client on approval (D-106).
    /// Its value, day and comment are sealed in the request's `reason`.
    AddMeasurement {
        metric: String,
    },
    /// A public page the server reads for the turn (D-114). Its address is
    /// sealed in the request's `reason`, as nothing stored may name it.
    WebFetch {},
    /// Code the client runs in its sandbox and answers with the output
    /// (D-115). The code and its inputs are sealed in the request's `reason`.
    RunCode {},
    /// The forecast at the place the session's IP points to (D-116), which the
    /// user approves. The place is sealed in the request's `reason`.
    GetWeather {},
}

/// How a request, or a tool call in a reply's record, ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Approved,
    Denied,
    /// The client did not know the scope.
    Refused,
    Timeout,
    /// The turn ended first.
    Cancelled,
    /// No grant was needed: the server or, for `read_history` and `read_file`, the client answered.
    Answered,
}

impl Outcome {
    pub fn name(self) -> &'static str {
        match self {
            Self::Approved => "approved",
            Self::Denied => "denied",
            Self::Refused => "refused",
            Self::Timeout => "timeout",
            Self::Cancelled => "cancelled",
            Self::Answered => "answered",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        [Self::Approved, Self::Denied, Self::Refused, Self::Timeout, Self::Cancelled, Self::Answered]
            .into_iter()
            .find(|o| o.name() == name)
    }
}

/// Event to the auth session that sent the turn's message; also an item of `permission.pending`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct PermissionRequest {
    /// The access log entry.
    pub request_id: Uuid,
    pub chat_id: Uuid,
    pub turn_id: Uuid,
    /// The entry of the providers setting the turn runs with.
    pub provider_id: Uuid,
    pub grant: Grant,
    /// An `audit.reason` record.
    pub reason: Bytes,
    /// Milliseconds.
    pub expires_at: i64,
}

impl Event for PermissionRequest {
    const TYPE: &'static str = "permission.request";
}

#[derive(Debug, Default, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct PermissionPending {}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct PermissionList {
    /// Oldest first.
    pub requests: Vec<PermissionRequest>,
}

impl Request for PermissionPending {
    const TYPE: &'static str = "permission.pending";
    type Response = PermissionList;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    Approve,
    Deny,
    /// The client does not know the scope, or the chat does not open.
    Refuse,
    /// A `read_history` result or a `read_file` key, which ask no one.
    Answer,
}

impl Decision {
    pub fn outcome(self) -> Outcome {
        match self {
            Self::Approve => Outcome::Approved,
            Self::Deny => Outcome::Denied,
            Self::Refuse => Outcome::Refused,
            Self::Answer => Outcome::Answered,
        }
    }
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct PermissionRespond {
    pub request_id: Uuid,
    pub decision: Decision,
    /// The tool result in plaintext: required when approving `read_register` or
    /// `add_measurement` or answering, refused otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub result: Option<Secret>,
}

impl Request for PermissionRespond {
    const TYPE: &'static str = "permission.respond";
    type Response = Empty;
}

/// Event to the same auth session: the request ended, however it ended.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct PermissionResolved {
    pub request_id: Uuid,
    pub chat_id: Uuid,
    pub outcome: Outcome,
}

impl Event for PermissionResolved {
    const TYPE: &'static str = "permission.resolved";
}

#[derive(Debug, Default, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct AccessLogList {
    /// The `next` of the previous page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub before: Option<Uuid>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct AccessEntry {
    pub id: Uuid,
    pub chat_id: Uuid,
    pub grant: Grant,
    /// An `audit.reason` record.
    pub reason: Bytes,
    /// Absent while the request waits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub outcome: Option<Outcome>,
    /// Milliseconds.
    pub requested_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub decided_at: Option<i64>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct AccessLogPage {
    /// Newest first.
    pub entries: Vec<AccessEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub next: Option<Uuid>,
}

impl Request for AccessLogList {
    const TYPE: &'static str = "access_log.list";
    type Response = AccessLogPage;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_grant_names_its_tool() {
        let grant = Grant::ReadRegister {
            metric: "body.weight".into(),
            scope_id: Uuid::nil(),
            from: Some("2026-03-01".into()),
            to: None,
        };
        let json = serde_json::to_value(&grant).unwrap_or_default();
        assert_eq!(json["tool"], "read_register");
        assert!(json.get("to").is_none());
        let back: Grant = rmp_serde::from_slice(&rmp_serde::to_vec_named(&grant).unwrap_or_default()).unwrap();
        assert_eq!(back, grant);
        let session: Grant = serde_json::from_str(r#"{"tool":"session_context"}"#).unwrap();
        assert_eq!(session, Grant::SessionContext {});
        let history: Grant = serde_json::from_str(r#"{"tool":"read_history","before":61,"count":50}"#).unwrap();
        assert_eq!(history, Grant::ReadHistory { before: 61, count: 50 });
        let add: Grant = serde_json::from_str(r#"{"tool":"add_measurement","metric":"body.weight"}"#).unwrap();
        assert_eq!(add, Grant::AddMeasurement { metric: "body.weight".into() });
        assert!(serde_json::from_str::<Grant>(r#"{"tool":"add_measurement","metric":"m","value":1}"#).is_err());
        assert!(serde_json::from_str::<Grant>(r#"{"tool":"list_scopes"}"#).is_err());
    }

    #[test]
    fn outcomes_round_trip_by_name() {
        for o in [
            Outcome::Approved,
            Outcome::Denied,
            Outcome::Refused,
            Outcome::Timeout,
            Outcome::Cancelled,
            Outcome::Answered,
        ] {
            assert_eq!(Outcome::from_name(o.name()), Some(o));
        }
        assert_eq!(Outcome::from_name("maybe"), None);
    }

    #[test]
    fn results_never_print() {
        let respond = PermissionRespond {
            request_id: Uuid::nil(),
            decision: Decision::Approve,
            result: Some(Secret("72.5".into())),
        };
        assert!(!format!("{respond:?}").contains("72.5"));
    }
}
