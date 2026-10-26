//! The rich message document (D-094) and its conversion from the model's
//! Markdown. The format is docs/crypto.md, "Message documents": the server
//! writes it into a reply's last record, and the client's preview converts
//! with the same code compiled to WASM (crates/document-wasm).

mod chart;
mod markdown;

use std::fmt;

pub use markdown::from_markdown;
use serde::{Deserialize, Serialize};

/// The `v` of every document this crate writes.
pub const VERSION: u8 = 1;
/// How deep containers (lists, quotes, callouts, panels) nest.
pub const DEPTH_MAX: usize = 8;

/// Span style bits (`f`).
pub mod flag {
    pub const BOLD: u8 = 1;
    pub const ITALIC: u8 = 2;
    pub const STRIKE: u8 = 4;
    pub const CODE: u8 = 8;
}

/// The plaintext of a message: `Debug` names the shape only.
macro_rules! redacted {
    ($($name:ident),*) => {$(
        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(concat!(stringify!($name), "(<redacted>)"))
            }
        }
    )*};
}
redacted!(Document, Block, Span, Styled, Item, Chart, Series);

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct Document {
    pub v: u8,
    pub blocks: Vec<Block>,
}

impl Document {
    /// MessagePack with named fields, as the record stores it.
    pub fn encode(&self) -> Vec<u8> {
        // Strings, numbers and lists only: serializing cannot fail.
        rmp_serde::to_vec_named(self).unwrap_or_default()
    }
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(tag = "t")]
pub enum Block {
    #[serde(rename = "p")]
    Paragraph { s: Vec<Span> },
    #[serde(rename = "h")]
    Heading { level: u8, s: Vec<Span> },
    #[serde(rename = "list")]
    List {
        /// Ordered, numbered from this.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional))]
        start: Option<u32>,
        items: Vec<Item>,
    },
    #[serde(rename = "quote")]
    Quote { b: Vec<Block> },
    #[serde(rename = "callout")]
    Callout { kind: CalloutKind, b: Vec<Block> },
    /// Folded until opened; nothing in Markdown makes one.
    #[serde(rename = "panel")]
    Panel { title: Vec<Span>, b: Vec<Block> },
    #[serde(rename = "code")]
    Code {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional))]
        lang: Option<String>,
        text: String,
    },
    #[serde(rename = "table")]
    Table { align: Vec<Align>, head: Vec<Vec<Span>>, rows: Vec<Vec<Vec<Span>>> },
    #[serde(rename = "rule")]
    Rule,
    #[serde(rename = "chart")]
    Chart(Chart),
}

/// Limits of a chart (docs/crypto.md, "Message documents").
pub const SERIES_MAX: usize = 8;
pub const LABELS_MAX: usize = 1000;

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct Chart {
    pub kind: ChartKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub title: Option<String>,
    /// The axis titles.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub x: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub y: Option<String>,
    /// The points along x, or a pie's slices.
    pub labels: Vec<String>,
    pub series: Vec<Series>,
    /// What a reader that knows no charts shows: the title.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub fallback: Option<String>,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct Series {
    pub name: String,
    /// One per label; none is a gap.
    pub values: Vec<Option<f64>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum ChartKind {
    Line,
    Area,
    Bar,
    Pie,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct Item {
    pub b: Vec<Block>,
    /// A task, done or not.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub checked: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum CalloutKind {
    Note,
    Tip,
    Important,
    Warning,
    Caution,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum Align {
    #[serde(rename = "")]
    None,
    Left,
    Center,
    Right,
}

/// Text in one style: a bare string when it has none, which most text is.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(untagged)]
pub enum Span {
    Plain(String),
    Styled(Styled),
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct Styled {
    pub text: String,
    /// Style bits: 1 bold, 2 italic, 4 strikethrough, 8 code (`flag`).
    #[serde(default, skip_serializing_if = "is_zero")]
    #[cfg_attr(feature = "ts", ts(as = "Option<u8>", optional))]
    pub f: u8,
    /// Only `http`, `https` or `mailto`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub href: Option<String>,
}

fn is_zero(f: &u8) -> bool {
    *f == 0
}

impl Span {
    pub fn new(text: String, f: u8, href: Option<String>) -> Self {
        if f == 0 && href.is_none() { Self::Plain(text) } else { Self::Styled(Styled { text, f, href }) }
    }
}

/// `url` when its scheme is one a message may link to.
pub fn safe_href(url: &str) -> Option<String> {
    let (scheme, _) = url.split_once(':')?;
    ["http", "https", "mailto"].iter().any(|s| s.eq_ignore_ascii_case(scheme)).then(|| url.to_owned())
}
