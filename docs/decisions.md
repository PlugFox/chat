# Decisions

One line per decision, plus why and what was rejected when it is not obvious.
Details live in the linked page; this log is what stops a settled question
from being reopened. Procedure: skill `decision`.

Tags: `[user]` decided by the user, changes only with the user's approval ·
`[accepted]` proposed by an agent, approved by the user · `[agent]` an
implementation choice, revised freely but recorded. Never renumber; a replaced
entry keeps its text and gets `superseded by D-NNN`.

## Product and scope

D-001 [user] A self-hostable personal AI assistant with client-held keys: chat with an LLM agent, notebook, saved messages, personal data registers. Open source, AGPL-3.0 (`AGPL-3.0-only`). 2026-10-25.
  → docs/brief.md

D-002 [user] Stack: Rust server (axum, sqlx, PostgreSQL), SolidJS client, one Rust crypto crate compiled natively and to WASM, the agent loop on the server with per-turn permission grants. Redis, SMTP and S3 optional.
  → docs/brief.md

D-003 [user] Honest guarantees only: no "end-to-end" claims; the server and the LLM provider see the active turn (N1). Losing every unlock method loses the data (G4).
  → docs/threat-model.md

D-004 [accepted] Rust packages are named `chat-*` (`chat-crypto`, `chat-protocol`, `chat-server`).

D-005 [user] Talk to the user in Russian; everything in the repository is English. No AI attribution anywhere.
  → CLAUDE.md, ~/.claude/CLAUDE.md

D-006 [user] Docs record what the code does not: decisions, contracts, reasons, measurements, links. They never restate code in English.

D-007 [user] Code style is the linters' and formatters' job (rustfmt, clippy, Biome, Stylelint, taplo, ast-grep), applied automatically; agents, skills and rules do not carry style guidance. Saves tokens and context.
  → lefthook.yml, sgconfig.yml

## Cryptography

D-010 [accepted] Records the client writes use HPKE auth mode with a writer key derived from the ARK; a reader rejects base mode for client-only kinds, so the server can neither forge nor downgrade them.
  rejected: separate signatures (a second key, a second format).
  → docs/crypto.md#authenticity
  Narrowed by D-016 for chat messages.

D-011 [accepted] The recovery key is 12 BIP-39 English words in every UI language (encoding only, no seed derivation).
  why: one list keeps the key portable between locales; short, distinct words.
  → docs/crypto.md#ark-wraps

D-012 [accepted] Profile data is split into `profile:basics`, `profile:medical`, `profile:lifestyle` scopes, so a grant can name one group.
  → docs/crypto.md#scope-kinds

D-013 [agent] HPKE from the `hpke` crate (rozbb), default features off.
  why: ~130 KiB WASM vs ~690 KiB, RustCrypto primitives we use anyway, MIT/Apache.
  rejected: `hpke-rs` + libcrux (0.0.x crates, MPL-2.0, size).
  → docs/crypto.md#crate-choice

D-014 [agent] Passphrase unlock is not in v1: the operator could guess it offline (N7).

D-015 [agent] Device linking authenticates the exchange with a one-time secret in the QR fragment (HPKE PSK mode), so the relaying server cannot substitute keys.
  → docs/crypto.md#device-linking

D-016 [user] The server seals chat messages, the user's included, and assigns their ids; a client seals only its edit of its own message. Auth mode stays for kinds only a client writes (titles, notes, registers, profile, settings).
  why: anyone who can write to the database can forge assistant messages anyway, and those inject as well as forged user messages would; server-assigned ids keep the send flow simple.
  rejected: client-proposed ids with retry on conflict (keeps user messages authentic, protects little while assistant messages are forgeable); AAD bound to a record UUID (lets the server reorder).
  open: whether and how to protect chat messages from forgery at all; a rare case, to be thought through separately. Client countersigning is one candidate, not a commitment.
  → docs/crypto.md#authenticity, docs/threat-model.md (N3)

D-017 [user] Without a PRF-capable passkey the recovery key is the only unlock method; it is typed at every unlock until the device is remembered.

D-018 [user] "Remember this device" is off by default and warns (N6). [accepted] It is split: a device secret in IndexedDB under a non-extractable WebCrypto key, and an ARK wrap under that secret on the server, returned only to the device's own session and deleted with it. Neither half unlocks alone.
  rejected: a purely local wrap (revoking the session cannot stop a stolen device).
  → docs/crypto.md#remember-this-device

D-019 [accepted] Each tab unlocks on its own; the ARK never crosses between workers.
  rejected: handing the ARK to other tabs over BroadcastChannel (key material in JS messages for one tap saved).

## Protocol and transport

D-020 [agent] WebSocket for everything interactive; HTTP only for auth flows, files and health.
  → docs/protocol.md

D-021 [agent] TypeScript types are generated from `crates/protocol` with `ts-rs`; a test fails when the file is stale.
  rejected: `specta` 2 (release candidate at the time).

