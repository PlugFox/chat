---
name: add-ws-message
description: Add or change a WebSocket message (request, response or server event) in Vault Chat — protocol types in crates/protocol, the server handler, the generated TypeScript and the client call. Use whenever a feature needs the client and server to exchange something new.
---

# Add a WebSocket message

`docs/protocol.md` is the source; the code follows it.

## Steps

1. **Spec first**: add the message to the right table in `docs/protocol.md`
   (type name `area.verb`, payload, response or event). Decide:
   - Does it create something? Then it carries an `idempotency_key`.
   - Can it be resent after a reconnect? Say so.
   - Does it carry plaintext user content or tokens? Then its `Debug` is redacted
     and the threat model is checked (`crypto-review`).
   - Size limits (frame, record, context) still hold?
2. **Types** in `crates/protocol`: `serde` with `deny_unknown_fields`,
   binary fields as base64url strings, ids typed (no bare `String`s for ids).
   Adding an optional field is compatible; removing or changing one bumps `v`.
3. **Generate TypeScript** and commit the generated file; never edit it by hand.
4. **Server handler**: authorize by session and ownership on every query;
   errors map to stable `code`s; no payload in `tracing` fields.
5. **Client**: call through the socket client (outbox, retry rules), strings
   for errors by `code` through i18n.
6. **Tests**: a WebSocket integration test on the server (happy path,
   unauthorized, wrong owner, retry with the same idempotency key) and a
   client unit test for the call.
