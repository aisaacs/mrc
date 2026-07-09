// The `mrc migrate` RUNNER — Pierre's 8 invariants + adoption's A/B/C, as explicit doors. The doors Pierre bet I'd
// trip (build RED-first): #2 slice-not-repo preflight (a sibling copy's live container must block), #4 --yes past
// preflight (consent-waiver ≠ safety-waiver), and adoption-A's dividing test (a level-2-shaped slice with only the
// #001 sentinel + no record must DENY, never adopt-down-to-0).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import {
  preflightLive, imageCanDrive, adoptionSignature, tryAdopt, decideUp, decideDetach,
  storeBornContent, statusReport, acquireSliceLock, runMigrate, planReconcile, applyReconcile,
} from '../src/commands/migrate.js'
import { sliceMigrationState, recordMigration, assertLayoutMarkerConvention, storeActivation, memberStoreActive, recordOptOut, clearOptOut, isOptedOut } from '../src/migrations/registry.js'
import mig001 from '../src/migrations/001-relocate-mrc-to-store.js'

const U1 = '11111111-1111-1111-1111-111111111111', U2 = '22222222-2222-2222-2222-222222222222'
function ws() {
  const d = mkdtempSync(join(tmpdir(), 'mrc-migrun-'))
  const slice = join(d, 'slice'), legacy = join(d, '.mrc'), metaRoot = join(d, 'meta'), lockRoot = join(d, 'locks')
  mkdirSync(slice, { recursive: true }); mkdirSync(legacy, { recursive: true })
  return { d, slice, legacy, metaRoot, lockRoot, done: () => rmSync(d, { recursive: true, force: true }) }
}
// Seed a completed, byte-identical migration in the slice (what the old auto-migrate produced): copy legacy→slice + sentinel.
function seedMigratedSlice(w, { withRecord = false } = {}) {
  writeFileSync(join(w.legacy, `${U1}.jsonl`), 'a\n'); writeFileSync(join(w.slice, `${U1}.jsonl`), 'a\n')
  mkdirSync(join(w.legacy, 'memory')); mkdirSync(join(w.slice, 'memory'))
  writeFileSync(join(w.legacy, 'memory', 'MEMORY.md'), '# m\n'); writeFileSync(join(w.slice, 'memory', 'MEMORY.md'), '# m\n')
  writeFileSync(join(w.slice, '.mrc-store-migrated-v2'), '')
  if (withRecord) recordMigration(w.slice, mig001, { metaRoot: w.metaRoot, manifest: [`${U1}.jsonl`, 'memory/MEMORY.md'] })
}

// ── DOOR #2: preflight is SLICE-not-repo, UNION refuse, fail-closed ───────────────────────────────────────────
test('DOOR #2: a sibling copy\'s live container (repo has 0, slice is live) BLOCKS the migrate', () => {
  const w = ws()
  try {
    const pf = preflightLive('/repo', w.slice, { repoContainers: () => 0, sliceLive: () => ({ id: 'sibling-container', determined: true }) })
    assert.equal(pf.ok, false); assert.equal(pf.reason, 'slice-live')
  } finally { w.done() }
})
test('DOOR #2: this repo\'s own live container blocks', () => {
  const w = ws()
  try {
    const pf = preflightLive('/repo', w.slice, { repoContainers: () => 2, sliceLive: () => ({ id: null, determined: true }) })
    assert.equal(pf.ok, false); assert.equal(pf.reason, 'repo-live')
  } finally { w.done() }
})
test('DOOR #2: an UNDETERMINED repo-container probe fails CLOSED (a legacy live session the slice arm can\'t see)', () => {
  const w = ws()
  try {
    // repoContainers returns {count, determined:false} — a docker hiccup. A live LEGACY container (no /mrc mount) is
    // invisible to the slice arm, so this MUST refuse, not fall through to the (clear) slice probe.
    const pf = preflightLive('/repo', w.slice, { repoContainers: () => ({ count: 0, determined: false }), sliceLive: () => ({ id: null, determined: true }) })
    assert.equal(pf.ok, false); assert.equal(pf.reason, 'undetermined')
  } finally { w.done() }
})
test('DOOR #2: a determined repo probe object ({count>0}) blocks', () => {
  const w = ws()
  try {
    const pf = preflightLive('/repo', w.slice, { repoContainers: () => ({ count: 1, determined: true }), sliceLive: () => ({ id: null, determined: true }) })
    assert.equal(pf.ok, false); assert.equal(pf.reason, 'repo-live')
  } finally { w.done() }
})
test('DOOR #2: an UNDETERMINED slice probe fails CLOSED (docker unresponsive → refuse, not "clear")', () => {
  const w = ws()
  try {
    const pf = preflightLive('/repo', w.slice, { repoContainers: () => 0, sliceLive: () => ({ id: null, determined: false }) })
    assert.equal(pf.ok, false); assert.equal(pf.reason, 'undetermined')
  } finally { w.done() }
})
test('DOOR #2: all clear → ok', () => {
  const w = ws()
  try {
    const pf = preflightLive('/repo', w.slice, { repoContainers: () => 0, sliceLive: () => ({ id: null, determined: true }) })
    assert.equal(pf.ok, true)
  } finally { w.done() }
})
test('FINDING-2: absent probes default FAIL-CLOSED — an unwired preflight REFUSES, never a silent pass', () => {
  const w = ws()
  try {
    assert.equal(preflightLive('/repo', w.slice, {}).ok, false, 'no deps at all → refuse')
    assert.equal(preflightLive('/repo', w.slice, { repoContainers: () => 0 }).ok, false, 'repo clear but slice unwired → refuse')
    assert.equal(preflightLive('/repo', w.slice, { sliceLive: () => ({ id: null, determined: true }) }).ok, false, 'slice clear but repo unwired → refuse')
  } finally { w.done() }
})

// ── DOOR #4: --yes waives CONSENT, never SAFETY (preflight still runs; a failing preflight refuses + never applies) ──
test('DOOR #4: --yes does NOT skip preflight — a live slice refuses and up() is NEVER called', async () => {
  const w = ws()
  seedMigratedSlice(w)
  let applied = false
  const mod = { ...mig001, up: () => { applied = true; return mig001.up.call(mig001, arguments) } }
  try {
    const res = await runMigrate('up', '/repo', {
      yes: true,
      deps: {
        legacyDir: w.legacy, sliceHostDir: w.slice, metaRoot: w.metaRoot, lockRoot: w.lockRoot,
        repoContainers: () => 0, sliceLive: () => ({ id: 'live', determined: true }),   // slice is LIVE
        store: { storeMode: true, cap: 1 }, log: () => {},
      },
    })
    assert.equal(res.ok, false); assert.equal(res.refused, 'slice-live')
    assert.equal(applied, false, '--yes must not push a migration past a failing preflight')
  } finally { w.done() }
})

