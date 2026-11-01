//! The agent's tools (docs/protocol.md, "Agent tools (v1)"; D-099): what the
//! model is offered, how its arguments are read, and the answers the server
//! gives itself. Data tools become permission requests in the turn.

use chat_protocol::{permissions::HISTORY_COUNT, registers::MetricCatalog};
use serde_json::{Value, json};
use time::{Date, Month, OffsetDateTime};

use crate::providers::{ToolCall, ToolSpec};

/// Tool calls one turn makes at most.
pub const CALLS_MAX: usize = 8;

pub const LIST_METRICS: &str = "list_metrics";
pub const READ_REGISTER: &str = "read_register";
pub const SESSION_CONTEXT: &str = "session_context";
pub const READ_HISTORY: &str = "read_history";
pub const READ_FILE: &str = "read_file";
pub const ADD_MEASUREMENT: &str = "add_measurement";

/// The longest comment a proposed entry carries, in bytes of UTF-8, as an entry holds.
const COMMENT_MAX: usize = 500;

/// What the system prompt says about the tools.
pub const GUIDE: &str = "You can call tools to read the user's own data. list_metrics tells which \
measurements the user records. read_register and session_context ask the user first, every time, so call \
them only when the question needs that data, ask for no more days than it needs, and give a short honest \
reason in the user's language. When the user denies a request, answer without the data. When the user tells you a measurement to record, \
call add_measurement with the value in the metric's unit, converting it or asking if the user gave another \
unit; the user approves each entry. Say it is recorded only after the result confirms it. You cannot change \
or delete entries: the user does that in the app.";

/// What the system prompt adds when the chat has messages before the context.
pub fn history_guide(first: u32) -> String {
    format!(
        "The messages above start at message {first} of this chat. When the question needs something said \
earlier, read_history reads the messages before that, without asking the user; read no further back than \
the question needs."
    )
}

/// What the system prompt adds when the chat has files the turn did not send.
pub const FILES_GUIDE: &str = "Files of earlier messages are shown as lines [file <id>: …] with a \
description in place of the file. When the question needs more than the description, read_file opens the \
file again, without asking the user.";

fn reason() -> Value {
    json!({
        "type": "string",
        "description": "Why the answer needs this data, in one sentence in the user's language. The user sees it before deciding.",
    })
}

/// The tools of a reply turn; `read_history` only when there is history
/// before the context, `read_file` only when the chat has other files.
pub fn specs(history: bool, files: bool) -> Vec<ToolSpec> {
    let mut specs = vec![
        ToolSpec {
            name: LIST_METRICS.into(),
            description: "The measurements the app knows (key, name, unit, whether a day's entries are averaged or \
                          summed) and, for those the user records, how many entries there are and when the newest is. \
                          No values."
                .into(),
            parameters: json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        },
        ToolSpec {
            name: READ_REGISTER.into(),
            description: "The user's entries of one measurement between two days, newest first, at most 1000: each \
                          with its local time, value in the metric's unit and the user's comment. The user approves \
                          or denies the request."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "metric": { "type": "string", "description": "A metric key from list_metrics, such as body.weight." },
                    "from": { "type": "string", "description": "The first day, YYYY-MM-DD; omit for no lower bound." },
                    "to": { "type": "string", "description": "The last day, YYYY-MM-DD, included; omit for no upper bound." },
                    "reason": reason(),
                },
                "required": ["metric", "reason"],
                "additionalProperties": false,
            }),
        },
        ToolSpec {
            name: SESSION_CONTEXT.into(),
            description: "The time zone, country and locale of the user's device, and the current time in UTC. The \
                          user approves or denies the request."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": { "reason": reason() },
                "required": ["reason"],
                "additionalProperties": false,
            }),
        },
        ToolSpec {
            name: ADD_MEASUREMENT.into(),
            description: "Adds one new entry to a measurement the user told you. The user sees the value and day and \
                          approves or denies it; the result confirms what was stored. Cannot change or delete entries."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "metric": { "type": "string", "description": "A metric key from list_metrics, such as body.weight." },
                    "value": { "type": "number", "description": "The value in the metric's unit from list_metrics." },
                    "day": { "type": "string", "description": "The day it belongs to, YYYY-MM-DD; omit for today." },
                    "comment": { "type": "string", "description": "A short note, only if the user gave one." },
                    "reason": {
                        "type": "string",
                        "description": "What the user asked to record, in one sentence in the user's language. The user sees it before deciding.",
                    },
                },
                "required": ["metric", "value", "reason"],
                "additionalProperties": false,
            }),
        },
    ];
    if history {
        specs.push(ToolSpec {
            name: READ_HISTORY.into(),
            description: "Earlier messages of this chat, oldest first: up to count message ids before the id \
                          before, each with its id, role, local time and text. The result's before, when present, \
                          is where to read on; without it the chat starts there."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "before": { "type": "integer", "minimum": 1, "description": "Read the messages before this id; omit to read before the messages above." },
                    "count": { "type": "integer", "minimum": 1, "maximum": HISTORY_COUNT, "description": "How many message ids to read, 50 if omitted." },
                    "reason": {
                        "type": "string",
                        "description": "Why the answer needs earlier messages, in one sentence in the user's language. The user sees it in the access log.",
                    },
                },
                "required": ["reason"],
                "additionalProperties": false,
            }),
        });
    }
    if files {
        specs.push(ToolSpec {
            name: READ_FILE.into(),
            description: "Opens a file of this chat by the id its [file …] line gives: the image, PDF or text \
                          itself, attached after the result."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "file_id": { "type": "string", "description": "The file's id, a UUID." },
                    "reason": {
                        "type": "string",
                        "description": "Why the answer needs the file itself, in one sentence in the user's language. The user sees it in the access log.",
                    },
                },
                "required": ["file_id", "reason"],
                "additionalProperties": false,
            }),
        });
    }
    specs
}

