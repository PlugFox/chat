#![allow(clippy::unwrap_used, reason = "test code fails loudly")]

use chat_document::{
    Align, Block, CalloutKind, Chart, ChartKind, DEPTH_MAX, Document, Item, LABELS_MAX, Series, Span, Styled, flag,
    from_markdown,
};

fn blocks(markdown: &str) -> Vec<Block> {
    let doc = from_markdown(markdown);
    assert_eq!(doc.v, 1);
    doc.blocks
}

fn plain(text: &str) -> Span {
    Span::Plain(text.to_owned())
}

fn styled(text: &str, f: u8, href: Option<&str>) -> Span {
    Span::Styled(Styled { text: text.to_owned(), f, href: href.map(str::to_owned) })
}

fn para(s: Vec<Span>) -> Block {
    Block::Paragraph { s }
}

#[test]
fn headings_paragraphs_and_styles() {
    assert_eq!(
        blocks("# Trip\n\nSee **the *sea*** and ~~not~~ `code`.\nNext line"),
        vec![
            Block::Heading { level: 1, s: vec![plain("Trip")] },
            para(vec![
                plain("See "),
                styled("the ", flag::BOLD, None),
                styled("sea", flag::BOLD | flag::ITALIC, None),
                plain(" and "),
                styled("not", flag::STRIKE, None),
                plain(" "),
                styled("code", flag::CODE, None),
                // A soft break stays a line break, as plain text showed it (D-092).
                plain(".\nNext line"),
            ]),
        ]
    );
}

#[test]
fn links_keep_only_safe_schemes() {
    assert_eq!(
        blocks("[a](https://x.org) [b](javascript:alert(1)) [c](/relative) [d](MAILTO:me@x.org)"),
        vec![para(vec![
            styled("a", 0, Some("https://x.org")),
            plain(" b c "),
            styled("d", 0, Some("MAILTO:me@x.org")),
        ])]
    );
}

#[test]
fn images_are_links_and_html_is_text() {
    assert_eq!(
        blocks(
            "![a cat](https://x.org/cat.png) ![](https://x.org/b.png)\n\n<script>alert(1)</script>\n\nhi <b>there</b>"
        ),
        vec![
            para(vec![
                styled("a cat", 0, Some("https://x.org/cat.png")),
                plain(" "),
                styled("https://x.org/b.png", 0, Some("https://x.org/b.png")),
            ]),
            para(vec![plain("<script>alert(1)</script>")]),
            para(vec![plain("hi <b>there</b>")]),
        ]
    );
}

#[test]
fn lists_tasks_and_quotes() {
    assert_eq!(
        blocks("3. one\n4. two\n   - [x] done\n   - [ ] not\n\n> said\n\n> [!WARNING]\n> careful"),
        vec![
            Block::List {
                start: Some(3),
                items: vec![
                    Item { b: vec![para(vec![plain("one")])], checked: None },
                    Item {
                        b: vec![
                            para(vec![plain("two")]),
                            Block::List {
                                start: None,
                                items: vec![
                                    Item { b: vec![para(vec![plain("done")])], checked: Some(true) },
                                    Item { b: vec![para(vec![plain("not")])], checked: Some(false) },
                                ],
                            },
                        ],
                        checked: None,
                    },
                ],
            },
            Block::Quote { b: vec![para(vec![plain("said")])] },
            Block::Callout { kind: CalloutKind::Warning, b: vec![para(vec![plain("careful")])] },
        ]
    );
}

#[test]
fn code_rules_and_tables() {
    assert_eq!(
        blocks("```rust ignore\nfn main() {}\n```\n\n---\n\n| a | b |\n|:-|-:|\n| 1 |\n| 2 | 3 | 4 |"),
        vec![
            Block::Code { lang: Some("rust".into()), text: "fn main() {}".into() },
            Block::Rule,
            Block::Table {
                align: vec![Align::Left, Align::Right],
                head: vec![vec![plain("a")], vec![plain("b")]],
                rows: vec![vec![vec![plain("1")], vec![]], vec![vec![plain("2")], vec![plain("3")]]],
            },
        ]
    );
}

