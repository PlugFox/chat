---
name: decision
description: Record, change or check a decision in docs/decisions.md. Use when the user decides something, accepts a proposal, when an implementation choice with lasting impact is made (a crate, a format, a default, a limit), and before doing anything that contradicts an existing D-NNN entry.
---

# Decisions

Entry, appended under its section with the next free number of that section:
```
D-NNN [user|accepted|agent] <the decision in one line>
  why: <reason, with numbers if any>
  rejected: <alternatives and why>
  → <docs/page.md#anchor, paths>
```
Drop lines that add nothing; a one-line entry is fine.

- `[user]`: the user decided. Change it only with the user's explicit approval; ask, do not reinterpret.
- `[accepted]`: an agent proposed, the user approved. `[agent]`: an implementation choice; revise freely, but record the revision.
- Never renumber. A replaced entry keeps its text and gets `superseded by D-NNN`; the new entry says what it replaces.
- An entry states the decision, not the code that implements it (D-006): no field lists, no restated behaviour. Details belong in the linked page.
- Before contradicting an entry: stop, name it to the user, and get the change approved (for `[user]`) or record the revision (for `[agent]`).
