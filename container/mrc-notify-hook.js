#!/usr/bin/env node
//
// mrc-notify-hook — Container-side Claude Code hook handler.
// Reads hook JSON from stdin, extracts a summary, and sends it
// to the host notification proxy via TCP.
//
import { createConnection } from 'node:net'

// #22: no stale-literal fallback. #50 moved the notify proxy off 7723 (portBase+2 now), so `|| '7723'` would dial the
// WRONG (clip/relay) port on a missing env. A missing MRC_NOTIFY_PORT means the notify proxy isn't up → no-op, don't
// dial a stale port. The host always injects the real port when the proxy starts.
const PORT = process.env.MRC_NOTIFY_PORT
if (!PORT) process.exit(0)
const REPO = process.env.MRC_REPO_NAME || 'workspace'

function clean(s) {
  return String(s).replace(/[#*`[\]]/g, '').replace(/\n+/g, ' ').trim()
}

function trunc(s, max = 140) {
  return s.length > max ? s.substring(0, max) + '…' : s
}

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { input += chunk })
process.stdin.on('end', () => {
  let msg = 'Needs your attention'
  try {
    const h = JSON.parse(input)
    switch (h.hook_event_name) {
      case 'Stop':
        msg = trunc(clean(h.last_assistant_message || '')) || 'Done.'
        break
      case 'PermissionRequest':
        msg = h.tool_name ? `Needs approval: ${h.tool_name}` : 'Needs your approval'
        break
      case 'Notification':
        msg = h.message ? trunc(clean(h.message)) : 'Needs your attention'
        break
    }
  } catch {}

  // Send to host proxy: line 1 = repo, line 2 = summary
  const socket = createConnection({ host: 'host.docker.internal', port: Number(PORT) }, () => {
    socket.end(`${REPO}\n${msg}\n`)
  })
  socket.on('error', e => process.stderr.write(`notify-hook: ${e.message}\n`))
  // Don't hang the hook — force exit after 2s
  setTimeout(() => process.exit(0), 2000).unref()
})
