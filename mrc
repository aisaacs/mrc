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
#   --no-notify          Disable desktop notifications on response complete
#   --no-sound           Disable notification sound (still shows notification)
#
# Commands:
#   mrc status                            Show active containers across repos
#   mrc pick [path]                       Interactive session picker (arrow keys)
#
# Session management:
#   mrc sessions ls [path]                List saved sessions
#   mrc sessions name <name> [#] [path]   Name a session (default: most recent)
#   mrc sessions resume <name-or-#> [path] Resume a specific session
#   mrc sessions pick [path]              Interactive session picker (alias for mrc pick)
#
# Examples:
#   mrc ~/projects/myapp
#   mrc ~/projects/myapp -- --model claude-sonnet-4-5-20250929
#   mrc .                 -- -p "fix the failing tests"
#   mrc -v ~/projects/myapp
#
# Hidden paths:
#   Create .sandboxignore files anywhere in your repo tree listing paths
#   to hide from the container (one per line, relative to the directory
#   containing the .sandboxignore file — works like .gitignore):
#
#     .env
#     secrets/
#     infrastructure/
#
# Config files (one flag per line, comments with #):
#   ~/.mrcrc              Global defaults
#   <repo>/.mrcrc         Per-repo overrides (merged on top of global)
#   CLI flags always take precedence over config files.
#
# Environment:
#   ANTHROPIC_API_KEY  — optional; loaded from .env next to this script if present
#   MRC_PORT_BASE      — starting port for proxy allocation (default: 7722)

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

# Load config files: ~/.mrcrc (global), then .mrcrc (repo-local).
# Lines are treated as flags, merged with CLI args (CLI wins by virtue of being last).
read_mrcrc() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  while IFS= read -r line; do
    line="${line%%#*}"          # strip comments
    line="${line#"${line%%[![:space:]]*}"}"  # trim leading
    line="${line%"${line##*[![:space:]]}"}"  # trim trailing
    [[ -z "$line" ]] && continue
    config_args+=("$line")
  done < "$file"
}

config_args=()
read_mrcrc "$HOME/.mrcrc"

# Sniff repo path from CLI args for per-repo config (before full parsing).
# We need this early to find .mrcrc in the repo root.
_repo_hint=""
for _arg in "$@"; do
  [[ "$_arg" == -* || "$_arg" == "--" ]] && continue
  [[ "$_arg" == "status" || "$_arg" == "sessions" || "$_arg" == "pick" ]] && break
  if [[ -d "$_arg" ]]; then _repo_hint="$(cd "$_arg" && pwd)"; break; fi
done
: "${_repo_hint:=$(pwd)}"
read_mrcrc "$_repo_hint/.mrcrc"

# Merge: config flags first, then CLI args (CLI overrides)
set -- "${config_args[@]+"${config_args[@]}"}" "$@"

# Parse flags
VERBOSE=false
ALLOW_WEB=false
NEW_SESSION=false
NO_NOTIFY=false
NO_SOUND=false
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
    --no-notify)   NO_NOTIFY=true ;;
    --no-sound)    NO_SOUND=true ;;
    --no-summary)  NO_SUMMARY=true ;;
    --rebuild|-r)  REBUILD=true ;;
    --verbose|-v)  VERBOSE=true ;;
    --web|-w)      ALLOW_WEB=true ;;
    *)             args+=("$1") ;;
  esac
  shift
done
set -- "${args[@]+"${args[@]}"}"

# Debug helper — prints to stderr when --verbose is set
dbg() { $VERBOSE && echo "[mrc:debug] $*" >&2 || true; }

