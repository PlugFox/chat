//! A fake LLM provider for deterministic tests (docs/brief.md §11): a real
//! HTTP server on 127.0.0.1 that answers OpenAI-compatible
//! (`/v1/chat/completions`) and Anthropic (`/v1/messages`) streaming requests
//! with scripted replies, and records every request it got.

use std::{
    collections::VecDeque,
    net::SocketAddr,
    sync::{Arc, Mutex},
};

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
};
use futures_util::StreamExt;
use serde_json::{Value, json};

/// One scripted reply.
#[derive(Clone, Debug, Default)]
pub struct Reply {
    /// Streamed as separate text deltas.
    pub text: Vec<String>,
    /// `(id, name, arguments JSON)`, streamed in two pieces each.
    pub tool_calls: Vec<(String, String, String)>,
    /// An HTTP error instead of a stream: `(status, body)`.
    pub error: Option<(u16, String)>,
    /// Keeps the stream open after the text, never finishing (OpenAI format only).
    pub hold: bool,
    /// Token counts to report: `(input, output)`.
    pub usage: Option<(u32, u32)>,
}

impl Reply {
    pub fn text(parts: &[&str]) -> Self {
        Self { text: parts.iter().map(|s| (*s).to_owned()).collect(), ..Self::default() }
    }

    /// Text that keeps streaming until the client goes away.
    pub fn endless(parts: &[&str]) -> Self {
        Self { hold: true, ..Self::text(parts) }
    }

    pub fn tool(id: &str, name: &str, arguments: &str) -> Self {
        Self { tool_calls: vec![(id.into(), name.into(), arguments.into())], ..Self::default() }
    }
}

#[derive(Clone, Debug)]
pub struct Recorded {
    pub path: String,
    pub headers: HeaderMap,
    pub body: Value,
}

#[derive(Clone, Default)]
struct Shared {
    replies: Arc<Mutex<VecDeque<Reply>>>,
    requests: Arc<Mutex<Vec<Recorded>>>,
    /// The answer to every request for a file's description, which runs
    /// beside the reply in no fixed order, so it takes no scripted reply.
    description: Arc<Mutex<Option<Reply>>>,
}

pub struct FakeLlm {
    pub addr: SocketAddr,
    shared: Shared,
}

