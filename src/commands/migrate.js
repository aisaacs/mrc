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
import { join, basename, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { openSync, writeSync, closeSync, readFileSync, unlinkSync, mkdirSync, readdirSync, existsSync, writeFileSync, renameSync } from 'node:fs'
import { MIGRATIONS, sliceMigrationState, recordMigration, LAYOUT_MARKER_RE, layoutMarkersOf } from '../migrations/registry.js'
import mig001 from '../migrations/001-relocate-mrc-to-store.js'
import { mrcStoreDir, storeCtx, planMigration } from '../mrc-store.js'

const sha256 = (f) => { try { return createHash('sha256').update(readFileSync(f)).digest('hex') } catch { return null } }

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
const KNOWN_001_CONTROL = new Set(['.mrc-store-migrated', '.mrc-store-migrated-v2', '.mrc-mtimes-normalized', '.mrc-migrate.log'])
const isControl = (f) => f.startsWith('.mrc-') || f.startsWith('.oxcl') || f.endsWith('.lock')
const isTransientControl = (f) => f.startsWith('.oxcl') || f.endsWith('.lock')
export function adoptionSignature(sliceHostDir) {
  let files = []; try { files = readdirSync(sliceHostDir) } catch {}
  const control = files.filter(isControl)
  const has001Sentinel = control.includes('.mrc-store-migrated-v2') || control.includes('.mrc-store-migrated')
  const declared = layoutMarkersOf()
  const higherSignature =
    files.some(f => LAYOUT_MARKER_RE.test(f) || declared.has(f)) ||                     // (1)+(2) reserved namespace / declared markers
    control.some(f => !KNOWN_001_CONTROL.has(f) && !isTransientControl(f))              // (3) fail-safe: unknown durable control → over-strand
  return { has001Sentinel, higherSignature }
}

// tryAdopt — guardrails A (downward-only) + B (verify-then-record) + C (provenance). Returns the outcome; the
// CALLER surfaces it. NEVER records on the bare sentinel: verify(legacy↔slice) is the gate. A diverged slice
// (the split incident) fails verify → routed to the reconciler, never blind-stamped.
export function tryAdopt(legacyDir, sliceHostDir, { metaRoot, mod = mig001, exclude = null, include = null } = {}) {
  const sig = adoptionSignature(sliceHostDir)
  if (!sig.has001Sentinel) return { adopted: false, reason: 'no-sentinel' }
  if (sig.higherSignature) return { adopted: false, reason: 'higher-signature', deny: true }        // (A) evidence of a layout beyond #001 → DENY
  const verify = mod.verify({ legacyDir, sliceDir: sliceHostDir, exclude, include })                 // (B) verify-then-record
  if (!verify.pass) return { adopted: false, reason: 'verify-failed', verify, reconcile: true }       // diverged/dropped → reconciler
  const record = recordMigration(sliceHostDir, mod, { metaRoot, adopted: true, from: 'in-slice-sentinel', verifiedByteIdentical: true })   // (C) provenance
  return { adopted: true, record }
}

// ── decideUp — the pure `up` decision from slice state (deny states handled BEFORE pendingMigrations, which throws) ──
// Actions: 'halt' (corrupt / higher-signature / record-lost-no-sentinel → manual), 'adopt' (sentinel, no record, no
// higher sig → verify-then-adopt), 'migrate' (fresh/partial with pending work), 'noop' (nothing pending).
export function decideUp(legacyDir, sliceHostDir, { metaRoot } = {}) {
  const st = sliceMigrationState(sliceHostDir, { metaRoot })
  if (st.corrupt) return { action: 'halt', reason: 'corrupt-record' }
  const sig = adoptionSignature(sliceHostDir)
  if (st.recordLost) {
    if (!sig.has001Sentinel) return { action: 'halt', reason: 'record-lost-no-sentinel' }   // data, no record, no sentinel → can't prove level → manual
    if (sig.higherSignature) return { action: 'halt', reason: 'higher-signature' }          // (A)
    return { action: 'adopt' }
  }
  const pending = MIGRATIONS.filter(m => !st.ran.has(m.id) && (typeof m.isPending === 'function' ? m.isPending({ legacyDir, sliceDir: sliceHostDir }) : true))
  if (pending.length === 0) return { action: 'noop', reason: st.migrated ? 'already-migrated' : 'nothing-pending' }
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
    if (sub === 'up') return await runUp(repoPath, legacyDir, sliceHostDir, { ...opts, deps: d, log, metaRoot, yes })
    log(`  ✗ Unknown migrate command: ${sub}. Use: up | status | detach.`)
    return { ok: false, refused: 'unknown-subcommand' }
  } finally { lock.release() }
}