# --- Subcommand: mrc status ---
if [[ "${1:-}" == "status" ]]; then
  # Ensure Docker is reachable
  if command -v colima &>/dev/null && [[ -z "${DOCKER_HOST:-}" ]]; then
    export DOCKER_HOST="unix://${HOME}/.colima/default/docker.sock"
  fi
  if ! docker info &>/dev/null 2>&1; then
    echo "Docker is not running." >&2
    exit 1
  fi

  CONTAINERS="$(docker ps --filter label=mrc=1 --format '{{.ID}}' 2>/dev/null)"
  if [[ -z "$CONTAINERS" ]]; then
    echo "  No Mr. Claude containers running."
    exit 0
  fi

  echo ""
  echo "  🎩 Active Mr. Claude Sessions"
  echo "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  while IFS= read -r cid; do
    REPO_NAME="$(docker inspect --format '{{index .Config.Labels "mrc.repo.name"}}' "$cid" 2>/dev/null)"
    REPO_PATH_LABEL="$(docker inspect --format '{{index .Config.Labels "mrc.repo"}}' "$cid" 2>/dev/null)"
    WEB="$(docker inspect --format '{{index .Config.Labels "mrc.web"}}' "$cid" 2>/dev/null)"
    STARTED="$(docker inspect --format '{{.State.StartedAt}}' "$cid" 2>/dev/null)"
    STATUS="$(docker inspect --format '{{.State.Status}}' "$cid" 2>/dev/null)"

    # Calculate uptime
    if [[ -n "$STARTED" ]]; then
      START_EPOCH="$(date -d "$STARTED" +%s 2>/dev/null || date -jf "%Y-%m-%dT%H:%M:%S" "${STARTED%%.*}" +%s 2>/dev/null || echo 0)"
      NOW_EPOCH="$(date +%s)"
      UPTIME_SECS=$(( NOW_EPOCH - START_EPOCH ))
      if [[ "$UPTIME_SECS" -ge 3600 ]]; then
        UPTIME="$((UPTIME_SECS / 3600))h $((UPTIME_SECS % 3600 / 60))m"
      elif [[ "$UPTIME_SECS" -ge 60 ]]; then
        UPTIME="$((UPTIME_SECS / 60))m"
      else
        UPTIME="${UPTIME_SECS}s"
      fi
    else
      UPTIME="unknown"
    fi

    WEB_TAG=""
    if [[ "$WEB" == "true" ]]; then
      WEB_TAG=" (--web)"
    fi

    echo "  → ${REPO_NAME:-unknown}  ·  up ${UPTIME}${WEB_TAG}"
    echo "    ${REPO_PATH_LABEL:-?}  [${cid:0:12}]"
  done <<< "$CONTAINERS"
  echo ""
  exit 0
fi

# --- Load .env early (needed for session naming in pick/sessions commands) ---
ENV_FILE="$SCRIPT_DIR/.env"
if [[ -f "$ENV_FILE" ]]; then
  if grep -q 'op://' "$ENV_FILE" 2>/dev/null && command -v op &>/dev/null; then
    dbg ".env contains op:// references, using 1Password CLI"
    # Try without --account first, then prompt if it fails
    if [[ -n "${OP_ACCOUNT:-}" ]]; then
      dbg "op run with explicit OP_ACCOUNT=$OP_ACCOUNT"
      _OP_KEY="$(op run --env-file "$ENV_FILE" --no-masking --account "$OP_ACCOUNT" -- printenv ANTHROPIC_API_KEY 2>/dev/null)" || true
    else
      dbg "op run without --account"
      _OP_KEY="$(op run --env-file "$ENV_FILE" --no-masking -- printenv ANTHROPIC_API_KEY 2>/dev/null)" || true
    fi
    dbg "op run result: ${_OP_KEY:+got key}${_OP_KEY:-empty}"
    # If that failed, try each known account silently
    if [[ -z "$_OP_KEY" && -z "${OP_ACCOUNT:-}" ]]; then
      dbg "enumerating op accounts"
      _OP_ACCOUNTS=()
      while IFS= read -r _line; do
        _OP_ACCOUNTS+=("$_line")
      done < <(op account list --format=json 2>/dev/null | python3 -c 'import sys,json; [print(a["url"]) for a in json.load(sys.stdin)]' 2>/dev/null)
      dbg "found ${#_OP_ACCOUNTS[@]} op account(s)"
      for _acct in "${_OP_ACCOUNTS[@]}"; do
        dbg "trying op account: $_acct"
        _OP_KEY="$(op run --env-file "$ENV_FILE" --no-masking --account "$_acct" -- printenv ANTHROPIC_API_KEY 2>/dev/null)" || true
        if [[ -n "$_OP_KEY" ]]; then
          dbg "got key from account: $_acct"
          break
        fi
      done
    fi
    if [[ -n "$_OP_KEY" ]]; then
      MRC_API_KEY="$_OP_KEY"
    fi
  else
    set -a
    source "$ENV_FILE"
    set +a
  fi
fi
MRC_API_KEY="${MRC_API_KEY:-${ANTHROPIC_API_KEY:-}}"