/// A tool call as the turn runs it.
#[derive(Clone, PartialEq, Eq)]
pub enum Call {
    ListMetrics,
    ReadRegister {
        metric: String,
        from: Option<Date>,
        to: Option<Date>,
        reason: String,
    },
    SessionContext {
        reason: String,
    },
    /// `before` as the model gave it; the turn bounds it by its context.
    ReadHistory {
        before: Option<u32>,
        count: u32,
        reason: String,
    },
    ReadFile {
        file_id: uuid::Uuid,
        reason: String,
    },
    /// A number as the model wrote it, so the type stays comparable.
    AddMeasurement {
        metric: String,
        value: serde_json::Number,
        day: Option<Date>,
        comment: Option<String>,
        reason: String,
    },
}

/// Without the reason: the model's text.
impl std::fmt::Debug for Call {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ListMetrics => f.write_str("ListMetrics"),
            Self::ReadRegister { metric, from, to, .. } => f
                .debug_struct("ReadRegister")
                .field("metric", metric)
                .field("from", from)
                .field("to", to)
                .finish_non_exhaustive(),
            Self::SessionContext { .. } => f.write_str("SessionContext"),
            Self::ReadHistory { before, count, .. } => {
                f.debug_struct("ReadHistory").field("before", before).field("count", count).finish_non_exhaustive()
            }
            Self::ReadFile { file_id, .. } => {
                f.debug_struct("ReadFile").field("file_id", file_id).finish_non_exhaustive()
            }
            // Without the value, day and comment: the user's data.
            Self::AddMeasurement { metric, .. } => {
                f.debug_struct("AddMeasurement").field("metric", metric).finish_non_exhaustive()
            }
        }
    }
}

/// A `YYYY-MM-DD` day.
pub fn parse_day(text: &str) -> Option<Date> {
    let mut parts = text.split('-');
    let (year, month, day) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() || year.len() != 4 || month.len() != 2 || day.len() != 2 {
        return None;
    }
    let month = Month::try_from(month.parse::<u8>().ok()?).ok()?;
    Date::from_calendar_date(year.parse().ok()?, month, day.parse().ok()?).ok()
}

pub fn day(date: Date) -> String {
    format!("{:04}-{:02}-{:02}", date.year(), u8::from(date.month()), date.day())
}

/// The model's reason, cut to what the dialog shows.
fn reason_of(arguments: &Value) -> String {
    let text = arguments.get("reason").and_then(Value::as_str).unwrap_or_default().trim();
    text.chars().take(chat_protocol::permissions::REASON_MAX).collect()
}

