# Vault Chat — agent guide

A self-hostable personal AI assistant with client-held keys: Rust server
(axum, sqlx, PostgreSQL), SolidJS client, shared Rust crypto compiled to WASM.
AGPL-3.0. Start with [docs/README.md](docs/README.md); the original brief is
[docs/brief.md](docs/brief.md), the current state is [docs/roadmap.md](docs/roadmap.md).

## Current phase

The threat model, crypto spec and protocol are agreed; the repository tooling
is being set up ([docs/roadmap.md](docs/roadmap.md)). A format or message not
yet in [docs/crypto.md](docs/crypto.md) or [docs/protocol.md](docs/protocol.md)
is specified there before it is implemented.

## Rules

**Security** ([docs/threat-model.md](docs/threat-model.md)):
- Never log, persist or put in an error message any plaintext user content,
  token, API key or key material. Payload types redact `Debug`.
- Never claim more protection than the threat model states — in docs, UI
  text, README or commit messages. "End-to-end encrypted" is not used.
- Every stored format is versioned and specified in [docs/crypto.md](docs/crypto.md)
  before it is implemented. Primitives come from crates; nothing is hand-rolled.

**Code**:
- Do only what the task asks. No speculative abstractions or options.
- Comments explain _why_; `docs/` explains decisions and must not restate
  code. Update the matching page when a decision changes.
- All code, comments, docs, commits, issues and PRs in English.

## Before you say "done"

1. The checks for what you touched are green (they will be listed here when
   the tooling lands; for docs: `typos`).
2. If a check fails, fix the cause. Never weaken a test, threshold or lint
   rule to get green without saying so explicitly.

## Git

Conventional Commits (`feat(crypto): …`, `fix(server): …`, `docs: …`).
Branch from `master`. Never force-push `master`. No AI attribution lines in
commits, PRs or code.
