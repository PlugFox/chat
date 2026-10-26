// Generated from crates/protocol by its `typescript` test. Do not edit.

export const PROTOCOL_VERSION = 1;

export type Empty = Record<symbol, never>;
export type ErrorCode = "protocol.malformed" | "protocol.unknown_type" | "protocol.missing_id" | "auth.already_authenticated" | "auth.invalid_token" | "auth.session_mismatch" | "auth.unavailable" | "auth.origin" | "auth.signed_out" | "auth.reauth_required" | "auth.provider_disabled" | "auth.invalid_email" | "auth.code_invalid" | "auth.code_expired" | "auth.signup_closed" | "auth.email_unverified" | "identity.in_use" | "identity.last" | "keys.not_set_up" | "keys.exists" | "keys.invalid" | "keys.limit" | "keys.device_mismatch" | "keys.recovery_required" | "link.not_found" | "link.used" | "agent.invalid_provider" | "agent.not_started" | "settings.conflict" | "settings.limit" | "chat.not_found" | "chat.exists" | "chat.archived" | "chat.not_archived" | "message.not_found" | "message.not_editable" | "message.not_retryable" | "message.streaming" | "message.too_large" | "turn.busy" | "not_found" | "rate_limited" | "unavailable" | "internal";
export type ErrorPayload = { code: ErrorCode, 
/**
 * For logs and developers; never shown to users and never contains user content.
 */
message: string, retry: boolean, };
export type Auth = { 
/**
 * The protocol version the client speaks.
 */
v: number, access_token: string, resume?: Resume, };
export type Resume = { agent_session_id: string, };
export type AuthOk = { session_id: string, 
/**
 * How often the client sends `ping`.
 */
heartbeat_ms: number, 
/**
 * Server clock, milliseconds since the Unix epoch.
 */
server_time: number, 
/**
 * The agent session `resume` picked up.
 */
agent_session_id?: string, };
export type AuthRenew = { access_token: string, };
export type Ping = Record<symbol, never>;
export type Pong = { 
/**
 * Server clock, milliseconds since the Unix epoch.
 */
server_time: number, };

// Keys (docs/protocol.md, "Keys")
export type AccountScopeKind = "settings" | "audit" | "profile:basics" | "profile:medical" | "profile:lifestyle";
export type KeysGet = Record<symbol, never>;
export type KeysState = { 
/**
 * Absent before key setup.
 */
keys?: AccountKeys, };
export type AccountKeys = { commitment: Uint8Array, writer_public_key: Uint8Array, 
/**
 * Passkey and recovery wraps, and this session's device wrap if any.
 */
wraps: Array<StoredWrap>, scopes: Array<AccountScope>, };
export type StoredWrap = { wrap: Uint8Array, 
/**
 * Milliseconds since the Unix epoch.
 */
created_at: number, };
export type AccountScope = { scope_id: string, kind: AccountScopeKind, };
export type KeysSetup = { commitment: Uint8Array, writer_public_key: Uint8Array, 
/**
 * One recovery wrap and any passkey wraps.
 */
wraps: Array<Uint8Array>, scopes: Array<NewAccountScope>, };
export type NewAccountScope = { scope_id: string, kind: AccountScopeKind, public_key: Uint8Array, wrapped_private_key: Uint8Array, };
export type KeysWrapAdd = { wrap: Uint8Array, };
export type KeysWrapRemove = { wrap_id: string, };
export type KeysRecoveryRotate = { wrap: Uint8Array, };
export type ScopeKeys = { scope_ids: Array<string>, };
export type ScopeKeyList = { 
/**
 * Every key version of the requested scopes the user owns; unknown ids are left out.
 */
keys: Array<ScopeKey>, };
export type ScopeKey = { scope_id: string, key_version: number, public_key: Uint8Array, wrapped_private_key: Uint8Array, };

// Device linking (docs/protocol.md, "Keys")
export type LinkCreate = Record<symbol, never>;
export type LinkCreated = { sid: string, 
/**
 * How long the link lives, from now: a duration, so a client with a wrong
 * clock still renews its code in time.
 */
expires_in_ms: number, };
export type LinkInfo = { sid: string, };
export type LinkRequester = { 
/**
 * When the link was created, in milliseconds.
 */
created_at: number, user_agent?: string, country?: string, };
export type LinkPost = { sid: string, message: Uint8Array, };
export type LinkGet = { sid: string, };
export type LinkState = { 
/**
 * Absent until the unlocked device posted it.
 */
message?: Uint8Array, };
export type LinkMessage = { sid: string, message: Uint8Array, };

// Agent sessions (docs/protocol.md, "Agent sessions")
export type ProviderKind = "openai_compatible" | "anthropic";
export type ProviderSettings = { kind: ProviderKind, base_url: string, 
/**
 * Empty for servers that need none (Ollama).
 */
api_key: string, model: string, };
export type AgentStart = { providers: Array<AgentProvider>, 
/**
 * The id of the provider a chat that names none runs with.
 */
active: string, };
export type AgentProvider = { id: string, kind: ProviderKind, base_url: string, api_key: string, model: string, };
export type AgentStarted = { agent_session_id: string, };
export type AgentStop = Record<symbol, never>;
export type AgentRetire = { fingerprints: Array<Uint8Array>, };

