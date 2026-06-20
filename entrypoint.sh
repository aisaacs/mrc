#!/bin/bash
set -euo pipefail
trap 'echo "FAILED at line $LINENO (exit code $?)" >&2' ERR

# C/#38: the container now starts as ROOT. The ROOT PASS (this block) waits for the network and applies the
# firewall — which needs NET_ADMIN — then drops to the unprivileged `coder` user via gosu and re-execs THIS
# script. Everything BELOW the block (config setup, Codex login, the agent) runs as `coder`, byte-for-byte as
# it did when the container started as coder — so normal sessions are unchanged (same file ownership, HOME,
# login). What changes: a sandboxed session can no longer invoke or weaken its own firewall (coder has no
# sudo at all). The old `sudo init-firewall.sh` escape hatch is gone.
if [ "$(id -u)" = "0" ]; then
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

  # Apply the firewall AS ROOT (no sudo — the coder grant is gone). init-firewall.sh pins the cage profile
  # into a root-owned file, so it's immutable for the rest of the container's life.
  ALLOW_WEB="${ALLOW_WEB:-}" \
    MRC_ADVERSARY_FW="${MRC_ADVERSARY_FW:-}" \
    MRC_CLIPBOARD_PORT="${MRC_CLIPBOARD_PORT:-7722}" \
    MRC_NOTIFY_PORT="${MRC_NOTIFY_PORT:-7723}" \
    MRC_ROOM_PORT="${MRC_ROOM_PORT:-}" \
    /usr/local/bin/init-firewall.sh

  # Drop to coder for everything else. Pin HOME/USER/LOGNAME (gosu does NOT set them) so config setup and the
  # agent resolve coder's home + config volume, not root's.
  export HOME=/home/coder USER=coder LOGNAME=coder
  exec gosu coder "$0" "$@"
fi

# ===== coder pass (unprivileged) — config setup + agent, unchanged from the pre-root-init flow =====
# C/#38 fail-closed: we only get here (as coder) AFTER the root pass ran the firewall, which writes a
# root-owned /etc/mrc-cage-profile. If that file is absent, the firewall never ran (e.g. the container was
# started non-root by some future path / a debug `docker run --user`) — refuse to launch the agent with
# un-firewalled network. (Spine 2: fail closed on the absence of proof the firewall applied.)
if [ ! -f /etc/mrc-cage-profile ]; then
  echo "FATAL: firewall did not run (no /etc/mrc-cage-profile) — refusing to start the agent unprotected." >&2
  exit 1
fi

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
      # Room/crew session: load the channel from the baked-in `mrc` plugin marketplace. It's
      # allowlisted in /etc/claude-code/managed-settings.json, so `--channels plugin:room@mrc` loads
      # the channel with NO experimental-channel prompt (container-setup.js registered the plugin into
      # this volume). Pin a stable conversation id for a NEW session (empty RESUME_FLAG) so rooms
      # survive a later resume; resume/continue keep their flag, which already targets the right one.
      SESSION_FLAG="$RESUME_FLAG"
      if [ -z "$RESUME_FLAG" ] && [ -n "${MRC_SESSION_ID:-}" ]; then
        SESSION_FLAG="--session-id ${MRC_SESSION_ID}"
      fi
      claude --dangerously-skip-permissions \
        --channels plugin:room@mrc $SESSION_FLAG "$@"
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
