// Migration framework foundation + #001 module. Host-only gate (tamper-proof, fail-closed), byte-honest verify over
// the SHARED planMigration manifest, and the RED cases Pierre named: memory/ corruption, corrupt marker, newer-host marker.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { sliceMigrationState, recordMigration, pendingMigrations, hasMigration } from '../src/migrations/registry.js'
import mig001 from '../src/migrations/001-relocate-mrc-to-store.js'

const U1 = '11111111-1111-1111-1111-111111111111', U2 = '22222222-2222-2222-2222-222222222222'
// Each test gets an isolated temp workspace: a slice, a legacy .mrc, and an injected metaRoot (host-only gate) — so the
// real ~/.local/share/mrc/migration-meta is NEVER touched.
function ws() {
  const d = mkdtempSync(join(tmpdir(), 'mrc-mig-'))
  const slice = join(d, 'slice'), legacy = join(d, '.mrc'), metaRoot = join(d, 'migration-meta')
  mkdirSync(slice, { recursive: true }); mkdirSync(legacy, { recursive: true })
  return { d, slice, legacy, metaRoot, metaDir: join(metaRoot, basename(slice)), done: () => rmSync(d, { recursive: true, force: true }) }
}

test('registry: host-only gate — empty → not migrated; record → migrated + layoutLevel + hasMigration', () => {
  const w = ws()
  try {
    let st = sliceMigrationState(w.slice, { metaRoot: w.metaRoot })
    assert.equal(st.migrated, false); assert.equal(st.layoutLevel, 0); assert.equal(st.corrupt, false)
    recordMigration(w.slice, mig001, { metaRoot: w.metaRoot })
    st = sliceMigrationState(w.slice, { metaRoot: w.metaRoot })
    assert.equal(st.migrated, true); assert.equal(st.layoutLevel, 0)
    assert.equal(hasMigration(w.slice, mig001.id, { metaRoot: w.metaRoot }), true)
  } finally { w.done() }
})

test('#001: up() migrates non-destructively (incl memory/), verify() PASSES byte-identical, pending clears', () => {
  const w = ws()
  writeFileSync(join(w.legacy, `${U1}.jsonl`), '{"timestamp":"2026-06-01T00:00:00Z","x":1}\n')
  writeFileSync(join(w.legacy, 'session-names'), `${U1}=hi\n`)
  mkdirSync(join(w.legacy, 'memory')); writeFileSync(join(w.legacy, 'memory', 'MEMORY.md'), '# mem\n')
  try {
    const ctx = { legacyDir: w.legacy, sliceDir: w.slice }
    assert.equal(mig001.isPending(ctx), true)
    mig001.up(ctx)
    assert.ok(existsSync(join(w.slice, `${U1}.jsonl`)) && existsSync(join(w.slice, 'memory', 'MEMORY.md')), 'migrated incl memory/')
    assert.ok(existsSync(join(w.legacy, `${U1}.jsonl`)), 'legacy retained (non-destructive)')
    const v = mig001.verify(ctx)
    assert.equal(v.pass, true, `verify should pass: ${JSON.stringify(v.checks)}`)
    recordMigration(w.slice, mig001, { metaRoot: w.metaRoot })
    assert.equal(pendingMigrations(w.slice, { metaRoot: w.metaRoot, legacyDir: w.legacy }).length, 0, 'not pending after record')
  } finally { w.done() }
})

test('#001 verify FAILS on a corrupt memory/MEMORY.md (recursive byte-walk — not just transcripts)', () => {
  const w = ws()
  writeFileSync(join(w.legacy, `${U1}.jsonl`), 'x\n'); writeFileSync(join(w.slice, `${U1}.jsonl`), 'x\n')
  mkdirSync(join(w.legacy, 'memory')); mkdirSync(join(w.slice, 'memory'))
  writeFileSync(join(w.legacy, 'memory', 'MEMORY.md'), '# the real memory\n')
  writeFileSync(join(w.slice, 'memory', 'MEMORY.md'), '# corrupted / truncated\n')
  try {
    const v = mig001.verify({ legacyDir: w.legacy, sliceDir: w.slice })
    assert.equal(v.pass, false)
    assert.ok(v.checks.some(c => c.kind === 'differs' && c.file === 'memory/MEMORY.md'), 'flags the corrupt memory file')
  } finally { w.done() }
})

test('#001 verify FAILS on a MISSING transcript (drop / divergent sharer — door #1)', () => {
  const w = ws()
  writeFileSync(join(w.legacy, `${U1}.jsonl`), 'a\n'); writeFileSync(join(w.slice, `${U1}.jsonl`), 'a\n')
  writeFileSync(join(w.legacy, `${U2}.jsonl`), 'b\n')   // in repo/.mrc, NOT in the shared slice
  try {
    const v = mig001.verify({ legacyDir: w.legacy, sliceDir: w.slice })
    assert.equal(v.pass, false)
    assert.ok(v.checks.some(c => c.kind === 'missing' && c.file === `${U2}.jsonl`))
  } finally { w.done() }
})

test('#001 verify FAILS on DIFFERING bytes (same uuid, different content = divergent sharer)', () => {
  const w = ws()
  writeFileSync(join(w.legacy, `${U1}.jsonl`), 'repoB version\n')
  writeFileSync(join(w.slice, `${U1}.jsonl`), 'repoA version (copy-if-absent kept)\n')
  try {
    const v = mig001.verify({ legacyDir: w.legacy, sliceDir: w.slice })
    assert.equal(v.pass, false)
    assert.ok(v.checks.some(c => c.kind === 'differs' && c.file === `${U1}.jsonl`))
  } finally { w.done() }
})

test('#001 verify SKIPS excluded @member transcripts (relocated to their own slice — not a drop)', () => {
  const w = ws()
  writeFileSync(join(w.legacy, `${U1}.jsonl`), 'x\n'); writeFileSync(join(w.slice, `${U1}.jsonl`), 'x\n')
  writeFileSync(join(w.legacy, `${U2}.jsonl`), 'member\n')
  try {
    const v = mig001.verify({ legacyDir: w.legacy, sliceDir: w.slice, exclude: new Set([U2]) })
    assert.equal(v.pass, true, `excluded member not flagged: ${JSON.stringify(v.checks)}`)
  } finally { w.done() }
})

test('registry FAIL-CLOSED: a corrupt (unparseable) host marker → corrupt=true (deny store-mode, never silent level 0)', () => {
  const w = ws()
  mkdirSync(w.metaDir, { recursive: true })
  writeFileSync(join(w.metaDir, mig001.id), 'not json {{{')
  try {
    const st = sliceMigrationState(w.slice, { metaRoot: w.metaRoot })
    assert.equal(st.corrupt, true, 'a present-but-unparseable marker fails closed')
  } finally { w.done() }
})

test('registry CROSS-VERSION: an UNKNOWN-module marker (newer host) still CONTRIBUTES its stamped layoutLevel', () => {
  const w = ws()
  mkdirSync(w.metaDir, { recursive: true })
  // a slice migrated by a NEWER host to some future migration at layout 3; this (older) host does not know it.
  writeFileSync(join(w.metaDir, '003-future-layout-change'), JSON.stringify({ id: '003-future-layout-change', layoutLevel: 3 }))
  try {
    const st = sliceMigrationState(w.slice, { metaRoot: w.metaRoot })
    assert.equal(st.layoutLevel, 3, 'unknown-module marker contributes its stamped level → old host sees level 3 (would fail-to-legacy), never undercounts+misreads')
    assert.equal(st.corrupt, false)
  } finally { w.done() }
})
