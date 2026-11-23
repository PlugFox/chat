//! Registers (docs/protocol.md, "Registers"): the metric catalog, plaintext
//! and the same for every account, and the account's entries, whose values
//! are `register.value` records sealed by the client to the scope of each
//! metric's register, which the server stores without reading (D-097).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use crate::{Bytes, Empty, Event, Request};

/// Entries per `register.entries` page, and the default.
pub const ENTRIES_PAGE: u32 = 1000;
/// Entries an account holds at most.
pub const ENTRIES_MAX: i64 = 1_000_000;
/// The longest `register.value` record.
pub const VALUE_MAX: usize = 1024;
/// `occurred_at` bounds: 1900-01-01 and 2200-01-01, UTC.
pub const OCCURRED_MIN: i64 = -2_208_988_800;
pub const OCCURRED_MAX: i64 = 7_258_118_400;

#[derive(Debug, Default, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct MetricList {}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct MetricCategory {
    pub key: String,
    /// Locale → name.
    pub names: BTreeMap<String, String>,
}

/// A metric of the catalog: what one kind of measurement is and how a day of it adds up.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct Metric {
    /// Stable and never reused, such as `body.weight`.
    pub key: String,
    pub category: String,
    /// The register kind holding its entries: `measurements`.
    pub register: String,
    /// Locale → name.
    pub names: BTreeMap<String, String>,
    /// A metric unit: `kg`, `cm`, `count`, `kcal`.
    pub unit: String,
    /// What the unit may be converted to for display: `mass`, `length`, `count`, `energy`.
    pub quantity: String,
    /// `decimal` or `integer`.
    pub value_type: String,
    /// Decimal places.
    pub precision: u8,
    pub min: f64,
    pub max: f64,
    /// `avg` or `sum`: how a day's entries make one value.
    pub aggregate: String,
    /// Whether the entries of a day are sets of an exercise (D-128): shown
    /// with their count and the best of them, and the agent proposes several at once.
    pub sets: bool,
}

/// One of the account's registers: a metric that has a scope.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct RegisterInfo {
    pub metric: String,
    pub scope_id: Uuid,
    pub entries: i64,
    /// The `occurred_at` of the newest entry; absent without entries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub latest_at: Option<i64>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct MetricCatalog {
    /// In display order.
    pub categories: Vec<MetricCategory>,
    /// In display order.
    pub metrics: Vec<Metric>,
    pub registers: Vec<RegisterInfo>,
}

impl Request for MetricList {
    const TYPE: &'static str = "metric.list";
    type Response = MetricCatalog;
}

/// Creates the scope of a metric's register, unless the account has one.
#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct RegisterSetup {
    pub metric: String,
    pub scope_id: Uuid,
    pub public_key: Bytes,
    pub wrapped_private_key: Bytes,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct RegisterScope {
    /// The register's scope: the one sent, or the one another request created first.
    pub scope_id: Uuid,
}

impl Request for RegisterSetup {
    const TYPE: &'static str = "register.setup";
    type Response = RegisterScope;
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct RegisterEntry {
    /// Chosen by the client.
    pub entry_id: Uuid,
    pub metric: String,
    /// Seconds since the Unix epoch, UTC: the record's `period_start`.
    pub occurred_at: i64,
    /// A `register.value` record.
    pub value: Bytes,
    /// Milliseconds.
    pub updated_at: i64,
    pub rev: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct RegisterCursor {
    pub occurred_at: i64,
    pub entry_id: Uuid,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct RegisterEntries {
    pub metric: String,
    /// Inclusive, seconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub from: Option<i64>,
    /// Exclusive, seconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub to: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub before: Option<RegisterCursor>,
    /// 1 to [`ENTRIES_PAGE`]; that when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct RegisterPage {
    /// Newest first.
    pub entries: Vec<RegisterEntry>,
    /// The `before` of the next page; absent on the last.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub next: Option<RegisterCursor>,
}

impl Request for RegisterEntries {
    const TYPE: &'static str = "register.entries";
    type Response = RegisterPage;
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct RegisterCreate {
    pub entry_id: Uuid,
    pub metric: String,
    pub occurred_at: i64,
    pub value: Bytes,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct RegisterStored {
    pub entry: RegisterEntry,
}

impl Request for RegisterCreate {
    const TYPE: &'static str = "register.create";
    type Response = RegisterStored;
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct RegisterUpdate {
    pub entry_id: Uuid,
    /// The revision this change was based on.
    pub rev: i64,
    pub occurred_at: i64,
    pub value: Bytes,
}

impl Request for RegisterUpdate {
    const TYPE: &'static str = "register.update";
    type Response = RegisterStored;
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct RegisterDelete {
    pub entry_id: Uuid,
}

impl Request for RegisterDelete {
    const TYPE: &'static str = "register.delete";
    type Response = Empty;
}

/// Event to every socket of the user: an entry was created or changed.
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct RegisterUpdated {
    pub entry: RegisterEntry,
}

impl Event for RegisterUpdated {
    const TYPE: &'static str = "register.updated";
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct RegisterDeleted {
    pub entry_id: Uuid,
    pub metric: String,
}

impl Event for RegisterDeleted {
    const TYPE: &'static str = "register.deleted";
}
