#!/usr/bin/env node
//
// mrc-notify-hook — Container-side hook handler for BOTH agents.
// Extracts a summary from the agent's hook payload and sends it to the host notification proxy over TCP.
//
// The two agents deliver that payload differently, so this reads either:
//   Claude Code  — hook JSON on STDIN,  event in `hook_event_name`, text in `last_assistant_message`
//   Codex        — hook JSON as the LAST ARGV (its legacy `notify` contract), event in `type`
//                  (only ever `agent-turn-complete`), text in `last-assistant-message` (HYPHENS)
// Codex's legacy `notify` is used rather than its newer [hooks] table because [hooks] sits behind a
// trust gate that silently no-ops unless every launch passes --dangerously-bypass-hook-trust.
//
import { createConnection } from 'node:net'

function clean(s) {
  return String(s).replace(/[#*`[\]]/g, '').replace(/\n+/g, ' ').trim()
}

function trunc(s, max = 140) {
  return s.length > max ? s.substring(0, max) + '…' : s
}

/** Turn either agent's payload into the summary line. Pure — exported for tests. */
export function summarize(h) {
  if (!h || typeof h !== 'object') return 'Needs your attention'
  // Codex has ONE event, and it means what Claude's Stop means: the turn is over and the agent is now
  // waiting on you. (Codex exposes no distinct idle/waiting event — agent-turn-complete IS that signal.)
  if (h.type === 'agent-turn-complete') {
    return trunc(clean(h['last-assistant-message'] || '')) || 'Done.'
  }
  switch (h.hook_event_name) {
    case 'Stop':
      return trunc(clean(h.last_assistant_message || '')) || 'Done.'
    case 'PermissionRequest':
      return h.tool_name ? `Needs approval: ${h.tool_name}` : 'Needs your approval'
    case 'Notification':
      return h.message ? trunc(clean(h.message)) : 'Needs your attention'
  }
  return 'Needs your attention'
}

/** Codex passes the payload as the last argv; Claude writes it to stdin. Returns null for the stdin case. */
export function payloadFromArgv(argv) {
  const last = argv[argv.length - 1]
  if (!last || !String(last).trimStart().startsWith('{')) return null
  try { return JSON.parse(last) } catch { return null }
}

function send(port, repo, msg) {
  // Send to host proxy: line 1 = repo, line 2 = summary
  const socket = createConnection({ host: 'host.docker.internal', port: Number(port) }, () => {
    socket.end(`${repo}\n${msg}\n`)
  })
  socket.on('error', e => process.stderr.write(`notify-hook: ${e.message}\n`))
  // Don't hang the hook — force exit after 2s
  setTimeout(() => process.exit(0), 2000).unref()
}

// Only run the I/O when invoked as the hook; importing this module (tests) must have no side effects.
if (process.argv[1] && /mrc-notify-hook\.js$/.test(process.argv[1])) {
  // #22: no stale-literal fallback. #50 moved the notify proxy off 7723 (portBase+2 now), so `|| '7723'` would dial the
  // WRONG (clip/relay) port on a missing env. A missing MRC_NOTIFY_PORT means the notify proxy isn't up → no-op, don't
  // dial a stale port. The host always injects the real port when the proxy starts.
  const PORT = process.env.MRC_NOTIFY_PORT
  if (!PORT) process.exit(0)
  const REPO = process.env.MRC_REPO_NAME || 'workspace'

  // Check argv FIRST: Codex gives the hook no stdin at all, so waiting on 'end' would stall until the
  // 2s timer and then send nothing.
  const fromArgv = payloadFromArgv(process.argv)
  if (fromArgv) {
    send(PORT, REPO, summarize(fromArgv))
  } else {
    let input = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => { input += chunk })
    process.stdin.on('end', () => {
      let payload = null
      try { payload = JSON.parse(input) } catch {}
      send(PORT, REPO, summarize(payload))
    })
  }
}
