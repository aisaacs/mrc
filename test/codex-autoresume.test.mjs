// Auto-resume target selection for a plain `mrc --agent codex`.
//
// This deliberately does NOT use `codex resume --last`: that flag applies its own opaque selection rules
// (cwd filtering, an internal ledger, non-interactive exclusion) and was observed not to resume, while
// `resume <id>` works. The invariant asserted at the bottom is the point of resolving it ourselves —
// auto-resume must land on exactly the session `mrc pick --agent codex` lists first.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'

const { resolveAutoResumeId, findRollouts, rolloutMeta, rankedRollouts } = await import('../container/codex-sessions.js')
const { getCodexSessions } = await import('../src/sessions/codex.js')

const UUID_A = '11111111-1111-4111-8111-111111111111'
const UUID_B = '22222222-2222-4222-8222-222222222222'
const UUID_C = '33333333-3333-4333-8333-333333333333'

function store() {
  return fs.mkdtempSync(join(os.tmpdir(), 'mrc-cxresume-'))
}

function writeRollout(root, { uuid, day = '2026/07/19', originator = 'codex_cli', mtime, lines }) {
  const dir = join(root, day)
  fs.mkdirSync(dir, { recursive: true })
  const file = join(dir, `rollout-2026-07-19T10-00-00-${uuid}.jsonl`)
  const body = lines || [{ type: 'session_meta', payload: { id: uuid, originator } }]
  fs.writeFileSync(file, body.map(l => JSON.stringify(l)).join('\n') + '\n')
  if (mtime) fs.utimesSync(file, mtime, mtime)
  return file
}

test('no store / empty store resumes nothing', () => {
  assert.equal(resolveAutoResumeId(join(os.tmpdir(), 'mrc-does-not-exist-xyz')), '')
  assert.equal(resolveAutoResumeId(store()), '')
})

test('picks the most recently modified session', () => {
  const root = store()
  writeRollout(root, { uuid: UUID_A, day: '2026/07/01', mtime: new Date('2026-07-01T00:00:00Z') })
  writeRollout(root, { uuid: UUID_B, day: '2026/07/19', mtime: new Date('2026-07-19T00:00:00Z') })
  writeRollout(root, { uuid: UUID_C, day: '2026/07/10', mtime: new Date('2026-07-10T00:00:00Z') })
  assert.equal(resolveAutoResumeId(root), UUID_B)
})

test('skips codex exec worker rollouts even when they are newest', () => {
  // `mrc team exec` worker turns share this store. Resuming INTO one would drop an interactive launch
  // into a one-shot worker transcript.
  const root = store()
  writeRollout(root, { uuid: UUID_A, mtime: new Date('2026-07-01T00:00:00Z'), originator: 'codex_cli' })
  writeRollout(root, { uuid: UUID_B, mtime: new Date('2026-07-19T00:00:00Z'), originator: 'codex_exec' })
  assert.equal(resolveAutoResumeId(root), UUID_A)
})

test('all-exec store resumes nothing rather than falling into a worker turn', () => {
  const root = store()
  writeRollout(root, { uuid: UUID_B, originator: 'codex_exec' })
  assert.equal(resolveAutoResumeId(root), '')
})

test('falls back to the filename uuid when meta is unreadable', () => {
  // A truncated/corrupt rollout is still resumable by id — silently starting fresh would be worse.
  const root = store()
  const dir = join(root, '2026/07/19')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(join(dir, `rollout-2026-07-19T10-00-00-${UUID_C}.jsonl`), 'garbage\n{trunc\n')
  assert.equal(resolveAutoResumeId(root), UUID_C)
})

test('reads meta from a large rollout without slurping it', () => {
  const root = store()
  const big = [{ type: 'session_meta', payload: { id: UUID_A, originator: 'codex_cli' } }]
  for (let i = 0; i < 5000; i++) big.push({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(200) }] } })
  const f = writeRollout(root, { uuid: UUID_A, lines: big })
  assert.ok(fs.statSync(f).size > 1_000_000, 'fixture should exceed the read window')
  assert.deepEqual(rolloutMeta(f), { id: UUID_A, originator: 'codex_cli' })
  assert.equal(resolveAutoResumeId(root), UUID_A)
})

test('finds rollouts nested by date and ignores non-rollout files', () => {
  const root = store()
  writeRollout(root, { uuid: UUID_A })
  fs.writeFileSync(join(root, 'ledger.json'), '{}')
  fs.writeFileSync(join(root, '2026/07/19', 'notes.txt'), 'hi')
  assert.equal(findRollouts(root).length, 1)
})

test('scans BOTH stores, so a broken symlink cannot blind auto-resume', () => {
  // The real-world failure: the migration copied rollouts into the repo-local store and emptied
  // ~/.codex/sessions, but the symlink never got planted — so scanning only the volume path found
  // nothing and every launch started fresh, even though `mrc pick` listed sessions fine.
  const local = store()        // /workspace/.mrc/codex-sessions — what the picker reads
  const volume = store()       // ~/.codex/sessions — empty, symlink absent
  writeRollout(local, { uuid: UUID_A, mtime: new Date('2026-07-19T00:00:00Z') })
  assert.equal(resolveAutoResumeId([local, volume]), UUID_A)
  assert.equal(resolveAutoResumeId([volume]), '', 'volume alone is what used to fail')
})

test('newest wins across the two stores', () => {
  const local = store()
  const volume = store()
  writeRollout(local, { uuid: UUID_A, mtime: new Date('2026-07-01T00:00:00Z') })
  writeRollout(volume, { uuid: UUID_B, mtime: new Date('2026-07-19T00:00:00Z') })
  assert.equal(resolveAutoResumeId([local, volume]), UUID_B)
})

test('a file reachable through both paths is counted once', () => {
  // The healthy case: ~/.codex/sessions is a symlink to the repo-local store, so both scans hit the
  // same inode. Without realpath dedup the same session would be ranked twice.
  const repo = fs.mkdtempSync(join(os.tmpdir(), 'mrc-cxlink-'))
  const local = join(repo, 'codex-sessions')
  fs.mkdirSync(local, { recursive: true })
  writeRollout(local, { uuid: UUID_A })
  const linked = join(repo, 'sessions-link')
  fs.symlinkSync(local, linked)

  assert.equal(rankedRollouts([local, linked]).length, 1)
  assert.equal(resolveAutoResumeId([local, linked]), UUID_A)
})

test('INVARIANT: auto-resume lands on exactly what the picker lists first', () => {
  // The reason we resolve the id ourselves instead of using `codex resume --last`. Both sides rank by
  // the same recency and apply the same non-interactive filter, so they must never disagree.
  const repo = fs.mkdtempSync(join(os.tmpdir(), 'mrc-cxrepo-'))
  const mrcDir = join(repo, '.mrc')
  const root = join(mrcDir, 'codex-sessions')
  fs.mkdirSync(root, { recursive: true })

  writeRollout(root, { uuid: UUID_A, day: '2026/07/01', mtime: new Date('2026-07-01T00:00:00Z') })
  writeRollout(root, { uuid: UUID_B, day: '2026/07/19', mtime: new Date('2026-07-19T00:00:00Z') })
  writeRollout(root, { uuid: UUID_C, day: '2026/07/20', mtime: new Date('2026-07-20T00:00:00Z'), originator: 'codex_exec' })

  const pickerFirst = getCodexSessions(mrcDir)[0].uuid
  assert.equal(resolveAutoResumeId(root), pickerFirst)
  assert.equal(pickerFirst, UUID_B)   // and both correctly skipped the newer exec rollout
})
