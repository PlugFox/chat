//! Generates `client/src/protocol/generated/protocol.ts` from the Rust types.
//! The test fails when the file is stale; `CHAT_PROTOCOL_REGEN=1 cargo test -p
//! chat-protocol typescript` rewrites it.

#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test code fails loudly")]

use ts_rs::{Config, TS};

use crate::{
    Empty, Event, Request, SUPPORTED_VERSIONS,
    agent::{AgentProvider, AgentRetire, AgentStart, AgentStarted, AgentStop, ProviderKind, ProviderSettings},
    auth::{
        AccessGrant, AuditEntry, AuditPage, EmailStart, EmailStarted, EmailVerify, Identities, IdentityInfo, Providers,
        SessionInfo, SessionUpdate, Sessions,
    },
    chat::{
        Author, ChatArchive, ChatCompact, ChatConfigure, ChatCursor, ChatDelete, ChatDeleted, ChatInfo, ChatList,
        ChatMessage, ChatPage, ChatPin, ChatRename, ChatSettings, ChatTitle, ChatTitled, ChatUpdated, Chunk, ChunkList,
        ChunkRequest, ContextMessage, Effort, History, MessageChunks, MessageContent, MessageCreated, MessageDelete,
        MessageDeleted, MessageDelta, MessageEdit, MessageSend, MessageSent, MessageState, MessageUpdated, NewChat,
        Revision, Role, SyncReset, TurnCancel, TurnContext, TurnDone, TurnError, TurnErrorCode, TurnRetry, TurnStarted,
    },
    close::CloseCode,
    connection::{Auth, AuthOk, AuthRenew, Ping, Pong, Resume},
    error::{ErrorCode, ErrorPayload},
    keys::{
        AccountKeys, AccountScope, AccountScopeKind, KeysGet, KeysRecoveryRotate, KeysSetup, KeysState, KeysWrapAdd,
        KeysWrapRemove, NewAccountScope, ScopeKey, ScopeKeyList, ScopeKeys, StoredWrap,
    },
    link::{LinkCreate, LinkCreated, LinkGet, LinkInfo, LinkMessage, LinkPost, LinkRequester, LinkState},
    settings::{
        ProvidersValue, SettingState, SettingStored, SettingValue, SettingsGet, SettingsPut, SettingsUpdated,
        StoredProvider,
    },
};

const PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../client/src/protocol/generated/protocol.ts");

struct Out {
    cfg: Config,
    text: String,
}

impl Out {
    fn decl<T: TS>(&mut self) {
        self.text.push_str(&format!("export {}\n", T::decl(&self.cfg)));
    }

    fn event<E: Event>(&mut self) -> String {
        format!("  \"{}\": {};\n", E::TYPE, E::name(&self.cfg))
    }

    fn request<R: Request>(&mut self) -> String {
        format!(
            "  \"{}\": {{ request: {}; response: {} }};\n",
            R::TYPE,
            R::name(&self.cfg),
            R::Response::name(&self.cfg)
        )
    }
}

