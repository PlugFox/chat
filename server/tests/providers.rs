//! Provider adapters against the fake LLM over real HTTP, and the address policy.

#![allow(clippy::unwrap_used, clippy::expect_used, reason = "tests fail loudly")]

mod support;

use chat_server::providers::{
    AddressPolicy, ChatRequest, Event, Message, Provider, ProviderConfig, ProviderError, ProviderHttp, ProviderKind,
    StopReason, ToolCall, ToolSpec,
};
use serde_json::json;
use support::fake_llm::{FakeLlm, Reply};

fn http() -> ProviderHttp {
    // The fake listens on loopback, which only an operator allowlist admits.
    ProviderHttp::new(AddressPolicy::parse("127.0.0.0/8").unwrap())
}

fn config(kind: ProviderKind, base_url: String) -> ProviderConfig {
    ProviderConfig { kind, base_url, api_key: "sk-test-secret".into(), model: "test-model".into() }
}

fn request(messages: Vec<Message>) -> ChatRequest {
    ChatRequest {
        system: Some("You are a test.".into()),
        messages,
        tools: vec![ToolSpec {
            name: "read_register".into(),
            description: "Read values".into(),
            parameters: json!({ "type": "object", "properties": { "days": { "type": "integer" } } }),
        }],
        max_tokens: 256,
        effort: None,
    }
}

async fn collect(provider: &Provider, req: &ChatRequest) -> Result<Vec<Event>, ProviderError> {
    let mut rx = provider.stream(req).await?;
    let mut events = Vec::new();
    while let Some(e) = rx.recv().await {
        events.push(e?);
    }
    Ok(events)
}

fn texts(events: &[Event]) -> String {
    events.iter().filter_map(|e| if let Event::Text(t) = e { Some(t.as_str()) } else { None }).collect()
}

#[tokio::test]
async fn openai_streams_text_and_sends_the_request_shape() {
    let fake = FakeLlm::start().await;
    fake.push(Reply::text(&["Good ", "morning"]));
    let provider = Provider::new(config(ProviderKind::OpenaiCompatible, fake.openai_url()), http()).unwrap();
    let mut req = request(vec![Message::User("Hi".into())]);
    req.effort = Some(chat_protocol::chat::Effort::High);
    let events = collect(&provider, &req).await.unwrap();
    assert_eq!(texts(&events), "Good morning");
    assert_eq!(events.last(), Some(&Event::Done(StopReason::EndTurn)));

    let sent = &fake.requests()[0];
    assert_eq!(sent.path, "/v1/chat/completions");
    assert_eq!(sent.headers["authorization"], "Bearer sk-test-secret");
    assert_eq!(sent.body["model"], "test-model");
    assert_eq!(sent.body["stream"], true);
    assert_eq!(sent.body["messages"][0], json!({ "role": "system", "content": "You are a test." }));
    assert_eq!(sent.body["messages"][1], json!({ "role": "user", "content": "Hi" }));
    assert_eq!(sent.body["tools"][0]["function"]["name"], "read_register");
    assert_eq!(sent.body["reasoning_effort"], "high");
}

