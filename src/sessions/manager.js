import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Return sessions sorted newest-first as [{ uuid, lastUpdated, preview }, ...]. */
export function getSessions(mrcDir) {
  const sessions = []
  let files
  try { files = readdirSync(mrcDir).filter(f => f.endsWith('.jsonl')) } catch { return [] }

  for (const file of files) {
    const uuid = basename(file, '.jsonl')
    let preview = ''
    let lastTs = ''

    try {
      const raw = readFileSync(join(mrcDir, file), 'utf8')
      for (const line of raw.split('\n')) {
        if (!line) continue
        let obj
        try { obj = JSON.parse(line) } catch { continue }
        if (obj.timestamp) lastTs = obj.timestamp
        if (!preview && obj.type === 'user') {
          let content = obj.message?.content || ''
          if (Array.isArray(content)) {
            content = content.find(c => c.type === 'text')?.text || ''
          }
          preview = content.slice(0, 60).replace(/\n/g, ' ')
          if (content.length > 60) preview += '...'
        }
      }
    } catch { continue }

    // Recency = FILE mtime, not the last in-transcript `timestamp`. Metadata lines (ai-title,
    // agent-name, snapshots, mode, …) advance the file mtime WITHOUT carrying a timestamp, so the
    // in-transcript ts runs stale relative to mtime by hours-to-days. `claude --continue` resumes by
    // file recency, so getSessions must rank by mtime too — else the host's "newest" disagrees with
    // what the container actually resumes (the #25 silent-guard divergence). max(mtime, ts) so a
    // never-touched-since-write file still works; numeric key, never NaN (a NaN comparator is UB).
    let mtimeMs = 0
    try { mtimeMs = statSync(join(mrcDir, file)).mtimeMs } catch {}
    const recencyMs = Math.max(mtimeMs, Date.parse(lastTs) || 0)
    if (recencyMs > 0) sessions.push({ uuid, lastUpdated: new Date(recencyMs).toISOString(), recencyMs, preview })
  }

  sessions.sort((a, b) => b.recencyMs - a.recencyMs)
  return sessions
}

/** uuid → name, read SOURCE-FIRST: the per-uuid record's `.name` (the single source of truth, #32) wins
 *  over the legacy `session-names` projection. Overlaying here means every reader of loadNames is
 *  source-first with no per-caller change and no stale-projection reads — the projection is just the
 *  transitional fallback for pre-#32 sessions that have no record yet (retired entirely in #32 Phase 2). */
export function loadNames(mrcDir) {
  const names = {}
  // 1) legacy projection (fallback / transitional)
  try {
    for (const line of readFileSync(join(mrcDir, 'session-names'), 'utf8').split('\n')) {
      const eq = line.indexOf('=')
      if (eq > 0) {
        const uuid = line.slice(0, eq)
        const name = line.slice(eq + 1)
        if (uuid && name) names[uuid] = name
      }
    }
  } catch {}
  // 2) source-of-truth overlay: each record's .name wins over the projection
  try {
    for (const f of readdirSync(metaDir(mrcDir))) {
      if (!f.endsWith('.json')) continue
      const nm = loadMeta(mrcDir, f.slice(0, -5)).name
      if (nm) names[f.slice(0, -5)] = nm
    }
  } catch {}
  return names
}

/** Save session-names file. */
export function saveNames(mrcDir, names) {
  const file = join(mrcDir, 'session-names')
  const content = Object.entries(names).map(([uuid, name]) => `${uuid}=${name}`).join('\n') + '\n'
  writeFileSync(file, content)
}

// --- Per-session metadata record (single source of truth, keyed by conversation UUID) ---
// One atomic file per session at <mrcDir>/session-meta/<uuid>.json, generalizing the legacy
// `session-names` map. One file per uuid (not one shared file), so concurrent writers can't
// lose-update each other. NOTE: <mrcDir> is the repo bind mount — WRITABLE by the sandbox — so the
// security-critical adversary/containment flag must NOT live here; it belongs in a host-only store.
function metaDir(mrcDir) { return join(mrcDir, 'session-meta') }
function metaPath(mrcDir, uuid) { return join(metaDir(mrcDir), `${uuid}.json`) }

