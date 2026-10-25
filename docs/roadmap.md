# Roadmap

The order of work from [brief.md](brief.md) §16, with the state of each step.
Update this page when a step starts or finishes.

## Phase 0 — specification

- [x] Draft [threat-model.md](threat-model.md), [crypto.md](crypto.md), [protocol.md](protocol.md)
- [x] Review the drafts; record the decisions (2026-10-25)

Decided: client-written records use HPKE auth mode; recovery key is 12
BIP-39 English words; `profile` is split into basics / medical / lifestyle;
Rust packages are named `chat-*`; HPKE comes from the `hpke` crate
(crypto.md, Crate choice); TypeScript is generated with `ts-rs`.

Still open (each is recorded in the page it affects once made):

1. Chat paging reference (to be provided) — may change `message.page`.

Decided 2026-10-26: authentication and sessions, specified in
[auth.md](auth.md) (reuses the foxic and pub designs with their defects
fixed).

## Phase 1 — repository

- [x] Cargo workspace (`crates/crypto`, `crates/protocol`, `server`), client
      package, mise tools and tasks, lefthook, Biome, Stylelint, typos,
      taplo, gitleaks, actionlint, cargo-deny, cargo-audit, CI, Dependabot
- [x] Agent files: AGENTS.md, CLAUDE.md, project skills (verify-changes,
      commit-message, crypto-review, add-ws-message), Stop hook
- [ ] `add-migration` and `add-component` skills — with the server skeleton
      and the design system they describe

## Phase 2 — vertical slice (milestone v1, brief §13)

- [x] `crates/crypto` with vectors, property tests, fuzz targets, WASM tests
      (files/STREAM come with the files feature after v1)
- [x] Server skeleton: config, migrations, health, tracing
- [x] Auth and sessions, server ([auth.md](auth.md)): schema, JWT and
      revocation store (memory, Redis), client IP and country, email code,
      Google, sessions and devices, linking, audit log, account deletion,
      retention
- [ ] Auth, client: token handling (Web Locks, BroadcastChannel), sign-in
      screen, sessions, identities, activity and account deletion in settings
- [x] WebSocket transport, server side: envelope, auth (behind a token
      verifier until sign-in lands), heartbeat, renewal, revocation, limits,
      close codes, graceful shutdown
- [x] WebSocket client: reconnect with backoff, heartbeat, outbox, renewal
- [ ] Resume (`sync`, `turn.state`) — with chats
- [x] Per-IP limit on unauthenticated sockets
- [x] Client shell: design system, themes, i18n, routing, UI kit, e2e suite
- [x] Crypto worker: chat-crypto as WASM in a Web Worker behind a typed API,
      self-test in the UI kit and the e2e suite
- [ ] Key setup and unlock (passkey PRF, recovery key, second device, linking)
- [ ] Chats, messages, paging, virtualized list, streaming
- [ ] Saved messages
- [ ] Notebook
- [ ] Registers: weight, steps; entry, list, chart
- [x] OpenAI-compatible and Anthropic adapters (streaming, tool calls), address policy against SSRF, fake provider
- [ ] Provider settings UI (manual + QR)
- [ ] Agent tools, permission dialog, access log
- [x] docker compose deployment (server, PostgreSQL, Caddy with the client), images built in CI

## After v1

- Refresh token in the response body as an operator option; API on its own
  origin (credentialed CORS, runtime client config) — [auth.md](auth.md#not-in-v1)
