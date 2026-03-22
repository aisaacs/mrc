#!/usr/bin/env bash
#
# notify-proxy.sh — Host-side notification proxy for mrc containers.
# Listens on a TCP port and fires a macOS/Linux desktop notification.
#
# Usage: notify-proxy.sh [port] [--no-sound]
#
# Protocol (from container):
#   Line 1: repo name (used in title)
#   Line 2: summary of what Claude did (notification body)
#
set -euo pipefail

NO_SOUND="${NO_SOUND:-false}"

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
      local sound_arg=""
      if ! $NO_SOUND; then
        sound_arg=' sound name "Glass"'
      fi
      osascript -e "display notification \"$summary\" with title \"$title\"${sound_arg}" 2>/dev/null || true
      ;;
    Linux)
      notify-send "$title" "$summary" 2>/dev/null || true
      ;;
  esac
}

# When socat forks us with --handle, serve one request
if [[ "${1:-}" == "--handle" ]]; then
  # NO_SOUND is passed via environment from the parent process
  handle_connection
  exit 0
fi

# Parse args
PORT="7723"
for arg in "$@"; do
  case "$arg" in
    --no-sound) NO_SOUND=true ;;
    *)          PORT="$arg" ;;
  esac
done

export NO_SOUND

log "starting on 127.0.0.1:$PORT (sound: $(! $NO_SOUND && echo on || echo off))"
exec socat TCP-LISTEN:"$PORT",fork,reuseaddr,bind=127.0.0.1 SYSTEM:"NO_SOUND=$NO_SOUND $(printf '%q' "$0") --handle"
