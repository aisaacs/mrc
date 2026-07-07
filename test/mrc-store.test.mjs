// #5 — the host-scoped memory store's chokepoint: the slice-keying lattice (isolated-by-default / repoId-by-grant),
// the race-safe + traversal-safe repo-id mint (Gates 2/4), and the ..-guard. The security core is the lattice:
// repoId (the user's own memory) is GRANTED only on a positive trusted-own signal — never fallen into by a member
// or a summoned adversary. sliceKeyFor takes an injected repoStoreId so "a member never reads .mrc-id" is a test.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync, realpathSync, utimesSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { existsSync as existsSyncT } from 'node:fs'
import { join } from 'node:path'
import { sliceKeyFor, repoStoreId, sliceDir, assertSafeSegment, storeRoot, repoIdFile, decideStoreMode, resolveStoreMode, STORE_CAPABILITY, storeCtx, forkSliceKey, forkSliceDir } from '../src/mrc-store.js'

// ---------- the keying lattice (the security core) ----------
test('lattice: a summoned adversary (summonedBy set, no member) → (repo,slot) slice, NEVER repoId', () => {
  let idRead = false
  const key = sliceKeyFor({ adversary: true, adversarySlot: 3, repoPath: '/r', isMember: false }, { repoStoreId: () => { idRead = true; return 'REPO-ID' } })
  assert.match(key, /^adv-[0-9a-f]{12}-3$/)
  assert.equal(idRead, false, 'an adversary must NEVER read the repo-id — no user-memory leak to a red-team')
})

test('lattice: a real team member → (org,handle) slice, and .mrc-id is NEVER read (GATE 1)', () => {
  let idRead = false
  const key = sliceKeyFor({ isMember: true, isSolo: false, org: 'acme', handle: 'alice/claude', repoPath: '/r' }, { repoStoreId: () => { idRead = true; return 'REPO-ID' } })
  assert.match(key, /^m-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'member slice = m-<memberSessionId uuid>')
  assert.equal(idRead, false, 'GATE 1: a team member must never read the repo-resident .mrc-id')
})

test('lattice: solo → repoId (granted even though solo is mechanically a member)', () => {
  assert.equal(sliceKeyFor({ isSolo: true, isMember: true, repoPath: '/r' }, { repoStoreId: () => 'THE-REPO-ID' }), 'THE-REPO-ID')
})

test('lattice: a clean plain session (member=false, adversary=false) → repoId', () => {
  assert.equal(sliceKeyFor({ isMember: false, adversary: false, repoPath: '/r' }, { repoStoreId: () => 'THE-REPO-ID' }), 'THE-REPO-ID')
})

test('lattice (fail-safe): UNCLEAR signals fall to the isolated floor, never repoId', () => {
  let idRead = false
  // isMember undefined (NOT an explicit false) → must not be granted the user memory
  const key = sliceKeyFor({ repoPath: '/r', sessionId: 's-1' }, { repoStoreId: () => { idRead = true; return 'REPO-ID' } })
  assert.match(key, /^iso-/)
  assert.equal(idRead, false, 'an unclear session must not fall through to repoId')
})

test('lattice (GATE 1): a MEMBER with a STRAY truthy isSolo stays in its member slice, never grabs repoId', () => {
  // a sloppy caller passing isSolo:1 on a member must NOT kick it out of the member branch into the repoId grant
  // (lenient `!!isSolo` would have; strict `=== true` keeps it). idRead proves .mrc-id is never touched.
  let idRead = false
  const key = sliceKeyFor({ isMember: true, isSolo: 1, org: 'acme', handle: 'alice/claude', repoPath: '/r' }, { repoStoreId: () => { idRead = true; return 'REPO-ID' } })
  assert.match(key, /^m-/, 'member with stray truthy isSolo → member slice, not repoId')
  assert.equal(idRead, false, 'GATE 1: it must never read the .mrc-id')
})

test('lattice: two orgs sharing a member handle get DISTINCT slices (no cross-org bleed)', () => {
  const a = sliceKeyFor({ isMember: true, isSolo: false, org: 'orgA', handle: 'alice/claude', repoPath: '/r' }, { repoStoreId: () => 'x' })
  const b = sliceKeyFor({ isMember: true, isSolo: false, org: 'orgB', handle: 'alice/claude', repoPath: '/r' }, { repoStoreId: () => 'x' })
  assert.notEqual(a, b)
})