/** Load a session's metadata record, or {} if none/unreadable. */
export function loadMeta(mrcDir, uuid) {
  try { return JSON.parse(readFileSync(metaPath(mrcDir, uuid), 'utf8')) } catch { return {} }
}

/** Merge a patch into a session's record and persist it atomically — temp file + rename in the SAME
 *  dir, so a torn or concurrent write can never leave a half-written record (last-writer-wins per
 *  uuid; the uuid field is always authoritative, never overwritable by a stale patch). */
export function saveMeta(mrcDir, uuid, patch) {
  mkdirSync(metaDir(mrcDir), { recursive: true })
  const merged = { ...loadMeta(mrcDir, uuid), ...patch, uuid }
  const file = metaPath(mrcDir, uuid)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n')
  renameSync(tmp, file)
  return merged
}

/** Resolve a name or list number to a UUID. Returns UUID or null. */
export function resolve(mrcDir, query) {
  const sessions = getSessions(mrcDir)
  const names = loadNames(mrcDir)

  // Try as a number
  const idx = parseInt(query, 10)
  if (!isNaN(idx) && idx >= 1 && idx <= sessions.length) {
    return sessions[idx - 1].uuid
  }

  // Try as exact name
  for (const s of sessions) {
    if (names[s.uuid] === query) return s.uuid
  }

  // Try as substring
  for (const s of sessions) {
    const name = names[s.uuid] || ''
    if (name && name.toLowerCase().includes(query.toLowerCase())) return s.uuid
  }

  // Try as raw UUID
  for (const s of sessions) {
    if (s.uuid === query) return s.uuid
  }

  return null
}

/** The stable per-conversation id used for room identity: the resumed UUID, the latest conversation
 *  (plain --continue), or a fresh UUID for a brand-new conversation (which the entrypoint then pins
 *  via `claude --session-id`). Stable across resume; unique per new conversation. */
export function resolveSessionId(mrcDir, { resumeSession, newSession } = {}) {
  if (resumeSession) return resumeSession
  if (!newSession) { try { const s = getSessions(mrcDir)[0]; if (s) return s.uuid } catch {} }
  return randomUUID()
}

/** Get first line of a session summary, or null. */
export function getSummaryPreview(mrcDir, uuid) {
  const file = join(mrcDir, 'session-summaries', `${uuid}.md`)
  try {
    const first = readFileSync(file, 'utf8').split('\n')[0].trim().replace(/^#+\s*/, '')
    if (first) return first.slice(0, 60) + (first.length > 60 ? '...' : '')
  } catch {}
  return null
}

/** Format timestamp for display. */
function formatTs(ts) {
  try {
    return new Date(ts).toISOString().replace('T', ' ').slice(0, 19)
  } catch {
    return ts.slice(0, 19)
  }
}

/** Print session list to stdout. */
export function listSessions(mrcDir) {
  const sessions = getSessions(mrcDir)
  if (!sessions.length) {
    console.log(`No sessions found in ${mrcDir}`)
    return
  }
  const names = loadNames(mrcDir)
  console.log(`  ${'#'.padEnd(5)} ${'Last Used'.padEnd(22)} ${'Name'.padEnd(80)} Preview`)
  console.log(`  ${'—'.padEnd(5)} ${'—————————'.padEnd(22)} ${'————'.padEnd(80)} ———————`)
  for (let i = 0; i < sessions.length; i++) {
    const { uuid, lastUpdated, preview } = sessions[i]
    const name = names[uuid] || '(unnamed)'
    const summary = getSummaryPreview(mrcDir, uuid)
    const display = summary || preview
    console.log(`  ${String(i + 1).padEnd(5)} ${formatTs(lastUpdated).padEnd(22)} ${name.padEnd(80)} ${display}`)
  }
}

/** Name a session. */
export function nameSession(mrcDir, name, target = '1') {
  const uuid = resolve(mrcDir, target)
  if (!uuid) {
    process.stderr.write(`Session not found: ${target}\nRun 'mrc sessions ls' to list available sessions.\n`)
    process.exit(1)
  }
  const names = loadNames(mrcDir)
  names[uuid] = name
  saveNames(mrcDir, names)            // transitional projection (retired in Phase 2)
  saveMeta(mrcDir, uuid, { name })     // record = source of truth
  console.log(`Named session ${uuid} → "${name}"`)
}
