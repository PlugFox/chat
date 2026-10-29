# Threat model

> Status: **agreed** (2026-10-25; authentication added 2026-10-26; server-sealed chat messages 2026-10-26). Changes to this page need the same review
> as changes to the crypto code.

Vault Chat keeps user data encrypted on the server under keys only the user's
client holds. This page says exactly what that buys and what it does not. The
README links here and must not claim more.

## Assets

| Asset | Examples | Who can read it in plaintext |
| ----- | -------- | ---------------------------- |
| Stored content | chat messages, notes, register values, profile, files, settings (incl. LLM API keys), access-log reasons | The user's unlocked clients only |
| Turn content | the user's message, the chat context the client sends, plaintext from approved grants, the reply | The client, **the server and the LLM provider**, during the turn |
| Keys | ARK, scope private keys, content keys | The user's unlocked clients only (Web Worker memory) |
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
through the chat context the client chose to send and through grants the user
approved for named scopes in that turn. A prompt injection can make the agent
*ask* for more scopes; it cannot obtain them without a user decision shown in a
dialog the client renders from its own data.

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
the chat context the client sends, plaintext of approved grants, and the
provider config (base URL, API key, model) for the life of the session and of
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
and assigns their ids, D-016), tool results, summaries, imports and
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
- Access log: when each permission request was made and answered, its chat
  and turn, the tool, the register's metric and scope, the days asked for,
  and the outcome. The reason the model gave is sealed.
- Activity: when the user is online, how often turns happen, which provider
  host the server calls (and the provider sees the server's IP).

## Specific risks and how the design answers them

| Risk | Answer |
| ---- | ------ |
| Server substitutes keys during **device linking** (MITM of the ephemeral exchange) | The QR code carries a one-time secret the server never sees; it authenticates the exchange ([crypto.md](crypto.md#device-linking)). |
| Someone who took over the **sign-in** (not the keys) gets the user to open their link: a QR shown to them, or the same URL sent as a message | The unlocked device sends nothing without the user's confirmation. It shows how the asking device describes itself (browser from its user agent, country from its IP), says that this description can be anything, and says to continue only for a code the user just scanned on their own screen, never for one sent to them. A link lives 2 minutes and is used once, a revoked session's links stop working, and the audit log records every completed link. What is left is the phishing risk of every QR sign-in: a user who confirms anyway hands over the keys. |
| Server asks for scopes the user did not intend; the dialog shows server-supplied labels | The dialog renders scope names from the client's own decrypted data and metadata; unknown scope ids are refused, not shown. The agent's reason is displayed as untrusted quoted text. |
| Prompt injection exfiltrates granted data to a URL | v1 has no tools that make outbound requests. Any future network tool is a grant of its own. |
| An approved **grant** | The client decrypts the entries asked for and sends them to the server in plaintext, which passes them to the turn's provider (N1), through Redis pub/sub when the socket and the turn are on different replicas, as deltas go ([protocol.md](protocol.md#event-delivery)). Nothing about the result is stored: the reply's record lists the call and its outcome, not the data, though the reply's text may quote it. The dialog names the provider host the data goes to, from the client's own settings; a request for a provider the client does not hold cannot be approved. |
| The model, or text it read (a register comment), presses for grants | Every grant is a dialog built from the client's own data, with the model's reason shown as its words; one grant is approved or denied whole. A denied grant asked again in the same turn is denied without a dialog, and a turn makes at most 8 tool calls, after which the model is offered no tools. |
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
| The agent learns where and when the user is | Timezone, country, locale and local time reach the LLM only through the `session` grant. These values are plaintext on the server, so the grant is a server-enforced consent, not a cryptographic boundary. IPs and the session list are never exposed to the agent. |

## Out of scope

Side channels in the browser or the OS, compromise of the user's passkey
provider (iCloud Keychain, Google Password Manager), coercion of the user,
traffic analysis beyond the metadata above, and quantum adversaries (all
public-key crypto is X25519; HPKE allows a hybrid KEM later via the format
version).
