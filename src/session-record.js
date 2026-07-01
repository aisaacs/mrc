// Host-only per-session record — the TAMPER-PROOF half of session metadata, keyed by the conversation
// UUID, at ~/.local/share/mrc/session-meta/<uuid>.json.
//
// WHY HERE and not in the repo's .mrc record (manager.js): .mrc is the repo bind mount, WRITABLE by the
// sandboxed session, and the config volume is mounted RW too — so neither can hold a field that drives a
// security decision (a contained session could forge its own classification). This dir is never mounted
// into any container. It holds the security-critical fields only: `summonedBy` (the issuer's session id)
// and `adversary`. The low-stakes name/repo half lives in .mrc/session-meta (travels with the repo).
//
// `adversary` is DERIVED from `summonedBy` (launch-time, from --summoned-by → the durable record), never
// from a session's name/persona/behavior — the same launch-derived-containment rule the daemon's #30 fix
// re-derives on register. This file is the durable source that survives a daemon restart AND a resume.
import { mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function recordDir() { return join(homedir(), '.local', 'share', 'mrc', 'session-meta') }
function recordPath(uuid) { return join(recordDir(), `${uuid}.json`) }

/** Load a session's host-only record, or {} if none/unreadable. */
export function loadSessionRecord(uuid) {
  try { return JSON.parse(readFileSync(recordPath(uuid), 'utf8')) } catch { return {} }
}

/** Merge a patch into a session's host-only record, atomically (temp + rename in the same dir; the
 *  uuid field is always authoritative). Returns the merged record. */
export function saveSessionRecord(uuid, patch) {
  mkdirSync(recordDir(), { recursive: true })
  const merged = { ...loadSessionRecord(uuid), ...patch, uuid }
  const file = recordPath(uuid)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n')
  renameSync(tmp, file)
  return merged
}

/** True iff this conversation UUID is an adversary (durable, host-only). Keyed on the `adversary`
 *  KEYSTONE (the field that drives the firewall cage) OR `summonedBy` (its launch origin) — aligned so
 *  the predicate the resume/cage path consults can't silently diverge from the cage authority. They
 *  coincide today (adversary:true ⟹ summonedBy set), but a future "mark adversary" path that set
 *  adversary without a summoner would otherwise be left UNcaged by a summonedBy-only check. */
export function isAdversarySession(uuid) {
  const r = loadSessionRecord(uuid)
  return !!(r.adversary || r.summonedBy)
}

/** 3-STATE containment classification for the bare-resume guard — keyed on record PRESENCE, NOT the
 *  2-state isAdversarySession (which collapses "no record" into "normal" and would make the fail-closed
 *  keystone never fire). 'adversary' (record says so) · 'normal' (record says not) · 'unknown' (NO or
 *  unreadable record — absence is anomalous, so the caller fails CLOSED). saveSessionRecord always writes
 *  `uuid`, so a missing `uuid` field ⟺ no record; a corrupt/unreadable file → {} → 'unknown' → picker,
 *  which is the safe direction. */
export function classifySession(uuid) {
  const r = loadSessionRecord(uuid)
  if (r.uuid === undefined) return 'unknown'
  return (r.adversary || r.summonedBy) ? 'adversary' : 'normal'
}

/** uuid → record for every session that has a host-only record. Lets the picker label adversaries
 *  (and skip them in the silent auto-resume) without querying the daemon. */
export function allSessionRecords() {
  const out = {}
  try {
    for (const f of readdirSync(recordDir())) {
      if (f.endsWith('.json')) out[f.slice(0, -5)] = loadSessionRecord(f.slice(0, -5))
    }
  } catch {}
  return out
}

/** Transcript-coupled prune: the record dir grows one file per session, so drop a record when its
 *  transcript is provably gone — but NEVER an adversary record. repoPath is mutable, so a moved/renamed
 *  repo empties the stored path and reads as "transcript gone"; for an adversary that would drop the
 *  record → a resume at the new path comes back UNCAGED. So keep adversary:true forever (only ever a
 *  handful of Pierres; a moved-repo resume then still re-cages), prune only the unbounded adversary:false
 *  bulk, and bias to KEEP on any ambiguity (no path / unreadable). The asymmetry IS the safety: a stranded
 *  normal record = one wasted picker click; a dropped adversary record = an uncage. Call host-side at
 *  launch BEFORE the current session's record is written, so it only ever touches PRIOR sessions. */
export function pruneSessionRecords() {
  for (const [uuid, r] of Object.entries(allSessionRecords())) {
    if (r.adversary || r.summonedBy) continue                 // NEVER an adversary — keep forever
    if (!r.repoPath) continue                                 // no path → ambiguous → keep
    let gone
    try { gone = !existsSync(join(r.repoPath, '.mrc', `${uuid}.jsonl`)) } catch { continue }   // unreadable → keep
    if (gone) { try { rmSync(recordPath(uuid)) } catch {} }   // adversary:false + transcript provably gone → drop
  }
}
