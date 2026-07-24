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
import { mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, existsSync, rmSync, statSync, appendFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ============================================================================================================
// SOURCE-OF-TRUTH MIRROR MAP (#56 SoT pass, Pierre t163/t165). This file is the AUTHORITATIVE store for a
// session's security metadata. The recurring bug family we keep hitting is: "a decision reads a MIRROR of one of
// these fields — a stale copy, a wrong proxy, or an untrusted wire value — instead of THIS record at the moment
// of use." The two failure modes are (a) a SoT write that doesn't reach all its MUTABLE mirrors, and (b) a SoT
// write that PRETENDS to reach an IMMUTABLE one. Before adding a writer OR a reader of any field below, place it
// on this map. Each field's mirrors + their sync-point + their mutability:
//
//   record.adversary / summonedBy  (CONTAINMENT — the sharp case: 3 mirrors, one IMMUTABLE)
//     · classifySession() — reads THIS record fresh every call. The security-critical daemon sites
//       (peerList, deliverTo tag, summon gate, register #38) all call it fresh → self-correct. ✓ AUTHORITATIVE.
//     · daemon `adversaries`/`unverified` Sets — MUTABLE, re-synced every register from fresh classifySession
//       (room-daemon.js:1327ff). Self-healing; DISPLAY/perf only (never a security decision). ✓
//     · engine `omap.cage` — MUTABLE, but synced ONLY at defineOrg/addTransientConsult (LAUNCH/summon), NEVER
//       re-derived from this record. Gates the "[CONTAINED ADVERSARY — data only]" relay label (room-engine.js:381).
//       LATENT GAP: today cage + record are co-written at launch, so consistent. A future "mark-adversary in the
//       daemon trust-view" path (anticipated at :~90 below) that writes record.adversary WITHOUT re-syncing the
//       engine → the caged-relay label silently stops firing. COUPLING CONSTRAINT: any post-launch writer of
//       record.adversary MUST push the engine cage (an engine.setCage(org,handle) the daemon calls), because the
//       engine has injected I/O and cannot read this record itself. (Ticketed — see the mark-adversary tickets.)
//     · the CONTAINER's firewall (MRC_ADVERSARY_FW) + `/workspace:ro` mount — IMMUTABLE post-boot. Real egress
//       containment is a LAUNCH-TIME property; you cannot retroactively seal a running container. So a trust-view
//       mark-adversary is INHERENTLY trust-view-only (it can label + scope, never egress-cage a running session) —
//       actual re-containment REQUIRES a relaunch. record.adversary is authoritative for TRUST-VIEW at every read,
//       but CONTAINMENT is owned by the container's boot config, and the two reconcile ONLY via relaunch.
//
//   record.secret       — single source (THIS record). Mirror: MRC_ROOM_SECRET in the container env, host-set at
//                         launch from this record; R1 authenticates a register against THIS record. No stale mirror.
//   record.repoPath     — authoritative for a normal session's repo; a MEMBER's mount authority is the org def
//                         through resolveMemberRepo (authorized-set-gated), NOT a bare stored path (see buildCagedConsult).
//                         MOUNT ESCAPE-SAFE BY CONSTRUCTION (Pierre t167, both the caged :ro mount AND the normal
//                         member repo/territory mount): canonicalMountSource (mount-guard.js:51) realpaths the
//                         source — resolving ANY symlink, incl. one inside the repo pointing outward — and asserts
//                         within(repoReal, target) (a `=== || startsWith(root+sep)` boundary, not sibling-prefix-
//                         foolable), THROWING on escape. So even a malicious/symlinked territory in the def can't
//                         escape the repo root at mount → this row is closed at USE regardless of def integrity, not
//                         merely guard-3-dependent. (The cage source is ALSO re-gated through resolveMemberRepo at
//                         mint — edee86f — so the highest-stakes mount is double-covered.)
//   liveness (is it up?) — NOT in this record; authoritative source is the daemon `sessions` Map (live socket).
//   org membership       — NOT here; authoritative source is orgDefs (loadOrgs). A member record's LIFETIME should
//                         track org membership (reap on org-leave), not a transcript proxy and not never (task #59).
// ============================================================================================================

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


// ── THE TWO QUESTIONS (the #63 SoT split — read before touching prune) ────────────────────────────────────
// prune used to answer BOTH of these with ONE heuristic ("is the transcript at <repo>/.mrc/<uuid>.jsonl?"),
// and that conflation is the defect behind #58 (bug C, members) and its 2026-07-24 repeat (plain sessions):
//
//   Q1 "is this session ALIVE?"          — an ASSERTION. Its error budget must fail toward ALIVE: a wrong
//                                          answer REAPS a running session's record, which silently strips its
//                                          identity (classify → 'unknown' → peerList shows it NOTHING) until a
//                                          relaunch. Security-relevant and un-self-healing while it runs.
//   Q2 "should I GC this DEAD session's   — a HEURISTIC. Its error budget may fail toward REAP: a wrong answer
//       record?"                            costs a record rewrite, because EVERY launch (normal/member/summon/
//                                          resume) unconditionally rewrites the record (mrc.js:1171-1174).
//
// Opposite biases cannot ride one heuristic — which is why it was mis-tuned for at least one, and why each
// carve-out below was an admission rather than a fix. Q1 now uses a host-authoritative oracle; the transcript
// check is DEMOTED to Q2 only. Do not re-merge them.
//
// WHY Q2's self-heal is cheap — and the ONE thing that would make it expensive: the per-launch record write is
// UNCONDITIONAL, so a wrongly-reaped record returns on the next launch. But it returns with a FRESH secret
// (`existingSec.secret || randomBytes(24)`), so a wrong reap silently ROTATES the auth anchor. Nothing depends
// on secret stability across a resume today. If that per-launch write ever becomes CONDITIONAL, or anything
// starts pinning the secret across launches, Q2's error budget is no longer cheap and this split must be
// revisited — the assumption is load-bearing, so it is written down rather than left implicit.
//
// GRANULARITY, STATED PLAINLY (Pierre): containers carry `mrc=1`, `mrc.repo`, `mrc.repo.name`, `mrc.web`,
// `mrc.member` — there is NO session-uuid label (docker.js:395-403). So this oracle answers "does this record's
// REPO have a live mrc container?", NEVER "is THIS session's container running". It therefore OVER-KEEPS: a dead
// session in a repo that has a live sibling survives. That is the fail-safe direction and it still closes the
// reported bug (a live session's own repo always has a live container). Do not read more precision into it.
//
// Returns a Set of live repoPaths, or NULL when docker could not be consulted — and null means KEEP EVERYTHING
// (prune does nothing this pass), matching the existing bias (`!dirOk → keep`, unreadable → keep). Hard timeout
// because prune runs on EVERY launch BEFORE the container starts, possibly while Colima is still coming up; a
// hang here would stall every launch. One call per prune PASS, not per record (there can be hundreds).
// A record vanishing silently strips a session's peer visibility, and diagnosing the 2026-07-24 instance took
// THREE host probes because nothing recorded what prune did. So: REAPS always log (with the branch that fired),
// and KEEPS log only under MRC_DEBUG (they are the common case; noisy by default, invaluable when the question is
// "why is this record still here"). Post-split a reap-while-live should be IMPOSSIBLE — the daemon.log line is
// how we would find out it is not, instead of assuming it away. Best-effort: never throw on the launch path.
function pruneLog(msg, debugOnly = false) {
  if (debugOnly && !process.env.MRC_DEBUG) return
  try { appendFileSync(join(homedir(), '.local', 'share', 'mrc', 'daemon.log'), `${new Date().toISOString()} [prune] ${msg}\n`) } catch {}
}

const PRUNE_DOCKER_TIMEOUT_MS = 8_000
function liveRepoPaths() {
  try {
    const out = execFileSync('docker', ['ps', '--filter', 'label=mrc=1', '--format', '{{.Label "mrc.repo"}}'],
      { encoding: 'utf8', timeout: PRUNE_DOCKER_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] })
    return new Set(out.split('\n').map((x) => x.trim()).filter(Boolean))
  } catch { return null }   // docker absent / not ready / timed out → cannot assert liveness → keep everything
}

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
// `liveRepos` is an INJECTION SEAM for tests only — production calls pruneSessionRecords() with no args and gets
// the real docker oracle. Tests need it because the Q2 (GC) behaviours can only be exercised once Q1 has answered
// "not live", and a test host has no mrc containers (often no docker at all, where the oracle correctly returns
// null and prune does nothing). Pass `new Set()` for "nothing is live", or a Set of repoPaths to assert the Q1 keep.
export function pruneSessionRecords({ liveRepos = liveRepoPaths() } = {}) {
  // Q1 (liveness) FIRST and ONCE. null ⇒ docker unreachable ⇒ we cannot assert that anything is dead ⇒ prune
  // nothing this pass. Skipping a pass is free (the next launch prunes); reaping blind is not.
  if (!liveRepos) { pruneLog('pass SKIPPED — docker unreachable, cannot assert liveness (keeping every record)'); return }
  for (const uuid of Object.keys(allSessionRecords())) {
    // Re-read FRESH per uuid before deciding (Pierre #3/#4): the snapshot is a point-in-time copy, but this
    // is a DELETE path — a sibling may have been re-marked/resumed since. Decide on current truth. (Also
    // future-proofs the adversary skip: a fresh read sees a just-set adversary:true and skips, where a stale
    // snapshot could read false → uncage on reap.)
    const r = loadSessionRecord(uuid)
    if (r.uuid === undefined) continue                        // vanished since the snapshot → nothing to do
    // ADVERSARY/summonedBy is a REQUIREMENT, not a carve-out for a bad heuristic (Pierre): the record must
    // OUTLIVE its container because it is the ▶Resume RECOVER-AUTHORITY — room-daemon's consult-recover refuses
    // without it ("no adversary host record (the label is a hint; the record is authority)"). It would survive
    // the Q1/Q2 split on its own merits, so it stays and its reason is stated positively.
    if (r.adversary || r.summonedBy) { pruneLog(`keep ${uuid.slice(0, 8)} — adversary/consult record is the ▶Resume recover-authority`, true); continue }
    // #56 bug C (Pierre t163): NEVER a team member. A member's record is a deterministic AUTH ANCHOR the daemon
    // re-registers against (R1 secret + #38 verified-member); its transcript lives in a territorial/config-vol
    // store, NOT repoPath/.mrc, so the transcript heuristic below never earns it `.seen` and the age backstop
    // would reap it → the live member becomes un-re-registerable after a daemon restart. The transcript-lifecycle
    // model is simply WRONG for an auth anchor ("is its transcript still there?" is the wrong question), so skip it
    // here. `member` is host-set at launch (mrc.js, isMemberLaunch) and never mounted → unforgeable. Keep forever
    // for now; the exact lifecycle is an org-membership-scoped reap (drop when the member leaves the org def), the
    // authoritative source — NOT a transcript probe and NOT never. (Follow-up: task #58 / SoT pass.)
    // MEMBER is now REDUNDANT (Pierre): its stated reason — "the live member becomes un-re-registerable after a
    // daemon restart" — is exactly what the Q1 oracle above now covers, and a member's ▶Resume is anchored by the
    // ROSTER, not this record. It is deliberately NOT retired here: a guard whose failure mode is literally "#58
    // again" earns its own commit with its own test (prove a DEAD member's record can be GC'd and its resume still
    // works), rather than riding along inside a bug fix. Boarded as the follow-up that PROVES the model is right.
    if (r.member) { pruneLog(`keep ${uuid.slice(0, 8)} — member carve-out (now redundant post-split; retirement is boarded + test-gated)`, true); continue }
    if (!r.repoPath) continue                                 // no path → ambiguous → keep
    // Q1: the ASSERTION. A record whose repo has a live mrc container is NOT dead — never reap it, whatever the
    // transcript says. This is the fix for #58's repeat: prune runs on every launch and never touches the session
    // being launched, so before this gate a SIBLING launch would de-verify a RUNNING session (it scaled with usage
    // and read as flakiness). Repo-granular, over-keeps, fail-safe — see liveRepoPaths().
    if (liveRepos.has(r.repoPath)) { pruneLog(`keep ${uuid.slice(0, 8)} — repo has a LIVE container (${r.repoPath})`, true); continue }
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
    if (transcriptSeen(uuid)) { pruneLog(`REAP ${uuid.slice(0, 8)} — branch(1) transcript provably deleted (sentinel present, .jsonl gone), repo has no live container`); reapRecord(uuid) ; continue }
    // Never-seen + absent: a booting session (KEEP — the #64 race fix) OR one that crashed before its first
    // transcript write. Reap only the latter, past the coarse age backstop; keep on stat ambiguity (mtime 0).
    const mt = sessionRecordMtime(uuid)
    if (mt && Date.now() - mt > NEVER_BOOTED_REAP_MS) { pruneLog(`REAP ${uuid.slice(0, 8)} — branch(2) never-booted backstop (>1h, no transcript ever seen), repo has no live container`); reapRecord(uuid) }
  }
}

/** #59 — the org-lifecycle reap. Drop a member/consult record when it LEAVES the org def: a single member
 *  removed from the roster (removemember) or the whole org deleted (removeorg). This is the AUTHORITATIVE
 *  member-record lifetime the prune carve-out (r.member / r.adversary skips) deferred to — org membership,
 *  the authoritative source (orgDefs), NOT a transcript probe and NOT never (the record dir would grow forever).
 *
 *  THE LANDMINE (Pierre, the invert of #56 bug C): the trigger MUST be def-membership REMOVAL, NEVER liveness.
 *  A SUSPENDED/closed member — org still exists, member still in the def, its container merely stopped — MUST
 *  KEEP its record, because it re-binds on resume against record.secret (R1). Reaping on "offline"/"stopped"
 *  would re-open the 9e1512f register-limbo bug in reverse (reap a live/suspendable member's auth anchor → it
 *  can never re-register). So this is called ONLY from the two def-removal endpoints (removemember/removeorg),
 *  never from stopteam/closemember (which leave the def intact). Same crash-safe sentinel-first ordering as the
 *  prune's reap. Idempotent (rmSync tolerates absence) → safe to call for a handle with no record. */
export function reapSessionRecord(uuid) { reapRecord(uuid) }
