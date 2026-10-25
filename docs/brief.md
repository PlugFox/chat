# Vault Chat — project brief

> Working name. Open source, AGPL-3.0.
> This brief initializes the repository: it fixes the goals, the threat model,
> the architecture and the first milestone. Details not covered here are
> decided during implementation and recorded in `docs/`.

## 1. What it is

A personal AI assistant as a web app: a chat with an LLM agent plus a
notebook, saved messages and personal data tables (weight, steps, exercises…).
Multi-user, self-hostable, with **client-held keys**: everything is stored
encrypted on the server, and neither the server nor the LLM can read a user's
data without that user granting access to a specific scope at that moment.

Each user brings their own LLM: an external provider (OpenAI-compatible,
Anthropic, …) or a self-hosted model (e.g. Ollama) reachable from the server by
URL, with their own API key and model.

## 2. Principles

1. **The server is the source of truth, but blind.** Online-first; the server
   stores ciphertext, metadata and public keys, never a key that decrypts user data.
2. **Disclosure is explicit and scoped.** The agent sees user data only when the
   client approves a request naming the scopes and the reason, every time.
3. **Honest guarantees.** The README and docs state exactly what is protected
   and what is not (section 3). No "end-to-end" marketing beyond that.
4. **Losing all keys means losing the data.** No server-side recovery, by design.
5. **Simple, verifiable code.** Shared Rust crypto for client (WASM) and server,
   test vectors, no hand-rolled primitives.

## 3. Threat model

**Protects against:**
- A database, backup or object-storage leak: only ciphertext and metadata leak.
- A curious or compromised server operator reading stored data at rest.
- The LLM (or a prompt injection) reaching data outside the granted scopes.

**Does not protect against (stated in the docs):**
- The server and the LLM provider see the **plaintext of what is sent in a
  turn**: the user's message, the chat context the client sends, and data from
  approved grants. A malicious server could record it at that moment.
- A malicious server could serve malicious client code (inherent to web apps;
  mitigations later: reproducible builds, published hashes, optional
  self-hosted client).
- **Authenticity** of records the server writes (assistant replies, imports):
  the server encrypts them, so it could forge them.
- **Metadata**: who, when, how often, sizes, which chats/scopes/metrics exist,
  register periods. Metric definitions are plaintext on purpose (the agent may
  see which metrics exist, never their values).

## 4. Cryptography

All primitives come from audited crates; one Rust crate (`crates/crypto`)
implements formats and operations, compiled natively (server, tests) and to
WASM (client). Every format is versioned.

### Keys

| Key | Where it lives | Purpose |
| --- | -------------- | ------- |
| **Account Root Key (ARK)**, 256-bit random | Client memory only (Web Worker); stored on the server only wrapped | Root of the user's key hierarchy |
| **Wraps of the ARK** | Server | One per unlock method: each passkey (WebAuthn **PRF** → HKDF → KEK), the **recovery key** (shown once, as words), optionally a **passphrase** (Argon2id) |
| **Scope key pair** (X25519) per scope | Public key: server, plaintext. Private key: server, encrypted under a key derived from the ARK | Anyone (client, server, agent, importers) can **write** to a scope; only the client can **read** |
| **Content key** per file | Sealed to the scope public key | Chunked streaming encryption of large files |
| **Device key** (optional "remember this device") | Non-extractable WebCrypto key in IndexedDB | Wraps the ARK locally so the device unlocks without a passkey prompt |

- Records: HPKE (RFC 9180, X25519 + HKDF-SHA256 + ChaCha20-Poly1305) sealed to
  the scope public key. AAD binds the record to its place: format version,
  scope id, and for chat messages `chat_id` + `message_id`, so the server
  cannot silently move or reorder ciphertext.
- Files: per-file content key, chunked AEAD stream (e.g. 64 KiB chunks,
  STREAM construction), content key sealed to the scope.
- Key rotation per scope (re-encrypt that scope only); ARK rotation re-wraps scope keys.
- Keys never touch the main thread: a dedicated Web Worker runs the WASM crypto
  and exposes a narrow message API (unlock, seal, open, export-for-grant).

### Scopes

A scope is a unit of access: one key pair, one grant target. Granularity, not
time, limits access:

- `user.profile` — characteristics (age, sex, height, allergies…), one scope per characteristic group or attribute (decide in design).
- `chat:<id>` — one per chat.
- `register:<id>` — one per data table (weight, steps, exercises…).
- `notes:<notebook id>`, `files:<id>` or per notebook, `settings` (LLM provider configs, preferences), `audit` (access log details).

### Unlock and devices

- Sign-in (identity) and unlock (keys) are separate steps.
- First sign-up on a device generates the ARK, registers a passkey with PRF,
  shows the recovery key, uploads the wraps.
- New device: sign in, then unlock with a synced passkey (PRF), the recovery
  key, a passphrase, or **device linking** (QR from an unlocked device:
  ephemeral X25519 exchange, ARK transferred encrypted).
