import { readFileSync, writeFileSync, renameSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { allSessionRecords, sessionRecordMtime } from '../session-record.js'

/** Return sessions sorted newest-first as [{ uuid, lastUpdated, preview }, ...]. */
export function getSessions(mrcDir, { exclude = null } = {}) {
  const sessions = []
  let files
  // #5 PICKABLE⟺MIGRATED: `exclude` is the roster's memberSessionId set — a plain picker/resume must not list a
  // @member's private transcript (it's in the shared repo/.mrc, UUID-named, filename-indistinguishable from a
  // plain conversation). The migration uses the SAME set, so a listed session is always one the launch can resolve.
  try { files = readdirSync(mrcDir).filter(f => f.endsWith('.jsonl') && !(exclude && exclude.has(basename(f, '.jsonl')))) } catch { return [] }

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
      // D5/#25: rank by FILE mtime (max'd with the in-transcript ts), because `claude --continue` resumes by
      // file recency — so the host's "newest" agrees with what the container actually resumes. Metadata writes
      // (ai-title / agent-name / snapshots) bump mtime with no in-transcript ts, so ts-only ranking drifts.
      let mtimeMs = 0
      try { mtimeMs = statSync(join(mrcDir, file)).mtimeMs } catch {}
      const recencyMs = Math.max(mtimeMs, Date.parse(lastTs) || 0)
      if (recencyMs > 0) sessions.push({ uuid, lastUpdated: new Date(recencyMs).toISOString(), recencyMs, preview })
    } catch {}
  }

  sessions.sort((a, b) => b.recencyMs - a.recencyMs)
  return sessions
}

/** Load session-names file into an object { uuid: name }. */
export function loadNames(mrcDir) {
  const names = {}
  const file = join(mrcDir, 'session-names')
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const eq = line.indexOf('=')
      if (eq > 0) {
        const uuid = line.slice(0, eq)
        const name = line.slice(eq + 1)
        if (uuid && name) names[uuid] = name
      }
    }
  } catch {}
  return names
}

/** Save session-names file. AUDIT: MERGE with the current on-disk state before writing, so two concurrent
 *  name-watchers (same-repo sessions) don't lose each other's additions in a read-modify-write (the second
 *  writer's stale `names` would otherwise clobber the first's just-added entry). Both callers are additive
 *  (generateName / nameSession set a single uuid), so overlaying the caller's entries onto the disk state is
 *  correct — it narrows the lost-update window to the reload→rename gap. Atomic write (tmp+rename) = no torn read. */
export function saveNames(mrcDir, names) {
  const file = join(mrcDir, 'session-names')
  const merged = { ...loadNames(mrcDir), ...names }
  const content = Object.entries(merged).map(([uuid, name]) => `${uuid}=${name}`).join('\n') + '\n'
  const tmp = file + '.tmp'
  writeFileSync(tmp, content)
  renameSync(tmp, file)
}

/**
 * D2: the ONE ordered list of resumable sessions, shared by the picker AND `resolve` (so `sessions resume <#>`
 * numbering matches what the picker shows and a raw adversary uuid resolves the same way). It merges the normal
 * `.mrc` sessions (recency-ranked) with SUMMONED-ADVERSARY sessions from the machine-global host records —
 * appended after the normal rows. Adversaries are surfaced from the records because a caged adversary's transcript
 * lives in its dedicated `-pierre-N` config volume, NOT in `.mrc` (container-setup skips the /workspace/.mrc symlink
 * under the cage), so getSessions('.mrc') is structurally blind to them. CONTAINMENT FLOOR: filter to
 * `rec.repoPath === repoPath` — allSessionRecords is GLOBAL and the `-pierre-N` pool + volume are md5(repoPath)-keyed,
 * so surfacing a foreign-repo adversary would resume it from THIS repo's (wrong/empty/co-resident) volume.
 * Each row: { uuid, lastUpdated, preview, adversary, summonedBy }.
 */
export function getResumableSessions(mrcDir, { exclude = null } = {}) {
  const repoPath = dirname(mrcDir)
  const sessions = getSessions(mrcDir, { exclude }).map((s) => ({ ...s, adversary: false, summonedBy: null }))
  const seen = new Set(sessions.map((s) => s.uuid))
  const advRows = []
  for (const [uuid, rec] of Object.entries(allSessionRecords())) {
    if (!(rec.adversary || rec.summonedBy)) continue        // adversaries only (keystone: same as classifySession)
    if (rec.repoPath !== repoPath) continue                 // containment floor: only THIS repo's Pierre pool
    if (seen.has(uuid)) continue                            // dedup (a normal .mrc session that also has a record)
    // recencyMs = the host record's mtime (a caged adversary's transcript is in its config volume, not .mrc, so
    // there's no in-repo mtime). Same numeric field getSessions ranks by (+ an ISO lastUpdated string for the
    // picker's date column) so an adversary COLLATES into the one recency order instead of sitting undated at the
    // bottom — a Pierre summoned today lands among today's sessions.
    const ms = sessionRecordMtime(uuid)
    advRows.push({ uuid, recencyMs: ms, lastUpdated: ms ? new Date(ms).toISOString() : '', preview: '', adversary: true, summonedBy: rec.summonedBy || null })
  }
  // ONE recency order for the whole list (normal + adversary) → the picker and `resolve` share it (a stable sort
  // keeps getSessions' existing tie-break), so `sessions resume <#>` can never diverge from the picker.
  return [...sessions, ...advRows].sort((a, b) => (b.recencyMs || 0) - (a.recencyMs || 0))
}

/** Resolve a name or list number to a UUID. Returns UUID or null. */
export function resolve(mrcDir, query, { exclude = null } = {}) {
  const sessions = getResumableSessions(mrcDir, { exclude })   // D2: include adversaries so `sessions resume <#>` matches the picker + a raw adversary uuid resolves (D10 confirmIfAdversary still guards the resume path in mrc.js)
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
export function resolveSessionId(mrcDir, { resumeSession, newSession, exclude } = {}) {
  if (resumeSession) return resumeSession
  if (!newSession) { try { const s = getSessions(mrcDir, { exclude })[0]; if (s) return s.uuid } catch {} }   // #5: a plain --continue never auto-resumes a @member's transcript
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
export function listSessions(mrcDir, { exclude = null } = {}) {
  const sessions = getSessions(mrcDir, { exclude })   // #5: don't list @member transcripts to the user
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
export function nameSession(mrcDir, name, target = '1', { exclude = null } = {}) {
  const uuid = resolve(mrcDir, target, { exclude })   // #5: the #N target indexes the SAME excluded list the picker shows
  if (!uuid) {
    process.stderr.write(`Session not found: ${target}\nRun 'mrc sessions ls' to list available sessions.\n`)
    process.exit(1)
  }
  const names = loadNames(mrcDir)
  names[uuid] = name
  saveNames(mrcDir, names)
  console.log(`Named session ${uuid} → "${name}"`)
}