fn generate() -> String {
    // i64 values in the protocol are timestamps and periods, well inside 2^53.
    let mut out = Out { cfg: Config::new().with_large_int("number"), text: String::new() };
    out.text.push_str("// Generated from crates/protocol by its `typescript` test. Do not edit.\n\n");
    out.text.push_str(&format!("export const PROTOCOL_VERSION = {};\n\n", crate::PROTOCOL_VERSION));
    debug_assert_eq!(SUPPORTED_VERSIONS.last(), Some(&crate::PROTOCOL_VERSION));

    out.decl::<Empty>();
    out.decl::<ErrorCode>();
    out.decl::<ErrorPayload>();
    out.decl::<Auth>();
    out.decl::<Resume>();
    out.decl::<AuthOk>();
    out.decl::<AuthRenew>();
    out.decl::<Ping>();
    out.decl::<Pong>();

    out.text.push_str("\n// Keys (docs/protocol.md, \"Keys\")\n");
    out.decl::<AccountScopeKind>();
    out.decl::<KeysGet>();
    out.decl::<KeysState>();
    out.decl::<AccountKeys>();
    out.decl::<StoredWrap>();
    out.decl::<AccountScope>();
    out.decl::<KeysSetup>();
    out.decl::<NewAccountScope>();
    out.decl::<KeysWrapAdd>();
    out.decl::<KeysWrapRemove>();
    out.decl::<KeysRecoveryRotate>();
    out.decl::<ScopeKeys>();
    out.decl::<ScopeKeyList>();
    out.decl::<ScopeKey>();

    out.text.push_str("\n// Device linking (docs/protocol.md, \"Keys\")\n");
    out.decl::<LinkCreate>();
    out.decl::<LinkCreated>();
    out.decl::<LinkInfo>();
    out.decl::<LinkRequester>();
    out.decl::<LinkPost>();
    out.decl::<LinkGet>();
    out.decl::<LinkState>();
    out.decl::<LinkMessage>();

    out.text.push_str("\n// Agent sessions (docs/protocol.md, \"Agent sessions\")\n");
    out.decl::<ProviderKind>();
    out.decl::<ProviderSettings>();
    out.decl::<AgentStart>();
    out.decl::<AgentProvider>();
    out.decl::<AgentStarted>();
    out.decl::<AgentStop>();
    out.decl::<AgentRetire>();

    out.text.push_str("\n// Settings (docs/protocol.md, \"Settings\")\n");
    out.decl::<SettingsGet>();
    out.decl::<SettingValue>();
    out.decl::<SettingState>();
    out.decl::<SettingsPut>();
    out.decl::<SettingStored>();
    out.decl::<SettingsUpdated>();
    out.decl::<StoredProvider>();
    out.decl::<ProvidersValue>();

    out.text.push_str("\n// Chats and messages (docs/protocol.md, \"Chats and messages\")\n");
    out.decl::<Author>();
    out.decl::<MessageState>();
    out.decl::<Effort>();
    out.decl::<History>();
    out.decl::<ChatSettings>();
    out.decl::<ChatInfo>();
    out.decl::<ChatMessage>();
    out.decl::<MessageContent>();
    out.decl::<ChatCursor>();
    out.decl::<ChatList>();
    out.decl::<ChatPage>();
    out.decl::<ChatRename>();
    out.decl::<ChatPin>();
    out.decl::<ChatArchive>();
    out.decl::<ChatConfigure>();
    out.decl::<ChatDelete>();
    out.decl::<NewChat>();
    out.decl::<Role>();
    out.decl::<ContextMessage>();
    out.decl::<TurnContext>();
    out.decl::<MessageSend>();
    out.decl::<ChatCompact>();
    out.decl::<ChatTitle>();
    out.decl::<MessageSent>();
    out.decl::<ChunkRequest>();
    out.decl::<MessageChunks>();
    out.decl::<ChunkList>();
    out.decl::<Chunk>();
    out.decl::<MessageEdit>();
    out.decl::<Revision>();
    out.decl::<MessageDelete>();
    out.decl::<TurnCancel>();
    out.decl::<TurnRetry>();
    out.decl::<TurnStarted>();
    out.decl::<ChatUpdated>();
    out.decl::<ChatDeleted>();
    out.decl::<MessageCreated>();
    out.decl::<MessageUpdated>();
    out.decl::<MessageDeleted>();
    out.decl::<MessageDelta>();
    out.decl::<ChatTitled>();
    out.decl::<TurnDone>();
    out.decl::<TurnErrorCode>();
    out.decl::<TurnError>();
    out.decl::<SyncReset>();

    out.text.push_str("\n// HTTP /auth (docs/auth.md)\n");
    out.decl::<crate::auth::Provider>();
    out.decl::<Providers>();
    out.decl::<EmailStart>();
    out.decl::<EmailStarted>();
    out.decl::<EmailVerify>();
    out.decl::<AccessGrant>();
    out.decl::<SessionUpdate>();
    out.decl::<SessionInfo>();
    out.decl::<Sessions>();
    out.decl::<IdentityInfo>();
    out.decl::<Identities>();
    out.decl::<AuditEntry>();
    out.decl::<AuditPage>();

    out.text.push_str("\nexport const CloseCode = {\n");
    for code in CloseCode::ALL {
        out.text.push_str(&format!("  {code:?}: {},\n", code.code()));
    }
    out.text.push_str("} as const;\n");

    let requests = [
        out.request::<Auth>(),
        out.request::<AuthRenew>(),
        out.request::<Ping>(),
        out.request::<KeysGet>(),
        out.request::<KeysSetup>(),
        out.request::<KeysWrapAdd>(),
        out.request::<KeysWrapRemove>(),
        out.request::<KeysRecoveryRotate>(),
        out.request::<ScopeKeys>(),
        out.request::<LinkCreate>(),
        out.request::<LinkInfo>(),
        out.request::<LinkPost>(),
        out.request::<LinkGet>(),
        out.request::<AgentStart>(),
        out.request::<AgentStop>(),
        out.request::<AgentRetire>(),
        out.request::<SettingsGet>(),
        out.request::<SettingsPut>(),
        out.request::<ChatList>(),
        out.request::<ChatRename>(),
        out.request::<ChatPin>(),
        out.request::<ChatArchive>(),
        out.request::<ChatConfigure>(),
        out.request::<ChatDelete>(),
        out.request::<MessageSend>(),
        out.request::<ChatCompact>(),
        out.request::<ChatTitle>(),
        out.request::<MessageChunks>(),
        out.request::<MessageEdit>(),
        out.request::<MessageDelete>(),
        out.request::<TurnCancel>(),
        out.request::<TurnRetry>(),
    ]
    .concat();
    out.text.push_str("\n/** Every request `type` with its payload and the payload of its `ok` response. */\n");
    out.text.push_str(&format!("export type Requests = {{\n{requests}}};\n"));
    let events = [
        out.event::<LinkMessage>(),
        out.event::<SettingsUpdated>(),
        out.event::<ChatUpdated>(),
        out.event::<ChatDeleted>(),
        out.event::<MessageCreated>(),
        out.event::<MessageUpdated>(),
        out.event::<MessageDeleted>(),
        out.event::<MessageDelta>(),
        out.event::<ChatTitled>(),
        out.event::<TurnDone>(),
        out.event::<TurnError>(),
        out.event::<SyncReset>(),
    ]
    .concat();
    out.text.push_str("\n/** Every server event `type` with its payload. */\n");
    out.text.push_str(&format!("export type Events = {{\n{events}}};\n"));
    out.text
}

#[test]
fn typescript_bindings_are_fresh() {
    let generated = generate();
    if std::env::var_os("CHAT_PROTOCOL_REGEN").is_some() {
        std::fs::create_dir_all(std::path::Path::new(PATH).parent().unwrap()).unwrap();
        std::fs::write(PATH, &generated).unwrap();
        return;
    }
    let stored = std::fs::read_to_string(PATH).unwrap_or_default();
    assert!(stored == generated, "{PATH} is stale: run CHAT_PROTOCOL_REGEN=1 cargo test -p chat-protocol typescript");
}
