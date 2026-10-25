# Configuration

The server reads environment variables only. It starts with PostgreSQL alone;
every optional feature is off until its variables are set, and the startup log
line lists the features that are on (`features=postgres`).

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `CHAT_DATABASE_URL` | — (required) | PostgreSQL URL. Never logged. |
| `CHAT_DATABASE_MAX_CONNECTIONS` | `10` | Pool size. |
| `CHAT_LISTEN` | `0.0.0.0:8080` | Address and port of the HTTP/WebSocket listener. |
| `CHAT_ALLOWED_ORIGINS` | `CHAT_PUBLIC_URL` | Comma-separated origins allowed to open WebSockets and call `/auth`: the client's origin, e.g. `https://chat.example`. |
| `CHAT_PROVIDER_ALLOWED_NETWORKS` | — (none) | Comma-separated IPs or CIDRs that users' LLM base URLs may reach besides public addresses, e.g. `127.0.0.1, 192.168.1.0/24` for Ollama on the host or the LAN. `http://` base URLs work only for these. |
| `CHAT_LOG_FORMAT` | `pretty` | `pretty` for terminals, `json` for log collectors. |
| `CHAT_PUBLIC_URL` | `http://localhost:3000` | Where users open the client. Builds the Google redirect URI; `https://` turns on `Secure` cookies with the `__Host-` prefix. |
| `CHAT_SERVER_SECRET` | random per start | 32 random bytes, base64 (`openssl rand -base64 32`). Root of the JWT signing key and the email-code key. Unset works for one instance; replicas need the same value. Replacing it rotates the keys ([auth.md](auth.md#server-secret-and-key-rotation)). Never logged. |
| `CHAT_SESSION_IDLE_DAYS` | `30` | A session not refreshed for this long expires. |
| `CHAT_SIGNUP_ALLOW` | — (open) | Comma-separated globs of addresses that may create an account, e.g. `*@example.com, me@example.org`. Empty or `*` is open sign-up. |
| `CHAT_GOOGLE_CLIENT_ID`, `CHAT_GOOGLE_CLIENT_SECRET` | — | Turn on Google sign-in. Redirect URI to register: `<CHAT_PUBLIC_URL>/auth/google/callback`. |
| `CHAT_SMTP_URL` | — | Turns on email sign-in, e.g. `smtps://user:password@smtp.example:465` or `smtp://127.0.0.1:1025` (Mailpit). Never logged. |
| `CHAT_SMTP_FROM` | — (required with SMTP) | Sender, e.g. `Vault Chat <chat@example.org>`. |
| `CHAT_REDIS_URL` | — | Redis or Valkey for revoked sessions and rate limits; needed for more than one replica. Configure `noeviction`. Never logged. |
| `CHAT_TRUSTED_PROXIES` | — (none) | Comma-separated CIDRs of reverse proxies whose `X-Forwarded-For` is believed, read from the right ([auth.md](auth.md#client-ip-behind-proxies)). |
| `CHAT_GEOIP_DB` | — | Path to an IP-to-country database in MaxMind format (DB-IP Lite Country recommended). Without it countries are empty. |
| `CHAT_AUDIT_RETENTION_DAYS` | `365` | Audit events older than this are deleted daily. |
| `RUST_LOG` | `info` | Log filter, e.g. `info,chat_server=debug`. |

Planned, with its feature: S3 (files).

Migrations run at startup (`server/migrations`, sqlx); a failed migration stops
the server before it listens.

Production: [deployment.md](deployment.md).

## Local development

`mise.toml` sets `CHAT_DATABASE_URL` and `DATABASE_URL` (what sqlx and
`#[sqlx::test]` read) to the dev database of `deploy/dev.compose.yaml`
(`127.0.0.1:5433`, user and password `chat`).

```bash
mise run db:up        # PostgreSQL in Docker, waits until healthy
mise run dev:server   # server on http://localhost:8080
mise run db:down      # stop; the data volume stays
```
