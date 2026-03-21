#!/bin/bash
# mrc-notify-hook.sh — Container-side Stop hook handler.
# Reads Claude Code's Stop hook JSON from stdin, extracts a summary,
# and sends it to the host notification proxy.
set -euo pipefail

PORT="${MRC_NOTIFY_PORT:-7723}"
REPO="${MRC_REPO_NAME:-workspace}"

# Extract and truncate the last assistant message from hook JSON
SUMMARY=$(node -e "
  let d = '';
  process.stdin.on('data', c => d += c);
  process.stdin.on('end', () => {
    try {
      const h = JSON.parse(d);
      let msg = (h.last_assistant_message || '').trim();
      // Strip markdown formatting for cleaner notification
      msg = msg.replace(/[#*\`\[\]]/g, '').replace(/\n+/g, ' ').trim();
      if (msg.length > 140) msg = msg.substring(0, 140) + '…';
      console.log(msg || 'Done.');
    } catch(e) { console.log('Done.'); }
  });
" 2>/dev/null || echo "Done.")

# Protocol: line 1 = repo name, line 2 = summary
printf '%s\n%s\n' "$REPO" "$SUMMARY" \
  | socat - "TCP:host.docker.internal:${PORT},connect-timeout=2" 2>/dev/null || true
