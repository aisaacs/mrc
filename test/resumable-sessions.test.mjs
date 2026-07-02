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
  return { mrcDir }
}

test('getResumableSessions: surfaces a THIS-repo adversary, FILTERS a foreign-repo one, dedups the normal session', () => {
  const { mrcDir } = setup()
  const rows = getResumableSessions(mrcDir)
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
  const { mrcDir } = setup()
  // rows = [ normal-uuid (from .mrc), adv-here (appended) ] → #1, #2
  assert.equal(resolve(mrcDir, '1'), 'normal-uuid', '#1 is the normal session')
  assert.equal(resolve(mrcDir, '2'), 'adv-here', '#2 reaches the appended adversary — the picker and `sessions resume <#>` can not diverge')
  assert.equal(resolve(mrcDir, 'adv-here'), 'adv-here', 'a raw adversary uuid resolves (D10 confirmIfAdversary still guards the resume in mrc.js)')
  assert.equal(resolve(mrcDir, 'adv-foreign'), null, 'a foreign-repo adversary uuid does NOT resolve here')
})

// The LOAD-BEARING containment invariant (Pierre): the inline confirm is intent-safety, NOT the gate — the re-cage
// (mrc.js:423 `if (isAdversarySession(resumeSession))`) fires from the UUID regardless of the confirm. So the thing
// that MUST stay true is: EVERY resolve path that yields an adversary uuid yields one that isAdversarySession flags
// (→ resumeIsAdversary → cageAdversary default-on → the -pierre-N volume + firewall re-cage). A future refactor that
// resolved an adversary to a uuid the re-cage didn't recognize would be the real hole — this guards it.
test('containment invariant: every resolve path to an adversary yields a uuid the mrc.js re-cage recognizes', () => {
  const { mrcDir } = setup()
  saveNames(mrcDir, { 'adv-here': 'redteam-pierre' })   // so the by-NAME resolve path is asserted too (Pierre), not just covered by construction
  for (const [path, q] of [['by-number', '2'], ['by-uuid', 'adv-here'], ['by-name', 'redteam-pierre']]) {
    const uuid = resolve(mrcDir, q)
    assert.equal(uuid, 'adv-here', `${path} resolves the adversary`)
    assert.equal(isAdversarySession(uuid), true, `${path}: the resolved uuid triggers the mrc.js:423 re-cage (cageAdversary defaults ON) — a bypassed confirm still reopens CAGED, not uncaged`)
  }
})