D-022 [agent] Heartbeat is an application `ping` answered with `ok { server_time }`, not a separate `pong` message: browsers cannot send WebSocket pings.

D-023 [user] The WebSocket authenticates with the access token in its first frame, never in the URL.
  [agent] Not with the refresh cookie: one credential for HTTP and WS, short-lived, no cross-site WebSocket hijacking surface, and it works unchanged for a future body-transport mode.
  → docs/protocol.md#connection-lifecycle

D-024 [agent] Provider base URLs are an SSRF vector: private and metadata ranges are refused after DNS resolution, the address is pinned, no redirects, no system proxy; operators allow LAN models with `CHAT_PROVIDER_ALLOWED_NETWORKS`.
  → docs/protocol.md#provider-endpoints

D-025 [agent] Every HTTP error body is the protocol `ErrorPayload`; past 512 requests in flight or a 30 s response deadline the server answers `503 unavailable`. Limits are constants until someone needs to tune them.
  → docs/protocol.md#http, server/src/middleware.rs

D-026 [user] WebSocket frames are MessagePack, binary; the schema stays the Rust types in `crates/protocol` with TypeScript generated from them.
  why: content is ciphertext, so binary saves the base64 third and its decoding, and bytes go to the worker as transferable buffers.
  rejected: JSON (base64), Protobuf and FlatBuffers (a second schema language, codegen, runtime size; zero-copy is wasted before decryption), a custom byte codec (hand-written parsers in two languages). A custom codec is the fallback if the Rust and TypeScript implementations ever disagree.
  → docs/protocol.md#envelope

D-027 [accepted] A response of many items arrives in parts of about 256 KiB split between items, so a large page never blocks deltas and pings; no single item exceeds a frame, so no byte-level fragmentation. No permessage-deflate: ciphertext does not compress, and compressing secrets beside attacker-chosen data invites CRIME-style attacks.

D-028 [user] Chat messages are addressed in chunks of 64 (`chunk = id >> 6`); ids start at 0 and are dense, because a chat is created by its first message and an id is allocated in the same transaction as its row. The client trusts a chunk only once fetched over the current socket; a disconnect clears the set.
  → docs/protocol.md#chats-and-messages

D-029 [accepted] Change detection by a per-chat revision counter, not timestamps (no ties); edits replace the record, deletion leaves a tombstone without content. Streaming is an update of the assistant message: deltas live, a sealed snapshot every few seconds, so a reconnect needs no separate turn state.
  rejected: `updated_at` (ties within a clock tick), a presence bitmap (ids are dense).

D-077 [accepted] Events reach sockets through a bus: process memory on one instance, Redis pub/sub with `CHAT_REDIS_URL` (needed for replicas anyway). It carries chat events, deltas, link messages and turn cancellation; a lost subscription or a lagging socket gets `sync.reset`. Link polling (D-076) stays. 2026-10-26.
  why: one mechanism beside the revocation channel, no 8 KB payload limit, no PostgreSQL connection per listener.
  rejected: PostgreSQL `NOTIFY` (payload limit; deltas would pass through the database, whose statement log may keep them).
  → docs/protocol.md#event-delivery

D-078 [accepted] Deltas cross replicas through the bus, so every device sees a reply live. Redis keeps them in memory only; over plain `redis://` it belongs on the same host or a private network, elsewhere `rediss://` (D-085).

D-079 [accepted] `chat.list` pages by `(updated_at, chat_id)`, 100 to a page; pinned chats come whole on the first page. Search over encrypted titles is client-side and pages through everything; a server-side index would reveal content (G1).
  rejected: the whole list at once (grows without bound); a cursor over `updated_at` alone (ties).

D-080 [user] Pinned chats have an order the user drags: pinning at a position shifts the rest down, at most 32, the one pushed past the end is unpinned.

D-081 [user] Deleting a chat removes all its content, and only an archived chat can be deleted; the archive is its own list. [accepted] A message sent to an archived chat brings it back.

D-082 [agent] A `chat.message` record holds a MessagePack map with `text`, readers ignoring unknown fields, so attachments and tool calls need no new record version; a `chat.title` is UTF-8.
  → docs/crypto.md#record-contents

D-083 [agent] A running turn is a 30-second lease on the chat row, renewed every 2 seconds, so a replica that dies mid-turn blocks its chat for at most the lease.

D-084 [agent] Chats are audited when created, archived, unarchived and deleted; messages, edits, renames and pins are not (volume, and the chat itself carries their traces).

D-085 [user] `CHAT_REDIS_URL` may be `rediss://`: TLS over rustls, verified against the system trust store, with no insecure mode. 2026-10-26.
  → docs/configuration.md