// ── ADOPTION A (dividing test): a slice with a HIGHER-layout signature + only the #001 sentinel + no record → DENY ──
test('ADOPTION-A: level-2-shaped slice (a newer control marker) with only the #001 sentinel + no record → DENY, not adopt-to-0', () => {
  const w = ws()
  seedMigratedSlice(w)
  writeFileSync(join(w.slice, '.mrc-store-layout-2'), '')   // a marker from a FUTURE (level-2) migration
  try {
    const sig = adoptionSignature(w.slice)
    assert.equal(sig.has001Sentinel, true); assert.equal(sig.higherSignature, true, 'a non-#001 control marker is a higher-layout signature')
    const dec = decideUp(w.legacy, w.slice, { metaRoot: w.metaRoot })
    assert.equal(dec.action, 'halt'); assert.equal(dec.reason, 'higher-signature')
    const res = tryAdopt(w.legacy, w.slice, { metaRoot: w.metaRoot })
    assert.equal(res.adopted, false); assert.equal(res.deny, true)
    assert.equal(existsSync(join(w.metaRoot, basename(w.slice), mig001.id)), false, 'NO record written — did not launder to level 0')
  } finally { w.done() }
})
test('ADOPTION-A: the #001 sentinel alone (no higher marker) is NOT a higher signature', () => {
  const w = ws()
  seedMigratedSlice(w)
  writeFileSync(join(w.slice, '.mrc-mtimes-normalized'), '')   // a KNOWN #001-era control file — must not count as higher
  writeFileSync(join(w.slice, '.mrc-migrate.log'), 'x\n')
  writeFileSync(join(w.slice, 'slice.lock'), '')               // transient lock — not a layout signature
  try {
    const sig = adoptionSignature(w.slice)
    assert.equal(sig.has001Sentinel, true); assert.equal(sig.higherSignature, false)
  } finally { w.done() }
})

// ── FINDING-1 (ADOPT-A made SOUND): the layout-marker convention lint + namespace detection ──────────────────
test('FINDING-1 lint: the shipped MIGRATIONS satisfy the layout-marker convention (armed for #002)', () => {
  assert.equal(assertLayoutMarkerConvention(), true)   // #001 is level-0/neutral → no marker required
})
test('FINDING-1 lint: a future layout migration (level>=1) WITHOUT a conforming marker THROWS at dev time', () => {
  assert.throws(() => assertLayoutMarkerConvention([{ id: '002-x', layoutLevel: 2 }]), /layoutMarker/)
  assert.throws(() => assertLayoutMarkerConvention([{ id: '002-x', layoutLevel: 2, layoutMarker: 'layout2.json' }]), /layoutMarker/, 'a non-namespace marker is rejected')
  assert.equal(assertLayoutMarkerConvention([{ id: '002-x', layoutLevel: 2, layoutMarker: '.mrc-store-layout-2' }]), true, 'a conforming marker passes')
})
test('FINDING-1: adoptionSignature strands on the RESERVED namespace regardless of KNOWN_001 set membership', () => {
  const w = ws()
  seedMigratedSlice(w)
  writeFileSync(join(w.slice, '.mrc-store-layout-2'), '')   // conforming future marker → detected by the namespace regex
  try {
    assert.equal(adoptionSignature(w.slice).higherSignature, true)
    assert.equal(decideUp(w.legacy, w.slice, { metaRoot: w.metaRoot }).reason, 'higher-signature')
  } finally { w.done() }
})

// ── ADOPTION B: verify-then-record. PASS → adopt w/ provenance; FAIL (diverged) → route to reconciler, never stamp ──
test('ADOPTION-B: a byte-identical adopted slice → records #001 WITH provenance (adopted/from/verifiedByteIdentical)', () => {
  const w = ws()
  seedMigratedSlice(w)
  try {
    assert.equal(sliceMigrationState(w.slice, { metaRoot: w.metaRoot }).recordLost, true, 'pre-adopt: data + no record = recordLost')
    const res = tryAdopt(w.legacy, w.slice, { metaRoot: w.metaRoot })
    assert.equal(res.adopted, true)
    assert.equal(res.record.adopted, true); assert.equal(res.record.from, 'in-slice-sentinel'); assert.equal(res.record.verifiedByteIdentical, true)
    const st = sliceMigrationState(w.slice, { metaRoot: w.metaRoot })
    assert.equal(st.migrated, true); assert.equal(st.recordLost, false); assert.equal(st.layoutLevel, 0)
  } finally { w.done() }
})
test('ADOPTION-B: a genuinely FORKED slice (legacy grew a NEW line the slice lacks) FAILS → reconcile, NOT recorded', () => {
  const w = ws()
  seedMigratedSlice(w)
  writeFileSync(join(w.legacy, `${U1}.jsonl`), 'a\nEDITED-UNDER-LEGACY\n')   // legacy forked from the slice (slice still 'a\n') = the split incident
  try {
    const res = tryAdopt(w.legacy, w.slice, { metaRoot: w.metaRoot })
    assert.equal(res.adopted, false); assert.equal(res.reconcile, true)
    assert.equal(res.verify.pass, false)
    assert.ok(res.verify.checks.some(c => c.kind === 'legacy-ahead' || c.kind === 'forked'))
    assert.equal(existsSync(join(w.metaRoot, basename(w.slice), mig001.id)), false, 'a forked slice is NEVER blind-stamped')
  } finally { w.done() }
})

test('ADOPTION V4 (Pierre): an EMPTY legacy (user deleted repo/.mrc after migrate) → verifyAdopt FAILS, NO false verifiedByteIdentical stamp', () => {
  const w = ws()
  seedMigratedSlice(w)   // populated slice + #001 sentinel → adoptable; legacy currently mirrors it
  for (const f of readdirSync(w.legacy)) rmSync(join(w.legacy, f), { recursive: true, force: true })   // user rm'd repo/.mrc ("memory's in the store now") → empty legacy manifest
  try {
    const v = mig001.verifyAdopt({ legacyDir: w.legacy, sliceDir: w.slice })
    assert.equal(v.pass, false, 'an empty legacy verifies NOTHING → must NOT vacuously pass (the loop ran 0 times)')
    assert.ok(v.checks.some(c => c.kind === 'no-legacy'), 'surfaces the no-legacy reason, not a vacuous 0/0 summary pass')
    const res = tryAdopt(w.legacy, w.slice, { metaRoot: w.metaRoot })
    assert.equal(res.adopted, false, 'no blind adopt when there is nothing to prove byte-identity against')
    assert.equal(res.reason, 'no-legacy', 'distinct reason (not a fork) → launcher gives "recover the record", not "reconcile"')
    assert.equal(res.reconcile, false, 'an empty legacy is NOT a fork — nothing to reconcile')
    assert.equal(existsSync(join(w.metaRoot, basename(w.slice), mig001.id)), false, 'NO record written → no false verifiedByteIdentical:true / no latent #002 double-apply (Pierre V4)')
  } finally { w.done() }
})

