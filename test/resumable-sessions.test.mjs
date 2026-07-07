// D2: getResumableSessions is the ONE ordered list shared by the picker and `resolve` (`sessions resume <#>`). It
// merges normal .mrc sessions with SUMMONED-ADVERSARY sessions from the machine-global host records — because a caged
// adversary's transcript lives in its -pierre-N config volume, not .mrc. Containment floor: only THIS repo's
// adversaries surface (rec.repoPath === repoPath), else a resume computes the wrong repo's (empty/co-resident) volume.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'

// Isolate HOME before importing session-record (its recordDir() is ~/.local/share/mrc/session-meta, machine-global).
process.env.HOME = fs.mkdtempSync(join(os.tmpdir(), 'mrc-resumable-home-'))
const { getResumableSessions, resolve, saveNames } = await import('../src/sessions/manager.js')
const { saveSessionRecord, isAdversarySession } = await import('../src/session-record.js')

function setup() {
  const repo = fs.mkdtempSync(join(os.tmpdir(), 'mrc-repoA-'))
  const foreign = fs.mkdtempSync(join(os.tmpdir(), 'mrc-repoB-'))
  const mrcDir = join(repo, '.mrc')
  fs.mkdirSync(mrcDir, { recursive: true })
  // a NORMAL session with a real .mrc transcript
  fs.writeFileSync(join(mrcDir, 'normal-uuid.jsonl'),
    JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { content: 'hi' } }) + '\n')
  // adversaries in the GLOBAL host records: one summoned in THIS repo, one in a FOREIGN repo
  saveSessionRecord('adv-here', { repoPath: repo, summonedBy: 'summoner-x', adversary: true, slot: 2 })
  saveSessionRecord('adv-foreign', { repoPath: foreign, summonedBy: 'summoner-y', adversary: true, slot: 1 })
  saveSessionRecord('normal-uuid', { repoPath: repo, adversary: false })   // the .mrc session's own (non-adversary) record
  // Deterministic recency for the collation: the normal session is NEWEST → it stays #1, adv-here #2 (matches the
  // fixed #-assertions below). Set the .mrc file mtime and the adv record's file mtime explicitly.
  const rec = join(process.env.HOME, '.local/share/mrc/session-meta')
  fs.utimesSync(join(mrcDir, 'normal-uuid.jsonl'), new Date('2026-06-15T00:00:00Z'), new Date('2026-06-15T00:00:00Z'))
  fs.utimesSync(join(rec, 'adv-here.json'), new Date('2026-06-01T00:00:00Z'), new Date('2026-06-01T00:00:00Z'))
  return { mrcDir, repo }   // #5: repoPath is now a REQUIRED arg (no dirname default), so tests pass the real repo
}

test('getResumableSessions: surfaces a THIS-repo adversary, FILTERS a foreign-repo one, dedups the normal session', () => {
  const { mrcDir, repo } = setup()
  const rows = getResumableSessions(mrcDir, { repoPath: repo })
  const byId = Object.fromEntries(rows.map((r) => [r.uuid, r]))
  assert.ok(byId['normal-uuid'], 'the normal .mrc session is listed')
  assert.equal(byId['normal-uuid'].adversary, false, 'the normal session is not flagged adversary')
  assert.ok(byId['adv-here'], 'a THIS-repo summoned adversary is surfaced (its transcript is in the -pierre-N volume, not .mrc)')
  assert.equal(byId['adv-here'].adversary, true, 'the this-repo adversary is flagged adversary')
  assert.equal(byId['adv-here'].summonedBy, 'summoner-x', 'its summoner is carried for the ⚔ issuer label')
  assert.ok(!byId['adv-foreign'], 'a FOREIGN-repo adversary is NOT surfaced — containment floor (its -pierre-N pool is keyed by the OTHER repo hash, so a resume here would mount the wrong/empty volume)')
  assert.equal(rows.filter((r) => r.uuid === 'normal-uuid').length, 1, 'a session with both a .mrc transcript and a record is listed exactly once')
})

