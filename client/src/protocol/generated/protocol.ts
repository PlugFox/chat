// Generated from crates/protocol by its `typescript` test. Do not edit.

export const PROTOCOL_VERSION = 1;

export type Empty = Record<symbol, never>;
export type ErrorCode = "protocol.malformed" | "protocol.unknown_type" | "protocol.missing_id" | "auth.already_authenticated" | "auth.invalid_token" | "auth.session_mismatch" | "auth.unavailable" | "auth.origin" | "auth.signed_out" | "auth.reauth_required" | "auth.provider_disabled" | "auth.invalid_email" | "auth.code_invalid" | "auth.code_expired" | "auth.signup_closed" | "auth.email_unverified" | "identity.in_use" | "identity.last" | "keys.not_set_up" | "keys.exists" | "keys.invalid" | "keys.limit" | "keys.device_mismatch" | "keys.recovery_required" | "link.not_found" | "link.used" | "agent.invalid_provider" | "agent.not_started" | "settings.conflict" | "settings.limit" | "chat.not_found" | "chat.exists" | "chat.archived" | "chat.not_archived" | "message.not_found" | "message.not_editable" | "message.not_retryable" | "message.streaming" | "message.too_large" | "turn.busy" | "turn.limit" | "saved.limit" | "notes.not_set_up" | "note.not_found" | "note.exists" | "note.conflict" | "note.limit" | "metric.not_found" | "register.not_set_up" | "register.not_found" | "register.exists" | "register.conflict" | "register.limit" | "permission.not_found" | "files.disabled" | "files.quota" | "file.too_large" | "file.limit" | "file.not_found" | "file.exists" | "not_found" | "rate_limited" | "unavailable" | "internal";
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
agent_session_id?: string, 
/**
 * The server has a file store (docs/protocol.md, "Files").
 */
files: boolean, };
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
export type History = { "mode": "recent", messages: number, } | { "mode": "compact", auto?: boolean, threshold?: number, };
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
pin?: number, archived_at?: number, settings: ChatSettings, 
/**
 * The current summary: the complete one with the largest `through`.
 */
summary_id?: number, 
/**
 * The title is automatic: the model's titles may replace it (docs/protocol.md, "Titles").
 */
title_auto: boolean, };
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
error?: TurnErrorCode, 
/**
 * On a summary, the last message id it covers.
 */