// ── LIVE-DOOR FINDING (2026-07-08): adoption is LOSS-DETECTION, not byte-equality — an actively-USED slice evolved ──
test('ADOPTION loss-gate: a SLICE-AHEAD transcript (legacy is a prefix; slice continued in-store) ADOPTS clean', () => {
  const w = ws()
  seedMigratedSlice(w)
  writeFileSync(join(w.slice, `${U1}.jsonl`), 'a\nCONTINUED-IN-STORE\n')   // slice grew (legacy 'a\n' is a prefix) — lossless
  try {
    const v = mig001.verifyAdopt({ legacyDir: w.legacy, sliceDir: w.slice })
    assert.equal(v.pass, true, `slice-ahead must pass: ${JSON.stringify(v.checks)}`)
    const res = tryAdopt(w.legacy, w.slice, { metaRoot: w.metaRoot })
    assert.equal(res.adopted, true, 'an actively-used repo adopts, not strands')
  } finally { w.done() }
})
test('ADOPTION loss-gate: session-names SUPERSET (more names added in-store) + a differing marker → ADOPTS (dietV2\'s real case)', () => {
  const w = ws()
  writeFileSync(join(w.legacy, `${U1}.jsonl`), 'a\n'); writeFileSync(join(w.slice, `${U1}.jsonl`), 'a\n')
  writeFileSync(join(w.legacy, 'session-names'), `${U1}=diet\n`)
  writeFileSync(join(w.slice, 'session-names'), `${U1}=diet\n${U2}=overhaul\n`)   // slice grew a name
  writeFileSync(join(w.legacy, 'names-migrated'), 'v1-legacy\n')
  writeFileSync(join(w.slice, 'names-migrated'), 'v1-slice0\n')                    // marker differs, same size (dietV2 shape)
  writeFileSync(join(w.slice, '.mrc-store-migrated-v2'), '')
  try {
    const v = mig001.verifyAdopt({ legacyDir: w.legacy, sliceDir: w.slice })
    assert.equal(v.pass, true, `dietV2-shape must pass: ${JSON.stringify(v.checks)}`)
    assert.equal(tryAdopt(w.legacy, w.slice, { metaRoot: w.metaRoot }).adopted, true)
  } finally { w.done() }
})
test('ADOPTION loss-gate: a RENAMED session (same uuid, new name in-store) ADOPTS — per-KEY, not per-line (Pierre)', () => {
  const w = ws()
  writeFileSync(join(w.legacy, `${U1}.jsonl`), 'a\n'); writeFileSync(join(w.slice, `${U1}.jsonl`), 'a\n')
  writeFileSync(join(w.legacy, 'session-names'), `${U1}=old-name\n`)
  writeFileSync(join(w.slice, 'session-names'), `${U1}=renamed-in-store\n`)         // same uuid, value changed = a rename
  writeFileSync(join(w.slice, '.mrc-store-migrated-v2'), '')
  try {
    const v = mig001.verifyAdopt({ legacyDir: w.legacy, sliceDir: w.slice })
    assert.equal(v.pass, true, `a rename must adopt, not strand: ${JSON.stringify(v.checks)}`)
    assert.equal(tryAdopt(w.legacy, w.slice, { metaRoot: w.metaRoot }).adopted, true)
  } finally { w.done() }
})
test('ADOPTION loss-gate: a DROPPED session-name (uuid no longer named in the slice) → FAIL (real loss)', () => {
  const w = ws()
  writeFileSync(join(w.legacy, `${U1}.jsonl`), 'a\n'); writeFileSync(join(w.slice, `${U1}.jsonl`), 'a\n')
  writeFileSync(join(w.legacy, 'session-names'), `${U1}=diet\n${U2}=important\n`)
  writeFileSync(join(w.slice, 'session-names'), `${U1}=diet\n`)                     // slice DROPPED the U2 uuid entirely
  writeFileSync(join(w.slice, '.mrc-store-migrated-v2'), '')
  try {
    const v = mig001.verifyAdopt({ legacyDir: w.legacy, sliceDir: w.slice })
    assert.equal(v.pass, false)
    assert.ok(v.checks.some(c => c.kind === 'entries-lost' && c.file === 'session-names'))
  } finally { w.done() }
})
test('ADOPTION loss-gate: a SHRUNK living file (edited-down memory) passes but SURFACES a non-blocking INFO (Pierre Q2)', () => {
  const w = ws()
  writeFileSync(join(w.legacy, `${U1}.jsonl`), 'a\n'); writeFileSync(join(w.slice, `${U1}.jsonl`), 'a\n')
  mkdirSync(join(w.legacy, 'memory')); mkdirSync(join(w.slice, 'memory'))
  writeFileSync(join(w.legacy, 'memory', 'MEMORY.md'), '# a long frozen snapshot with lots of content\n')
  writeFileSync(join(w.slice, 'memory', 'MEMORY.md'), '# trimmed\n')                // smaller in the slice
  try {
    const v = mig001.verifyAdopt({ legacyDir: w.legacy, sliceDir: w.slice })
    assert.equal(v.pass, true, 'shrink is not a failure')
    assert.ok(v.checks.some(c => c.ok === true && c.kind === 'shrank' && c.file === 'memory/MEMORY.md'), 'but it surfaces an INFO')
  } finally { w.done() }
})
test('ADOPTION loss-gate: a MISSING transcript (in legacy, absent from slice) → FAIL (lost history)', () => {
  const w = ws()
  writeFileSync(join(w.legacy, `${U1}.jsonl`), 'a\n'); writeFileSync(join(w.slice, `${U1}.jsonl`), 'a\n')
  writeFileSync(join(w.legacy, `${U2}.jsonl`), 'lost conversation\n')               // never made it to the slice
  writeFileSync(join(w.slice, '.mrc-store-migrated-v2'), '')
  try {
    const v = mig001.verifyAdopt({ legacyDir: w.legacy, sliceDir: w.slice })
    assert.equal(v.pass, false)
    assert.ok(v.checks.some(c => c.kind === 'missing' && c.file === `${U2}.jsonl`))
  } finally { w.done() }
})
test('ADOPTION loss-gate: an edited memory/ file (present, differs) is EXPECTED, not loss → passes; a MISSING one fails', () => {
  const w = ws()
  writeFileSync(join(w.legacy, `${U1}.jsonl`), 'a\n'); writeFileSync(join(w.slice, `${U1}.jsonl`), 'a\n')
  mkdirSync(join(w.legacy, 'memory')); mkdirSync(join(w.slice, 'memory'))
  writeFileSync(join(w.legacy, 'memory', 'MEMORY.md'), '# frozen snapshot\n')
  writeFileSync(join(w.slice, 'memory', 'MEMORY.md'), '# frozen snapshot\n+ edited in-store\n')   // living file, edited
  try {
    assert.equal(mig001.verifyAdopt({ legacyDir: w.legacy, sliceDir: w.slice }).pass, true, 'edited memory is not loss')
    rmSync(join(w.slice, 'memory', 'MEMORY.md'))
    const v = mig001.verifyAdopt({ legacyDir: w.legacy, sliceDir: w.slice })
    assert.equal(v.pass, false); assert.ok(v.checks.some(c => c.kind === 'missing' && c.file === 'memory/MEMORY.md'))
  } finally { w.done() }
})