test('resolve: shares the merged order — `sessions resume <#>` reaches the appended adversary, and a raw adversary uuid resolves', () => {
  const { mrcDir, repo } = setup()
  // rows = [ normal-uuid (from .mrc), adv-here (appended) ] → #1, #2
  assert.equal(resolve(mrcDir, '1', { repoPath: repo }), 'normal-uuid', '#1 is the normal session')
  assert.equal(resolve(mrcDir, '2', { repoPath: repo }), 'adv-here', '#2 reaches the appended adversary — the picker and `sessions resume <#>` can not diverge')
  assert.equal(resolve(mrcDir, 'adv-here', { repoPath: repo }), 'adv-here', 'a raw adversary uuid resolves (D10 confirmIfAdversary still guards the resume in mrc.js)')
  assert.equal(resolve(mrcDir, 'adv-foreign', { repoPath: repo }), null, 'a foreign-repo adversary uuid does NOT resolve here')
})

// The LOAD-BEARING containment invariant (Pierre): the inline confirm is intent-safety, NOT the gate — the re-cage
// (mrc.js:423 `if (isAdversarySession(resumeSession))`) fires from the UUID regardless of the confirm. So the thing
// that MUST stay true is: EVERY resolve path that yields an adversary uuid yields one that isAdversarySession flags
// (→ resumeIsAdversary → cageAdversary default-on → the -pierre-N volume + firewall re-cage). A future refactor that
// resolved an adversary to a uuid the re-cage didn't recognize would be the real hole — this guards it.
test('adversary rows carry a real timestamp (record mtime) and sort most-recent-first within the group', () => {
  const repo = fs.mkdtempSync(join(os.tmpdir(), 'mrc-repoTs-'))
  const mrcDir = join(repo, '.mrc'); fs.mkdirSync(mrcDir, { recursive: true })
  saveSessionRecord('adv-old', { repoPath: repo, summonedBy: 's1', adversary: true })
  saveSessionRecord('adv-new', { repoPath: repo, summonedBy: 's2', adversary: true })
  // Make adv-old ancient; adv-new keeps its ~now mtime.
  fs.utimesSync(join(process.env.HOME, '.local/share/mrc/session-meta/adv-old.json'), new Date(1000), new Date(1000))
  const adv = getResumableSessions(mrcDir, { repoPath: repo }).filter((r) => r.adversary)
  assert.deepEqual(adv.map((r) => r.uuid), ['adv-new', 'adv-old'], 'most-recently-summoned adversary first (not undated at the bottom)')
  assert.ok(adv[0].recencyMs > 0 && adv[0].lastUpdated, 'a real timestamp is stamped from the record mtime (was 0 → blank date + always-last)')
  assert.equal(adv[1].recencyMs, 1000, 'the ancient record keeps its own mtime')
})

test('BUG-2: store-mode surfaces adversaries — mrcDir is the SLICE (dirname≠repo), repoPath passed explicitly', () => {
  const repo = fs.mkdtempSync(join(os.tmpdir(), 'mrc-repoStore-'))
  // the SLICE lives OUTSIDE the repo (store-mode): dirname(sliceDir) is the store root, NOT repo — the old
  // dirname(mrcDir) default would filter this adversary out. With repoPath passed, it surfaces.
  const sliceDir = fs.mkdtempSync(join(os.tmpdir(), 'mrc-store-slice-'))
  saveSessionRecord('adv-store', { repoPath: repo, summonedBy: 'sx', adversary: true, slot: 1 })
  const rows = getResumableSessions(sliceDir, { repoPath: repo })
  assert.ok(rows.find((r) => r.uuid === 'adv-store' && r.adversary), 'the adversary surfaces in store-mode when the REAL repoPath is passed (not dirname of the slice)')
  // and the fail-loud contract: a missed call site (no repoPath) THROWS, never silently drops the adversary
  assert.throws(() => getResumableSessions(sliceDir), /repoPath is required/, 'no repoPath → loud throw, not a silent empty adversary list')
})

test('containment invariant: every resolve path to an adversary yields a uuid the mrc.js re-cage recognizes', () => {
  const { mrcDir, repo } = setup()
  saveNames(mrcDir, { 'adv-here': 'redteam-pierre' })   // so the by-NAME resolve path is asserted too (Pierre), not just covered by construction
  for (const [path, q] of [['by-number', '2'], ['by-uuid', 'adv-here'], ['by-name', 'redteam-pierre']]) {
    const uuid = resolve(mrcDir, q, { repoPath: repo })
    assert.equal(uuid, 'adv-here', `${path} resolves the adversary`)
    assert.equal(isAdversarySession(uuid), true, `${path}: the resolved uuid triggers the mrc.js:423 re-cage (cageAdversary defaults ON) — a bypassed confirm still reopens CAGED, not uncaged`)
  }
})
