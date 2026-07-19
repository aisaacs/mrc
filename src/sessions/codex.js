// Host-side reader for CODEX sessions ("rollouts").
//
// Codex records each conversation as an append-only JSONL rollout under ~/.codex/sessions, nested by
// date (…/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl). ~/.codex is a per-repo Docker VOLUME, so the host
// can't see any of it — container-setup.js therefore symlinks ~/.codex/sessions →
// /workspace/.mrc/codex-sessions, exactly the project-local-memory trick already used for Claude's
// project store. That symlink is what makes this module possible: everything below reads the repo,
// never the volume.
//
// The rollout schema is Codex's internal format, not a published contract, so every field here is
// read DEFENSIVELY — an unrecognized shape degrades a row (no title, no preview) but never throws and
// never drops the session, because the uuid alone is enough to `codex resume <uuid>`.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Where container-setup.js parks the ~/.codex/sessions symlink target, relative to <repo>/.mrc. */
export const CODEX_SESSIONS_DIR = 'codex-sessions'

const ROLLOUT_RE = /^rollout-.*\.jsonl$/
const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i

// Codex opens every conversation with synthetic user turns (environment context, user instructions,
// injected AGENTS.md). They'd make every preview identical, so skip anything that is just a tag block.
const SYNTHETIC_RE = /^\s*<(environment_context|user_instructions|user_environment|instructions)[\s>]/i

/** Recursively collect rollout files. Depth-capped: the layout is YYYY/MM/DD, so 4 is already slack. */
function collectRollouts(dir, depth = 0, out = []) {
  if (depth > 4) return out
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) collectRollouts(full, depth + 1, out)
    else if (e.isFile() && ROLLOUT_RE.test(e.name)) out.push(full)
  }
  return out
}

/** Pull display text out of a rollout record, whichever of the two shapes Codex used. */
function textOf(payload) {
  if (!payload || typeof payload !== 'object') return ''
  // event_msg → { type: 'user_message', message: '...' }
  if (typeof payload.message === 'string') return payload.message
  // response_item → { type: 'message', role: 'user', content: [{ type: 'input_text', text: '...' }] }
  if (Array.isArray(payload.content)) {
    return payload.content.map(c => (c && typeof c.text === 'string' ? c.text : '')).join(' ').trim()
  }
  return ''
}

/**
 * Parse one rollout into a session row, or null if it isn't usable.
 *
 * `interactiveOnly` mirrors what `codex resume --last` does by default: exclude non-interactive
 * sessions. That matters here because `mrc team exec` runs task-worker turns (`codex exec`) against
 * the SAME repo, and those rollouts would otherwise flood the picker with one-shot worker turns.
 */
function parseRollout(file, { interactiveOnly = true } = {}) {
  let raw
  try { raw = readFileSync(file, 'utf8') } catch { return null }

  let uuid = ''
  let title = ''
  let preview = ''
  let metaTs = ''
  let originator = ''

  for (const line of raw.split('\n')) {
    if (!line) continue
    let obj
    try { obj = JSON.parse(line) } catch { continue }
    const p = obj.payload || {}

    if (obj.type === 'session_meta' || p.id || p.originator) {
      if (!uuid && typeof p.id === 'string') uuid = p.id
      if (!metaTs && typeof p.timestamp === 'string') metaTs = p.timestamp
      if (!originator && typeof p.originator === 'string') originator = p.originator
    }
    // Codex generates its own session title and may emit it AFTER the opening meta record, so take the
    // last non-empty one rather than stopping at the first — that's the freshest label it settled on.
    if (typeof p.title === 'string' && p.title.trim()) title = p.title.trim()
    if (!preview) {
      const isUser = p.role === 'user' || p.type === 'user_message'
      if (isUser) {
        const t = textOf(p)
        if (t && !SYNTHETIC_RE.test(t)) preview = t.slice(0, 200).replace(/\s+/g, ' ')
      }
    }
  }

  // Fall back to the uuid embedded in the filename — a rollout whose meta record is missing or
  // truncated is still perfectly resumable, so losing it to a strict parse would be the worse bug.
  if (!uuid) uuid = (file.match(UUID_RE) || [])[1] || ''
  if (!uuid) return null
  if (interactiveOnly && originator && originator.includes('exec')) return null

  let mtimeMs = 0
  try { mtimeMs = statSync(file).mtimeMs } catch {}
  const recencyMs = Math.max(mtimeMs, Date.parse(metaTs) || 0)

  return {
    uuid,
    file,
    title,
    preview,
    recencyMs,
    lastUpdated: recencyMs ? new Date(recencyMs).toISOString() : '',
  }
}

/**
 * Codex sessions for a repo, newest-first — the codex-side counterpart of getSessions().
 * `mrcDir` is <repo>/.mrc, so callers pass the same path they already use for Claude.
 */
export function getCodexSessions(mrcDir, opts = {}) {
  const root = join(mrcDir, CODEX_SESSIONS_DIR)
  const rows = []
  const seen = new Set()
  for (const f of collectRollouts(root)) {
    const row = parseRollout(f, opts)
    // Dedup on uuid: a forked/copied rollout can repeat one, and resuming is keyed on uuid alone.
    if (row && !seen.has(row.uuid)) { seen.add(row.uuid); rows.push(row) }
  }
  rows.sort((a, b) => b.recencyMs - a.recencyMs)
  return rows
}

/** True if this repo has any resumable Codex session (drives `mrc pick`'s empty-state message). */
export function hasCodexSessions(mrcDir) {
  return getCodexSessions(mrcDir).length > 0
}

/**
 * Resolve a list number, uuid (or uuid prefix), or title substring to a Codex session uuid.
 * Same precedence as the Claude-side resolve(), over the same order the picker shows.
 */
export function resolveCodexSession(mrcDir, query) {
  const sessions = getCodexSessions(mrcDir)
  if (!query) return null

  const idx = parseInt(query, 10)
  if (!isNaN(idx) && String(idx) === String(query).trim() && idx >= 1 && idx <= sessions.length) {
    return sessions[idx - 1].uuid
  }
  for (const s of sessions) if (s.uuid === query) return s.uuid
  for (const s of sessions) if (s.title && s.title === query) return s.uuid
  const q = query.toLowerCase()
  for (const s of sessions) if (s.uuid.startsWith(q)) return s.uuid
  for (const s of sessions) if (s.title && s.title.toLowerCase().includes(q)) return s.uuid
  return null
}

/** Print the Codex session list — the `mrc sessions ls --agent codex` counterpart of listSessions(). */
export function listCodexSessions(mrcDir) {
  const sessions = getCodexSessions(mrcDir)
  if (!sessions.length) {
    console.log(`No Codex sessions found in ${join(mrcDir, CODEX_SESSIONS_DIR)}`)
    console.log('(Codex sessions appear here after you run `mrc --agent codex` at least once.)')
    return
  }
  const fmt = (ts) => { try { return new Date(ts).toISOString().replace('T', ' ').slice(0, 19) } catch { return '' } }
  console.log(`  ${'#'.padEnd(5)} ${'Last Used'.padEnd(22)} ${'Title'.padEnd(40)} Preview`)
  console.log(`  ${'—'.padEnd(5)} ${'—————————'.padEnd(22)} ${'—————'.padEnd(40)} ———————`)
  for (let i = 0; i < sessions.length; i++) {
    const { lastUpdated, title, preview } = sessions[i]
    console.log(`  ${String(i + 1).padEnd(5)} ${fmt(lastUpdated).padEnd(22)} ${(title || '(untitled)').slice(0, 40).padEnd(40)} ${preview.slice(0, 60)}`)
  }
}
