# Protocol

> Status: **agreed** (2026-10-25; MessagePack frames and the chat model
> 2026-10-26). Message names and fields here are the source for
> `crates/protocol`; TypeScript types are generated from it, never written by
> hand. Payloads of registers are fixed when that feature is built.

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
decrypted provider configs and the state of a running turn. It lives in server
memory only.

- `agent.start { providers, active }` → `ok { agent_session_id }`. Sent after
  unlock; `providers` are the entries of the `providers` setting
  ([Settings](#settings)), decrypted by the client, each with its `id`, and
  `active` is the id of the active one. The client sends it again when that
  setting changes. At most 32 entries with distinct ids, and `active` among
  them, else `malformed`. An entry the server refuses is left out, unless it
  is the active one (`agent.invalid_provider`).
- A turn runs with the provider its chat names in its settings
  ([Chats and messages](#chats-and-messages)), or with the active one when the
  chat names none or one the session does not hold (removed meanwhile or
  refused).
- The session is bound to the auth session and to the socket that started it.
  When the socket drops, the agent session survives for a grace period
  (default 2 minutes) so a reconnect with `auth { resume: { agent_session_id } }`
  picks it up. After that it is dropped, with the provider config and any
  pending permission requests (answered as `denied: disconnected`).
- A turn outlives its session: one that runs when the socket drops, the grace
  period ends, `agent.start` replaces the session or `agent.stop` ends it
  keeps its copy of the provider config and runs to its end, for at most
  10 minutes (`turn.timed_out`), so a reply finishes after the tab is closed
  (D-088). Only retiring the provider, revoking the auth session, a cancel
  or a server shutdown stops it early.
- One turn per chat at a time. `message.send` on a chat with a running turn
  returns `error turn.busy`.
- A socket holds at most one agent session: `agent.start` again replaces it,
  for example after the provider settings changed. `agent.stop` ends it (no
  provider is active any more, or the keys were locked). A provider config the
  server refuses (`Provider` checks: model, base URL, address policy) is
  `agent.invalid_provider`.
- `agent.retire { fingerprints }` names provider configs the user removed or
  changed; the client that stored the change sends it. On every replica the
  user's agent sessions holding one of them end, and the turns running with
  one of them stop with `turn.interrupted`, turns whose session already ended
  included; a turn of such a session running with another config runs on. A
  fingerprint is `SHA-256("vc/v1/provider-fingerprint" || user_id || field...)`,
  with the user id as its 16 bytes and the fields `kind` (its wire name),
  `base_url`, `api_key` and `model` as sent in
  `agent.start`, each field as a 4-byte big-endian length and its UTF-8
  bytes; at most 64 of them, each 32 bytes, else `malformed`. The note goes
  over the event bus ([Event delivery](#event-delivery)); one lost in a gap
  is not replayed, so its turns run to their end.
- `auth.ok` carries `agent_session_id` when `resume` picked the session up;
  a resume from a second socket while the first still holds it closes the
  first with `4009`. Revoking the auth session drops its agent sessions at
  once, without the grace period, and interrupts their running turns
  (`turn.interrupted`).

## Messages (v1)

Requests are client → server unless marked. "Events" are server → client.

### Connection

| Type | Payload | Response |
| ---- | ------- | -------- |
| `auth` | `v`, `access_token`, `resume?: { agent_session_id }` | `session_id`, `heartbeat_ms`, `server_time`, `agent_session_id?` |
| `auth.renew` | `access_token` | — |
| `ping` | — | `server_time` |
| `agent.start` | `providers: [{ id, kind, base_url, api_key, model }]`, `active` | `agent_session_id` |
| `agent.stop` | — | — |
| `agent.retire` | `fingerprints: bytes[]` | — |

### Keys

| Type | Payload | Response |
| ---- | ------- | -------- |
| `keys.get` | — | `keys?: { commitment, writer_public_key, wraps: [{ wrap, created_at }], scopes: [{ scope_id, kind }] }` |
| `keys.setup` | `commitment`, `writer_public_key`, `wraps`, `scopes: [{ scope_id, kind, public_key, wrapped_private_key }]` | — |
| `keys.wrap_add` | `wrap` | — |
| `keys.wrap_remove` | `wrap_id` | — |
| `keys.recovery_rotate` | `wrap` | — |
| `scope.keys` | `scope_ids` (≤ 64) | `keys: [{ scope_id, key_version, public_key, wrapped_private_key }]` |
| `link.create` | — | `sid`, `expires_in_ms` |
| `link.info` | `sid` | `created_at`, `user_agent?`, `country?` |
| `link.post` | `sid`, `message` | — |
| `link.get` | `sid` | `message?` |
| event `link.message` | `sid`, `message` | |

Keys, wraps and wrapped private keys are `Bytes` in the formats of
[crypto.md](crypto.md); the client reads the public parameters of a wrap
(method, passkey credential id, PRF salt) through the crypto worker, never by
parsing it in TypeScript. The server decodes each wrap with `chat-crypto` to
check its shape and take its id and method, and stores it as it came.

- **`keys.get`** returns no `keys` before setup. `wraps` holds the passkey
  and recovery wraps and, for a session that remembered its device, that
  device's wrap; never another device's. `scopes` lists the account scopes
  created at setup (`settings`, `audit`, `profile:basics`,
  `profile:medical`, `profile:lifestyle`); chats, notes and registers
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

**Device linking** ([crypto.md](crypto.md#device-linking), direction A): the
new device creates the link session and shows the QR; the unlocked device
reads `sid` from it, asks the user, and posts the sealed ARK. The server sees
`sid` and the ciphertext only, never the QR's key or secret.

- **`link.create`** needs an account with keys. The link session belongs to
  the requesting session and lives 2 minutes; `expires_in_ms` is a duration,
  so a client with a wrong clock still renews in time. Each tab showing a code
  has its own; a session holds at most 8 live ones (`rate_limited`).
- **`link.info`** describes the session that created the link (its user
  agent and country as the server recorded them), for the confirmation on the
  unlocked device. The asking device chooses its user agent and IP, so the
  client shows this as its own description, unverified.
- **`link.post`** stores the `message` (at most 256 bytes) once: a repeat with
  the same bytes succeeds and notifies again, other bytes fail with
  `link.used`. It sends
  `link.message` to the creating session on every replica (through the
  [bus](#event-delivery)) and records the audit kind `link.completed` (details: the
  creating `session_id`).
- **`link.get`**, by the creating session only, returns the message once
  posted. The waiting client asks on every (re)connect, every 5 seconds and
  before it renews its code, so a missed event costs a few seconds at most.
- Errors: `link.not_found` for an unknown, expired or other account's `sid`,
  or one whose creating session was revoked (one code, so it reveals
  nothing), `link.used`, `keys.not_set_up` and `rate_limited`.

### Settings

| Type | Payload | Response |
| ---- | ------- | -------- |
| `settings.get` | `key` | `value?: { record, rev }` |
| `settings.put` | `key`, `record`, `rev?` | `rev` |
| event `settings.updated` | `key`, `record`, `rev` | |

A setting is one `settings.value` record ([crypto.md](crypto.md#records)) in
the account's `settings` scope, under a plaintext `key` of 1 to 64 characters
from `a-z`, `0-9`, `.`, `_`, `-`. Keys in use: `providers` and
`chat` ([crypto.md](crypto.md#record-contents)).

- **`settings.get`** returns no `value` for a key never put.
- **`settings.put`** stores the record, at most 64 KiB and sealed to the
  scope's current key version (`protocol.malformed` otherwise); an account
  holds at most 32 keys (`settings.limit`). `rev` starts at 1 and grows with
  every put. A put names the `rev` it was based on, or none for a new key;
  when the stored one differs it fails with `settings.conflict`, and the
  client reads the value again, applies its change and retries, so two
  devices never overwrite each other silently. A resend whose bytes are
  already stored succeeds with their `rev`.
- Every put sends `settings.updated` to every socket of the user, the
  sender's included ([Event delivery](#event-delivery)).
- Errors: `keys.not_set_up`, `settings.conflict`, `settings.limit`.

### Chats and messages

| Type | Payload | Response |
| ---- | ------- | -------- |
| `chat.list` | `archived?`, `before?: { updated_at, chat_id }` | `chats: [chat]`, `next?` |
| `chat.rename` | `chat_id`, `title` (record), `auto?` | — |
| `chat.title` | `chat_id`, `context` | — (the title comes as `chat.titled`) |
| `chat.pin` | `chat_id`, `position?` | — |
| `chat.archive` | `chat_id`, `archived` | — |
| `chat.configure` | `chat_id`, `settings` | — |
| `chat.delete` | `chat_id` | — |
| `message.send` | see below | `message_id`, `turn_id` |
| `chat.compact` | `chat_id`, `through`, `context` | `message_id`, `turn_id` |
| `message.chunks` | `chat_id`, `chunks: [{ chunk, rev? }]` (≤ 8) | in parts: `chat_id`, `chunks: [{ chunk, rev, messages }]` |
| `message.edit` | `chat_id`, `message_id`, `record` | `rev` |
| `message.delete` | `chat_id`, `message_id` | `rev` |
| `turn.cancel` | `chat_id` | — |
| `turn.retry` | `chat_id`, `message_id`, `text`, `context` | `turn_id` |

Events: `chat.updated { chat }`, `chat.deleted { chat_id }`,
`message.created { chat_id, message }`, `message.updated { chat_id, message }`,
`message.deleted { chat_id, message_id, rev }`,
`message.delta { chat_id, message_id, seq, text }`,
`turn.done { chat_id, turn_id }`, `turn.error { chat_id, turn_id, code }`,
`sync.reset {}`. They reach every socket of the user
([Event delivery](#event-delivery)), except `chat.titled { chat_id, title }`,
which goes to the auth session that asked for it (**Titles** below).
`turn.tool` comes with the agent tools.

A chat: `chat_id` (its scope id), `title?` (a `chat.title` record),
`created_at`, `updated_at` (when its last message was created, in
milliseconds), `last_message_id`, `rev`, `turn` (a turn is running), `pin?`
(its position among the pinned chats, from 0), `archived_at?`, `settings`,
`summary_id?` (the chat's current summary, see **Compaction** below),
`title_auto` (the title is automatic and may be replaced, see **Titles**).

**Chat settings** are what the composer's popup chooses (D-093), stored with
the chat as plaintext JSON: the server sees all of them during a turn anyway.
`chat.configure` replaces them whole and sends `chat.updated`; the last write
wins. Every field is optional, and an absent one takes the account's default,
which the client holds in its `chat` setting:

```
provider?   UUID, the id of an entry of the providers setting
effort?     low | medium | high   sent to the provider as its reasoning effort
history?    { mode: recent, messages: 1..=500 }
          | { mode: compact, auto?: bool, threshold?: 4000..=128000 }
```

The server checks the shape and refuses unknown fields (`malformed`); it uses
`provider` and `effort` and stores `history` for the client, which builds the
context. A provider that does not take an effort refuses the turn
(`provider.refused`). `recent` sends the latest messages; `compact` sends the
current summary and every message after its cut (**Compaction** below),
and with `auto` (on unless false) the client compacts before a send whose
context passes `threshold` tokens (64000 unless set), estimated as UTF-8
bytes / 4. With no `history` in the chat or the account setting, a chat
compacts automatically at 64000 (D-091).

A message: `id`, `author` (user, assistant, tool, summary), `created_at`,
`edited_at?`, `deleted_at?`, `state` (complete, streaming, cancelled, failed),
`rev`, `record?` (absent on a tombstone), `seq?` (the last delta a streaming
snapshot includes), `error?` (on a `failed` reply, its turn error code),
`through?` (on a summary, the last message id it covers). What a record holds is in
[crypto.md](crypto.md#record-contents).

**The list.** `chat.list` pages chats by `(updated_at, chat_id)`, newest
first, 100 to a page; `next` is the `before` of the following page and is
absent on the last one. Without `archived` it lists the chats outside the
archive, and pinned chats are not paged: the first page (no `before`) starts
with all of them in pin order. `archived: true` pages the archive, which holds
no pinned chats. The order moves while the client pages: a chat that gets a
message moves to the top, so a page may miss it, and its `chat.updated`
delivers it instead; the client deduplicates by `chat_id`. Searching titles is
the client's job (they are encrypted): it pages through every chat.

**Pins.** At most 32 chats are pinned. `chat.pin` with a `position` puts the
chat there (clamped to the end of the pinned list) and shifts the chats from
that position down by one; the chat pushed past the 32nd place is unpinned.
Moving a pinned chat is the same request with its new position. Without
`position` the chat is unpinned and the chats after it move up. An archived
chat cannot be pinned (`chat.archived`). Every chat whose `pin` changed gets
`chat.updated`.

**Archive and deletion.** `chat.archive` with `archived: true` unpins the
chat and moves it to the archive; `false` brings it back, as does a message
sent to it. Only an archived chat can be deleted (`chat.not_archived`):
deletion cancels a running turn and removes the chat scope, its keys and
every message, then sends `chat.deleted`. Audit kinds: `chat.created`,
`chat.archived`, `chat.unarchived`, `chat.deleted` (details: `chat_id`).

**Ids and chunks** (D-028). A chat is created by its first message, so it is
never empty. Message ids start at 0 and are dense: the server allocates the
next id from a counter on the chat row in the same transaction that inserts
the message (a database sequence would leave gaps on rollback). Messages are
addressed in chunks of 64: `chunk = id >> 6`, position `id & 63`; chunk `c`
holds ids `c << 6` to `min((c << 6) | 63, last_message_id)`. A response part
holds whole messages, so one chunk may span several parts, each naming the
chunk and its `rev`; a chunk with nothing to return is listed with no
messages.

**Revisions** (D-029). Each chat has a revision counter. Every change to a
message (creation, edit, streaming snapshot, completion, deletion) increments
it and stores the new value as the message's `rev`. Changes to the chat
itself (title, pin, archive, a turn's end) increment it too, so of two
`chat.updated` for one chat the client keeps the higher `rev`. A chunk's `rev` is the
largest `rev` among its messages. `message.chunks` with a `rev` returns only
the messages of that chunk changed after it, tombstones included; without one,
all of them.

**Trust.** The server is the source of truth. The client keeps the set of
chunk numbers fetched over the current socket; a disconnect or `sync.reset`
clears it. A chunk scrolled into view and not in the set is fetched (with the
`rev` the client holds, if any) and added to the set when its response
completes. Events on the same socket keep fetched chunks current; an event and
a response that cross are reconciled per message by `rev`, the higher wins.

**Sending.** `message.send` payload:

```
idempotency_key
chat_id               UUID; a new chat's id is chosen by the client
new_chat?             { public_key, wrapped_private_key, title?, settings? }  creates the chat; refused if it exists
text                  the user's message in plaintext
context               { summary?: text, messages: [{ id, role, text }] }  chosen by the client
```

The server allocates the message id, seals `text` to the chat scope public key
(D-016), stores it together with the empty reply (the next id, `author:
assistant`, `state: streaming`), answers `ok { message_id, turn_id }`, and
sends `message.created` for both to every socket of the user, the sender's
included. The client clears its input on `ok` and places the message when the
event arrives. Then the turn runs with `text` and `context`, which are never stored.
Attachments (after v1) are uploaded over HTTP first; their ids go with the
message.

- The socket needs an agent session (`agent.not_started`), and the chat no
  running turn (`turn.busy`).
- `new_chat` creates the chat's scope with key version 1; `chat_id` is the
  scope id. An existing id is refused with `chat.exists`, unless the request
  is a resend.
- A resend (the same `idempotency_key` in the same chat) returns the first
  result and runs no second turn.
- `text` is at most 200 KiB (`message.too_large`), the whole context at most
  512 KiB. `context.messages` are in chat order with `role` `user` or
  `assistant`; the summary goes before them, in the system prompt after an
  instruction on the reply's Markdown and its charts
  ([crypto.md](crypto.md#message-documents)).

**Streaming.** The reply exists from the send on, so every turn ends in a
message, a failure before any text included (D-089). The server sends the
reply's text as `message.delta` events with an increasing `seq` from 1, and
about every 2 seconds stores a sealed snapshot of the text so far as
`message.updated` with the `seq` it includes. The final update has `state:
complete`, `cancelled`, or `failed` with the turn's `error` code, with the text
so far (possibly empty) and, from it, the reply as a document
([crypto.md](crypto.md#message-documents)); a summary's document leaves out
its title line. While a reply streams, the client converts the text so far
with the same crate for its preview. Tool results are messages of their own. After a reconnect the client re-fetches the
chunk, gets the latest snapshot, and drops deltas whose `seq` it already has.

- A turn ends with `turn.done` (complete or cancelled) or `turn.error` with
  a code; the code is also stored on the reply, and nothing else about the
  failure is (no provider or server error text). When the database fails to
  store the end, the server still sends `turn.error` (`turn.interrupted`) and
  the reply stays streaming until the lease runs out. The codes:
  `provider.blocked` (the address policy), `provider.unreachable`,
  `provider.refused` (the provider answered with an error status),
  `provider.invalid` (a response the server cannot read), `turn.too_long`
  (the reply passed 200 KiB; it ends `failed`), `turn.timed_out` (the turn
  ran 10 minutes), `turn.interrupted` (the provider was retired, the auth
  session revoked or the server stopped). A client renders an unknown code as
  a generic error that names it.
- The chat row holds the running turn with a 30-second lease that its replica
  renews every 2 seconds; `turn` is true while the lease holds, and a turn
  that cannot renew it for 30 seconds stops with `turn.interrupted`, writing
  nothing more. When a replica dies mid-turn the lease runs out, and the next send or retry marks the
  stale reply `failed` with `turn.interrupted`. Until then a client shows a
  streaming reply of a chat whose `turn` is false as interrupted.
  `turn.cancel` reaches the replica that runs the turn through the bus.

**Retry.** `turn.retry` runs a failed reply's turn again in place: the reply
keeps its id, goes back to `streaming` with an empty text and no `error`
(`message.updated`), and streams as above. Only the chat's last message can be
retried, and only an assistant reply in `failed` state (a stale reply counts,
as above); anything else is `message.not_retryable`. The server cannot read the
chat, so the client sends the turn again: `text` is the user message the reply
answers, `context` what came before it, with the limits of a send. The other
refusals and the unarchiving are those of a send. A retry carries no
idempotency key, so the client does not resend it after a reconnect; the user
retries again. A failed summary is retried the same way, with an empty
`text` (`malformed` otherwise) and as `context` what it folds; it keeps its
`through`.

**Compaction** (D-091). A summary is a message of its own (`author: summary`)
appended to the chat like a reply: it covers every message up to its
`through` and is written by a turn from the previous summary and the messages
since. `chat.compact` starts that turn: `through` is a message id before the
summary's own (`malformed` otherwise), and `context` holds what the client
folds, the previous summary as `context.summary` and the messages after its
cut up to `through`, with the limits of a send. The server allocates the next
id, stores the summary empty and `streaming` with its `through`, answers
`ok { message_id, turn_id }` and streams it as a reply, with a summarizing
instruction of its own in place of a user message. The refusals, the
unarchiving and the one-turn rule are those of a send; it carries no
idempotency key and is not resent.

- The chat's current summary (`summary_id`) is its complete summary, not
  deleted, with the largest `through` (the larger id on a tie). The client
  builds a `compact` context from it: its text as `context.summary`, then
  the messages after `through` other than summaries, tombstones and replies
  that did not complete.
- Summaries chain like the balances of an accumulation register: each one
  folds the previous summary and the turnovers since into a new balance at
  its cut. When more than a context's limit lies between the current cut and
  the one wanted, the client compacts in steps.
- Editing or deleting a message deletes every summary that covers it
  (`through` at or past its id), sending `message.deleted` for each and
  `chat.updated`; the next compaction starts from the summary still standing.
  A covering summary that is streaming refuses the change with `turn.busy`.
  Deleting a summary deletes only itself.
- Before a send whose context passes the threshold the client compacts,
  keeping whole the latest messages up to a quarter of the threshold, and
  sends when the summary ends. When it fails the send still goes, with the
  context it has; the failed summary stays in the chat, where it can be
  retried or deleted. "Compact now" folds every message.

**Titles** (D-091). A chat's title is a `chat.title` record only the client
writes. A new chat starts with an automatic title (`title_auto`), the first
line of its first message, which the model's titles replace until the user
names the chat: `chat.rename` without `auto` sets `title_auto` to false, and
with `auto: true` it renames only a chat whose title is still automatic
(otherwise it changes nothing and still answers `ok`), so a name the user
gave on another device survives a title that was on its way.

- After the chat's first reply (message 1) completes, the client that sent
  or retried it asks for a title: `chat.title` with a `context` of the
  first exchange, with the limits of a send. The server answers `ok` at
  once and asks the chat's provider (as a send picks it) for a title, with
  an instruction of its own and no reasoning effort; the first line of the
  answer, at most 256 bytes, comes back as `chat.titled { chat_id, title }`
  within 30 seconds, or nothing does (a failure is not reported). Needs an
  agent session (`agent.not_started`).
- A summary begins with a `<title>…</title>` line, which the client takes
  off the summary's text (in the feed and in `context.summary`). When the
  summary completes, the client that started or retried it renews the
  title from it.
- The model's title is text the client does not trust: it keeps the first
  line, trims quotes and spaces, shortens it as it does a first message
  and seals it with `chat.rename { auto: true }`; an empty one changes
  nothing.

**Editing and deletion.** A client may edit its own messages (`author: user`;
others are `message.not_editable`): it seals the new text in auth mode under
the same id (the AAD binds chat and id) and sends `message.edit`; the server
checks that the record is sealed to the chat's current key version, replaces
the record and sets `edited_at`. No history is kept, and an edit does not
rerun the turn: later context carries the new text. Any message that is not
streaming can be deleted (`message.streaming` otherwise; a reply whose turn
lost its lease counts as not streaming): the record is
removed and a tombstone keeps `id`, `author`, `created_at` and `deleted_at`.
Deleting a tombstone again returns its `rev`; editing one is
`message.not_found`. Both send the matching event, and both delete the
summaries covering the message (**Compaction** above).

Errors: `chat.not_found` (unknown or another account's chat), `chat.exists`,
`chat.archived`, `chat.not_archived`, `message.not_found`,
`message.not_editable`, `message.not_retryable`, `message.streaming`, `message.too_large`,
`turn.busy`, `agent.not_started`, `keys.not_set_up`.

### Saved messages

| Type | Payload | Response |
| ---- | ------- | -------- |
| `saved.add` | `chat_id`, `message_id` | `saved_at` |
| `saved.remove` | `chat_id`, `message_id` | — |
| `saved.list` | `before?: { saved_at, chat_id, message_id }` | in parts: `items: [{ saved_at, chat, message }]`, `next?` |
| `saved.chat` | `chat_id` | `message_ids` |
| event `saved.updated` | `chat_id`, `message_id`, `saved_at?` (absent: removed) | |

A saved message (D-095) is a reference to `(chat_id, message_id)`, not a
copy: it shows the message as it is now, edits included. Any message that is
not a tombstone can be saved, whoever wrote it and while it streams too.

- `saved.add` and `saved.remove` can be resent: saving a saved message
  returns its `saved_at`, removing one not saved does nothing. Both send
  `saved.updated` to every socket of the user, the sender's included, when
  they change something.
- `saved.list` pages newest first by `(saved_at, chat_id, message_id)`, 32
  at a time, archived chats included; each item carries the chat (for its
  title) and the message as `message.chunks` returns it, split into parts
  between items. `next` is the cursor of the next page.
- `saved.chat` lists the saved ids of one chat, for its open view.
- A message turned into a tombstone leaves the saved messages in the same
  transaction (summaries deleted with it included), and a deleted chat
  takes its saved messages along. No `saved.updated` is sent for these: the
  client drops the reference on `message.deleted` and `chat.deleted`.
- At most 10 000 saved messages per account (`saved.limit`).

Errors: `chat.not_found`, `message.not_found` (unknown or a tombstone),
`saved.limit`, `keys.not_set_up`.

### Event delivery

Events reach sockets through a bus: process memory on a single instance, Redis
pub/sub when `CHAT_REDIS_URL` is set (which several replicas need anyway, for
revocation). The bus carries chat events, deltas included, link messages,
turn cancellation and provider retirement; a replica delivers to its own
sockets only what arrives from the bus, so every socket sees one order.

Delivery is at most once. When a replica's subscription comes back after a
loss, or a socket falls behind, the socket gets `sync.reset`: the client
clears its set of fetched chunks and reloads the first page of the chat list,
as after a reconnect. When Redis does not take an event, the replica still
delivers it to its own sockets, resets them, and skips Redis for a few
seconds rather than stall a turn on every delta. Sockets on other replicas
miss those events, as they miss those of a replica that dies right after its
commit, and catch up on their next reset or reconnect.

Deltas are turn content in plaintext (N1). Redis keeps pub/sub messages in
memory only (a slow publish may linger in its slow log, also in memory),
never in its snapshots or append log. Over `redis://` deltas cross the
network in the clear, so such a Redis belongs on the same host or a private
network; anywhere else it takes `rediss://` ([configuration.md](configuration.md)).

### Notes

| Type | Payload | Response |
| ---- | ------- | -------- |
| `notes.setup` | `scope_id`, `public_key`, `wrapped_private_key` | `scope_id` |
| `note.list` | `before?: { updated_at, note_id }` | `scope_id?`, `notes: [note]`, `next?` |
| `note.get` | `note_id` | `note`, `body` (record) |
| `note.create` | `note_id`, `title` (record), `body` (record) | `note` |
| `note.update` | `note_id`, `rev`, `title` (record), `body` (record) | `note` |
| `note.delete` | `note_id` | — |
| event `note.updated` | `note` | |
| event `note.deleted` | `note_id` | |

An account has one notebook in v1 (D-096): its `notes` scope, which the
first client to need it creates. A note: `note_id` (chosen by the client),
`title` (a `note.title` record, which also holds the start of the text for
the list), `created_at`, `updated_at` (milliseconds) and `rev`. Bodies come
one at a time with `note.get`, never in the list. What the records hold is
in [crypto.md](crypto.md#record-contents).

- **`notes.setup`** creates the notes scope with key version 1 when the
  account has none and returns its id; when it has one (another device
  was first, or this is a resend) it stores nothing and returns the id of
  the existing scope, and the client drops the keys it made.
- **`note.list`** pages notes by `(updated_at, note_id)`, newest first, 100
  to a page; `next` is the `before` of the following page. `scope_id` is
  absent until the scope exists, and then there are no notes. A note that
  changes while the client pages moves to the top, and its `note.updated`
  delivers it; the client deduplicates by `note_id`. Searching titles is the
  client's job: it pages through every note.
- **`note.create`** stores a note under a new `note_id`. A resend of one
  already stored with the same records returns it; other records under the
  id fail with `note.exists`.
- **`note.update`** replaces both records. `rev` names the revision the
  change was based on; when the stored one differs it fails with
  `note.conflict`, and the client stores its version as a new note named
  with the date and time instead (D-096), so no device overwrites another's
  change. A resend whose records are already stored returns the note. Every
  change raises `rev` by one and moves `updated_at` past the previous one.
- **`note.delete`** removes the note for good; deleting one that is gone
  succeeds and sends nothing.
- Records are sealed to the scope's current key version, a title at most
  2 KiB and a body at most 256 KiB (`malformed` otherwise). An account holds
  at most 10 000 notes (`note.limit`).
- Every change sends `note.updated` or `note.deleted` to every socket of the
  user, the sender's included ([Event delivery](#event-delivery)). On
  `sync.reset` or a reconnect the client reloads the list and the open note.

Errors: `notes.not_set_up` (no notes scope yet), `note.not_found`,
`note.exists`, `note.conflict`, `note.limit`, `keys.not_set_up`.

### Registers

`register.*` lists with a cursor, creates with an `idempotency_key`,
updates and deletes; values are records. Entries carry `period_start` and
`granularity` in plaintext (and in the AAD). Exact payloads are fixed when
the feature is built and added here.

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
