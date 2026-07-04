// container/mrc-rename.js — the in-session "rename this session" helper. Runs the REAL script against a temp
// .mrc (via MRC_RENAME_DIR) and cross-checks with src/sessions/manager.js's reader, so the two stay in
// lockstep (the script replicates manager's session-names format because src/ isn't available in the
// container). Integration substrate: session-names is the ONLY store (no per-uuid session-meta — #32
// name-meta was decided against), so these tests assert that single file.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const { loadNames } = await import(join(here, '../src/sessions/manager.js'))
const SCRIPT = join(here, '../container/mrc-rename.js')

function freshMrc() {
  const dir = join(mkdtempSync(join(tmpdir(), 'mrc-rename-')), '.mrc')
  mkdirSync(dir, { recursive: true })
  // Two transcripts; make 'cur-uuid' the most-recently-modified (the "active" session).
  writeFileSync(join(dir, 'old-uuid.jsonl'), '{}\n'); utimesSync(join(dir, 'old-uuid.jsonl'), new Date(1000), new Date(1000))
  writeFileSync(join(dir, 'cur-uuid.jsonl'), '{}\n'); utimesSync(join(dir, 'cur-uuid.jsonl'), new Date(9999999999), new Date(9999999999))
  return dir
}
const run = (dir, args, env = {}) => execFileSync('node', [SCRIPT, ...args], { env: { ...process.env, MRC_RENAME_DIR: dir, ...env }, encoding: 'utf8' })

test('no MRC_SESSION_ID → targets the newest .jsonl and writes a manager-readable name', () => {
  const dir = freshMrc()
  run(dir, ['my cool name'], { MRC_SESSION_ID: '' })
  assert.equal(loadNames(dir)['cur-uuid'], 'my cool name', 'newest session named')
  // Stickiness: names[uuid] truthy → the host auto-namer (generateName) returns 'exists' and won't clobber.
  assert.ok(loadNames(dir)['cur-uuid'])
})

test('MRC_SESSION_ID wins over the newest-jsonl heuristic and leaves the other session untouched', () => {
  const dir = freshMrc()
  run(dir, ['first'], { MRC_SESSION_ID: 'cur-uuid' })
  run(dir, ['second name'], { MRC_SESSION_ID: 'old-uuid' })
  assert.equal(loadNames(dir)['old-uuid'], 'second name', 'pinned id targeted')
  assert.equal(loadNames(dir)['cur-uuid'], 'first', 'the other name untouched (merge, not clobber)')
})

test('sanitize: newline collapsed (session-names is line-based) and a = in the name round-trips', () => {
  const dir = freshMrc()
  run(dir, ['has = and\nnewline'], { MRC_SESSION_ID: 'cur-uuid' })
  assert.equal(loadNames(dir)['cur-uuid'], 'has = and newline')
})

test('empty name → usage error (nonzero exit), nothing written', () => {
  const dir = freshMrc()
  assert.throws(() => run(dir, [''], { MRC_SESSION_ID: 'cur-uuid' }))
  assert.equal(loadNames(dir)['cur-uuid'], undefined)
})