/// The call, or the error text the model gets back.
pub fn parse(call: &ToolCall) -> Result<Call, String> {
    let args = &call.arguments;
    if !args.is_object() {
        return Err("arguments must be a JSON object".into());
    }
    match call.name.as_str() {
        LIST_METRICS => Ok(Call::ListMetrics),
        READ_REGISTER => {
            let metric = args.get("metric").and_then(Value::as_str).ok_or("metric is required")?;
            let bound = |name: &str| -> Result<Option<Date>, String> {
                match args.get(name) {
                    None | Some(Value::Null) => Ok(None),
                    Some(Value::String(s)) if s.is_empty() => Ok(None),
                    Some(Value::String(s)) => parse_day(s).map(Some).ok_or(format!("{name} must be YYYY-MM-DD")),
                    Some(_) => Err(format!("{name} must be YYYY-MM-DD")),
                }
            };
            let (from, to) = (bound("from")?, bound("to")?);
            if let (Some(from), Some(to)) = (from, to)
                && from > to
            {
                return Err("from must not be after to".into());
            }
            Ok(Call::ReadRegister { metric: metric.to_owned(), from, to, reason: reason_of(args) })
        }
        SESSION_CONTEXT => Ok(Call::SessionContext { reason: reason_of(args) }),
        READ_HISTORY => {
            let number = |name: &str, max: u32| -> Result<Option<u32>, String> {
                match args.get(name) {
                    None | Some(Value::Null) => Ok(None),
                    Some(v) => v
                        .as_u64()
                        .and_then(|n| u32::try_from(n).ok())
                        .filter(|n| (1..=max).contains(n))
                        .map(Some)
                        .ok_or(format!("{name} must be an integer from 1 to {max}")),
                }
            };
            let before = number("before", u32::MAX)?;
            let count = number("count", HISTORY_COUNT)?.unwrap_or(HISTORY_COUNT);
            Ok(Call::ReadHistory { before, count, reason: reason_of(args) })
        }
        READ_FILE => {
            let id = args.get("file_id").and_then(Value::as_str).ok_or("file_id is required")?;
            let file_id = id.trim().parse().map_err(|_| "file_id must be a file's id from its [file …] line")?;
            Ok(Call::ReadFile { file_id, reason: reason_of(args) })
        }
        ADD_MEASUREMENT => {
            let metric = args.get("metric").and_then(Value::as_str).ok_or("metric is required")?;
            let value = args.get("value").and_then(Value::as_number).ok_or("value must be a number")?.clone();
            let day = match args.get("day") {
                None | Some(Value::Null) => None,
                Some(Value::String(s)) if s.is_empty() => None,
                Some(Value::String(s)) => Some(parse_day(s).ok_or("day must be YYYY-MM-DD")?),
                Some(_) => return Err("day must be YYYY-MM-DD".into()),
            };
            let comment = match args.get("comment") {
                None | Some(Value::Null) => None,
                Some(Value::String(s)) => {
                    let mut text = s.trim().to_owned();
                    let end = (0..=COMMENT_MAX.min(text.len())).rev().find(|i| text.is_char_boundary(*i));
                    text.truncate(end.unwrap_or(0));
                    (!text.is_empty()).then_some(text)
                }
                Some(_) => return Err("comment must be text".into()),
            };
            Ok(Call::AddMeasurement { metric: metric.to_owned(), value, day, comment, reason: reason_of(args) })
        }
        other => Err(format!("there is no tool {other}")),
    }
}

/// The sealed content of an `add_measurement` request (docs/crypto.md, "Record contents").
pub fn proposal(call: &Call) -> Option<String> {
    let Call::AddMeasurement { value, day: when, comment, reason, .. } = call else { return None };
    let mut sealed = json!({ "reason": reason, "value": value });
    if let Some(when) = when {
        sealed["day"] = json!(day(*when));
    }
    if let Some(comment) = comment {
        sealed["comment"] = json!(comment);
    }
    Some(sealed.to_string())
}