// ---------- repo-id mint (GATE 2 race-safe + GATE 4 traversal-safe) ----------
const scratchRepo = () => realpathSync(mkdtempSync(join(tmpdir(), 'mrc-store-')))

test('repoStoreId: mints a UUID, persists it, returns the SAME id on re-read (memory travels)', () => {
  const r = scratchRepo()
  try {
    const id1 = repoStoreId(r)
    assert.match(id1, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    assert.equal(repoStoreId(r), id1, 'stable across launches')
    assert.equal(readFileSync(repoIdFile(r), 'utf8').trim(), id1)
  } finally { rmSync(r, { recursive: true, force: true }) }
})

test('GATE 4: a tampered .mrc-id (../x, /abs, NUL, newline, non-uuid, empty) is REJECTED and REGENERATED', () => {
  for (const bad of ['../victim-slice', '/etc/passwd', 'a\0b', 'x\ny', 'not-a-uuid', '']) {
    const r = scratchRepo()
    try {
      mkdirSync(join(r, '.mrc'), { recursive: true })
      writeFileSync(repoIdFile(r), bad)
      const id = repoStoreId(r)
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, `bad id ${JSON.stringify(bad)} → valid uuid`)
      assert.doesNotThrow(() => assertSafeSegment(id), 'the regenerated id is a safe path segment')
    } finally { rmSync(r, { recursive: true, force: true }) }
  }
})

// ---------- ..-guard / assertSafeSegment ----------
test('assertSafeSegment: rejects traversal/separator/NUL/newline/dotdot, accepts our minted key shapes', () => {
  for (const bad of ['..', '.', 'a/b', '../x', 'a\0b', 'a\nb', '/abs', '']) assert.throws(() => assertSafeSegment(bad), undefined, `should reject ${JSON.stringify(bad)}`)
  for (const ok of ['m-0123456789abcdef', 'adv-0123456789ab-2', 'iso-0123456789abcdef', '550e8400-e29b-41d4-a716-446655440000']) assert.doesNotThrow(() => assertSafeSegment(ok))
})

test('sliceDir ..-guard: a PLANTED symlink at the slice path is REFUSED (never mount through it)', () => {
  const key = `test-planted-${process.pid}`
  const p = join(storeRoot(), key)
  mkdirSync(storeRoot(), { recursive: true })
  try {
    symlinkSync('/etc', p)   // a member plants <store>/<key> -> /etc
    assert.throws(() => sliceDir(key), /symlink|real directory/)
  } finally { rmSync(p, { force: true }) }
})

test('sliceDir ..-guard: a DANGLING symlink at the slice path is REFUSED (lstat catches it; a realpath/ENOENT check would not)', () => {
  const key = `test-dangling-${process.pid}`
  const p = join(storeRoot(), key)
  mkdirSync(storeRoot(), { recursive: true })
  try {
    symlinkSync('/no/such/target/xyz', p)   // dangling: realpathSync(p) would throw ENOENT → a naive guard treats it "absent → safe"
    assert.throws(() => sliceDir(key), /symlink|real directory/)
  } finally { rmSync(p, { force: true }) }
})

test('sliceDir ..-guard: a LOOPING symlink at the slice path is REFUSED, never swallowed (ELOOP)', () => {
  const a = `test-loop-a-${process.pid}`, b = `test-loop-b-${process.pid}`
  const pa = join(storeRoot(), a), pb = join(storeRoot(), b)
  mkdirSync(storeRoot(), { recursive: true })
  try {
    symlinkSync(pb, pa); symlinkSync(pa, pb)   // a → b → a : realpathSync throws ELOOP
    assert.throws(() => sliceDir(a), /symlink|real directory/)   // lstat sees a symlink FIRST → refused (never reaches ELOOP swallow)
  } finally { rmSync(pa, { force: true }); rmSync(pb, { force: true }) }
})

