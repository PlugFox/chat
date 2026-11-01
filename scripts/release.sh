#!/usr/bin/env bash
# Build the images on this machine and ship them to the production host
# (docs/deployment.md, "Production").
#
#   scripts/release.sh build    # build linux/arm64, push vX.Y.Z and latest to Docker Hub
#   scripts/release.sh deploy   # copy the images to the host, recreate the stack, verify
#
# build:  needs `docker login`. Refuses a dirty tree, which would make the commit
#         in the binary a lie, and a published version (FORCE=1 overwrites).
# deploy: needs CHAT_DEPLOY_HOST (ssh target with passwordless sudo) and
#         CHAT_STACK_DIR (compose directory on the host). DEPLOY_VERSION=X.Y.Z
#         rolls back. The host has no Docker Hub credentials, so images go over
#         ssh (docker save | docker load).

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
REGISTRY=plugfox
PLATFORM=linux/arm64
PUBLIC_URL=${CHAT_PUBLIC_URL:-https://chat.plugfox.dev}
COMPONENTS="server web"

die() {
    echo "error: $*" >&2
    exit 1
}

manifest_version() {
    sed -n 's/^version = "\(.*\)"/\1/p' "$ROOT/Cargo.toml" | head -1
}

build() {
    [[ -z $(git -C "$ROOT" status --porcelain) ]] || die "working tree is dirty; commit or stash first"
    local version commit
    version=$(manifest_version)
    commit=$(git -C "$ROOT" rev-parse --short=12 HEAD)

    if [[ ${FORCE:-0} != 1 ]]; then
        for c in $COMPONENTS; do
            if docker manifest inspect "$REGISTRY/chat-$c:v$version" >/dev/null 2>&1; then
                die "$REGISTRY/chat-$c:v$version is already published; bump the version or set FORCE=1"
            fi
        done
    fi

    for c in $COMPONENTS; do
        echo "==> $REGISTRY/chat-$c:v$version ($commit, $PLATFORM)"
        docker buildx build --platform "$PLATFORM" --push \
            --build-arg "GIT_COMMIT=$commit" \
            -f "$ROOT/deploy/$c.Dockerfile" \
            -t "$REGISTRY/chat-$c:v$version" -t "$REGISTRY/chat-$c:latest" \
            "$ROOT"
    done
}

deploy() {
    local host=${CHAT_DEPLOY_HOST:?set CHAT_DEPLOY_HOST (ssh target)}
    local stack=${CHAT_STACK_DIR:?set CHAT_STACK_DIR (compose directory on the host)}
    local version=${DEPLOY_VERSION:-$(manifest_version)}

    for c in $COMPONENTS; do
        local image="$REGISTRY/chat-$c:v$version"
        echo "==> shipping $image to $host"
        docker pull -q --platform "$PLATFORM" "$image" >/dev/null
        docker save "$image" | gzip -1 | ssh -o BatchMode=yes "$host" \
            "gunzip | sudo docker load -q && sudo docker tag $(printf %q "$image") $(printf %q "${image%:*}:latest")"
    done

    echo "==> recreating the stack"
    # The clone is root-only (0700), so even `cd` needs sudo.
    local remote
    remote="cd $(printf %q "$stack") && docker compose -p chat --env-file .env up -d"
    ssh -o BatchMode=yes "$host" "sudo sh -c $(printf %q "$remote")"

    echo "==> verifying $PUBLIC_URL (up to 2 minutes; the server runs migrations on start)"
    for _ in $(seq 1 24); do
        if curl -fsS --max-time 5 "$PUBLIC_URL/ready" >/dev/null 2>&1 \
            && curl -fsSI --max-time 5 "$PUBLIC_URL/" 2>/dev/null | grep -qi '^content-security-policy:'; then
            ssh -o BatchMode=yes "$host" "sudo docker exec chat-chat-server-1 /chat-server --version"
            echo "live"
            return
        fi
        sleep 5
    done
    die "$PUBLIC_URL is not ready after 2 minutes; check the container logs"
}

case "${1:-}" in
    build)
        [[ -z ${DEPLOY_VERSION:-} ]] || die "DEPLOY_VERSION applies to deploy only"
        build
        ;;
    deploy)
        if [[ -n ${DEPLOY_VERSION:-} && ! $DEPLOY_VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
            die "DEPLOY_VERSION must look like 1.2.3"
        fi
        deploy
        ;;
    *) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 1 ;;
esac