/// Why the metric takes no such value, for the model; `None` when it does.
pub fn value_problem(metric: &chat_protocol::registers::Metric, value: &serde_json::Number) -> Option<String> {
    let number = value.as_f64()?;
    if number < metric.min || number > metric.max {
        return Some(format!("{} takes values from {} to {} {}", metric.key, metric.min, metric.max, metric.unit));
    }
    if metric.value_type == "integer" && number.fract() != 0.0 {
        return Some(format!("{} takes whole numbers", metric.key));
    }
    // As the client checks it; refused there, the model could not correct it in this turn.
    let scale = 10_f64.powi(i32::from(metric.precision));
    ((number * scale).round() - number * scale)
        .abs()
        .gt(&1e-6)
        .then(|| format!("{} takes at most {} decimal places; round the value", metric.key, metric.precision))
}

/// Seconds as `YYYY-MM-DDTHH:MM:SSZ`.
pub fn utc(seconds: i64) -> String {
    let at = OffsetDateTime::from_unix_timestamp(seconds).unwrap_or(OffsetDateTime::UNIX_EPOCH);
    format!("{}T{:02}:{:02}:{:02}Z", day(at.date()), at.hour(), at.minute(), at.second())
}

/// The widest UTC range in seconds that can hold entries of these local days:
/// offsets reach ±14 hours.
pub fn span(from: Option<Date>, to: Option<Date>) -> (Option<i64>, Option<i64>) {
    const MARGIN: i64 = 14 * 3600;
    let start = |d: Date| d.midnight().assume_utc().unix_timestamp();
    let from = from.map(|d| start(d) - MARGIN);
    let to = to.and_then(Date::next_day).map(|d| start(d) + MARGIN);
    (from, to)
}

/// `list_metrics`: the catalog in English, with the account's counts.
pub fn metrics(catalog: &MetricCatalog) -> String {
    let metrics: Vec<Value> = catalog
        .metrics
        .iter()
        .map(|m| {
            let mut entry = json!({
                "key": m.key,
                "name": m.names.get("en").unwrap_or(&m.key),
                "unit": m.unit,
                "day": if m.aggregate == "sum" { "sum of the day's entries" } else { "average of the day's entries" },
                "entries": 0,
            });
            if let Some(r) = catalog.registers.iter().find(|r| r.metric == m.key) {
                entry["entries"] = json!(r.entries);
                if let Some(latest) = r.latest_at {
                    entry["newest"] = json!(utc(latest));
                }
            }
            entry
        })
        .collect();
    json!({ "metrics": metrics }).to_string()
}

/// How many messages a client's `read_history` result holds.
pub fn history_count(result: &str) -> u32 {
    let messages = serde_json::from_str::<Value>(result).ok().and_then(|v| v.get("messages")?.as_array().map(Vec::len));
    messages.and_then(|n| u32::try_from(n).ok()).unwrap_or(0)
}