if [[ -z "${MRC_API_KEY:-}" ]]; then
  echo ""
  echo "  ⚠ The Schwartz is not with you... no API key found!"
  echo ""
  echo "  \"I can't make it work without the combination!\""
  echo "     — Colonel Sandurz, probably talking about this .env file"
  echo ""
  echo "  mrc needs an Anthropic API key for session naming and summaries."
  echo "  This is NOT your Claude Code subscription — it's a separate key"
  echo "  for Haiku API calls. Think of it as the combination to the air shield."
  echo ""
  echo "  To unlock Druidia's fresh air supply:"
  echo ""
  echo "    1. Install the 1Password CLI (op) — it's like having the"
  echo "       Schwartz ring, but for secrets"
  echo "    2. Create a .env file next to the mrc script:"
  echo "       ${SCRIPT_DIR}/.env"
  echo "    3. Add this line (the combination is... 1-2-3-4-5):"
  echo ""
  echo "       ANTHROPIC_API_KEY=\"op://Engineering/MRC Claude API key/credential\""
  echo ""
  echo "  The 1Password CLI will resolve the secret on launch. No need to"
  echo "  write the actual key down — that's the kind of thing an idiot"
  echo "  would have on his luggage."
  echo ""
  echo "  Once you complete these steps, run the command again."
  echo "  May the Schwartz be with you!"
  echo ""
  exit 1
fi

# --- Subcommand: mrc pick [path] ---
if [[ "${1:-}" == "pick" ]]; then
  shift
  REPO_PATH="${1:-.}"
  REPO_PATH="$(cd "$REPO_PATH" && pwd)"
  SESSIONS="$SCRIPT_DIR/mrc-sessions"
  dbg "running: python3 $SESSIONS pick $REPO_PATH/.mrc"
  PICK_RESULT="$(ANTHROPIC_API_KEY="${MRC_API_KEY}" python3 "$SESSIONS" pick "$REPO_PATH/.mrc")"
  dbg "pick result: $PICK_RESULT"
  if [[ "$PICK_RESULT" == "NEW" ]]; then
    NEW_SESSION=true
    ALLOW_WEB=true
  else
    RESUME_SESSION="$PICK_RESULT"
  fi
  set --
fi

# --- Subcommand: mrc sessions <ls|name|resume|pick> ---
if [[ "${1:-}" == "sessions" ]]; then
  SUBCMD="${2:-ls}"
  shift 2 || shift $#
  SESSIONS="$SCRIPT_DIR/mrc-sessions"

  case "$SUBCMD" in
    ls)
      REPO_PATH="${1:-.}"
      REPO_PATH="$(cd "$REPO_PATH" && pwd)"
      ANTHROPIC_API_KEY="${MRC_API_KEY}" python3 "$SESSIONS" list "$REPO_PATH/.mrc"
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
    pick)
      REPO_PATH="${1:-.}"
      REPO_PATH="$(cd "$REPO_PATH" && pwd)"
      PICK_RESULT="$(ANTHROPIC_API_KEY="${MRC_API_KEY}" python3 "$SESSIONS" pick "$REPO_PATH/.mrc")"
      if [[ "$PICK_RESULT" == "NEW" ]]; then
        NEW_SESSION=true
        ALLOW_WEB=true
      else
        RESUME_SESSION="$PICK_RESULT"
      fi
      set --
      ;;
    *)
      echo "Unknown sessions command: $SUBCMD" >&2
      echo "Usage: mrc sessions <ls|name|resume|pick>" >&2
      exit 1
      ;;
  esac

  # ls and name exit here; resume and pick fall through to launch
  if [[ "$SUBCMD" != "resume" && "$SUBCMD" != "pick" ]]; then
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


# Pass API key through to the container if set
ENV_FLAGS=()
if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  ENV_FLAGS+=(-e ANTHROPIC_API_KEY)
fi
if $ALLOW_WEB; then
  ENV_FLAGS+=(-e ALLOW_WEB=1)
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