impl FakeLlm {
    pub async fn start() -> Self {
        let shared = Shared::default();
        let app = Router::new()
            .route("/v1/chat/completions", post(openai))
            .route("/v1/messages", post(anthropic))
            .with_state(shared.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self { addr, shared }
    }

    pub fn push(&self, reply: Reply) {
        self.shared.replies.lock().unwrap().push_back(reply);
    }

    pub fn requests(&self) -> Vec<Recorded> {
        self.shared.requests.lock().unwrap().clone()
    }

    /// Requests other than descriptions, in order.
    pub fn turn_requests(&self) -> Vec<Recorded> {
        self.requests().into_iter().filter(|r| !describes(&r.body)).collect()
    }

    /// Requests for a file's description.
    pub fn description_requests(&self) -> Vec<Recorded> {
        self.requests().into_iter().filter(|r| describes(&r.body)).collect()
    }

    /// What every description request gets; without it, an error.
    pub fn describe(&self, reply: Reply) {
        *self.shared.description.lock().unwrap() = Some(reply);
    }

    /// `http://127.0.0.1:<port>/v1` for OpenAI-compatible configs.
    pub fn openai_url(&self) -> String {
        format!("http://{}/v1", self.addr)
    }

    /// `http://127.0.0.1:<port>` for Anthropic configs.
    pub fn anthropic_url(&self) -> String {
        format!("http://{}", self.addr)
    }
}

/// Whether the request asks for a file's description (its system prompt says so).
pub fn describes(body: &Value) -> bool {
    let system = body["system"].as_str().or_else(|| body["messages"][0]["content"].as_str()).unwrap_or_default();
    system.starts_with("You describe a file")
}

fn take(shared: &Shared, path: &str, headers: HeaderMap, body: Value) -> Reply {
    let description = describes(&body);
    shared.requests.lock().unwrap().push(Recorded { path: path.into(), headers, body });
    if description {
        return shared
            .description
            .lock()
            .unwrap()
            .clone()
            .unwrap_or(Reply { error: Some((500, "no description scripted".into())), ..Reply::default() });
    }
    shared.replies.lock().unwrap().pop_front().unwrap_or_else(|| Reply::text(&["(no scripted reply)"]))
}

fn sse(events: Vec<(Option<&str>, Value)>, done: bool) -> Response {
    let mut body = String::from(": fake provider\n\n");
    for (event, data) in events {
        if let Some(event) = event {
            body.push_str(&format!("event: {event}\n"));
        }
        body.push_str(&format!("data: {data}\n\n"));
    }
    if done {
        body.push_str("data: [DONE]\n\n");
    }
    ([("content-type", "text/event-stream")], body).into_response()
}

fn error(status: u16, body: String) -> Response {
    (StatusCode::from_u16(status).unwrap(), [("content-type", "application/json")], body).into_response()
}

async fn openai(State(shared): State<Shared>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    let reply = take(&shared, "/v1/chat/completions", headers, body);
    if let Some((status, body)) = reply.error {
        return error(status, body);
    }
    let chunk = |delta: Value, finish: Value| {
        (None, json!({ "choices": [{ "index": 0, "delta": delta, "finish_reason": finish }] }))
    };
    let mut events = vec![chunk(json!({ "role": "assistant" }), Value::Null)];
    for t in &reply.text {
        events.push(chunk(json!({ "content": t }), Value::Null));
    }
    for (i, (id, name, args)) in reply.tool_calls.iter().enumerate() {
        let (a, b) = args.split_at(args.len() / 2);
        events.push(chunk(
            json!({ "tool_calls": [{ "index": i, "id": id, "type": "function", "function": { "name": name, "arguments": a } }] }),
            Value::Null,
        ));
        events.push(chunk(json!({ "tool_calls": [{ "index": i, "function": { "arguments": b } }] }), Value::Null));
    }
    if reply.hold {
        let open = sse(events, false).into_body().into_data_stream().chain(futures_util::stream::pending());
        return ([("content-type", "text/event-stream")], axum::body::Body::from_stream(open)).into_response();
    }
    let finish = if reply.tool_calls.is_empty() { "stop" } else { "tool_calls" };
    events.push(chunk(json!({}), json!(finish)));
    if let Some((input, output)) = reply.usage {
        events.push((None, json!({ "choices": [], "usage": { "prompt_tokens": input, "completion_tokens": output } })));
    }
    sse(events, true)
}

async fn anthropic(State(shared): State<Shared>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    let reply = take(&shared, "/v1/messages", headers, body);
    if let Some((status, body)) = reply.error {
        return error(status, body);
    }
    let mut events = vec![(
        Some("message_start"),
        json!({ "type": "message_start", "message": {
        "id": "msg_1",
        "usage": reply.usage.map(|(input, _)| json!({ "input_tokens": 1, "cache_read_input_tokens": input - 1, "output_tokens": 1 })),
    } }),
    )];
    let mut index = 0;
    if !reply.text.is_empty() {
        events.push((
            Some("content_block_start"),
            json!({ "type": "content_block_start", "index": index, "content_block": { "type": "text", "text": "" } }),
        ));
        events.push((Some("ping"), json!({ "type": "ping" })));
        for t in &reply.text {
            events.push((
                Some("content_block_delta"),
                json!({ "type": "content_block_delta", "index": index, "delta": { "type": "text_delta", "text": t } }),
            ));
        }
        events.push((Some("content_block_stop"), json!({ "type": "content_block_stop", "index": index })));
        index += 1;
    }
    for (id, name, args) in &reply.tool_calls {
        let (a, b) = args.split_at(args.len() / 2);
        events.push((Some("content_block_start"), json!({ "type": "content_block_start", "index": index, "content_block": { "type": "tool_use", "id": id, "name": name, "input": {} } })));
        for part in [a, b] {
            events.push((Some("content_block_delta"), json!({ "type": "content_block_delta", "index": index, "delta": { "type": "input_json_delta", "partial_json": part } })));
        }
        events.push((Some("content_block_stop"), json!({ "type": "content_block_stop", "index": index })));
        index += 1;
    }
    let stop = if reply.tool_calls.is_empty() { "end_turn" } else { "tool_use" };
    events.push((
        Some("message_delta"),
        json!({
            "type": "message_delta",
            "delta": { "stop_reason": stop },
            "usage": reply.usage.map(|(_, output)| json!({ "output_tokens": output })),
        }),
    ));
    events.push((Some("message_stop"), json!({ "type": "message_stop" })));
    sse(events, false)
}
