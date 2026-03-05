#!/bin/bash
#
# clipboard-shim.sh — Container-side xclip replacement.
# Connects to the host clipboard proxy via TCP.
#
# Mimics enough of xclip's interface for Claude Code's clipboard reads:
#   xclip -selection clipboard -t TARGETS -o
#   xclip -selection clipboard -t image/png -o
#   xclip -selection clipboard -o
#
set -euo pipefail

LOG="/tmp/mrc-xclip-shim.log"
log() { echo "[xclip-shim] $(date +%H:%M:%S) $*" >> "$LOG" 2>/dev/null || true; }

PROXY_HOST="${MRC_CLIPBOARD_HOST:-host.docker.internal}"
PROXY_PORT="${MRC_CLIPBOARD_PORT:-7722}"

# Parse xclip-compatible arguments
TARGET=""
DIRECTION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -t)       TARGET="$2"; shift 2 ;;
    -o)       DIRECTION="out"; shift ;;
    -selection) shift 2 ;;  # consume "clipboard" / "primary" etc.
    -i)       DIRECTION="in"; shift ;;
    *)        shift ;;
  esac
done

# Default target when none specified
if [[ -z "$TARGET" ]]; then
  TARGET="text/plain"
fi

log "args: TARGET=$TARGET DIRECTION=$DIRECTION"

if [[ "$DIRECTION" != "out" ]]; then
  # We only support reading (output mode). For writes, silently succeed.
  log "write mode — no-op"
  cat >/dev/null
  exit 0
fi

log "connecting to $PROXY_HOST:$PROXY_PORT for GET $TARGET"
# Stream directly to stdout — never capture binary data in a bash variable
# (bash strips null bytes from variables, which corrupts PNG data)
printf 'GET %s\n' "$TARGET" | socat -,ignoreeof TCP:"$PROXY_HOST":"$PROXY_PORT" 2>/dev/null || {
  log "socat failed (exit $?)"
  exit 1
}
log "request complete"