// Settings (docs/protocol.md, "Settings")
export type SettingsGet = { key: string, };
export type SettingValue = { record: Uint8Array, rev: number, };
export type SettingState = { 
/**
 * Absent for a key never put.
 */
value?: SettingValue, };
export type SettingsPut = { key: string, record: Uint8Array, 
/**
 * The revision this change was based on; absent for a new key.
 */
rev?: number, };
export type SettingStored = { rev: number, };
export type SettingsUpdated = { key: string, record: Uint8Array, rev: number, };
export type StoredProvider = { id: string, name: string, kind: ProviderKind, base_url: string, 
/**
 * Empty for servers that need none (Ollama).
 */
api_key: string, model: string, };
export type ProvidersValue = { providers: Array<StoredProvider>, 
/**
 * The provider turns use.
 */
active?: string, };

// Chats and messages (docs/protocol.md, "Chats and messages")
export type Author = "user" | "assistant" | "tool" | "summary";
export type MessageState = "complete" | "streaming" | "cancelled" | "failed";
export type Effort = "low" | "medium" | "high";
export type History = { "mode": "recent", messages: number, } | { "mode": "compact", };
export type ChatSettings = { 
/**
 * The id of an entry of the `providers` setting.
 */
provider?: string, effort?: Effort, history?: History, };
export type ChatInfo = { 
/**
 * The chat's scope id.
 */
chat_id: string, 
/**
 * A `chat.title` record.
 */
title?: Uint8Array, created_at: number, 
/**
 * When the last message was created, in milliseconds.
 */
updated_at: number, last_message_id: number, rev: number, 
/**
 * A turn is running.
 */
turn: boolean, 
/**
 * The position among the pinned chats, from 0.
 */
pin?: number, archived_at?: number, settings: ChatSettings, };
export type ChatMessage = { id: number, author: Author, created_at: number, edited_at?: number, deleted_at?: number, state: MessageState, rev: number, 
/**
 * A `chat.message` record; absent on a tombstone.
 */
record?: Uint8Array, 
/**
 * The last delta a streaming snapshot includes.
 */
seq?: number, 
/**
 * Why a `failed` reply failed.
 */
error?: TurnErrorCode, };
export type MessageContent = { text: string, };
export type ChatCursor = { updated_at: number, chat_id: string, };
export type ChatList = { 
/**
 * Page the archive instead of the other chats.
 */
archived?: boolean, before?: ChatCursor, };
export type ChatPage = { 
/**
 * On the first page outside the archive: every pinned chat first, in pin order.
 */
chats: Array<ChatInfo>, 
/**
 * The `before` of the next page; absent on the last.
 */
next?: ChatCursor, };
export type ChatRename = { chat_id: string, title: Uint8Array, };
export type ChatPin = { chat_id: string, 
/**
 * Where to put the chat among the pinned ones; absent unpins it.
 */
position?: number, };
export type ChatArchive = { chat_id: string, archived: boolean, };
export type ChatConfigure = { chat_id: string, settings: ChatSettings, };
export type ChatDelete = { chat_id: string, };
export type NewChat = { public_key: Uint8Array, wrapped_private_key: Uint8Array, title?: Uint8Array, settings?: ChatSettings, };
export type Role = "user" | "assistant";
export type ContextMessage = { id: number, role: Role, text: string, };
export type TurnContext = { summary?: string, messages: Array<ContextMessage>, };
export type MessageSend = { idempotency_key: string, chat_id: string, new_chat?: NewChat, text: string, context: TurnContext, };
export type MessageSent = { message_id: number, turn_id: string, };
export type ChunkRequest = { chunk: number, 
/**
 * The chunk revision the client holds: only later changes come back.
 */
rev?: number, };
export type MessageChunks = { chat_id: string, chunks: Array<ChunkRequest>, };
export type ChunkList = { chat_id: string, 
/**
 * A chunk may span several parts, each with some of its messages.
 */
chunks: Array<Chunk>, };
export type Chunk = { chunk: number, 
/**
 * The largest `rev` among the chunk's messages; 0 for an empty chunk.
 */
rev: number, messages: Array<ChatMessage>, };
export type MessageEdit = { chat_id: string, message_id: number, 
/**
 * A `chat.message` record sealed by the client in auth mode.
 */
record: Uint8Array, };
export type Revision = { rev: number, };
export type MessageDelete = { chat_id: string, message_id: number, };
export type TurnCancel = { chat_id: string, };
export type TurnRetry = { chat_id: string, message_id: number, text: string, context: TurnContext, };
export type TurnStarted = { turn_id: string, };
export type ChatUpdated = { chat: ChatInfo, };
export type ChatDeleted = { chat_id: string, };
export type MessageCreated = { chat_id: string, message: ChatMessage, };
export type MessageUpdated = { chat_id: string, message: ChatMessage, };
export type MessageDeleted = { chat_id: string, message_id: number, rev: number, };
export type MessageDelta = { chat_id: string, message_id: number, seq: number, text: string, };
export type TurnDone = { chat_id: string, turn_id: string, };
export type TurnErrorCode = "provider.blocked" | "provider.unreachable" | "provider.refused" | "provider.invalid" | "turn.too_long" | "turn.timed_out" | "turn.interrupted";
export type TurnError = { chat_id: string, turn_id: string, code: TurnErrorCode, };
export type SyncReset = Record<symbol, never>;

