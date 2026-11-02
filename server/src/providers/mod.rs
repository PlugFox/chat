//! LLM providers: one interface, adapters for OpenAI-compatible APIs (OpenAI,
//! Ollama, vLLM, LM Studio, many hosted ones) and Anthropic. Both stream text
//! and tool calls. Provider configs come from the client per agent session and
//! live only in memory (docs/protocol.md, "Agent sessions").

mod anthropic;
pub mod network;
mod openai;
mod sse;

use std::fmt;

use serde::Deserialize;
use tokio::sync::mpsc;

pub use network::{AddressPolicy, ProviderHttp};

/// Largest streamed response the server reads from a provider.
const MAX_RESPONSE_BYTES: usize = 16 << 20;
/// What is read of an error's body, and for how long.
const ERROR_BODY_MAX: usize = 64 << 10;
const ERROR_BODY_WAIT: std::time::Duration = std::time::Duration::from_secs(10);
/// Events buffered between the HTTP task and the agent loop.
const CHANNEL: usize = 64;

pub use chat_protocol::{agent::ProviderKind, chat::TokenUsage};

/// A user's provider config, decrypted by the client from the `settings` scope.
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderConfig {
    pub kind: ProviderKind,
    /// E.g. `https://api.openai.com/v1`, `http://192.168.1.5:11434/v1`, `https://api.anthropic.com`.
    pub base_url: String,
    /// Never logged. Empty for servers that need none (Ollama).
    #[serde(default)]
    pub api_key: String,
    pub model: String,
}

impl From<chat_protocol::agent::ProviderSettings> for ProviderConfig {
    fn from(s: chat_protocol::agent::ProviderSettings) -> Self {
        Self { kind: s.kind, base_url: s.base_url, api_key: s.api_key.0, model: s.model }
    }
}

impl fmt::Debug for ProviderConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ProviderConfig")
            .field("kind", &self.kind)
            .field("base_url", &self.base_url)
            .field("api_key", &"<redacted>")
            .field("model", &self.model)
            .finish()
    }
}

/// A tool the model may call; `parameters` is a JSON Schema object.
#[derive(Clone, Debug)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Message {
    User(String),
    /// Files of a user message, before its text or after tool results (docs/protocol.md, "Files").
    Files(Vec<FilePart>),
    Assistant {
        text: String,
        tool_calls: Vec<ToolCall>,
    },
    Tool {
        call_id: String,
        content: String,
    },
}

/// One part of a [`Message::Files`]; the bytes are shared, so a request
/// clones cheaply from round to round.
#[derive(Clone, PartialEq)]
pub enum FilePart {
    Text(String),
    Image { media_type: &'static str, data: bytes::Bytes },
    Pdf { name: String, data: bytes::Bytes },
}

/// The kind only: the content is the user's.
impl fmt::Debug for FilePart {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Text(_) => f.write_str("Text(..)"),
            Self::Image { media_type, data } => write!(f, "Image({media_type}, {})", data.len()),
            Self::Pdf { data, .. } => write!(f, "Pdf({})", data.len()),
        }
    }
}

pub(crate) fn base64(data: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(data)
}

#[derive(Clone, Debug)]
pub struct ChatRequest {
    pub system: Option<String>,
    pub messages: Vec<Message>,
    pub tools: Vec<ToolSpec>,
    pub max_tokens: u32,
    /// The reasoning effort the chat chose; absent leaves the provider's default.
    pub effort: Option<chat_protocol::chat::Effort>,
}

