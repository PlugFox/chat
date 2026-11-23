//! A chart from the JSON of a fenced `chart` code block. Anything that does
//! not read or breaks a limit is `None`, and the block stays code. A pie's
//! slices take the series colors, so it has no more of them than series.

use serde::Deserialize;

use crate::{Chart, ChartKind, LABELS_MAX, SERIES_MAX, Series};

#[derive(Deserialize)]
struct Source {
    kind: ChartKind,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    x: Option<String>,
    #[serde(default)]
    y: Option<String>,
    labels: Vec<Label>,
    series: Vec<Series>,
}

/// Models write years and other numbers as labels too.
#[derive(Deserialize)]
#[serde(untagged)]
enum Label {
    Text(String),
    Number(serde_json::Number),
}

pub fn from_json(json: &str) -> Option<Chart> {
    let source: Source = serde_json::from_str(json).ok()?;
    let labels: Vec<String> = source
        .labels
        .into_iter()
        .map(|l| match l {
            Label::Text(text) => text,
            Label::Number(n) => n.to_string(),
        })
        .collect();
    let series = source.series;
    let fits = (1..=LABELS_MAX).contains(&labels.len())
        && (1..=SERIES_MAX).contains(&series.len())
        && series.iter().all(|s| s.values.len() == labels.len());
    let pie = source.kind != ChartKind::Pie
        || (series.len() == 1
            && labels.len() <= SERIES_MAX
            && series.iter().flat_map(|s| &s.values).flatten().all(|v| *v >= 0.0));
    (fits && pie).then(|| Chart {
        kind: source.kind,
        fallback: source.title.clone(),
        title: source.title,
        x: source.x,
        y: source.y,
        labels,
        series,
    })
}
