// #49-SEC — the member-writable-roster confused deputy. The inner `mrc --member` launch must derive EVERY
// security-load-bearing field (org→sessionId, mount/territory→write-scope, repo, cage) from an AUTHORITATIVE
// source — the OUTER launcher's host-set --member-def blob (team) or the repo-derived soloRoster (solo) — and
// NEVER from the member-writable roster (team.runtime.json in the rw-mounted .mrc). These assert exactly that,
// including the NEGATIVE (Pierre #4): with the blob absent, NOTHING backstops from the roster — it fails closed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveMemberIdentity, memberArgv, memberWorkspaceVolumes } from '../src/commands/team.js'
import { rosterCandidates } from '../src/teams/roster.js'
import { memberSessionId } from '../src/teams/session-id.js'

const enc = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64')

// What a live member could REWRITE team.runtime.json into: wrong org, full-repo rw, uncaged. If ANY of these
// leaks into the launch, a door is open. Every test below proves the roster is NOT the source.
const TAMPERED = {
  org: 'VICTIM',
  members: [{ handle: 'a/claude', first: 'alice', mount: 'rw', territory: '.', cage: null, tier: 'live', team: 't', role: 'engineer', repo: '/repo' }],
}

test('team member: identity is the --member-def BLOB, roster ignored (Door 1 org, Door 3 mount/territory, limb-4 cage)', () => {
  const auth = { handle: 'a/claude', org: 'REAL', mount: 'ro', territory: 'sub', repo: '/repo', cage: 'adversary', tier: 'live', first: 'alice', team: 't', role: 'engineer' }
  const m = resolveMemberIdentity({ solo: false, memberDef: enc(auth) }, TAMPERED, 'a/claude')
  assert.equal(m.org, 'REAL', 'Door 1: org from blob, not TAMPERED.org=VICTIM')
  assert.equal(m.mount, 'ro', 'Door 3: mount from blob, not the roster rw')
  assert.equal(m.territory, 'sub', 'Door 3: territory from blob, not the roster "."')
  assert.equal(m.cage, 'adversary', 'limb 4: cage from blob, not the roster null (no self-uncage)')
})

test('NEGATIVE (Pierre #4): a team member with NO --member-def THROWS — NO roster backstop', () => {
  // The single most likely regression: a `?? norm.<field>` fallback. There is none — absent blob fails closed.
  assert.throws(() => resolveMemberIdentity({ solo: false, memberDef: '' }, TAMPERED, 'a/claude'), /requires the launcher-set --member-def/)
  assert.throws(() => resolveMemberIdentity({ solo: false }, TAMPERED, 'a/claude'), /requires the launcher-set --member-def/)
})

test('NEGATIVE: a malformed / field-short / handle-mismatched --member-def THROWS, never falls through to the roster', () => {
  // undecodable → throws (not "parse the roster instead")
  assert.throws(() => resolveMemberIdentity({ solo: false, memberDef: '@@@not-base64-json@@@' }, TAMPERED, 'a/claude'), /unreadable --member-def|missing a required/)
  // valid base64 json but missing a boundary field → refused (fail-closed, no partial trust)
  assert.throws(() => resolveMemberIdentity({ solo: false, memberDef: enc({ handle: 'a/claude', org: 'X' }) }, TAMPERED, 'a/claude'), /missing a required authoritative field/)
  // valid + complete but for the WRONG handle → refused (--member-def must match the requested --member)
  assert.throws(() => resolveMemberIdentity({ solo: false, memberDef: enc({ handle: 'b/claude', org: 'X', mount: 'ro', territory: '.' }) }, TAMPERED, 'a/claude'), /is for @b\/claude, not the requested @a\/claude/)
})

test('solo: identity is soloRoster with its repo-DERIVED org stamped — authoritative, no blob, no mounted file', () => {
  const soloNorm = { org: 'proj-solo-abc123', members: [{ handle: 'you/claude', first: 'you', mount: 'rw', territory: '.', tier: 'live', team: 'solo', role: 'engineer' }] }
  const m = resolveMemberIdentity({ solo: true }, soloNorm, 'you/claude')
  assert.equal(m.org, 'proj-solo-abc123', 'solo org stamped from soloRoster (derived from repoPath, not a mounted file)')
  assert.equal(m.mount, 'rw', 'solo owns its whole repo by design')
})

test('memberArgv round-trips the authoritative blob → the inner recovers it; sessionId keys on the REAL org, not VICTIM', () => {
  const member = { handle: 'a/claude', first: 'alice', mount: 'ro', territory: 'sub', repo: '/repo', cage: 'adversary', tier: 'live', team: 't', role: 'engineer', roleLabel: 'Engineer' }
  const argv = memberArgv('/repo', member, '/repo/.mrc/team.runtime.json', 'REAL')
  const i = argv.indexOf('--member-def')
  assert.ok(i > 0, '--member-def is threaded into the inner argv')
  const recovered = resolveMemberIdentity({ solo: false, memberDef: argv[i + 1] }, TAMPERED, 'a/claude')
  assert.equal(recovered.org, 'REAL')
  assert.equal(recovered.mount, 'ro')
  assert.equal(recovered.cage, 'adversary')
  // Door 1 end-to-end: the daemon keyed its sessionIndex on the AUTHORITATIVE org; the inner computes the same id.
  assert.equal(memberSessionId(recovered.org, recovered.handle), memberSessionId('REAL', 'a/claude'))
  assert.notEqual(memberSessionId(recovered.org, recovered.handle), memberSessionId('VICTIM', 'a/claude'), 'a tampered roster org can NOT steer the sessionId')
})

test('Mouth A: rosterCandidates never sources a roster from the rw .mrc mount (no .mrc/team.json)', () => {
  // The worker exec's container mount derives from findRoster→memberWorkspaceVolumes. If a member could plant a
  // <repo>/.mrc/team.json (rw mount) that findRoster read, it would steer that mount. Nothing WRITES .mrc/team.json
  // (writeTeamFile → repo-root team.json), so it was a pure member-writable discovery hole — removed.
  const c = rosterCandidates('/repo')
  assert.ok(!c.some((p) => p.includes('/.mrc/')), 'no candidate under the rw-mounted .mrc')
  assert.ok(c.some((p) => p.endsWith('/team.json')), 'root team.json (RO to members) is still discovered')
})

test('Door 3 write-scope: memberWorkspaceVolumes on the BLOB member keeps /workspace RO even though the roster said rw/.', () => {
  const repo = mkdtempSync(join(tmpdir(), 'mrc-mid-'))
  try {
    mkdirSync(join(repo, 'sub'))
    // The authoritative (blob) member is ro-with-subtree; feed THAT to the mount builder (as the inner now does).
    const blobMember = { handle: 'a/claude', mount: 'ro', territory: 'sub', repo }
    const vols = memberWorkspaceVolumes(blobMember, repo).join(' ')
    assert.ok(/:\/workspace:ro\b/.test(vols), 'the RO floor holds: /workspace is mounted read-only')
    assert.ok(!/:\/workspace(?!:ro)(?!\/)/.test(vols) || /:\/workspace:ro/.test(vols), 'no bare rw /workspace')
    // sanity: a member the human LEGITIMATELY granted rw/. does get the wide mount — the guard is precise, not blanket
    const wide = memberWorkspaceVolumes({ handle: 'a/claude', mount: 'rw', territory: '.', repo }, repo).join(' ')
    assert.ok(/:\/workspace\b/.test(wide) && !/:\/workspace:ro/.test(wide), 'a legit full-rw member still mounts /workspace rw (precise, not blanket)')
  } finally { rmSync(repo, { recursive: true, force: true }) }
})
