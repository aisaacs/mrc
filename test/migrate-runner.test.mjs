// The `mrc migrate` RUNNER — Pierre's 8 invariants + adoption's A/B/C, as explicit doors. The doors Pierre bet I'd
// trip (build RED-first): #2 slice-not-repo preflight (a sibling copy's live container must block), #4 --yes past
// preflight (consent-waiver ≠ safety-waiver), and adoption-A's dividing test (a level-2-shaped slice with only the
// #001 sentinel + no record must DENY, never adopt-down-to-0).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import {
  preflightLive, imageCanDrive, adoptionSignature, tryAdopt, decideUp, decideDetach,
  storeBornContent, statusReport, acquireSliceLock, runMigrate,
} from '../src/commands/migrate.js'
import { sliceMigrationState, recordMigration, assertLayoutMarkerConvention } from '../src/migrations/registry.js'
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
test('ADOPTION-B: a DIVERGED slice (legacy edited under a legacy launch) FAILS verify → reconcile, NOT recorded', () => {
  const w = ws()
  seedMigratedSlice(w)
  writeFileSync(join(w.legacy, `${U1}.jsonl`), 'a\nEDITED-UNDER-LEGACY\n')   // legacy diverged from the slice = the split incident
  try {
    const res = tryAdopt(w.legacy, w.slice, { metaRoot: w.metaRoot })
    assert.equal(res.adopted, false); assert.equal(res.reconcile, true)
    assert.equal(res.verify.pass, false)
    assert.equal(existsSync(join(w.metaRoot, basename(w.slice), mig001.id)), false, 'a diverged slice is NEVER blind-stamped')
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
test('decideUp: data + no record + no sentinel → halt (can\'t prove layout)', () => {
  const w = ws()
  writeFileSync(join(w.slice, `${U1}.jsonl`), 'orphan\n')   // slice has data but NO sentinel, NO record
  try {
    const dec = decideUp(w.legacy, w.slice, { metaRoot: w.metaRoot })
    assert.equal(dec.action, 'halt'); assert.equal(dec.reason, 'record-lost-no-sentinel')
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