through?: number, };
export type MessageContent = { text: string, 
/**
 * The reply as a document, written with its last record ("Message documents").
 */
doc?: Document, 
/**
 * A reply's tool calls in order, without their results (D-099).
 */
tools?: Array<ToolUse>, 
/**
 * A user message's attachments in order (docs/protocol.md, "Files").
 */
files?: Array<FileRef>, };
export type ToolUse = { tool: string, metric?: string, from?: string, to?: string, 
/**
 * Of `read_history`: the messages asked for, then the messages read once the client answered.
 */
count?: number, 
/**
 * Of `web_fetch`: the site it read, as this sealed record may say and the access log may not.
 */
host?: string, 
/**
 * Absent while the call waits for the user.
 */
outcome?: Outcome, };
export type Document = { v: number, blocks: Array<Block>, };
export type Block = { "t": "p", s: Array<Span>, } | { "t": "h", level: number, s: Array<Span>, } | { "t": "list", 
/**
 * Ordered, numbered from this.
 */
start?: number, items: Array<Item>, } | { "t": "quote", b: Array<Block>, } | { "t": "callout", kind: CalloutKind, b: Array<Block>, } | { "t": "panel", title: Array<Span>, b: Array<Block>, } | { "t": "code", lang?: string, text: string, } | { "t": "table", align: Array<Align>, head: Array<Array<Span>>, rows: Array<Array<Array<Span>>>, } | { "t": "rule" } | { "t": "chart" } & Chart;
export type Item = { b: Array<Block>, 
/**
 * A task, done or not.
 */
checked?: boolean, };
export type Span = string | Styled;
export type Styled = { text: string, 
/**
 * Style bits: 1 bold, 2 italic, 4 strikethrough, 8 code (`flag`).
 */
f?: number, 
/**
 * Only `http`, `https` or `mailto`.
 */
href?: string, };
export type CalloutKind = "note" | "tip" | "important" | "warning" | "caution";
export type Align = "" | "left" | "center" | "right";
export type Chart = { kind: ChartKind, title?: string, 
/**
 * The axis titles.
 */
x?: string, y?: string, 
/**
 * The points along x, or a pie's slices.
 */
labels: Array<string>, series: Array<Series>, 
/**
 * What a reader that knows no charts shows: the title.
 */
fallback?: string, };
export type ChartKind = "line" | "area" | "bar" | "pie";
export type Series = { name: string, 
/**
 * One per label; none is a gap.
 */
values: Array<number | null>, };
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
export type ChatRename = { chat_id: string, title: Uint8Array, 
/**
 * An automatic title: applied only while the chat's title is automatic.
 */
auto?: boolean, };
export type ChatMemoryGet = { chat_id: string, };
export type ChatMemory = { 
/**
 * A `chat.memory` record; absent while the chat has no memory.
 */
memory?: Uint8Array, };
export type ChatMemoryClear = { chat_id: string, };
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
export type ContextMessage = { id: number, role: Role, text: string, 
/**
 * A user message's files, as the model is told about them.
 */
files?: Array<ContextFile>, };
export type TurnContext = { summary?: string, 
/**
 * The chat's memory, opened by the client (D-117).
 */
memory?: string, messages: Array<ContextMessage>, };
export type MessageSend = { idempotency_key: string, chat_id: string, new_chat?: NewChat, text: string, context: TurnContext, 
/**
 * The message's attachments (docs/protocol.md, "Files").
 */
files?: Array<SentFile>, };
export type ChatCompact = { chat_id: string, through: number, context: TurnContext, };
export type ChatTitle = { chat_id: string, context: TurnContext, };
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
export type TurnRetry = { chat_id: string, message_id: number, text: string, context: TurnContext, 
/**
 * The files of the user message the reply answers, with their keys.
 */
files?: Array<SentFile>, };
export type TurnStarted = { turn_id: string, };
export type ChatUpdated = { chat: ChatInfo, };
export type ChatDeleted = { chat_id: string, };
export type MessageCreated = { chat_id: string, message: ChatMessage, };
export type MessageUpdated = { chat_id: string, message: ChatMessage, };
export type MessageDeleted = { chat_id: string, message_id: number, rev: number, };
export type MessageDelta = { chat_id: string, message_id: number, seq: number, text: string, };
export type ChatTitled = { chat_id: string, title: string, };
export type TurnDone = { chat_id: string, turn_id: string, };
export type TurnErrorCode = "provider.blocked" | "provider.unreachable" | "provider.refused" | "provider.invalid" | "turn.too_long" | "turn.timed_out" | "turn.interrupted" | "files.busy";
export type TurnError = { chat_id: string, turn_id: string, code: TurnErrorCode, };
export type SyncReset = Record<symbol, never>;
export type NoticeCode = "file.undescribed";
export type Notice = { code: NoticeCode, chat_id?: string, file_id?: string, };

