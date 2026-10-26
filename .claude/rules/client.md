---
paths:
  - "client/src/**"
  - "client/tests/**"
---

# Client: traps

- Screens use design-system components only; a missing look is a new component or variant shown on `/ui-kit` (skill `add-component`). ast-grep refuses `class`/`style` in `client/src/features`.
- Every user-visible string goes through `t()` in every locale (skill `add-string`); error text comes from protocol codes, never from server messages.
- The access token lives in memory only; nothing auth-related goes to `localStorage` except the device id (D-034).
- e2e runs against `vite preview` with no server: `/auth/**` is answered by `tests/e2e/fixtures.ts`, `/ws` by `tests/e2e/fake-keys.ts`; a new endpoint or message the UI uses needs a fake answer there. Pages behind the key gate open unlocked by default (docs/testing.md).
- `client/src/protocol/generated/` is generated from `crates/protocol`; edit the Rust types and regenerate.
- A new dependency changes the bundle: check `bun run build` sizes, and the CSP still holds (`check:e2e`).
- A screen inside a `<Match>` reads values that change while it is up (flags in the keys state) from the state, not from the Match value, and captures long-lived objects once (`const vault = props.vault`): a tracked read of the Match value throws "Stale read from <Match>" the moment the condition flips, and the switch never finishes.
- Nothing on the main thread holds a key: a secret on its way to the worker (PRF output) is wiped after the call, and the device secret never leaves the worker (D-064, D-018).
