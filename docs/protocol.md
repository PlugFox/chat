# Protocol

> Status: **agreed** (2026-10-25; MessagePack frames and the chat model
> 2026-10-26). Message names and fields here are the source for
> `crates/protocol`; TypeScript types are generated from it, never written by
> hand. Payloads of notes and registers are fixed when those features are
> built.

WebSocket carries everything interactive: chat turns, streaming, keys,
permission requests. HTTP is used only for auth flows (they need cookies),
file transfer (later) and health.

## Envelope

Every frame is a binary WebSocket message holding one MessagePack value
(D-026); text frames close the socket with `4008`. The value is an array of
three:

```
[type, id, payload]          e.g. ["chat.list", 17, {}]
```

| Field | Meaning |
| ----- | ------- |
| `type` | Message name, `area.verb`; `ok`, `more` and `error` for responses. |
| `id` | A `u32`. Requests: chosen by the client, from 1, increasing per socket. Responses: the request's id. Events: 0. |
| `payload` | A map with the type's fields. Unknown fields are rejected (`deny_unknown_fields`) so mismatches fail loudly in development. |

A request gets one response with the same `id`, or several when the result
is large (D-027):

```
["ok",    17, { … }]                                       the whole result
["more",  17, { … }]  …  ["ok", 17, { … }]                 parts, then the last part
["error", 17, { "code": "chat.not_found", "message": "…", "retry": false }]
```

Each `more` part has the same type as the final `ok` and holds whole items,
split between items at about 256 KiB, so the client can use a part as soon as
it arrives and other frames (deltas, pings) pass between parts. An `error`
may end a response after some parts. No item is larger than a frame (a record
is at most 256 KiB), so there is no byte-level fragmentation.

`error.message` is for logs and developers; the client shows localized text by
`code`. `retry: true` means the same request may be sent again. A frame that
cannot be parsed, or a request with id 0, gets an `error` with id 0
(`protocol.malformed`, `protocol.missing_id`); the socket stays open.

Server events (`message.created`, `message.delta`, `permission.request`, …)
have id 0. When the server needs an answer (a permission decision), the event
carries its own `request_id` and the client answers with a normal request.

### Encoding rules

MessagePack has one specification, but the Rust (`rmp-serde`) and TypeScript
(`@msgpack/msgpack`) implementations differ in defaults. These are fixed, and
fixtures encoded by each side are decoded by the other in tests:

- Structs are maps with field names (`rmp_serde::to_vec_named`), never
  positional arrays; the envelope is the only array.
- Binary values (ciphertext, keys, wraps) are MessagePack `bin` and
  `Uint8Array` in TypeScript, through the protocol's `Bytes` type; a plain
  `Vec<u8>` would encode as an array of numbers.
- UUIDs are strings (the human-readable serde mode): the client uses them as
  map keys.
- Integers stay below 2^53 (ids, revisions, milliseconds); there is no `u64`
  field, because JavaScript numbers would lose precision.
- An absent optional field is omitted, never `nil`: the client encodes with
  `ignoreUndefined`.

## Connection lifecycle

1. The client opens `wss://host/ws`. No token in the URL. The server checks
   `Origin` against `CHAT_ALLOWED_ORIGINS` (exact match) and answers 403
   otherwise.
2. The first frame must be `auth { v, access_token, resume? }` within 5
   seconds, otherwise close `4002`. Before `auth` succeeds no other message is
   read. `v` is the protocol version; the server accepts the current and the
   previous one and closes with `4005` otherwise. The envelope itself never
   changes, so any version can read it.
3. `ok { session_id, heartbeat_ms, server_time }`.
4. The client sends `ping` every `heartbeat_ms` (default 20 s); the server
   answers `ok { server_time }`. Browsers cannot send or observe WebSocket-level pings,
   hence application-level ones. A client that gets no `pong` within two
   intervals treats the socket as dead and reconnects. The server closes
   sockets silent for three intervals.
5. Before the access token expires the client refreshes it over HTTP and sends
   `auth.renew { access_token }` on the open socket. A token of another session
   is refused with `auth.session_mismatch` and the socket keeps the old one. A socket whose
   token expired without renewal is closed with `4004`.
6. When the session is revoked, the server closes every socket of that session
   with `4003`; the client goes to sign-in and does not reconnect.

### Close codes