// Files (docs/protocol.md, "Files")
export type FileCreate = { file_id: string, 
/**
 * The chat the records are sealed to; a new chat's may not exist yet.
 */
chat_id: string, 
/**
 * Bytes of the object.
 */
size: number, 
/**
 * A `file.key` record.
 */
key: Uint8Array, 
/**
 * A `file.preview` record.
 */
preview?: Uint8Array, 
/**
 * Stay after the reply; absent, the object goes once the reply is complete (D-107).
 */
keep?: boolean, };
export type FileRecords = { chat_id: string, file_ids: Array<string>, };
export type FileRecord = { file_id: string, 
/**
 * Bytes of the object.
 */
size: number, 
/**
 * A `file.key` record.
 */
key: Uint8Array, preview?: Uint8Array, 
/**
 * A `file.description` record.
 */
description?: Uint8Array, };
export type FileRecordList = { files: Array<FileRecord>, };
export type FileUsage = Record<symbol, never>;
export type FileUsed = { 
/**
 * Bytes of the account's objects, stored and pending.
 */
used: number, 
/**
 * Absent without a quota.
 */
quota?: number, };
export type FileForget = { 
/**
 * At most [`FORGET_MAX`].
 */
file_ids: Array<string>, };
export type FileDescribed = { chat_id: string, file_id: string, 
/**
 * A `file.description` record.
 */
description: Uint8Array, };
export type SentFile = { file_id: string, 
/**
 * The content key, 32 bytes.
 */
key: Uint8Array, name: string, type: string, 
/**
 * Bytes of plaintext.
 */
size: number, w?: number, h?: number, 
/**
 * An image's ThumbHash.
 */
hash?: Uint8Array, original?: SentOriginal, };
export type SentOriginal = { file_id: string, type: string, size: number, };
export type ContextFile = { file_id: string, name: string, type: string, size: number, w?: number, h?: number, description?: string, };
export type FileRef = { 
/**
 * The file id as a UUID string.
 */
id: string, name: string, type: string, size: number, w?: number, h?: number, hash?: Uint8Array, original?: OriginalRef, };
export type OriginalRef = { 
/**
 * The file id as a UUID string.
 */
id: string, type: string, size: number, };

// Saved messages (docs/protocol.md, "Saved messages")
export type SavedAt = { 
/**
 * Milliseconds.
 */
saved_at: number, };
export type SavedAdd = { chat_id: string, message_id: number, };
export type SavedRemove = { chat_id: string, message_id: number, };
export type SavedCursor = { saved_at: number, chat_id: string, message_id: number, };
export type SavedList = { before?: SavedCursor, };
export type SavedItem = { saved_at: number, chat: ChatInfo, message: ChatMessage, };
export type SavedPage = { 
/**
 * Newest first; a page may span several parts.
 */
items: Array<SavedItem>, 
/**
 * The `before` of the next page; absent on the last. Only the last part has it.
 */
next?: SavedCursor, };
export type SavedChat = { chat_id: string, };
export type SavedIds = { message_ids: Array<number>, };
export type SavedUpdated = { chat_id: string, message_id: number, 
/**
 * Absent: no longer saved.
 */
saved_at?: number, };

// Notes (docs/protocol.md, "Notes")
export type NotesSetup = { scope_id: string, public_key: Uint8Array, wrapped_private_key: Uint8Array, };
export type NotesScope = { 
/**
 * The account's notes scope: the one sent, or the one another request created first.
 */
scope_id: string, };
export type NoteInfo = { note_id: string, 
/**
 * A `note.title` record: the title and the start of the text.
 */
title: Uint8Array, 
/**
 * Milliseconds.
 */
created_at: number, 
/**
 * Milliseconds; grows with every change.
 */
updated_at: number, rev: number, };
export type NoteCursor = { updated_at: number, note_id: string, };
export type NoteList = { before?: NoteCursor, };
export type NotePage = { 
/**
 * Absent until the notes scope exists.
 */
scope_id?: string, 
/**
 * Newest first.
 */
notes: Array<NoteInfo>, 
/**
 * The `before` of the next page; absent on the last.
 */
next?: NoteCursor, };
export type NoteGet = { note_id: string, };
export type NoteOpened = { note: NoteInfo, 
/**
 * A `note.body` record.
 */
body: Uint8Array, };
export type NoteCreate = { 
/**
 * Chosen by the client.
 */
note_id: string, title: Uint8Array, body: Uint8Array, };
export type NoteStored = { note: NoteInfo, };
export type NoteUpdate = { note_id: string, 
/**
 * The revision this change was based on.
 */
rev: number, title: Uint8Array, body: Uint8Array, };
export type NoteDelete = { note_id: string, };
export type NoteUpdated = { note: NoteInfo, };
export type NoteDeleted = { note_id: string, };

