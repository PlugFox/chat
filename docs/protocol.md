# Protocol

> Status: **agreed** (2026-10-25; MessagePack frames and the chat model
> 2026-10-26). Message names and fields here are the source for
> `crates/protocol`; TypeScript types are generated from it, never written by
> hand.

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
| 4008 | Rate limit, frame too large, or the account holds too many sockets | Reconnect with backoff, report |
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
  picks it up. After that it is dropped with the provider config; a
  permission request waits for its own timeout (**Permissions** below).
- A turn outlives its session: one that runs when the socket drops, the grace
  period ends, `agent.start` replaces the session or `agent.stop` ends it
  keeps its copy of the provider config and runs to its end, for at most
  10 minutes (`turn.timed_out`), so a reply finishes after the tab is closed
  (D-088). Only retiring the provider, revoking the auth session, a cancel
  or a server shutdown stops it early.
- One turn per chat at a time. `message.send` on a chat with a running turn
  returns `error turn.busy`.
- Three turns per account at a time: one in a fourth chat returns `error
  turn.limit`. Each holds a provider stream and the files it reads.
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
| `auth` | `v`, `access_token`, `resume?: { agent_session_id }` | `session_id`, `heartbeat_ms`, `server_time`, `agent_session_id?`, `files` |
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
| `chat.memory` | `chat_id` | `memory?` (record, absent while empty; D-117) |
| `chat.memory.clear` | `chat_id` | — |
| `chat.title` | `chat_id`, `context` | — (the title comes as `chat.titled`) |
| `chat.pin` | `chat_id`, `position?` | — |
| `chat.archive` | `chat_id`, `archived` | — |
| `chat.configure` | `chat_id`, `settings` | — |
| `chat.delete` | `chat_id` | — |
| `activity.ping` | — | — |
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
Permission events are under **Permissions and the access log**.

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
history?    { mode: recent, messages: 0..=500 }
          | { mode: compact, auto?: bool, threshold?: 4000..=128000 }
