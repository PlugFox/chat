# Authentication and sessions

> Status: **agreed** (2026-10-26). Replaces brief §7. It reuses the session
> designs of foxic and pub, with the defects found there fixed (listed in
> their roadmaps). A change to this page needs the same review as a change to
> [threat-model.md](threat-model.md).

Signing in proves who the user is to the server. It does **not** unlock any
data: content stays sealed under keys only the user's clients hold
([crypto.md](crypto.md)). Someone who takes over a linked Google account or
mailbox gets the account's [metadata](threat-model.md#metadata) and can delete
the account, but cannot read stored content without an unlock method.

## Model

| Concept | What it is |
| ------- | ---------- |
| **User** | An account. Owns identities, devices, sessions, audit events and all content. Has no email of its own. |
| **Identity** | One way to sign in: a Google account (`issuer`, `subject`) or an email address. A user has one or more, including several of the same kind (two Google accounts, three addresses). |
| **Device** | A browser profile or an app install, identified by a UUID the client generates and keeps (`device_id`). Push tokens and the "remember this device" key wrap attach to it later. Keyed by `(user_id, device_id)`, so two people sharing a browser profile get separate device rows. |
| **Session** | One sign-in. It holds the refresh token, the identity that was used, the device, and what the server observed: IP, country, user agent, timezone, created and last-seen times. The session id is the `sid` claim of every access token issued from it. |

## Tokens

### Access token

- A JWT signed with **Ed25519** (`alg: EdDSA`, crate `jsonwebtoken`), with a `kid` header.
- Claims, nothing more:

  | Claim | Meaning |
  | ----- | ------- |
  | `sub` | user id |
  | `sid` | session id |
  | `iid` | identity id used to sign in |
  | `prv` | provider kind of that identity: `google` or `email` |
  | `iat`, `exp` | issued at, expiry; TTL 1 hour |

- `exp` is required. Clock skew of 30 seconds is accepted on `exp` and `iat`.
- The client keeps it **in memory only** and sends it as `Authorization:
  Bearer` over HTTP and in the `auth` frame over WebSocket.

### Server secret and key rotation

`CHAT_SERVER_SECRET` (32 random bytes, base64) is the root of every server-side
key. HKDF-SHA-256 derives from it:

- the JWT signing key (`chat/server/v1/jwt-ed25519`);
- the email-code HMAC key (`chat/server/v1/email-code`).

The `kid` is the first 8 bytes of SHA-256 of the public key, in hex.

**Rotation is replacing the secret.** Access tokens signed with the old key
stop verifying, and clients refresh them silently: refresh tokens are stored as
hashes in the database and do not depend on the secret. Email codes that are
pending at that moment stop working.

**Unset secret.** The server generates a random one at startup and logs a
warning. That works for a single instance: a restart costs one silent refresh
per client. Several replicas need the same secret.

### Refresh token

- **Format:** `base64url(session_id ‖ generation u32 BE ‖ 32 random bytes)`.
  The server stores SHA-256 of the whole token, never the token itself.
