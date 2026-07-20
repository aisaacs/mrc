#!/bin/bash
#
# codex-paste-shim.sh — Container-side `powershell.exe` stand-in, so Codex's Ctrl+V image paste
# reaches the HOST clipboard.
#
# WHY THIS FILE EXISTS. Claude Code reads the clipboard by shelling out to `xclip`, which is why
# clipboard-shim.sh works: a command boundary is a place mrc can stand in. Codex has no such
# boundary — it links arboard and speaks the X11 protocol itself — so the xclip shim is invisible to
# it and Ctrl+V dies with:
#   Failed to paste image: clipboard unavailable: ... X11 server connection timed out ...
# (arboard::Clipboard::new() failing outright, before any image read, because there is no DISPLAY.)
#
# Codex has exactly ONE non-X11 image path — its WSL fallback in codex-rs/tui/src/clipboard_paste.rs.
# On a ClipboardUnavailable error, if is_probably_wsl() it runs `powershell.exe -NoProfile -Command
# <script>`, reads STDOUT as a WINDOWS path to a PNG, maps `C:\dir\f.png` → `/mnt/c/dir/f.png`, and
# attaches that file. That IS a command boundary, so it is shimmable exactly like xclip:
# entrypoint.sh sets WSL_DISTRO_NAME for the Codex process (is_probably_wsl() accepts that env var on
# its own), and this script plays PowerShell — pulling the image from the host clipboard proxy on
# demand. No X server, no clipboard polling, same on-demand shape as the xclip shim.
#
# The contract below is Codex's, not ours — do not "improve" it:
#   stdout  = one Windows-style path and nothing else (a stray echo would be parsed as the path)
#   exit 1  = no image available; Codex then reports its original arboard error
#
set -uo pipefail

LOG="/tmp/mrc-codex-paste-shim.log"
log() { echo "[codex-paste-shim] $(date +%H:%M:%S) $*" >> "$LOG" 2>/dev/null || true; }

PROXY_HOST="${MRC_CLIPBOARD_HOST:-host.docker.internal}"
PROXY_PORT="${MRC_CLIPBOARD_PORT:-}"

if [ -z "$PROXY_PORT" ]; then
  log "no MRC_CLIPBOARD_PORT — clipboard proxy not available"
  exit 1
fi

# Must live under /mnt/<drive>/ — that is the only shape convert_windows_path_to_wsl() maps back.
# The Dockerfile pre-creates it owned by coder; `mkdir -p` only covers a stale/rebuilt image.
DIR="/mnt/c/mrc-clipboard"
mkdir -p "$DIR" 2>/dev/null || { log "cannot create $DIR"; exit 1; }

# Codex takes the path and never cleans up, so each paste leaves a PNG behind. Sweep the previous
# hour's worth on the way in — cheap, and keeps a long session from growing a pile.
find "$DIR" -maxdepth 1 -type f -name '*.png' -mmin +60 -delete 2>/dev/null || true

NAME="paste-$(date +%Y%m%d-%H%M%S)-$$.png"
OUT="$DIR/$NAME"

log "fetching image/png from $PROXY_HOST:$PROXY_PORT"
if ! printf 'GET image/png\n' | socat -,ignoreeof TCP:"$PROXY_HOST":"$PROXY_PORT" > "$OUT" 2>/dev/null; then
  log "socat failed"
  rm -f "$OUT"
  exit 1
fi

# An empty body is the proxy's "no image on the clipboard" answer (the human copied text, or
# nothing). Exit 1 rather than hand Codex a 0-byte file it would fail to decode anyway.
if [ ! -s "$OUT" ]; then
  log "no image on the host clipboard"
  rm -f "$OUT"
  exit 1
fi

log "wrote $(wc -c < "$OUT") bytes to $OUT"
printf 'C:\\mrc-clipboard\\%s\n' "$NAME"
