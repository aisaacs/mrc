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
    echo "DNS test:"
    dig api.anthropic.com 2>&1 || true
    echo "Route:"
    ip route 2>&1 || true
    exit 1
  fi
  sleep 1
done

sudo ALLOW_WEB="${ALLOW_WEB:-}" /usr/local/bin/init-firewall.sh

# Ensure the symlink target for .claude.json exists in the persistent volume
CONFIG_TARGET="$HOME/.claude/claude.json"
if [ ! -f "$CONFIG_TARGET" ]; then
  LATEST_BACKUP=$(ls -t "$HOME/.claude/backups/.claude.json.backup."* 2>/dev/null | head -1)
  if [ -n "$LATEST_BACKUP" ]; then
    echo "Restoring Claude config from backup..."
    cp "$LATEST_BACKUP" "$CONFIG_TARGET"
  fi
fi

# Skip onboarding prompt when API key is provided
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  if [ ! -s "$HOME/.claude.json" ]; then
    echo '{"hasCompletedOnboarding":true}' > "$HOME/.claude/claude.json"
  fi
fi

echo "Launching Claude Code..."
claude --dangerously-skip-permissions "$@"
EXIT_CODE=$?
if [ $EXIT_CODE -ne 0 ]; then
  echo ""
  echo "Claude exited with code $EXIT_CODE"
  echo "Debug info:"
  echo "  Node: $(node --version 2>&1 || echo 'not found')"
  echo "  Claude: $(claude --version 2>&1 || echo 'not found')"
  echo "  TERM: ${TERM:-unset}"
  echo "  TTY: $(tty 2>&1 || echo 'not a tty')"
  echo "  API key set: $([ -n "${ANTHROPIC_API_KEY:-}" ] && echo yes || echo no)"
fi
exit $EXIT_CODE