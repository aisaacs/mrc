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

# #5 per-UUID COEXIST FLOOR (store-mode only): lock the specific CONVERSATION this session resumes, NOT the whole
# slice — /mrc/<MRC_SESSION_ID>.lock. flock is advisory on the shared bind-mounted inode, so it serializes ACROSS
# containers, and it auto-releases when this container dies (kernel closes the fd → no stale lock, no reaping). Two
# same-repo sessions on DIFFERENT conversations hold DIFFERENT lock files → they COEXIST; only a genuine
# same-conversation double-open contends and is REFUSED (two containers on one transcript is the one thing that truly
# corrupts a single file). The host normally routes a bare launch to a free conversation before we reach here; this
# is the TOCTOU backstop. Shared project /memory is NOT covered by a per-conversation lock — that's the owner-accepted
# residual (Claude Code doesn't lock its own memory writes). Adversaries never mount /mrc, so this never touches them.
if [ -d /mrc ]; then
  # FAIL-LOUD if the primitive is missing: the floor's correctness DEPENDS on flock, so a missing binary must
  # abort, never run the session unguarded (no-silent-failure doctrine). flock is util-linux (Dockerfile), present.
  command -v flock >/dev/null 2>&1 || {
    echo "FATAL: flock(1) is missing from this image, but store-mode requires it to prevent concurrent" >&2
    echo "       memory-store corruption. Refusing to start unguarded (rebuild the image with util-linux)." >&2
    exit 1
  }
  # Per-conversation lock. If MRC_SESSION_ID is somehow unset in store-mode (shouldn't happen — the host always
  # resolves a concrete id), fall back to the whole-slice lock: conservative (serializes everything), never unguarded.
  LOCKFILE="/mrc/${MRC_SESSION_ID:-.writer}.lock"
  exec 200>"$LOCKFILE"
  # LOAD-BEARING: fd 200 is held by THIS shell process, and the agent below runs as a CHILD (NOT `exec claude`), so
  # the shell stays alive as the authoritative fd-200 holder for the whole session — the child's own fd hygiene
  # (a native binary may closefrom() on startup) can't drop the lock. If anyone ever converts the interactive agent
  # launch to `exec claude` (replacing this shell), claude becomes the SOLE fd-200 holder and closing it would
  # SILENTLY drop the writer lock mid-session → the exact silent co-write this guard exists to stop. Keep it a child.
  # Gate the agent on a POSITIVE flock-acquired. `flock -n` exits 0 iff WE now own the lock; ANY non-zero (a live
  # peer holds it, or an error) fails CLOSED → refuse, never fall through to the agent unlocked.
  if flock -n 200; then
    : # acquired — this container owns THIS conversation; fd 200 stays open across the exec below → held for its life
  elif [ "${MRC_RESUME_IS_AUTO:-}" = "1" ]; then
    # #5 TOCTOU on an AUTO-continue: the conversation the host resolved was FREE at the host check but got claimed
    # in the sub-second before this flock (the owner's near-simultaneous multi-launch makes this more likely). Auto-
    # continue must never hard-fail cryptically — the human/automation re-runs; the host's held-check then routes to a
    # free conversation (which can't re-loop: if ALL are held, auto→FRESH, an uncontended id). We do NOT silently
    # re-mint an id here: an auto-continue is almost always a room session, and re-minting MRC_SESSION_ID mid-container
    # would desync the daemon registration the host already pinned. Exit 69 (EX_UNAVAILABLE, retry-able) so a
    # non-interactive wrapper AUTO-retries; friendly prose only on a TTY (Pierre — same split as the explicit path).
    if [ -t 2 ]; then
      echo "  ! mrc: your most recent conversation was just opened by another session (a rare timing overlap)." >&2
      echo "     Re-run \`mrc <this repo>\` — I'll continue a different conversation automatically." >&2
    else
      echo "mrc: this conversation was just claimed by another session — retry (auto-continue routes to a free one)." >&2
    fi
    exit 69
  else
    # An EXPLICIT resume/pick of a held conversation (or an unset-auto path) → hard refuse; they asked for THIS one.
    echo "FATAL: this conversation (${MRC_SESSION_ID:-slice}) is already open in another live mrc session." >&2
    echo "       Two sessions resuming one conversation corrupt its transcript. Close the other session, or open a" >&2
    echo "       different conversation." >&2
    exit 1
  fi
fi

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

# Auto-login Codex if OPENAI_API_KEY is present (persists in ~/.codex/ volume)
if [ -n "${OPENAI_API_KEY:-}" ]; then
  printenv OPENAI_API_KEY | codex login --with-api-key 2>/dev/null || true
fi

AGENT="${MRC_AGENT:-claude}"
case "$AGENT" in
  claude)
    echo "Launching Claude Code..."
    # NB: claude runs as a CHILD of this shell (never `exec claude`) — this is LOAD-BEARING for the #5 /mrc writer
    # lock (fd 200, opened above): the shell must stay alive as the fd holder for the whole session. Do not exec.
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
