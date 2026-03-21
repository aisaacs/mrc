#!/usr/bin/env bash
#
# mrc — Mister Claude
# Launch Claude Code in a sandboxed Docker container with network firewall.
#
# Usage:
#   mrc [options] [path-to-repo] [-- claude-code-args...]
#
# Options:
#   -r, --rebuild  Force a full image rebuild (no cache)
#   -v, --verbose  Show Colima and Docker output (useful for debugging)
#   -n, --new [name]     Start a new conversation (optionally named)
#   -w, --web            Allow outbound HTTPS to any host (for web search/fetch)
#   --no-summary         Skip AI session summary on exit
#
# Session management:
#   mrc sessions ls [path]                List saved sessions
#   mrc sessions name <name> [#] [path]   Name a session (default: most recent)
#   mrc sessions resume <name-or-#> [path] Resume a specific session
#
# Examples:
#   mrc ~/projects/myapp
#   mrc ~/projects/myapp -- --model claude-sonnet-4-5-20250929
#   mrc .                 -- -p "fix the failing tests"
#   mrc -v ~/projects/myapp
#
# Hidden directories:
#   Create a .sandboxignore file in your repo root listing paths to hide
#   from the container (one per line, relative to repo root):
#
#     .env
#     secrets/
#     infrastructure/
#
# Environment:
#   ANTHROPIC_API_KEY  — optional; loaded from .env next to this script if present

set -euo pipefail

# --- Spaceballs Quotes (Master Yogurt's wisdom for the waiting) ---
YOGURT_QUOTES=(
  "Moichandising! Moichandising! ...where the real money from the movie is made."
  "May the Schwartz be with you."
  "I am Yogurt. The one and only."
  "Use the Schwartz, coder!"
  "God willing, we'll all meet again in Spaceballs 2: The Search for More Money."
  "I hate yogurt. Even with strawberries."
  "The ring! I can't believe you fell for the oldest trick in the book!"
)

spinner() {
  local pid=$1
  local frames=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
  local quote="${YOGURT_QUOTES[$((RANDOM % ${#YOGURT_QUOTES[@]}))]}"
  local i=0
  while kill -0 "$pid" 2>/dev/null; do
    printf "\r  %s %s" "${frames[$((i % ${#frames[@]}))]}" "$quote"
    sleep 0.1
    ((++i))
  done
  printf "\r%*s\r" $((${#quote} + 6)) ""   # clear the line
}

# Resolve symlinks to find the real script directory (portable, works on macOS)
SOURCE="$0"
while [ -L "$SOURCE" ]; do
  DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
IMAGE_NAME="mister-claude"

# Parse flags
VERBOSE=false
ALLOW_WEB=false
NEW_SESSION=false
NO_SUMMARY=false
REBUILD=false
RESUME_SESSION=""
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)     sed -n '2,/^$/{s/^# //;s/^#//;p;}' "$0"; exit 0 ;;
    --new|-n)      NEW_SESSION=true; NEW_SESSION_NAME="${2:-}";
                   if [[ -n "$NEW_SESSION_NAME" && "$NEW_SESSION_NAME" != -* ]]; then shift; fi
                   ;;
    --no-summary)  NO_SUMMARY=true ;;
    --rebuild|-r)  REBUILD=true ;;
    --verbose|-v)  VERBOSE=true ;;
    --web|-w)      ALLOW_WEB=true ;;
    *)             args+=("$1") ;;
  esac
  shift
done
set -- "${args[@]+"${args[@]}"}"

# --- Subcommand: mrc sessions <ls|name|resume> ---
if [[ "${1:-}" == "sessions" ]]; then
  SUBCMD="${2:-ls}"
  shift 2 || shift $#
  SESSIONS="$SCRIPT_DIR/mrc-sessions"

  case "$SUBCMD" in
    ls)
      REPO_PATH="${1:-.}"
      REPO_PATH="$(cd "$REPO_PATH" && pwd)"
      python3 "$SESSIONS" list "$REPO_PATH/.mrc"
      ;;
    name)
      NAME="${1:-}"
      NUMBER="${2:-1}"
      REPO_PATH="${3:-.}"
      REPO_PATH="$(cd "$REPO_PATH" && pwd)"
      if [[ -z "$NAME" ]]; then
        echo "Usage: mrc sessions name <name> [#] [path]" >&2
        exit 1
      fi
      python3 "$SESSIONS" name "$REPO_PATH/.mrc" "$NAME" "$NUMBER"
      ;;
    resume)
      QUERY="${1:-}"
      REPO_PATH="${2:-.}"
      REPO_PATH="$(cd "$REPO_PATH" && pwd)"
      if [[ -z "$QUERY" ]]; then
        echo "Usage: mrc sessions resume <name-or-#> [path]" >&2
        exit 1
      fi
      RESUME_SESSION="$(python3 "$SESSIONS" resolve "$REPO_PATH/.mrc" "$QUERY")"
      # Clear args and fall through to normal launch with RESUME_SESSION set
      set --
      ;;
    *)
      echo "Unknown sessions command: $SUBCMD" >&2
      echo "Usage: mrc sessions <ls|name|resume>" >&2
      exit 1
      ;;
  esac

  # ls and name exit here; resume falls through to launch
  if [[ "$SUBCMD" != "resume" ]]; then
    exit 0
  fi
