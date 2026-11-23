---
name: crypto-review
description: Review a change that touches cryptography in Vault Chat — crates/crypto, a stored or transmitted binary format, key handling in the client worker, or anything that changes what the server or the LLM can see. Use before committing such a change and when asked for a crypto or security review.
---

# Crypto review

Read `docs/threat-model.md` and `docs/crypto.md` first. The spec leads: if the
code needs something the spec does not say, change the spec in the same PR
and say so in the PR body.

## Checklist

**Spec**
- Every format has a version byte and is described in `docs/crypto.md`
  byte by byte. A changed layout bumps the version; old versions still open
  or are explicitly retired.
- Every KDF output has its own `vc/v1/…` label; no label is reused for two purposes.
- AAD binds owner, scope, key version, kind and position as in the kind table.
  New kinds get a row.
- A kind that only the client writes is never accepted in `mode = 0`.

**Primitives**
- No primitive is implemented here; only crates listed in the suite table.
- Nonces: XChaCha20 nonces are random 24 bytes; STREAM nonces follow the
  header layout; no nonce is derived from a counter shared across keys.
- Randomness only from `getrandom` (tests: injected seeded RNG).

**Secrets**
- Key types derive `Zeroize`/`ZeroizeOnDrop`, have no `Debug` with content,
  no `Clone` unless needed, and are compared with `subtle`.
- Errors do not say *which* check failed in a way that becomes an oracle
  (one `OpenError` for bad tag, bad AAD, bad padding).
- Nothing in `tracing` fields, panics or error strings contains plaintext or keys.
- The worker API gains no call that returns key material.

**Tests**
- Vectors for the new or changed format, committed and run natively and in WASM.
- Property tests: round trip; any flipped bit in record, AAD fields, scope or
  key version fails; wrong padding fails; `mode = 0` for client-only kinds fails.
- A fuzz target for every new decoder.

**Threat model**
- Does the change alter what the server, the LLM or a database thief can see?
  Then `docs/threat-model.md` changes too, and so does the README if a claim moves.

Report findings with file and line; mark each as blocking or not.
