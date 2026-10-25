# Documentation

Decisions, rules and workflows that the code alone does not explain. Code
details live in the code; these pages say _why_ and _how to work with it_.

| Page | Read before |
| ---- | ----------- |
| [brief.md](brief.md) | Anything: the original project brief (goals, scope, milestone v1). Kept as written; decisions that refine it live in the pages below |
| [threat-model.md](threat-model.md) | Any change that touches data, keys, the agent or logging; writing user-facing security claims |
| [crypto.md](crypto.md) | Any change under `crates/crypto` or to a stored format |
| [protocol.md](protocol.md) | Adding or changing a WebSocket message or HTTP route |
| [roadmap.md](roadmap.md) | Picking the next task; the order of work and its state |

Pages still to write as the code appears: `architecture.md`, `deployment.md`,
`design-system.md`, `i18n.md`, `testing.md`.

Status markers: a page that starts with **draft for review** is a proposal;
nothing is built against it until the draft marker is removed.