- Authenticators without PRF fall back to the recovery key / passphrase.

## 5. Agent and permissions

The agent loop runs **on the server**:

1. The client opens a WebSocket session and, after unlocking, sends the
   user's **LLM provider config** (decrypted from the `settings` scope). It
   lives only in server memory for the session.
2. Each turn the client sends the user message plus the **chat context** it
   decrypted itself (recent messages + a rolling summary). Sending a message in
   a chat is the implicit grant for that chat's context.
3. The LLM may call tools. Metadata tools need no grant (`list_scopes`,
   `list_metrics`: names, units, kinds, no values). Data tools
   (`read_register`, `read_profile`, `read_notes`, …) make the server send a
   `permission.request { scopes, reason }` to the client.
4. The client shows a dialog every time: scopes, the agent's reason, approve /
   deny. On approve the worker decrypts exactly those scopes and returns the
   plaintext as the tool result. Nothing about it is persisted in plaintext.
5. Replies stream to the client (`message.delta`); the final assistant message
   and tool results are sealed to the chat scope and stored.
6. Every request and decision goes to the **access log** (time, chat, scopes,
   decision; the reason sealed to `audit`), viewable by the user.

Providers: an interface with adapters for OpenAI-compatible APIs (covers
Ollama, vLLM, LM Studio, many hosted ones) and Anthropic; streaming and tool
calling required. Provider configs (base URL, API key, model) are entered by
hand or scanned/shown as a **QR code** to share between devices or people.

Aggregations over encrypted values (sum of steps, trends) happen on the
client after decryption, or inside an approved grant.

## 6. Domain

- **Users**, identities (Google subject, email), passkeys, ARK wraps.
- **Chats**: many per user, independent. **Messages** have ids `u32`
  **per chat**, strictly increasing, gaps allowed (deleted messages);
  allocated atomically from a per-chat counter. Stored as `BIGINT` with a
  `0..=4294967295` check (Postgres has no unsigned types).
- **History paging** by id: `before`/`after` cursors, chunks of 64 messages;
  the client's virtualized list maps id ranges to chunks and fetches on scroll.
- **Saved messages** (favorites): references to `(chat_id, message_id)`.
- **Notebook**: notebooks and notes (encrypted body, title encrypted too).
- **Registers** in the 1C sense, both kinds:
  - *information registers* — value per period (weight, height, blood pressure);
  - *accumulation registers* — movements summed over periods (steps, calories,
    exercise volume).
  Definitions (name, kind, unit, dimensions) are plaintext metadata; values
  are encrypted; periods are plaintext so ranges can be queried.
- **Files**: encrypted chunks in S3-compatible storage; the feature is
  disabled when the server has no storage configured.
- **Access log**.
- Later: reminders and push notifications as a server feature (design how
  their content stays confidential), integrations, exercises catalog.

## 7. Authentication and sessions

- Google OAuth (OIDC). Email OTP when SMTP is configured. TOTP later.
- Access token: JWT, 1 hour TTL. Refresh token: opaque, rotated on use,
  stored hashed.
- Sessions in the database with IP, user agent, created/last-seen times;
  users see and revoke them.
- Revoked session ids go to **Redis** when configured, otherwise an in-memory
  hash set, with a TTL slightly above the access-token TTL; middleware (HTTP
  and WebSocket) rejects tokens of revoked sessions.
- The session-management reference implementation and table layout are
  provided separately and take precedence over this section.

## 8. Transport

- **WebSocket** for everything interactive: chat turns, streaming, permission
  requests, sync events. HTTP only for auth flows, file transfer and health.
- Versioned JSON envelope: `{ v, id, type, payload }`; requests and responses
  correlate by `id`; server events have no `id`.
- Auth: the first frame carries the access token (never in the URL); on
  expiry the client refreshes over HTTP and re-authenticates the socket; a
  revoked session closes the socket with a dedicated close code.
- **Reconnects**: exponential backoff with jitter (capped), heartbeat
  ping/pong, resume by sending the last seen message id per open chat; the
  server replays what was missed. In-flight requests are retried or failed
  explicitly, never silently dropped.
- Protocol types are defined once in Rust (`crates/protocol`) and generated
  as TypeScript types for the client.

## 9. Stack

**Server**: Rust (edition 2024), tokio, axum, sqlx (PostgreSQL, compile-time
checked queries, migrations), tracing (never logs plaintext or secrets),
serde. Optional: Redis, SMTP, S3. Configuration via environment variables; the
server starts with only PostgreSQL configured and disables optional features.

**Client**: TypeScript (strictest), bun, Vite, SolidJS, a virtualized chat list
for long dialogs, Rust → WASM for crypto (wasm-bindgen) in a Web Worker,
i18n with ICU messages (Russian and English first), routing, PWA-ready later.

**Design system** (same discipline as the doctorina landing):
- DTCG JSON tokens → CSS custom properties; primitives never emitted, only
  semantic tokens; themes (light, dark at first; high contrast and AMOLED
  later) without flash, following the system by default.
