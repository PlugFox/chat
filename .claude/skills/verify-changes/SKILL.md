---
name: verify-changes
description: Run the right checks for what changed before declaring work done in Vault Chat. Use before reporting a task complete, when asked to "check", "validate", "make sure it builds", or before a commit or PR.
---

# Verify changes

AGENTS.md: a task is done when it is verified, not when it is written.

## Pick the checks

From `git status` / `git diff --name-only`:

| Touched | Run |
| ------- | --- |
| `crates/`, `server/`, `Cargo.toml`, `Cargo.lock` | `mise run check:rust` |
| `crates/crypto/` | also the `crypto-review` skill |
| `client/` | `mise run check:client` |
| Dependencies (`Cargo.lock`, `client/bun.lock`) | also `mise run audit` |
| `.github/workflows/` | `actionlint` |
| `*.toml` | `taplo lint` |
| Only `docs/`, `*.md` | `typos` |
| Before a PR | `mise run check` |

## When something fails

Show the failing tail, find the cause, fix it. Do not weaken a test, a lint
rule or a `deny.toml` policy, and do not add `#[allow]`, `biome-ignore` or
`stylelint-disable`, to get green; if a rule is genuinely wrong for a case,
say so and ask.

## Footguns

- `cargo fmt` needs `--all` (virtual workspace manifest).
- CI uses `--locked`; a `Cargo.lock` change you did not commit fails there.
- The WASM build (`--target wasm32-unknown-unknown`) catches dependencies that
  pull in OS-only code (e.g. `getrandom` without its wasm backend).