- **Transport:** an HttpOnly cookie. The client never sees the token, so XSS
  cannot copy it off the device.

  | Attribute | Value |
  | --------- | ----- |
  | Name | `__Host-chat_refresh`; `chat_refresh` when `CHAT_PUBLIC_URL` is `http://` (local development only, where browsers refuse `Secure`) |
  | Flags | `HttpOnly; Secure; SameSite=Strict; Path=/` |
  | Max-Age | the idle timeout, renewed on every rotation |

  Delivering the token in the response body (for an API on another site, or a
  native app) is a later operator option; see [Not in v1](#not-in-v1).
- **Rotation on every refresh.** The server swaps in a new token and
  increments `generation`. The previous hash is kept, with the time of the
  swap, for the reuse checks below.
- **Concurrent refreshes.** A token that was current until less than 10
  seconds ago still gets a new access token, but no rotation and no cookie.
  Two tabs that refresh together both succeed: the browser already holds the
  winner's cookie. The client also serializes refreshes with a Web Lock
  ([Client](#client)), so this window is a fallback rather than the main
  mechanism.
- **Reuse detection.** The server revokes the session (reason
  `refresh_reused`) when a presented token names an existing session, matches
  neither its current hash nor the previous hash within the window, and
  carries an older `generation`.
  - This works at any depth, so a stolen token that was rotated several times
    since is still caught.
  - A token whose generation is not older and whose hash does not match is
    treated as junk: `401` without revocation.
  - **Known limit.** Anyone who knows a session id can craft a token with an
    older generation and get that session revoked. Session ids are visible
    only to the user and to whoever holds one of their access tokens, so this
    is accepted.
- **Expiry.** A session that has not been refreshed for
  `CHAT_SESSION_IDLE_DAYS` (default 30) expires. There is no absolute
  lifetime; a per-user setting may add one later.

### Refresh, CSRF and origins

- **Origin check.** Endpoints that read the cookie (`/auth/refresh`,
  `/auth/sign-out`) require an `Origin` header that exactly matches
  `CHAT_ALLOWED_ORIGINS`; a missing `Origin` is refused. `SameSite=Strict`
  alone does not stop a sibling subdomain, which counts as the same site.
- **Bearer endpoints** cannot be forged cross-site, but they get the same
  Origin check so every route behaves the same.

## Revocation

1. **Revoking a session** sets `sessions.revoked_at` and `revoked_reason`, and
   puts the session id into the revocation store with a TTL of the access-token
   TTL plus one minute.
2. **Every authenticated request** checks the store in the same middleware that
   verifies the JWT signature and claims. The WebSocket does the same at
   `auth` and `auth.renew`.
3. **Open sockets** of the session close with `4003` when the revocation is
   published.
4. **The store:**

   | Store | When | How |
   | ----- | ---- | --- |
   | Redis (or Valkey) | `CHAT_REDIS_URL` set | Keys with the TTL; a pub/sub channel reaches the sockets on every replica. |
   | In-memory hash set | otherwise | Same TTL. Supports a single instance only. |

5. **At startup** the server loads into the store the sessions revoked within
   the last TTL, so a restart does not revive revoked access tokens.
6. **The store failing closes the door.** If Redis is unreachable, HTTP answers
   `503 auth.unavailable` (retry), and a WebSocket `auth` closes with `1011`.
   A failed lookup is never treated as "not revoked".
7. **Redis must not evict these keys.** Use `noeviction` or a dedicated
   database. An evicted key makes a revoked access token usable until it
   expires (at most one hour). Refresh still fails, because it checks the
   database.
8. **Durability.** Refresh always checks `sessions.revoked_at` in the
   database, so the store only has to hold revocations for one access-token
   lifetime.

Reasons recorded:
- `sign_out`;
- `revoked_by_user`;
- `device_replaced`;
- `identity_unlinked`;
- `refresh_reused`;
- `idle` (set lazily, when the server finds the session expired).

Ending a session (any reason above), or the session reporting another
device, deletes the ARK wrap of its device
("remember this device", [crypto.md](crypto.md#remember-this-device)). A stolen
device then cannot unlock even if it signs in again.

## Sign-in

### Email code

Email sign-in is on when `CHAT_SMTP_URL` is set.

1. `POST /auth/email/start { email, locale }` → `202 { pending_id }`.
   - The address is normalized: trimmed, lower-cased, at most 254 characters,
     one `@`.
   - **Every address gets the same answer.** For an address that may not sign
     up, a pending record is still created but no mail is sent. The mail is
     sent from a background task, so timing does not differ either.
2. **The code:**
   - 8 digits from the OS RNG, without modulo bias;
   - stored as `HMAC-SHA-256(email-code key, pending_id ‖ email ‖ code)`;
   - valid for 10 minutes; at most 5 attempts.
3. **Limits:**
   - one pending code per address: starting again replaces the old code;
   - 60 seconds between sends, at most 5 sends per address per hour, enforced
     by one conditional upsert;
   - per IP: 10 starts and 30 verifications per 15 minutes.
4. `POST /auth/email/verify { pending_id, email, code }`.
   - **Atomic attempt.** The attempt is spent in the same statement that
     reads the stored code, before the comparison, so parallel guesses each
     cost one.
   - The comparison runs in constant time.
   - **Single use.** A match redeems the code in one statement; a concurrent
     second redemption finds nothing and fails. One code yields at most one
     session.
   - The pending id binds the code to the browser that started the flow, so a
     phished code alone is not enough.
5. **The mail** contains the code only, no link: mail scanners open links, and
   people read mail on another device.
   - Subject and body come from the `locale` the client sent (`en`, `ru`).
   - The code is never logged. A failed send is logged without the address.

### Google

Google sign-in is on when `CHAT_GOOGLE_CLIENT_ID` and
`CHAT_GOOGLE_CLIENT_SECRET` are set.

1. **Start.** `GET /auth/google/start` creates a flow record and redirects to
   Google (authorization code flow).
   - The record holds `state`, `nonce` and a PKCE S256 verifier, each 256-bit,
     and expires after 10 minutes.
   - The flow id goes into a `__Host-chat_oidc` cookie (`HttpOnly; Secure;
     SameSite=Lax; Max-Age=600`), which binds the callback to the browser that
     started it.
   - Scopes are `openid email profile`, with no offline access.
2. **Callback.** `GET /auth/google/callback?code&state`:
   - The server redeems the flow in one statement, matching both the cookie's
     flow id and `state`, then exchanges the code.
   - **The `id_token` is verified.** Algorithm RS256, key from Google's JWKS by
     `kid`; `iss` `https://accounts.google.com` or `accounts.google.com`;
     `aud` the client id; `exp` and `iat` with 30 seconds of skew; `nonce`
     equal to the flow's.
   - The JWKS is cached for an hour and refetched once on an unknown `kid`.
   - `userinfo` is not used.
3. **Result.** The callback sets the refresh cookie and redirects to the app
   (`/`), which then calls `/auth/refresh`. On failure it redirects to
   `/sign-in?error=<code>`.
   - No token ever appears in a URL.

### Who may sign up

`CHAT_SIGNUP_ALLOW` is a comma-separated list of glob patterns matched against
the whole normalized address:
- `*` matches any run of characters, `?` one character;
- example: `*@example.com, me@example.org`;
- unset, empty or `*` means open sign-up.

Globs rather than regular expressions: an unanchored regular expression such
as `.*@example.com` would admit `x@example.com.attacker.net`.

The list applies only to creating a user. Existing users always sign in, and
linking adds identities regardless of the list. For Google the address checked
is the verified email of the identity; an unverified one cannot sign up while
a list is set.

### Account linking

A new identity is placed by this procedure, in one transaction that holds an
advisory lock on the normalized address. The lock stops two concurrent first
sign-ins with the same address from creating two users.

1. **Known identity** (`kind`, `issuer`, `subject` already exist): sign in as
   its user.
2. **Verified address shared with another identity** (an email identity, or
   Google with `email_verified = true`, whose address matches a verified
   identity of an existing user): link it to that user automatically. Audited
   as `identity.linked` with `auto: true`.
3. **Unverified Google address that belongs to an existing user:** refuse
   (`auth.email_unverified`). Auto-linking it would hand the account to anyone
   who can create a Google account with that address.
4. **Otherwise:** create a user, if sign-up allows the address.

**Manual linking** while signed in:
- **Google:** the client navigates to `GET /auth/google/start?link=true`. The
  server reads the refresh cookie, and the flow record carries that session's
  user. The cookie is `SameSite=Strict`, so it is not sent when another site
  starts the navigation. Nobody can make a victim's browser link the
  attacker's Google account into the victim's account. The callback redirects
  to `/settings?linked=google`, or `…=exists` or `…=in_use`.
- **Email:** `POST /auth/link/email/start` and `…/verify` work like sign-in. A
  link code is bound to the user and cannot sign anyone in.
- **An identity that already belongs to another user is refused**
  (`identity.in_use`). Accounts cannot be merged: each user's data is sealed
  under its own ARK, and the server cannot re-encrypt it. The user deletes the
  other account first.

**Unlinking:**
- `DELETE /auth/identities/{id}` refuses the last identity (`identity.last`).
- It revokes the sessions that signed in through that identity (reason
  `identity_unlinked`).

## Sessions and devices

**Creating a session.** A successful sign-in creates the session row and
records what the server observes: IP, country and user agent.

**Session details.** Right after sign-in, and on every app start, the client
calls `PUT /auth/session` with:

```
device_id         UUID the client generated (crypto.randomUUID, kept in localStorage)
timezone          IANA name from Intl; stored only if PostgreSQL knows it, else null
locale            the UI language
client_version    build version
```

- The user agent comes from the request header.
- IP, country and last-seen time are updated by the server itself on every
  refresh and every WebSocket `auth` (last-seen at most every 5 minutes); the
  client never sends them.
- **One live session per device.** Setting `device_id` revokes the user's
  other sessions with the same device (reason `device_replaced`). Other users'
  sessions on that device are untouched.
- In v1 one browser profile holds one signed-in account at a time: the cookie
  and the key store are per profile. Signing in as someone else signs the
  current account out first. Switching accounts without signing out is later
  work.

| Route | Purpose |
| ----- | ------- |
| `GET /auth/sessions` | Live sessions of the user: id, `current`, provider, device id, user agent, IP, country, timezone, client version, created and last-seen times. |
| `DELETE /auth/sessions/{id}` | Revoke one of the user's sessions. |
| `POST /auth/sign-out` | Revoke the current session and clear the cookie. |

### Client IP behind proxies

`CHAT_TRUSTED_PROXIES` is a list of CIDRs, empty by default.

- **Untrusted peer:** if the TCP peer is not in the list, forwarding headers
  are ignored and the peer address is the client.
- **Trusted peer:** the server walks `X-Forwarded-For` **from the right**,
  skipping trusted addresses. The first untrusted address is the client. An
  entry that does not parse as an IP stops the walk, and the last trusted hop
  is used instead.
- **The leftmost entry is never trusted:** the client writes it.
- **Traefik** appends to `X-Forwarded-For` only from peers listed in its
  entrypoint's `forwardedHeaders.trustedIPs`, and overwrites it otherwise.
  Either way the rightmost entry is the address Traefik saw.
- **Caddy** behaves the same with its `trusted_proxies`.
- **The bundled compose deployment** trusts the private ranges, because the
  server is reachable only from Caddy on the compose network.

The same client IP keys the per-IP limits: auth endpoints, and unauthenticated
WebSockets (10 per IP).

### Country

- The country comes from an IP-to-country database in MaxMind format at
  `CHAT_GEOIP_DB` (crate `maxminddb`).
- The recommended database is **DB-IP Lite Country** (CC BY 4.0,
  redistributable, updated monthly). The image does not bundle one, so the
  operator downloads it ([deployment.md](deployment.md)).
- Without the file the country is null. Private and loopback addresses give
  null as well.

## Audit log

Append-only, written in the same transaction as the action it records
(`server/migrations/`, `server/src/auth/audit.rs`). An event names the user,
or nobody when it cannot be attributed (a failed code for an address with no
account), and records the IP, country and user agent observed.

- **No content, no codes, no tokens, no email addresses.** Identities are
  referred to by id.
- **Kinds:**
  - `account.created`;
  - `auth.signed_in` (provider, identity, new user or not);
  - `auth.sign_in_failed` (provider, reason);
  - `auth.code_sent`;
  - `session.revoked` (session, reason);
  - `identity.linked` (identity, provider, auto);
  - `identity.unlinked`.
- Key setup, unlock methods and device linking add theirs
  ([protocol.md](protocol.md#keys)).
- Refreshes are not logged: one per hour per session is noise, and
  `last_seen_at` already shows activity.
- The user reads their own log: `GET /auth/audit?before=<id>&limit≤100`.
- Retention is `CHAT_AUDIT_RETENTION_DAYS` (default 365). A daily task deletes
  older rows in batches. The same task removes expired codes, flows and
  sessions revoked more than 30 days ago.

## Account deletion

`DELETE /auth/account` with a bearer token.

1. **Recent sign-in.** The session must have been created less than 10 minutes
   ago, otherwise `403 auth.reauth_required`. The client asks the user to
   sign in again and to type an address of the account.
2. **Revoke first.** Every session of the user goes into the revocation store
   and their sockets close (`4003`). If the store fails, nothing is deleted.
3. **Delete everything.** One transaction removes the user row, and `ON DELETE
   CASCADE` removes everything else: identities, devices, sessions, audit
   events, keys, wraps and all content.
   - This is a hard delete. Nothing is kept, including audit rows.
   - Files in object storage (after v1) are deleted by a background task.
4. **Response.** The cookie is cleared. Signing in later with the same identity
   creates a new, empty user.

## Agent access to session data

- **The `session` grant** exposes:
  - the timezone, country and locale of the current session;
  - the user's local time.
- **Never exposed:** IP addresses, the session list, user agents, identities
  and email addresses.
- The grant goes through the same permission dialog as other grants
  ([protocol.md](protocol.md#permissions-and-the-access-log)).
- **What the grant does not protect.** These values are stored in plaintext,
  so the grant is a consent the server enforces, like G5. It is not a
  cryptographic boundary like G3.

## Client

- **On start**, the client calls `POST /auth/refresh`. The cookie decides
  whether the user is signed in; no token lives in storage.
- **One refresh at a time.** Refreshes run under
  `navigator.locks.request("chat.auth.refresh")`. A tab that acquires the lock
  first checks whether another tab has just refreshed, and if so takes the new
  token instead of calling the server.
- **Shared state.** New access tokens, sign-out and revocation are broadcast on
  `BroadcastChannel("chat.auth")`, so every tab follows.
- Each tab keeps its own WebSocket. A leader tab holding the only socket can
  come later on the same primitives.
- **No SharedWorker:** Chrome on Android does not support it.
- **Scheduling.** The token is refreshed 60 seconds before `exp`. On a `401`
  the client refreshes once and retries. A refused refresh means the user is
  signed out; a network error does not.
- **The socket** gets new tokens through `auth.renew`. On `4003` the client
  signs out everywhere.
- **Code layout.** Token handling sits behind a small interface
  (`client/src/auth/`). A body-transport mode can then swap the cookie for
  storage without touching callers.

## HTTP routes

All bodies are JSON. Errors use the WebSocket error payload
`{ code, message, retry }`. Types live in `crates/protocol` and are generated
into TypeScript.

| Route | Auth | Purpose |
| ----- | ---- | ------- |
| `GET /auth/providers` | — | Which sign-in methods are on |
| `POST /auth/email/start` | — | Send a code |
| `POST /auth/email/verify` | — | Sign in with the code; sets the cookie; returns the access token |
| `GET /auth/google/start` | — | Redirect to Google |
| `GET /auth/google/callback` | — | Finish Google sign-in; sets the cookie; redirects |
| `POST /auth/refresh` | cookie | Rotate; returns `{ access_token, expires_at, user_id, session_id }` |
| `POST /auth/sign-out` | cookie + bearer | Revoke this session |
| `PUT /auth/session` | bearer | Device id, timezone, locale, client version |
| `GET /auth/sessions`, `DELETE /auth/sessions/{id}` | bearer | List and revoke sessions |
| `GET /auth/identities`, `DELETE /auth/identities/{id}` | bearer | List and unlink identities |
| `GET /auth/google/start?link=true` | cookie | Link a Google account to the signed-in user |
| `POST /auth/link/email/start`, `POST /auth/link/email/verify` | bearer | Link another address |
| `GET /auth/audit` | bearer | The user's audit log, newest first |
| `DELETE /auth/account` | bearer, recent sign-in | Delete the account and everything in it |

## Not in v1

- **Refresh token in the response body**, for an API on another site, a domain
  on the Public Suffix List, or a native app. It would be an operator setting,
  never a client choice: otherwise XSS asks for body mode and takes the token.
  The cookie handling is in one place on the server and behind one interface
  on the client, so adding it is local.
- **API on its own origin** (`api.chat.example` next to `chat.example`). That
  is the same site, so the cookie works, but it needs credentialed CORS, a
  runtime client config (`/config.json`) and CSP `connect-src` built from the
  deployment.
- **Other:** TOTP, passkeys as a sign-in method, switching between several
  signed-in accounts, a per-user absolute session lifetime.
