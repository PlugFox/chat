---
paths:
  - "server/**"
  - "crates/protocol/**"
---

# Server: traps

- Every HTTP route sits behind `middleware::stack` (server/src/middleware.rs): errors become `ErrorPayload`, so a handler returns `ApiError` or a protocol code, never a bare string body that the client cannot read.
- Integration tests need PostgreSQL and Valkey (`mise run db:up`); a test that needs a service fails when it is missing, never skips (D-073).
- Queries are runtime `sqlx::query`; there is no compile-time check, so every new query gets an integration test (D-049). A schema change follows skill `add-migration`.
- A new environment variable goes into `server/src/config.rs` with a redacted `Debug` if it can hold a secret, into `docs/configuration.md`, and into `deploy/compose.yaml` and `deploy/.env.example` when operators set it.
- A WebSocket message is specified in `docs/protocol.md` first (skill `add-ws-message`).
- `#[sqlx::test]` pools of one test binary share a parent pool of 20 connections, and a test server under a turn holds up to 5; with more tests at once the rest wait out sqlx's 30-second acquire timeout (or fail with `PoolTimedOut`). `check:rust` runs the server tests with `--test-threads=4`; do the same when running them by hand.
