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
/// Events buffered between the HTTP task and the agent loop.
const CHANNEL: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    OpenaiCompatible,
    Anthropic,
}

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
    Assistant { text: String, tool_calls: Vec<ToolCall> },
    Tool { call_id: String, content: String },
}

#[derive(Clone, Debug)]
pub struct ChatRequest {
    pub system: Option<String>,
    pub messages: Vec<Message>,
    pub tools: Vec<ToolSpec>,
    pub max_tokens: u32,
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
        let (url, body, headers) = match self.config.kind {
            ProviderKind::OpenaiCompatible => openai::request(&self.base, &self.config, request)?,
            ProviderKind::Anthropic => anthropic::request(&self.base, &self.config, request)?,
        };
        let client = self.http.for_url(&url)?;
        let response = client.post(url).headers(headers).json(&body).send().await?;
        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            return Err(ProviderError::Status { status: status.as_u16(), message: error_message(&text) });
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

/// The provider's own error message, if its body is the usual `{"error":{"message":…}}`, shortened.
fn error_message(body: &str) -> String {
    let parsed: Option<String> = serde_json::from_str::<serde_json::Value>(body).ok().and_then(|v| {
        v.pointer("/error/message").or_else(|| v.get("error")).and_then(|m| m.as_str()).map(str::to_owned)
    });
    let message = parsed.unwrap_or_else(|| "no details".to_owned());
    message.chars().take(300).collect()
}