// Registers (docs/protocol.md, "Registers")
export type MetricList = Record<symbol, never>;
export type MetricCategory = { key: string, 
/**
 * Locale → name.
 */
names: { [key in string]: string }, };
export type Metric = { 
/**
 * Stable and never reused, such as `body.weight`.
 */
key: string, category: string, 
/**
 * The register kind holding its entries: `measurements`.
 */
register: string, 
/**
 * Locale → name.
 */
names: { [key in string]: string }, 
/**
 * A metric unit: `kg`, `cm`, `count`, `kcal`.
 */
unit: string, 
/**
 * What the unit may be converted to for display: `mass`, `length`, `count`, `energy`.
 */
quantity: string, 
/**
 * `decimal` or `integer`.
 */
value_type: string, 
/**
 * Decimal places.
 */
precision: number, min: number, max: number, 
/**
 * `avg` or `sum`: how a day's entries make one value.
 */
aggregate: string, };
export type RegisterInfo = { metric: string, scope_id: string, entries: number, 
/**
 * The `occurred_at` of the newest entry; absent without entries.
 */
latest_at?: number, };
export type MetricCatalog = { 
/**
 * In display order.
 */
categories: Array<MetricCategory>, 
/**
 * In display order.
 */
metrics: Array<Metric>, registers: Array<RegisterInfo>, };
export type RegisterSetup = { metric: string, scope_id: string, public_key: Uint8Array, wrapped_private_key: Uint8Array, };
export type RegisterScope = { 
/**
 * The register's scope: the one sent, or the one another request created first.
 */
scope_id: string, };
export type RegisterEntry = { 
/**
 * Chosen by the client.
 */
entry_id: string, metric: string, 
/**
 * Seconds since the Unix epoch, UTC: the record's `period_start`.
 */
occurred_at: number, 
/**
 * A `register.value` record.
 */
value: Uint8Array, 
/**
 * Milliseconds.
 */
updated_at: number, rev: number, };
export type RegisterCursor = { occurred_at: number, entry_id: string, };
export type RegisterEntries = { metric: string, 
/**
 * Inclusive, seconds.
 */
from?: number, 
/**
 * Exclusive, seconds.
 */
to?: number, before?: RegisterCursor, 
/**
 * 1 to [`ENTRIES_PAGE`]; that when absent.
 */
limit?: number, };
export type RegisterPage = { 
/**
 * Newest first.
 */
entries: Array<RegisterEntry>, 
/**
 * The `before` of the next page; absent on the last.
 */
next?: RegisterCursor, };
export type RegisterCreate = { entry_id: string, metric: string, occurred_at: number, value: Uint8Array, };
export type RegisterStored = { entry: RegisterEntry, };
export type RegisterUpdate = { entry_id: string, 
/**
 * The revision this change was based on.
 */
rev: number, occurred_at: number, value: Uint8Array, };
export type RegisterDelete = { entry_id: string, };
export type RegisterUpdated = { entry: RegisterEntry, };
export type RegisterDeleted = { entry_id: string, metric: string, };