#[test]
fn containers_past_the_depth_limit_are_flattened() {
    let deep = format!("{}deep", "> ".repeat(DEPTH_MAX + 5));
    let mut block = &blocks(&deep)[0];
    let mut depth = 0;
    while let Block::Quote { b } = block {
        depth += 1;
        block = &b[0];
    }
    assert_eq!(depth, DEPTH_MAX);
    assert_eq!(block, &para(vec![plain("deep")]));

    let list: String = (0..DEPTH_MAX + 5).map(|i| format!("{}- {i}\n", "  ".repeat(i))).collect();
    let doc = from_markdown(&list);
    let mut items = match &doc.blocks[0] {
        Block::List { items, .. } => items,
        _ => panic!("a list"),
    };
    let mut depth = 1;
    while let Some(Block::List { items: inner, .. }) = items[0].b.get(1) {
        depth += 1;
        items = inner;
    }
    assert_eq!(depth, DEPTH_MAX);
    // The deeper items are paragraphs of the deepest one.
    assert_eq!(items[0].b.len(), 1 + 5);
}

fn chart_block(json: &str) -> Block {
    let mut found = blocks(&format!("```chart\n{json}\n```"));
    assert_eq!(found.len(), 1);
    found.remove(0)
}

#[test]
fn chart_blocks_become_charts() {
    assert_eq!(
        chart_block(
            r#"{"kind":"line","title":"Weight","y":"kg","labels":["Mon",2026],
                "series":[{"name":"Ann","values":[81.5,null]},{"name":"Bo","values":[70,71]}],"extra":1}"#
        ),
        Block::Chart(Chart {
            kind: ChartKind::Line,
            title: Some("Weight".into()),
            x: None,
            y: Some("kg".into()),
            labels: vec!["Mon".into(), "2026".into()],
            series: vec![
                Series { name: "Ann".into(), values: vec![Some(81.5), None] },
                Series { name: "Bo".into(), values: vec![Some(70.0), Some(71.0)] },
            ],
            fallback: Some("Weight".into()),
        })
    );
    let pie = r#"{"kind":"pie","labels":["a","b"],"series":[{"name":"n","values":[1,0]}]}"#;
    assert!(matches!(chart_block(pie), Block::Chart(Chart { kind: ChartKind::Pie, fallback: None, .. })));
}

