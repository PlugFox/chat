---
paths:
  - "client/src/**"
  - "client/tests/**"
---

# Client: traps

- Screens use design-system components only; a missing look is a new component or variant shown on `/ui-kit` (skill `add-component`). ast-grep refuses `class`/`style` in `client/src/features`.
- Every user-visible string goes through `t()` in every locale (skill `add-string`); error text comes from protocol codes, never from server messages.
- The access token lives in memory only; nothing auth-related goes to `localStorage` except the device id (D-034).
- e2e runs against `vite preview` with no server: `/auth/**` is answered by `tests/e2e/fixtures.ts`; a new endpoint the UI calls needs a fake answer there.
- `client/src/protocol/generated/` is generated from `crates/protocol`; edit the Rust types and regenerate.
- A new dependency changes the bundle: check `bun run build` sizes, and the CSP still holds (`check:e2e`).
