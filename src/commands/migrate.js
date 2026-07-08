// The `mrc migrate` RUNNER — the explicit, guarded, versioned front door to the migration framework
// (src/migrations/). It replaces the old SILENT auto-migrate (the launch-coupled side-effect that caused the
// owner's mixed-mode split). See docs/migration-system.md and CLAUDE.md.
//
// DESIGN (Pierre's 8 runner invariants + adoption's 3 guardrails, built as explicit doors):
//   1. LOCK the SLICE-ID, not the repo — N cp'd siblings share ONE slice; a migrate on either must serialize.
//   2. PREFLIGHT = UNION refuse: no live container on the repo LABEL *or* on the SLICE SOURCE (a sibling copy's
//      live container shares the slice at a different path) may exist. Undetermined docker → FAIL CLOSED (refuse).
//   3. CAPABILITY = comparison + rebuild-gated: apply a migration only if the running image can DRIVE its
//      layoutLevel (imageCanDrive). #001 is layout-neutral (level 0) so any store-capable image drives it; a
//      future layout migration needs a newer image → refuse with a rebuild instruction, never a half-applied state.
//   4. `--yes` waives CONSENT (the confirm prompt), NEVER SAFETY — the lock + preflight + capability gates ALWAYS run.
//   5. `detach` is slice→legacy opt-out, REFUSE-BY-DEFAULT when store-born content exists (opting out would strand
//      it); `--force-detach` is as loud as any --force. It NEVER copies slice→repo/.mrc (re-opening the hostile-clone
//      surface) and NEVER deletes the slice.
//   6. PREVIEW states repo/.mrc is RETAINED (non-destructive) + surfaces a pre-populated (possibly shared) slice.
//   7. `status` renders record-lost / corrupt HONESTLY (STRANDED ≠ fresh) — never a reassuring "unmigrated".
//   8. RECORD is host-only, atomic, AFTER verify() is green, WITH the manifest (recordMigration handles this).
//   ADOPTION (#9, for pre-framework slices the old auto-migrate left with an in-slice sentinel but NO host record —
//   the owner's already-migrated repos): (A) adopt DOWNWARD to the level the evidence PROVES only — the #001 sentinel
//   proves #001-level-0 and nothing higher; ANY higher-layout signature → DENY (stay stranded, manual). (B)
//   VERIFY-THEN-RECORD — run #001's byte-honest verify(legacy↔slice) as the GATE: PASS → adopt, FAIL → route to the
//   reconciler (a diverged slice must never be blind-stamped "done"). (C) the adopted record carries PROVENANCE
//   ({adopted, from, verifiedByteIdentical}) so an auditor distinguishes adopted from freshly-migrated.
import { join, basename, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { openSync, writeSync, closeSync, readFileSync, unlinkSync, mkdirSync, readdirSync, existsSync, copyFileSync, appendFileSync, statSync } from 'node:fs'
import { MIGRATIONS, sliceMigrationState, recordMigration, sliceHigherSignature, recordOptOut, clearOptOut, isOptedOut } from '../migrations/registry.js'
import mig001 from '../migrations/001-relocate-mrc-to-store.js'
import { mrcStoreDir, storeCtx, planMigration, normalizeSliceMtimes } from '../mrc-store.js'

const sha256 = (f) => { try { return createHash('sha256').update(readFileSync(f)).digest('hex') } catch { return null } }
// A verify result's FAILING per-FILE checks — excludes the leading summary check (ok:false when the whole verify
// failed, but it's not a file). Counting it as a file was the "3 files" vs actual-2 miscount the live door surfaced.
const failedFiles = (v) => (v && v.checks || []).filter(c => c.ok === false && c.file)

// The plain/USER slice for a repo — the migrate front door. A repo is a front door that resolves to the user's own
// repoId slice (never a member/adversary slice: `mrc migrate` is a plain-user act). Uses the SAME lattice as launch
// (storeCtx → mrcStoreDir), so the runner targets the EXACT slice a plain `mrc <repo>` would open — no second path.
export function repoSliceDir(repoPath, { storeCtx: mkCtx = storeCtx, mrcStoreDir: mkDir = mrcStoreDir } = {}) {
  return mkDir(mkCtx({ solo: false, memberCtx: null, cagedAdversary: false, repoPath }))
}

// ── INVARIANT 1: the slice lock (host-only, O_EXCL, stale-steal) ─────────────────────────────────────────────
// Keyed by the SLICE id (basename), not the repo — two cp'd siblings on one slice serialize. Host-only (a lock in
// the container-writable /mrc could be forged/removed). O_EXCL claim; on EEXIST, if the recorded owner pid is still
// ALIVE → refuse (a real concurrent migrate), else steal the stale lock (a crashed migrate left it) and retry once.
const defaultLockRoot = () => join(homedir(), '.local', 'share', 'mrc', 'migration-locks')
const pidAlive = (p) => { try { process.kill(p, 0); return true } catch (e) { return e && e.code === 'EPERM' } }   // EPERM = exists but not ours to signal → alive
const LOCK_STALE_MS = 3_600_000   // 1h — no real migration (host FS copies) runs an hour; a live+aged lock is a hang or PID-REUSE, so steal it
export function acquireSliceLock(sliceHostDir, { lockRoot, pid = process.pid, isAlive = pidAlive, now = () => Date.now(), staleMs = LOCK_STALE_MS } = {}) {
  const root = lockRoot || defaultLockRoot(); mkdirSync(root, { recursive: true })
  const file = join(root, `${basename(sliceHostDir)}.lock`)
  for (let attempt = 0; attempt < 2; attempt++) {
    try { const fd = openSync(file, 'wx'); writeSync(fd, `${pid} ${now()}`); closeSync(fd); return { ok: true, file, release: () => { try { unlinkSync(file) } catch {} } } }
    catch (e) {
      if (!e || e.code !== 'EEXIST') throw e
      let owner = 0, ts = 0
      try { const [p, t] = readFileSync(file, 'utf8').trim().split(/\s+/); owner = Number(p); ts = Number(t) || 0 } catch {}
      // Refuse ONLY a lock that is BOTH held by a live pid AND fresh (< staleMs). The freshness guard defuses
      // PID-REUSE: a crashed migrate's pid reused by an unrelated process would otherwise be "alive" forever and
      // wedge every future migrate; an aged-out lock (or a dead owner) is stolen. `file` is returned on refuse too
      // so the caller can surface the manual escape (rm the lockfile).
      const fresh = ts > 0 && (now() - ts) < staleMs
      if (owner && owner !== pid && isAlive(owner) && fresh) return { ok: false, owner, file, release: () => {} }
      try { unlinkSync(file) } catch {}   // dead owner OR aged-out → steal + retry
    }
  }
  return { ok: false, owner: null, file, reason: 'contended', release: () => {} }
}

// ── INVARIANT 2: preflight — UNION refuse over repo-label ∪ slice-source live containers ─────────────────────
// A migrate mutates the slice; it must not run while ANY live container could be writing it. Check BOTH the repo
// LABEL (this repo's own sessions) AND the slice SOURCE (a cp'd sibling opened elsewhere → different repo path,
// same slice). EITHER live → refuse. EITHER undetermined (docker unresponsive) → FAIL CLOSED (refuse), never read
// as "clear" (the fail-open sin — an 8s timeout under load would falsely green a co-write). `--yes` does NOT skip this.
export function preflightLive(repoPath, sliceHostDir, { repoContainers, sliceLive } = {}) {
  // The repo arm accepts either a plain count OR a {count, determined} probe. BOTH arms fail closed: a legacy-mode
  // live container (no /mrc mount) is invisible to the slice arm, so the repo arm must be the fail-closed one that
  // catches it — a docker hiccup that silently returned 0 would let a migrate race a live legacy session (the split).
  // ABSENT-DEP default is PARANOID (Pierre F2): an unwired probe defaults to {determined:false} → REFUSE, never a
  // silent PASS. A safety gate must fail closed BY CONSTRUCTION — a future call site that drops a dep can't silently
  // disable the split-preventing preflight (the same lesson as the corrupt/record-lost accessors).
  const rc = repoContainers ? repoContainers(repoPath) : { count: 0, determined: false }
  const repoN = typeof rc === 'number' ? rc : (rc && rc.count) || 0
  const repoDet = typeof rc === 'number' ? true : !(rc && rc.determined === false)
  if (repoN > 0) return { ok: false, reason: 'repo-live', detail: `${repoN} live mrc container(s) are open for this repo` }
  if (!repoDet) return { ok: false, reason: 'undetermined', detail: 'could not confirm no live container is open for this repo (docker unresponsive, or the probe was not wired) — refusing rather than risk a concurrent write (fail-closed)' }
  const sl = sliceLive ? sliceLive(sliceHostDir) : { id: null, determined: false }
  if (sl.id) return { ok: false, reason: 'slice-live', detail: 'a live container (a copied/sibling checkout?) is using this repo\'s memory slice' }
  if (!sl.determined) return { ok: false, reason: 'undetermined', detail: 'could not confirm no live container is using this slice (docker unresponsive) — refusing rather than risk a concurrent write (fail-closed)' }
  return { ok: true }
}

// ── INVARIANT 3: capability comparison (rebuild-gated) ───────────────────────────────────────────────────────
// Apply migration M only if the running image can DRIVE its layout. `store` is a resolveStoreMode() result
// ({storeMode, cap}). A non-store-capable image drives NOTHING (recording #001 while launches still read repo/.mrc
// = a lie the record would tell). A layout migration whose layoutLevel exceeds the image's capability needs a NEWER
// image → refuse with a rebuild instruction. #001 (level 0) drives on any store-capable image.
export function imageCanDrive(store, migration) {
  if (!store || !store.storeMode) return false
  return Number(migration.layoutLevel) <= Number(store.cap)
}

// ── ADOPTION signature (guardrail A) ─────────────────────────────────────────────────────────────────────────
// The in-slice sentinel the OLD auto-migrate wrote proves a #001-level-0 relocation happened — and NOTHING higher.
// A slice at a FUTURE layout would carry a durable layout marker; if we see one we must NOT launder it down to
// level-0 (the misread reborn). `higherSignature` is true on THREE, layered strongest-first:
//   1. any file in the RESERVED layout-marker namespace `.mrc-store-layout-<N>` — the convention every layout
//      migration MUST use (registry.assertLayoutMarkerConvention is the lint that makes this SOUND, not a hope);
//   2. any registered migration's DECLARED layoutMarker present in the slice (belt against a renamed namespace);
//   3. FAIL-SAFE: any OTHER durable control file (`.mrc-*`) not in the #001 baseline set → over-strand (route to
//      manual), NEVER launder. Transient locks/probes (`.oxcl*`, `*.lock`) are not layout signatures.
// Byte-verify (ADOPT-B, in tryAdopt) is the further belt: a layout migration that RESTRUCTURED memory/ fails
// verify(legacy↔slice) → reconciler, even independent of any marker. So a higher layout is caught by marker OR
// by structure. A marker-LESS, structure-preserving level-2 is impossible under the lint (it'd have no way to be
// level-2 without either a marker or a restructure).
export function adoptionSignature(sliceHostDir) {
  let files = []; try { files = readdirSync(sliceHostDir) } catch {}
  const has001Sentinel = files.includes('.mrc-store-migrated-v2') || files.includes('.mrc-store-migrated')
  return { has001Sentinel, higherSignature: sliceHigherSignature(sliceHostDir) }   // the ONE detector, shared with memberStoreActive
}

// tryAdopt — guardrails A (downward-only) + B (verify-then-record) + C (provenance). Returns the outcome; the
// CALLER surfaces it. NEVER records on the bare sentinel: verify(legacy↔slice) is the gate. A diverged slice
// (the split incident) fails verify → routed to the reconciler, never blind-stamped.
export function tryAdopt(legacyDir, sliceHostDir, { metaRoot, mod = mig001, exclude = null, include = null } = {}) {
  const sig = adoptionSignature(sliceHostDir)
  if (!sig.has001Sentinel) return { adopted: false, reason: 'no-sentinel' }
  if (sig.higherSignature) return { adopted: false, reason: 'higher-signature', deny: true }        // (A) evidence of a layout beyond #001 → DENY
  // (B) verify-then-record. Adoption uses the LOSS-DETECTION gate (verifyAdopt) — an already-USED slice has evolved
  // (session-names grew, memory/ edited, continued transcripts longer); byte-equality would false-strand it. Only a
  // genuine split (fork / legacy-ahead / lost content) fails → reconciler. (Falls back to strict verify if a future
  // migration doesn't define verifyAdopt.)
  const verify = (mod.verifyAdopt || mod.verify)({ legacyDir, sliceDir: sliceHostDir, exclude, include })
  if (!verify.pass) return { adopted: false, reason: 'verify-failed', verify, reconcile: true }       // diverged/dropped → reconciler
  const record = recordMigration(sliceHostDir, mod, { metaRoot, adopted: true, from: 'in-slice-sentinel', verifiedByteIdentical: true })   // (C) provenance
  try { normalizeSliceMtimes(sliceHostDir, legacyDir) } catch {}   // fresh-migrate normalizes via #001.up; adoption must too (a pre-mtime-fix slice has clobbered recency)
  return { adopted: true, record, verify }
}

// ── decideUp — the pure `up` decision from slice state (deny states handled BEFORE pendingMigrations, which throws) ──
// Actions: 'halt' (corrupt / higher-signature / record-lost-no-sentinel → manual), 'adopt' (sentinel, no record, no
// higher sig → verify-then-adopt), 'migrate' (fresh/partial with pending work), 'noop' (nothing pending).
export function decideUp(legacyDir, sliceHostDir, { metaRoot, init = false } = {}) {
  const st = sliceMigrationState(sliceHostDir, { metaRoot })
  if (st.corrupt) return { action: 'halt', reason: 'corrupt-record' }
  const sig = adoptionSignature(sliceHostDir)
  if (st.recordLost) {
    if (!sig.has001Sentinel) return { action: 'halt', reason: 'record-lost-no-sentinel' }   // data, no record, no sentinel → can't prove level → manual
    if (sig.higherSignature) return { action: 'halt', reason: 'higher-signature' }          // (A)
    return { action: 'adopt' }
  }
  const pending = MIGRATIONS.filter(m => !st.ran.has(m.id) && (typeof m.isPending === 'function' ? m.isPending({ legacyDir, sliceDir: sliceHostDir }) : true))
  if (pending.length === 0) {
    if (st.migrated) return { action: 'noop', reason: 'already-migrated' }
    // Fresh repo with NO memory to relocate. Model A (Pierre): opting an EMPTY repo into the store is an EXPLICIT,
    // RECORDED act (`--init`) — it keeps #13's invariant (store-active ⟺ a host record), so no recordLost-mint (D1a's
    // class) and no launch-coupled auto (which "empty ⟹ auto-store" would reintroduce, on a racy + clone-forgeable
    // "empty" gate). Without --init a bare `up` stays a noop (no surprise slice on a random dir) and points at --init.
    if (init) return { action: 'init', pending: MIGRATIONS.filter(m => !st.ran.has(m.id)) }
    return { action: 'noop', reason: 'nothing-pending' }
  }
  return { action: 'migrate', pending }
}

// ── INVARIANT 5: detach (opt-out) ────────────────────────────────────────────────────────────────────────────
// store-BORN content = slice memory leaves that are NOT byte-present in repo/.mrc (created in the slice, never in
// legacy — a legacy launch could never see them). Opting out strands them, so detach REFUSES by default when any
// exist; --force-detach proceeds (loudly). Reuses the ONE enumeration (planMigration) over the SLICE, so it can't
// drift from what a migration considers "memory".
export function storeBornContent(legacyDir, sliceHostDir, { exclude = null, include = null } = {}) {
  const born = []
  const plan = planMigration(sliceHostDir, { exclude, include })
  for (const rel of plan.manifest) {
    const lf = join(legacyDir, rel)
    if (!existsSync(lf) || sha256(lf) !== sha256(join(sliceHostDir, rel))) born.push(rel)
  }
  return born
}
export function decideDetach(legacyDir, sliceHostDir, { force = false } = {}) {
  const born = storeBornContent(legacyDir, sliceHostDir)
  if (born.length && !force) return { action: 'refuse', born }
  return { action: 'detach', born }
}

// ── #14: THE RECONCILER (heals a split — the counterpart to the runner's diverged-refusal) ────────────────────
// A split is repo/.mrc (the frozen migration snapshot, or content a LEGACY launch wrote after migration) diverging
// from the store slice. verifyAdopt REFUSES to adopt a diverged repo (never a blind stamp); the reconciler is how
// that repo gets UNIFIED — losslessly where safe, surfaced-and-pickable where not — after which adoption records it.
// Per-transcript, legacy vs slice (append-only ordered logs):
//   • in-sync / slice-ahead (legacy ⊑ slice) → NOTHING (the slice already has it all).
//   • legacy-ahead (slice ⊑ legacy — repo/.mrc grew past the slice) → EXTEND: slice ← legacy (lossless; slice ⊂ legacy).
//   • diverged (neither is a prefix — both got unique turns after the split) → PROMOTE the legacy fork to a NEW
//     pickable session (`<newuuid>.jsonl` + a `session-names` entry "…(legacy fork <date>)"); the slice KEEPS its own
//     version at the original uuid. BOTH appear in `mrc pick`; the human chooses by reading. Never a silent drop,
//     never an auto-merge of two realities, never a `.conflict` dead-letter (invisible to the picker = theater).
//   • missing-in-slice (legacy transcript never made it) → COPY-IN.
//   • session-names → UNION legacy keys the slice lacks (a name is never dropped). Living memory/ → slice authoritative
//     (present) or copy-in (missing) — reconcile heals unrecoverable TRANSCRIPT history, not free-form memory content.
const fileLines = (f) => { try { const a = readFileSync(f, 'utf8').split('\n'); while (a.length && a[a.length - 1] === '') a.pop(); return a } catch { return null } }
const linePrefix = (a, b) => { if (!a || !b || a.length > b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true }
const nameKey = (line) => { const i = line.indexOf('='); return i < 0 ? line : line.slice(0, i) }
// does ANY slice .jsonl byte-equal `legacyFile`? (an already-promoted legacy fork lands as a NEW uuid byte-equal to
// the legacy transcript) — makes the diverged→fork action IDEMPOTENT so a re-plan after apply converges to empty.
const sliceHasByteEqual = (sliceHostDir, legacyFile) => {
  const want = sha256(legacyFile); if (!want) return false
  try { for (const f of readdirSync(sliceHostDir)) if (f.endsWith('.jsonl') && sha256(join(sliceHostDir, f)) === want) return true } catch {}
  return false
}

// IDEMPOTENT by construction: after applyReconcile, planReconcile MUST return zero ACTIONS (that empty re-plan is
// runReconcile's record gate). So every action's post-state re-plans to no-action: extend→slice==legacy; copy-in→
// present; merge-names→emitted only on a MISSING KEY (not a byte-diff), so a superset re-plans clean; promote-fork→
// emitted only if legacy's content isn't ALREADY byte-present as a slice fork. `infos` are NON-blocking surfacings
// (they do NOT gate the record): a living file present-but-SHRUNK vs the snapshot (parity with adoption's shrink
// INFO — no-silent-failure), and a DIVERGED nested subagent leaf (see below). infos persist across re-plans and are
// deliberately kept OUT of `actions` so they never block convergence.
export function planReconcile(legacyDir, sliceHostDir, { exclude = null, include = null } = {}) {
  const plan = planMigration(legacyDir, { exclude, include })
  const actions = [], infos = []
  const sizeOf = (f) => { try { return statSync(f).size } catch { return 0 } }
  for (const rel of plan.manifest) {
    const lf = join(legacyDir, rel), sf = join(sliceHostDir, rel)
    if (!rel.endsWith('.jsonl')) {
      if (!existsSync(sf)) { actions.push({ rel, kind: 'copy-in' }); continue }
      if (rel === 'session-names') {                                          // union on a MISSING KEY (idempotent), not a byte-diff
        const sliceKeys = new Set((fileLines(sf) || []).map(nameKey))
        if ((fileLines(lf) || []).some(l => l && !sliceKeys.has(nameKey(l)))) actions.push({ rel, kind: 'merge-names' })
      } else if (sha256(lf) !== sha256(sf) && sizeOf(sf) < sizeOf(lf)) {
        infos.push({ rel, kind: 'shrank', legacyBytes: sizeOf(lf), sliceBytes: sizeOf(sf) })   // living file present-but-smaller (parity w/ adoption)
      }
      // names-migrated/security-migrated markers + living memory/: slice authoritative; only SURFACE a shrink.
      continue
    }
    if (!existsSync(sf)) { actions.push({ rel, kind: 'copy-in' }); continue }
    if (sha256(lf) === sha256(sf)) continue
    const la = fileLines(lf), sa = fileLines(sf)
    if (linePrefix(la, sa)) continue                                         // slice-ahead → noop
    if (linePrefix(sa, la)) { actions.push({ rel, kind: 'extend' }); continue }   // legacy-ahead → slice ← legacy (lossless)
    // DIVERGED. A TOP-LEVEL transcript is a user conversation → promote its legacy fork to a pickable session. A
    // NESTED `<uuid>/sub.jsonl` is an internal SUBAGENT artifact — promoting it to a top-level pickable session would
    // surface a subagent as a user conversation (Pierre). So DON'T: its legacy fork stays in repo/.mrc (non-destructive)
    // and we SURFACE it (info), rather than mis-promote. (extend/copy-in above already handle the recoverable nested cases.)
    if (rel.includes('/')) { infos.push({ rel, kind: 'diverged-subagent' }); continue }
    if (!sliceHasByteEqual(sliceHostDir, lf)) actions.push({ rel, kind: 'promote-fork', uuid: rel.replace(/\.jsonl$/, '') })  // diverged (unless already forked)
  }
  return { actions, infos }
}

// Apply a reconcile plan to the slice. Injected `now`/`newId` for deterministic tests. Returns what it did.
export function applyReconcile(legacyDir, sliceHostDir, plan, { now = () => new Date(), newId = randomUUID } = {}) {
  const res = { copied: 0, extended: 0, promoted: [], mergedNames: 0 }
  const nameFor = (uuid) => {
    for (const dir of [sliceHostDir, legacyDir]) {
      try { for (const l of readFileSync(join(dir, 'session-names'), 'utf8').split('\n')) if (l && nameKey(l) === uuid) return l.slice(l.indexOf('=') + 1) } catch {}
    }
    return uuid.slice(0, 8)
  }
  const stamp = (() => { try { return now().toISOString().slice(0, 10) } catch { return 'fork' } })()
  for (const a of plan.actions) {
    const lf = join(legacyDir, a.rel), sf = join(sliceHostDir, a.rel)
    if (a.kind === 'copy-in') { mkdirSync(dirname(sf), { recursive: true }); copyFileSync(lf, sf); res.copied++ }
    else if (a.kind === 'extend') { copyFileSync(lf, sf); res.extended++ }                       // slice ⊂ legacy → overwrite is lossless
    else if (a.kind === 'promote-fork') {
      const nid = newId(); copyFileSync(lf, join(sliceHostDir, `${nid}.jsonl`))                   // legacy fork → a NEW pickable uuid; slice keeps its own
      try { appendFileSync(join(sliceHostDir, 'session-names'), `${nid}=${nameFor(a.uuid)} (legacy fork ${stamp})\n`) } catch {}
      res.promoted.push({ from: a.uuid, to: nid })
    } else if (a.kind === 'merge-names') {
      const sliceKeys = new Set((fileLines(sf) || []).map(nameKey))
      const add = (fileLines(lf) || []).filter(l => l && !sliceKeys.has(nameKey(l)))
      if (add.length) { try { appendFileSync(sf, add.map(l => l + '\n').join('')); res.mergedNames += add.length } catch {} }
    }
  }
  return res
}

// ── INVARIANT 7: status (honest state) ───────────────────────────────────────────────────────────────────────
export function statusReport(legacyDir, sliceHostDir, { metaRoot } = {}) {
  const st = sliceMigrationState(sliceHostDir, { metaRoot })
  const sig = adoptionSignature(sliceHostDir)
  const applied = [...st.ran.keys()]
  let state, pending = []
  if (st.corrupt) state = 'corrupt'
  else if (st.recordLost) state = (sig.has001Sentinel && !sig.higherSignature) ? 'adoptable' : 'stranded'
  else {
    pending = MIGRATIONS.filter(m => !st.ran.has(m.id) && (typeof m.isPending === 'function' ? m.isPending({ legacyDir, sliceDir: sliceHostDir }) : true)).map(m => m.id)
    if (st.migrated) state = pending.length ? 'partial' : 'migrated'
    else state = pending.length ? 'unmigrated' : 'fresh'
  }
  // A store LEVEL is meaningful only once the slice is actually tracked in the store (migrated/partial). fresh /
  // unmigrated / adoptable / stranded / corrupt render "—" (not "level 0", which reads as "in the store at 0").
  const tracked = state === 'migrated' || state === 'partial'
  return { state, applied, pending, layoutLevel: tracked ? st.layoutLevel : null, sliceId: basename(sliceHostDir) }
}

// ── The CLI shell — composes the pure core with injected effectful deps (docker probes, capability, prompt, log) ──
// Every effectful boundary is injected so the control flow (esp. the "--yes past preflight" door #4 and the
// "verify-fails-so-don't-record" gate) is unit-testable without docker or a TTY. mrc.js supplies real deps.
export async function runMigrate(sub, repoPath, opts = {}) {
  const d = opts.deps || {}
  const log = d.log || ((m) => console.error(m))
  const legacyDir = d.legacyDir || join(resolve(repoPath), '.mrc')
  const sliceHostDir = d.sliceHostDir || repoSliceDir(resolve(repoPath))
  const metaRoot = d.metaRoot   // undefined in prod → registry uses the real host meta root
  const yes = !!opts.yes
  const init = !!opts.init

  if (sub === 'status') {
    const rep = statusReport(legacyDir, sliceHostDir, { metaRoot })
    log(renderStatus(rep, { repoPath, sliceHostDir }))
    return { ...rep, ok: true }
  }

  // up + detach both take the LOCK and the live-container PREFLIGHT first (invariants 1 + 2) — ALWAYS, --yes or not.
  const lock = (d.acquireLock || acquireSliceLock)(sliceHostDir, { lockRoot: d.lockRoot })
  if (!lock.ok) { log(`  ✗ Another migration is in progress for this memory slice${lock.owner ? ` (pid ${lock.owner})` : ''} — refusing to run concurrently.${lock.file ? `\n    If you're certain no migration is running (e.g. after a crash), remove the stale lock:  rm ${lock.file}` : ''}`); return { ok: false, refused: 'locked' } }
  try {
    const pf = (d.preflight || preflightLive)(repoPath, sliceHostDir, { repoContainers: d.repoContainers, sliceLive: d.sliceLive })
    if (!pf.ok) {
      log(`  ✗ Refusing to migrate: ${pf.detail}.\n    Close all mrc sessions for this repo (and any copied checkout that shares its memory), then re-run \`mrc migrate ${sub}\`.`)
      return { ok: false, refused: pf.reason }
    }

    if (sub === 'detach') return await runDetach(legacyDir, sliceHostDir, { ...opts, deps: d, log })
    if (sub === 'reconcile') return await runReconcile(repoPath, legacyDir, sliceHostDir, { ...opts, deps: d, log, metaRoot, yes })
    if (sub === 'up') return await runUp(repoPath, legacyDir, sliceHostDir, { ...opts, deps: d, log, metaRoot, yes, init })
    log(`  ✗ Unknown migrate command: ${sub}. Use: up | status | detach | reconcile.`)
    return { ok: false, refused: 'unknown-subcommand' }
  } finally { lock.release() }
}

async function runUp(repoPath, legacyDir, sliceHostDir, { deps: d, log, metaRoot, yes, init = false }) {
  const decision = decideUp(legacyDir, sliceHostDir, { metaRoot, init })
  if (decision.action === 'halt') {
    log(haltMessage(decision.reason, sliceHostDir))
    return { ok: false, halted: decision.reason }
  }
  if (decision.action === 'noop') {
    if (decision.reason === 'already-migrated') { log('  ✓ This repo\'s memory is already migrated — nothing to do.'); return { ok: true, noop: true, reason: decision.reason } }
    // Fresh repo, nothing to relocate. Point at the EXPLICIT opt-in (Model A) — bare `up` never surprise-mints a slice.
    log(`  ✓ No memory to relocate here. To start THIS repo in the store from its first conversation, run:  mrc migrate up --init ${repoPath}`)
    return { ok: true, noop: true, reason: decision.reason }
  }

  // INVARIANT 3: capability — every migration we'd apply must be drivable by the running image.
  const store = d.store || { storeMode: false, cap: 0 }
  const mods = (decision.action === 'adopt') ? [mig001] : decision.pending
  const blocked = mods.filter(m => !imageCanDrive(store, m))
  if (blocked.length) {
    log(`  ✗ This image can't drive ${blocked.map(m => m.id).join(', ')} (store capability ${store.cap || 0}).\n    Rebuild a store-capable image first:  docker rmi mister-claude && mrc ${repoPath}`)
    return { ok: false, refused: 'capability' }
  }

  if (decision.action === 'adopt') {
    // Pre-framework slice (sentinel, no host record — the already-migrated repos). VERIFY-then-record.
    log('  ◎ This repo was migrated by an earlier mrc; adopting it into the migration ledger (verifying byte-identity first)…')
    const res = tryAdopt(legacyDir, sliceHostDir, { metaRoot })
    if (res.adopted) {
      clearOptOut(sliceHostDir, { metaRoot })   // adopting is opting back IN — clear any prior detach opt-out
      log('  ✓ Adopted — #001 recorded (verified no pre-migration content lost). Your memory is under the ledger now.')
      for (const c of (res.verify && res.verify.checks || []).filter(c => c.ok && c.kind === 'shrank')) log(`      ℹ ${c.msg}`)
      return { ok: true, adopted: true }
    }
    if (res.reconcile) {
      const bad = failedFiles(res.verify)
      log(`  ⚠ Adoption BLOCKED — repo/.mrc and the store slice have genuinely FORKED (${bad.length} file(s) lost or diverged). This is the mixed-mode split; it needs healing, not a blind stamp. Run:  mrc migrate reconcile ${repoPath}`)
      for (const c of bad.slice(0, 8)) log(`      • ${c.msg}`)
      return { ok: false, refused: 'diverged' }
    }
    log('  ✗ Can\'t adopt this slice automatically (no clear #001 evidence). Leaving it as-is; inspect it manually.')
    return { ok: false, refused: res.reason }
  }

  // action === 'migrate' (relocate real memory) OR 'init' (opt an EMPTY repo in — 0 files, `--init` IS the consent).
  // Both: PREVIEW (invariant 6) → CONFIRM (unless --yes / --init) → up → verify → record.
  const isInit = decision.action === 'init'
  const mod = decision.pending[0]   // ordered; #001 is the only one today. (Loop generalizes when #002 lands.)
  if (isInit) log(`\n  Initialize ${repoPath} in the host memory store (#001) — this repo has no memory to relocate; new conversations will live in the store slice.\n`)
  else {
    const prev = mod.preview ? mod.preview({ legacyDir, sliceDir: sliceHostDir }) : {}
    log(renderPreview(mod, prev, { legacyDir, sliceHostDir, preExisting: slicePrePopulated(sliceHostDir) }))
  }
  if (!yes && !isInit) {
    const ok = d.confirm ? await d.confirm('  Proceed with the migration?') : false
    if (!ok) { log('  Aborted (no changes made).'); return { ok: false, refused: 'declined' } }
  }
  const upRes = mod.up({ legacyDir, sliceDir: sliceHostDir })                                  // non-destructive copy (0 files for --init)
  const verify = mod.verify({ legacyDir, sliceDir: sliceHostDir, manifest: upRes.manifest, refused: upRes.refused })
  if (!verify.pass) {
    // INVARIANT 8: do NOT record on a failed verify. Surface it; a divergent sharer / drop routes to the reconciler.
    const bad = failedFiles(verify)
    log(`  ✗ Migration verify FAILED — ${bad.length} file(s) differ or are missing. NOT recording it. repo/.mrc is untouched (non-destructive).`)
    for (const c of bad.slice(0, 8)) log(`      • ${c.msg}`)
    return { ok: false, refused: 'verify-failed', verify }
  }
  const record = recordMigration(sliceHostDir, mod, { metaRoot, manifest: upRes.manifest, ...(isInit ? { init: true } : {}) })   // host-only, atomic, AFTER verify
  clearOptOut(sliceHostDir, { metaRoot })   // migrating/init is opting IN — clear any prior detach opt-out
  log(isInit
    ? `  ✓ Initialized ${repoPath} in the host store (recorded ${mod.id}). New conversations live in the store from now on.`
    : `  ✓ Migrated ${upRes.migrated} file(s) (verified byte-identical), recorded ${mod.id}. repo/.mrc is retained (non-destructive).`)
  return { ok: true, migrated: upRes.migrated, init: isInit, record }
}

async function runDetach(legacyDir, sliceHostDir, { deps: d, log, force = false, yes = false }) {
  const decision = decideDetach(legacyDir, sliceHostDir, { force })
  if (decision.action === 'refuse') {
    log(`  ✗ Refusing to detach: ${decision.born.length} conversation/memory file(s) live ONLY in the store (born after migration) and would be STRANDED by opting out.`)
    for (const b of decision.born.slice(0, 8)) log(`      • ${b}`)
    log('    The store keeps them safe; a legacy launch just can\'t see them. If you truly want to opt out anyway, re-run with --force-detach (the slice is preserved, nothing is deleted).')
    return { ok: false, refused: 'store-born' }
  }
  if (!yes && !force) {
    const ok = d.confirm ? await d.confirm('  Opt this repo OUT of the memory store (revert to legacy repo/.mrc)?') : false
    if (!ok) { log('  Aborted (no changes made).'); return { ok: false, refused: 'declined' } }
  }
  ;(d.recordOptOut || recordOptOut)(sliceHostDir, { metaRoot: d.metaRoot })
  log(`  ✓ Opted out of the memory store for this repo. Launches will read legacy repo/.mrc again. The slice is PRESERVED (not deleted); re-run \`mrc migrate up\` to opt back in.${decision.born.length ? ' (--force-detach: store-born content stays in the slice, not visible to legacy launches.)' : ''}`)
  return { ok: true, detached: true }
}

// #14: `mrc migrate reconcile` — heal a split, then adopt. Plans the per-transcript actions, previews them (so the
// human sees exactly what merges vs what becomes a new pickable fork), applies (a slice WRITE — already behind the
// lock + live-container preflight in runMigrate), then RECORDS the adoption (the repo is now consistent → no loss).
// After a diverged `up` refusal, this is the path forward. Non-destructive to repo/.mrc; slice-forks are additive.
async function runReconcile(repoPath, legacyDir, sliceHostDir, { deps: d, log, metaRoot, yes }) {
  if (!existsSync(sliceHostDir)) { log('  ✓ Nothing to reconcile — this repo has no store slice yet. Run `mrc migrate up` first.'); return { ok: true, noop: true } }
  // The RECORD gate is a fork-aware, CONVERGENT re-plan: after applyReconcile every legacy transcript is present in
  // the slice (extended / copied / already-forked), so a re-plan returns ZERO actions — THAT is "unified, no loss."
  // We record on the empty re-plan, NOT via verifyAdopt (which would re-flag the DELIBERATE fork divergence at the
  // original uuid). recordAdopted stamps #001 with reconcile provenance.
  const recordUnified = (forks) => {
    normalizeSliceMtimes(sliceHostDir, legacyDir)
    const rec = recordMigration(sliceHostDir, mig001, { metaRoot, adopted: true, from: 'reconcile', reconciled: true, forks: forks || [] })
    clearOptOut(sliceHostDir, { metaRoot })
    return rec
  }
  const plan = planReconcile(legacyDir, sliceHostDir)
  const surfaceInfos = (infos) => {
    for (const i of infos || []) {
      if (i.kind === 'shrank') log(`      ℹ ${i.rel} is smaller in the store (${i.sliceBytes}B) than at migration (${i.legacyBytes}B) — expected if edited down; check if unexpected (frozen copy in repo/.mrc).`)
      else if (i.kind === 'diverged-subagent') log(`      ℹ ${i.rel} (a subagent transcript) diverged; its legacy version is kept in repo/.mrc (not promoted to a top-level session).`)
    }
  }
  const alreadyMigrated = sliceMigrationState(sliceHostDir, { metaRoot }).migrated
  if (plan.actions.length === 0) {
    surfaceInfos(plan.infos)
    if (alreadyMigrated) { log('  ✓ Nothing to reconcile — repo/.mrc and the store are already consistent and adopted.'); return { ok: true, noop: true, adopted: true } }
    recordUnified([])   // consistent (lossless superset by construction) but unrecorded → record the adoption
    log('  ✓ Nothing to reconcile — repo/.mrc and the store are already consistent; adoption recorded.')
    return { ok: true, noop: true, adopted: true }
  }
  const byKind = plan.actions.reduce((m, a) => { m[a.kind] = (m[a.kind] || 0) + 1; return m }, {})
  log('')
  log(`  Reconcile plan for ${repoPath}:`)
  if (byKind['extend']) log(`    • ${byKind['extend']} conversation(s) where repo/.mrc is AHEAD of the store → the store takes the longer version (lossless).`)
  if (byKind['promote-fork']) log(`    • ${byKind['promote-fork']} conversation(s) genuinely FORKED → the repo/.mrc version becomes a NEW pickable session "(legacy fork)"; the store keeps its own. You choose in \`mrc pick\`.`)
  if (byKind['copy-in']) log(`    • ${byKind['copy-in']} conversation/file(s) missing from the store → copied in.`)
  if (byKind['merge-names']) log(`    • session names union-merged (no name dropped).`)
  log('    repo/.mrc is untouched (non-destructive); store forks are additive (nothing is overwritten except a strictly-longer log).')
  log('')
  if (!yes) {
    const ok = d.confirm ? await d.confirm('  Apply this reconcile and adopt the repo?') : false
    if (!ok) { log('  Aborted (no changes made).'); return { ok: false, refused: 'declined' } }
  }
  const applied = applyReconcile(legacyDir, sliceHostDir, plan, {})
  const remaining = planReconcile(legacyDir, sliceHostDir)   // fork-aware convergent re-plan = the record gate
  const forks = applied.promoted.map(p => p.to)
  log(`  ✓ Reconciled: ${applied.extended} extended, ${applied.copied} copied-in, ${applied.promoted.length} forked-to-pickable${applied.mergedNames ? `, ${applied.mergedNames} name(s) merged` : ''}.`)
  if (forks.length) log(`    New pickable "(legacy fork)" session(s) in \`mrc pick\`: ${forks.map(f => f.slice(0, 8)).join(', ')}`)
  surfaceInfos(remaining.infos)   // living-file shrink / diverged-subagent notes (non-blocking, parity with adoption)
  if (remaining.actions.length === 0) {
    recordUnified(applied.promoted)
    log('  ✓ Adopted — the repo is unified and under the ledger now.')
    return { ok: true, reconciled: applied, adopted: true }
  }
  log(`  ⚠ Reconciled, but ${remaining.actions.length} action(s) did not settle (a write failed?) — NOT recording. Inspect \`mrc migrate status\`. (repo/.mrc is untouched.)`)
  return { ok: true, reconciled: applied, adopted: false, remaining: remaining.actions }
}

// slice is pre-populated with memory (may be a SHARED slice — a sibling copy migrated first). Surfaced in preview.
function slicePrePopulated(sliceHostDir) {
  try { return readdirSync(sliceHostDir).some(f => f.endsWith('.jsonl') || f === 'memory' || f === 'session-summaries') } catch { return false }
}

function renderPreview(mod, prev, { legacyDir, sliceHostDir, preExisting }) {
  const lines = ['', `  Migration ${mod.id}`, `    ${mod.description}`, '']
  if (prev.conversations != null) lines.push(`    • ${prev.conversations} conversation(s)${prev.bytes ? `, ${(prev.bytes / 1024).toFixed(0)} KB` : ''}${prev.hasMemory ? ' + shared memory/' : ''} will be COPIED into the store.`)
  lines.push(`    • repo/.mrc is RETAINED (non-destructive — nothing is deleted or moved).`)
  lines.push(`    • Store slice: ${sliceHostDir}`)
  if (preExisting) lines.push(`    ⚠ This slice ALREADY has memory — a copied/sibling checkout may share it. Files present in the store are kept (copy-if-absent); byte differences are surfaced by verify.`)
  lines.push('')
  return lines.join('\n')
}

function renderStatus(rep, { repoPath, sliceHostDir }) {
  const label = {
    fresh: '○ fresh (no legacy memory to migrate)',
    unmigrated: '● UNMIGRATED — run `mrc migrate up`',
    partial: '◐ PARTIAL — pending: ' + rep.pending.join(', '),
    migrated: '✓ migrated (in the store)',
    adoptable: '↥ ADOPTABLE — migrated by an earlier mrc but not in the ledger; `mrc migrate up` will adopt it',
    stranded: '⚠ STRANDED — this slice holds data but its host migration record is LOST; it needs recovery (not fresh!)',
    corrupt: '⚠ CORRUPT — the migration record is unreadable; store-mode is denied (fail-closed) until fixed',
  }[rep.state] || rep.state
  return [
    '', `  Migration status — ${repoPath}`,
    `    slice:   ${sliceHostDir}`,
    `    state:   ${label}`,
    `    applied: ${rep.applied.length ? rep.applied.join(', ') : '(none)'}`,
    rep.layoutLevel != null ? `    layout:  store level ${rep.layoutLevel}` : `    layout:  — (not tracked at a store level)`,
    '',
  ].join('\n')
}

function haltMessage(reason, sliceHostDir) {
  const meta = `~/.local/share/mrc/migration-meta/${basename(sliceHostDir)}`
  if (reason === 'corrupt-record') return `  ✗ HALTED: this slice's migration record is CORRUPT (unreadable). Store-mode is denied (fail-closed). Inspect ${meta} — remove the bad record to let \`mrc migrate up\` re-derive, or restore it from a backup.`
  if (reason === 'higher-signature') return `  ✗ HALTED: this slice shows a layout NEWER than #001 but has no host record — refusing to adopt it DOWN to level 0 (that would misread its layout). It needs manual recovery; inspect ${meta}.`
  if (reason === 'record-lost-no-sentinel') return `  ✗ HALTED: this slice holds data but has neither a host record nor a recognizable migration sentinel — can't prove its layout. Refusing to blind-migrate. Inspect the slice + ${meta}.`
  return `  ✗ HALTED: ${reason}.`
}

// OPT-OUT marker helpers (recordOptOut / clearOptOut / isOptedOut) now live in migrations/registry.js — the same
// trust tier + meta dir as the records, and where storeActivation reads them. `homedir` is no longer needed here.
