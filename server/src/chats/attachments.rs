//! The files of a turn (docs/protocol.md, "Files"; D-101): opened with the
//! keys the client gave, turned into the parts a provider takes, and
//! described once for later turns. Their plaintext lives in the turn only.

use std::sync::Arc;

use chat_crypto::{
    ids::{FileId, ScopeId, UserId},
    os_rng,
    record::{self, Kind, Place},
    scope::ScopePublicKey,
};
use chat_protocol::{
    Bytes,
    chat::ContextMessage,
    files::{ContextFile, DESCRIPTION_MAX, FileDescribed, SentFile, TEXT_FILE_MAX},
};
use sqlx::PgPool;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::{
    bus::{Bus, Note, Target},
    files::{self, FileStore, OpenError},
    providers::{ChatRequest, Event, FilePart, Message, Provider},
};

/// A file a turn gives the model, with the key that opens it.
pub struct TurnFile {
    pub file_id: Uuid,
    pub key: Zeroizing<Vec<u8>>,
    pub name: String,
    pub media_type: String,
    /// Bytes of plaintext, as the send gave and the server checked against the object.
    pub size: u32,
}

/// Ids only: the key and the name are the user's.
impl std::fmt::Debug for TurnFile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TurnFile").field("file_id", &self.file_id).finish_non_exhaustive()
    }
}

impl From<SentFile> for TurnFile {
    fn from(file: SentFile) -> Self {
        Self {
            file_id: file.file_id,
            key: Zeroizing::new(file.key.0),
            name: file.name.0,
            media_type: file.media_type,
            size: file.size,
        }
    }
}

/// What a file holds, told by its first bytes and not by the type the client named.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Content {
    Image(&'static str),
    Pdf,
    Text,
    Unreadable,
}

pub fn sniff(data: &[u8]) -> Content {
    if data.starts_with(&[0xff, 0xd8, 0xff]) {
        Content::Image("image/jpeg")
    } else if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        Content::Image("image/png")
    } else if data.starts_with(b"%PDF-") {
        Content::Pdf
    } else if data.len() <= TEXT_FILE_MAX && std::str::from_utf8(data).is_ok() {
        Content::Text
    } else {
        Content::Unreadable
    }
}

/// The name as the model reads it: one line, without quotes that would end it.
fn label(name: &str) -> String {
    name.chars().map(|c| if c.is_control() || c == '"' { ' ' } else { c }).collect()
}

/// A file as provider parts: a line naming it, then its content.
pub fn parts(id: Uuid, name: &str, data: Vec<u8>) -> (Vec<FilePart>, Content) {
    // `read_file` knows no name: the server never keeps one in the clear.
    let name = if name.is_empty() { id.to_string() } else { label(name) };
    let content = sniff(&data);
    let head = |kind: &str| FilePart::Text(format!("[file {id}: \"{name}\", {kind}]"));
    let parts = match content {
        Content::Image(media_type) => vec![head(media_type), FilePart::Image { media_type, data: data.into() }],
        Content::Pdf => vec![head("application/pdf"), FilePart::Pdf { name, data: data.into() }],
        Content::Text => {
            let text = String::from_utf8(data).unwrap_or_default();
            vec![FilePart::Text(format!("<file id=\"{id}\" name=\"{name}\">\n{text}\n</file>"))]
        }
        Content::Unreadable => vec![FilePart::Text(format!("[file {id}: \"{name}\" could not be read]"))],
    };
    (parts, content)
}

/// Bytes of file content a part gives the model, against the turn's limit.
pub fn part_bytes(part: &FilePart) -> u64 {
    let len = match part {
        FilePart::Text(text) => text.len(),
        FilePart::Image { data, .. } | FilePart::Pdf { data, .. } => data.len(),
    };
    u64::try_from(len).unwrap_or(u64::MAX)
}

/// A file that would not open: the model hears so in its place.
pub fn missing(id: Uuid, name: &str, why: &OpenError) -> FilePart {
    let why = match why {
        OpenError::Store => "is not available now",
        OpenError::Decrypt => "could not be opened",
    };
    FilePart::Text(format!("[file {id}: \"{}\" {why}]", label(name)))
}

/// A context message's files as lines after its text, in place of the files.
pub fn context_text(message: &ContextMessage) -> String {
    let mut text = message.text.0.clone();
    for file in &message.files {
        text.push_str(&format!("\n\n{}", line(file)));
    }
    text
}

fn line(file: &ContextFile) -> String {
    let size = match (file.w, file.h) {
        (Some(w), Some(h)) => format!(", {w}×{h} px"),
        _ => String::new(),
    };
    let about = file.description.as_ref().map_or("no description", |d| d.0.as_str());
    format!(
        "[file {}: \"{}\", {}{size}, {} bytes. {about}]",
        file.file_id,
        label(&file.name.0),
        file.media_type,
        file.size
    )
}

/// How the model is asked to describe a file.
const DESCRIBE: &str = "You describe a file the user attached to a conversation, so that later turns can \
answer from your description without the file. Say what it is and what it shows; write out any text in it, \
and the figures, names, dates and details a later question may need. Be factual and complete, without a \
preamble or advice, in at most 250 words, in the language of the file's text or else in English.";

