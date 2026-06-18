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
import { mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync } from 'node:fs'
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

/** True iff this conversation UUID was launched as a summoned adversary (durable, host-only). */
export function isAdversarySession(uuid) {
  return !!loadSessionRecord(uuid).summonedBy
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