| Code | Meaning | Client action |
| ---- | ------- | ------------- |
| 1000 | Normal close | — |
| 1001 | Server going away (deploy) | Reconnect with backoff |
| 1011 | Server error (e.g. the revocation store is unreachable) | Reconnect with backoff |
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
- Nothing is replayed. After `auth` the client fetches `chat.list` and
  re-fetches the chunks it shows ([Chats and messages](#chats-and-messages));
  a streaming reply resumes from its last sealed snapshot, then live deltas
  (see [Agent sessions](#agent-sessions)).
- **In-flight requests are never dropped silently.** The client keeps
  unanswered requests in an outbox. On reconnect it resends those that are
  safe to repeat; requests that create something (`message.send`,
  `note.create`, …) carry a client-generated
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
- One turn per chat at a time. `message.send` on a chat with a running turn
  returns `error turn.busy`.

## Messages (v1)

Requests are client → server unless marked. "Events" are server → client.

### Connection

| Type | Payload | Response |
| ---- | ------- | -------- |
| `auth` | `v`, `access_token`, `resume?: { agent_session_id }` | `session_id`, `heartbeat_ms`, `server_time` |
| `auth.renew` | `access_token` | — |
| `ping` | — | `server_time` |

### Keys

| Type | Payload | Response |
| ---- | ------- | -------- |
| `keys.get` | — | `keys?: { commitment, writer_public_key, wraps: [{ wrap, created_at }], scopes: [{ scope_id, kind }] }` |
| `keys.setup` | `commitment`, `writer_public_key`, `wraps`, `scopes: [{ scope_id, kind, public_key, wrapped_private_key }]` | — |
| `keys.wrap_add` | `wrap` | — |
| `keys.wrap_remove` | `wrap_id` | — |
| `keys.recovery_rotate` | `wrap` | — |
| `scope.keys` | `scope_ids` (≤ 64) | `keys: [{ scope_id, key_version, public_key, wrapped_private_key }]` |
| `link.create` / `link.post` / event `link.message` | see [crypto.md](crypto.md#device-linking) | — |

Keys, wraps and wrapped private keys are `Bytes` in the formats of
[crypto.md](crypto.md); the client reads the public parameters of a wrap
(method, passkey credential id, PRF salt) through the crypto worker, never by
parsing it in TypeScript. The server decodes each wrap with `chat-crypto` to
check its shape and take its id and method, and stores it as it came.

- **`keys.get`** returns no `keys` before setup. `wraps` holds the passkey
  and recovery wraps and, for a session that remembered its device, that
  device's wrap; never another device's. `scopes` lists the account scopes
  created at setup (`settings`, `audit`, `profile:basics`,
  `profile:medical`, `profile:lifestyle`); chats, notebooks and registers
  come with their own lists.
- **`keys.setup`** stores everything in one transaction, or nothing. It
  needs exactly one recovery wrap, any number of passkey wraps, no device
  wrap, and one scope of each account kind. A second setup fails with
  `keys.exists`, so two devices setting up at once cannot both win.
- **`keys.wrap_add`** adds a passkey wrap (at most 20), or the wrap of the
  session's own device (method 4 with the `device_id` the session reported in
  `PUT /auth/session`; otherwise `keys.device_mismatch`). A device wrap
  replaces the session's previous one and is deleted when the session ends.
- **`keys.wrap_remove`** removes a passkey or device wrap of the account.
  The recovery wrap is never removed (`keys.recovery_required`), only rotated.
  Removing a wrap that is already gone succeeds.
- **`keys.recovery_rotate`** replaces the recovery wrap. The client sends it
  only after the user confirmed the new words; the old key stops working at
  once.
- Errors: `keys.not_set_up`, `keys.exists`, `keys.invalid` (a wrap or key that
  does not decode or breaks a rule above), `keys.limit`,
  `keys.device_mismatch`, `keys.recovery_required`. Every keys request may be
  resent: a repeat of setup, rotation or an added wrap finds its own bytes
  already stored and succeeds.
- Audit kinds: `keys.setup`, `keys.wrap_added`, `keys.wrap_removed` (details:
  `method`, `wrap_id`), `keys.recovery_rotated`.

### Chats and messages

| Type | Payload | Response |
| ---- | ------- | -------- |
| `chat.list` | `after?` (cursor) | chats: id, title record?, created_at, updated_at, `last_message_id`, `rev`, `turn` (running or not) |
| `chat.rename` | `chat_id`, title record | — |
| `chat.delete` | `chat_id` | — |
| `message.send` | see below | `message_id`, `turn_id` |
| `message.chunks` | `chat_id`, `chunks: [{ chunk, rev? }]` (≤ 8) | in parts: `chat_id`, `chunks: [{ chunk, rev, messages }]` |
| `message.edit` | `chat_id`, `message_id`, record | `rev` |
| `message.delete` | `chat_id`, `message_id` | `rev` |
| `turn.cancel` | `chat_id` | — |
| `saved.add` / `saved.remove` / `saved.list` | `chat_id`, `message_id` | — / saved refs |

Events: `chat.updated { chat }`, `chat.deleted { chat_id }`,
`message.created { chat_id, message }`, `message.updated { chat_id, message }`,
`message.deleted { chat_id, message_id, rev }`,
`message.delta { chat_id, message_id, seq, text }`,
`turn.tool { chat_id, turn_id, tool, status }`, `turn.done { chat_id, turn_id }`,
`turn.error { chat_id, turn_id, code }`. They reach every socket of the user.

A message: `id`, `author` (user, assistant, tool, summary), `created_at`,
`edited_at?`, `deleted_at?`, `state` (complete, streaming, cancelled, failed),
`rev`, `record?` (absent on a tombstone), `seq?` (the last delta a streaming
snapshot includes).

**Ids and chunks** (D-028). A chat is created by its first message, so it is
never empty. Message ids start at 0 and are dense: the server allocates the
next id from a counter on the chat row in the same transaction that inserts
the message (a database sequence would leave gaps on rollback). Messages are
addressed in chunks of 64: `chunk = id >> 6`, position `id & 63`; chunk `c`
holds ids `c << 6` to `min((c << 6) | 63, last_message_id)`.

**Revisions** (D-029). Each chat has a revision counter. Every change to a
message (creation, edit, streaming snapshot, completion, deletion) increments
it and stores the new value as the message's `rev`. A chunk's `rev` is the
largest `rev` among its messages. `message.chunks` with a `rev` returns only
the messages of that chunk changed after it, tombstones included; without one,
all of them.

**Trust.** The server is the source of truth. The client keeps the set of
chunk numbers fetched over the current socket; a disconnect clears it. A chunk
scrolled into view and not in the set is fetched (with the `rev` the client
holds, if any) and added to the set when its response completes. Events on the
same socket keep fetched chunks current; an event and a response that cross
are reconciled per message by `rev`, the higher wins.

**Sending.** `message.send` payload:

```
idempotency_key
chat_id               UUID; a new chat's id is chosen by the client
new_chat?             { public_key, wrapped_private_key, title? }  creates the chat; refused if it exists
text                  the user's message in plaintext
context               { summary?: text, messages: [{ id, role, text }] }  chosen by the client
```

The server allocates the message id, seals `text` to the chat scope public key
(D-016), stores it, answers `ok { message_id, turn_id }`, and sends
`message.created` to every socket of the user, the sender's included. The
client clears its input on `ok` and places the message when the event
arrives. Then the turn runs with `text` and `context`, which are never stored.
Attachments (after v1) are uploaded over HTTP first; their ids go with the
message.

**Streaming.** The server creates the assistant message when the reply starts
(`state: streaming`), sends its text as `message.delta` events with an
increasing `seq`, and about every 2 seconds stores a sealed snapshot of the
text so far as `message.updated` with the `seq` it includes. The final update
has `state: complete`, or `cancelled` / `failed` with the text so far. Tool
results are messages of their own. After a reconnect the client re-fetches the
chunk, gets the latest snapshot, and drops deltas whose `seq` it already has.

**Editing and deletion.** A client may edit its own messages: it seals the new
text in auth mode under the same id (the AAD binds chat and id) and sends
`message.edit`; the server replaces the record and sets `edited_at`. No history
is kept, and an edit does not rerun the turn: later context carries the new
text. Any message that is not streaming can be deleted: the record is removed
and a tombstone keeps `id`, `author`, `created_at` and `deleted_at`. Both send
the matching event.

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
| `session_context` | `session` | timezone, country, locale and local time of the current session; never IPs or the session list ([auth.md](auth.md#agent-access-to-session-data)) |

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
| `/auth/*` | Sign-in (Google, email code), refresh, sign-out, sessions, identities, audit log, account deletion: [auth.md](auth.md#http-routes) |
| `/files/*` | Encrypted chunk upload and download (after v1) |

Every HTTP error body is the error payload above (`code`, `message`, `retry`),
including unknown routes and malformed bodies. Past 512 requests in flight, or
when a response is not ready within 30 seconds, the server answers
`503 unavailable` (retry). API answers carry `nosniff`, `X-Frame-Options:
DENY`, `Referrer-Policy: no-referrer`, `default-src 'none'` and
`Cache-Control: no-store` unless a route sets its own.

## Limits

| Limit | Default |
| ----- | ------- |
| Frame size | 1 MiB |
| One record | 256 KiB |
| Response part | about 256 KiB, split between items |
| Turn context | 512 KiB |
| Grant result | 256 KiB |
| Requests per socket | 50 / s burst, 10 / s sustained |
| Unauthenticated sockets per IP | 10 (client IP per [auth.md](auth.md#client-ip-behind-proxies)) |

## Versioning and generation

- Types live in `crates/protocol` with `serde`; TypeScript is generated from
  them with `ts-rs` (stable, unlike `specta` 2, still a release candidate)
  into `client/src/protocol/generated/protocol.ts`, which is never edited by
  hand. The `typescript` test of `chat-protocol` fails when the file is stale;
  `CHAT_PROTOCOL_REGEN=1 cargo test -p chat-protocol typescript` rewrites it.
- `i64` values become TypeScript `number`s: they are timestamps (ms),
  periods (s) and revisions, far inside 2^53. `Bytes` becomes `Uint8Array`.
- Adding an optional field or a new message type is compatible. Removing or
  changing a field bumps `v`.
- `Debug` for payloads that contain plaintext or tokens is redacted, so they
  cannot end up in logs.
