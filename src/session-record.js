// Host-only per-session record — the TAMPER-PROOF half of session metadata, keyed by the conversation
// UUID, at ~/.local/share/mrc/session-meta/<uuid>.json.
//
// WHY HERE and not in the repo's .mrc record (manager.js): .mrc is the repo bind mount, WRITABLE by the
// sandboxed session, and the config volume is mounted RW too — so neither can hold a field that drives a
// security decision (a contained session could forge its own classification). This dir is never mounted
// into any container. It holds the security-critical fields only: `summonedBy` (the issuer's session id)
// and `adversary`. (The low-stakes session NAME lives separately in the repo's `.mrc/session-names` file —
// manager.js. #32's per-uuid repo-side `.mrc/session-meta` split was never built, so don't look for it here.)
//
// `adversary` is DERIVED from `summonedBy` (launch-time, from --summoned-by → the durable record), never
// from a session's name/persona/behavior — the same launch-derived-containment rule the daemon's #30 fix
// re-derives on register. This file is the durable source that survives a daemon restart AND a resume.
import { mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, existsSync, rmSync, statSync } from 'node:fs'
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

/** The record file's mtime (ms), or 0 if none — a recency proxy for a summoned adversary whose transcript
 *  lives in its config volume (not .mrc), so it has no in-repo mtime for the picker to sort/date by. */
export function sessionRecordMtime(uuid) {
  try { return statSync(recordPath(uuid)).mtimeMs } catch { return 0 }
}

// #64 age backstop: a record whose session crashed BEFORE Claude Code wrote its first transcript byte
// never earns its `.seen` sentinel, so it can't be pruned by the deletion rule below — this coarse ceiling
// mops that leak. Sized as "no boot on Earth takes an hour", NOT typical boot lag: a robust, sloppy-
// tolerant number that can never reap a live-but-slow boot (which earns the sentinel in seconds), unlike a
// tight grace window that would have to equal worst-case boot latency exactly (and guess in the unsafe
// direction under the very load that triggers #64). Pierre-converged.
const NEVER_BOOTED_REAP_MS = 60 * 60 * 1000

// #64 "transcript observed" is persisted in a prune-OWNED sentinel FILE, NOT a field in the record. This is
// the load-bearing containment choice (Pierre): the record carries the cage/trust bit (adversary/summonedBy)
// which the daemon reads at RUNTIME to classify a session (mrc.js:635). If prune stamped the fact INTO the
// record, it would do a lockless read-modify-write on that bit — and a FUTURE "downgrade a live session to
// adversary" feature (buildable purely in the daemon's trust view, no container re-cage) that wrote the bit
// onto an existing record could then be CLOBBERED back by prune's RMW → daemon-level uncage. A file-disjoint
// sentinel means prune NEVER read-modify-writes the record (it only ever CREATEs a `.seen` or DELETEs the
// whole record). So "prune cannot uncage" is true BY CONSTRUCTION, not by "no re-mark path exists yet".
function sentinelPath(uuid) { return join(recordDir(), `${uuid}.seen`) }
function transcriptSeen(uuid) { return existsSync(sentinelPath(uuid)) }
function markTranscriptSeen(uuid) { try { mkdirSync(recordDir(), { recursive: true }); writeFileSync(sentinelPath(uuid), '') } catch {} }
// Reap = drop the record AND its sentinel. Unlink the SENTINEL FIRST, record SECOND (Pierre): the two rms
// are non-atomic, so a crash between them (SIGKILL/OOM/reboot — routine under many churning launches) must
// fail SAFE. Sentinel-first → a partial reap leaves a sentinel-LESS record, which reads as "never-seen" so
// the AGE BACKSTOP above reaps it on a later pass — self-healing. Record-first would leave an ORPHAN `.seen`
// that nothing GCs (reapRecord is its only remover) → unbounded sentinel bloat, the very dir-growth prune
// exists to prevent, plus a latent false-reap if that uuid's record were ever rewritten with its transcript
// transiently absent. One ordering turns a permanent leak into a self-healing one.
function reapRecord(uuid) { try { rmSync(sentinelPath(uuid)) } catch {} ; try { rmSync(recordPath(uuid)) } catch {} }