test('sliceDir: a fresh (not-yet-created) slice resolves to a real child of the store root', () => {
  const key = `test-fresh-${process.pid}`
  try {
    assert.ok(sliceDir(key).startsWith(realpathSync(storeRoot()) + '/'))
  } finally { rmSync(join(storeRoot(), key), { recursive: true, force: true }) }
})

// ---------- store-mode capability gate (fail-toward-legacy) ----------
test('decideStoreMode: FAIL-TOWARD-LEGACY matrix — every unsure/absent/malformed/unknown case → legacy', () => {
  const L = (v) => ({ 'mrc.store.capability': v })
  assert.equal(decideStoreMode({}).storeMode, false, 'label absent → legacy')
  assert.equal(decideStoreMode(null).storeMode, false, 'null labels → legacy')
  assert.equal(decideStoreMode(L('')).storeMode, false, 'empty → legacy')
  assert.equal(decideStoreMode(L('   ')).storeMode, false, 'whitespace → legacy')
  assert.equal(decideStoreMode(L('garbage')).storeMode, false, 'malformed → legacy')
  assert.equal(decideStoreMode(L('0')).storeMode, false, 'older (0) → legacy')
  assert.equal(decideStoreMode(L('999')).storeMode, false, 'UNKNOWN-HIGHER (image newer than host) → legacy, not "probably fine"')
  assert.equal(decideStoreMode(L('1.5')).storeMode, false, 'non-integer → legacy')
  assert.equal(decideStoreMode(L(String(STORE_CAPABILITY))).storeMode, true, 'exact supported version → store-mode (the ONLY grant path)')
})

test('resolveStoreMode: any missing-id / missing-inspector / inspect-failure → legacy (deny-first)', () => {
  assert.equal(resolveStoreMode('', () => ({})).storeMode, false, 'no image id → legacy')
  assert.equal(resolveStoreMode('img', null).storeMode, false, 'no inspector → legacy')
  assert.equal(resolveStoreMode('img', () => { throw new Error('docker down') }).storeMode, false, 'inspect throws → legacy')
  assert.equal(resolveStoreMode('img', () => null).storeMode, false, 'inspect returns null labels → legacy')
  assert.equal(resolveStoreMode('img', () => ({ 'mrc.store.capability': String(STORE_CAPABILITY) })).storeMode, true, 'capable image → store-mode')
})

test('drift guard: Dockerfile LABEL === container-setup.js STORE_CAPABILITY === src/mrc-store STORE_CAPABILITY (the code-tie that stops the label lying)', () => {
  const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8')
  const setup = readFileSync(new URL('../container/container-setup.js', import.meta.url), 'utf8')
  // Anchor to the actual DIRECTIVE (^LABEL / ^const) and require EXACTLY ONE — an UNANCHORED first-match would let
  // a COMMENT win (`# e.g. mrc.store.capability=2`) or miss a Docker LABEL OVERRIDE (last-write-wins: a later
  // `LABEL ...=2` ships 2, but first-match reads 1). matchAll + length===1 makes a comment / duplicate / override
  // each FAIL loudly, so the tie is enforced BY CONSTRUCTION, not just for today's formatting.
  const labels = [...dockerfile.matchAll(/^LABEL\s+mrc\.store\.capability=(\d+)\b/gm)]
  const consts = [...setup.matchAll(/^const STORE_CAPABILITY\s*=\s*(\d+)\b/gm)]
  assert.equal(labels.length, 1, 'exactly ONE `LABEL mrc.store.capability=` directive (comment/duplicate/override → fail)')
  assert.equal(consts.length, 1, 'exactly ONE top-level `const STORE_CAPABILITY =` declaration')
  assert.equal(Number(labels[0][1]), STORE_CAPABILITY, 'Dockerfile label === src/mrc-store STORE_CAPABILITY')
  assert.equal(Number(consts[0][1]), STORE_CAPABILITY, 'container-setup STORE_CAPABILITY === it too — a bump to any one alone fails HERE')
})

// ---------- storeCtx (launch signals → slice ctx; every signal explicit) ----------
test('storeCtx: a plain session (no memberCtx, no solo, not caged) → clean grant ctx (repoId)', () => {
  const c = storeCtx({ solo: false, memberCtx: null, cagedAdversary: false, repoPath: '/r', sessionId: 's' })
  assert.equal(c.isMember, false); assert.equal(c.isSolo, false); assert.equal(c.adversary, false)
  // through the lattice → repoId (the guardrail)
  assert.equal(sliceKeyFor(c, { repoStoreId: () => 'RID' }), 'RID')
})

