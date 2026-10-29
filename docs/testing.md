# Testing

| Layer | Tool | Command | Covers |
| ----- | ---- | ------- | ------ |
| Crypto | cargo test, proptest, cargo fuzz | `mise run check:rust`, `mise run fuzz` | vectors natively and in WASM, tampering, decoders ([crypto.md](crypto.md#testing)) |
| Server | cargo test, `#[sqlx::test]` | `mise run check:rust` (needs `mise run db:up`) | config, health, WebSocket transport over real sockets, `/auth` flows with a fake Google and captured mail, settings, chats and turns over a socket against the fake LLM, saved messages (pages in parts, tombstones, the limit) (`server/tests/support/fake_llm.rs`, including a reply that never ends, for cancel and snapshots), notes (one scope per account under racing setups, pages, resends, revision conflicts, key versions, the limit, ownership, events), registers (the seeded catalog, one scope per metric under racing setups, ranges and pages in parts, resends, revision conflicts, key versions, moments out of range, the account's limit, ownership, events), agent tools and permissions (an approval reaching the model while the reply keeps only the call, answers only from the asking auth session and only once, a denied grant not asked again, the answers the server gives itself, the call limit, `session_context` filled by the server, a reload finding the request, cancel and timeout, the access log's pages), the Redis store and bus against Valkey (`CHAT_TEST_REDIS_URL`; the leg fails when it is missing) |
| Documents | cargo test, cargo fuzz | `mise run check:rust`, `mise run fuzz` | Markdown to documents: every block, charts and their limits, unsafe links, HTML as text, the depth and size limits, the encoded shape ([crypto.md](crypto.md#message-documents)) |
| Protocol | cargo test | same | envelope parsing, redaction, generated TypeScript is fresh |
| Client unit | Vitest (jsdom) | `mise run check:client` | WebSocket client with fake sockets and timers, provider settings and agent session start, provider links (round trip, a pasted link from any host, refused fragments), note documents through the editor and back (unknown blocks kept, nesting flattened), the notebook and its autosave (debounce, a conflict leaving a copy, a body too large to send), registers (value records, days at the offset each entry was recorded with, values checked against a metric, entries in parts, unreadable entries, conflicts, events), permission requests (a register's days by each entry's own offset, the oldest dropped to fit a result, an unknown register refused unseen, late and repeated requests, an answer that did not go out) and a reply's tool calls, i18n catalogs, token contrast, design-system contract |
| Client e2e | Playwright + axe | `mise run check:e2e` | every page on phone and desktop: axe in every theme, 48px targets, no-flash themes, language switch, CSP, no third-party requests, navigation and focus, no horizontal scroll at 320px; key setup, unlock (recovery key, passkey with PRF on Chromium's virtual authenticator, remembered device), unlock methods, device linking between two browsers, provider settings (stored sealed, opened after a reload, synced to a second browser; shared by QR without the key and added in a second browser, a copied link filling the add form, a link already added, a damaged link, signed out), saved messages (saving, the saved page, opening a chat at a message far up its history), and notes (typing with Markdown shortcuts and keys, sealed records, reopening after a reload, tasks, tables and callouts from the toolbar, pasted Markdown with a chart, a conflict leaving a copy, deletion), registers (entries added, edited and deleted, sealed values, days as averages and totals, values checked against their metric, a conflict keeping the stored entry, axe with the chart and the entry dialog), and permissions (a register read approved with only that day's entries, the reply's tool line and the access log with its reason, Esc denying, a waiting request back after a reload, an unknown register refused without a dialog, axe on the dialog) |

Rules: fix the cause of a failure; never weaken a test, threshold or lint rule
to get green without saying so. For visual changes, also look at the page on a
phone and a desktop width, light and dark.

## e2e without a server

`vite preview` has no server behind it. `/auth/**` is answered by
`tests/e2e/fixtures.ts` and `/ws` by `tests/e2e/fake-keys.ts`, which stores
what the client uploads (keys, scope keys, settings) and records `agent.start`. The default account is made in Node by the real
chat-crypto WASM, then unlocked once with its recovery words and "remember
this device", so every later page load unlocks by itself (`vault: "locked"`
and `vault: "new"` start elsewhere). Tests run on `localhost`, not
`127.0.0.1`: WebAuthn refuses an IP address as the relying party. Pages that
install the same `FakeKeys` act as two devices of one account, which is how
linking is tested; the phone camera is stood in for by the test build, which
aliases `uqr` to `tests/e2e/uqr-spy.ts` so a test can read what the QR encodes.