fi

# Redirect target for noisy commands
if $VERBOSE; then
  QUIET="/dev/stderr"
else
  QUIET="/dev/null"
fi

# Parse repo path (default: current directory)
REPO_PATH="${1:-.}"
REPO_PATH="$(cd "$REPO_PATH" && pwd)"
shift || true

# Strip optional "--" separator
[[ "${1:-}" == "--" ]] && shift


# Load .env file if present (for dedicated API key)
ENV_FILE="$SCRIPT_DIR/.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a            # auto-export all sourced variables
  source "$ENV_FILE"
  set +a
fi

# Pass API key through if set
ENV_FLAGS=()
if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  ENV_FLAGS+=(-e ANTHROPIC_API_KEY)
fi
if $ALLOW_WEB; then
  ENV_FLAGS+=(-e ALLOW_WEB=1)
fi
if $NEW_SESSION; then
  ENV_FLAGS+=(-e NEW_SESSION=1)
fi
if [[ -n "$RESUME_SESSION" ]]; then
  ENV_FLAGS+=(-e "RESUME_SESSION=$RESUME_SESSION")
fi
ENV_FLAGS+=(-e CLAUDE_CODE_MAX_OUTPUT_TOKENS="${CLAUDE_CODE_MAX_OUTPUT_TOKENS:-128000}")
ENV_FLAGS+=(-e "MRC_REPO_NAME=$(basename "$REPO_PATH")")

# Ensure Colima is running
STARTED_COLIMA=false
if command -v colima &>/dev/null; then
  # Point docker at Colima's socket if not already configured
  if [[ -z "${DOCKER_HOST:-}" ]]; then
    export DOCKER_HOST="unix://${HOME}/.colima/default/docker.sock"
  fi
  if ! colima status &>/dev/null 2>&1; then
    echo "🎩 Preparing ship for Ludicrous Speed..."
    COLIMA_FLAGS=(--vm-type vz --mount-type virtiofs --cpu 4 --memory 8)
    colima start "${COLIMA_FLAGS[@]}" 2>"$QUIET" &
    spinner $!
    wait $!
    echo "  ✓ Ship ready. All bleeps, sweeps, and creeps accounted for."
    STARTED_COLIMA=true
  fi
elif ! docker info &>/dev/null 2>&1; then
  echo "We've lost the bleeps, the sweeps, AND the creeps." >&2
  echo "Error: Docker is not running and Colima is not installed." >&2
  exit 1
fi

# Cleanup on exit: stop clipboard proxy, optionally stop Colima
cleanup() {
  [[ -n "${CLIP_PID:-}" ]] && kill "$CLIP_PID" 2>/dev/null || true
  [[ -n "${NOTIFY_PID:-}" ]] && kill "$NOTIFY_PID" 2>/dev/null || true
  if ${STARTED_COLIMA:-false}; then
    echo ""
    echo "🎩 Goodbye, Lone Starr."
    colima stop 2>"$QUIET"
  fi
}
trap cleanup EXIT

# Build image if needed (--no-cache when image is missing so npm pulls fresh)
echo "  ◎ Mr. Radar is scanning the environment..."
USER_UID="$(id -u)"
USER_GID="$(id -g)"

BUILD_FLAGS=(-q --build-arg "USER_UID=$USER_UID" --build-arg "USER_GID=$USER_GID")
if $REBUILD; then
  docker rmi -f "$IMAGE_NAME" 2>/dev/null || true
  BUILD_FLAGS+=(--no-cache)
elif ! docker image inspect "$IMAGE_NAME" &>/dev/null; then
  BUILD_FLAGS+=(--no-cache)
fi

BUILD_LOG=$(mktemp)
if ! docker build "${BUILD_FLAGS[@]}" \
  -t "$IMAGE_NAME" \
  "$SCRIPT_DIR" > /dev/null 2>"$BUILD_LOG"; then
  echo "  ✗ Build failed. Docker output:" >&2
  cat "$BUILD_LOG" >&2
  rm -f "$BUILD_LOG"
  exit 1
fi
rm -f "$BUILD_LOG"

echo "  ✓ Radar locked."

