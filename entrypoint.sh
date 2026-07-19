#!/bin/bash
set -euo pipefail
trap 'echo "FAILED at line $LINENO (exit code $?)" >&2' ERR

# ROOT PASS (C/#38): the container starts as root (Dockerfile `USER root`). Wait for the network, run the
# firewall as root — NO sudo; coder has no sudo, so a sandboxed session can't re-run it to weaken its cage —
# then re-exec this script as the unprivileged `coder` user for everything else. A caged adversary carries
# MRC_ADVERSARY_FW / MRC_SNI_PROXY_PORT, which init-firewall.sh honors (empty allowlist + SNI-proxy egress).
if [ "$(id -u)" = "0" ]; then
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

  ALLOW_WEB="${ALLOW_WEB:-}" \
    MRC_ADVERSARY_FW="${MRC_ADVERSARY_FW:-}" \
    MRC_CLIPBOARD_PORT="${MRC_CLIPBOARD_PORT:-}" \
    MRC_NOTIFY_PORT="${MRC_NOTIFY_PORT:-}" \
    MRC_ROOM_PORT="${MRC_ROOM_PORT:-}" \
    MRC_SNI_PROXY_PORT="${MRC_SNI_PROXY_PORT:-}" \
    /usr/local/bin/init-firewall.sh

  # Repair legacy root-owned files in the Codex volume, while we still have root. The Dockerfile chowns
  # /home/coder/.codex at BUILD time, but a persisted mrc-codex-<hash> volume shadows that — so rollouts
  # written back when the container ran as root stay root-owned forever. Everything under ~/.codex is
  # meant to be coder's, so any other owner is a legacy artifact. This matters because container-setup.js
  # migrates that tree into the repo, and an unreadable file there is not a soft failure: Node's cpSync
  # ABORTS THE PROCESS (an uncatchable std::filesystem throw) on an unreadable directory. `find ... ! -user`
  # touches only mismatched entries, so it's a no-op on a healthy volume.
  if [ -d /home/coder/.codex ]; then
    find /home/coder/.codex ! -user coder -exec chown coder:coder {} + 2>/dev/null || true
  fi

  export HOME=/home/coder USER=coder LOGNAME=coder
  exec gosu coder "$0" "$@"
fi

# CODER PASS (unprivileged). Fail CLOSED if the firewall never ran — /etc/mrc-cage-profile is init-firewall's
# first act, so its absence means we somehow reached here unprotected. Never start the agent without the cage.
if [ ! -f /etc/mrc-cage-profile ]; then
  echo "FATAL: firewall did not run (no /etc/mrc-cage-profile) — refusing to start the agent unprotected." >&2
  exit 1
fi

# All config setup is now in Node
node /usr/local/bin/container-setup.js

# One-shot worker turn (task-worker member): run the backend non-interactively on the prompt file and
# print its output (captured by the host runWorkerExec). No interactive TTY, no channel. The prompt is
# read from a file so backticks/$ in it are not re-evaluated by the shell.
if [ -n "${MRC_EXEC_PROMPT_FILE:-}" ] && [ -f "${MRC_EXEC_PROMPT_FILE}" ]; then
  echo "===MRC-WORKER-OUTPUT-START==="
  case "${MRC_AGENT:-codex}" in
    codex)  codex exec --dangerously-bypass-approvals-and-sandbox "$(cat "${MRC_EXEC_PROMPT_FILE}")" 2>&1 || true ;;
    claude) claude --dangerously-skip-permissions -p "$(cat "${MRC_EXEC_PROMPT_FILE}")" 2>&1 || true ;;
    *)      echo "[worker backend '${MRC_AGENT:-}' is not installed in this image]" ;;
  esac
  echo "===MRC-WORKER-OUTPUT-END==="
  exit 0
fi

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

# --- Codex auth (persists in the mrc-codex-<hash> volume) ---------------------------------------
# Two mutually exclusive paths write the SAME ~/.codex/auth.json:
#   OPENAI_API_KEY      → pay-as-you-go platform org billing (a company account)
#   --device-auth       → a personal ChatGPT Plus/Pro/Team subscription's own limits
# An API key can NEVER draw on a subscription, so re-running --with-api-key on every boot would
# silently downgrade a subscription login back to platform billing (and to its "Quota exceeded" if
# that org has no credits). Hence: only ever act when there is NO existing login.
if ! codex login status >/dev/null 2>&1; then
  if [ -n "${OPENAI_API_KEY:-}" ]; then
    if ! printenv OPENAI_API_KEY | codex login --with-api-key 2>/dev/null; then
      echo "FATAL: Codex API-key login failed — refusing to launch unauthenticated." >&2
      exit 1
    fi
  elif [ "${MRC_AGENT:-claude}" = "codex" ]; then
    # No key and Codex is the agent being launched: drive the subscription flow now, before the TUI
    # takes over stdin (its prompt box sends `codex login` to the MODEL, not to a shell). --device-auth
    # prints a code to enter in a HOST browser — the plain flow's localhost:1455 callback is
    # unreachable from inside the container.
    echo ""
    echo "  ⚠ No OpenAI credentials found — may the Schwartz be with you."
    echo ""
    echo "  Linking a ChatGPT subscription (Plus/Pro/Team). Open the URL below on your host."
    echo "  Prefer platform API billing instead? Ctrl-C, then put OPENAI_API_KEY in your .env."
    echo ""
    if ! codex login --device-auth; then
      echo "FATAL: Codex device authentication was cancelled or failed — not launching Codex." >&2
      exit 1
    fi
  fi
