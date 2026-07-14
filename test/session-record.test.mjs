// session-record.js — the host-only containment record: keystone-aligned isAdversarySession, the
// 3-state classifySession the bare-resume guard keys on, and the transcript-coupled prune. Sets an
// isolated HOME up front (UNconditionally) so it can never read/delete a real ~/.local/share/mrc record.
//   node test/session-record.test.mjs
import assert from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, existsSync } from 'node:fs'
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
  mkdirSync(join(dir, '.mrc'), { recursive: true })   // .mrc ALWAYS exists (the project store dir); only the transcript is conditional
  if (withTranscript) writeFileSync(join(dir, '.mrc', `${uuid}.jsonl`), '{}\n')
  return dir
}
const metaDir = () => join(process.env.HOME, '.local', 'share', 'mrc', 'session-meta')
// Backdate a record file's mtime to exercise the #64 age backstop (the record's own mtime is the clock).
function backdateRecord(uuid, msAgo) {
  const secs = (Date.now() - msAgo) / 1000
  utimesSync(join(metaDir(), `${uuid}.json`), secs, secs)
}
// The prune-owned "transcript observed" sentinel — a FILE, not a record field (#64 containment).
const seenSentinel = (uuid) => existsSync(join(metaDir(), `${uuid}.seen`))

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
// #56 bug C: a team member's record is a deterministic AUTH ANCHOR (the daemon re-registers against its
// secret via R1 + the #38 verified-member gate). Its transcript lives in a territorial/config-vol store, NOT
// repoPath/.mrc, so it NEVER earns `.seen` → before the fix, the age backstop reaped it → the live member
// became un-re-registerable after a daemon restart (register-limbo). Prune must skip it like an adversary.
t('#56 prune KEEPS a team-member record past the age backstop, secret intact (auth anchor, not transcript-governed)', () => {
  saveSessionRecord('p-member', { adversary: false, member: true, secret: 'MSEC', repoPath: repo('p-member', false) })
  backdateRecord('p-member', 2 * 60 * 60 * 1000)   // 2h old, never-seen — the age backstop WOULD reap a plain normal record here
  pruneSessionRecords()
  assert.equal(loadSessionRecord('p-member').uuid, 'p-member')   // kept — a member's lifetime is NOT transcript-governed
  assert.equal(loadSessionRecord('p-member').secret, 'MSEC')     // and its secret survives → R1 can still authenticate the re-register
  assert.equal(classifySession('p-member'), 'normal')            // `member` does NOT change classification (keys on adversary||summonedBy)
})
t('prune KEEPS a normal record whose transcript still exists, and marks the SENTINEL', () => {
  saveSessionRecord('p-norm-live', { adversary: false, repoPath: repo('p-norm-live', true) })
  pruneSessionRecords()
  assert.equal(loadSessionRecord('p-norm-live').uuid, 'p-norm-live')
  assert.equal(seenSentinel('p-norm-live'), true)   // observed → sentinel file, so a future absence reads as a real deletion
})
// #64 containment: prune persists "observed" in a FILE, never by mutating the record (which carries the
// cage/trust bit). Prove prune does NO read-modify-write on the record — else a future re-mark could be clobbered.
t('#64 prune marks via the SENTINEL FILE and never mutates the record (no RMW on the trust bit)', () => {
  saveSessionRecord('p-nomut', { adversary: false, secret: 'SEEKRIT', repoPath: repo('p-nomut', true) })
  pruneSessionRecords()
  assert.equal(seenSentinel('p-nomut'), true)
  const r = loadSessionRecord('p-nomut')
  assert.equal(r.secret, 'SEEKRIT')            // record untouched
  assert.equal(r.transcriptSeen, undefined)    // prune wrote NO field into the record
})
// #64 — the DELETION vs NOT-YET-CREATED distinction. A record is dropped only once its transcript was
// SEEN and then removed; a fresh never-seen record (booting) is KEPT no matter how absent its .jsonl is.
t('#64 prune DROPS a normal record whose transcript was SEEN then deleted (real deletion), and clears the sentinel', () => {
  const dir = repo('p-del', true)
  saveSessionRecord('p-del', { adversary: false, repoPath: dir })
  pruneSessionRecords()                                       // observes transcript → creates sentinel
  assert.equal(seenSentinel('p-del'), true)
  rmSync(join(dir, '.mrc', 'p-del.jsonl'), { force: true })   // now genuinely deleted
  pruneSessionRecords()
  assert.equal(loadSessionRecord('p-del').uuid, undefined)
  assert.equal(seenSentinel('p-del'), false)                 // reap drops record AND sentinel together (no stale-seen inheritance)
})
t('#64 prune KEEPS a fresh never-seen record (transcript not created yet = booting, NOT deleted)', () => {
  saveSessionRecord('p-booting', { adversary: false, repoPath: repo('p-booting', false) })
  pruneSessionRecords()
  assert.equal(loadSessionRecord('p-booting').uuid, 'p-booting')   // the bug fix: a sibling launch must NOT delete a booting session's record
})
t('#64 prune DROPS a never-seen record older than the age backstop (crashed before first write)', () => {
  saveSessionRecord('p-crashed', { adversary: false, repoPath: repo('p-crashed', false) })
  backdateRecord('p-crashed', 2 * 60 * 60 * 1000)             // 2h old, never earned the bit
  pruneSessionRecords()
  assert.equal(loadSessionRecord('p-crashed').uuid, undefined)
})
t('#64 prune KEEPS a SEEN record when the whole .mrc dir is absent (volume reset — no mass-reap)', () => {
  const dir = repo('p-reset', true)
  saveSessionRecord('p-reset', { adversary: false, repoPath: dir })
  pruneSessionRecords()                                       // observes transcript → creates sentinel
  assert.equal(seenSentinel('p-reset'), true)
  rmSync(join(dir, '.mrc'), { recursive: true, force: true }) // whole store vanishes (dangling symlink after a reset)
  pruneSessionRecords()
  assert.equal(loadSessionRecord('p-reset').uuid, 'p-reset')  // dir-absent = ambiguous → KEEP, not "deleted"
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