# Read .sandboxignore files recursively (like .gitignore — each applies relative
# to the directory it lives in).
process_sandboxignore() {
  local ignore_file="$1"
  local ignore_dir="$(dirname "$ignore_file")"
  local rel_dir="${ignore_dir#"$REPO_PATH"}"
  rel_dir="${rel_dir#/}"  # strip leading slash

  while IFS= read -r line || [[ -n "$line" ]]; do
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

    # Resolve relative to the directory containing this .sandboxignore
    if [[ -n "$rel_dir" ]]; then
      REL_PATH="$rel_dir/$line"
    else
      REL_PATH="$line"
    fi
    HOST_PATH="$REPO_PATH/$REL_PATH"
    CONTAINER_PATH="/workspace/$REL_PATH"

    if [[ -f "$HOST_PATH" ]]; then
      # Files: mount /dev/null over them (appears as empty file)
      VOLUMES+=(-v "/dev/null:$CONTAINER_PATH:ro")
      echo "  → Cloaked:   $REL_PATH (file)"
    elif [[ -d "$HOST_PATH" ]]; then
      # Directories: anonymous volume overlay (appears as empty dir)
      VOLUMES+=(-v "$CONTAINER_PATH")
      echo "  → Cloaked:   $REL_PATH (dir)"
    else
      echo "  → Not found: $REL_PATH (we ain't found shit)"
    fi
  done < "$ignore_file"
}

while IFS= read -r -d '' ignore_file; do
  process_sandboxignore "$ignore_file"
done < <(find "$REPO_PATH" -name .sandboxignore -not -path '*/.git/*' -not -path '*/.mrc/*' -not -path '*/node_modules/*' -print0 | sort -z)

# Persist Claude config between runs (per-repo to avoid cross-project contamination)
REPO_HASH="$(printf '%s' "$REPO_PATH" | md5sum | cut -c1-12)"

# Detect other mrc containers running against the same repo
EXISTING_COUNT=0
if docker ps --filter label=mrc=1 --filter "label=mrc.repo=$REPO_PATH" --format '{{.ID}}' 2>/dev/null | grep -q .; then
  EXISTING_COUNT="$(docker ps --filter label=mrc=1 --filter "label=mrc.repo=$REPO_PATH" --format '{{.ID}}' 2>/dev/null | wc -l | tr -d ' ')"
  echo ""
  echo "  ⚠ There's already ${EXISTING_COUNT} Mr. Claude running in this repo."
  echo "    They'll share the workspace but get separate config volumes."
  echo "    Watch out for edit conflicts — two Claudes, one codebase, no good."
  echo ""
fi

# Append instance number to volume name if another container is already running,
# and force a new session so it doesn't try to --continue the active one.
if [[ "$EXISTING_COUNT" -gt 0 ]]; then
  INSTANCE_ID="$((EXISTING_COUNT + 1))"
  VOLUME_NAME="mrc-config-${REPO_HASH}-${INSTANCE_ID}"
  if ! $NEW_SESSION && [[ -z "$RESUME_SESSION" ]]; then
    NEW_SESSION=true
  fi
else
  VOLUME_NAME="mrc-config-${REPO_HASH}"
fi
VOLUMES+=(-v "${VOLUME_NAME}:/home/coder/.claude")

# Find a free port starting from a base
find_free_port() {
  local port=$1
  while nc -z 127.0.0.1 "$port" 2>/dev/null || lsof -i :"$port" &>/dev/null 2>&1; do
    ((port++))
  done
  echo "$port"
}

# Start clipboard proxy if socat is available
CLIP_PORT="$(find_free_port "${MRC_PORT_BASE:-7722}")"
CLIP_PID=""
if command -v socat &>/dev/null; then
  bash "$SCRIPT_DIR/clipboard-proxy.sh" "$CLIP_PORT" 2>/dev/null &
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
NOTIFY_PORT="$(find_free_port $((CLIP_PORT + 1)))"
NOTIFY_PID=""
if [[ "$(uname -s)" == "Darwin" ]] && ! command -v terminal-notifier &>/dev/null; then
  echo "  ! terminal-notifier not found — install it for desktop notifications:"
  echo "    brew install terminal-notifier"
  NO_NOTIFY=true
fi
if ! $NO_NOTIFY && command -v socat &>/dev/null; then
  NOTIFY_PROXY_ARGS=("$NOTIFY_PORT")
  if $NO_SOUND; then
    NOTIFY_PROXY_ARGS+=(--no-sound)
  fi
  bash "$SCRIPT_DIR/notify-proxy.sh" "${NOTIFY_PROXY_ARGS[@]}" 2>/dev/null &
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
echo "  → Volume:    ${VOLUME_NAME}"
if [[ -n "${MRC_API_KEY:-}" ]]; then
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

# Finalize session env flags (must be after concurrent-instance detection)
if $NEW_SESSION; then
  ENV_FLAGS+=(-e NEW_SESSION=1)
fi

