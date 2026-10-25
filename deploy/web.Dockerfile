# The web image: the built client served by Caddy, which also proxies the
# server and terminates TLS. Build from the repository root:
# docker build -f deploy/web.Dockerfile .
FROM rust:1.99-bookworm AS build
COPY --from=oven/bun:1.4.4 /usr/local/bin/bun /usr/local/bin/bun
RUN rustup target add wasm32-unknown-unknown \
    && cargo install --locked wasm-bindgen-cli --version 0.2.129
WORKDIR /src
COPY . .
WORKDIR /src/client
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    bun install --frozen-lockfile && bun run build

FROM caddy:2.10-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /src/client/dist /srv