fi

AGENT="${MRC_AGENT:-claude}"
case "$AGENT" in
  claude)
    echo "Launching Claude Code..."
    # Build the --append-system-prompt content ONCE: a team member's persona (role + protocol) AND/OR a
    # downgrade notice. Gap-(b): a resume with no persisted transcript (a pre-fix vaporized record) downgrades to
    # a fresh session, and container-setup.js drops /tmp/mrc-session-note — a first-turn notice for the agent to
    # relay so the human SEES they got a clean start IN-SESSION, not just in boot stderr that scrolls away.
    # Read the persona from a FILE so backticks/$ in it are not re-evaluated by the shell ($(cat …) is not rescanned).
    APPEND_SYSTEM=""
    if [ -n "${MRC_PERSONA_FILE:-}" ] && [ -f "${MRC_PERSONA_FILE}" ]; then
      APPEND_SYSTEM="$(cat "${MRC_PERSONA_FILE}")"
    fi
    if [ -f /tmp/mrc-session-note ]; then
      MRC_NOTE="$(cat /tmp/mrc-session-note)"; rm -f /tmp/mrc-session-note
      if [ -n "$APPEND_SYSTEM" ]; then
        APPEND_SYSTEM="$APPEND_SYSTEM

$MRC_NOTE"
      else
        APPEND_SYSTEM="$MRC_NOTE"
      fi
    fi
    if [ -n "${MRC_ROOM_PORT:-}" ]; then
      # Room/crew session: load the channel from the baked-in `mrc` plugin marketplace. It's allowlisted
      # in /etc/claude-code/managed-settings.json, so `--channels plugin:room@mrc` loads the channel with
      # NO experimental-channel prompt (container-setup.js registered the plugin into this volume).
      # Pin a stable conversation id for a NEW session (empty RESUME_FLAG) so rooms survive a later
      # resume; resume/continue keep their flag, which already targets the right conversation.
      SESSION_FLAG="$RESUME_FLAG"
      if [ -z "$RESUME_FLAG" ] && [ -n "${MRC_SESSION_ID:-}" ]; then
        SESSION_FLAG="--session-id ${MRC_SESSION_ID}"
      fi
      if [ -n "$APPEND_SYSTEM" ]; then
        claude --dangerously-skip-permissions \
          --channels plugin:room@mrc \
          --append-system-prompt "$APPEND_SYSTEM" $SESSION_FLAG "$@"
      else
        claude --dangerously-skip-permissions \
          --channels plugin:room@mrc $SESSION_FLAG "$@"
      fi
    elif [ -n "$APPEND_SYSTEM" ]; then
      claude --dangerously-skip-permissions --append-system-prompt "$APPEND_SYSTEM" $RESUME_FLAG "$@"
    else
      claude --dangerously-skip-permissions $RESUME_FLAG "$@"
    fi
    ;;
  codex)
    # $RESUME_FLAG is a SUBCOMMAND here (`resume --last` / `resume <id>`), not an option like Claude's
    # `--resume <id>` — it must therefore come BEFORE the options, hence the unquoted expansion first.
    # container-setup.js only emits it after confirming a matching rollout exists, so this can't invoke
    # `codex resume` on an empty store (a hard startup failure).
    # Name the target rather than just "resuming": if auto-resume ever misbehaves again, this line alone
    # says which session container-setup picked. It does NOT claim why a fresh session started — the
    # reason (asked for --new, vs nothing found) is container-setup's to report, and it logs the store
    # state above; saying "none found" here was wrong whenever the human passed --new.
    if [ -n "$RESUME_FLAG" ]; then
      echo "Launching Codex (resuming ${RESUME_FLAG#resume })..."
    else
      echo "Launching Codex (new session)..."
    fi
    codex $RESUME_FLAG --dangerously-bypass-approvals-and-sandbox "$@"
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
