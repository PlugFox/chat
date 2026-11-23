# The server image: a static-ish release binary on distroless, as non-root.
# Build from the repository root: docker build -f deploy/server.Dockerfile .
FROM rust:1.99.0-bookworm AS build
WORKDIR /src
# The context has no .git: `--build-arg GIT_COMMIT=$(git rev-parse --short=12 HEAD)`.
ARG GIT_COMMIT=""
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p chat-server \
    && cp target/release/chat-server /chat-server \
    && mkdir /files

# cc: glibc and libgcc for the binary; ca-certificates for provider TLS.
FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /chat-server /chat-server
# Owned by nonroot, so the named volume mounted there starts writable.
COPY --from=build --chown=65532:65532 /files /var/lib/chat/files
ENV CHAT_LISTEN=0.0.0.0:8080 CHAT_LOG_FORMAT=json
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 CMD ["/chat-server", "healthcheck"]
ENTRYPOINT ["/chat-server"]
