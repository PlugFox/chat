# Configuration

The server reads environment variables only. It starts with PostgreSQL alone;
every optional feature is off until its variables are set, and the startup log
line lists the features that are on (`features=postgres`).

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `CHAT_DATABASE_URL` | — (required) | PostgreSQL URL. Never logged. |
| `CHAT_DATABASE_MAX_CONNECTIONS` | `10` | Pool size. |
| `CHAT_LISTEN` | `0.0.0.0:8080` | Address and port of the HTTP/WebSocket listener. |
| `CHAT_ALLOWED_ORIGINS` | `http://localhost:3000` | Comma-separated origins allowed to open WebSockets: the client's origin, e.g. `https://chat.example`. |
| `CHAT_PROVIDER_ALLOWED_NETWORKS` | — (none) | Comma-separated IPs or CIDRs that users' LLM base URLs may reach besides public addresses, e.g. `127.0.0.1, 192.168.1.0/24` for Ollama on the host or the LAN. `http://` base URLs work only for these. |
| `CHAT_LOG_FORMAT` | `pretty` | `pretty` for terminals, `json` for log collectors. |
| `RUST_LOG` | `info` | Log filter, e.g. `info,chat_server=debug`. |

Planned, with their features: Google OIDC, SMTP (email OTP), Redis (revoked
sessions), S3 (files), and the trusted proxy
([protocol.md](protocol.md#provider-endpoints)).

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
