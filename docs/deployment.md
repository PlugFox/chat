# Deployment

Self-hosting first: one VPS with Docker Compose (`deploy/compose.yaml`).

| Service | Image | Role |
| ------- | ----- | ---- |
| `postgres` | `postgres:18-alpine` | The only required dependency. Holds ciphertext and metadata only. |
| `server` | `deploy/server.Dockerfile` (distroless, non-root, ~65 MB) | API and WebSocket on `:8080`, internal network only. Health: `chat-server healthcheck` (`/ready`). |
| `web` | `deploy/web.Dockerfile` (Caddy + the built client) | TLS (automatic HTTPS for `CHAT_DOMAIN`), static client, proxy of `/ws`, `/health`, `/ready`, `/auth/*` to the server, security headers. |

## Run

```bash
cp deploy/.env.example deploy/.env   # set CHAT_DOMAIN and POSTGRES_PASSWORD
docker compose -f deploy/compose.yaml --env-file deploy/.env up -d --build
```

DNS for `CHAT_DOMAIN` must point at the VPS and ports 80/443 must be open
for the certificate. Server variables: [configuration.md](configuration.md);
`CHAT_ALLOWED_ORIGINS` is set to `https://$CHAT_DOMAIN` by the compose file.
For Ollama on the same host or LAN, set `CHAT_PROVIDER_ALLOWED_NETWORKS`
(e.g. `172.17.0.1` for the Docker host, or the LAN range).

## Headers

Caddy sends the Content-Security-Policy of `client/vite.config.ts` (also
present as a `<meta>` in the built page) plus `frame-ancestors 'none'`, HSTS,
`nosniff`, `Referrer-Policy: no-referrer`, COOP and a Permissions-Policy
(camera for QR scanning only). Hashed assets are cached for a year;
`index.html` is revalidated on every load. Keep the CSP strings in sync when
either changes.

## Backups

`docker compose exec postgres pg_dump -U chat chat > backup.sql`. A dump
holds ciphertext and metadata only ([threat-model.md](threat-model.md)): it
cannot be read without users' keys, but it still reveals metadata, so store it
like any other private data. Users who lose all their keys cannot be helped
from a backup.

## Updates

`git pull`, then the same `up -d --build`. Migrations run at server start; a
failing migration keeps the old container running behind Caddy's health check.

## Not yet

Prebuilt images and published bundle hashes (for verifying the served
client, [threat-model.md](threat-model.md) N2), Redis, SMTP and object
storage services, and the per-IP limit on unauthenticated sockets, which
needs Caddy's client address forwarded and trusted.