// ── decideUp actions ─────────────────────────────────────────────────────────────────────────────────────────
test('decideUp: fresh repo with legacy memory → migrate', () => {
  const w = ws()
  writeFileSync(join(w.legacy, `${U1}.jsonl`), 'a\n')
  try {
    const dec = decideUp(w.legacy, w.slice, { metaRoot: w.metaRoot })
    assert.equal(dec.action, 'migrate'); assert.equal(dec.pending[0].id, mig001.id)
  } finally { w.done() }
})
test('decideUp: already-recorded → noop', () => {
  const w = ws()
  seedMigratedSlice(w, { withRecord: true })
  try {
    const dec = decideUp(w.legacy, w.slice, { metaRoot: w.metaRoot })
    assert.equal(dec.action, 'noop'); assert.equal(dec.reason, 'already-migrated')
  } finally { w.done() }
})
test('decideUp: corrupt record → halt (deny handled before pendingMigrations throws)', () => {
  const w = ws()
  writeFileSync(join(w.legacy, `${U1}.jsonl`), 'a\n')
  mkdirSync(join(w.metaRoot, basename(w.slice)), { recursive: true })
  writeFileSync(join(w.metaRoot, basename(w.slice), mig001.id), 'not json {{{')
  try {
    const dec = decideUp(w.legacy, w.slice, { metaRoot: w.metaRoot })
    assert.equal(dec.action, 'halt'); assert.equal(dec.reason, 'corrupt-record')
  } finally { w.done() }
})
// ── #13 EMPTY-REPO opt-in (Model A, Pierre): store-active ⟺ an explicit host record; empty needs --init, never auto ──
test('decideUp: fresh EMPTY repo (nothing to relocate), no --init → noop (bare up never surprise-mints a slice)', () => {
  const w = ws()   // empty legacy, empty slice, no record
  try {
    const dec = decideUp(w.legacy, w.slice, { metaRoot: w.metaRoot })
    assert.equal(dec.action, 'noop'); assert.equal(dec.reason, 'nothing-pending')
  } finally { w.done() }
})
test('decideUp: fresh EMPTY repo + --init → init (explicit opt-in records #001, relocates 0)', () => {
  const w = ws()
  try {
    const dec = decideUp(w.legacy, w.slice, { metaRoot: w.metaRoot, init: true })
    assert.equal(dec.action, 'init'); assert.equal(dec.pending[0].id, mig001.id)
  } finally { w.done() }
})
test('runMigrate up --init: an empty repo → records #001 (host record) → store-ACTIVE, no recordLost (D1a\'s class avoided)', async () => {
  const w = ws()   // truly empty repo
  try {
    const res = await runMigrate('up', '/repo', {
      init: true,
      deps: { legacyDir: w.legacy, sliceHostDir: w.slice, metaRoot: w.metaRoot, lockRoot: w.lockRoot,
        repoContainers: () => 0, sliceLive: () => ({ id: null, determined: true }), store: { storeMode: true, cap: 1 }, log: () => {} },
    })
    assert.equal(res.ok, true); assert.equal(res.init, true)
    const st = sliceMigrationState(w.slice, { metaRoot: w.metaRoot })
    assert.equal(st.migrated, true, 'a host RECORD exists — so the next launch activates store-mode, never recordLost')
    assert.equal(st.ran.get(mig001.id).init, true)
    // the invariant: storeActivation now sees a record → active (NOT the recordLost path Model B would have hit)
    assert.equal(storeActivation(w.slice, { storeMode: true, cap: 1 }, { metaRoot: w.metaRoot }).active, true)
  } finally { w.done() }
})
test('runMigrate up (no --init): an empty repo → noop, points at --init (never a silent store-state change)', async () => {
  const w = ws()
  const logs = []
  try {
    const res = await runMigrate('up', '/repo', {
      deps: { legacyDir: w.legacy, sliceHostDir: w.slice, metaRoot: w.metaRoot, lockRoot: w.lockRoot,
        repoContainers: () => 0, sliceLive: () => ({ id: null, determined: true }), store: { storeMode: true, cap: 1 }, log: (m) => logs.push(m) },
    })
    assert.equal(res.ok, true); assert.equal(res.noop, true)
    assert.equal(sliceMigrationState(w.slice, { metaRoot: w.metaRoot }).migrated, false, 'NO record written on a bare up of an empty repo')
    assert.ok(logs.some(l => /--init/.test(l)), 'points the user at the explicit opt-in')
  } finally { w.done() }
})

test('decideUp: data + no record + no sentinel → halt (can\'t prove layout)', () => {
  const w = ws()
  writeFileSync(join(w.slice, `${U1}.jsonl`), 'orphan\n')   // slice has data but NO sentinel, NO record
  try {
    const dec = decideUp(w.legacy, w.slice, { metaRoot: w.metaRoot })
    assert.equal(dec.action, 'halt'); assert.equal(dec.reason, 'record-lost-no-sentinel')
  } finally { w.done() }
})

