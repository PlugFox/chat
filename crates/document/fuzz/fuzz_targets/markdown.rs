//! Markdown conversion of arbitrary text: never panics, keeps the depth limit.
#![no_main]

use chat_document::{Block, DEPTH_MAX, from_markdown};
use libfuzzer_sys::fuzz_target;

fn depth(blocks: &[Block]) -> usize {
    blocks
        .iter()
        .map(|block| match block {
            Block::Quote { b } | Block::Callout { b, .. } | Block::Panel { b, .. } => 1 + depth(b),
            Block::List { items, .. } => 1 + items.iter().map(|i| depth(&i.b)).max().unwrap_or(0),
            _ => 0,
        })
        .max()
        .unwrap_or(0)
}

fuzz_target!(|data: &[u8]| {
    if let Ok(text) = std::str::from_utf8(data) {
        let doc = from_markdown(text);
        assert!(depth(&doc.blocks) <= DEPTH_MAX);
        let _ = doc.encode();
    }
});
