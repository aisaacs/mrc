#!/usr/bin/env bash
#
# notify-proxy.sh — Host-side notification proxy for mrc containers.
# Listens on a TCP port and fires a macOS/Linux desktop notification.
#
# Protocol (from container):
#   Line 1: repo name (used in title)
#   Line 2: summary of what Claude did (notification body)
#
set -euo pipefail

log() { echo "[notify-proxy] $(date +%H:%M:%S) $*" >&2; }

handle_connection() {
  local repo summary
  IFS= read -r repo 2>/dev/null || true
  IFS= read -r summary 2>/dev/null || true
  repo="${repo%%$'\r'}"
  summary="${summary%%$'\r'}"
  repo="${repo:-workspace}"
  summary="${summary:-Ready for input.}"

  local title="Mr. Claude · $repo"
  log "$title: $summary"

  case "$(uname -s)" in
    Darwin)
      osascript -e "display notification \"$summary\" with title \"$title\" sound name \"Glass\"" 2>/dev/null || true
      ;;
    Linux)
      notify-send "$title" "$summary" 2>/dev/null || true
      ;;
  esac
}

# When socat forks us with --handle, serve one request
if [[ "${1:-}" == "--handle" ]]; then
  handle_connection
  exit 0
fi

PORT="${1:-7723}"

log "starting on 127.0.0.1:$PORT"
exec socat TCP-LISTEN:"$PORT",fork,reuseaddr,bind=127.0.0.1 SYSTEM:"$(printf '%q' "$0") --handle"
