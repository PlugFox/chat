# Roadmap

The order of work from [brief.md](brief.md) §16, with the state of each step.
Update this page when a step starts or finishes.

## Phase 0 — specification

- [x] Draft [threat-model.md](threat-model.md), [crypto.md](crypto.md), [protocol.md](protocol.md)
- [x] Review the drafts; record the decisions (2026-10-25)

Decided: client-written records use HPKE auth mode; recovery key is 12
BIP-39 English words; `profile` is split into basics / medical / lifestyle;
Rust packages are named `chat-*`.

Still open (each is recorded in the page it affects once made):

1. HPKE crate: `hpke` vs `hpke-rs` (crypto.md, Crate choice) — prototype both
   in the first `crates/crypto` PR.
2. TypeScript generation: `ts-rs` vs `specta` (protocol.md) — decided in the
   first `crates/protocol` PR.
3. Session-management reference (to be provided) — blocks server auth.
4. Chat paging reference (to be provided) — may change `message.page`.

## Phase 1 — repository

- [ ] Cargo workspace (`crates/crypto`, `crates/protocol`, `server`), client
      package, mise tools and tasks, lefthook, Biome, Stylelint, typos,
      gitleaks, actionlint, cargo-deny, CI, Dependabot
- [ ] Agent files: AGENTS.md, CLAUDE.md, project skills (verify-changes,
      add-component, add-ws-message, add-migration, crypto-review), Stop hook

## Phase 2 — vertical slice (milestone v1, brief §13)

- [ ] `crates/crypto` with vectors, property tests, fuzz targets, WASM build
- [ ] Server skeleton: config, migrations, health, tracing
- [ ] Auth and sessions (Google OIDC, email OTP, revocation)
- [ ] WebSocket transport: envelope, auth, heartbeat, reconnect, resume
- [ ] Client shell: design system, themes, i18n, routing, crypto worker
- [ ] Key setup and unlock (passkey PRF, recovery key, second device, linking)
- [ ] Chats, messages, paging, virtualized list, streaming
- [ ] Saved messages
- [ ] Notebook
- [ ] Registers: weight, steps; entry, list, chart
- [ ] Provider settings (manual + QR), OpenAI-compatible and Anthropic adapters, fake provider
- [ ] Agent tools, permission dialog, access log
- [ ] docker compose deployment
