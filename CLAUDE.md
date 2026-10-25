@AGENTS.md

## Claude Code

- Talk to the user in Russian; write everything in the repository in English.
- For anything non-trivial: point out flaws and risks in the request, list
  edge cases, ask about real unknowns, propose simpler alternatives, then
  implement after agreement.
- Anything touching keys, formats or what the server/LLM can see: re-read
  [docs/threat-model.md](docs/threat-model.md) and [docs/crypto.md](docs/crypto.md) first.
- Project skills: [.claude/skills/](.claude/skills/) (index:
  [.claude/skills/README.md](.claude/skills/README.md)). When a skill and
  `docs/` disagree, `docs/` wins.
- [.claude/settings.json](.claude/settings.json) holds shared permissions;
  pushes and dependency additions always ask. A Stop hook
  ([.claude/hooks/stop-reminder.sh](.claude/hooks/stop-reminder.sh)) reminds
  which checks to run when the turn edited code.
