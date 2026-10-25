# Protocol

> Status: **agreed** (2026-10-25). Message names and fields here are the
> source for `crates/protocol`; TypeScript types are generated from it, never
> written by hand. Payloads of notes and registers are fixed when those
> features are built; `message.page` may change after the chat paging
> reference.

WebSocket carries everything interactive: chat turns, streaming, permission
requests and sync. HTTP is used only for auth flows, file transfer (later) and
health. Binary values (ciphertext, keys) travel as unpadded base64url strings.

## Envelope

```json
{ "v": 1, "id": 17, "type": "chat.create", "payload": { } }
```

| Field | Meaning |
| ----- | ------- |
| `v` | Protocol version. The server accepts the current and the previous one; anything else closes the socket with `4005`. |
| `id` | Present on client requests and on their responses. A `u32` chosen by the client, increasing per socket. Absent on server events. |
| `type` | Message name, `area.verb`. |
| `payload` | Type-specific object. Unknown fields are rejected (`deny_unknown_fields`) so mismatches fail loudly in development. |

A request gets exactly one response with the same `id`:

```json
{ "v": 1, "id": 17, "type": "ok",    "payload": { } }
{ "v": 1, "id": 17, "type": "error", "payload": { "code": "chat.not_found", "message": "…", "retry": false } }
```

`error.message` is for logs and developers; the client shows localized text by
`code`. `retry: true` means the same request may be sent again. A frame that
cannot be parsed, or a request without an `id`, gets an `error` without `id`
(`protocol.malformed`, `protocol.missing_id`); the socket stays open.

Server events (`message.created`, `turn.delta`, `permission.request`, …) have
no `id`. When the server needs an answer (a permission decision), the event
carries its own `request_id` and the client answers with a normal request.

## Connection lifecycle

1. The client opens `wss://host/ws`. No token in the URL. The server checks
   `Origin` against `CHAT_ALLOWED_ORIGINS` (exact match) and answers 403
   otherwise.
2. The first frame must be `auth { access_token, resume? }` within 5 seconds,
   otherwise close `4002`. Before `auth` succeeds no other message is read.
3. `ok { session_id, heartbeat_ms, server_time }`.
4. The client sends `ping` every `heartbeat_ms` (default 20 s); the server
   answers `ok { server_time }`. Browsers cannot send or observe WebSocket-level pings,
   hence application-level ones. A client that gets no `pong` within two
   intervals treats the socket as dead and reconnects. The server closes
   sockets silent for three intervals.
5. Before the access token expires the client refreshes it over HTTP and sends
   `auth.renew { access_token }` on the open socket. A socket whose token
   expired without renewal is closed with `4004`.
6. When the session is revoked, the server closes every socket of that session
   with `4003`; the client goes to sign-in and does not reconnect.

### Close codes

| Code | Meaning | Client action |
| ---- | ------- | ------------- |
| 1000 | Normal close | — |
| 1001 | Server going away (deploy) | Reconnect with backoff |
| 4001 | Authentication failed | Refresh token once, then sign-in |
| 4002 | No `auth` frame in time | Reconnect |
| 4003 | Session revoked | Sign-in, no reconnect |
| 4004 | Access token expired | Refresh over HTTP, reconnect |
| 4005 | Unsupported protocol version | Reload the client |
| 4008 | Rate limit or frame too large | Reconnect with backoff, report |
| 4009 | Superseded (same agent session taken by another socket) | Do not reconnect this tab |

### Reconnect and resume

- Backoff: exponential from 500 ms, factor 2, cap 30 s, full jitter; reset
  after a socket stays healthy for 30 s.
- After `auth`, the client sends `sync { chats: [{ chat_id, last_seen_id }] }`
  for the chats it has open. The server replays `message.created` for every
  newer message, up to 64 per chat; beyond that it sends
  `sync.gap { chat_id, from_id }` and the client pages normally.
