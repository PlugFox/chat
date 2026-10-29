# Project skills

Loaded by Claude Code when a task matches the description. They summarize
`docs/` and add procedures; when they disagree, `docs/` wins.

| Skill                                     | Use for                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------- |
| [verify-changes](verify-changes/SKILL.md) | Choosing and running checks before saying "done"                                |
| [commit-message](commit-message/SKILL.md) | Conventional commits and PR bodies                                              |
| [crypto-review](crypto-review/SKILL.md)   | Any change to `crates/crypto`, stored formats, keys or what the server/LLM sees |
| [add-ws-message](add-ws-message/SKILL.md) | A new or changed WebSocket message                                              |
| [add-component](add-component/SKILL.md)   | A new design-system component or variant                                        |
| [add-migration](add-migration/SKILL.md)   | A schema or seed change in `server/migrations`                                  |
| [add-string](add-string/SKILL.md)         | User-visible text in every locale                                               |
| [decision](decision/SKILL.md)             | Recording or checking a decision in docs/decisions.md                           |

Area traps live in [../rules/](../rules/) (loaded by path), the read-only
reviewer in [../agents/reviewer.md](../agents/reviewer.md). No skill carries
code style: the linters own it (D-007).
