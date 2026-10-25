# Testing

| Layer | Tool | Command | Covers |
| ----- | ---- | ------- | ------ |
| Crypto | cargo test, proptest, cargo fuzz | `mise run check:rust`, `mise run fuzz` | vectors natively and in WASM, tampering, decoders ([crypto.md](crypto.md#testing)) |
| Server | cargo test, `#[sqlx::test]` | `mise run check:rust` (needs `mise run db:up`) | config, health, WebSocket transport over real sockets |
| Protocol | cargo test | same | envelope parsing, redaction, generated TypeScript is fresh |
| Client unit | Vitest (jsdom) | `mise run check:client` | WebSocket client with fake sockets and timers, i18n catalogs, token contrast, design-system contract |
| Client e2e | Playwright + axe | `mise run check:e2e` | every page on phone and desktop: axe in every theme, 48px targets, no-flash themes, language switch, CSP, no third-party requests, navigation and focus, no horizontal scroll at 320px |

Rules: fix the cause of a failure; never weaken a test, threshold or lint rule
to get green without saying so. For visual changes, also look at the page on a
phone and a desktop width, light and dark.