// ── #13: storeActivation (capability-as-version + explicit-migration-gated; the silent auto-migrate is GONE) ───
test('#13 storeActivation: a non-store-capable image → inactive (image-not-capable)', () => {
  const w = ws()
  try {
    const a = storeActivation(w.slice, { storeMode: false, cap: 0 }, { metaRoot: w.metaRoot })
    assert.equal(a.active, false); assert.equal(a.reason, 'image-not-capable')
  } finally { w.done() }
})
test('#13 storeActivation: UNMIGRATED (no host record) → inactive (unmigrated) — no silent auto-migrate', () => {
  const w = ws()
  writeFileSync(join(w.legacy, `${U1}.jsonl`), 'a\n')   // legacy has memory, but nothing was migrated
  try {
    const a = storeActivation(w.slice, { storeMode: true, cap: 1 }, { metaRoot: w.metaRoot })
    assert.equal(a.active, false); assert.equal(a.reason, 'unmigrated')
  } finally { w.done() }
})
test('#13 storeActivation: MIGRATED (host record) + capable → ACTIVE (mounts the already-migrated slice)', () => {
  const w = ws()
  seedMigratedSlice(w, { withRecord: true })
  try {
    const a = storeActivation(w.slice, { storeMode: true, cap: 1 }, { metaRoot: w.metaRoot })
    assert.equal(a.active, true); assert.equal(a.reason, 'migrated'); assert.equal(a.layoutLevel, 0)
  } finally { w.done() }
})
test('#13 storeActivation: migrated at a HIGHER layout than the image can drive → capability-shortfall (LEGACY)', () => {
  const w = ws()
  writeFileSync(join(w.slice, `${U1}.jsonl`), 'a\n')
  mkdirSync(join(w.metaRoot, basename(w.slice)), { recursive: true })
  writeFileSync(join(w.metaRoot, basename(w.slice), '003-future'), JSON.stringify({ id: '003-future', layoutLevel: 3 }))
  try {
    const a = storeActivation(w.slice, { storeMode: true, cap: 1 }, { metaRoot: w.metaRoot })
    assert.equal(a.active, false); assert.equal(a.reason, 'capability-shortfall'); assert.equal(a.layoutLevel, 3)
  } finally { w.done() }
})
test('#13 storeActivation: recordLost + #001 sentinel (no higher sig) → ADOPTABLE (launcher offers to adopt)', () => {
  const w = ws()
  writeFileSync(join(w.slice, `${U1}.jsonl`), 'a\n'); writeFileSync(join(w.slice, '.mrc-store-migrated-v2'), '')   // an earlier-mrc migration, no host record
  try {
    assert.equal(storeActivation(w.slice, { storeMode: true, cap: 1 }, { metaRoot: w.metaRoot }).reason, 'adoptable')
  } finally { w.done() }
})
test('#13 storeActivation: recordLost with NO sentinel → STRANDED (needs manual recovery, not a silent legacy open)', () => {
  const w = ws()
  writeFileSync(join(w.slice, `${U1}.jsonl`), 'a\n')   // data, no sentinel, no record
  try {
    assert.equal(storeActivation(w.slice, { storeMode: true, cap: 1 }, { metaRoot: w.metaRoot }).reason, 'stranded')
  } finally { w.done() }
})
test('#13 storeActivation: recordLost + sentinel + a HIGHER-layout signature → STRANDED (not adoptable — could misread)', () => {
  const w = ws()
  writeFileSync(join(w.slice, `${U1}.jsonl`), 'a\n'); writeFileSync(join(w.slice, '.mrc-store-migrated-v2'), '')
  writeFileSync(join(w.slice, '.mrc-store-layout-2'), '')   // evidence of a layout beyond #001
  try {
    assert.equal(storeActivation(w.slice, { storeMode: true, cap: 1 }, { metaRoot: w.metaRoot }).reason, 'stranded')
  } finally { w.done() }
})
test('#13 storeActivation: corrupt record → record-corrupt (fail-closed to legacy)', () => {
  const w = ws()
  writeFileSync(join(w.slice, `${U1}.jsonl`), 'a\n')
  mkdirSync(join(w.metaRoot, basename(w.slice)), { recursive: true })
  writeFileSync(join(w.metaRoot, basename(w.slice), mig001.id), 'not json {{')
  try {
    assert.equal(storeActivation(w.slice, { storeMode: true, cap: 1 }, { metaRoot: w.metaRoot }).reason, 'record-corrupt')
  } finally { w.done() }
})
test('#13 opt-out: detach marks it → storeActivation inactive (opted-out); a re-up clears it → active again', () => {
  const w = ws()
  seedMigratedSlice(w, { withRecord: true })
  try {
    assert.equal(isOptedOut(w.slice, { metaRoot: w.metaRoot }), false)
    recordOptOut(w.slice, { metaRoot: w.metaRoot })
    assert.equal(isOptedOut(w.slice, { metaRoot: w.metaRoot }), true)
    const a = storeActivation(w.slice, { storeMode: true, cap: 1 }, { metaRoot: w.metaRoot })
    assert.equal(a.active, false); assert.equal(a.reason, 'opted-out')   // opted-out beats migrated
    clearOptOut(w.slice, { metaRoot: w.metaRoot })
    assert.equal(isOptedOut(w.slice, { metaRoot: w.metaRoot }), false)
    assert.equal(storeActivation(w.slice, { storeMode: true, cap: 1 }, { metaRoot: w.metaRoot }).active, true)
  } finally { w.done() }
})
test('#13 opt-out marker is a DOTFILE → never pollutes the migration record set (sliceMigrationState ignores it)', () => {
  const w = ws()
  seedMigratedSlice(w, { withRecord: true })
  try {
    recordOptOut(w.slice, { metaRoot: w.metaRoot })
    const st = sliceMigrationState(w.slice, { metaRoot: w.metaRoot })
    assert.equal(st.migrated, true); assert.equal(st.ran.has('.opted-out'), false); assert.equal(st.corrupt, false)
  } finally { w.done() }
})

