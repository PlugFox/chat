# Roadmap

The order of work from [brief.md](brief.md) §16, with the state of each step.
Update this page when a step starts or finishes.

## Phase 0 — specification

- [x] Draft [threat-model.md](threat-model.md), [crypto.md](crypto.md), [protocol.md](protocol.md)
- [x] Review the drafts; record the decisions (2026-10-25)

Decisions are in [decisions.md](decisions.md).

The chat model (chunks of 64, revisions, server-sealed messages) was settled
on 2026-10-26 instead of a paging reference (D-028, D-029).


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
- [x] Auth, client: token handling (Web Locks, BroadcastChannel), sign-in
      screen, sessions, identities, activity and account deletion in settings
- [x] WebSocket transport, server side: envelope, auth (behind a token
      verifier until sign-in lands), heartbeat, renewal, revocation, limits,
      close codes, graceful shutdown
- [x] WebSocket client: reconnect with backoff, heartbeat, outbox, renewal
- [x] MessagePack frames, response parts, cross-implementation fixtures (D-026, D-027)
- [x] Per-IP limit on unauthenticated sockets
- [x] Client shell: design system, themes, i18n, routing, UI kit, e2e suite
- [x] Crypto worker: chat-crypto as WASM in a Web Worker behind a typed API,
      self-test in the UI kit and the e2e suite
- [x] Key setup and unlock: passkey PRF, recovery key, remembered device,
      unlock methods in settings (add/remove passkey, replace the recovery
      key, forget the device), keys messages and tables
- [x] Device linking by QR (`link.*`), direction A (D-075)
- [ ] Chats, messages, chunks, editing and deletion, virtualized list
      (try virtua's SolidJS adapter first), streaming as message updates;
      pins and archive (D-080, D-081). Server side, event bus and agent
      sessions done; client next
- [ ] Errors in the chat (D-089): a failed turn always leaves a `failed`
      assistant message with its code (spec in protocol.md first); the
      client renders failed turns and unreadable records (decryption, parse,
      unknown version, size) as errors in place, unknown codes as a generic
      error, with retry; only the code is stored, never error text; a
      rejected send is a toast and adds nothing to the chat. Server side,
      with retry in place (D-090), done; client next
- [ ] Chat context (D-091): per-chat choice of how many recent messages a
      turn sends and of auto-compaction, account defaults and auto-compaction
      in settings, compaction into `summary` messages; automatic titles,
      renewed on compaction. The agent's request for older history comes with
      the agent tools
- [ ] Saved messages
- [ ] Notebook
- [ ] Registers: weight, steps; entry, list, chart
- [x] OpenAI-compatible and Anthropic adapters (streaming, tool calls), address policy against SSRF, fake provider
- [ ] Provider settings UI: manual entry with presets, encrypted `providers`
      setting and agent session start done (D-086); QR transfer left
- [ ] Agent tools, permission dialog, access log
- [x] docker compose deployment (server, PostgreSQL, Caddy with the client), images built in CI

## After v1

- Decide whether and how to protect chat messages from forgery (N3, D-016);
  candidates and their limits in [crypto.md](crypto.md#authenticity)
- Refresh token in the response body as an operator option; API on its own
  origin (credentialed CORS, runtime client config) — [auth.md](auth.md#not-in-v1)
