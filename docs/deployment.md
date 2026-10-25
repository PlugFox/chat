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
`CHAT_PUBLIC_URL` is set to `https://$CHAT_DOMAIN` by the compose file, and the
allowed origins follow it.
For Ollama on the same host or LAN, set `CHAT_PROVIDER_ALLOWED_NETWORKS`
(e.g. `172.17.0.1` for the Docker host, or the LAN range).

## Sign-in

Set at least one method in `deploy/.env` ([auth.md](auth.md)):

- **Email codes:** `CHAT_SMTP_URL` (e.g. `smtps://user:password@smtp.example:465`)
  and `CHAT_SMTP_FROM`.
- **Google:** `CHAT_GOOGLE_CLIENT_ID` and `CHAT_GOOGLE_CLIENT_SECRET` of an OAuth
  client of type "Web application" with the redirect URI
  `https://<CHAT_DOMAIN>/auth/google/callback`.
- **Who may sign up:** `CHAT_SIGNUP_ALLOW`, e.g. `me@example.org` for a personal
  instance. Unset means anyone who can sign in may create an account.
- **`CHAT_SERVER_SECRET`** (`openssl rand -base64 32`): without it the server
  picks a random key at every start, which signs every client in again
  silently after a restart. Replacing it later does the same, which is how
  the keys are rotated.

### Behind another proxy

The bundled Caddy is the only proxy the compose file trusts. When Traefik,
nginx or a CDN sits in front of it, add their addresses to
`CHAT_TRUSTED_PROXIES` and configure them to append to `X-Forwarded-For`
(Traefik: `entryPoints.<name>.forwardedHeaders.trustedIPs`), or the server
records the proxy's address as every client's IP and the per-IP limits apply
to everyone at once ([auth.md](auth.md#client-ip-behind-proxies)).

### Country

Sessions show a country when an IP-to-country database is present. DB-IP
Lite Country (CC BY 4.0, monthly) is in the format the server reads:

```bash
mkdir -p deploy/geoip
curl -L "https://download.db-ip.com/free/dbip-country-lite-$(date +%Y-%m).mmdb.gz" | gunzip > deploy/geoip/country.mmdb
echo 'CHAT_GEOIP_DB=/geoip/country.mmdb' >> deploy/.env
```

The file is read at start; refresh it monthly and restart the server. DB-IP's
licence asks for attribution where the data is shown.

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
client, [threat-model.md](threat-model.md) N2), and Redis and object storage
services. One server instance needs no Redis; several replicas need
`CHAT_REDIS_URL` (Redis or Valkey with `noeviction`) and the same
`CHAT_SERVER_SECRET`.
