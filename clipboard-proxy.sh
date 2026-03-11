#!/usr/bin/env bash
#
# clipboard-proxy.sh — Host-side clipboard proxy for mrc containers.
# Listens on a TCP port and serves clipboard content to the container.
#
# Protocol:
#   Client connects, sends: "GET <mimetype>\n"
#   Server writes back raw bytes and closes the connection.
#   If clipboard has no data for that type, connection closes with no data.
#
# Supported types:
#   image/png  — clipboard image as PNG
#   text/plain — clipboard text
#
set -euo pipefail

log() { echo "[clipboard-proxy] $(date +%H:%M:%S) $*" >&2; }

read_clipboard() {
  local mime="$1"
  case "$(uname -s)" in
    Darwin)
      case "$mime" in
        TARGETS)
          # Report which types are available on the clipboard
          # Always report text; verify image is actually readable before advertising
          echo "text/plain"
          local tmpcheck="/tmp/mrc-clip-check.$$"
          if osascript -e '
            use framework "AppKit"
            use framework "Foundation"
            set pb to current application'"'"'s NSPasteboard'"'"'s generalPasteboard()
            set imgData to pb'"'"'s dataForType:(current application'"'"'s NSPasteboardTypePNG)
            if imgData is missing value then error "no image"
            imgData'"'"'s writeToFile:"'"$tmpcheck"'" atomically:true
          ' >/dev/null 2>/dev/null && [ -s "$tmpcheck" ]; then
            echo "image/png"
          fi
          rm -f "$tmpcheck"
          ;;
        image/png)
          # Use osascript to write clipboard PNG to a temp file, then stream it
          local tmpfile="/tmp/mrc-clip-img.$$"
          osascript -e '
            use framework "AppKit"
            use framework "Foundation"
            set pb to current application'"'"'s NSPasteboard'"'"'s generalPasteboard()
            set imgData to pb'"'"'s dataForType:(current application'"'"'s NSPasteboardTypePNG)
            if imgData is missing value then error "no image"
            imgData'"'"'s writeToFile:"'"$tmpfile"'" atomically:true
          ' >/dev/null 2>/dev/null && cat "$tmpfile" || true
          rm -f "$tmpfile"
          ;;
        text/plain)
          pbpaste 2>/dev/null || true
          ;;
      esac
      ;;
    Linux)
      case "$mime" in
        TARGETS)
          # Only report image types if we can actually read non-empty data
          local targets
          targets=$(xclip -selection clipboard -t TARGETS -o 2>/dev/null || true)
          echo "$targets" | while IFS= read -r t; do
            case "$t" in
              image/*)
                # Verify we can actually read this image type
                if xclip -selection clipboard -t "$t" -o 2>/dev/null | head -c 1 | grep -qc .; then
                  echo "$t"
                fi
                ;;
              *) echo "$t" ;;
            esac
          done
          ;;
        image/png|image/bmp|image/jpeg|image/jpg|image/gif|image/webp)
          xclip -selection clipboard -t "$mime" -o 2>/dev/null || true
          ;;
        text/plain)
          xclip -selection clipboard -o 2>/dev/null || true
          ;;
      esac
      ;;
  esac
}

handle_connection() {
  local request
  if IFS= read -r request; then
    request="${request%%$'\r'}"  # strip trailing CR if present
    local mime="${request#GET }"
    mime="${mime// /}"
    log "request: GET $mime"
    # Stream directly to stdout — never capture binary data in a bash variable
    # (bash strips null bytes from variables, which corrupts PNG data)
    read_clipboard "$mime"
  fi
}

# When socat forks us with --handle, serve one request on stdin/stdout
if [[ "${1:-}" == "--handle" ]]; then
  handle_connection
  exit 0
fi

PORT="${1:-7722}"

log "starting on 127.0.0.1:$PORT"
# socat forks a handler for each connection
exec socat TCP-LISTEN:"$PORT",fork,reuseaddr,bind=127.0.0.1 SYSTEM:"$(printf '%q' "$0") --handle"
