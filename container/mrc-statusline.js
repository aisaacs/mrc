#!/usr/bin/env node
//
// mrc-statusline — Context bar, rate limits, session name.
//
// Claude Code pipes a JSON blob to stdin on each refresh. We render:
//   [█████████░░░░░░░░░░░] 49% context · 5h 12% │ 7d 7% · my-session
//
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const BAR_WIDTH = 20
const COMPACT_THRESHOLD = 77  // Claude reserves ~15% for compaction
const WARN_THRESHOLD = 60

const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const DIM = '\x1b[2m'
const DIM_CYAN = '\x1b[2;36m'
const DIM_GREEN = '\x1b[2;32m'
const DIM_YELLOW = '\x1b[2;33m'
const DIM_RED = '\x1b[2;31m'
const RESET = '\x1b[0m'

function lookupSessionName(projectDir, sessionId) {
  if (!projectDir || !sessionId) return ''
  try {
    const lines = readFileSync(join(projectDir, '.mrc', 'session-names'), 'utf8').split('\n')
    for (const line of lines) {
      const eq = line.indexOf('=')
      if (eq > 0 && line.slice(0, eq) === sessionId) {
        return line.slice(eq + 1).trim()
      }
    }
  } catch {}
  return ''
}

function colorForPct(pct, dim) {
  if (pct >= COMPACT_THRESHOLD) return dim ? DIM_RED : RED
  if (pct >= WARN_THRESHOLD) return dim ? DIM_YELLOW : YELLOW
  return dim ? DIM_GREEN : GREEN
}

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { input += chunk })
process.stdin.on('end', () => {
  let data = {}
  try { data = JSON.parse(input) } catch {}

  // Context bar
  const ctx = data.context_window || {}
  const u = ctx.current_usage || {}
  // #caffeine: a FINE, monotonic token count (input + cache) for the daemon's liveness signal — per-turn
  // resolution. The floored integer percent below only moves every ~2000 tokens (1% of a 200k window), so it's
  // blind to a normal small turn; the raw token total grows on every turn and never masquerades an idle window.
  const totalTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
  let pct = ctx.used_percentage
  if (pct == null) {
    const size = ctx.context_window_size || 200_000
    pct = size ? Math.min(100, Math.floor(totalTokens * 100 / size)) : 0
  }
  pct = Math.min(100, Math.floor(pct))
  const filled = Math.floor(pct * BAR_WIDTH / 100)
  const bar = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled)
  const barColor = colorForPct(pct, false)

  // Rate limits
  const limits = data.rate_limits || {}
  const limitParts = []
  for (const [key, label] of [['five_hour', '5h'], ['seven_day', '7d']]) {
    const bucket = limits[key]
    if (bucket) {
      const lp = Math.floor(bucket.used_percentage || 0)
      limitParts.push(`${DIM_CYAN}${label}${RESET} ${colorForPct(lp, true)}${lp}%${RESET}`)
    }
  }

  // Session name
  const projectDir = (data.workspace || {}).project_dir || ''
  const name = lookupSessionName(projectDir, data.session_id || '')

  // #64: tee the parsed ints to a container-local file. The channel server forwards them to the host daemon
  // (transport B') for the dashboard's per-agent context bar + lead-only rate-limit rail. Numbers, not strings
  // (the daemon strict-validates). Best-effort — a write failure never affects the rendered statusline.
  try {
    const ratePct = (k) => { const b = limits[k]; return b ? Math.floor(b.used_percentage || 0) : null }
    writeFileSync(process.env.MRC_STATUS_FILE || '/tmp/mrc-status.json',
      JSON.stringify({ context: pct, tokens: totalTokens, fiveHour: ratePct('five_hour'), sevenDay: ratePct('seven_day'), name, at: Date.now() }))
  } catch {}

  // Assemble
  const parts = [`${barColor}[${bar}] ${pct}% context${RESET}`]
  if (limitParts.length) parts.push(limitParts.join(` ${DIM}│${RESET} `))
  if (name) parts.push(`${DIM}${name}${RESET}`)

  process.stdout.write(parts.join(' · '))
})
