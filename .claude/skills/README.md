# Project skills

Loaded by Claude Code when a task matches the description. They summarize
`docs/` and add procedures; when they disagree, `docs/` wins.

| Skill | Use for |
| ----- | ------- |
| [verify-changes](verify-changes/SKILL.md) | Choosing and running checks before saying "done" |
| [commit-message](commit-message/SKILL.md) | Conventional commits and PR bodies |
| [crypto-review](crypto-review/SKILL.md) | Any change to `crates/crypto`, stored formats, keys or what the server/LLM sees |
| [add-ws-message](add-ws-message/SKILL.md) | A new or changed WebSocket message |

Added with the code they describe: `add-migration` (server skeleton),
`add-component` (client design system).

Adapted from the landing, pub and Foxic skills.