// HTTP /auth (docs/auth.md)
export type Provider = "google" | "email";
export type Providers = { google: boolean, email: boolean, };
export type EmailStart = { email: string, 
/**
 * UI language for the mail; unknown values fall back to English.
 */
locale: string, };
export type EmailStarted = { pending_id: string, };
export type EmailVerify = { pending_id: string, email: string, code: string, };
export type AccessGrant = { access_token: string, expires_at: number, user_id: string, session_id: string, };
export type SessionUpdate = { device_id: string, 
/**
 * IANA name from `Intl`; dropped when the server does not know it.
 */
timezone?: string, locale?: string, client_version?: string, };
export type SessionInfo = { id: string, 
/**
 * The session making this request.
 */
current: boolean, provider: Provider, device_id: string | null, user_agent: string | null, ip: string | null, country: string | null, timezone: string | null, locale: string | null, client_version: string | null, created_at: number, last_seen_at: number, };
export type Sessions = { sessions: Array<SessionInfo>, };
export type IdentityInfo = { id: string, provider: Provider, email: string | null, email_verified: boolean, created_at: number, last_used_at: number, };
export type Identities = { identities: Array<IdentityInfo>, };
export type AuditEntry = { id: number, 
/**
 * `area.verb`, e.g. `auth.signed_in`.
 */
kind: string, session_id: string | null, ip: string | null, country: string | null, user_agent: string | null, 
/**
 * Ids, provider kinds and reasons; never content or addresses.
 */
details: Record<string, unknown>, created_at: number, };
export type AuditPage = { events: Array<AuditEntry>, 
/**
 * Pass as `before` for the next page; absent on the last page.
 */
next_before: number | null, };

export const CloseCode = {
  Normal: 1000,
  GoingAway: 1001,
  ServerError: 1011,
  AuthFailed: 4001,
  AuthTimeout: 4002,
  SessionRevoked: 4003,
  TokenExpired: 4004,
  UnsupportedVersion: 4005,
  PolicyViolation: 4008,
  Superseded: 4009,
} as const;

/** Every request `type` with its payload and the payload of its `ok` response. */
export type Requests = {
  "auth": { request: Auth; response: AuthOk };
  "auth.renew": { request: AuthRenew; response: Empty };
  "ping": { request: Ping; response: Pong };
  "keys.get": { request: KeysGet; response: KeysState };
  "keys.setup": { request: KeysSetup; response: Empty };
  "keys.wrap_add": { request: KeysWrapAdd; response: Empty };
  "keys.wrap_remove": { request: KeysWrapRemove; response: Empty };
  "keys.recovery_rotate": { request: KeysRecoveryRotate; response: Empty };
  "scope.keys": { request: ScopeKeys; response: ScopeKeyList };
  "link.create": { request: LinkCreate; response: LinkCreated };
  "link.info": { request: LinkInfo; response: LinkRequester };
  "link.post": { request: LinkPost; response: Empty };
  "link.get": { request: LinkGet; response: LinkState };
  "agent.start": { request: AgentStart; response: AgentStarted };
  "agent.stop": { request: AgentStop; response: Empty };
  "agent.retire": { request: AgentRetire; response: Empty };
  "settings.get": { request: SettingsGet; response: SettingState };
  "settings.put": { request: SettingsPut; response: SettingStored };
  "chat.list": { request: ChatList; response: ChatPage };
  "chat.rename": { request: ChatRename; response: Empty };
  "chat.pin": { request: ChatPin; response: Empty };
  "chat.archive": { request: ChatArchive; response: Empty };
  "chat.configure": { request: ChatConfigure; response: Empty };
  "chat.delete": { request: ChatDelete; response: Empty };
  "message.send": { request: MessageSend; response: MessageSent };
  "message.chunks": { request: MessageChunks; response: ChunkList };
  "message.edit": { request: MessageEdit; response: Revision };
  "message.delete": { request: MessageDelete; response: Revision };
  "turn.cancel": { request: TurnCancel; response: Empty };
  "turn.retry": { request: TurnRetry; response: TurnStarted };
};

/** Every server event `type` with its payload. */
export type Events = {
  "link.message": LinkMessage;
  "settings.updated": SettingsUpdated;
  "chat.updated": ChatUpdated;
  "chat.deleted": ChatDeleted;
  "message.created": MessageCreated;
  "message.updated": MessageUpdated;
  "message.deleted": MessageDeleted;
  "message.delta": MessageDelta;
  "turn.done": TurnDone;
  "turn.error": TurnError;
  "sync.reset": SyncReset;
};
