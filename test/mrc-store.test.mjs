// #5 — the host-scoped memory store's chokepoint: the slice-keying lattice (isolated-by-default / repoId-by-grant),
// the race-safe + traversal-safe repo-id mint (Gates 2/4), and the ..-guard. The security core is the lattice:
// repoId (the user's own memory) is GRANTED only on a positive trusted-own signal — never fallen into by a member
// or a summoned adversary. sliceKeyFor takes an injected repoStoreId so "a member never reads .mrc-id" is a test.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sliceKeyFor, repoStoreId, sliceDir, assertSafeSegment, storeRoot, repoIdFile, decideStoreMode, resolveStoreMode, STORE_CAPABILITY, storeCtx } from '../src/mrc-store.js'

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
