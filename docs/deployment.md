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
GIT_COMMIT=$(git rev-parse --short=12 HEAD) \
  docker compose -f deploy/compose.yaml --env-file deploy/.env up -d --build
```

`GIT_COMMIT` is optional: it is what `chat-server --version` and the startup
log line report (the build context has no `.git`).

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

Files (D-101) live in the `files` volume, encrypted: back it up with the
dump, as the database names the objects and holds their keys. To keep them
in S3 or Backblaze B2 instead, set `CHAT_FILES_DIR=` (empty) and the
`CHAT_FILES_S3_*` variables in `deploy/.env` ([configuration.md](configuration.md)).

## Updates

`git pull`, then the same `up -d --build`. Migrations run at server start; a
failing migration keeps the old container running behind Caddy's health check.

## Production

`chat.plugfox.dev` does not use the compose file above. It is the stack
`stacks/apps/chat` of the private repository `plugfox/stacks`, whose docs cover
the host, Traefik, Komodo, secrets and backups. It uses the host's shared
PostgreSQL (database and role `chat`) and Traefik for TLS. Traefik sends
`/ws`, `/health`, `/ready`, `/auth/*` and `/files/*` straight to the server,
because a second proxy in between would replace `X-Forwarded-For`, and
everything else to the web image, with `CHAT_DOMAIN=:80` for plain HTTP.

Images are built on an arm64 Mac, not in CI (D-103): native `linux/arm64`, and
public on Docker Hub (D-104), like the source they are built from.

```bash
mise run check                # nothing else runs the checks before a release
scripts/release.sh build      # version from Cargo.toml; refuses a dirty tree
export CHAT_DEPLOY_HOST=<user>@<host>
export CHAT_STACK_DIR=/etc/komodo/repos/plugfox/stacks/stacks/apps/chat
scripts/release.sh deploy
```

Dump the database first when a release has migrations: they only go forward,
and a rollback (`DEPLOY_VERSION=X.Y.Z scripts/release.sh deploy`) cannot undo
them. Changes to the stack itself are commits to `plugfox/stacks`, followed by
Deploy in Komodo.

## Not yet

Published bundle hashes (for verifying the served client,
[threat-model.md](threat-model.md) N2), and Redis and MinIO services. One server instance needs no Redis; several replicas need
`CHAT_REDIS_URL` (Redis or Valkey with `noeviction`) and the same
`CHAT_SERVER_SECRET`.
