//! The Markdown conversion for the client's preview of a streaming reply. A
//! module of its own on the main thread, not part of the crypto worker: text
//! the server controls never reaches a parser in the memory that holds the
//! keys (D-094).

use wasm_bindgen::prelude::*;

/// The encoded document of `markdown`, as a record's `doc` holds it.
#[wasm_bindgen]
pub fn markdown(markdown: &str) -> Vec<u8> {
    chat_document::from_markdown(markdown).encode()
}