D-086 [user] LLM providers are one `providers` setting: a list with one active provider, which every turn uses; a choice per chat comes later (superseded in part by D-093). The form takes kind, name, base URL, API key and model, with presets for OpenAI, Anthropic, OpenRouter and Ollama; v1 has no connection test. The client starts the agent session with the active provider after unlock and again when the setting changes.
  → docs/crypto.md#record-contents

D-087 [agent] A setting carries a revision; a put names the one it was based on and fails with `settings.conflict` otherwise, so two devices never overwrite each other's change silently. At most 32 keys of 64 KiB each.
  → docs/protocol.md#settings

D-088 [user] A turn outlives its agent session: closing the tab, the grace period, a new start or `agent.stop` leave a running reply to finish, for at most 10 minutes. Removing or changing a provider retires its config by fingerprint (`agent.retire`), which ends its sessions and turns on every device; renames, additions and switching the active provider stop nothing. Locking the keys sends `agent.stop`. The UI says that removing a provider does not revoke its key at the provider. 2026-10-26.
  → docs/protocol.md#agent-sessions

D-089 [user] A reply that fails is shown in the chat, never dropped: every failed turn leaves an assistant message in `failed` state carrying the error code, even when it fails before any text, so every device and a later reconnect see it. The same holds for what the client cannot show: a record that does not decrypt, does not parse, has an unknown version or is too large renders as an error in its place instead of breaking the list. An unknown code renders as a generic error that still names the code; retry is offered where it makes sense. Only the code is stored: no error text from the provider or the server, in plaintext or sealed. A send the server rejects (`message.too_large`, `turn.busy` and the like) is answered with an error on the request itself, adds nothing to the chat and shows a toast. 2026-10-26.
  why: unreachable or failing agents, timeouts, provider errors and unreadable responses are normal events, and a silent missing reply looks like a hang. A provider's error text may echo the user's content, so it is never kept.
  rejected: errors only as the transient `turn.error` event (lost on reconnect, invisible on other devices).
  → docs/protocol.md#chats-and-messages (replaces "a failure before any text creates no assistant message")

D-090 [accepted] A send stores the empty reply with the user's message, so a turn always ends in a reply, also when its replica dies before any text; a turn cancelled before any text leaves an empty `cancelled` reply. A failed reply is retried in place (`turn.retry`, the chat's last message only), with the text and context sent again since the server cannot read the chat; it carries no idempotency key and is not resent. 2026-10-26.
  rejected: creating the reply on failure (misses a replica that dies before any text); retry as a new send (duplicates the question and keeps the failed reply).
  → docs/protocol.md#chats-and-messages

D-091 [user] How much history a turn carries is the user's choice per chat, as effort or the model is chosen in Claude Code: how many recent messages are sent and whether the chat compacts itself. An account setting holds auto-compaction and its defaults. The agent can ask for older history when it needs it. Automatic chat titles come later and are renewed on compaction. 2026-10-26.
  Compaction is set by a threshold: past it, a summary covers everything before a cut and the messages after the cut go whole. It never deletes a message. Until this lands a turn sends the latest 50 messages, at most 64 KiB of text.
  [accepted] Compaction works as in Claude, ChatGPT and Gemini: near the threshold everything before the cut folds into a summary and a tail of recent messages stays whole. Summaries chain like balances and turnovers of an accumulation register: each one covers everything up to its cut, built from the previous one and the messages since. Editing or deleting a message removes the summaries that cover it, and the next compaction rebuilds from the last one still valid. The defaults: auto-compaction on, threshold about 64k tokens (estimated from bytes). 2026-10-26.
  [agent] A summary is a message appended to the chat with the last id it covers (`through`); `chat.compact` runs it as a turn from the client's context, a failed one is retried in place, and the chat names its current summary. Auto-compaction and its threshold (4k to 128k tokens, as far as the 512 KiB context allows) are set per chat and in the account's `chat` setting; the latest messages up to a quarter of the threshold stay whole. A failed auto-compaction does not hold back the send; a summary that is streaming refuses edits and deletions it covers (`turn.busy`). 2026-10-26.
  rejected: summaries as a field of the chat (a retry, a failure and their chain would need a store of their own); holding the send until a summary succeeds (a provider that fails to summarize would stop the chat).
  [user] Titles: the chat's first reply asks the model for a short title in a call of its own, and every summary carries a new one in its first line; a title the user gave is never replaced. 2026-10-26.
  [agent] `title_auto` is a plaintext flag of the chat and `chat.rename { auto: true }` applies only while it holds; `chat.title` answers at once and the title comes as a `chat.titled` event to the asking session (a socket serves its requests one by one, so a provider call cannot hold the response); only the device that started the turn asks. 2026-10-26.
  rejected: titles from summaries only (most chats never reach the threshold); a title line in the first reply (the user would see it and it would stay in the context); the flag inside the title record (a new record version that hides only whether the user renamed the chat).
  → docs/roadmap.md

