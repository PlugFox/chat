# Documentation

Decisions, rules and workflows that the code alone does not explain. Code
details live in the code; these pages say _why_ and _how to work with it_.

| Page | Read before |
| ---- | ----------- |
| [brief.md](brief.md) | Anything: the original project brief (goals, scope, milestone v1). Kept as written; decisions that refine it live in the pages below |
| [threat-model.md](threat-model.md) | Any change that touches data, keys, the agent or logging; writing user-facing security claims |
| [crypto.md](crypto.md) | Any change under `crates/crypto` or to a stored format |
| [auth.md](auth.md) | Anything about sign-in, tokens, sessions, devices, identities, the audit log or account deletion |
| [protocol.md](protocol.md) | Adding or changing a WebSocket message or HTTP route |
| [configuration.md](configuration.md) | Running the server; adding an environment variable |
| [design-system.md](design-system.md) | Writing client UI or CSS, adding a component, token or theme |
| [i18n.md](i18n.md) | Adding user-visible text or a locale |
| [testing.md](testing.md) | Writing tests; understanding a failing check |
| [deployment.md](deployment.md) | Self-hosting: compose, TLS, headers, backups |
| [decisions.md](decisions.md) | Deciding anything with lasting effect, or before doing something that contradicts a settled question |
| [roadmap.md](roadmap.md) | Picking the next task; the order of work and its state |

Still to write as the code appears: `architecture.md`.

Status markers: a page that starts with **draft for review** is a proposal;
nothing is built against it until the draft marker is removed.