test('storeCtx: solo → isSolo true, isMember false (repoId, not the member slice) even though solo carries a memberCtx', () => {
  const c = storeCtx({ solo: true, memberCtx: { org: 'x-solo', member: { handle: 'you/claude' } }, cagedAdversary: false, repoPath: '/r' })
  assert.equal(c.isSolo, true); assert.equal(c.isMember, false)
  assert.equal(sliceKeyFor(c, { repoStoreId: () => 'RID' }), 'RID')
})

test('storeCtx: a real team member → isMember true + org/handle (its own slice), .mrc-id never read', () => {
  const c = storeCtx({ solo: false, memberCtx: { org: 'acme', member: { handle: 'a/claude' } }, cagedAdversary: false, repoPath: '/r' })
  assert.equal(c.isMember, true); assert.equal(c.org, 'acme'); assert.equal(c.handle, 'a/claude')
  let idRead = false
  assert.match(sliceKeyFor(c, { repoStoreId: () => { idRead = true; return 'RID' } }), /^m-/)
  assert.equal(idRead, false)
})

test('storeCtx: a caged adversary → adversary true + slot (walled slice), never repoId/member', () => {
  const c = storeCtx({ solo: false, memberCtx: null, cagedAdversary: true, adversarySlot: 2, repoPath: '/r' })
  assert.equal(c.adversary, true); assert.equal(c.adversarySlot, 2)
  let idRead = false
  assert.match(sliceKeyFor(c, { repoStoreId: () => { idRead = true; return 'RID' } }), /^adv-[0-9a-f]{12}-2$/)
  assert.equal(idRead, false, 'an adversary never reads the user repo-id')
})

// ---------- GATE-3 ephemeral fork slice (the ceiling's side slice) ----------
test('forkSliceKey: fresh + distinct each call, `fork-` prefixed, a traversal-safe segment, NEVER derived from .mrc-id', () => {
  const a = forkSliceKey(), b = forkSliceKey()
  assert.notEqual(a, b, 'each fork is a fresh key (ephemeral, one launch)')
  assert.ok(a.startsWith('fork-') && b.startsWith('fork-'), 'greppable/nameable prefix')
  assert.doesNotThrow(() => assertSafeSegment(a), 'a fork key is a safe single path segment (no traversal)')
  // forkSliceDir resolves under the store root (never through a planted symlink) — same ..-guard as every slice
  const d = forkSliceDir()
  assert.ok(d.startsWith(realpathSync(storeRoot())), 'the fork slice is a real child of the store root')
})

// ---------- migrateToStore (non-destructive, exclude, idempotent, kill-safe sentinel) ----------
import { migrateToStore } from '../src/mrc-store.js'
test('migrateToStore: copies transcripts+names, EXCLUDES member sessionIds, leaves Class-2 + originals, idempotent', () => {
  const legacy = realpathSync(mkdtempSync(join(tmpdir(), 'mrc-legacy-')))
  const slice = join(realpathSync(mkdtempSync(join(tmpdir(), 'mrc-slice-'))), 'plain')
  try {
    writeFileSync(join(legacy, 'plain-uuid.jsonl'), '{"type":"user"}\n')
    writeFileSync(join(legacy, 'member-uuid.jsonl'), '{"type":"user"}\n')   // a @member transcript
    writeFileSync(join(legacy, 'session-names'), 'plain-uuid=my session\n')
    writeFileSync(join(legacy, '.env'), 'SECRET=1\n')                       // Class 2 — must NOT migrate
    const r = migrateToStore(legacy, slice, { exclude: new Set(['member-uuid']) })
    assert.equal(r.migrated, 2, 'plain transcript + session-names copied')
    assert.ok(existsSyncT(join(slice, 'plain-uuid.jsonl')), 'plain transcript migrated')
    assert.ok(existsSyncT(join(slice, 'session-names')), 'names migrated')
    assert.ok(!existsSyncT(join(slice, 'member-uuid.jsonl')), 'MEMBER transcript excluded (its own slice)')
    assert.ok(!existsSyncT(join(slice, '.env')), 'Class-2 .env NOT migrated (stays repo-relative)')
    // non-destructive: originals intact
    assert.ok(existsSyncT(join(legacy, 'plain-uuid.jsonl')) && existsSyncT(join(legacy, 'member-uuid.jsonl')) && existsSyncT(join(legacy, '.env')), 'legacy originals left intact (symmetric bridge)')
    // idempotent: sentinel present → second call is a no-op
    const r2 = migrateToStore(legacy, slice, { exclude: new Set(['member-uuid']) })
    assert.equal(r2.alreadyDone, true, 'sentinel → idempotent no-op')
  } finally { rmSync(legacy, { recursive: true, force: true }); rmSync(join(slice, '..'), { recursive: true, force: true }) }
})

