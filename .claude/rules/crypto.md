---
paths:
  - "crates/crypto/**"
  - "crates/crypto-wasm/**"
  - "client/src/crypto/**"
  - "docs/crypto.md"
  - "docs/threat-model.md"
---

# Cryptography: traps

The spec is `docs/crypto.md`, the guarantees `docs/threat-model.md`; the
`crypto-review` skill runs before such a change is committed.

- The spec leads. A format, label or AAD field that is not in `docs/crypto.md` is specified there first, in the same change.
- Regenerating `crates/crypto/vectors/v1.json` (`CHAT_CRYPTO_REGEN=1`) changes the frozen format. Only for a new version, never to make a failing test pass.
- `serde-wasm-bindgen` turns `Vec<u8>` into a JS array unless the field uses `serde_bytes`; the client then breaks only at runtime.
- WASM size matters (D-013): a new dependency of `chat-crypto` is checked with `bun run wasm` in `client/` and the size compared.
- The worker API never returns key material, and nothing on the main thread holds a key (D-064).
- Every claim a change makes about protection matches `docs/threat-model.md` exactly; "end-to-end encrypted" is not used (D-003).