- Components are the only source of styles; Stylelint enforces tokens-only,
  logical properties, no `px`/hex/`!important`.
- Every interactive element ≥ 48×48; WCAG 2.2 AA (contrast tested per theme);
  responsive from 320px phones to desktops; RTL-safe CSS.
- A UI kit page with every component and variant, tested in every theme.

## 10. Repository layout (monorepo)

```
crates/
  crypto/        key hierarchy, HPKE records, file streams, wraps; native + wasm
  protocol/      WebSocket and HTTP types; generates TypeScript
server/          axum app: auth, sessions, chats, registers, notes, files, agent, providers
client/          SolidJS app (design system, features, crypto worker)
docs/            architecture, threat model, crypto spec, protocol, deployment, design system
deploy/          docker compose for a VPS (server, PostgreSQL, optional Redis/MinIO), Caddy example
.github/         CI, release workflows
```

Agent-friendly from day one: `AGENTS.md` + `CLAUDE.md`, `docs/` that explain
decisions (not restate code), project skills (verify changes, add a component,
add a WebSocket message, add a migration, crypto review), a Stop hook with
the check reminder, mise for tool versions and tasks, lefthook.

## 11. Quality

- Server: `cargo fmt`, `clippy -D warnings`, `cargo test` with `sqlx::test`
  databases, WebSocket integration tests, `cargo deny` / `cargo audit`.
- Crypto: published test vectors, the same vectors run natively and in WASM,
  property tests (round trips, tampered AAD/ciphertext must fail), fuzzing of
  decoders; a written spec in `docs/crypto.md` reviewed before code.
- Client: Biome, Stylelint, type check, Vitest, Playwright e2e (axe in every
  theme, touch targets, i18n, reconnects, permission dialog), visual checks on
  phone and desktop widths.
- A **fake LLM provider** (OpenAI-compatible, scripted responses and tool
  calls) for deterministic agent tests.
- Strict CSP (`script-src 'self' 'wasm-unsafe-eval'`), no third-party scripts.
- CI on every PR; typos, actionlint, gitleaks; Dependabot.

## 12. Deployment

Self-hosting first: a single VPS with docker compose (server + PostgreSQL,
optional Redis and MinIO), TLS via a reverse proxy, documented environment
variables, backups (database dumps contain only ciphertext and metadata).
Other targets later.

## 13. Milestone v1 (vertical slice)

1. Sign-in with Google and email OTP; sessions with revocation.
2. Key setup: ARK, passkey PRF unlock, recovery key; unlock on a second device.
3. WebSocket transport with reconnect and resume.
4. Chats: list, create, rename, delete; messages with per-chat `u32` ids,
   64-message paging, virtualized list, streaming replies.
5. Saved messages.
6. Notebook: notebooks and notes.
7. Registers: weight (information) and steps (accumulation) — entry, list,
   simple chart.
8. LLM provider settings (manual + QR), OpenAI-compatible and Anthropic adapters.
9. Agent tools: metadata tools + one data tool with the permission dialog,
   access log screen.
10. Design system, light and dark themes, Russian and English.
11. Tests and CI as in section 11; docker compose deployment.

## 14. Desired features (beyond v1)

- Encrypted file storage (S3) and attachments in chats and notes.
- More registers: exercises and workouts, nutrition, sleep, blood pressure;
  custom user-defined registers.
- Reminders and push notifications (server feature, confidential content).
- Integrations through OAuth cloud sync (Fitbit, Withings, Garmin, Strava…),
  importing sealed to scope public keys.
- Client-side search over decrypted history (WASM index).
- IndexedDB cache, offline reading, PWA install.
- TOTP sign-in; passkeys as a sign-in method too.
- Encrypted export and import (full backup the user can restore).
- Key rotation UI, device management, session list with IP.
- Client-as-relay mode for LLMs reachable only from the user's device.
- High-contrast and AMOLED themes, more languages.
- Voice input (browser speech recognition or a provider's transcription).
- 3D avatar of the assistant (three.js), optional and lazy-loaded.
- Admin settings for self-hosters (registration policy, quotas).

## 15. Open questions

- Scope granularity of `user.profile` (one scope vs one per attribute).
- Rolling chat summaries: when to create them, how large the context window is.
- Confidential reminders: what the push payload may contain.
- Whether user-written records should be signed by the client (authenticity
  against the server).
- Session-management reference (to be provided) and the Flutter chat paging
  reference (to be provided).

## 16. How to start

1. Write `docs/threat-model.md`, `docs/crypto.md` and `docs/protocol.md` from
   sections 3–5 and 8 and review them before any code.
2. Scaffold the monorepo, tooling (mise, CI, lint, hooks) and agent files.
3. Implement `crates/crypto` with test vectors, then the server skeleton
   (config, migrations, auth, sessions), then the WebSocket protocol, then the
   client shell with the design system, then the v1 features in order.

For anything non-trivial: challenge the approach, list edge cases and risks,
ask about real unknowns, and agree on the plan before writing code.
