# Testing

| Layer | Tool | Command | Covers |
| ----- | ---- | ------- | ------ |
| Crypto | cargo test, proptest, cargo fuzz | `mise run check:rust`, `mise run fuzz` | vectors natively and in WASM, tampering, decoders ([crypto.md](crypto.md#testing)) |
| Server | cargo test, `#[sqlx::test]` | `mise run check:rust` (needs `mise run db:up`) | config, health, WebSocket transport over real sockets, `/auth` flows with a fake Google and captured mail, the Redis store against Valkey (`CHAT_TEST_REDIS_URL`; the leg fails when it is missing) |
| Protocol | cargo test | same | envelope parsing, redaction, generated TypeScript is fresh |
| Client unit | Vitest (jsdom) | `mise run check:client` | WebSocket client with fake sockets and timers, i18n catalogs, token contrast, design-system contract |
| Client e2e | Playwright + axe | `mise run check:e2e` | every page on phone and desktop: axe in every theme, 48px targets, no-flash themes, language switch, CSP, no third-party requests, navigation and focus, no horizontal scroll at 320px; key setup, unlock (recovery key, passkey with PRF on Chromium's virtual authenticator, remembered device), unlock methods, and device linking between two browsers |

Rules: fix the cause of a failure; never weaken a test, threshold or lint rule
to get green without saying so. For visual changes, also look at the page on a
phone and a desktop width, light and dark.

## e2e without a server

`vite preview` has no server behind it. `/auth/**` is answered by
`tests/e2e/fixtures.ts` and `/ws` by `tests/e2e/fake-keys.ts`, which stores
what the client uploads. The default account is made in Node by the real
chat-crypto WASM, then unlocked once with its recovery words and "remember
this device", so every later page load unlocks by itself (`vault: "locked"`
and `vault: "new"` start elsewhere). Tests run on `localhost`, not
`127.0.0.1`: WebAuthn refuses an IP address as the relying party. Pages that
install the same `FakeKeys` act as two devices of one account, which is how
linking is tested; the phone camera is stood in for by the test build, which
aliases `uqr` to `tests/e2e/uqr-spy.ts` so a test can read what the QR encodes.
