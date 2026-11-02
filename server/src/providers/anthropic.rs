//! Anthropic Messages API with streaming (`/v1/messages`).

use std::collections::BTreeMap;

use bytes::Bytes;
use futures_util::Stream;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::{
    ChatRequest, Event, FilePart, Message, ProviderConfig, ProviderError, StopReason, TokenUsage, ToolCall, base64, sse,
};

const API_VERSION: &str = "2023-06-01";

/// Anthropic content blocks of one message.
fn blocks(m: &Message) -> (&'static str, Vec<Value>) {
    match m {
        Message::User(text) => ("user", vec![json!({ "type": "text", "text": text })]),
        Message::Files(files) => (
            "user",
            files
                .iter()
                .map(|part| match part {
                    FilePart::Text(text) => json!({ "type": "text", "text": text }),
                    FilePart::Image { media_type, data } => json!({
                        "type": "image",
                        "source": { "type": "base64", "media_type": media_type, "data": base64(data) },
                    }),
                    FilePart::Pdf { name, data } => json!({
                        "type": "document",
                        "source": { "type": "base64", "media_type": "application/pdf", "data": base64(data) },
                        "title": name,
                    }),
                })
                .collect(),
        ),
        Message::Assistant { text, tool_calls } => {
            let mut content = Vec::new();
            if !text.is_empty() {
                content.push(json!({ "type": "text", "text": text }));
            }
            for c in tool_calls {
                content.push(json!({ "type": "tool_use", "id": c.id, "name": c.name, "input": c.arguments }));
            }
            ("assistant", content)
        }
        Message::Tool { call_id, content } => {
            ("user", vec![json!({ "type": "tool_result", "tool_use_id": call_id, "content": content })])
        }
    }
}

pub(super) fn request(
    base: &reqwest::Url,
    config: &ProviderConfig,
    req: &ChatRequest,
) -> Result<(reqwest::Url, Value, HeaderMap), ProviderError> {
    let url = base.join("v1/messages").map_err(|_| ProviderError::InvalidConfig("the base URL is not a URL"))?;
    // Roles must alternate: consecutive messages of one role (tool results after
    // a multi-call turn) merge into one message.
    let mut messages: Vec<(&str, Vec<Value>)> = Vec::new();
    for m in &req.messages {
        let (role, content) = blocks(m);
        match messages.last_mut() {
            Some((last, blocks)) if *last == role => blocks.extend(content),
            _ => messages.push((role, content)),
        }
    }
    let mut body = json!({
        "model": config.model,
        "max_tokens": req.max_tokens,
        "stream": true,
        "messages": messages.into_iter().map(|(role, content)| json!({ "role": role, "content": content })).collect::<Vec<_>>(),
    });
    if let Some(system) = &req.system {
        body["system"] = Value::String(system.clone());
    }
    if let Some(effort) = req.effort {
        body["output_config"] = json!({ "effort": super::effort_name(effort) });
    }
    if !req.tools.is_empty() {
        body["tools"] = req
            .tools
            .iter()
            .map(|t| json!({ "name": t.name, "description": t.description, "input_schema": t.parameters }))
            .collect();
    }
    let mut headers = HeaderMap::new();
    let mut key = HeaderValue::from_str(&config.api_key)
        .map_err(|_| ProviderError::InvalidConfig("the API key has invalid characters"))?;
    key.set_sensitive(true);
    headers.insert(HeaderName::from_static("x-api-key"), key);
    headers.insert(HeaderName::from_static("anthropic-version"), HeaderValue::from_static(API_VERSION));
    Ok((url, body, headers))
}

struct ToolBlock {
    id: String,
    name: String,
    json: String,
}

fn count(usage: &Value, field: &str) -> u32 {
    usage.get(field).and_then(Value::as_u64).map_or(0, |n| u32::try_from(n).unwrap_or(u32::MAX))
}

fn stop_reason(reason: &str) -> StopReason {
    match reason {
        "end_turn" | "stop_sequence" => StopReason::EndTurn,
        "tool_use" => StopReason::ToolUse,
        "max_tokens" => StopReason::MaxTokens,
        _ => StopReason::Other,
    }
}

pub(super) async fn pump<S, E>(
    mut events: sse::Reader<S>,
    tx: &mpsc::Sender<Result<Event, ProviderError>>,
) -> Result<(), ProviderError>
where
    S: Stream<Item = Result<Bytes, E>> + Unpin,
{
    let send = |e: Event| async { tx.send(Ok(e)).await.map_err(|_| ProviderError::Network) };
    let mut tools: BTreeMap<u64, ToolBlock> = BTreeMap::new();
    let mut finish: Option<StopReason> = None;
    let mut usage: Option<TokenUsage> = None;
    while let Some(event) = events.next().await? {
        let data: Value = match event.event.as_deref() {
            Some("ping") | None if event.data.is_empty() => continue,
            _ => serde_json::from_str(&event.data).map_err(|_| ProviderError::Protocol("an event is not JSON"))?,
        };
        let index = data.get("index").and_then(Value::as_u64).unwrap_or(0);
        match data.get("type").and_then(Value::as_str).unwrap_or_default() {
            // A cached prompt is counted apart from `input_tokens`, and is still context.
            "message_start" => {
                if let Some(counted) = data.pointer("/message/usage") {
                    let input = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]
                        .iter()
                        .fold(0, |sum: u32, field| sum.saturating_add(count(counted, field)));
                    usage = Some(TokenUsage { input, output: count(counted, "output_tokens") });
                }
            }
            "content_block_start" => {
                let block = &data["content_block"];
                if block["type"] == "tool_use" {
                    let field = |k: &str| block[k].as_str().unwrap_or_default().to_owned();
                    tools.insert(index, ToolBlock { id: field("id"), name: field("name"), json: String::new() });
                }
            }
            "content_block_delta" => {
                let delta = &data["delta"];
                match delta["type"].as_str() {
                    Some("text_delta") => {
                        if let Some(text) = delta["text"].as_str().filter(|t| !t.is_empty()) {
                            send(Event::Text(text.to_owned())).await?;
                        }
                    }
                    Some("input_json_delta") => {
                        if let (Some(tool), Some(part)) = (tools.get_mut(&index), delta["partial_json"].as_str()) {
                            tool.json.push_str(part);
                        }
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {
                if let Some(tool) = tools.remove(&index) {
                    let arguments = if tool.json.trim().is_empty() {
                        json!({})
                    } else {
                        serde_json::from_str(&tool.json)
                            .map_err(|_| ProviderError::Protocol("tool input is not JSON"))?
                    };
                    send(Event::ToolCall(ToolCall { id: tool.id, name: tool.name, arguments })).await?;
                }
            }
            "message_delta" => {
                if let Some(reason) = data.pointer("/delta/stop_reason").and_then(Value::as_str) {
                    finish = Some(stop_reason(reason));
                }
                // Already the total for the message, not an increment.
                if let Some(counted) = data.get("usage") {
                    usage.get_or_insert_default().output = count(counted, "output_tokens");
                }
            }
            "message_stop" => break,
            "error" => {
                let message = data.pointer("/error/message").and_then(Value::as_str).unwrap_or("stream error");
                return Err(ProviderError::Status { status: 200, message: message.chars().take(300).collect() });
            }
            _ => {}
        }
    }
    if let Some(usage) = usage {
        send(Event::Usage(usage)).await?;
    }
    send(Event::Done(finish.ok_or(ProviderError::Protocol("the stream ended without a stop reason"))?)).await
}