/// The wire name of an effort, the same for both APIs.
pub(crate) fn effort_name(effort: chat_protocol::chat::Effort) -> &'static str {
    use chat_protocol::chat::Effort;
    match effort {
        Effort::Low => "low",
        Effort::Medium => "medium",
        Effort::High => "high",
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StopReason {
    EndTurn,
    ToolUse,
    MaxTokens,
    Other,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    Text(String),
    /// A complete tool call (arguments parsed).
    ToolCall(ToolCall),
    /// This request's tokens, before `Done`, when the provider counts them.
    Usage(TokenUsage),
    Done(StopReason),
}

/// Errors carry no request content and no API key.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ProviderError {
    #[error("invalid provider config: {0}")]
    InvalidConfig(&'static str),
    #[error("the provider address is not allowed by the server's network policy")]
    Blocked,
    #[error("cannot reach the provider")]
    Network,
    #[error("the provider answered {status}: {message}")]
    Status { status: u16, message: String },
    #[error("unexpected response from the provider: {0}")]
    Protocol(&'static str),
    #[error("the provider's response is too large")]
    TooLarge,
}

impl From<reqwest::Error> for ProviderError {
    fn from(e: reqwest::Error) -> Self {
        // A blocked address surfaces as a connect error whose source is ours.
        let mut source: Option<&dyn std::error::Error> = Some(&e);
        while let Some(s) = source {
            if let Some(ProviderError::Blocked) = s.downcast_ref::<ProviderError>() {
                return Self::Blocked;
            }
            source = s.source();
        }
        Self::Network
    }
}

pub type EventStream = mpsc::Receiver<Result<Event, ProviderError>>;

/// A configured provider for one agent session.
#[derive(Clone, Debug)]
pub struct Provider {
    config: ProviderConfig,
    base: reqwest::Url,
    http: ProviderHttp,
}

impl Provider {
    pub fn new(config: ProviderConfig, http: ProviderHttp) -> Result<Self, ProviderError> {
        if config.model.trim().is_empty() {
            return Err(ProviderError::InvalidConfig("the model is empty"));
        }
        let mut base: reqwest::Url =
            config.base_url.trim().parse().map_err(|_| ProviderError::InvalidConfig("the base URL is not a URL"))?;
        // Paths are appended: `…/v1` + `/chat/completions`.
        if !base.path().ends_with('/') {
            base.set_path(&format!("{}/", base.path()));
        }
        http.for_url(&base)?;
        Ok(Self { config, base, http })
    }

    /// Starts a streamed completion. Dropping the receiver cancels the request.
    pub async fn stream(&self, request: &ChatRequest) -> Result<EventStream, ProviderError> {
        let (url, mut body, headers) = match self.config.kind {
            ProviderKind::OpenaiCompatible => openai::request(&self.base, &self.config, request)?,
            ProviderKind::Anthropic => anthropic::request(&self.base, &self.config, request)?,
        };
        let client = self.http.for_url(&url)?;
        let mut response = client.post(url.clone()).headers(headers.clone()).json(&body).send().await?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let message = error_message(&error_body(response).await);
            // A compatible server with a strict schema: usage is not worth losing the turn.
            let retry = matches!(status, 400 | 422)
                && message.contains(openai::USAGE_OPTION)
                && body.as_object_mut().and_then(|b| b.remove(openai::USAGE_OPTION)).is_some();
            if !retry {
                return Err(ProviderError::Status { status, message });
            }
            response = client.post(url).headers(headers).json(&body).send().await?;
            if !response.status().is_success() {
                let status = response.status().as_u16();
                return Err(ProviderError::Status { status, message: error_message(&error_body(response).await) });
            }
        }
        let (tx, rx) = mpsc::channel(CHANNEL);
        let kind = self.config.kind;
        tokio::spawn(async move {
            let events = sse::Reader::new(response.bytes_stream(), MAX_RESPONSE_BYTES);
            let result = match kind {
                ProviderKind::OpenaiCompatible => openai::pump(events, &tx).await,
                ProviderKind::Anthropic => anthropic::pump(events, &tx).await,
            };
            if let Err(e) = result {
                let _ = tx.send(Err(e)).await;
            }
        });
        Ok(rx)
    }
}

/// The start of an error's body: a provider at a user's address may send an
/// endless one, slowly enough that no read times out.
async fn error_body(response: reqwest::Response) -> String {
    use futures_util::StreamExt as _;
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    let read = async {
        while let Some(Ok(chunk)) = stream.next().await {
            body.extend_from_slice(&chunk[..chunk.len().min(ERROR_BODY_MAX - body.len())]);
            if body.len() == ERROR_BODY_MAX {
                break;
            }
        }
    };
    let _ = tokio::time::timeout(ERROR_BODY_WAIT, read).await;
    String::from_utf8_lossy(&body).into_owned()
}

/// The provider's own error message, if its body is the usual `{"error":{"message":…}}`, shortened.
fn error_message(body: &str) -> String {
    let parsed: Option<String> = serde_json::from_str::<serde_json::Value>(body).ok().and_then(|v| {
        v.pointer("/error/message").or_else(|| v.get("error")).and_then(|m| m.as_str()).map(str::to_owned)
    });
    let message = parsed.unwrap_or_else(|| "no details".to_owned());
    message.chars().take(300).collect()
}