#[test]
fn charts_past_the_limits_stay_code() {
    let series = |n: usize| (0..n).map(|i| format!(r#"{{"name":"s{i}","values":[1]}}"#)).collect::<Vec<_>>().join(",");
    let many = vec!["1"; LABELS_MAX + 1].join(",");
    for json in [
        "not json".to_owned(),
        r#"{"kind":"radar","labels":["a"],"series":[{"name":"n","values":[1]}]}"#.to_owned(),
        r#"{"kind":"bar","labels":[],"series":[]}"#.to_owned(),
        r#"{"kind":"bar","labels":["a","b"],"series":[{"name":"n","values":[1]}]}"#.to_owned(),
        r#"{"kind":"bar","labels":["a"],"series":[{"name":"n","values":["1"]}]}"#.to_owned(),
        format!(r#"{{"kind":"bar","labels":["a"],"series":[{}]}}"#, series(9)),
        format!(r#"{{"kind":"bar","labels":[{many}],"series":[{{"name":"n","values":[{many}]}}]}}"#),
        format!(r#"{{"kind":"pie","labels":["a"],"series":[{}]}}"#, series(2)),
        r#"{"kind":"pie","labels":["a","b"],"series":[{"name":"n","values":[1,-1]}]}"#.to_owned(),
        r#"{"kind":"pie","labels":["1","2","3","4","5","6","7","8","9"],"series":[{"name":"n","values":[1,1,1,1,1,1,1,1,1]}]}"#.to_owned(),
    ] {
        assert_eq!(chart_block(&json), Block::Code { lang: Some("chart".into()), text: json.clone() }, "{json}");
    }
    // Not a chart fence: code, however it reads.
    let json = r#"{"kind":"bar","labels":["a"],"series":[{"name":"n","values":[1]}]}"#;
    assert_eq!(
        blocks(&format!("```json\n{json}\n```")),
        vec![Block::Code { lang: Some("json".into()), text: json.into() }]
    );
}

#[test]
fn encodes_as_the_spec_says() {
    let doc = Document { v: 1, blocks: vec![para(vec![plain("a"), styled("b", flag::BOLD, None)]), Block::Rule] };
    let value: rmpv_free::Value = rmpv_free::decode(&doc.encode());
    assert_eq!(
        value,
        rmpv_free::map(&[
            ("v", rmpv_free::Value::Int(1)),
            (
                "blocks",
                rmpv_free::Value::List(vec![
                    rmpv_free::map(&[
                        ("t", rmpv_free::Value::Str("p".into())),
                        (
                            "s",
                            rmpv_free::Value::List(vec![
                                rmpv_free::Value::Str("a".into()),
                                rmpv_free::map(&[
                                    ("text", rmpv_free::Value::Str("b".into())),
                                    ("f", rmpv_free::Value::Int(1)),
                                ]),
                            ]),
                        ),
                    ]),
                    rmpv_free::map(&[("t", rmpv_free::Value::Str("rule".into()))]),
                ]),
            ),
        ])
    );
    assert_eq!(rmp_serde::from_slice::<Document>(&doc.encode()).unwrap(), doc);
    let charts = from_markdown(
        "```chart\n{\"kind\":\"bar\",\"x\":\"Day\",\"labels\":[\"a\"],\"series\":[{\"name\":\"n\",\"values\":[1.5]}]}\n```",
    );
    assert!(matches!(charts.blocks[..], [Block::Chart(_)]));
    assert_eq!(rmp_serde::from_slice::<Document>(&charts.encode()).unwrap(), charts);
}

/// A just-enough MessagePack reader for the shape test, so the test does not
/// trust the encoder it checks.
mod rmpv_free {
    #[derive(Debug, PartialEq)]
    pub enum Value {
        Int(i64),
        Str(String),
        List(Vec<Value>),
        Map(Vec<(String, Value)>),
    }

    pub fn map(entries: &[(&str, Value)]) -> Value {
        Value::Map(entries.iter().map(|(k, v)| ((*k).to_owned(), clone(v))).collect())
    }

    fn clone(v: &Value) -> Value {
        match v {
            Value::Int(i) => Value::Int(*i),
            Value::Str(s) => Value::Str(s.clone()),
            Value::List(l) => Value::List(l.iter().map(clone).collect()),
            Value::Map(m) => Value::Map(m.iter().map(|(k, v)| (k.clone(), clone(v))).collect()),
        }
    }

    pub fn decode(bytes: &[u8]) -> Value {
        let mut at = 0;
        let v = read(bytes, &mut at);
        assert_eq!(at, bytes.len());
        v
    }

    fn read(b: &[u8], at: &mut usize) -> Value {
        let tag = b[*at];
        *at += 1;
        match tag {
            0x00..=0x7f => Value::Int(i64::from(tag)),
            0x80..=0x8f => {
                let n = usize::from(tag & 0x0f);
                Value::Map(
                    (0..n)
                        .map(|_| match read(b, at) {
                            Value::Str(k) => (k, read(b, at)),
                            other => panic!("key {other:?}"),
                        })
                        .collect(),
                )
            }
            0x90..=0x9f => Value::List((0..usize::from(tag & 0x0f)).map(|_| read(b, at)).collect()),
            0xa0..=0xbf => {
                let n = usize::from(tag & 0x1f);
                let s = std::str::from_utf8(&b[*at..*at + n]).unwrap().to_owned();
                *at += n;
                Value::Str(s)
            }
            other => panic!("tag {other:#x} not in the shape test"),
        }
    }
}
