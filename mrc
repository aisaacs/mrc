#!/usr/bin/env bash
#
# mrc — Mister Claude
# Launch Claude Code in a sandboxed Docker container with network firewall.
#
# Usage:
#   mrc [options] [path-to-repo] [-- claude-code-args...]
#
# Options:
#   -v, --verbose  Show Colima and Docker output (useful for debugging)
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
    ((i++))
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
args=()
for arg in "$@"; do
  case "$arg" in
    --verbose|-v) VERBOSE=true ;;
    *) args+=("$arg") ;;
  esac
done
set -- "${args[@]+"${args[@]}"}"

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

# Ensure Colima is running
STARTED_COLIMA=false
if command -v colima &>/dev/null; then
  # Point docker at Colima's socket if not already configured
  if [[ -z "${DOCKER_HOST:-}" ]]; then
    export DOCKER_HOST="unix://${HOME}/.colima/default/docker.sock"
  fi
  if ! colima status &>/dev/null 2>&1; then
    echo "🎩 Preparing ship for Ludicrous Speed..."
    colima start --vm-type vz --mount-type virtiofs --cpu 4 --memory 8 2>"$QUIET" &
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

# Stop Colima on exit if we started it
if $STARTED_COLIMA; then
  trap "echo ''; echo '🎩 Goodbye, Lone Starr.'; colima stop 2>\"$QUIET\"" EXIT
fi

# Build image if needed (--no-cache when image is missing so npm pulls fresh)
echo "  ◎ Mr. Radar is scanning the environment..."
USER_UID="$(id -u)"
USER_GID="$(id -g)"

BUILD_FLAGS=(-q --build-arg "USER_UID=$USER_UID" --build-arg "USER_GID=$USER_GID")
if ! docker image inspect "$IMAGE_NAME" &>/dev/null; then
  BUILD_FLAGS+=(--no-cache)
fi

docker build "${BUILD_FLAGS[@]}" \
  -t "$IMAGE_NAME" \
  "$SCRIPT_DIR" > /dev/null 2>"$QUIET"

echo "  ✓ Radar locked."

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

# Persist Claude config between runs
VOLUMES+=(-v "mister-claude-config:/home/coder/.claude")

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
if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "  → Schwartz:  engaged (API key)"
else
  echo "  → Schwartz:  I see your Schwartz is as big as mine... you DO have a subscription, right?"
fi
echo "  → Firewall:  jammed (just like their radar)"
echo ""

docker run --rm -it --init \
  --cap-add=NET_ADMIN \
  --cap-add=NET_RAW \
  ${ENV_FLAGS[@]+"${ENV_FLAGS[@]}"} \
  "${VOLUMES[@]}" \
  "$IMAGE_NAME" \
  "$@"