D-092 [user] Messages show as plain text with line breaks in v1. A rich format follows later: the project's own spans and paragraphs with embedded widgets, not Markdown. 2026-10-26.

D-093 [user] A chat's settings (models, effort, how much history a turn carries) are chosen in one popup on the composer, which names the model in short. They are stored with the chat as plaintext JSON the server checks: the server sees all of them during a turn anyway. The agent session holds every configured provider, so a chat can name its own; one that names none, or a removed one, uses the active provider. Supersedes the "choice per chat comes later" of D-086. 2026-10-26.
  rejected: an encrypted record (a new format that hides nothing the server does not already see).
  → docs/protocol.md#chats-and-messages

D-094 [accepted] The rich message format (D-092): a document of blocks (headings, paragraphs, lists, quotes, code, tables, callouts, collapsible panels, images, widgets) whose text is flat spans carrying style bit flags and optional attributes (links, mentions), encoded as MessagePack in the `chat.message` record with a format field, plain text staying valid. Models keep writing Markdown; a shared Rust crate converts it to the document at the end of a turn on the server and for previews in the client, and converts a document back to Markdown for the prompt and to plain text for search. Tables are structures that fit the width where they can, scroll inside themselves as a fallback and copy as CSV. Widgets are declarative by chart type with their data, not tied to a register; an unknown block carries a text fallback. No HTML in messages; an isolated iframe may be tried later. 2026-10-26.
  why: a format of our own renders safely without an HTML sanitizer and gives widgets a place; MessagePack is already the record encoding, while a hand-made binary layout would be another parser to fuzz.
  rejected: Markdown as the stored format (no widgets, every client parses differently); raw HTML (script injection through the model's output).
  [user] The record keeps the model's Markdown in `text` beside `doc`, and the prompt carries that text: no conversion of a document back to Markdown. The Markdown parser is pulldown-cmark. Text blocks come first; charts follow, drawn with a chart library; images come with files. 2026-10-26.
  [agent] The client's preview runs the conversion in a WASM module of its own on the main thread, not in the crypto worker: text the server controls never reaches a parser in the memory that holds the keys. A soft line break stays a break, as plain-text messages showed it. A record keeps its 256 KiB limit: a reply whose document does not fit beside its text is stored without one, and the client converts it as it does a preview. 2026-10-26.
  [user] Charts are drawn by Chart.js, loaded when the first chart shows; the model writes one as a fenced `chart` code block holding JSON. 2026-10-26.
  [agent] Chart kinds are line, area, bar and pie (scatter left out: its points need x values of their own). A pie has at most 8 slices, one color each: categorical colors are never cycled. The eight series colors are a fixed order validated for color-vision deficiencies; some light ones sit under 3:1 on the surface, so every chart has a table view (also what a screen reader gets) and a legend from two series on. A copied chart table keeps raw numbers, not the locale's format. Every turn's system prompt describes the format. Chart.js is pinned at 4.5.1: 4.6.1 came out four days before, after a year without a release. The JSON parser (serde_json) adds about 32 KB gzipped to the document WASM. 2026-10-26.
  → docs/roadmap.md, docs/crypto.md#message-documents

D-095 [user] Saved messages are references to `(chat, message)`, shown whole (the message's document) with its chat and the time it was saved, and open the chat at the message. Any message can be saved. A message deleted in its chat leaves the saved messages. 2026-10-26.
  [agent] `saved.list` carries each message's record and its chat, so the page needs no chunk fetches from many chats; `saved.chat` gives an open chat its saved ids. Removal by deletion sends no event of its own: `message.deleted` and `chat.deleted` say it. At most 10 000 per account. 2026-10-26.
  → docs/protocol.md#saved-messages

D-096 [user] The notebook: notes written in a WYSIWYG editor on ProseMirror (loaded with the notes page), stored as a document only (the message format, with no Markdown beside it), with a title of its own. One notebook per account in v1; folders or groups come later. A change made on another device in the meantime is never overwritten: the client saves its version as a new note named with the date and time. 2026-10-26.
  why: notes are long and richly formatted, like a blog post; one scope keeps v1 simple, and how to organize notes is decided once there are many.
  rejected: Tiptap (more dependencies and weight, paid extensions); a Markdown field with a preview (not a blog editor); a choice dialog or the last write winning on a conflict.
  [agent] The `note.title` record carries an excerpt of the body, so the list opens no bodies. Autosave a second after typing stops and on leaving the note. The editor keeps blocks it does not know and writes them back; a note it cannot read stays read-only. Markdown pasted as plain text goes through the document crate's conversion. The ProseMirror packages are pinned exactly, with overrides so one copy of each is installed (a second `prosemirror-model` breaks the editor); the editor is a chunk of its own, about 81 KB gzipped. 2026-10-26.
  → docs/protocol.md#notes, docs/crypto.md#note-documents

D-097 [user] Registers follow 1C: a catalog of metrics (like a chart of characteristic types) describes each measurement, and registers by kind of record hold the entries, so a new metric needs no new table or client code. The catalog is seeded by the server; editing it in the client comes later. Values are stored in metric units, and the client converts them for display. Any number of entries a moment, or none, a day; a day shows their average or their sum, as the metric says. A chart and the agent read the newest 1000 entries and page back. Names of metrics and categories live in the catalog per locale. The starting set: weight, height (cm), steps, squats, push-ups, energy eaten and energy burned. Every metric shows on the registers screen, by category. 2026-10-29.
  why: weight, steps, height, calories and exercise counts differ only in unit and in how a day adds up; hardcoded presets would mean a table and a screen each.
  rejected: two presets, weight and steps, with a register each; one value a day; names in the client's strings (a new metric would wait for a client release).
  [agent] v1 has one register kind, `measurements` (a number at a moment, with the time zone offset and an optional comment in the record); readings of several values or with intervals (blood pressure, workouts, sleep) come as kinds of their own. Each metric an account uses gets its own `register` scope, so a grant opens one metric. Units are the client's strings, as converting them is client code. On a conflict the stored entry wins and is shown again: it is one number, not worth a copy. 2026-10-29.
  → docs/protocol.md#registers, docs/crypto.md#record-contents

D-098 [user] A provider config is shared as a link, shown as a QR code or copied, to other devices or people: the link is built when the user asks, after a warning that it carries the API key, which the user may leave out. The phone camera opens it; the add form also takes a pasted link, so it works across servers. A page that is not signed in says to sign in and scan again. 2026-10-29.
  why: own devices already share the `providers` setting; the link is for handing a config to someone else, possibly on another server.
  rejected: keeping the config across the sign-in redirect (the key would be stored in the clear); no copy button (the user wants one).
  [agent] The link is `/provider#1.<base64url(MessagePack)>`, unencrypted. Adding asks for confirmation with the host the turns go to, gives a new `id`, makes the entry active only when none is, and skips an equal entry. 2026-10-29.
  → docs/protocol.md#provider-links, docs/threat-model.md

D-099 [user] Agent tools in v1 are `list_metrics` (no grant), `read_register` and `session_context` (a grant each); `list_scopes` is dropped, as ids without names tell the model nothing and would reach the provider without consent. A grant asks every time in a dialog on the auth session that sent the message, approved or denied whole, naming the provider host the data goes to. The reply's record lists each tool call and its outcome; results are neither stored nor sent with later turns, so a follow-up asks again. 2026-10-29.
  why: a copy of register data in the chat would outlive the entries it came from.
  rejected: tool results as messages of their own resent with the context (brief §5); the dialog on every unlocked device; narrowing the days in the dialog.
  [agent] Requests live in the `access_log` table, so any replica answers one and a reload asks for the pending ones; answers reach the turn over the bus. Requests expire after 5 minutes; a grant denied in a turn is denied again without a dialog; at most 8 tool calls a turn, after which the model is offered no tools; a request whose provider the client does not hold cannot be approved; results at most 64 KiB; `session_context` gives the time in UTC with the time zone, as the server has no time zone database. 2026-10-29.
  → docs/protocol.md#permissions-and-the-access-log, docs/threat-model.md

D-100 [accepted] The agent reads older messages of the turn's chat with `read_history` (up to 50 message ids before a given one), answered by the client without a dialog: the chat is the user's own conversation, and a dialog on most follow-up questions would wear the user down. The call shows in the reply and in the access log. No text search in v1. A turn reads at most 128 KiB of history; a request waits 30 seconds, as no person answers it. 2026-10-29.
  why: the chat's history setting limits what a turn starts with; the model needs a way back when the question reaches further.
  rejected: a dialog like `read_register` (a click on nearly every question about the past); a per-chat switch (later, if wanted); search (the client would decrypt the whole chat per call).
  [agent] Each result is at most 32 KiB, so the turn's limit is exact: a call is answered with an error when 32 KiB more would pass 128 KiB. The client answers `answer` (outcome `answered`), or `refuse` when the chat does not open; the record's `count` is the number of messages read. Only the tab that started the turn answers, by the `turn_id` of its send or retry and in that turn's chat, with the same limits checked on its side, so forged requests cannot read other chats; a reload loses those ids, and a history read of an earlier turn times out. `read_history` is offered only when the chat has messages before the context.
  → docs/protocol.md#agent-tools-v1, docs/threat-model.md

D-101 [accepted] Files in chats: images, PDFs and text files attached to the user's messages, encrypted on the client, stored by `object_store` in a directory, S3 or Backblaze B2 (its S3 API), disabled when none is configured. Only types the agents take are accepted, within the smallest limit of the OpenAI and Anthropic APIs. Images are processed in a media worker of their own, one at a time: a square preview and a ThumbHash for the chat, and a big image is compressed or, as in Telegram, sent as it is, with a compressed copy for the model. Supported files show an icon of their type from a sprite. The model sees a message's files in its turn; a description it writes of each is stored with the file and goes with later turns instead of the file, which the model can open again with `read_file`, answered by the client like `read_history`. A per-account quota, 1 GB unless configured. Notes get files later. 2026-10-29.
  why: an image costs 1.5–5k tokens a turn and a PDF tens of thousands, a description a few hundred, so it pays for its one extra call by the second turn; images decoded in their own worker keep untrusted decoders out of the memory that holds keys; the smallest limits keep every provider working.
  rejected: sending every file of the context with each turn (cost); Postgres `bytea` for contents (bloats the database and its backups); S3 only (MinIO for every self-hoster).
  [agent] Limits, from the OpenAI and Anthropic documentation of 2026-10-29: a file at most 50 MB (OpenAI's PDF limit, also its total per request, so a turn sends at most 50 MB of files), at most 100 images a turn (Anthropic), images to the model at most 2000 px on the long edge (Anthropic's limit for requests with more than 20 images, under OpenAI's 2048), as JPEG or PNG without metadata (animated GIFs are refused by OpenAI, so the copy is one frame), PDFs with at most 100 pages (Anthropic below a 1M context), text files at most 200 KiB. Ours: 10 files a message, images at most 50 megapixels (a decoded image is 4 bytes a pixel), compression offered past 2000 px or 2 MB. Unattached uploads go after 24 hours. Previews are records in the database, fetched in batches, not objects.
  [agent] Revises D-064: a file's content key leaves the worker, to the server only, for a turn that reads the file. The key is random per file, so it opens that file alone, whose plaintext the turn sends the server anyway (N1); the server never stores it. The alternative, uploading the plaintext again for each turn, sends up to 50 MB from a phone per `read_file`.
  [agent] From review of the client: the `file.key` record carries a flag byte after the key, set on an image's original, and the worker never gives an original's key, so a forged `read_file` or retry (the message record is the server's) cannot reach it. A tab answers a turn's history and file requests one at a time, so its limits hold against requests sent together. An image's size is read from the whole header before decoding (a JPEG's frame after long metadata, a GIF's first frame, a HEIC's largest `ispe`), and one whose header tells none is refused. 2026-10-29.
  → docs/crypto.md#files, docs/protocol.md#files, docs/threat-model.md

D-102 [accepted] Files survive failures without holding work in memory: the client encrypts and uploads one file at a time from the picked file, retrying a failed upload 3 times and taking back what a failed send registered (`file.forget`); the server keeps its state in rows, streams uploads and the objects it opens, and a sweep at startup and every few minutes removes what a crash leaves (rows past their time, staging files, objects without a row). A file's description gets 3 tries, counted before each runs; after the last the user gets a notice over the socket and the file stays, described by its name. Opened files count against a per-replica memory budget (256 MB by default); an account runs 3 turns and holds 20 sockets at once. A send does not survive a closed tab.
  why: image processing runs on the client, where the plaintext is, so the server has no queue of files to resume; what it can lose is uploads, turns and descriptions, and their rows already say where each stopped. A content key is never stored, so the server cannot resume a description by itself: the next turn that has the key does.
  rejected: a server-side processing queue with temporary files (the server would need the originals and their keys); a client outbox in OPFS that resumes after a reload (much more work, and text messages do not resume either); deleting a file whose description failed (the model already read it, and `read_file` still opens it).
  → docs/protocol.md#files, docs/protocol.md#notices, docs/configuration.md

## Authentication and sessions (2026-10-26, docs/auth.md)

D-030 [user] A session records user agent, client IP (taken correctly behind proxies such as Traefik), country by IP, timezone, created and last-seen times, and a device id chosen by the client, to which push tokens and other device data attach later.

D-031 [user] Access token: JWT, TTL 1 hour, carrying the session id and the provider. [accepted] Claims `sub`, `sid`, `iid` (the identity), `prv` (its kind), `iat`, `exp`; 30 s of clock skew accepted.

D-032 [user] A user has several identities, including several of the same kind. Accounts auto-link by email, and further identities can be linked by hand.
  [agent] Auto-linking only when the address is verified on both sides; an unverified Google address of an existing account is refused. An identity of another account is refused: accounts cannot merge, each has its own ARK.

D-033 [user] Revoked sessions go to a Redis-compatible store with a TTL, or an in-memory hash set behind the same interface; the middleware that verifies the JWT checks it.
  [agent] The store fails closed (503 / close 1011); revocations of the last TTL are reloaded from PostgreSQL at start; refresh always checks the database.

D-034 [user] Refresh token in an HttpOnly cookie only for now; a body-transport mode is added later as an operator setting, never a client choice. An API on another origin is also later.
  why: with no maximum session lifetime, a token XSS copies off the device would work indefinitely.
  → docs/auth.md#not-in-v1

D-035 [user] Session details (device id, timezone, locale, client version) are reported by a separate call after authentication (`PUT /auth/session`).

D-036 [user] One live session per device: setting a device id revokes the user's other sessions on it. Other users of the same browser profile are untouched.

D-037 [user] Sign-up allowlist: comma-separated globs of addresses; empty or `*` means open.
  [agent] Globs, not regular expressions: an unanchored expression admits look-alike domains.

D-038 [user] No maximum session lifetime (a per-user setting may add one later). [agent] An idle timeout stays: 30 days without a refresh (`CHAT_SESSION_IDLE_DAYS`).

D-039 [user] Account deletion is a hard delete of everything, the audit log included.

D-040 [user] Every user action is audited, sign-ins above all, without private data. [user] Retention 365 days.

D-041 [user] The agent may read some session data through a grant: timezone, country, locale, local time. Never IPs or the session list. [agent] It is a consent the server enforces, not a cryptographic boundary.

D-042 [accepted] Cross-tab coordination with Web Locks and BroadcastChannel. rejected: SharedWorker (no Chrome on Android).

D-043 [accepted] Country from a MaxMind-format file the operator downloads; DB-IP Lite Country recommended (CC BY 4.0). rejected: bundling GeoLite2 (its EULA restricts redistribution).

D-044 [agent] Email codes are 8 digits.
  why: with the per-address and per-IP limits, 6 digits give about 2 % odds of a guess within a month, 8 give under 0.05 %.

D-045 [agent] One `CHAT_SERVER_SECRET`; the JWT key and the email-code key are derived from it. Rotation is replacing the secret: access tokens stop verifying and clients refresh silently. Unset means a random secret per start, fine for one instance.
  rejected: a list of signing keys with overlap (more to configure, no benefit while refresh is cheap).

D-046 [agent] Ed25519 JWTs through `jsonwebtoken` on its `aws_lc_rs` backend; Google's `id_token` is verified with the same crate (`leeway` covers the skew).
  rejected: hand-rolled JWS (pub), the `rust_crypto` backend (pulls `rsa`, RUSTSEC-2023-0071), `openidconnect` (more dependencies, skew handling unclear).

D-047 [agent] Linking Google needs the `SameSite=Strict` refresh cookie at `/auth/google/start?link=true`, so another site cannot link its Google account into a victim's account.

D-048 [agent] Client IP: forwarding headers count only from `CHAT_TRUSTED_PROXIES`, read from the right.

D-049 [agent] SQL is written as runtime queries (`sqlx::query`), not compile-time macros; integration tests cover every query.
  why: no `.sqlx` cache to maintain and no database at image build time.

## Client

D-060 [agent] Design tokens in DTCG; primitives are never emitted; light and dark themes, applied before paint.
  → docs/design-system.md

D-061 [agent] Screens are built only from design-system components; every interactive element is at least 48×48; every string goes through `t()` in English and Russian (ICU MessageFormat).
  → docs/design-system.md, docs/i18n.md

D-062 [agent] System fonts only (no font requests); an indigo palette.

D-063 [agent] Strict CSP: `script-src 'self' 'wasm-unsafe-eval'`, no inline scripts or styles.

D-064 [agent] Keys live in a Web Worker running `chat-crypto` as WASM; no worker method returns key material. Revised by D-101: a file's content key, for a turn.
  → docs/crypto.md#client-worker-api

D-065 [accepted] Passkeys are only a PRF source, not a sign-in method: no server challenge or attestation, no WebAuthn server library; the credential id lives in its wrap.

D-066 [agent] Content routes wait behind the key gate (setup or unlock); settings stay usable while locked, so signing out, revoking sessions and deleting the account never depend on unlocking. Setup order: passkey (skippable), recovery words, three of them typed back, one upload. "Remember this device" is offered at the end of setup, on the unlock screen and in settings, always off by default.
  → client/src/features/keys/

D-067 [agent] Passkeys have no names: the list shows the date each was added, and nothing user-chosen about them reaches the server. WebAuthn `user.id` is the account id and enrolled credentials are excluded, so one authenticator holds one passkey per account.

D-068 [agent] A device wrap belongs to the session that stored it (`ark_wraps.session_id`); a database trigger deletes it when the session is revoked or reports another device, so no code path that ends a session can forget it.
  → server/migrations/20261026000002_keys.sql

D-075 [accepted] Device linking in v1 is direction A only: the new device shows the QR, the unlocked phone scans it with its own camera and opens the link in its browser. A phone that is not signed in tells the user to sign in and scan again; the QR secret is never stored to survive the sign-in redirect. The QR is drawn with `uqr`, loaded only when a QR is shown.
  why: no camera access or QR decoder in the app; direction B (and a typed code) later.
  rejected: keeping the fragment in `sessionStorage` across sign-in (the secret would outlive the page).
  → docs/crypto.md#device-linking

D-076 [agent] Link messages reach the creating session through PostgreSQL `NOTIFY` (works across replicas, no new service); the waiting device also asks with `link.get` on every connect, every 5 seconds and before renewing its code, since a notification can be lost while the listener reconnects. Superseded by D-077.
  → docs/protocol.md#keys

## Repository and operations

D-070 [agent] Configuration is environment variables only; optional features are off until their variables are set.
  → docs/configuration.md

D-071 [agent] Tools pinned in `mise.toml` by backend; Rust pinned exactly in `rust-toolchain.toml` (same version in CI and Docker); no build date in the binary, only the commit.
  why: one commit builds one binary (reproducible builds, N2).

D-072 [agent] Self-hosting is one docker compose: PostgreSQL, the server (distroless, non-root) and Caddy serving the client with TLS and security headers.
  → docs/deployment.md

D-073 [agent] Local services: PostgreSQL on 127.0.0.1:5433, Valkey on :6380, Mailpit on :1025 (UI :8025). Test legs that need a service fail when it is missing instead of skipping.
  → docs/testing.md

D-074 [user] Defects found in foxic and pub while reusing their designs are recorded in their roadmaps, with a reminder in their CLAUDE.md; not in other projects unless asked.

D-103 [user] Releases are built and deployed from the developer's machine, not in CI, to the existing host at chat.plugfox.dev with no dev server: private Docker Hub images shipped over ssh, secrets in Komodo, sign-up limited to the owner's address, Google and email sign-in. Image visibility superseded by D-104.
  why: native arm64 builds on the Mac; the same path as foxic and the host's other stacks.
  → docs/deployment.md#production, scripts/release.sh

D-104 [user] Release images on Docker Hub are public, as the source repository is; replaces the private images of D-103.

D-105 [user] chat.plugfox.dev starts with Google sign-in only; email sign-in from D-103 stays off until SMTP is set.

D-106 [user] The agent adds register entries with `add_measurement`: a dialog every time, written by the client after approval; it cannot change or delete them.
  [agent] The server takes the approval before the client writes, so a request that ended stores nothing; a denial stops that metric's requests for the turn, as any grant's does.
  why: the value is often in the chat already, and only the client can seal `register.value`, so an approved entry is an ordinary one and an unapproved one does not exist.
  rejected: writing without a dialog (a misread value or text in a file would land in the data); a per-chat "allow without asking" (later, with experience); a new record kind for the proposal (an `audit.reason` holding JSON for this tool needs no crypto change).
  → docs/protocol.md#permissions-and-the-access-log, docs/threat-model.md

D-107 [user] Files are not kept unless the user asks: the object leaves the store when a reply that read it ends, about an hour after the send otherwise; the description and ThumbHash stay, the preview and an original do not exist for such a file.
  why: a chat is not a gallery, and most files are asked about once, such as the calories on a photo.
  rejected: sending the plaintext in the message (50 MB past what a frame holds, and a retry would need it again); deleting the description too (follow-up questions would have nothing); kept by default with a choice to discard.
  → docs/protocol.md#files, docs/threat-model.md

D-108 [user] The client installs as a PWA with a manifest and icons, and no service worker yet.
  why: installing needs neither; a service worker would cache the client's code, which changes what a server update can do to it (threat-model.md N2), and offline use has no local data to show until the IndexedDB cache exists.
  rejected: a service worker that only satisfies older install checks (a cache to reason about for no feature).
  → client/public/manifest.webmanifest

D-109 [user] Settings are screens with their own addresses (`/settings/:section`), not one page: a list of sections beside the open one on large screens, one of them on smaller ones. The barrier closes a dialog, except where a stray tap would lose typed work or answer for the user (`persistent`: a permission request, recovery rotation, the provider and entry forms, editing a message). 2026-11-02.
  why: activity, devices and the access log grow without end and buried everything after them; a tap on the barrier is what people expect of a popup, but closing a permission request denies it.
  rejected: tabs (seven do not fit a phone without hidden scrolling).
  → client/src/features/settings/SettingsPage.tsx, client/src/design-system/components/Dialog.tsx

D-110 [user] A chat's messages scroll under the composer, whose container takes every click in its area, and list screens carry their title and actions in the phone's top bar. An `amoled` theme joins `light` and `dark`, and the browser's bars follow the chosen theme. 2026-11-02.
  → client/src/design-system/components/Pane.tsx, client/src/design-system/tokens/themes/amoled.json

D-111 [user] A top bar leads with one control: a pane's `leading`, or the menu button when it names none. A screen opened from a list goes back with `leading` and reaches the menu from the list. 2026-11-02.
  why: settings showed the menu and a back button side by side; one slot makes that impossible to repeat.
  → client/src/design-system/components/Pane.tsx