#[tokio::test]
async fn openai_tool_calls_arrive_whole_and_results_go_back() {
    let fake = FakeLlm::start().await;
    fake.push(Reply::tool("call_7", "read_register", r#"{"days":7}"#));
    let provider = Provider::new(config(ProviderKind::OpenaiCompatible, fake.openai_url()), http()).unwrap();
    let events = collect(&provider, &request(vec![Message::User("Steps?".into())])).await.unwrap();
    let call = ToolCall { id: "call_7".into(), name: "read_register".into(), arguments: json!({ "days": 7 }) };
    assert_eq!(events, vec![Event::ToolCall(call.clone()), Event::Done(StopReason::ToolUse)]);

    fake.push(Reply::text(&["8 123 steps"]));
    let follow_up = request(vec![
        Message::User("Steps?".into()),
        Message::Assistant { text: String::new(), tool_calls: vec![call] },
        Message::Tool { call_id: "call_7".into(), content: r#"{"steps":8123}"#.into() },
    ]);
    collect(&provider, &follow_up).await.unwrap();
    let sent = &fake.requests()[1].body["messages"];
    assert!(fake.requests()[1].body.get("reasoning_effort").is_none());
    assert_eq!(sent[2]["tool_calls"][0]["function"]["arguments"], r#"{"days":7}"#);
    assert_eq!(sent[3], json!({ "role": "tool", "tool_call_id": "call_7", "content": r#"{"steps":8123}"# }));
}

#[tokio::test]
async fn anthropic_streams_text_and_tools_with_its_headers() {
    let fake = FakeLlm::start().await;
    fake.push(Reply {
        text: vec!["Let me ".into(), "check.".into()],
        ..Reply::tool("toolu_1", "read_register", r#"{"days":3}"#)
    });
    let provider = Provider::new(config(ProviderKind::Anthropic, fake.anthropic_url()), http()).unwrap();
    let mut req = request(vec![Message::User("Steps?".into())]);
    req.effort = Some(chat_protocol::chat::Effort::Low);
    let events = collect(&provider, &req).await.unwrap();
    assert_eq!(texts(&events), "Let me check.");
    assert!(events.contains(&Event::ToolCall(ToolCall {
        id: "toolu_1".into(),
        name: "read_register".into(),
        arguments: json!({ "days": 3 }),
    })));
    assert_eq!(events.last(), Some(&Event::Done(StopReason::ToolUse)));

    let sent = &fake.requests()[0];
    assert_eq!(sent.path, "/v1/messages");
    assert_eq!(sent.headers["x-api-key"], "sk-test-secret");
    assert_eq!(sent.headers["anthropic-version"], "2023-06-01");
    assert_eq!(sent.body["system"], "You are a test.");
    assert_eq!(sent.body["max_tokens"], 256);
    assert_eq!(sent.body["tools"][0]["input_schema"]["type"], "object");
    assert_eq!(sent.body["output_config"], json!({ "effort": "low" }));
}

#[tokio::test]
async fn anthropic_merges_consecutive_tool_results_into_one_user_turn() {
    let fake = FakeLlm::start().await;
    fake.push(Reply::text(&["ok"]));
    let provider = Provider::new(config(ProviderKind::Anthropic, fake.anthropic_url()), http()).unwrap();
    let calls = vec![
        ToolCall { id: "a".into(), name: "x".into(), arguments: json!({}) },
        ToolCall { id: "b".into(), name: "y".into(), arguments: json!({}) },
    ];
    let req = request(vec![
        Message::User("Go".into()),
        Message::Assistant { text: String::new(), tool_calls: calls },
        Message::Tool { call_id: "a".into(), content: "1".into() },
        Message::Tool { call_id: "b".into(), content: "2".into() },
    ]);
    collect(&provider, &req).await.unwrap();
    let messages = fake.requests()[0].body["messages"].as_array().unwrap().clone();
    assert_eq!(messages.len(), 3);
    assert_eq!(messages[2]["role"], "user");
    assert_eq!(messages[2]["content"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn provider_errors_carry_status_and_message() {
    let fake = FakeLlm::start().await;
    fake.push(Reply { error: Some((401, r#"{"error":{"message":"invalid api key"}}"#.into())), ..Reply::default() });
    let provider = Provider::new(config(ProviderKind::OpenaiCompatible, fake.openai_url()), http()).unwrap();
    let err = collect(&provider, &request(vec![Message::User("Hi".into())])).await.unwrap_err();
    assert_eq!(err, ProviderError::Status { status: 401, message: "invalid api key".into() });
    assert!(!format!("{:?}", config(ProviderKind::Anthropic, "x".into())).contains("sk-test-secret"));
}

#[tokio::test]
async fn loopback_is_blocked_without_an_operator_allowlist() {
    let fake = FakeLlm::start().await;
    let strict = ProviderHttp::new(AddressPolicy::default());
    // An IP literal is refused before any request…
    let literal = Provider::new(config(ProviderKind::OpenaiCompatible, fake.openai_url()), strict.clone());
    assert_eq!(literal.unwrap_err(), ProviderError::Blocked);
    // …and a name is refused by the resolver, after resolution.
    let by_name = format!("https://localhost:{}/v1", fake.addr.port());
    let provider = Provider::new(config(ProviderKind::OpenaiCompatible, by_name), strict).unwrap();
    let err = collect(&provider, &request(vec![Message::User("Hi".into())])).await.unwrap_err();
    assert_eq!(err, ProviderError::Blocked);
    assert!(fake.requests().is_empty(), "nothing reached the fake");
}
