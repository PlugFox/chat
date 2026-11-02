# Threat model

> Status: **agreed** (2026-10-25; authentication added 2026-10-26; server-sealed chat messages 2026-10-26; files 2026-10-29). Changes to this page need the same review
> as changes to the crypto code.

Vault Chat keeps user data encrypted on the server under keys only the user's
client holds. This page says exactly what that buys and what it does not. The
README links here and must not claim more.

## Assets

| Asset | Examples | Who can read it in plaintext |
| ----- | -------- | ---------------------------- |
| Stored content | chat messages, notes, register values, profile, files, settings (incl. LLM API keys), access-log reasons | The user's unlocked clients only |
| Turn content | the user's message and its files, the chat context the client sends, plaintext from approved grants, files the model opens, the reply | The client, **the server and the LLM provider**, during the turn |
| Keys | ARK, scope private keys, content keys | The user's unlocked clients only (Web Worker memory); a file's content key also reaches the server for a turn that reads the file (D-101) |
| Metadata | see [Metadata](#metadata) | The server |
| Identity | Google subjects, email addresses, devices, sessions (IP, country, user agent, timezone), the audit log | The server |

## Actors and what they can do

| Actor | Capabilities assumed |
| ----- | -------------------- |
| **Database / backup / object-storage thief** | Reads every table and object, once or repeatedly. No access to server memory or to client code. |
| **Curious or compromised operator** | Everything the thief has, plus: reads server memory and logs, modifies the database, runs modified server code. |
| **LLM provider** | Sees every request the server makes on behalf of the user. |
| **Prompt injection** | Text the LLM reads (a note, an imported record, a web page) that tries to steer the agent. Acts through tool calls only. |
| **Network attacker** | Between client and server, or server and provider. TLS is assumed to hold. |
| **Another user** of the same instance | Has an account; tries to reach someone else's data through the API. |
| **Thief of an unlocked device** | Has the browser profile with a remembered device key. |

## Guarantees

**G1. At-rest confidentiality against the thief and the operator.** Stored
content is sealed to scope public keys (HPKE); scope private keys and the ARK
exist on the server only wrapped under keys derived from unlock secrets the
server never sees (passkey PRF output, recovery key). A full copy of the
database, backups and object storage reveals [metadata](#metadata) only.

**G2. Placement integrity.** Every ciphertext is bound by its AAD to its
format version, owner, scope and position (for messages: chat id and message
id). The server cannot move a record into another scope, chat or position, or
present a note body as a register value, without the client detecting it. For
kinds the server writes itself (N3) this only stops copying an existing
record elsewhere; it can seal a new one in any position.

**G3. Scoped disclosure to the agent.** The LLM reaches stored content only
through the chat context the client chose to send, the chat's memory included, through older messages of
the same chat and their files in a turn the client started (`read_history`
and `read_file`, answered without a dialog, D-100, D-101), and through grants the user approved for named scopes in
that turn. A prompt injection can make the agent *ask* for more scopes; it
cannot obtain them without a user decision shown in a dialog the client
renders from its own data.

**G4. No server-side recovery.** Losing every unlock method (all passkeys,
the recovery key, every remembered device) makes the data unrecoverable, for
the user and for the operator alike.

**G5. Account isolation.** Server-side authorization (sessions, ownership
checks on every query) keeps users from reaching each other's ciphertext and
metadata. This is ordinary access control, not cryptography; G1 still holds if
it fails.

**G6. Signing in is not unlocking.** Authentication ([auth.md](auth.md))
decides who reaches the account; it never yields a key. Taking over a linked
Google account or mailbox gives an attacker the account's metadata and the
power to delete it, not its content.

## Non-guarantees

These are stated in the README and in the client's onboarding.

**N1. The server and the LLM provider see the turn.** The agent loop runs on
the server. For each turn the server receives in plaintext the user's message,
the files it carries and those the model opens (by their content keys, with
which the server opens the stored objects), the chat context the client
sends, plaintext of approved grants, and the provider config (base URL, API key, model) for the life of the session and of
a turn started in it, which runs on after the tab is closed for at most 10
minutes (D-088). A malicious or compromised server can record all of it.
When the server is configured with Redis (as several replicas need), the
reply text and the fingerprints of retired provider configs also pass through
Redis pub/sub, in Redis memory and never in its snapshots
([protocol.md](protocol.md#event-delivery)). In practice this means:
**a chat you are actively using is protected at rest, not from the server.**

**N2. Malicious client code.** The server serves the web client. A
compromised server can serve code that exfiltrates keys or plaintext after
unlock. Mitigations planned later: reproducible builds, published bundle
hashes, an optional self-hosted or packaged client. The Web Worker that holds
keys protects against accidental leaks (logging, serialization, devtools on the
main thread), **not** against hostile code from the same origin, which can ask
the worker to decrypt anything.

**N3. Authenticity of server-written records.** Records the server writes
are sealed to a public key, so the server, and anyone who can write to the
database, could forge or alter them; the UI marks them as server-written.
These are all chat messages (the user's own included: the server seals them
and assigns their ids, D-016), a chat's memory, tool results, summaries, imports and
access-log reasons. Records only a client writes (chat titles, notes,
registers, profile, settings, a user's edit of their message) are
authenticated with the user's writer key; the server cannot forge those
([crypto.md](crypto.md#authenticity)). An automatic chat title is the
exception in substance: the model writes it and the server relays it, so the
server can choose its text as it can a reply's; a title the user gave cannot
be forged.

**N4. Completeness and freshness.** The server can withhold records, delete
them (a deleted message looks like a gap, which is legal), or serve an older
version of a record that was edited. AAD prevents moving records, not hiding
them.

**N5. Metadata.** See below. It is visible to the server by design.

**N6. Unlocked devices.** A stolen device with "remember this device" enabled
unlocks without a passkey prompt until its session is revoked, which deletes
the server half of its wrap ([crypto.md](crypto.md#remember-this-device)). A device the attacker controls while it is
unlocked (malware, a malicious extension) gets everything.

**N7. Weak secrets.** If a passphrase unlock method is offered, the operator
can brute-force its wrap offline; its strength is the only protection. Passkey
PRF and recovery-key wraps are not brute-forceable (≥128-bit secrets).

**N8. Availability.** The server can refuse service or delete everything.
Backups are the operator's job; encrypted user export is a later feature.

## Metadata

Visible to the server and to a database thief, on purpose:

- Accounts: identities (Google subjects, email addresses), passkey
  credential ids (inside their wraps; passkeys have no names), wrap kinds, devices, sessions with IPs, countries, user
  agents, timezones and locales, timestamps, and the audit log of sign-ins,
  revocations and linking (no content, no addresses in its details).
- Scope list: kinds and ids (which chats and registers exist, whether the notes scope does), public
  keys, key versions.
- Chat memory: whether a chat has one and its ciphertext size (rounded by
  padding). Its text is encrypted.
- Chats and messages: count, ids, timestamps (created, edited, deleted,
  archived), author kind (user / assistant / tool / summary), which
  messages a summary covers, whether a chat's title is automatic, revisions, ciphertext
  sizes (rounded by padding, [crypto.md](crypto.md#padding)), which chats are
  pinned and in what order, which are archived, when a turn runs, the
  error code a failed reply ended with (never the error text), and each
  chat's settings: the id of its provider entry, its reasoning effort and
  how much history its turns carry (D-093; the server sees all of them
  during a turn anyway).
- Registers: the metric catalog is the same for everyone and plaintext;
  the agent may list it without a grant. Per account the server sees which
  metrics have entries, how many, each entry's moment (`occurred_at`, to the
  second, so ranges can be queried), ciphertext sizes (rounded by padding)
  and revisions. Values, the time zone offset of each entry and its comment
  are encrypted.
- Notes: count, ids, ciphertext sizes of titles and bodies (rounded by
  padding), timestamps (created, updated), revisions. Titles, the excerpts
  beside them and bodies are encrypted.
- Settings: which keys exist (such as `providers`), their sizes and when
  they change. Values are encrypted. Removing or changing a provider sends
  the server a SHA-256 fingerprint of its old config
  ([protocol.md](protocol.md#agent-sessions)). It includes the user id, so
  equal configs of two users do not match; for a provider without an API
  key, such as Ollama, it can be confirmed by guessing the address and model.
- Saved messages: which `(chat, message)` pairs are saved, and when.
- Files: count, ids, the chat and message each belongs to, object sizes
  (rounded by padding), when each was uploaded, which an image's original
  is, the plaintext size of each, which files a turn read, how many times
  the model was asked to describe each, each account's total against
  its quota, which files were not kept, and when their objects went. Names, types, image sizes, previews,
  ThumbHashes and descriptions are encrypted at rest; a send and a retry
  carry the names, types, image sizes and ThumbHashes of their files, and
  every turn the names and types of its context's files, in the clear to
  the server (N1), which seals the list into the message. The provider
  sees what a turn gives the model, which is not the ThumbHashes.
- Access log: when each permission request was made and answered, its chat
  and turn, the tool, the register's metric and scope, the days asked for,
  the message ids of a history read, the file of a `read_file`, that the agent proposed an entry of a metric, read a site, ran code or asked for the weather at the place by IP, and the outcome. The reason the model gave, a proposed entry's value, day and comment, a read's address, the code and the place are sealed.
- Activity: when the user is online, how often turns happen, which provider
  host the server calls (and the provider sees the server's IP).

## Specific risks and how the design answers them

| Risk | Answer |
| ---- | ------ |
| Server substitutes keys during **device linking** (MITM of the ephemeral exchange) | The QR code carries a one-time secret the server never sees; it authenticates the exchange ([crypto.md](crypto.md#device-linking)). |
| Someone who took over the **sign-in** (not the keys) gets the user to open their link: a QR shown to them, or the same URL sent as a message | The unlocked device sends nothing without the user's confirmation. It shows how the asking device describes itself (browser from its user agent, country from its IP), says that this description can be anything, and says to continue only for a code the user just scanned on their own screen, never for one sent to them. A link lives 2 minutes and is used once, a revoked session's links stop working, and the audit log records every completed link. What is left is the phishing risk of every QR sign-in: a user who confirms anyway hands over the keys. |
| Server asks for scopes the user did not intend; the dialog shows server-supplied labels | The dialog renders scope names from the client's own decrypted data and metadata; unknown scope ids are refused, not shown. The agent's reason is displayed as untrusted quoted text. |
| Prompt injection exfiltrates data to a URL (`web_fetch`, D-114) | **Reduced, not prevented.** The model is told to keep private data out of addresses, but that is a request to the model, which text it read can overrule. The check is the dialog: it shows the whole address of the first read of each host in a turn. Later reads of an approved host ask no one, so a host the user approved, or one that passes through whatever it is given, can receive what the model read in that turn, in its address. A redirect does not follow by itself, so it cannot move a read to a new host without a dialog. Only `GET`, within 2 KiB of address. |
| The server is made to reach its own network (`web_fetch`, SSRF) | Public addresses only, checked on the resolved addresses in the client's resolver, with no operator exception, `https://` on the default port, no credentials, no redirects, no cookies. Reads leave from the server's IP, so sites see it and an operator answers for what its users read through it. |
| A web page steers the agent | A page reaches the model as data, like a register comment; it acts only through tool calls, each under its own rule. Page text is not stored except as the reply may quote it. The server and the provider see the address and the text (N1), and only the sealed reply record and access log keep the host and address. |
| The model's code (`run_code`, D-115) | It runs on the client in a worker of its own, apart from the keys, in QuickJS in WASM: no network, DOM, storage, threads or timers reach it, only `console.log` and the inputs, and it ends within seconds. Nothing runs on the server. A flaw in QuickJS would reach only the worker, which the browser's sandbox and the CSP still bound; that worker can reach the same origin, so such a flaw is the risk this leaves. Its output goes to the server and provider as any result (N1), and it can use only what the model could already read in the turn. The code is sealed in the access log. |
| An approved **grant** | The client decrypts the entries asked for and sends them to the server in plaintext, which passes them to the turn's provider (N1), through Redis pub/sub when the socket and the turn are on different replicas, as deltas go ([protocol.md](protocol.md#event-delivery)). Nothing about the result is stored: the reply's record lists the call and its outcome, not the data, though the reply's text may quote it. The dialog names the provider host the data goes to, from the client's own settings; a request for a provider the client does not hold cannot be approved. |
| The model, or text it read (a register comment), presses for grants | Every grant is a dialog built from the client's own data, with the model's reason shown as its words; one grant is approved or denied whole. A denied grant asked again in the same turn is denied without a dialog, and a turn makes at most 8 tool calls, after which the model is offered no tools. |
| The model reads older messages of the chat (`read_history`) | The client answers without a dialog (D-100): the messages are the user's own words and replies of this chat, but they may be older than the history the chat settings send and may have gone to another provider when written, so the setting limits what a turn starts with, not what the model can read, except a chat set to no history (D-112), whose turns are offered no such tool and whose client refuses the request. The call shows in the reply and in the access log. The client answers only for a turn its own tab started, by the turn id its send or retry was answered with, in that turn's chat, at most 50 ids a call and 128 KiB a turn, which the server also enforces; so a server that sends forged requests learns no other chat's messages, and only up to that limit of this one. A reload loses the tab's turn ids, and a history request of a turn started before it times out. Text in an older message reaches the model as data, like a register comment. |
| A file's **content key given to the server** for a turn (D-101) | It opens that one file, whose plaintext the turn sends anyway (N1); keys are random per file, so it opens nothing else. The server never stores it, but a server that keeps it can open the object again later and could store other content under it, as it can forge a chat's messages (N3). A key in a `read_file` answer passes through Redis pub/sub as grant results do. The client never gives the key of an image's original, which its own `file.key` record marks as such (a record the server cannot forge), so the server cannot read an original even by asking for it in a forged `read_file` or retry; a file uploaded for a send that failed is the user's to send and can be given to a later turn of that chat. |
| **Photo metadata** (EXIF location, camera, time) | The copy the model reads is re-encoded by the client, which drops all metadata. An image sent "as it is" keeps its original, metadata included, stored encrypted like any file. |
| A **malicious image or PDF** aimed at a decoder | Images are decoded in the client's media worker, which holds no keys, one at a time, after a size and pixel check of the header; PDFs and text are not parsed by the client but for a page count. On the server the files reach only the provider's API: nothing decodes them. |
| The model reads a chat's files (`read_file`) | Like `read_history`: no dialog, only the turn's tab answers, and only with a key that opens under the turn's chat, so forged requests open no other chat's files; the call shows in the reply and the access log. Text inside a file (in an image, a PDF) reaches the model as data and may try to steer it, as a register comment may. |
| **Files not kept** (D-107) | The object leaves the store after the reply, about an hour after the send otherwise (on Backblaze B2 the encrypted version stays hidden in the bucket a day or so longer, by its lifecycle rule: configuration.md), but the server and the provider saw the plaintext during the turn (N1), and the provider's retention is its own. A backup taken meanwhile may hold the encrypted object, whose key the row still has sealed. The model's description stays, sealed, and can repeat what the file showed. The UI says the file is removed from this server, and names the provider's copy. |
| **Entries the agent proposes** (D-106) | The server, the provider or text the model read can put any value in a request (N1, N3), so nothing is stored without the user's approval in a dialog showing the value, day and metric, every time. The client writes the entry with its own writer key, so it cannot be told from one entered by hand, and the server cannot write one alone. A malicious server can still ask the user to approve a value it chose, and an approved wrong value stays until the user deletes it. The agent cannot change or delete entries. In the rare case that the client fails to save after approving, the model has been told the entry is stored; the client says otherwise to the user. |
| The model writes a chat's **memory** with no dialog (`write_memory`, D-117) | **Not prevented.** Text the model read can steer it into saving an instruction, which then reaches every later turn of that chat, and the server can write any text there (N3). It reaches no other chat. The model is told these are its notes and not to save at a page's or file's request, but that is a request to the model. The check is the user's: the chat's settings show the text and clear it, and a reply that wrote it says so. The access log has no entry for it. A chat set to no history still sends its memory, so such a turn may know what earlier turns saved. |
| A file's **description** | The model writes it and the server seals it (N3): the server can choose its text, as it can a reply's. It is shown as the image's alternative text and goes to later turns instead of the file. |
| A **provider link** (QR or copied) is seen, photographed or kept by the browser or clipboard | The link carries the config in the clear, API key included unless the user leaves it out: anyone holding it can use the key at the provider. The client warns before showing or copying it, builds it only then, and the opening page takes it out of the address bar at once; the scanning browser's history and the clipboard may still keep it ([protocol.md](protocol.md#provider-links)). |
| Someone sends the user a **provider link of their own**, pointing at an endpoint they run | Every turn with that provider goes to its base URL (N1). Adding it needs the user's confirmation, which shows the host the turns go to; an added provider is not made active while another one is. |
| **SSRF** through a user-supplied provider base URL (the server fetches it) | Private, loopback and link-local addresses are refused unless the operator allows them; the address is checked after DNS resolution and pinned for the connection ([protocol.md](protocol.md#provider-endpoints)). |
| Provider API keys in server memory | Kept only in the agent session and the turns started in it, never logged or persisted by the server; dropped when both have ended, or at once when the provider is removed or changed, the auth session revoked. A retirement that is lost (the client's connection drops, a gap on the bus) leaves running turns to their 10-minute limit, and a session on another device until that device starts it again on the next settings change it sees. Removing a provider here does not revoke the key at the provider, and the UI says so. Inherent to a server-side agent loop (N1); a client-as-relay mode is a later option. |
| Plaintext in logs | `tracing` fields never carry payloads; protocol payload types implement a redacting `Debug`. Tested. |
| Offline guessing of the passphrase wrap | Passphrase unlock is not in v1. If added: Argon2id with strong parameters and a strength gate (N7). |
| The server claims an account has **no keys**, so the user sets up new ones | New keys reveal nothing stored under the old ones. A browser that unlocked the account before warns on the setup screen that the server may be misbehaving. |
| A deleted message lingers | Deletion removes the record and leaves a tombstone. The LLM provider already saw the message during its turn (N1), summaries made earlier may mention it, and the operator's backups keep the old ciphertext. An edit replaces the record the same way; no history is kept. |
| Reuse of an access token after sign-out | Revoked session ids are checked on HTTP and at WebSocket `auth`/`auth.renew`, and open sockets of the session close at once with a dedicated code. A failing revocation store refuses requests rather than letting them through ([auth.md](auth.md#revocation)). |
| Account takeover through **auto-linking** by email | Only addresses verified on both sides link automatically; an unverified Google address that matches an account is refused ([auth.md](auth.md#account-linking)). Takeover would still not unlock content (G6). |
| **Refresh token theft** | The refresh token lives in an HttpOnly cookie that page scripts cannot read; it rotates on every use and reuse of an older generation revokes the session. Hostile code in the page (N2) can still act as the user while the page is open. |
| Spoofed client IP (rate limits, session and audit records) | Forwarding headers count only from configured trusted proxies, read from the right ([auth.md](auth.md#client-ip-behind-proxies)). |
| The weather learns the user's place (`get_weather`, D-116) | The user's IP is never sent. A place by IP needs a dialog each time, naming the city found; then the model and provider learn the city, and Open-Meteo gets coordinates rounded to about a kilometre from the server's address, which its logs keep for 90 days. A named place goes with no dialog: the user or the model said it, and the field takes letters only, 80 at most, so it can carry little else to the service. City data is wrong for mobile networks and VPNs, so the dialog says so. |
| The agent learns where and when the user is | Timezone, country, locale and local time reach the LLM only through the `session` grant. These values are plaintext on the server, so the grant is a server-enforced consent, not a cryptographic boundary. IPs and the session list are never exposed to the agent. |

## Out of scope

Side channels in the browser or the OS, compromise of the user's passkey
provider (iCloud Keychain, Google Password Manager), coercion of the user,
traffic analysis beyond the metadata above, and quantum adversaries (all
public-key crypto is X25519; HPKE allows a hybrid KEM later via the format
version).