test('migrateToStore: copy-if-absent never clobbers newer store data with older repo data', () => {
  const legacy = realpathSync(mkdtempSync(join(tmpdir(), 'mrc-legacy-')))
  const slice = join(realpathSync(mkdtempSync(join(tmpdir(), 'mrc-slice-'))), 'plain')
  try {
    mkdirSync(slice, { recursive: true })
    writeFileSync(join(legacy, 'x.jsonl'), 'OLD-repo\n')
    writeFileSync(join(slice, 'x.jsonl'), 'NEW-store\n')   // store already has a newer x.jsonl
    migrateToStore(legacy, slice, {})
    assert.equal(readFileSync(join(slice, 'x.jsonl'), 'utf8'), 'NEW-store\n', 'copy-if-absent kept the newer store copy')
  } finally { rmSync(legacy, { recursive: true, force: true }); rmSync(join(slice, '..'), { recursive: true, force: true }) }
})

test('migrateToStore INCLUDE (member): copies ONLY the member\'s own transcript into its slice — no sibling, no session-names', () => {
  const legacy = realpathSync(mkdtempSync(join(tmpdir(), 'mrc-legacy-')))
  const slice = join(realpathSync(mkdtempSync(join(tmpdir(), 'mrc-slice-'))), 'member')
  try {
    writeFileSync(join(legacy, 'member-me.jsonl'), '{"type":"user"}\n')      // THIS member's transcript
    writeFileSync(join(legacy, 'member-other.jsonl'), '{"type":"user"}\n')   // a SIBLING member's transcript
    writeFileSync(join(legacy, 'plain-uuid.jsonl'), '{"type":"user"}\n')     // a plain conversation
    writeFileSync(join(legacy, 'session-names'), 'member-me=me\nmember-other=other\n')
    const r = migrateToStore(legacy, slice, { include: new Set(['member-me']) })
    assert.equal(r.migrated, 1, 'ONLY the member\'s own transcript copied')
    assert.ok(existsSyncT(join(slice, 'member-me.jsonl')), 'the member resumes: its own transcript is in its slice')
    assert.ok(!existsSyncT(join(slice, 'member-other.jsonl')), 'a SIBLING member transcript never bleeds into this slice')
    assert.ok(!existsSyncT(join(slice, 'plain-uuid.jsonl')), 'a plain transcript never bleeds into a member slice')
    assert.ok(!existsSyncT(join(slice, 'session-names')), 'session-names NOT copied (would leak sibling names into the member slice)')
    // non-destructive: every legacy original intact (recoverable)
    assert.ok(existsSyncT(join(legacy, 'member-me.jsonl')) && existsSyncT(join(legacy, 'member-other.jsonl')), 'legacy originals intact')
    // idempotent
    assert.equal(migrateToStore(legacy, slice, { include: new Set(['member-me']) }).alreadyDone, true, 'sentinel → idempotent')
  } finally { rmSync(legacy, { recursive: true, force: true }); rmSync(join(slice, '..'), { recursive: true, force: true }) }
})