// ── #13 MEMBER belt: members bypass the RECORD gate but NOT capability-as-version (Pierre #13-review) ─────────
test('#13 memberStoreActive: a member slice with NO host record → ACTIVE (layout-0 floor; teams unbroken)', () => {
  const w = ws()
  writeFileSync(join(w.slice, `${U1}.jsonl`), 'a\n'); writeFileSync(join(w.slice, '.mrc-store-migrated-v2'), '')   // sentinel, no record = recordLost
  try {
    // storeActivation would DENY this (active:false — it's adoptable/recordLost), but a member must stay active
    // (it never runs `mrc migrate`; the member relocate keeps its slice populated).
    assert.equal(storeActivation(w.slice, { storeMode: true, cap: 1 }, { metaRoot: w.metaRoot }).active, false)
    assert.equal(memberStoreActive(w.slice, { storeMode: true, cap: 1 }, { metaRoot: w.metaRoot }), true)
  } finally { w.done() }
})
test('#13 memberStoreActive: a member slice recorded at a HIGHER layout than the image can drive → INACTIVE (fail-closed)', () => {
  const w = ws()
  writeFileSync(join(w.slice, `${U1}.jsonl`), 'a\n')
  mkdirSync(join(w.metaRoot, basename(w.slice)), { recursive: true })
  writeFileSync(join(w.metaRoot, basename(w.slice), '002-x'), JSON.stringify({ id: '002-x', layoutLevel: 2 }))
  try {
    assert.equal(memberStoreActive(w.slice, { storeMode: true, cap: 1 }, { metaRoot: w.metaRoot }), false, 'cap 1 < layout 2 → legacy, no misread')
    assert.equal(memberStoreActive(w.slice, { storeMode: true, cap: 2 }, { metaRoot: w.metaRoot }), true, 'cap 2 >= layout 2 → active')
  } finally { w.done() }
})
test('#13 memberStoreActive corner (Pierre): a member slice with a HIGHER-layout SIGNATURE + no record → INACTIVE (not floored to 0)', () => {
  const w = ws()
  writeFileSync(join(w.slice, `${U1}.jsonl`), 'a\n'); writeFileSync(join(w.slice, '.mrc-store-migrated-v2'), '')
  writeFileSync(join(w.slice, '.mrc-store-layout-2'), '')   // a future member-layout marker, no host record
  try {
    assert.equal(memberStoreActive(w.slice, { storeMode: true, cap: 1 }, { metaRoot: w.metaRoot }), false, 'higher signature → deny, never floor-to-0 misread')
  } finally { w.done() }
})
test('#13 memberStoreActive: non-capable image → inactive; corrupt record → inactive', () => {
  const w = ws()
  mkdirSync(join(w.metaRoot, basename(w.slice)), { recursive: true })
  writeFileSync(join(w.metaRoot, basename(w.slice), mig001.id), 'not json {{')
  try {
    assert.equal(memberStoreActive(w.slice, { storeMode: false, cap: 0 }, { metaRoot: w.metaRoot }), false)
    assert.equal(memberStoreActive(w.slice, { storeMode: true, cap: 1 }, { metaRoot: w.metaRoot }), false, 'corrupt → deny')
  } finally { w.done() }
})

