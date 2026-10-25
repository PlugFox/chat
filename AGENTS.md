# Vault Chat — agent guide

A self-hostable personal AI assistant with client-held keys: Rust server
(axum, sqlx, PostgreSQL), SolidJS client, shared Rust crypto compiled to WASM.
AGPL-3.0. Start with [docs/README.md](docs/README.md); the original brief is
[docs/brief.md](docs/brief.md), the current state is [docs/roadmap.md](docs/roadmap.md).

## Layout and commands

```
crates/crypto/    key hierarchy, records, wraps, file streams; native + wasm32 (chat-crypto)
crates/protocol/  WebSocket and HTTP types; generates TypeScript (chat-protocol)
server/           axum app (chat-server)
client/           SolidJS app: bun, Vite, TypeScript strictest
docs/             spec and decisions — start at docs/README.md
```

Tool versions and tasks: [mise.toml](mise.toml); Rust from rustup
([rust-toolchain.toml](rust-toolchain.toml)). One-time: `mise install && mise run setup`.

```bash
mise run db:up          # local PostgreSQL (Docker, 127.0.0.1:5433)
mise run dev:server     # server on http://localhost:8080
mise run dev            # client on http://localhost:3000
mise run check          # everything CI runs
mise run check:rust     # fmt, clippy -D warnings, tests (needs db:up), crypto tests in WASM
mise run check:client   # Biome, Stylelint, types, Vitest, build
mise run check:e2e      # Playwright: axe per theme, 48px targets, i18n, CSP (phone + desktop)
mise run check:repo     # typos, taplo, actionlint, gitleaks
mise run audit          # cargo deny, cargo audit, bun audit
mise run fuzz [secs]    # chat-crypto fuzz targets (nightly + cargo-fuzz)
mise run fmt            # rustfmt, taplo, Biome, Stylelint fixes
```

## Current phase

Building milestone v1 in the order of [docs/roadmap.md](docs/roadmap.md). A format or message not yet in
[docs/crypto.md](docs/crypto.md) or [docs/protocol.md](docs/protocol.md) is
specified there before it is implemented.

## Rules

**Security** ([docs/threat-model.md](docs/threat-model.md)):
- Never log, persist or put in an error message any plaintext user content,
  token, API key or key material. Payload types redact `Debug`.
- Never claim more protection than the threat model states — in docs, UI
  text, README or commit messages. "End-to-end encrypted" is not used.
- Every stored format is versioned and specified in [docs/crypto.md](docs/crypto.md)
  before it is implemented. Primitives come from crates; nothing is hand-rolled.

**Client UI** ([docs/design-system.md](docs/design-system.md), [docs/i18n.md](docs/i18n.md)):
- Build screens only from `client/src/design-system/components`; features set
  no `class` or `style`. Missing a look? Add a component or variant and show
  it on `/ui-kit`.
- CSS uses tokens only, logical properties, no `px`/hex/`!important`;
  Stylelint enforces it, do not disable rules to get past it.
- Every interactive element is at least 48×48. No hardcoded user-visible
  text: every string goes through `t()` in English and Russian.

**Code**:
- Do only what the task asks. No speculative abstractions or options.
- Comments explain _why_; `docs/` explains decisions and must not restate
  code. Update the matching page when a decision changes.
- All code, comments, docs, commits, issues and PRs in English.

## Before you say "done"

1. The checks for what you touched are green (`verify-changes` skill picks
   them; `mise run check` before a PR). Changes to `crates/crypto` also go
   through the `crypto-review` skill.
2. If a check fails, fix the cause. Never weaken a test, threshold or lint
   rule to get green without saying so explicitly.

## Git

Conventional Commits (`feat(crypto): …`, `fix(server): …`, `docs: …`).
Branch from `master`. Never force-push `master`. No AI attribution lines in
commits, PRs or code.
