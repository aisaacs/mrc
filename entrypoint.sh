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

# Seed plugins and config from build-time defaults into the persistent volume.
# Copies marketplace data and merges plugin settings without overwriting user changes.
DEFAULTS="$HOME/.claude-defaults"
if [ -d "$DEFAULTS" ]; then
  # Copy marketplace repo if not already present
  if [ -d "$DEFAULTS/plugins/marketplaces" ] && [ ! -d "$HOME/.claude/plugins/marketplaces" ]; then
    cp -a "$DEFAULTS/plugins" "$HOME/.claude/"
  fi

  # Merge enabledPlugins into settings.json (add defaults, keep user overrides)
  if [ -f "$DEFAULTS/settings.json" ]; then
    if [ ! -f "$HOME/.claude/settings.json" ]; then
      cp "$DEFAULTS/settings.json" "$HOME/.claude/settings.json"
    else
      # Merge: default plugins go in first, user overrides win
      node -e "
        const fs = require('fs');
        const d = JSON.parse(fs.readFileSync('$DEFAULTS/settings.json', 'utf8'));
        const c = JSON.parse(fs.readFileSync('$HOME/.claude/settings.json', 'utf8'));
        c.enabledPlugins = { ...d.enabledPlugins, ...c.enabledPlugins };
        fs.writeFileSync('$HOME/.claude/settings.json', JSON.stringify(c, null, 2) + '\n');
      "
    fi
  fi
fi

# Ensure the symlink target for .claude.json exists in the persistent volume
CONFIG_TARGET="$HOME/.claude/claude.json"
if [ ! -f "$CONFIG_TARGET" ]; then
  LATEST_BACKUP=$(ls -t "$HOME/.claude/backups/.claude.json.backup."* 2>/dev/null | head -1 || true)
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

# Store Claude's project memory in the repo itself (survives volume resets,
# travels with the project).  Claude Code uses ~/.claude/projects/-workspace/
# for /workspace paths.  We symlink that into /workspace/.mrc/ so the data
# lives in the bind-mounted repo.
MRC_LOCAL="/workspace/.mrc"
PROJECT_STORE="$HOME/.claude/projects/-workspace"
if [ ! -L "$PROJECT_STORE" ]; then
  mkdir -p "$MRC_LOCAL" "$(dirname "$PROJECT_STORE")"
  # Move any existing project data into the repo
  if [ -d "$PROJECT_STORE" ]; then
    cp -a "$PROJECT_STORE/." "$MRC_LOCAL/" 2>/dev/null || true
    rm -rf "$PROJECT_STORE"
  fi
  ln -sf "$MRC_LOCAL" "$PROJECT_STORE"
fi

# Seed .gitignore entry for .mrc/ if the repo uses git
if [ -d "/workspace/.git" ]; then
  if [ ! -f "/workspace/.gitignore" ] || ! grep -qxF '.mrc/' /workspace/.gitignore 2>/dev/null; then
    echo '.mrc/' >> /workspace/.gitignore
  fi
fi

# Session resume logic:
#   RESUME_SESSION=<uuid>  → resume that specific session
#   NEW_SESSION=1          → start fresh
#   otherwise              → continue most recent session if one exists
RESUME_FLAG=""
if [ -n "${RESUME_SESSION:-}" ]; then
  RESUME_FLAG="--resume $RESUME_SESSION"
elif [ "${NEW_SESSION:-}" != "1" ] && ls /workspace/.mrc/*.jsonl >/dev/null 2>&1; then
  RESUME_FLAG="--continue"
fi

# Configure notification hook if the proxy is running on the host
if [ -n "${MRC_NOTIFY_PORT:-}" ]; then
  SETTINGS_FILE="$HOME/.claude/settings.json"
  [ -f "$SETTINGS_FILE" ] || echo '{}' > "$SETTINGS_FILE"
  node -e "
    const fs = require('fs');
    const s = JSON.parse(fs.readFileSync('$SETTINGS_FILE', 'utf8'));
    s.hooks = s.hooks || {};
    s.hooks.Stop = [{
      matcher: '',
      hooks: [{
        type: 'command',
        command: '/usr/local/bin/mrc-notify-hook.sh'
      }]
    }];
    fs.writeFileSync('$SETTINGS_FILE', JSON.stringify(s, null, 2) + '\n');
  "
fi

echo "Launching Claude Code..."
claude --dangerously-skip-permissions $RESUME_FLAG "$@"
EXIT_CODE=$?
if [ $EXIT_CODE -ne 0 ]; then
  echo ""
  echo "Claude exited with code $EXIT_CODE"
  echo "Debug info:"
  echo "  Claude: $(claude --version 2>&1 || echo 'not found')"
  echo "  TERM: ${TERM:-unset}"
  echo "  TTY: $(tty 2>&1 || echo 'not a tty')"
  echo "  API key set: $([ -n "${ANTHROPIC_API_KEY:-}" ] && echo yes || echo no)"
fi
exit $EXIT_CODE