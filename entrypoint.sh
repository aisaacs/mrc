#!/bin/bash
set -euo pipefail
trap 'echo "FAILED at line $LINENO (exit code $?)" >&2' ERR

# Wait for network to be ready (Colima can be slow to warm up)
echo "Waiting for network..."
for i in $(seq 1 30); do
  if dig +short +timeout=1 api.anthropic.com >/dev/null 2>&1; then
    echo "Network ready after ${i}s"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "ERROR: Network not ready after 30 attempts"
    dig api.anthropic.com 2>&1 || true
    exit 1
  fi
  sleep 1
done

# Run firewall (must be bash + sudo — see init-firewall.sh)
sudo ALLOW_WEB="${ALLOW_WEB:-}" \
  MRC_CLIPBOARD_PORT="${MRC_CLIPBOARD_PORT:-7722}" \
  MRC_NOTIFY_PORT="${MRC_NOTIFY_PORT:-7723}" \
  MRC_ROOM_PORT="${MRC_ROOM_PORT:-}" \
  /usr/local/bin/init-firewall.sh

# All config setup is now in Node
node /usr/local/bin/container-setup.js

# Read the resume flag computed by container-setup.js
RESUME_FLAG=""
if [ -f /tmp/mrc-resume-flag ]; then
  RESUME_FLAG="$(cat /tmp/mrc-resume-flag)"
  rm -f /tmp/mrc-resume-flag
fi

if [ "${MRC_DAEMON:-}" = "1" ]; then
  echo "READY"
  exec tail -f /dev/null
fi

# Auto-login Codex if OPENAI_API_KEY is present (persists in ~/.codex/ volume)
if [ -n "${OPENAI_API_KEY:-}" ]; then
  printenv OPENAI_API_KEY | codex login --with-api-key 2>/dev/null || true
fi

AGENT="${MRC_AGENT:-claude}"
case "$AGENT" in
  claude)
    echo "Launching Claude Code..."
    if [ -n "${MRC_ROOM_PORT:-}" ]; then
      # Room session: load the channel server directly (no wrapper). Claude renders natively and
      # the user accepts the one-time dev-channel prompt manually. NO auto-accept — an injected
      # "1<Enter>" was dangerous (it could land on an unintended menu, e.g. trigger a compact).
      # Pin a stable conversation id for a NEW session (empty RESUME_FLAG) so rooms survive a later
      # resume; resume/continue keep their flag, which already targets the right conversation.
      SESSION_FLAG="$RESUME_FLAG"
      if [ -z "$RESUME_FLAG" ] && [ -n "${MRC_SESSION_ID:-}" ]; then
        SESSION_FLAG="--session-id ${MRC_SESSION_ID}"
      fi
      claude --dangerously-skip-permissions \
        --dangerously-load-development-channels server:room \
        --mcp-config /tmp/mrc-room-mcp.json $SESSION_FLAG "$@"
    else
      claude --dangerously-skip-permissions $RESUME_FLAG "$@"
    fi
    ;;
  codex)
    echo "Launching Codex..."
    codex --dangerously-bypass-approvals-and-sandbox "$@"
    ;;
  *)
    echo "Unknown agent: $AGENT"
    exit 1
    ;;
esac
EXIT_CODE=$?
if [ $EXIT_CODE -ne 0 ]; then
  echo ""
  echo "$AGENT exited with code $EXIT_CODE"
  echo "Debug info:"
  echo "  claude: $(claude --version 2>&1 || echo 'not found')"
  echo "  codex:  $(codex --version 2>&1 || echo 'not found')"
  echo "  TERM: ${TERM:-unset}"
  echo "  TTY: $(tty 2>&1 || echo 'not a tty')"
  echo "  ANTHROPIC_API_KEY set: $([ -n "${ANTHROPIC_API_KEY:-}" ] && echo yes || echo no)"
  echo "  OPENAI_API_KEY set: $([ -n "${OPENAI_API_KEY:-}" ] && echo yes || echo no)"
fi
exit $EXIT_CODE
