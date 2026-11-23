---
name: commit-message
description: Write a commit message or PR title/body for Vault Chat using Conventional Commits. Use when asked to commit, write a commit message, or open a PR.
---

# Commit message

```
<type>(<scope>): <subject>

<body: why, wrapped at 72>
```

- Types: `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `build`, `ci`, `chore`, `style`.
- Scopes (when obvious): `crypto`, `protocol`, `server`, `client`, `ui`,
  `i18n`, `deploy`, `ci`, `deps`, `agents` (skills, AGENTS.md, hooks).
- Subject: imperative, lowercase, no period, ≤ 72 chars.
- English only. One logical change per commit.
- No `Co-Authored-By: Claude`, no "Generated with" lines, no session links.

PR body: follow `.github/pull_request_template.md`.

Before committing: only relevant files staged; never `.env*`, keys, real
provider API keys, `target/`, `dist/`; the checks from `verify-changes` were
green after the last edit.
