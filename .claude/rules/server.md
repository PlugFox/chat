---
paths:
  - "server/**"
  - "crates/protocol/**"
---

# Server: traps

- Every HTTP route sits behind `middleware::stack` (server/src/middleware.rs): errors become `ErrorPayload`, so a handler returns `ApiError` or a protocol code, never a bare string body that the client cannot read.
- Integration tests need PostgreSQL and Valkey (`mise run db:up`); a test that needs a service fails when it is missing, never skips (D-073).
- Queries are runtime `sqlx::query`; there is no compile-time check, so every new query gets an integration test (D-049).
- A new environment variable goes into `server/src/config.rs` with a redacted `Debug` if it can hold a secret, into `docs/configuration.md`, and into `deploy/compose.yaml` and `deploy/.env.example` when operators set it.
- A WebSocket message is specified in `docs/protocol.md` first (skill `add-ws-message`).
