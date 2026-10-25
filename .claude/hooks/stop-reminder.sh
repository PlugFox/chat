#!/usr/bin/env bash
# Stop hook: when this turn edited project files, reminds which checks to run
# before reporting the task as done (AGENTS.md, "Before you say done").
# Reads the Stop event JSON on stdin and scans the transcript of the current
# turn for Edit/Write targets.

set -euo pipefail

# Only a reminder: without jq stay silent instead of failing the hook.
command -v jq >/dev/null || exit 0

event=$(cat)
# Re-entry after our own block: let the turn end (avoids loops).
if printf '%s' "$event" | jq -e '.stop_hook_active == true' >/dev/null 2>&1; then
    exit 0
fi

transcript=$(printf '%s' "$event" | jq -r '.transcript_path // empty')
[[ -z "$transcript" || ! -f "$transcript" ]] && exit 0

# Edit/Write targets after the last message the user typed (tool results and
# meta entries also arrive as "user" lines and are skipped).
paths=$(jq -rs '
    def typed: .type == "user" and (.isMeta != true) and ((.message.content | type) == "string"
        or ([.message.content[]? | select(.type == "text")] | length) > 0);
    (map(typed) | rindex(true) // -1) as $start
    | .[($start + 1):][]
    | select(.type == "assistant")
    | .message.content[]?
    | select(.type == "tool_use" and (.name == "Edit" or .name == "Write" or .name == "NotebookEdit"))
    | .input.file_path // empty
' "$transcript" 2>/dev/null || true)

rust=false
crypto=false
client=false
workflows=false
spec=false
while IFS= read -r p; do
    [[ -z "$p" ]] && continue
    case "$p" in
        */crates/crypto/*) rust=true; crypto=true ;;
        */crates/*|*/server/*|*/Cargo.toml|*/deny.toml) rust=true ;;
        */client/*) client=true ;;
        */.github/workflows/*) workflows=true ;;
        */docs/crypto.md|*/docs/protocol.md|*/docs/threat-model.md) spec=true ;;
    esac
done <<< "$paths"

$rust || $client || $workflows || $spec || exit 0

msg="Before reporting the task as done:"
$rust && msg+=$'\n  - mise run check:rust (fmt, clippy, tests, WASM build)'
$crypto && msg+=$'\n  - crypto-review skill: the change matches docs/crypto.md, vectors and property tests cover it'
$client && msg+=$'\n  - mise run check:client (Biome, Stylelint, types, Vitest, build)\n  - UI change: mise run check:e2e, and look at it on a phone and a desktop, light and dark'
$workflows && msg+=$'\n  - actionlint'
$spec && msg+=$'\n  - the spec change is reflected in code and in the other spec pages (or flagged as pending)'
msg+=$'\nSkip what was already run green after the last edit.'

jq -n --arg reason "$msg" '{decision: "block", reason: $reason}'