/** Transcript-coupled prune: the record dir grows one file per session, so drop a record when its
 *  transcript is provably DELETED — but NEVER an adversary record, and NEVER a session that is merely
 *  still booting. repoPath is mutable, so a moved/renamed repo empties the stored path and reads as
 *  "transcript gone"; for an adversary that would drop the record → a resume at the new path comes back
 *  UNCAGED. So keep adversary:true forever (only ever a handful of Pierres; a moved-repo resume then
 *  still re-cages), and bias to KEEP on any ambiguity (no path / unreadable / .mrc dir gone).
 *
 *  #64 — the DELETION vs NOT-YET-CREATED distinction (the bug this fixes): prune runs on EVERY launch,
 *  BEFORE the container starts (mrc.js), so a sibling launch's prune can fire in the window between a
 *  fresh session's record being written and Claude Code creating its `.jsonl`. The old "transcript absent
 *  → drop" rule read that as "deleted" and deleted the just-written record → the session classified
 *  'unknown' (invisible in rooms, un-summonable). Fix: persist the FACT that a transcript was ever observed
 *  in a prune-owned `.seen` sentinel (see above), created lazily the first time we see it. Then a later
 *  ABSENCE reads as a real deletion only if the sentinel exists; a never-seen record is a booting (keep) or
 *  crashed-early (age-backstop) session. Race closed BY CONSTRUCTION — no boot-latency guess, and no RMW on
 *  the trust bit. Only ever touches PRIOR sessions (this session's record is written after this call).
 *
 *  TRIPWIRE (Pierre, the load-bearing invariant): the "sentinel + transcript-absent → reap" rule is safe
 *  ONLY because a uuid whose transcript is gone can never be RELAUNCHED under that same uuid — resume lists
 *  sessions by scanning `.jsonl` (manager.js), so a deleted-transcript conversation resumes as a FRESH uuid.
 *  Thus no launch ever writes record[U] while U's transcript is absent, so a stale sentinel[U] can't collide
 *  with a booting record[U] into a false reap. If ANY path is ever added that writes/pre-seeds a record for
 *  a uuid BEFORE its transcript exists on disk on a resume (a warm/pre-seeded record, lazy transcript
 *  restore, a migration recreating records ahead of transcripts), that invariant breaks and the boot-window
 *  race reopens for resumes — gate any such path on the transcript existing first. */
export function pruneSessionRecords() {
  for (const uuid of Object.keys(allSessionRecords())) {
    // Re-read FRESH per uuid before deciding (Pierre #3/#4): the snapshot is a point-in-time copy, but this
    // is a DELETE path — a sibling may have been re-marked/resumed since. Decide on current truth. (Also
    // future-proofs the adversary skip: a fresh read sees a just-set adversary:true and skips, where a stale
    // snapshot could read false → uncage on reap.)
    const r = loadSessionRecord(uuid)
    if (r.uuid === undefined) continue                        // vanished since the snapshot → nothing to do
    if (r.adversary || r.summonedBy) continue                 // NEVER an adversary — keep forever
    if (!r.repoPath) continue                                 // no path → ambiguous → keep
    const mrcDir = join(r.repoPath, '.mrc')
    let dirOk, exists
    try { dirOk = existsSync(mrcDir); exists = existsSync(join(mrcDir, `${uuid}.jsonl`)) } catch { continue }   // unreadable → keep
    if (!dirOk) continue   // the .mrc store itself is absent/dangling (volume reset — the store is a symlink
                           // that can outlive its target): EVERY uuid would read "gone" → mass-reap. Ambiguous
                           // → KEEP, one directory-stat wider than the existing bias (Pierre bonus).
    if (exists) {
      // Observed → mark once in the sentinel FILE (no record write). STAMP-ONCE (guarded) → O(new
      // transcripts) sentinel-creates, not O(all records) per launch (Pierre #2). Never an RMW on the record.
      if (!transcriptSeen(uuid)) markTranscriptSeen(uuid)
      continue
    }
    if (transcriptSeen(uuid)) { reapRecord(uuid) ; continue }   // sentinel present → HAD a transcript → provably DELETED → drop
    // Never-seen + absent: a booting session (KEEP — the #64 race fix) OR one that crashed before its first
    // transcript write. Reap only the latter, past the coarse age backstop; keep on stat ambiguity (mtime 0).
    const mt = sessionRecordMtime(uuid)
    if (mt && Date.now() - mt > NEVER_BOOTED_REAP_MS) reapRecord(uuid)
  }
}