/// Asks the model for a description of one file and stores it sealed to
/// the chat; nothing is stored when the model fails.
pub struct Describe {
    pub db: PgPool,
    pub bus: Bus,
    pub provider: Arc<Provider>,
    pub user_id: Uuid,
    pub chat_id: Uuid,
    pub key: ScopePublicKey,
    pub file_id: Uuid,
    pub parts: Vec<FilePart>,
}

impl Describe {
    pub async fn run(self) {
        let request = ChatRequest {
            system: Some(DESCRIBE.to_owned()),
            messages: vec![Message::Files(self.parts), Message::User("Describe this file.".into())],
            tools: Vec::new(),
            max_tokens: 1024,
            effort: None,
        };
        let mut text = String::new();
        let Ok(mut stream) = self.provider.stream(&request).await else { return };
        while let Some(event) = stream.recv().await {
            match event {
                Ok(Event::Text(delta)) => text.push_str(&delta),
                Ok(Event::Done(_)) => break,
                Ok(Event::ToolCall(_)) => {}
                Err(_) => return,
            }
        }
        let text = cut(text.trim(), DESCRIPTION_MAX);
        if text.is_empty() {
            return;
        }
        let place = Place {
            user: UserId::from_bytes(*self.user_id.as_bytes()),
            scope: ScopeId::from_bytes(*self.chat_id.as_bytes()),
            kind: Kind::FileDescription { file_id: FileId::from_bytes(*self.file_id.as_bytes()) },
        };
        let Ok(sealed) = record::seal_as_server(&place, &self.key, text.as_bytes(), &mut os_rng()) else { return };
        match files::describe(&self.db, self.file_id, &sealed).await {
            Ok(true) => {
                let event = FileDescribed { chat_id: self.chat_id, file_id: self.file_id, description: Bytes(sealed) };
                self.bus.publish(Note::event(Target::User(self.user_id), &event)).await;
            }
            Ok(false) => {}
            Err(e) => tracing::error!(error = %e, "cannot store a file description"),
        }
    }
}

/// At most `max` bytes, cut at a character boundary.
fn cut(text: &str, max: usize) -> &str {
    let mut end = text.len().min(max);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// Opens the turn's files; a file that fails is a note in its place.
pub async fn open_all(
    store: &FileStore,
    user_id: Uuid,
    turn_files: &[TurnFile],
) -> Vec<(Uuid, Vec<FilePart>, Content)> {
    let mut opened = Vec::with_capacity(turn_files.len());
    for file in turn_files {
        match files::open(store, user_id, file.file_id, &file.key, file.size).await {
            Ok(data) => {
                let (parts, content) = parts(file.file_id, &file.name, data);
                opened.push((file.file_id, parts, content));
            }
            Err(e) => opened.push((file.file_id, vec![missing(file.file_id, &file.name, &e)], Content::Unreadable)),
        }
    }
    opened
}

#[cfg(test)]
mod tests {
    use chat_protocol::{chat::Role, redact::Secret};

    use super::*;

    #[test]
    fn the_content_decides_the_part_not_the_name() {
        let id = Uuid::from_u128(1);
        let (image, content) = parts(id, "cat.png", vec![0xff, 0xd8, 0xff, 0xe0]);
        assert_eq!(content, Content::Image("image/jpeg"));
        assert!(matches!(&image[1], FilePart::Image { media_type: "image/jpeg", .. }));
        let (_, content) = parts(id, "doc", b"%PDF-1.7 ...".to_vec());
        assert_eq!(content, Content::Pdf);
        let (text, content) = parts(id, "a\"b\nc.txt", b"hello".to_vec());
        assert_eq!(content, Content::Text);
        let FilePart::Text(text) = &text[0] else { panic!("text") };
        assert!(text.starts_with("<file id=\"00000000-0000-0000-0000-000000000001\" name=\"a b c.txt\">\nhello"));
        assert_eq!(sniff(&[0xc3, 0x28]), Content::Unreadable);
        assert_eq!(sniff(&vec![b'a'; TEXT_FILE_MAX + 1]), Content::Unreadable);
    }

    #[test]
    fn context_files_become_lines() {
        let file = ContextFile {
            file_id: Uuid::from_u128(2),
            name: Secret("receipt.jpg".into()),
            media_type: "image/jpeg".into(),
            size: 1234,
            w: Some(2000),
            h: Some(1500),
            description: Some(Secret("A grocery receipt, total 12.40.".into())),
        };
        let message = ContextMessage { id: 3, role: Role::User, text: Secret("See this".into()), files: vec![file] };
        assert_eq!(
            context_text(&message),
            "See this\n\n[file 00000000-0000-0000-0000-000000000002: \"receipt.jpg\", image/jpeg, 2000×1500 px, \
             1234 bytes. A grocery receipt, total 12.40.]"
        );
        assert_eq!(cut("ййй", 5), "йй");
    }
}
