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

D-064 [agent] Keys live in a Web Worker running `chat-crypto` as WASM; no worker method returns key material.
  → docs/crypto.md#client-worker-api

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
