//
// codex-sessions.js — container-side scanning of Codex's rollout store.
//
// Used by container-setup.js to decide what a plain `mrc --agent codex` should resume. This deliberately
// does NOT delegate to `codex resume --last`: that flag applies its own opaque selection rules (cwd
// filtering, an internal ledger, non-interactive exclusion) and was observed not to resume, whereas
// `resume <id>` works. Resolving the id here also buys a real invariant — auto-resume continues exactly
// the session `mrc pick --agent codex` lists first, because both rank by the same recency and apply the
// same non-interactive filter.
//
import { readdirSync, statSync, openSync, readSync, closeSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

const ROLLOUT_RE = /^rollout-.*\.jsonl$/
const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i

/** All rollout files under `dir`. Codex nests them by date (YYYY/MM/DD), so this walks rather than lists. */
export function findRollouts(dir, depth = 0, out = []) {
  if (depth > 4) return out
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) findRollouts(full, depth + 1, out)
    else if (e.isFile() && ROLLOUT_RE.test(e.name)) out.push(full)
  }
  return out
}

/**
 * Read a rollout's session_meta → { id, originator }, or null.
 * session_meta is the FIRST record, so read a bounded prefix instead of slurping a rollout that can grow
 * to many megabytes. A truncated trailing line in that window simply fails to parse and is skipped.
 */
export function rolloutMeta(file) {
  let head = ''
  try {
    const fd = openSync(file, 'r')
    try {
      const buf = Buffer.alloc(65536)
      const n = readSync(fd, buf, 0, buf.length, 0)
      head = buf.subarray(0, n).toString('utf8')
    } finally { closeSync(fd) }
  } catch { return null }
  for (const line of head.split('\n')) {
    if (!line) continue
    let obj
    try { obj = JSON.parse(line) } catch { continue }
    const p = obj.payload || {}
    if (p.id || p.originator) return { id: p.id || '', originator: p.originator || '' }
  }
  return null
}

/**
 * Rollouts across every candidate store, newest-first, deduplicated by REAL path.
 *
 * Two directories are in play — the repo-local store (/workspace/.mrc/codex-sessions, what the host-side
 * picker reads) and Codex's own ~/.codex/sessions in the volume — and normally the second is a symlink to
 * the first, so both list the same files. Scanning BOTH and deduping by realpath makes this correct
 * whether or not that symlink is intact: if it ever fails to plant, Codex records into the volume while
 * the picker reads the repo copy, and auto-resume must not go blind just because it looked at only one.
 */
export function rankedRollouts(dirs) {
  const list = Array.isArray(dirs) ? dirs : [dirs]
  const seen = new Set()
  const ranked = []
  for (const dir of list) {
    for (const f of findRollouts(dir)) {
      let key = f
      try { key = realpathSync(f) } catch {}
      if (seen.has(key)) continue          // same file reached through the symlink and directly
      seen.add(key)
      let m = 0
      try { m = statSync(f).mtimeMs } catch {}
      ranked.push({ f, m })
    }
  }
  return ranked.sort((a, b) => b.m - a.m)
}

/**
 * The session id a plain launch should resume, or '' when there's nothing resumable.
 * Newest first by mtime, skipping non-interactive (`codex exec`) rollouts — `mrc team exec` worker turns
 * share this store and must never become the session an interactive launch lands in.
 */
export function resolveAutoResumeId(dirs) {
  for (const { f } of rankedRollouts(dirs)) {
    const meta = rolloutMeta(f)
    if (meta && meta.originator && meta.originator.includes('exec')) continue
    // Fall back to the uuid in the filename: a rollout whose meta is missing or truncated is still
    // perfectly resumable, and dropping it would silently start a fresh session instead.
    const id = (meta && meta.id) || (f.match(UUID_RE) || [])[1] || ''
    if (id) return id
  }
  return ''
}
