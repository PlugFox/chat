---
name: add-string
description: Add or change user-visible text in the Vault Chat client — labels, messages, aria-labels, errors — in every locale. Use whenever code would otherwise contain a hardcoded string the user can see or hear.
---

# Add a string

Read `docs/i18n.md`.

1. Add the key to `client/src/i18n/messages/en.ts` (`area.name`, English,
   ICU syntax: `{count, plural, one {# chat} other {# chats}}`).
2. Add the same key to every other locale (`ru.ts`): the type check fails
   otherwise. Russian plurals need `one`, `few`, `many`, `other`.
3. Use it: `const { t } = useI18n(); t("area.name", { count })`.
4. `bun run test` (from `client/`) checks parsing and matching arguments.

Rules: no string concatenation to build sentences (word order differs);
one key per sentence; no user content or secrets in messages; error texts
come from protocol `code`s, never from server `message`s.
