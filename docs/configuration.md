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
| `CHAT_REDIS_URL` | — | Redis or Valkey for revoked sessions, rate limits and the event bus (chat events, reply text in memory only); needed for more than one replica. Configure `noeviction`. `redis://` is plain TCP, for the same host or a private network; `rediss://` uses TLS verified against the system trust store (add a private CA there), with no insecure mode. Never logged. |
| `CHAT_TRUSTED_PROXIES` | — (none) | Comma-separated CIDRs of reverse proxies whose `X-Forwarded-For` is believed, read from the right ([auth.md](auth.md#client-ip-behind-proxies)). |
| `CHAT_GEOIP_DB` | — | Path to an IP-to-country database in MaxMind format (DB-IP Lite Country recommended). Without it countries are empty. |
| `CHAT_AUDIT_RETENTION_DAYS` | `365` | Audit events older than this are deleted daily. |
| `CHAT_FILES_DIR` | — | Turns on files (D-101), stored in this directory, e.g. `/var/lib/chat/files`. Objects are encrypted; back the directory up with the database. |
| `CHAT_FILES_S3_BUCKET` | — | Turns on files stored in this S3 bucket instead (S3, MinIO, Backblaze B2 through its S3 API). Takes the four variables below. Uploads are multipart: give the bucket a lifecycle rule that aborts incomplete multipart uploads after a day. |
| `CHAT_FILES_S3_ENDPOINT` | AWS | The S3 endpoint, e.g. `https://s3.us-west-004.backblazeb2.com` for B2 or `http://minio:9000`. |
| `CHAT_FILES_S3_REGION` | `us-east-1` | The bucket's region, e.g. `us-west-004` for B2. |
| `CHAT_FILES_S3_ACCESS_KEY_ID`, `CHAT_FILES_S3_SECRET_ACCESS_KEY` | — (required with a bucket) | The bucket's credentials (a B2 application key and its id). The secret is never logged. |
| `CHAT_FILES_QUOTA_MB` | `1024` | Each account's files at most this many megabytes, counted as stored (encrypted) bytes; `0` for no quota. |
| `RUST_LOG` | `info` | Log filter, e.g. `info,chat_server=debug`. |

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