```

The server checks the shape and refuses unknown fields (`malformed`); it uses
`provider` and `effort` and stores `history` for the client, which builds the
context. A provider that does not take an effort refuses the turn
(`provider.refused`). `recent` sends the latest messages, and with 0 none: such a chat's turns are also offered neither `read_history` nor `read_file`, and the client refuses both (D-112); `compact` sends the
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

**Temporary chats** (D-121). `new_chat.temporary` makes a chat that the server
deletes once the user has been away for 30 minutes; a chat says so with
`temporary`. `activity.ping` renews every temporary chat of the account: a
client sends it on connect and every 5 minutes while its page is visible, and
when the page becomes visible. When a socket that sent one closes, the server
renews once more, so the time away counts from the drop; a hidden tab's
reconnects renew nothing. A chat past its expiry is not renewed. A sweep at
start and every 5 minutes deletes what is due, as `chat.delete` does (with
`chat.deleted`), skipping a chat whose turn still holds its lease. So a chat
goes between 30 and about 35 minutes after the user left, also across restarts.
A temporary chat is deleted directly, without the archive; archiving or pinning
it is refused (`chat.temporary`).

**Sending.** `message.send` payload:

```
idempotency_key
chat_id               UUID; a new chat's id is chosen by the client
new_chat?             { public_key, wrapped_private_key, title?, settings?, temporary? }  creates the chat; refused if it exists
text                  the user's message in plaintext
context               { summary?: text, messages: [{ id, role, text, files? }] }  chosen by the client
files?                the message's attachments (Files below)
```

The server allocates the message id, seals `text` to the chat scope public key
(D-016), stores it together with the empty reply (the next id, `author:
assistant`, `state: streaming`), answers `ok { message_id, turn_id }`, and
sends `message.created` for both to every socket of the user, the sender's
included. The client clears its input on `ok` and places the message when the
event arrives. Then the turn runs with `text` and `context`, which are never stored.
Files are uploaded over HTTP first and go with the message as `files`
([Files](#files)).

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
with the same crate for its preview. The tool calls of the reply so far are in its record from the snapshot after each call starts. After a reconnect the client re-fetches the
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
`chat.archived`, `chat.temporary`, `chat.not_archived`, `message.not_found`,
`message.not_editable`, `message.not_retryable`, `message.streaming`, `message.too_large`,
`turn.busy`, `turn.limit` (three turns of the account run in other chats),
`agent.not_started`, `keys.not_set_up`.

### Files

| Type | Payload | Response |
| ---- | ------- | -------- |
| `file.create` | `file_id`, `chat_id`, `size`, `key` (a `file.key` record), `preview?` (a `file.preview` record), `keep?` (D-107) | — |
| `file.records` | `chat_id`, `file_ids` (≤ 64) | `files: [{ file_id, size, key, preview?, description? }]` |
| `file.usage` | — | `used`, `quota?` (bytes) |
| `file.forget` | `file_ids` (≤ 20) | — |
| event `file.described` | `chat_id`, `file_id`, `description` (a `file.description` record) | |

A file (D-101) is an object in the server's file store holding the
encrypted content ([crypto.md](crypto.md#files)), and a row with its
records: the content key, the client's preview and the model's
description. Files belong to a chat: they are sealed to its scope and are
attached to one user message. `auth` answers `files: true` when the server
has a file store; without one, `file.*` is `files.disabled` and the client
offers no attachments.

**Uploading.** The client registers the file with `file.create`, then puts
the object over HTTP: `PUT /files/{file_id}` with the access token as a
bearer token and a body of exactly `size` bytes, which the server checks
against the header (version, file id, chunk size) before it stores
anything (`201`, empty). `GET /files/{file_id}` returns the object
(`Cache-Control: private, max-age=31536000, immutable`: an object never
changes). Both answer `404 file.not_found` for an unknown file or another
account's, `PUT` answers `409 file.exists` once the object is stored and
`400 malformed` for a wrong length or header, and `GET` answers
`404 file.not_found` before the upload completes. An upload holds its file
until it ends; one that fails or is cut off lets go, so the client can put
the object again, and a second `PUT` meanwhile is `409 file.exists`. A
`PUT` streams to the store in parts and has its own limits instead of the
30 seconds and the in-flight limit of other requests: 30 seconds without
bytes, 15 minutes in all, 2 uploads at once per account and 32 per server
(`503 unavailable` past them).

- `file.create` can be resent with the same fields. `chat_id` is the chat
  the file is sealed to; it may not exist yet, since a new chat is created
  by its first message, but it may not be a scope of another kind or
  account (`chat.not_found`). The records are sealed to that chat's key
  version 1 for a new chat, its current one otherwise (`malformed`).
- `size` is at most the object of a 50 MB plaintext (`file.too_large`).
  With a quota (`CHAT_FILES_QUOTA_MB`, 1024 unless set, 0 for none) the
  account's stored and pending objects together stay within it
  (`files.quota`); `file.usage` says how much is used.
- An account has at most 100 files not yet attached (`file.limit`); a file
  not attached to a message within 24 hours is deleted, object and all,
  and one whose upload has not finished within an hour too.
- `file.forget` takes back files of the account that no message took, an
  upload still running included; the others are left as they are. The
  client sends it for a send that failed, so its files do not wait for the
  sweep; a send that went through with its answer lost keeps its files.

**What survives a failure (D-102).** Nothing waits in memory for a later
step: the client encrypts and uploads one file at a time from the picked
file, and the server streams each upload to the store and each object it
opens through the decryption. The server's state is in its rows, and a
sweep, at startup and every 5 minutes, removes what a failure leaves: rows
past their time as above, the staging files of uploads a dead server left
in a local store (after 20 minutes), and, at startup and daily, objects no
row names (after an hour). An S3 bucket needs a lifecycle rule for its
incomplete multipart uploads ([configuration.md](configuration.md)). The
client tries a `PUT` 3 times when the network or the server fails (1 and
4 seconds apart); a `PUT` whose earlier try stored the object and lost the
answer counts `409 file.exists` as done.
- `file.records` returns the rows of the chat's files asked for, uploaded
  or not; ids of other chats or accounts are left out.

**What the client sends.** Before encrypting, the client checks the file
against what every supported provider takes (D-101), in a media worker of
its own, one file at a time:

| Type | Accepted | Sent to the model as |
| ---- | -------- | -------------------- |
| Images: JPEG, PNG, WebP, GIF, and HEIC where the browser decodes it | at most 50 MB and 50 megapixels, checked from the header before decoding | a copy re-encoded without metadata, at most 2000 px on the long edge: PNG for a PNG within 7 MB, JPEG otherwise; a GIF's first frame |
| PDF | at most 50 MB and 100 pages, as far as its uncompressed objects tell (a provider refuses a longer one the client could not count) | the file |
| Text: UTF-8 files of the listed extensions (`txt`, `md`, `csv`, `json`, source code and the like) | at most 200 KiB | its text |

Anything else is refused in the composer. An image past 2000 px or 2 MB
is compressed, where the copy is the file; kept, it can also go as it is, where
the original is stored too and the copy is what the model reads. Both choices
are in the file's settings in the composer. Every image gets a preview (256 px, cut square from the middle,
JPEG) and a ThumbHash in the message record; a file not kept has no preview
and cannot go as it is. A message has at most 10 files
and 50 MB of files for the model.

**Sending.** `message.send` and `turn.retry` take `files?`, the message's
attachments in order, each:

```
file_id     the file the model reads
key         its content key (32 bytes): used for this turn, never stored or logged
name, type, size, w?, h?, hash?     as the record's files list them (crypto.md)
original?   { file_id, type, size }  an image sent as it is
```

A send attaches the files (and originals) to the user message in the same
transaction and puts the list, without keys, in the message's record; they
must be uploaded, of this chat and not attached yet (`file.not_found`
otherwise), and `text` may be empty when there are files. A retry gives
exactly the files the model reads of the user message it answers, at the
sizes the send gave, never an original (`file.not_found` otherwise). The
model never reads an original. A message deleted takes
its files along; an edit keeps them. Chat and account deletion delete their
files; objects go from the store within minutes after their rows.

**Files not kept (D-107).** A file is not kept unless `file.create` says
`keep`, and the client asks for that only when the user does, in the file's
settings in the composer: a chat is not a gallery. Such a file has no preview and no original (`malformed`,
`file.not_found`). It is encrypted, stored and given to the model like any
other. Its object leaves the store once a reply that read it is stored as
complete or stopped, if the file has a description or has spent its tries. Otherwise the sweep
takes it about an hour after the send, so a failed reply can be retried and
a file the store could not open or the model could not describe is not lost
at once. The row stays, with the description, and the message record keeps
the name and ThumbHash; it stops counting against the quota, `GET` answers
`404 file.not_found`, a retry is `file.not_found`, and `read_file` tells the
model to use the description. A store may keep the deleted object a while (configuration.md). This limits what the server stores, not what
it or the provider saw (N1).

**The turn.** The server reads the objects of the turn's files, opens them
with the keys and gives them to the model with the message, naming each by
id and name. Opened files count against a memory budget of the replica
(`CHAT_FILES_MEMORY_MB`, 256 unless set) for as long as the turn and its
descriptions hold them; a turn that finds no room within 30 seconds fails
with `files.busy`, and `read_file` answers the model that the file cannot
be opened now. A file whose plaintext is not the size the send
gave (padding leaves room for a little more) does not open. It takes the
type from the content, not from `type`: JPEG, PNG and PDF by their signature, text when it is UTF-8; anything else reaches
the model as a note that the file could not be read. A turn sends at most
50 MB of files and 100 images in all, `read_file` included.

Context messages carry `files?` too: `[{ file_id, name, type, size, w?, h?,
description? }]`, with the description the client opened, and reach the
model as a line per file in place of the file, so a later turn costs a few
hundred tokens per file instead of thousands. The model opens one again
with `read_file` ([Agent tools](#agent-tools-v1)); `read_history` lists
the files of the messages it returns the same way.

**Descriptions.** For each file a send or retry gives the model and that has
no description yet, the server asks the turn's provider, beside the reply,
for a description of that file alone, with an instruction of its own (what
it shows, any text in it, the details a later question may need) and no
reasoning effort or tools. The answer, cut at 4 KiB, is sealed as the
file's `file.description` record and sent as `file.described` to every
socket of the user. Each file has 3 tries, counted before each runs, so a
server that dies in one has spent it: a send, a retry or a `read_file` of
a file without a description and with tries left asks again. After the
third fails the user gets the notice `file.undescribed`, and the file is
described by its name and type. The client shows a description as an
image's alternative text.

Errors: `files.disabled`, `files.quota`, `file.too_large`, `file.limit`,
`file.not_found`, `chat.not_found`, `malformed`, `keys.not_set_up`.

### Notices

| Type | Payload |
| ---- | ------- |
| event `notice` | `code`, `chat_id?`, `file_id?` |

What the server tells every socket of the user about work that ended on
its own, which no request is waiting for; the client shows it as a toast by
`code` and ignores a code it does not know. Codes: `file.undescribed` (the
last try at a file's description failed).

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
turn cancellation, provider retirement and permission answers, results
included, to the replica running the turn; a replica delivers to its own
sockets only what arrives from the bus, so every socket sees one order.

Delivery is at most once. When a replica's subscription comes back after a
loss, or a socket falls behind, the socket gets `sync.reset`: the client
clears its set of fetched chunks and reloads the first page of the chat list,
as after a reconnect. When Redis does not take an event, the replica still
delivers it to its own sockets, resets them, and skips Redis for a few
seconds rather than stall a turn on every delta. Sockets on other replicas
miss those events, as they miss those of a replica that dies right after its
commit, and catch up on their next reset or reconnect.

Deltas and approved tool results are turn content in plaintext (N1). A
gap in the notes while a turn waits for an answer makes it look the request
up in the database; an approval whose result was lost tells the model so. Redis keeps pub/sub messages in
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

Measurements (weight, steps, calories) are kept as in 1C (D-097): a
catalog of metrics, like a chart of characteristic types, says what each
one is, and a register of a kind of record holds the entries. v1 has one
register kind, `measurements`: one number at a moment, any number of them
a day or none.

| Type | Payload | Response |
| ---- | ------- | -------- |
| `metric.list` | — | `categories: [category]`, `metrics: [metric]`, `registers: [register]` |
| `register.setup` | `metric`, `scope_id`, `public_key`, `wrapped_private_key` | `scope_id` |
| `register.entries` | `metric`, `from?`, `to?`, `before?: { occurred_at, entry_id }`, `limit?` | `entries: [entry]`, `next?` |
| `register.create` | `entry_id`, `metric`, `occurred_at`, `value` (record) | `entry` |
| `register.update` | `entry_id`, `rev`, `occurred_at`, `value` (record) | `entry` |
| `register.delete` | `entry_id` | — |
| event `register.updated` | `entry` | |
| event `register.deleted` | `entry_id`, `metric` | |

- **The catalog** is the same for every account and plaintext; the server
  seeds it with migrations and has no request that changes it. A
  `category` is `key`, `names` (locale → text) and its place in the order.
  A `metric` is `key` (stable, never reused, such as `body.weight`),
  `category`, `register` (`measurements`), `names`, `unit` (metric: `kg`,
  `cm`, `count`, `kcal`), `quantity` (`mass`, `length`, `count`, `energy`:
  what the client may convert the unit to for display), `value_type`
  (`decimal` or `integer`), `precision` (decimal places), `min`, `max` and
  `aggregate` (`avg` or `sum`: how a day's entries make one value) and
  `sets` (D-128: the entries of a day are sets of an exercise, shown with
  their count and the best of them; the agent may propose several at once). The
  client shows a name in its locale, else English, else the key; units are
  the client's strings, since converting them is client code. A metric the
  client does not know a register kind of is not shown.
- **`registers`** of `metric.list` are the account's registers: `metric`,
  `scope_id`, `entries` (how many) and `latest_at?` (the `occurred_at` of
  the newest entry). Each register has a `register` scope of its own, so a
  grant to the agent opens one metric and not the others.
- **`register.setup`** creates the scope of the metric's register, with key
  version 1, when the account has none, and returns its id; when it has one
  it stores nothing and returns the existing id, as `notes.setup` does.
- **An entry** is `entry_id` (chosen by the client), `metric`,
  `occurred_at` (seconds since the Unix epoch, UTC: the `period_start` of
  its record, with granularity `instant`), `value` (a `register.value`
  record, at most 1 KiB, sealed to the register's current key version;
  `malformed` otherwise), `updated_at` (milliseconds) and `rev`.
  `occurred_at` is between 1900 and 2200.
- **`register.entries`** pages one metric's entries by `(occurred_at,
  entry_id)`, newest first: `from` (inclusive) and `to` (exclusive) bound
  `occurred_at`, `limit` is 1–1000 (1000 when absent), `next` is the
  `before` of the following page. A chart and the agent read the newest
  1000 and page back from there. A metric without a register has no
  entries.
- **`register.create`** stores an entry; a resend with the same fields
  returns it, other fields under the id fail with `register.exists`. An
  account holds at most 1 000 000 entries (`register.limit`).
- **`register.update`** replaces `occurred_at` and `value` (a new moment
  needs a new seal: it is in the AAD). `rev` is the revision the change was
  based on; when the stored one differs it fails with `register.conflict`,
  and the client keeps the stored entry (its `register.updated` came
  before the answer) and says so. A resend whose fields are stored returns
  the entry.
- **`register.delete`** removes the entry for good; one that is gone
  succeeds and sends nothing.
- Every change sends `register.updated` or `register.deleted` to every
  socket of the user; on `sync.reset` or a reconnect the client reloads
  what it shows.
- Days, sums and averages are the client's: the server cannot open values.
  An entry's day is the date at the time zone offset stored in its record.

Errors: `metric.not_found`, `register.not_set_up` (no scope for the metric
yet), `register.not_found` (no such entry), `register.exists`,
`register.conflict`, `register.limit`, `keys.not_set_up`.

### Permissions and the access log

A data tool (**Agent tools** below) asks the user first (D-099), except
`read_history` and `read_file`, which the client answers itself (D-100,
D-101). The server
writes the request to the access log, seals the model's reason to the
`audit` scope (an `audit.reason` record whose `log_entry_id` is the
request id) and sends the request to the auth session that sent the
turn's message: every socket of it, not the user's other devices.

Event `permission.request` (also an item of `permission.pending`):

```
request_id    UUID, the access log entry
chat_id, turn_id
provider_id   UUID, the entry of the providers setting the turn runs with
grant         { tool: read_register, metric, scope_id, from?, to? }
            | { tool: session_context }
            | { tool: read_history, before, count }
            | { tool: read_file, file_id }
            | { tool: add_measurement, metric }
            | { tool: set_goal, metric }
            | { tool: web_fetch }
            | { tool: run_code }
            | { tool: get_weather }
