//! OpenAI-compatible Chat Completions with streaming (`/chat/completions`):
//! OpenAI, Ollama, vLLM, LM Studio and most hosted gateways.

use std::collections::BTreeMap;

use bytes::Bytes;
use futures_util::Stream;
use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderValue};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::{ChatRequest, Event, Message, ProviderConfig, ProviderError, StopReason, ToolCall, sse};

pub(super) fn request(
    base: &reqwest::Url,
    config: &ProviderConfig,
    req: &ChatRequest,
) -> Result<(reqwest::Url, Value, HeaderMap), ProviderError> {
    let url = base.join("chat/completions").map_err(|_| ProviderError::InvalidConfig("the base URL is not a URL"))?;
    let mut messages = Vec::new();
    if let Some(system) = &req.system {
        messages.push(json!({ "role": "system", "content": system }));
    }
    for m in &req.messages {
        messages.push(match m {
            Message::User(text) => json!({ "role": "user", "content": text }),
            Message::Assistant { text, tool_calls } if tool_calls.is_empty() => {
                json!({ "role": "assistant", "content": text })
            }
            Message::Assistant { text, tool_calls } => json!({
                "role": "assistant",
                "content": if text.is_empty() { Value::Null } else { Value::String(text.clone()) },
                "tool_calls": tool_calls.iter().map(|c| json!({
                    "id": c.id,
                    "type": "function",
                    "function": { "name": c.name, "arguments": c.arguments.to_string() },
                })).collect::<Vec<_>>(),
            }),
            Message::Tool { call_id, content } => {
                json!({ "role": "tool", "tool_call_id": call_id, "content": content })
            }
        });
    }
    let mut body = json!({ "model": config.model, "stream": true, "messages": messages, "max_tokens": req.max_tokens });
    if let Some(effort) = req.effort {
        body["reasoning_effort"] = Value::String(super::effort_name(effort).to_owned());
    }
    if !req.tools.is_empty() {
        body["tools"] = req
            .tools
            .iter()
            .map(|t| json!({ "type": "function", "function": { "name": t.name, "description": t.description, "parameters": t.parameters } }))
            .collect();
    }
    let mut headers = HeaderMap::new();
    if !config.api_key.is_empty() {
        let mut value = HeaderValue::from_str(&format!("Bearer {}", config.api_key))
            .map_err(|_| ProviderError::InvalidConfig("the API key has invalid characters"))?;
        value.set_sensitive(true);
        headers.insert(AUTHORIZATION, value);
    }
    Ok((url, body, headers))
}

#[derive(Default)]
struct PartialCall {
    id: String,
    name: String,
    arguments: String,
}

fn stop_reason(finish: &str) -> StopReason {
    match finish {
        "stop" => StopReason::EndTurn,
        "tool_calls" | "function_call" => StopReason::ToolUse,
        "length" => StopReason::MaxTokens,
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
    // Tool calls arrive in pieces keyed by index; they are complete at the finish reason.
    let mut calls: BTreeMap<u64, PartialCall> = BTreeMap::new();
    let mut finish: Option<StopReason> = None;
    while let Some(event) = events.next().await? {
        if event.data == "[DONE]" {
            break;
        }
        let chunk: Value =
            serde_json::from_str(&event.data).map_err(|_| ProviderError::Protocol("a chunk is not JSON"))?;
        if let Some(message) = chunk.pointer("/error/message").and_then(Value::as_str) {
            return Err(ProviderError::Status { status: 200, message: message.chars().take(300).collect() });
        }
        let Some(choice) = chunk.pointer("/choices/0") else { continue };
        if let Some(text) = choice.pointer("/delta/content").and_then(Value::as_str)
            && !text.is_empty()
        {
            send(Event::Text(text.to_owned())).await?;
        }
        if let Some(deltas) = choice.pointer("/delta/tool_calls").and_then(Value::as_array) {
            for d in deltas {
                let index = d.get("index").and_then(Value::as_u64).unwrap_or(0);
                let call = calls.entry(index).or_default();
                if let Some(id) = d.get("id").and_then(Value::as_str) {
                    call.id = id.to_owned();
                }
                if let Some(name) = d.pointer("/function/name").and_then(Value::as_str) {
                    call.name.push_str(name);
                }
                if let Some(args) = d.pointer("/function/arguments").and_then(Value::as_str) {
                    call.arguments.push_str(args);
                }
            }
        }
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            finish = Some(stop_reason(reason));
        }
    }
    for (index, call) in calls {
        let arguments = if call.arguments.trim().is_empty() {
            json!({})
        } else {
            serde_json::from_str(&call.arguments)
                .map_err(|_| ProviderError::Protocol("tool call arguments are not JSON"))?
        };
        // Some servers omit ids; the agent loop needs one to pair the result.
        let id = if call.id.is_empty() { format!("call_{index}") } else { call.id };
        send(Event::ToolCall(ToolCall { id, name: call.name, arguments })).await?;
    }
    send(Event::Done(finish.ok_or(ProviderError::Protocol("the stream ended without a finish reason"))?)).await
}