# Background session name generator — names the session while it's still running
if [[ -z "${NEW_SESSION_NAME:-}" ]] && ! $NO_SUMMARY && [[ -n "${MRC_API_KEY:-}" ]]; then
  (
    _SESSIONS="$SCRIPT_DIR/mrc-sessions"
    _MRC_DIR="$REPO_PATH/.mrc"
    _BEFORE="$BEFORE_SESSIONS"

    # For resumed sessions, name immediately if unnamed (transcript already exists)
    if [[ -d "$_MRC_DIR" ]]; then
      _LATEST="$(ls -t "$_MRC_DIR"/*.jsonl 2>/dev/null | head -1)"
      if [[ -n "$_LATEST" ]]; then
        _UUID="$(basename "$_LATEST" .jsonl)"
        ANTHROPIC_API_KEY="$MRC_API_KEY" python3 "$_SESSIONS" generate-name "$_MRC_DIR" "$_UUID" 2>/dev/null || true
      fi
    fi

    # For new sessions, wait for a new JSONL to appear and accumulate context
    for _i in $(seq 1 60); do
      sleep 5
      [[ -d "$_MRC_DIR" ]] || continue
      _AFTER="$(ls "$_MRC_DIR"/*.jsonl 2>/dev/null || true)"
      _NEW="$(comm -13 <(echo "$_BEFORE") <(echo "$_AFTER") | head -1)"
      if [[ -n "$_NEW" ]]; then
        # Wait for enough conversation (~10KB ≈ 3-5 exchanges)
        for _j in $(seq 1 60); do
          sleep 5
          _SIZE="$(wc -c < "$_NEW" 2>/dev/null || echo 0)"
          [[ "$_SIZE" -ge 10240 ]] && break
        done
        _UUID="$(basename "$_NEW" .jsonl)"
        ANTHROPIC_API_KEY="$MRC_API_KEY" python3 "$_SESSIONS" generate-name "$_MRC_DIR" "$_UUID" 2>/dev/null || true
        break
      fi
    done
  ) &
  NAME_WATCHER_PID=$!
fi

docker run --rm -it --init \
  --cap-add=NET_ADMIN \
  --cap-add=NET_RAW \
  --add-host=host.docker.internal:host-gateway \
  --label mrc=1 \
  --label "mrc.repo=$REPO_PATH" \
  --label "mrc.repo.name=$(basename "$REPO_PATH")" \
  --label "mrc.web=$ALLOW_WEB" \
  ${ENV_FLAGS[@]+"${ENV_FLAGS[@]}"} \
  "${VOLUMES[@]}" \
  "$IMAGE_NAME" \
  "$@" \
  && EXIT_CODE=0 || EXIT_CODE=$?

# Kill background name watcher if still running
if [[ -n "${NAME_WATCHER_PID:-}" ]]; then
  kill "$NAME_WATCHER_PID" 2>/dev/null || true
  wait "$NAME_WATCHER_PID" 2>/dev/null || true
fi

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

  # 2b. Auto-generate a descriptive name if none was set
  if [[ -z "${NEW_SESSION_NAME:-}" ]] && ! $NO_SUMMARY && [[ -n "${MRC_API_KEY:-}" ]]; then
    ANTHROPIC_API_KEY="$MRC_API_KEY" python3 "$SESSIONS" generate-name "$MRC_DIR" "$NEW_UUID"
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
  if ! $NO_SUMMARY && [[ -n "${MRC_API_KEY:-}" ]]; then
    ANTHROPIC_API_KEY="$MRC_API_KEY" python3 "$SESSIONS" summarize "$MRC_DIR" "$NEW_UUID" &
  fi
fi

# 5. Auto-name resumed sessions that are still unnamed
if [[ -z "$NEW_FILE" ]] && ! $NO_SUMMARY && [[ -n "${MRC_API_KEY:-}" ]] && [[ -d "$MRC_DIR" ]]; then
  LATEST_SESSION="$(ls -t "$MRC_DIR"/*.jsonl 2>/dev/null | head -1)"
  if [[ -n "$LATEST_SESSION" ]]; then
    LATEST_UUID="$(basename "$LATEST_SESSION" .jsonl)"
    ANTHROPIC_API_KEY="$MRC_API_KEY" python3 "$SCRIPT_DIR/mrc-sessions" generate-name "$MRC_DIR" "$LATEST_UUID"
  fi
fi

exit $EXIT_CODE
