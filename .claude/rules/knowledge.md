---
paths:
  - "CLAUDE.md"
  - "AGENTS.md"
  - "docs/**/*.md"
  - ".claude/**/*.md"
---

# Where knowledge goes

Put a fact in the narrowest home that fits, and in one only: a fact in two places will disagree with itself.

| Home | Loaded | Holds |
| ---- | ------ | ----- |
| `AGENTS.md` (+ `CLAUDE.md`) | every session | layout, commands, invariants every task needs |
| `.claude/rules/<topic>.md` with `paths:` | when a matching file is read or edited | the traps of one area |
| `.claude/skills/<name>/SKILL.md` | description always, body when invoked | a procedure done repeatedly |
| `docs/<topic>.md` | when the task touches the topic | specs, contracts, reasons, measurements |
| `docs/decisions.md` | when deciding or before contradicting | what was decided and by whom (skill `decision`) |

- Docs and rules record what the code does not show (D-006); point to paths instead of restating code.
- No code-style guidance anywhere: formatters, linters and ast-grep rules enforce it (D-007). A style rule worth having becomes a lint rule.
- A rule without `paths:` loads in every session; every rule here has one.
- When something a doc or rule says stops being true, fix it in the same change.