// ---------- BUG-1: mtime not clobbered on migrate (Fix B) + repaired on an already-migrated slice (Fix C) ----------
import { normalizeSliceMtimes, migrateAndNormalize } from '../src/mrc-store.js'
test('BUG-1 Fix B: migrateToStore preserves the SOURCE mtime (copyFileSync alone would stamp NOW → recency collapse)', () => {
  const legacy = realpathSync(mkdtempSync(join(tmpdir(), 'mrc-legacy-')))
  const slice = join(realpathSync(mkdtempSync(join(tmpdir(), 'mrc-slice-'))), 'plain')
  try {
    const old = new Date('2020-03-04T05:06:07Z')
    writeFileSync(join(legacy, 'a.jsonl'), '{"type":"user","timestamp":"2020-03-04T05:06:07Z"}\n')
    utimesSync(join(legacy, 'a.jsonl'), old, old)
    migrateToStore(legacy, slice, {})
    const ms = statSync(join(slice, 'a.jsonl')).mtimeMs
    assert.ok(Math.abs(ms - old.getTime()) < 2000, `copy carries the source mtime (${new Date(ms).toISOString()}), not NOW`)
  } finally { rmSync(legacy, { recursive: true, force: true }); rmSync(join(slice, '..'), { recursive: true, force: true }) }
})

test('BUG-1 Fix C: normalizeSliceMtimes repairs a clobbered mtime to MAX(legacy, slice-lastTs) — never NOW, Q2-safe', () => {
  const legacy = realpathSync(mkdtempSync(join(tmpdir(), 'mrc-legacy-')))
  const slice = join(realpathSync(mkdtempSync(join(tmpdir(), 'mrc-slice-'))), 'plain')
  try {
    mkdirSync(slice, { recursive: true })
    const now = new Date()
    // x: migrated-only — legacy mtime + slice lastTs both OLD; slice mtime CLOBBERED to NOW → must repair to OLD
    writeFileSync(join(legacy, 'x.jsonl'), '{"type":"user","timestamp":"2021-06-01T00:00:00Z"}\n')
    utimesSync(join(legacy, 'x.jsonl'), new Date('2021-06-01T00:00:00Z'), new Date('2021-06-01T00:00:00Z'))
    writeFileSync(join(slice, 'x.jsonl'), '{"type":"user","timestamp":"2021-06-01T00:00:00Z"}\n')
    utimesSync(join(slice, 'x.jsonl'), now, now)
    // y (Q2): opened IN-SLICE after migration — legacy is STALE, but the slice transcript has a NEWER lastTs; slice
    // mtime also clobbered to NOW. MAX(stale-legacy, newer-slice-lastTs) must pick the newer ts, NOT demote to legacy.
    writeFileSync(join(legacy, 'y.jsonl'), '{"type":"user","timestamp":"2021-01-01T00:00:00Z"}\n')
    utimesSync(join(legacy, 'y.jsonl'), new Date('2021-01-01T00:00:00Z'), new Date('2021-01-01T00:00:00Z'))
    writeFileSync(join(slice, 'y.jsonl'), '{"type":"user","timestamp":"2021-01-01T00:00:00Z"}\n{"type":"user","timestamp":"2022-12-31T00:00:00Z"}\n')
    utimesSync(join(slice, 'y.jsonl'), now, now)

    normalizeSliceMtimes(slice, legacy)
    const mx = statSync(join(slice, 'x.jsonl')).mtimeMs, my = statSync(join(slice, 'y.jsonl')).mtimeMs
    assert.ok(Math.abs(mx - Date.parse('2021-06-01T00:00:00Z')) < 2000, `x repaired to its real recency, not NOW (got ${new Date(mx).toISOString()})`)
    assert.ok(mx < now.getTime() - 60_000, 'x is NOT left at the clobbered NOW')
    assert.ok(Math.abs(my - Date.parse('2022-12-31T00:00:00Z')) < 2000, `Q2: y kept its NEWER slice-lastTs, not demoted to the stale legacy mtime (got ${new Date(my).toISOString()})`)
    // idempotent: own sentinel → second call is a no-op
    assert.equal(normalizeSliceMtimes(slice, legacy).alreadyDone, true, 'mtime sentinel → one-time')
  } finally { rmSync(legacy, { recursive: true, force: true }); rmSync(join(slice, '..'), { recursive: true, force: true }) }
})

