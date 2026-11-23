//! A chat's title from the model (docs/protocol.md, "Titles"): asked in the
//! background, since a socket serves its requests one by one, and delivered
//! to the asking session as `chat.titled`. Nothing is stored: the client seals
//! the title it receives.

use std::time::Duration;

use chat_protocol::{
    chat::{ChatTitled, TurnContext},
    redact::Secret,
};
use uuid::Uuid;

use super::turn::transcript;
use crate::{
    agent::Agent,
    app::AppState,
    bus::{Note, Target},
    providers::{ChatRequest, Event, Message},
};

/// How long a title may take; after that none comes.
const LIMIT: Duration = Duration::from_secs(30);
/// The longest title passed on, in bytes.
pub const TITLE_BYTES: usize = 256;
/// Room for a model that thinks aloud before the title.
const MAX_TOKENS: u32 = 1024;

const INSTRUCTION: &str = "You name conversations between a user and an AI assistant. You get the start of \
one as a transcript. Answer with a title for it of at most six words, in the language of the conversation, \
without quotes or punctuation at the end, and nothing else.";

fn request(context: TurnContext) -> ChatRequest {
    ChatRequest {
        system: Some(INSTRUCTION.to_owned()),
        messages: vec![Message::User(transcript(context))],
        tools: Vec::new(),
        max_tokens: MAX_TOKENS,
        effort: None,
    }
}

/// The first non-empty line of `text`, trimmed, at most [`TITLE_BYTES`].
fn first_line(text: &str) -> Option<String> {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty())?;
    let mut end = line.len().min(TITLE_BYTES);
    while !line.is_char_boundary(end) {
        end -= 1;
    }
    Some(line[..end].trim_end().to_owned())
}

/// Streams the answer until its first line is complete; any error gives no title.
async fn ask(agent: &Agent, request: &ChatRequest) -> Option<String> {
    let mut events = agent.provider.stream(request).await.ok()?;
    let mut text = String::new();
    while let Some(event) = events.recv().await {
        match event.ok()? {
            Event::Text(delta) => text.push_str(&delta),
            Event::Done(_) => break,
            Event::ToolCall(_) | Event::Usage(_) => {}
        }
        let started = text.trim_start();
        if started.contains('\n') || started.len() > TITLE_BYTES {
            break;
        }
    }
    first_line(&text)
}

/// Asks for the title of `chat_id` and sends it to `session_id` when it comes.
pub fn spawn(state: &AppState, session_id: Uuid, chat_id: Uuid, agent: Agent, context: TurnContext) {
    let bus = state.bus.clone();
    let request = request(context);
    tokio::spawn(async move {
        let mut interrupted = agent.interrupted.clone();
        let title = tokio::select! {
            title = tokio::time::timeout(LIMIT, ask(&agent, &request)) => title.ok().flatten(),
            _ = interrupted.changed() => None,
        };
        if let Some(title) = title {
            let titled = ChatTitled { chat_id, title: Secret(title) };
            bus.publish(Note::event(Target::Session(session_id), &titled)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_title_is_the_first_line_cut_at_a_character() {
        assert_eq!(first_line("\n  A title  \nmore").as_deref(), Some("A title"));
        assert_eq!(first_line(" \n "), None);
        let long = "й".repeat(200);
        let cut = first_line(&long).unwrap();
        assert!(cut.len() <= TITLE_BYTES && cut.chars().all(|c| c == 'й'));
    }
}
