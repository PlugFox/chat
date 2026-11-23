---
paths:
  - "server/src/auth/**"
  - "server/src/ws/**"
  - "server/migrations/**"
  - "client/src/auth/**"
  - "crates/protocol/src/auth.rs"
  - "docs/auth.md"
---

# Authentication: traps

Spec `docs/auth.md`; decisions D-030…D-049.

- One-time values (email codes, OIDC flows) are redeemed with a single `DELETE … RETURNING` or a conditional `UPDATE … RETURNING`. A read followed by a separate delete lets two parallel requests redeem the same value (pub D67).
- An attempt is spent before the comparison, atomically; otherwise parallel guesses share one attempt.
- The revocation store fails closed: a store error refuses the request (`503 auth.unavailable`, WS close 1011), never "not revoked".
- Never log, audit or put in an error an email address, a code, a token or a cookie. Audit `details` carry ids, provider kinds and reasons only.
- Every address gets the same answer from `/auth/email/start`, in body and in timing (mail goes out in the background).
- Auto-linking needs a verified address on both sides (D-032); a test asserts the unverified case is refused.
- The refresh cookie is `SameSite=Strict`; anything that must work after a cross-site redirect (the Google callback) cannot rely on it.
- Client IP only through `auth::client::client_ip` with `CHAT_TRUSTED_PROXIES` (D-048); never read `X-Forwarded-For` directly.
- `sqlx` 0.9 takes `&'static str` queries: SQL is literal with bind parameters, never `format!`.
- Tests that cover a race or a security property are checked by reverting the fix and watching them fail.