reason        an audit.reason record: what the model wrote, at most 500 characters;
              for add_measurement also the proposed entry, for web_fetch the address,
              for run_code the code and its inputs, for get_weather the place
              (crypto.md, "Record contents")
expires_at    ms
```

`from` and `to` are days, `YYYY-MM-DD`, both included; an entry belongs to
the day of its own time zone offset. Absent means unbounded. `before` is a
message id of the turn's chat and `count` (1..=50) how many ids before it
the client reads.

- `permission.pending {}` → `ok { requests }`: the auth session's requests
  still waiting, oldest first. The client asks after every connect, so a
  reload shows the dialog again.
- `permission.respond { request_id, decision, result? }` → `ok {}`.
  `decision` is `approve`, `deny`, `refuse` (the client does not know the
  scope, or the metric is not the one that scope holds, or the chat does not
  open; it answers without a dialog) or `answer`, which only `read_history`,
  `read_file` and `run_code` take, and which take only it and `refuse`. `result` is the
  tool result in plaintext, required when approving `read_register` or
  `add_measurement` or `set_goal` or answering and refused otherwise, at most 64 KiB of UTF-8, 32 KiB for
  `read_history` and `run_code`; for `read_file` it is the file's content key, 32 bytes
  in unpadded base64url. Only the
  auth session the request went to answers it, once: an answered, expired
  or foreign request is `permission.not_found`.
- `permission.resolved { request_id, chat_id, outcome }` goes to the same
  auth session when a request ends however it ends, so every tab closes its
  dialog.

The client renders the dialog from its own data: the metric's name from its
catalog, the days from `grant`, the provider's host from its own providers
setting (the host every reply with the data goes to), the reason quoted as
the agent's words. It never shows a string the server chose. A request
names one grant and is approved or denied whole; the days cannot be
narrowed. A request whose provider is not in the client's settings cannot
be approved: the client cannot tell where the data would go.

On approval the client reads the register's entries of those days (the
newest 1000, D-097) and answers with JSON: `metric`, `unit`, `aggregate`,
`entries` (newest first, each `at`, the local time with its offset,
`value` in the metric's unit and `comment?`) and `truncated` when entries
were left out (past 1000, or the oldest dropped to fit 64 KiB). For
`session_context` the server fills the result itself (D-041).

An `add_measurement` request (D-106) asks to add one entry, or for a metric
with `sets` one entry per set (D-128), never to change or delete one. The value, day and comment are the user's data, so they travel
sealed in `reason`, and the access log stores only the tool and the metric in
the clear. The client shows what it opened: the metric from its catalog, the
value with the metric's unit, the day, the comment, and how many entries that
day already has. Writing is the client's: only it can seal `register.value`
(crypto.md, "Authenticity"), so a request the user does not approve writes
nothing. The client refuses without a dialog a proposal that does not open or
parse, a metric it does not know, a value the metric does not allow, several
values for a metric without `sets`, a comment past 500 bytes, and a day after
today on this device. The first entry's id is the request's, and each later
set's is the request's with its last byte XORed with the set's index, so a
second save of any of them stores nothing new.

A `set_goal` request (D-124, D-126) works the same way: its `target?`, `since?` and `until?` travel sealed in `reason`, no `target` removes the goal and no `since` starts the path on the device's today, and the client refuses without a dialog a proposal that does not open or parse, a metric it does not know, a target the metric does not allow, and an `until` not after the start. On approval it answers with JSON (`stored`, `metric`, `unit`, `target?`, `since?`, `until?`), then writes the `goals` setting.

On approval the client answers first, with JSON: `recorded` (true), `metric`,
`unit`, `value` and `day`. Only an answer the server takes writes anything, so a
request that ended (denied in another tab, expired while the device slept)
stores nothing. The client then stores the entry with `register.create`, setting up the
register first if the account has none. The entry's id is the request's id, so
saving again stores nothing new (the client reads `register.exists` as stored). Absent `day`, or today, the entry
takes the present moment; an earlier day takes noon of that day on this device.
When its answer's reply was lost, approving again meets `permission.not_found`,
and the client looks the request up in the access log: approved, it stores
the entry. A save that fails is shown with a way to try again, as the model
has been told the entry is stored; a tab closed in that moment leaves it
unsaved. After a denial or refusal the metric is not asked again in that turn,
as for any grant. A new turn is a new request: a retried reply can ask again,
and the dialog's count of the day's entries is what shows it.

A `read_history` request shows no dialog: the client fetches the chunks of
the ids `before − count` to `before − 1`, opens them and answers with JSON:
`messages` (oldest first, each `id`, `role` `user` or `assistant`, `at`, the
local time with its offset, `text`, `files?` as context messages carry them,
and `truncated` when the text was cut to fit) and `before?`, the id to ask before next, absent when the chat has no
earlier messages. Tombstones, summaries and messages that do not open or
are empty are left out. Past 32 KiB the oldest messages are dropped (and
`before` moves up to the oldest kept); a single message that alone does not
fit is cut. Only the tab that started the turn answers: it knows the turn
by the `turn_id` its `message.send` or `turn.retry` was answered with
(waiting a few seconds for that answer, which may come after the request),
answers only in that turn's chat, refuses `count` past 50 and a turn's
history past 128 KiB, and leaves a request it cannot fetch for a dropped
connection to time out. Other tabs ignore it; after a reload it times
out.

A `read_file` request shows no dialog either: the tab that started the
turn, bound to it as for `read_history`, gets the file's `file.key` record
with `file.records`, opens it with the turn's chat key (a file of another
chat does not open) and answers with the key; the server reads and opens
the object and gives it to the model as a send does. A file the turn
already gave the model is answered without asking. The access log keeps
the file id.

A `run_code` request shows no dialog either: the tab that started the turn,
bound to it as for `read_history`, opens the sealed code and runs it in a
worker of its own holding QuickJS in WASM, with `console.log` and `inputs` and
nothing else, at most 64 MiB, one thread, 3 seconds in the interpreter, the
worker ended after 10 at most. It answers with JSON: `output`, `value?`,
`truncated?` and `error?` (the message and the line). Whatever goes wrong with
the code or its inputs is such an answer, for the model to correct and call
again, within the turn's calls. `inputs.registers` holds only what the user
approved in this turn on this tab, so code opens no register past its dialog;
`inputs.files` holds text files of this chat, none in a chat without history.
A refused run does not close the tool for the rest of the turn.

A `web_fetch` request shows a dialog with the host and the whole address.
Approving allows the host until the turn ends: later reads there ask no one.
The server reads it: `GET`, `https://` on the default port only, public
addresses only with no operator exception, through the checks of
[Provider endpoints](#provider-endpoints), no cookies, no redirects, 10
seconds, 2 MiB read, HTML reduced to its text, 32 KiB to the model. Every
status comes back: `ok` (false outside 2xx), `status`, `type`, `text`,
`truncated?`; a redirect gives `redirect`, the target, which the model calls
as a new read and so a new host asks again; what is not text gives `error`.

A request ends:

| Outcome | When |
| ------- | ---- |
| `approved`, `denied`, `refused`, `answered` | the client answered |
| `timeout` | 5 minutes passed without an answer (30 seconds for `read_history` and `read_file`), or less, so that 30 seconds of the turn's own limit are left for the reply |
| `cancelled` | the turn ended first (cancelled, interrupted, its chat deleted) |

A closed tab leaves the request to its timeout; the model then hears that
the user did not answer. After a denial (or refusal) the same grant asked
again in that turn is denied without a dialog, so a model, or text it read,
cannot wear the user down with repeated requests; nothing is logged for
those.

**The access log** holds every request: when it was made and answered, the
chat and turn, the tool, the register's metric and scope, the days, the
message ids of a history read, the file of a `read_file`, that a site was read or code run (their address and code sealed), the outcome, and the reason, which the server gets from the model during the
turn (N1) and stores sealed; the rest it stores in the clear (N5). A request
that never got an outcome (its turn died with its replica) reads as
`timeout` a minute after it expired. Entries stay when their chat is deleted (the chat id remains) and
are deleted after 365 days, as audit events are (D-040), and with the
account. `access_log.list { before? }` → `ok { entries, next? }` pages it
newest first, 50 entries a page; `before` is the `next` of the previous
page. An entry: `id`, `chat_id`, `grant`, `reason`, `outcome?` (absent
while waiting), `requested_at`, `decided_at?` (ms).

Errors: `permission.not_found`, `keys.not_set_up`, `malformed`.

## Agent tools (v1)

The model gets these tools in every reply turn; summaries and titles get
none. A turn makes at most 8 tool calls; past that a call is answered with
an error, and the next request offers no tools, so the model has to reply. Tool calls of a reply are not sent with
later turns, nor stored with their results: the reply's record lists each
call and its outcome ([crypto.md](crypto.md#record-contents)), and a later
question asks again.

| Tool | Grant | Returns |
| ---- | ----- | ------- |
| `list_metrics` | none | the metric catalog (key, English name, unit, how a day adds up) with the number of entries and the newest entry's time for each metric the account has entries for ([Registers](#registers)) |
| `read_register` | `register:<scope id>` | `metric`, `from?`, `to?` (days, as above) and `reason`: the entries of those days, read and decrypted by the client |
| `session_context` | `session` | `reason`: the time zone, country and locale of the auth session that sent the message, and the time in UTC; never IPs or the session list ([auth.md](auth.md#agent-access-to-session-data)) |
| `read_history` | none, answered by the client (D-100) | `before?`, `count?` (1..=50, 50 if absent) and `reason`: the turn's chat's messages before `before`, read and decrypted by the client, as above |
| `read_file` | none, answered by the client (D-101) | `file_id` and `reason`: the file itself, as a send gives it, after its line in the context told the model about it |
| `write_memory` | none, answered by the server (D-117) | `content` (at most 8 KiB, longer is an error and saves nothing; empty removes the memory): replaces the chat's whole memory, sealed as `chat.memory`. The client reads it anew for each send and retry and sends it as `context.memory`, whatever the history setting; a compaction or title request does not carry it. The server puts it in the system prompt |
| `set_goal` | `register:<metric>`, a dialog every time (D-124, D-126) | `metric`, `target?`, `since?`, `until?` (days, `until` after `since`) and `reason`: replaces the metric's goal, no `target` removes it; written by the client into the `goals` setting; the result confirms it. `read_register`'s result carries the current `goal` |
| `web_fetch` | a dialog per host per turn (D-114) | `url` and `reason`: the page's text, read by the server, as above |
| `get_weather` | none for a named place; for the place by IP, a dialog each time (D-116) | `place?`, `days?` (1..=7, 1 if absent) and `reason`: the current weather and daily forecast from Open-Meteo, the place it is for and the source. Without `place` the server looks up the session's IP in the city database; with none or no match the model hears to ask for the city. `place` takes letters and little else, 80 characters at most. Off with `CHAT_WEATHER=off` |
| `run_code` | none, answered by the client (D-115) | `code` (at most 16 KiB), `files?`, `registers?` (at most 8 each) and `reason`: what the code printed and returned, or its error, as above |
| `add_measurement` | `register:<metric>`, a dialog every time (D-106) | `metric`, `value` (in the metric's unit) or, for a metric with `sets`, `values` (1 to 20, one entry each, D-128), `day?` (`YYYY-MM-DD`, today if absent), `comment?` and `reason`: adds the entries, written by the client; the result confirms them |

`read_history` is offered only when the chat has messages before the
context the client sent; the system prompt names the first id of that
context, and a `before` past it reads from it. A turn reads at most 128 KiB
of history: a call that could pass it is answered with an error.
`read_file` is offered when the chat has files the turn did not send, and
opens any of them but originals; a call past the turn's files limit is answered with an
error.

The system prompt lists the catalog in one line (key, English name, unit,
how a day adds up), so the model names a metric without calling
`list_metrics` first: a wrong key costs a round that resends the whole
context. A call's `metric` may be the key, the key without its category or
the metric's name in any locale, compared in lower case with letters and
digits only; the server replaces it with the key before the grant, the
dialog and the access log see it. A name that matches no metric or more
than one is an error that lists the keys.

The server answers without asking when asking would tell the user nothing:
a metric not in the catalog, malformed days or arguments (an error), a
metric without entries for a read (no entries), and a value outside the metric's range (an
error). Results are JSON text; the model is
told that the data is the user's own.

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

A turn's `context` may hold `mentions` (D-123): each `name` and `text`, read by
the client from a note or a metric the user chose with `@`, at most 5 of them:
a note's text up to 32 KiB, a metric as `read_register`'s result. They join the message for the model in that turn, with
no dialog, as choosing is the consent; nothing stores them, and a retry or a
later turn does not have them. The composer names the provider's host while a
message mentions something.

Adapters (`server/src/providers/`): OpenAI-compatible Chat Completions
(`{base}/chat/completions`, SSE `choices[].delta`, tool calls assembled by
`index`) and Anthropic Messages (`{base}/v1/messages`, `anthropic-version:
2023-06-01`, consecutive same-role messages merged). Both yield text deltas,
complete tool calls, a stop reason and, when the provider counts them, tokens.
Chat Completions asks for them with `stream_options`; a server that answers
400 or 422 naming that field gets the request again without it. A fake provider in
`server/tests/support/fake_llm.rs` speaks both formats with scripted replies
for deterministic agent tests.

### Provider links

A provider config travels to another device or person as a link, shown as a
QR code or copied, built at the moment the user asks for it (D-098):
`https://host/provider#1.<config>`. `1` is the format version; `<config>` is
base64url without padding of a MessagePack map with `kind`, `name`,
`base_url`, `model` and, unless the user leaves it out, `api_key` — the
fields of a `providers` entry without its `id`. The fragment never reaches the
server. It is not encrypted: whoever sees the QR or holds the link has the key.

- The opening page reads the fragment once, before anything renders, and
  removes it from the address bar and the history entry; the config waits in
  memory while the tab is unlocked. A page that is not signed in drops it and
  says to sign in and scan again.
- Nothing is added without the user's confirmation, which shows the name, the
  API, the base URL's host (every turn with this provider goes there) and the
  model. The new entry gets a new `id` and is not made active unless the
  account has no active provider. An entry equal in kind, base URL, model and
  key is not added twice.
- The add form takes a pasted link from any host, so a link opens on another
  server too.
- A reader refuses a fragment over 4096 characters, another version, an
  unknown `kind`, an empty `name` or `model`, or a base URL that is not
  `http(s)`; fields it does not know are ignored.

## HTTP

| Route | Purpose |
| ----- | ------- |
| `GET /health` | Liveness: process up |
| `GET /ready` | Readiness: database reachable |
| `/auth/*` | Sign-in (Google, email code), refresh, sign-out, sessions, identities, audit log, account deletion: [auth.md](auth.md#http-routes) |
| `PUT /files/{file_id}`, `GET /files/{file_id}` | A file's encrypted object ([Files](#files)) |

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
| Grant result | 64 KiB; 32 KiB of history, 128 KiB of history per turn |
| File | 50 MB of plaintext; 10 a message; a turn's files at most 50 MB and 100 images |
| File records | preview 64 KiB, description 4 KiB of text |
| Requests per socket | 50 / s burst, 10 / s sustained |
| Unauthenticated sockets per IP | 10 (client IP per [auth.md](auth.md#client-ip-behind-proxies)) |
| Authenticated sockets per account | 20 on each replica |
| Turns per account | 3 at once, across replicas |

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