# Warn if the image is more than 4 days old (Claude Code auto-update is disabled)
IMAGE_CREATED="$(docker image inspect --format '{{.Created}}' "$IMAGE_NAME" 2>/dev/null || true)"
if [[ -n "$IMAGE_CREATED" ]]; then
  IMAGE_EPOCH="$(date -d "$IMAGE_CREATED" +%s 2>/dev/null || date -jf "%Y-%m-%dT%H:%M:%S" "${IMAGE_CREATED%%.*}" +%s 2>/dev/null || true)"
  if [[ -n "$IMAGE_EPOCH" ]]; then
    NOW_EPOCH="$(date +%s)"
    AGE_DAYS=$(( (NOW_EPOCH - IMAGE_EPOCH) / 86400 ))
    if [[ "$AGE_DAYS" -ge 4 ]]; then
      echo ""
      echo "  ⚠ Your Claude Code image is ${AGE_DAYS} days old. Auto-update is disabled in the container."
      echo "    Rebuild to get the latest version:"
      echo "      mrc --rebuild $REPO_PATH"
      echo ""
    fi
  fi
fi

# Build volume flags
VOLUMES=(-v "$REPO_PATH:/workspace")

# Read .sandboxignore and create volume overlays for each entry
IGNORE_FILE="$REPO_PATH/.sandboxignore"
if [[ -f "$IGNORE_FILE" ]]; then
  while IFS= read -r line; do
    # Skip blank lines and comments
    line="${line%%#*}"          # strip inline comments
    line="${line%"${line##*[![:space:]]}"}"  # trim trailing whitespace
    line="${line#"${line%%[![:space:]]*}"}"  # trim leading whitespace
    [[ -z "$line" ]] && continue

    # Strip trailing slash for consistency
    line="${line%/}"

    # Reject absolute paths and path traversal attempts
    if [[ "$line" == /* ]] || [[ "$line" == *..* ]]; then
      echo "  → Ignored:   $line (absolute or traversal paths not allowed)" >&2
      continue
    fi

    HOST_PATH="$REPO_PATH/$line"
    CONTAINER_PATH="/workspace/$line"

    if [[ -f "$HOST_PATH" ]]; then
      # Files: mount /dev/null over them (appears as empty file)
      VOLUMES+=(-v "/dev/null:$CONTAINER_PATH:ro")
      echo "  → Cloaked:   $line (file)"
    elif [[ -d "$HOST_PATH" ]]; then
      # Directories: anonymous volume overlay (appears as empty dir)
      VOLUMES+=(-v "$CONTAINER_PATH")
      echo "  → Cloaked:   $line (dir)"
    else
      echo "  → Not found: $line (we ain't found shit)"
    fi
  done < "$IGNORE_FILE"
fi

# Persist Claude config between runs (per-repo to avoid cross-project contamination)
REPO_HASH="$(printf '%s' "$REPO_PATH" | md5sum | cut -c1-12)"
VOLUMES+=(-v "mrc-config-${REPO_HASH}:/home/coder/.claude")

# Start clipboard proxy if socat is available
CLIP_PORT="7722"
CLIP_PID=""
if command -v socat &>/dev/null; then
  bash "$SCRIPT_DIR/clipboard-proxy.sh" "$CLIP_PORT" &
  CLIP_PID=$!
  # Wait briefly for the proxy to start listening
  for _ in $(seq 1 10); do
    if lsof -i :"$CLIP_PORT" &>/dev/null 2>&1 || nc -z 127.0.0.1 "$CLIP_PORT" 2>/dev/null; then
      break
    fi
    sleep 0.1
  done
  if kill -0 "$CLIP_PID" 2>/dev/null; then
    ENV_FLAGS+=(-e "MRC_CLIPBOARD_PORT=$CLIP_PORT")
  else
    echo "  ! Clipboard proxy failed to start (image paste won't work)"
    CLIP_PID=""
  fi
else
  echo "  ! socat not found — install it for clipboard/image paste support"
fi

# Start notification proxy (fires macOS/Linux desktop notifications)
NOTIFY_PORT="7723"
NOTIFY_PID=""
if command -v socat &>/dev/null; then
  bash "$SCRIPT_DIR/notify-proxy.sh" "$NOTIFY_PORT" &
  NOTIFY_PID=$!
  for _ in $(seq 1 10); do
    if lsof -i :"$NOTIFY_PORT" &>/dev/null 2>&1 || nc -z 127.0.0.1 "$NOTIFY_PORT" 2>/dev/null; then
      break
    fi
    sleep 0.1
  done
  if kill -0 "$NOTIFY_PID" 2>/dev/null; then
    ENV_FLAGS+=(-e "MRC_NOTIFY_PORT=$NOTIFY_PORT")
  else
    echo "  ! Notification proxy failed to start"
    NOTIFY_PID=""
  fi
fi

cat << 'BANNER'
      __  __ ____     ____  _                 _
     |  \/  |  _ \ . / ___|| | __ _ _   _  __| | ___
     | |\/| | |_) |  | |   | |/ _` | | | |/ _` |/ _ \
     | |  | |  _ <   | |___| | (_| | |_| | (_| |  __/
     |_|  |_|_| \_\   \____|_|\__,_|\__,_|\__,_|\___|
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Sandboxed Claude Code  ·
  "It's my industrial-strength hair dryer, AND IT WORKS."

BANNER
echo "  → Repo:      $REPO_PATH"
echo "  → Volume:    mrc-config-${REPO_HASH}"
if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "  → Schwartz:  engaged (API key)"
else
  echo "  → Schwartz:  I see your Schwartz is as big as mine... you DO have a subscription, right?"
fi
if [[ -n "$CLIP_PID" ]]; then
  echo "  → Clipboard: the Schwartz can see your clipboard"
else
  echo "  → Clipboard: disabled (install socat for image paste)"
fi
if [[ -n "$NOTIFY_PID" ]]; then
  echo "  → Notify:    the Schwartz will alert you when ready"
else
  echo "  → Notify:    disabled (install socat for desktop notifications)"
fi
if $ALLOW_WEB; then
  echo "  → Firewall:  jammed, but he can see the web (--web)"
else
  echo "  → Firewall:  jammed (just like their radar)"
fi
echo ""

# Snapshot existing sessions so we can detect the new one after exit
MRC_DIR="$REPO_PATH/.mrc"
BEFORE_SESSIONS=""
if [[ -d "$MRC_DIR" ]]; then
  BEFORE_SESSIONS="$(ls "$MRC_DIR"/*.jsonl 2>/dev/null || true)"
fi

docker run --rm -it --init \
  --cap-add=NET_ADMIN \
  --cap-add=NET_RAW \
  --add-host=host.docker.internal:host-gateway \
  ${ENV_FLAGS[@]+"${ENV_FLAGS[@]}"} \
  "${VOLUMES[@]}" \
  "$IMAGE_NAME" \
  "$@"
EXIT_CODE=$?

# --- Post-session processing ---

# 1. Detect the new session file
NEW_FILE=""
if [[ -d "$MRC_DIR" ]]; then
  AFTER_SESSIONS="$(ls "$MRC_DIR"/*.jsonl 2>/dev/null || true)"
  NEW_FILE="$(comm -13 <(echo "$BEFORE_SESSIONS") <(echo "$AFTER_SESSIONS") | head -1)"
fi

if [[ -n "$NEW_FILE" ]]; then
  NEW_UUID="$(basename "$NEW_FILE" .jsonl)"
  SESSIONS="$SCRIPT_DIR/mrc-sessions"

  # 2. Name it if --new was given with a name
  if [[ -n "${NEW_SESSION_NAME:-}" ]]; then
    python3 "$SESSIONS" name "$MRC_DIR" "$NEW_SESSION_NAME" "$NEW_UUID" 2>/dev/null
  fi

  # 3. Tool-miss detection (sync — fast, pure parsing)
  TOOL_MISSES="$(python3 "$SESSIONS" tool-misses "$MRC_DIR" "$NEW_UUID" 2>/dev/null || true)"
  if [[ -n "$TOOL_MISSES" ]]; then
    echo ""
    echo "  ⚠ We ain't found these tools:"
    MRC_REPO_URL="$(cd "$SCRIPT_DIR" && git remote get-url origin 2>/dev/null | sed 's/\.git$//' || true)"
    MRC_REPO_URL="${MRC_REPO_URL:-https://github.com/aisaacs/mrc}"
    while IFS= read -r miss; do
      CMD_NAME="${miss%%:*}"
      echo "    - $miss"
      ISSUE_TITLE="$(python3 -c "import urllib.parse; print(urllib.parse.quote('Add $CMD_NAME to Dockerfile'))")"
      ISSUE_BODY="$(python3 -c "import urllib.parse; print(urllib.parse.quote('Session reported: $miss\n\nConsider adding \`$CMD_NAME\` to the apt-get install line in the Dockerfile.'))")"
      echo "      → ${MRC_REPO_URL}/issues/new?title=${ISSUE_TITLE}&body=${ISSUE_BODY}"
    done <<< "$TOOL_MISSES"
  fi

  # 4. Session summary (async background — uses Haiku API)
  if ! $NO_SUMMARY && [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" python3 "$SESSIONS" summarize "$MRC_DIR" "$NEW_UUID" &
  fi
fi

exit $EXIT_CODE