// Permissions and the access log (docs/protocol.md)
export type Grant = { "tool": "read_register", metric: string, scope_id: string, from?: string, to?: string, } | { "tool": "session_context", } | { "tool": "read_history", before: number, count: number, } | { "tool": "read_file", file_id: string, } | { "tool": "add_measurement", metric: string, } | { "tool": "web_fetch", } | { "tool": "run_code", } | { "tool": "get_weather", };
export type Outcome = "approved" | "denied" | "refused" | "timeout" | "cancelled" | "answered";
export type PermissionRequest = { 
/**
 * The access log entry.
 */
request_id: string, chat_id: string, turn_id: string, 
/**
 * The entry of the providers setting the turn runs with.
 */
provider_id: string, grant: Grant, 
/**
 * An `audit.reason` record.
 */
reason: Uint8Array, 
/**
 * Milliseconds.
 */
expires_at: number, };
export type PermissionPending = Record<symbol, never>;
export type PermissionList = { 
/**
 * Oldest first.
 */
requests: Array<PermissionRequest>, };
export type Decision = "approve" | "deny" | "refuse" | "answer";
export type PermissionRespond = { request_id: string, decision: Decision, 
/**
 * The tool result in plaintext: required when approving `read_register` or
 * `add_measurement` or answering, refused otherwise.
 */
result?: string, };
export type PermissionResolved = { request_id: string, chat_id: string, outcome: Outcome, };
export type AccessLogList = { 
/**
 * The `next` of the previous page.
 */
before?: string, };
export type AccessEntry = { id: string, chat_id: string, grant: Grant, 
/**
 * An `audit.reason` record.
 */
reason: Uint8Array, 
/**
 * Absent while the request waits.
 */
outcome?: Outcome, 
/**
 * Milliseconds.
 */
requested_at: number, decided_at?: number, };
export type AccessLogPage = { 
/**
 * Newest first.
 */
entries: Array<AccessEntry>, next?: string, };

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
  "chat.memory": { request: ChatMemoryGet; response: ChatMemory };
  "chat.memory.clear": { request: ChatMemoryClear; response: Empty };
  "chat.pin": { request: ChatPin; response: Empty };
  "chat.archive": { request: ChatArchive; response: Empty };
  "chat.configure": { request: ChatConfigure; response: Empty };
  "chat.delete": { request: ChatDelete; response: Empty };
  "message.send": { request: MessageSend; response: MessageSent };
  "chat.compact": { request: ChatCompact; response: MessageSent };
  "chat.title": { request: ChatTitle; response: Empty };
  "message.chunks": { request: MessageChunks; response: ChunkList };
  "message.edit": { request: MessageEdit; response: Revision };
  "message.delete": { request: MessageDelete; response: Revision };
  "turn.cancel": { request: TurnCancel; response: Empty };
  "turn.retry": { request: TurnRetry; response: TurnStarted };
  "file.create": { request: FileCreate; response: Empty };
  "file.records": { request: FileRecords; response: FileRecordList };
  "file.usage": { request: FileUsage; response: FileUsed };
  "file.forget": { request: FileForget; response: Empty };
  "saved.add": { request: SavedAdd; response: SavedAt };
  "saved.remove": { request: SavedRemove; response: Empty };
  "saved.list": { request: SavedList; response: SavedPage };
  "saved.chat": { request: SavedChat; response: SavedIds };
  "notes.setup": { request: NotesSetup; response: NotesScope };
  "note.list": { request: NoteList; response: NotePage };
  "note.get": { request: NoteGet; response: NoteOpened };
  "note.create": { request: NoteCreate; response: NoteStored };
  "note.update": { request: NoteUpdate; response: NoteStored };
  "note.delete": { request: NoteDelete; response: Empty };
  "metric.list": { request: MetricList; response: MetricCatalog };
  "register.setup": { request: RegisterSetup; response: RegisterScope };
  "register.entries": { request: RegisterEntries; response: RegisterPage };
  "register.create": { request: RegisterCreate; response: RegisterStored };
  "register.update": { request: RegisterUpdate; response: RegisterStored };
  "register.delete": { request: RegisterDelete; response: Empty };
  "permission.pending": { request: PermissionPending; response: PermissionList };
  "permission.respond": { request: PermissionRespond; response: Empty };
  "access_log.list": { request: AccessLogList; response: AccessLogPage };
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
  "chat.titled": ChatTitled;
  "file.described": FileDescribed;
  "notice": Notice;
  "saved.updated": SavedUpdated;
  "note.updated": NoteUpdated;
  "note.deleted": NoteDeleted;
  "register.updated": RegisterUpdated;
  "register.deleted": RegisterDeleted;
  "permission.request": PermissionRequest;
  "permission.resolved": PermissionResolved;
  "turn.done": TurnDone;
  "turn.error": TurnError;
  "sync.reset": SyncReset;
};