// ── #14 THE RECONCILER: heal a split (extend / promote-fork / copy-in / merge-names), idempotent, then adopt ──
const RID = () => 'ffffffff-ffff-4fff-8fff-ffffffffffff'   // deterministic fork uuid for tests
test('#14 planReconcile: legacy-ahead → extend; slice-ahead → noop; diverged → promote-fork; missing → copy-in', () => {
  const w = ws()
  // legacy-ahead (repo/.mrc grew): legacy [a,b,c], slice [a,b]
  writeFileSync(join(w.legacy, `${U1}.jsonl`), 'a\nb\nc\n'); writeFileSync(join(w.slice, `${U1}.jsonl`), 'a\nb\n')
  // slice-ahead (continued in store): legacy [a], slice [a,x]
  writeFileSync(join(w.legacy, `${U2}.jsonl`), 'a\n'); writeFileSync(join(w.slice, `${U2}.jsonl`), 'a\nx\n')
  // diverged: legacy [p,q], slice [p,r]
  const U3 = '33333333-3333-3333-3333-333333333333'
  writeFileSync(join(w.legacy, `${U3}.jsonl`), 'p\nq\n'); writeFileSync(join(w.slice, `${U3}.jsonl`), 'p\nr\n')
  // missing in slice
  const U4 = '44444444-4444-4444-4444-444444444444'
  writeFileSync(join(w.legacy, `${U4}.jsonl`), 'only-in-legacy\n')
  try {
    const kinds = Object.fromEntries(planReconcile(w.legacy, w.slice).actions.map(a => [a.rel, a.kind]))
    assert.equal(kinds[`${U1}.jsonl`], 'extend')
    assert.equal(kinds[`${U2}.jsonl`], undefined, 'slice-ahead is a noop')
    assert.equal(kinds[`${U3}.jsonl`], 'promote-fork')
    assert.equal(kinds[`${U4}.jsonl`], 'copy-in')
  } finally { w.done() }
})
test('#14 applyReconcile then re-plan → EMPTY (idempotent: extend settles, fork becomes byte-present, no re-fork)', () => {
  const w = ws()
  writeFileSync(join(w.legacy, `${U1}.jsonl`), 'a\nb\nc\n'); writeFileSync(join(w.slice, `${U1}.jsonl`), 'a\nb\n')          // legacy-ahead
  const U3 = '33333333-3333-3333-3333-333333333333'
  writeFileSync(join(w.legacy, `${U3}.jsonl`), 'p\nq\n'); writeFileSync(join(w.slice, `${U3}.jsonl`), 'p\nr\n')             // diverged
  writeFileSync(join(w.legacy, 'session-names'), `${U1}=one\n${U3}=three\n`); writeFileSync(join(w.slice, 'session-names'), `${U1}=one\n`)   // missing key U3
  try {
    const plan = planReconcile(w.legacy, w.slice)
    const applied = applyReconcile(w.legacy, w.slice, plan, { newId: RID })
    assert.equal(applied.extended, 1); assert.equal(applied.promoted.length, 1)
    // the legacy fork is now a NEW pickable session, byte-equal to the legacy transcript
    assert.ok(existsSync(join(w.slice, `${RID()}.jsonl`)))
    assert.match(readFileSync(join(w.slice, 'session-names'), 'utf8'), /legacy fork/)
    assert.match(readFileSync(join(w.slice, 'session-names'), 'utf8'), new RegExp(`${U3}=three`))   // union-merged, no name dropped
    // slice kept its OWN diverged version at the original uuid
    assert.equal(readFileSync(join(w.slice, `${U3}.jsonl`), 'utf8'), 'p\nr\n')
    // RE-PLAN converges to empty → the record gate
    assert.equal(planReconcile(w.legacy, w.slice).actions.length, 0, 'reconcile is idempotent (no re-fork on re-plan)')
  } finally { w.done() }
})
test('#14 runMigrate reconcile: a diverged repo → heals + ADOPTS (records #001 w/ reconcile provenance); 2nd run is noop', async () => {
  const w = ws()
  seedMigratedSlice(w)   // byte-identical base
  // introduce a fork: legacy transcript diverges from the slice
  writeFileSync(join(w.legacy, `${U1}.jsonl`), 'a\nLEGACY-FORK\n'); writeFileSync(join(w.slice, `${U1}.jsonl`), 'a\nSTORE-FORK\n')
  try {
    const res = await runMigrate('reconcile', '/repo', {
      yes: true,
      deps: {
        legacyDir: w.legacy, sliceHostDir: w.slice, metaRoot: w.metaRoot, lockRoot: w.lockRoot,
        repoContainers: () => 0, sliceLive: () => ({ id: null, determined: true }),
        store: { storeMode: true, cap: 1 }, log: () => {},
      },
    })
    assert.equal(res.ok, true); assert.equal(res.adopted, true); assert.equal(res.reconciled.promoted.length, 1)
    const st = sliceMigrationState(w.slice, { metaRoot: w.metaRoot })
    assert.equal(st.migrated, true); assert.equal(st.ran.get(mig001.id).reconciled, true)
    // a promoted "(legacy fork)" session is now pickable
    assert.match(readFileSync(join(w.slice, 'session-names'), 'utf8'), /legacy fork/)
    // 2nd reconcile: already unified → noop, no double-fork
    const before = readdirSync(w.slice).filter(f => f.endsWith('.jsonl')).length
    const res2 = await runMigrate('reconcile', '/repo', {
      yes: true,
      deps: { legacyDir: w.legacy, sliceHostDir: w.slice, metaRoot: w.metaRoot, lockRoot: w.lockRoot, repoContainers: () => 0, sliceLive: () => ({ id: null, determined: true }), store: { storeMode: true, cap: 1 }, log: () => {} },
    })
    assert.equal(res2.noop, true)
    assert.equal(readdirSync(w.slice).filter(f => f.endsWith('.jsonl')).length, before, 'no duplicate fork on a 2nd reconcile')
  } finally { w.done() }
})
test('#14 reconcile INFO parity: a SHRUNK living memory file surfaces an info (not an action; does not block record)', () => {
  const w = ws()
  writeFileSync(join(w.legacy, `${U1}.jsonl`), 'a\n'); writeFileSync(join(w.slice, `${U1}.jsonl`), 'a\n')
  mkdirSync(join(w.legacy, 'memory')); mkdirSync(join(w.slice, 'memory'))
  writeFileSync(join(w.legacy, 'memory', 'MEMORY.md'), '# a long frozen snapshot with content\n')
  writeFileSync(join(w.slice, 'memory', 'MEMORY.md'), '# short\n')   // present but smaller
  try {
    const plan = planReconcile(w.legacy, w.slice)
    assert.equal(plan.actions.length, 0, 'a shrunk living file is NOT an action (never blocks convergence)')
    assert.ok(plan.infos.some(i => i.kind === 'shrank' && i.rel === 'memory/MEMORY.md'), 'but it surfaces a shrink INFO (parity with adoption)')
  } finally { w.done() }
})
test('#14 nested SUBAGENT diverged → info, NOT a top-level promote-fork (a subagent is not a pickable session)', () => {
  const w = ws()
  writeFileSync(join(w.legacy, `${U1}.jsonl`), 'a\n'); writeFileSync(join(w.slice, `${U1}.jsonl`), 'a\n')
  mkdirSync(join(w.legacy, U1)); mkdirSync(join(w.slice, U1))
  writeFileSync(join(w.legacy, U1, 'sub.jsonl'), 'p\nLEGACY\n'); writeFileSync(join(w.slice, U1, 'sub.jsonl'), 'p\nSTORE\n')   // diverged nested leaf
  try {
    const plan = planReconcile(w.legacy, w.slice)
    assert.equal(plan.actions.some(a => a.kind === 'promote-fork'), false, 'a nested subagent leaf is NOT promoted to a top-level pickable')
    assert.ok(plan.infos.some(i => i.kind === 'diverged-subagent' && i.rel === `${U1}/sub.jsonl`), 'it is surfaced instead')
    // and no session-names "(legacy fork)" entry is minted for it
    applyReconcile(w.legacy, w.slice, plan, { newId: RID })
    assert.equal(existsSync(join(w.slice, `${RID()}.jsonl`)), false, 'no top-level fork transcript minted for a subagent leaf')
  } finally { w.done() }
})
test('#14 reconcile preflight: a live slice REFUSES (it writes the slice — same guard as up)', async () => {
  const w = ws()
  seedMigratedSlice(w)
  writeFileSync(join(w.legacy, `${U1}.jsonl`), 'a\nLEGACY\n')
  try {
    const res = await runMigrate('reconcile', '/repo', {
      yes: true,
      deps: { legacyDir: w.legacy, sliceHostDir: w.slice, metaRoot: w.metaRoot, lockRoot: w.lockRoot, repoContainers: () => 0, sliceLive: () => ({ id: 'live', determined: true }), store: { storeMode: true, cap: 1 }, log: () => {} },
    })
    assert.equal(res.ok, false); assert.equal(res.refused, 'slice-live')
  } finally { w.done() }
})

// ── INVARIANT 3: imageCanDrive (rebuild-gated capability comparison) ──────────────────────────────────────────
test('imageCanDrive: store-capable cap1 drives #001 (layoutLevel 0)', () => {
  assert.equal(imageCanDrive({ storeMode: true, cap: 1 }, mig001), true)
})
test('imageCanDrive: a non-store-capable image drives NOTHING', () => {
  assert.equal(imageCanDrive({ storeMode: false, cap: 0 }, mig001), false)
})
test('imageCanDrive: a future layout migration (level 2) is NOT driven by a cap-1 image (needs a rebuild)', () => {
  assert.equal(imageCanDrive({ storeMode: true, cap: 1 }, { id: '002', layoutLevel: 2 }), false)
})

// ── INVARIANT 5: detach — refuse-by-default on store-born content, --force proceeds ───────────────────────────
test('detach: store-born content (slice-only conversation) makes detach REFUSE by default', () => {
  const w = ws()
  seedMigratedSlice(w)
  writeFileSync(join(w.slice, `${U2}.jsonl`), 'born-in-store\n')   // exists ONLY in the slice
  try {
    const born = storeBornContent(w.legacy, w.slice)
    assert.ok(born.includes(`${U2}.jsonl`))
    assert.equal(decideDetach(w.legacy, w.slice, { force: false }).action, 'refuse')
    assert.equal(decideDetach(w.legacy, w.slice, { force: true }).action, 'detach')
  } finally { w.done() }
})
test('detach: a fully-mirrored slice (nothing store-born) detaches without --force', () => {
  const w = ws()
  seedMigratedSlice(w)
  try {
    assert.equal(storeBornContent(w.legacy, w.slice).length, 0)
    assert.equal(decideDetach(w.legacy, w.slice, { force: false }).action, 'detach')
  } finally { w.done() }
})