- A turn that was streaming continues on the server while the socket is down
  (see [Agent sessions](#agent-sessions)). On resume the server sends
  `turn.state { turn_id, text, seq }` and then further `turn.delta`s.
  Deltas carry an increasing `seq`, so the client drops duplicates.
- **In-flight requests are never dropped silently.** The client keeps
  unanswered requests in an outbox. On reconnect it resends those that are
  safe to repeat; requests that create something (`chat.create`,
  `message.reserve`, `turn.start`, `note.create`, …) carry a client-generated
  `idempotency_key` (UUID), and the server returns the original result for a
  key it has seen in the last 10 minutes. Anything the client cannot resend is
  failed in the UI with a retry button.

## Agent sessions

An agent session holds what the server needs to run turns for one client: the
decrypted provider config and the state of a running turn. It lives in server
memory only.

- `agent.start { provider }` → `ok { agent_session_id }`. Sent after unlock;
  `provider` is decrypted from the `settings` scope by the client.
- The session is bound to the auth session and to the socket that started it.
  When the socket drops, the agent session survives for a grace period
  (default 2 minutes) so a reconnect with `auth { resume: { agent_session_id } }`
  picks it up. After that it is dropped, with the provider config and any
  pending permission requests (answered as `denied: disconnected`).
- One turn per chat at a time. `turn.start` on a chat with a running turn
  returns `error turn.busy`.

## Messages (v1)

Requests are client → server unless marked. "Events" are server → client.

### Connection

| Type | Payload | Response |
| ---- | ------- | -------- |
| `auth` | `access_token`, `resume?: { agent_session_id }` | `session_id`, `heartbeat_ms`, `server_time` |
| `auth.renew` | `access_token` | — |
| `ping` | — | `server_time` |
| `sync` | `chats: [{ chat_id, last_seen_id }]` | — then events |

### Keys

| Type | Payload | Response |
| ---- | ------- | -------- |
| `keys.get` | — | wraps, commitment, writer public key |
| `keys.setup` | the bundle from the worker's `setup` | — |
| `scope.keys` | `scope_ids` | public keys and wrapped private keys |
| `link.create` / `link.post` / event `link.message` | see [crypto.md](crypto.md#device-linking) | — |

### Chats and messages

| Type | Payload | Response |
| ---- | ------- | -------- |
| `chat.list` | `after?` (cursor) | chats: id, title record, updated_at, last_message_id |
| `chat.create` | `idempotency_key`, scope public key, wrapped private key, title record | chat |
| `chat.rename` | `chat_id`, title record | — |
| `chat.delete` | `chat_id` | — |
| `message.page` | `chat_id`, `before?` or `after?` (message id), `limit ≤ 64` | messages (id, author, created_at, record), `has_more` |
| `message.reserve` | `chat_id`, `idempotency_key` | `message_id` |
| `turn.start` | see below | `turn_id` |
| `turn.cancel` | `turn_id` | — |
| `saved.add` / `saved.remove` / `saved.list` | `chat_id`, `message_id` | — / saved refs |

Events: `message.created { chat_id, message }`, `message.deleted`,
`chat.updated`, `turn.delta { turn_id, seq, text }`,
`turn.tool { turn_id, tool, status }`, `turn.done { turn_id, message_ids }`,
`turn.error { turn_id, code }`.

Message ids are allocated by the server from a per-chat counter. The client
needs the id **before** sealing its own message (the id is in the AAD), hence
`message.reserve`. A reserved id that is never used becomes a gap, which is
legal.

`turn.start` payload:

```
chat_id
message_id            reserved id of the user's message
record                the user's message, sealed by the client (stored)
text                  the same message in plaintext (sent to the LLM)
context               { summary?: text, messages: [{ id, role, text }] }  chosen by the client
idempotency_key
```

The server stores `record`, runs the agent loop with `text` and `context`,
streams the reply, and stores the assistant message and tool results sealed to
the chat scope public key. It never stores `text` or `context`.

### Notes and registers

`notebook.*`, `note.*` and `register.*` follow the same pattern: list with a
cursor, create with an `idempotency_key`, update, delete; values are records.
Register entries carry `period_start` and `granularity` in plaintext (and in the
AAD). Exact payloads are fixed when the features are built and added here.

### Permissions and the access log

Event `permission.request`:

```
request_id, turn_id, chat_id
tool                  e.g. "read_register"
scopes                [scope_id]
args                  tool arguments the client needs to answer (e.g. register id, from, to)
reason                text written by the LLM — untrusted, shown quoted
expires_at
```

Request `permission.respond`:

```
request_id
decision              "approve" | "deny"
result?               plaintext tool result when approved (size-limited)
```

The client renders the dialog from its own data: scope names come from the
client's decrypted titles and register definitions, never from strings in the
event. A request naming a scope the client does not know is denied
automatically. Unanswered requests expire after 5 minutes (`denied: timeout`).
Every request and its outcome is written to the access log; `access_log.list`
pages it.

## Agent tools (v1)

| Tool | Grant | Returns |
| ---- | ----- | ------- |
| `list_scopes` | none | scope kinds and ids, chat count; no titles (they are encrypted) |
| `list_metrics` | none | register definitions: name, kind, unit, dimensions |
| `read_register` | `register:<id>` | values for a period range, decrypted by the client |

## Provider endpoints

Each user configures their own LLM: `kind` (`openai_compatible` or
`anthropic`), `base_url`, `api_key`, `model`. The server makes the HTTP calls,
so a user-supplied `base_url` is an SSRF vector into the server's network
(database, Redis, cloud metadata).

- By default the server refuses targets in loopback, private, link-local,
  CGNAT and unique-local ranges, and cloud metadata addresses.
- The check runs on the **resolved** address, and the connection is pinned to
  that address (no second DNS lookup, so DNS rebinding cannot swap it).
- Redirects are not followed.
- Self-hosters who run Ollama on the same host or LAN allow it explicitly with
  `CHAT_PROVIDER_ALLOWED_NETWORKS` (IPs or CIDRs). The user cannot override it.
  `http://` base URLs reach those networks only; everything public is `https://`.
- No system proxy (an environment proxy would bypass the checks); base URLs
  with credentials are refused.
- Requests have a 10 s connect timeout, a 120 s timeout between chunks of a
  stream, and a 16 MiB response cap.

Adapters (`server/src/providers/`): OpenAI-compatible Chat Completions
(`{base}/chat/completions`, SSE `choices[].delta`, tool calls assembled by
`index`) and Anthropic Messages (`{base}/v1/messages`, `anthropic-version:
2023-06-01`, consecutive same-role messages merged). Both yield text deltas,
complete tool calls and a stop reason. A fake provider in
`server/tests/support/fake_llm.rs` speaks both formats with scripted replies
for deterministic agent tests.

The QR form of a provider config contains the API key; the client warns
before showing it.

## HTTP

| Route | Purpose |
| ----- | ------- |
| `GET /health` | Liveness: process up |
| `GET /ready` | Readiness: database reachable |
| `/auth/*` | Google OIDC, email OTP, refresh, sign-out, session list and revocation (layout follows the session-management reference) |
| `/files/*` | Encrypted chunk upload and download (after v1) |

## Limits

| Limit | Default |
| ----- | ------- |
| Frame size | 1 MiB |
| One record | 256 KiB |
| Turn context | 512 KiB |
| Grant result | 256 KiB |
| Requests per socket | 50 / s burst, 10 / s sustained |
| Unauthenticated sockets per IP | 10 (not yet enforced: needs the trusted-proxy setting of the deployment) |

## Versioning and generation

- Types live in `crates/protocol` with `serde`; TypeScript is generated from
  them with `ts-rs` (stable, unlike `specta` 2, still a release candidate)
  into `client/src/protocol/generated/protocol.ts`, which is never edited by
  hand. The `typescript` test of `chat-protocol` fails when the file is stale;
  `CHAT_PROTOCOL_REGEN=1 cargo test -p chat-protocol typescript` rewrites it.
- `i64` values become TypeScript `number`s: they are timestamps (ms) and
  periods (s), far inside 2^53.
- Adding an optional field or a new message type is compatible. Removing or
  changing a field bumps `v`.
- `Debug` for payloads that contain plaintext or tokens is redacted, so they
  cannot end up in logs.