test('Finding-1: migrateAndNormalize skipNormalize — migrates (copy-if-absent) but NEVER runs the mtime WRITE on a live slice', () => {
  const legacy = realpathSync(mkdtempSync(join(tmpdir(), 'mrc-legacy-')))
  const slice = join(realpathSync(mkdtempSync(join(tmpdir(), 'mrc-slice-'))), 'plain')
  try {
    writeFileSync(join(legacy, 'a.jsonl'), '{"type":"user","timestamp":"2020-01-01T00:00:00Z"}\n')
    utimesSync(join(legacy, 'a.jsonl'), new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'))
    migrateAndNormalize(legacy, slice, { skipNormalize: true })
    assert.ok(existsSyncT(join(slice, 'a.jsonl')), 'migrate still ran (copy-if-absent is safe on a live slice)')
    assert.ok(!existsSyncT(join(slice, '.mrc-mtimes-normalized')), 'skipNormalize → the mtime WRITE was skipped (no sentinel) — never mtime-race a live agent; the repair defers to an idle launch')
  } finally { rmSync(legacy, { recursive: true, force: true }); rmSync(join(slice, '..'), { recursive: true, force: true }) }
})

test('Finding-2: normalizeSliceMtimes does NOT stamp the sentinel on a FAILED run (retry-safe, no-silent-failure)', () => {
  const r = normalizeSliceMtimes('/no/such/slice-xyz', '/no/such/legacy')
  assert.equal(r.failed, true, 'an unlistable slice → failed (retry next time), NOT a silent success that freezes the clobber forever')
  // contrast: an UNHELPABLE file (no legacy source + no parseable ts → ms=0) is SKIPPED, not a failure → sentinel commits
  const legacy = realpathSync(mkdtempSync(join(tmpdir(), 'mrc-legacy-')))
  const slice = join(realpathSync(mkdtempSync(join(tmpdir(), 'mrc-slice-'))), 'plain')
  try {
    mkdirSync(slice, { recursive: true })
    writeFileSync(join(slice, 'no-ts.jsonl'), 'not-json no timestamp\n')
    assert.equal(normalizeSliceMtimes(slice, legacy).failed, false, 'a no-recency file is unhelpable, NOT a failure')
    assert.equal(normalizeSliceMtimes(slice, legacy).alreadyDone, true, 'so the sentinel DID commit (nothing failed) — no needless re-scan')
  } finally { rmSync(legacy, { recursive: true, force: true }); rmSync(join(slice, '..'), { recursive: true, force: true }) }
})

// ---------- PICKABLE ⟺ MIGRATED (the guardrail invariant, unit level) ----------
import { getSessions } from '../src/sessions/manager.js'
import { readdirSync } from 'node:fs'
test('PICKABLE⟺MIGRATED: the SAME exclude at the picker AND the migration → every listed session is migrated (no ghost)', () => {
  const legacy = realpathSync(mkdtempSync(join(tmpdir(), 'mrc-legacy-')))
  const slice = join(realpathSync(mkdtempSync(join(tmpdir(), 'mrc-slice-'))), 'plain')
  try {
    writeFileSync(join(legacy, 'plain.jsonl'), '{"type":"user","timestamp":"2026-01-01T00:00:00Z","message":{"content":"hi"}}\n')
    writeFileSync(join(legacy, 'member-abc.jsonl'), '{"type":"user","timestamp":"2026-01-02T00:00:00Z","message":{"content":"member"}}\n')
    const exclude = new Set(['member-abc'])   // the roster's memberSessionId set
    const listed = new Set(getSessions(legacy, { exclude }).map((s) => s.uuid))            // the PICKER
    migrateToStore(legacy, slice, { exclude })                                             // the MIGRATION (same exclude)
    const migrated = new Set(readdirSync(slice).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -6)))
    assert.ok(!listed.has('member-abc') && !migrated.has('member-abc'), 'member excluded from BOTH picker and migration')
    assert.ok(listed.has('plain') && migrated.has('plain'), 'plain in BOTH')
    for (const u of listed) assert.ok(migrated.has(u), `every listed session must be migrated — ${u} would be a GHOST otherwise`)
  } finally { rmSync(legacy, { recursive: true, force: true }); rmSync(join(slice, '..'), { recursive: true, force: true }) }
})
