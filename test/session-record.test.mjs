// session-record.js — the host-only containment record: keystone-aligned isAdversarySession, the
// 3-state classifySession the bare-resume guard keys on, and the transcript-coupled prune. Sets an
// isolated HOME up front (UNconditionally) so it can never read/delete a real ~/.local/share/mrc record.
//   node test/session-record.test.mjs
import assert from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Isolate HOME BEFORE importing — session-record's recordDir() = join(homedir(), …) reads $HOME per call.
process.env.HOME = mkdtempSync(join(tmpdir(), 'mrc-srtest-home-'))

const { saveSessionRecord, loadSessionRecord, isAdversarySession, classifySession, pruneSessionRecords } =
  await import('../src/session-record.js')

let pass = 0, fail = 0
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`) }
  catch (e) { fail++; console.log(`  \x1b[31m✗ ${name}\x1b[0m\n    ${e.message}`) }
}
const repos = []
function repo(uuid, withTranscript) {
  const dir = mkdtempSync(join(tmpdir(), 'mrc-repo-'))
  repos.push(dir)
  if (withTranscript) { mkdirSync(join(dir, '.mrc'), { recursive: true }); writeFileSync(join(dir, '.mrc', `${uuid}.jsonl`), '{}\n') }
  return dir
}

console.log('\nsession-record — classification + transcript-coupled prune')

// --- isAdversarySession: keystone (adversary || summonedBy), 2-state ---
t('isAdversarySession: summonedBy set → true', () => {
  saveSessionRecord('u-adv1', { adversary: true, summonedBy: 'issuer-x' })
  assert.equal(isAdversarySession('u-adv1'), true)
})
t('isAdversarySession: adversary:true with NO summonedBy → true (aligned to keystone)', () => {
  saveSessionRecord('u-adv2', { adversary: true, summonedBy: null })
  assert.equal(isAdversarySession('u-adv2'), true)
})
t('isAdversarySession: normal record → false', () => {
  saveSessionRecord('u-norm1', { adversary: false, summonedBy: null })
  assert.equal(isAdversarySession('u-norm1'), false)
})
t('isAdversarySession: NO record → false (2-state collapses absence into not-adversary)', () => {
  assert.equal(isAdversarySession('u-absent'), false)
})

// --- classifySession: 3-state on record PRESENCE (this is what the guard keys on) ---
t('classifySession: adversary record → "adversary"', () => assert.equal(classifySession('u-adv1'), 'adversary'))
t('classifySession: adversary:true w/o summonedBy → "adversary"', () => assert.equal(classifySession('u-adv2'), 'adversary'))
t('classifySession: normal record → "normal"', () => assert.equal(classifySession('u-norm1'), 'normal'))
t('classifySession: NO record → "unknown" (the fail-closed input absence collapses into in the 2-state)', () =>
  assert.equal(classifySession('u-never-seen'), 'unknown'))

// --- pruneSessionRecords: never-adversary, transcript-coupled, keep-on-ambiguity ---
t('prune KEEPS an adversary record even when its transcript is gone (moved-repo safety)', () => {
  saveSessionRecord('p-adv', { adversary: true, summonedBy: 'x', repoPath: repo('p-adv', false) })
  pruneSessionRecords()
  assert.equal(loadSessionRecord('p-adv').uuid, 'p-adv')
})
t('prune DROPS a normal record whose transcript is provably gone', () => {
  saveSessionRecord('p-norm-gone', { adversary: false, repoPath: repo('p-norm-gone', false) })
  pruneSessionRecords()
  assert.equal(loadSessionRecord('p-norm-gone').uuid, undefined)
})
t('prune KEEPS a normal record whose transcript still exists', () => {
  saveSessionRecord('p-norm-live', { adversary: false, repoPath: repo('p-norm-live', true) })
  pruneSessionRecords()
  assert.equal(loadSessionRecord('p-norm-live').uuid, 'p-norm-live')
})
t('prune KEEPS a normal record with NO repoPath (ambiguous → keep, not drop)', () => {
  saveSessionRecord('p-norm-nopath', { adversary: false })
  pruneSessionRecords()
  assert.equal(loadSessionRecord('p-norm-nopath').uuid, 'p-norm-nopath')
})

for (const r of repos) { try { rmSync(r, { recursive: true, force: true }) } catch {} }
try { rmSync(process.env.HOME, { recursive: true, force: true }) } catch {}

console.log(`\nsession-record: ${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