pub fn error(text: &str) -> String {
    json!({ "error": text }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(name: &str, arguments: Value) -> ToolCall {
        ToolCall { id: "c1".into(), name: name.into(), arguments }
    }

    #[test]
    fn days_are_calendar_days() {
        assert_eq!(parse_day("2026-02-28").map(day).as_deref(), Some("2026-02-28"));
        for bad in ["2026-02-30", "2026-2-28", "26-02-28", "2026-02-28T00:00", "", "2026-13-01"] {
            assert_eq!(parse_day(bad), None, "{bad}");
        }
    }

    #[test]
    fn read_register_takes_a_metric_days_and_a_reason() {
        let parsed = parse(&call(
            READ_REGISTER,
            json!({ "metric": "body.weight", "from": "2026-03-01", "to": "2026-03-31", "reason": "  Trend  " }),
        ));
        assert_eq!(
            parsed,
            Ok(Call::ReadRegister {
                metric: "body.weight".into(),
                from: parse_day("2026-03-01"),
                to: parse_day("2026-03-31"),
                reason: "Trend".into(),
            })
        );
        assert!(parse(&call(READ_REGISTER, json!({ "reason": "x" }))).is_err());
        assert!(parse(&call(READ_REGISTER, json!({ "metric": "m", "from": "March" }))).is_err());
        assert!(
            parse(&call(READ_REGISTER, json!({ "metric": "m", "from": "2026-03-02", "to": "2026-03-01" }))).is_err()
        );
        assert!(parse(&call("list_scopes", json!({}))).is_err());
        assert!(parse(&call(LIST_METRICS, json!("x"))).is_err());
    }

    #[test]
    fn read_history_takes_ids_within_bounds() {
        let parsed = parse(&call(READ_HISTORY, json!({ "before": 61, "count": 20, "reason": "Earlier plan" })));
        assert_eq!(parsed, Ok(Call::ReadHistory { before: Some(61), count: 20, reason: "Earlier plan".into() }));
        let bare = parse(&call(READ_HISTORY, json!({})));
        assert_eq!(bare, Ok(Call::ReadHistory { before: None, count: 50, reason: String::new() }));
        for bad in [json!({ "count": 51 }), json!({ "count": 0 }), json!({ "before": 0 }), json!({ "before": "61" })] {
            assert!(parse(&call(READ_HISTORY, bad.clone())).is_err(), "{bad}");
        }
        assert_eq!(specs(false, false).iter().filter(|s| s.name == READ_HISTORY).count(), 0);
        assert_eq!(specs(true, false).iter().filter(|s| s.name == READ_HISTORY).count(), 1);
    }

    #[test]
    fn read_file_takes_a_file_id() {
        let id = "01928c4e-0000-7000-8000-000000000001";
        let parsed = parse(&call(READ_FILE, json!({ "file_id": id, "reason": "The receipt" })));
        assert_eq!(parsed, Ok(Call::ReadFile { file_id: id.parse().unwrap(), reason: "The receipt".into() }));
        assert!(parse(&call(READ_FILE, json!({ "file_id": "receipt.jpg" }))).is_err());
        assert!(parse(&call(READ_FILE, json!({}))).is_err());
        assert_eq!(specs(false, false).iter().filter(|s| s.name == READ_FILE).count(), 0);
        assert_eq!(specs(false, true).iter().filter(|s| s.name == READ_FILE).count(), 1);
    }

    #[test]
    fn add_measurement_keeps_its_data_out_of_debug_and_in_the_proposal() {
        let args = json!({ "metric": "body.weight", "value": 115.5, "day": "2026-03-01", "comment": " Morning ", "reason": "You asked" });
        let parsed = parse(&call(ADD_MEASUREMENT, args)).unwrap();
        let printed = format!("{parsed:?}");
        for secret in ["115", "2026", "Morning", "asked"] {
            assert!(!printed.contains(secret), "{printed}");
        }
        let sealed: Value = serde_json::from_str(&proposal(&parsed).unwrap()).unwrap();
        assert_eq!(sealed, json!({ "reason": "You asked", "value": 115.5, "day": "2026-03-01", "comment": "Morning" }));
        let long = parse(&call(ADD_MEASUREMENT, json!({ "metric": "m", "value": 1, "comment": "й".repeat(400) })));
        let Ok(Call::AddMeasurement { comment: Some(cut), .. }) = long else { panic!("not parsed") };
        assert_eq!(cut.len(), 500);
        let bare = parse(&call(ADD_MEASUREMENT, json!({ "metric": "m", "value": 1 }))).unwrap();
        let sealed: Value = serde_json::from_str(&proposal(&bare).unwrap()).unwrap();
        assert_eq!(sealed, json!({ "reason": "", "value": 1 }));
        for bad in [
            json!({ "value": 1 }),
            json!({ "metric": "m" }),
            json!({ "metric": "m", "value": "115" }),
            json!({ "metric": "m", "value": 1, "day": "today" }),
            json!({ "metric": "m", "value": 1, "comment": 5 }),
        ] {
            assert!(parse(&call(ADD_MEASUREMENT, bad.clone())).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_long_reason_is_cut() {
        let long = "й".repeat(600);
        let Ok(Call::SessionContext { reason }) = parse(&call(SESSION_CONTEXT, json!({ "reason": long }))) else {
            panic!("not parsed");
        };
        assert_eq!(reason.chars().count(), 500);
    }

    #[test]
    fn a_span_covers_every_offset() {
        let (from, to) = span(parse_day("1970-01-02"), parse_day("1970-01-02"));
        assert_eq!(from, Some(86_400 - 14 * 3600));
        assert_eq!(to, Some(2 * 86_400 + 14 * 3600));
        assert_eq!(span(None, None), (None, None));
        assert_eq!(utc(86_400 + 3661), "1970-01-02T01:01:01Z");
    }
}