// ── INVARIANT 7: status renders record-lost / corrupt HONESTLY ────────────────────────────────────────────────
test('status: record-lost + #001 sentinel → "adoptable" (never "fresh")', () => {
  const w = ws()
  seedMigratedSlice(w)
  try {
    const rep = statusReport(w.legacy, w.slice, { metaRoot: w.metaRoot })
    assert.equal(rep.state, 'adoptable'); assert.equal(rep.layoutLevel, null)
  } finally { w.done() }
})
test('status: data + no record + no sentinel → "stranded" (never "fresh")', () => {
  const w = ws()
  writeFileSync(join(w.slice, `${U1}.jsonl`), 'orphan\n')
  try {
    assert.equal(statusReport(w.legacy, w.slice, { metaRoot: w.metaRoot }).state, 'stranded')
  } finally { w.done() }
})
test('status: recorded → "migrated"; genuinely fresh empty slice → "fresh"', () => {
  const w = ws()
  try {
    assert.equal(statusReport(w.legacy, w.slice, { metaRoot: w.metaRoot }).state, 'fresh')
    seedMigratedSlice(w, { withRecord: true })
    assert.equal(statusReport(w.legacy, w.slice, { metaRoot: w.metaRoot }).state, 'migrated')
  } finally { w.done() }
})

// ── INVARIANT 1: the slice lock serializes concurrent migrates; a stale (dead-owner) lock is stolen ───────────
test('lock: a live holder refuses a second acquire; a stale (dead pid) lock is stolen', () => {
  const w = ws()
  try {
    const a = acquireSliceLock(w.slice, { lockRoot: w.lockRoot, pid: 4242, isAlive: () => true })
    assert.equal(a.ok, true)
    const b = acquireSliceLock(w.slice, { lockRoot: w.lockRoot, pid: 9999, isAlive: () => true })
    assert.equal(b.ok, false); assert.equal(b.owner, 4242)
    assert.ok(b.file, 'refuse returns the lockfile path so the caller can surface the manual escape')
    a.release()
    // a stale lock (owner reported DEAD) is stolen
    acquireSliceLock(w.slice, { lockRoot: w.lockRoot, pid: 4242, isAlive: () => true })   // re-take as 4242
    const c = acquireSliceLock(w.slice, { lockRoot: w.lockRoot, pid: 5555, isAlive: () => false })   // 4242 now "dead"
    assert.equal(c.ok, true)
  } finally { w.done() }
})
test('lock: PID-REUSE trap defused — a LIVE-but-AGED lock is stolen (not wedged forever)', () => {
  const w = ws()
  let t = 1_000_000
  try {
    const a = acquireSliceLock(w.slice, { lockRoot: w.lockRoot, pid: 4242, isAlive: () => true, now: () => t })
    assert.equal(a.ok, true)
    // same pid still "alive" (reused by an unrelated process), but the lock is 2h old → stolen, not a permanent refuse
    t += 2 * 3_600_000
    const b = acquireSliceLock(w.slice, { lockRoot: w.lockRoot, pid: 5555, isAlive: () => true, now: () => t })
    assert.equal(b.ok, true, 'an aged lock with a (reused) live pid is stolen')
    // a FRESH live lock still refuses
    const c = acquireSliceLock(w.slice, { lockRoot: w.lockRoot, pid: 7777, isAlive: () => true, now: () => t })
    assert.equal(c.ok, false); assert.equal(c.owner, 5555)
  } finally { w.done() }
})

// ── end-to-end (injected deps): a fresh migrate applies, verifies, records; --yes skips only the confirm ─────────
test('runMigrate up: fresh repo, --yes → migrates, verifies, records host-only', async () => {
  const w = ws()
  writeFileSync(join(w.legacy, `${U1}.jsonl`), 'hello\n')
  mkdirSync(join(w.legacy, 'memory')); writeFileSync(join(w.legacy, 'memory', 'MEMORY.md'), '# mem\n')
  try {
    const res = await runMigrate('up', '/repo', {
      yes: true,
      deps: {
        legacyDir: w.legacy, sliceHostDir: w.slice, metaRoot: w.metaRoot, lockRoot: w.lockRoot,
        repoContainers: () => 0, sliceLive: () => ({ id: null, determined: true }),
        store: { storeMode: true, cap: 1 }, log: () => {},
      },
    })
    assert.equal(res.ok, true); assert.ok(res.migrated >= 2)
    assert.ok(existsSync(join(w.slice, `${U1}.jsonl`)) && existsSync(join(w.slice, 'memory', 'MEMORY.md')))
    assert.ok(existsSync(join(w.legacy, `${U1}.jsonl`)), 'non-destructive: legacy retained')
    const st = sliceMigrationState(w.slice, { metaRoot: w.metaRoot })
    assert.equal(st.migrated, true); assert.equal(st.layoutLevel, 0)
  } finally { w.done() }
})
test('runMigrate up: a non-store-capable image REFUSES (capability gate) even though work is pending', async () => {
  const w = ws()
  writeFileSync(join(w.legacy, `${U1}.jsonl`), 'hello\n')
  try {
    const res = await runMigrate('up', '/repo', {
      yes: true,
      deps: {
        legacyDir: w.legacy, sliceHostDir: w.slice, metaRoot: w.metaRoot, lockRoot: w.lockRoot,
        repoContainers: () => 0, sliceLive: () => ({ id: null, determined: true }),
        store: { storeMode: false, cap: 0 }, log: () => {},
      },
    })
    assert.equal(res.ok, false); assert.equal(res.refused, 'capability')
    assert.equal(existsSync(join(w.slice, `${U1}.jsonl`)), false, 'nothing migrated when the image can\'t drive it')
  } finally { w.done() }
})
test('runMigrate up: adoption path — already-migrated repo, --yes → adopts (verify-then-record)', async () => {
  const w = ws()
  seedMigratedSlice(w)
  try {
    const res = await runMigrate('up', '/repo', {
      yes: true,
      deps: {
        legacyDir: w.legacy, sliceHostDir: w.slice, metaRoot: w.metaRoot, lockRoot: w.lockRoot,
        repoContainers: () => 0, sliceLive: () => ({ id: null, determined: true }),
        store: { storeMode: true, cap: 1 }, log: () => {},
      },
    })
    assert.equal(res.ok, true); assert.equal(res.adopted, true)
    assert.equal(sliceMigrationState(w.slice, { metaRoot: w.metaRoot }).ran.get(mig001.id).adopted, true)
  } finally { w.done() }
})