async function runUp(repoPath, legacyDir, sliceHostDir, { deps: d, log, metaRoot, yes }) {
  const decision = decideUp(legacyDir, sliceHostDir, { metaRoot })
  if (decision.action === 'halt') {
    log(haltMessage(decision.reason, sliceHostDir))
    return { ok: false, halted: decision.reason }
  }
  if (decision.action === 'noop') {
    log(decision.reason === 'already-migrated'
      ? '  ✓ This repo\'s memory is already migrated — nothing to do.'
      : '  ✓ Nothing to migrate here (no legacy .mrc memory to relocate).')
    return { ok: true, noop: true, reason: decision.reason }
  }

  // INVARIANT 3: capability — every migration we'd apply must be drivable by the running image.
  const store = d.store || { storeMode: false, cap: 0 }
  const mods = decision.action === 'adopt' ? [mig001] : decision.pending
  const blocked = mods.filter(m => !imageCanDrive(store, m))
  if (blocked.length) {
    log(`  ✗ This image can't drive ${blocked.map(m => m.id).join(', ')} (store capability ${store.cap || 0}).\n    Rebuild a store-capable image first:  docker rmi mister-claude && mrc ${repoPath}`)
    return { ok: false, refused: 'capability' }
  }

  if (decision.action === 'adopt') {
    // Pre-framework slice (sentinel, no host record — the already-migrated repos). VERIFY-then-record.
    log('  ◎ This repo was migrated by an earlier mrc; adopting it into the migration ledger (verifying byte-identity first)…')
    const res = tryAdopt(legacyDir, sliceHostDir, { metaRoot })
    if (res.adopted) { log('  ✓ Adopted — #001 recorded (verified byte-identical). Your memory is under the ledger now.'); return { ok: true, adopted: true } }
    if (res.reconcile) { log(`  ⚠ Adoption BLOCKED — repo/.mrc and the store slice have DIVERGED (${res.verify.checks.filter(c => c.ok === false).length} file(s) differ/missing). This is the mixed-mode split; it needs the reconciler, not a blind stamp. Run \`mrc migrate status\` for detail (reconciler: task #14).`); return { ok: false, refused: 'diverged' } }
    log('  ✗ Can\'t adopt this slice automatically (no clear #001 evidence). Leaving it as-is; inspect it manually.')
    return { ok: false, refused: res.reason }
  }

  // action === 'migrate' — fresh/partial. PREVIEW (invariant 6) → CONFIRM (unless --yes) → up → verify → record.
  const mod = decision.pending[0]   // ordered; #001 is the only one today. (Loop generalizes when #002 lands.)
  const prev = mod.preview ? mod.preview({ legacyDir, sliceDir: sliceHostDir }) : {}
  const preExisting = slicePrePopulated(sliceHostDir)
  log(renderPreview(mod, prev, { legacyDir, sliceHostDir, preExisting }))
  if (!yes) {
    const ok = d.confirm ? await d.confirm('  Proceed with the migration?') : false
    if (!ok) { log('  Aborted (no changes made).'); return { ok: false, refused: 'declined' } }
  }
  const upRes = mod.up({ legacyDir, sliceDir: sliceHostDir })                                  // non-destructive copy
  const verify = mod.verify({ legacyDir, sliceDir: sliceHostDir, manifest: upRes.manifest, refused: upRes.refused })
  if (!verify.pass) {
    // INVARIANT 8: do NOT record on a failed verify. Surface it; a divergent sharer / drop routes to the reconciler.
    log(`  ✗ Migration verify FAILED — ${verify.checks.filter(c => c.ok === false).length} file(s) differ or are missing. NOT recording it. repo/.mrc is untouched (non-destructive).`)
    for (const c of verify.checks.filter(c => c.ok === false).slice(0, 8)) log(`      • ${c.msg}`)
    return { ok: false, refused: 'verify-failed', verify }
  }
  const record = recordMigration(sliceHostDir, mod, { metaRoot, manifest: upRes.manifest })     // host-only, atomic, AFTER verify
  log(`  ✓ Migrated ${upRes.migrated} file(s) (verified byte-identical), recorded ${mod.id}. repo/.mrc is retained (non-destructive).`)
  return { ok: true, migrated: upRes.migrated, record }
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

// ── OPT-OUT marker (consumed by the capability-as-version activation, task #13) ───────────────────────────────
// Host-only, in the slice's migration-meta dir (a dotfile → sliceMigrationState skips it, so it never looks like a
// migration record). INERT until #13's activation reads it; kept here so detach has a durable, tamper-proof landing
// spot on the SAME trust tier as the records. (#13 will make resolveStoreMode honor it → legacy for this slice.)
const optOutMetaDir = (sliceHostDir, metaRoot) => join(metaRoot || join(homedir(), '.local', 'share', 'mrc', 'migration-meta'), basename(sliceHostDir))
export function recordOptOut(sliceHostDir, { metaRoot } = {}) {
  const dir = optOutMetaDir(sliceHostDir, metaRoot); mkdirSync(dir, { recursive: true })
  const file = join(dir, '.opted-out'), tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ optedOut: true, at: new Date().toISOString() }) + '\n'); renameSync(tmp, file)
  return file
}
export function isOptedOut(sliceHostDir, { metaRoot } = {}) {
  try { return existsSync(join(optOutMetaDir(sliceHostDir, metaRoot), '.opted-out')) } catch { return false }
}
